// `flume launch status|enable|disable`, the `hermes.launch-mode` audit rule, and the retired titles.
//
// Everything runs the REAL built dist in a subprocess against a constructed fleet in /tmp (never the
// live ~/.hermes): the registry, profile, repo and jobs store are fixtures; `candybar` and Hermes'
// Python are the stand-ins in tests/helpers (fake-candybar.py, fake-hermes-python.py).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "flume-hr", "dist", "index.js");
if (!existsSync(CLI)) {
  console.error("SKIP launch-mode-regressions: dist/ is not built (npm run build)");
  process.exit(0);
}
const work = mkdtempSync("/tmp/flume-launch-");
let failures = 0;
let count = 0;
const check = async (name, fn) => {
  count += 1;
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
};

const home = join(work, "home");
const fleet = join(work, "fleet");
const repo = join(work, "demo");
const state = join(work, "candybar-state.json");
const cbLog = join(work, "candybar.log");
const profile = join(fleet, "profiles", "demo-pm");
const roleDir = join(repo, "agents", "hermes", "pm");
for (const dir of [home, fleet, profile, join(roleDir, ".scripts"), join(repo, ".candybars")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(roleDir, ".scripts", "launch-pass.py"), "#!/usr/bin/env python3\n");
mkdirSync(join(repo, ".git"));

const row = (id, role, extra = {}) => ({
  repo: "demo", role, type: "hermes", display_name: `Demo ${role}`, project_path: repo,
  role_dir: role === "pm" ? roleDir : join(repo, "agents", "hermes", id),
  profile_name: id, bloodbank: { enabled: true, gateway_scope: "fleet", target_agent_id: id }, ...extra,
});
const writeRegistry = (agents) => writeFileSync(join(fleet, "agents-registry.yaml"), YAML.stringify({ schema_version: 1, agents }));
writeRegistry({ "demo-pm": row("demo-pm", "pm") });

const env = {
  ...process.env, HOME: home, HERMES_FLEET_HOME: fleet,
  HERMES_AGENTS_REGISTRY: "", HERMES_FLEET_REGISTRY_FILE: "",
  FLUME_CANDYBAR_BIN: join(ROOT, "tests/helpers/fake-candybar.py"),
  FLUME_HERMES_PYTHON: join(ROOT, "tests/helpers/fake-hermes-python.py"),
  FLUME_PJ_BIN: join(ROOT, "tests/helpers/fake-pj.py"), FAKE_PJ_LOG: join(work, "pj.log"),
  FAKE_CANDYBAR_STATE: state, FAKE_CANDYBAR_LOG: cbLog, NO_COLOR: "1",
};
const flume = (args, cwd = repo, extra = {}) => {
  const run = spawnSync("node", [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
  return { status: run.status, out: String(run.stdout), err: String(run.stderr) };
};
const json = (args, extra) => { const r = flume([...args, "--json"], repo, extra); return { ...r, doc: JSON.parse(r.out) }; };

const declare = (mode) => writeFileSync(join(repo, ".launch.yaml"), `mode: ${mode}\ndeclared: 2026-11-18\nsource: test\nfinish_line: ship\ncontract: []\nepic: DEMO-1\n`);
const jobsPath = join(profile, "cron", "jobs.json");
const jobs = () => JSON.parse(readFileSync(jobsPath, "utf8")).jobs;
const cbState = () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {});
const manifestPath = join(repo, ".candybars", "demo-pm-launch-pass.candybar.toml");
const monitor = join(profile, "scripts", "launch-monitor.sh");
const brief = join(profile, "scripts", "launch-brief.sh");

await check("enable refuses a repo that has not declared an active mode, and writes nothing", () => {
  const r = json(["launch", "enable", repo]);
  assert.equal(r.status, 1);
  assert.match(r.doc.error, /\.launch\.yaml must say `mode: launch` or `mode: polish` \(it is absent\)/);
  assert.equal(existsSync(manifestPath), false);
  declare("steady");
  assert.match(json(["launch", "enable", repo]).doc.error, /it is develop/, "the legacy steady alias reads as develop");
  declare("live");
  assert.match(json(["launch", "enable", repo]).doc.error, /it is live/, "a live app has no finish line to launch");
});

await check("enable --dry-run plans every piece and changes nothing", () => {
  declare("launch");
  const r = json(["launch", "enable", repo, "--dry-run"]);
  assert.equal(r.status, 0);
  assert.equal(r.doc.dryRun, true);
  const byTarget = Object.fromEntries(r.doc.actions.map((a) => [a.target.split("/").pop(), a.action]));
  assert.equal(byTarget["launch-monitor.sh"], "create");
  assert.equal(byTarget["launch-brief.sh"], "create");
  assert.ok(r.doc.actions.some((a) => a.target.startsWith("hermes job") && a.action === "create" && /scheduler=external/.test(a.detail)));
  assert.equal(byTarget["demo-pm-launch-pass.candybar.toml"], "create");
  assert.ok(r.doc.actions.some((a) => /candybar register/.test(a.detail)) && r.doc.actions.some((a) => /candybar resume/.test(a.detail)));
  assert.equal(existsSync(monitor), false);
  assert.equal(existsSync(manifestPath), false);
  assert.equal(existsSync(jobsPath), false);
  assert.deepEqual(cbState(), {});
});

await check("enable wires wrappers, a lean external job, the manifest, and an enabled Candybar", () => {
  const r = json(["launch", "enable", repo]);
  assert.equal(r.status, 0, r.out + r.err);
  assert.equal(r.doc.ok, true);
  for (const path of [monitor, brief]) {
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "a real file, not a link (Hermes refuses symlinks)");
    assert.ok((stat.mode & 0o111) !== 0, "executable");
  }
  assert.match(readFileSync(monitor, "utf8"), new RegExp(`exec python3 ${roleDir}/.scripts/launch-pass.py --monitor`));
  assert.match(readFileSync(brief, "utf8"), new RegExp(`exec python3 ${roleDir}/.scripts/launch-pass.py --brief`));
  const [job] = jobs();
  assert.equal(jobs().length, 1);
  assert.equal(job.scheduler, "external", "Candybar is the only clock");
  assert.deepEqual(job.enabled_toolsets.sort(), ["file", "no_mcp", "terminal"]);
  assert.deepEqual(job.skills, []);
  assert.equal(job.economics.max_iterations, 10);
  assert.equal(job.timezone, "America/New_York");
  assert.match(job.schedule.expr, /^\d+ 8-22 \* \* \*$/u);
  const manifest = readFileSync(manifestPath, "utf8");
  assert.match(manifest, /name = "demo-pm-launch-pass"/);
  assert.match(manifest, new RegExp(`job_id = "${job.id}"`));
  assert.match(manifest, /kind = "hermes"/);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, true);
  const status = json(["launch", "status", repo]);
  assert.equal(status.status, 0, status.out);
  assert.equal(status.doc.candybar.state, "enabled");
  assert.equal(status.doc.job.scheduler, "external");
  assert.equal(status.doc.manifest.inSync, true);
  assert.deepEqual(status.doc.wrappers, { monitor: true, brief: true });
});

