import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {build} from '/home/delorenj/code/33GOD/flume/.worktrees/fix-FLUME-97-retire-managed-execution/node_modules/esbuild/lib/main.js';
const root='/home/delorenj/code/33GOD/flume/.worktrees/fix-FLUME-97-retire-managed-execution';
const out=fs.mkdtempSync(join(process.env.TMPDIR,'flume97-review-edges-'));
try {
  fs.symlinkSync(join(root,'node_modules'),join(out,'node_modules'),'dir');
  const input=join(root,'tests/flume-97-scaffold-regressions.mjs');
  const source=fs.readFileSync(input,'utf8').split('\ntry{\n  const f=fixture')[0]
    .replace("const root=resolve(import.meta.dirname,'..'),cli=join(root,'packages/flume-hr/dist/index.js');",`const root=${JSON.stringify(root)},cli=join(root,'packages/flume-hr/dist/index.js');`)
    .replace('return {repo,role,home,registry,run,remediate,audit};','return {repo,role,home,registry,env,run,remediate,audit};')
    +'\nexport {fixture,work,historical,snapshot};\n';
  const bundled=join(out,'fixture.mjs');
  await build({stdin:{contents:source,resolveDir:dirname(input),sourcefile:input,loader:'js'},bundle:true,packages:'external',format:'esm',platform:'node',outfile:bundled});
  const {fixture,work,historical,snapshot}=await import(pathToFileURL(bundled).href);
  try {
    for(const kind of ['in-repo-parent-link','role-ancestor-link','fifo','large','older-allowlist']) {
      const f=fixture(kind),target=join(f.role,'.scripts/managed-execution.py');
      if(kind==='in-repo-parent-link') {
        const other=join(f.repo,'other-scripts');fs.renameSync(join(f.role,'.scripts'),other);fs.symlinkSync(other,join(f.role,'.scripts'));
        const before=snapshot(other),r=f.remediate('--scripts-only');assert.equal(r.status,'partial');assert.deepEqual(snapshot(other),before);assert.equal(f.audit().status,'fail');
      } else if(kind==='role-ancestor-link') {
        const roles=join(f.repo,'agents/hermes'),other=join(work,'foreign-roles');fs.renameSync(roles,other);fs.symlinkSync(other,roles);
        const before=snapshot(other),r=f.remediate('--scripts-only');assert.equal(r.status,'partial');assert.deepEqual(snapshot(other),before);assert.equal(f.audit().status,'fail');
      } else if(kind==='fifo') {
        fs.unlinkSync(target);assert.equal(spawnSync('mkfifo',[target]).status,0);const r=f.remediate('--scripts-only');assert.equal(r.status,'partial');assert.equal(fs.lstatSync(target).isFIFO(),true);assert.equal(f.audit().status,'fail');
      } else if(kind==='large') {
        fs.writeFileSync(target,'x'.repeat(65537));const before=snapshot(target),r=f.remediate('--scripts-only');assert.equal(r.status,'partial');assert.deepEqual(snapshot(target),before);assert.equal(f.audit().status,'fail');
      } else {
        const r=spawnSync('git',['show','0aabe2c:template/.scripts/managed-execution.py'],{cwd:join(root,'templates/hermes-agent'),encoding:'utf8'});assert.equal(r.status,0,r.stderr);fs.writeFileSync(target,r.stdout);const done=f.remediate('--scripts-only');assert.equal(fs.existsSync(target),false);console.log('older allowlisted helper removal status',done.status);
      }
      console.log('PASS edge',kind);
    }
    const f=fixture('race'),target=join(f.role,'.scripts/managed-execution.py'),receipt=join(out,'race-receipt.json'),preload=join(out,'race.mjs');
    assert.equal(f.remediate().status,'applied');
    assert.equal(f.audit().status,'pass');
    fs.writeFileSync(target,historical('managed-execution.py'));
    fs.writeFileSync(preload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const target=process.env.RACE_TARGET,original=fs.readFileSync;let reads=0;
fs.readFileSync=function(path,...args){const bytes=original.call(this,path,...args);if(String(path)===target&&++reads===2){fs.renameSync(target,target+'.old');fs.writeFileSync(target,'# local replacement created during read\\nDO NOT DELETE\\n');fs.writeFileSync(process.env.RACE_RECEIPT,JSON.stringify({triggered:true,read:reads,localReplacementPresent:fs.existsSync(target)}));}return bytes;};syncBuiltinESMExports();`);
    // The audit reads the helper once; migration's ownership classifier reads it second.
    f.env.NODE_OPTIONS=`--import=${preload}`;f.env.RACE_TARGET=target;f.env.RACE_RECEIPT=receipt;
    const result=f.remediate('--scripts-only');
    assert.ok(fs.existsSync(receipt),'replacement injection reached real deletion classifier');
    console.log(JSON.stringify({probe:'replacement-between-read-and-unlink',status:result.status,race:JSON.parse(fs.readFileSync(receipt,'utf8')),replacementStillPresent:fs.existsSync(target),oldHelperPreserved:fs.existsSync(target+'.old'),details:result.details.filter(x=>x.includes('managed-execution'))}));
    assert.equal(fs.existsSync(target),false,'repro: replacement local content was deleted');
  } finally {fs.rmSync(work,{recursive:true,force:true});}
} finally {fs.rmSync(out,{recursive:true,force:true});}
