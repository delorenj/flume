// Read-only systemd topology and service health: every registered agent's
// canonical unit set derived from the contract, sampled off the user manager
// over a declared stabilization window, and proven against the DESIRED state
// the registry's own messaging declaration derives.
//
// Before this, `systemd` reported every agent `unsupported` (the `unit_topology`
// deferral): unit names were expectations `service_model.per_agent` derives,
// never observations. On the live fleet that hid real drift -- a gateway
// enabled+active for an agent whose row declares its channels deferred, a
// verified-Telegram agent whose gateway is disabled, a heartbeat oneshot whose
// latest result is an exit code, a deferred agent whose empty delta inherits
// the fleet base's platform enablement, heartbeat pairs on disk the registry
// never recorded, a registered agent with no units at all, a retired consumer
// reference, and a set of unregistered `hermes-*` units nothing reported.
//
// Seven disciplines:
//
//   * READ-ONLY, AND STRUCTURALLY SO. The only `systemctl --user` verbs this
//     module can spawn are the four in `SYSTEMD_READ_VERBS`. There is no code
//     path to `enable`, `start`, `daemon-reload` or `reset-failed`, no write
//     anywhere under the unit directory, and every child receives an
//     ALLOWLISTED environment (the manifest's `probe.env_allowlist` plus the
//     four pager/locale pins) rather than a filtered copy of this process's.
//   * SAMPLE THE MANAGER, NOT THE AGENTS. One `show` carries every unit of
//     interest, so a window is `stabilization.samples` children regardless of
//     fleet size -- and every agent's window is the SAME window, which is what
//     makes "stable over the window" a fleet-wide claim rather than 84
//     unrelated ones. A failed manager probe skips sampling entirely.
//   * DESIRED STATE COMES FROM THE DECLARATION, NOT FROM THE UNIT. The
//     provisioner enables a gateway only when a platform's `provisioning_status`
//     is `verified`, and disables it otherwise. Reading that declaration back
//     off the registry makes "deferred but enabled" and "verified but disabled"
//     visible as drift instead of two alternate healthy modes, and makes a row
//     that declares nothing `undeclared` -- an active gateway there is the
//     liveness theatre the epic forbids, never health.
//   * THE TEMPLATE'S STABILITY RULE IS THE CONTRACT. `_lib.sh`'s
//     `systemd_wait_for_stable_health` rejects any window in which a unit looked
//     healthy and then changed, and `systemd_timer_health_snapshot` refuses a
//     oneshot that has not completed (systemd pre-initialises `Result=success`
//     before the first exit). Both are encoded here, so a deploy's "stabilized"
//     claim and this reading can never disagree about what stable means.
//   * BUCKETS, NEVER AGES. No timestamp, age, pid, duration or completion order
//     reaches `data`. Monotonic properties are compared against
//     `process.hrtime.bigint()` -- CLOCK_MONOTONIC, the same clock systemd's
//     `*USecMonotonic` properties use -- and reduced to `current | overdue |
//     never | unknown` and `success | failed | in-progress | stuck | never |
//     unknown`. Two runs over unchanged state produce identical bytes; a tick
//     between them is a real change.
//   * UNREGISTERED UNITS ARE FINDINGS, NEVER A LICENCE. Every `hermes-*` unit no
//     registered row claims lands in exactly one of five classes with bounded
//     evidence and guidance, and is left alone. None is assigned to the nearest
//     agent name, and every one carries `process_reference: "unobserved"` --
//     attributing the process behind a unit is story 1.9.
//   * BOUNDED AND NARROW. From `Environment=` only the two declared keys; from
//     `ExecStart=` only `path=` and the first argv token; from a transient
//     scope's `Description=` only an exact `--profile <name>` token naming a
//     REGISTERED profile. Nothing else from those properties reaches `data`,
//     notes, items or diagnostics, and every path goes through `shown`.
//
// This module never constructs a `FleetStatusObservation`. It returns typed
// per-agent aspect results, a manager record, a shared-gateway record, an
// unregistered classification and probe records; `status.ts` turns them into
// observations through its single construction point.

import YAML from "yaml";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isSafePathSegment } from "./inventory";
import { entryStat, readBounded, RENDERER_BASE_FILE, type BoundedRead } from "./profile";
import { mapBounded, probeText, sleepBounded, throwIfCancelled, type FleetRunContext } from "./runtime";
import {
  FLEET_STATUS_SYSTEMD_CONCURRENCY,
  type FleetContract,
  type FleetProbeRecord,
  type FleetProbeOutcome,
  type FleetServiceManifest,
  type FleetStatusState,
  type FleetStatusSystemdUnitView,
  type FleetStatusSystemdUnregisteredItem,
  type FleetSystemdCapabilityState,
  type FleetSystemdEntrypointFamily,
  type FleetSystemdExtraClass,
  type FleetSystemdHomeState,
  type FleetSystemdItemKind,
  type FleetSystemdLatestResult,
  type FleetSystemdManagerCode,
  type FleetSystemdReconcileDeclaration,
  type FleetSystemdReconcileEvidence,
  type FleetSystemdSchedule,
  type FleetSystemdSharedState,
  type FleetSystemdTick,
  type FleetSystemdUnregisteredClass,
} from "./types";

/** The probe `kind` every record this module emits carries. */
export const SYSTEMD_PROBE_KIND = "systemd";

/** The executable, spawned BY NAME so `PATH` applies and a suite can shim it. */
export const SYSTEMCTL = "systemctl";

/**
 * The ONLY `systemctl` verbs this module can spawn.
 *
 * A list, not a comment: `systemctlArgv` refuses anything outside it, so a
 * mutation verb cannot be reached even by a future edit that forgets the rule.
 * `is-system-running` is a query, `list-units` and `list-unit-files` are
 * listings, and `show` reads properties. None of them writes.
 */
export const SYSTEMD_READ_VERBS = ["is-system-running", "list-units", "list-unit-files", "show"] as const;
export type FleetSystemdVerb = (typeof SYSTEMD_READ_VERBS)[number];

/** Flags every child carries: no pager, no columns, no legend, no colour. */
export const SYSTEMD_CHILD_FLAGS = ["--no-pager", "--plain", "--no-legend"] as const;

/**
 * Environment keys pinned on every child regardless of the manifest allowlist.
 *
 * `LC_ALL=C` fixes the duration and state spellings this module parses;
 * the three `SYSTEMD_*` keys turn off the pager, colour and URL hyperlinking
 * that would otherwise arrive as escape sequences inside a property value.
 */
export const SYSTEMD_CHILD_PINS: Readonly<Record<string, string>> = Object.freeze({
  LC_ALL: "C",
  SYSTEMD_PAGER: "",
  SYSTEMD_COLORS: "0",
  SYSTEMD_URLIFY: "0",
});

/**
 * The unit properties one sampled `show` asks for.
 *
 * Requested by name rather than taken wholesale: `show` without `-p` prints
 * every property a unit has, including `Environment` values, `ExecStart` argv
 * and `Description` for units this module does not classify -- megabytes of
 * text this observer has no business reading.
 */
export const SYSTEMD_SHOW_PROPERTIES = [
  "Id", "Names", "LoadState", "LoadError", "UnitFileState", "ActiveState", "SubState",
  "Result", "ExecMainStatus", "ExecMainCode", "NRestarts",
  "FragmentPath", "DropInPaths", "ExecStart", "Environment", "Type", "Restart",
  "ExecMainStartTimestampMonotonic", "ExecMainExitTimestampMonotonic", "TimeoutStartUSec",
  "Unit", "Triggers", "TriggeredBy", "TimersMonotonic", "LastTriggerUSecMonotonic", "NextElapseUSecMonotonic",
] as const;

/** The properties the ONE classification `show` over unregistered units asks for. Narrower still. */
export const SYSTEMD_CLASSIFY_PROPERTIES = [
  "Id", "LoadState", "UnitFileState", "ActiveState", "SubState", "Description", "Environment", "FragmentPath",
] as const;

/**
 * The SYSTEM-WIDE half of the user unit load path: the directories a canonical
 * `FragmentPath` may live in that do not depend on this operator's environment.
 *
 * Not a copy of the manager's `UnitPath` -- that is 16 entries on this host,
 * varies per machine, and reading it back would cost another child and make
 * the safe set depend on the thing being audited. It is a bounded allowlist of
 * the load-path entries this build can resolve on its own: these, plus the
 * four the context derives from the environment (`$XDG_CONFIG_HOME/systemd/user`,
 * `$XDG_DATA_HOME/systemd/user`, and the `$XDG_RUNTIME_DIR/systemd/*` set a
 * `--runtime` enable or link writes into). A package-installed unit under
 * `/usr/share/systemd/user` and a runtime one under `/run/user/<uid>/systemd/user`
 * are as canonical as `/usr/lib/systemd/user`, and reporting either as
 * `fragment-unsafe` would send an operator hunting a defect systemd put there.
 */
export const SYSTEMD_SYSTEM_UNIT_DIRS = [
  "/usr/lib/systemd/user", "/lib/systemd/user", "/etc/systemd/user", "/usr/local/lib/systemd/user",
  "/usr/share/systemd/user", "/usr/local/share/systemd/user", "/run/systemd/user",
] as const;

/**
 * The `$XDG_RUNTIME_DIR`-relative load-path entries, in the manager's own order.
 *
 * `systemctl --user enable --runtime` and `--link --runtime` write here, and
 * `enabled-runtime`/`linked-runtime` are states this module already reads as
 * legitimately enabled -- so leaving these out made the one shape the enabled
 * vocabulary explicitly allows read `fragment-unsafe`.
 */
export const SYSTEMD_RUNTIME_UNIT_SUBDIRS = [
  "user", "user.control", "transient", "generator", "generator.early", "generator.late",
] as const;

/**
 * The properties EVERY unit reading is built on, required in every sample.
 *
 * A sample that carries a unit and omits one of these is not a unit in a
 * default state: coercing a missing `ActiveState` to `""` would report
 * `inactive` -- a verdict -- about a property nobody actually read, and a
 * deferred agent's gateway would pass for the wrong reason. All four are on
 * systemd's own `Unit` interface and are printed for every unit type and even
 * for a unit that does not exist (`LoadState=not-found` with an EMPTY
 * `UnitFileState`), so an absent one is a defect of the READING and is
 * reported as `property-malformed:<Key>` rather than resolved with a default.
 * Present-and-empty is a reading; absent is not.
 */
export const SYSTEMD_REQUIRED_PROPERTIES = ["LoadState", "UnitFileState", "ActiveState", "SubState"] as const;

/** `UnitFileState` values that mean the unit is wired to start. */
const ENABLED_STATES: ReadonlySet<string> = new Set(["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"]);
/** `UnitFileState` values that mean the unit will not start on its own. */
const DISABLED_STATES: ReadonlySet<string> = new Set(["disabled", "masked", "masked-runtime"]);
/** `SubState` values a healthy timer sits in (`_lib.sh:systemd_timer_health_snapshot`). */
const TIMER_SUBSTATES: ReadonlySet<string> = new Set(["waiting", "running", "elapsed"]);

