// Hire snapshots the target repo before and after every ingredient. They must
// stay cheap on a huge tree (tolt: 49 GB) and still see every change a hire makes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'..');
const work=fs.mkdtempSync('/tmp/flume-tree-diff-');
const bundle=join(root,'tests',`.tree-diff-${process.pid}.mjs`);
let count=0;
const pass=label=>{count++;console.log(`PASS ${label}`);};
try {
  await build({entryPoints:[join(root,'packages/flume-hr/src/utils/tree-diff.ts')],outfile:bundle,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
  const {snapshotTree,changedTreePaths,CONTENT_HASH_MAX_BYTES}=await import(pathToFileURL(bundle).href);
  const repo=join(work,'repo');
  const at=(...p)=>join(repo,...p);
  const diff=(before,after)=>changedTreePaths(repo,before,after).map(p=>p.slice(repo.length+1));
  fs.mkdirSync(at('.git'),{recursive:true});
  fs.mkdirSync(at('agents','hermes','pm'),{recursive:true});
  fs.writeFileSync(at('agents','hermes','pm','role.yaml'),'role: pm\n');
  fs.writeFileSync(at('big.bin'),Buffer.alloc(CONTENT_HASH_MAX_BYTES+1,1));
  fs.mkdirSync(at('vendor','sub'),{recursive:true});
  fs.writeFileSync(at('vendor','sub','.git'),'gitdir: ../../.git/modules/sub\n');
  fs.writeFileSync(at('vendor','sub','inside.txt'),'a');

  const idle=snapshotTree(repo);
  assert.deepEqual(diff(idle,snapshotTree(repo)),[]);
  pass('idle snapshots agree');

  let before=snapshotTree(repo);
  fs.writeFileSync(at('agents','hermes','pm','role.yaml'),'role: pm\n');
  assert.deepEqual(diff(before,snapshotTree(repo)),[]);
  pass('identical rewrite of a small file is unchanged');

  before=snapshotTree(repo);
  fs.writeFileSync(at('agents','hermes','pm','role.yaml'),'role: qa\n');
  assert.deepEqual(diff(before,snapshotTree(repo)),['agents/hermes/pm/role.yaml']);
  pass('same-size small rewrite inside the racy window is caught');

  before=snapshotTree(repo);
  const big=Buffer.alloc(CONTENT_HASH_MAX_BYTES+1,1);big[0]=2;
  fs.writeFileSync(at('big.bin'),big);
  assert.deepEqual(diff(before,snapshotTree(repo)),['big.bin']);
  pass('large file rewrite is caught by metadata');

  before=snapshotTree(repo);
  fs.chmodSync(at('agents','hermes','pm','role.yaml'),0o600);
  assert.deepEqual(diff(before,snapshotTree(repo)),['agents/hermes/pm/role.yaml']);
  pass('mode change is caught');

  before=snapshotTree(repo);
  fs.symlinkSync('/nonexistent/flume-target',at('dangling'));
  assert.deepEqual(diff(before,snapshotTree(repo)),['dangling']);
  pass('dangling symlink is seen');

  before=snapshotTree(repo);
  fs.writeFileSync(at('vendor','sub','inside.txt'),'b');
  assert.deepEqual(diff(before,snapshotTree(repo)),[]);
  assert.equal(snapshotTree(repo).has('vendor/sub/inside.txt'),false);
  pass('nested repository worktree is not walked');

  const ancient=new Date(Date.now()-60_000);
  fs.utimesSync(at('agents','hermes','pm','role.yaml'),ancient,ancient);
  snapshotTree(repo);
  before=snapshotTree(repo);
  fs.writeFileSync(at('agents','hermes','pm','role.yaml'),'role: pa\n');
  fs.utimesSync(at('agents','hermes','pm','role.yaml'),ancient,ancient);
  assert.deepEqual(diff(before,snapshotTree(repo)),['agents/hermes/pm/role.yaml']);
  pass('cached hash is not reused after a rewrite that restores mtime');

  console.log(`\n${count} tree-diff regressions passed`);
} finally {
  fs.rmSync(bundle,{force:true});
  fs.rmSync(work,{recursive:true,force:true});
}
