// FLUME-32: a role's skills loadout is delivered as a Skillex SELECTION, and a strict
// (Skillex-only) desk accepts it. Everything here runs against a scratch fleet, a scratch
// Skillex catalog and the real Skillex CLI/library; no live desk is read or written.
import assert from 'node:assert/strict';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
import {build} from 'esbuild';
import {addSetSkills,createPack,createSet,addPackSkills} from '@delorenj/skillex';

const root=process.cwd();
const bundle=join(root,'tests',`.role-selection-${process.pid}.mjs`);
await build({entryPoints:['packages/flume-hr/src/index.ts'],outfile:bundle,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
const api=await import(pathToFileURL(bundle).href);
rmSync(bundle);
const skillexCli=join(root,'node_modules','@delorenj','skillex','dist','cli.js');
const flumeCli=join(root,'packages','flume-hr','dist','index.js');
const renderer=join(root,'templates','hermes-agent','scripts','hermes-profile-config.py');
const work=mkdtempSync(join(tmpdir(),'flume32-selection-'));
let count=0;
const pass=label=>{count++;console.log(`PASS ${label}`);};
const names=dir=>readdirSync(dir).filter(n=>!n.startsWith('.')).sort();

async function fleet(label,{externalDirs=true}={}) {
  const dir=join(work,label), home=join(dir,'home'), hermes=join(home,'.hermes'), skillex=join(dir,'skillex');
  mkdirSync(hermes,{recursive:true});
  for(const name of ['build','review','deploy','lint']) {
    mkdirSync(join(skillex,'all-skills',name),{recursive:true});
    writeFileSync(join(skillex,'all-skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: fixture ${name}\n---\n`);
  }
  const reg={registryRoot:skillex,home,stateHome:join(home,'.local','state')};
  for(const [set,members] of [['dev-set',['build','review']],['ops-set',['deploy','lint']]]) {
    assert.ok((await createSet(set,reg)).ok);assert.ok((await addSetSkills(set,members,reg)).ok);
  }
  for(const [pack,version,members] of [['dev','1.0.0',['build','review']],['ops','2.1.0',['deploy','lint']]]) {
    assert.ok((await createPack(pack,version,reg)).ok);assert.ok((await addPackSkills(`${pack}@${version}`,members,reg)).ok);
  }
  // A realistic fleet base: it lists external skill roots, which a strict desk must override with [].
  writeFileSync(join(hermes,'config.yaml'),YAML.stringify({model:{provider:'automaticai',default:'fleet/primary'},fallback_providers:[{provider:'automaticai',model:'fleet/fallback'}],providers:{},...(externalDirs?{skills:{external_dirs:[join(home,'.agents','skills'),join(home,'.agents','archive')]}}:{})}));
  const registry=join(hermes,'agents-registry.yaml'), org=join(hermes,'org.yaml');
  writeFileSync(registry,'agents:\n  boss: {role: director, department: engineering}\n  unrelated: {role: reporter, department: editorial}\n');
  writeFileSync(org,'# precious top comment\ncompany: {name: Fixture}\ndepartments:\n  - id: engineering # department comment\n    manager: boss\n    members: []\n  - id: editorial\n    members: [unrelated]\n');
  const stateHome=join(home,'.local','state');
  const env={...process.env,HOME:home,XDG_STATE_HOME:stateHome,HERMES_FLEET_HOME:hermes,HERMES_AGENTS_REGISTRY:registry,HERMES_ORG_PATH:org,PJ_SKILLS_REGISTRY_ROOT:skillex,FLUME_GATEWAY_CATALOG:join(dir,'routes.json')};
  const options=desk=>({home,fleetRoot:hermes,registryPath:registry,orgPath:org,skillexRoot:skillex,deskPath:desk,stateHome,renderer});
  const deskOf=profile=>join(hermes,'profiles',profile);
  const skillexCmd=(...args)=>{
    const run=spawnSync(process.execPath,[skillexCli,...args,'--registry-root',skillex,'--json'],{encoding:'utf8',env,timeout:30000});
    let report=null;try{report=JSON.parse(run.stdout);}catch{}
    return {status:run.status,report,stderr:run.stderr};
  };
  const show=(profile,project)=>skillexCmd('profile','show',profile,'--hermes-root',hermes,...(project?['--project',project]:[]));
  return {dir,home,hermes,skillex,registry,org,stateHome,env,options,deskOf,skillexCmd,show,reg};
}
const project=desk=>join(desk,'.skillex-selection');
const manifestOf=desk=>JSON.parse(readFileSync(join(project(desk),'.agents','skills.json'),'utf8'));
const roleOf=(skills,extra={})=>({role:'dev',skills,department:'engineering',reports_to:'boss',...extra});

try {
  // ---- 1. a set loadout becomes exactly one Skillex selection; the strict desk accepts it ----
  const f=await fleet('set');
  const desk=f.deskOf('demo-dev');
  const first=await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',f.options(desk));
  assert.deepEqual(manifestOf(desk),{inherit_global:false,sets:['dev-set']});
  assert.equal(first.selection.project,project(desk));
  assert.deepEqual(first.skills.map(s=>s.name),['build','review']);
  assert.deepEqual(names(join(desk,'skills')),['build','review']);
  for(const name of ['build','review']) {
    assert.ok(lstatSync(join(desk,'skills',name)).isSymbolicLink(),`${name} is a symlink, never a copied payload`);
    assert.equal(realpathSync(join(desk,'skills',name)),join(f.skillex,'all-skills',name));
  }
  for(const marker of ['.skillex-only','.no-bundled-skills']) assert.ok(lstatSync(join(desk,marker)).isFile(),`${marker} is a regular file`);
  assert.equal(existsSync(join(desk,'.agents')),false,'no <desk>/.agents second skill core');
  assert.equal(existsSync(join(desk,'contract.yaml')),false,'no named-agent contract file in a Hermes desk');
  const delta=YAML.parse(readFileSync(join(desk,'config.delta.yaml'),'utf8'));
  assert.deepEqual(delta.skills,{external_dirs:[]},'the delta pins strict discovery');
  assert.equal(JSON.stringify(delta).includes('list_patches'),false,'no list patch may add a discovery root');
  assert.deepEqual(YAML.parse(readFileSync(join(desk,'config.yaml'),'utf8')).skills.external_dirs,[],'the generated config lists no external roots despite the fleet base listing two');
  pass('role set loadout -> Skillex selection manifest + strict symlink projection, no .agents/, external_dirs pinned []');

  // Skillex itself is the judge: the real CLI accepts the strict desk, with the project named or recorded.
  const named=f.show('demo-dev',project(desk));
  assert.equal(named.status,0,JSON.stringify(named.report?.findings));
  assert.deepEqual(named.report.data.managed.map(m=>m.name).sort(),['build','review']);
  assert.ok(named.report.data.managed.every(m=>m.state==='unchanged'));
  assert.deepEqual(named.report.data.changes,[]);
  const recorded=f.show('demo-dev');
  assert.equal(recorded.status,0,JSON.stringify(recorded.report?.findings));
  assert.equal(realpathSync(recorded.report.data.project),realpathSync(project(desk)),'the receipt records the role selection as the desk project');
  pass('skillex profile show exits 0 (explicit project and recorded project)');

  // ---- 2. convergence: projecting again changes nothing ----
  const snapshot=()=>({manifest:readFileSync(join(project(desk),'.agents','skills.json'),'utf8'),receipt:readFileSync(named.report.data.receiptPath,'utf8'),
    links:Object.fromEntries(['build','review'].map(n=>[n,lstatSync(join(desk,'skills',n)).ino])),delta:readFileSync(join(desk,'config.delta.yaml'),'utf8'),config:readFileSync(join(desk,'config.yaml'),'utf8')});
  const before=snapshot();
  for(let i=0;i<2;i++) await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',f.options(desk));
  assert.deepEqual(snapshot(),before,'manifest, receipt, links, delta and config are unchanged by re-projection');
  const noop=f.skillexCmd('profile','sync','demo-dev','--hermes-root',f.hermes,'--project',project(desk),'--skillex-only','--dry-run');
  assert.equal(noop.status,0);assert.deepEqual(noop.report.data.changes,[]);
  assert.equal(f.show('demo-dev',project(desk)).status,0);
  const dry=await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',{...f.options(desk),dryRun:true});
  assert.equal(dry.selection.manifestChange,'none');assert.deepEqual(dry.selection.changes,[]);
  pass('re-projection converges: byte-identical state, a no-op Skillex preview, a no-op dry run');

  // ---- 3. pack loadouts (exclusive complete loadout) ----
  const g=await fleet('pack');
  const packDesk=g.deskOf('pack-dev'), versioned=g.deskOf('pack-ops');
  await api.projectRoleDeclaration(roleOf({pack:'dev'}),'pack-dev','pack-dev',g.options(packDesk));
  assert.deepEqual(manifestOf(packDesk),{inherit_global:false,packs:['dev']});
  assert.deepEqual(names(join(packDesk,'skills')),['build','review']);
  assert.equal(g.show('pack-dev',project(packDesk)).status,0);
  await api.projectRoleDeclaration(roleOf({packs:['ops@2.1.0']}),'pack-ops','pack-ops',g.options(versioned));
  assert.deepEqual(manifestOf(versioned),{inherit_global:false,packs:['ops@2.1.0']});
  assert.deepEqual(names(join(versioned,'skills')),['deploy','lint']);
  assert.equal(g.show('pack-ops',project(versioned)).status,0);
  pass('role pack / versioned pack loadouts -> packs[] selection, accepted by skillex profile show');

  // ---- 4. the loadout changes: Skillex prunes what left and links what arrived ----
  await api.projectRoleDeclaration(roleOf({set:'ops-set'}),'demo-dev','demo-dev',f.options(desk));
  assert.deepEqual(manifestOf(desk),{inherit_global:false,sets:['ops-set']});
  assert.deepEqual(names(join(desk,'skills')),['deploy','lint']);
  assert.equal(f.show('demo-dev',project(desk)).status,0);
  await api.projectRoleDeclaration(roleOf({pack:'dev'}),'demo-dev','demo-dev',f.options(desk));
  assert.deepEqual(manifestOf(desk),{inherit_global:false,packs:['dev']});
  assert.deepEqual(names(join(desk,'skills')),['build','review']);
  assert.equal(f.show('demo-dev',project(desk)).status,0);
  // a member added to the set later flows through the same selection, no re-declaration needed
  await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',f.options(desk));
  assert.ok((await addSetSkills('dev-set',['lint'],f.reg)).ok);
  assert.ok((await api.auditRoleSkills('demo-dev',desk,roleOf({set:'dev-set'}),f.options(desk))).some(x=>/profile skills create/.test(x)),'audit sees the pending catalog change');
  await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',f.options(desk));
  assert.deepEqual(names(join(desk,'skills')),['build','lint','review']);
  assert.deepEqual(await api.auditRoleSkills('demo-dev',desk,roleOf({set:'dev-set'}),f.options(desk)),[]);
  pass('changed declaration and changed set membership converge through Skillex');

  // ---- 5. declarations Skillex cannot express as ONE selection are refused by name ----
  const h=await fleet('refused');
  const hdesk=h.deskOf('demo-dev');
  assert.deepEqual(api.roleSelectionManifest({pack:'dev',packs:['dev']}),{inherit_global:false,packs:['dev']},'the same pack named twice is one pack');
  for(const [label,skills,needle] of [
    ['two packs',{packs:['dev','ops']},/2 packs \(dev, ops\).*exclusive complete loadout/],
    ['pack + set',{pack:'dev',set:'dev-set'},/pack dev and set dev-set.*exclusive complete loadout/],
  ]) {
    const problems=api.declarationProblems(roleOf(skills),'demo-dev',h.options(hdesk));
    assert.ok(problems.some(x=>needle.test(x)),`${label}: ${problems}`);
    await assert.rejects(api.projectRoleDeclaration(roleOf(skills),'demo-dev','demo-dev',h.options(hdesk)),needle);
    assert.equal(existsSync(hdesk),false,`${label}: a refused declaration writes nothing`);
  }
  await assert.rejects(api.projectRoleDeclaration(roleOf({set:'no-such-set'}),'demo-dev','demo-dev',h.options(hdesk)),/no-such-set/);
  assert.equal(existsSync(hdesk),false);
  pass('inexpressible and unresolvable loadouts are refused by name before anything is written');

  // ---- 6. a strict desk never adopts or deletes foreign content ----
  const k=await fleet('foreign');
  const kdesk=k.deskOf('demo-dev');
  mkdirSync(join(kdesk,'skills','local-note'),{recursive:true});writeFileSync(join(kdesk,'skills','local-note','SKILL.md'),'---\nname: local-note\ndescription: mine\n---\n');
  await assert.rejects(api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',k.options(kdesk)),/not Skillex-only and holds local skills \(local-note\).*nothing was changed/);
  assert.ok(existsSync(join(kdesk,'skills','local-note','SKILL.md')),'foreign local content is preserved');
  assert.equal(existsSync(join(kdesk,'skills','build')),false,'nothing was projected over a refused desk');
  for(const untouched of ['config.delta.yaml','config.yaml','.skillex-only','.skillex-selection']) assert.equal(existsSync(join(kdesk,untouched)),false,`a refused legacy desk is not half converted: ${untouched}`);
  await assert.rejects(api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',{...k.options(kdesk),dryRun:true}),/not Skillex-only and holds local skills/,'a dry run reports the refusal a real run would hit');
  // the same refusal holds when a strict desk is already marked: Skillex itself refuses the unowned entry
  writeFileSync(join(kdesk,'.skillex-only'),'x\n');writeFileSync(join(kdesk,'.no-bundled-skills'),'x\n');
  await assert.rejects(api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',k.options(kdesk)),/Skillex refused the role selection.*local-note/);
  assert.ok(existsSync(join(kdesk,'skills','local-note','SKILL.md')),'foreign local content survives a strict refusal too');
  pass('a desk with foreign local skills is refused before any change, and a strict desk refuses them too');

  // ---- 6b. a desk Skillex already synced (not yet strict) becomes strict with the role selection ----
  const u=await fleet('ordinary');
  const udesk=u.deskOf('demo-dev'), uproject=join(u.dir,'owning-repo');
  mkdirSync(join(uproject,'.agents'),{recursive:true});writeFileSync(join(uproject,'.agents','skills.json'),JSON.stringify({inherit_global:true,sets:['ops-set']}));
  mkdirSync(udesk,{recursive:true});
  assert.equal(u.skillexCmd('profile','sync','demo-dev','--hermes-root',u.hermes,'--project',uproject).status,0);
  assert.deepEqual(names(join(udesk,'skills')),['deploy','lint']);assert.equal(existsSync(join(udesk,'.skillex-only')),false);
  await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',u.options(udesk));
  assert.deepEqual(names(join(udesk,'skills')),['build','review']);
  assert.ok(lstatSync(join(udesk,'.skillex-only')).isFile());
  assert.equal(u.show('demo-dev',project(udesk)).status,0);
  pass('an ordinary Skillex-synced desk becomes strict, carrying exactly the role selection');

  // ---- 6c. Hermes' own bookkeeping inside a strict skills root is tolerated and preserved ----
  const b=await fleet('bookkeeping');
  const bdesk=b.deskOf('demo-dev');
  await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',b.options(bdesk));
  const bookkeeping=['.usage.json','.usage.json.lock','.curator_state','.curator_suppressed','.sync_state'];
  for(const file of bookkeeping) writeFileSync(join(bdesk,'skills',file),'{}\n');
  mkdirSync(join(bdesk,'skills','.curator_backups'),{recursive:true});writeFileSync(join(bdesk,'skills','.curator_backups','before.tar.gz'),'x');
  await api.projectRoleDeclaration(roleOf({set:'ops-set'}),'demo-dev','demo-dev',b.options(bdesk));
  assert.deepEqual(names(join(bdesk,'skills')),['deploy','lint']);
  for(const file of [...bookkeeping,'.curator_backups']) assert.ok(existsSync(join(bdesk,'skills',file)),`${file} is Hermes bookkeeping and survives a loadout change`);
  assert.equal(b.show('demo-dev',project(bdesk)).status,0);
  assert.deepEqual(await api.auditRoleSkills('demo-dev',bdesk,roleOf({set:'ops-set'}),b.options(bdesk)),[]);
  pass('Hermes bookkeeping files in a strict skills root are tolerated, preserved and never mistaken for skills');

  // ---- 7. legacy flume projection: the list patch is removed, the leftover directory is reported ----
  const l=await fleet('legacy');
  const ldesk=l.deskOf('demo-dev');
  mkdirSync(join(ldesk,'.agents','skills'),{recursive:true});symlinkSync(join(l.skillex,'all-skills','build'),join(ldesk,'.agents','skills','build'));
  writeFileSync(join(ldesk,'config.delta.yaml'),YAML.stringify({'x-pjangler-merge':{list_patches:{'skills.external_dirs':{add:[join(ldesk,'.agents','skills')]},'plugins.enabled':{add:['tts/vox']}}}}));
  await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',l.options(ldesk));
  const ldelta=YAML.parse(readFileSync(join(ldesk,'config.delta.yaml'),'utf8'));
  assert.deepEqual(Object.keys(ldelta['x-pjangler-merge'].list_patches),['plugins.enabled'],'only the legacy flume patch is removed; a person-authored list patch survives');
  assert.deepEqual(ldelta.skills,{external_dirs:[]});
  assert.deepEqual(YAML.parse(readFileSync(join(ldesk,'config.yaml'),'utf8')).skills.external_dirs,[]);
  assert.equal(l.show('demo-dev',project(ldesk)).status,0);
  const legacy=await api.auditRoleSkills('demo-dev',ldesk,roleOf({set:'dev-set'}),l.options(ldesk));
  assert.ok(legacy.some(x=>/legacy role skill projection/.test(x)),`${legacy}`);
  rmSync(join(ldesk,'.agents'),{recursive:true});
  assert.deepEqual(await api.auditRoleSkills('demo-dev',ldesk,roleOf({set:'dev-set'}),l.options(ldesk)),[]);
  pass('a legacy list patch is removed, a hand-written one survives, the legacy .agents/skills directory is flagged');

  // ---- 8. the audit names every kind of drift between declaration and desk ----
  const m=await fleet('drift');
  const mdesk=m.deskOf('demo-dev'), mrole=roleOf({set:'dev-set'});
  await api.projectRoleDeclaration(mrole,'demo-dev','demo-dev',m.options(mdesk));
  assert.deepEqual(await api.auditRoleSkills('demo-dev',mdesk,mrole,m.options(mdesk)),[]);
  const manifestPath=join(project(mdesk),'.agents','skills.json'), original=readFileSync(manifestPath,'utf8');
  writeFileSync(manifestPath,JSON.stringify({inherit_global:false,sets:['ops-set']}));
  assert.ok((await api.auditRoleSkills('demo-dev',mdesk,mrole,m.options(mdesk))).some(x=>/differs from the declaration/.test(x)));
  rmSync(manifestPath);
  assert.ok((await api.auditRoleSkills('demo-dev',mdesk,mrole,m.options(mdesk))).some(x=>/manifest missing/.test(x)));
  writeFileSync(manifestPath,original);
  rmSync(join(mdesk,'.skillex-only'));
  assert.ok((await api.auditRoleSkills('demo-dev',mdesk,mrole,m.options(mdesk))).some(x=>/not Skillex-only/.test(x)));
  await api.projectRoleDeclaration(mrole,'demo-dev','demo-dev',m.options(mdesk));
  assert.deepEqual(await api.auditRoleSkills('demo-dev',mdesk,mrole,m.options(mdesk)),[],'re-projection repairs every drift');
  assert.ok(lstatSync(join(mdesk,'.skillex-only')).isFile(),'the strict marker is republished');
  assert.ok((await api.auditRoleSkills('demo-dev',join(m.hermes,'profiles','absent'),mrole,m.options(mdesk))).some(x=>/desk missing/.test(x)));
  pass('audit names a changed, missing and non-strict desk and re-projection repairs each');

  // ---- 9. a role without a loadout never touches skills ----
  const n=await fleet('plain');
  const ndesk=n.deskOf('demo-dev');
  mkdirSync(ndesk,{recursive:true});
  await api.projectRoleDeclaration({role:'dev',department:'engineering',reports_to:'boss'},'demo-dev','demo-dev',n.options(ndesk));
  assert.equal(existsSync(project(ndesk)),false);assert.equal(existsSync(join(ndesk,'skills')),false);assert.equal(existsSync(join(ndesk,'.skillex-only')),false);
  assert.equal(YAML.parse(readFileSync(join(ndesk,'config.delta.yaml'),'utf8'))?.skills,undefined,'no skills pin without a loadout');
  pass('a role with no loadout leaves skills, selection and discovery alone');

  // ---- 10. the flume audit CLI, end to end ----
  const a=await fleet('audit');
  const adesk=a.deskOf('demo-dev'), arole=roleOf({set:'dev-set'});
  const rolesRoot=join(a.dir,'declarations'), repo=join(a.dir,'repo');
  mkdirSync(join(rolesRoot,'roles'),{recursive:true});mkdirSync(join(repo,'agents','hermes','dev'),{recursive:true});
  writeFileSync(join(repo,'agents','hermes','dev','role.yaml'),'agent_id: demo-dev\nprofile: demo-dev\nrole: dev\n');
  const declare=skills=>writeFileSync(join(rolesRoot,'roles','dev.md'),'---\n'+YAML.stringify(roleOf(skills))+'---\nfixture\n');
  const audit=rule=>{
    const run=spawnSync(process.execPath,[flumeCli,'audit',repo,'--rules',rule,'--json'],{encoding:'utf8',timeout:30000,env:{...a.env,FLUME_ROLES_ROOT:rolesRoot}});
    assert.ok(run.stdout.trim(),`audit ${rule} status=${run.status} stderr=${run.stderr}`);
    return JSON.parse(run.stdout).rules.find(x=>x.id===rule);
  };
  declare({set:'dev-set'});
  await api.projectRoleDeclaration(arole,'demo-dev','demo-dev',a.options(adesk));
  // Every skills problem is attributed to the profile; the fixture desk has unrelated singleton-link gaps.
  const skillsDetail=text=>text.startsWith('demo-dev: ')&&/profile skills|loadout|Skillex-only|legacy role skill|selection manifest|desk missing/.test(text);
  let finding=audit('hermes.runtime-singleton');
  assert.equal(finding.details.filter(skillsDetail).length,0,`a converged desk has no skills problem: ${finding.details}`);
  finding=audit('hermes.role-declaration');
  assert.equal(finding.status,'pass',JSON.stringify(finding));
  finding=audit('hermes.delta-list-override');
  assert.equal(finding.status,'pass',JSON.stringify(finding));
  assert.ok((await addSetSkills('dev-set',['lint'],a.reg)).ok);
  finding=audit('hermes.runtime-singleton');
  assert.ok(finding.details.some(x=>/profile skills create/.test(x)),`pending catalog change is reported: ${finding.details}`);
  writeFileSync(join(adesk,'config.delta.yaml'),readFileSync(join(adesk,'config.delta.yaml'),'utf8').replace('external_dirs: []','external_dirs: [/somewhere/else]'));
  assert.equal(audit('hermes.delta-list-override').status,'fail');
  declare({packs:['dev','ops']});
  finding=audit('hermes.role-declaration');
  assert.equal(finding.status,'fail');assert.ok(finding.details.some(x=>/exclusive complete loadout/.test(x)),JSON.stringify(finding));
  declare({set:'no-such-set'});
  finding=audit('hermes.role-declaration');
  assert.equal(finding.status,'fail');assert.ok(finding.details.some(x=>/no-such-set/.test(x)),JSON.stringify(finding));
  pass('flume audit: green on a converged strict desk; names a pending change, a leaked discovery root, an inexpressible and an unresolvable loadout');

  // ---- 11. the real caller: `flume onboard`, twice, against a strict desk ----
  const o=await fleet('onboard');
  const orepo=join(o.dir,'demo'), odesk=o.deskOf('demo-dev'), orolesRoot=join(o.dir,'declarations');
  mkdirSync(join(orepo,'agents','hermes','dev'),{recursive:true});mkdirSync(join(orolesRoot,'roles'),{recursive:true});
  writeFileSync(join(orepo,'agents','hermes','dev','role.yaml'),'agent_id: demo-dev\nprofile: demo-dev\nrole: dev\nrepo: demo\n');
  writeFileSync(join(orolesRoot,'roles','dev.md'),'---\n'+YAML.stringify(roleOf({set:'dev-set'}))+'---\nfixture\n');
  const onboard=()=>spawnSync(process.execPath,[flumeCli,'onboard','dev','--skip-telegram','--skip-plane','--local'],{cwd:orepo,env:{...o.env,FLUME_ROLES_ROOT:orolesRoot},encoding:'utf8',timeout:60000});
  const first11=onboard();
  assert.equal(first11.status,0,`${first11.stdout}\n${first11.stderr}`);
  assert.match(first11.stdout,/Role declaration projected/);
  assert.deepEqual(names(join(odesk,'skills')),['build','review']);
  assert.equal(existsSync(join(odesk,'.agents')),false);
  const shown=o.show('demo-dev');
  assert.equal(shown.status,0,JSON.stringify(shown.report?.findings));
  const state11=()=>({org:readFileSync(o.org,'utf8'),registry:readFileSync(o.registry,'utf8'),config:readFileSync(join(odesk,'config.yaml'),'utf8'),delta:readFileSync(join(odesk,'config.delta.yaml'),'utf8'),
    manifest:readFileSync(join(project(odesk),'.agents','skills.json'),'utf8'),receipt:readFileSync(shown.report.data.receiptPath,'utf8'),
    links:Object.fromEntries(['build','review'].map(n=>[n,lstatSync(join(odesk,'skills',n)).ino]))});
  const before11=state11();
  const second11=onboard();
  assert.equal(second11.status,0,`${second11.stdout}\n${second11.stderr}`);
  assert.deepEqual(state11(),before11,'a second flume onboard leaves org, registry, config, selection, receipt and links unchanged');
  assert.equal(o.show('demo-dev').status,0);
  const onboardAudit=spawnSync(process.execPath,[flumeCli,'audit',orepo,'--rules','hermes.runtime-singleton','--json'],{encoding:'utf8',timeout:30000,env:{...o.env,FLUME_ROLES_ROOT:orolesRoot}});
  const singleton=JSON.parse(onboardAudit.stdout).rules.find(x=>x.id==='hermes.runtime-singleton');
  assert.equal(singleton.details.filter(x=>x.startsWith('demo-dev: ')).length,0,`${singleton.details}`);
  pass('flume onboard twice: strict desk accepted by skillex, state byte-identical, audit has no skills finding');

  // ---- 12. a desk the template first synced against its repo is re-pointed at the role selection ----
  const t=await fleet('repo-first');
  const tdesk=t.deskOf('demo-dev'), repoProject=join(t.dir,'owning-repo');
  mkdirSync(join(repoProject,'.agents'),{recursive:true});writeFileSync(join(repoProject,'.agents','skills.json'),JSON.stringify({inherit_global:true,sets:['ops-set']}));
  mkdirSync(tdesk,{recursive:true});writeFileSync(join(tdesk,'config.delta.yaml'),YAML.stringify({skills:{external_dirs:[]}}));
  const stepTen=()=>t.skillexCmd('profile','sync','demo-dev','--hermes-root',t.hermes,'--project',repoProject,'--skillex-only');
  assert.equal(stepTen().status,0);
  assert.deepEqual(names(join(tdesk,'skills')),['deploy','lint'],'the repo selection is what step 10 projects');
  await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',t.options(tdesk));
  assert.deepEqual(names(join(tdesk,'skills')),['build','review'],'the role selection replaces the repo selection');
  assert.equal(t.show('demo-dev',project(tdesk)).status,0);
  assert.equal(realpathSync(t.show('demo-dev').report.data.project),realpathSync(project(tdesk)),'the receipt now records the role selection');
  // Any writer that syncs the desk against another project overrides the role; the audit catches it and onboarding repairs it.
  assert.equal(stepTen().status,0);
  assert.deepEqual(names(join(tdesk,'skills')),['deploy','lint']);
  const overridden=await api.auditRoleSkills('demo-dev',tdesk,roleOf({set:'dev-set'}),t.options(tdesk));
  assert.ok(overridden.some(x=>/profile skills/.test(x)),`${overridden}`);
  await api.projectRoleDeclaration(roleOf({set:'dev-set'}),'demo-dev','demo-dev',t.options(tdesk));
  assert.deepEqual(await api.auditRoleSkills('demo-dev',tdesk,roleOf({set:'dev-set'}),t.options(tdesk)),[]);
  assert.deepEqual(names(join(tdesk,'skills')),['build','review']);
  pass('a repo-synced strict desk is re-pointed at the role selection; a later repo sync is detected and repaired');

  console.log(`\n${count} role-selection check groups passed`);
} finally {rmSync(work,{recursive:true,force:true});}