/** A unit name this module is willing to name: a systemd unit name and nothing else. */
export const UNIT_NAME = /^[A-Za-z0-9:_.@\\-]{1,255}\.(?:service|timer|socket|target|path|slice|scope|mount|automount|swap|device)$/u;
/** One safe lower-case identifier segment, for an agent id or a profile name inside a derived unit name. */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
/** An identifier word this module may emit verbatim (a state, a result, a registry key). */
const WORD = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/u;
/** `--profile <name>` in a transient scope's description. EXACT token, never a substring guess. */
const PROFILE_TOKEN = /(?:^|\s)--profile[\s=]+([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\s|$)/u;

/**
 * Microseconds per systemd duration unit, looked up by EXACT suffix.
 *
 * The lookup is an equality match on the whole suffix a token carries, not a
 * prefix scan, so ordering carries no meaning: `min` and `m` are both here and
 * `1min` can never be read as one minute plus an `in`. systemd itself accepts
 * a bare `m` for minutes (`systemd.time(7)`), which is why it is listed.
 */
const DURATION_UNITS: ReadonlyArray<readonly [string, bigint]> = [
  ["usec", 1n], ["us", 1n], ["msec", 1_000n], ["ms", 1_000n],
  ["minutes", 60_000_000n], ["minute", 60_000_000n], ["min", 60_000_000n], ["m", 60_000_000n],
  ["seconds", 1_000_000n], ["second", 1_000_000n], ["sec", 1_000_000n], ["s", 1_000_000n],
  ["hours", 3_600_000_000n], ["hour", 3_600_000_000n], ["hr", 3_600_000_000n], ["h", 3_600_000_000n],
  ["days", 86_400_000_000n], ["day", 86_400_000_000n], ["d", 86_400_000_000n],
  ["weeks", 604_800_000_000n], ["week", 604_800_000_000n], ["w", 604_800_000_000n],
  ["months", 2_629_800_000_000n], ["month", 2_629_800_000_000n], ["M", 2_629_800_000_000n],
  ["years", 31_557_600_000_000n], ["year", 31_557_600_000_000n], ["y", 31_557_600_000_000n],
];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** How one registry row declares one messaging platform. Names and words only; never a token. */
export interface FleetSystemdMessagingInput {
  /** The row's `<platform>.provisioning_status`, or null when it declares none. */
  status: string | null;
  /** The manifest's `identity_fields` for this platform, each present-or-not. Values are NEVER carried. */
  identity: Record<string, boolean>;
}

export interface FleetSystemdAgentInput {
  agentId: string;
  /** The row's `profile_name`, for the profile home and the delta read. Null when the row records none. */
  profileName: string | null;
  /** The role directory, for the reconcile policy and its state file. Null when neither can be derived. */
  roleDir: string | null;
  /** The row's `systemd.gateway_unit`, verbatim. Null or blank when it records none. */
  storedGatewayUnit: string | null;
  /** The row's `systemd.heartbeat_timer`, verbatim. */
  storedHeartbeatTimer: string | null;
  /** Every key the row's `systemd` block carries, sorted. Keys the contract does not declare are retired. */
  storedSystemdKeys: readonly string[];
  /** The row's `hermes.bin`: the executable the registry pins for this agent. */
  hermesBin: string | null;
  /** Per platform, as the manifest lists them. */
  messaging: Readonly<Record<string, FleetSystemdMessagingInput>>;
}

export interface FleetSystemdContext {
  run: FleetRunContext;
  home: string;
  env: NodeJS.ProcessEnv;
  /** `resolveFleetHome(env, home)`: the ONE resolution the inventory and the profile observer also use. */
  fleetHome: string;
  /** The profile root (`<fleetHome>/profiles`), or null when the contract declares no layout. */
  profileRoot: string | null;
  /** The generated profile's override file name, for the platform-enablement read. */
  overrideFile: string;
  /** `resolveConfigHome(env, home)`: where `systemd/user` lives, shared with the profile observer's unit scan. */
  configHome: string;
  manifest: FleetServiceManifest;
  serviceModel: FleetContract["service_model"];
  /** The contract's retired modes, for classifying an unregistered unit name. */
  retired: FleetContract["retired"];
  classifications: FleetContract["classifications"] | undefined;
  /** The fleet-shared Bloodbank gateway: what the contract derives, and what the registry records. */
  sharedGateway: { unit: string | null; profile: string | null; registryUnit: string | null };
  /** The registry field leaves the contract declares writable under `systemd`, unqualified (`gateway_unit`). */
  declaredSystemdKeys: readonly string[];
  /** Every registered row's `profile_name`, for the transient-scope correlation. */
  registeredProfileNames: readonly string[];
  /** Every registered agent id, so a unit named for a registered agent is never "unregistered". */
  registeredAgentIds: readonly string[];
  agents: readonly FleetSystemdAgentInput[];
  /** Fleet scope: list the manager and classify unregistered units. Agent scope never lists. */
  sweep: boolean;
  /** A path as it may be shown: bounded and home-redacted. Never a realpath. */
  shown: (path: string) => string;
  /** CLOCK_MONOTONIC now, in microseconds. Injected so a suite can pin a window without sleeping. */
  monotonicNowUs: bigint;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface FleetSystemdItem {
  /** A unit name, a registry key, or a platform name. Never an absolute path. */
  path: string;
  kind: FleetSystemdItemKind;
  desired: string | null;
  observed: string | null;
  /** A stable category carrying the subject: `platform-enablement-inherited:telegram`. */
  detail: string | null;
}

/** One of the five per-agent leaves, before it becomes an observation. */
export interface FleetSystemdAspect {
  state: FleetStatusState;
  items: FleetSystemdItem[];
  observed: string;
  desired: string;
  summary: string;
}

export interface FleetSystemdManagerRecord {
  code: FleetSystemdManagerCode;
  /** The word the manager answered with (`running`, `degraded`), or a stable code. */
  state: string;
  detail: string;
}

export interface FleetSystemdSharedRecord {
  state: FleetSystemdSharedState;
  code: string | null;
  unit: string | null;
  profile: string | null;
  detail: string;
}

export interface FleetSystemdUnregisteredRecord {
  items: FleetStatusSystemdUnregisteredItem[];
  truncated: boolean;
}

export interface FleetSystemdAgentResult {
  agentId: string;
  topology: FleetSystemdAspect & {
    expected: string[];
    installed: string[];
    missing: string[];
    extra: Array<{ unit: string; class: FleetSystemdExtraClass }>;
  };
  /** The registry's own `systemd.heartbeat_timer` field. */
  heartbeatTimerRow: FleetSystemdAspect;
  capability: {
    declared: FleetSystemdCapabilityState;
    platforms: Record<string, "verified" | "deferred" | "undeclared">;
    deltaDisabled: Record<string, boolean | null>;
  };
  gateway: FleetSystemdAspect & {
    view: FleetStatusSystemdUnitView;
    code: string | null;
    result: string | null;
    execStatus: number | null;
    restarts: number | null;
    entrypoint: { family: FleetSystemdEntrypointFamily; pinned: boolean };
    home: FleetSystemdHomeState;
    stability: { samples: number; stable: boolean; transitions: string[] };
  };
  timer: FleetSystemdAspect & {
    view: FleetStatusSystemdUnitView;
    /** The stable code of the item that decided this leaf's state, or null. */
    code: string | null;
    paired: boolean;
    schedule: FleetSystemdSchedule;
    tick: FleetSystemdTick;
  };
  service: FleetSystemdAspect & {
    view: FleetStatusSystemdUnitView;
    /** The stable code of the item that decided this leaf's state, or null. */
    code: string | null;
    result: string | null;
    execStatus: number | null;
    entrypoint: { family: FleetSystemdEntrypointFamily; pinned: boolean };
    latestResult: FleetSystemdLatestResult;
    reconcile: { declared: FleetSystemdReconcileDeclaration; evidence: FleetSystemdReconcileEvidence };
  };
}

export interface FleetSystemdHealth {
  manager: FleetSystemdManagerRecord;
  window: { samples: number; interval_ms: number };
  /** Fleet scope only; zeros under `--agent`, which lists nothing. */
  units: { listed: number; unit_files: number; transient: number };
  /** A listing that hit `limits.max_units`: the sweep saw a PREFIX of the manager's units, and says so. */
  listingTruncated: boolean;
  agents: Map<string, FleetSystemdAgentResult>;
  shared: FleetSystemdSharedRecord;
  /** Null in agent scope and when the manager could not be reached. */
  unregistered: FleetSystemdUnregisteredRecord | null;
  unregisteredReason: string | null;
  probes: FleetProbeRecord[];
}

// ---------------------------------------------------------------------------
// Small, safe primitives
// ---------------------------------------------------------------------------

/** An identifier the envelope may carry, or `unparsed` when the value is not one. */
function word(value: unknown): string {
  return typeof value === "string" && WORD.test(value) ? value : "unparsed";
}

/**
 * A UNIT NAME the envelope may carry, or `unparsed`.
 *
 * Wider than `word` on purpose: systemd allows 255 bytes and the live fleet
 * already carries 47-character names, so passing one through `word` would
 * report a real unit as `unparsed` and lose the only thing an operator could
 * act on. Still a closed grammar -- a value that is not a unit name never
 * reaches the payload.
 */
function unitWord(value: unknown): string {
  return typeof value === "string" && UNIT_NAME.test(value) ? value : "unparsed";
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function aspect(state: FleetStatusState, items: FleetSystemdItem[], observed: string, desired: string, summary: string): FleetSystemdAspect {
  return { state, items, observed, desired, summary };
}

/**
 * The item that DECIDED a leaf's state, as its stable code.
 *
 * `items[0]` was not it: an `error` leaf whose first item is a `warn` reported
 * the warning's code beside the error's state, so the one line an operator
 * reads (`gw <code>` / `hb <code>`) named a reading that did not cause the
 * verdict. The first item whose OWN rank equals the leaf's state is the cause;
 * the first item is the fallback, which is what a `pass` leaf with items or a
 * rank function and a state that disagree would fall back to.
 */
function decisiveCode(
  items: readonly FleetSystemdItem[],
  state: FleetStatusState,
  rank: (kind: FleetSystemdItemKind) => FleetStatusState,
): string | null {
  if (items.length === 0) return null;
  const decisive = items.find((item) => rank(item.kind) === state) ?? items[0]!;
  return decisive.detail ?? decisive.kind;
}

/** The precedence this module ranks its own items by: error beats fail beats warn beats pass. */
const RANK: readonly FleetStatusState[] = ["pass", "warn", "fail", "error"];

function worseOf(a: FleetStatusState, b: FleetStatusState): FleetStatusState {
  return RANK.indexOf(b) > RANK.indexOf(a) ? b : a;
}

/**
 * The four `systemctl --user` argv shapes, and the ONE place a verb is chosen.
 *
 * Throws on a verb outside `SYSTEMD_READ_VERBS`. That is not defensive
 * programming against a hostile caller -- it is the read-only guarantee made
 * structural, so a later edit that reaches for `restart` fails at the type
 * level and then at runtime rather than shipping.
 */
export function systemctlArgv(verb: FleetSystemdVerb, rest: readonly string[] = []): string[] {
  if (!(SYSTEMD_READ_VERBS as readonly string[]).includes(verb)) {
    throw new Error(`refusing to spawn systemctl ${verb}: the systemd observer is read-only`);
  }
  return ["--user", verb, ...SYSTEMD_CHILD_FLAGS, ...rest];
}

/** The environment a `systemctl` child receives: the manifest allowlist plus the four pins. An allowlist, never a filter. */
export function systemctlEnv(ctx: FleetSystemdContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ctx.manifest.probe.env_allowlist) {
    const value = ctx.env[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(SYSTEMD_CHILD_PINS)) env[key] = value;
  return env;
}

/**
 * A systemd time value in microseconds, or null.
 *
 * TWO spellings, one function. `ExecMainStartTimestampMonotonic` is a raw
 * decimal count of microseconds; `TimeoutStartUSec` and
 * `LastTriggerUSecMonotonic` are timespan strings systemd renders itself
 * (`1w 5d 14h 16min 26.297365s`, `45min`, `500ms`, `12us`). `infinity` and an
 * unparseable value are null -- never zero, which is a real reading (a unit
 * that has never run).
 */
export function parseSystemdUsec(raw: string | undefined): bigint | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === "" || value === "infinity" || value === "n/a") return null;
  if (/^\d+$/u.test(value)) return BigInt(value);
  let total = 0n;
  let matched = false;
  const token = /(\d+(?:\.\d+)?)\s*([A-Za-z]+)/gu;
  let hit: RegExpExecArray | null;
  while ((hit = token.exec(value)) !== null) {
    const unit = DURATION_UNITS.find(([name]) => name === hit![2]);
    if (unit === undefined) return null;
    // Fractional seconds are real (`26.297365s`); the multiplication is done in
    // floating point and then floored to whole microseconds, which is the
    // resolution the value itself has.
    total += BigInt(Math.floor(Number(hit[1]) * Number(unit[1])));
    matched = true;
  }
  return matched ? total : null;
}

/**
 * One `show` payload as a map from unit id to its properties.
 *
 * Blocks are separated by ONE blank line and each carries its own `Id=`, which
 * is what the map is keyed on -- never the argv order, which systemd does not
 * promise to preserve. A repeated key accumulates (`TimersMonotonic` prints one
 * line per timer expression); a key with an empty value is kept as an empty
 * string, because "present and empty" and "absent" are different readings
 * (`LoadError=` on a healthy unit versus a timer that has no `Result`).
 */
export function parseShowBlocks(text: string): Map<string, Map<string, string[]>> {
  const units = new Map<string, Map<string, string[]>>();
  for (const block of text.split(/\n[ \t]*\n/u)) {
    const properties = new Map<string, string[]>();
    for (const line of block.split("\n")) {
      const at = line.indexOf("=");
      if (at <= 0) continue;
      const key = line.slice(0, at);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key)) continue;
      const existing = properties.get(key);
      if (existing === undefined) properties.set(key, [line.slice(at + 1)]);
      else existing.push(line.slice(at + 1));
    }
    const id = properties.get("Id")?.[0];
    if (id === undefined || id === "") continue;
    if (!units.has(id)) units.set(id, properties);
  }
  return units;
}

/** One unit's properties in one sample. `null` when the sample did not carry the unit at all. */
type Sample = Map<string, string[]> | null;

function one(sample: Sample, key: string): string | undefined {
  return sample?.get(key)?.[0];
}

function all(sample: Sample, key: string): string[] {
  return sample?.get(key) ?? [];
}

/**
 * The required properties this sample does not carry AT ALL, in declaration
 * order.
 *
 * `one` returns `undefined` only for a key the block never printed; a key
 * printed with an empty value (`UnitFileState=` on a `not-found` unit) comes
 * back as `""` and is a reading, not a gap.
 */
function missingProperties(sample: Sample): string[] {
  if (sample === null) return [];
  return SYSTEMD_REQUIRED_PROPERTIES.filter((key) => one(sample, key) === undefined);
}

/** What one unit's sample supports: a full reading, an absent unit, or a sample this build refuses to read. */
type UnitReading = "readable" | "absent" | "unreadable";

