// FLUME-32: run the built CLI and real Copier tasks against the pinned template.
// Hermes profile creation is the sole runtime fixture; Skillex and the config renderer are real.
import assert from 'node:assert/strict';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,readlinkSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';
import {createSet,addSetSkills,createPack,addPackSkills} from '@delorenj/skillex';

const root=resolve(import.meta.dirname,'..');
const cli=join(root,'packages/flume-hr/dist/index.js');
const skillexCli=join(root,'node_modules/@delorenj/skillex/dist/cli.js');
const template=join(root,'templates/hermes-agent');
const renderer=join(template,'scripts/hermes-profile-config.py');
// Literal /tmp prevents an operator TMPDIR inside a checkout from answering for fixtures.
const work=mkdtempSync('/tmp/flume32-hire-');
const tool=name=>{
  const result=spawnSync('which',[name],{encoding:'utf8'});
  assert.equal(result.status,0,`${name} is required for the real hire proof: ${result.stderr}`);
  return realpathSync(result.stdout.trim());
};
const copier=tool('copier'),python=tool('python3');
const names=dir=>readdirSync(dir).filter(n=>!n.startsWith('.')).sort();
const models=[
  'automaticai/personal/sol-6.1','automaticai/personal/sol','automaticai/personal/astra',
  'automaticai/personal/claude-opus-5.5','automaticai/intelliforia/claude-opus-5.5',
  'automaticai/personal/claude-sonnet-5.5','automaticai/intelliforia/claude-sonnet-5.5',
  'automaticai/personal/kimi-k3','automaticai/personal/kimi-k3s','automaticai/personal/kimi-2.8',
  'automaticai/personal/glm-5.3','automaticai/personal/glm-5.3-flash',
];
let count=0;
const pass=label=>{count++;console.log(`PASS ${label}`);};

function tree(path) {
  let stat;
  try {stat=lstatSync(path);} catch(error) {if(error.code==='ENOENT') return null;throw error;}
  if(stat.isSymbolicLink()) return {link:readlinkSync(path),ino:stat.ino};
  if(stat.isDirectory()) return Object.fromEntries(readdirSync(path).sort().map(n=>[n,tree(join(path,n))]));
  return {bytes:readFileSync(path).toString('base64')};
}

