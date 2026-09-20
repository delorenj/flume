// Machine and human output for the read-only org commands.
//
// A sibling of the notebook envelope rather than a reuse of it: the notebook
// envelope's `project` and `notebook` root blocks are mandatory and its command
// set is closed (`src/notebook/output.ts`). A fleet contract is not
// project-scoped, so borrowing that shape would either loosen the notebook's
// guarantees or force a fake project onto every fleet answer. The guarantees
// themselves -- bounded strings, capped details, ok <=> error === null, one
// complete document -- are reproduced here deliberately.
//
// ONE CONSTRAINT, AND IT IS LOAD-BEARING: this module and `src/fleet/health.ts`
// import each other. This file needs `compareStatusFindings` and the two sort
// keys so the human report ranks findings exactly as the machine path does --
// two orderings would make the report's cap drop a different finding from the
// one the envelope drops. `health.ts` needs `bounded`/`redactHome` from here so
// a next action or a justification it builds is bounded on the same terms as
// every other string in the envelope. The cycle is deliberate, and it is SAFE
// ONLY BECAUSE NEITHER FILE CALLS THE OTHER AT MODULE SCOPE -- every use is
// inside a function body, so whichever half the bundler initializes second
// still has the first's bindings by the time anything runs.
//
// Do not add a top-level initializer to either file that calls across it. A
// `const X = compareStatusFindings(...)` here, or a `const Y = bounded(...)`
// there, is a `TypeError: ... is not a function` at import time in whichever
// order the bundle happens to emit -- and every suite runs the BUNDLE, so it
// would surface as the whole CLI failing to start rather than as a unit-test
// failure pointing at the line.

import { homedir, userInfo } from "node:os";
import {
  FLEET_ERROR_CODES,
  FLEET_SCHEMA_VERSION,
  FleetError,
  fleetExitCode,
  type FleetConflictGroup,
  type FleetDiagnostic,
  type FleetErrorCode,
  type FleetExtension,
  type FleetFieldValue,
  type FleetInventory,
  type FleetInventoryFinding,
  type FleetInventoryRow,
  type FleetProbeRecord,
  type FleetProvenance,
  type FleetProvenanceFact,
  type FleetProvenanceStatus,
  type FleetStatus,
  type FleetStatusAgent,
  type FleetStatusDomainRollup,
  type FleetStatusObservation,
  type FleetStatusSeverity,
  type FleetStatusState,
  type FleetStatusVerdict,
} from "./types";
import { compareStatusFindings, hostSortKey, observationSortKey } from "./health";
import { bold, cyan, dim, glyph, gray, green, joinDot, padVisible, red, statusStyle, terminalWidth, truncateVisible, visibleWidth, yellow } from "../utils/style";

/** Commands allowed to produce a fleet envelope. */
export const FLEET_COMMANDS = ["fleet.contract.validate", "fleet.inventory", "fleet.provenance", "fleet.status"] as const;

/**
 * The `data` keys each command's success envelope must carry.
 *
 * Per-command, not one hardcoded list. While `validate` was the only command,
 * `validateFleetEnvelope` asserted its ten keys on EVERY `ok` envelope -- so the
 * second command in the namespace could not emit a success envelope at all; it
 * threw INTERNAL_ERROR out of `renderFleetJson` instead.
 */
const FLEET_COMMAND_DATA_KEYS: Record<string, readonly string[]> = {
  "fleet.contract.validate": [
    "contract_path", "authorities", "projections", "classifications",
    "service_model", "activation", "retired", "extensions", "truncated", "diagnostics",
  ],
  // `scope`, `contract_path` and `contract_version` are emitted, rendered by the
  // human report, and asserted by the suite; leaving them off this list meant
  // the validator would have waved through an envelope that dropped them.
  "fleet.inventory": [
    "contract_path", "contract_version", "scope",
    "stores", "totals", "health", "rows", "conflicts", "findings", "truncated",
  ],
  // Same discipline the inventory entry documents: a key omitted here is a key
  // `validateFleetEnvelope` will wave through if a future edit drops it, so
  // every key the report renders and the suite asserts is listed.
  "fleet.provenance": [
    "contract_path", "contract_version", "scope",
    "sources", "totals", "health", "facts", "probes", "findings", "truncated",
  ],
  // Same discipline again. Omitting a key here does not make the envelope
  // smaller -- it makes `validateFleetEnvelope` wave the envelope through when a
  // future edit drops the key, which is the one thing this table exists to stop.
  "fleet.status": [
    "contract_path", "contract_version", "scope",
    "totals", "health", "agents", "domains", "host", "findings", "probes", "transitions", "scaffold", "profile", "systemd", "truncated",
  ],
};

const MAX_STRING = 512;
const MAX_DETAILS = 20;
const MAX_NEXT_ACTIONS = 20;
/** Notes carried in a view before the envelope's list cap applies. */
const MAX_NOTES = 10;

export interface FleetEnvelopeV1<T = unknown> {
  schema_version: 1;
  ok: boolean;
  command: string;
  data: T | null;
  error: null | {
    code: FleetErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
  next_actions: string[];
}

export interface FleetAuthorityView {
  id: string;
  owner: string;
  store: string;
  store_env: string[];
  read_only: boolean;
  writable_fields: string[];
  notes: string[];
}

export interface FleetProjectionView {
  field: string;
  source: string;
  target: string;
  direction: string;
  writable_by: string;
}

export interface FleetClassificationView {
  id: string;
  required_fields: string[];
  entry_count: number;
  entries: Array<Record<string, unknown>>;
}

export interface FleetRetiredView {
  id: string;
  reason: string;
  superseded_by: string;
  detect: string[];
}

/** Everything `fleet contract validate` learned, in one bounded shape. */
export interface FleetContractInspection {
  contract_path: string;
  byte_stable: boolean;
  schema_version: number | null;
  contract_version: string | null;
  compatibility: { min_schema_version: number; max_schema_version: number } | null;
  supported_schema_versions: { min: number; max: number };
  authorities: FleetAuthorityView[];
  projections: FleetProjectionView[];
  classifications: FleetClassificationView[];
  service_model: Record<string, unknown> | null;
  activation: Record<string, unknown> | null;
  retired: FleetRetiredView[];
  extensions: FleetExtension[];
  /** Dotted paths where an envelope bound clipped the reported value. */
  truncated: string[];
  diagnostics: FleetDiagnostic[];
}

/**
 * Strip control characters and cap length. Same rule as the notebook envelope,
 * plus one this surface needs: CR and LF fold to a space rather than survive.
 * Every bounded string here is printed as one row of a report, so a newline
 * inside a contract value let that value forge additional rows.
 */
export function bounded(value: string, max = MAX_STRING): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, max);
}

/**
 * Every home directory this process might be describing, longest first.
 *
 * `os.homedir()` alone is not enough: on POSIX it just reports `$HOME`, so
 * under an isolated test HOME, a systemd unit, or a CI runner with HOME
 * rewritten it points somewhere the reported path is not under -- and the
 * redaction silently stops redacting exactly where it matters most.
 * `os.userInfo().homedir` reads the passwd entry and ignores `$HOME`, so the
 * two together cover both. Longest first so a scratch HOME nested inside the
 * real one wins over its own parent.
 */
function homeCandidates(): string[] {
  const candidates = new Set<string>();
  try { if (homedir()) candidates.add(homedir()); } catch { /* no home is a valid state */ }
  try { if (userInfo().homedir) candidates.add(userInfo().homedir); } catch { /* container with no passwd entry */ }
  return [...candidates].sort((a, b) => b.length - a.length);
}

/**
 * Replace the operator's home directory with `~`.
 *
 * The report has to name the file it validated -- an operator cannot fix a
 * contract they cannot find -- but an absolute path under a home directory
 * carries the account name into logs, CI output, and pasted transcripts.
 * Naming the file and naming the machine are separable, so they are separated:
 * a known home collapses to `~`, and any other home-shaped prefix keeps its
 * shape but loses the account, rather than being passed through intact.
 */
export function redactHome(path: string, homes: readonly string[] = homeCandidates()): string {
  for (const home of homes) {
    if (!home) continue;
    if (path === home) return "~";
    if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  }
  // Kept in step with HOST_PATH in contract.ts: `/root` is a home directory
  // too, and leaving it out meant `--contract /root/x.yaml` echoed the path
  // back verbatim while `/home/someone/x.yaml` was redacted.
  return path
    .replace(/^\/(home|Users)\/[^/]+/u, "/$1/<redacted>")
    .replace(/^\/root(?=\/|$)/u, "/root/<redacted>");
}

/**
 * Where a bound was actually applied, so a caller is never quietly short-changed.
 *
 * Bounds are non-negotiable -- an envelope has to stay one document a pipe can
 * carry -- but silently dropping the 51st key while reporting "extensions
 * survive verbatim" would be a lie the caller has no way to detect. Every clip
 * records its dotted path here and the command surfaces the list.
 */
export interface BoundedContext {
  truncated: string[];
}

export function boundedContext(): BoundedContext {
  return { truncated: [] };
}

const MAX_DEPTH = 6;
const MAX_KEYS = 50;
const MAX_ITEMS = 100;

/**
 * Bound a declared string list and record the clip.
 *
 * `writable_fields`, `store_env` and `detect` were once copied with a bare
 * spread, so a contract with thousands of entries produced an envelope past
 * every documented bound while `truncated` stayed empty -- the one list whose
 * whole job is to say "you did not get all of it" was the one that could not
 * say so.
 *
 * Lives here rather than in `cli.ts` because the inventory needs the same bound
 * on the same terms, and two copies of a bound are two bounds.
 */
export function cappedStrings(values: readonly string[] | undefined, context: BoundedContext, path: string, max = MAX_ITEMS, noun = "items"): string[] {
  const all = values ?? [];
  if (all.length > max) context.truncated.push(`${path}: ${all.length - max} of ${all.length} ${noun} dropped`);
  return all.slice(0, max).map((value) => bounded(value));
}

export function boundedNotes(notes: readonly string[] | undefined, context: BoundedContext, path: string): string[] {
  // `noun` is not decoration: folding this into `cappedStrings` silently
  // rewrote a shipped truncation note from "N of M notes dropped" to
  // "... items dropped", and no check reads that clip.
  return cappedStrings(notes, context, path, MAX_NOTES, "notes");
}

/** Keep an open-keyed contract subtree inside the envelope's bounds. */
export function boundedValue(value: unknown, context: BoundedContext = boundedContext(), path = "", depth = 0): unknown {
  const clip = (reason: string): void => { if (!context.truncated.includes(`${path}: ${reason}`)) context.truncated.push(`${path}: ${reason}`); };
  if (depth > MAX_DEPTH) { clip(`nesting deeper than ${MAX_DEPTH} levels dropped`); return null; }
  if (typeof value === "string") {
    const result = bounded(value);
    if (result.length < value.length) clip(`string clipped to ${MAX_STRING} characters`);
    return result;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) clip(`${value.length - MAX_ITEMS} of ${value.length} items dropped`);
    return value.slice(0, MAX_ITEMS).map((item, index) => boundedValue(item, context, `${path}[${index}]`, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_KEYS) clip(`${entries.length - MAX_KEYS} of ${entries.length} keys dropped`);
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, MAX_KEYS)) {
      const child = path ? `${path}.${key}` : key;
      result[bounded(key, 128)] = boundedValue(item, context, child, depth + 1);
    }
    return result;
  }
  clip("value of an unrepresentable type dropped");
  return null;
}