/** A value at a dotted path inside a parsed YAML mapping, or `undefined`. Mappings only; never an array index. */
function atPath(root: unknown, segments: readonly string[]): unknown {
  let cursor = root;
  for (const key of segments) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** The `path=` and the first argv token of an `ExecStart={ ... }` line. Nothing else from it is read. */
export function parseExecStart(raw: string | undefined): { path: string | null; argv0: string | null } {
  if (raw === undefined) return { path: null, argv0: null };
  const path = /(?:^|[{;\s])path=([^;]+?)\s*(?:;|\}|$)/u.exec(raw);
  const argv = /argv\[\]=(\S+)/u.exec(raw);
  return { path: path ? path[1]!.trim() : null, argv0: argv ? argv[1]! : null };
}

/**
 * The two declared keys of an `Environment=` line, and nothing else.
 *
 * The live `pjangler-pm` gateway carries `CODEX_HOME`, `TERMINAL_CWD`, a
 * `PATH` and four `OP_*` keys beside them. None of those reaches `data`, a
 * note, an item or a diagnostic: this returns exactly the keys it was asked
 * for, so a key nobody named cannot leak through a later edit.
 */
export function parseEnvironment(lines: readonly string[], keys: readonly string[]): Record<string, string | null> {
  const wanted = new Set(keys);
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = null;
  for (const line of lines) {
    for (const token of splitEnvironmentLine(line)) {
      const at = token.indexOf("=");
      if (at <= 0) continue;
      const key = token.slice(0, at);
      if (!wanted.has(key) || out[key] !== null) continue;
      out[key] = token.slice(at + 1);
    }
  }
  return out;
}

/**
 * One `Environment=` line split into assignments the way systemd QUOTES them.
 *
 * Splitting on whitespace was wrong for the one thing this parser exists to
 * read: systemd prints a value containing a space as `"HERMES_HOME=/a b/c"`,
 * so a naive split truncated the home at the space and the observer reported
 * `home-unsafe` or `home-mismatch` about a path the unit does not have. Double
 * and single quotes both open a token, a backslash escapes the next character
 * outside single quotes, and whitespace outside quotes ends it.
 */
export function splitEnvironmentLine(line: string): string[] {
  const out: string[] = [];
  let token = "";
  let quote: string | null = null;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]!;
    if (quote === null && (ch === " " || ch === "\t")) {
      if (started) { out.push(token); token = ""; started = false; }
      continue;
    }
    started = true;
    if (quote === null && (ch === '"' || ch === "'")) { quote = ch; continue; }
    if (quote !== null && ch === quote) { quote = null; continue; }
    if (ch === "\\" && quote !== "'" && index + 1 < line.length) { index += 1; token += line[index]!; continue; }
    token += ch;
  }
  if (started) out.push(token);
  return out;
}

/** The monotonic expression each `TimersMonotonic={ OnXUSec=... ; ... }` line declares, in microseconds. */
export function parseTimersMonotonic(lines: readonly string[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const line of lines) {
    const hit = /\{\s*([A-Za-z]+USec)\s*=\s*([^;}]+?)\s*(?:;|\})/u.exec(line);
    if (hit === null) continue;
    const usec = parseSystemdUsec(hit[2]);
    if (usec !== null && !out.has(hit[1]!)) out.set(hit[1]!, usec);
  }
  return out;
}

/** A unit's five reported words, bounded. The `FleetStatusSystemdUnitView` every leaf carries. */
function unitView(unit: string, sample: Sample): FleetStatusSystemdUnitView {
  // A property the manager did not report is `null`, never the word
  // `unparsed`: "systemd said nothing about this" and "systemd said something
  // this build will not repeat" are different readings, and an unit-file state
  // of `""` (what a `not-found` unit carries) is the first of the two.
  const reported = (key: string): string | null => {
    const value = one(sample, key);
    return value === undefined || value === "" ? null : word(value);
  };
  return {
    unit,
    load: sample === null ? null : reported("LoadState"),
    unit_file: sample === null ? null : reported("UnitFileState"),
    active: sample === null ? null : reported("ActiveState"),
    sub: sample === null ? null : reported("SubState"),
  };
}

