// Keep unchanged legacy suites' /tmp-prefixed fixtures in this session's scratch.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import cp from 'node:child_process';
const original = fs.mkdtempSync;
fs.mkdtempSync = (prefix, ...options) => original(typeof prefix === 'string' && prefix.startsWith('/tmp/') ? join(tmpdir(), basename(prefix)) : prefix, ...options);
const baseline = process.env.FLUME80_BASELINE_CLI;
if (baseline) {
  for (const method of ['spawn', 'spawnSync']) {
    const originalSpawn = cp[method];
    cp[method] = (command, args, ...rest) => originalSpawn(command, Array.isArray(args) ? args.map(a => typeof a === 'string' && a.endsWith('/packages/flume-hr/dist/index.js') ? baseline : a) : args, ...rest);
  }
}
syncBuiltinESMExports();
