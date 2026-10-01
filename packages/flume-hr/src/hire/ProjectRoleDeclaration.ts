import {readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {Command,type InvokeResult} from "../engine/Command";
import {resolveFlumeRoot} from "../kernel/paths";
import { projectRoleDeclaration, readRoleDeclaration } from "../workforce/role";
import type {HermesAgentContext} from "./types";

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
      return {success:true,outcome:ctx.dryRun?"planned":"changed",message:`Role declaration projected: ${JSON.stringify(result)}`};
    } catch(error) {return {success:false,outcome:"failed",message:`Role declaration: ${(error as Error).message}`};}
  }
}
