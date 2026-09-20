import { Recipe, mergeInitResults } from "../engine/Recipe";
import { EnsureTemplateConfig } from "./EnsureTemplateConfig";
import { PromptForAgentConfig } from "./PromptForAgentConfig";
import { ValidateHermesOptions } from "./ValidateHermesOptions";
import { RunCopierTemplate } from "./RunCopierTemplate";
import { UntrackHermesRuntimes } from "./UntrackHermesRuntimes";
import { WireTelegram } from "./WireTelegram";
import { WireEmail } from "./WireEmail";
import { PrintHermesSummary } from "./PrintHermesSummary";
import { ApplyDeferredExternalEffects } from "./ApplyDeferredExternalEffects";
import { ApplyDeferredHostEffects } from "./ApplyDeferredHostEffects";
import type { HermesAgentContext } from "./types";
import { createHermesChecks } from "../parity/rules";
import { probeProjectContracts } from "../kernel/project-contract";
import type { LifecycleContext, RecipeInitResult, RecipeMetadata, RecipePhaseOutcome, RecipePhaseStatus } from "../engine/types";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { changedTreePaths, snapshotTree } from "../utils/tree-diff";
import { preflightRenderedHermes } from "../kernel/preflight";

function deploymentDeferrals(ctx: HermesAgentContext): string[] {
  const deferred: string[] = [];
  if (ctx.local || ctx.skipPlane) deferred.push("ticket-board provisioning");
  if (ctx.local || ctx.skipSystemd) deferred.push("systemd service activation");
  const projectManifest = join(ctx.targetDir, ".project.json");
  if (!ctx.skipPlane && existsSync(projectManifest)) {
    try {
      const project = JSON.parse(readFileSync(projectManifest, "utf8")) as {
        ticket_provider?: { state?: unknown };
      };
      const state = project.ticket_provider?.state;
      if (typeof state === "string" && state !== "linked") deferred.push(`ticket board (${state})`);
    } catch {
      deferred.push("ticket board state unreadable");
    }
  }
  const rolePath = ctx.roleDir ? join(ctx.roleDir, "role.yaml") : "";
  if (rolePath && existsSync(rolePath)) {
    try {
      const role = YAML.parse(readFileSync(rolePath, "utf8")) as {
        service_state?: { gateway?: unknown; heartbeat?: unknown };
      } | null;
      const gateway = role?.service_state?.gateway;
      const heartbeat = role?.service_state?.heartbeat;
      if (typeof gateway === "string" && gateway !== "active") deferred.push(`gateway (${gateway})`);
      if (typeof heartbeat === "string" && heartbeat !== "active") deferred.push(`heartbeat (${heartbeat})`);
    } catch {
      deferred.push("service state unreadable");
    }
  } else if (!ctx.dryRun) {
    deferred.push("role service state unavailable");
  }
  return [...new Set(deferred)];
}

async function summaryResult(ctx: LifecycleContext): Promise<RecipeInitResult> {
  const summary = await new PrintHermesSummary(ctx).invoke();
  return {
    recipeId: "hermes-agent",
    ok: summary.success,
    dryRun: Boolean(ctx.dryRun),
    changedFiles: [],
    logs: summary.message ? [summary.message] : [],
    errors: summary.success ? [] : [summary.message || "Hermes summary could not be rendered"],
    phases: [{
      id: "hermes.summary",
      status: summary.success ? "unchanged" : "failed",
      changedFiles: [],
      message: summary.message || undefined,
    }],
  };
}

/**
 * Recipe that provisions a Hermes agent role into the current project repo.
 *
 * Chain (each command mutates the shared context):
 *   1. PromptForAgentConfig  — collect/default effect-free inputs
 *   2. ValidateHermesOptions — reject unsupported or destructive modes
 *   3. EnsureTemplateConfig  — bootstrap/merge the pinned host config schema
 *   4. RunCopierTemplate     — render the pinned vendored Copier template
 *   5. UntrackHermesRuntimes — keep runtime state out of the repository
 *   6. WireTelegram          — BotFather token capture (skippable)
 *   7. WireEmail             — defense-in-depth unsupported-option guard
 *
 * PrintHermesSummary is deliberately not an ingredient. It runs only after
 * the final postcondition audit, so presentation can never outrun reality.
 *
 * We deliberately swallow the base Recipe's "✓/⚠️ created file" line — our
 * commands print their own rich status via @clack/prompts, and we don't want
 * doubled output.
 */
