import type { Command } from "commander";
import {
  FLEET_CONTRACT_RELATIVE_PATH,
  loadFleetContract,
  resolveFleetContractPath,
  serializeFleetContract,
  validateFleetContract,
} from "./contract";
import { collectFleetInventory } from "./inventory";
import { collectFleetProvenance } from "./provenance";
import { createRunContext, type FleetRunContext } from "./runtime";
import { collectFleetStatus } from "./status";
import {
  boundedContext,
  boundedNotes,
  boundedValue,
  bounded,
  cappedStrings,
  diagnosticDetails,
  fleetEnvelopeExitCode,
  fleetFailureEnvelope,
  fleetSuccessEnvelope,
  formatFleetContractReport,
  formatFleetErrorReport,
  formatFleetInventoryReport,
  formatFleetProvenanceReport,
  formatFleetStatusReport,
  ignoreBrokenPipe,
  normalizeFleetError,
  redactHome,
  renderFleetJson,
  type FleetContractInspection,
  type FleetEnvelopeV1,
} from "./output";
import {
  FLEET_STATUS_DOMAINS,
  FLEET_STATUS_EXIT_CODES,
  FLEET_SUPPORTED_SCHEMA_VERSIONS,
  FleetError,
  fleetExitCode,
  type FleetDiagnostic,
  type FleetInventory,
  type FleetProvenance,
  type FleetStatus,
} from "./types";
import { writeStdout } from "../utils/stdout";

const VALIDATE_COMMAND = "fleet.contract.validate";
const INVENTORY_COMMAND = "fleet.inventory";
const PROVENANCE_COMMAND = "fleet.provenance";
const STATUS_COMMAND = "fleet.status";

interface ValidateOptions {
  contract?: string;
  json?: boolean;
}

interface InventoryOptions {
  agent?: string;
  projectRegistry?: string;
  agentRegistry?: string;
  contract?: string;
  deadlineMs?: string;
  json?: boolean;
}

type ProvenanceOptions = InventoryOptions;

interface StatusOptions extends InventoryOptions {
  domain?: string;
  live?: boolean;
  baseline?: string;
  exitCode?: boolean;
}

/** An inspection with nothing learned yet, so a failure still renders a report. */
function emptyInspection(contractPath: string, diagnostics: FleetDiagnostic[]): FleetContractInspection {
  return {
    contract_path: contractPath,
    byte_stable: false,
    schema_version: null,
    contract_version: null,
    compatibility: null,
    supported_schema_versions: { ...FLEET_SUPPORTED_SCHEMA_VERSIONS },
    authorities: [],
    projections: [],
    classifications: [],
    service_model: null,
    activation: null,
    retired: [],
    extensions: [],
    truncated: [],
    diagnostics,
  };
}

/**
 * Read and validate the contract. No writes, anywhere, on any path.
 *
 * Returns an inspection rather than throwing for contract-content problems:
 * the human report and the JSON envelope must describe the same finding set,
 * and an exception would leave the human path with nothing to print.
 */
