// Built-CLI fixture: one PM, a shared-board claimant and an opted-out desk.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages/flume-hr/dist/index.js");
assert.ok(existsSync(CLI), "build the CLI before the regression");
const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "flume111-"));
const repo = join(base, "demo");
const fleet = join(base, "fleet");
const profile = join(fleet, "profiles", "demo-pm");
const role = join(repo, "agents/hermes/pm");
for (const dir of [join(role, ".scripts"), join(role, "runtime"), profile]) mkdirSync(dir, { recursive: true });
for (const file of ["pm-reconcile.py", "pm-reconcile-liveness.mjs", "pm-reconcile.prompt.md", "launch-pass.py"]) writeFileSync(join(role, ".scripts", file), "fixture\n");
const roleFile = join(role, "role.yaml");
const rolePolicy = (enabled, optOut = false) => writeFileSync(roleFile, YAML.stringify({ role: "pm", plane: { identifier: "DEMO" }, reconcile: { enabled, explicit_opt_out: optOut } }));
rolePolicy(true);
const board = "board-demo";
const agents = {
  "demo-pm": { role: "pm", repo: "demo", project_path: repo, role_dir: role, profile_name: "demo-pm", plane: { project_id: board, scope_default: true, scope_label: ["repo:demo"] }, bloodbank: { enabled: true, gateway_scope: "fleet", target_agent_id: "demo-pm" } },
  "else-pm": { role: "pm", repo: "else", project_path: join(base, "else"), profile_name: "else-pm", plane: { project_id: board, scope_label: ["repo:else"] }, bloodbank: { enabled: true, gateway_scope: "fleet", target_agent_id: "else-pm" } },
};
const registry = join(fleet, "agents-registry.yaml");
const updateRegistry = () => writeFileSync(registry, YAML.stringify({ agents }));
updateRegistry();
const env = { ...process.env, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry,
  FLUME_HERMES_PYTHON: join(ROOT, "tests/helpers/fake-hermes-python.py") };
const cli = (args) => {
  const r = spawnSync("node", [CLI, "reconcile", ...args, "--json"], { env, cwd: repo, encoding: "utf8", timeout: 60000 });
  return { status: r.status, data: JSON.parse(r.stdout), stderr: r.stderr };
};
let count = 0;
const check = (label, fn) => { fn(); count++; console.log(`PASS ${label}`); };
try {
  check("scoped coverage reports owning labels without adopting foreign ones", () => {
    const c = cli(["status", repo]);
    assert.equal(c.status, 0, JSON.stringify(c));
    assert.deepEqual(c.data.scopes.map((s) => s.label).sort(), ["(unlabeled)", "repo:demo"]);
    assert.deepEqual(cli(["authority", repo]).data.scopes, ["repo:demo"]);
  });
  check("shared-board unlabeled intake is visible but not automatically authorized", () => {
    assert.equal(cli(["authority", repo]).data.scopes.includes("(unlabeled)"), false);
  });
  check("installation preview is inert", () => {
    const p = cli(["install", repo]);
    assert.equal(p.status, 0, JSON.stringify(p));
    assert.equal(p.data.applied, false);
    assert.ok(p.data.actions.some((a) => a.detail.includes("disabled manifest")));
    assert.equal(existsSync(join(profile, "cron", "jobs.json")), false);
    assert.equal(existsSync(join(repo, ".candybars")), false);
  });
  check("explicit apply installs paused external job and disabled manifest without Candybar", () => {
    const p = cli(["install", repo, "--apply"]);
    assert.equal(p.status, 0, JSON.stringify(p));
    const jobs = JSON.parse(readFileSync(join(profile, "cron/jobs.json"))).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].enabled, false);
    assert.equal(jobs[0].scheduler, "external");
    assert.deepEqual(jobs[0].enabled_toolsets, ["terminal", "file", "no_mcp"]);
    assert.deepEqual(jobs[0].skills, []);
    assert.match(readFileSync(join(repo, ".candybars/demo-pm-reconcile.candybar.toml"), "utf8"), /enabled = false/);
    assert.match(readFileSync(join(role, "runtime/pm-reconcile.json"), "utf8"), /"employee": "demo-pm"/);
    for (const file of ["pm-reconcile-monitor.sh", "pm-reconcile-brief.sh"]) assert.ok(statSync(join(profile, "scripts", file)).mode & 0o111);
  });
  check("repeated installation changes no job or manifest", () => {
    const job = join(profile, "cron/jobs.json"), manifest = join(repo, ".candybars/demo-pm-reconcile.candybar.toml");
    const before = [statSync(job).mtimeMs, statSync(manifest).mtimeMs];
    const p = cli(["install", repo, "--apply"]);
    assert.equal(p.status, 0, JSON.stringify(p));
    assert.deepEqual([statSync(job).mtimeMs, statSync(manifest).mtimeMs], before);
  });
  check("opt-out and retired rows remain inactive", () => {
    rolePolicy(false, true);
    assert.equal(cli(["install", repo, "--apply"]).status, 1);
    assert.match(cli(["status", repo]).data.problems.join(" "), /opt-out/);
    rolePolicy(true);
    agents["demo-pm"].bloodbank.enabled = false;
    updateRegistry();
    assert.equal(cli(["install", repo]).status, 1);
    agents["demo-pm"].bloodbank.enabled = true;
    updateRegistry();
  });
  check("duplicate and conflicting jobs refuse installation", () => {
    const path = join(profile, "cron/jobs.json");
    const jobs = JSON.parse(readFileSync(path));
    jobs.jobs.push({ ...jobs.jobs[0], id: "second" });
    writeFileSync(path, JSON.stringify(jobs));
    assert.match(cli(["install", repo]).data.error, /duplicate/);
    jobs.jobs.pop(); jobs.jobs[0].scheduler = "internal";
    writeFileSync(path, JSON.stringify(jobs));
    assert.match(cli(["install", repo]).data.error, /conflicts/);
  });
} finally { rmSync(base, { recursive: true, force: true }); }
console.log(`${count} PM reconcile built-CLI checks passed`);