/** A whole number from a property, or `undefined` when it is absent, and `NaN` when it is present and malformed. */
function numeric(sample: Sample, key: string): number | undefined {
  const raw = one(sample, key);
  if (raw === undefined || raw === "") return undefined;
  return /^-?\d+$/u.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

/** A unit name derived from a pattern, or null when the id could not be substituted safely. */
function derive(pattern: unknown, agentId: string): string | null {
  if (typeof pattern !== "string" || pattern === "") return null;
  if (!SAFE_SEGMENT.test(agentId)) return null;
  const name = pattern.replaceAll("{agent_id}", agentId);
  return UNIT_NAME.test(name) ? name : null;
}

// ---------------------------------------------------------------------------
// Phase 1: the manager probe
// ---------------------------------------------------------------------------

/**
 * Is the user manager answering, and is it in a state the manifest calls
 * available?
 *
 * `degraded` IS available and is what this host reports: a failed unit
 * somewhere else on the manager does not make the fleet unobservable, and
 * treating it as a collection failure would report the whole domain `error`
 * on a machine where every Hermes unit is fine. `is-system-running` exits
 * NONZERO for `degraded`, so the probe keeps stdout on failure and classifies
 * by the word, never by the exit code.
 */
async function probeManager(ctx: FleetSystemdContext): Promise<{ record: FleetSystemdManagerRecord; probe: FleetProbeRecord }> {
  // `keepStdoutOnFailure` on EVERY child of this module, and load-bearing on
  // this one: `is-system-running` exits 1 for `degraded` with the word on
  // stdout, so classifying by the exit code would report the most common
  // healthy state on this fleet as an unreachable manager. On the others it is
  // insurance rather than a contract -- a non-`ok` outcome is still not a
  // sample, and a listing that did not exit 0 is not parsed as JSON.
  const result = await probeText(ctx.run, SYSTEMCTL, systemctlArgv("is-system-running"), {
    env: systemctlEnv(ctx),
    timeoutMs: ctx.manifest.probe.timeout_ms,
    keepStdoutOnFailure: true,
  });
  throwIfCancelled(ctx.run);
  const record = (code: FleetSystemdManagerCode, state: string, detail: string): FleetSystemdManagerRecord => ({ code, state, detail });
  const probe = (outcome: FleetProbeOutcome, reason: string | null): FleetProbeRecord => ({
    id: `${SYSTEMD_PROBE_KIND}:is-system-running`, kind: SYSTEMD_PROBE_KIND, target: "is-system-running", outcome, reason,
  });
  if (result.outcome === "timeout") {
    return {
      record: record("manager-timeout", "timeout", `systemctl --user is-system-running did not answer within ${ctx.manifest.probe.timeout_ms} ms; no unit was sampled`),
      probe: probe("timeout", "manager-timeout"),
    };
  }
  const answer = (result.value ?? "").trim().split(/\s+/u)[0] ?? "";
  if (answer === "") {
    return {
      record: record("manager-unavailable", "unreachable", "systemctl --user is-system-running produced no answer; there is no user manager to observe on this host"),
      probe: probe(result.outcome === "cancelled" ? "cancelled" : "failed", "manager-unavailable"),
    };
  }
  if (!ctx.manifest.probe.manager_available_states.includes(answer)) {
    return {
      record: record("manager-unavailable", word(answer), `the user manager reports ${word(answer)}, which service_manifest.probe.manager_available_states does not list; no unit was sampled`),
      probe: probe("failed", "manager-unavailable"),
    };
  }
  return {
    record: record("available", word(answer), `the user manager reports ${word(answer)}, which the contract lists as available`),
    probe: probe("ok", null),
  };
}

// ---------------------------------------------------------------------------
// Phase 2: the fleet listings
// ---------------------------------------------------------------------------

interface Listing {
  /** Loaded units the manager knows, by name. */
  units: Map<string, { load: string; active: string; sub: string; description: string }>;
  /** Unit files on disk, by name, with their `UnitFileState`. */
  files: Map<string, string>;
  probes: FleetProbeRecord[];
  truncated: boolean;
  /** A stable code when a listing could not be read, else null. */
  error: string | null;
}

function emptyListing(): Listing {
  return { units: new Map(), files: new Map(), probes: [], truncated: false, error: null };
}

async function listFleet(ctx: FleetSystemdContext): Promise<Listing> {
  const listing = emptyListing();
  const env = systemctlEnv(ctx);
  const record = (verb: string, outcome: FleetProbeOutcome, reason: string | null): void => {
    listing.probes.push({ id: `${SYSTEMD_PROBE_KIND}:${verb}`, kind: SYSTEMD_PROBE_KIND, target: verb, outcome, reason });
  };
  const glob = ctx.manifest.unregistered.unit_glob;

  const units = await probeText(ctx.run, SYSTEMCTL, systemctlArgv("list-units", [glob, "--all", "--output=json"]), {
    env, timeoutMs: ctx.manifest.probe.timeout_ms, keepStdoutOnFailure: true,
  });
  throwIfCancelled(ctx.run);
  if (units.outcome !== "ok") {
    listing.error = units.outcome === "timeout" ? "listing-timeout" : "listing-failed";
    record("list-units", units.outcome, listing.error);
    return listing;
  }
  try {
    const parsed: unknown = JSON.parse(units.value ?? "[]");
    if (!Array.isArray(parsed)) throw new Error("not a list");
    if (parsed.length > ctx.manifest.limits.max_units) listing.truncated = true;
    for (const row of parsed.slice(0, ctx.manifest.limits.max_units)) {
      if (typeof row !== "object" || row === null) continue;
      const entry = row as Record<string, unknown>;
      const name = typeof entry.unit === "string" ? entry.unit : null;
      if (name === null || !UNIT_NAME.test(name)) continue;
      listing.units.set(name, {
        load: word(entry.load),
        active: word(entry.active),
        sub: word(entry.sub),
        // The description is NOT emitted; it is kept only so the transient
        // classification can look for an exact `--profile <name>` token in it.
        description: typeof entry.description === "string" ? entry.description : "",
      });
    }
    record("list-units", "ok", null);
  } catch {
    listing.error = "listing-malformed";
    record("list-units", "failed", listing.error);
    return listing;
  }

  const files = await probeText(ctx.run, SYSTEMCTL, systemctlArgv("list-unit-files", [glob, "--output=json"]), {
    env, timeoutMs: ctx.manifest.probe.timeout_ms, keepStdoutOnFailure: true,
  });
  throwIfCancelled(ctx.run);
  if (files.outcome !== "ok") {
    listing.error = files.outcome === "timeout" ? "listing-timeout" : "listing-failed";
    record("list-unit-files", files.outcome, listing.error);
    return listing;
  }
  try {
    const parsed: unknown = JSON.parse(files.value ?? "[]");
    if (!Array.isArray(parsed)) throw new Error("not a list");
    if (parsed.length > ctx.manifest.limits.max_units) listing.truncated = true;
    for (const row of parsed.slice(0, ctx.manifest.limits.max_units)) {
      if (typeof row !== "object" || row === null) continue;
      const entry = row as Record<string, unknown>;
      const name = typeof entry.unit_file === "string" ? entry.unit_file : null;
      if (name === null || !UNIT_NAME.test(name)) continue;
      listing.files.set(name, word(entry.state));
    }
    record("list-unit-files", "ok", null);
  } catch {
    listing.error = "listing-malformed";
    record("list-unit-files", "failed", listing.error);
  }
  return listing;
}

// ---------------------------------------------------------------------------
// Phase 4: the stability window
//
// Phase 3 -- the universe of units to sample -- is derived in the entry point
// at the bottom of this file rather than here, because it needs the whole
// context (every selected agent, every REGISTERED agent's owned names, and the
// shared gateway) and produces no function of its own. The numbers follow the
// RUN order, so they skip here rather than renumber around it.
// ---------------------------------------------------------------------------

interface Window {
  /** Per unit, one entry per sample. A sample that did not carry the unit is `null`. */
  samples: Map<string, Sample[]>;
  taken: number;
  probes: FleetProbeRecord[];
  /** A stable code when sampling failed outright, else null. */
  error: string | null;
}

/**
 * Sample every unit of interest, `stabilization.samples` times, one child per
 * sample.
 *
 * ONE child per sample and not one per agent per sample: 28 agents times three
 * units times three samples would be 252 spawns, and -- worse -- no two agents
 * would share an observation window, so "stable over the same window" would be
 * a fiction. Every unit of interest rides one argv.
 */
async function sampleWindow(ctx: FleetSystemdContext, unitsOfInterest: readonly string[]): Promise<Window> {
  const window: Window = { samples: new Map(), taken: 0, probes: [], error: null };
  for (const unit of unitsOfInterest) window.samples.set(unit, []);
  if (unitsOfInterest.length === 0) return window;
  const env = systemctlEnv(ctx);
  const argv = systemctlArgv("show", ["-p", SYSTEMD_SHOW_PROPERTIES.join(","), ...unitsOfInterest]);
  for (let index = 0; index < ctx.manifest.stabilization.samples; index += 1) {
    if (index > 0) await sleepBounded(ctx.run, ctx.manifest.stabilization.interval_ms);
    throwIfCancelled(ctx.run);
    const result = await probeText(ctx.run, SYSTEMCTL, argv, { env, timeoutMs: ctx.manifest.probe.timeout_ms, keepStdoutOnFailure: true });
    throwIfCancelled(ctx.run);
    const id = `${SYSTEMD_PROBE_KIND}:show:${index}`;
    const target = `${unitsOfInterest.length} unit(s)`;
    if (result.outcome !== "ok") {
      const reason = result.outcome === "timeout" ? "show-timeout" : "show-failed";
      window.probes.push({ id, kind: SYSTEMD_PROBE_KIND, target, outcome: result.outcome, reason });
      // ONE failed sample does not invalidate the window; a window with no
      // sample at all does, and says which failure ended it.
      if (window.taken === 0) window.error = reason;
      continue;
    }
    const text = result.value ?? "";
    if (Buffer.byteLength(text) > ctx.manifest.limits.max_show_bytes) {
      window.probes.push({ id, kind: SYSTEMD_PROBE_KIND, target, outcome: "failed", reason: "show-too-large" });
      if (window.taken === 0) window.error = "show-too-large";
      continue;
    }
    const parsed = parseShowBlocks(text);
    for (const unit of unitsOfInterest) window.samples.get(unit)!.push(parsed.get(unit) ?? null);
    window.taken += 1;
    window.error = null;
    window.probes.push({ id, kind: SYSTEMD_PROBE_KIND, target, outcome: "ok", reason: null });
  }
  return window;
}

// ---------------------------------------------------------------------------
// Phase 5: per-agent evaluation (pure, over the samples)
// ---------------------------------------------------------------------------

/** Everything the per-agent evaluation shares: the window, the listings, and the manifest-derived constants. */
interface Shared {
  manager: FleetSystemdManagerRecord;
  window: Window;
  listing: Listing;
  /** Directories a `FragmentPath` may live in, resolved. */
  unitDirs: string[];
  /** The fleet base's per-platform enablement, read once: what a delta that pins nothing inherits. */
  baseEnabled: Record<string, boolean | null>;
}

/** The properties of one unit that make a window unanimous, joined for comparison. */
function stabilityKey(sample: Sample): string {
  if (sample === null) return "absent";
  return [
    one(sample, "LoadState") ?? "-",
    one(sample, "UnitFileState") ?? "-",
    one(sample, "ActiveState") ?? "-",
    one(sample, "SubState") ?? "-",
    one(sample, "Result") ?? "-",
    one(sample, "ExecMainStatus") ?? "-",
  ].join("/");
}

/** How a transition reads to an operator: two words, never a timestamp. */
function stabilitySummary(sample: Sample): string {
  if (sample === null) return "absent";
  return `${word(one(sample, "ActiveState"))}/${word(one(sample, "SubState"))}`;
}

interface Stability {
  stable: boolean;
  crashLooping: boolean;
  transitions: string[];
  restarts: number | null;
  malformed: string[];
}

/**
 * Was this unit the same unit for the whole window?
 *
 * The template's own rule (`systemd_wait_for_stable_health`): a unit that
 * looked healthy and then changed is NOT proven, and the transition is what is
 * reported -- never the most favourable sample. An `NRestarts` that grew during
 * the window is a crash loop rather than a mere instability, and gets its own
 * summary (`restarts 3 -> 5`) because the cause is different.
 */
function evaluateStability(samples: readonly Sample[]): Stability {
  const transitions: string[] = [];
  const malformed: string[] = [];
  let stable = true;
  for (let index = 1; index < samples.length; index += 1) {
    if (stabilityKey(samples[index - 1]!) === stabilityKey(samples[index]!)) continue;
    stable = false;
    const summary = `${stabilitySummary(samples[index - 1]!)} -> ${stabilitySummary(samples[index]!)}`;
    if (!transitions.includes(summary)) transitions.push(summary);
  }
  let first: number | null = null;
  let last: number | null = null;
  for (const sample of samples) {
    const value = numeric(sample, "NRestarts");
    if (value === undefined) continue;
    if (Number.isNaN(value)) { if (!malformed.includes("NRestarts")) malformed.push("NRestarts"); continue; }
    if (first === null) first = value;
    last = value;
  }
  const crashLooping = first !== null && last !== null && last > first;
  if (crashLooping) {
    const summary = `restarts ${first} -> ${last}`;
    if (!transitions.includes(summary)) transitions.push(summary);
  }
  return { stable: stable && !crashLooping, crashLooping, transitions, restarts: last, malformed };
}

/**
 * Is the heartbeat oneshot mid-tick, and has it been mid-tick too long?
 *
 * Computed ONCE and reported on the TIMER leaf, because "is the tick
 * happening" is the timer's question -- the same leaf that owns
 * `tick-overdue`, `tick-never` and `schedule-off-policy` -- while "did the last
 * COMPLETED run succeed" (`latest-result-failed`) is the oneshot's. systemd
 * pre-initialises `Result=success` before the first exit, so an activating
 * oneshot is never read as a success; whether it is merely running or wedged is
 * the unit's OWN start timeout, floored by the manifest's ceiling for a unit
 * that declares none.
 */
function evaluateTickActivation(sample: Sample, monotonicNowUs: bigint, maxTickSeconds: number): "in-progress" | "stuck" | null {
  if (sample === null || one(sample, "LoadState") !== "loaded") return null;
  const active = one(sample, "ActiveState") ?? "";
  if (active !== "activating" && active !== "active") return null;
  // `RemainAfterExit=yes` leaves a SUCCESSFULLY completed oneshot sitting at
  // `active/exited`. That is a finished tick, not one in flight: reading it as
  // `in-progress` would age into `stuck` and never recover. Every heartbeat
  // unit this fleet provisions is `RemainAfterExit=no`, so this is the latent
  // half of the rule rather than the live one.
  if (one(sample, "SubState") === "exited") return null;
  const timeout = parseSystemdUsec(one(sample, "TimeoutStartUSec")) ?? BigInt(maxTickSeconds) * 1_000_000n;
  const start = parseSystemdUsec(one(sample, "ExecMainStartTimestampMonotonic"));
  const age = start === null || start === 0n ? null : monotonicNowUs - start;
  return age !== null && age >= timeout ? "stuck" : "in-progress";
}

/** Which executable family a unit's `ExecStart` path belongs to, and whether the registry pins it. */
function classifyEntrypoint(
  path: string | null,
  roleDir: string | null,
  launcher: string,
  hermesBin: string | null,
): { family: FleetSystemdEntrypointFamily; pinned: boolean } {
  if (path === null || path === "") return { family: "unknown", pinned: false };
  const launcherPath = roleDir === null ? null : resolve(roleDir, launcher);
  if (launcherPath !== null && resolve(path) === launcherPath) return { family: "launcher", pinned: true };
  if (hermesBin !== null && resolve(path) === resolve(hermesBin)) return { family: "hermes-bin", pinned: true };
  // Any other `hermes` on disk is a release the registry does not pin. It is
  // still the `hermes-bin` FAMILY -- naming it `other` would hide that the unit
  // runs Hermes at all -- but it is not pinned.
  if (/(?:^|\/)hermes$/u.test(path)) return { family: "hermes-bin", pinned: false };
  // By BASENAME, never by bare suffix: `endsWith` alone classed
  // `/opt/anything/foo-credential-launch.sh` as this role's launcher, and a
  // launcher is the one family this build calls PINNED when it resolves.
  const launcherName = launcher.slice(launcher.lastIndexOf("/") + 1);
  if (launcherName !== "" && path.slice(path.lastIndexOf("/") + 1) === launcherName) return { family: "launcher", pinned: false };
  return { family: "other", pinned: false };
}

/** Is the unit's declared profile home this agent's own named profile directory? */
function classifyHome(home: string | null, expected: string | null, fleetHomeReal: string): FleetSystemdHomeState {
  if (home === null || home === "") return "absent";
  const resolved = resolve(home);
  if (!isAbsolute(resolved) || !within(fleetHomeReal, resolved)) return "unsafe";
  if (expected === null) return "unknown";
  return resolved === resolve(expected) ? "matches" : "mismatch";
}

/**
 * The FLEET BASE's `platforms.<p>.enabled`, read once for the whole run.
 *
 * The base is the file the renderer merges every delta over
 * (`hermes-profile-config.py`'s `BASE`), so a delta that pins nothing inherits
 * exactly this. Reading it is what makes `platform-enablement-inherited:<p>`
 * mean what its name says: without it the item fires for a deferred platform
 * NOTHING enables, which is an item asking an operator to pin away an
 * enablement that does not exist. `null` for a platform the base does not
 * declare, and for a base that is missing or unparseable -- an enablement this
 * observer could not read is not an enablement it will claim.
 */
function readBaseEnablement(ctx: FleetSystemdContext, platforms: readonly string[]): Record<string, boolean | null> {
  const enabled: Record<string, boolean | null> = {};
  for (const platform of platforms) enabled[platform] = null;
  const path = join(ctx.fleetHome, RENDERER_BASE_FILE);
  if (entryStat(path).kind !== "file") return enabled;
  const read = readBounded(path, ctx.manifest.limits.max_file_bytes);
  if (!("bytes" in read)) return enabled;
  let document: unknown;
  try { document = YAML.parse(read.bytes.toString("utf8")); } catch { return enabled; }
  for (const platform of platforms) {
    const value = atPath(document, ctx.manifest.messaging.enabled_path.replaceAll("{platform}", platform).split("."));
    enabled[platform] = typeof value === "boolean" ? value : null;
  }
  return enabled;
}

/** The delta's `platforms.<p>.enabled` pin, read once per agent. `null` when the delta leaves it inherited. */
function readDeltaEnablement(ctx: FleetSystemdContext, profileName: string | null, platforms: readonly string[]): {
  enabled: Record<string, boolean | null>;
  secrets: Record<string, boolean>;
  read: BoundedRead | null;
} {
  const enabled: Record<string, boolean | null> = {};
  const secrets: Record<string, boolean> = {};
  for (const platform of platforms) { enabled[platform] = null; secrets[platform] = false; }
  if (profileName === null || ctx.profileRoot === null || !isSafePathSegment(profileName)) return { enabled, secrets, read: null };
  const path = join(ctx.profileRoot, profileName, ctx.overrideFile);
  if (entryStat(path).kind !== "file") return { enabled, secrets, read: null };
  const read = readBounded(path, ctx.manifest.limits.max_file_bytes);
  if (!("bytes" in read)) return { enabled, secrets, read };
  let document: unknown;
  try { document = YAML.parse(read.bytes.toString("utf8")); } catch { return { enabled, secrets, read: { error: "unreadable" } }; }
  for (const platform of platforms) {
    const segments = ctx.manifest.messaging.enabled_path.replaceAll("{platform}", platform).split(".");
    const value = atPath(document, segments);
    enabled[platform] = typeof value === "boolean" ? value : null;
    // PRESENCE of the declared environment key under the delta's secret block,
    // and nothing else. The reference itself is never read, never compared and
    // never emitted -- only whether the delta names the key at all.
    const keys = ctx.manifest.messaging.secret_env[platform] ?? [];
    const block = atPath(document, ["secrets", "onepassword", "env"]);
    secrets[platform] = keys.length > 0 && typeof block === "object" && block !== null
      && keys.every((key) => typeof (block as Record<string, unknown>)[key] === "string" && ((block as Record<string, unknown>)[key] as string).trim() !== "");
  }
  return { enabled, secrets, read };
}

/** What the role's reconcile policy declares, and what its state file evidences. Presence of keys only. */
function readReconcile(ctx: FleetSystemdContext, roleDir: string | null): {
  declared: FleetSystemdReconcileDeclaration;
  evidence: FleetSystemdReconcileEvidence;
  kind: FleetSystemdItemKind | null;
} {
  const { reconcile_policy_file, reconcile_state_file } = ctx.manifest.heartbeat;
  if (roleDir === null) return { declared: "unverifiable", evidence: "not-read", kind: "reconcile-unverifiable" };
  const policyPath = join(roleDir, ...reconcile_policy_file.split("/"));
  if (entryStat(policyPath).kind !== "file") return { declared: "undeclared", evidence: "not-applicable", kind: "reconcile-undeclared" };
  const read = readBounded(policyPath, ctx.manifest.limits.max_file_bytes);
  if (!("bytes" in read)) return { declared: "unreadable", evidence: "not-read", kind: "policy-unreadable" };
  let document: unknown;
  try { document = YAML.parse(read.bytes.toString("utf8")); } catch { return { declared: "unreadable", evidence: "not-read", kind: "policy-unreadable" }; }
  const block = typeof document === "object" && document !== null && !Array.isArray(document)
    ? (document as Record<string, unknown>).reconcile
    : undefined;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return { declared: "undeclared", evidence: "not-applicable", kind: "reconcile-undeclared" };
  }
  const record = block as Record<string, unknown>;
  if (record.enabled !== true) {
    if (record.explicit_opt_out === true) return { declared: "opted-out", evidence: "not-applicable", kind: null };
    return { declared: "disabled", evidence: "not-applicable", kind: "reconcile-opt-out-undeclared" };
  }
  // Reconcile is ON: the heartbeat must be evidencing a FULL run, not only a
  // checkpoint tick. The state file is read for the PRESENCE of two keys and
  // nothing else -- never a value, never a decision, never a timestamp.
  const statePath = join(roleDir, ...reconcile_state_file.split("/"));
  if (entryStat(statePath).kind !== "file") return { declared: "enabled", evidence: "state-missing", kind: "checkpoint-only" };
  const state = readBounded(statePath, ctx.manifest.limits.max_file_bytes);
  if (!("bytes" in state)) return { declared: "enabled", evidence: "state-unreadable", kind: "state-unreadable" };
  let parsed: unknown;
  try { parsed = JSON.parse(state.bytes.toString("utf8")); } catch { return { declared: "enabled", evidence: "state-unreadable", kind: "state-unreadable" }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { declared: "enabled", evidence: "state-unreadable", kind: "state-unreadable" };
  }
  const keys = parsed as Record<string, unknown>;
  const full = keys.last_full_run_epoch !== undefined && keys.last_runner_completed_at !== undefined;
  return { declared: "enabled", evidence: full ? "full-run" : "checkpoint-only", kind: full ? null : "checkpoint-only" };
}

