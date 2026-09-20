import type { CommandContext } from "./Command";

export type RecipeId = string;
export type RuleId = string;
export type LifecycleStatus = "pass" | "fail" | "warn" | "skip";
/**
 * `partial` is the honest outcome for a rule that DID apply changes (or found
 * nothing it was allowed to change) yet still does not pass its own audit --
 * e.g. a step that needs an explicit opt-in flag, or a blocker the rule
 * refuses to resolve destructively. It is the migrate-side counterpart of the
 * postcondition check `Recipe.initializeOwnedChecks` has always run, and it
 * exists so "Migration complete" can never be followed by a failing audit.
 */
export type MigrationStatus = "applied" | "noop" | "blocked" | "skipped" | "partial";
export type RecipePhaseStatus = "changed" | "unchanged" | "planned" | "skipped" | "failed" | "cancelled";

export interface LifecycleContext extends CommandContext {
  targetDir: string;
  dryRun: boolean;
  force: boolean;
  repoRoot: string;
  pjanglerRoot: string;
  homeDir: string;
  /**
   * The project registry this run reads.
   *
   * Threaded explicitly rather than resolved per-rule. pjangler learned this the
   * hard way (PJAN-84): every rule that fell back to its own registry lookup was
   * unreachable by `--registry`, so one report could answer about two different
   * registries at once. Flume reads the project registry too -- for the repo an
   * employee is assigned to -- and inherits the same rule.
   */
  registryPath?: string;
  live?: boolean;
  bmadVersionPin?: string;
  acceptRegistryMatches?: boolean;
}

export interface RecipeMetadata {
  id: RecipeId;
  name: string;
  description: string;
  dependencies: readonly RecipeId[];
  commands: readonly string[];
  publicRuleIds: readonly RuleId[];
}

export interface RecipeInitResult {
  recipeId: RecipeId;
  ok: boolean;
  dryRun: boolean;
  changedFiles: string[];
  logs: string[];
  errors: string[];
  phases: RecipePhaseOutcome[];
  [key: string]: unknown;
}

export interface RecipePhaseOutcome {
  id: string;
  status: RecipePhaseStatus;
  changedFiles: string[];
  message?: string;
}

export interface LifecycleAuditFinding {
  /** See LifecycleScope. Absent means "project". */
  scope?: LifecycleScope;
  id: RuleId;
  title: string;
  status: LifecycleStatus;
  summary: string;
  details: string[];
  fixable: boolean;
  recipeId?: RecipeId;
}

export interface LifecycleMigrationResult {
  id: RuleId;
  title: string;
  status: MigrationStatus;
  summary: string;
  changedFiles: string[];
  details: string[];
  recipeId?: RecipeId;
}

export interface LifecycleAuditReport {
  repo: string;
  /** Is the audited PROJECT in parity? Host-scoped findings never affect this. */
  ok: boolean;
  /** Is the MACHINE's shared state healthy? Reported separately, never gating. */
  hostOk: boolean;
  auditedAt: string;
  rules: LifecycleAuditFinding[];
}

export interface LifecycleMigrationReport {
  repo: string;
  dryRun: boolean;
  ok: boolean;
  selectedRules: string[];
  results: LifecycleMigrationResult[];
  changedFiles: string[];
}

/**
 * PJAN-84: whose problem is this finding?
 *
 * `project` — the repository being audited can change it. A failure gates the
 *   project: it is exactly what `pj audit` and the init transaction are for.
 * `host` — it is about this MACHINE ($HOME, systemd, the fleet registry, the
 *   global skill projection). No amount of work in the repository can change it,
 *   so failing the repository for it is a category error.
 *
 * Absent means `project`, so a rule that has never thought about scope keeps
 * gating — the safe default.
 *
 * Why this exists: `auditRecipes` counted anything but pass/skip as not-ok, and
 * `ProjectRecipe` turned a not-ok postcondition audit into a transaction error.
 * So one drifted symlink under ~/.agents could fail — and roll back — a
 * brand-new project, and every project on the machine at once. PJAN-82 fixed the
 * two rules that happened to be firing; this fixes the semantics, so the next
 * host-scoped rule cannot re-create it.
 */
export type LifecycleScope = "project" | "host";

export interface RecipeCheck {
  readonly id: RuleId;
  readonly title: string;
  /** Defaults to "project" when absent. */
  readonly scope?: LifecycleScope;
  audit(ctx: LifecycleContext): LifecycleAuditFinding | Promise<LifecycleAuditFinding>;
  migrate(ctx: LifecycleContext, finding: LifecycleAuditFinding): LifecycleMigrationResult | Promise<LifecycleMigrationResult>;
}

/**
 * The ONE place a check's audit is turned into a stamped finding.
 *
 * Every caller must go through this. `Recipe.audit` was the only stamper, but
 * `verifyMigration` and `migrateAll` call `checks[i].audit(ctx)` directly — so a
 * field stamped only in `Recipe.audit` would be silently absent in exactly the
 * two places that decide whether a migration succeeded.
 */
export function stampFinding(
  check: RecipeCheck,
  finding: LifecycleAuditFinding,
  recipeId?: string,
): LifecycleAuditFinding {
  return {
    ...finding,
    scope: finding.scope ?? check.scope ?? "project",
    ...(recipeId ? { recipeId } : {}),
  };
}

export async function auditCheck(
  check: RecipeCheck,
  ctx: LifecycleContext,
  recipeId?: string,
): Promise<LifecycleAuditFinding> {
  return stampFinding(check, await check.audit(ctx), recipeId);
}

/** A finding that must not gate the repository it was found in. */
export function isHostScoped(finding: Pick<LifecycleAuditFinding, "scope">): boolean {
  return finding.scope === "host";
}

/**
 * Does this finding mean the audited PROJECT is out of parity?
 *
 * `warn` deliberately does not. A warn that counts against ok is just a fail
 * with a different glyph, which is how `pj audit` came to exit 1 while
 * reporting zero failed rules. Migration selection is a different question and
 * still picks up fail AND warn.
 */
export function gatesProject(finding: Pick<LifecycleAuditFinding, "status" | "scope">): boolean {
  return finding.status === "fail" && !isHostScoped(finding);
}

export interface LifecycleRecipe<TInput = unknown> {
  readonly metadata: RecipeMetadata;
  readonly checks: readonly RecipeCheck[];
  init(ctx: LifecycleContext, input: TInput): Promise<RecipeInitResult>;
  audit(ctx: LifecycleContext): Promise<LifecycleAuditFinding[]>;
  migrate(ctx: LifecycleContext, ruleIds: readonly RuleId[]): Promise<LifecycleMigrationResult[]>;
  /** Project-like orchestrators run their declared dependencies inside init. */
  readonly orchestratesDependencies?: boolean;
}
