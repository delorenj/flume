import {join} from "node:path";
import {Command,type InvokeResult} from "../engine/Command";
import {resolveFlumeRoot} from "../kernel/paths";
import { projectRoleDeclaration, readRoleDeclaration } from "../workforce/role";
import type {HermesAgentContext} from "./types";
import {spawnSync} from "node:child_process";

// The fleet base equips PMs for Bloodbank delegation. A newly hired
// contributor must not inherit those unattended permissions: the final hire
// audit correctly refuses them. Preserve explicit desk overrides for review.
const RESTRICT_INHERITED_BLOODBANK = String.raw`
import importlib.util, os, sys, tempfile
source, profile = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("flume_renderer", source)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
pdir = r.PROFILES / profile
if pdir.is_symlink() or not pdir.is_dir():
    raise SystemExit("desk must be a real directory")
with r.PROFILE_LOCK.ProfileConfigLock(pdir):
    path = pdir / "config.delta.yaml"
    if path.is_symlink() or (pdir / "config.yaml").is_symlink():
        raise SystemExit("refusing config symlink")
    delta = r.load_yaml(path)
    tools = delta.get("platform_toolsets") or {}
    directive = delta.get(r.LIST_PATCH_KEY) or {}
    patches = directive.get("list_patches") or {}
    if "bloodbank" not in tools and "platform_toolsets.bloodbank" not in patches:
        inherited = (r.load_yaml(r.BASE).get("platform_toolsets") or {}).get("bloodbank")
        if isinstance(inherited, list):
            delta[r.LIST_PATCH_KEY] = {**directive, "list_patches": {
                **patches, "platform_toolsets.bloodbank": {"remove": ["delegation", "terminal", "file"]}}}
            fd, temporary = tempfile.mkstemp(prefix=".config.delta.yaml.hire-", dir=pdir)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    stream.write(r.dump_yaml(delta))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            r.write_generated(pdir / "config.yaml", r.deep_merge(r.load_yaml(r.BASE), delta))
`;

/** Role-owned projection, after the existing template has established the desk. */
export class ProjectRoleDeclaration extends Command {
  async invoke():Promise<InvokeResult> {
    const ctx=this.context as HermesAgentContext;
    try {
      const root=process.env.FLUME_ROLES_ROOT ?? resolveFlumeRoot();
      const role=readRoleDeclaration(root,ctx.role??"pm",ctx.agentId??"",ctx.profileName??"");
      // Charter-only legacy roles keep their established provisioning path.
      if(!role.skills&&!role.chain&&!role.department&&!role.reports_to) return {success:true,outcome:"unchanged",message:"Charter-only role: no deployment declaration"};
      const result=await projectRoleDeclaration(role,ctx.agentId!,ctx.profileName!,{dryRun:ctx.dryRun});
      if (role.role !== "pm" && !ctx.dryRun) {
        const restricted = spawnSync("python3", ["-c", RESTRICT_INHERITED_BLOODBANK,
          join(resolveFlumeRoot(), "templates/hermes-agent/scripts/hermes-profile-config.py"), ctx.profileName!],
          {encoding:"utf8",timeout:35_000});
        if(restricted.status!==0) throw new Error(`Role Bloodbank config: ${restricted.stderr || restricted.error?.message}`);
      }
      return {success:true,outcome:ctx.dryRun?"planned":"changed",message:`Role declaration projected: ${JSON.stringify(result)}`};
    } catch(error) {return {success:false,outcome:"failed",message:`Role declaration: ${(error as Error).message}`};}
  }
}