await check("enable is idempotent: a wired repo plans zero changes and touches nothing", () => {
  const before = [monitor, brief, manifestPath, jobsPath].map((p) => statSync(p).mtimeMs);
  for (const args of [["--dry-run"], []]) {
    const r = json(["launch", "enable", repo, ...args]);
    assert.equal(r.doc.changes, 0, JSON.stringify(r.doc.actions));
    assert.ok(r.doc.actions.every((a) => a.action === "unchanged" || a.action === "adopt"));
  }
  assert.deepEqual([monitor, brief, manifestPath, jobsPath].map((p) => statSync(p).mtimeMs), before);
});

await check("enable adopts a drifted job: re-pins external and lean, keeps its schedule", () => {
  const doc = JSON.parse(readFileSync(jobsPath, "utf8"));
  const schedule = doc.jobs[0].schedule.expr;
  Object.assign(doc.jobs[0], { scheduler: "internal", skills: ["x"], enabled_toolsets: ["terminal"], economics: {} });
  writeFileSync(jobsPath, JSON.stringify(doc));
  const plan = json(["launch", "enable", repo, "--dry-run"]);
  const jobAction = plan.doc.actions.find((a) => a.target.startsWith("hermes job"));
  assert.equal(jobAction.action, "update");
  for (const key of ["scheduler", "enabled_toolsets", "skills", "economics"]) assert.match(jobAction.detail, new RegExp(key));
  assert.equal(jobs()[0].scheduler, "internal", "dry run changed nothing");
  assert.equal(json(["launch", "enable", repo]).doc.ok, true);
  assert.equal(jobs()[0].scheduler, "external");
  assert.equal(jobs()[0].schedule.expr, schedule, "an adopted job keeps its own schedule");
  assert.equal(jobs().length, 1, "adopted, not duplicated");
});