async function fixture(label,skills) {
  const dir=join(work,label),home=join(dir,'home'),hermes=join(home,'.hermes'),skillex=join(dir,'skillex');
  const repo=join(dir,'demo'),bin=join(dir,'bin'),runtime=join(dir,'runtime-fixture'),roles=join(dir,'declarations');
  const registry=join(hermes,'agents-registry.yaml'),org=join(hermes,'org.yaml'),calls=join(dir,'calls.jsonl'),blocked=join(dir,'blocked.log');
  const config=join(home,'.config/hermes-agent-template/config.toml');
  for(const path of [hermes,repo,bin,runtime,join(roles,'roles'),join(home,'.agents'),join(home,'.config/hermes-agent-template')]) mkdirSync(path,{recursive:true});
  const reg={registryRoot:skillex,home,stateHome:join(home,'.local/state')};
  for(const name of ['build','review','deploy','lint','global']) {
    mkdirSync(join(skillex,'all-skills',name),{recursive:true});
    writeFileSync(join(skillex,'all-skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: fixture ${name}\n---\n`);
  }
  for(const [name,members] of [['dev-set',['build','review']],['ops-set',['deploy','lint']],['global-set',['global']]]) {
    assert.ok((await createSet(name,reg)).ok);assert.ok((await addSetSkills(name,members,reg)).ok);
  }
  for(const [name,members] of [['dev',['build','review']],['ops',['deploy','lint']]]) {
    assert.ok((await createPack(name,'1.0.0',reg)).ok);assert.ok((await addPackSkills(`${name}@1.0.0`,members,reg)).ok);
  }
  writeFileSync(join(home,'.agents/skills.json'),JSON.stringify({sets:['global-set']}));
  mkdirSync(join(repo,'.agents'),{recursive:true});
  // Step 10 starts with a different selection. The declaration must replace it.
  writeFileSync(join(repo,'.agents/skills.json'),JSON.stringify({sets:['ops-set'],inherit_global:true}));
  writeFileSync(join(repo,'.project.json'),JSON.stringify({name:'demo',project_dir:repo,ticket_provider:{type:'plane',state:'deferred'},agents:{},fixture:'preserve'}));
  const model='automaticai/personal/kimi-2.8';
  writeFileSync(join(hermes,'config.yaml'),YAML.stringify({
    model:{provider:'automaticai',default:model},
    providers:{automaticai:{api:'https://api.automaticai.io/v1',key_env:'AUTOMATICAI_GATEWAY_KEY',models,extra_body:{reasoning_effort:'high'}}},
    delegation:{provider:'automaticai',model},auxiliary:{free_only:true,discovery:false},moa:{presets:{default:{enabled:false}}},
    memory:{provider:'hindsight'},hooks:Object.fromEntries(['on_session_start','on_session_end','pre_tool_call','post_tool_call'].map(e=>[e,[{command:`${join(home,'.agents/hooks/bb-hook')} --cli hermes --native ${e}`}]])),
    skills:{external_dirs:[join(home,'.agents/skills')]},platform_toolsets:{bloodbank:['delegation','terminal','file','skills','web']},
    timeouts:{tools:{concurrent_batch:1800,sequential_call:1800}},
    // A deliberately unusable reference: neither the test nor any child resolves it.
    secrets:{onepassword:{enabled:true,env:{AUTOMATICAI_GATEWAY_KEY:'op://fixture/gateway/credential'}}},
  }));
  writeFileSync(join(hermes,'.env'),'');writeFileSync(join(hermes,'auth.json'),'{}\n');
  writeFileSync(registry,'# registry top comment\nschema_version: 1\nagents:\n  boss: {role: director, department: engineering} # boss comment\n  unrelated: {role: reporter, department: editorial, notes: preserve} # unrelated comment\n');
  writeFileSync(org,'# org top comment\ncompany: {name: Fixture}\ndepartments:\n  - id: engineering # department comment\n    manager: boss\n    members: [] # members comment\n  - id: editorial\n    members: [unrelated] # editorial comment\n');
  writeFileSync(join(roles,'roles/dev.md'),'---\n'+YAML.stringify({role:'dev',skills,department:'engineering',reports_to:'boss'})+'---\nFixture role\n');
  const log=`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(calls)},JSON.stringify({command:process.argv[1].split('/').pop(),args:process.argv.slice(2)})+'\\n');\n`;
  const executable=(name,code)=>writeFileSync(join(bin,name),`#!${process.execPath}\n${log}${code}\n`,{mode:0o755});
  // This wrapper forwards every argument to the real installed Copier and preserves its exit status.
  executable('copier',`import {spawnSync} from 'node:child_process';const r=spawnSync(${JSON.stringify(copier)},process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(r.status??1);`);
  executable('skillex',`await import(${JSON.stringify(skillexCli)});`);
  executable('flume',`await import(${JSON.stringify(cli)});`);
  // Only the external Hermes profile-create interface is simulated. No renderer/task/audit is replaced.
  executable('hermes',`import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const a=process.argv.slice(2);if(JSON.stringify(a)!==JSON.stringify(['profile','create','demo-dev','--no-alias','--no-skills']))process.exit(93);const p=join(process.env.HOME,'.hermes/profiles',a[2]);mkdirSync(p,{recursive:true});writeFileSync(join(p,'config.yaml'),'{}\\n');writeFileSync(join(p,'.env'),'');`);
  symlinkSync(python,join(bin,'python3'));
  for(const name of ['curl','wget','op','systemctl','gh','pj','mise','bloodbank','nats','ssh']) {
    executable(name,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(blocked)},${JSON.stringify(name)}+'\\n');process.exit(97);`);
  }
  writeFileSync(config,`# fixture config\n[fleet]\nhermes_bin = ${JSON.stringify(join(bin,'hermes'))}\nhermes_repo = ${JSON.stringify(runtime)}\nflume_bin = ${JSON.stringify(join(bin,'flume'))}\npjangler_bin = ${JSON.stringify(join(bin,'flume'))}\nfleet_env = ${JSON.stringify(join(hermes,'fleet.env'))}\nregistry_file = ${JSON.stringify(registry)}\n[hindsight]\nagent_bank_template = ""\n`);
  // Allowlist, never {...process.env}: no operator credentials, services, hooks, runtime or config.
  const env={
    HOME:home,PATH:`${bin}:/usr/bin:/bin`,TMPDIR:dir,LANG:'C.UTF-8',NO_COLOR:'1',COLUMNS:'100',
    XDG_CONFIG_HOME:join(home,'.config'),XDG_STATE_HOME:join(home,'.local/state'),XDG_DATA_HOME:join(home,'.local/share'),XDG_CACHE_HOME:join(home,'.cache'),
    HERMES_FLEET_HOME:hermes,HERMES_AGENTS_REGISTRY:registry,HERMES_FLEET_REGISTRY_FILE:registry,HERMES_ORG_PATH:org,
    HERMES_TEMPLATE_CONFIG:config,HERMES_FLEET_ENV:join(hermes,'fleet.env'),HERMES_BIN:join(bin,'hermes'),HERMES_AGENT_REPO:runtime,
    FLUME_BIN:join(bin,'flume'),PJANGLER_BIN:join(bin,'unavailable-pj'),PJ_SKILLS_REGISTRY_ROOT:skillex,SKILLEX_BIN:join(bin,'skillex'),
    PROFILE_RENDERER:renderer,FLUME_ROLES_ROOT:roles,FLUME_GATEWAY_CATALOG:join(dir,'routes.json'),
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CEILING_DIRECTORIES:work,GIT_ALLOW_PROTOCOL:'file',PYTHONDONTWRITEBYTECODE:'1',
  };
  writeFileSync(env.FLUME_GATEWAY_CATALOG,'[]\n');
  const init=spawnSync('git',['init','--quiet','--initial-branch=main','--template=',repo],{encoding:'utf8',env});
  assert.equal(init.status,0,init.stderr);
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:repo,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  const show=()=>{
    const result=spawnSync(process.execPath,[skillexCli,'profile','show','demo-dev','--hermes-root',hermes,'--registry-root',skillex,'--json'],{env,encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout).data;
  };
  const records=()=>existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n').map(s=>JSON.parse(s)):[];
  const desk=join(hermes,'profiles/demo-dev'),roleDir=join(repo,'agents/hermes/dev');
  return {dir,home,hermes,skillex,repo,registry,org,config,env,desk,roleDir,run,show,records,blocked};
}
const hire=f=>f.run('hire','dev','--yes','--skip-telegram','--skip-plane','--local');
const onboard=f=>f.run('onboard','dev','--target-repo','demo','--skip-telegram','--skip-plane','--local');
const succeeded=result=>assert.equal(result.status,0,`${result.error?.message??''}\n${result.stdout}\n${result.stderr}`);
const writeDelta=(f,delta)=>{
  const dumped=spawnSync(python,['-I','-c','import json,sys,yaml; print(yaml.safe_dump(json.load(sys.stdin),default_flow_style=False,sort_keys=False,width=100),end="")'],
    {env:f.env,input:JSON.stringify(delta),encoding:'utf8'});
  assert.equal(dumped.status,0,dumped.stderr);
  writeFileSync(join(f.desk,'config.delta.yaml'),dumped.stdout);
};
const removeBloodbankPatch=delta=>{
  const directive=delta['x-pjangler-merge'];
  if(directive?.list_patches) {
    delete directive.list_patches['platform_toolsets.bloodbank'];
    if(!Object.keys(directive.list_patches).length) delete directive.list_patches;
    if(!Object.keys(directive).length) delete delta['x-pjangler-merge'];
  }
};

try {
  // Verify the checkout matches the parent's pin, without touching the canonical template checkout.
  const git=(cwd,args)=>{
    const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  const pin=git(root,['ls-tree','HEAD','templates/hermes-agent']).match(/^160000 commit ([0-9a-f]{40})\t/)[1];
  assert.equal(git(template,['rev-parse','HEAD']),pin,'Copier must use the vendored gitlink, not another checkout');
  assert.equal(git(template,['status','--porcelain']),'','the real template fixture is clean');

  for(const [label,skills,manifest] of [
    ['set',{set:'dev-set'},{inherit_global:false,sets:['dev-set']}],
    ['pack',{pack:'dev@1.0.0'},{inherit_global:false,packs:['dev@1.0.0']}],
  ]) {
    const f=await fixture(label,skills),base=readFileSync(join(f.hermes,'config.yaml'),'utf8');
    const beforeRegistry=YAML.parse(readFileSync(f.registry,'utf8'));
    // Drive parser semantics through the real consumer too, with neither
    // explicit registry override available to hide a bad fleet.env resolution.
    delete f.env.HERMES_AGENTS_REGISTRY;delete f.env.HERMES_FLEET_REGISTRY_FILE;
    writeFileSync(join(f.hermes,'fleet.env'),label==='set'
      ? `HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/agents-registry.yaml # registry\n`
      : `HERMES_FLEET_REGISTRY_FILE="${f.registry}" # registry\n`);
    const first=hire(f);succeeded(first);
    assert.match(first.stdout,/Role declaration projected/);
    assert.match(first.stdout,/Hermes lifecycle audit passed/,'the final hire audit must finish');
    assert.match(first.stdout,/verified|deferred/i);
    assert.match(first.stdout,/automatic Skillex resync \(host service\)/,'local hire names its host automation deferral');
    assert.equal(existsSync(f.blocked),false,'no credential, network or service tool was used');
    const records=f.records();
    const copierRuns=records.filter(r=>r.command==='copier');
    assert.equal(copierRuns.length,1);assert.deepEqual(copierRuns[0].args.slice(0,3),['copy',template,f.roleDir]);
    assert.ok(copierRuns[0].args.includes('--vcs-ref=HEAD'));
    assert.ok(records.some(r=>r.command==='hermes'&&r.args[1]==='create'));
    assert.ok(records.some(r=>r.command==='skillex'&&r.args.includes(f.repo)&&r.args.includes('--skillex-only')&&!r.args.includes('--dry-run')));
    for(const preview of [true,false]) assert.ok(records.some(r=>r.command==='flume'&&r.args[0]==='migrate'&&r.args[1]==='hermes.runtime-singleton'&&r.args.includes('--dry-run')===preview));
    for(const step of ['01-config','05-fleet-env','10-hermes-profile','20-runtime-repo','80-registry']) assert.ok(existsSync(join(f.roleDir,`.scripts/.done-${step}`)),`actual task ${step} completed`);
    assert.equal(existsSync(join(f.roleDir,'runtime/.git')),false);
    assert.equal(lstatSync(f.desk).isDirectory(),true);
    assert.deepEqual(names(join(f.desk,'skills')),['build','global','review']);
    for(const name of ['build','global','review']) {
      assert.ok(lstatSync(join(f.desk,'skills',name)).isSymbolicLink());
      assert.equal(realpathSync(join(f.desk,'skills',name)),join(f.skillex,'all-skills',name));
    }
    for(const marker of ['.skillex-only','.no-bundled-skills']) assert.ok(lstatSync(join(f.desk,marker)).isFile());
    assert.equal(existsSync(join(f.desk,'.agents')),false);
    const generated=YAML.parse(readFileSync(join(f.desk,'config.yaml'),'utf8'));
    assert.deepEqual(generated.skills.external_dirs,[]);
    assert.deepEqual(generated.platform_toolsets.bloodbank,['skills','web'],'contributor permissions use a scoped list patch');
    const selection=join(f.desk,'.skillex-selection/.agents/skills.json');
    assert.deepEqual(JSON.parse(readFileSync(selection,'utf8')),manifest);
    const shown=f.show();
    assert.deepEqual(shown.managed.map(m=>m.name).sort(),['build','global','review']);assert.deepEqual(shown.changes,[]);
    assert.equal(realpathSync(shown.project),realpathSync(join(f.desk,'.skillex-selection')));
    const registry=YAML.parse(readFileSync(f.registry,'utf8')),org=YAML.parse(readFileSync(f.org,'utf8'));
    assert.equal(registry.agents['demo-dev'].department,'engineering');assert.equal(registry.agents['demo-dev'].reports_to,'boss');
    for(const id of ['boss','unrelated']) assert.deepEqual(registry.agents[id],beforeRegistry.agents[id]);
    assert.equal(org.departments[0].manager,'boss');assert.deepEqual(org.departments[0].members,['demo-dev']);assert.deepEqual(org.departments[1].members,['unrelated']);
    for(const comment of ['registry top comment','boss comment','unrelated comment']) assert.ok(readFileSync(f.registry,'utf8').includes(`# ${comment}`));
    for(const comment of ['org top comment','department comment','members comment','editorial comment']) assert.ok(readFileSync(f.org,'utf8').includes(`# ${comment}`));
    assert.equal(JSON.parse(readFileSync(join(f.repo,'.project.json'),'utf8')).fixture,'preserve');
    assert.equal(readFileSync(join(f.hermes,'config.yaml'),'utf8'),base,'the fleet base is never edited');
    pass(`real ${label} hire: Copier tasks, final audit, strict global + declared selection, comments and organization`);

    // Files retain their bytes and skill links retain their identity through two real onboard calls.
    writeFileSync(join(f.desk,'skills/.usage.json'),'{}\n');
    writeFileSync(join(f.roleDir,'runtime/sessions/operator-note'),'precious unrelated state\n');
    const snapshot=()=>({registry:tree(f.registry),org:tree(f.org),config:tree(f.config),desk:tree(f.desk),repo:tree(f.repo),receipt:tree(shown.receiptPath)});
    const before=snapshot();
    for(let i=0;i<2;i++) {
      const onboard=f.run('onboard','dev','--target-repo','demo','--skip-telegram','--skip-plane','--local');succeeded(onboard);
      assert.deepEqual(snapshot(),before,'onboard preserves bytes, links, receipt, comments, reporting and unrelated state');
    }
    assert.equal(f.records().filter(r=>r.command==='copier').length,1,'onboarding does not rerender an occupied desk');
    assert.deepEqual(f.show().changes,[]);assert.equal(existsSync(f.blocked),false);
    pass(`${label} onboard twice: byte-identical state, receipt and strict links`);

    const refused=hire(f);assert.notEqual(refused.status,0);assert.match(refused.stdout+refused.stderr,/target directory is not empty.*--force/s);
    assert.deepEqual(snapshot(),before);assert.equal(f.records().filter(r=>r.command==='copier').length,1);
    pass(`${label} occupied role: unforced noninteractive hire refuses before any mutation`);

    if(label==='set') {
      const deltaPath=join(f.desk,'config.delta.yaml'),basePath=join(f.hermes,'config.yaml');
      const modifiedBase=YAML.parse(base);modifiedBase.platform_toolsets.bloodbank=['delegation','skills'];
      writeFileSync(basePath,YAML.stringify(modifiedBase));
      let delta=YAML.parse(readFileSync(deltaPath,'utf8'));removeBloodbankPatch(delta);
      delta['x-operator-note']={keep:['unrelated','state']};writeDelta(f,delta);
      const victim=join(f.dir,'operator-owned'),trap=join(f.desk,'.config.delta.yaml.hire-tmp');
      writeFileSync(victim,'precious operator file\n');symlinkSync(victim,trap);
      const trapInode=lstatSync(trap).ino;
      succeeded(onboard(f));
      delta=YAML.parse(readFileSync(deltaPath,'utf8'));
      assert.deepEqual(delta['x-pjangler-merge'].list_patches['platform_toolsets.bloodbank'],{remove:['delegation','terminal','file']});
      assert.deepEqual(delta['x-operator-note'],{keep:['unrelated','state']});
      assert.equal(lstatSync(deltaPath).isSymbolicLink(),false);assert.equal(lstatSync(deltaPath).mode&0o777,0o600);
      assert.equal(lstatSync(trap).ino,trapInode);assert.equal(readlinkSync(trap),victim);
      assert.equal(readFileSync(victim,'utf8'),'precious operator file\n');
      assert.deepEqual(readdirSync(f.desk).filter(n=>n.startsWith('.config.delta.yaml.hire-')),['.config.delta.yaml.hire-tmp']);
      pass('onboard uses an exclusive delta temporary; a pre-existing temp symlink and its target survive');

      modifiedBase.platform_toolsets.bloodbank=['delegation','terminal','file','skills','web'];
      const grownBase=YAML.stringify(modifiedBase);writeFileSync(basePath,grownBase);
      succeeded(onboard(f));
      assert.deepEqual(YAML.parse(readFileSync(join(f.desk,'config.yaml'),'utf8')).platform_toolsets.bloodbank,['skills','web']);
      assert.equal(readFileSync(basePath,'utf8'),grownBase);
      const stable=snapshot();succeeded(onboard(f));assert.deepEqual(snapshot(),stable);
      assert.equal(readFileSync(victim,'utf8'),'precious operator file\n');
      pass('complete generated restriction survives later base growth and repeat onboarding');

      for(const kind of ['direct-list','list-patch']) {
        delta=YAML.parse(readFileSync(deltaPath,'utf8'));removeBloodbankPatch(delta);
        delete delta.platform_toolsets?.bloodbank;
        if(kind==='direct-list') delta.platform_toolsets={...delta.platform_toolsets,bloodbank:['terminal','skills']};
        else delta['x-pjangler-merge']={list_patches:{'platform_toolsets.bloodbank':{remove:['delegation','file'],add:['web']}}};
        writeDelta(f,delta);
        const operatorDelta=readFileSync(deltaPath,'utf8'),operatorNote=readFileSync(victim,'utf8');
        for(let i=0;i<2;i++) {
          succeeded(onboard(f));
          assert.equal(readFileSync(deltaPath,'utf8'),operatorDelta,'operator-owned delta stays byte-identical');
          assert.equal(readFileSync(victim,'utf8'),operatorNote);
          const tools=YAML.parse(readFileSync(join(f.desk,'config.yaml'),'utf8')).platform_toolsets.bloodbank;
          assert.ok(tools.includes('terminal'),'explicit operator permission is never silently stripped');
          assert.equal(tools.includes('delegation'),false);assert.equal(lstatSync(trap).ino,trapInode);
        }
        assert.equal(readFileSync(basePath,'utf8'),grownBase);assert.equal(existsSync(f.blocked),false);
        pass(`onboard preserves explicit Bloodbank ${kind}, unrelated delta and operator files`);
      }
    }
  }

  for(const [label,skills,needle] of [
    ['missing-set',{set:'no-such-set'},/no-such-set/],
    ['incompatible-packs',{packs:['dev','ops']},/2 packs \(dev, ops\).*exclusive complete loadout/],
  ]) {
    const f=await fixture(label,skills),before={home:tree(f.home),repo:tree(f.repo)};
    const refused=hire(f);assert.notEqual(refused.status,0);assert.match(refused.stdout+refused.stderr,needle);
    assert.deepEqual({home:tree(f.home),repo:tree(f.repo)},before,'invalid loadout fails before config, role, desk or receipt writes');
    assert.deepEqual(f.records(),[]);assert.equal(existsSync(f.desk),false);assert.equal(existsSync(f.blocked),false);
    pass(`${label}: named declaration failure before provisioning`);
  }

  for(const [label,fields,needle] of [
    ['missing-department',{department:'unknown-department'},/unknown-department absent from org/],
    ['missing-manager',{reports_to:'missing-boss'},/missing-boss absent from registry/],
    ['reporting-cycle',{reports_to:'demo-dev'},/reporting cycle/],
    ['unknown-route',{chain:['automaticai/personal/unknown-route']},/unknown-route absent from gateway catalog/],
    ['unreadable-catalog',{chain:['automaticai/personal/sol-6.1']},/gateway catalog unavailable/],
  ]) {
    const f=await fixture(label,{set:'dev-set'});
    writeFileSync(join(f.dir,'declarations/roles/dev.md'),'---\n'+YAML.stringify({role:'dev',skills:{set:'dev-set'},department:'engineering',reports_to:'boss',...fields})+'---\nFixture role\n');
    if(label==='unreadable-catalog') rmSync(f.env.FLUME_GATEWAY_CATALOG);
    const before={home:tree(f.home),repo:tree(f.repo),catalog:tree(f.skillex)};
    const refused=hire(f);assert.notEqual(refused.status,0);assert.match(refused.stdout+refused.stderr,needle);
    assert.deepEqual({home:tree(f.home),repo:tree(f.repo),catalog:tree(f.skillex)},before);
    assert.deepEqual(f.records(),[]);assert.equal(existsSync(f.desk),false);assert.equal(existsSync(f.blocked),false);
    pass(`${label}: built hire preflight refuses before any provisioning or operator data change`);
  }

  const malformed=await fixture('invalid-fleet-env',{set:'dev-set'});
  const fleetEnv=join(malformed.hermes,'fleet.env');writeFileSync(fleetEnv,'HERMES_FLEET_REGISTRY_FILE="/tmp/registry" trailing\n');
  const untouched={home:tree(malformed.home),repo:tree(malformed.repo)};
  const refused=hire(malformed);assert.notEqual(refused.status,0);assert.match(refused.stdout+refused.stderr,/Registry preflight: Fleet environment:/);
  assert.deepEqual({home:tree(malformed.home),repo:tree(malformed.repo)},untouched);
  assert.deepEqual(malformed.records(),[]);assert.equal(existsSync(malformed.desk),false);assert.equal(existsSync(malformed.blocked),false);
  pass('built hire refuses invalid canonical fleet data before Copier or any fixture mutation');

  const f=await fixture('copier-failure',{set:'dev-set'});
  rmSync(join(f.repo,'.agents/skills.json'));
  const failed=hire(f);assert.notEqual(failed.status,0);
  assert.match(failed.stdout+failed.stderr,/project selection is missing/);
  assert.match(failed.stdout+failed.stderr,/copier exited with status/);
  assert.doesNotMatch(failed.stdout,/Hermes lifecycle audit passed/);
  assert.equal(f.records().filter(r=>r.command==='copier').length,1,'a real failed Copier task is not replaced by a fake exit');
  assert.equal(existsSync(f.desk),false);assert.equal(existsSync(f.blocked),false);
  pass('real Copier task failure exits nonzero, names the cause and never claims hire completion');
  assert.equal(git(template,['status','--porcelain']),'','the vendored template is untouched');
  assert.equal(git(root,['ls-tree','HEAD','templates/hermes-agent']).match(/^160000 commit ([0-9a-f]{40})\t/)[1],pin);
  console.log(`\n${count} role-hire check groups passed`);
} finally {rmSync(work,{recursive:true,force:true});}
