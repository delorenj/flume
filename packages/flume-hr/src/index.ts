#!/usr/bin/env node
/**
 * `flume` -- the workforce CLI.
 *
 * Hires, onboards and reviews the agents that do the work. This surface used to
 * be `pj hermes-agent` and `pj fleet *` inside pjangler; it is here now because
 * pjangler is a project bootstrapper and registry, and an employee is not a
 * project.
 */

import { Command, CommanderError } from "commander";

import { registerOrgCli, isOrgJsonInvocation, orgParserFailureEnvelope } from "./org/cli";
import { fleetEnvelopeExitCode, renderFleetJson } from "./org/output";
import { recipeRegistry } from "./parity/catalog";
import { lifecycleContext, runAudit, runMigrationForRules } from "./parity/index";
import { formatAuditReport, formatMigrationReport } from "./parity/rules";
import { SOUL_TONES, type HermesAgentContext } from "./hire/types";

const program = new Command();

program
  .name("flume")
  .description("The workforce: hire, onboard and review the agents that do the work")
  .version("1.0.0");

// ============================================================================
// HIRING
// ============================================================================

program
  .command("hire")
  .argument("[title]", "Job title to hire for", "pm")
  .description("Bring on a new employee for this repository, and prove they are seated")
  .option("-y, --yes", "Non-interactive defaults; never overwrites an existing role without --force")
  .option("--target-repo <name>", "Target repo name (default: basename of cwd)")
  .option("--purpose <text>", "One-line purpose (default: \"pm agent for <repo>\")")
  .option(`--tone <tone>`, `Personality tone (default: direct; ${SOUL_TONES.join(" | ")})`)
  .option("--model-provider <name>", 'Inference provider override ("" = inherit the shared default)')
  .option("--model-name <name>", 'Model name override ("" = inherit the shared default)')
  .option("--model-base-url <url>", 'Inference API base URL override ("" = inherit the shared default)')
  .option("--model-api-mode <mode>", 'Inference API mode override ("" = inherit the shared default)')
  .option("--model-key-env <name>", "Environment variable name holding the scoped model credential")
  .option("--skip-telegram", "Skip the Telegram wire-up (no BotFather prompt)")
  .option("--email", "Unsupported by the pinned template; rejected before any mutation")
  .option("--skip-plane", "Skip creating or linking the ticket board")
  .option("--skip-systemd", "Skip installing systemd --user units")
  .option("--local", "Local-only: defer ticket-board creation and systemd")
  .option("--force-config", "Merge missing pinned-schema fields into the host config without replacing existing values")
  .option("--dry-run", "Preview what would run; don't execute copier")
  .option("-f, --force", "Re-render even if agents/hermes/<title>/role.yaml already exists")
  .action(async (title: string, options) => {
    await runHire(title, options);
  });

program
  .command("onboard")
  .argument("[title]", "Job title to onboard", "pm")
  .description("Re-run the onboarding checklist for an existing employee; convergent by contract")
  .option("-y, --yes", "Non-interactive defaults", true)
  .option("--skip-telegram", "Skip the Telegram wire-up")
  .option("--skip-plane", "Skip creating or linking the ticket board")
  .option("--skip-systemd", "Skip installing systemd --user units")
  .option("--local", "Local-only: defer ticket-board creation and systemd")
  .option("--dry-run", "Preview what would run; don't execute copier")
  .action(async (title: string, options) => {
    // Onboarding IS hiring, run again. Every step is marker-guarded and the
    // registry write is an upsert, so a second pass is a no-op that proves the
    // first one held. `--force` is deliberately not offered: onboarding an
    // employee must never be a way to overwrite one.
    await runHire(title, { ...options, yes: true, force: false });
  });