/** Every leaf reads `error` with one collection code: what a failed manager or an unsampled window leaves behind. */
function erroredAspect(kind: FleetSystemdItemKind, unit: string, detail: string, summary: string): FleetSystemdAspect {
  return aspect("error", [{ path: unit, kind, desired: "an observation of the user manager", observed: kind, detail }], kind, "an observation of the user manager", summary);
}

/**
 * Every leaf of one agent, filled in with a collection failure.
 *
 * The three unit names arrive BY KEY, never as positions in `expected`.
 * `expected` is SORTED for the payload, and the canonical triple sorts
 * `…-gateway.service`, `…-heartbeat.service`, `…-heartbeat.timer` -- so
 * destructuring it as `[gateway, timer, service]` handed the heartbeat SERVICE
 * to the timer leaf and the TIMER to the service leaf on every
 * `manager-unavailable`, `manager-timeout` and `show-failed` result. The error
 * path is exactly where an operator has the least other evidence, so it is the
 * worst place to name the wrong unit.
 */
function emptyAgentResult(
  input: FleetSystemdAgentInput,
  expected: string[],
  units: { gateway: string | null; timer: string | null; service: string | null },
  failure: (unit: string) => FleetSystemdAspect,
  platforms: readonly string[],
): FleetSystemdAgentResult {
  const view = (unit: string): FleetStatusSystemdUnitView => ({ unit, load: null, unit_file: null, active: null, sub: null });
  const { gateway: gatewayUnit, timer: timerUnit, service: serviceUnit } = units;
  // ONE aspect per leaf, and its code comes from that aspect's own item -- the
  // same rule a READ leaf follows. Hardcoding `code: null` here blanked
  // `agents[].systemd.gateway.code` and `.heartbeat.code` on every collection
  // failure: the leaves still carried an item naming the failure, and the two
  // summary fields a JSON consumer reads to learn WHY the domain is not proven
  // said nothing at all.
  const gatewayAspect = failure(gatewayUnit ?? input.agentId);
  const timerAspect = failure(timerUnit ?? input.agentId);
  const serviceAspect = failure(serviceUnit ?? input.agentId);
  const codeOf = (leaf: FleetSystemdAspect): string | null => (
    leaf.items.length === 0 ? null : leaf.items[0]!.detail ?? leaf.items[0]!.kind
  );
  return {
    agentId: input.agentId,
    topology: { ...gatewayAspect, expected, installed: [], missing: [], extra: [] },
    heartbeatTimerRow: timerAspect,
    capability: {
      declared: "undeclared",
      platforms: Object.fromEntries(platforms.map((platform) => [platform, "undeclared" as const])),
      deltaDisabled: Object.fromEntries(platforms.map((platform) => [platform, null])),
    },
    gateway: {
      ...gatewayAspect, view: view(gatewayUnit ?? "(underivable)"), code: codeOf(gatewayAspect),
      result: null, execStatus: null, restarts: null,
      entrypoint: { family: "unknown", pinned: false }, home: "unknown",
      stability: { samples: 0, stable: false, transitions: [] },
    },
    timer: { ...timerAspect, view: view(timerUnit ?? "(underivable)"), code: codeOf(timerAspect), paired: false, schedule: "unknown", tick: "unknown" },
    service: {
      ...serviceAspect, view: view(serviceUnit ?? "(underivable)"), code: codeOf(serviceAspect),
      result: null, execStatus: null, entrypoint: { family: "unknown", pinned: false },
      latestResult: "unknown", reconcile: { declared: "unverifiable", evidence: "not-read" },
    },
  };
}

