import {existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync} from "node:fs";
import {join, dirname, resolve} from "node:path";
import {homedir} from "node:os";
import {spawn,spawnSync} from "node:child_process";
import YAML from "yaml";
import {resolveFlumeRoot} from "../kernel/paths";
import {validateRoleDeclaration, type RoleDeclaration} from "./validator";
import {applyRoleSelection, auditRoleSelection, planRoleSelection, preflightRoleSelection, previewRoleSelection, resolveRoleLoadout, roleSelectionManifest, type RoleSelectionPreview, type RoleSelectionResult, type SelectionContext} from "./selection";
import type {ResolvedSkill, ValidationOptions} from "./types";

export interface RoleProjectionOptions extends ValidationOptions {
  fleetRoot?: string; registryPath?: string; orgPath?: string; deskPath?: string; renderer?: string;
  catalogPath?: string; catalogModels?: string[]; dryRun?: boolean;
  /** XDG state home for Skillex's profile receipts and locks (defaults to the environment's). */
  stateHome?: string;
}
export interface RoleProjectionResult {
  department: string|undefined; reports_to: string|undefined; skills: ResolvedSkill[]; chain?: unknown; overrides: string[];
  /** The Skillex selection that carries the loadout (null for a role without one). */
  selection: RoleSelectionResult|RoleSelectionPreview|null; fallback_surface?: string;
}
function read(path:string): any {return existsSync(path) ? YAML.parse(readFileSync(path,"utf8")) ?? {} : {};}
function paths(options:RoleProjectionOptions) {
  const home=options.home ?? homedir(), fleet=options.fleetRoot ?? process.env.HERMES_FLEET_HOME ?? join(home,".hermes");
  return {home,fleet,registry:options.registryPath ?? process.env.HERMES_AGENTS_REGISTRY ?? process.env.HERMES_FLEET_REGISTRY_FILE ?? join(fleet,"agents-registry.yaml"),
    org:options.orgPath ?? process.env.HERMES_ORG_PATH ?? join(fleet,"org.yaml")};
}
function selectionContext(options:RoleProjectionOptions, p:ReturnType<typeof paths>): SelectionContext {
  return {hermesRoot:p.fleet,home:p.home,...(options.skillexRoot?{skillexRoot:options.skillexRoot}:{}),...(options.stateHome?{stateHome:options.stateHome}:{})};
}
/** Every problem between the role's skills loadout and what Skillex projects into its desk. */
export async function auditRoleSkills(profile:string, profileDir:string, declaration:RoleDeclaration, options:RoleProjectionOptions={}) {
  if(!declaration.skills) return [];
  return auditRoleSelection(profile,profileDir,declaration.skills,selectionContext(options,paths(options)));
}
/** Does the declared loadout resolve against the live Skillex catalog? Async because Skillex is. */
export async function skillsProblems(role:RoleDeclaration, employee:string, options:RoleProjectionOptions={}): Promise<string[]> {
  if(!role.skills) return [];
  try {await resolveRoleLoadout(role.skills,selectionContext(options,paths(options)));return [];}
  catch(error){return [`${employee}: skills loadout does not resolve: ${(error as Error).message}`];}
}
export function readRoleDeclaration(root:string, role:string, post="", profile=post): RoleDeclaration {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(role)) throw new Error("Unsafe role filename");
  const path=join(root,"roles",`${role}.md`);
  const fallback=join(root,"roles","_default.md");
  const raw=readFileSync(existsSync(path)?path:fallback,"utf8");
  const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)?.[1];
  if(front===undefined) throw new Error(`roles/${role}.md has no frontmatter`);
  const doc=YAML.parseDocument(front,{uniqueKeys:true});
  if(doc.errors.length) throw new Error(doc.errors[0]!.message);
  return validateRoleDeclaration({...doc.toJS(),role},post,profile);
}
export function gatewayCatalog(options:RoleProjectionOptions={}): Set<string> {
  if(options.catalogModels) return new Set(options.catalogModels);
  const {home}=paths(options);
  const path=options.catalogPath ?? process.env.FLUME_GATEWAY_CATALOG ?? join(home,"docker/stacks/ai/newapi/ops/routes.json");
  const raw=JSON.parse(readFileSync(path,"utf8"));
  return new Set((raw.routes ?? raw).map((r:any)=>typeof r==="string"?r:r.id));
}
export function declarationProblems(role:RoleDeclaration, employee:string, options:RoleProjectionOptions={}): string[] {
  const {registry,org}=paths(options), agents=read(registry).agents ?? {}, departments=read(org).departments ?? [];
  const problems:string[]=[];
  if(!role.department) problems.push(`${employee}: no department declared`);
  const department=departments.find((d:any)=>d.id===role.department);
  if(role.department && !department) problems.push(`${employee}: department ${role.department} absent from org.yaml`);
  const superior=role.reports_to ?? department?.manager;
  if(!superior) problems.push(`${employee}: reports_to absent and department ${role.department} has no manager`);
  else if(!(superior in agents)) problems.push(`${employee}: reports_to ${superior} absent from registry`);
  const edges={...Object.fromEntries(Object.entries(agents).map(([id,row])=>[id,(row as any).reports_to])),[employee]:superior};
  const seen=new Set<string>(); let cursor:string|undefined=employee;
  while(cursor) {if(seen.has(cursor)){problems.push(`${employee}: reporting cycle ${[...seen,cursor].join(" -> ")}`);break;}seen.add(cursor);cursor=edges[cursor];}
  if(role.skills) {try {roleSelectionManifest(role.skills);} catch(error){problems.push(`${employee}: ${(error as Error).message}`);}}
  if(role.chain) {
    try {const catalog=gatewayCatalog(options);for(const route of role.chain) if(!catalog.has(route)) problems.push(`${employee}: chain route ${route} absent from gateway catalog`);}
    catch(error){problems.push(`${employee}: gateway catalog unavailable: ${(error as Error).message}`);}
  }
  return problems;
}
function updateDocument(path:string, edit:(doc:ReturnType<typeof YAML.parseDocument>)=>void) {
  if(existsSync(path)&&lstatSync(path).isSymbolicLink()) throw new Error(`Refusing source symlink ${path}`);
  const before=existsSync(path)?readFileSync(path,"utf8"):"";
  const doc=YAML.parseDocument(before||"{}\n",{uniqueKeys:true});
  if(doc.errors.length) throw new Error(doc.errors[0]!.message);
  edit(doc);const after=String(doc);if(after!==before){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,after);}
}
/** The same projection runs on hire and onboard. Never writes the fleet base. */
export async function withRegistryLock<T>(path:string, action:()=>Promise<T>):Promise<T> {
  mkdirSync(dirname(path),{recursive:true});
  const lock=path+'.lock';
  if(existsSync(lock)&&lstatSync(lock).isSymbolicLink()) throw new Error(`Refusing registry lock symlink ${lock}`);
  const child=spawn('flock',['-w','30',lock,'sh','-c','printf "locked\\n"; read release'],{stdio:['pipe','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{
    child.stdout.once('data',()=>resolve());
    child.once('error',reject);
    child.once('exit',code=>reject(new Error(`Registry lock unavailable (exit ${code})`)));
  });
  try {return await action();} finally {child.stdin.end('\n');await new Promise<void>(resolve=>child.once('close',()=>resolve()));}
}
export async function projectRoleDeclaration(input:unknown, employee:string, profile:string, options:RoleProjectionOptions={}): Promise<RoleProjectionResult> {
  if(options.dryRun) return projectUnlocked(input,employee,profile,options);
  return withRegistryLock(paths(options).registry,()=>projectUnlocked(input,employee,profile,options));
}
async function projectUnlocked(input:unknown, employee:string, profile:string, options:RoleProjectionOptions={}): Promise<RoleProjectionResult> {
  const role=validateRoleDeclaration(input,employee,profile), p=paths(options);
  const errors=declarationProblems(role,employee,options);if(errors.length) throw new Error(errors.join("; "));
  const department=read(p.org).departments.find((d:any)=>d.id===role.department);
  const superior=role.reports_to ?? department.manager;
  const desk=options.deskPath ?? join(p.fleet,"profiles",profile);
  if(existsSync(desk)&&lstatSync(desk).isSymbolicLink()) throw new Error("desk must be a real directory");
  const selected=selectionContext(options,p);
  // Skillex projects into <hermes root>/profiles/<profile> and nowhere else: a loadout is
  // never delivered through a second directory the desk would have to be told about.
  if(role.skills&&resolve(desk)!==resolve(join(p.fleet,"profiles",profile))) throw new Error(`skills loadout: Skillex projects into ${join(p.fleet,"profiles",profile)}, not ${desk}`);
  const plan=role.skills ? await planRoleSelection(desk,role.skills,selected) : undefined;
  const skills=plan?.skills ?? [];
  const flume=resolveFlumeRoot();
  if(role.chain && !options.catalogModels) {
    const current=read(join(desk,"config.yaml"));
    const reference=current.secrets?.onepassword?.env?.AUTOMATICAI_GATEWAY_KEY;
    const check=spawnSync("python3",[join(flume,"scripts/role-catalog-check.py")],{input:JSON.stringify({chain:role.chain,reference}),encoding:"utf8",timeout:40_000});
    if(check.status!==0) throw new Error(String(check.stderr).trim()||"Authenticated catalog check failed");
  }
  // Read-only, so a dry run reports the refusal a real run would hit (and a real run hits it before any change).
  if(plan) await preflightRoleSelection(profile,desk,selected);
  if(options.dryRun) return {department:role.department,reports_to:superior,skills,chain:role.chain??null,overrides:[],selection:plan?await previewRoleSelection(profile,plan,selected):null};
  mkdirSync(desk,{recursive:true});
  // A loadout makes the desk strict: discovery is pinned to the Skillex projection before Skillex
  // writes it (a strict sync refuses a generated config that still lists external roots).
  const configured=spawnSync("python3",[join(flume,"scripts/role-profile-config.py"),options.renderer??join(flume,"templates/hermes-agent/scripts/hermes-profile-config.py"),profile],
    {input:JSON.stringify({chain:role.chain,strict_skills:Boolean(role.skills)}),encoding:"utf8",timeout:35_000,env:{...process.env,HERMES_FLEET_HOME:p.fleet}});
  if(configured.status!==0) throw new Error(`Role config projection failed: ${configured.stderr}`);
  const selection=plan ? await applyRoleSelection(profile,plan,selected) : null;
  updateDocument(p.registry,doc=>{doc.setIn(["agents",employee,"department"],role.department);doc.setIn(["agents",employee,"reports_to"],superior);});
  updateDocument(p.org,doc=>{
    const departments=doc.get("departments",true);
    if(!YAML.isSeq(departments)) throw new Error("org departments must be a list");
    for(const item of departments.items) {
      if(!YAML.isMap(item)) continue;
      let members=item.get("members",true);
      if(!YAML.isSeq(members)) {if(item.get("id")!==role.department)continue;item.set("members",[]);members=item.get("members",true);}
      if(YAML.isSeq(members)) {
        for(let i=members.items.length-1;i>=0;i--) if(String(members.items[i])===employee&&item.get("id")!==role.department) members.delete(i);
        if(item.get("id")===role.department&&item.get("manager")!==employee&&!members.items.some(x=>String(x)===employee)) members.add(employee);
      }
    }
  });
  return {department:role.department,reports_to:superior,skills,selection,...JSON.parse(configured.stdout)};
}