export function inspectFleetContract(override?: string): FleetContractInspection {
  const path = resolveFleetContractPath(override);
  const shown = redactHome(path);
  const canonical = override === undefined;
  const loaded = loadFleetContract(path);
  const { diagnostics, contract, extensions } = validateFleetContract(loaded.document);
  if (!contract) return { ...emptyInspection(shown, diagnostics), extensions };

  // The TRACKED contract is the canonical artifact, so the serializer must
  // reproduce it exactly or tooling can never edit it without a spurious diff.
  // That is a hard failure. An arbitrary operator file handed in with
  // `--contract` owes nobody canonical formatting, so there it stays a fact.
  const byteStable = serializeFleetContract(loaded.document) === loaded.text;
  const findings = [...diagnostics];
  if (canonical && !byteStable) {
    findings.push({
      code: "INVALID_INPUT",
      path: "contract",
      message: "the tracked contract is not its own canonical serialization; re-save it through the yaml round trip",
    });
  }

  const context = boundedContext();
  return {
    contract_path: shown,
    byte_stable: byteStable,
    schema_version: contract.schema_version,
    contract_version: contract.contract_version,
    compatibility: { ...contract.compatibility },
    supported_schema_versions: { ...FLEET_SUPPORTED_SCHEMA_VERSIONS },
    // Every string below is printed as a row of the human report AND carried in
    // the envelope, so all of them go through `bounded` -- not just the prose
    // ones. Unbounded, an escape sequence in a `--contract` file (a candidate
    // file is operator input) reached the terminal raw, and a 30,000-character
    // field reached the envelope whole.
    authorities: Object.entries(contract.authorities).map(([id, authority]) => ({
      id,
      owner: bounded(authority.owner),
      store: bounded(authority.store),
      store_env: cappedStrings(authority.store_env, context, `authorities.${id}.store_env`),
      read_only: authority.read_only === true,
      writable_fields: cappedStrings(authority.writable_fields, context, `authorities.${id}.writable_fields`),
      notes: boundedNotes(authority.notes, context, `authorities.${id}.notes`),
    })),
    projections: contract.projections.map((projection) => ({
      field: bounded(projection.field),
      source: bounded(projection.source),
      target: bounded(projection.target),
      direction: bounded(projection.direction),
      writable_by: bounded(projection.writable_by),
    })),
    classifications: Object.entries(contract.classifications).map(([id, classification]) => ({
      id,
      required_fields: [...classification.required_fields],
      entry_count: classification.entries.length,
      entries: classification.entries.map((entry, index) => boundedValue(entry, context, `classifications.${id}.entries[${index}]`) as Record<string, unknown>),
    })),
    service_model: boundedValue(contract.service_model, context, "service_model") as Record<string, unknown>,
    activation: boundedValue(contract.activation, context, "activation") as Record<string, unknown>,
    retired: contract.retired.map((mode, index) => ({
      id: bounded(mode.id),
      reason: bounded(mode.reason),
      superseded_by: bounded(mode.superseded_by),
      detect: cappedStrings(mode.detect, context, `retired[${index}].detect`),
    })),
    extensions: extensions.map((extension) => ({
      path: bounded(extension.path),
      value: boundedValue(extension.value, context, extension.path),
    })),
    truncated: context.truncated,
    diagnostics: findings,
  };
}

function validateEnvelope(inspection: FleetContractInspection): FleetEnvelopeV1 {
  const first = inspection.diagnostics[0];
  if (!first) {
    // Not "run the command you just ran". The useful next step after a clean
    // contract is the work the contract unblocks.
    return fleetSuccessEnvelope(VALIDATE_COMMAND, inspection, [
      // The file that was actually inspected, not the tracked one. Under
      // `--contract` both next actions pointed at a file the caller never named.
      `Consume the declared authorities from ${inspection.contract_path} rather than re-deriving field ownership`,
      "Record any new managed exception under a lifecycle class before adopting, retiring, or draining it",
    ]);
  }
  const error = new FleetError(
    first.code,
    `${first.path}: ${first.message}`,
    false,
    diagnosticDetails(inspection.diagnostics, { contract_path: inspection.contract_path }),
  );
  return fleetFailureEnvelope(VALIDATE_COMMAND, error, [
    `Edit ${inspection.contract_path} at the reported field paths, then re-run this command`,
  ]);
}

/**
 * The inventory's success envelope. An unhealthy fleet is still `ok: true`.
 *
 * `validateFleetEnvelope` enforces `ok ? data !== null : data === null`, so
 * reporting conflicts as `ok: false` would null out `data` on exactly the runs
 * where the inventory matters most. Only a COMMAND failure -- an unreadable
 * registry, an unknown `--agent`, a bad flag -- is `ok: false`.
 */
function inventoryEnvelope(inventory: FleetInventory, json: boolean): FleetEnvelopeV1 {
  const nextActions = inventory.health.healthy
    ? ["Consume data.rows as the fleet's declared state; every value names the authority that owns it"]
    : [
      inventory.health.conflicts
        ? "Rule on each unpermitted conflict group: repair the drift, or record it under classifications.intentionally_unmanaged"
        : "Review data.findings; each names the owning registry and the field path to repair",
      "Re-run with --json for the complete row set",
    ];
  // A caller who already passed --json is reading this string IN the JSON.
  if (json && nextActions.length > 1) nextActions.pop();
  return fleetSuccessEnvelope(INVENTORY_COMMAND, inventory, nextActions);
}