function inspectAgent(ctx: FleetSystemdContext, shared: Shared, input: FleetSystemdAgentInput): FleetSystemdAgentResult {
  const { manifest } = ctx;
  const platforms = manifest.messaging.platforms;
  const perAgent = ctx.serviceModel?.per_agent ?? {};
  const gatewayUnit = derive(perAgent.gateway_unit, input.agentId);
  const timerUnit = derive(perAgent.heartbeat_timer, input.agentId);
  const serviceUnit = derive(perAgent.heartbeat_service, input.agentId);
  const expected = [gatewayUnit, timerUnit, serviceUnit].filter((unit): unit is string => unit !== null).sort();

  // -- the collection gates, carried onto every leaf --------------------------
  if (shared.manager.code !== "available") {
    const kind: FleetSystemdItemKind = shared.manager.code === "manager-timeout" ? "manager-timeout" : "manager-unavailable";
    return emptyAgentResult(input, expected, { gateway: gatewayUnit, timer: timerUnit, service: serviceUnit }, (unit) => erroredAspect(kind, unit, shared.manager.code, `not observed: ${shared.manager.detail}`), platforms);
  }
  if (gatewayUnit === null || timerUnit === null || serviceUnit === null) {
    return emptyAgentResult(input, expected, { gateway: gatewayUnit, timer: timerUnit, service: serviceUnit }, (unit) => aspect(
      "error",
      [{ path: unit, kind: "agent-id-unsafe", desired: "a unit name derived from service_model.per_agent", observed: "underivable", detail: null }],
      "underivable", "a unit name derived from service_model.per_agent",
      "the agent id is not one safe lower-case segment, so no canonical unit name can be derived for it",
    ), platforms);
  }
  if (shared.window.taken === 0) {
    const kind: FleetSystemdItemKind = shared.window.error === "show-timeout" ? "show-timeout" : shared.window.error === "show-too-large" ? "show-too-large" : "show-failed";
    return emptyAgentResult(input, expected, { gateway: gatewayUnit, timer: timerUnit, service: serviceUnit }, (unit) => erroredAspect(kind, unit, shared.window.error ?? "show-failed", "not observed: the stability window produced no sample of the user manager"), platforms);
  }

  const samplesOf = (unit: string): Sample[] => shared.window.samples.get(unit) ?? [];
  const latest = (unit: string): Sample => {
    const list = samplesOf(unit);
    for (let index = list.length - 1; index >= 0; index -= 1) if (list[index] !== null) return list[index]!;
    return null;
  };
  const loaded = (unit: string): boolean => {
    const sample = latest(unit);
    return sample !== null && one(sample, "LoadState") === "loaded";
  };
  const fleetHomeReal = resolve(ctx.fleetHome);
  const profileHome = input.profileName !== null && ctx.profileRoot !== null && isSafePathSegment(input.profileName)
    ? join(ctx.profileRoot, input.profileName)
    : null;

  // -- capability: DERIVED from the registry's declaration -------------------
  const declaredPlatforms: Record<string, "verified" | "deferred" | "undeclared"> = {};
  for (const platform of platforms) {
    const status = input.messaging[platform]?.status ?? null;
    declaredPlatforms[platform] = status === manifest.messaging.verified_status
      ? "verified"
      : status !== null && manifest.messaging.deferred_statuses.includes(status) ? "deferred" : "undeclared";
  }
  const anyVerified = platforms.some((platform) => declaredPlatforms[platform] === "verified");
  const anyDeferred = platforms.some((platform) => declaredPlatforms[platform] === "deferred");
  const capability: FleetSystemdCapabilityState = anyVerified ? "active" : anyDeferred ? "deferred" : "undeclared";
  const delta = readDeltaEnablement(ctx, input.profileName, platforms);

  // -- topology --------------------------------------------------------------
  const topologyItems: FleetSystemdItem[] = [];
  const installed: string[] = [];
  const missing: string[] = [];
  const extra: Array<{ unit: string; class: FleetSystemdExtraClass }> = [];
  for (const [unit, kind] of [
    [gatewayUnit, "gateway-missing"], [timerUnit, "heartbeat-timer-missing"], [serviceUnit, "heartbeat-service-missing"],
  ] as ReadonlyArray<readonly [string, FleetSystemdItemKind]>) {
    if (loaded(unit)) installed.push(unit);
    else {
      missing.push(unit);
      topologyItems.push({ path: unit, kind, desired: "loaded", observed: word(one(latest(unit), "LoadState") ?? "not-found"), detail: null });
    }
  }
  installed.sort();
  missing.sort();
  // A stored gateway name that is not the derived one: the row points the
  // provisioner at a unit the contract does not name.
  if (input.storedGatewayUnit !== null && input.storedGatewayUnit !== "" && input.storedGatewayUnit !== gatewayUnit) {
    topologyItems.push({ path: unitWord(input.storedGatewayUnit), kind: "misnamed-gateway", desired: gatewayUnit, observed: unitWord(input.storedGatewayUnit), detail: `misnamed-gateway:${unitWord(input.storedGatewayUnit)}` });
    if (loaded(input.storedGatewayUnit)) extra.push({ unit: input.storedGatewayUnit, class: "duplicate-gateway" });
  }
  // A second gateway-named unit for this agent: two gateways racing one channel.
  // SORTED, because the listing arrives in whatever order the manager chose and
  // `data` has to be byte-identical across two runs.
  for (const unit of [...shared.listing.units.keys()].sort()) {
    if (unit === gatewayUnit || !unit.startsWith(`hermes-${input.agentId}-`) || !unit.endsWith("gateway.service")) continue;
    if (extra.some((item) => item.unit === unit)) continue;
    extra.push({ unit, class: "duplicate-gateway" });
    topologyItems.push({ path: unit, kind: "duplicate-gateway", desired: gatewayUnit, observed: unit, detail: `duplicate-gateway:${unit}` });
  }
  // Retired shapes: on the manager or on disk, they are drift on the agent they name.
  for (const pattern of manifest.unregistered.retired_candidates) {
    const unit = derive(pattern, input.agentId);
    if (unit === null) continue;
    const present = loaded(unit) || shared.listing.units.has(unit) || shared.listing.files.has(unit)
      || (latest(unit) !== null && one(latest(unit), "LoadState") !== "not-found");
    if (!present) continue;
    extra.push({ unit, class: "retired" });
    topologyItems.push({ path: unit, kind: "retired-unit", desired: "absent", observed: word(one(latest(unit), "LoadState") ?? "present"), detail: `retired-unit:${unit}` });
  }
  // Registry keys the contract does not declare writable are retired keys.
  for (const key of input.storedSystemdKeys) {
    if (ctx.declaredSystemdKeys.includes(key)) continue;
    topologyItems.push({ path: `systemd.${word(key)}`, kind: "registry-retired-key", desired: "absent", observed: word(key), detail: `registry-retired-key:${word(key)}` });
  }
  extra.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  const topologyState = topologyItems.length === 0 ? "pass" : "fail";
  const topology = {
    ...aspect(
      topologyState, topologyItems,
      `${installed.length} of ${expected.length} canonical unit(s) loaded${extra.length ? `, ${extra.length} extra` : ""}`,
      `the canonical unit set ${expected.join(", ")} loaded, with no retired or duplicate unit and no retired registry key`,
      topologyItems.length === 0
        ? `the canonical unit set is loaded and the row records no retired systemd key`
        : `${topologyItems.length} topology defect(s): the canonical unit set, the row's own unit names, or a retired shape disagrees with the contract`,
    ),
    expected, installed, missing, extra,
  };

  // -- the registry's heartbeat_timer field ----------------------------------
  const rowItems: FleetSystemdItem[] = [];
  const stored = input.storedHeartbeatTimer !== null && input.storedHeartbeatTimer !== "" ? input.storedHeartbeatTimer : null;
  const timerOnDisk = shared.listing.files.has(timerUnit) || loaded(timerUnit);
  if (stored === null) {
    if (timerOnDisk) {
      rowItems.push({ path: timerUnit, kind: "registry-undeclared", desired: timerUnit, observed: "absent", detail: "registry-undeclared" });
    }
  } else if (stored !== timerUnit) {
    rowItems.push({ path: unitWord(stored), kind: "misnamed-heartbeat-timer", desired: timerUnit, observed: unitWord(stored), detail: `misnamed-heartbeat-timer:${unitWord(stored)}` });
  } else if (!loaded(timerUnit)) {
    rowItems.push({ path: timerUnit, kind: "unit-missing", desired: "loaded", observed: word(one(latest(timerUnit), "LoadState") ?? "not-found"), detail: "unit-missing" });
  }
  const heartbeatTimerRow = aspect(
    rowItems.length === 0 ? "pass" : "fail", rowItems,
    stored === null ? "absent" : unitWord(stored), timerUnit,
    rowItems.length === 0
      ? stored === null ? "the row declares no heartbeat timer and none is installed" : "the row's heartbeat timer is the canonical name and the manager loads it"
      : "the row's heartbeat_timer field and the units on this manager disagree",
  );

  // -- the gateway -----------------------------------------------------------
  const gatewaySamples = samplesOf(gatewayUnit);
  const gatewaySample = latest(gatewayUnit);
  const gatewayStability = evaluateStability(gatewaySamples);
  const gatewayItems: FleetSystemdItem[] = [];
  const gatewayView = unitView(gatewayUnit, gatewaySample);
  const gatewayExec = parseExecStart(one(gatewaySample, "ExecStart"));
  const gatewayEnvironment = parseEnvironment(all(gatewaySample, "Environment"), [manifest.entrypoint.home_env]);
  const gatewayEntrypoint = classifyEntrypoint(gatewayExec.path, input.roleDir, manifest.entrypoint.launcher, input.hermesBin);
  const gatewayHome = classifyHome(gatewayEnvironment[manifest.entrypoint.home_env] ?? null, profileHome, fleetHomeReal);
  const gatewayResult = one(gatewaySample, "Result") ?? null;
  const gatewayStatus = numeric(gatewaySample, "ExecMainStatus");
  const unitFileState = one(gatewaySample, "UnitFileState") ?? "";
  const isEnabled = ENABLED_STATES.has(unitFileState);
  const isDisabled = DISABLED_STATES.has(unitFileState) || unitFileState === "";
  const activeState = one(gatewaySample, "ActiveState") ?? "";
  const isActive = activeState === "active" || activeState === "activating" || activeState === "reloading";

  const unitDefects = (unit: string, sample: Sample, items: FleetSystemdItem[]): UnitReading => {
    if (sample === null) {
      items.push({ path: unit, kind: "absent", desired: "loaded", observed: "not-found", detail: "absent" });
      return "absent";
    }
    // A sample that CARRIES the unit and omits a load-bearing property is a
    // reading this build will not make. Checked before the `not-found` test on
    // purpose: an absent unit is still a complete reading (systemd prints all
    // four properties for one), so the two cannot be confused -- and coercing a
    // missing `ActiveState` to `""` would report `inactive` about a property
    // nobody read. ONE unit's leaf, never the run: the window is shared, but
    // each unit's block stands or falls on its own.
    const missing = missingProperties(sample);
    if (missing.length > 0) {
      for (const key of missing) {
        items.push({
          path: unit, kind: "property-malformed",
          desired: "a property the user manager reports for every unit",
          observed: "absent", detail: `property-malformed:${word(key)}`,
        });
      }
      return "unreadable";
    }
    if (one(sample, "LoadState") === "not-found") {
      items.push({ path: unit, kind: "absent", desired: "loaded", observed: "not-found", detail: "absent" });
      return "absent";
    }
    const load = one(sample, "LoadState") ?? "";
    if (load !== "loaded") {
      items.push({ path: unit, kind: "load-error", desired: "loaded", observed: word(load), detail: `load-error:${word(load)}` });
      return "unreadable";
    }
    const fragment = one(sample, "FragmentPath") ?? "";
    if (fragment !== "" && !shared.unitDirs.some((dir) => within(dir, resolve(fragment)))) {
      items.push({ path: unit, kind: "fragment-unsafe", desired: "a fragment under the declared unit directories", observed: ctx.shown(fragment), detail: "fragment-unsafe" });
    }
    return "readable";
  };

  const gatewayRead = unitDefects(gatewayUnit, gatewaySample, gatewayItems);
  if (gatewayRead === "readable") {
    for (const key of gatewayStability.malformed) {
      gatewayItems.push({ path: gatewayUnit, kind: "property-malformed", desired: "a whole number", observed: "unparsed", detail: `property-malformed:${word(key)}` });
    }
    // A present-but-unparseable `ExecMainStatus`, reported the way the oneshot's
    // leaf already reports it. Without this it was silently swallowed: `NaN`
    // fails the `!== 0` test, so the unit read as a clean exit and the summary
    // carried `exec_status: null` with no item to say why.
    if (gatewayStatus !== undefined && Number.isNaN(gatewayStatus)) {
      gatewayItems.push({ path: gatewayUnit, kind: "property-malformed", desired: "a whole number", observed: "unparsed", detail: "property-malformed:ExecMainStatus" });
    }
    // A `UnitFileState` in NEITHER set -- `static`, `generated`, `indirect`,
    // `bad`. The observer's whole deferred verdict is "this unit is disabled",
    // and a static or indirectly-enabled unit is not a unit anyone disabled: it
    // is a reading this vocabulary cannot classify, and saying so is the only
    // honest option. `warn`, because nothing is proven either way.
    if (!isEnabled && !isDisabled) {
      gatewayItems.push({
        // SHORT on purpose: `desired` is clipped to 64 characters with no
        // marker on the way into the payload, and the full two vocabularies are
        // 85 -- so spelling them here ended the enumeration mid-word in the one
        // item whose whole job is to say which vocabulary the reading fell
        // outside of. The lists live in the README table instead.
        path: gatewayUnit, kind: "unit-file-state-unclassified",
        desired: "an enabled or a disabled UnitFileState",
        observed: word(unitFileState), detail: `unit-file-state-unclassified:${word(unitFileState)}`,
      });
    }
    if (capability === "active") {
      if (!isEnabled) gatewayItems.push({ path: gatewayUnit, kind: "verified-channel-gateway-disabled", desired: "enabled", observed: word(unitFileState || "absent"), detail: "verified-channel-gateway-disabled" });
      if (activeState !== "active" || one(gatewaySample, "SubState") !== "running") {
        gatewayItems.push({ path: gatewayUnit, kind: "verified-channel-gateway-inactive", desired: "active/running", observed: `${word(activeState)}/${word(one(gatewaySample, "SubState"))}`, detail: "verified-channel-gateway-inactive" });
      }
      if (gatewayResult !== null && gatewayResult !== "success") {
        gatewayItems.push({ path: gatewayUnit, kind: "result-not-success", desired: "success", observed: word(gatewayResult), detail: `result-not-success:${word(gatewayResult)}` });
      }
      if (gatewayStatus !== undefined && !Number.isNaN(gatewayStatus) && gatewayStatus !== 0) {
        gatewayItems.push({ path: gatewayUnit, kind: "result-not-success", desired: "0", observed: String(gatewayStatus), detail: `exec-status:${gatewayStatus}` });
      }
      for (const platform of platforms) {
        if (declaredPlatforms[platform] !== "verified") continue;
        const identity = input.messaging[platform]?.identity ?? {};
        const blanks = (manifest.messaging.identity_fields[platform] ?? []).filter((field) => identity[field] !== true);
        if (blanks.length > 0) {
          gatewayItems.push({ path: platform, kind: "channel-identity-incomplete", desired: (manifest.messaging.identity_fields[platform] ?? []).join(", "), observed: `${blanks.length} blank`, detail: `channel-identity-incomplete:${platform}` });
        }
        if (!delta.secrets[platform]) {
          gatewayItems.push({ path: platform, kind: "channel-secret-unreferenced", desired: (manifest.messaging.secret_env[platform] ?? []).join(", "), observed: "unreferenced", detail: `channel-secret-unreferenced:${platform}` });
        }
      }
    } else if (capability === "deferred") {
      if (isEnabled) gatewayItems.push({ path: gatewayUnit, kind: "deferred-but-enabled", desired: "disabled", observed: word(unitFileState), detail: "deferred-but-enabled" });
      if (isActive) gatewayItems.push({ path: gatewayUnit, kind: "deferred-but-active", desired: "inactive", observed: word(activeState), detail: "deferred-but-active" });
      for (const platform of platforms) {
        if (declaredPlatforms[platform] !== "deferred") continue;
        // The EFFECTIVE enablement the renderer produces: the delta's pin when
        // it has one, the fleet base's value when it does not. Both halves are
        // read, because the item's whole claim is that this platform IS enabled
        // -- a deferred platform nothing enables needs no pin, and reporting one
        // there would ask an operator to pin away an enablement that does not
        // exist (the live fleet's base enables telegram, which is exactly why
        // an empty delta inherits it and a pinned one does not).
        const pinned = delta.enabled[platform];
        const effective = pinned ?? shared.baseEnabled[platform] ?? null;
        if (effective === true) {
          gatewayItems.push({
            path: platform, kind: "platform-enablement-inherited",
            desired: `${manifest.messaging.enabled_path.replaceAll("{platform}", platform)}: false`,
            observed: pinned === true ? "true" : "inherited",
            detail: `platform-enablement-inherited:${platform}`,
          });
        }
      }
    } else {
      gatewayItems.push({
        path: gatewayUnit, kind: "channel-undeclared",
        desired: `${manifest.messaging.status_field} on at least one declared platform`,
        observed: isEnabled || isActive ? "active with no declared channel" : "absent",
        detail: "channel-undeclared",
      });
    }
    // Stability is judged only where the gateway is meant to be running: a
    // deferred gateway that is correctly inactive has no window to be unstable in.
    if (capability === "active" || isActive) {
      if (gatewayStability.crashLooping) {
        gatewayItems.push({ path: gatewayUnit, kind: "crash-looping", desired: "a constant restart count", observed: gatewayStability.transitions.join("; "), detail: "crash-looping" });
      } else if (!gatewayStability.stable) {
        gatewayItems.push({ path: gatewayUnit, kind: "unstable", desired: "one unchanged reading across the window", observed: gatewayStability.transitions.join("; "), detail: "unstable" });
      } else if (activeState === "activating") {
        gatewayItems.push({ path: gatewayUnit, kind: "unstable", desired: "active/running", observed: `activating/${word(one(gatewaySample, "SubState"))}`, detail: "unstable" });
      }
      if (!gatewayEntrypoint.pinned) {
        gatewayItems.push({ path: gatewayUnit, kind: "entrypoint-unpinned", desired: "the role launcher or the executable the row pins", observed: gatewayEntrypoint.family, detail: "entrypoint-unpinned" });
      }
      if (gatewayHome === "absent") gatewayItems.push({ path: gatewayUnit, kind: "home-absent", desired: profileHome === null ? "a profile home" : ctx.shown(profileHome), observed: "absent", detail: "home-absent" });
      else if (gatewayHome === "unsafe") gatewayItems.push({ path: gatewayUnit, kind: "home-unsafe", desired: "a home under the fleet home", observed: ctx.shown(gatewayEnvironment[manifest.entrypoint.home_env] ?? ""), detail: "home-unsafe" });
      else if (gatewayHome === "mismatch") gatewayItems.push({ path: gatewayUnit, kind: "home-mismatch", desired: profileHome === null ? "this agent's profile directory" : ctx.shown(profileHome), observed: ctx.shown(gatewayEnvironment[manifest.entrypoint.home_env] ?? ""), detail: "home-mismatch" });
    }
  }

  const gatewayRank = (kind: FleetSystemdItemKind): FleetStatusState => (
    kind === "property-malformed" ? "error"
      : kind === "unit-file-state-unclassified" || (kind === "channel-undeclared" && !isEnabled && !isActive) ? "warn"
        : "fail"
  );
  let gatewayState: FleetStatusState = "pass";
  for (const item of gatewayItems) gatewayState = worseOf(gatewayState, gatewayRank(item.kind));
  const gatewayCode = decisiveCode(gatewayItems, gatewayState, gatewayRank);
  const gateway = {
    ...aspect(
      gatewayState, gatewayItems,
      gatewayRead === "readable" ? `${word(unitFileState || "absent")}/${word(activeState)}/${word(one(gatewaySample, "SubState"))}` : gatewayRead,
      capability === "active" ? "enabled, active, running and stable over the window"
        : capability === "deferred" ? "disabled and inactive, with no deferred platform left enabled by the delta or the fleet base"
          : "a declared messaging capability before any gateway is enabled",
      gatewayItems.length === 0
        ? capability === "deferred" ? "the gateway is correctly deferred: disabled, inactive, and no platform inherits enablement" : "the gateway is enabled, active and stable over the window"
        : `${gatewayItems.length} gateway defect(s) against a ${capability} messaging declaration`,
    ),
    view: gatewayView,
    code: gatewayCode,
    result: gatewayResult === null ? null : word(gatewayResult),
    execStatus: gatewayStatus === undefined || Number.isNaN(gatewayStatus) ? null : gatewayStatus,
    restarts: gatewayStability.restarts,
    entrypoint: gatewayEntrypoint,
    home: gatewayHome,
    stability: { samples: gatewaySamples.length, stable: gatewayRead === "readable" && gatewayStability.stable, transitions: gatewayStability.transitions },
  };

  // -- the heartbeat timer ---------------------------------------------------
  const timerSample = latest(timerUnit);
  const timerItems: FleetSystemdItem[] = [];
  const timerRead = unitDefects(timerUnit, timerSample, timerItems);
  const timers = parseTimersMonotonic(all(timerSample, "TimersMonotonic"));
  let schedule: FleetSystemdSchedule = "unknown";
  let tick: FleetSystemdTick = "unknown";
  let paired = false;
  const serviceSample = latest(serviceUnit);
  // Whether the tick is HAPPENING is the timer's question, and the answer is
  // read off the oneshot: this leaf already carries `tick-overdue`,
  // `tick-never` and `schedule-off-policy`, and a wedged oneshot is the same
  // fact one step further along. The oneshot's own leaf keeps whether the last
  // COMPLETED run succeeded, and reports this reading as its `latest_result`
  // bucket.
  const activation = evaluateTickActivation(serviceSample, ctx.monotonicNowUs, manifest.heartbeat.max_tick_seconds);
  if (timerRead === "readable") {
    const timerFileState = one(timerSample, "UnitFileState") ?? "";
    if (!ENABLED_STATES.has(timerFileState)) timerItems.push({ path: timerUnit, kind: "timer-disabled", desired: "enabled", observed: word(timerFileState || "absent"), detail: "timer-disabled" });
    const timerActive = one(timerSample, "ActiveState") ?? "";
    if (timerActive !== "active") timerItems.push({ path: timerUnit, kind: "timer-inactive", desired: "active", observed: word(timerActive), detail: "timer-inactive" });
    const timerSub = one(timerSample, "SubState") ?? "";
    if (!TIMER_SUBSTATES.has(timerSub)) timerItems.push({ path: timerUnit, kind: "timer-substate", desired: [...TIMER_SUBSTATES].join("|"), observed: word(timerSub), detail: "timer-substate" });
    paired = one(timerSample, "Unit") === serviceUnit || all(timerSample, "Triggers").some((value) => value.split(/\s+/u).includes(serviceUnit));
    if (!paired) timerItems.push({ path: timerUnit, kind: "timer-unpaired", desired: serviceUnit, observed: unitWord(one(timerSample, "Unit") ?? "none"), detail: "timer-unpaired" });

    // The schedule, compared to the policy EXACTLY: `OnUnitInactiveUSec` and
    // `OnBootUSec` are the two expressions `70-systemd.sh` writes, and a timer
    // that fires on a different cadence is a different agent contract.
    const inactive = timers.get("OnUnitInactiveUSec");
    const boot = timers.get("OnBootUSec");
    const wantInactive = BigInt(manifest.heartbeat.on_unit_inactive_sec) * 1_000_000n;
    const wantBoot = BigInt(manifest.heartbeat.on_boot_sec) * 1_000_000n;
    // Reported in the MANIFEST's vocabulary, never systemd's. `OnUnitInactiveUSec`
    // is a property NAME rather than a value, but a payload that may carry no
    // `USec` reading is easier to keep true when the string never appears at
    // all -- and `on_unit_inactive_sec` is the key an operator would edit.
    if (inactive === undefined && boot === undefined) {
      schedule = "unknown";
      timerItems.push({ path: timerUnit, kind: "schedule-unknown", desired: `on_unit_inactive_sec ${manifest.heartbeat.on_unit_inactive_sec}s`, observed: "no monotonic expression", detail: "schedule-unknown" });
    } else if ((inactive !== undefined && inactive !== wantInactive) || (boot !== undefined && boot !== wantBoot)) {
      schedule = "off-policy";
      timerItems.push({
        path: timerUnit, kind: "schedule-off-policy",
        desired: `on_unit_inactive_sec ${manifest.heartbeat.on_unit_inactive_sec}s, on_boot_sec ${manifest.heartbeat.on_boot_sec}s`,
        observed: [inactive === undefined ? null : `on_unit_inactive_sec ${inactive / 1_000_000n}s`, boot === undefined ? null : `on_boot_sec ${boot / 1_000_000n}s`].filter((value) => value !== null).join(", "),
        detail: "schedule-off-policy",
      });
    } else schedule = "within-policy";

    // The tick, as a BUCKET. `LastTriggerUSecMonotonic` and the oneshot's exit
    // are both CLOCK_MONOTONIC in microseconds, the same clock
    // `process.hrtime.bigint()` reads, so the comparison is exact and the
    // ANSWER is a word -- never an age, which would move between two runs over
    // unchanged state.
    const lastTrigger = parseSystemdUsec(one(timerSample, "LastTriggerUSecMonotonic"));
    const lastExit = parseSystemdUsec(one(serviceSample, "ExecMainExitTimestampMonotonic"));
    const latestTick = [lastTrigger, lastExit].filter((value): value is bigint => value !== null && value > 0n).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0] ?? null;
    const overdueAfter = BigInt(manifest.heartbeat.on_unit_inactive_sec) * BigInt(manifest.heartbeat.overdue_multiplier) * 1_000_000n;
    if (latestTick === null) {
      // Never triggered. Only claim `never` once the boot delay has had time to
      // elapse twice over; before that, "not yet" and "never" are the same
      // reading and this says so.
      tick = ctx.monotonicNowUs > BigInt(manifest.heartbeat.on_boot_sec) * 2n * 1_000_000n ? "never" : "unknown";
      if (tick === "never") timerItems.push({ path: timerUnit, kind: "tick-never", desired: "a completed tick since boot", observed: "never", detail: "tick-never" });
      else timerItems.push({ path: timerUnit, kind: "tick-unknown", desired: "a completed tick since boot", observed: "not yet due", detail: "tick-unknown" });
    } else if (latestTick > ctx.monotonicNowUs) {
      tick = "unknown";
      timerItems.push({ path: timerUnit, kind: "tick-unknown", desired: "a monotonic reading inside this boot", observed: "ahead of the monotonic clock", detail: "tick-unknown" });
    } else if (ctx.monotonicNowUs - latestTick > overdueAfter) {
      tick = "overdue";
      timerItems.push({
        path: timerUnit, kind: "tick-overdue",
        desired: `a tick within ${manifest.heartbeat.on_unit_inactive_sec * manifest.heartbeat.overdue_multiplier}s`,
        observed: "overdue", detail: "tick-overdue",
      });
    } else tick = "current";

    // The oneshot mid-tick, on the leaf that owns whether the tick happens.
    // `path` names the ONESHOT, because that is the unit an operator would look
    // at -- the item is on the timer's leaf, not about the timer's own state.
    if (activation !== null) {
      timerItems.push({
        path: serviceUnit, kind: activation, desired: "a completed tick",
        observed: activation === "stuck" ? "activating past its own start timeout" : "activating",
        detail: activation,
      });
    }
  }
  const timerRank = (kind: FleetSystemdItemKind): FleetStatusState => (
    kind === "property-malformed" ? "error"
      : kind === "tick-unknown" || kind === "schedule-unknown" || kind === "in-progress" ? "warn"
        : "fail"
  );
  let timerState: FleetStatusState = "pass";
  for (const item of timerItems) timerState = worseOf(timerState, timerRank(item.kind));
  const timer = {
    ...aspect(
      timerState, timerItems,
      timerRead !== "readable" ? timerRead : `${word(one(timerSample, "UnitFileState") ?? "absent")}/${word(one(timerSample, "ActiveState"))}/${word(one(timerSample, "SubState"))} tick ${tick}`,
      `enabled, active and waiting, paired with ${serviceUnit}, on the declared schedule, with a current tick`,
      timerItems.length === 0
        ? "the heartbeat timer is enabled, active, correctly paired, on policy and current"
        : `${timerItems.length} heartbeat-timer defect(s): an active timer proves nothing on its own`,
    ),
    view: unitView(timerUnit, timerSample),
    code: decisiveCode(timerItems, timerState, timerRank),
    paired, schedule, tick,
  };

  // -- the heartbeat oneshot -------------------------------------------------
  const serviceItems: FleetSystemdItem[] = [];
  const serviceRead = unitDefects(serviceUnit, serviceSample, serviceItems);
  const serviceExec = parseExecStart(one(serviceSample, "ExecStart"));
  const serviceEntrypoint = classifyEntrypoint(serviceExec.path, input.roleDir, manifest.entrypoint.launcher, input.hermesBin);
  const serviceResult = one(serviceSample, "Result") ?? null;
  const serviceStatus = numeric(serviceSample, "ExecMainStatus");
  let latestResult: FleetSystemdLatestResult = "unknown";
  const reconcile = readReconcile(ctx, input.roleDir);
  if (serviceRead === "readable") {
    if ((one(serviceSample, "Type") ?? "") !== "oneshot") {
      serviceItems.push({ path: serviceUnit, kind: "type-not-oneshot", desired: "oneshot", observed: word(one(serviceSample, "Type") ?? "absent"), detail: "type-not-oneshot" });
    }
    const start = parseSystemdUsec(one(serviceSample, "ExecMainStartTimestampMonotonic"));
    const exit = parseSystemdUsec(one(serviceSample, "ExecMainExitTimestampMonotonic"));
    if (activation !== null) {
      // Mid-tick: the BUCKET is reported here, the ITEM on the timer leaf.
      // systemd pre-initialises `Result=success` before the first exit, so an
      // activating oneshot is never read as a success -- and it has no
      // completed run for THIS leaf to fault either.
      latestResult = activation;
    } else if (serviceResult !== null && serviceResult !== "success") {
      latestResult = "failed";
      serviceItems.push({ path: serviceUnit, kind: "latest-result-failed", desired: "success", observed: word(serviceResult), detail: `latest-result-failed:${word(serviceResult)}` });
    } else if (serviceStatus !== undefined && Number.isNaN(serviceStatus)) {
      latestResult = "unknown";
      serviceItems.push({ path: serviceUnit, kind: "property-malformed", desired: "a whole number", observed: "unparsed", detail: "property-malformed:ExecMainStatus" });
    } else if (serviceStatus !== undefined && serviceStatus !== 0) {
      latestResult = "failed";
      serviceItems.push({ path: serviceUnit, kind: "latest-result-failed", desired: "0", observed: String(serviceStatus), detail: `latest-result-failed:exit-${serviceStatus}` });
    } else if (start === null || start === 0n) {
      latestResult = "never";
      serviceItems.push({ path: serviceUnit, kind: "never-completed", desired: "a completed tick since boot", observed: "never started", detail: "never-completed" });
    } else if (exit === null || exit < start) {
      latestResult = "never";
      serviceItems.push({ path: serviceUnit, kind: "never-completed", desired: "an exit at or after the last start", observed: "no exit recorded", detail: "never-completed" });
    } else if (serviceResult === null) {
      latestResult = "unknown";
      serviceItems.push({ path: serviceUnit, kind: "latest-result-unknown", desired: "success", observed: "no Result property", detail: "latest-result-unknown" });
    } else latestResult = "success";

    if (!serviceEntrypoint.pinned) {
      serviceItems.push({ path: serviceUnit, kind: "entrypoint-unpinned", desired: "the role launcher or the executable the row pins", observed: serviceEntrypoint.family, detail: "entrypoint-unpinned" });
    }
    if (reconcile.kind !== null) {
      serviceItems.push({
        path: manifest.heartbeat.reconcile_policy_file, kind: reconcile.kind,
        desired: "reconcile.enabled: true with a full-run state file, or an explicit opt-out",
        observed: `${reconcile.declared}/${reconcile.evidence}`, detail: reconcile.kind,
      });
    }
  }
  const serviceRank = (kind: FleetSystemdItemKind): FleetStatusState => (
    kind === "property-malformed" || kind === "policy-unreadable" || kind === "state-unreadable" ? "error"
      : kind === "reconcile-undeclared" || kind === "reconcile-opt-out-undeclared" || kind === "reconcile-unverifiable" || kind === "latest-result-unknown" ? "warn"
        : "fail"
  );
  let serviceState: FleetStatusState = "pass";
  for (const item of serviceItems) serviceState = worseOf(serviceState, serviceRank(item.kind));
  const service = {
    ...aspect(
      serviceState, serviceItems,
      serviceRead !== "readable" ? serviceRead : `${word(one(serviceSample, "ActiveState"))}/${word(one(serviceSample, "SubState"))} ${latestResult}`,
      "a oneshot whose latest invocation completed successfully, entered from the pinned entrypoint",
      serviceItems.length === 0
        ? "the heartbeat oneshot completed its latest tick successfully"
        : `${serviceItems.length} heartbeat-service defect(s): an active timer proves nothing without a successful tick`,
    ),
    view: unitView(serviceUnit, serviceSample),
    code: decisiveCode(serviceItems, serviceState, serviceRank),
    result: serviceResult === null ? null : word(serviceResult),
    execStatus: serviceStatus === undefined || Number.isNaN(serviceStatus) ? null : serviceStatus,
    entrypoint: serviceEntrypoint,
    latestResult,
    reconcile: { declared: reconcile.declared, evidence: reconcile.evidence },
  };

  return {
    agentId: input.agentId,
    topology,
    heartbeatTimerRow,
    capability: { declared: capability, platforms: declaredPlatforms, deltaDisabled: delta.enabled },
    gateway,
    timer,
    service,
  };
}

