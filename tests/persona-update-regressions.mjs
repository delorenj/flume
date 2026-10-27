// FLUME-69: continuity-safe persona update through the real CLI.
//
// Built CLI + canonical renderer + real Skillex fixture, modeled on
// specialist-hire-regressions.mjs. Every case runs `flume identity update`
// against a hired + ENROLLED portable specialist and asserts real state.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,lstatSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import YAML from 'yaml';
import {createSet,addSetSkills} from '@delorenj/skillex';

const root=resolve(import.meta.dirname,'..'),cli=join(root,'packages/flume-hr/dist/index.js');
const work=mkdtempSync(join(process.env.TMPDIR,'flume69-'));
let count=0;const pass=name=>{count++;console.log(`PASS ${name}`);};

/** Recursive tree snapshot (bytes + mtimes); volatile lock/marker files excluded. */
function snap(path){
  let s;try{s=lstatSync(path);}catch{return null;}
  if(s.isSymbolicLink())return {kind:'link',mtime:s.mtimeMs};
  if(s.isDirectory())return {kind:'dir',mtime:s.mtimeMs,kids:Object.fromEntries(readdirSync(path).sort().filter(n=>!n.startsWith('.flume-')&&!n.endsWith('.lock')).map(n=>[n,snap(join(path,n))]))};
  return {kind:'file',bytes:readFileSync(path).toString('base64'),mtime:s.mtimeMs};
}