/**
 * The provenance success envelope. A drifted fleet is still `ok: true`.
 *
 * Same rule the inventory documents and for the same reason: `data` is nulled on
 * `ok: false`, so reporting drift as a failure would blank the report on exactly
 * the runs that matter. Only a command failure -- an unreadable source, an
 * unknown `--agent`, a bad flag, a blown deadline, a cancellation -- is
 * `ok: false`.
 */
function provenanceEnvelope(provenance: FleetProvenance, json: boolean): FleetEnvelopeV1 {
  const nextActions = provenance.health.healthy && provenance.health.complete
    ? ["Consume data.facts as the fleet's proven provenance; every fact names the source of both sides"]
    : [
      provenance.health.mismatched
        ? "Repoint each mismatched agent at the configured pin, or move the pin -- data.facts names both sides and the authority that owns the field"
        : provenance.health.missing
          ? "Record the missing values on the owning side; an absent pin is never a match"
          : "Review data.probes: a fact reported unobserved was not read, and nothing may be claimed about it",
      "Re-run with --json for the complete fact set",
    ];
  // A caller who already passed --json is reading this string IN the JSON.
  if (json && nextActions.length > 1) nextActions.pop();
  return fleetSuccessEnvelope(PROVENANCE_COMMAND, provenance, nextActions);
}

/**
 * The status success envelope. An unhealthy OR incomplete fleet is still `ok: true`.
 *
 * Third time, same rule, and it is the rule this whole namespace is built on:
 * `validateFleetEnvelope` nulls `data` on `ok:false`, so reporting drift as a
 * command failure would blank the report on exactly the runs that matter. Only a
 * command failure -- an unreadable source, an unknown `--agent`/`--domain`, a bad
 * flag, a blown deadline, a cancellation -- is `ok:false`.
 */
function statusEnvelope(status: FleetStatus, json: boolean): FleetEnvelopeV1 {
  const nextActions = status.health.proven
    ? ["Consume data.agents as the fleet's proven state; every observation names its domain, its evidence, its severity, and the one action that changes it"]
    : [
      status.health.errors || status.health.collection_errors
        ? "Review data.findings: a collection error is never a pass, so the domains it covers are reported error or unobserved until the source can be read"
        : status.health.failed
          ? "Repair the failing observations in data.agents, worst first -- data.findings is sorted by gating impact and severity, and data.host is separate on purpose"
          : status.health.unjustified
            ? "Every non-pass without a justification blocks proof: authorize it under health_policy in the fleet contract, or repair it"
            : status.health.stale
              ? "Refresh the evidence behind each stale observation, or widen the owning health_policy.freshness entry"
              : status.scope.live
                ? "Review data.health.unobserved: live-process and Bloodbank-liveness observers do not exist in this release (stories 1.9/1.10)"
                : "Re-run with --live to authorize the bounded, read-only recipe audit; without it every audit-fed domain is unobserved",
      "Re-run with --json for the complete observation set",
    ];
  // A caller who already passed --json is reading this string IN the JSON.
  if (json && nextActions.length > 1) nextActions.pop();
  return fleetSuccessEnvelope(STATUS_COMMAND, status, nextActions);
}

/**
 * Parse `--deadline-ms` into the positive whole number the run context needs.
 *
 * Rejected here rather than in `createRunContext` so a typo is INVALID_INPUT
 * with the flag named, not an internal error from three layers down.
 *
 * The DIGITS are matched first, and `Number()` only afterwards. `parseInt("5x")`
 * is 5 -- the rejection this guard was written for -- but `Number()` has the
 * same class of hole in the other direction: `Number("0x10")` is 16 and
 * `Number("1e3")` is 1000, both integers, both accepted. Measured before this
 * fix: `--deadline-ms 0x10` produced a 16ms deadline and exit 7, and
 * `--deadline-ms 1e3` a 1000ms one. A caller who typed either did not mean a
 * millisecond count in a base they never named, and the two spellings that
 * silently succeed are worse than the one that loudly fails.
 */
function parseDeadlineMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  const value = Number(text);
  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value) || value <= 0) {
    throw new FleetError("INVALID_INPUT", "--deadline-ms must be a positive whole number of milliseconds");
  }
  return value;
}

/**
 * Validate the shared flag surface once, for both commands.
 *
 * The CLI is one of two equal adapters, so it owns no policy beyond argument
 * shaping: everything below is a guard on what Commander bound, and nothing here
 * decides what a fleet answer is.
 */