async function runHire(title: string, options: Record<string, unknown>): Promise<void> {
  const isDarwin = process.platform === "darwin";
  const local = Boolean(options.local ?? false);
  const context: HermesAgentContext = {
    targetDir: process.cwd(),
    force: Boolean(options.force ?? false),
    dryRun: Boolean(options.dryRun ?? false),
    yes: Boolean(options.yes ?? false),
    local,
    forceConfig: Boolean(options.forceConfig ?? false),
    targetRepo: options.targetRepo as string | undefined,
    role: title,
    agentPurpose: options.purpose as string | undefined,
    soulTone: options.tone as HermesAgentContext["soulTone"],
    modelProvider: options.modelProvider as string | undefined,
    modelName: options.modelName as string | undefined,
    modelBaseUrl: options.modelBaseUrl as string | undefined,
    modelApiMode: options.modelApiMode as string | undefined,
    modelKeyEnv: options.modelKeyEnv as string | undefined,
    skipTelegram: options.skipTelegram as boolean | undefined,
    // Email is opt-in only: `--email` wires it, otherwise it is never done.
    skipEmail: options.email ? false : undefined,
    skipPlane: (options.skipPlane as boolean | undefined) ?? local,
    skipSystemd: (options.skipSystemd as boolean | undefined) ?? (local || isDarwin),
  };
  try {
    const ctx = lifecycleContext(context.targetDir, Boolean(context.dryRun), false, context);
    const result = await recipeRegistry.initRecipe("hire", ctx, context);
    for (const line of result.logs) console.log(line);
    for (const error of result.errors) console.error(`✗ ${error}`);
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error("✗ hire failed:", err);
    process.exitCode = 1;
  }
}

// ============================================================================
// THE ORG CHART, RECORDS, REVIEWS, THE HANDBOOK
// ============================================================================

registerOrgCli(program);

// ============================================================================
// COMPLIANCE
// ============================================================================

program
  .command("audit")
  .argument("[repo]", "Repository to audit (default: cwd)")
  .description("Compliance audit: every employee invariant this repository is subject to")
  .option("--rules <ids>", "Comma-separated rule ids; report only these")
  .option("--json", "Output machine-parseable JSON")
  .action(async (repo: string | undefined, options) => {
    const ruleIds = String(options.rules ?? "").split(",").map((id: string) => id.trim()).filter(Boolean);
    const report = await runAudit(repo, undefined, ruleIds);
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatAuditReport(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command("remediate")
  // `migrate` is a FROZEN compatibility alias, not a nicety.
  //
  // `20-runtime-repo.sh` runs `<bin> migrate hermes.runtime-singleton <path>
  // [--dry-run] --json`, and a copy of that script is baked into 74 role
  // directories on this machine -- against 25 rows in the registry, which is
  // all `fleet-sync.sh` iterates. Redirecting them is a one-line config change
  // (`fleet.flume_bin`), but only if this argv keeps working. Renaming the verb
  // without keeping the alias strands roughly fifty deployed copies.
  .alias("migrate")
  .argument("<finding>", "Rule id to correct, e.g. hermes.runtime-singleton")
  .argument("[repo]", "Repository to correct (default: cwd)")
  .description("Correct a finding")
  .option("--dry-run", "Report what would change without changing it")
  .option("--json", "Output machine-parseable JSON")
  .action(async (finding: string, repo: string | undefined, options) => {
    const report = await runMigrationForRules([finding], repo, Boolean(options.dryRun));
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatMigrationReport(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  });

// ============================================================================

const commandArgs = process.argv.slice(2);
program.exitOverride();
try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError
      && (error.code === "commander.helpDisplayed" || error.code === "commander.version")) {
    process.exitCode = error.exitCode;
  } else if (isOrgJsonInvocation(commandArgs)) {
    // A caller that asked for --json gets JSON even when Commander is the one
    // refusing. Without this the org commands answered a rejected argument list
    // with zero bytes and exit 1 -- outside their own exit taxonomy.
    const envelope = orgParserFailureEnvelope(commandArgs);
    process.stdout.write(renderFleetJson(envelope));
    process.exitCode = fleetEnvelopeExitCode(envelope);
  } else if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
