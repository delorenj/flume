// `flume offboard`: the whole exit. Out of service, identity retired, schedules archived, desk unserved and
// archived, role directory removed from its repository, record archived, row gone from the org chart.
//
// The incident (2026-11-24): PM launch mode replaced the launch directors on 2026-11-18, and they were "retired"
// with `flume retire` (record kept). Six days later all three still sat in the registry, the status line and
// Telegram, and the gateway ticker had re-created one archived desk because the profile was still served.
//
// Everything here runs the REAL built dist in a subprocess against a constructed fleet in /tmp (never the live
// ~/.hermes). Candybar is a loopback HTTP fixture and a fake `candybar` binary that records what it was asked to
// archive. The gateway control socket is absent, so unserve degrades to a next action, as it must.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "flume-hr", "dist", "index.js");
if (!existsSync(CLI)) {
  console.error("SKIP offboard-regressions: dist/ is not built (npm run build)");
  process.exit(0);
}

const work = mkdtempSync("/tmp/flume-offboard-");
let failures = 0;
let count = 0;
const check = async (name, fn) => {
  count += 1;
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
};

// ---- Candybar fixture ---------------------------------------------------------------------------
const CANDYBARS = [
  { id: "cb-1", name: "old-director-pass", enabled: true, runner: { kind: "hermes", profile: "old-director", job_id: "j1" } },
  { id: "cb-2", name: "old-director-argv", enabled: true, runner: { kind: "command", argv: ["hermes", "-p", "old-director", "cron", "run"] } },
  { id: "cb-3", name: "old-director-path", enabled: true, runner: { kind: "command", argv: ["bash", "/home/x/.hermes/profiles/old-director/run.sh"] } },
  { id: "cb-4", name: "old-director-gone", enabled: false, archived: true, runner: { kind: "hermes", profile: "old-director" } },
  // Near misses: a profile name inside another word never matches.
  { id: "cb-5", name: "keeper-pass", enabled: true, runner: { kind: "hermes", profile: "old-director-2" } },
  { id: "cb-6", name: "keeper-argv", enabled: true, runner: { kind: "command", argv: ["hermes", "--profile", "old-directorate"] } },
  { id: "cb-7", name: "keeper-path", enabled: true, runner: { kind: "command", argv: ["/home/x/.hermes/profiles/old-director-x/run.sh"] } },
];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/candybars") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(CANDYBARS.map(({ runner, ...rest }) => rest)));
  }
  const m = /^\/candybars\/([^/]+)\/runner$/u.exec(url.pathname);
  const hit = m && CANDYBARS.find((c) => c.id === decodeURIComponent(m[1]));
  if (hit) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ runner: hit.runner })); }
  res.statusCode = 404; res.end("{}");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const CANDYBAR_URL = `http://127.0.0.1:${server.address().port}`;

const archiveLog = join(work, "candybar-archive.log");
const fakeCandybar = join(work, "candybar");
writeFileSync(fakeCandybar, `#!/bin/sh\necho "$@" >> ${JSON.stringify(archiveLog)}\n`);
chmodSync(fakeCandybar, 0o755);

// ---- the registry -------------------------------------------------------------------------------
function registryText({ oldIdentity = "" } = {}) {
  return `# Fleet registry fixture: this header comment must survive every offboard.
schema_version: 1
agents:
  # the employee leaving
  old-director:
    profile_name: old-director
    role: launch-director
    type: hermes
    role_dir: ROLE_DIR
    telegram:
      provisioning_status: retired
      bot_username: shared_bot
    bloodbank:
      enabled: false
      gateway_scope: fleet
      target_agent_id: old-director
${oldIdentity}  # A colleague who stays. Its comments and quoting are none of offboard's business.
  stays-pm:
    profile_name: stays-pm # keep this trailing comment
    role: pm
    type: hermes
    display_name: "Stays — the PM"
    telegram:
      bot_username: shared_bot
    bloodbank:
      enabled: true
      gateway_scope: fleet
      target_agent_id: stays-pm
`;
}

