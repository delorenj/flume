#!/usr/bin/env node
/**
 * `flume` -- the workforce CLI.
 *
 * Hires, onboards and reviews the agents that do the work. This surface used to
 * be `pj hermes-agent` and `pj fleet *` inside pjangler; it is here now because
 * pjangler is a project bootstrapper and registry, and an employee is not a
 * project.
 */

import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";

import { guardBrokenPipe, writeStdout, exitAfterFlush } from "./utils/stdout";

// Workforce portable named agents API
export * from "./workforce/index";

import { registerOrgCli, isOrgJsonInvocation, orgParserFailureEnvelope } from "./org/cli";
import { fleetEnvelopeExitCode, renderFleetJson } from "./org/output";
import { recipeRegistry } from "./parity/catalog";
import { lifecycleContext, runAudit, runMigrationForRules } from "./parity/index";
import { formatAuditReport, formatMigrationReport, SCAFFOLD_SCRIPTS_ONLY_ENV, type MigrationReport } from "./parity/rules";
import { REGISTER_PROJECTS_ENV } from "./parity/reconcile";
import { SOUL_TONES, type HermesAgentContext } from "./hire/types";
import { offboardEmployee, formatOffboardResult } from "./hire/offboard";
import { EnsureTemplateConfig } from "./hire/EnsureTemplateConfig";
import { hireSpecialist, auditSpecialist, launchSpecialist } from "./workforce/specialist";
import { adoptNativeActor, bindProvider, enrollEmployee, setEmployeeStatus, showEmployeeIdentity } from "./workforce/company";
import { provisionEmployee } from "./workforce/provision";
import { identityReadiness } from "./workforce/readiness";
import { effectiveRecall, readRecency, touchProject } from "./workforce/recency";
import { accessConfigPath, execWithGithubToken, githubInspect, loadAccessConfig, printableResult, requestAccess, startAccessServer } from "./workforce/access";
import { githubApiBase, githubEvidence } from "./workforce/github";
import { formatCommentResult, postComment, verifyComments } from "./workforce/comment";
import { formatPlaneCommentResult, verifyPlaneComments } from "./workforce/plane";
import { runEmployeeCommand } from "./workforce/launcher";
import { homedir } from "node:os";
import { join } from "node:path";

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
  .option("--definition <file>", "Hire a portable specialist from its named definition")
  .option("--json", "Output machine-parseable JSON")
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
    if (options.definition) { await specialistResult(() => hireSpecialist(options.definition, false, options), options.json); return; }
    await runHire(title, options);
  });

program
  .command("onboard")
  .argument("[title]", "Job title to onboard", "pm")
  .description("Re-run the onboarding checklist for an existing employee; convergent by contract")
  .option("--definition <file>", "Refresh a portable specialist from a changed definition")
  .option("--employee <id>", "Refresh the owning workforce agent.yaml")
  .option("--json", "Output machine-parseable JSON")
  .option("-y, --yes", "Non-interactive defaults", true)
  .option("--target-repo <name>", "Target repo name (default: basename of cwd)")
  .option("--skip-telegram", "Skip the Telegram wire-up")
  .option("--skip-plane", "Skip creating or linking the ticket board")
  .option("--skip-systemd", "Skip installing systemd --user units")
  .option("--local", "Local-only: defer ticket-board creation and systemd")
  .option("--dry-run", "Preview what would run; don't execute copier")
  .action(async (title: string, options) => {
    if (options.definition || options.employee) {
      if (options.employee && !/^[a-z0-9][a-z0-9_-]{0,57}$/u.test(options.employee)) {
        await specialistResult(async () => { throw new Error("Unsafe employee identity"); }, options.json); return;
      }
      if (options.employee && options.definition) {
        await specialistResult(async () => { throw new Error("Choose --employee or --definition"); }, options.json); return;
      }
      const path = options.definition || join(process.env.HOME || homedir(), ".agents/workforce", options.employee, "agent.yaml");
      await specialistResult(() => hireSpecialist(path, true, { ...options, expectedEmployee: options.employee }), options.json); return;
    }
    // Onboarding IS hiring, run again. Every step is marker-guarded and the
    // registry write is an upsert, so a second pass is a no-op that proves the
    // first one held. `--force` is deliberately not offered: onboarding an
    // employee must never be a way to overwrite one.
    await runHire(title, { ...options, yes: true, force: false, onboard: true });
  });

