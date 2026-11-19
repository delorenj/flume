import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const out = import.meta.dirname, root = resolve(out, '../../..');
const env = { ...process.env, FLUME_HOST_OVERLAY: 'none', HERMES_FLEET_ENV: join(out, 'no-fleet.env'), PYTHONDONTWRITEBYTECODE: '1' };
for (const key of Object.keys(env)) if (/^(PLANE_.*API_KEY|TRELLO_.*|TRELLO_KEY|TRELLO_TOKEN)$/u.test(key)) env[key] = '';
const preload = `--import=${join(out, 'scratch-temp.mjs')}`;
const baseline = join(root, 'packages/flume-hr/dist/flume80-baseline.js');
const cases = [
  ['typecheck', ['npm', 'run', 'typecheck']],
  ['build', ['npm', 'run', 'build']],
  ['baseline-build', ['node', join(out, 'build-baseline.mjs')]],
  ['baseline-reproduction', ['node', 'tests/identity-provision-regressions.mjs'], { FLUME_PROVISION_TEST_CLI: baseline, FLUME_PROVISION_EXPECT_OLD_FAILURE: '1' }],
  ['provision', ['node', 'tests/identity-provision-regressions.mjs']],
  ['direct-company-identity-lifecycle', ['node', 'tests/company-identity-lifecycle-regressions.mjs'], { FLUME_HOST_OVERLAY: process.env.FLUME_HOST_OVERLAY || '', HERMES_FLEET_ENV: process.env.HERMES_FLEET_ENV || '' }],
  ...['company-identity-lifecycle', 'employee-access-lifecycle', 'company-identity', 'registry-lifecycle-projection', 'company-identity-registry-plane', 'company-identity-plane'].map(name => [name, ['node', `tests/${name}-regressions.mjs`], { NODE_OPTIONS: preload }]),
  ...['company-identity-lifecycle', 'employee-access-lifecycle', 'company-identity'].map(name => [`baseline-${name}`, ['node', `tests/${name}-regressions.mjs`], { NODE_OPTIONS: preload, FLUME80_BASELINE_CLI: baseline }]),
  ['diff-check', ['git', 'diff', '--check']],
];
const results = [];
for (const [name, [command, ...args], extra = {}] of cases) {
  if (name.startsWith('baseline-') && name !== 'baseline-build' && results.find(r => r.name === 'baseline-build')?.exit !== 0) {
    results.push({ name, command: [command, ...args].join(' '), exit: null, skipped: 'baseline-build failed', log: null });
    continue;
  }
  const started = Date.now();
  const run = spawnSync(command, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const log = ((run.stdout || '') + (run.stderr || '') + (run.error ? `\n${run.error.message}\n` : '')).trimEnd();
  writeFileSync(join(out, `${name}.txt`), log ? log + '\n' : '');
  const result = { name, command: [command, ...args].join(' '), env: extra, exit: run.status, signal: run.signal, duration_ms: Date.now() - started, log: `${name}.txt` };
  results.push(result);
  console.log(`${name}: exit=${run.status} (${result.duration_ms}ms)`);
}
writeFileSync(join(out, 'source-hashes.json'), JSON.stringify(Object.fromEntries([
  'packages/flume-hr/src/workforce/access-issuance.ts', 'packages/flume-hr/src/workforce/company.ts',
  'packages/flume-hr/src/workforce/provision.ts', 'packages/flume-hr/src/workforce/lifecycle-adapters.ts',
  'tests/identity-provision-regressions.mjs', 'docs/identity-provisioning.md',
].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])), null, 2) + '\n');
writeFileSync(join(out, 'checks.json'), JSON.stringify({ at: new Date().toISOString(), base: 'f85a126835ce3f4a4b5f30198b949d865a9b54b6', evidence: 'isolated-fixture; no live provider/vault reads or mutations', results }, null, 2) + '\n');
process.exitCode = results.some(r => r.name === 'baseline-build' && r.exit !== 0 || !r.name.startsWith('baseline-') && r.exit !== 0) ? 1 : 0;
