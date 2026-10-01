import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
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
  const base=YAML.parse(readFileSync('/home/delorenj/.hermes/config.yaml','utf8'));
  const chain=[base.model.default,...base.fallback_providers.map(x=>x.model)];
  writeFileSync(join(fleet,'config.yaml'),YAML.stringify({model:base.model,fallback_providers:base.fallback_providers,providers:base.providers}));
  writeFileSync(registry,'agents:\n  boss: {role: director, department: engineering}\n  unrelated: {role: reporter, department: editorial}\n');
  const original='# precious top comment\ncompany: {name: Fixture}\ndepartments:\n  - id: engineering # department comment\n    manager: boss\n    members: []\n  - id: editorial\n    members: [unrelated] # precious other employee\n';
  writeFileSync(org,original);
  const role={role:'dev',skills:{pack:'dev'},chain,department:'engineering',reports_to:'boss'};
  const options={home,fleetRoot:fleet,registryPath:registry,orgPath:org,skillexRoot:skillex,deskPath:desk,catalogModels:chain,catalogPath:'/home/delorenj/docker/stacks/ai/newapi/ops/routes.json',renderer:join(process.cwd(),'templates/hermes-agent/scripts/hermes-profile-config.py')};
  await api.projectRoleDeclaration(role,'demo-dev','demo-dev',options);
  assert.deepEqual(readdirSync(join(desk,'.agents','skills')).sort(),['build','review']);
  for(const name of ['build','review']) assert.equal(realpathSync(join(desk,'.agents','skills',name)),join(skillex,'all-skills',name));
  const cfg=YAML.parse(readFileSync(join(desk,'config.yaml'),'utf8'));
  assert.deepEqual([cfg.model.default,...cfg.fallback_providers.map(x=>x.model)],chain);
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
    console.log(`PASS AC-3 ${label}: ${findings.join('; ')}`);
  }
  const inherited={role:'dev',skills:{packs:['dev']},department:'engineering'};
  const secondDesk=join(fleet,'profiles','second-dev');mkdirSync(secondDesk,{recursive:true});
  await api.projectRoleDeclaration(inherited,'second-dev','second-dev',{...options,deskPath:secondDesk});
  const inheritedCfg=YAML.parse(readFileSync(join(secondDesk,'config.yaml'),'utf8'));
  assert.deepEqual([inheritedCfg.model.default,...inheritedCfg.fallback_providers.map(x=>x.model)],chain);
  assert.equal(YAML.parse(readFileSync(registry,'utf8')).agents['second-dev'].reports_to,'boss');
  writeFileSync(join(secondDesk,'config.delta.yaml'),'model: {provider: openai-codex, default: explicit-override}\n');
  const override=await api.projectRoleDeclaration(role,'second-dev','second-dev',{...options,deskPath:secondDesk});
  assert.ok(override.overrides.includes('model.default'));
  assert.equal(YAML.parse(readFileSync(join(secondDesk,'config.yaml'),'utf8')).model.default,'explicit-override');
  assert.equal(override.fallback_surface,'desk-gateway');
  console.log('PASS AC-4 runtime fleet inheritance, manager default and reported explicit override');
} finally {rmSync(work,{recursive:true,force:true});}
