import { homedir } from "node:os";
import { resolve } from "node:path";
import { recipeRegistry } from "./catalog";
import { resolveFlumeRoot } from "../kernel/paths";
import type { LifecycleContext } from "../engine/types";
import type { AuditReport, MigrationReport } from "./rules";

export { recipeRegistry };

/**
 * `recipeId` is an INTERNAL field. It names which recipe owns a rule, which is
 * how `ownerOf` routes a migration -- and it is nobody's business on the wire.
 * pjangler stripped it from both reports and the strippers did not come across
 * with the move, so `flume audit --json` started shipping it.
 */
function publicAudit(report: Awaited<ReturnType<typeof recipeRegistry.auditRecipes>>): AuditReport {
  return {
    ...report,
    rules: report.rules.map(({ recipeId: _recipeId, ...finding }) => finding),
  } as AuditReport;
}

function publicMigration(report: Awaited<ReturnType<typeof recipeRegistry.migrateRules>>): MigrationReport {
  return {
    ...report,
    results: report.results.map(({ recipeId: _recipeId, ...result }) => result),
  } as MigrationReport;
}

/**
 * The context every employee rule runs against.
 *
 * `flumeRoot` replaces pjangler's `pjanglerRoot`: the rules resolve the vendored
 * job-description template beneath it, and after the split that template ships
 * from this repo.
 */
export function lifecycleContext(
  repoArg: string | undefined,
  dryRun: boolean,
  acceptRegistryMatches = false,
  overrides: Partial<LifecycleContext> = {},
): LifecycleContext {
  const repoRoot = resolve(repoArg ?? process.cwd());
  return {
    ...overrides,
    targetDir: repoRoot,
    repoRoot,
    dryRun: overrides.dryRun ?? dryRun,
    force: overrides.force ?? false,
    pjanglerRoot: overrides.pjanglerRoot ?? resolveFlumeRoot(),
    homeDir: overrides.homeDir ?? homedir(),
    acceptRegistryMatches: overrides.acceptRegistryMatches ?? acceptRegistryMatches,
  };
}

export function getParityRuleIds(): string[] {
  return [...recipeRegistry.listRuleIds()];
}

/**
 * Audit, optionally narrowed to specific rule ids.
 *
 * An id this registry does not own is an ERROR, never an empty pass -- the same
 * contract `pj audit --rules` keeps on the project side. A caller probing a rule
 * must not read "no findings" when the real answer is "I never checked".
 */
export async function runAudit(
  repoArg?: string,
  registryPath?: string,
  ruleIds?: readonly string[],
): Promise<AuditReport> {
  const report = publicAudit(await recipeRegistry.auditRecipes(
    lifecycleContext(repoArg, true, false, registryPath ? { registryPath } : {}),
  ));
  if (!ruleIds || ruleIds.length === 0) return report;
  const known = new Set(recipeRegistry.listRuleIds());
  const unknown = ruleIds.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown employee rule id(s): ${unknown.join(", ")}`);
  const wanted = new Set(ruleIds);
  const rules = report.rules.filter((finding) => wanted.has(finding.id));
  return { ...report, rules, ok: rules.every((f) => f.status === "pass" || f.status === "skip") };
}

export async function runMigrationForRules(
  ruleIds: string[],
  repoArg: string | undefined,
  dryRun: boolean,
  acceptRegistryMatches = false,
  registryPath?: string,
): Promise<MigrationReport> {
  return publicMigration(await recipeRegistry.migrateRules(
    lifecycleContext(repoArg, dryRun, acceptRegistryMatches, registryPath ? { registryPath } : {}),
    ruleIds,
  ));
}
