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

import { guardBrokenPipe, writeStdout, exitAfterFlush } from "./utils/stdout";

import { registerOrgCli, isOrgJsonInvocation, orgParserFailureEnvelope } from "./org/cli";
import { fleetEnvelopeExitCode, renderFleetJson } from "./org/output";
import { recipeRegistry } from "./parity/catalog";
import { lifecycleContext, runAudit, runMigrationForRules } from "./parity/index";
import { formatAuditReport, formatMigrationReport, SCAFFOLD_SCRIPTS_ONLY_ENV, type MigrationReport } from "./parity/rules";
import { REGISTER_PROJECTS_ENV } from "./parity/reconcile";
import { SOUL_TONES, type HermesAgentContext } from "./hire/types";
import { offboardEmployee, formatOffboardResult } from "./hire/offboard";
import { EnsureTemplateConfig } from "./hire/EnsureTemplateConfig";

const program = new Command();
const commandArgs = process.argv.slice(2);

// BEFORE any .command() call, and that is the whole point.
//
// Commander copies inherited settings into a subcommand when the subcommand is
// CREATED. Calling exitOverride() after the tree is built leaves every
// subcommand exiting the process itself, so the catch below never runs and a
// rejected `--json` invocation writes zero bytes -- the exact defect the
// envelope exists to prevent. Measured: `flume roster --json --bogus` printed
// nothing at all until this moved up here.
program.exitOverride();
program.configureOutput({
  writeErr: (text) => { if (!isOrgJsonInvocation(commandArgs)) process.stderr.write(text); },
});

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

program
  .command("offboard")
  .argument("<employee>", "Employee id, e.g. 33god-pm")
  .description("Remove an employee's record from the org chart")
  .option("--apply", "Write the change (default is a dry run)")
  .option("--json", "Output machine-parseable JSON")
  .action(async (employee: string, options) => {
    guardBrokenPipe();
    const result = offboardEmployee(employee, { apply: Boolean(options.apply) });
    await writeStdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatOffboardResult(result)}\n`);
    await exitAfterFlush(result.ok ? 0 : 1);
  });

// ============================================================================
// THE ORG CHART, RECORDS, REVIEWS, THE HANDBOOK
// ============================================================================

registerOrgCli(program);

// `handbook bootstrap` hangs off the namespace registerOrgCli created.
//
// It is not optional politeness: EnsureTemplateConfig writes "Bootstrapped by
// `flume handbook bootstrap`" into the header of the host config it generates,
// so the file names this command. It was `pj config bootstrap`.
const handbookCmd = program.commands.find((command) => command.name() === "handbook");
if (!handbookCmd) throw new Error("registerOrgCli did not register the handbook namespace");
handbookCmd
  .command("bootstrap")
  .description("Create ~/.config/hermes-agent-template/config.toml with host-correct defaults if missing")
  .option("--force", "Merge missing pinned-schema fields without replacing existing values")
  .option("--dry-run", "Show what would be written without writing")
  .action(async (options) => {
    const ctx: HermesAgentContext = {
      targetDir: process.cwd(),
      dryRun: Boolean(options.dryRun ?? false),
      forceConfig: Boolean(options.force ?? false),
    };
    const result = await new EnsureTemplateConfig(ctx).invoke();
    if (result.message) (result.success ? console.log : console.error)(result.message);
    if (!result.success) process.exitCode = 1;
  });

// ============================================================================
// COMPLIANCE
// ============================================================================

program
  .command("audit")
  .argument("[repo]", "Repository to audit (default: cwd)")
  .description("Compliance audit: every employee invariant this repository is subject to")
  .option("--rules <ids>", "Comma-separated rule ids; report only these")
  .option("--json", "Output machine-parseable JSON")
  // `guardBrokenPipe` BEFORE the first write, and `writeStdout` + a flushing
  // exit after it. Neither is decoration.
  //
  // On Linux `process.stdout` is asynchronous for a PIPE, so a bare write
  // followed by an exit discards whatever is still queued -- and still exits 0.
  // A small report hides it by fitting the pipe buffer; a multi-megabyte one
  // does not. And `flume audit --json | head -c 10` closes the pipe mid-write,
  // which without the guard reaches the process as an unhandled 'error' event
  // and a stack trace. This is the exact defect the fleet epic was written to
  // stop reproducing, and it was reintroduced here by a plain
  // `process.stdout.write`.
  .action(async (repo: string | undefined, options) => {
    guardBrokenPipe();
    const ruleIds = String(options.rules ?? "").split(",").map((id: string) => id.trim()).filter(Boolean);
    const report = await runAudit(repo, undefined, ruleIds);
    await writeStdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatAuditReport(report)}\n`);
    await exitAfterFlush(report.ok ? 0 : 1);
  });

