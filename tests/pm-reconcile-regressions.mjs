// Isolated built-CLI installer prototype checks; not live installation acceptance.
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
const repo = join(base, "Demo");
const fleet = join(base, "fleet");
const profile = join(fleet, "profiles", "demo-pm");
const role = join(repo, "agents/hermes/pm");
for (const dir of [join(role, ".scripts"), join(role, "runtime"), profile]) mkdirSync(dir, { recursive: true });
for (const file of ["pm-reconcile.py", "pm-reconcile-liveness.mjs", "pm-reconcile.prompt.md", "launch-pass.py"]) writeFileSync(join(role, ".scripts", file), "fixture\n");
const roleFile = join(role, "role.yaml");
const rolePolicy = (enabled, optOut = false) => writeFileSync(roleFile, YAML.stringify({ role: "pm", plane: { identifier: "33GOD" }, reconcile: { enabled, explicit_opt_out: optOut } }));
rolePolicy(true);
const board = "board-demo";
const agents = {
  "demo-pm": { role: "pm", repo: "demo", project_path: repo, role_dir: role, profile_name: "demo-pm", plane: { project_id: board, scope_default: true, scope_label: ["repo:demo"] }, bloodbank: { enabled: true, gateway_scope: "fleet", target_agent_id: "demo-pm" } },
  "else-pm": { role: "pm", repo: "else", project_path: join(base, "else"), profile_name: "else-pm", plane: { project_id: board, scope_label: ["repo:else"] }, bloodbank: { enabled: true, gateway_scope: "fleet", target_agent_id: "else-pm" } },
};
const registry = join(fleet, "agents-registry.yaml");
const updateRegistry = () => writeFileSync(registry, YAML.stringify({ agents }));
updateRegistry();
// Deliberately inherit no provider credentials or production profile selectors.
const bin = join(base, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "px"), "#!/usr/bin/env python3\nimport json,sys\nassert sys.argv[1:3] == ['task','get']\nprint(json.dumps({'ticket':{'ref':sys.argv[3],'label_names':['repo:demo']}}))\n");
chmodSync(join(bin, "px"), 0o755);
const env = { PATH: `${bin}:${process.env.PATH}`, HOME: base, TMPDIR: base, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry,
  FLUME_HERMES_PYTHON: join(ROOT, "tests/helpers/fake-hermes-python.py") };