/**
 * Ignore a closed stdout instead of dying on it.
 *
 * `flume handbook validate --json | head -1` closes the pipe mid-write. With
 * no handler that surfaces as an unhandled EPIPE and a stack trace -- from a
 * command whose entire contract is "one clean document, no stack traces".
 */
export function ignoreBrokenPipe(stream: NodeJS.WriteStream = process.stdout): void {
  stream.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") throw error; });
}

export function normalizeFleetError(error: unknown): FleetError {
  if (error instanceof FleetError) return error;
  // Unknown exceptions are not an operator-facing protocol: runtime, parser and
  // filesystem messages routinely carry absolute paths and payload fragments.
  // Keep the original as an in-memory cause and expose one stable category.
  return new FleetError("INTERNAL_ERROR", "Fleet command encountered an unexpected internal error", false, {}, { cause: error });
}

export function fleetSuccessEnvelope<T>(command: string, data: T, nextActions: string[] = []): FleetEnvelopeV1<T> {
  return {
    schema_version: FLEET_SCHEMA_VERSION,
    ok: true,
    command,
    data,
    error: null,
    next_actions: nextActions.slice(0, MAX_NEXT_ACTIONS).map((item) => bounded(item)),
  };
}

export function fleetFailureEnvelope(command: string, error: unknown, nextActions: string[] = []): FleetEnvelopeV1<never> {
  const normalized = normalizeFleetError(error);
  return {
    schema_version: FLEET_SCHEMA_VERSION,
    ok: false,
    command,
    data: null,
    error: {
      code: normalized.code,
      message: bounded(normalized.message),
      retryable: normalized.retryable,
      details: sanitizeDetails(normalized.details),
    },
    next_actions: nextActions.slice(0, MAX_NEXT_ACTIONS).map((item) => bounded(item)),
  };
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, MAX_DETAILS)) {
    if (!key) continue;
    if (typeof value === "string") result[bounded(key, 128)] = bounded(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) result[bounded(key, 128)] = value;
  }
  return result;
}

/**
 * Turn ordered diagnostics into a bounded, scalar-only `details` map.
 *
 * Prefixed with the index so two findings on the same path cannot collapse into
 * one, which is how a "1 finding" report would silently understate a "2
 * findings" contract.
 */