await check("--schedule re-times the job and the manifest together; a bad cron is refused", () => {
  assert.match(json(["launch", "enable", repo, "--schedule", "nonsense"]).doc.error, /5-field cron/);
  const r = json(["launch", "enable", repo, "--schedule", "7 9-18 * * 1-5"]);
  assert.equal(r.doc.ok, true, r.out);
  assert.equal(jobs()[0].schedule.expr, "7 9-18 * * 1-5");
  assert.match(readFileSync(manifestPath, "utf8"), /schedule = "7 9-18 \* \* 1-5"/);
  assert.equal(json(["launch", "enable", repo, "--dry-run", "--schedule", "7 9-18 * * 1-5"]).doc.changes, 0);
});

await check("enable refuses an unobservable Candybar instead of guessing", () => {
  const r = json(["launch", "enable", repo, "--dry-run"], { FAKE_CANDYBAR_BROKEN: "1" });
  assert.equal(r.status, 1);
  assert.match(r.doc.error, /cannot read Candybar state/);
});

await check("audit passes while launch mode and the pass agree", () => {
  const r = json(["audit", repo, "--rules", "hermes.launch-mode"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.doc.rules[0].id, "hermes.launch-mode");
  assert.equal(r.doc.rules[0].status, "pass");
});

await check("audit: mode launch with a paused Candybar fails and names flume launch enable", () => {
  const cb = cbState(); cb["demo-pm-launch-pass"].enabled = false; writeFileSync(state, JSON.stringify(cb));
  const r = json(["audit", repo, "--rules", "hermes.launch-mode"]);
  assert.equal(r.doc.rules[0].status, "fail");
  assert.match(r.doc.rules[0].details.join("\n"), /is paused, mode is launch; run: flume launch enable/);
  assert.equal(r.doc.rules[0].fixable, true);
});

await check("remediate hermes.launch-mode re-enables the pass (dry run first)", () => {
  const dry = json(["remediate", "hermes.launch-mode", repo, "--dry-run"]);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, false, "dry run changed nothing");
  assert.match(JSON.stringify(dry.doc), /candybar resume/);
  const run = json(["remediate", "hermes.launch-mode", repo]);
  assert.equal(run.status, 0, run.out);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, true);
});