async function specialistResult(action: () => Promise<unknown>, json: boolean): Promise<void> {
  guardBrokenPipe();
  try {
    const result = await action() as { ok: boolean };
    await writeStdout(`${JSON.stringify(result, null, json ? 2 : undefined)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    const result = { ok: false, standing: "unable to assess", error: (error as Error).message };
    await writeStdout(`${JSON.stringify(result, null, json ? 2 : undefined)}\n`);
    process.exitCode = 1;
  }
}

program.command("launch")
  .argument("<employee>", "Portable specialist identity")
  .argument("[hermesArgs...]", "Hermes CLI arguments following --")
  .option("--cwd <directory>", "Working directory (default: caller's current directory)")
  .description("Launch Hermes with a portable employee's charter, loadout and personal memory")
  .action(async (employee: string, args: string[], options) => {
    try { process.exitCode = await launchSpecialist(employee, args, options.cwd); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  });

async function runHire(title: string, options: Record<string, unknown>): Promise<void> {
  const isDarwin = process.platform === "darwin";
  const local = Boolean(options.local ?? false);
  const context: HermesAgentContext = {
    targetDir: process.cwd(),
    onboard: Boolean(options.onboard),
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
// COMPANY IDENTITY
// ============================================================================
//
// Who an employee is to the company: one subject and `<handle>@agents.delo.sh`
// on the definition the employee already owns. `enroll` and `status` preview
// unless `--apply`; a blocker writes nothing and exits 1.

const collect = (value: string, previous: string[] = []) => [...previous, value];

const identityCmd = program
  .command("identity")
  .description("Company identity: one subject and address per employee, on the definition they already own");

async function identityResult(action: () => Promise<{ ok: boolean }>, json: boolean): Promise<void> {
  guardBrokenPipe();
  let result: { ok: boolean };
  try { result = await action(); }
  catch (error) { result = { ok: false, error: (error as Error).message } as { ok: boolean }; }
  await writeStdout(json ? `${JSON.stringify(result, null, 2)}\n` : formatIdentityResult(result as Record<string, any>));
  await exitAfterFlush(result.ok ? 0 : 1);
}

function formatIdentityResult(result: Record<string, any>): string {
  const lines: string[] = [];
  if (result.error) lines.push(`✗ ${result.error}`);
  if (result.definition) lines.push(`${result.employee}: ${result.kind} definition ${result.definition}${result.person ? ` (person ${result.person})` : ""}`);
  if (result.identity) lines.push(`  subject ${result.identity.subject}  ${result.identity.email}  ${result.identity.status}`);
  else if (result.enrolled === false && result.ok) lines.push("  not enrolled");
  if (result.from !== undefined) lines.push(`  status ${result.from ?? "none"} -> ${result.to}${result.apply ? "" : " (preview)"}`);
  if (result.changed !== undefined && result.ok) lines.push(`  ${result.changed ? (result.apply ? "written" : "would change (preview; pass --apply)") : "no change"}`);
  for (const write of result.writes ?? []) lines.push(`  wrote ${write}`);
  if (result.receipt) lines.push(`  receipt ${result.receipt}`);
  for (const board of result.boards ?? []) lines.push(`  board ${board.identifier} (${board.id}) verified by Pilot`);
  if (result.actor?.id && result.provider === "plane") lines.push(`  native user ${result.actor.id} (${result.actor.email}) evidence ${result.evidence}${result.credential ? `; static ${result.credential.type}, expiry not observable` : ""}`);
  for (const step of result.enrollment?.prerequisites ?? []) lines.push(`  enroll: ${step}`);
  if (result.credentials?.plane) lines.push(`  plane credential: static ${result.credentials.plane.type}, expiry observable ${String(result.credentials.plane.expiry?.observable)}, ${result.credentials.plane.verified ? "verified by Pilot" : "not verified"}`);
  for (const blocker of result.blockers ?? []) lines.push(`  ✗ ${blocker.code}: ${blocker.detail}`);
  for (const [name, cap] of Object.entries(result.capabilities ?? {}) as [string, any][]) lines.push(`  ${name}: ${cap.action} — ${cap.detail}`);
  for (const candidate of result.reconcile ?? []) lines.push(`  reconcile ${candidate.provider} ${candidate.principal} (${candidate.state}) ${candidate.description ?? ""}`.trimEnd());
  for (const warning of result.warnings ?? []) lines.push(`  ! ${warning}`);
  for (const [name, check] of Object.entries(result.checks ?? {}) as [string, any][]) {
    lines.push(`${name}: ${check.status}, not ready — ${check.detail}`);
    for (const e of check.evidence) lines.push(`  GET ${e.path} -> ${e.http_status ?? "no response"} at ${e.observed_at}${e.error ? ` (${e.error})` : ` ${JSON.stringify(e.measured)}`}`);
  }
  for (const [name, state] of Object.entries(result.probes ?? {})) lines.push(`probe ${name}: ${state}`);
  if (result.note) lines.push(result.note);
  return `${lines.join("\n")}\n`;
}

identityCmd
  .command("enroll")
  .argument("<employee>", "Registry id, unhired specialist, or person name")
  .description("Give an existing employee one persistent subject and address on their own definition")
  .option("--handle <handle>", "Handle to enroll under (default: the person's name; immutable once enrolled)")
  .option("--apply", "Write the enrollment (default is a preview)")
  .option("--json", "Output machine-parseable JSON")
  .action(async (employee: string, options) => {
    await identityResult(() => enrollEmployee(employee, { apply: Boolean(options.apply), handle: options.handle }), options.json);
  });

identityCmd
  .command("show")
  .argument("<employee>", "Registry id, unhired specialist, or person name")
  .description("Read an employee's company identity; legacy definitions stay readable")
  .option("--json", "Output machine-parseable JSON")
  .action(async (employee: string, options) => {
    await identityResult(async () => showEmployeeIdentity(employee), options.json);
  });

identityCmd
  .command("status")
  .argument("<employee>", "Registry id, unhired specialist, or person name")
  .argument("<status>", "active | suspended | retired (retired is terminal)")
  .description("Record local employment status; provider access is not revoked here")
  .option("--apply", "Write the change (default is a preview)")
  .option("--json", "Output machine-parseable JSON")
  .action(async (employee: string, status: string, options) => {
    await identityResult(() => setEmployeeStatus(employee, status, { apply: Boolean(options.apply) }), options.json);
  });

identityCmd
  .command("provision")
  .argument("<employee>", "Registry id, unhired specialist, or person name")
  .description("FLUME-56: live provider accounts for an enrolled employee — Access service token, mailbox rule + allowlist, vault item (preview unless --apply)")
  .option("--apply", "Perform the provider mutations (default is a preview)")
  .option("--json", "Output machine-parseable JSON")
  .action(async (employee: string, options) => {
    await identityResult(() => provisionEmployee(employee, { apply: Boolean(options.apply) }), options.json);
  });

identityCmd
  .command("bind")
  .argument("<employee>", "Registry id, unhired specialist, or person name")
  .argument("<provider>", "Provider key, e.g. github or plane")
  .description("FLUME-50/52: bind one provider principal to an enrolled employee, by reference only (preview unless --apply). github: principal = App ID, instance = installation ID, credential-ref = op://<vault>/<item-uuid>/<field-id> of the App private key. plane: principal = the native Plane user UUID, instance = https://<host>/<workspace>, credential-ref = the employee's own PAT by item UUID and field ID (Flume never creates a Plane user or token)")
  .option("--principal <id>", "Provider principal (github: the numeric App ID; plane: the native user UUID)")
  .option("--instance <id>", "Provider instance (github: the numeric installation ID; plane: https://<host>/<workspace-slug>)")
  .option("--credential-ref <ref>", "op:// reference to the credential; never a value")
  .option("--attribution-mode <mode>", "native | shared_bot_attributed")
  .option("--apply", "Write the binding (default is a preview)")
  .option("--json", "Output machine-parseable JSON")
  .action(async (employee: string, provider: string, options) => {
    await identityResult(() => bindProvider(employee, provider, { principal: options.principal, instance: options.instance, credentialRef: options.credentialRef, attributionMode: options.attributionMode }, { apply: Boolean(options.apply) }), options.json);
  });

identityCmd
  .command("adopt-actor")
  .argument("<employee>", "Registry id, unhired specialist, or person name")
  .argument("<provider>", "Provider key; github or plane")
  .description("FLUME-51/52: record the native actor ID on the employee's binding, as the provider reports it (preview unless --apply). github: the bot user ID of the employee's own App. plane: the native user UUID, verified by Pilot (`px identity verify`) on every --board. Never mints a token")
  .option("--board <board>", "plane: board identifier or UUID to verify membership on; repeatable, every board must pass", collect)
  .option("--apply", "Write native_actor_id (default is a preview)")
  .option("--json", "Output machine-parseable JSON")
  .action(async (employee: string, provider: string, options) => {
    await identityResult(() => adoptNativeActor(employee, provider, { apply: Boolean(options.apply), boards: options.board }), options.json);
  });

identityCmd
  .command("readiness")
  .description("What is unproven about the accounts company identity needs; never ready, never free")
  .option("--probe <provider>", "Measure with read-only GET requests (cloudflare; token from CLOUDFLARE_API_TOKEN)", (value: string, previous: string[] = []) => [...previous, value])
  .option("--json", "Output machine-parseable JSON")
  .action(async (options) => {
    await identityResult(() => identityReadiness({ probe: options.probe }), options.json);
  });

identityCmd
  .command("recent")
  .argument("<employee>", "Registry id, unhired specialist, or person name (must be a NAMED person)")
  .description("The recall compass: the named agent's last 5 projects, most-recent-first")
  .option("--touch <project>", "Record an interaction with this project (preview unless --apply)")
  .option("--at <iso8601>", "Interaction timestamp (default: now)")
  .option("--source <label>", "Interaction source label", "manual")
  .option("--apply", "Write the touch (default is a preview)")
  .option("--json", "Output machine-parseable JSON")
  .action(async (employee: string, options) => {
    if (options.touch) {
      await identityResult(() => touchProject(employee, options.touch, { apply: Boolean(options.apply), at: options.at, source: options.source }), options.json);
    } else {
      await identityResult(async () => readRecency(employee), options.json);
    }
  });

identityCmd
  .command("recall")
  .argument("<employee>", "Registry id, unhired specialist, or person name (must be a NAMED person)")
  .description("Effective personal recall list: write bank, then declared banks most-recently-interacted first")
  .option("--narrow", "Intersect the declared set with recent projects instead of re-ordering")
  .option("--json", "Output machine-parseable JSON")
  .action(async (employee: string, options) => {
    await identityResult(async () => effectiveRecall(employee, { narrow: Boolean(options.narrow) }), options.json);
  });

// ============================================================================
// EMPLOYEE ACCESS
// ============================================================================
//
// Authenticate who is asking, independently of the harness. `serve` is the
// facade; `run` and `launch` are the trusted launchers; `request` is the plain
// client. Fixture grants for every service but github, which mints a real
// single-repository installation token for the employee's own App.

const accessCmd = program
  .command("access")
  .description("Employee access: authenticate requests by Cloudflare Access assertion plus a launcher-signed run");

accessCmd
  .command("serve")
  .description("Run the access facade (fixture grants; GitHub App installation tokens for service github); put Cloudflare Access in front of it")
  .option("--config <path>", "Access configuration (default: FLUME_ACCESS_CONFIG or ~/.config/flume/employee-access.yaml)")
  .option("--host <host>", "Listen host (default: config listen.host or 127.0.0.1)")
  .option("--port <port>", "Listen port (default: config listen.port or 8787)", (value: string) => Number(value))
  .action(async (options) => {
    try {
      const configPath = options.config ?? accessConfigPath();
      const { server, url } = await startAccessServer(loadAccessConfig(configPath), { host: options.host, port: options.port, configPath });
      await writeStdout(`${JSON.stringify({ event: "listening", url, github_api_base: githubApiBase() })}\n`);
      const stop = () => server.close(() => process.exit(0));
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    } catch (error) {
      console.error((error as Error).message);
      await exitAfterFlush(1);
    }
  });

accessCmd
  .command("run")
  .argument("<employee>", "Enrolled employee (registry id, desk name or person)")
  .argument("<command...>", "Command to run, after --")
  .option("--cwd <directory>", "Working directory (default: caller's current directory)")
  .description("Run any command as an enrolled employee with only that employee's access (trusted launcher)")
  .action(async (employee: string, command: string[], options) => {
    try { process.exitCode = await runEmployeeCommand(employee, command, options.cwd); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  });

accessCmd
  .command("request")
  .argument("[command...]", "With --exec: the consumer to run, after --")
  .description("Request access as the launched employee; identity comes from the launcher's environment, never a flag")
  .requiredOption("--service <service>", "Service the access is for")
  .requiredOption("--resource <resource>", "Resource within the service (github: owner/repo)")
  .requiredOption("--permission <permission>", "Permission wanted (repeatable; github: <name>:<read|write>)", (value: string, previous: string[] = []) => [...previous, value])
  .option("--lifetime <seconds>", "Requested lifetime in seconds (not supported for github)", (value: string) => Number(value))
  .option("--request-id <id>", "Idempotency key (default: a fresh one)")
  .option("--employee <employee>", "May only repeat the authenticated employee; anything else is denied")
  .option("--exec", "Run the consumer after -- with the granted GitHub token as GH_TOKEN/GITHUB_TOKEN; the token is never printed")
  .action(async (command: string[], options) => {
    guardBrokenPipe();
    try {
      const github = options.service === "github";
      if (github && !options.exec) throw new Error("service github delivers its token only with --exec -- <consumer>; a GitHub token is never printed");
      if (options.exec && !github) throw new Error("--exec delivers a GitHub installation token; use it with --service github");
      if (options.exec && !command.length) throw new Error("--exec needs a consumer after --");
      if (!options.exec && command.length) throw new Error("A command after -- needs --exec");
      const result = await requestAccess({ service: options.service, resource: options.resource, permissions: options.permission, lifetimeSeconds: options.lifetime, requestId: options.requestId, employee: options.employee });
      if (options.exec && result.body.status === "granted") {
        // stdout belongs to the consumer: the redacted receipt goes to stderr.
        process.stderr.write(`${JSON.stringify(printableResult(result.body), null, 2)}\n`);
        await exitAfterFlush(await execWithGithubToken(result.body, command));
        return;
      }
      await writeStdout(`${JSON.stringify(printableResult(result.body), null, 2)}\n`);
      await exitAfterFlush(result.body.status === "granted" ? 0 : 1);
    } catch (error) {
      await writeStdout(`${JSON.stringify({ ok: false, status: "error", error: (error as Error).message }, null, 2)}\n`);
      await exitAfterFlush(1);
    }
  });

accessCmd
  .command("github-inspect")
  .description("Read-only discovery of a GitHub App and its installations (app-JWT GETs only; never mints, writes or adopts)")
  .option("--employee <employee>", "Inspect the App in this employee's github binding")
  .option("--app-id <id>", "Inspect this App (with --key-ref)")
  .option("--key-ref <ref>", "op:// reference to the App private key (with --app-id)")
  .option("--json", "Output machine-parseable JSON")
  .action(async (options) => {
    guardBrokenPipe();
    let report: Awaited<ReturnType<typeof githubInspect>>;
    try { report = await githubInspect({ employee: options.employee, appId: options.appId, keyRef: options.keyRef }); }
    catch (error) { report = { ok: false, observed_at: new Date().toISOString(), evidence: githubEvidence(), error: (error as Error).message }; }
    const lines = report.ok && report.app
      ? [`app ${report.app.id} ${report.app.slug} (client ${report.app.client_id ?? "?"}) owned by ${report.app.owner.login ?? "?"}`, `bot_login ${report.bot_login}`, ...(report.installations ?? []).map(i => `installation ${i.id}: ${i.account ?? "?"} (${i.repository_selection ?? "?"}) ${i.suspended ? "SUSPENDED " : ""}${Object.entries(i.permissions).map(([k, v]) => `${k}:${v}`).join(",")}`), ...(report.truncated ? ["(installation list truncated)"] : []), `observed_at ${report.observed_at} evidence ${report.evidence}`]
      : [`✗ ${report.error}`];
    await writeStdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${lines.join("\n")}\n`);
    await exitAfterFlush(report.ok ? 0 : 1);
  });

