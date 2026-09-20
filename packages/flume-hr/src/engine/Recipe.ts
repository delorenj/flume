import { homedir } from "node:os";
import { resolve } from "node:path";
import { Command } from "./Command";
import type { CommandContext, InvokeResult } from "./Command";
import { bold, cyan, dim, green, yellow, glyph } from "../utils/style";
import { auditCheck } from "./types";
import type {
  LifecycleAuditFinding,
  LifecycleContext,
  LifecycleMigrationResult,
  LifecycleRecipe,
  RecipeCheck,
  RecipeInitResult,
  RecipeMetadata,
  RecipePhaseOutcome,
  RecipePhaseStatus,
} from "./types";

export interface AddIngredient<T extends Command = Command> {
  new (context: CommandContext): T;
}

function commandStatus(result: InvokeResult, dryRun: boolean): RecipePhaseStatus {
  if (result.outcome) return result.outcome;
  if (!result.success) return "failed";
  if (dryRun && result.filePath) return "planned";
  return result.filePath ? "changed" : "unchanged";
}

function mergeInitResults(recipeId: string, dryRun: boolean, results: readonly RecipeInitResult[]): RecipeInitResult {
  return {
    recipeId,
    ok: results.every((result) => result.ok),
    dryRun,
    changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))].sort(),
    logs: results.flatMap((result) => result.logs),
    errors: results.flatMap((result) => result.errors),
    phases: results.flatMap((result) => result.phases),
  };
}

/**
 * A lifecycle recipe owns initialization, audit, and migration for one module.
 * Command messages are presentation only; lifecycle success and changed-file
 * accounting are derived exclusively from structured command/check outcomes.
 */
export abstract class Recipe<TInput = unknown> implements LifecycleRecipe<TInput> {
  abstract readonly metadata: RecipeMetadata;
  abstract readonly checks: readonly RecipeCheck[];
  protected readonly ingredientTypes: AddIngredient[] = [];
  private readonly compatibilityContext?: CommandContext;

  constructor(context?: CommandContext) {
    this.compatibilityContext = context;
  }

  addIngredient<T extends Command>(CommandClass: AddIngredient<T>): this {
    this.ingredientTypes.push(CommandClass);
    return this;
  }

  protected async invokeIngredients(ctx: LifecycleContext): Promise<RecipeInitResult> {
    const phases: RecipePhaseOutcome[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const changedFiles: string[] = [];

    for (const CommandClass of this.ingredientTypes) {
      const command = new CommandClass(ctx);
      const result = await command.invoke();
      const status = commandStatus(result, Boolean(ctx.dryRun));
      const phaseChangedFiles = status === "changed" && result.filePath
        ? [resolve(ctx.targetDir, result.filePath)]
        : [];
      phases.push({ id: CommandClass.name, status, changedFiles: phaseChangedFiles, message: result.message || undefined });
      if (result.message) logs.push(result.message);
      changedFiles.push(...phaseChangedFiles);
      if (status === "failed" || status === "cancelled") errors.push(result.message || `${CommandClass.name} ${status}`);
      if (status === "failed" || status === "cancelled") break;
    }

    return {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases,
    };
  }

  /** Initialize missing/drifted state using only this recipe's owned checks. */
  protected async initializeOwnedChecks(ctx: LifecycleContext): Promise<RecipeInitResult> {
    const phases: RecipePhaseOutcome[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const changedFiles: string[] = [];

    for (const check of this.checks) {
      const finding = await check.audit(ctx);
      if (finding.status === "pass" || finding.status === "skip") {
        phases.push({ id: check.id, status: finding.status === "skip" ? "skipped" : "unchanged", changedFiles: [], message: finding.summary });
        continue;
      }
      if (!finding.fixable) {
        phases.push({ id: check.id, status: "failed", changedFiles: [], message: finding.summary });
        errors.push(`${check.id}: ${finding.summary}`);
        break;
      }
      const migrated = await check.migrate(ctx, finding);
      const status: RecipePhaseStatus = migrated.status === "applied"
        ? (ctx.dryRun ? "planned" : "changed")
        : migrated.status === "noop"
          ? "unchanged"
          : migrated.status === "skipped"
            ? "skipped"
            : "failed";
      const actualChanges = status === "changed" ? migrated.changedFiles : [];
      phases.push({ id: check.id, status, changedFiles: actualChanges, message: migrated.summary });
      logs.push(`${check.id}: ${migrated.summary}`);
      changedFiles.push(...actualChanges);
      if (status === "failed") {
        errors.push(`${check.id}: ${migrated.summary}`);
        break;
      }
      if (!ctx.dryRun) {
        const postcondition = await check.audit(ctx);
        if (postcondition.status !== "pass" && postcondition.status !== "skip") {
          const detail = postcondition.details.length ? ` (${postcondition.details.join("; ")})` : "";
          errors.push(`${check.id}: init postcondition failed: ${postcondition.summary}${detail}`);
          phases.push({ id: `${check.id}:postcondition`, status: "failed", changedFiles: [], message: postcondition.summary });
          break;
        }
      }
    }

    return {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases,
    };
  }

  /** Every concrete recipe declares its own initialization policy. */
  abstract init(ctx: LifecycleContext, input: TInput): Promise<RecipeInitResult>;

  async audit(ctx: LifecycleContext): Promise<LifecycleAuditFinding[]> {
    return Promise.all(this.checks.map((check) => auditCheck(check, ctx, this.metadata.id)));
  }

  async migrate(ctx: LifecycleContext, ruleIds: readonly string[]): Promise<LifecycleMigrationResult[]> {
    const selected = this.checks.filter((check) => ruleIds.includes(check.id));
    const results: LifecycleMigrationResult[] = [];
    for (const check of selected) {
      results.push({ ...await check.migrate(ctx, await check.audit(ctx)), recipeId: this.metadata.id });
    }
    return results;
  }

  /** @deprecated Compatibility alias; registry dispatch is authoritative. */
  async execute(input?: TInput): Promise<void> {
    if (!this.compatibilityContext) throw new Error(`${this.metadata.id}.execute requires a compatibility context`);
    const targetDir = resolve(this.compatibilityContext.targetDir);
    const ctx: LifecycleContext = {
      ...this.compatibilityContext,
      targetDir,
      repoRoot: targetDir,
      pjanglerRoot: resolve(new URL("../..", import.meta.url).pathname),
      homeDir: homedir(),
      dryRun: Boolean(this.compatibilityContext.dryRun),
      force: Boolean(this.compatibilityContext.force),
    };
    console.log("");
    console.log(`  ${cyan(bold(glyph.chevron))} ${bold(`Initializing ${this.metadata.id} subsystem`)}${ctx.dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
    console.log("");
    const result = await this.init(ctx, input as TInput);
    for (const line of result.logs) console.log(line.split("\n").map((part) => part ? `  ${part}` : part).join("\n"));
    for (const error of result.errors) console.error(error);
    if (!ctx.dryRun && result.ok) this.printNextSteps();
    if (ctx.dryRun) {
      console.log("");
      console.log(`  ${green(glyph.pass)} ${dim("Dry-run complete — no files were modified.")}`);
      console.log(`  ${dim("Remove --dry-run to apply changes.")}`);
    }
  }

  protected abstract printNextSteps(): void;
}

export { mergeInitResults };
