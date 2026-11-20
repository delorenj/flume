import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const root = new URL('../packages/flume-hr/dist/index.js', import.meta.url).pathname;
const usage = process.env.USAGE_BIN || 'usage';
test('flume emits real-parser-compatible usage KDL from its Commander tree', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'flume-usage-'));
  try {
    const spec = execFileSync(process.execPath, [root, '--usage-spec'], { encoding: 'utf8' });
    const path = join(dir, 'flume.usage.kdl');
    writeFileSync(path, spec);
    execFileSync(usage, ['lint', '-q', path]);
    const json = JSON.parse(execFileSync(usage, ['generate', 'json', '-f', path], { encoding: 'utf8' }));
    assert.match(spec, /^name flume$/m);
    assert.match(spec, /^cmd hire /m);
    assert.match(spec, /^cmd roster /m);
    assert.ok(json);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