export function diagnosticDetails(diagnostics: readonly FleetDiagnostic[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const details: Record<string, unknown> = { ...extra, diagnostic_count: diagnostics.length };
  // One slot held back for the marker below, so the clip can always announce
  // itself. Without it a 30-finding contract produced 18 entries and a count of
  // 30, and the only way to notice was to compare the two by hand -- the same
  // "quietly short-changed" failure `truncated` exists to prevent on the
  // success path.
  const room = MAX_DETAILS - Object.keys(details).length - 1;
  const shown = Math.max(0, Math.min(room, diagnostics.length));
  diagnostics.slice(0, shown).forEach((diagnostic, index) => {
    details[`${index}:${diagnostic.path}`] = `${diagnostic.code}: ${diagnostic.message}`;
  });
  if (shown < diagnostics.length) {
    details.diagnostics_truncated = `showing ${shown} of ${diagnostics.length} findings; run without --json for the full report`;
  }
  return details;
}

export function renderFleetJson(envelope: FleetEnvelopeV1): string {
  validateFleetEnvelope(envelope);
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * The process exit for one envelope, and the ONE choke point for the taxonomy.
 *
 * A command failure always wins: `ok: false` maps through `fleetExitCode` and
 * `projected` is not consulted, because an unreadable registry is not an
 * unhealthy fleet and the two must never share an exit band.
 *
 * `projected` is how an `ok: true` envelope can still exit nonzero. `unhealthy`
 * and `incomplete` are `ok: true` states -- the command succeeded, the fleet did
 * not -- so they cannot be `FleetErrorCode` members without nulling `data` on
 * exactly the runs that matter. They live in `data.health.exit_category`, which
 * both adapters carry, and only the CLI projects them, only under `--exit-code`.
 * The default stays 0.
 */
export function fleetEnvelopeExitCode(envelope: FleetEnvelopeV1, projected = 0): number {
  if (!envelope.ok && envelope.error) return fleetExitCode(envelope.error.code);
  return projected;
}

export function validateFleetEnvelope(envelope: FleetEnvelopeV1): void {
  const invalid = (reason: string): never => {
    throw new FleetError("INTERNAL_ERROR", `Fleet command produced an invalid JSON v1 envelope: ${reason}`);
  };
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) invalid("root must be an object");
  const keys = Object.keys(envelope).sort();
  const expected = ["command", "data", "error", "next_actions", "ok", "schema_version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalid("root fields differ from v1");
  if (envelope.schema_version !== FLEET_SCHEMA_VERSION) invalid("schema version is invalid");
  if (typeof envelope.ok !== "boolean") invalid("ok is invalid");
  if (!(FLEET_COMMANDS as readonly string[]).includes(envelope.command)) invalid("command is invalid");
  if (!Array.isArray(envelope.next_actions) || envelope.next_actions.length > MAX_NEXT_ACTIONS) invalid("next_actions is invalid");
  for (const action of envelope.next_actions) if (typeof action !== "string" || action.length === 0) invalid("next_actions entry is invalid");
  if (envelope.ok === (envelope.error !== null) || (envelope.ok ? envelope.data === null : envelope.data !== null)) invalid("success/error invariant failed");
  if (envelope.ok) {
    const data = envelope.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) invalid("data must be an object");
    const required = FLEET_COMMAND_DATA_KEYS[envelope.command];
    if (!required) invalid("command declares no required data keys");
    for (const key of required!) {
      if ((data as Record<string, unknown>)[key] === undefined) invalid(`data.${key} is missing`);
    }
    return;
  }
  const error = envelope.error;
  if (!error || typeof error !== "object") invalid("error must be an object");
  const errorKeys = Object.keys(error!).sort();
  const expectedError = ["code", "details", "message", "retryable"];
  if (errorKeys.length !== expectedError.length || errorKeys.some((key, index) => key !== expectedError[index])) invalid("error fields differ from v1");
  if (!(FLEET_ERROR_CODES as readonly string[]).includes(error!.code)) invalid("error code is invalid");
  if (typeof error!.message !== "string" || error!.message.length === 0 || error!.message.length > MAX_STRING) invalid("error message is invalid");
  if (typeof error!.retryable !== "boolean") invalid("error retryable is invalid");
  const details = error!.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) invalid("error details must be an object");
  const entries = Object.entries(details);
  if (entries.length > MAX_DETAILS) invalid("error details are too large");
  for (const [key, value] of entries) {
    if (!key || !(["string", "number", "boolean"].includes(typeof value) || value === null)) invalid("error details are invalid");
  }
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

function section(lines: string[], title: string): void {
  lines.push("");
  lines.push(`  ${bold(cyan(glyph.chevron))} ${bold(title)}`);
}

/** Report in the `formatAuditReport` house style. The caller does the printing. */
export function formatFleetContractReport(inspection: FleetContractInspection): string {
  const ok = inspection.diagnostics.length === 0;
  const lines = [""];

  const headline = ok
    ? `${green(glyph.pass)} ${bold("Handbook valid")}`
    : `${red(glyph.fail)} ${bold("Handbook invalid")}`;
  const tally = ok
    ? [green(`${inspection.authorities.length} authorities`), green(`${inspection.classifications.length} lifecycle classes`)]
    : [red(`${inspection.diagnostics.length} finding${inspection.diagnostics.length === 1 ? "" : "s"}`)];
  lines.push(`  ${headline}  ${dim(glyph.dot)}  ${joinDot(tally)}`);

  const facts = [dim(inspection.contract_path)];
  if (inspection.contract_version) facts.push(dim(`contract ${inspection.contract_version}`));
  if (inspection.schema_version !== null) facts.push(dim(`schema ${inspection.schema_version}`));
  if (inspection.compatibility) {
    facts.push(dim(`compatible ${inspection.compatibility.min_schema_version}..${inspection.compatibility.max_schema_version}`));
  }
  facts.push(dim(`supported ${inspection.supported_schema_versions.min}..${inspection.supported_schema_versions.max}`));
  if (ok) facts.push(inspection.byte_stable ? dim("byte-stable round trip") : yellow("round trip NOT byte-stable"));
  lines.push(`  ${joinDot(facts)}`);

  if (inspection.truncated.length) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${bold("Report clipped to envelope bounds")}  ${dim(glyph.dot)}  ${dim("the file on disk is complete")}`);
    for (const note of inspection.truncated) lines.push(`     ${dim(glyph.arrow)} ${dim(note)}`);
  }

  if (!ok) {
    section(lines, "Findings");
    const width = inspection.diagnostics.reduce((max, item) => Math.max(max, item.code.length), 0);
    for (const diagnostic of inspection.diagnostics) {
      lines.push(`    ${red(glyph.fail)}  ${red(diagnostic.code.padEnd(width))}  ${diagnostic.path}`);
      lines.push(`       ${dim(glyph.arrow)} ${dim(diagnostic.message)}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  section(lines, "Authority owners");
  const authorityWidth = inspection.authorities.reduce((max, item) => Math.max(max, item.id.length), 0);
  const ownerWidth = inspection.authorities.reduce((max, item) => Math.max(max, item.owner.length), 0);
  for (const authority of inspection.authorities) {
    const style = statusStyle(authority.read_only ? "skip" : "pass");
    const count = authority.read_only ? "read-only" : `${authority.writable_fields.length} writable field${authority.writable_fields.length === 1 ? "" : "s"}`;
    lines.push(`    ${style.color(style.glyph)}  ${authority.id.padEnd(authorityWidth)}  ${cyan(authority.owner.padEnd(ownerWidth))}  ${dim(count)}`);
    // A read-only authority (the process table) resolves from no env key at
    // all; `via` with nothing after it read as a truncated line.
    const resolvedBy = authority.store_env.length ? ` via ${bounded(authority.store_env.join(", "))}` : "";
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${bounded(authority.store)}${resolvedBy}`)}`);
  }

  section(lines, "Projections");
  const projectionWidth = inspection.projections.reduce((max, item) => Math.max(max, item.field.length), 0);
  for (const projection of inspection.projections) {
    lines.push(`    ${green(glyph.pass)}  ${projection.field.padEnd(projectionWidth)}  ${cyan(projection.writable_by)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${projection.source} -> ${projection.target}`)}`);
  }

  section(lines, "Lifecycle classes");
  const classWidth = inspection.classifications.reduce((max, item) => Math.max(max, item.id.length), 0);
  for (const classification of inspection.classifications) {
    lines.push(`    ${green(glyph.pass)}  ${classification.id.padEnd(classWidth)}  ${dim(`${classification.entry_count} declared entr${classification.entry_count === 1 ? "y" : "ies"}`)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`requires ${classification.required_fields.join(", ")}`)}`);
  }

  section(lines, "Canonical service model");
  for (const line of describeTree(inspection.service_model)) lines.push(`    ${dim(glyph.bullet)} ${line}`);

  section(lines, "Activation");
  for (const line of describeTree(inspection.activation)) lines.push(`    ${dim(glyph.bullet)} ${line}`);

  section(lines, "Superseded modes");
  const retiredWidth = inspection.retired.reduce((max, item) => Math.max(max, item.id.length), 0);
  for (const mode of inspection.retired) {
    lines.push(`    ${gray(glyph.skip)}  ${gray(mode.id.padEnd(retiredWidth))}  ${dim(mode.reason)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`superseded by ${mode.superseded_by}`)}`);
  }

  section(lines, "Extensions (recorded, never policy)");
  if (inspection.extensions.length === 0) lines.push(`    ${dim("none")}`);
  else for (const extension of inspection.extensions) lines.push(`    ${dim(glyph.dot)} ${yellow(extension.path)}`);

  lines.push("");
  return lines.join("\n");
}

/** Flatten a bounded open-keyed subtree into `a.b.c  value` report lines. */
function describeTree(node: unknown, prefix = ""): string[] {
  if (node === null || node === undefined) return [dim("not declared")];
  const flat: Array<[string, string]> = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item !== "object" || item === null)) {
        flat.push([path, value.map((item) => String(item)).join(" -> ")]);
        return;
      }
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, path ? `${path}.${key}` : key);
      return;
    }
    flat.push([path, String(value)]);
  };
  walk(node, prefix);
  const width = flat.reduce((max, [path]) => Math.max(max, path.length), 0);
  return flat.map(([path, value]) => `${padVisible(path, width)}  ${cyan(value)}`);
}

// ---------------------------------------------------------------------------
// Inventory report
// ---------------------------------------------------------------------------

/** How many rows the human report prints before it says how many it withheld. */
const REPORT_MAX_ROWS = 60;
/** How many findings the human report lists in the "top findings" block. */
const REPORT_MAX_FINDINGS = 25;

function fieldCell(value: FleetFieldValue<unknown>): string {
  const shown = value.value === null
    ? "-"
    : Array.isArray(value.value)
      ? value.value.map((item) => String(item)).join(", ")
      : typeof value.value === "object"
        ? Object.entries(value.value as Record<string, unknown>).filter(([, item]) => item !== null).map(([key, item]) => `${key}=${String(item)}`).join(" ")
        : String(value.value);
  return bounded(shown || "-");
}

function stateColor(state: string): (value: string | number) => string {
  if (state === "resolved") return green;
  if (state === "conflicted") return red;
  if (state === "unobserved") return gray;
  return yellow;
}

function findingGlyph(severity: FleetInventoryFinding["severity"]): string {
  if (severity === "error") return red(glyph.fail);
  if (severity === "warn") return yellow(glyph.warn);
  return dim(glyph.info);
}

/**
 * One reason an employee's row is not clean: a finding, or a conflict group
 * they are a claimant in.
 *
 * Findings and conflicts used to be two sections of their own, so "what is
 * wrong with THIS agent" meant scrolling three blocks and matching opaque
 * conflict ids by eye. To the operator they are the same thing -- a reason this
 * row is not clean -- so they share one shape and print UNDER the row they
 * belong to. Nothing here changes the envelope: both lists are still emitted
 * whole, in their own order, by the inventory the CLI hands `--json`.
 */
interface InventoryIssue {
  /** 2 broken, 1 imperfect, 0 informational. Drives the row glyph and the tally. */
  rank: 0 | 1 | 2;
  glyph: string;
  code: string;
  field: string;
  owner: string | null;
  detail: string;
  /** Set only in the unattributed block, where the row above no longer names the subject. */
  subject?: string | null;
}

function findingIssue(finding: FleetInventoryFinding): InventoryIssue {
  return {
    rank: finding.severity === "error" ? 2 : finding.severity === "warn" ? 1 : 0,
    glyph: findingGlyph(finding.severity),
    code: finding.code,
    field: finding.field,
    owner: finding.source,
    detail: finding.detail,
    subject: finding.agent_id,
  };
}

/**
 * A conflict group, told from the point of view of ONE of its claimants.
 *
 * The group's own section named every participant, including the agent whose
 * row it sat nowhere near. Under a row the useful half is who ELSE claims the
 * value, so that is what it says -- and the group id stays on the line, because
 * that is the handle the remediation takes.
 */
function conflictIssue(group: FleetConflictGroup, agentId: string): InventoryIssue {
  const others = group.participants.filter((participant) => participant !== agentId);
  const verdict = group.permitted
    ? `permitted${group.exception_id ? ` by ${bounded(group.exception_id)}` : ""}`
    : "unpermitted";
  const claimants = others.length
    ? `also claimed by ${others.join(", ")}`
    : `claimed by ${group.participants.join(", ") || "nobody named"}`;
  return {
    rank: group.permitted ? 1 : 2,
    glyph: group.permitted ? gray(glyph.skip) : red(glyph.fail),
    code: "conflict",
    field: group.field,
    owner: group.owners.join(", ") || null,
    detail: `${bounded(group.value)} ${glyph.dot} ${claimants} ${glyph.dot} ${verdict} ${glyph.dot} ${group.id}`,
  };
}

/** A conflict a row names that the report cannot find. Silence here is a tally that does not add up. */
function danglingConflictIssue(id: string): InventoryIssue {
  return {
    rank: 2,
    glyph: red(glyph.fail),
    code: "conflict",
    field: "-",
    owner: null,
    detail: `${bounded(id)} ${glyph.dot} this row names a conflict group that is missing from the report`,
  };
}

/** Worst rank in a set. An informational finding must never make a row look broken. */
function worstRank(issues: readonly InventoryIssue[]): 0 | 1 | 2 {
  let worst: 0 | 1 | 2 = 0;
  for (const issue of issues) if (issue.rank > worst) worst = issue.rank;
  return worst;
}

/**
 * The cells the row model does not declare YET.
 *
 * `tickets` and `state` are being built by the provider work in flight. This
 * reads them through an index signature rather than a widened row type, so the
 * renderer does not have to guess the shape that lands: a scalar, or the
 * `{ value, source, state }` field shape every other cell already uses, both
 * render. Until one lands the column prints its placeholder rather than
 * `undefined`, and this file never fetches anything itself.
 */
function optionalCell(row: FleetInventoryRow, key: string): string | null {
  return scalarCell((row as unknown as Record<string, unknown>)[key]);
}

/**
 * Keys a cell-shaped object might carry its one printable value under, in the
 * order they win. `value` is the `FleetFieldValue` shape the rest of the row
 * uses; `total` and `state` are the ones the live provider's `LiveTickets` and
 * `LiveAgentState` carry. An object whose value is absent -- an unmeasured
 * ticket count, an agent with no live record -- resolves to null and prints the
 * placeholder, never a zero it did not measure.
 */
const CELL_VALUE_KEYS = ["value", "total", "state", "label", "count"] as const;

function scalarCell(raw: unknown, depth = 0): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw.trim() ? bounded(raw, 64) : null;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) {
    const parts = raw.map((item) => scalarCell(item, depth + 1)).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(", ") : null;
  }
  if (depth < 2 && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of CELL_VALUE_KEYS) {
      if (record[key] === undefined) continue;
      const nested = scalarCell(record[key], depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** The board an agent is bound to, in the short form an operator says out loud. */
function boardCell(board: FleetInventoryRow["board"]): string | null {
  const value = board.value;
  if (!value) return null;
  return bounded(value.identifier ?? value.workspace ?? value.project_id ?? "", 32) || null;
}

/** A cell nothing has reported yet. Deliberately not `-`, which this report already means "declared nothing". */
const PENDING_CELL = "—";

/** Column ceilings, so one pathological id cannot push the table off the terminal. */
const ROSTER_WIDTHS = { id: 28, repo: 22, role: 16, board: 12, tickets: 7, state: 13 } as const;
/** How far the three text columns may be squeezed before the table is allowed to overrun instead. */
const ROSTER_FLOORS = { role: 6, repo: 8, id: 12 } as const;
/** How many issue lines the block nobody's row owns may take, so a footnote can never become the report. */
const REPORT_MAX_UNATTRIBUTED = 8;
/** Columns held back for the row's own tally, so a narrow terminal never eats the verdict on the row. */
const ROSTER_TALLY_RESERVE = 12;
/** Indent, glyph, and the six two-space gaps between the seven columns. */
const ROSTER_CHROME = 4 + 1 + 2 + 2 * 5;

/** One printable employee row. Cells stay RAW here: the fit below still moves the columns. */
interface RosterEntry {
  glyph: string;
  id: string;
  repo: string;
  repoPaint: (value: string | number) => string;
  role: string;
  board: string;
  tickets: string;
  state: string;
  /** Every issue against this agent, worst first. `shown` is how many the cap left room for. */
  issues: InventoryIssue[];
  shown: number;
}

/** The row's own verdict: how many of each severity, in the glyph vocabulary the rest of the file uses. */
function issueTally(issues: readonly InventoryIssue[]): string {
  const counts = [2, 1, 0].map((rank) => issues.filter((issue) => issue.rank === rank).length);
  const paints = [red, yellow, dim];
  const glyphs = [glyph.fail, glyph.warn, glyph.info];
  return counts
    .map((count, index) => (count ? paints[index]!(`${count}${glyphs[index]}`) : ""))
    .filter(Boolean)
    .join(" ");
}

/**
 * One issue, indented under the row it belongs to.
 *
 * The contract path and the owning store go LAST on purpose. They are the least
 * of what an operator needs and the first thing a narrow terminal should eat,
 * and the tail is truncated BEFORE it is coloured -- `truncateVisible` on an
 * already-coloured string drops every escape in it, which would leave exactly
 * the long lines that matter most rendered in no colour at all.
 */
function issueLine(issue: InventoryIssue, codeWidth: number, subjectWidth: number, width: number): string {
  const subject = subjectWidth
    ? `${padVisible(issue.subject ? cyan(bounded(issue.subject, 64)) : dim("-"), subjectWidth)}  `
    : "";
  const head = `       ${issue.glyph} ${subject}${padVisible(issue.code, codeWidth)}  `;
  const tail = `${issue.detail} ${glyph.dot} ${issue.field} ${glyph.dot} owner ${issue.owner ?? "undeclared"}`;
  return `${head}${dim(truncateVisible(tail, Math.max(24, width - visibleWidth(head))))}`;
}

/**
 * Report in the `formatFleetContractReport` house style. The caller prints it.
 *
 * ONE ENTRY PER AGENT, and the whole shape of this function follows from that.
 * This report used to be six blocks -- verdict, stores, totals, conflict
 * groups, agents, findings -- and four of them listed agents again, so
 * answering "what is wrong with `condaleeza`" meant reading the same 25 names
 * four times and correlating an opaque conflict id by hand. Now the roster IS
 * the report: one row per employee, that employee's findings and conflicts
 * indented underneath, and everything that was a section reduced to the footer
 * counts it was actually carrying.
 *
 * The health verdict still leads. An unhealthy fleet exits 0 -- conflicts are
 * data, not a command failure -- so a report that opened with the table would
 * let "the command worked" read as "the fleet is fine". It is ONE line now
 * rather than a block of its own.
 */
export function formatFleetInventoryReport(inventory: FleetInventory): string {
  const { health, totals } = inventory;
  const lines = [""];
  const width = terminalWidth();

  const verdict = health.healthy
    ? `${green(glyph.pass)} ${bold("Org chart in good standing")}`
    : `${red(glyph.fail)} ${bold("Org chart ON NOTICE")}`;
  // The verdict's own reasons ride WITH it rather than under it. They were
  // computed, shipped in JSON and once rendered nowhere -- so the operator who
  // cannot run `--json` could see THAT the fleet was unhealthy, never why.
  const why = [
    health.conflicts ? red(`${health.conflicts} unpermitted conflict${health.conflicts === 1 ? "" : "s"}`) : green("0 unpermitted conflicts"),
    health.unresolved_rows ? yellow(`${health.unresolved_rows} unresolved`) : dim("0 unresolved"),
    health.contract_violations ? red(`${health.contract_violations} contract violation${health.contract_violations === 1 ? "" : "s"}`) : dim("0 contract violations"),
    health.malformed_rows ? red(`${health.malformed_rows} malformed`) : dim("0 malformed"),
    health.collection_errors ? red(`${health.collection_errors} unreadable store${health.collection_errors === 1 ? "" : "s"}`) : dim("0 unreadable stores"),
  ];
  lines.push(`  ${verdict}  ${dim(glyph.dot)}  ${joinDot(why)}`);

  // ---- regroup. Every finding already carries its `agent_id`, so this is sorting, not work.
  const conflictsById = new Map(inventory.conflicts.map((group) => [group.id, group]));
  const findingsByAgent = new Map<string, FleetInventoryFinding[]>();
  const unattributed: InventoryIssue[] = [];
  for (const finding of inventory.findings) {
    if (!finding.agent_id) { unattributed.push(findingIssue(finding)); continue; }
    const bucket = findingsByAgent.get(finding.agent_id);
    if (bucket) bucket.push(finding);
    else findingsByAgent.set(finding.agent_id, [finding]);
  }

  const shownRows = inventory.rows.slice(0, REPORT_MAX_ROWS);
  const claimedConflicts = new Set<string>();
  const claimedAgents = new Set<string>();
  const plain = (value: string | number): string => String(value);

  const entries: RosterEntry[] = shownRows.map((row) => {
    const id = row.agent_id.value ?? "<unnamed>";
    claimedAgents.add(id);
    const conflicts = row.conflicts.map((conflictId) => {
      const group = conflictsById.get(conflictId);
      if (!group) return danglingConflictIssue(conflictId);
      claimedConflicts.add(conflictId);
      return conflictIssue(group, id);
    });
    const issues = [...conflicts, ...(findingsByAgent.get(id) ?? []).map(findingIssue)]
      .sort((left, right) => right.rank - left.rank);
    // The glyph is the worst thing about this row -- and an `info` finding is
    // not one of them: a row carrying only `board-binding-missing` stays green.
    const rank = Math.max(
      worstRank(issues),
      row.malformed ? 1 : 0,
      row.project_id.state === "resolved" ? 0 : 1,
    ) as 0 | 1 | 2;
    const projectState = row.conflicts.length ? "conflicted" : row.project_id.state;
    return {
      glyph: rank === 2 ? red(glyph.fail) : rank === 1 ? yellow(glyph.warn) : green(glyph.pass),
      id: bounded(id, 128),
      repo: bounded(row.repo.value ?? row.project_id.value ?? "-"),
      repoPaint: projectState === "resolved" ? plain : stateColor(projectState),
      role: fieldCell(row.role),
      board: boardCell(row.board) ?? "-",
      tickets: optionalCell(row, "tickets") ?? PENDING_CELL,
      state: optionalCell(row, "state") ?? PENDING_CELL,
      issues,
      shown: 0,
    };
  });

  // Whatever the rows did not claim still has to be said out loud. A conflict
  // between two PROJECT records has no agent row to sit under, and a finding can
  // name an agent this scope or the row cap left out of the run.
  for (const group of inventory.conflicts) {
    if (claimedConflicts.has(group.id)) continue;
    unattributed.push({ ...conflictIssue(group, ""), subject: null });
  }
  for (const [agentId, findings] of findingsByAgent) {
    if (claimedAgents.has(agentId)) continue;
    for (const finding of findings) unattributed.push(findingIssue(finding));
  }
  unattributed.sort((left, right) => right.rank - left.rank);

  // ---- bound the detail. Worst severity first, then round robin WITHIN a
  // severity, rows before the block nobody's row owns.
  //
  // Every clause there is paid for. A straight walk down the list spends the
  // whole budget on the first few agents and leaves every later one looking
  // clean, which is the exact lie a cap must not tell. Severity first, so one
  // agent's second warning never crowds out another agent's error -- and a
  // fleet-level error still beats every agent's warning, because it is served
  // in the same pass as theirs. Rows before the unattributed block, because
  // `flume roster <employee>` still carries the whole fleet's findings: served
  // the other way round, the one agent you asked about got three lines and
  // twenty-two went to agents you did not.
  const fleetBucket = { issues: unattributed, shown: 0 };
  let budget = REPORT_MAX_FINDINGS;
  let fleetRoom = REPORT_MAX_UNATTRIBUTED;
  for (const rank of [2, 1, 0] as const) {
    let served = 1;
    while (budget > 0 && served > 0) {
      served = 0;
      for (const entry of entries) {
        if (budget <= 0) break;
        if (entry.issues[entry.shown]?.rank !== rank) continue;
        entry.shown += 1;
        budget -= 1;
        served += 1;
      }
    }
    while (budget > 0 && fleetRoom > 0 && fleetBucket.issues[fleetBucket.shown]?.rank === rank) {
      fleetBucket.shown += 1;
      budget -= 1;
      fleetRoom -= 1;
    }
  }
  const withheldIssues = [fleetBucket, ...entries]
    .reduce((sum, bucket) => sum + (bucket.issues.length - bucket.shown), 0);

  section(lines, "Agents");
  // ---- fit the columns to the terminal, squeezing the text columns before the
  // tally, so the row's verdict is never the part that falls off the edge.
  const columnWidth = (label: string, values: string[], max: number): number =>
    Math.min(max, values.reduce((wide, value) => Math.max(wide, value.length), label.length));
  const columns = {
    id: columnWidth("agent", entries.map((entry) => entry.id), ROSTER_WIDTHS.id),
    repo: columnWidth("repo/project", entries.map((entry) => entry.repo), ROSTER_WIDTHS.repo),
    role: columnWidth("role", entries.map((entry) => entry.role), ROSTER_WIDTHS.role),
    board: columnWidth("board", entries.map((entry) => entry.board), ROSTER_WIDTHS.board),
    tickets: columnWidth("tickets", entries.map((entry) => entry.tickets), ROSTER_WIDTHS.tickets),
    state: columnWidth("state", entries.map((entry) => entry.state), ROSTER_WIDTHS.state),
  };
  let overflow = ROSTER_CHROME + ROSTER_TALLY_RESERVE
    + Object.values(columns).reduce((sum, value) => sum + value, 0) - width;
  for (const key of ["role", "repo", "id"] as const) {
    if (overflow <= 0) break;
    const give = Math.min(overflow, Math.max(0, columns[key] - ROSTER_FLOORS[key]));
    columns[key] -= give;
    overflow -= give;
  }
  const cell = (value: string, paint: (input: string | number) => string, wide: number): string =>
    padVisible(paint(truncateVisible(value, wide)), wide);

  lines.push(dim(`       ${cell("agent", plain, columns.id)}  ${cell("repo/project", plain, columns.repo)}  `
    + `${cell("role", plain, columns.role)}  ${cell("board", plain, columns.board)}  `
    + `${cell("tickets", plain, columns.tickets)}  ${cell("state", plain, columns.state)}  errors`));
  if (entries.length === 0) lines.push(`    ${dim("no agent rows in this report -- the verdict above says why")}`);
  const printed = [fleetBucket, ...entries].flatMap((bucket) => bucket.issues.slice(0, bucket.shown));
  const codeWidth = printed.reduce((wide, issue) => Math.max(wide, issue.code.length), 0);
  for (const entry of entries) {
    // The tally is over EVERY issue this agent has, not the ones that fit: a
    // row whose detail the cap withheld must still say how bad it is.
    const row = `    ${entry.glyph}  ${cell(entry.id, plain, columns.id)}  ${cell(entry.repo, entry.repoPaint, columns.repo)}  `
      + `${cell(entry.role, cyan, columns.role)}  ${cell(entry.board, dim, columns.board)}  `
      + `${cell(entry.tickets, dim, columns.tickets)}  ${cell(entry.state, dim, columns.state)}  ${issueTally(entry.issues)}`;
    lines.push(row.trimEnd());
    for (const issue of entry.issues.slice(0, entry.shown)) lines.push(issueLine(issue, codeWidth, 0, width));
    const held = entry.issues.length - entry.shown;
    if (held) lines.push(`       ${dim(`... ${held} more on this agent, not shown -- use --json`)}`);
  }
  if (inventory.rows.length > REPORT_MAX_ROWS) {
    lines.push(`    ${yellow(glyph.warn)} ${dim(`${inventory.rows.length - REPORT_MAX_ROWS} more agent(s) NOT SHOWN; the report prints ${REPORT_MAX_ROWS} rows -- use --json for all of them`)}`);
  }

  if (fleetBucket.shown) {
    lines.push("");
    // Not always fleet-level: a scoped run still carries the whole fleet's
    // findings, so this block holds anything with no row of its own ABOVE it.
    lines.push(`  ${dim(glyph.arrow)} ${dim("no row above owns these")}`);
    // Zero when nothing in the block names an agent, so the two registry-level
    // duplicates do not each print a column containing one dash.
    const subjectWidth = unattributed.slice(0, fleetBucket.shown)
      .reduce((wide, issue) => Math.max(wide, issue.subject ? issue.subject.length : 0), 0);
    for (const issue of unattributed.slice(0, fleetBucket.shown)) lines.push(issueLine(issue, codeWidth, subjectWidth, width));
  }
  if (withheldIssues) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${dim(`${withheldIssues} more finding(s)/conflict(s) NOT SHOWN -- this report caps issue lines at ${REPORT_MAX_FINDINGS}, and at ${REPORT_MAX_UNATTRIBUTED} for the ones no row owns; use --json for all of them`)}`);
  }

  // ---- the footer says in one line what the Stores, Totals and Conflict-group
  // sections spent three blocks saying. `source_rows` and `emitted_rows` stay
  // spelled out: they are counted in two independent passes and their agreement
  // is the one check that says no agent was lost between counting and building.
  const storesOk = inventory.stores.filter((store) => store.exists && store.parse === "ok").length;
  lines.push("");
  lines.push(`  ${joinDot([
    `${totals.observed} agent${totals.observed === 1 ? "" : "s"}`,
    health.conflicts ? red(`${health.conflicts} conflict${health.conflicts === 1 ? "" : "s"}`) : dim("0 conflicts"),
    ...(health.permitted_conflicts ? [dim(`${health.permitted_conflicts} permitted`)] : []),
    // "parsed", not "ok": a store can parse as YAML and still carry no fleet,
    // which is a `collection_errors` in the verdict above. Two lines of the same
    // report calling that store both "ok" and "unreadable" is how an operator
    // stops believing either of them.
    storesOk === inventory.stores.length
      ? (health.collection_errors ? yellow(`${storesOk} store${storesOk === 1 ? "" : "s"} parsed`) : green(`${storesOk} store${storesOk === 1 ? "" : "s"} parsed`))
      : red(`${storesOk} of ${inventory.stores.length} stores parsed`),
    totals.findings ? `${totals.findings} findings` : dim("0 findings"),
    totals.source_rows === totals.emitted_rows
      ? dim(`source_rows ${totals.source_rows} = emitted_rows ${totals.emitted_rows}`)
      : red(`source_rows ${totals.source_rows} != emitted_rows ${totals.emitted_rows}; a row was lost between counting and building`),
    `contract ${inventory.contract_version ?? "?"}`,
  ])}`);
  lines.push(`  ${joinDot([dim(inventory.scope.label), dim(inventory.contract_path)])}`);
  // A store the report could not read is the one store fact that cannot live in
  // a count: the operator needs the path to go and fix it.
  for (const store of inventory.stores) {
    if (store.exists && store.parse === "ok") continue;
    const style = statusStyle(store.exists ? "warn" : "fail");
    lines.push(`  ${style.color(style.glyph)} ${dim(`${store.id} ${glyph.dot} ${store.parse} ${glyph.dot} ${store.overridden ? store.inspected_path : store.configured_path}`)}`);
  }

  if (inventory.truncated.length) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${bold("Report clipped to envelope bounds")}  ${dim(glyph.dot)}  ${dim("the stores on disk are complete")}`);
    for (const note of inventory.truncated) lines.push(`     ${dim(glyph.arrow)} ${dim(note)}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Provenance report
