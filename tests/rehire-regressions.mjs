// `flume rehire`: the exit undone from the archives `flume offboard` left. Role dir, desk and the exact row back; an
// identity THIS offboard retired is un-retired (tombstone moved to a recorded history, never deleted) and restored; the
// revoked gateway member key minted again; the role dir committed path-scoped and pushed; the candybars it archived put back.
//
// The incident (2026-11-24): tolt-director was offboarded with the launch directors, and the operator wanted it back the
// same afternoon. A retired identity is terminal by design, so nothing could bring it back without a deliberate, proven,
// recorded exception. These suites prove the exception is exactly that narrow: a tombstone made by `flume identity retire`
// alone, or one the archive cannot place inside its own offboard, is never lifted.
//
// Everything runs the REAL built dist in a subprocess against constructed fleets in /tmp (never the live ~/.hermes).
// Cloudflare, the gateway-tokens tool, op and the member-key authority are the stateful doubles of lifecycle-fixtures.mjs
// (or a tiny helper here); Candybar is a loopback fixture plus a fake binary that logs its argv. No gateway socket exists,
// so serve degrades to a next action, as it must.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { fakeCloudflare, writeFakeGateway, writeFakeOp } from "./lifecycle-fixtures.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "flume-hr", "dist", "index.js");
if (!existsSync(CLI)) {
  console.error("SKIP rehire-regressions: dist/ is not built (npm run build)");
  process.exit(0);
}

const work = mkdtempSync("/tmp/flume-rehire-");
let failures = 0;
let count = 0;
const check = async (name, fn) => {
  count += 1;
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
};

// ---- Candybar fixture ---------------------------------------------------------------------------
const CANDYBARS = [
  { id: "cb-1", name: "old-director-pass", enabled: true, runner: { kind: "hermes", profile: "old-director" } },
  { id: "cb-2", name: "old-director-paused", enabled: false, runner: { kind: "command", argv: ["hermes", "-p", "old-director", "cron", "run"] } },
  { id: "cb-4", name: "old-director-gone", enabled: false, archived: true, runner: { kind: "hermes", profile: "old-director" } },
  { id: "cb-5", name: "keeper-pass", enabled: true, runner: { kind: "hermes", profile: "old-director-2" } },
];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/candybars") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(CANDYBARS.map(({ runner, ...rest }) => rest))); }
  const m = /^\/candybars\/([^/]+)\/runner$/u.exec(url.pathname);
  const hit = m && CANDYBARS.find((c) => c.id === decodeURIComponent(m[1]));
  if (hit) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ runner: hit.runner })); }
  res.statusCode = 404; res.end("{}");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const CANDYBAR_URL = `http://127.0.0.1:${server.address().port}`;
const candybarLog = join(work, "candybar.log");
const fakeCandybar = join(work, "candybar");
writeFileSync(fakeCandybar, `#!/bin/sh\necho "$@" >> ${JSON.stringify(candybarLog)}\n`);
chmodSync(fakeCandybar, 0o755);
const candybarCalls = () => (existsSync(candybarLog) ? readFileSync(candybarLog, "utf8").trim().split("\n").filter(Boolean) : []);

// ---- Cloudflare + identity doubles ----------------------------------------------------------------
const ACCOUNT = "a".repeat(32), ZONE = "b".repeat(32), KVNS = "c".repeat(32);
const CF_TOKEN = "fixture-cloudflare-provisioning-token-secret";
const TOKEN_REF = "op://DeLoSecrets/Cloudflare/provisioning-token";
const VAULT = "vault-session-token-secret";
const GW_ITEM = "yeurk5dpqkaarspvsn3cjtmkki";
const cf = await fakeCloudflare({ account: ACCOUNT, zone: ZONE, kvns: KVNS, token: CF_TOKEN, issuer: "https://fixture.cloudflareaccess.com" });

// ---- one fleet: a registry, a desk, a project repository with a pushed origin -------------------
let seq = 0;
const g = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout; };

