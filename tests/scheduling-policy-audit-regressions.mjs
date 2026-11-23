import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { canonicalPolicy, START, END } from "../scripts/lib/scheduling-policy.mjs";

const root = resolve(import.meta.dirname, ".."), work = mkdtempSync(join(tmpdir(), "flume-policy-audit-"));
const fleet = join(work, "fleet"), registry = join(work, "registry.yaml"), soul = join(fleet, "profiles/current/SOUL.md");
const policy = canonicalPolicy(root);
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const row = { role: "dev", profile_name: "current" };
const save = agents => put(registry, YAML.stringify({ agents }));
const run = (script = join(root, "scripts/audit-scheduling-policy.mjs")) => spawnSync(process.execPath, [script, "--registry", registry, "--fleet-home", fleet], { encoding: "utf8", timeout: 3000 });
const report = (exit, script) => { const result = run(script); assert.equal(result.status, exit, result.stdout + result.stderr + String(result.error ?? "")); return JSON.parse(result.stdout); };
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
try {
  put(soul, `# Preserve persona\n${policy}\n`);
  const config = join(fleet, "profiles/current/config.yaml"), service = join(work, "worker.service");
  put(config, "model: unchanged\n"); put(service, "[Service]\nExecStart=/bin/true\n"); save({ current: row });
  const snapshot = () => Object.fromEntries([registry, soul, config, service].map(path => [path, { bytes: readFileSync(path).toString("hex"), mtime: lstatSync(path).mtimeMs, mode: lstatSync(path).mode }]));
  check("current CLI audit is read-only and limits its positive claim to on-disk instructions", () => {
    const before = snapshot(), result = report(0);
    assert.equal(result.ok, true); assert.equal(result.read_only, true);
    assert.equal(result.runtime_schedules_assessed, false);
    assert.equal(result.running_sessions_assessed, false);
    assert.equal(result.coverage_scope, "registered-profile-soul-policy-bytes");
    assert.deepEqual(snapshot(), before);
  });
  check("malformed role/employment and duplicate profile rows never certify current coverage", () => {
    for (const invalid of [null, [], {}, { profile_name: "current" }, { ...row, role: 2 }, { ...row, role: "" }, { ...row, role: {} }, { ...row, employment: [] }, { ...row, employment: "invented" }]) {
      save({ invalid }); const before = snapshot(), result = report(1);
      assert.equal(result.counts.pass, 0); assert.equal(result.counts.unproven, 1); assert.deepEqual(snapshot(), before);
    }
    save({ "bad/id": row }); const invalidId = report(1);
    assert.equal(invalidId.counts.unproven, 1);
    save({ a: row, b: row }); const before = snapshot(), result = report(1);
    assert.deepEqual(result.counts, { pass: 0, drift: 0, unproven: 2 }); assert.deepEqual(snapshot(), before);
  });
  check("unreadable, non-UTF8 and nonregular SOUL inputs remain incomplete without mutation or hangs", () => {
    save({ current: row });
    const original = readFileSync(soul); chmodSync(soul, 0); const before = lstatSync(soul);
    assert.equal(report(1).counts.unproven, 1); assert.equal(lstatSync(soul).mtimeMs, before.mtimeMs); assert.equal(lstatSync(soul).mode, before.mode);
    chmodSync(soul, 0o600); assert.deepEqual(readFileSync(soul), original);
    put(soul, Buffer.concat([Buffer.from(policy), Buffer.from([0xff])])); assert.equal(report(1).counts.unproven, 1);
    rmSync(soul); assert.equal(spawnSync("mkfifo", [soul]).status, 0); assert.equal(report(1).counts.unproven, 1); rmSync(soul);
    put(soul, policy + "x".repeat(1024 * 1024)); assert.equal(report(1).counts.unproven, 1);
    const target = join(work, "runtime-SOUL.md"); put(target, policy); rmSync(soul); symlinkSync(target, soul); assert.equal(report(0).counts.pass, 1);
  });
  check("opened descriptors bound raced growth and short reads while preserving valid runtime links", () => {
    const preload = join(work, "race.cjs"), receipt = join(work, "read-receipt.json");
    put(preload, `const fs = require("node:fs"), cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = { open: fs.openSync, stat: fs.fstatSync, read: fs.readSync, close: fs.closeSync };
let fd, bytes = 0, closed = false, triggered = false;
fs.openSync = function(path, ...args) {
  if (path === process.env.RACE_TARGET && process.env.RACE_MODE === "fifo") {
    fs.unlinkSync(path); if (cp.spawnSync("mkfifo", [path]).status) throw new Error("fixture mkfifo failed"); triggered = true;
  }
  const opened = original.open.call(this, path, ...args);
  if (path === process.env.RACE_TARGET) {
    fd = opened;
    if (process.env.RACE_MODE === "rename") {
      fs.renameSync(path, path + ".original"); fs.writeFileSync(path, "replacement without policy"); triggered = true;
    }
  }
  return opened;
};
fs.fstatSync = function(opened, ...args) {
  const result = original.stat.call(this, opened, ...args);
  if (opened === fd && process.env.RACE_MODE === "grow") { fs.appendFileSync(process.env.RACE_TARGET, "x".repeat(1024 * 1024 + 1)); triggered = true; }
  return result;
};
fs.readSync = function(opened, buffer, offset, length, position) {
  if (opened === fd && process.env.RACE_MODE === "short") { length = Math.min(length, 7); triggered = true; }
  const count = original.read.call(this, opened, buffer, offset, length, position);
  if (opened === fd) bytes += count;
  return count;
};
fs.closeSync = function(opened) { if (opened === fd) { closed = true; fd = undefined; } return original.close.call(this, opened); };
syncBuiltinESMExports();
process.on("exit", () => fs.writeFileSync(process.env.RACE_RECEIPT, JSON.stringify({ bytes, closed, triggered })));
`);
    rmSync(soul); put(soul, policy); save({ current: row });
    for (const [mode, exit] of [["short", 0], ["grow", 1], ["rename", 0], ["fifo", 1]]) {
      rmSync(soul, { force: true }); put(soul, policy);
      const result = spawnSync(process.execPath, ["--require", preload, join(root, "scripts/audit-scheduling-policy.mjs"), "--registry", registry, "--fleet-home", fleet], {
        encoding: "utf8", timeout: 3000, env: { ...process.env, RACE_MODE: mode, RACE_TARGET: soul, RACE_RECEIPT: receipt },
      });
      assert.equal(result.status, exit, result.stdout + result.stderr + String(result.error ?? ""));
      const seen = JSON.parse(readFileSync(receipt, "utf8")); assert.equal(seen.triggered, true); assert.equal(seen.closed, true);
      assert.ok(seen.bytes <= 1024 * 1024 + 1);
      if (mode === "short" || mode === "rename") assert.equal(seen.bytes, Buffer.byteLength(policy));
      if (mode === "grow") assert.equal(seen.bytes, 1024 * 1024 + 1);
    }
    rmSync(soul); put(soul, policy);
  });
  check("missing, duplicate-key, non-UTF8, nonregular and oversized registry inputs fail closed", () => {
    for (const invalid of ["agents: {}\n", "agents: []\n", "agents: {a: {}, a: {}}\n", "agents:\n  1: {role: dev, profile_name: missing}\n  \"1\": {role: dev, profile_name: current}\n", "agents:\n  true: {role: dev, profile_name: missing}\n  \"true\": {role: dev, profile_name: current}\n", Buffer.from([0xff]), "x".repeat(4 * 1024 * 1024 + 1)]) {
      put(registry, invalid); assert.equal(report(2).ok, false);
    }
    rmSync(registry); assert.equal(report(2).ok, false);
    assert.equal(spawnSync("mkfifo", [registry]).status, 0); assert.equal(report(2).ok, false); rmSync(registry); save({ current: row });
  });
  check("audit role grammar follows the owning role contract", () => {
    rmSync(soul); put(soul, policy);
    save({ current: { ...row, role: "3d-artist" } });
    assert.equal(report(0).counts.pass, 1);
    for (const role of ["dev_", "dev--oops", "_dev", "dev-", "dev__ops"]) {
      save({ current: { ...row, role } });
      const result = report(1);
      assert.equal(result.counts.unproven, 1);
      assert.equal(result.counts.pass, 0);
    }
    save({ current: row });
  });
  check("missing, unreadable and malformed canonical policy cannot return a clean registry", () => {
    const source = join(work, "isolated-audit-source");
    try {
      mkdirSync(source);
      symlinkSync(join(root, "node_modules"), join(source, "node_modules"), "dir");
      for (const file of ["scripts/audit-scheduling-policy.mjs", "scripts/lib/scheduling-policy.mjs", "scripts/lib/bounded-policy.mjs", "scripts/lib/read-audit-text.mjs", "contracts/role.schema.json"]) {
        mkdirSync(dirname(join(source, file)), { recursive: true }); copyFileSync(join(root, file), join(source, file));
      }
      const script = join(source, "scripts/audit-scheduling-policy.mjs"), base = join(source, "roles/_base.md");
      assert.equal(report(2, script).ok, false);
      for (const invalid of ["", `${END}\n${START}`, `${START}\n${END}`, `${policy}\n${policy}`, Buffer.from([0xff])]) {
        put(base, invalid); assert.equal(report(2, script).ok, false);
      }
      put(base, policy); chmodSync(base, 0); assert.equal(report(2, script).ok, false); chmodSync(base, 0o600);
      put(base, policy); assert.equal(report(0, script).counts.pass, 1);
    } finally { rmSync(source, { recursive: true, force: true }); }
  });
  console.log(`scheduling-policy-audit: ${checks} check groups passed`);
} finally { rmSync(work, { recursive: true, force: true }); }
