import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as paths from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const { join, resolve } = paths;
const scratch = mkdtempSync(join(tmpdir(), "flume13-"));
const output = join(scratch, "observer.mjs");
const build = spawnSync("esbuild", ["packages/flume-hr/src/org/live-process.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);
const { scanLiveProcesses } = await import(pathToFileURL(output).href);
const registered = [["alpha", "alpha"], ["beta", "beta"]];
const fixtureDir = join(scratch, "fixtures"); mkdirSync(fixtureDir);
const home = join(fixtureDir, "home"); mkdirSync(home);
const fleet = join(home, ".hermes"); mkdirSync(fleet);
const registry = join(fixtureDir, "agents.yaml");
const projects = join(fixtureDir, "projects.yaml");
writeFileSync(registry, `schema_version: 1\nagents:\n${registered.map(([id]) => `  ${id}:\n    repo: ${id}\n    role: pm\n    profile_name: ${id}\n    project_path: ${fixtureDir}\n`).join("")}`);
writeFileSync(projects, "schema_version: 1\nprojects: {}\n");
const hermes = (args = "", env = "", comm = "hermes") => ({ comm, cmdline: `hermes\0${args}`, environ: env });
const gateway = hermes("gateway\0run\0", `HERMES_HOME=${fleet}\0SECRET=planted-secret\0`);
const profile = name => `HERMES_HOME=${fleet}/profiles/${name}\0`;
const fixtures = {
  normal: { 10: gateway, 11: hermes("--profile\0alpha\0worker\0--token=planted-secret\0", profile("alpha")), 12: hermes("-p\0alpha\0chat\0--query\0planted-secret\0"), 13: { comm: "python3", cmdline: "python3\0unrelated.py\0", environ: "" }, 14: { comm: "sleep" } },
  module: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-m\0hermes_cli.main\0--profile\0alpha\0", environ: "" } },
  console: { 10: gateway, 11: { comm: "python3", cmdline: "/usr/bin/python3\0/opt/bin/hermes\0--profile\0alpha\0", environ: "" } },
  equals: { 10: gateway, 11: hermes("--profile=beta\0", profile("alpha")) },
  short: { 10: gateway, 11: hermes("-p\0beta\0", profile("alpha")) },
  repeated: { 10: gateway, 11: hermes("--profile\0alpha\0--profile-name\0beta\0") },
  foreign: { 10: hermes("gateway\0run\0", "HERMES_HOME=/elsewhere\0") },
  foreignClaim: { 10: gateway, 11: hermes("--profile\0alpha\0", "HERMES_HOME=/elsewhere/profiles/beta\0") },
  invalidHome: { 10: gateway, 11: hermes("--profile\0alpha\0", `${profile("beta").slice(0, -1)}/child\0`) },
  unregisteredGateway: { 10: hermes("--profile\0planted-secret\0gateway\0run\0") },
  missingGatewayIdentity: { 10: hermes("gateway\0run\0") },
  duplicateGateway: { 10: gateway, 11: gateway },
  defaultGateway: { 10: hermes("--profile\0default\0gateway\0run\0", `HERMES_HOME=${fleet}\0`) },
  unregistered: { 10: gateway, 11: hermes("--profile\0planted-secret\0") },
  missing: { 10: gateway, 11: hermes() },
  passthrough: { 10: gateway, 11: hermes("--profile\0alpha\0mcp\0add\0tool\0--args\0tool\0--profile\0beta\0", profile("alpha")) },
  prompt: { 10: gateway, 11: hermes("--profile\0alpha\0chat\0--query\0--profile beta\0", profile("alpha")) },
  afterAction: { 10: gateway, 11: hermes("chat\0--profile=beta\0", profile("alpha")) },
  normalized: { 10: gateway, 11: hermes("--model\0planted-secret\0--profile=ALPHA\0chat\0", profile("alpha")) },
  oversized: { 10: gateway, 11: { ...hermes(), cmdline: "x".repeat(16 * 1024 + 1) } },
  deniedPython: { 10: gateway, 11: { comm: "python3", cmdline: null } },
  exited: { 10: gateway, 11: hermes("--profile\0alpha\0", null) },
  deniedComm: { 10: gateway, 11: { comm: null } },
  deniedList: { $listError: true },
  empty: {},
};
const source = rows => ({ list: () => Object.keys(rows), read: (pid, file) => {
  if (rows[pid][file] == null) throw Error("denied planted-secret");
  return Buffer.from(rows[pid][file]);
} });
const scan = rows => scanLiveProcesses(registered, fleet, source(rows), paths);
const copy = JSON.stringify(fixtures);
const env = { ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_FLEET_ENV: join(home, "absent"), FLUME_HOST_OVERLAY: "none", NODE_OPTIONS: `--import=${resolve("tests/helpers/proc-fixture-preload.mjs")}`, NO_COLOR: "1" };
const cli = resolve("packages/flume-hr/dist/index.js");
const fixtureFile = join(fixtureDir, "proc.json");
const guard = join(scratch, "effects");
function snapshot(root) {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name), stat = lstatSync(path);
    const content = stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? snapshot(path) : createHash("sha256").update(readFileSync(path)).digest("hex");
    return [name, stat.mode, stat.mtimeMs, content];
  });
}
function invoke(rows, extra = [], json = true) {
  writeFileSync(fixtureFile, JSON.stringify(rows));
  const before = JSON.stringify(snapshot(fixtureDir));
  const result = spawnSync(process.execPath, [cli, "review", "--agent-registry", registry, "--project-registry", projects, "--deadline-ms", "5000", ...extra, ...(json ? ["--json"] : [])], {
    encoding: "utf8", timeout: 8000, env: { ...env, FLUME_TEST_PROC_FIXTURE: fixtureFile, ...(extra.includes("live_process") ? { FLUME_TEST_PROC_GUARD: guard } : {}) },
  });
  const after = JSON.stringify(snapshot(fixtureDir));
  assert.equal(after, before, "review mutated fixture");
  assert.doesNotMatch(result.stdout + result.stderr, /planted-secret/);
  assert.equal(result.status, 0, result.stderr);
  return json ? JSON.parse(result.stdout).data : result.stdout;
}
try {
  assert.deepEqual(scan(fixtures.normal).processes.map(p => p.pid), [10, 11, 12]);
  assert.equal(scan(fixtures.module).processes[1].employee, "alpha");
  assert.equal(scan(fixtures.console).processes[1].employee, "alpha");
  for (const key of ["equals", "short", "repeated", "foreignClaim", "invalidHome", "afterAction"]) assert.equal(scan(fixtures[key]).processes[1].state, "ambiguous", key);
  for (const key of ["passthrough", "prompt", "normalized"]) assert.equal(scan(fixtures[key]).processes[1].employee, "alpha", key);
  assert.equal(scanLiveProcesses([["alpha", "alpha"], ["other", "alpha"]], fleet, source(fixtures.module), paths).processes[1].state, "ambiguous");
  assert.equal(scan({ ...fixtures.module, 11: { comm: "python3", cmdline: null } }).complete, false);
  assert.equal(scanLiveProcesses(registered, fleet, { list: () => ["10", "10"], read: source({ 10: gateway }).read }, paths).processes.length, 1);
  for (const [key, rows] of Object.entries(fixtures)) {
    const data = invoke(rows, ["--domain", "live_process"]);
    const host = data.host.find(f => f.rule_id === "live_process.host");
    const expected = ["deniedPython", "exited", "deniedComm", "deniedList", "oversized"].includes(key) ? "error" : ["normal", "module", "console", "defaultGateway", "passthrough", "prompt", "normalized", "empty"].includes(key) ? "pass" : "warn";
    assert.equal(host.state, expected, key);
    const pidFindings = [...data.host, ...data.agents.flatMap(a => a.observations)].filter(f => /^processes\.\d+$/.test(f.field ?? "") || /^live_process\.pid\.\d+$/.test(f.rule_id ?? ""));
    if (!key.startsWith("denied") && key !== "oversized") assert.equal(pidFindings.length, Object.values(rows).filter(row => row.comm === "hermes" || row.cmdline?.includes("hermes")).length, `${key}: each selected PID exactly once`);
    if (["module", "console"].includes(key)) assert.ok(data.agents.find(a => a.agent_id === "alpha").observations.some(o => o.field === "processes.11"));
    if (expected !== "pass") {
      assert.equal(data.health.proven, false, key);
      if (expected === "error") assert.equal(data.health.complete, false, key);
      assert.ok(host.owner && host.next_action, key);
    }
    if (expected === "error") assert.equal(data.health.healthy, false, key);
  }
  const aggregate = invoke(fixtures.deniedPython);
  assert.equal(aggregate.health.proven, false);
  assert.equal(aggregate.health.complete, false);
  assert.equal(aggregate.domains.find(d => d.domain === "live_process").state, "error");
  const aggregateObservations = [...aggregate.host, ...aggregate.agents.flatMap(a => a.observations)];
  assert.ok(aggregateObservations.some(f => f.domain === "bloodbank" && f.state === "unsupported"));
  assert.ok(aggregateObservations.some(f => f.domain === "release_provenance"));
  for (const key of ["foreign", "normal", "unregistered", "unregisteredGateway", "deniedPython"]) assert.match(invoke(fixtures[key], ["--domain", "live_process"], false), /gateway|runtime|process/);
  assert.equal(JSON.stringify(fixtures), copy);

  // Exercise a real synchronous read in the probe, not a Promise race around
  // blocking work. A ten-second read must return within the 50 ms probe budget
  // plus process startup/scheduling tolerance, without signalling observed PIDs.
  const slow = { 10: { ...gateway, comm: { value: "hermes", delay: 10_000 } } };
  writeFileSync(fixtureFile, JSON.stringify(slow));
  const driver = join(scratch, "driver.mjs");
  writeFileSync(driver, `import { observeLiveProcesses } from ${JSON.stringify(pathToFileURL(output).href)};\nconst c = new AbortController(); if (process.argv[2] === 'cancel') setTimeout(() => c.abort(), 100);\nconst start = Date.now(); try { const data = await observeLiveProcesses({ signal:c.signal, deadlineAt:process.argv[2] === 'deadline' ? Date.now()+80 : null, probeTimeoutMs:process.argv[2] === 'timeout' ? 50 : 5000 }, new Map(${JSON.stringify(registered)}), ${JSON.stringify(fleet)}); console.log(JSON.stringify({data,elapsed:Date.now()-start})); } catch(e) {console.log(JSON.stringify({code:e.code,elapsed:Date.now()-start}));}`);
  for (const mode of ["timeout", "cancel", "deadline"]) {
    const result = spawnSync(process.execPath, [driver, mode], { encoding: "utf8", timeout: 2000, env: { ...env, FLUME_TEST_PROC_FIXTURE: fixtureFile, FLUME_TEST_PROC_GUARD: guard } });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.elapsed < 1000, `${mode}: actual wall bound ${parsed.elapsed}`);
    console.log(`  ${mode}: ${parsed.elapsed} ms`);
    if (mode === "timeout") { assert.equal(parsed.data.complete, false); assert.match(parsed.data.errors[0], /timeout/); }
    else assert.equal(parsed.code, mode === "cancel" ? "CANCELLED" : "TIMEOUT");
  }
  // Probe spawn failure cannot become a successfully observed empty table.
  writeFileSync(fixtureFile, JSON.stringify(fixtures.empty));
  const failPreload = join(scratch, "fail-spawn.mjs");
  writeFileSync(failPreload, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; cp.spawn=()=>{throw Error('planted-secret')}; syncBuiltinESMExports();`);
  const failure = spawnSync(process.execPath, ["--import", failPreload, driver, "timeout"], { encoding: "utf8", env: { ...env, FLUME_TEST_PROC_GUARD: "" } });
  assert.equal(failure.status, 0, failure.stderr);
  assert.equal(JSON.parse(failure.stdout).data.complete, false);
  assert.match(JSON.parse(failure.stdout).data.errors[0], /failed/);
  const effects = readdirSync(scratch).filter(f => /^effects\.\d+\.json$/.test(f));
  assert.ok(effects.length >= 20, "side-effect guards must have actually run in CLI/probe children");
  for (const file of effects) assert.deepEqual(JSON.parse(readFileSync(join(scratch, file))), [], file);
  console.log("live-process adversarial regressions: PASS (selection, identity, topology, CLI rollups, secrets, zero observed effects, bounded reads, timeout/deadline/cancel/failure)");
} finally { rmSync(scratch, { recursive: true, force: true }); }
