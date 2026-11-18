// Test-only OS seam. NODE_OPTIONS propagates it to the real bounded probe;
// production has no fixture environment variable or alternative observation path.
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalWrite = fs.writeFileSync.bind(fs);
const fixture = process.env.FLUME_TEST_PROC_FIXTURE
  ? JSON.parse(fs.readFileSync(process.env.FLUME_TEST_PROC_FIXTURE, "utf8"))
  : {};
const events = [];
const handles = new Map();
let fd = -1000;
const original = Object.fromEntries(["readdirSync", "openSync", "readSync", "closeSync"].map(key => [key, fs[key].bind(fs)]));
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.readdirSync = (path, ...rest) => {
  if (path !== "/proc") return original.readdirSync(path, ...rest);
  if (fixture.$listError) throw Error("planted-secret list denied");
  if (fixture.$listDelay) wait(fixture.$listDelay);
  return Object.keys(fixture).filter(key => /^\d+$/.test(key));
};
fs.openSync = (path, ...rest) => {
  const match = /^\/proc\/(\d+)\/(comm|cmdline|environ)$/.exec(String(path));
  if (!match) return original.openSync(path, ...rest);
  const value = fixture[match[1]]?.[match[2]];
  if (value === null || value === undefined) throw Error("planted-secret metadata denied");
  const descriptor = fd--;
  handles.set(descriptor, { value: Buffer.from(typeof value === "object" ? value.value : value), delay: value.delay ?? 0 });
  return descriptor;
};
fs.readSync = (descriptor, buffer, offset, length, position) => {
  if (!handles.has(descriptor)) return original.readSync(descriptor, buffer, offset, length, position);
  const { value, delay } = handles.get(descriptor);
  if (delay) wait(delay);
  value.copy(buffer, offset, 0, length);
  return Math.min(value.length, length);
};
fs.closeSync = descriptor => handles.has(descriptor) ? handles.delete(descriptor) : original.closeSync(descriptor);

if (process.env.FLUME_TEST_PROC_GUARD) {
  const reject = name => { events.push(name); throw Error("forbidden side effect"); };
  for (const key of ["writeFileSync", "appendFileSync", "unlinkSync", "rmSync", "renameSync", "mkdirSync", "rmdirSync", "chmodSync", "chownSync", "truncateSync", "symlinkSync", "linkSync", "copyFileSync"]) fs[key] = () => reject(`fs.${key}`);
  const spawn = cp.spawn;
  const spawned = new Set();
  cp.spawn = (command, args, ...rest) => {
    if (command !== process.execPath || args[0] !== "--eval" || !args[1]?.includes("const scan =")) return reject("unapproved spawn");
    const child = spawn(command, args, ...rest);
    if (child.pid) spawned.add(child.pid);
    return child;
  };
  for (const key of ["spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[key] = () => reject(`child_process.${key}`);
  const kill = process.kill.bind(process);
  process.kill = (pid, ...rest) => spawned.has(Math.abs(pid)) ? kill(pid, ...rest) : reject("observed process signalled");
  const childKill = cp.ChildProcess.prototype.kill;
  cp.ChildProcess.prototype.kill = function (...args) { return spawned.has(this.pid) ? childKill.apply(this, args) : reject("observed child signalled"); };
  process.on("exit", () => originalWrite(`${process.env.FLUME_TEST_PROC_GUARD}.${process.pid}.json`, JSON.stringify(events)));
}
syncBuiltinESMExports();
