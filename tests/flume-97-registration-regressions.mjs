import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'..');
const work=mkdtempSync(join(process.env.TMPDIR,'flume97-registration-'));
try {
  symlinkSync(join(root,'node_modules'),join(work,'node_modules'),'dir');
  const bundled=join(work,'register.mjs');
  await build({entryPoints:[join(root,'packages/flume-hr/src/hire/RunCopierTemplate.ts')],bundle:true,packages:'external',platform:'node',format:'esm',outfile:bundled});
  const {registerRenderedAgent}=await import(pathToFileURL(bundled).href);
  let count=0;
  for(const mode of [undefined,'shadow','managed']) {
    const dir=join(work,mode??'absent'),roleDir=join(dir,'agents/hermes/pm');mkdirSync(roleDir,{recursive:true});
    const manifest={project_id:'demo',repo_path:dir,notebook:{binding:{state:'planned'}},automation:{enabled:false},unrelated:{keep:['value']},
      ...(mode?{execution:{mode,operator:{keep:'configuration'}}}:{}),agents:{'existing-dev':{role:'dev',custom:{preserve:true}}}};
    const path=join(dir,'.project.json');writeFileSync(path,JSON.stringify(manifest,null,2)+'\n');
    const ctx={targetRepo:'demo',targetDir:dir,agentId:'demo-pm'};
    registerRenderedAgent(ctx,roleDir,'pm','demo-pm');
    const observed=JSON.parse(readFileSync(path,'utf8'));
    assert.deepEqual(observed,{...manifest,agents:{...manifest.agents,'demo-pm':{role:'pm',role_dir:'agents/hermes/pm',provisioning_state:'provisioned'}}});
    assert.equal('execution_mode' in observed.agents['demo-pm'],false);
    assert.equal('execution_readiness' in observed.agents['demo-pm'],false);
    const after=readFileSync(path,'utf8');registerRenderedAgent(ctx,roleDir,'pm','demo-pm');assert.equal(readFileSync(path,'utf8'),after);
    assert.throws(()=>registerRenderedAgent(ctx,roleDir,'pm','wrong-id'),/agent_id must match/);
    assert.equal(readFileSync(path,'utf8'),after);
    console.log(`PASS ${mode??'absent'} execution: project registration preserves unrelated fields and prior employee without engine metadata or pins`);count++;
  }
  const absent=join(work,'no-manifest');mkdirSync(absent);
  registerRenderedAgent({targetRepo:'demo',targetDir:absent,agentId:'demo-pm'},join(absent,'agents/hermes/pm'),'pm','demo-pm');
  assert.equal(existsSync(join(absent,'.project.json')),false);
  console.log('PASS no project manifest: registration remains no-op');count++;
  console.log(`${count} FLUME-97 registration groups passed`);
}finally{rmSync(work,{recursive:true,force:true});}
