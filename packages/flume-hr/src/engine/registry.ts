import { auditCheck, gatesProject, isHostScoped } from "./types";
import type {
  LifecycleAuditFinding,
  LifecycleAuditReport,
  LifecycleContext,
  LifecycleMigrationReport,
  LifecycleMigrationResult,
  LifecycleRecipe,
  RecipeId,
  RecipeInitResult,
  RecipeMetadata,
  RuleId,
} from "./types";

/**
 * The sole lifecycle dispatch and ownership boundary.
 *
 * Registration is deliberately strict: recipe ids and public rule ids are
 * globally unique, dependencies must exist, and the dependency graph must be
 * acyclic. Ordering is stable: registration order for audit, dependencies-first
 * for init, requested order for selected migrations.
 */
export class RecipeRegistry {
  private readonly recipes = new Map<RecipeId, LifecycleRecipe>();
  private readonly ruleOwners = new Map<RuleId, { recipe: LifecycleRecipe; checkIndex: number }>();
  private validated = false;

  constructor(recipes: readonly LifecycleRecipe[] = []) {
    for (const recipe of recipes) this.register(recipe);
    if (recipes.length) this.validate();
  }

  register(recipe: LifecycleRecipe): this {
    if (this.recipes.has(recipe.metadata.id)) throw new Error(`Duplicate recipe id: ${recipe.metadata.id}`);
    const seenLocal = new Set<string>();
    for (let index = 0; index < recipe.checks.length; index++) {
      const check = recipe.checks[index]!;
      if (seenLocal.has(check.id) || this.ruleOwners.has(check.id)) throw new Error(`Duplicate parity rule id: ${check.id}`);
      seenLocal.add(check.id);
      this.ruleOwners.set(check.id, { recipe, checkIndex: index });
    }
    const declared = [...recipe.metadata.publicRuleIds];
    const actual = recipe.checks.map((check) => check.id);
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      throw new Error(`Recipe ${recipe.metadata.id} publicRuleIds do not match its checks`);
    }
    this.recipes.set(recipe.metadata.id, recipe);
    const registryAware = recipe as LifecycleRecipe & { attachRegistry?: (registry: RecipeRegistry) => void };
    registryAware.attachRegistry?.(this);
    this.validated = false;
    return this;
  }

  validate(): void {
    for (const recipe of this.recipes.values()) {
      for (const dependency of recipe.metadata.dependencies) {
        if (!this.recipes.has(dependency)) throw new Error(`Unknown dependency ${dependency} for recipe ${recipe.metadata.id}`);
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, path: string[]) => {
      if (visiting.has(id)) throw new Error(`Recipe dependency cycle: ${[...path, id].join(" -> ")}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const recipe = this.recipes.get(id)!;
      for (const dependency of recipe.metadata.dependencies) visit(dependency, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.recipes.keys()) visit(id, []);
    this.validated = true;
  }

  private ensureValid(): void {
    if (!this.validated) this.validate();
  }

  list(): readonly RecipeMetadata[] {
    this.ensureValid();
    return [...this.recipes.values()].map((recipe) => recipe.metadata);
  }

  get(recipeId: RecipeId): LifecycleRecipe | undefined {
    return this.recipes.get(recipeId);
  }

  ownerOf(ruleId: RuleId): { recipe: LifecycleRecipe; check: LifecycleRecipe["checks"][number] } | undefined {
    const owner = this.ruleOwners.get(ruleId);
    if (!owner) return undefined;
    return { recipe: owner.recipe, check: owner.recipe.checks[owner.checkIndex]! };
  }

  resolveOrder(recipeId: RecipeId): LifecycleRecipe[] {
    this.ensureValid();
    if (!this.recipes.has(recipeId)) throw new Error(`Unknown recipe: ${recipeId}`);
    const ordered: LifecycleRecipe[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      const recipe = this.recipes.get(id)!;
      for (const dependency of recipe.metadata.dependencies) visit(dependency);
      seen.add(id);
      ordered.push(recipe);
    };
    visit(recipeId);
    return ordered;
  }

  resolveDependencies(recipeId: RecipeId): LifecycleRecipe[] {
    return this.resolveOrder(recipeId).filter((recipe) => recipe.metadata.id !== recipeId);
  }

  private aggregateInit(recipeId: RecipeId, ctx: LifecycleContext, results: readonly RecipeInitResult[]): RecipeInitResult {
    const selected = results.at(-1) ?? {
      recipeId,
      ok: true,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [],
      logs: [],
      errors: [],
      phases: [],
    };
    return {
      ...selected,
      recipeId,
      ok: results.every((result) => result.ok),
      changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))].sort(),
      logs: results.flatMap((result) => result.logs),
      errors: results.flatMap((result) => result.errors),
      phases: results.flatMap((result) => result.phases),
      dependencyResults: results.slice(0, -1),
    };
  }

  async initDependencies<TInput>(recipeId: RecipeId, ctx: LifecycleContext, input: TInput, excludeRecipeIds: readonly RecipeId[] = []): Promise<RecipeInitResult> {
    const results: RecipeInitResult[] = [];
    for (const dependency of this.resolveDependencies(recipeId)) {
      if (excludeRecipeIds.includes(dependency.metadata.id)) continue;
      const result = await dependency.init(ctx, input);
      results.push(result);
      if (!result.ok) break;
    }
    return this.aggregateInit(recipeId, ctx, results);
  }

  async initRecipe<TInput>(recipeId: RecipeId, ctx: LifecycleContext, input: TInput): Promise<RecipeInitResult> {
    this.ensureValid();
    const selected = this.recipes.get(recipeId);
    if (!selected) throw new Error(`Unknown recipe: ${recipeId}`);
    if (selected.orchestratesDependencies) return selected.init(ctx, input);

    const results: RecipeInitResult[] = [];
    for (const recipe of this.resolveOrder(recipeId)) {
      const result = await recipe.init(ctx, input);
      results.push(result);
      if (!result.ok) break;
    }
    return this.aggregateInit(recipeId, ctx, results);
  }

  async auditRecipes(ctx: LifecycleContext, recipeIds?: readonly RecipeId[]): Promise<LifecycleAuditReport> {
    this.ensureValid();
    const selected = recipeIds ? recipeIds.map((id) => {
      const recipe = this.recipes.get(id);
      if (!recipe) throw new Error(`Unknown recipe: ${id}`);
      return recipe;
    }) : [...this.recipes.values()];
    const rules = (await Promise.all(selected.map(async (recipe) =>
      (await recipe.audit(ctx)).map((finding) => ({ ...finding, recipeId: finding.recipeId ?? recipe.metadata.id }))
    ))).flat();
    return {
      repo: ctx.repoRoot,
      // PJAN-84: `ok` answers "is the audited PROJECT in parity?".
      //
      // It used to be `every(pass || skip)`, which made two unrelated claims:
      // that a `warn` is a failure, and that a HOST condition is the
      // repository's failure. The first is why `pj audit` exited 1 while
      // reporting zero failed rules; the second is why a drifted symlink under
      // ~/.agents could fail — and roll back — a brand-new project, and every
      // project on the machine at once.
      //
      // Host findings are still reported, and `hostOk` says whether any of them
      // needs attention, so nothing is hidden — it just no longer gates a repo
      // that cannot fix it.
      ok: rules.every((rule) => !gatesProject(rule)),
      hostOk: rules.every((rule) => !isHostScoped(rule) || rule.status === "pass" || rule.status === "skip"),
      auditedAt: new Date().toISOString(),
      rules,
    };
  }

  /**
   * PJAN-75: re-audit a rule that has just been migrated and demote a claimed
   * success that did not actually reach parity.
   *
   * Without this, `migrate` reports whatever each rule chooses to report about
   * itself, and a rule that applies SOME of its changes still shows a green
   * `[applied]`. That is how `migrate` came to print "Migration complete"
   * immediately followed by a failing `audit` on the very same rules -- the
   * two commands were answering different questions and only `audit` was
   * answering the one the operator asked.
   *
   * Only `applied` and `noop` are re-checked. `blocked` and `skipped` already
   * say the work did not happen, and a dry run has nothing to verify because
   * nothing was written.
   */
  private async verifyMigration(ctx: LifecycleContext, result: LifecycleMigrationResult): Promise<LifecycleMigrationResult> {
    if (ctx.dryRun) return result;
    if (result.status !== "applied" && result.status !== "noop") return result;
    const owner = this.ruleOwners.get(result.id);
    if (!owner) return result;
    let postcondition;
    try {
      postcondition = await auditCheck(owner.recipe.checks[owner.checkIndex]!, ctx);
    } catch (err) {
      return {
        ...result,
        status: "partial",
        summary: `${result.summary} (postcondition audit threw)`,
        details: [...result.details, `postcondition audit threw: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
    if (postcondition.status === "pass" || postcondition.status === "skip") return result;
    return {
      ...result,
      status: "partial",
      // The audit's own summary is the authoritative account of what is still
      // wrong, so it replaces the migrate summary rather than appending to it.
      summary: postcondition.summary,
      details: [
        ...result.details,
        `still failing after migrate: ${postcondition.summary}`,
        ...postcondition.details,
      ],
    };
  }

  async migrateRules(ctx: LifecycleContext, ruleIds: readonly RuleId[]): Promise<LifecycleMigrationReport> {
    this.ensureValid();
    const unknown = ruleIds.filter((id) => !this.ruleOwners.has(id));
    if (unknown.length) throw new Error(`Unknown parity rules: ${unknown.join(", ")}`);
    // PJAN-84: verify AFTER every selected rule has run, not inside the loop.
    //
    // verifyMigration used to be applied per result as it was produced, so rule
    // N's postcondition was read before rules N+1..M had run. A rule that a
    // LATER rule repaired was therefore still reported `partial`, and since
    // `partial` counts against `ok`, `migrate --all` exited 1 describing a repo
    // that was in parity by the time the run ended. Observed on pjangler:
    // bmad.cli-roots reported "3 supported projection issue(s)" that
    // bmad.scaffold's BMAD reinstall had already resolved.
    //
    // PJAN-75's property is untouched: a claimed success must still be supported
    // by the rule's own audit. Only WHEN that audit is read changes.
    const raw: LifecycleMigrationResult[] = [];
    for (const id of ruleIds) {
      const owner = this.ruleOwners.get(id)!;
      try {
        const migrated = await owner.recipe.migrate(ctx, [id]);
        raw.push(...migrated.map((result) => ({
          ...result,
          recipeId: result.recipeId ?? owner.recipe.metadata.id,
        })));
      } catch (err) {
        const check = owner.recipe.checks[owner.checkIndex]!;
        raw.push({
          id,
          recipeId: owner.recipe.metadata.id,
          title: check.title,
          status: "blocked",
          summary: `migrate threw: ${err instanceof Error ? err.message : String(err)}`,
          changedFiles: [],
          details: [],
        });
      }
    }
    const results = await Promise.all(raw.map((result) => this.verifyMigration(ctx, result)));
    return {
      repo: ctx.repoRoot,
      dryRun: Boolean(ctx.dryRun),
      // `partial` counts against ok for the same reason `blocked` does: the
      // repo is not in parity, so the command must not exit 0.
      ok: results.every((result) => result.status !== "blocked" && result.status !== "partial"),
      selectedRules: [...ruleIds],
      results,
      changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))].sort(),
    };
  }

  /**
   * PJAN-75: `migrate --all` accounts for every failing rule, including the
   * ones it is not allowed to touch.
   *
   * Non-fixable failures were silently excluded from the report entirely, so a
   * repo whose only problem was an operator-owned rule -- an unprovisioned
   * Hermes role, a fleet-wide config value -- got "Migration complete", an
   * empty result list and exit 0, immediately followed by a failing `audit`.
   * They are re-checked AFTER the migrations run, because a rule this pass was
   * not allowed to fix may still have been fixed as a side effect of one it
   * was.
   */
  async migrateAll(ctx: LifecycleContext): Promise<LifecycleMigrationReport> {
    const audit = await this.auditRecipes(ctx);
    const failing = audit.rules.filter((rule) => rule.status === "fail" || rule.status === "warn");
    const report = await this.migrateRules(ctx, failing.filter((rule) => rule.fixable).map((rule) => rule.id));

    const manual: LifecycleMigrationResult[] = [];
    for (const rule of failing.filter((candidate) => !candidate.fixable)) {
      const owner = this.ruleOwners.get(rule.id);
      let current = rule;
      if (owner) {
        try {
          current = await auditCheck(owner.recipe.checks[owner.checkIndex]!, ctx, rule.recipeId);
        } catch {
          // Keep the pre-migration finding rather than dropping the rule.
        }
      }
      if (current.status === "pass" || current.status === "skip") continue;
      manual.push({
        id: current.id,
        recipeId: current.recipeId,
        title: current.title,
        status: "blocked",
        summary: current.summary,
        changedFiles: [],
        details: [...current.details, "not auto-fixable: this rule needs an operator decision or action"],
      });
    }
    if (!manual.length) return report;
    return { ...report, ok: false, results: [...report.results, ...manual] };
  }

  listRuleIds(): readonly RuleId[] {
    this.ensureValid();
    return [...this.recipes.values()].flatMap((recipe) => recipe.checks.map((check) => check.id));
  }
}

export function metadata(input: Omit<RecipeMetadata, "publicRuleIds">, checks: readonly { id: string }[]): RecipeMetadata {
  return { ...input, publicRuleIds: checks.map((check) => check.id) };
}
