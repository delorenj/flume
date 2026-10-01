import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import * as api from '../packages/flume-hr/dist/index.js';
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
  const options={home,fleetRoot:fleet,registryPath:registry,orgPath:org,skillexRoot:skillex,deskPath:desk,catalogPath:'/home/delorenj/docker/stacks/ai/newapi/ops/routes.json',renderer:join(process.cwd(),'templates/hermes-agent/scripts/hermes-profile-config.py')};
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
} finally {rmSync(work,{recursive:true,force:true});}