await check("crank: n/a without .project.json; a launching pjangler repo with crank off fails, enable turns it on via pj", () => {
  assert.equal(json(["launch", "status", repo]).doc.crank.applicable, false, "no .project.json: crank does not apply");
  const project = join(repo, ".project.json");
  writeFileSync(project, JSON.stringify({ slug: "demo" }));
  const bad = json(["audit", repo, "--rules", "hermes.launch-mode"]);
  assert.equal(bad.doc.rules[0].status, "fail");
  assert.match(bad.doc.rules[0].details.join("\n"), /crank is off \(built-in default\), mode is launch; run: flume launch enable/);
  assert.equal(bad.doc.rules[0].fixable, true);
  const dry = json(["launch", "enable", repo, "--dry-run"]);
  const crankAction = dry.doc.actions.find((a) => a.target === "crank");
  assert.equal(crankAction.action, "update");
  assert.match(crankAction.detail, /pj crank enable --interval 5m/);
  assert.equal(dry.doc.changes, 1, "only crank is missing");
  assert.equal(JSON.parse(readFileSync(project, "utf8")).crank, undefined, "dry run changed nothing");
  const fix = json(["remediate", "hermes.launch-mode", repo]);
  assert.equal(fix.status, 0, fix.out);
  assert.deepEqual(JSON.parse(readFileSync(project, "utf8")).crank, { enabled: true, interval: "5m" });
  assert.equal(json(["audit", repo, "--rules", "hermes.launch-mode"]).doc.rules[0].status, "pass");
  const status = json(["launch", "status", repo]);
  assert.deepEqual([status.doc.crank.enabled, status.doc.crank.interval], [true, "5m"]);
  assert.match(flume(["launch", "status", repo]).out, /crank\s+on every 5m \(project\)/);
  const again = json(["launch", "enable", repo]);
  assert.equal(again.doc.changes, 0, JSON.stringify(again.doc.actions));
  assert.equal(again.doc.actions.find((a) => a.target === "crank").action, "unchanged");
});

await check("crank: an unreadable pj warns in the audit and is skipped by enable, never guessed", () => {
  const broken = { FAKE_PJ_BROKEN: "1" };
  const r = json(["audit", repo, "--rules", "hermes.launch-mode"], broken);
  assert.equal(r.doc.rules[0].status, "warn");
  assert.match(r.doc.rules[0].details.join("\n"), /Crank not observable \(pj crank status failed/);
  const plan = json(["launch", "enable", repo, "--dry-run"], broken);
  assert.equal(plan.doc.ok, true);
  assert.equal(plan.doc.actions.find((a) => a.target === "crank").action, "skip");
});

await check("disable pauses the Candybar and keeps the manifest and the Hermes job; twice is a no-op", () => {
  const dry = json(["launch", "disable", repo, "--dry-run"]);
  assert.equal(dry.doc.changes, 1);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, true);
  const r = json(["launch", "disable", repo]);
  assert.equal(r.doc.ok, true);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, false);
  assert.ok(existsSync(manifestPath));
  assert.equal(jobs().length, 1);
  assert.equal(json(["launch", "disable", repo]).doc.changes, 0);
});

await check("audit: develop (via the legacy steady alias) with an enabled pass fails and names flume launch disable", () => {
  declare("steady");
  const cb = cbState(); cb["demo-pm-launch-pass"].enabled = true; writeFileSync(state, JSON.stringify(cb));
  const bad = json(["audit", repo, "--rules", "hermes.launch-mode"]);
  assert.equal(bad.doc.rules[0].status, "fail");
  assert.match(bad.doc.rules[0].details.join("\n"), /enabled but \.launch\.yaml is develop.*flume launch disable/);
  const fix = json(["remediate", "hermes.launch-mode", repo]);
  assert.equal(fix.status, 0, fix.out);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, false);
  assert.equal(json(["audit", repo, "--rules", "hermes.launch-mode"]).doc.rules[0].status, "pass");
  rmSync(join(repo, ".launch.yaml"));
  assert.equal(json(["audit", repo, "--rules", "hermes.launch-mode"]).doc.rules[0].status, "pass", "absent declaration reads as develop");
});

