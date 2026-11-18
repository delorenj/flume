import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as paths from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  emptyModelSole: { 10: gateway, 11: hermes("--model\0\0--profile=beta\0chat\0") },
  emptyQuerySole: { 10: gateway, 11: hermes("chat\0--query\0\0--profile=beta\0") },
  emptyModelConflict: { 10: gateway, 11: hermes("--model\0\0--profile=beta\0chat\0", profile("alpha")) },
  emptyQueryConflict: { 10: gateway, 11: hermes("chat\0--query\0\0--profile=beta\0", profile("alpha")) },
  emptyRepeated: { 10: gateway, 11: hermes("--model\0\0--profile=alpha\0--profile=beta\0chat\0") },
  switchedModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-u\0-I\0-m\0hermes_cli.main\0--profile=alpha\0", environ: "" } },
  switchedConsole: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-Bu\0/opt/bin/hermes\0--profile=alpha\0", environ: "" } },
  valueSwitchModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-W\0ignore\0-X\0dev\0--check-hash-based-pycs\0always\0-m\0hermes_cli.main\0--profile=alpha\0", environ: "" } },
  combinedValueSwitch: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-Wignore\0-Xdev\0--check-hash-based-pycs=always\0/opt/bin/hermes\0--profile=alpha\0", environ: "" } },
  attachedModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-mhermes_cli.main\0--profile=alpha\0", environ: "" } },
  groupedModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-um\0hermes_cli.main\0--profile=alpha\0", environ: "" } },
  groupedAttachedModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-Bumhermes_cli.main\0--profile=alpha\0", environ: "" } },
  groupedValueModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-uWignore\0-Xdev\0-mhermes_cli.main\0--profile=alpha\0", environ: "" } },
  groupedValueConsole: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-uXdev\0/opt/bin/hermes\0--profile=alpha\0", environ: "" } },
  groupedSeparatedValue: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-uW\0ignore\0-um\0hermes_cli.main\0--profile=alpha\0", environ: "" } },
  doubleDashConsole: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-u\0--\0/opt/bin/hermes\0--profile=alpha\0", environ: "" } },
  doubleDashModulePayload: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0--\0-mhermes_cli.main\0--profile=alpha\0", environ: "" } },
  valueSuffixNotModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-Wignoremhermes_cli.main\0unrelated.py\0--profile=alpha\0", environ: "" } },
  valueConsumesModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-uW\0-mhermes_cli.main\0unrelated.py\0--profile=alpha\0", environ: "" } },
  groupedCodePayload: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-uc\0hermes\0-mhermes_cli.main\0--profile=alpha\0", environ: "" } },
  attachedCodePayload: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-cprint('hermes')\0-mhermes_cli.main\0--profile=alpha\0", environ: "" } },
  stdinPayload: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-u\0-\0-mhermes_cli.main\0--profile=alpha\0", environ: "" } },
  scriptModulePayload: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0unrelated.py\0-mhermes_cli.main\0--profile=alpha\0", environ: "" } },
  unknownGroupedModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0--unknown\0-um\0hermes_cli.main\0--profile=alpha\0", environ: "" } },
  unknownAttachedModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0--unknown\0-mhermes_cli.main\0--profile=alpha\0", environ: "" } },
  unknownGroupedSwitch: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-uZ\0-mhermes_cli.main\0--profile=alpha\0", environ: "" } },
  missingModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-um\0", environ: "" } },
  pythonCommandPayload: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-u\0-c\0hermes\0-m\0hermes_cli.main\0--profile=alpha\0", environ: "" } },
  pythonScriptPayload: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0-u\0/other.py\0hermes\0--profile=alpha\0", environ: "" } },
  unknownSwitchModule: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0--unknown\0-m\0hermes_cli.main\0--profile=alpha\0", environ: "" } },
  unknownValueSwitch: { 10: gateway, 11: { comm: "python3", cmdline: "python3\0--unknown\0value\0-m\0hermes_cli.main\0--profile=alpha\0", environ: "" } },
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
  for (const key of ["equals", "short", "repeated", "foreignClaim", "invalidHome", "afterAction", "emptyModelConflict", "emptyQueryConflict", "emptyRepeated"]) assert.equal(scan(fixtures[key]).processes[1].state, "ambiguous", key);
  for (const key of ["passthrough", "prompt", "normalized", "switchedModule", "switchedConsole", "valueSwitchModule", "combinedValueSwitch", "attachedModule", "groupedModule", "groupedAttachedModule", "groupedValueModule", "groupedValueConsole", "groupedSeparatedValue", "doubleDashConsole"]) assert.equal(scan(fixtures[key]).processes[1].employee, "alpha", key);
  for (const key of ["emptyModelSole", "emptyQuerySole"]) assert.equal(scan(fixtures[key]).processes[1].employee, "beta", key);
  const excludedPython = ["pythonCommandPayload", "pythonScriptPayload", "valueSuffixNotModule", "valueConsumesModule", "groupedCodePayload", "attachedCodePayload", "stdinPayload", "scriptModulePayload", "doubleDashModulePayload"];
  for (const key of excludedPython) {
    assert.deepEqual(scan(fixtures[key]).processes.map(p => p.pid), [10], key);
    assert.equal(scan(fixtures[key]).complete, true, key);
  }
  assert.equal(scan(fixtures.missingModule).complete, false);
  for (const key of ["unknownGroupedModule", "unknownAttachedModule", "unknownGroupedSwitch"]) assert.equal(scan(fixtures[key]).complete, false, key);
  assert.equal(scan(fixtures.unknownSwitchModule).complete, false);
  assert.equal(scan(fixtures.unknownValueSwitch).complete, false);
  assert.equal(scanLiveProcesses([["alpha", "alpha"], ["other", "alpha"]], fleet, source(fixtures.module), paths).processes[1].state, "ambiguous");
  assert.equal(scan({ ...fixtures.module, 11: { comm: "python3", cmdline: null } }).complete, false);
  assert.equal(scanLiveProcesses(registered, fleet, { list: () => ["10", "10"], read: source({ 10: gateway }).read }, paths).processes.length, 1);
  for (const [key, rows] of Object.entries(fixtures)) {
    const data = invoke(rows, ["--domain", "live_process"]);
    const host = data.host.find(f => f.rule_id === "live_process.host");
    const expected = ["deniedPython", "exited", "deniedComm", "deniedList", "oversized", "unknownSwitchModule", "unknownValueSwitch", "unknownGroupedModule", "unknownAttachedModule", "unknownGroupedSwitch", "missingModule"].includes(key) ? "error" : ["normal", "module", "console", "defaultGateway", "passthrough", "prompt", "normalized", "empty", "emptyModelSole", "emptyQuerySole", "switchedModule", "switchedConsole", "valueSwitchModule", "combinedValueSwitch", "attachedModule", "groupedModule", "groupedAttachedModule", "groupedValueModule", "groupedValueConsole", "groupedSeparatedValue", "doubleDashConsole", ...excludedPython].includes(key) ? "pass" : "warn";
    assert.equal(host.state, expected, key);
    const pidFindings = [...data.host, ...data.agents.flatMap(a => a.observations)].filter(f => /^processes\.\d+$/.test(f.field ?? "") || /^live_process\.pid\.\d+$/.test(f.rule_id ?? ""));
    const selected = [...excludedPython, "unknownSwitchModule", "unknownValueSwitch", "unknownGroupedModule", "unknownAttachedModule", "unknownGroupedSwitch", "missingModule"].includes(key) ? 1 : Object.values(rows).filter(row => row.comm === "hermes" || row.cmdline?.includes("hermes")).length;
    if (!key.startsWith("denied") && key !== "oversized") assert.equal(pidFindings.length, selected, `${key}: each selected PID exactly once`);
    if (["module", "console", "switchedModule", "switchedConsole", "valueSwitchModule", "combinedValueSwitch", "attachedModule", "groupedModule", "groupedAttachedModule", "groupedValueModule", "groupedValueConsole", "groupedSeparatedValue", "doubleDashConsole"].includes(key)) assert.ok(data.agents.find(a => a.agent_id === "alpha").observations.some(o => o.field === "processes.11"));
    if (["emptyModelSole", "emptyQuerySole"].includes(key)) assert.ok(data.agents.find(a => a.agent_id === "beta").observations.some(o => o.field === "processes.11"));
    if (["emptyModelConflict", "emptyQueryConflict", "emptyRepeated"].includes(key)) assert.ok(data.host.some(f => f.rule_id === "live_process.pid.11" && f.state !== "pass"), `${key}: conflict belongs to host`);
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

  const nativeModuleForms = [["-mjson.tool"], ["-um", "json.tool"], ["-Bumjson.tool"], ["-uWignore", "-Xdev", "-mjson.tool"]];
  for (const pythonArgs of nativeModuleForms) {
    const result = spawnSync("/usr/bin/python3", pythonArgs, { input: "{}", encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, `${pythonArgs.join(" ")}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).constructor, Object);
  }
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
  // Real /proc startup shape: sitecustomize stalls our own Python child before
  // importing Hermes. Only /proc listing is scoped; metadata comes from Linux.
  const startup = join(scratch, "startup"); mkdirSync(startup);
  writeFileSync(join(startup, "sitecustomize.py"), "import os,time\nos.write(1,b'owned-startup-ready\\n')\ntime.sleep(20)\nraise SystemExit(0)\n");
  for (const pythonArgs of [["-u", "-m", "hermes_cli.main", "--profile=alpha"], ["-mhermes_cli.main", "--profile=alpha"], ["-um", "hermes_cli.main", "--profile=alpha"], ["-Bumhermes_cli.main", "--profile=alpha"]]) {
    const child = spawn("/usr/bin/python3", pythonArgs, {
      env: { HOME: home, PATH: "/usr/bin:/bin", PYTHONPATH: startup, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((ok, fail) => {
        const timeout = setTimeout(() => fail(Error("owned Python startup timed out")), 2500);
        child.once("error", error => { clearTimeout(timeout); fail(error); });
        child.stdout.once("data", data => { clearTimeout(timeout); assert.match(String(data), /owned-startup-ready/); ok(); });
      });
      assert.equal(readFileSync(`/proc/${child.pid}/comm`, "utf8").trim(), "python3");
      const actualArgv = readFileSync(`/proc/${child.pid}/cmdline`, "utf8").split("\0"); actualArgv.pop();
      assert.deepEqual(actualArgv.slice(1), pythonArgs);
      const ownedOnly = join(scratch, "owned-proc.mjs");
      writeFileSync(ownedOnly, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const list=fs.readdirSync.bind(fs); fs.readdirSync=(p,...args)=>p==='/proc'?[${JSON.stringify(String(child.pid))}]:list(p,...args);syncBuiltinESMExports();`);
      const result = spawnSync(process.execPath, [cli, "review", "--domain", "live_process", "--agent-registry", registry, "--project-registry", projects, "--deadline-ms", "3000", "--json"], {
        encoding: "utf8", timeout: 5000, env: { ...env, NODE_OPTIONS: `--import=${ownedOnly}` },
      });
      assert.equal(result.status, 0, result.stderr);
      const data = JSON.parse(result.stdout).data;
      assert.ok(data.agents.find(a => a.agent_id === "alpha").observations.some(o => o.field === `processes.${child.pid}`), "owned real /proc startup is attributed");
      assert.match(data.host.find(f => f.rule_id === "live_process.host").observed, /1 selected process/);
    } finally {
      child.kill("SIGKILL");
      await new Promise(ok => child.once("close", ok));
    }
  }
  console.log("live-process adversarial regressions: PASS (selection, identity, topology, CLI rollups, secrets, zero observed effects, bounded reads, timeout/deadline/cancel/failure, owned real /proc startup)");
} finally { rmSync(scratch, { recursive: true, force: true }); }
