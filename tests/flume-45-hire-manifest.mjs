import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';
import {createSet,addSetSkills} from '@delorenj/skillex';

const root=resolve(import.meta.dirname,'..');
const cli=join(root,'packages/flume-hr/dist/index.js');
const template=join(root,'templates/hermes-agent');
const work=mkdtempSync(join(process.env.TMPDIR,'flume45-hire-'));
const models=[
  'automaticai/personal/sol-6.1','automaticai/personal/sol','automaticai/personal/astra',
  'automaticai/personal/claude-opus-5.5','automaticai/intelliforia/claude-opus-5.5',
  'automaticai/personal/claude-sonnet-5.5','automaticai/intelliforia/claude-sonnet-5.5',
  'automaticai/personal/kimi-k3','automaticai/personal/kimi-k3s','automaticai/personal/kimi-2.8',
  'automaticai/personal/glm-5.3','automaticai/personal/glm-5.3-flash',
];
const copierLookup=spawnSync('which',['copier'],{encoding:'utf8'});
assert.equal(copierLookup.status,0,'real Copier is required for the public hire regression');
const copier=realpathSync(copierLookup.stdout.trim());
const executable=(path,code)=>writeFileSync(path,`#!${process.execPath}\n${code}\n`,{mode:0o755});
const blocked=['curl','wget','op','systemctl','gh','pj','mise','bloodbank','nats','ssh'];
let passed=0;
const pass=label=>{passed++;console.log(`PASS ${label}`);};