await check("audit: live is a first-class mode; an enabled pass fails and names flume launch disable", () => {
  declare("live");
  const cb = cbState(); cb["demo-pm-launch-pass"].enabled = true; writeFileSync(state, JSON.stringify(cb));
  const bad = json(["audit", repo, "--rules", "hermes.launch-mode"]);
  assert.equal(bad.doc.rules[0].status, "fail");
  const details = bad.doc.rules[0].details.join("\n");
  assert.match(details, /enabled but \.launch\.yaml is live.*flume launch disable/);
  assert.doesNotMatch(details, /mode must be/, "live is not an invalid mode");
  assert.equal(json(["remediate", "hermes.launch-mode", repo]).status, 0);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, false);
  assert.equal(json(["audit", repo, "--rules", "hermes.launch-mode"]).doc.rules[0].status, "pass");
  assert.equal(json(["launch", "status", repo]).doc.declaration.mode, "live");
});

await check("audit: an em or launch-director row is a finding until it is offboarded, retired or not", () => {
  writeRegistry({
    "demo-pm": row("demo-pm", "em"),
    "demo-launch-director": row("demo-launch-director", "paired-launch-director"),
    "demo-old-ld": row("demo-old-ld", "launch-director", { bloodbank: { enabled: false, gateway_scope: "fleet", target_agent_id: "demo-old-ld" } }),
  });
  const r = json(["audit", repo, "--rules", "hermes.launch-mode"]);
  const details = r.doc.rules[0].details.join("\n");
  assert.equal(r.doc.rules[0].status, "fail");
  assert.match(details, /demo-pm: role em is retired; convert it to pm \(docs\/launch-mode\.md "em to pm conversion"\), or run: flume offboard demo-pm --apply/);
  assert.match(details, /demo-launch-director: role paired-launch-director is retired; .*flume offboard demo-launch-director --apply/);
  // 2026-11-24: retired (bloodbank off) launch directors sat in the org chart, the status line and Telegram for six
  // days because a retired row was never a finding. Out of service is not out of the org chart.
  assert.match(details, /demo-old-ld: role launch-director is retired and the employee is out of service, but still in the org chart.*flume offboard demo-old-ld --apply/);
  assert.equal(r.doc.rules[0].fixable, false);
  const fix = json(["remediate", "hermes.launch-mode", repo]);
  assert.match(JSON.stringify(fix.doc), /blocked/);
  // enable names the em desk rather than silently using it
  declare("launch");
  assert.match(json(["launch", "enable", repo]).doc.error, /demo-pm still has role em.*convert it to pm first/);
  writeRegistry({ "demo-pm": row("demo-pm", "pm") });
});

await check("audit skips a repo with no declaration, no desk and no candybars", () => {
  const bare = join(work, "bare");
  mkdirSync(join(bare, ".git"), { recursive: true });
  const r = flume(["audit", bare, "--rules", "hermes.launch-mode", "--json"], bare);
  assert.equal(JSON.parse(r.out).rules[0].status, "skip");
});

await check("hire and onboard refuse each retired title with a pointer to PM launch mode", () => {
  for (const title of ["launch-director", "paired-launch-director", "em"]) {
    for (const verb of ["hire", "onboard"]) {
      const r = flume([verb, title, "--yes", "--dry-run", "--local", "--target-repo", "demo"]);
      assert.notEqual(r.status, 0, `${verb} ${title} must fail`);
      const text = r.out + r.err;
      assert.match(text, new RegExp(`Role "${title}" is retired`), text);
      assert.match(text, title === "em" ? /Convert an existing em desk to pm/ : /Hire a pm instead/);
    }
  }
  assert.equal(existsSync(join(repo, "agents", "hermes", "em")), false, "a refused hire creates no desk");
});

await check("the older `flume launch <employee>` still reaches the specialist launcher", () => {
  const r = flume(["launch", "nobody-here"]);
  assert.notEqual(r.status, 0);
  assert.match(r.out + r.err, /agent\.yaml/, "routed to launchSpecialist, not rejected as an unknown subcommand");
  assert.doesNotMatch(r.out + r.err, /unknown command/);
});

rmSync(work, { recursive: true, force: true });
console.log(`launch-mode-regressions: ${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
