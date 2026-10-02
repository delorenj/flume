import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { readRoleDeclaration, declarationProblems, skillsProblems } from "./role";
import type { RecipeOwnedCheck } from "../parity/rules";

export const roleDeclarationCheck: RecipeOwnedCheck = {
  id: "hermes.role-declaration",
  title: "Role deployment declaration and reporting references are valid",
  audit: async ctx => {
    const details: string[] = [];
    const rolesDir = join(ctx.repoRoot, "agents", "hermes");
    let declarations = 0;
    if (existsSync(rolesDir)) for (const entry of readdirSync(rolesDir, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(rolesDir, entry.name, "role.yaml");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = YAML.parse(readFileSync(manifestPath, "utf8"));
        const id = String(manifest.agent_id), profile = String(manifest.profile ?? id);
        const role = readRoleDeclaration(process.env.FLUME_ROLES_ROOT ?? ctx.pjanglerRoot, String(manifest.role ?? entry.name), id, profile);
        if (!role.skills && !role.chain && !role.department && !role.reports_to) continue;
        declarations++;
        details.push(...declarationProblems(role, id, {home: ctx.homeDir}), ...await skillsProblems(role, id, {home: ctx.homeDir}));
        const registryPath = process.env.HERMES_AGENTS_REGISTRY ?? process.env.HERMES_FLEET_REGISTRY_FILE ?? join(process.env.HERMES_FLEET_HOME ?? join(ctx.homeDir,".hermes"), "agents-registry.yaml");
        const row = (YAML.parse(readFileSync(registryPath,"utf8"))?.agents ?? {})[id];
        if (row && !row.department) details.push(`${id}: registered employee has no department`);
        if (row?.reports_to && row.reports_to !== role.reports_to && role.reports_to) details.push(`${id}: registry reports_to ${row.reports_to} differs from declaration ${role.reports_to}`);
      } catch(error) {details.push(`${entry.name}: ${(error as Error).message}`);}
    }
    return {id: "hermes.role-declaration", title: "Role deployment declaration and reporting references are valid", status: details.length ? "fail" : declarations ? "pass" : "skip",
      summary: details.length ? `${details.length} invalid role declaration/reference(s)` : `${declarations} deployment declaration(s) checked`, details, fixable: false};
  },
  migrate: (_ctx, finding) => ({id: finding.id, title: finding.title, status: "blocked", summary: "Correct the declaration/references before projection", changedFiles: [], details: finding.details}),
};