function fleetRunInputs(options: InventoryOptions): { deadlineMs: number | undefined } {
  requireValue(options.agent, "--agent");
  requireValue(options.projectRegistry, "--project-registry");
  requireValue(options.agentRegistry, "--agent-registry");
  requireValue(options.contract, "--contract");
  requireValue(options.deadlineMs, "--deadline-ms");
  return { deadlineMs: parseDeadlineMs(options.deadlineMs) };
}

/**
 * Run `body` with a context that a SIGINT or SIGTERM aborts.
 *
 * The listener is removed in `finally`, always. Left installed, a long-lived
 * process embedding this CLI would accumulate one listener per invocation and
 * Node would eventually warn about a leak -- and worse, an abort meant for a
 * later run would cancel an earlier context that is still in scope.
 */
async function withSignals<T>(deadlineMs: number | undefined, body: (ctx: FleetRunContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const ctx = createRunContext({ signal: controller.signal, deadlineMs });
  const abort = (): void => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    return await body(ctx);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

/** The read-only org commands, which all promise the same JSON envelope. */
const ORG_COMMAND_WORDS = new Set(["roster", "org", "record", "review", "handbook"]);

/** Whether these argv words are an org invocation that promised JSON. */
export function isOrgJsonInvocation(args: readonly string[]): boolean {
  return args[0] !== undefined && ORG_COMMAND_WORDS.has(args[0]) && args.includes("--json");
}

/**
 * The envelope a caller gets when Commander rejects the arguments.
 *
 * Without it `handbook validate --json --bogus` wrote zero bytes and
 * exited 1 -- outside the command's own exit taxonomy, and unparseable by the
 * automation that asked for `--json` in the first place.
 */
export function orgParserFailureEnvelope(args: readonly string[]): FleetEnvelopeV1<never> {
  // Now that the namespace has two commands the envelope has to name the one
  // that failed. Derived from the positional words only: an option VALUE can be
  // anything (`--agent inventory` is a legal, if unlucky, id), so scanning the
  // whole argv for the word would mislabel a validate failure as an inventory
  // one. Commander has already rejected these arguments, so the words are
  // untrusted -- this only picks a label, never a code path.
  const words = args.filter((arg) => !arg.startsWith("-"));
  // Positional-only, and a MAP rather than a chain of ternaries: an option VALUE
  // may legally be `provenance` (`--agent provenance` is an unlucky but valid
  // id), so scanning the whole argv would mislabel a validate failure.
  //
  // NULL-PROTOTYPE, and that is the whole point of building it with
  // `Object.create(null)`. A plain object literal inherits `Object.prototype`,
  // so `positional["constructor"]` answers with a FUNCTION rather than
  // `undefined`, that function becomes the envelope's `command`, and
  // `validateFleetEnvelope` then throws `INTERNAL_ERROR` out of the very helper
  // that exists to guarantee one parseable envelope. Measured before this fix:
  // `org constructor --json` printed a raw stack trace, wrote zero JSON bytes
  // and exited 1 -- outside the command's own exit taxonomy. The words are
  // attacker-shaped by definition (Commander has already rejected them), so the
  // lookup table must not have a prototype to reach.
  const positional: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
    roster: INVENTORY_COMMAND,
    org: INVENTORY_COMMAND,
    record: PROVENANCE_COMMAND,
    review: STATUS_COMMAND,
  });
  // These commands now hang off the ROOT, so the command word is words[0], not
  // words[1] as it was under the old `fleet <sub>` namespace. Anything else --
  // including `handbook validate` -- falls through to the handbook label.
  const candidate = words[0] !== undefined ? positional[words[0]] : undefined;
  const command = typeof candidate === "string" ? candidate : VALIDATE_COMMAND;
  return fleetFailureEnvelope(command, new FleetError("INVALID_INPUT", "Invalid org command arguments"));
}

/**
 * Refuse a path or id option that Commander bound to something that is not one.
 *
 * Two failures, both real. An explicitly-empty value (`--agent "$UNSET"`) used
 * to fall through to the unscoped default and report success about a request
 * nobody made. And Commander binds the NEXT argv token as the value, so
 * `--agent --json` makes the flag the id: `options.json` stays false and a
 * caller that asked for JSON gets an ANSI report about an agent named `--json`.
 */