// ============================================================================
// REVIEW COMMENTS WITH VERIFIED AUTHORSHIP (FLUME-51)
// ============================================================================
//
// Consumers of the FLUME-50 installation token: run them as
//   flume access run <e> -- flume access request --service github --resource o/r --permission ... --exec -- flume comment post ...
// They need the GH_TOKEN and FLUME_* environment `--exec` sets, and nothing else.

const commentCmd = program
  .command("comment")
  .description("Leave and verify GitHub comments as the launched employee; authorship is whatever GitHub reads back, never text");

commentCmd
  .command("post")
  .argument("<repository>", "owner/repo (must be the repository the token was granted for)")
  .argument("<number>", "Pull request or issue number")
  .description("Post one marked comment (conversation, or a single-line inline review comment with --review) and read it back from GitHub; at most one POST per invocation")
  .option("--body <text>", "Comment text")
  .option("--body-file <path>", "Read the comment text from a file")
  .option("--marker <key>", "Idempotency marker, 8-128 of [A-Za-z0-9._-] (default: a fresh UUID); re-run with the same one after comment-ambiguous")
  .option("--review", "Post an inline review comment on the PR head instead of a conversation comment")
  .option("--commit <sha>", "With --review: the full head SHA being reviewed")
  .option("--path <file>", "With --review: the file path")
  .option("--line <n>", "With --review: the single line")
  .option("--side <side>", "With --review: RIGHT (default) or LEFT")
  .option("--start-line <n>", "Refused: multi-line ranges are unsupported")
  .option("--position <n>", "Refused: diff positions are unsupported")
  .option("--subject-type <type>", "Refused: file-level comments are unsupported")
  .option("--event <event>", "Refused: review events are unsupported")
  .option("--json", "Output machine-parseable JSON")
  .action(async (repository: string, number: string, options) => {
    guardBrokenPipe();
    const unsupported = [["startLine", "--start-line"], ["position", "--position"], ["subjectType", "--subject-type"], ["event", "--event"]].filter(([key]) => options[key!] !== undefined).map(([, flag]) => flag!);
    const result = await postComment({ repository, number, body: options.body, bodyFile: options.bodyFile, marker: options.marker, review: Boolean(options.review), commit: options.commit, path: options.path, line: options.line, side: options.side, unsupported });
    await writeStdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatCommentResult(result)}\n`);
    await exitAfterFlush(result.ok ? 0 : 1);
  });

commentCmd
  .command("verify")
  .argument("<repository>", "owner/repo (must be the repository the token was granted for)")
  .description("Read each comment from GitHub and report whether the named employees' own distinct bots wrote them (read-only; native-distinct-verified or not-native-distinct)")
  .requiredOption("--comment <employee:kind:id>", "<employee>:<issue|review>:<comment id>, repeatable; any other kind (commit, ...) is unsupported-evidence", collect)
  .option("--json", "Output machine-parseable JSON")
  .action(async (repository: string, options) => {
    guardBrokenPipe();
    const result = await verifyComments({ repository, comments: options.comment });
    await writeStdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatCommentResult(result)}\n`);
    await exitAfterFlush(result.ok ? 0 : 1);
  });