/** A hired, enrolled portable specialist named bennett (display_name Arnie). */
async function fixture(label){
  const dir=join(work,label),home=join(dir,'home'),fleet=join(home,'.hermes'),catalog=join(dir,'skillex');
  for(const p of [home,fleet,join(home,'.agents'),join(dir,'unrelated')])mkdirSync(p,{recursive:true});
  for(const name of ['alpha','global']){
    mkdirSync(join(catalog,'all-skills',name),{recursive:true});
    writeFileSync(join(catalog,'all-skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: fixture ${name}\n---\n`);
  }
  const options={registryRoot:catalog,home,stateHome:join(home,'.local/state')};
  assert.ok((await createSet('first',options)).ok);assert.ok((await addSetSkills('first',['alpha'],options)).ok);
  assert.ok((await createSet('global',options)).ok);assert.ok((await addSetSkills('global',['global'],options)).ok);
  writeFileSync(join(home,'.agents/skills.json'),JSON.stringify({sets:['global']}));
  writeFileSync(join(fleet,'config.yaml'),YAML.stringify({model:{provider:'automaticai',default:'automaticai/personal/sol'},skills:{external_dirs:['/foreign']},memory:{provider:'hindsight'},operator:{base:'preserve'}}));
  const registry=join(fleet,'agents-registry.yaml');
  writeFileSync(registry,'# org comment\nschema_version: 1\nagents: {}\n');
  const definition=join(dir,'agent.yaml'),desk=join(home,'.agents/workforce/bennett'),profile=join(fleet,'profiles/bennett');
  const contract={schema_version:1,id:'bennett',display_name:'Arnie',role:'brennan-portfolio-director',
    charter:{purpose:'Coordinate the portfolio.',tone:'Clear, practical and accountable.',directives:['Keep conventions','Escalate scope changes to Jarad']},
    skills:{set:'first'},memory:{write_bank:'agent-bennett',recall_banks:['james-brennan']}};
  writeFileSync(definition,YAML.stringify(contract));
  const env={...process.env,HOME:home,HERMES_FLEET_HOME:fleet,HERMES_AGENTS_REGISTRY:registry,HERMES_FLEET_REGISTRY_FILE:registry,
    HERMES_TEMPLATE_CONFIG:join(dir,'no-config'),HERMES_FLEET_ENV:join(dir,'no-env'),PJ_SKILLS_REGISTRY_ROOT:catalog,
    XDG_STATE_HOME:join(home,'.local/state'),PYTHONDONTWRITEBYTECODE:'1',TMPDIR:work};
  const run=(args,extra={},cwd=join(dir,'unrelated'))=>spawnSync(process.execPath,[cli,...args],{env:{...env,...extra},cwd,encoding:'utf8',timeout:60000});
  const json=r=>{assert.equal(r.status,0,r.stdout+r.stderr);return JSON.parse(r.stdout);};
  json(run(['hire','--definition',definition,'--json']));
  const enrolled=json(run(['identity','enroll','bennett','--apply','--json']));
  assert.equal(enrolled.ok,true);
  return {dir,home,fleet,catalog,registry,definition,desk,profile,contract,env,subject:enrolled.identity.subject,
    deskAgent:()=>join(desk,'agent.yaml'),run,json};
}

const e2e=await fixture('e2e');

// ---------------------------------------------------------------------------
// 1. PREVIEW writes nothing: whole-home tree identical, desk still says Arnie.
// ---------------------------------------------------------------------------
{
  const before={home:snap(e2e.home),catalog:snap(e2e.catalog)};
  const result=e2e.json(e2e.run(['identity','update','bennett','--name','Christopher','--json']));
  assert.equal(result.ok,true);
  assert.equal(result.changed,true);
  assert.equal(result.apply,false);
  assert.deepEqual(result.from,{display_name:'Arnie',tone:'Clear, practical and accountable.',directives:['Keep conventions','Escalate scope changes to Jarad']});
  assert.equal(result.to.display_name,'Christopher');
  assert.equal(result.to.tone,'Clear, practical and accountable.','name alone never invents personality');
  assert.deepEqual(result.to.directives,result.from.directives);
  assert.equal(result.immutable.id,'bennett');
  assert.equal(result.immutable.memory.write_bank,'agent-bennett');
  assert.equal(result.immutable.company_identity.subject,e2e.subject);
  assert.ok(result.unmanaged.some(s=>s.surface==='provider_display_names'));
  assert.ok(result.unmanaged.some(s=>s.surface==='vault_item_label'));
  assert.ok(result.unmanaged.some(s=>s.surface==='mailbox'));
  assert.deepEqual(result.writes,[]);
  assert.deepEqual({home:snap(e2e.home),catalog:snap(e2e.catalog)},before,'preview must write nothing');
  assert.equal(YAML.parse(readFileSync(e2e.deskAgent(),'utf8')).display_name,'Arnie');
  pass('preview reports the change and writes nothing (whole-home snapshot identical)');
}

// ---------------------------------------------------------------------------
// 2. APPLY name only: personality untouched, identity preserved, projection
//    converges, registry row follows, idempotent.
// ---------------------------------------------------------------------------
{
  const result=e2e.json(e2e.run(['identity','update','bennett','--name','Christopher','--apply','--json']));
  assert.equal(result.ok,true);assert.equal(result.changed,true);
  assert.deepEqual(result.writes,[e2e.deskAgent()]);
  const agent=YAML.parse(readFileSync(e2e.deskAgent(),'utf8'));
  assert.equal(agent.display_name,'Christopher');
  assert.equal(agent.charter.tone,'Clear, practical and accountable.');
  assert.deepEqual(agent.charter.directives,['Keep conventions','Escalate scope changes to Jarad']);
  assert.equal(agent.id,'bennett');
  assert.equal(agent.role,'brennan-portfolio-director');
  assert.equal(agent.memory.write_bank,'agent-bennett');
  assert.deepEqual(agent.memory.recall_banks,['james-brennan']);
  assert.equal(agent.company_identity.subject,e2e.subject);
  assert.equal(agent.company_identity.handle,'bennett');
  assert.equal(agent.company_identity.email,'bennett@agents.delo.sh');
  assert.equal(agent.company_identity.status,'active');
  // Projection converged: SOUL addressed to the new name, old name gone.
  const soul=readFileSync(join(e2e.profile,'SOUL.md'),'utf8');
  assert.match(soul,/^# Christopher/u);
  assert.doesNotMatch(soul,/Arnie/u);
  assert.equal(YAML.parse(readFileSync(join(e2e.profile,'profile.yaml'),'utf8')).display_name,'Christopher');
  // Registry row follows; employee id, bank and employment never move.
  const row=YAML.parse(readFileSync(e2e.registry,'utf8')).agents.bennett;
  assert.equal(row.display_name,'Christopher');
  assert.equal(row.identity,'bennett');
  assert.equal(row.hindsight.write_bank,'agent-bennett');
  assert.equal(row.employment,'portable-specialist');
  assert.ok(e2e.json(e2e.run(['audit','--employee','bennett','--json'])).ok);
  const again=e2e.json(e2e.run(['identity','update','bennett','--name','Christopher','--apply','--json']));
  assert.equal(again.changed,false);
  assert.match(again.note,/already carries this persona/u);
  pass('apply name-only updates agent.yaml, SOUL, profile metadata and registry row; immutable identity preserved; idempotent');
}

// ---------------------------------------------------------------------------
// 3. Tone + directives together, schema-compatible output, name preserved.
// ---------------------------------------------------------------------------
{
  const directives=join(e2e.dir,'directives.yaml');
  writeFileSync(directives,YAML.stringify(['Lead the portfolio with evidence.','Keep each board authoritative.']));
  const result=e2e.json(e2e.run(['identity','update','bennett','--tone','Warm, direct and precise.','--directives-file',directives,'--apply','--json']));
  assert.equal(result.ok,true);assert.equal(result.changed,true);
  const agent=YAML.parse(readFileSync(e2e.deskAgent(),'utf8'));
  assert.equal(agent.display_name,'Christopher','name preserved when not passed');
  assert.equal(agent.charter.tone,'Warm, direct and precise.');
  assert.deepEqual(agent.charter.directives,['Lead the portfolio with evidence.','Keep each board authoritative.']);
  assert.equal(agent.charter.purpose,'Coordinate the portfolio.','purpose is immutable');
  assert.ok(e2e.json(e2e.run(['audit','--employee','bennett','--json'])).ok);
  assert.match(readFileSync(join(e2e.profile,'SOUL.md'),'utf8'),/Warm, direct and precise\./u);
  // One-per-line form parses too.
  const lines=join(e2e.dir,'lines.txt');writeFileSync(lines,'One per line.\nTwo per line.\n');
  const lined=e2e.json(e2e.run(['identity','update','bennett','--directives-file',lines,'--json']));
  assert.equal(lined.to.directives.length,2);
  pass('apply tone+directives lands schema-compatible charter fields and keeps the name');
}

// ---------------------------------------------------------------------------
// 4. Invalid inputs refuse before any write.
// ---------------------------------------------------------------------------
{
  const cases=[
    [['identity','update','bennett','--name','','--json'],/invalid-name/u],
    [['identity','update','bennett','--name','x'.repeat(81),'--json'],/invalid-name/u],
    [['identity','update','bennett','--name','Bad\nName','--json'],/invalid-name/u],
    [['identity','update','bennett','--tone','','--json'],/invalid-tone/u],
    [['identity','update','bennett','--json'],/name a change/u],
    [['identity','update','bennett','--apply','--json'],/name a change/u],
    [['identity','update','bennett','--directives-file',join(e2e.dir,'nope.yaml'),'--json'],/directives file not found/u],
  ];
  const before=snap(e2e.desk);
  for(const [args,needle] of cases){
    const refused=e2e.run(args);
    assert.notEqual(refused.status,0,`must refuse: ${args.join(' ')}`);
    assert.match(refused.stdout+refused.stderr,needle,`message for: ${args.join(' ')}`);
  }
  const badDirectives=join(e2e.dir,'bad.yaml');
  writeFileSync(badDirectives,YAML.stringify({not:'a list'}));
  const refused=e2e.run(['identity','update','bennett','--directives-file',badDirectives,'--json']);
  assert.notEqual(refused.status,0);assert.match(refused.stdout,/must be a YAML list of strings/u);
  const emptyDirectives=join(e2e.dir,'empty.yaml');writeFileSync(emptyDirectives,'\n\n');
  const refusedEmpty=e2e.run(['identity','update','bennett','--directives-file',emptyDirectives,'--json']);
  assert.notEqual(refusedEmpty.status,0);assert.match(refusedEmpty.stdout,/holds no directives/u);
  assert.deepEqual(snap(e2e.desk),before);
  pass('invalid name/tone/directives/missing-change inputs refuse with zero writes');
}

// ---------------------------------------------------------------------------
// 5. Repo employees (post role.yaml) refuse clearly until supported.
// ---------------------------------------------------------------------------
{
  const f=await fixture('post-employee');
  const postDir=join(f.dir,'postrole');mkdirSync(postDir,{recursive:true});
  writeFileSync(join(postDir,'role.yaml'),'agent_id: some-pm\n');
  const doc=YAML.parseDocument(readFileSync(f.registry,'utf8'));
  doc.setIn(['agents','some-pm'],{role_dir:postDir,profile_name:'some-pm'});
  writeFileSync(f.registry,String(doc));
  const refused=f.run(['identity','update','some-pm','--name','Christopher','--json']);
  assert.notEqual(refused.status,0);
  assert.match(refused.stdout,/unsupported-post-definition/u);
  pass('repo (post) employees refuse with unsupported-post-definition');
}

// ---------------------------------------------------------------------------
// 6. Unknown and unsafe employee ids refuse.
// ---------------------------------------------------------------------------
{
  const refused=e2e.run(['identity','update','nobody-here','--name','X','--json']);
  assert.notEqual(refused.status,0);
  assert.match(refused.stdout,/Employee not found/u);
  const unsafe=e2e.run(['identity','update','../escape','--name','X','--json']);
  assert.notEqual(unsafe.status,0);
  assert.match(unsafe.stdout,/Unsafe employee identity/u);
  pass('unknown and unsafe employee ids refuse');
}

// Projection ownership conflicts refuse before publishing a new definition.
{
  const f=await fixture('preflight');
  const original=readFileSync(f.deskAgent(),'utf8');
  const originalStat=lstatSync(f.deskAgent());
  writeFileSync(join(f.profile,'SOUL.md'),'handwritten soul\n');
  const result=f.run(['identity','update','bennett','--name','Christopher','--apply','--json']);
  assert.notEqual(result.status,0);
  const parsed=JSON.parse(result.stdout);
  assert.ok(parsed.blockers.some(b=>b.code==='preview-failed'));
  assert.deepEqual(parsed.writes,[]);
  assert.equal(readFileSync(f.deskAgent(),'utf8'),original);
  assert.equal(lstatSync(f.deskAgent()).ino,originalStat.ino);
  assert.equal(lstatSync(f.deskAgent()).mtimeMs,originalStat.mtimeMs);
  pass('preflight refuses handwriting before changing the definition inode or bytes');
}

// Mid-publication failures retain the candidate for the existing forward journal.
{
  const f=await fixture('forward-recovery');
  const result=f.run(['identity','update','bennett','--name','Christopher','--apply','--json'],{FLUME_TEST_SPECIALIST_INTERRUPT_AFTER:'SOUL.md'});
  assert.notEqual(result.status,0);
  const parsed=JSON.parse(result.stdout);
  assert.equal(parsed.recovery.definition_retained,true);
  assert.equal(YAML.parse(readFileSync(f.deskAgent(),'utf8')).display_name,'Christopher');
  const recovered=f.json(f.run(['identity','update','bennett','--name','Christopher','--apply','--json']));
  assert.ok(recovered.ok);
  assert.ok(f.json(f.run(['audit','--employee','bennett','--json'])).ok);
  pass('interrupted projection recovers forwards on same-name apply, without stale rollback');
}

// ---------------------------------------------------------------------------
// 8. Symlink safety: a symlinked desk agent.yaml refuses before any write.
// ---------------------------------------------------------------------------
{
  const f=await fixture('symlinked');
  const real=join(f.dir,'real-agent.yaml');
  writeFileSync(real,readFileSync(f.deskAgent(),'utf8'));
  rmSync(f.deskAgent());
  symlinkSync(real,f.deskAgent());
  const refused=f.run(['identity','update','bennett','--name','Christopher','--json']);
  assert.notEqual(refused.status,0);
  assert.match(refused.stdout,/refusing symlinked definition/u);
  assert.equal(readFileSync(real,'utf8').includes('Christopher'),false);
  pass('symlinked definition refuses before any write');
}

// ---------------------------------------------------------------------------
// 9. Concurrency: two truly simultaneous applies serialize; audit stays green.
// ---------------------------------------------------------------------------
{
  const f=await fixture('concurrent');
  const invoke=(name)=>new Promise(done=>{
    const child=spawn(process.execPath,[cli,'identity','update','bennett','--name',name,'--apply','--json'],
      {env:f.env,cwd:join(f.dir,'unrelated'),stdio:['ignore','pipe','pipe']});
    let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);
    child.on('close',status=>done({status,out}));
  });
  const [one,two]=await Promise.all([invoke('Christopher'),invoke('Christian')]);
  const codes=[one.status,two.status].sort();
  assert.ok(codes[0]===0,'at least one apply wins');
  const agent=YAML.parse(readFileSync(f.deskAgent(),'utf8'));
  assert.ok(['Christopher','Christian'].includes(agent.display_name),`durable name: ${agent.display_name}`);
  assert.ok(f.json(f.run(['audit','--employee','bennett','--json'])).ok,'audit green after concurrent applies');
  pass(`simultaneous applies serialize (${codes.join(',')}); audit stays green`);
}

// ---------------------------------------------------------------------------
// 10. Unmanaged surfaces are reported, not pretended synced (json + human).
// ---------------------------------------------------------------------------
{
  const result=e2e.json(e2e.run(['identity','update','bennett','--tone','Calm and exact.','--json']));
  assert.deepEqual(result.unmanaged.map(s=>s.surface),['provider_display_names','vault_item_label','mailbox','avatar','external_slack']);
  assert.ok(result.unmanaged.every(s=>s.detail.length>20));
  const human=e2e.run(['identity','update','bennett','--tone','Calm and exact.']);
  assert.equal(human.status,0);
  assert.match(human.stdout,/unmanaged provider_display_names/u);
  assert.match(human.stdout,/would change \(preview; pass --apply\)/u);
  assert.match(human.stdout,/name Christopher -> Christopher/u);
  pass('unmanaged surfaces reported in json and human output');
}

// Ordinary suite fixtures must not depend on a production employee's current name.
{
  const f=await fixture('fixture-shape');
  const result=f.json(f.run(['identity','update','bennett','--name','Christopher','--json']));
  assert.equal(result.from.display_name,'Arnie');
  assert.equal(result.to.display_name,'Christopher');
  assert.equal(result.immutable.company_identity.subject,f.subject);
  pass('Arnie-to-Christopher fixture remains independent of production state');
}

// Verify the registry lock remains held while the real profile preflight blocks.
{
  const f=await fixture('identity-contention');
  const barrier=join(f.dir,'barrier');
  let output='';
  const child=spawn(process.execPath,[cli,'identity','update','bennett','--name','Christopher','--apply','--json'],{env:{...f.env,PYTEST_CURRENT_TEST:'persona-contention',PJANGLER_TEST_PROFILE_CONFIG_BARRIER:barrier,PJANGLER_TEST_PROFILE_CONFIG_BARRIER_LABEL:'specialist'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const done=new Promise(resolve=>child.on('close',resolve));
  const deadline=Date.now()+10000;
  while(!existsSync(barrier+'.ready') && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(existsSync(barrier+'.ready'),'profile snapshot barrier reached');
  const contender=spawnSync('flock',['-n',f.registry+'.lock','true'],{env:f.env});
  assert.equal(contender.status,1,'registry lock remains held at profile snapshot');
  writeFileSync(barrier+'.resume','resume');
  assert.equal(await done,0,output);
  assert.ok(f.json(f.run(['audit','--employee','bennett','--json'])).ok);
  pass('registry lock spans real profile preflight and refresh, blocking concurrent identity writers');
}

console.log(`\n${count} persona update check groups passed`);
rmSync(work,{recursive:true,force:true});