/**
 * Every failing rule this run is allowed to correct, and an account of the ones
 * it is not.
 *
 * `RecipeRegistry.migrateAll` has been complete since PJAN-75 and had ZERO
 * callers: it audits, migrates every fixable fail/warn, then RE-AUDITS the
 * non-fixable ones so a rule nobody was allowed to touch is reported rather
 * than silently dropped. Wiring it is what turns a report into a repair.
 */
async function runFullRemediation(repo: string | undefined, dryRun: boolean): Promise<MigrationReport> {
  const report = await recipeRegistry.migrateAll(lifecycleContext(repo, dryRun));
  // `recipeId` is internal routing -- which recipe owns a rule -- and
  // `parity/index.ts` strips it from every other report that goes on the wire.
  // This one must not be the exception.
  return { ...report, results: report.results.map(({ recipeId: _recipeId, ...result }) => result) } as MigrationReport;
}

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
  //
  // `<finding>` became `[finding]` for `--all`, which is additive: every
  // deployed invocation still passes a rule id and a path, and still lands in
  // exactly the same call. Adding flags is safe; reshaping the argv is not.
  .alias("migrate")
  .argument("[finding]", "Rule id to correct, e.g. hermes.runtime-singleton")
  .argument("[repo]", "Repository to correct (default: cwd)")
  .description("Correct a finding, or every finding this run can correct (--all)")
  .option("--all", "Correct every fixable failing rule, and report each one it may not touch")
  .option("--register-projects", "Authorize org.project-records to create the project records it reports; without it that rule only says what it would register")
  .option("--scripts-only", "hermes.pm-scaffold only: refresh the role's .scripts/ and nothing else (no SOUL compose, wrapper, .gitignore, runtime seed, profile metadata or registry row)")
  .option("--dry-run", "Report what would change without changing it")
  .option("--json", "Output machine-parseable JSON")
  .action(async (finding: string | undefined, repo: string | undefined, options) => {
    guardBrokenPipe();
    const usage = options.all && finding
      ? "--all corrects every rule; drop the rule id, or drop --all"
      : !options.all && !finding
        ? "name a rule id to correct, or pass --all"
        : options.scriptsOnly && finding !== "hermes.pm-scaffold"
          ? "--scripts-only narrows hermes.pm-scaffold only; name that rule and drop --all"
          : null;
    if (usage) {
      await writeStdout(options.json ? `${JSON.stringify({ ok: false, error: usage }, null, 2)}\n` : "");
      console.error(`\u2717 ${usage}`);
      await exitAfterFlush(1);
      return;
    }
    // Set BEFORE the migration reads it. The gate lives in an environment key
    // rather than the lifecycle context because the context is the engine's
    // shape, shared by every recipe, and this authorization belongs to one rule.
    if (options.registerProjects) process.env[REGISTER_PROJECTS_ENV] = "1";
    if (options.scriptsOnly) process.env[SCAFFOLD_SCRIPTS_ONLY_ENV] = "1";
    const report = options.all
      ? await runFullRemediation(repo, Boolean(options.dryRun))
      : await runMigrationForRules([finding!], repo, Boolean(options.dryRun));
    await writeStdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatMigrationReport(report)}\n`);
    await exitAfterFlush(report.ok ? 0 : 1);
  });

// ============================================================================

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