export class HireRecipe extends Recipe {
  readonly checks = createHermesChecks();
  readonly metadata: RecipeMetadata = {
    id: "hire",
    name: "hire",
    description: "Bring on an employee and prove they are seated",
    dependencies: [],
    commands: [
      "PromptForAgentConfig",
      "ValidateHermesOptions",
      "EnsureTemplateConfig",
      "RunCopierTemplate",
      "UntrackHermesRuntimes",
      "WireTelegram",
      "WireEmail",
      "PrintHermesSummary (postconditions only)",
    ],
    publicRuleIds: this.checks.map((check) => check.id),
  };

  /** Onboarding sequencing is fatal/cancel short-circuiting under registry init. */
  override async init(ctx: LifecycleContext, _input: unknown): Promise<RecipeInitResult> {
    const phases: RecipePhaseOutcome[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const changedFiles: string[] = [];

    // Resolve constructors lazily at dispatch time. The bundled CLI also
    // imports EnsureTemplateConfig directly for `config bootstrap`; capturing
    // that binding while the singleton catalog is being evaluated would store
    // `undefined` before the command module finishes initializing.
    const ingredients = [
      PromptForAgentConfig,
      ValidateHermesOptions,
      EnsureTemplateConfig,
      RunCopierTemplate,
      UntrackHermesRuntimes,
      WireTelegram,
      WireEmail,
    ] as const;
    for (const [ingredientIndex, CommandClass] of ingredients.entries()) {
      if (typeof CommandClass !== "function") {
        throw new TypeError(`Hermes ingredient ${ingredientIndex} is not constructable`);
      }
      const before = ctx.dryRun ? undefined : snapshotTree(ctx.targetDir);
      const result = await new CommandClass(ctx).invoke();
      const observedChanges = before ? changedTreePaths(ctx.targetDir, before, snapshotTree(ctx.targetDir)) : [];
      let status: RecipePhaseStatus = result.outcome ?? (result.success
        ? (ctx.dryRun && result.filePath ? "planned" : result.filePath ? "changed" : "unchanged")
        : "failed");
      if (result.success && !ctx.dryRun && observedChanges.length) status = "changed";
      const declaredChanges = status === "changed" && result.filePath ? [resolve(ctx.targetDir, result.filePath)] : [];
      const actualChanges = [...new Set([...observedChanges, ...declaredChanges])].sort();
      phases.push({ id: CommandClass.name, status, changedFiles: actualChanges, message: result.message || undefined });
      changedFiles.push(...actualChanges);
      if (result.message) logs.push(result.message);
      if (status === "failed" || status === "cancelled") {
        errors.push(result.message || `${CommandClass.name} ${status}`);
        break;
      }

      // Copier's trusted, version-locked inputs were attested before launch.
      // Validate its repo-local projection before any deferred config/profile/
      // fleet effect runs, so a structural lifecycle failure cannot first be
      // discovered after host state has changed.
      if (!ctx.dryRun && CommandClass === RunCopierTemplate && (ctx as HermesAgentContext).deferredExternalEffects) {
        const hermesContext = ctx as HermesAgentContext;
        const eligibility = hermesContext.roleDir
          && hermesContext.targetRepo
          && hermesContext.role
          && hermesContext.agentId
          ? preflightRenderedHermes({
              pjanglerRoot: ctx.pjanglerRoot,
              targetDir: ctx.targetDir,
              roleDir: hermesContext.roleDir,
              targetRepo: hermesContext.targetRepo,
              role: hermesContext.role,
              agentId: hermesContext.agentId,
            })
          : { ok: false, error: "Hermes render did not establish role identity" };
        phases.push({
          id: "hermes.rendered-eligibility",
          status: eligibility.ok ? "unchanged" : "failed",
          changedFiles: [],
          message: eligibility.ok ? "Rendered Hermes lifecycle eligibility passed" : eligibility.error,
        });
        if (!eligibility.ok) {
          errors.push(`hermes.rendered-eligibility: ${eligibility.error ?? "unknown eligibility failure"}`);
          break;
        }

        const beforeHost = snapshotTree(ctx.targetDir);
        const host = await new ApplyDeferredHostEffects(ctx).invoke();
        const hostChanges = changedTreePaths(ctx.targetDir, beforeHost, snapshotTree(ctx.targetDir));
        phases.push({
          id: "hermes.host-effects",
          status: host.success ? (hostChanges.length ? "changed" : "unchanged") : "failed",
          changedFiles: host.success ? hostChanges : [],
          message: host.message || undefined,
        });
        changedFiles.push(...hostChanges);
        if (host.message) logs.push(host.message);
        if (!host.success) {
          errors.push(host.message || "Deferred Hermes host effects failed");
          break;
        }
      }
    }

    const commandResult: RecipeInitResult = {
      recipeId: this.metadata.id,
      ok: errors.length === 0,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [...new Set(changedFiles)].sort(),
      logs,
      errors,
      phases,
    };
    if (!commandResult.ok) return commandResult;
    const lifecycle = await this.initializeOwnedChecks(ctx);
    const localResult = mergeInitResults(this.metadata.id, Boolean(ctx.dryRun), [commandResult, lifecycle]);
    if (!localResult.ok) return localResult;

    const hermesContext = ctx as HermesAgentContext;
    if (ctx.dryRun) {
      hermesContext.deploymentOutcome = "planned";
      hermesContext.deploymentDeferrals = deploymentDeferrals(hermesContext);
      hermesContext.deploymentPostconditions = ["dry-run made no repository or host changes"];
      return mergeInitResults(this.metadata.id, true, [localResult, await summaryResult(ctx)]);
    }

    const selected = hermesContext.deferredExternalEffects;
    // The Project recipe owns external dispatch and the whole-project audit for
    // MCP project transactions. It is the only caller that returns before this
    // recipe's final direct-command presentation.
    if (selected?.owner === "project" || (ctx.quiet && !selected)) return localResult;

    let appliedResult = localResult;
    if (selected?.owner === "hermes" && (selected.ticketBoard || selected.systemd)) {
      const beforeExternal = snapshotTree(ctx.targetDir);
      const external = await new ApplyDeferredExternalEffects(ctx).invoke();
      const externalChanges = changedTreePaths(ctx.targetDir, beforeExternal, snapshotTree(ctx.targetDir));
      const externalResult: RecipeInitResult = {
        recipeId: this.metadata.id,
        ok: external.success,
        dryRun: false,
        changedFiles: externalChanges,
        logs: external.message ? [external.message] : [],
        errors: external.success ? [] : [external.message || "Deferred Hermes external effects failed"],
        phases: [{
          id: "hermes.external-effects",
          status: external.success ? "changed" : "failed",
          changedFiles: external.success ? externalChanges : [],
          message: external.message || undefined,
        }],
      };
      appliedResult = mergeInitResults(this.metadata.id, false, [localResult, externalResult]);
      if (!externalResult.ok) return appliedResult;
    }

    // Copier exit zero is not deployment success. Re-audit every employee-owned
    // invariant, then ASK pjangler about the two project contracts this command
    // changes or depends on rather than auditing them ourselves.
    //
    // A probe that cannot reach `pj` reports `unableToAssess`, which is surfaced
    // and does NOT fail the hire. Flume never hard-depends on pjangler being
    // installed; requiring it would rebuild, in the opposite direction, exactly
    // the cycle this split exists to break.
    const projectContracts = probeProjectContracts(ctx.repoRoot ?? ctx.targetDir);
    const findings = (await this.audit(ctx))
      .filter((finding) => finding.status !== "pass" && finding.status !== "skip");
    const contractErrors = projectContracts.standing === "onNotice" ? projectContracts.details : [];
    const contractWarnings = projectContracts.standing === "unableToAssess" ? projectContracts.details : [];
    const verification: RecipeInitResult = {
      recipeId: this.metadata.id,
      ok: findings.length === 0 && contractErrors.length === 0,
      dryRun: false,
      changedFiles: [],
      logs: contractWarnings,
      errors: [...findings.map((finding) => `${finding.id}: ${finding.summary}`), ...contractErrors],
      phases: [{
        id: "hire.postcondition-audit",
        status: findings.length || contractErrors.length ? "failed" : "unchanged",
        changedFiles: [],
        message: findings.length || contractErrors.length
          ? "hire postcondition audit failed"
          : contractWarnings.length
            ? "hire postcondition audit passed; project contracts unable to assess"
            : "hire postcondition audit passed",
      }],
    };
    const verifiedResult = mergeInitResults(this.metadata.id, false, [appliedResult, verification]);
    if (!verification.ok) {
      hermesContext.deploymentOutcome = "failed";
      return verifiedResult;
    }

    hermesContext.deploymentDeferrals = deploymentDeferrals(hermesContext);
    hermesContext.deploymentOutcome = hermesContext.deploymentDeferrals.length ? "verified-deferred" : "verified";
    hermesContext.deploymentPostconditions = [
      "Hermes lifecycle audit passed",
      "mise PATH and canonical project manifest passed",
    ];
    return mergeInitResults(this.metadata.id, false, [verifiedResult, await summaryResult(ctx)]);
  }

  protected printNextSteps(): void {
    // PrintHermesSummary handles this via the recipe chain.
  }
}