function fleet({ id = "old-director", role = "launch-director", identity = false } = {}) {
  seq += 1;
  const dir = join(work, `w${seq}`);
  const home = join(dir, "home");
  const fleetHome = join(home, ".hermes");
  const registry = join(fleetHome, "agents-registry.yaml");
  const bin = join(dir, "bin");
  for (const p of [join(fleetHome, "profiles"), join(home, ".agents", "workforce"), bin]) mkdirSync(p, { recursive: true });
  writeFileSync(join(fleetHome, "org.yaml"), "version: 1\ncompany: {name: Fixture Co., handle: Fix}\nceo: {id: ceo, display_name: Boss, title: CEO}\n");
  writeFileSync(join(fleetHome, "config.yaml"), YAML.stringify({ model: { default: "fleet-model" }, secrets: { onepassword: { env: { AUTOMATICAI_GATEWAY_KEY: `op://DeLoSecrets/${GW_ITEM}/fleet` } } } }));
  const desk = join(fleetHome, "profiles", id);
  mkdirSync(join(desk, "memories"), { recursive: true });
  writeFileSync(join(desk, "memories", "MEMORY.md"), "remember me\n");
  writeFileSync(join(desk, "config.delta.yaml"), YAML.stringify({ secrets: { onepassword: { env: { AUTOMATICAI_GATEWAY_KEY: `op://DeLoSecrets/${GW_ITEM}/hermes-${id}` } } } }));

  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  g(dir, "init", "-q", "--bare", origin);
  g(dir, "init", "-q", "-b", "main", repo);
  g(repo, "config", "user.email", "t@example.com"); g(repo, "config", "user.name", "T");
  g(repo, "config", "core.hooksPath", "/dev/null");
  const roleDir = join(repo, "agents", "hermes", role);
  mkdirSync(join(roleDir, "runtime"), { recursive: true });
  mkdirSync(join(repo, "agents", "hermes", "pm"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "runtime/\n");
  writeFileSync(join(roleDir, "role.yaml"), identity
    ? `# operator note: keep me\nrepo: fixture\nrole: ${role}\nagent_id: ${id}\nprofile: ${id}\nidentity:\n  name: ada\n  recall_banks:\n    - agent-${id}\n`
    : `role: ${role}\n`);
  writeFileSync(join(roleDir, "SOUL.md"), "who I am\n");
  writeFileSync(join(repo, "agents", "hermes", "pm", "role.yaml"), "role: pm\n");
  writeFileSync(join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "init");
  g(repo, "remote", "add", "origin", origin); g(repo, "push", "-q", "-u", "origin", "main");
  writeFileSync(join(roleDir, "runtime", "state.json"), "{}\n");

  writeFileSync(registry, `# Fleet registry fixture: this header comment must survive every rehire.
schema_version: 1
agents:
  # A colleague who stays. Its comments and quoting are none of rehire's business.
  stays-pm:
    profile_name: stays-pm # keep this trailing comment
    role: pm
    type: hermes
    display_name: "Stays — the PM"
    bloodbank:
      enabled: true
      gateway_scope: fleet
      target_agent_id: stays-pm
  # the employee who leaves and comes back
  ${id}:
    profile_name: ${id}
    role: ${role}
    type: hermes
    display_name: Old Director
    project_path: ${repo}
    role_dir: ${roleDir}
    telegram:
      provisioning_status: deferred
      bot_username: ${id.replace(/-/gu, "_")}_bot
      bot_id: ""
    bloodbank:
      enabled: false
      gateway_scope: fleet
      target_agent_id: ${id}
`, { mode: 0o600 });

  writeFakeOp(join(bin, "op"), VAULT);
  writeFakeGateway(join(bin, "gateway-tokens.py"));
  const opMap = join(dir, "op.json");
  writeFileSync(opMap, JSON.stringify({ [TOKEN_REF]: CF_TOKEN }));
  const provision = join(dir, "identity-provisioning.yaml");
  writeFileSync(provision, YAML.stringify({ version: 1, cloudflare: { api_token_ref: TOKEN_REF, account_id: ACCOUNT, zone_id: ZONE, access_issuer: "https://fixture.cloudflareaccess.com" }, mailbox: { worker: "agents-facade", kv_namespace_id: KVNS }, onepassword: { vault: "DeLoSecrets" } }));
  const gwState = join(dir, "gw-state.json"), gwLog = join(dir, "gw-log.jsonl");
  writeFileSync(gwState, JSON.stringify({ mode: "ok", consumers: { [`hermes-${id}`]: [{ id: 117, name: `aai:hermes-${id}:1`, status: 1, expired_time: -1, planted_key: "planted" }] } }));
  writeFileSync(gwLog, "");
  // The member-key authority (scripts/gateway-member-tokens.py), reduced to its --json contract: it logs its argv and
  // "mints" a fresh token into the gateway double's state, as the real one does through gateway-tokens.py mint.
  const memberLog = join(dir, "member-log.jsonl");
  const memberHelper = join(bin, "gateway-member-tokens.py");
  writeFileSync(memberHelper, `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
open(os.environ["MEMBER_LOG"], "a").write(json.dumps(args) + "\\n")
profile = args[args.index("--members") + 1]
consumer = "hermes-" + profile
state = json.load(open(os.environ["GW_STATE"]))
state["consumers"][consumer] = [{"id": 118, "name": "aai:" + consumer + ":2", "status": 1, "expired_time": -1, "planted_key": "planted"}]
json.dump(state, open(os.environ["GW_STATE"], "w"))
print(json.dumps({"ok": True, "apply": True, "members": [{"profile": profile, "consumer": consumer, "reference": "op://DeLoSecrets/${GW_ITEM}/" + consumer, "token": "minted", "delta": "unchanged", "render": "rendered", "ok": True}]}))
`, { mode: 0o755 });

  const env = {
    HOME: home, NO_COLOR: "1", TMPDIR: "/tmp", PATH: `${bin}:${process.env.PATH}`,
    HERMES_FLEET_HOME: fleetHome, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
    HERMES_TEMPLATE_CONFIG: join(dir, "no-config"), HERMES_FLEET_ENV: join(dir, "no-env"), FLUME_HOST_OVERLAY: "none",
    FLUME_CANDYBAR_API_URL: CANDYBAR_URL, FLUME_CANDYBAR_BIN: fakeCandybar, GIT_CONFIG_GLOBAL: "/dev/null",
    XDG_STATE_HOME: join(home, ".local", "state"), FLUME_IDENTITY_STATE: join(dir, "state", "identity"), FLUME_ACCESS_STATE: join(dir, "state", "access"),
    FLUME_PROVISION_CONFIG: provision, FLUME_CLOUDFLARE_API_BASE: cf.url, FLUME_GATEWAY_TOKENS_BIN: join(bin, "gateway-tokens.py"),
    FLUME_GATEWAY_EVIDENCE: join(dir, "no-evidence"), GW_STATE: gwState, GW_LOG: gwLog,
    FLUME_GATEWAY_MEMBER_TOKENS: memberHelper, MEMBER_LOG: memberLog,
    OP_SERVICE_ACCOUNT_TOKEN: VAULT, OP_FIXTURE: opMap, PYTHONDONTWRITEBYTECODE: "1",
  };
  const run = (args) => new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd: ROOT });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  const json = async (args) => { const r = await run([...args, "--json"]); try { return { ...r, body: JSON.parse(r.stdout) }; } catch { throw new Error(`not JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
  const read = () => readFileSync(registry, "utf8");
  const agents = () => YAML.parse(read()).agents;
  const state = () => { const p = join(env.FLUME_IDENTITY_STATE, "lifecycle-state.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };
  const ledger = () => { const p = join(env.FLUME_IDENTITY_STATE, "lifecycle-ledger.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const archives = () => readdirSync(join(fleetHome, "agents-retired"));
  const archivePath = () => join(fleetHome, "agents-retired", archives().find((n) => new RegExp(`^${id}-\\d{8}T\\d{6}Z\\.yaml$`, "u").test(n)));
  const w = { id, dir, home, fleetHome, registry, repo, origin, roleDir, desk, env, run, json, read, agents, state, ledger, archives, archivePath, gwState, memberLog };

  if (identity) {
    // Enroll, then mirror the identity into the row the way `hermes.registry-parity` projects it (offboard reads the row).
    const enrolled = spawnSync(process.execPath, [CLI, "identity", "enroll", id, "--apply", "--json"], { env, encoding: "utf8" });
    assert.equal(enrolled.status, 0, enrolled.stdout + enrolled.stderr);
    const block = JSON.parse(enrolled.stdout).identity;
    const doc = YAML.parseDocument(read());
    doc.setIn(["agents", id, "company_identity"], { subject: block.subject, handle: block.handle, email: block.email, status: "active" });
    writeFileSync(registry, String(doc));
    w.block = block;
    // The role's enrollment is committed, as it is in a real repository.
    g(repo, "add", "-A", "--", roleDir); g(repo, "commit", "-q", "-m", "enroll"); g(repo, "push", "-q");
    cf.reset();
    cf.rules.push({ id: "rule-ada", name: "ada mailbox", enabled: true, matchers: [{ type: "literal", field: "to", value: block.email }], actions: [{ type: "worker", value: ["agents-facade"] }] });
    cf.kv.set(`allowlist/${block.email}`, { handle: block.handle, subject: block.subject, provisioned_at: "2026-10-01T00:00:00.000Z" });
  }
  // Another agent's staged work in the same repository must ride along in neither commit.
  writeFileSync(join(repo, "README.md"), "hello, staged by someone else\n");
  g(repo, "add", "README.md");
  w.original = YAML.parse(read()).agents[id];
  w.text = read();
  rmSync(candybarLog, { force: true });
  return w;
}
const stepOf = (body, name) => body.steps.filter((s) => s.step === name);

// ---- preview ------------------------------------------------------------------------------------

await check("preview after an offboard writes nothing and names every step", async () => {
  const f = fleet();
  assert.equal((await f.json(["offboard", f.id, "--apply"])).status, 0);
  const before = { registry: f.read(), archives: f.archives().sort(), head: g(f.repo, "rev-parse", "HEAD") };
  rmSync(candybarLog, { force: true });
  const { body, status } = await f.json(["rehire", f.id]);
  assert.equal(status, 0, JSON.stringify(body, null, 2));
  assert.equal(body.applied, false);
  for (const name of ["role-dir", "desk", "record", "commit", "serve"]) assert.equal(stepOf(body, name)[0]?.action, "would", name);
  assert.equal(f.read(), before.registry);
  assert.deepEqual(f.archives().sort(), before.archives);
  assert.equal(g(f.repo, "rev-parse", "HEAD"), before.head);
  assert.ok(!existsSync(f.roleDir) && !existsSync(f.desk));
  assert.deepEqual(candybarCalls(), []);
  assert.match((await f.run(["rehire", f.id])).stdout, /dry run; pass --apply/u);
});

// ---- apply ----------------------------------------------------------------------------------------

await check("apply restores the exact row; header, comments and the colleague are untouched", async () => {
  const f = fleet();
  await f.json(["offboard", f.id, "--apply"]);
  const { body, status } = await f.json(["rehire", f.id, "--apply"]);
  assert.equal(status, 0, JSON.stringify(body, null, 2));
  assert.equal(body.applied, true);
  assert.deepEqual(f.agents()[f.id], f.original, "the row is exactly the archived one");
  const after = f.read();
  assert.ok(after.startsWith("# Fleet registry fixture: this header comment must survive every rehire."));
  assert.ok(after.includes("profile_name: stays-pm # keep this trailing comment"));
  assert.ok(after.includes(`display_name: "Stays — the PM"`));
  assert.deepEqual(f.agents()["stays-pm"], YAML.parse(f.text).agents["stays-pm"]);
  assert.ok(f.archives().some((n) => /\.rehired\.yaml$/u.test(n)), "a rehire receipt sits beside the archive");
});

await check("desk and role dir come back whole: memories, the uncommitted role.yaml, the ignored runtime/", async () => {
  const f = fleet();
  writeFileSync(join(f.roleDir, "role.yaml"), "role: launch-director\nstatus: edited-not-committed\n");
  await f.json(["offboard", f.id, "--apply"]);
  const { body } = await f.json(["rehire", f.id, "--apply"]);
  assert.equal(stepOf(body, "desk")[0].action, "done");
  assert.equal(readFileSync(join(f.desk, "memories", "MEMORY.md"), "utf8"), "remember me\n");
  assert.equal(stepOf(body, "role-dir")[0].action, "done");
  assert.equal(readFileSync(join(f.roleDir, "role.yaml"), "utf8"), "role: launch-director\nstatus: edited-not-committed\n");
  assert.ok(existsSync(join(f.roleDir, "runtime", "state.json")), "the ignored runtime is back");
  assert.ok(!readdirSync(join(f.fleetHome, "profiles-retired")).some((n) => n.startsWith(`${f.id}-`)), "the desk archive was moved, not copied");
  assert.equal(stepOf(body, "serve")[0].action, "next-action", "no socket: serving is a next action");
  assert.ok(body.nextActions.some((a) => /hermes-gateway-restart/u.test(a)));
});

await check("role dir: a path-scoped commit that undoes the removal, pushed; others' staged work untouched", async () => {
  const f = fleet();
  await f.json(["offboard", f.id, "--apply"]);
  const { body } = await f.json(["rehire", f.id, "--reason", "the operator wants it back", "--apply"]);
  const commit = stepOf(body, "commit")[0];
  assert.equal(commit.action, "done", JSON.stringify(commit));
  const shown = f.g ?? g;
  const stat = shown(f.repo, "show", "--stat", "--format=%s%n%b", "HEAD");
  assert.match(stat, /^chore\(agents\): rehire old-director/u);
  assert.match(stat, /the operator wants it back/u);
  assert.match(stat, /undoes [0-9a-f]{7}/u);
  assert.ok(stat.includes("role.yaml") && stat.includes("SOUL.md"), stat);
  assert.ok(!stat.includes("README.md"), `someone else's staged README rode along:\n${stat}`);
  assert.match(g(f.repo, "diff", "--cached", "--name-only"), /README\.md/u, "the other agent's work is still staged");
  assert.equal(g(f.repo, "rev-parse", "HEAD").trim(), g(f.origin, "rev-parse", "main").trim(), "pushed");
  assert.equal(g(f.repo, "ls-files", "--", "agents/hermes/launch-director/runtime").trim(), "", "the ignored runtime is never committed");
});

await check("schedules: only the candybars this offboard archived come back, resumed only if they were scheduling", async () => {
  const f = fleet();
  await f.json(["offboard", f.id, "--apply"]);
  const record = YAML.parse(readFileSync(f.archivePath(), "utf8"));
  assert.deepEqual(record.archived_schedules.map((s) => s.id).sort(), ["cb-1", "cb-2"], "offboard records what it archived");
  rmSync(candybarLog, { force: true });
  const { body } = await f.json(["rehire", f.id, "--apply"]);
  assert.deepEqual(candybarCalls().sort(), ["resume cb-1", "unarchive cb-1", "unarchive cb-2"]);
  assert.ok(body.inService.some((l) => /old-director-gone was archived before this offboard/u.test(l)), body.inService.join("\n"));
});

await check("an id already in the org chart is refused, and nothing is written", async () => {
  const f = fleet();
  await f.json(["offboard", f.id, "--apply"]);
  const doc = YAML.parseDocument(f.read());
  doc.setIn(["agents", f.id], { profile_name: f.id, role: "pm" });
  writeFileSync(f.registry, String(doc));
  const before = f.read();
  const { body, status } = await f.json(["rehire", f.id, "--apply"]);
  assert.notEqual(status, 0);
  assert.match(body.errors.join("\n"), /already in the org chart/u);
  assert.equal(f.read(), before);
  assert.ok(!existsSync(f.roleDir) && !existsSync(f.desk));
});

await check("a re-run converges: no second row, no second commit", async () => {
  const f = fleet();
  await f.json(["offboard", f.id, "--apply"]);
  assert.equal((await f.json(["rehire", f.id, "--apply"])).status, 0);
  const head = g(f.repo, "rev-parse", "HEAD");
  const registry = f.read();
  const again = await f.json(["rehire", f.id, "--apply"]);
  assert.equal(again.status, 0, JSON.stringify(again.body, null, 2));
  assert.equal(stepOf(again.body, "record")[0].action, "skipped");
  assert.equal(stepOf(again.body, "commit")[0].action, "skipped");
  assert.equal(g(f.repo, "rev-parse", "HEAD"), head);
  assert.equal(f.read(), registry);
});

await check("an employee with no archive fails cleanly", async () => {
  const f = fleet();
  const { body, status } = await f.json(["rehire", "nobody"]);
  assert.notEqual(status, 0);
  assert.match(body.errors.join("\n"), /no offboard archive for "nobody"/u);
});

// ---- identity -----------------------------------------------------------------------------------------

await check("identity: the offboard's own tombstone is lifted (moved, recorded), status restored, mailbox reopened, member key minted", async () => {
  const f = fleet({ id: "ada-pm", role: "director", identity: true });
  const off = await f.json(["offboard", f.id, "--apply"]);
  assert.equal(off.status, 0, JSON.stringify(off.body, null, 2));
  const tombstone = f.state().tombstones[f.block.subject];
  assert.ok(tombstone, "the offboard retired the identity");
  assert.equal(YAML.parse(readFileSync(f.archivePath(), "utf8")).identity_operation_id, tombstone.operation_id, "the archive records the retire operation");
  assert.ok(!cf.kv.has(`allowlist/${f.block.email}`) && cf.rules[0].enabled === false, "retire closed the mailbox");
  assert.deepEqual(JSON.parse(readFileSync(f.gwState, "utf8")).consumers["hermes-ada-pm"], [], "retire revoked the member key");

  const { body, status } = await f.json(["rehire", f.id, "--apply"]);
  assert.equal(status, 0, JSON.stringify(body, null, 2));
  assert.equal(stepOf(body, "identity")[0].action, "done", JSON.stringify(stepOf(body, "identity")));
  const state = f.state();
  assert.equal(state.tombstones[f.block.subject], undefined, "no tombstone left");
  const lifted = state.unretired[f.block.subject];
  assert.equal(lifted.length, 1);
  assert.deepEqual(lifted[0].tombstone, tombstone, "the tombstone is kept whole in the history, never deleted");
  assert.equal(lifted[0].proof, "operation-id");
  assert.equal(lifted[0].archive, f.archivePath());
  const lines = f.ledger().filter((l) => l.event === "lifecycle.unretire");
  assert.deepEqual(lines.map((l) => l.phase), ["tombstone-lifted", "finished"]);
  assert.equal(lines[0].tombstone_operation_id, tombstone.operation_id);
  assert.equal(YAML.parse(readFileSync(join(f.roleDir, "role.yaml"), "utf8")).company_identity.status, "active");
  assert.ok(readFileSync(join(f.roleDir, "role.yaml"), "utf8").startsWith("# operator note: keep me"), "the definition's comments survive");
  assert.ok(cf.kv.has(`allowlist/${f.block.email}`), "the captured allowlist record is back");
  assert.equal(cf.rules[0].enabled, true, "the routing rule retire disabled is enabled again");
  assert.equal(stepOf(body, "gateway")[0].action, "done");
  const minted = readFileSync(f.memberLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(minted, [["--members", "ada-pm", "--json", "--render", "--apply"]]);
  // The commit carries the definition's final status, not the retired one.
  assert.match(g(f.repo, "show", "HEAD:agents/hermes/director/role.yaml"), /status: "active"/u);
  // And the employee is an ordinary active employee again: it can be suspended like anyone.
  const suspend = spawnSync(process.execPath, [CLI, "identity", "suspend", f.id, "--json"], { env: f.env, encoding: "utf8" });
  assert.equal(suspend.status, 0, suspend.stdout + suspend.stderr);
});

await check("identity: a tombstone `flume identity retire` made before the offboard is never lifted", async () => {
  const f = fleet({ id: "ada-pm", role: "director", identity: true });
  const retired = spawnSync(process.execPath, [CLI, "identity", "retire", f.id, "--revoke", "all", "--apply", "--json"], { env: f.env, encoding: "utf8" });
  // Exit is nonzero while a credential still needs a person (revocation INCOMPLETE); the tombstone is what this case needs.
  assert.ok(JSON.parse(retired.stdout).operation_id, retired.stdout);
  const off = await f.json(["offboard", f.id, "--apply"]);
  assert.equal(off.status, 0, JSON.stringify(off.body, null, 2));
  assert.equal(stepOf(off.body, "identity")[0].action, "skipped");
  const tombstone = f.state().tombstones[f.block.subject];
  const { body } = await f.json(["rehire", f.id, "--apply"]);
  assert.equal(body.applied, true, "the employee comes back");
  assert.equal(stepOf(body, "identity")[0].action, "next-action");
  assert.match(stepOf(body, "identity")[0].detail, /retired before this offboard/u);
  assert.deepEqual(f.state().tombstones[f.block.subject], tombstone, "the tombstone stands");
  assert.equal(f.ledger().filter((l) => l.event === "lifecycle.unretire").length, 0);
  assert.equal(YAML.parse(readFileSync(join(f.roleDir, "role.yaml"), "utf8")).company_identity.status, "retired");
  assert.equal(stepOf(body, "gateway")[0].action, "skipped", "no member key for an identity that stays retired");
});

await check("identity: an archive that cannot place the tombstone in its own run is refused (preview, nothing written)", async () => {
  const f = fleet({ id: "ada-pm", role: "director", identity: true });
  await f.json(["offboard", f.id, "--apply"]);
  const path = f.archivePath();
  const archive = YAML.parse(readFileSync(path, "utf8"));
  writeFileSync(path, YAML.stringify({ ...archive, identity_operation_id: "00000000-0000-4000-8000-00000000dead" }));
  const before = JSON.stringify(f.state());
  const { body, status } = await f.json(["rehire", f.id]);
  assert.notEqual(status, 0);
  assert.equal(stepOf(body, "identity")[0].action, "failed");
  assert.match(stepOf(body, "identity")[0].detail, /cannot be lifted: the tombstone was made by operation/u);
  assert.equal(JSON.stringify(f.state()), before);
});

await check("identity: a legacy archive (no operation id) is proven by the offboard's own time window, and only by it", async () => {
  const f = fleet({ id: "ada-pm", role: "director", identity: true });
  await f.json(["offboard", f.id, "--apply"]);
  const path = f.archivePath();
  const { identity_operation_id: _dropped, ...legacy } = YAML.parse(readFileSync(path, "utf8"));
  writeFileSync(path, YAML.stringify(legacy));
  const inside = await f.json(["rehire", f.id]);
  assert.equal(inside.status, 0, JSON.stringify(inside.body, null, 2));
  assert.match(stepOf(inside.body, "identity")[0].detail, /proof: offboard-window/u);
  writeFileSync(path, YAML.stringify({ ...legacy, offboarded_at: "2020-01-01T00:00:00.000Z" }));
  const outside = await f.json(["rehire", f.id]);
  assert.notEqual(outside.status, 0);
  assert.match(stepOf(outside.body, "identity")[0].detail, /falls outside that offboard's run/u);
});

await check("identity: retired stays terminal for every other path (status, restore)", async () => {
  const f = fleet({ id: "ada-pm", role: "director", identity: true });
  await f.json(["offboard", f.id, "--apply"]);
  // Put only the row and role dir back by hand: the ordinary commands must still refuse a retired identity.
  const archive = YAML.parse(readFileSync(f.archivePath(), "utf8"));
  const doc = YAML.parseDocument(f.read());
  doc.setIn(["agents", f.id], archive.record);
  writeFileSync(f.registry, String(doc));
  spawnSync("cp", ["-a", f.archivePath().replace(/\.yaml$/u, ".role-dir"), f.roleDir]);
  for (const args of [["identity", "status", f.id, "suspended", "--apply"], ["identity", "restore", f.id, "--apply"]]) {
    const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { env: f.env, encoding: "utf8" });
    assert.notEqual(r.status, 0, `${args.join(" ")} must refuse: ${r.stdout}`);
    assert.match(r.stdout, /retired-terminal/u);
  }
  assert.ok(f.state().tombstones[f.block.subject], "the tombstone stands");
});

server.close();
await cf.close();
rmSync(work, { recursive: true, force: true });
console.log(`${count - failures}/${count} rehire regressions passed`);
process.exit(failures ? 1 : 0);