commentCmd
  .command("verify-plane")
  .argument("<ref>", "ticket ref, e.g. TEST-14")
  .description("FLUME-52: read a ticket's comments through Pilot (`px show`) and report whether the named employees' own distinct native Plane users wrote them (read-only on Plane; receipt only with --apply)")
  .requiredOption("--comment <employee:comment-id>", "<employee>:<comment uuid>, repeatable", collect)
  .option("--apply", "Append a receipt to plane-verifications.jsonl (default is read-only)")
  .option("--json", "Output machine-parseable JSON")
  .action(async (ref: string, options) => {
    guardBrokenPipe();
    const result = verifyPlaneComments({ ref, comments: options.comment, apply: Boolean(options.apply) });
    await writeStdout(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatPlaneCommentResult(result)}\n`);
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
  .option("--employee <id>", "Audit an owned portable specialist without a repository")
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
    if (options.employee) { await specialistResult(() => auditSpecialist(options.employee), options.json); return; }
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

const thisFile = resolve(fileURLToPath(import.meta.url));
const thisDir = dirname(thisFile);
const pkgRoot = resolve(thisDir, "..");
const validEntries = new Set([
  thisFile,
  resolve(pkgRoot, "dist", "index.js"),
  resolve(pkgRoot, "src", "index.ts"),
]);
const arg1 = process.argv[1] ? resolve(process.argv[1]) : "";
const arg1Base = arg1 ? basename(arg1) : "";
const isCliEntry = Boolean(
  arg1 && (
    validEntries.has(arg1) ||
    arg1Base === "flume" ||
    arg1Base === "fl"
  )
);

if (isCliEntry) {
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
}
