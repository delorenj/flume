import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import {spawnSync} from 'node:child_process';
import { build } from 'esbuild';
import {pathToFileURL} from 'node:url';
const bundle = join(process.cwd(), 'tests', `.role-projection-${process.pid}.mjs`);
await build({entryPoints:['packages/flume-hr/src/index.ts'],outfile:bundle,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
const api = await import(pathToFileURL(bundle).href);
rmSync(bundle);
const work=mkdtempSync(join(tmpdir(),'flume32-projection-'));
try {
  assert.equal(typeof api.projectRoleDeclaration,'function');
  const home=join(work,'home'), fleet=join(home,'.hermes'), registry=join(fleet,'agents-registry.yaml'), org=join(fleet,'org.yaml');
  const skillex=join(work,'skillex'), desk=join(fleet,'profiles','demo-dev');
  for(const name of ['build','review']) {mkdirSync(join(skillex,'all-skills',name),{recursive:true});writeFileSync(join(skillex,'all-skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: fixture\n---\n`);}
  mkdirSync(join(skillex,'packs','dev'),{recursive:true});writeFileSync(join(skillex,'packs','dev','pack.toml'),'[pack]\nname="dev"\nversion="1.0.0"\n[freeform]\nskills=["build","review"]\n');
  mkdirSync(desk,{recursive:true});
  const chain=['automaticai/auto','automaticai/auto/subagent','automaticai/auto/fast'];
  const base={model:{provider:'automaticai',default:'automaticai/fixture/base'},fallback_providers:[{provider:'automaticai',model:'automaticai/fixture/base-fallback'}],providers:{}};
  const catalogPath=join(work,'routes.json');
  writeFileSync(catalogPath,JSON.stringify({routes:[...chain,base.model.default,base.fallback_providers[0].model].map(id=>({id}))}));
  writeFileSync(join(fleet,'config.yaml'),YAML.stringify(base));
  writeFileSync(registry,'agents:\n  boss: {role: director, department: engineering}\n  unrelated: {role: reporter, department: editorial}\n');
  const original='# precious top comment\ncompany: {name: Fixture}\ndepartments:\n  - id: engineering # department comment\n    manager: boss\n    members: []\n  - id: editorial\n    members: [unrelated] # precious other employee\n';
  writeFileSync(org,original);
  const role={role:'dev',skills:{pack:'dev'},chain,department:'engineering',reports_to:'boss'};
  const options={home,fleetRoot:fleet,registryPath:registry,orgPath:org,skillexRoot:skillex,deskPath:desk,stateHome:join(home,'.local','state'),catalogModels:chain,catalogPath,renderer:join(process.cwd(),'templates/hermes-agent/scripts/hermes-profile-config.py')};
  await api.projectRoleDeclaration(role,'demo-dev','demo-dev',options);
  // The loadout is a Skillex selection projected into the strict desk's own skills/ -- never a
  // second skill directory or a discovery root.
  assert.deepEqual(readdirSync(join(desk,'skills')).filter(n=>!n.startsWith('.')).sort(),['build','review']);
  for(const name of ['build','review']) assert.equal(realpathSync(join(desk,'skills',name)),join(skillex,'all-skills',name));
  assert.equal(existsSync(join(desk,'.agents')),false,'a role loadout must not create <desk>/.agents/skills');
  const cfg=YAML.parse(readFileSync(join(desk,'config.yaml'),'utf8'));
  assert.deepEqual(cfg.skills.external_dirs,[],'a role loadout must never add skills.external_dirs');
  assert.deepEqual([cfg.model.default,...cfg.fallback_providers.map(x=>x.model)],chain);
  assert.equal(cfg.model.provider,'automaticai');
  assert.deepEqual(cfg.fallback_providers.map(x=>x.provider),['automaticai','automaticai']);
  assert.deepEqual(api.declarationProblems(role,'demo-dev',options),[],'catalog fixture accepts every auto-router tier');
  const absent={...options,catalogModels:chain.slice(1)};
  assert.ok(api.declarationProblems(role,'demo-dev',absent).some(x=>x.includes('automaticai/auto absent from gateway catalog')),'schema acceptance does not bypass catalog validation');
  const chart=api.buildOrgChart({home,registryPath:registry,orgPath:org});
  const find=n=>n.id==='demo-dev'?n:n.children.map(find).find(Boolean);
  const employee=find(chart.root);
  assert.equal(employee.department,'engineering');assert.equal(employee.reports_to,'boss');
  console.log('PASS AC-1 one role -> exact canonical skills, chain and org');
  const before=readFileSync(org,'utf8');
  for(let i=0;i<2;i++) await api.projectRoleDeclaration(role,'demo-dev','demo-dev',options);
  assert.equal(readFileSync(org,'utf8'),before);assert.match(before,/# precious top comment/);assert.match(before,/# department comment/);assert.match(before,/# precious other employee/);assert.match(before,/unrelated/);
  console.log('PASS AC-2 convergent projection twice, comments and unrelated employee retained');
  for(const [label,negative,needle] of [
    ['route',{...role,chain:['automaticai/personal/sol-5.5']},'sol-5.5'],
    ['reference',{...role,reports_to:'missing-boss'},'missing-boss'],
    ['cycle',{...role,reports_to:'demo-dev'},'cycle'],
    ['department',{...role,department:undefined},'no department']
  ]) {
    const findings=api.declarationProblems(negative,'demo-dev',options);
    assert.ok(findings.some(x=>x.includes(needle)),`${label}: ${findings}`);
    const rolesRoot=join(work,'declarations');mkdirSync(join(rolesRoot,'roles'),{recursive:true});
    writeFileSync(join(rolesRoot,'roles','dev.md'),'---\n'+YAML.stringify(negative)+'---\nfixture\n');
    const repo=join(work,'repo');mkdirSync(join(repo,'agents','hermes','dev'),{recursive:true});
    writeFileSync(join(repo,'agents','hermes','dev','role.yaml'),'agent_id: demo-dev\nprofile: demo-dev\nrole: dev\n');
    const audit=spawnSync(process.execPath,[join(process.cwd(),'packages/flume-hr/dist/index.js'),'audit',repo,'--rules','hermes.role-declaration','--json'],{encoding:'utf8',timeout:10000,env:{...process.env,PJ_SKILLS_REGISTRY_ROOT:skillex,HOME:home,HERMES_FLEET_HOME:fleet,HERMES_AGENTS_REGISTRY:registry,HERMES_ORG_PATH:org,FLUME_ROLES_ROOT:rolesRoot,FLUME_GATEWAY_CATALOG:options.catalogPath}});
    assert.ok(audit.stdout.trim(),`audit status=${audit.status} error=${audit.error} stderr=${audit.stderr}`);
    const report=JSON.parse(audit.stdout);
    const finding=report.rules.find(x=>x.id==='hermes.role-declaration');
    assert.equal(finding.status,'fail');assert.ok(finding.details.some(x=>x.includes(needle)),JSON.stringify(finding));
    console.log(`PASS AC-3 flume audit ${label}: ${finding.details.join('; ')}`);
  }
  const inherited={role:'dev',skills:{packs:['dev']},department:'engineering'};
  const secondDesk=join(fleet,'profiles','second-dev');mkdirSync(secondDesk,{recursive:true});
  await api.projectRoleDeclaration(inherited,'second-dev','second-dev',{...options,deskPath:secondDesk});
  const inheritedCfg=YAML.parse(readFileSync(join(secondDesk,'config.yaml'),'utf8'));
  assert.deepEqual([inheritedCfg.model.default,...inheritedCfg.fallback_providers.map(x=>x.model)],[base.model.default,...base.fallback_providers.map(x=>x.model)]);
  assert.equal(YAML.parse(readFileSync(registry,'utf8')).agents['second-dev'].reports_to,'boss');
  writeFileSync(join(secondDesk,'config.delta.yaml'),'model: {provider: openai-codex, default: explicit-override}\nfallback_providers:\n  - {provider: openai-codex, model: explicit-fallback}\n');
  for(let i=0;i<2;i++) {
    const inheritedOverride=await api.projectRoleDeclaration(inherited,'second-dev','second-dev',{...options,deskPath:secondDesk});
    assert.deepEqual(inheritedOverride.overrides.sort(),['fallback_providers','model.default','model.provider']);
    const configured=YAML.parse(readFileSync(join(secondDesk,'config.yaml'),'utf8'));
    assert.deepEqual(configured.model,{provider:'openai-codex',default:'explicit-override'});
    assert.deepEqual(configured.fallback_providers,[{provider:'openai-codex',model:'explicit-fallback'}]);
  }
  const override=await api.projectRoleDeclaration(role,'second-dev','second-dev',{...options,deskPath:secondDesk});
  assert.ok(override.overrides.includes('model.default'));
  assert.ok(override.overrides.includes('fallback_providers'));
  assert.equal(YAML.parse(readFileSync(join(secondDesk,'config.yaml'),'utf8')).model.default,'explicit-override');
  assert.equal(override.fallback_surface,'desk-gateway');
  console.log('PASS AC-4 runtime fleet inheritance, manager default and reported explicit override with and without chain');
  const rolesRoot=join(work,'declarations');
  writeFileSync(join(rolesRoot,'roles','dev.md'),'---\n'+YAML.stringify(inherited)+'---\nfixture\n');
  const repo=join(work,'repo');
  const bin=join(work,'bin');mkdirSync(bin,{recursive:true});
  const gatewayStub=join(bin,'gateway-tokens.py');
  writeFileSync(gatewayStub,'#!/usr/bin/env python3\nimport sys\nassert sys.argv[1:8] == ["mint", "hermes-demo-dev", "--preset", "owner-no-anthropic", "--group", "aai-personal", "--days"]\nprint("hermes-demo-dev: existing token; op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/hermes-demo-dev")\n',{mode:0o755});
  writeFileSync(join(bin,'op'),`#!${process.execPath}\nif(process.argv[2]!=='read'||process.argv[3]!=='op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/hermes-demo-dev')process.exit(1);process.stdout.write('private-fixture-readback-value-long-enough');\n`,{mode:0o755});
  const cliEnv={...process.env,HOME:home,PATH:`${bin}:${process.env.PATH}`,OP_SERVICE_ACCOUNT_TOKEN:'',FLUME_GATEWAY_TOKENS_BIN:gatewayStub,HERMES_FLEET_HOME:fleet,HERMES_AGENTS_REGISTRY:registry,HERMES_ORG_PATH:org,FLUME_ROLES_ROOT:rolesRoot,FLUME_GATEWAY_CATALOG:options.catalogPath,PJ_SKILLS_REGISTRY_ROOT:skillex};
  const beforeOrg=readFileSync(org,'utf8');
  let firstOnboardCfg;
  for(let i=0;i<2;i++) {
    const onboard=spawnSync(process.execPath,[join(process.cwd(),'packages/flume-hr/dist/index.js'),'onboard','dev','--target-repo','demo','--skip-telegram','--skip-plane','--local'],{cwd:repo,env:cliEnv,encoding:'utf8',timeout:20000});
    assert.equal(onboard.status,0,`${onboard.stdout}\n${onboard.stderr}`);
    const configured=readFileSync(join(desk,'config.yaml'),'utf8');
    if(i===0) firstOnboardCfg=configured;
    else assert.equal(configured,firstOnboardCfg,'repeat onboard must preserve the credential projection');
  }
  assert.equal(readFileSync(org,'utf8'),beforeOrg);
  assert.equal(YAML.parse(firstOnboardCfg).secrets.onepassword.env.AUTOMATICAI_GATEWAY_KEY,'op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/hermes-demo-dev');
  assert.deepEqual(readdirSync(join(desk,'skills')).filter(n=>!n.startsWith('.')).sort(),['build','review']);
  console.log('PASS AC-2 caller: flume onboard twice leaves projections and comments unchanged');
  // The public onboard path must report an operator's override even when the role has no chain.
  writeFileSync(join(desk,'config.delta.yaml'),'model: {provider: openai-codex, default: explicit-override}\nfallback_providers:\n  - {provider: openai-codex, model: explicit-fallback}\n');
  for(let i=0;i<2;i++) {
    const onboard=spawnSync(process.execPath,[join(process.cwd(),'packages/flume-hr/dist/index.js'),'onboard','dev','--target-repo','demo','--skip-telegram','--skip-plane','--local'],{cwd:repo,env:cliEnv,encoding:'utf8',timeout:20000});
    assert.equal(onboard.status,0,`${onboard.stdout}\n${onboard.stderr}`);
    const reported=onboard.stdout.match(/Role declaration projected: (\{[^\n]+\})/);
    assert.ok(reported,`missing public override report: ${onboard.stdout}`);
    assert.deepEqual(JSON.parse(reported[1]).overrides.sort(),['fallback_providers','model.default','model.provider']);
    const after=YAML.parse(readFileSync(join(desk,'config.yaml'),'utf8'));
    assert.deepEqual(after.model,{provider:'openai-codex',default:'explicit-override'});
    assert.deepEqual(after.fallback_providers,[{provider:'openai-codex',model:'explicit-fallback'}]);
  }
  console.log('PASS AC-4 caller: flume onboard reports and preserves primary/fallback overrides for chain-omitting role twice');
  // The actual fleet exposes a symlinked org file and the CEO is not a registry row.
  const chartTarget=join(fleet,'tracked-org.yaml');
  writeFileSync(chartTarget,'# link target comment\nceo: {id: ceo}\ndepartments:\n  - id: launch # placement comment\n    members: []\n');
  rmSync(org);symlinkSync(chartTarget,org);
  const ceoRole={role:'dev',department:'launch',reports_to:'ceo',board_scope:'advisory'};
  const ceoDesk=join(fleet,'profiles','ceo-dev');mkdirSync(ceoDesk,{recursive:true});
  assert.deepEqual(api.declarationProblems(ceoRole,'ceo-dev',options),[]);
  const preview=await api.projectRoleDeclaration(ceoRole,'ceo-dev','ceo-dev',{...options,deskPath:ceoDesk,dryRun:true});
  assert.equal(preview.reports_to,'ceo');
  assert.deepEqual(YAML.parse(readFileSync(chartTarget,'utf8')).departments[0].members,[]);
  await api.projectRoleDeclaration(ceoRole,'ceo-dev','ceo-dev',{...options,deskPath:ceoDesk});
  const linked=readFileSync(chartTarget,'utf8');
  assert.equal(realpathSync(org),chartTarget);assert.match(linked,/# link target comment/);assert.match(linked,/# placement comment/);
  assert.deepEqual(YAML.parse(linked).departments[0].members,['ceo-dev']);
  assert.equal(YAML.parse(readFileSync(registry,'utf8')).agents['ceo-dev'].reports_to,'ceo');
  await api.projectRoleDeclaration(ceoRole,'ceo-dev','ceo-dev',{...options,deskPath:ceoDesk});
  assert.equal(readFileSync(chartTarget,'utf8'),linked,'second apply preserves link target and comments');
  console.log('PASS CEO report + symlink org: preview is read-only, apply converges and keeps comments');
} finally {rmSync(work,{recursive:true,force:true});}