function requireValue(value: string | undefined, flag: string): void {
  if (value === undefined) return;
  if (value.trim() === "") throw new FleetError("INVALID_INPUT", `${flag} was given an empty value`);
  if (value.startsWith("--")) throw new FleetError("INVALID_INPUT", `${flag} was given an option, not a value`);
}

/**
 * The read-only org surface: `roster`/`org`, `record`, `review`, `handbook validate`.
 *
 * Writes with `process.stdout.write` and sets `process.exitCode`. It never calls
 * `process.exit()` -- that is what truncates buffered stdout under pipe capture,
 * and it is the exact defect this code was written to stop reproducing.
 */
export function registerOrgCli(program: Command): void {
  const handbook = program.command("handbook").description("Work with the employee handbook: authorities, classes, service model, retired modes");

  // Hangs off the root, not off `handbook`: the roster is a read of the two
  // canonical registries, not a read of the handbook.
  program.command("roster")
    .alias("org")
    .description("Every employee in the org chart, and everywhere the two registries disagree (read-only)")
    .option("--agent <id>", "Report only this agent; totals still describe the whole fleet")
    .option("--project-registry <path>", "Inspect this project registry instead of the configured one")
    .option("--agent-registry <path>", "Inspect this agent registry instead of the configured one")
    .option("--contract <path>", "Validate and read this contract instead of the tracked one")
    .option("--deadline-ms <ms>", "Fail with TIMEOUT if the whole run has not finished within this budget")
    .option("--json", "Emit the fleet JSON v1 envelope")
    // Async because the two fleet observation commands share one option surface
    // and one run context. `src/index.ts` already awaits `program.parseAsync()`.
    .action(async (options: InventoryOptions) => {
      ignoreBrokenPipe();
      const json = Boolean(options.json);
      try {
        const { deadlineMs } = fleetRunInputs(options);
        const inventory = await withSignals(deadlineMs, async (runContext) => collectFleetInventory({
          agentId: options.agent,
          projectRegistry: options.projectRegistry,
          agentRegistry: options.agentRegistry,
          contract: options.contract,
          runContext,
        }));
        await write(inventoryEnvelope(inventory, json), json, () => formatFleetInventoryReport(inventory));
      } catch (error) {
        const normalized = normalizeFleetError(error);
        // Exit 4 and 5 come out of `collectFleetInventory` rethrowing a contract
        // diagnostic's own code, and no store path is the fix for those.
        const contractFault = fleetExitCode(normalized.code) === 4 || fleetExitCode(normalized.code) === 5;
        const envelope = fleetFailureEnvelope(INVENTORY_COMMAND, normalized, [
          contractFault
            ? "Run `flume handbook validate` -- the fault is in contracts/handbook.yaml, not in a registry"
            : "Re-run without --json for the full report, or fix the reported store path",
        ]);
        try { await write(envelope, json, () => formatFleetErrorReport("Fleet inventory failed", normalized)); }
        catch { await emitLastResort(INVENTORY_COMMAND); }
      }
    });

  // Hangs off the root beside `roster`, and takes the SAME option surface: the
  // two commands are one core with two adapters, and an option that exists on
  // one and not the other is how the MCP tool and the CLI stop being equal.
  program.command("record")
    .description("Each employee's employment record: which build they actually run, against the configured pin (read-only)")
    .option("--agent <id>", "Report only this agent; totals and the verdict still describe the whole fleet")
    .option("--project-registry <path>", "Inspect this project registry instead of the configured one")
    .option("--agent-registry <path>", "Inspect this agent registry instead of the configured one")
    .option("--contract <path>", "Validate and read this contract instead of the tracked one")
    .option("--deadline-ms <ms>", "Fail with TIMEOUT if the whole run has not finished within this budget")
    .option("--json", "Emit the fleet JSON v1 envelope")
    .action(async (options: ProvenanceOptions) => {
      ignoreBrokenPipe();
      const json = Boolean(options.json);
      try {
        const { deadlineMs } = fleetRunInputs(options);
        const provenance = await withSignals(deadlineMs, async (runContext) => collectFleetProvenance({
          agentId: options.agent,
          projectRegistry: options.projectRegistry,
          agentRegistry: options.agentRegistry,
          contract: options.contract,
          runContext,
        }));
        await write(provenanceEnvelope(provenance, json), json, () => formatFleetProvenanceReport(provenance));
      } catch (error) {
        const normalized = normalizeFleetError(error);
        const contractFault = fleetExitCode(normalized.code) === 4 || fleetExitCode(normalized.code) === 5;
        const budgetFault = normalized.code === "TIMEOUT" || normalized.code === "CANCELLED";
        const envelope = fleetFailureEnvelope(PROVENANCE_COMMAND, normalized, [
          contractFault
            ? "Run `flume handbook validate` -- the fault is in contracts/handbook.yaml, not in a source"
            : budgetFault
              ? "Re-run with a larger --deadline-ms; no partial provenance is reported, because a partial one must never be mistaken for a complete one"
              : "Re-run without --json for the full report, or fix the reported source path",
        ]);
        try { await write(envelope, json, () => formatFleetErrorReport("Fleet provenance failed", normalized)); }
        catch { await emitLastResort(PROVENANCE_COMMAND); }
      }
    });

  // The third observation command, on the SAME option surface plus the two this
  // one owns. `--live` is an authorization, not a mode: it authorizes bounded,
  // read-only host and network observation (the recipe-owned audit rules, whose
  // bmad rule makes a real `npm view` call) and nothing else. Never mutation,
  // process control, service changes, board changes, or Bloodbank activation.
  program.command("review")
    .description("Performance review: every employee across all nine observation domains, in one read-only invocation")
    .option("--agent <id>", "Report only this agent; totals still describe the whole fleet, and no child runs for any other agent")
    .option("--domain <domain>", `Report only this domain (${FLEET_STATUS_DOMAINS.join(", ")})`)
    .option("--live", "Authorize bounded, read-only host and network observation: run the recipe-owned audit rules per repository")
    .option("--baseline <path>", "Correlate against a prior status document and report every transition (read-only)")
    .option("--exit-code", "Project data.health.exit_category onto the process exit: 10 unhealthy, 11 unproven. Default is 0")
    .option("--project-registry <path>", "Inspect this project registry instead of the configured one")
    .option("--agent-registry <path>", "Inspect this agent registry instead of the configured one")
    .option("--contract <path>", "Validate and read this contract instead of the tracked one")
    .option("--deadline-ms <ms>", "Fail with TIMEOUT if the whole run has not finished within this budget")
    .option("--json", "Emit the fleet JSON v1 envelope")
    .action(async (options: StatusOptions) => {
      ignoreBrokenPipe();
      const json = Boolean(options.json);
      try {
        const { deadlineMs } = fleetRunInputs(options);
        // `--domain` gets the same guard as every other value flag. Commander
        // binds the NEXT argv token, so `--domain --json` would otherwise make
        // the flag the domain and hand a caller who asked for JSON an ANSI
        // report about a domain named `--json`.
        requireValue(options.domain, "--domain");
        requireValue(options.baseline, "--baseline");
        const status = await withSignals(deadlineMs, async (runContext) => collectFleetStatus({
          agentId: options.agent,
          domain: options.domain,
          live: Boolean(options.live),
          baseline: options.baseline,
          projectRegistry: options.projectRegistry,
          agentRegistry: options.agentRegistry,
          contract: options.contract,
          runContext,
        }));
        // OPT-IN, and the default stays 0. `fleet status` is an observation
        // command: gating CI is story 1.21's job, and a `mise run fleet:status`
        // that is permanently red on the real (unhealthy) fleet teaches an
        // operator to ignore it. The envelope is unchanged either way -- `ok`
        // stays true and `data` stays complete, because the command succeeded;
        // it is the fleet that did not.
        const projected = options.exitCode === true ? FLEET_STATUS_EXIT_CODES[status.health.exit_category] : 0;
        await write(statusEnvelope(status, json), json, () => formatFleetStatusReport(status), projected);
      } catch (error) {
        const normalized = normalizeFleetError(error);
        const contractFault = fleetExitCode(normalized.code) === 4 || fleetExitCode(normalized.code) === 5;
        const budgetFault = normalized.code === "TIMEOUT" || normalized.code === "CANCELLED";
        const envelope = fleetFailureEnvelope(STATUS_COMMAND, normalized, [
          contractFault
            ? "Run `flume handbook validate` -- the fault is in contracts/handbook.yaml, not in a registry"
            : budgetFault
              ? "Re-run with a larger --deadline-ms; no partial status is reported, because a partial one must never be mistaken for a complete one"
              : "Re-run without --json for the full report, or fix the reported agent id, domain, or store path",
        ]);
        try { await write(envelope, json, () => formatFleetErrorReport("Fleet status failed", normalized)); }
        catch { await emitLastResort(STATUS_COMMAND); }
      }
    });

  handbook.command("validate")
    .description("Validate the fleet contract and report authorities, classes, service model, and retired modes")
    .option("--contract <path>", "Validate this contract instead of the tracked one")
    .option("--json", "Emit the fleet JSON v1 envelope")
    // Async because `write()` now AWAITS the stdout drain. A sync action would
    // return before the document had left the process, which is the truncation
    // this story exists to remove -- and `src/index.ts` already awaits
    // `program.parseAsync()`, so nothing above has to change.
    .action(async (options: ValidateOptions) => {
      ignoreBrokenPipe();
      const json = Boolean(options.json);
      try {
        // An explicitly-passed empty value used to fall through to the tracked
        // contract, so `--contract "$UNSET"` validated a file the caller never
        // named and reported success about it.
        if (options.contract !== undefined && options.contract.trim() === "") {
          throw new FleetError("INVALID_INPUT", "--contract was given an empty path");
        }
        // Commander binds the next argv token as the value, so
        // `--contract --json` makes the FLAG the path: `options.json` stays
        // false and a caller that asked for JSON got the ANSI human report for
        // a file named `--json`. A path never starts with `--`.
        if (options.contract !== undefined && options.contract.startsWith("--")) {
          throw new FleetError("INVALID_INPUT", "--contract was given an option, not a path");
        }
        const inspection = inspectFleetContract(options.contract);
        const envelope = validateEnvelope(inspection);
        await write(envelope, json, () => formatFleetContractReport(inspection));
      } catch (error) {
        const normalized = normalizeFleetError(error);
        let shown = "contract";
        try { shown = redactHome(resolveFleetContractPath(options.contract)); } catch { /* keep the placeholder */ }
        const envelope = fleetFailureEnvelope(VALIDATE_COMMAND, new FleetError(
          normalized.code,
          normalized.message,
          normalized.retryable,
          { ...normalized.details, contract_path: shown },
        ));
        const inspection = emptyInspection(shown, [{ code: normalized.code, path: "contract", message: normalized.message }]);
        // The render itself can throw -- `renderFleetJson` validates the
        // envelope it is handed. Outside this catch that escaped the action
        // handler and reached the top-level rethrow as a raw stack trace with
        // `process.exitCode` never set.
        try { await write(envelope, json, () => formatFleetContractReport(inspection)); }
        catch { await emitLastResort(VALIDATE_COMMAND); }
      }
    });
}