// ---------------------------------------------------------------------------

/** How many facts the human report prints before it says how many it withheld. */
const REPORT_MAX_FACTS = 80;
/** How many probe records the human report lists. */
const REPORT_MAX_PROBES = 30;

function provenanceGlyph(status: FleetProvenanceStatus): string {
  if (status === "match") return green(glyph.pass);
  if (status === "mismatch") return red(glyph.fail);
  if (status === "dirty" || status === "missing") return yellow(glyph.warn);
  return gray(glyph.skip);
}

function provenanceColor(status: FleetProvenanceStatus): (value: string | number) => string {
  if (status === "match") return green;
  if (status === "mismatch") return red;
  if (status === "dirty" || status === "missing") return yellow;
  return gray;
}

function sideCell(side: { value: string | null; family: string | null }): string {
  const shown = side.value ?? "-";
  return bounded(side.family && side.family !== "pinned-release" ? `${shown} [${side.family}]` : shown);
}

function factLines(fact: FleetProvenanceFact, idWidth: number): string[] {
  const style = provenanceColor(fact.status);
  const subject = fact.agent_id ? `${fact.agent_id} ${glyph.dot} ${fact.id}` : fact.id;
  const lines = [
    `    ${provenanceGlyph(fact.status)}  ${padVisible(bounded(subject), idWidth)}  ${style(fact.status)}`,
    `       ${dim(glyph.arrow)} ${dim(`desired ${sideCell(fact.desired)} (${fact.desired.source ?? "no source"}/${fact.desired.state})`)}`,
    `       ${dim(glyph.arrow)} ${dim(`observed ${sideCell(fact.observed)} (${fact.observed.source ?? "no source"}/${fact.observed.state})`)}`,
  ];
  // The reason a fact is anything other than a match is the half an operator
  // acts on. A match needs no explanation and printing one for all 300 would
  // bury the ones that do.
  if (fact.status !== "match") lines.push(`       ${dim(glyph.arrow)} ${dim(fact.detail)}`);
  return lines;
}

