// Project modes (develop | launch | polish): the declaration reader, polish enable
// (cadence precedence, retune on a mode switch, job budget and name), the polish
// metrics in status, crank, the audit rule and the `flume mode` command group.
//
// Everything runs the REAL built dist in a subprocess against a constructed fleet in /tmp (never the
// live ~/.hermes): the registry, profile, repo and jobs store are fixtures; `candybar`, `pj` and
// Hermes' Python are the stand-ins in tests/helpers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "flume-hr", "dist", "index.js");
if (!existsSync(CLI)) {
  console.error("SKIP project-modes: dist/ is not built (npm run build)");
  process.exit(0);
}
const work = mkdtempSync("/tmp/flume-modes-");
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
const profile = join(fleet, "profiles", "demo-pm");
const roleDir = join(repo, "agents", "hermes", "pm");
for (const dir of [home, fleet, profile, join(roleDir, ".scripts"), join(repo, ".candybars")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(roleDir, ".scripts", "launch-pass.py"), "#!/usr/bin/env python3\n");
mkdirSync(join(repo, ".git"));

writeFileSync(join(fleet, "agents-registry.yaml"), YAML.stringify({
  schema_version: 1,
  agents: {
    "demo-pm": {
      repo: "demo", role: "pm", type: "hermes", display_name: "Demo PM", project_path: repo,
      role_dir: roleDir, profile_name: "demo-pm",
      bloodbank: { enabled: true, gateway_scope: "fleet", target_agent_id: "demo-pm" },
    },
  },
}));

const env = {
  ...process.env, HOME: home, HERMES_FLEET_HOME: fleet,
  HERMES_AGENTS_REGISTRY: "", HERMES_FLEET_REGISTRY_FILE: "",
  FLUME_CANDYBAR_BIN: join(ROOT, "tests/helpers/fake-candybar.py"),
  FLUME_HERMES_PYTHON: join(ROOT, "tests/helpers/fake-hermes-python.py"),
  FLUME_PJ_BIN: join(ROOT, "tests/helpers/fake-pj.py"), FAKE_PJ_LOG: join(work, "pj.log"),
  FAKE_CANDYBAR_STATE: state, FAKE_CANDYBAR_LOG: join(work, "candybar.log"), NO_COLOR: "1",
};
const flume = (args, cwd = repo, extra = {}) => {
  const run = spawnSync("node", [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
  return { status: run.status, out: String(run.stdout), err: String(run.stderr) };
};
const json = (args, extra) => { const r = flume([...args, "--json"], repo, extra); return { ...r, doc: JSON.parse(r.out) }; };

const declare = (text) => writeFileSync(join(repo, ".launch.yaml"), text);
const declarePolish = (polish = "") => declare(`mode: polish\ndeclared: 2026-11-27\nsource: test\nepic: DEMO-9\n${polish}`);
const jobsPath = join(profile, "cron", "jobs.json");
const jobs = () => JSON.parse(readFileSync(jobsPath, "utf8")).jobs;
const cbState = () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {});
const manifestPath = join(repo, ".candybars", "demo-pm-launch-pass.candybar.toml");
const metricsPath = join(roleDir, "runtime", "polish-metrics.json");

await check("declaration parsing: polish block fields, lowercase, steady alias, absent, unknown mode, broken cadence", () => {
  declarePolish("polish:\n  focus: [UX, Physics]\n  qa: [\"mise run qa:explore\"]\n  wip: 6\n  cadence: \"*/10 * * * *\"\n  todo_depth: 12\n");
  const status = json(["launch", "status", repo]);
  assert.equal(status.doc.mode, "polish");
  assert.equal(status.doc.declaration.mode, "polish");
  assert.deepEqual(status.doc.declaration.polish, {
    wip: 6, cadence: "*/10 * * * *", todoDepth: 12, qa: ["mise run qa:explore"], focus: ["ux", "physics"],
  });
  declarePolish();
  assert.equal(json(["launch", "status", repo]).doc.declaration.polish, null, "no polish block is null, not an error");
  declare("mode: Polish\ndeclared: 2026-11-27\n");
  assert.equal(json(["launch", "status", repo]).doc.mode, "polish", "mode reads lowercase");
  declare("mode: steady\n");
  assert.equal(json(["launch", "status", repo]).doc.mode, "develop", "steady is a legacy alias for develop");
  declare("mode: bogus\n");
  const invalid = json(["launch", "status", repo]);
  assert.equal(invalid.doc.mode, "invalid");
  assert.match(invalid.doc.declaration.error, /mode must be "develop", "launch", "polish" or "live"/);
  declarePolish("polish:\n  cadence: soon\n");
  const broken = json(["launch", "status", repo]);
  assert.equal(broken.doc.mode, "invalid");
  assert.match(broken.doc.declaration.error, /polish\.cadence must be a 5-field cron/);
  rmSync(join(repo, ".launch.yaml"));
  assert.equal(json(["launch", "status", repo]).doc.mode, "absent");
});

await check("polish enable: every-15m default cadence, max_iterations 30, polish job name, mode-aware manifest", () => {
  declarePolish();
  const r = json(["launch", "enable", repo]);
  assert.equal(r.status, 0, r.out + r.err);
  const [job] = jobs();
  assert.equal(jobs().length, 1);
  assert.equal(job.scheduler, "external");
  assert.equal(job.schedule.expr, "*/15 * * * *", "polish default cadence");
  assert.equal(job.economics.max_iterations, 30, "polish runs a bigger budget than launch");
  assert.equal(job.name, "Demo polish pass (every 15m)");
  const manifest = readFileSync(manifestPath, "utf8");
  assert.ok(manifest.startsWith("# Demo polish pass (demo-pm), every 15 minutes by default."), manifest.split("\n")[0]);
  assert.match(manifest, /schedule = "\*\/15 \* \* \* \*"/);
  assert.match(manifest, /only while \.launch\.yaml says `mode: polish`/);
  assert.match(manifest, /launch-mode: develop/, "the quiet-mode comment names develop");
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, true);
  const status = json(["launch", "status", repo]);
  assert.equal(status.doc.ok, true, JSON.stringify(status.doc.problems));
  assert.equal(status.doc.manifest.inSync, true);
  assert.equal(status.doc.polish.metrics, null, "no ledger yet");
  assert.match(flume(["launch", "status", repo]).out, /polish\s+no cycles yet/);
  assert.equal(json(["audit", repo, "--rules", "hermes.launch-mode"]).doc.rules[0].status, "pass");
});

await check("mode switch retunes a factory-default schedule and renames the job; the budget follows the mode", () => {
  declare("mode: launch\ndeclared: 2026-11-27\nsource: test\nepic: DEMO-1\n");
  const r = json(["launch", "enable", repo]);
  assert.equal(r.status, 0, r.out + r.err);
  const [job] = jobs();
  assert.match(job.schedule.expr, /^\d+ 8-22 \* \* \*$/u, "*/15 was polish's factory default, not hand-tuned: retuned to the launch default");
  assert.equal(job.name, "Demo launch pass (hourly)");
  assert.equal(job.economics.max_iterations, 10);
  assert.ok(readFileSync(manifestPath, "utf8").startsWith("# Demo launch pass (demo-pm), hourly at :"), "manifest follows the mode");
  assert.equal(jobs().length, 1, "the same job is retuned, never duplicated");
  declarePolish();
  assert.equal(json(["launch", "enable", repo]).status, 0);
  const [back] = jobs();
  assert.equal(back.schedule.expr, "*/15 * * * *", "and back again");
  assert.equal(back.name, "Demo polish pass (every 15m)");
  assert.equal(back.economics.max_iterations, 30);
});

await check("schedule precedence: --schedule > the declaration's polish.cadence > the mode default", () => {
  declarePolish("polish:\n  cadence: \"*/10 * * * *\"\n");
  assert.equal(json(["launch", "enable", repo]).status, 0);
  assert.equal(jobs()[0].schedule.expr, "*/10 * * * *", "declared cadence beats the adopted job's */15");
  assert.match(readFileSync(manifestPath, "utf8"), /schedule = "\*\/10 \* \* \* \*"/);
  assert.match(readFileSync(manifestPath, "utf8").split("\n")[0], /on "\*\/10 \* \* \* \*"/, "a custom cadence is quoted, not called every 15 minutes");
  const r = json(["launch", "enable", repo, "--schedule", "9 9 * * *"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(jobs()[0].schedule.expr, "9 9 * * *", "--schedule beats the declared cadence");
});

await check("a hand-tuned schedule survives a mode switch; the name and budget still follow the mode", () => {
  declare("mode: launch\ndeclared: 2026-11-27\nsource: test\n");
  assert.equal(json(["launch", "enable", repo]).status, 0);
  const [job] = jobs();
  assert.equal(job.schedule.expr, "9 9 * * *", "9 9 * * * is nobody's factory default: kept");
  assert.equal(job.name, "Demo launch pass (hourly)");
  assert.equal(job.economics.max_iterations, 10);
  declarePolish();
  assert.equal(json(["launch", "enable", repo]).status, 0);
  assert.equal(jobs()[0].schedule.expr, "9 9 * * *", "and kept on the way back");
  assert.equal(jobs()[0].economics.max_iterations, 30);
});

await check("status shows the polish metrics ledger; a missing or broken file is 'no cycles yet', never an error", () => {
  mkdirSync(join(roleDir, "runtime"), { recursive: true });
  writeFileSync(metricsPath, JSON.stringify({
    declared: "2026-11-27", cycles: 3,
    proposed: [{ ref: "DEMO-11", title: "[ux:improvement] The location of the X element sometimes blocks Y", at: "2026-11-27T01:00:00Z" }, { ref: "DEMO-12", title: "[physics:tweak] cue ball force", at: "2026-11-27T01:15:00Z" }],
    implemented: ["DEMO-11"], updated_at: "2026-11-27T01:30:00Z",
  }));
  const status = json(["launch", "status", repo]);
  assert.deepEqual(status.doc.polish.metrics, { cycles: 3, proposed: 2, implemented: 1, updatedAt: "2026-11-27T01:30:00Z" });
  assert.match(flume(["launch", "status", repo]).out, /polish\s+3 cycle\(s\), 2 proposed, 1 implemented \(updated 2026-11-27T01:30:00Z\)/);
  writeFileSync(metricsPath, "{ not json");
  const broken = json(["launch", "status", repo]);
  assert.equal(broken.status, 0, "a broken ledger is never an error");
  assert.equal(broken.doc.polish.metrics, null);
  rmSync(metricsPath);
  assert.match(flume(["launch", "status", repo]).out, /polish\s+no cycles yet/);
  declare("mode: launch\ndeclared: 2026-11-27\nsource: test\n");
  const launchStatus = json(["launch", "status", repo]);
  assert.equal(launchStatus.doc.polish, null, "metrics are a polish-mode read");
  assert.doesNotMatch(flume(["launch", "status", repo]).out, /polish\s+/);
  declarePolish();
});

await check("crank: polish turns crank on like launch", () => {
  const project = join(repo, ".project.json");
  writeFileSync(project, JSON.stringify({ slug: "demo" }));
  const bad = json(["audit", repo, "--rules", "hermes.launch-mode"]);
  assert.equal(bad.doc.rules[0].status, "fail");
  assert.match(bad.doc.rules[0].details.join("\n"), /crank is off \(built-in default\), mode is polish; run: flume launch enable/);
  const fix = json(["launch", "enable", repo]);
  assert.equal(fix.status, 0, fix.out);
  assert.deepEqual(JSON.parse(readFileSync(project, "utf8")).crank, { enabled: true, interval: "5m" });
  assert.equal(json(["audit", repo, "--rules", "hermes.launch-mode"]).doc.rules[0].status, "pass");
});

await check("audit and remediate follow the mode: polish pauses fail, develop with an enabled pass fails", () => {
  const cb = cbState(); cb["demo-pm-launch-pass"].enabled = false; writeFileSync(state, JSON.stringify(cb));
  const paused = json(["audit", repo, "--rules", "hermes.launch-mode"]);
  assert.equal(paused.doc.rules[0].status, "fail");
  assert.match(paused.doc.rules[0].details.join("\n"), /is paused, mode is polish; run: flume launch enable/);
  assert.equal(json(["remediate", "hermes.launch-mode", repo]).status, 0);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, true, "remediate re-enables in polish mode");
  declare("mode: develop\ndeclared: 2026-11-27\nsource: test\n");
  const develop = json(["audit", repo, "--rules", "hermes.launch-mode"]);
  assert.equal(develop.doc.rules[0].status, "fail");
  assert.match(develop.doc.rules[0].details.join("\n"), /enabled but \.launch\.yaml is develop \(develop: the default mode, no pass\); run: flume launch disable/);
  assert.equal(json(["remediate", "hermes.launch-mode", repo]).status, 0);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, false, "remediate pauses in develop mode");
  assert.equal(json(["audit", repo, "--rules", "hermes.launch-mode"]).doc.rules[0].status, "pass");
});

await check("flume mode status|enable|disable drive the same machinery; enable still refuses develop", () => {
  declarePolish();
  const status = json(["mode", "status", repo]);
  assert.equal(status.doc.mode, "polish");
  assert.equal(status.status, 1, "the pass is paused after the develop remediation, so status reports problems");
  assert.match(status.doc.problems.join("\n"), /is paused, mode is polish/);
  assert.equal(status.doc.repo, json(["launch", "status", repo]).doc.repo);
  const enable = json(["mode", "enable", repo, "--dry-run"]);
  assert.equal(enable.doc.ok, true, enable.out);
  assert.equal(enable.doc.operation, "enable");
  assert.ok(enable.doc.changes >= 1, "the pass is paused after the develop remediation");
  assert.equal(json(["mode", "enable", repo]).status, 0);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, true);
  const disable = json(["mode", "disable", repo, "--dry-run"]);
  assert.equal(disable.doc.ok, true);
  assert.equal(disable.doc.changes, 1);
  assert.equal(json(["mode", "disable", repo]).status, 0);
  assert.equal(cbState()["demo-pm-launch-pass"].enabled, false);
  declare("mode: develop\n");
  const refused = json(["mode", "enable", repo]);
  assert.equal(refused.status, 1);
  assert.match(refused.doc.error, /must say `mode: launch` or `mode: polish` \(it is develop\)/);
  assert.match(flume(["mode", "status", repo]).out, /\(mode: develop\)/, "the text status names the mode");
});

rmSync(work, { recursive: true, force: true });
console.log(`project-modes: ${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
