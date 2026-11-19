import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const revision = 'f85a126835ce3f4a4b5f30198b949d865a9b54b6';
await build({
  entryPoints: [`${root}/packages/flume-hr/src/index.ts`], bundle: true,
  packages: 'external', platform: 'node', format: 'esm',
  outfile: `${root}/packages/flume-hr/dist/flume80-baseline.js`,
  plugins: [{ name: 'baseline-provision', setup(builder) {
    builder.onLoad({ filter: /\/workforce\/provision\.ts$/ }, () => ({
      contents: execFileSync('git', ['show', `${revision}:packages/flume-hr/src/workforce/provision.ts`], { cwd: root, encoding: 'utf8' }) + '\n// Baseline compatibility shim: current lifecycle imports the FLUME-80 receipt reader.\nexport const pendingAccessIssuance = () => ({ token_ids: [], client_ids: {}, uncertain: false });\n',
      loader: 'ts', resolveDir: `${root}/packages/flume-hr/src/workforce`,
    }));
  } }],
});
console.log(`Built baseline provisioner from ${revision}; all other source is the current branch.`);