function probeLine(record: FleetProbeRecord, kindWidth: number): string {
  const ok = record.outcome === "ok";
  const style = statusStyle(ok ? "pass" : record.outcome === "skipped" ? "skip" : "fail");
  const reason = record.reason ? `  ${dim(record.reason)}` : "";
  return `    ${style.color(style.glyph)}  ${padVisible(record.kind, kindWidth)}  ${dim(record.target)}  ${style.color(record.outcome)}${reason}`;
}

/**
 * Report in the `formatFleetInventoryReport` house style. The caller prints it.
 *
 * The verdict leads, and its REASONS lead with it. A drifted fleet exits 0 --
 * provenance drift is data, not a command failure -- so an operator on the human
 * path has to be able to see WHY provenance is unhealthy, not only that it is.
 * The two verdicts are deliberately separate: `healthy` is about drift,
 * `complete` is about whether everything that should have been observed was, and
 * a run that could not reach half the fleet must never read as a clean bill.
 */
export function formatFleetProvenanceReport(provenance: FleetProvenance): string {
  const { health, totals } = provenance;
  const lines = [""];

  const headline = health.healthy
    ? `${green(glyph.pass)} ${bold("Employment records in good standing")}`
    : `${red(glyph.fail)} ${bold("Employment records ON NOTICE")}`;
  lines.push(`  ${headline}  ${dim(glyph.dot)}  ${joinDot([
    `${totals.emitted_facts} of ${totals.facts} facts`,
    `${totals.agents} agent${totals.agents === 1 ? "" : "s"}`,
    health.complete ? green("complete") : yellow("INCOMPLETE"),
  ])}`);
  const why = [
    health.mismatched ? red(`${health.mismatched} mismatched`) : dim("0 mismatched"),
    health.dirty ? red(`${health.dirty} dirty`) : dim("0 dirty"),
    health.missing ? yellow(`${health.missing} missing`) : dim("0 missing"),
    health.unsupported ? gray(`${health.unsupported} unsupported`) : dim("0 unsupported"),
    health.unobserved ? yellow(`${health.unobserved} unobserved`) : dim("0 unobserved"),
    health.probe_failures ? red(`${health.probe_failures} probe failure${health.probe_failures === 1 ? "" : "s"}`) : dim("0 probe failures"),
  ];
  lines.push(`  ${dim(glyph.arrow)} ${joinDot(why)}`);
  lines.push(`  ${joinDot([dim(provenance.scope.label), dim(provenance.contract_path), dim(`contract ${provenance.contract_version ?? "?"}`)])}`);

  section(lines, "Sources");
  const sourceWidth = provenance.sources.reduce((max, source) => Math.max(max, source.id.length), 0);
  for (const source of provenance.sources) {
    const style = statusStyle(source.exists && source.parse === "ok" ? "pass" : "fail");
    lines.push(`    ${style.color(style.glyph)}  ${padVisible(source.id, sourceWidth)}  ${cyan(source.kind)}  ${dim(source.configured_path)}`);
    if (source.inspected_path !== source.configured_path) {
      lines.push(`       ${dim(glyph.arrow)} ${yellow(`inspected ${source.inspected_path}`)}`);
    }
  }

  section(lines, "Totals");
  for (const [label, value] of Object.entries(totals)) {
    if (label === "by_status") continue;
    lines.push(`    ${dim(glyph.bullet)} ${padVisible(label, 24)}  ${cyan(String(value))}`);
  }
  for (const [status, count] of Object.entries(totals.by_status)) {
    lines.push(`    ${dim(glyph.bullet)} ${padVisible(`by_status.${status}`, 24)}  ${provenanceColor(status as FleetProvenanceStatus)(String(count))}`);
  }

  section(lines, "Probes");
  if (provenance.probes.length === 0) lines.push(`    ${dim("none")}`);
  const kindWidth = provenance.probes.reduce((max, record) => Math.max(max, record.kind.length), 0);
  for (const record of provenance.probes.slice(0, REPORT_MAX_PROBES)) lines.push(probeLine(record, kindWidth));
  if (provenance.probes.length > REPORT_MAX_PROBES) {
    lines.push(`    ${dim(`... ${provenance.probes.length - REPORT_MAX_PROBES} more probe(s); use --json for all of them`)}`);
  }

  section(lines, "Facts");
  // Drift first, then everything else. An operator scanning 300 facts for the
  // handful that need a decision should not have to scroll past 200 matches.
  const ranked = [...provenance.facts].sort((a, b) => {
    const rank = (status: FleetProvenanceStatus): number => (status === "match" ? 1 : 0);
    return rank(a.status) - rank(b.status);
  });
  const factWidth = ranked.slice(0, REPORT_MAX_FACTS)
    .reduce((max, fact) => Math.max(max, (fact.agent_id ? `${fact.agent_id} ${glyph.dot} ${fact.id}` : fact.id).length), 0);
  for (const fact of ranked.slice(0, REPORT_MAX_FACTS)) for (const line of factLines(fact, factWidth)) lines.push(line);
  if (ranked.length > REPORT_MAX_FACTS) {
    lines.push(`    ${dim(`... ${ranked.length - REPORT_MAX_FACTS} more fact(s); use --json for all of them`)}`);
  }

  section(lines, "Findings");
  if (provenance.findings.length === 0) lines.push(`    ${dim("none")}`);
  const codeWidth = provenance.findings.slice(0, REPORT_MAX_FINDINGS).reduce((max, item) => Math.max(max, item.code.length), 0);
  for (const finding of provenance.findings.slice(0, REPORT_MAX_FINDINGS)) {
    lines.push(`    ${findingGlyph(finding.severity)}  ${padVisible(finding.code, codeWidth)}  ${dim(finding.field)}${finding.agent_id ? `  ${cyan(finding.agent_id)}` : ""}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${finding.detail} ${glyph.dot} owner ${finding.source ?? "undeclared"}`)}`);
  }
  if (provenance.findings.length > REPORT_MAX_FINDINGS) {
    lines.push(`    ${dim(`... ${provenance.findings.length - REPORT_MAX_FINDINGS} more finding(s); use --json for all of them`)}`);
  }

  if (provenance.truncated.length) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${bold("Report clipped to envelope bounds")}  ${dim(glyph.dot)}  ${dim("the sources on disk are complete")}`);
    for (const note of provenance.truncated) lines.push(`     ${dim(glyph.arrow)} ${dim(note)}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Status report
// ---------------------------------------------------------------------------

/** How many agent records the human report prints before it says how many it withheld. */
const REPORT_MAX_AGENTS = 40;
/** How many actionable observations the human report lists. */
const REPORT_MAX_OBSERVATIONS = 40;
/** How many baseline transitions the human report lists. */
const REPORT_MAX_TRANSITIONS = 30;
/** How many typed items one scaffold observation prints before it says how many it withheld. */
const REPORT_MAX_ITEMS = 5;

function statusGlyph(state: FleetStatusState): string {
  if (state === "pass") return green(glyph.pass);
  if (state === "fail" || state === "error") return red(glyph.fail);
  if (state === "warn" || state === "unobserved") return yellow(glyph.warn);
  return gray(glyph.skip);
}

function statusColor(state: FleetStatusState): (value: string | number) => string {
  if (state === "pass") return green;
  if (state === "fail" || state === "error") return red;
  if (state === "warn" || state === "unobserved") return yellow;
  return gray;
}

/** The verdict's own colour. `unproven` is not a failure and must not read as one. */
function verdictColor(verdict: FleetStatusVerdict): (value: string | number) => string {
  if (verdict === "healthy") return green;
  if (verdict === "unhealthy") return red;
  return yellow;
}

function severityColor(severity: FleetStatusSeverity): (value: string | number) => string {
  if (severity === "critical" || severity === "high") return red;
  if (severity === "medium") return yellow;
  if (severity === "low") return gray;
  return dim;
}

/** Item kinds that are imperfections rather than failures: painted yellow, not red. */
const REPORT_SOFT_ITEM_KINDS: ReadonlySet<string> = new Set([
  "wrong-mode", "unexpected-owned", "unknown-key", "unverifiable",
  // Story 1.8. A tick still running, a reconcile policy nobody declared, and a
  // gateway that is undeclared but correctly disabled are warnings, not
  // failures: the observer ranks them `warn`, and the report must agree.
  "in-progress", "reconcile-undeclared", "reconcile-opt-out-undeclared", "reconcile-unverifiable",
  "latest-result-unknown", "tick-unknown", "schedule-unknown",
]);
/**
 * `channel-undeclared` is the ONE kind whose rank depends on the reading beside
 * it: a row that declares no messaging capability is a `warn` while its gateway
 * is correctly disabled and inactive, and a `fail` the moment that gateway is
 * enabled or running -- which is the liveness theatre the epic forbids. The
 * item's own `observed` half carries the distinction, so the report reads it
 * rather than guessing from the kind.
 */
const REPORT_UNDECLARED_SOFT_OBSERVED = "absent";
/** Bank codes that mean the pin file exists but cannot be read as a pin. Printed `bank invalid`, never `unpinned`. (`too-large` and `unreadable` rank `error` and print as that state.) */
const REPORT_BANK_INVALID_CODES: ReadonlySet<string> = new Set(["pin-symlink", "pin-malformed"]);
/** Item kinds that are information beside a pass: painted dim. */
const REPORT_INFO_ITEM_KINDS: ReadonlySet<string> = new Set(["inert-config-block", "extra-skill", "source-unresolvable"]);

/**
 * One observation, with the four axes and the one thing to do about it.
 *
 * The severity, the repair class, the observed/desired pair and the next action
 * are all printed, because an operator on the human path who can see THAT a
 * domain is wrong and not WHAT TO DO has been given a dashboard rather than a
 * report. The retrieval is kept beside them for a clipped envelope.
 */
function observationLines(observation: FleetStatusObservation, width: number): string[] {
  const subject = observation.agent_id
    ? `${observation.agent_id} ${glyph.dot} ${observation.domain}`
    : `fleet ${glyph.dot} ${observation.domain}`;
  const style = statusColor(observation.state);
  const axes = joinDot([
    severityColor(observation.severity)(observation.severity),
    dim(observation.applicability),
    dim(observation.evidence),
    observation.freshness === "stale" ? yellow("stale") : dim(observation.freshness),
    dim(`repair ${observation.repair}`),
  ]);
  const lines = [
    `    ${statusGlyph(observation.state)}  ${padVisible(bounded(subject), width)}  ${style(observation.state)}`
    + `${observation.rule_id ? `  ${cyan(observation.rule_id)}` : ""}`,
    `       ${dim(glyph.arrow)} ${dim(observation.summary)}`,
    `       ${dim(glyph.arrow)} ${axes}`,
  ];
  if (observation.state !== "pass" && observation.state !== "skip") {
    lines.push(`       ${dim(glyph.arrow)} ${dim(`observed ${observation.observed ?? "-"}`)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`desired  ${observation.desired ?? "-"}`)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`owner ${observation.owner ?? "undeclared"}`)}`);
  }
  if (observation.justification) {
    lines.push(`       ${dim(glyph.arrow)} ${gray(`authorized by ${observation.justification.policy}: ${observation.justification.reason}`)}`);
  }
  // The typed items of a scaffold group or a profile field: kind, relative
  // path, and the desired -> observed pair (digest prefixes or identifier
  // words). Never a body, never an absolute path -- the items carry neither.
  const items = observation.items ?? [];
  for (const item of items.slice(0, REPORT_MAX_ITEMS)) {
    const pair = item.desired !== null || item.observed !== null ? ` ${item.desired ?? "-"}${glyph.arrow}${item.observed ?? "-"}` : "";
    const soft = REPORT_SOFT_ITEM_KINDS.has(item.kind)
      || (item.kind === "channel-undeclared" && item.observed === REPORT_UNDECLARED_SOFT_OBSERVED);
    const paint = item.kind === "incomplete"
      ? red
      : soft ? yellow : REPORT_INFO_ITEM_KINDS.has(item.kind) ? dim : red;
    lines.push(`       ${dim(glyph.arrow)} ${paint(item.kind)} ${bounded(item.path)}${dim(pair)}${item.wip ? ` ${yellow("[wip]")}` : ""}${item.detail ? ` ${dim(`(${item.detail})`)}` : ""}`);
  }
  if (items.length > REPORT_MAX_ITEMS) {
    lines.push(`       ${dim(glyph.arrow)} ${dim(`... ${items.length - REPORT_MAX_ITEMS} more item(s); use --json for all of them`)}`);
  }
  // The RETRIEVAL, which is what an operator reaches for when the envelope
  // clipped: the command that returns this one observation on its own. It was
  // dropped when the axes were added and the docstring went on promising it --
  // and it is the one line here that is useful precisely when the rest of the
  // report is missing.
  if (observation.state !== "pass" && observation.state !== "skip") {
    lines.push(`       ${dim(glyph.arrow)} ${dim(observation.retrieval)}`);
  }
  // The next action is the half an operator acts on, so it is printed for
  // everything that needs one -- and a command that is NOT read-only is
  // labelled, loudly, because that label is the only thing standing between a
  // reader and a change to the fleet.
  if (observation.repair !== "none") {
    const label = observation.next_action_class === "requires-authorization"
      ? yellow("[requires-authorization]")
      : dim("[read-only]");
    lines.push(`       ${dim(glyph.arrow)} ${label} ${cyan(observation.next_action)}`);
  }
  return lines;
}

function agentLine(agent: FleetStatusAgent, width: number, domains: readonly FleetStatusDomainRollup[]): string[] {
  const cells = domains.map((rollup) => {
    const state = agent.domains[rollup.domain] ?? "unobserved";
    return statusColor(state)(`${rollup.domain}=${state}`);
  });
  const head = `    ${statusGlyph(agent.state)}  ${padVisible(bounded(agent.agent_id), width)}  ${statusColor(agent.state)(agent.state)}`
    + `  ${dim(glyph.dot)}  ${dim(agent.member_class)}`
    + `  ${dim(glyph.dot)}  ${agent.healthy ? dim("in good standing") : red("ON NOTICE")}`
    + `  ${dim(glyph.dot)}  ${agent.complete ? dim("complete") : yellow("incomplete")}`;
  const lines = [head, `       ${dim(glyph.arrow)} ${joinDot(cells)}`];
  // Four separate values, printed as four separate values. Collapsing any two
  // of them here would undo in the report what the record keeps apart.
  lines.push(`       ${dim(glyph.arrow)} ${joinDot([
    dim(`desired ${agent.lifecycle.desired_state}`),
    dim(`observed ${agent.lifecycle.observed_state}`),
    agent.lifecycle.capability_readiness === "ready" ? green("routing ready") : dim(`routing ${agent.lifecycle.capability_readiness}`),
    agent.lifecycle.activation === "granted" ? yellow("activation granted") : dim(`activation ${agent.lifecycle.activation}`),
  ])}`);
  // The scaffold cell: how much of the pinned template this role directory
  // carries, and against which gitlink. Absent when the domain was not read.
  if (agent.scaffold) {
    const assets = agent.scaffold.assets;
    const cells = [
      dim(`scaffold ${assets.matching}/${assets.owned}`),
      assets.drifted ? red(`${assets.drifted} drifted`) : dim("0 drifted"),
      assets.incomplete ? yellow(`${assets.incomplete} undecided`) : dim("0 undecided"),
      assets.unexpected_owned ? yellow(`${assets.unexpected_owned} unexpected`) : dim("0 unexpected"),
      dim(`gitlink ${agent.scaffold.source_gitlink ? agent.scaffold.source_gitlink.slice(0, 12) : "unreadable"}`),
    ];
    if (agent.scaffold.wip_overlap.length) cells.push(yellow(`${agent.scaffold.wip_overlap.length} wip overlap`));
    lines.push(`       ${dim(glyph.arrow)} ${joinDot(cells)}`);
  }
  // The profile cell: whether the generated config is in sync by the canonical
  // renderer's check, whether the bank is pinned, and how much of the skill
  // core resolves by bytes. Absent when the domain was not read.
  if (agent.profile) {
    const profile = agent.profile;
    const renderer = profile.renderer.state;
    const coreCell = `skills ${profile.skills.core_present}/${profile.skills.core_present + profile.skills.core_missing.length}`;
    const cells = [
      // A warn on the path (an unverifiable link) is painted as the warn it
      // is; a fail or an error is red and names the code.
      profile.path.state === "pass" ? dim(`profile ${renderer}`) : profile.path.state === "warn" ? yellow(`profile ${profile.path.code}`) : red(`profile ${profile.path.code}`),
      profile.bank.state === "pass"
        ? dim("bank ok")
        : profile.bank.state === "unobserved" || profile.bank.state === "error"
          ? dim(`bank ${profile.bank.state}`)
          : red(`bank ${profile.bank.observed ?? (REPORT_BANK_INVALID_CODES.has(profile.bank.code ?? "") ? "invalid" : "unpinned")}`),
      profile.skills.state === "pass"
        ? dim(coreCell)
        : profile.skills.state === "unobserved" || profile.skills.state === "error" ? dim(`skills ${profile.skills.state}`) : red(coreCell),
    ];
    if (renderer === "drifted" && profile.renderer.sections.length) cells.push(red(`drift in ${profile.renderer.sections.join(", ")}`));
    if (profile.identity.state === "fail") cells.push(red("identity"));
    else if (profile.identity.state === "warn") cells.push(yellow("identity warn"));
    lines.push(`       ${dim(glyph.arrow)} ${joinDot(cells)}`);
  }
  // The systemd cell: what the gateway reads as against the capability its own
  // registry row DECLARES, and whether the last heartbeat tick actually
  // succeeded. An active timer is not on this line, because an active timer
  // proves nothing.
  if (agent.systemd) {
    const systemd = agent.systemd;
    const gateway = systemd.gateway;
    const heartbeat = systemd.heartbeat;
    const paint = (state: FleetStatusState, text: string): string => (
      state === "pass" ? dim(text) : state === "warn" ? yellow(text) : state === "unobserved" || state === "unsupported" ? gray(text) : red(text)
    );
    const gatewayCell = gateway.state === "pass"
      ? `gw ${gateway.active ?? "-"}${gateway.stability.stable ? `${glyph.dot}stable` : ""}`
      : `gw ${gateway.code ?? gateway.active ?? "-"}`;
    const heartbeatCell = `hb ${heartbeat.latest_result}${glyph.dot}${heartbeat.tick}`;
    const cells = [
      paint(gateway.state, gatewayCell),
      paint(heartbeat.state, heartbeatCell),
      dim(`capability ${systemd.capability.declared}`),
      paint(systemd.topology.state, `units ${systemd.topology.installed.length}/${systemd.topology.expected.length}`),
    ];
    if (systemd.topology.extra.length) cells.push(red(`${systemd.topology.extra.length} extra unit(s)`));
    if (!gateway.stability.stable && gateway.stability.transitions.length) cells.push(red(gateway.stability.transitions.join("; ")));
    if (!gateway.entrypoint.pinned && gateway.entrypoint.family !== "unknown") cells.push(red(`entrypoint ${gateway.entrypoint.family} unpinned`));
    lines.push(`       ${dim(glyph.arrow)} ${joinDot(cells)}`);
  }
  if (agent.truncated) lines.push(`       ${dim(glyph.arrow)} ${yellow(`observations clipped; ${agent.retrieval}`)}`);
  return lines;
}

/**
 * Report in the `formatFleetProvenanceReport` house style. The caller prints it.
 *
 * THE VERDICT LEADS, and it is the three-way one. `healthy` and `complete` are
 * printed beside it because they are still what it is built from, but the
 * headline can no longer read "healthy" over a fleet whose audit-fed half was
 * never opened -- which is the exact sentence story 1.4's report could produce.
 *
 * The reason it is not `healthy` leads with it, for the same reason it always
 * has: an unhealthy or unproven fleet exits 0, so an operator on the human path
 * has to be able to see WHY, not only THAT.
 *
 * The host block is printed apart from the agents, once, for the same reason it
 * is stored apart: a condition about this MACHINE is not any repository's
 * failure, and printing it 28 times would say otherwise.
 */
export function formatFleetStatusReport(status: FleetStatus): string {
  const { health, totals, scope } = status;
  const lines = [""];

  const verdictLabel = health.verdict === "healthy"
    ? "Workforce IN GOOD STANDING"
    : health.verdict === "unhealthy" ? "Workforce ON NOTICE" : "Workforce UNABLE TO ASSESS";
  const paint = verdictColor(health.verdict);
  const headline = `${health.verdict === "healthy" ? green(glyph.pass) : health.verdict === "unhealthy" ? red(glyph.fail) : yellow(glyph.warn)} ${bold(paint(verdictLabel))}`;
  lines.push(`  ${headline}  ${dim(glyph.dot)}  ${joinDot([
    `${totals.emitted_agents} of ${totals.agents} agents`,
    `${totals.emitted_observations} of ${totals.observations} observations`,
    health.proven ? green("proven") : yellow("NOT proven"),
    dim(`exit_category ${health.exit_category}`),
  ])}`);
  // WHY it is not healthy, before anything else. `verdict` is derived from
  // `healthy`, `complete`, `stale` and `unjustified`, so all four are on the
  // line under it rather than left for a reader to reconstruct from counts.
  const why = [
    health.healthy ? dim("no proven drift") : red(`${health.failed} failed`),
    health.errors ? red(`${health.errors} errors`) : dim("0 errors"),
    health.complete ? dim("complete") : yellow("INCOMPLETE"),
    health.unobserved ? yellow(`${health.unobserved} unobserved`) : dim("0 unobserved"),
    health.unjustified ? yellow(`${health.unjustified} unjustified`) : dim("0 unjustified"),
    health.stale ? yellow(`${health.stale} stale`) : dim("0 stale"),
    health.freshness_unknown ? yellow(`${health.freshness_unknown} freshness unknown`) : dim("0 freshness unknown"),
    health.contradictions ? red(`${health.contradictions} contradiction${health.contradictions === 1 ? "" : "s"}`) : dim("0 contradictions"),
    health.collection_errors ? red(`${health.collection_errors} collection error${health.collection_errors === 1 ? "" : "s"}`) : dim("0 collection errors"),
  ];
  lines.push(`  ${dim(glyph.arrow)} ${joinDot(why)}`);
  const counts = [
    health.warned ? yellow(`${health.warned} warned`) : dim("0 warned"),
    health.unsupported ? gray(`${health.unsupported} unsupported`) : dim("0 unsupported"),
    health.skipped ? gray(`${health.skipped} skipped`) : dim("0 skipped"),
    health.fleet_complete ? green("fleet-complete") : dim("not fleet-complete"),
  ];
  lines.push(`  ${dim(glyph.arrow)} ${joinDot(counts)}`);
  // Every SELECTED agent, in exactly one bucket, summing to the selection --
  // not to the records the cap let through.
  lines.push(`  ${dim(glyph.arrow)} ${joinDot([
    dim(`members of ${scope.selected_agents}`),
    green(`${health.members.healthy} healthy`),
    red(`${health.members.unhealthy} unhealthy`),
    yellow(`${health.members.incomplete} incomplete`),
    gray(`${health.members.deferred} deferred`),
    gray(`${health.members.exception} exception`),
    gray(`${health.members.unclassified} unclassified`),
  ])}`);
  lines.push(`  ${joinDot([dim(scope.label), dim(status.contract_path), dim(`contract ${status.contract_version ?? "?"}`)])}`);

  section(lines, "Domains");
  const domainWidth = status.domains.reduce((max, rollup) => Math.max(max, rollup.domain.length), 0);
  for (const rollup of status.domains) {
    const stateCounts = Object.entries(rollup.counts)
      .filter(([, count]) => count > 0)
      .map(([state, count]) => statusColor(state as FleetStatusState)(`${count} ${state}`));
    lines.push(`    ${statusGlyph(rollup.state)}  ${padVisible(rollup.domain, domainWidth)}  ${statusColor(rollup.state)(rollup.state)}  ${dim(`${rollup.agents} agent${rollup.agents === 1 ? "" : "s"}`)}`);
    lines.push(`       ${dim(glyph.arrow)} ${stateCounts.length ? joinDot(stateCounts) : dim("no observations")}`);
    // The scaffold parity summary rides on its domain: how many selected
    // agents match the pinned template, and whether the source was canonical.
    if (rollup.domain === "template_scaffold" && status.scaffold) {
      const counts = status.scaffold.agents;
      lines.push(`       ${dim(glyph.arrow)} ${joinDot([
        dim(`scaffold parity over ${counts.applicable} of ${counts.selected} selected`),
        counts.passing ? green(`${counts.passing} passing`) : dim("0 passing"),
        counts.drifted ? red(`${counts.drifted} drifted`) : dim("0 drifted"),
        counts.incomplete ? yellow(`${counts.incomplete} incomplete`) : dim("0 incomplete"),
        counts.exception_authorized ? gray(`${counts.exception_authorized} exception`) : dim("0 exception"),
        counts.unobserved ? yellow(`${counts.unobserved} unobserved`) : dim("0 unobserved"),
      ])}`);
      const source = status.scaffold.source;
      lines.push(`       ${dim(glyph.arrow)} ${source.integrity === "ok" ? green("source ok") : red(`source ${source.integrity}`)} ${dim(`gitlink ${source.gitlink ? source.gitlink.slice(0, 12) : "none"}`)}`);
      const agreement = status.scaffold.rule_agreement;
      if (agreement.compared || agreement.disagree) {
        lines.push(`       ${dim(glyph.arrow)} ${joinDot([
          dim(`rule agreement ${agreement.agree}/${agreement.compared}`),
          agreement.disagree ? red(`${agreement.disagree} disagree`) : dim("0 disagree"),
          dim(`${agreement.not_compared} not compared`),
        ])}`);
      }
    }
    // The profile summary rides on its domain: the root and renderer gates,
    // how many selected profiles are real and structurally healthy, and what
    // the root sweep classified.
    if (rollup.domain === "profile" && status.profile) {
      const profile = status.profile;
      lines.push(`       ${dim(glyph.arrow)} ${joinDot([
        profile.root.state === "pass" ? green("root ok") : profile.root.state === "unsupported" ? gray(`root ${profile.root.code}`) : red(`root ${profile.root.code}`),
        profile.renderer.source === "ok" ? green("renderer ok") : profile.renderer.source === "manifest-undeclared" ? gray(`renderer ${profile.renderer.source}`) : red(`renderer ${profile.renderer.source}`),
        profile.renderer.python === "ok" ? dim("python ok") : profile.renderer.python === "not-probed" ? dim("python not probed") : red(`python ${profile.renderer.python}`),
        dim(`gitlink ${profile.renderer.gitlink ? profile.renderer.gitlink.slice(0, 12) : "none"}`),
      ])}`);
      const counts = profile.agents;
      lines.push(`       ${dim(glyph.arrow)} ${joinDot([
        dim(`profiles ${counts.real} real of ${counts.selected} selected`),
        counts.structurally_healthy ? green(`${counts.structurally_healthy} healthy`) : dim("0 healthy"),
        counts.drifted ? red(`${counts.drifted} drifted`) : dim("0 drifted"),
        counts.blocked_at_path ? red(`${counts.blocked_at_path} blocked at path`) : dim("0 blocked at path"),
        counts.incomplete ? yellow(`${counts.incomplete} incomplete`) : dim("0 incomplete"),
        counts.exception_authorized ? gray(`${counts.exception_authorized} exception`) : dim("0 exception"),
        counts.unobserved ? yellow(`${counts.unobserved} unobserved`) : dim("0 unobserved"),
      ])}`);
      lines.push(`       ${dim(glyph.arrow)} ${joinDot([
        dim(`renderer checked ${profile.renderer.checked}`),
        dim(`${profile.renderer.in_sync} in sync`),
        profile.renderer.drifted ? red(`${profile.renderer.drifted} drifted`) : dim("0 drifted"),
        profile.renderer.failed || profile.renderer.timeout ? red(`${profile.renderer.failed} failed, ${profile.renderer.timeout} timed out`) : dim("0 failed"),
        dim(`bank ok ${profile.identity.bank_ok}`),
        profile.identity.bank_alias || profile.identity.bank_custom || profile.identity.bank_missing || profile.identity.bank_mismatch || profile.identity.bank_invalid
          ? red(`bank ${profile.identity.bank_alias} alias, ${profile.identity.bank_custom} custom, ${profile.identity.bank_missing} missing, ${profile.identity.bank_mismatch} mismatch, ${profile.identity.bank_invalid} invalid`)
          : dim("bank 0 wrong"),
        dim(`skill core complete ${profile.skills.core_complete}`),
      ])}`);
      const extras = profile.extras;
      if (extras.coverage === "not-swept") {
        lines.push(`       ${dim(glyph.arrow)} ${dim(`extras not swept (${extras.reason ?? "scoped"})`)}`);
      } else {
        const byClass = Object.entries(extras.by_class).filter(([, count]) => count > 0).map(([klass, count]) => (
          klass === "approved-managed-exception" || klass === "intentionally-unmanaged" ? dim(`${count} ${klass}`) : yellow(`${count} ${klass}`)
        ));
        lines.push(`       ${dim(glyph.arrow)} ${joinDot([dim(`extras swept: ${extras.entries_total} unregistered entr${extras.entries_total === 1 ? "y" : "ies"}`), ...byClass])}${extras.truncated ? ` ${yellow("(root enumeration capped)")}` : ""}`);
      }
      const agreement = profile.rule_agreement;
      if (agreement.compared || agreement.disagree) {
        lines.push(`       ${dim(glyph.arrow)} ${joinDot([
          dim(`rule agreement ${agreement.agree}/${agreement.compared}`),
          agreement.disagree ? red(`${agreement.disagree} disagree`) : dim("0 disagree"),
          dim(`${agreement.not_compared} not compared`),
        ])}`);
      }
    }
    // The systemd summary rides on its domain: the manager and the window it
    // was sampled over, how many selected agents are healthy per aspect, what
    // each row DECLARES its messaging capability to be, the fleet-shared
    // gateway, and what the sweep classified.
    if (rollup.domain === "systemd" && status.systemd) {
      const systemd = status.systemd;
      lines.push(`       ${dim(glyph.arrow)} ${joinDot([
        systemd.manager.code === "available" ? green(`manager ${systemd.manager.state}`) : red(`manager ${systemd.manager.code}`),
        dim(`window ${systemd.window.samples} sample(s) ${systemd.window.interval_ms} ms apart`),
        dim(`${systemd.units.listed} unit(s) listed, ${systemd.units.unit_files} unit file(s), ${systemd.units.transient} transient`),
      ])}`);
      const counts = systemd.agents;
      lines.push(`       ${dim(glyph.arrow)} ${joinDot([
        dim(`agents ${counts.complete} complete of ${counts.selected} selected`),
        counts.gateway_healthy ? green(`${counts.gateway_healthy} gateway healthy`) : dim("0 gateway healthy"),
        counts.gateway_deferred ? dim(`${counts.gateway_deferred} gateway deferred`) : dim("0 gateway deferred"),
        counts.heartbeat_healthy ? green(`${counts.heartbeat_healthy} heartbeat healthy`) : dim("0 heartbeat healthy"),
        counts.drifted ? red(`${counts.drifted} drifted`) : dim("0 drifted"),
        counts.incomplete ? yellow(`${counts.incomplete} incomplete`) : dim("0 incomplete"),
        counts.exception_authorized ? gray(`${counts.exception_authorized} exception`) : dim("0 exception"),
        counts.unobserved ? yellow(`${counts.unobserved} unobserved`) : dim("0 unobserved"),
      ])}`);
      lines.push(`       ${dim(glyph.arrow)} ${joinDot([
        dim(`topology ok ${counts.topology_ok}`),
        counts.unstable ? red(`${counts.unstable} unstable`) : dim("0 unstable"),
        counts.crash_looping ? red(`${counts.crash_looping} crash looping`) : dim("0 crash looping"),
        dim(`capability ${systemd.capability.active} active, ${systemd.capability.deferred} deferred`),
        systemd.capability.undeclared ? yellow(`${systemd.capability.undeclared} undeclared`) : dim("0 undeclared"),
      ])}`);
      const shared = systemd.shared;
      lines.push(`       ${dim(glyph.arrow)} ${shared.coverage === "unobserved"
        ? dim(`shared gateway not observed (${shared.code ?? "scoped"})`)
        : joinDot([
          shared.state === "healthy" ? green(`shared gateway ${shared.state}`) : red(`shared gateway ${shared.state}`),
          dim(`unit ${shared.unit ?? "none declared"}`),
          dim(`profile ${shared.profile ?? "none declared"}`),
        ])}`);
      const unregistered = systemd.unregistered;
      if (unregistered.coverage === "not-swept") {
        lines.push(`       ${dim(glyph.arrow)} ${dim(`unregistered units not swept (${unregistered.reason ?? "scoped"})`)}`);
      } else {
        const byClass = Object.entries(unregistered.by_class).filter(([, count]) => count > 0).map(([klass, count]) => (
          klass === "managed-exception" ? dim(`${count} ${klass}`) : yellow(`${count} ${klass}`)
        ));
        lines.push(`       ${dim(glyph.arrow)} ${joinDot([dim(`unregistered swept: ${unregistered.total} unit${unregistered.total === 1 ? "" : "s"}`), ...byClass])}${unregistered.truncated ? ` ${yellow("(listing capped)")}` : ""}`);
      }
      const agreement = systemd.rule_agreement;
      if (agreement.compared || agreement.disagree) {
        lines.push(`       ${dim(glyph.arrow)} ${joinDot([
          dim(`rule agreement ${agreement.agree}/${agreement.compared}`),
          agreement.disagree ? red(`${agreement.disagree} disagree`) : dim("0 disagree"),
          dim(`${agreement.not_compared} not compared`),
        ])}`);
      }
    }
    for (const observation of rollup.observations) {
      lines.push(`       ${dim(glyph.arrow)} ${statusColor(observation.state)(observation.state)} ${dim(observation.summary)}`);
    }
  }

  section(lines, "Host (this machine, reported once — never a repository's failure)");
  if (status.host.length === 0) {
    lines.push(`    ${dim(scope.live ? "none" : "not observed; pass --live to run the recipe-owned audit rules")}`);
  }
  const hostRanked = [...status.host].sort((a, b) => compareStatusFindings(hostSortKey(a), hostSortKey(b)));
  const hostWidth = hostRanked.reduce((max, finding) => Math.max(max, finding.rule_id.length), 0);
  for (const finding of hostRanked) {
    lines.push(`    ${statusGlyph(finding.state)}  ${padVisible(finding.rule_id, hostWidth)}  ${statusColor(finding.state)(finding.state)}  ${severityColor(finding.severity)(finding.severity)}  ${dim(finding.domain)}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${finding.summary} ${glyph.dot} owner ${finding.owner ?? "undeclared"} ${glyph.dot} repair ${finding.repair}`)}`);
    if (finding.repair !== "none") {
      const label = finding.next_action_class === "requires-authorization" ? yellow("[requires-authorization]") : dim("[read-only]");
      lines.push(`       ${dim(glyph.arrow)} ${label} ${cyan(finding.next_action)}`);
    }
  }

  section(lines, "Agents");
  if (status.agents.length === 0) lines.push(`    ${dim("none")}`);
  const agentWidth = status.agents.reduce((max, agent) => Math.max(max, agent.agent_id.length), 0);
  for (const agent of status.agents.slice(0, REPORT_MAX_AGENTS)) {
    for (const line of agentLine(agent, agentWidth, status.domains)) lines.push(line);
  }
  if (status.agents.length > REPORT_MAX_AGENTS) {
    lines.push(`    ${dim(`... ${status.agents.length - REPORT_MAX_AGENTS} more agent(s); use --json for all of them`)}`);
  }

  section(lines, "Highest-priority observations");
  // The SAME sort the machine path applies, and applied BEFORE the cap. Ranking
  // by state alone put a `medium` unjustified warn above a `critical` failure
  // whenever the states tied, and a cap over an unranked list is a dump with a
  // verdict on top.
  const ranked = status.agents
    .flatMap((agent) => agent.observations)
    .concat(status.domains.flatMap((rollup) => rollup.observations))
    // A STALE OR UNREADABLE READING IS ACTIONABLE WHATEVER ITS STATE. Filtering
    // on the state alone dropped every stale `pass`, so the headline could
    // report `3 stale` with nothing anywhere in the report saying WHICH -- a
    // count an operator cannot act on is a count that trains them to ignore it.
    .filter((observation) => (
      (observation.state !== "pass" && observation.state !== "skip")
      || observation.freshness === "stale" || observation.freshness === "unknown"
    ))
    .sort((a, b) => compareStatusFindings(observationSortKey(a), observationSortKey(b)));
  if (ranked.length === 0) lines.push(`    ${dim("none")}`);
  const observationWidth = ranked.slice(0, REPORT_MAX_OBSERVATIONS).reduce((max, observation) => Math.max(
    max,
    (observation.agent_id ? `${observation.agent_id} ${glyph.dot} ${observation.domain}` : `fleet ${glyph.dot} ${observation.domain}`).length,
  ), 0);
  for (const observation of ranked.slice(0, REPORT_MAX_OBSERVATIONS)) {
    for (const line of observationLines(observation, observationWidth)) lines.push(line);
  }
  if (ranked.length > REPORT_MAX_OBSERVATIONS) {
    lines.push(`    ${dim(`... ${ranked.length - REPORT_MAX_OBSERVATIONS} more actionable observation(s); use --json for all of them`)}`);
  }

  // PRINTED WHENEVER A BASELINE WAS READ, empty or not. On the human path "no
  // section" meant both "nothing moved" and "nothing was compared", and those
  // are opposite answers -- the first is the result an operator asked for, the
  // second means their flag did nothing.
  if (status.scope.baseline) {
    section(lines, "Transitions since the baseline");
    if (status.transitions.length === 0) {
      lines.push(`    ${green("none")}  ${dim(glyph.dot)}  ${dim("every finding is exactly as the baseline recorded it")}`);
    }
    const transitionWidth = status.transitions.reduce((max, item) => Math.max(max, item.kind.length), 0);
    for (const transition of status.transitions.slice(0, REPORT_MAX_TRANSITIONS)) {
      const subject = transition.agent_id ? `${transition.agent_id} ${glyph.dot} ${transition.domain}` : `${transition.scope} ${glyph.dot} ${transition.domain}`;
      const paintKind = transition.kind === "resolved" ? green : transition.kind === "appeared" ? red : yellow;
      lines.push(`    ${dim(glyph.bullet)}  ${paintKind(padVisible(transition.kind, transitionWidth))}  ${dim(bounded(subject))}  ${dim(transition.finding_id)}`);
      lines.push(`       ${dim(glyph.arrow)} ${dim(transition.detail)}`);
    }
    if (status.transitions.length > REPORT_MAX_TRANSITIONS) {
      lines.push(`    ${dim(`... ${status.transitions.length - REPORT_MAX_TRANSITIONS} more transition(s); use --json for all of them`)}`);
    }
  }

  section(lines, "Findings");
  if (status.findings.length === 0) lines.push(`    ${dim("none")}`);
  // SORTED BEFORE THE CAP. `status.findings` already arrives in this order from
  // the core; re-applying it here is what keeps the guarantee true if a caller
  // ever hands this function a differently-ordered document, and it is cheap.
  const rankedFindings = [...status.findings].sort(compareStatusFindings);
  const codeWidth = rankedFindings.slice(0, REPORT_MAX_FINDINGS).reduce((max, item) => Math.max(max, item.code.length), 0);
  for (const finding of rankedFindings.slice(0, REPORT_MAX_FINDINGS)) {
    lines.push(`    ${findingGlyph(finding.severity)}  ${padVisible(finding.code, codeWidth)}  ${severityColor(finding.status_severity)(finding.status_severity)}  ${dim(finding.field)}${finding.agent_id ? `  ${cyan(finding.agent_id)}` : ""}`);
    lines.push(`       ${dim(glyph.arrow)} ${dim(`${finding.detail} ${glyph.dot} owner ${finding.source ?? "undeclared"}`)}`);
  }
  if (rankedFindings.length > REPORT_MAX_FINDINGS) {
    lines.push(`    ${dim(`... ${rankedFindings.length - REPORT_MAX_FINDINGS} more finding(s); use --json for all of them`)}`);
  }

  if (status.truncated.length) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${bold("Report clipped to envelope bounds")}  ${dim(glyph.dot)}  ${dim("the registries on disk are complete")}`);
    for (const note of status.truncated) lines.push(`     ${dim(glyph.arrow)} ${dim(note)}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * A command failure, in the same house style as the success reports.
 *
 * The human path still owes the operator a readable answer when the command
 * itself failed: an unreadable registry, an unknown agent, a rejected flag. The
 * error's message and code are already bounded and home-redacted by the time
 * they reach here.
 */
export function formatFleetErrorReport(title: string, error: { code: string; message: string; details?: Record<string, unknown> | null }): string {
  const lines = [
    "",
    `  ${red(glyph.fail)} ${bold(title)}  ${dim(glyph.dot)}  ${red(error.code)}`,
    `     ${dim(glyph.arrow)} ${dim(bounded(error.message))}`,
  ];
  // The detail is the half that identifies the failure: WHICH path was not
  // there, WHICH agent id is not registered. It goes through the same
  // `sanitizeDetails` the JSON path uses, so the human report cannot become the
  // looser of the two surfaces; the operator most likely to have fat-fingered a
  // path was the one who could not see it.
  for (const [key, value] of Object.entries(sanitizeDetails(error.details ?? {}))) {
    if (value === null) continue;
    lines.push(`     ${dim(glyph.arrow)} ${dim(`${key} ${bounded(String(value))}`)}`);
  }
  lines.push("");
  return lines.join("\n");
}