async function fixture(label,shape,extra={}) {
  const dir=join(work,label),repo=join(dir,'demo'),home=join(dir,'home'),hermes=join(home,'.hermes');
  const bin=join(dir,'bin'),registry=join(hermes,'agents-registry.yaml'),runtime=join(dir,'runtime');
  const config=join(home,'.config/hermes-agent-template/config.toml'),blockedLog=join(dir,'blocked.log');
  for(const path of [repo,bin,runtime,hermes,join(home,'.config/hermes-agent-template')]) mkdirSync(path,{recursive:true});
  const catalog=join(dir,'skillex');
  mkdirSync(join(catalog,'all-skills','fixture'),{recursive:true});
  writeFileSync(join(catalog,'all-skills','fixture','SKILL.md'),'---\nname: fixture\ndescription: Isolated test skill\n---\n');
  const skills={registryRoot:catalog,home,stateHome:join(home,'.local/state')};
  assert.ok((await createSet('hire-fixture',skills)).ok);
  assert.ok((await addSetSkills('hire-fixture',['fixture'],skills)).ok);
  mkdirSync(join(repo,'.agents'),{recursive:true});
  writeFileSync(join(repo,'.agents/skills.json'),JSON.stringify({set:'hire-fixture',inherit_global:false}));
  executable(join(bin,'skillex'),`await import(${JSON.stringify(join(root,'node_modules/@delorenj/skillex/dist/cli.js'))});`);
  const manifest={project_id:'demo',repo_path:repo,ticket_provider:{type:'plane',state:'deferred'},notebook:{binding:{state:'planned'}},automation:{enabled:false},'x-unrecognized':{keep:['value']},...extra};
  if(shape==='empty') manifest.agents={};
  writeFileSync(join(repo,'.project.json'),JSON.stringify(manifest,null,2)+'\n');
  writeFileSync(join(hermes,'config.yaml'),YAML.stringify({
    model:{provider:'automaticai',default:'automaticai/personal/kimi-2.8'},
    providers:{automaticai:{api:'https://api.automaticai.io/v1',key_env:'AUTOMATICAI_GATEWAY_KEY',models,extra_body:{reasoning_effort:'high'}}},
    delegation:{provider:'automaticai',model:'automaticai/personal/kimi-2.8'},auxiliary:{free_only:true,discovery:false},moa:{presets:{default:{enabled:false}}},
    memory:{provider:'hindsight'},hooks:Object.fromEntries(['on_session_start','on_session_end','pre_tool_call','post_tool_call'].map(e=>[e,[{command:`${join(home,'.agents/hooks/bb-hook')} --cli hermes --native ${e}`}]])),skills:{external_dirs:[join(home,'.agents/skills')]},platform_toolsets:{bloodbank:['delegation','terminal','file','skills','web']},
    timeouts:{tools:{concurrent_batch:1800,sequential_call:1800}},
    secrets:{onepassword:{enabled:true,env:{AUTOMATICAI_GATEWAY_KEY:'op://fixture/gateway/credential'}}},
  }));
  writeFileSync(join(hermes,'.env'),'');writeFileSync(join(hermes,'auth.json'),'{}\n');
  const roles=join(dir,'declarations');
  mkdirSync(join(roles,'roles'),{recursive:true});
  writeFileSync(join(roles,'roles/_default.md'),'---\nrole: default\n---\nFixture default\n');
  writeFileSync(join(roles,'roles/dev.md'),'---\n'+YAML.stringify({role:'dev',skills:{set:'hire-fixture'},department:'engineering',reports_to:'boss'})+'---\nFixture role\n');
  writeFileSync(registry,'schema_version: 1\nagents:\n  boss: {role: director, department: engineering}\n');
  writeFileSync(join(hermes,'org.yaml'),'company: {name: Fixture}\ndepartments:\n  - id: engineering\n    manager: boss\n    members: []\n');
  writeFileSync(config,`[fleet]\nhermes_bin = ${JSON.stringify(join(bin,'hermes'))}\nhermes_repo = ${JSON.stringify(runtime)}\nflume_bin = ${JSON.stringify(join(bin,'flume'))}\npjangler_bin = ${JSON.stringify(join(bin,'flume'))}\nfleet_env = ${JSON.stringify(join(hermes,'fleet.env'))}\nregistry_file = ${JSON.stringify(registry)}\n[hindsight]\nagent_bank_template = ""\n`);
  executable(join(bin,'hermes'),`import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const a=process.argv.slice(2);if(a[0]!=='profile'||a[1]!=='create'||!['demo-pm','demo-dev'].includes(a[2])||a[3]!=='--no-alias'||a[4]!=='--no-skills')process.exit(93);const p=join(process.env.HOME,'.hermes/profiles',a[2]);mkdirSync(p,{recursive:true});writeFileSync(join(p,'config.yaml'),'{}\\n');writeFileSync(join(p,'.env'),'');`);
  executable(join(bin,'flume'),`await import(${JSON.stringify(cli)});`);
  for(const name of blocked) executable(join(bin,name),`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(blockedLog)},${JSON.stringify(name)}+'\\n');process.exit(97);`);
  executable(join(bin,'copier'),`import {spawnSync} from 'node:child_process';const r=spawnSync(${JSON.stringify(copier)},process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(r.status??1);`);
  symlinkSync('/usr/bin/python3',join(bin,'python3'));
  const env={HOME:home,PATH:`${bin}:/usr/bin:/bin`,TMPDIR:dir,LANG:'C.UTF-8',NO_COLOR:'1',COLUMNS:'100',
    XDG_CONFIG_HOME:join(home,'.config'),XDG_STATE_HOME:join(home,'.local/state'),XDG_DATA_HOME:join(home,'.local/share'),XDG_CACHE_HOME:join(home,'.cache'),
    HERMES_FLEET_HOME:hermes,HERMES_AGENTS_REGISTRY:registry,HERMES_FLEET_REGISTRY_FILE:registry,HERMES_ORG_PATH:join(hermes,'org.yaml'),FLUME_ROLES_ROOT:roles,
    HERMES_TEMPLATE_CONFIG:config,HERMES_FLEET_ENV:join(hermes,'fleet.env'),HERMES_BIN:join(bin,'hermes'),HERMES_AGENT_REPO:runtime,
    FLUME_BIN:join(bin,'flume'),PJANGLER_BIN:join(bin,'unavailable-pj'),SKILLEX_BIN:join(bin,'skillex'),PJ_SKILLS_REGISTRY_ROOT:catalog,
    PROFILE_RENDERER:join(template,'scripts/hermes-profile-config.py'),FLUME_GATEWAY_CATALOG:join(dir,'routes.json'),FLUME_HOST_OVERLAY:'none',
    PJANGLER_HERMES_TEMPLATE:template,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CEILING_DIRECTORIES:work,
    GIT_ALLOW_PROTOCOL:'file',PYTHONDONTWRITEBYTECODE:'1',PLANE_API_KEY:'',TRELLO_KEY:'',TRELLO_TOKEN:'',
  };
  writeFileSync(env.FLUME_GATEWAY_CATALOG,'[]\n');
  const git=spawnSync('git',['init','--quiet','--initial-branch=main','--template=',repo],{encoding:'utf8',env});assert.equal(git.status,0,git.stderr);
  const run=(...args)=>spawnSync(process.execPath,[cli,'hire','pm','--yes','--skip-telegram','--skip-plane','--local',...args],{cwd:repo,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  const runDev=()=>spawnSync(process.execPath,[cli,'hire','dev','--yes','--skip-telegram','--skip-plane','--local'],{cwd:repo,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  return {repo,home,env,manifest,blockedLog,run,runDev};
}

try {
  for(const shape of ['absent','empty','shadow','managed']) {
    const extra=['shadow','managed'].includes(shape) ? {execution:{mode:shape}} : {};
    const f=await fixture(shape,shape,extra);
    const result=f.run();
    assert.equal(result.status,0,`${shape}: ${result.error?.message??''}\n${result.stdout}\n${result.stderr}`);
    const role=YAML.parse(readFileSync(join(f.repo,'agents/hermes/pm/role.yaml'),'utf8'));
    const actual=JSON.parse(readFileSync(join(f.repo,'.project.json'),'utf8'));
    assert.deepEqual(actual.agents,{[role.agent_id]:{role:'pm',role_dir:'agents/hermes/pm',provisioning_state:'provisioned'}});
    assert.deepEqual(Object.fromEntries(Object.entries(actual).filter(([key])=>key!=='agents')),Object.fromEntries(Object.entries(f.manifest).filter(([key])=>key!=='agents')));
    assert.equal(existsSync(f.blockedLog),false,'no production service tool invoked');
    pass(`${shape} agents: public repo-bound PM hire registers generated identity without touching project fields`);
  }
  const f=await fixture('existing','empty');
  const prior=f.runDev();
  assert.equal(prior.status,0,`${prior.stdout}\n${prior.stderr}`);
  const beforeExisting=JSON.parse(readFileSync(join(f.repo,'.project.json'),'utf8'));
  assert.deepEqual(Object.keys(beforeExisting.agents),['demo-dev']);
  beforeExisting.agents['demo-dev'].custom={keep:['legacy-note']};
  writeFileSync(join(f.repo,'.project.json'),JSON.stringify(beforeExisting,null,2)+'\n');
  const result=f.run();
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  const actual=JSON.parse(readFileSync(join(f.repo,'.project.json'),'utf8'));
  assert.deepEqual(actual.agents['demo-dev'],beforeExisting.agents['demo-dev']);
  assert.deepEqual(Object.keys(actual.agents).sort(),['demo-dev','demo-pm']);
  assert.deepEqual(Object.fromEntries(Object.entries(actual).filter(([key])=>key!=='agents')),Object.fromEntries(Object.entries(beforeExisting).filter(([key])=>key!=='agents')));
  pass('existing provisioned agent and unrelated project fields preserved');

  for (const mode of [undefined,'shadow','managed']) {
    const preview=await fixture(`dry-run-${mode??'absent'}`,'absent',mode ? {execution:{mode}} : {});
    const before=readFileSync(join(preview.repo,'.project.json'),'utf8');
    const planned=preview.run('--dry-run');
    assert.equal(planned.status,0,`${planned.stdout}\n${planned.stderr}`);
    assert.equal(readFileSync(join(preview.repo,'.project.json'),'utf8'),before);
    assert.equal(existsSync(join(preview.repo,'agents/hermes/pm/role.yaml')),false);
    assert.equal(existsSync(preview.blockedLog),false);
  }
  pass('public dry run leaves absent/shadow/managed project manifests byte-identical');

  const blockedWrite=await fixture('write-failure','empty');
  const manifestPath=join(blockedWrite.repo,'.project.json');
  const original=readFileSync(manifestPath,'utf8');
  const preload=join(work,'fail-manifest-write.cjs');
  writeFileSync(preload,`const fs=require('node:fs');const original=fs.writeFileSync;fs.writeFileSync=function(path,...args){if(String(path)===${JSON.stringify(manifestPath)})throw new Error('fixture manifest write denied');return original.call(this,path,...args)};\n`);
  // Only the manifest writer is denied; Copier and its controlled local fixture still run.
  const failure=spawnSync(process.execPath,['--require',preload,cli,'hire','pm','--yes','--skip-telegram','--skip-plane','--local'],
    {cwd:blockedWrite.repo,env:blockedWrite.env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  assert.notEqual(failure.status,0,`${failure.stdout}\n${failure.stderr}`);
  assert.match(failure.stdout+failure.stderr,/fixture manifest write denied/);
  assert.doesNotMatch(failure.stdout,/Hermes lifecycle audit passed/);
  assert.equal(readFileSync(manifestPath,'utf8'),original);
  assert.equal(existsSync(join(blockedWrite.repo,'agents/hermes/pm/role.yaml')),true,'render reached registration');
  assert.equal(existsSync(blockedWrite.blockedLog),false);
  pass('registration write failure exits nonzero, names the failure and never claims completion');
} finally {rmSync(work,{recursive:true,force:true});}
console.log(`${passed} FLUME-45 groups passed`);
