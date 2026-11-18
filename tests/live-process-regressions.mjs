import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "flume13-"));
const output = join(scratch, "observer.mjs");
const build = spawnSync("esbuild", ["packages/flume-hr/src/org/live-process.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);
const { observeLiveProcesses } = await import(pathToFileURL(output).href);
const run = { signal: new AbortController().signal, deadlineAt: Date.now() + 5000, probeTimeoutMs: 50 };
const registered = new Map([["alpha", "alpha"], ["beta", "beta"]]);
const home = "/fleet";
const snapshots = new Map([
  ["1", { comm: "hermes", cmdline: "/bin/hermes\0gateway\0run\0", environ: "HERMES_HOME=/fleet\0SECRET_KEY=planted-secret\0" }],
  ["2", { comm: "hermes", cmdline: "/bin/hermes\0--profile\0alpha\0worker\0--token=planted-secret\0", environ: "HERMES_HOME=/fleet/profiles/alpha\0" }],
  ["3", { comm: "python", cmdline: "python\0unrelated\0", environ: "" }],
  ["4", { comm: "hermes", cmdline: "/bin/hermes\0--profile\0alpha\0--profile\0beta\0", environ: "" }],
  ["5", { comm: "hermes", cmdline: "/bin/hermes\0--profile\0stranger\0", environ: "" }],
  ["6", { comm: "hermes", cmdline: "/bin/hermes\0", environ: "" }],
]);
const copy = JSON.stringify([...snapshots]);
const readOnly = { list: () => [...snapshots.keys()], read: (pid, file) => Buffer.from(snapshots.get(pid)[file]) };
try {
  const report = observeLiveProcesses(run, registered, home, readOnly);
  assert.deepEqual(report.processes.map(p => p.pid), [1, 2, 4, 5, 6]);
  assert.deepEqual(report.processes.map(p => [p.employee, p.state]), [[null, "unattributed"], ["alpha", "attributed"], [null, "ambiguous"], [null, "unattributed"], [null, "unattributed"]]);
  assert.equal(report.complete, true);
  assert.equal(JSON.stringify([...snapshots]), copy);
  assert.doesNotMatch(JSON.stringify(report), /planted-secret/);
  assert.equal(observeLiveProcesses(run, new Map([["alpha", "alpha"], ["other", "alpha"]]), home, { list: () => ["2"], read: readOnly.read }).processes[0].state, "ambiguous");
  assert.deepEqual(observeLiveProcesses(run, registered, home, { list: () => [], read: () => { throw Error("not called"); } }), { processes: [], errors: [], complete: true });
  assert.equal(observeLiveProcesses(run, registered, home, { list: () => { throw Error("denied"); }, read: () => { throw Error("not called"); } }).complete, false);
  const exited = observeLiveProcesses(run, registered, home, { list: () => ["1"], read: (_pid, file) => file === "environ" ? (() => { throw Error("exited"); })() : Buffer.from(snapshots.get("1")[file]) });
  assert.equal(exited.processes[0].state, "error");
  assert.equal(exited.complete, false);
  assert.throws(() => observeLiveProcesses({ ...run, deadlineAt: Date.now() - 1 }, registered, home, readOnly), /deadline/);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => observeLiveProcesses({ ...run, signal: controller.signal }, registered, home, readOnly), /cancelled/);
  console.log("live-process focused fixtures: PASS (selection, attribution, conflicts, missing, empty, denied, exited, deadline, cancel, read-only and secrets)");
} finally { rmSync(scratch, { recursive: true, force: true }); }