// ---------------------------------------------------------------------------
// Phase 6: the fleet-shared gateway and the unregistered sweep
// ---------------------------------------------------------------------------

function inspectShared(ctx: FleetSystemdContext, shared: Shared): FleetSystemdSharedRecord {
  const unit = ctx.sharedGateway.unit;
  const profile = ctx.sharedGateway.profile;
  const base = { unit, profile };
  if (!ctx.sweep) {
    return { ...base, state: "unobserved", code: "agent-scope", detail: "an --agent run never probes the fleet-shared gateway; its coverage is reported as unobserved rather than as an empty reading" };
  }
  if (shared.manager.code !== "available") {
    return { ...base, state: "error", code: shared.manager.code, detail: `the fleet-shared gateway could not be observed: ${shared.manager.detail}` };
  }
  if (unit === null) {
    return { ...base, state: "registry-undeclared", code: "contract-undeclared", detail: "the contract declares no service_model.fleet_shared.bloodbank_gateway_unit, so there is no shared gateway to correlate" };
  }
  if (ctx.sharedGateway.registryUnit === null) {
    return { ...base, state: "registry-undeclared", code: "registry-undeclared", detail: `the registry's gateways.bloodbank block names no systemd_unit; the contract derives ${unit}` };
  }
  if (ctx.sharedGateway.registryUnit !== unit) {
    return { ...base, state: "identity-mismatch", code: "identity-mismatch", detail: `the registry names ${unitWord(ctx.sharedGateway.registryUnit)} while the contract derives ${unit}; one shared gateway may not have two names` };
  }
  const samples = shared.window.samples.get(unit) ?? [];
  const sample = samples.length === 0 ? null : samples.filter((entry) => entry !== null).pop() ?? null;
  if (sample === null || one(sample, "LoadState") === "not-found") {
    return { ...base, state: "absent", code: "absent", detail: `${unit} is not loaded on this user manager; nothing owns Bloodbank command ingress fleet-wide` };
  }
  const stability = evaluateStability(samples);
  const unitFileState = one(sample, "UnitFileState") ?? "";
  const home = parseEnvironment(all(sample, "Environment"), [ctx.manifest.entrypoint.home_env])[ctx.manifest.entrypoint.home_env] ?? null;
  const expectedHome = profile !== null && ctx.profileRoot !== null && isSafePathSegment(profile) ? join(ctx.profileRoot, profile) : null;
  const homeState = classifyHome(home, expectedHome, resolve(ctx.fleetHome));
  const defects: string[] = [];
  if (!ENABLED_STATES.has(unitFileState)) defects.push("disabled");
  if (one(sample, "ActiveState") !== "active" || one(sample, "SubState") !== "running") defects.push("inactive");
  if (!stability.stable) defects.push(stability.crashLooping ? "crash-looping" : "unstable");
  if (homeState !== "matches") defects.push(`home-${homeState}`);
  if (defects.length === 0) {
    return { ...base, state: "healthy", code: null, detail: `${unit} is enabled, active, stable over the window and rooted at the declared shared profile` };
  }
  return { ...base, state: "drifted", code: defects[0]!, detail: `${unit} is the declared shared gateway but reads ${defects.join(", ")}` };
}