const cli = (args) => {
  const r = spawnSync("node", [CLI, "reconcile", ...args, "--json"], { env, cwd: repo, encoding: "utf8", timeout: 60000 });
  return { status: r.status, data: JSON.parse(r.stdout), stderr: r.stderr };
};
let count = 0;
const check = (label, fn) => { fn(); count++; console.log(`PASS ${label}`); };
try {
  check("33GOD board and uppercase repository retain exact owner routing", () => {
    const c = cli(["status", repo]);
    assert.equal(c.status, 0, JSON.stringify(c));
    assert.equal(c.data.board, "33GOD");
    assert.deepEqual(c.data.scopes.map((s) => s.label).sort(), ["(unlabeled)", "repo:demo"]);
    assert.deepEqual(cli(["authority", repo]).data.scopes, ["repo:demo"]);
    const exact = cli(["ticket-authority", "33GOD-1", repo]);
    assert.equal(exact.status, 0, JSON.stringify(exact));
    assert.equal(exact.data.ok, true);
    assert.equal(exact.data.scope, "repo:demo");
  });
  check("shared-board unlabeled intake is visible but not authorized", () => {
    assert.equal(cli(["authority", repo]).data.scopes.includes("(unlabeled)"), false);
  });
  check("installation preview is inert and explicitly not install-ready", () => {
    const p = cli(["install", repo]);
    assert.equal(p.status, 0, JSON.stringify(p));
    assert.equal(p.data.applied, false);
    assert.ok(p.data.actions.some((a) => a.detail.includes("NOT install-ready")));
    assert.equal(existsSync(join(profile, "cron/jobs.json")), false);
    assert.equal(existsSync(join(repo, ".candybars")), false);
  });
  check("isolated apply creates only paused job and lowercase disabled manifest", () => {
    const p = cli(["install", repo, "--apply"]);
    assert.equal(p.status, 0, JSON.stringify(p));
    const jobs = JSON.parse(readFileSync(join(profile, "cron/jobs.json"))).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].enabled, false);
    assert.equal(jobs[0].scheduler, "external");
    assert.match(jobs[0].prompt, /Automatic board writes are disabled/);
    assert.deepEqual(jobs[0].enabled_toolsets, ["terminal", "file", "no_mcp"]);
    assert.deepEqual(jobs[0].skills, []);
    const manifest = join(repo, ".candybars/demo-pm-reconcile.candybar.toml");
    assert.match(readFileSync(manifest, "utf8"), /enabled = false/);
    assert.match(readFileSync(manifest, "utf8"), /name = "demo-pm-reconcile"/);
    assert.equal(cli(["status", repo]).data.manifest, manifest);
    for (const file of ["pm-reconcile-monitor.sh", "pm-reconcile-brief.sh"]) assert.ok(statSync(join(profile, "scripts", file)).mode & 0o111);
  });
  check("repeated installation changes no job or manifest", () => {
    const job = join(profile, "cron/jobs.json"), manifest = join(repo, ".candybars/demo-pm-reconcile.candybar.toml");
    const before = [statSync(job).mtimeMs, statSync(manifest).mtimeMs];
    assert.equal(cli(["install", repo, "--apply"]).status, 0);
    assert.deepEqual([statSync(job).mtimeMs, statSync(manifest).mtimeMs], before);
  });
  check("opt-out and every Krebs inactive lifecycle form deny authority and install", () => {
    rolePolicy(false, true);
    assert.equal(cli(["install", repo, "--apply"]).status, 1);
    assert.match(cli(["status", repo]).data.problems.join(" "), /opt-out/);
    rolePolicy(true);
    const forms = [
      ...["status", "employment"].flatMap((key) => ["retired", "suspended", "offboarded", " ReTiReD "].map((value) => ({ [key]: value }))),
      { retired: true }, { retired_at: "2026-11-22" }, { retired_at: 1234 },
      { bloodbank: { ...agents["demo-pm"].bloodbank, enabled: false } },
    ];
    const original = structuredClone(agents["demo-pm"]);
    const jobBefore = readFileSync(join(profile, "cron/jobs.json"), "utf8");
    for (const form of forms) {
      agents["demo-pm"] = { ...original, ...form };
      updateRegistry();
      const coverage = cli(["status", repo]).data;
      assert.equal(coverage.ok, false, JSON.stringify(form));
      assert.equal(coverage.enabled, false, JSON.stringify(form));
      assert.ok(coverage.scopes.every((s) => !s.eligible));
      assert.equal(cli(["authority", repo]).data.ok, false);
      assert.equal(cli(["ticket-authority", "33GOD-1", repo]).data.ok, false);
      assert.equal(cli(["install", repo, "--apply"]).status, 1);
    }
    assert.equal(readFileSync(join(profile, "cron/jobs.json"), "utf8"), jobBefore);
    agents["demo-pm"] = original;
    updateRegistry();
  });
  check("POSIX wrappers execute literal apostrophe and substitution paths", () => {
    const maliciousRole = join(repo, "agents", "pm'$(touch PWNED)'`touch BACKTICK` space");
    mkdirSync(join(maliciousRole, ".scripts"), { recursive: true });
    writeFileSync(join(maliciousRole, "role.yaml"), readFileSync(roleFile));
    for (const file of ["pm-reconcile-liveness.mjs", "launch-pass.py"]) writeFileSync(join(maliciousRole, ".scripts", file), "fixture\n");
    const driver = join(maliciousRole, ".scripts/pm-reconcile.py");
    writeFileSync(driver, "import json,sys\nprint(json.dumps({'file':__file__,'args':sys.argv[1:]}))\n");
    agents["demo-pm"].role_dir = maliciousRole;
    updateRegistry();
    assert.equal(cli(["install", repo, "--apply"]).status, 0);
    for (const mode of ["monitor", "brief"]) {
      const wrapper = join(profile, "scripts", `pm-reconcile-${mode}.sh`);
      const r = spawnSync("/bin/sh", [wrapper], { env, cwd: base, encoding: "utf8", timeout: 10000 });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { file: driver, args: [`--${mode}`] });
    }
    assert.equal(existsSync(join(base, "PWNED")), false);
    assert.equal(existsSync(join(base, "BACKTICK")), false);
    assert.equal(cli(["status", repo]).data.wrappers, true);
    agents["demo-pm"].role_dir = role;
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
console.log(`${count} isolated PM reconcile built-CLI checks passed; NOT production acceptance`);
