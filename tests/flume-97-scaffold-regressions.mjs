import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';
import {canonicalPolicy,policySection} from '../scripts/lib/scheduling-policy.mjs';

const root=resolve(import.meta.dirname,'..'),cli=join(root,'packages/flume-hr/dist/index.js');
const template=join(root,'templates/hermes-agent'),work=fs.mkdtempSync(join(process.env.TMPDIR,'flume97-scaffold-'));
const old='c738f69db40a19b9f6c316b03b1c17edef9d0948^';
let checks=0;
const pass=name=>{checks++;console.log(`PASS ${name}`);};
const git=(cwd,...args)=>{
  const run=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);return run.stdout;
};
const historical=path=>git(template,'show',`${old}:template/.scripts/${path}`);
const put=(path,text)=>{fs.mkdirSync(dirname(path),{recursive:true});fs.writeFileSync(path,text);};
const snapshot=path=>{
  const stat=fs.lstatSync(path);
  if(stat.isSymbolicLink())return {link:fs.readlinkSync(path),mtime:stat.mtimeMs};
  if(stat.isDirectory())return Object.fromEntries(fs.readdirSync(path).sort().filter(p=>p!=='.git'&&p!=='.runtime-scaffold'&&!(fs.statSync(join(path,p)).isDirectory()&&fs.readdirSync(join(path,p)).length===0)).map(p=>[p,snapshot(join(path,p))]));
  return {bytes:fs.readFileSync(path).toString('base64'),mtime:stat.mtimeMs,mode:stat.mode};
};
function fixture(name,{authored=false,modified=false,retired=false}={}){
  const dir=join(work,name),repo=join(dir,'repo'),home=join(dir,'home'),role=join(repo,'agents/hermes/pm'),fleet=join(home,'.hermes');
  fs.mkdirSync(role,{recursive:true});fs.mkdirSync(fleet,{recursive:true});git(repo,'init','--quiet','--initial-branch=main','--template=');
  const registry=join(fleet,'agents-registry.yaml');
  const row={role:'pm',repo:'demo',project_path:repo,role_dir:role,profile_name:'demo-pm',display_name:'Demo',bloodbank:{enabled:!retired},...(retired?{telegram:{provisioning_status:'retired'}}:{})};
  put(registry,YAML.stringify({schema_version:1,agents:{'demo-pm':row}}));
  put(join(repo,'.project.json'),JSON.stringify({project_id:'demo',repo_path:repo,agents:{'demo-pm':{role:'pm',role_dir:'agents/hermes/pm',provisioning_state:'provisioned'}}}));
  put(join(role,'role.yaml'),YAML.stringify({repo:'demo',role:'pm',agent_id:'demo-pm',profile:'demo-pm',display_name:'Demo',purpose:'Preserve purpose',soul_tone:'direct',bloodbank:{enabled:!retired}}));
  const soul=authored?'# Operator persona\nDo not replace my voice.\n':'<!-- Composed by flume from roles/pm.md. -->\n## Identity\n## Tone\n## Role-specific behavior\nOld PM prose\n';
  put(join(role,'SOUL.md'),soul);put(join(role,'runtime/SOUL.md'),soul);
  for(const name of ['state.db','sessions/history.json','memories/MEMORY.md','local-notes.md'])put(join(role,'runtime',name),`runtime ${name}\n`);
  put(join(role,'runtime/profile.yaml'),'config:\n  inherit_from: default\n  save_mode: delta\noperator: preserve\n');
  put(join(role,'.scripts/lifecycle.sh'),historical('lifecycle.sh'));
  put(join(role,'.scripts/managed-execution.py'),historical('managed-execution.py')+(modified?'\n# Local operator change\n':''));
  put(join(role,'.scripts/heartbeat.sh'),historical('heartbeat.sh'));
  put(join(role,'.scripts/local-helper.sh'),'#!/bin/sh\nprintf local\n');
  put(join(role,'.gitignore'),'runtime/\n');
  git(repo,'add','--','.project.json','agents');git(repo,'commit','--quiet','-m','deployed scaffold');
  const env={...process.env,HOME:home,HERMES_FLEET_HOME:fleet,HERMES_AGENTS_REGISTRY:registry,HERMES_FLEET_REGISTRY_FILE:registry,
    HERMES_FLEET_ENV:join(dir,'no-env'),HERMES_TEMPLATE_CONFIG:join(dir,'no-config'),FLUME_HOST_OVERLAY:'none',
    PJ_PROJECT_REGISTRY:join(dir,'no-projects'),XDG_CACHE_HOME:join(home,'.cache'),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'};
  const run=(...args)=>{
    const r=spawnSync(process.execPath,[cli,...args,'--json'],{cwd:repo,env,encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024});
    assert.ok(r.stdout,r.stderr);return {exit:r.status,...JSON.parse(r.stdout)};
  };
  const remediate=(...extra)=>run('remediate','hermes.pm-scaffold',repo,...extra).results[0];
  const audit=()=>run('audit',repo,'--rules','hermes.pm-scaffold').rules[0];
  return {repo,role,home,registry,env,run,remediate,audit};
}
try{
  const f=fixture('canonical');
  const runtimeBefore=Object.fromEntries(['state.db','sessions/history.json','memories/MEMORY.md','local-notes.md','profile.yaml'].map(n=>[n,snapshot(join(f.role,'runtime',n))]));
  const registryBefore=snapshot(f.registry),localBefore=snapshot(join(f.role,'.scripts/local-helper.sh'));
  assert.match(f.audit().details.join('\n'),/obsolete template-owned helper/);
  const before={repo:snapshot(f.repo),registry:snapshot(f.registry)};
  const preview=f.remediate('--dry-run');
  assert.equal(preview.status,'applied');
  assert.deepEqual({repo:snapshot(f.repo),registry:snapshot(f.registry)},before);
  const preview2=f.remediate('--dry-run');assert.deepEqual(preview2.changedFiles,preview.changedFiles);
  const applied=f.remediate();assert.deepEqual(applied.changedFiles,preview.changedFiles);
  for(const name of ['managed-execution.py','lifecycle.sh'])assert.equal(fs.existsSync(join(f.role,'.scripts',name)),false);
  assert.equal(fs.readFileSync(join(f.role,'.scripts/heartbeat.sh'),'utf8'),fs.readFileSync(join(template,'template/.scripts/heartbeat.sh'),'utf8'));
  assert.doesNotMatch(fs.readFileSync(join(f.role,'.scripts/heartbeat.sh'),'utf8'),/managed-execution|lifecycle\.sh/);
  const soul=fs.readFileSync(join(f.role,'SOUL.md'),'utf8');
  for(const hold of ['lifecycle:needs-input','lifecycle:blocked','lifecycle:human','agent:failed'])assert.ok(soul.includes(hold),hold);
  assert.equal(policySection(soul),canonicalPolicy(root));assert.match(soul,/Preserve purpose/);
  assert.equal(fs.readFileSync(join(f.role,'runtime/SOUL.md'),'utf8'),soul);
  assert.deepEqual(Object.fromEntries(Object.keys(runtimeBefore).map(n=>[n,snapshot(join(f.role,'runtime',n))])),runtimeBefore);
  assert.deepEqual(snapshot(f.registry),registryBefore);assert.deepEqual(snapshot(join(f.role,'.scripts/local-helper.sh')),localBefore);
  assert.equal(f.audit().status,'pass');
  const after=snapshot(f.repo);assert.equal(f.remediate().status,'noop');assert.deepEqual(f.remediate('--dry-run').changedFiles,[]);assert.deepEqual(snapshot(f.repo),after);
  pass('canonical preview/apply removes only shipped obsolete helpers, updates heartbeat and composes four holds; runtime/local state survives and repeats converge');

  const m=fixture('modified',{authored:true,modified:true,retired:true});
  const mSoul=snapshot(join(m.role,'SOUL.md')),mRuntime=snapshot(join(m.role,'runtime/SOUL.md')),mRegistry=snapshot(m.registry),mHelper=snapshot(join(m.role,'.scripts/managed-execution.py'));
  const partial=m.remediate();assert.equal(partial.status,'partial');
  assert.match(partial.details.join('\n'),/preserved .scripts\/managed-execution.py \(locally-modified/);
  assert.deepEqual(snapshot(join(m.role,'SOUL.md')),mSoul);assert.deepEqual(snapshot(join(m.role,'runtime/SOUL.md')),mRuntime);
  assert.deepEqual(snapshot(m.registry),mRegistry);assert.deepEqual(snapshot(join(m.role,'.scripts/managed-execution.py')),mHelper);
  assert.equal(m.audit().status,'fail');assert.match(m.audit().details.join('\n'),/locally-modified content/);
  pass('modified obsolete helper and authored persona remain visible failures, and a retired registry row stays disabled');

  for(const kind of ['symlink','directory','parent-link']){
    const s=fixture(kind),path=join(s.role,'.scripts/managed-execution.py'),outside=join(work,`${kind}-outside`);
    if(kind==='parent-link'){
      fs.renameSync(join(s.role,'.scripts'),outside);fs.symlinkSync(outside,join(s.role,'.scripts'));
    }else{
      fs.unlinkSync(path);
      if(kind==='symlink'){put(outside,historical('managed-execution.py'));fs.symlinkSync(outside,path);}
      else fs.mkdirSync(path);
    }
    const unchanged=kind==='parent-link'?snapshot(outside):snapshot(path);
    const result=s.remediate('--scripts-only');assert.equal(result.status,'partial');
    assert.deepEqual(kind==='parent-link'?snapshot(outside):snapshot(path),unchanged);
    assert.equal(s.audit().status,'fail');
  }
  pass('symlink, directory and linked scripts parent refuse destructive removal and retain audit failures');

  const s=fixture('scripts-only'),protectedBefore={soul:snapshot(join(s.role,'SOUL.md')),runtime:snapshot(join(s.role,'runtime')),registry:snapshot(s.registry)};
  const planned=s.remediate('--scripts-only','--dry-run'),done=s.remediate('--scripts-only');assert.deepEqual(done.changedFiles,planned.changedFiles);
  assert.ok(done.changedFiles.every(p=>p.startsWith(join(s.role,'.scripts')+'/')));
  assert.deepEqual({soul:snapshot(join(s.role,'SOUL.md')),runtime:snapshot(join(s.role,'runtime')),registry:snapshot(s.registry)},protectedBefore);
  assert.equal(s.remediate('--scripts-only').changedFiles.length,0);
  pass('supported scripts-only refresh removes obsolete helpers without touching SOUL/runtime/registry');

  const raced=fixture('replacement-race'),target=join(raced.role,'.scripts/managed-execution.py'),preload=join(work,'replace-after-classify.cjs'),receipt=join(work,'replace-receipt.json');
  assert.equal(raced.remediate().status,'applied');
  put(target,historical('managed-execution.py'));
  put(preload,`const fs=require('node:fs');const original=fs.readFileSync;let reads=0;
fs.readFileSync=function(path,...args){const bytes=original.call(this,path,...args);
if(String(path)===process.env.RACE_TARGET&&++reads===2){fs.renameSync(path,path+'.old');fs.writeFileSync(path,'# local replacement\\nDO NOT DELETE\\n');fs.writeFileSync(process.env.RACE_RECEIPT,String(reads));}
return bytes;};`);
  raced.env.NODE_OPTIONS=`--require=${preload}`;
  raced.env.RACE_TARGET=target;raced.env.RACE_RECEIPT=receipt;
  const race=raced.remediate('--scripts-only');
  assert.equal(fs.readFileSync(receipt,'utf8'),'2','the actual CLI classified the stale historical bytes');
  assert.equal(race.status,'partial');
  assert.equal(fs.readFileSync(target,'utf8'),'# local replacement\nDO NOT DELETE\n');
  assert.equal(fs.readFileSync(target+'.old','utf8'),historical('managed-execution.py'));
  assert.match(race.details.join('\n'),/preserved .scripts\/managed-execution.py \(helper changed since classification\)/);
  assert.ok(!race.changedFiles.includes(target));
  pass('actual CLI preserves and reports a child-local replacement after classification');

  const held=fixture('quarantine-race'),heldTarget=join(held.role,'.scripts/managed-execution.py'),heldPreload=join(work,'replace-after-quarantine.cjs'),heldReceipt=join(work,'held-receipt.json');
  assert.equal(held.remediate().status,'applied');
  put(heldTarget,historical('managed-execution.py'));
  put(heldPreload,`const fs=require('node:fs');const original=fs.renameSync;
fs.renameSync=function(src,dest){const value=original.call(this,src,dest);
if(String(src)===process.env.RACE_TARGET&&String(dest).includes('.flume-obsolete-')){
fs.writeFileSync(src,'# replacement after quarantine\\nDO NOT DELETE\\n');fs.writeFileSync(process.env.RACE_RECEIPT,String(dest));}
return value;};`);
  held.env.NODE_OPTIONS=`--require=${heldPreload}`;held.env.RACE_TARGET=heldTarget;held.env.RACE_RECEIPT=heldReceipt;
  const afterMove=held.remediate('--scripts-only');
  const heldPath=fs.readFileSync(heldReceipt,'utf8');
  assert.equal(afterMove.status,'partial');
  assert.equal(fs.readFileSync(heldTarget,'utf8'),'# replacement after quarantine\nDO NOT DELETE\n');
  assert.equal(fs.readFileSync(heldPath,'utf8'),historical('managed-execution.py'));
  assert.match(afterMove.details.join('\n'),/recover held file at/);
  assert.ok(!afterMove.changedFiles.includes(heldTarget));
  pass('quarantined old bytes remain recoverable when a public replacement arrives during removal');
}finally{fs.rmSync(work,{recursive:true,force:true});}
console.log(`${checks} FLUME-97 scaffold groups passed`);