/** The contract entry, if any, that claims one unit by name. Every claim must declare `systemd` among its policy domains. */
function declaredUnitClaim(ctx: FleetSystemdContext, unit: string): { klass: FleetSystemdUnregisteredClass; detail: string } | null {
  for (const id of ["managed_shared_service", "intentionally_unmanaged"] as const) {
    const block = ctx.classifications?.[id];
    const entries = block && Array.isArray(block.entries) ? block.entries : [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const domains = Array.isArray(record.policy_domains) ? record.policy_domains : [];
      if (!domains.includes("systemd")) continue;
      const source = typeof record.source === "string" ? record.source : "";
      if (source === `units.${unit}` || source === unit || (source === "gateways.bloodbank" && ctx.sharedGateway.unit === unit)) {
        return { klass: "managed-exception", detail: `classifications.${id}.entries[${index}]` };
      }
    }
  }
  return null;
}

/**
 * Every `hermes-*` unit no registered row claims, in exactly one of five
 * classes, with bounded evidence and guidance.
 *
 * REPORTED AND LEFT ALONE. Nothing here assigns a unit to the nearest agent
 * name: `hermes-coachingagentframework-pm-gateway.service` looks exactly like a
 * registered agent's gateway and is not one, and guessing would hand a
 * convergence engine a row that does not exist. A transient scope's
 * `Description` may name a REGISTERED profile through an exact `--profile
 * <name>` token; that correlation is recorded and is still not an attribution.
 */
async function classifyUnregistered(ctx: FleetSystemdContext, shared: Shared, owned: ReadonlySet<string>): Promise<{
  record: FleetSystemdUnregisteredRecord;
  probe: FleetProbeRecord | null;
}> {
  const names = new Set<string>();
  for (const unit of shared.listing.units.keys()) if (!owned.has(unit)) names.add(unit);
  for (const unit of shared.listing.files.keys()) if (!owned.has(unit)) names.add(unit);
  const sorted = [...names].sort();
  const truncated = sorted.length > ctx.manifest.limits.max_unregistered_units;
  const kept = sorted.slice(0, ctx.manifest.limits.max_unregistered_units);
  if (kept.length === 0) return { record: { items: [], truncated }, probe: null };

  // ONE extra child for the whole set, and only when there is something to
  // classify: the listing carries neither `Environment` nor a scope's
  // `Description` in a shape this module will parse.
  const result = await probeText(ctx.run, SYSTEMCTL, systemctlArgv("show", ["-p", SYSTEMD_CLASSIFY_PROPERTIES.join(","), ...kept]), {
    env: systemctlEnv(ctx), timeoutMs: ctx.manifest.probe.timeout_ms, keepStdoutOnFailure: true,
  });
  throwIfCancelled(ctx.run);
  const probe: FleetProbeRecord = {
    id: `${SYSTEMD_PROBE_KIND}:show:unregistered`, kind: SYSTEMD_PROBE_KIND,
    target: `${kept.length} unregistered unit(s)`,
    outcome: result.outcome,
    reason: result.outcome === "ok" ? null : result.outcome === "timeout" ? "show-timeout" : "show-failed",
  };
  const shown = result.outcome === "ok" ? parseShowBlocks(result.value ?? "") : new Map<string, Map<string, string[]>>();
  const registeredProfiles = new Set(ctx.registeredProfileNames);
  const retiredPatterns = ctx.retired.flatMap((mode) => mode.detect.map((pattern) => ({ id: mode.id, pattern })));

  const items: FleetStatusSystemdUnregisteredItem[] = kept.map((unit) => {
    const sample = shown.get(unit) ?? null;
    const listed = shared.listing.units.get(unit);
    const fileState = shared.listing.files.get(unit) ?? (sample === null ? null : one(sample, "UnitFileState") || null);
    const view: FleetStatusSystemdUnitView = {
      unit,
      load: listed?.load ?? (sample === null ? null : word(one(sample, "LoadState"))),
      unit_file: fileState === null ? null : word(fileState),
      active: listed?.active ?? (sample === null ? null : word(one(sample, "ActiveState"))),
      sub: listed?.sub ?? (sample === null ? null : word(one(sample, "SubState"))),
    };

    const claim = declaredUnitClaim(ctx, unit);
    if (claim !== null) {
      return { ...view, class: claim.klass, correlated_profile: null, process_reference: "unobserved", guidance: "exception", detail: claim.detail };
    }
    // A transient scope: a `systemd-run` wrapper around a live call. Its COUNT
    // is ephemeral by construction and is never asserted; only its class is.
    if (fileState === "transient" || unit.endsWith(".scope")) {
      const description = listed?.description ?? one(sample, "Description") ?? "";
      const hit = PROFILE_TOKEN.exec(description);
      const correlated = hit !== null && registeredProfiles.has(hit[1]!) ? hit[1]! : null;
      return { ...view, class: "transient", correlated_profile: correlated, process_reference: "unobserved", guidance: "manual-review", detail: "unit-file-state:transient" };
    }
    // A retired shape: the contract's own `retired[].detect` patterns, or a
    // per-agent retired candidate name with any id substituted.
    const retiredHit = retiredPatterns.find(({ pattern }) => {
      try { return new RegExp(pattern, "u").test(unit); } catch { return false; }
    });
    if (retiredHit !== undefined) {
      return { ...view, class: "retired", correlated_profile: null, process_reference: "unobserved", guidance: "retirement", detail: `retired:${word(retiredHit.id)}` };
    }
    // A profile correlation: the unit's own `HERMES_HOME` names a directory
    // under the profile root. The DIRECTORY, never a name similarity.
    const home = parseEnvironment(all(sample, "Environment"), [ctx.manifest.entrypoint.home_env])[ctx.manifest.entrypoint.home_env] ?? null;
    if (home !== null && ctx.profileRoot !== null) {
      const resolved = resolve(home);
      const root = resolve(ctx.profileRoot);
      if (resolved !== root && within(root, resolved)) {
        const name = resolved.slice(root.length + 1).split(sep)[0] ?? "";
        return {
          ...view, class: "profile-correlated",
          correlated_profile: SAFE_SEGMENT.test(name) ? name : null,
          process_reference: "unobserved", guidance: registeredProfiles.has(name) ? "manual-review" : "adoption",
          detail: "hermes-home-under-profile-root",
        };
      }
    }
    return { ...view, class: "unclassified", correlated_profile: null, process_reference: "unobserved", guidance: "manual-review", detail: null };
  });

  return { record: { items, truncated }, probe };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Sample the user manager once for the whole fleet, prove every selected
 * agent's canonical unit set against the state its registry row DECLARES, and
 * -- in fleet scope -- correlate the shared gateway and classify every
 * unregistered `hermes-*` unit. The entry point `status.ts` calls.
 */
export async function collectSystemdHealth(ctx: FleetSystemdContext): Promise<FleetSystemdHealth> {
  throwIfCancelled(ctx.run);
  const probes: FleetProbeRecord[] = [];
  const window = { samples: ctx.manifest.stabilization.samples, interval_ms: ctx.manifest.stabilization.interval_ms };

  const manager = await probeManager(ctx);
  probes.push(manager.probe);

  // A failed manager probe skips sampling ENTIRELY: there is nothing to ask,
  // and asking anyway would spend the run's budget on children that cannot
  // answer while reporting the same thing at the end.
  const available = manager.record.code === "available";
  const listing = available && ctx.sweep ? await listFleet(ctx) : emptyListing();
  probes.push(...listing.probes);

  // -- Phase 3: the universe of interest (see the Phase 4 header) ------------
  const perAgent = ctx.serviceModel?.per_agent ?? {};
  const interest = new Set<string>();
  const owned = new Set<string>();
  for (const agent of ctx.agents) {
    for (const pattern of [perAgent.gateway_unit, perAgent.heartbeat_timer, perAgent.heartbeat_service]) {
      const unit = derive(pattern, agent.agentId);
      if (unit !== null) { interest.add(unit); owned.add(unit); }
    }
    for (const pattern of ctx.manifest.unregistered.retired_candidates) {
      const unit = derive(pattern, agent.agentId);
      if (unit !== null) { interest.add(unit); owned.add(unit); }
    }
    for (const stored of [agent.storedGatewayUnit, agent.storedHeartbeatTimer]) {
      if (stored !== null && stored !== "" && UNIT_NAME.test(stored)) { interest.add(stored); owned.add(stored); }
    }
  }
  // Every REGISTERED agent's canonical names are owned even when this run did
  // not select them: an `--agent` run must not report another agent's gateway
  // as an unregistered unit, and a fleet-scope sweep must not either.
  for (const agentId of ctx.registeredAgentIds) {
    for (const pattern of [perAgent.gateway_unit, perAgent.heartbeat_timer, perAgent.heartbeat_service]) {
      const unit = derive(pattern, agentId);
      if (unit !== null) owned.add(unit);
    }
    for (const pattern of ctx.manifest.unregistered.retired_candidates) {
      const unit = derive(pattern, agentId);
      if (unit !== null) owned.add(unit);
    }
  }
  if (ctx.sweep && ctx.sharedGateway.unit !== null) { interest.add(ctx.sharedGateway.unit); owned.add(ctx.sharedGateway.unit); }
  else if (ctx.sharedGateway.unit !== null) owned.add(ctx.sharedGateway.unit);

  const unitsOfInterest = [...interest].sort();
  const sampled = available ? await sampleWindow(ctx, unitsOfInterest) : { samples: new Map<string, Sample[]>(), taken: 0, probes: [], error: "manager-unavailable" };
  probes.push(...sampled.probes);

  // The user unit load path: the two home-relative directories systemd reads
  // (`$XDG_CONFIG_HOME/systemd/user` for an operator's own units,
  // `$XDG_DATA_HOME/systemd/user` for a package's or a `systemctl --user link`)
  // plus the system-wide ones. `$XDG_DATA_HOME` is resolved the way every
  // other consumer in this build resolves it, so an operator who moved it does
  // not read `fragment-unsafe` for units systemd itself loaded.
  const dataHome = ctx.env.XDG_DATA_HOME && ctx.env.XDG_DATA_HOME.trim() !== ""
    ? ctx.env.XDG_DATA_HOME
    : join(ctx.home, ".local", "share");
  const runtimeDir = ctx.env.XDG_RUNTIME_DIR && ctx.env.XDG_RUNTIME_DIR.trim() !== "" ? ctx.env.XDG_RUNTIME_DIR : null;
  const unitDirs = [
    join(ctx.configHome, "systemd", "user"),
    join(ctx.configHome, "systemd", "user.control"),
    join(dataHome, "systemd", "user"),
    ...(runtimeDir === null ? [] : SYSTEMD_RUNTIME_UNIT_SUBDIRS.map((name) => join(runtimeDir, "systemd", name))),
    ...SYSTEMD_SYSTEM_UNIT_DIRS,
  ].map((dir) => resolve(dir));
  const shared: Shared = {
    manager: manager.record,
    window: sampled,
    listing,
    unitDirs,
    // ONE read for the whole fleet: the base is one file every profile's delta
    // is merged over, so reading it per agent would be the same bytes 28 times.
    baseEnabled: readBaseEnablement(ctx, ctx.manifest.messaging.platforms),
  };

  const results = await mapBounded(ctx.agents, FLEET_STATUS_SYSTEMD_CONCURRENCY, async (input) => {
    throwIfCancelled(ctx.run);
    return inspectAgent(ctx, shared, input);
  });
  const agents = new Map<string, FleetSystemdAgentResult>();
  for (const result of results) agents.set(result.agentId, result);

  const sharedRecord = inspectShared(ctx, shared);

  let unregistered: FleetSystemdUnregisteredRecord | null = null;
  let unregisteredReason: string | null = null;
  if (!ctx.sweep) unregisteredReason = "agent-scope";
  else if (!available) unregisteredReason = manager.record.code;
  else if (listing.error !== null) unregisteredReason = listing.error;
  else {
    const swept = await classifyUnregistered(ctx, shared, owned);
    unregistered = swept.record;
    if (swept.probe !== null) probes.push(swept.probe);
  }

  // Deduped by id and stably sorted: two runs over unchanged state must emit
  // byte-identical probe records, and completion order is never a sort key.
  const seen = new Set<string>();
  const deduped = probes.filter((record) => (seen.has(record.id) ? false : (seen.add(record.id), true)));
  deduped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    manager: manager.record,
    window,
    listingTruncated: listing.truncated,
    units: {
      listed: listing.units.size,
      unit_files: listing.files.size,
      transient: [...listing.files.values()].filter((state) => state === "transient").length,
    },
    agents,
    shared: sharedRecord,
    unregistered,
    unregisteredReason,
    probes: deduped,
  };
}