let seq = 0;
function fleet({ oldIdentity, roleDirInRepo = true, desk = true, candybarUrl = CANDYBAR_URL } = {}) {
  seq += 1;
  const home = join(work, `home${seq}`);
  const fleetHome = join(home, ".hermes");
  const registry = join(fleetHome, "agents-registry.yaml");
  mkdirSync(join(fleetHome, "profiles"), { recursive: true });
  writeFileSync(join(fleetHome, "org.yaml"), "version: 1\ncompany: {name: Fixture Co., handle: Fix}\nceo: {id: ceo, display_name: Boss, title: CEO}\n");
  writeFileSync(join(fleetHome, "config.yaml"), YAML.stringify({ model: { default: "fleet-model" } }));
  if (desk) {
    const dir = join(fleetHome, "profiles", "old-director");
    mkdirSync(join(dir, "memories"), { recursive: true });
    writeFileSync(join(dir, "memories", "MEMORY.md"), "remember me\n");
  }
  // A project repository with a bare origin, so the removal commit can be pushed.
  const origin = join(work, `origin${seq}.git`);
  const repo = join(work, `repo${seq}`);
  const g = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
  g(work, "init", "-q", "--bare", origin);
  g(work, "init", "-q", "-b", "main", repo);
  g(repo, "config", "user.email", "t@example.com"); g(repo, "config", "user.name", "T");
  g(repo, "config", "core.hooksPath", "/dev/null");
  const roleDir = roleDirInRepo ? join(repo, "agents", "hermes", "launch-director") : repo;
  mkdirSync(join(repo, "agents", "hermes", "launch-director", "runtime"), { recursive: true });
  mkdirSync(join(repo, "agents", "hermes", "pm"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "runtime/\n");
  writeFileSync(join(repo, "agents", "hermes", "launch-director", "role.yaml"), "role: launch-director\n");
  writeFileSync(join(repo, "agents", "hermes", "pm", "role.yaml"), "role: pm\n");
  writeFileSync(join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "init");
  g(repo, "remote", "add", "origin", origin); g(repo, "push", "-q", "-u", "origin", "main");
  // The identity step rewrites role.yaml before the role-dir step runs; an ignored runtime/ is never in git.
  writeFileSync(join(repo, "agents", "hermes", "launch-director", "role.yaml"), "role: launch-director\nstatus: retired\n");
  writeFileSync(join(repo, "agents", "hermes", "launch-director", "runtime", "state.json"), "{}\n");
  // Another agent's staged work in the same repository must not ride along in the removal commit.
  writeFileSync(join(repo, "README.md"), "hello, staged by someone else\n");
  g(repo, "add", "README.md");

  const text = registryText({ oldIdentity }).replace("ROLE_DIR", roleDir);
  writeFileSync(registry, text, { mode: 0o600 });
  rmSync(archiveLog, { force: true });
  const env = {
    HOME: home, NO_COLOR: "1", TMPDIR: "/tmp", PATH: process.env.PATH,
    HERMES_FLEET_HOME: fleetHome, HERMES_AGENTS_REGISTRY: registry,
    FLUME_CANDYBAR_API_URL: candybarUrl, FLUME_CANDYBAR_BIN: fakeCandybar,
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const run = (args) => new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  const json = async (args) => { const r = await run([...args, "--json"]); try { return { ...r, body: JSON.parse(r.stdout) }; } catch { throw new Error(`not JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
  return { home, fleetHome, registry, repo, origin, roleDir, text, g, run, json, read: () => readFileSync(registry, "utf8"), agents: () => YAML.parse(readFileSync(registry, "utf8")).agents };
}
const stepOf = (body, name) => body.steps.filter((s) => s.step === name);
const archived = () => (existsSync(archiveLog) ? readFileSync(archiveLog, "utf8").trim().split("\n").filter(Boolean) : []);

// ---- preview ------------------------------------------------------------------------------------

await check("preview writes nothing: registry, desk, role dir and Candybar untouched", async () => {
  const f = fleet();
  const { body, status } = await f.json(["offboard", "old-director", "--reason", "launch mode"]);
  assert.equal(status, 0, JSON.stringify(body));
  assert.equal(body.applied, false);
  assert.equal(f.read(), f.text);
  assert.ok(existsSync(join(f.fleetHome, "profiles", "old-director")));
  assert.ok(existsSync(f.roleDir));
  assert.ok(!existsSync(join(f.fleetHome, "agents-retired")));
  assert.deepEqual(archived(), []);
  const would = stepOf(body, "schedules").filter((s) => s.action === "would").map((s) => s.detail).join("\n");
  for (const name of ["old-director-pass", "old-director-argv", "old-director-path"]) assert.match(would, new RegExp(name, "u"));
  assert.match((await f.run(["offboard", "old-director"])).stdout, /dry run; pass --apply/u);
});

// ---- apply --------------------------------------------------------------------------------------

await check("apply removes exactly the row; header, comments and the colleague are byte-identical", async () => {
  const f = fleet();
  const { body, status } = await f.json(["offboard", "old-director", "--reason", "launch mode", "--apply"]);
  assert.equal(status, 0, JSON.stringify(body, null, 2));
  assert.equal(body.applied, true);
  const after = f.read();
  assert.ok(!("old-director" in f.agents()));
  assert.ok(after.startsWith("# Fleet registry fixture: this header comment must survive every offboard."));
  assert.ok(after.includes("profile_name: stays-pm # keep this trailing comment"));
  assert.ok(after.includes(`display_name: "Stays — the PM"`));
  assert.deepEqual(f.agents()["stays-pm"], YAML.parse(f.text).agents["stays-pm"]);
  // The record is archived in full, beside the step log.
  const files = readdirSync(join(f.fleetHome, "agents-retired"));
  const yaml = files.find((name) => /^old-director-\d{8}T\d{6}Z\.yaml$/u.test(name));
  assert.ok(yaml, files.join(","));
  const record = YAML.parse(readFileSync(join(f.fleetHome, "agents-retired", yaml), "utf8"));
  assert.equal(record.employee, "old-director");
  assert.equal(record.reason, "launch mode");
  assert.equal(record.record.role, "launch-director");
  assert.ok(Array.isArray(record.steps) && record.steps.length > 0);
});

await check("apply archives the desk with its memories; unserve without a socket is a next action, not a failure", async () => {
  const f = fleet();
  const { body } = await f.json(["offboard", "old-director", "--apply"]);
  assert.ok(!existsSync(join(f.fleetHome, "profiles", "old-director")));
  assert.ok(body.deskArchive && existsSync(join(body.deskArchive, "memories", "MEMORY.md")));
  assert.equal(stepOf(body, "unserve")[0].action, "next-action");
  assert.ok(body.nextActions.some((a) => /hermes-gateway-restart/u.test(a)), body.nextActions.join("\n"));
});

await check("apply archives every candybar that runs the profile, and none that merely look like it", async () => {
  const f = fleet();
  await f.json(["offboard", "old-director", "--apply"]);
  assert.deepEqual(archived().sort(), ["archive cb-1", "archive cb-2", "archive cb-3"]);
});

await check("role dir: path-scoped removal commit pushed; dirty and ignored files archived; others' staged work untouched", async () => {
  const f = fleet();
  const { body } = await f.json(["offboard", "old-director", "--reason", "launch mode", "--apply"]);
  const role = stepOf(body, "role-dir")[0];
  assert.equal(role.action, "done", JSON.stringify(role));
  assert.ok(!existsSync(f.roleDir), "the directory is gone, ignored runtime/ included");
  assert.ok(existsSync(join(f.repo, "agents", "hermes", "pm", "role.yaml")), "the sibling role stays");
  const shown = f.g(f.repo, "show", "--stat", "--format=%s", "HEAD");
  assert.match(shown, /^chore\(agents\): offboard old-director/u);
  assert.ok(!shown.includes("README.md"), `someone else's staged README rode along:\n${shown}`);
  assert.match(f.g(f.repo, "diff", "--cached", "--name-only"), /README\.md/u, "the other agent's work is still staged");
  assert.equal(f.g(f.repo, "rev-parse", "HEAD").trim(), f.g(f.origin, "rev-parse", "main").trim(), "pushed");
  const copy = readdirSync(join(f.fleetHome, "agents-retired")).find((n) => n.endsWith(".role-dir"));
  assert.ok(copy);
  assert.equal(readFileSync(join(f.fleetHome, "agents-retired", copy, "role.yaml"), "utf8"), "role: launch-director\nstatus: retired\n", "the uncommitted edit survives");
  assert.ok(existsSync(join(f.fleetHome, "agents-retired", copy, "runtime", "state.json")), "the ignored runtime survives");
});

await check("--keep-role-dir leaves the role directory and says so", async () => {
  const f = fleet();
  const { body } = await f.json(["offboard", "old-director", "--keep-role-dir", "--apply"]);
  assert.equal(body.applied, true);
  assert.ok(existsSync(f.roleDir));
  assert.ok(body.leftBehind.some((l) => /kept on request/u.test(l)));
});

// ---- identity -----------------------------------------------------------------------------------

await check("identity: never enrolled is skipped; an already-retired identity is skipped, not re-retired", async () => {
  const a = fleet();
  const one = await a.json(["offboard", "old-director", "--apply"]);
  assert.equal(stepOf(one.body, "identity")[0].action, "skipped");
  assert.match(stepOf(one.body, "identity")[0].detail, /never enrolled/u);
  const b = fleet({ oldIdentity: "    company_identity:\n      subject: 00000000-0000-4000-8000-000000000001\n      handle: old-director\n      email: old-director@agents.example\n      status: retired\n" });
  const two = await b.json(["offboard", "old-director", "--apply"]);
  assert.equal(two.status, 0, JSON.stringify(two.body, null, 2));
  assert.equal(stepOf(two.body, "identity")[0].action, "skipped");
  assert.match(stepOf(two.body, "identity")[0].detail, /already retired/u);
  assert.ok(!two.body.leftBehind.some((l) => /INCOMPLETE/u.test(l)), "a finished retire is never re-reported as incomplete");
});

// ---- failure keeps the row ------------------------------------------------------------------------

await check("a failed step keeps the row for a re-run (role dir is the repository root)", async () => {
  const f = fleet({ roleDirInRepo: false });
  const { body, status } = await f.json(["offboard", "old-director", "--apply"]);
  assert.notEqual(status, 0);
  assert.equal(body.applied, false);
  assert.equal(stepOf(body, "role-dir")[0].action, "failed");
  assert.equal(stepOf(body, "record")[0].action, "skipped");
  assert.ok("old-director" in f.agents(), "the row is what a re-run reads");
  assert.ok(existsSync(join(f.repo, "README.md")), "the repository was never touched");
});

await check("Candybar unreachable: the exit still completes, with a next action to check schedules by hand", async () => {
  const f = fleet({ candybarUrl: "http://127.0.0.1:9" });
  const { body, status } = await f.json(["offboard", "old-director", "--apply"]);
  assert.equal(status, 0, JSON.stringify(body, null, 2));
  assert.equal(stepOf(body, "schedules")[0].action, "next-action");
  assert.ok(body.leftBehind.some((l) => /Candybar unreadable/u.test(l)));
});

await check("Telegram: a bot shared with a colleague is kept, never handed to BotFather", async () => {
  const f = fleet();
  const { body } = await f.json(["offboard", "old-director", "--apply"]);
  const line = body.leftBehind.find((l) => /shared_bot/u.test(l)) ?? "";
  assert.ok(!/deletebot/u.test(line), line);
});

await check("a ghost desk (no row, desk left behind) is unserved and archived; the registry is untouched", async () => {
  const f = fleet();
  const ghost = join(f.fleetHome, "profiles", "earshot-ghost");
  mkdirSync(ghost, { recursive: true });
  writeFileSync(join(ghost, "config.yaml"), "# GENERATED FILE\n");
  const preview = await f.json(["offboard", "earshot-ghost"]);
  assert.equal(preview.status, 0, JSON.stringify(preview.body));
  assert.equal(preview.body.ghost, true);
  assert.ok(existsSync(ghost), "preview moves nothing");
  assert.match((await f.run(["offboard", "earshot-ghost"])).stdout, /ghost desk earshot-ghost/u);
  const { body, status } = await f.json(["offboard", "earshot-ghost", "--apply"]);
  assert.equal(status, 0, JSON.stringify(body, null, 2));
  assert.equal(body.applied, true);
  assert.ok(!existsSync(ghost));
  assert.ok(existsSync(join(body.deskArchive, "config.yaml")));
  assert.equal(f.read(), f.text, "no row, so the org chart is not touched");
});

await check("an unknown employee fails cleanly", async () => {
  const f = fleet();
  const { body, status } = await f.json(["offboard", "nobody"]);
  assert.notEqual(status, 0);
  assert.match(body.errors.join("\n"), /no employee "nobody"/u);
});

server.close();
rmSync(work, { recursive: true, force: true });
console.log(`${count - failures}/${count} offboard regressions passed`);
process.exit(failures ? 1 : 0);
