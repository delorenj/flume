// Force filesystem scheduling windows while leaving every stat/open/read and
// the observer's socket exchange real. Loaded only by private CLI fixtures.
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const pointer = process.env.F14_POINTER;
const mode = process.env.F14_POINTER_MODE;
const pending = process.env.F14_PENDING;
const events = process.env.F14_POINTER_EVENTS;
const original = Object.fromEntries(["lstatSync", "openSync", "fstatSync", "readSync", "closeSync"].map((name) => [name, fs[name]]));
const descriptors = new Set();
let changed = false;
let mutating = false;
function log(event) { fs.appendFileSync(events, JSON.stringify(event) + "\n"); }
function mutate(phase, stat) {
  if (changed || mode === "control" || mode === "short-reads") return;
  changed = true;
  mutating = true;
  try {
    if (mode === "grow-after-stat") fs.appendFileSync(pointer, Buffer.alloc(1024 * 1024, 0x20));
    else fs.renameSync(pending, pointer);
  } finally { mutating = false; }
  const after = original.lstatSync(pointer);
  log({ kind: "mutation", phase, regularBefore: stat?.isFile(), sizeBefore: stat?.size,
    fifoAfter: after.isFIFO(), symlinkAfter: after.isSymbolicLink(), sizeAfter: after.size, modeAfter: after.mode & 0o777 });
}
// The prior implementation checked the pathname; the repaired reader checks
// its descriptor. Support both so the regression demonstrably fails before repair.
fs.lstatSync = function(path, ...args) {
  const actual = original.lstatSync(path, ...args);
  if (path === pointer) mutate("after-path-stat", actual);
  return actual;
};
fs.openSync = function(path, flags, ...args) {
  if (mutating) return original.openSync(path, flags, ...args);
  if (path === pointer) {
    log({ kind: "open-attempt", flags });
    if (mode.endsWith("before-open")) mutate("before-open", original.lstatSync(pointer));
  }
  const fd = original.openSync(path, flags, ...args);
  if (path === pointer) { descriptors.add(fd); log({ kind: "opened", fd }); }
  return fd;
};
fs.fstatSync = function(fd, ...args) {
  const actual = original.fstatSync(fd, ...args);
  if (descriptors.has(fd)) {
    log({ kind: "descriptor-stat", regular: actual.isFile(), fifo: actual.isFIFO(), uid: actual.uid,
      mode: actual.mode & 0o777, size: actual.size });
    if (mode.endsWith("after-stat")) mutate("after-descriptor-stat", actual);
  }
  return actual;
};
fs.readSync = function(fd, buffer, offset, length, position) {
  if (!descriptors.has(fd)) return original.readSync(...arguments);
  const count = original.readSync(fd, buffer, offset, mode === "short-reads" ? Math.min(length, 7) : length, position);
  log({ kind: "read", requested: length, count });
  return count;
};
fs.closeSync = function(fd) {
  const tracked = descriptors.has(fd);
  const result = original.closeSync(...arguments);
  if (tracked) { descriptors.delete(fd); log({ kind: "closed", fd }); }
  return result;
};
syncBuiltinESMExports();