/**
 * One writer for both commands.
 *
 * Takes a formatter THUNK rather than a payload: the human report of a contract
 * inspection and of a fleet inventory have nothing in common but the fact that
 * one of them has to be produced only on the non-JSON path. Typing this to
 * `FleetContractInspection` and hardwiring `formatFleetContractReport` is what
 * would otherwise have forced a second near-identical copy.
 */
async function write(envelope: FleetEnvelopeV1, json: boolean, format: () => string, projected = 0): Promise<void> {
  // AWAITED, and that is the whole change. `process.stdout` is ASYNCHRONOUS for
  // a pipe on Linux, so `write()` only queues; anything that terminates the
  // process before the queue drains loses the tail. Measured on this runtime: a
  // 200 000-character document reached a file complete and a pipe at 131 072
  // bytes, exit 0. This path was correct before only because nothing on it
  // called `process.exit()` -- a property maintained by a COMMENT. Awaiting the
  // drain makes it a property of the code, and it stays true if a later edit
  // does call `process.exit`.
  if (json) await writeStdout(renderFleetJson(envelope));
  else await writeStdout(`${format()}\n`);
  process.exitCode = fleetEnvelopeExitCode(envelope, projected);
}

/** Last resort when even rendering the failure envelope threw. */
async function emitLastResort(command: string): Promise<void> {
  await writeStdout(`${JSON.stringify({
    schema_version: 1,
    ok: false,
    command,
    data: null,
    error: { code: "INTERNAL_ERROR", message: "Fleet command could not render its own result", retryable: false, details: {} },
    next_actions: [],
  }, null, 2)}\n`);
  process.exitCode = 6;
}
