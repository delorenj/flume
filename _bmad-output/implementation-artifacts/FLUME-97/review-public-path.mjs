import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from '/home/delorenj/code/33GOD/flume/.worktrees/fix-FLUME-97-retire-managed-execution/node_modules/esbuild/lib/main.js';
const root='/home/delorenj/code/33GOD/flume/.worktrees/fix-FLUME-97-retire-managed-execution';
const out=fs.mkdtempSync(join(process.env.TMPDIR,'flume97-review-public-'));
try {
  fs.symlinkSync(join(root,'node_modules'),join(out,'node_modules'),'dir');
  const input=join(root,'tests/flume-45-hire-manifest.mjs');
  const src=fs.readFileSync(input,'utf8').split('\ntry {\n  for(const shape')[0]
    .replace("const root=resolve(import.meta.dirname,'..');",`const root=${JSON.stringify(root)};`)
    +'\nexport {fixture,work};\n';
  const bundled=join(out,'fixture.mjs');
  await build({stdin:{contents:src,resolveDir:root,sourcefile:input,loader:'js'},bundle:true,packages:'external',format:'esm',platform:'node',outfile:bundled});
  const {fixture,work}=await import(pathToFileURL(bundled).href);
  try {
    for(const mode of [undefined,'shadow','managed']) {
      const f=await fixture(`review-${mode??'absent'}`,'absent',mode?{execution:{mode,keep:'operator-config'}}:{});
      const path=join(f.repo,'.project.json'),before=fs.readFileSync(path,'utf8');
      const preview=f.run('--dry-run');
      assert.equal(preview.status,0,preview.stdout+preview.stderr);
      assert.equal(fs.readFileSync(path,'utf8'),before);
      assert.equal(fs.existsSync(join(f.repo,'agents/hermes/pm/role.yaml')),false);
      assert.equal(fs.existsSync(f.blockedLog),false);
      console.log(`PASS public CLI dry-run ${mode??'absent'}: exit 0, manifest bytes unchanged, no role written, no blocked service calls`);
      const result=f.run();
      const registered=JSON.parse(fs.readFileSync(path,'utf8'));
      assert.deepEqual(registered.agents,{'demo-pm':{role:'pm',role_dir:'agents/hermes/pm',provisioning_state:'provisioned'}});
      assert.deepEqual(Object.fromEntries(Object.entries(registered).filter(([k])=>k!=='agents')),f.manifest);
      assert.equal(fs.existsSync(f.blockedLog),false);
      const output=result.stdout+'\n'+result.stderr;
      const lastError=output.split('\n').find(x=>/Member gateway credential not verified/.test(x));
      console.log(JSON.stringify({mode:mode??'absent',publicHireExit:result.status,registrationVerified:true,rendered:output.includes('Rendered Hermes role at'),lastError:lastError??'see full receipt'}));
      fs.writeFileSync(join(process.env.TMPDIR,`flume97-review-public-${mode??'absent'}.log`),output);
    }
    const prior={'existing-dev':{role:'dev',role_dir:'agents/hermes/dev',provisioning_state:'provisioned',custom:{keep:true}}};
    const f=await fixture('review-prior','absent',{agents:prior});
    const result=f.run();
    const path=join(f.repo,'.project.json');
    const observed=JSON.parse(fs.readFileSync(path,'utf8'));
    assert.deepEqual(observed.agents, {...prior,'demo-pm':{role:'pm',role_dir:'agents/hermes/pm',provisioning_state:'provisioned'}});
    const registered=fs.readFileSync(path,'utf8');
    const repeat=f.run();
    assert.notEqual(repeat.status,0);
    assert.equal(fs.readFileSync(path,'utf8'),registered);
    assert.equal(fs.existsSync(f.blockedLog),false);
    console.log(JSON.stringify({publicPriorEmployeePreserved:true,initialExit:result.status,occupiedHireRepeatExit:repeat.status,manifestBytesPreservedOnRepeat:true}));
    const denied=await fixture('review-denied','empty');
    const manifestPath=join(denied.repo,'.project.json'),original=fs.readFileSync(manifestPath,'utf8');
    const preload=join(out,'deny.cjs');
    fs.writeFileSync(preload,`const fs=require('node:fs');const old=fs.writeFileSync;fs.writeFileSync=function(path,...args){if(String(path)===${JSON.stringify(manifestPath)})throw new Error('review manifest write denied');return old.call(this,path,...args)};`);
    const {spawnSync}=await import('node:child_process');
    const r=spawnSync(process.execPath,['--require',preload,join(root,'packages/flume-hr/dist/index.js'),'hire','pm','--yes','--skip-telegram','--skip-plane','--local'],{cwd:denied.repo,env:denied.env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
    assert.notEqual(r.status,0);
    assert.match(r.stdout+r.stderr,/review manifest write denied/);
    assert.doesNotMatch(r.stdout,/Hermes lifecycle audit passed/);
    assert.equal(fs.readFileSync(manifestPath,'utf8'),original);
    assert.equal(fs.existsSync(join(denied.repo,'agents/hermes/pm/role.yaml')),true);
    assert.equal(fs.existsSync(denied.blockedLog),false);
    console.log(JSON.stringify({publicWriteFailureExit:r.status,writeFailureNamed:true,manifestBytesPreserved:true,noFalseCompletion:true}));
  } finally {fs.rmSync(work,{recursive:true,force:true});}
} finally {fs.rmSync(out,{recursive:true,force:true});}
