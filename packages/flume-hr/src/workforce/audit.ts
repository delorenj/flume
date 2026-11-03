import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { readRoleDeclaration, declarationProblems, skillsProblems } from "./role";
import type { RecipeOwnedCheck } from "../parity/rules";
import { resolveAgentRegistryPath } from "../kernel/fleet-paths";
import { agentsOf, claimedBoards, type Row } from "./board-routing";

const RETIRED_ROUTING_TITLE = "No retired employee still claims a board, and no board has two defaults";

/** The registry-wide routing invariants. Pure: a parsed `agents` mapping in, one line per violation out. */
export function retiredRoutingProblems(agents: Row): string[] {
  const problems: string[] = [];
  const defaults = new Map<string, string[]>();
  for (const [id, raw] of Object.entries(agents)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Row;
    const plane = row.plane !== null && typeof row.plane === "object" ? (row.plane as Row) : undefined;
    if (plane?.scope_default === true) for (const board of claimedBoards(row)) defaults.set(board, [...(defaults.get(board) ?? []), id]);
    const retired = ["telegram", "slack"].filter((platform) => {
      const block = row[platform];
      return block !== null && typeof block === "object" && (block as Row).provisioning_status === "retired";
    });
    if (!retired.length) continue;
    const bloodbank = row.bloodbank !== null && typeof row.bloodbank === "object" ? (row.bloodbank as Row) : undefined;
    const routable = bloodbank !== undefined && bloodbank.enabled !== false;
    if (routable || plane !== undefined) {
      const claims = claimedBoards(row);
      problems.push(`${id}: ${retired.join(", ")} marked retired but the row still ${[
        plane !== undefined ? `claims board ${claims.join(", ") || "(plane block)"}` : "",
        routable ? "has bloodbank enabled" : "",
      ].filter(Boolean).join(" and ")}; run: flume retire ${id} --apply`);
    }
  }
  for (const [board, ids] of [...defaults].sort()) {
    if (ids.length > 1) problems.push(`board ${board}: ${ids.length} rows declare plane.scope_default: true (${[...ids].sort().join(", ")}); the first by id wins every unmatched ticket. Retire the one that is out of service: flume retire <id> --apply`);
  }
  return problems;
}

/**
 * The shape of the 2026-11-02 incident. pile-of-dumb-things-pm was "retired" by setting its telegram
 * status to `retired` and nothing else, so its still-enabled bloodbank row and its plane claim kept winning
 * every ticket on the shared TOLT board. Host-scoped (the registry is this machine's) and never gating.
 */
export const retiredRoutingCheck: RecipeOwnedCheck = {
  id: "hermes.retired-routing",
  title: RETIRED_ROUTING_TITLE,
  scope: "host",
  audit: ctx => {
    const path = resolveAgentRegistryPath(process.env, ctx.homeDir);
    const base = {id: "hermes.retired-routing", title: RETIRED_ROUTING_TITLE, fixable: false};
    if (!existsSync(path)) return {...base, status: "skip" as const, summary: `no agent registry at ${path}`, details: []};
    let registry: unknown;
    try {registry = YAML.parse(readFileSync(path, "utf8"));}
    catch {return {...base, status: "skip" as const, summary: `agent registry unreadable at ${path}`, details: []};}
    const agents = agentsOf(registry);
    const details = retiredRoutingProblems(agents);
    return details.length
      ? {...base, status: "fail" as const, summary: `${details.length} routing invariant violation(s) in the agent registry`, details}
      : {...base, status: "pass" as const, summary: `${Object.keys(agents).length} registry row(s) checked`, details: []};
  },
  migrate: (_ctx, finding) => ({id: finding.id, title: finding.title, status: "blocked", summary: "Retiring is a per-employee decision: run `flume retire <id> --apply` for each row named", changedFiles: [], details: finding.details}),
};

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
