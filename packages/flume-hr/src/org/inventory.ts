// Registry-wide, strictly read-only fleet inventory.
//
// The question this module answers is the one nothing in the repo could answer
// before it: "what is the whole fleet, and where does it disagree with itself?"
//
// Three disciplines make that answerable rather than merely printable:
//
//   * TOLERANT PARSING. `loadProjectRegistry` throws on exactly the duplicates
//     this command exists to REPORT (slug, repo_path, board_id, identifier),
//     and `readHermesAgentBoards` throws raw ENOENT on a missing file. Neither
//     can be reused. Both stores are parsed here with per-record salvage, so one
//     bad row is one finding rather than a run that produced nothing.
//   * INDEPENDENT COUNTING. `totals.source_rows` is counted from the raw
//     `agents:` mapping keys in its own pass before any row is built, so a bug
//     in the row builder shows up as `source_rows != emitted_rows` rather than
//     as an agent that quietly vanished.
//   * DECLARED PROVENANCE. Every emitted value carries the authority `owner`
//     the CONTRACT declares for its field path. Nothing here invents an owner;
//     a field path the contract does not cover reports `source: null` and says
//     so in a finding.
//
// Read-only is not a convention here, it is the contract: no registry, manifest,
// profile, repo, service, or network write, and no directory, project, role,
// profile, or registry row is ever created. Paths are classified with `lstat`
// and never followed for mutation -- a symlink is reported as a symlink with its
// target as evidence, never silently retargeted.
//
// What this module deliberately does NOT do: probe systemd, probe a process,
// probe Bloodbank, or reach the network. Expected unit names are expectations
// (state `unobserved`); the Bloodbank block is the STORED routing record. Those
// observations are stories 1.3-1.10.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import YAML from "yaml";
import { isRegistryServiceLocation, registryRequest, resolveRegistryLocation } from "../kernel/registryClient";
import { loadFleetContract, resolveFleetContractPath, validateFleetContract } from "./contract";
import { bounded, redactHome } from "./output";
import { throwIfCancelled, remainingMs, type FleetRunContext } from "./runtime";
import {
  FLEET_INVENTORY_MAX_ROWS,
  FleetError,
  type FleetBoardBinding,
  type FleetConflictGroup,
  type FleetClassificationId,
  type FleetContract,
  type FleetFieldState,
  type FleetFieldValue,
  type FleetInventory,
  type FleetInventoryFinding,
  type FleetInventoryHealth,
  type FleetInventoryRow,
  type FleetInventoryScope,
  type FleetInventoryTotals,
  type FleetManifestEvidence,
  type FleetPathClassification,
  type FleetPathView,
  type FleetStoreView,
} from "./types";

/** A registry larger than this is not a fleet registry; it is an accident. */
const REGISTRY_MAX_BYTES = 16 * 1024 * 1024;

/** Cap on findings carried in one envelope, so a broken fleet stays one document. */
const MAX_FINDINGS = 2000;

/** Cap on conflict groups carried in one envelope. */
const MAX_CONFLICT_GROUPS = 500;

/** Cap on manifest notes carried on one row; a clip is recorded, never silent. */
const MAX_MANIFEST_NOTES = 10;

/** Manifest read cap. `.project.json` is a small binding file, not a data store. */
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The role-local runtime directory name.
 *
 * Not contract-derived, and not pretending to be: `join(role_dir, "runtime")` is
 * the tracked template's convention (`src/parity/rules.ts` `singletonPlan`), and
 * the contract deliberately declares role-local runtime bytes as owned by
 * nobody. The unit-name patterns, the profile-layout root, and the activation
 * field ARE contract-derived and are read from the contract below.
 */
const ROLE_RUNTIME_DIRNAME = "runtime";

/**
 * Findings that describe a row's SHAPE rather than a contract breach.
 *
 * `malformed_rows` already counts each of these rows exactly once; counting the
 * findings too would book one bad row two or three times against
 * `health.contract_violations`. `identity-conflict` is here for the same reason:
 * `health.conflicts` is its counter.
 */
const ROW_INTEGRITY_CODES = new Set([
  "identity-conflict",
  "agent-row-malformed",
  "agent-id-not-a-string",
]);

/**
 * Row-SHAPE codes, excluded only for a row already counted in `malformed_rows`.
 *
 * `agent-id-unsafe` cannot join `ROW_INTEGRITY_CODES` outright: on a WELL-FORMED
 * row (a real mapping under a string key that simply is not a safe path
 * segment) nothing else counts it, and dropping it there would let an unsafe id
 * ride at `healthy: true`. But on a row that is ALSO malformed it is the second
 * booking of one defect -- measured: a clean fleet reports 0 violations, the
 * same fleet plus `1234: [not-a-mapping]` reports 0, and plus
 * `"../escape": [not-a-mapping]` reports 1 while `malformed_rows` already says
 * 1. That is the leak the previous pass's own entry named and its replacement
 * set did not close.
 */
const ROW_SHAPE_CODES = new Set(["agent-id-unsafe"]);

/**
 * Finding code -> the parity rule that can repair it.
 *
 * This module raises BARE CODES: a `note()` call carries a code, a field path,
 * an owner and a sentence, and nothing that says what to do about it. That is
 * why thirty-six roster findings arrived with `rule_id: null`, fell through
 * every branch of `deriveRepair` in `org/health.ts`, and were reported as
 * "manual" -- an operator was handed a list of problems and no command.
 *
 * The table is the seam. `src/parity/reconcile.ts` declares one check per rule
 * id here and owns what the repair actually does; `org/status.ts` reads it to
 * hand an inventory observation the rule that REPAIRS it (beside its identity,
 * never inside it -- see `ObservationInput.repairRule`); and the hint below puts
 * the read-only planning command in the finding an operator is looking at.
 *
 * NOTHING HERE WRITES. The module header's guarantee -- no registry, manifest,
 * profile, repo, service or network write -- is why `roster` is safe to run
 * anywhere, and a lookup table plus a string suffix does not touch it. The rule
 * ids are declared here rather than imported so that the read-only inventory
 * never depends on the module that performs the writes.
 */
export const FINDING_RULE_IDS: Readonly<Record<string, string>> = Object.freeze({
  "manifest-disagrees": "org.board-projection",
  "profile-path-symlinked": "org.profile-path",
  "profile-path-unusable": "org.profile-path",
  "runtime-path-unusable": "org.runtime-path",
  "role-dir-unusable": "org.runtime-path",
  "project-record-missing": "org.project-records",
  "identity-conflict": "org.identity-conflict",
  "project-registry-duplicate": "org.identity-conflict",
});

/** The rule that answers for a finding code, or null where none does yet. */
export function ruleIdForFindingCode(code: string): string | null {
  return FINDING_RULE_IDS[code] ?? null;
}

/**
 * The registry schema this reader models.
 *
 * Both live stores declare `schema_version: 1`. The field was already parsed and
 * then never consulted, so a v2 registry would have been read, keyed, and
 * reported as if it were v1 -- confidently wrong about a shape nobody here has
 * seen.
 */
const SUPPORTED_REGISTRY_SCHEMA = 1;

/** Store ids, used as stable keys in `data.stores` and in finding details. */
const AGENT_STORE = "agent-registry";
const PROJECT_STORE = "pjangler-project-registry";

export interface FleetInventoryOptions {
  /** Report only this agent. Totals still describe the whole registered fleet. */
  agentId?: string;
  /** Inspect this project registry instead of the configured one. Never rewrites the configured path. */
  projectRegistry?: string;
  /** Inspect this agent registry instead of the configured one. */
  agentRegistry?: string;
  /** Validate and read this contract instead of the tracked one. */
  contract?: string;
  /**
   * The run's cancellation and deadline budget.
   *
   * Threaded rather than owned so `fleet inventory` and `fleet provenance`
   * honour the SAME inputs: an MCP client that aborts a request, or a CLI caller
   * that hits ctrl-C, must stop both commands the same way. Omitted, the
   * inventory behaves exactly as it did before -- there is no implicit deadline.
   */
  runContext?: FleetRunContext;
  /**
   * Carry at most this many rows. Defaults to `FLEET_INVENTORY_MAX_ROWS`.
   *
   * Only the status core passes it, and it passes `Infinity`: status DERIVES a
   * fleet verdict from these rows, so a bound on what the inventory CARRIES
   * would move what status CONCLUDES. Measured on a 1021-row registry whose only
   * malformed row sorted last: `health.healthy` true, `failed` 0,
   * `domains[registry].state` "pass" -- and `--agent zzzz-broken` answered
   * `NOT_FOUND` while `totals.agents` counted it. `fleet inventory` never passes
   * this, so its own payload is unchanged.
   */
  rowCap?: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mirrors the unexported `expandHome` in `src/project/index.ts`. */
function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** A path as an operator may see it: bounded, and with their home collapsed to `~`. */
function shownPath(path: string): string {
  return bounded(redactHome(path));
}

function field<T>(value: T | null, source: string | null, state: FleetFieldState): FleetFieldValue<T> {
  return { value, source, state };
}

/** An absent value is explicitly null and explicitly unresolved. Never inferred. */
function unresolved<T>(source: string | null): FleetFieldValue<T> {
  return { value: null, source, state: "unresolved" };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// ---------------------------------------------------------------------------
// Contract-derived authority attribution
// ---------------------------------------------------------------------------

/** Collapse every `{placeholder}` so a declared path and a query path compare. */
function normalizeFieldPath(path: string): string {
  return path.replace(/\{[^}]*\}/gu, "{}");
}

export interface FleetAuthorityIndex {
  /** The declared owner of a field path, or null when the contract declares none. */
  ownerOf(fieldPath: string): string | null;
  /** Every declared field path, normalized, mapped to its owner. */
  declared: ReadonlyMap<string, string>;
}

/**
 * Index every `writable_fields` entry the contract declares, by owner.
 *
 * `validateFleetContract` has already refused any field path claimed writable by
 * two authorities, so one normalized path maps to at most one owner and this
 * index cannot be the place a dual claim gets silently resolved.
 *
 * The namespace fallback exists for two real query paths -- `agents.{agent_id}`
 * (the row key itself) and `profiles.{profile_name}` (the profile directory) --
 * neither of which is a leaf the contract declares. It answers with the MODAL
 * owner of everything declared beneath the namespace: the authority that owns
 * most of a namespace is the authority that put the row there. A tie answers
 * null rather than picking, because picking would be inventing.
 */
export function buildAuthorityIndex(contract: FleetContract): FleetAuthorityIndex {
  const declared = new Map<string, string>();
  for (const authority of Object.values(contract.authorities)) {
    for (const path of authority.writable_fields ?? []) {
      if (typeof path !== "string" || !path) continue;
      declared.set(normalizeFieldPath(path), authority.owner);
    }
  }
  const cache = new Map<string, string | null>();
  const ownerOf = (fieldPath: string): string | null => {
    const key = normalizeFieldPath(fieldPath);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let answer = declared.get(key) ?? null;
    if (answer === null) {
      const tally = new Map<string, number>();
      for (const [path, owner] of declared) {
        if (!path.startsWith(`${key}.`)) continue;
        tally.set(owner, (tally.get(owner) ?? 0) + 1);
      }
      const ranked = [...tally].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
      const top = ranked[0];
      const runnerUp = ranked[1];
      answer = top && (!runnerUp || runnerUp[1] < top[1]) ? top[0] : null;
    }
    cache.set(key, answer);
    return answer;
  };
  return { ownerOf, declared };
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

export interface ClassifyPathOptions {
  /** Containment root. Compared LEXICALLY -- resolving it would follow the link. */
  root?: string | null;
  /** Whether the referent is expected to be a directory. */
  directory?: boolean;
}

/**
 * What a declared path IS. `lstat` first, always; the link is never followed.
 *
 * `resolveContainedPath` in `src/project/index.ts` is realpath-based and THROWS,
 * which makes it a mutation guard rather than a classifier -- and realpath is
 * exactly the wrong tool here, because it resolves away the symlink this command
 * has to report. Containment is therefore lexical: a link out of the profile
 * root is `symlink` (with its target as evidence), and a declared path that is
 * literally outside the root is `outside-root`.
 */
export function classifyPath(raw: unknown, options: ClassifyPathOptions = {}): FleetPathView {
  const value = nonEmptyString(raw);
  if (value === null) return { declared: null, classification: "undeclared", link_target: null };
  const declared = shownPath(value);
  if (!isAbsolute(value)) return { declared, classification: "relative", link_target: null };
  const root = options.root ? resolve(options.root) : null;
  if (root) {
    const inside = relative(root, resolve(value));
    if (inside === "" || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) {
      return { declared, classification: "outside-root", link_target: null };
    }
  }
  let stat;
  try {
    stat = lstatSync(value);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { declared, classification: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable", link_target: null };
  }
  if (stat.isSymbolicLink()) {
    let target: string | null = null;
    try { target = shownPath(readlinkSync(value)); } catch { target = null; }
    return { declared, classification: "symlink", link_target: target };
  }
  if (options.directory && !stat.isDirectory()) return { declared, classification: "not-a-directory", link_target: null };
  return { declared, classification: "ok", link_target: null };
}

// ---------------------------------------------------------------------------
// Tolerant store reads
// ---------------------------------------------------------------------------

interface RawEntry {
  /** The mapping key exactly as written, bounded. Never inferred from a basename. */
  key: string;
  keyIsString: boolean;
  value: unknown;
  /** True when the entry is not a mapping, or could not be materialised. */
  malformed: boolean;
}

interface RawStore {
  path: string;
  exists: boolean;
  parse: "ok" | "salvaged" | "unreadable";
  /**
   * Whether the keyed collection is there at all.
   *
   * A file that parses but carries no `agents:` mapping is not an empty fleet;
   * it is a file this command could not read. Reported so it cannot be mistaken
   * for a healthy zero.
   */
  collection: "ok" | "missing" | "not-a-mapping";
  /** Counted in its own pass over the raw mapping keys, before any row is built. */
  sourceRows: number;
  /**
   * Whether `sourceRows` really came from the separate parse.
   *
   * `counted ?? items.length` is a necessary fallback, but silently taking it
   * turns the advertised `source_rows != emitted_rows` invariant back into the
   * tautology the separate parse exists to break. Recorded so the fallback is
   * reportable rather than invisible.
   */
  countIndependent: boolean;
  entries: RawEntry[];
  /** Keys written more than once in the source document. */
  duplicateKeys: string[];
  schemaVersion: number | null;
  top: Record<string, unknown>;
  /**
   * Sibling top-level blocks a caller asked for beside the keyed collection,
   * materialised from the SAME parse. The profile observer reads
   * `gateways.bloodbank.profile_name` this way rather than opening the
   * registry a second time.
   */
  siblings: Record<string, unknown>;
}

function readYamlDocument(path: string, label: string): { document: YAML.Document.Parsed; text: string } {
  if (!existsSync(path)) {
    throw new FleetError("NOT_FOUND", `${label} not found`, false, { path: shownPath(path) });
  }
  const stat = statSync(path);
  if (!stat.isFile()) throw new FleetError("INVALID_INPUT", `${label} is not a regular file`, false, { path: shownPath(path) });
  if (stat.size > REGISTRY_MAX_BYTES) {
    throw new FleetError("INVALID_INPUT", `${label} exceeds ${REGISTRY_MAX_BYTES} bytes`, false, { path: shownPath(path) });
  }
  // `uniqueKeys: false` is the whole reason a duplicate agent id is reportable.
  // The parser's default turns one into a DUPLICATE_KEY error and the run dies
  // on the exact drift AC5 requires this command to name; here both entries
  // survive as separate items and become a conflict group.
  const text = readFileSync(path, "utf8");
  const document = YAML.parseDocument(text, { uniqueKeys: false });
  if (document.errors.length) {
    const first = document.errors[0]!;
    const at = first.linePos?.[0];
    // The parser's message quotes source fragments. Only its stable code and
    // position cross the boundary.
    throw new FleetError(
      "INVALID_INPUT",
      `${label} could not be parsed (${first.code})${at ? ` at line ${at.line} column ${at.col}` : ""}`,
      false,
      { path: shownPath(path) },
    );
  }
  return { document, text };
}

/**
 * Count the collection's raw keys from a SEPARATE parse of the same bytes.
 *
 * Independence is the whole point. Counting `items.length` on the very array the
 * row builder then walks cannot disagree with it no matter what breaks -- the
 * invariant reads as a check and is a tautology. This re-parses and reaches the
 * node by a different route (scan the document's own root pairs, rather than
 * `document.get`), so a defect in the reader's node extraction -- the wrong
 * collection name, a shape guard that silently yields `[]` -- shows up as
 * `source_rows != emitted_rows` instead of a fleet quietly reporting zero.
 *
 * `uniqueKeys: false` for the same reason the reader uses it: a duplicate agent
 * id is two raw keys, and this count must say two.
 */
function countCollectionRows(text: string, collection: string): number | null {
  try {
    const document = YAML.parseDocument(text, { uniqueKeys: false });
    const contents = document.contents as unknown as { items?: unknown } | null;
    const pairs = contents && Array.isArray(contents.items)
      ? (contents.items as Array<{ key?: { value?: unknown }; value?: { items?: unknown } }>)
      : [];
    for (const pair of pairs) {
      if (pair?.key?.value !== collection) continue;
      return Array.isArray(pair.value?.items) ? (pair.value!.items as unknown[]).length : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read one keyed store tolerantly.
 *
 * The count and the entries come from two independent parses on purpose; see
 * `countCollectionRows`.
 */
function readKeyedStore(path: string, label: string, collection: string, siblingKeys: readonly string[] = []): RawStore {
  // The guards inside `readYamlDocument` -- existence, regular file, size cap --
  // must run BEFORE any read, so the text comes back out of it rather than being
  // read ahead of it. Reading first turned a missing registry into a raw ENOENT,
  // and NOT_FOUND/exit 3 into INTERNAL_ERROR/exit 6.
  const { document, text } = readYamlDocument(path, label);
  const node = document.get(collection, true) as unknown;
  const nodeIsMapping = Boolean(node) && typeof node === "object" && Array.isArray((node as { items?: unknown }).items);
  const items = nodeIsMapping
    ? ((node as { items: Array<{ key?: { value?: unknown }; value?: { toJSON?: () => unknown } | null }> }).items)
    : [];
  const collectionState: RawStore["collection"] = nodeIsMapping
    ? "ok"
    : node === undefined || node === null
      ? "missing"
      : "not-a-mapping";

  // Pass 1: count, from its own parse.
  const counted = countCollectionRows(text, collection);
  const sourceRows = counted ?? items.length;
  const countIndependent = counted !== null;

  // Pass 2: build.
  const entries: RawEntry[] = [];
  const seen = new Map<string, number>();
  let salvaged = false;
  for (const item of items) {
    const rawKey = item?.key?.value;
    const keyIsString = typeof rawKey === "string" && rawKey.length > 0;
    const key = bounded(keyIsString ? (rawKey as string) : String(rawKey ?? ""), 128);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    let value: unknown = null;
    let malformed = false;
    try {
      value = typeof item?.value?.toJSON === "function" ? item.value.toJSON() : null;
    } catch {
      value = null;
      malformed = true;
    }
    if (!isRecord(value)) malformed = true;
    if (malformed || !keyIsString) salvaged = true;
    entries.push({ key, keyIsString, value, malformed });
  }

  let top: Record<string, unknown> = {};
  let schemaVersion: number | null = null;
  const siblings: Record<string, unknown> = {};
  try {
    const tree = document.toJS() as unknown;
    if (isRecord(tree)) {
      top = tree;
      schemaVersion = typeof tree.schema_version === "number" ? tree.schema_version : null;
      for (const key of siblingKeys) if (Object.prototype.hasOwnProperty.call(tree, key)) siblings[key] = tree[key];
    }
  } catch {
    // An alias bomb materialises only here. The per-entry salvage above already
    // has everything the rows need, so this is a degraded read, not a dead run.
    salvaged = true;
  }

  return {
    path,
    exists: true,
    parse: salvaged ? "salvaged" : "ok",
    collection: collectionState,
    sourceRows,
    countIndependent,
    entries,
    duplicateKeys: [...seen].filter(([, count]) => count > 1).map(([key]) => key).sort((a, b) => (a < b ? -1 : 1)),
    schemaVersion,
    top,
    siblings,
  };
}

/** The agent rows, plus the fleet-shared `gateways` block from the same parse. */
export function readAgentRegistryRaw(path: string): RawStore {
  return readKeyedStore(path, "Hermes agent registry", "agents", ["gateways"]);
}

export function readProjectRegistryRaw(path: string): RawStore {
  if (!isRegistryServiceLocation(path)) return readKeyedStore(path, "PJangler project registry", "projects");
  let registry;
  try {
    registry = registryRequest<Record<string, unknown>>(path, "GET", "/v1/registry");
    if (!isRecord(registry)) throw new Error("Expected a registry object");
  } catch (error) {
    throw new FleetError("INTERNAL_ERROR", `Project registry service could not be read: ${error instanceof Error ? error.message : String(error)}`, true, { path });
  }
  // Count the returned map before projecting its records into inventory rows.
  const projects = isRecord(registry.projects) ? registry.projects : {};
  const sourceRows = Object.keys(projects).length;
  const entries: RawEntry[] = Object.entries(projects).map(([key, value]) => ({
    key, keyIsString: true, value, malformed: !isRecord(value),
  }));
  return {
    path, exists: true, parse: entries.some((entry) => entry.malformed) ? "salvaged" : "ok",
    collection: isRecord(registry.projects) ? "ok" : registry.projects === undefined ? "missing" : "not-a-mapping", sourceRows,
    countIndependent: true, entries, duplicateKeys: [],
    schemaVersion: typeof registry.schema_version === "number" ? registry.schema_version : null, top: registry, siblings: {},
  };
}

// ---------------------------------------------------------------------------
// Store resolution
// ---------------------------------------------------------------------------

export interface ResolvedStore {
  id: string;
  /** The canonical path, whatever an override said. */
  configuredPath: string;
  /** The path that will actually be opened. */
  inspectedPath: string;
  overridden: boolean;
  envKeys: string[];
}

export interface ResolvedStores {
  agents: ResolvedStore;
  projects: ResolvedStore;
  /** Raised when the two Hermes registry env keys do not name the same file. */
  disagreement: string | null;
}

/**
 * Where the two canonical registries live, and where this run will look.
 *
 * `configured_path` never moves: an override says which bytes to read, not which
 * file is canonical, and reporting the override as the configured path would
 * make an inventory of a scratch copy indistinguishable from an inventory of the
 * fleet.
 *
 * `HERMES_FLEET_REGISTRY_FILE` has zero TypeScript references today -- it is the
 * shell provisioner's key, and the contract records both because they disagree.
 * It is honoured here as a FALLBACK only, and a disagreement is reported rather
 * than resolved: converging the two writers is not this command's business.
 */
export function resolveInventoryStores(options: FleetInventoryOptions = {}): ResolvedStores {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  const agentsKey = env.HERMES_AGENTS_REGISTRY?.trim() ?? "";
  const fleetKey = env.HERMES_FLEET_REGISTRY_FILE?.trim() ?? "";
  const agentsDefault = join(home, ".hermes", "agents-registry.yaml");
  const agentsConfigured = resolve(expandHome(agentsKey || fleetKey || agentsDefault, home));

  let disagreement: string | null = null;
  if (agentsKey && fleetKey && resolve(expandHome(agentsKey, home)) !== resolve(expandHome(fleetKey, home))) {
    disagreement = "HERMES_AGENTS_REGISTRY and HERMES_FLEET_REGISTRY_FILE name different files";
  } else if (!agentsKey && fleetKey && resolve(expandHome(fleetKey, home)) !== resolve(agentsDefault)) {
    disagreement = "HERMES_FLEET_REGISTRY_FILE is set but HERMES_AGENTS_REGISTRY is not; the TypeScript reader would use the default path";
  }

  const projectsKey = env.PJ_PROJECT_REGISTRY?.trim() ?? "";
  const projectsConfigured = resolveRegistryLocation(projectsKey ? expandHome(projectsKey, home) : undefined, env);

  // The CLI guards these, but `collectFleetInventory` is exported and barrelled.
  // Reached directly, a whitespace-only override used to fall through to the
  // canonical store and then report `overridden: false` about it -- an inventory
  // of the real fleet returned to a caller who asked for a copy.
  for (const [value, name] of [[options.agentRegistry, "agentRegistry"], [options.projectRegistry, "projectRegistry"]] as const) {
    if (value !== undefined && value.trim() === "") {
      throw new FleetError("INVALID_INPUT", `${name} was given an empty value`, false);
    }
  }
  const agentOverride = options.agentRegistry?.trim();
  const projectOverride = options.projectRegistry?.trim();

  return {
    agents: {
      id: AGENT_STORE,
      configuredPath: agentsConfigured,
      inspectedPath: agentOverride ? resolve(expandHome(agentOverride, home)) : agentsConfigured,
      overridden: Boolean(agentOverride),
      envKeys: ["HERMES_AGENTS_REGISTRY", "HERMES_FLEET_REGISTRY_FILE"],
    },
    projects: {
      id: PROJECT_STORE,
      configuredPath: projectsConfigured,
      inspectedPath: projectOverride ? resolveRegistryLocation(expandHome(projectOverride, home), env) : projectsConfigured,
      overridden: Boolean(projectOverride),
      envKeys: ["PJ_REGISTRY_URL", "PJ_PROJECT_REGISTRY"],
    },
    disagreement,
  };
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

/**
 * The exported `validateSafePathSegment` throws; a classifier must not.
 *
 * Same rule, same regex, asked as a question. Nothing derived from a registry
 * value becomes a unit name or a directory segment without passing it.
 */
export function isSafePathSegment(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.trim() !== value || !value) return false;
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) return false;
  if (isAbsolute(value)) return false;
  return SAFE_PATH_SEGMENT.test(value);
}

interface ProjectIndexEntry {
  slug: string;
  key: string;
  repoPath: string | null;
  identifier: string | null;
  boardId: string | null;
  workspace: string | null;
  /** `type/workspace`, the scope the project registry's own uniqueness rules use. */
  providerScope: string;
}

interface InventoryContext {
  contract: FleetContract;
  authority: FleetAuthorityIndex;
  /** `service_model.profile_layout.root` with `{HERMES_FLEET_HOME}` substituted. */
  profileRoot: string | null;
  profilePathTemplate: string | null;
  /** `service_model.per_agent` patterns, in declared key order. */
  unitPatterns: string[];
  /** `service_model.per_agent.gateway_unit` alone, for the drift comparison. */
  gatewayPattern: string | null;
  activationField: string;
  activationOwner: string | null;
  projectsByRepoPath: Map<string, ProjectIndexEntry>;
  projectsBySlug: Map<string, ProjectIndexEntry>;
  /** The home this run resolves `~` against, on both sides of correlation. */
  home: string;
  findings: FleetInventoryFinding[];
  /** Findings the cap refused. Counted, because a silent cap is a lie. */
  droppedFindings: number;
}

function addFinding(ctx: InventoryContext, finding: FleetInventoryFinding): void {
  // Counted rather than merely refused. The first cut stopped pushing at the
  // cap, which meant `findings.length > MAX_FINDINGS` was never true and the
  // clip could never be recorded -- the exact "quietly short-changed" failure
  // `truncated` exists to prevent.
  if (ctx.findings.length >= MAX_FINDINGS) { ctx.droppedFindings += 1; return; }
  // The repair hint is appended HERE, at the one funnel every finding passes
  // through, rather than at each `note()` call -- the conflict findings below
  // are added directly and would otherwise be the two that never carried one.
  //
  // `info` is excluded on purpose: an `info` finding is an observation, not a
  // violation (a permitted conflict is one), and offering a repair for
  // something nobody has to repair is how a report earns its way into being
  // ignored.
  const rule = finding.severity === "info" ? null : ruleIdForFindingCode(finding.code);
  const detail = rule ? `${finding.detail}; repair: flume remediate ${rule} --dry-run` : finding.detail;
  ctx.findings.push({ ...finding, detail: bounded(detail) });
}

/**
 * The fleet home: `HERMES_FLEET_HOME`, else `<home>/.hermes`.
 *
 * ONE function, shared by the inventory's profile layout and the profile
 * observer (story 1.7), so the two can never disagree about which directory
 * the renderer reads. A `~` or relative value is kept as written; expanding
 * it is a separate, deferred decision.
 */
export function resolveFleetHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.HERMES_FLEET_HOME?.trim() || join(home, ".hermes");
}

/**
 * Read the contract's declared profile layout rather than re-deriving one.
 *
 * Exported for `status.ts`, which has to reach the GENERATED profile config on
 * disk for the profile observer. A row's `profile_path` is home-redacted for
 * display and cannot be opened, so the alternative was a second copy of the
 * substitution -- and two copies of a contract-derived path are two paths.
 */
export function resolveProfileLayout(contract: FleetContract, env: NodeJS.ProcessEnv, home: string): { root: string | null; template: string | null } {
  const layout = contract.service_model?.profile_layout;
  const raw = isRecord(layout) ? nonEmptyString(layout.root) : null;
  if (raw === null) return { root: null, template: null };
  const fleetHome = resolveFleetHome(env, home);
  const template = raw.replaceAll("{HERMES_FLEET_HOME}", fleetHome);
  const marker = template.indexOf("{profile_name}");
  if (marker < 0) return { root: null, template: null };
  return { root: template.slice(0, marker).replace(/\/+$/u, ""), template };
}

/** The per-agent unit-name patterns the contract declares. Never re-hardcoded here. */
function unitPatternsFrom(contract: FleetContract): string[] {
  const perAgent = contract.service_model?.per_agent;
  if (!isRecord(perAgent)) return [];
  return Object.keys(perAgent)
    .sort((a, b) => (a < b ? -1 : 1))
    .map((key) => perAgent[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * The `gateway_unit` pattern specifically -- not "any of the three".
 *
 * Drift used to be judged against the whole `expected_units` array, which the
 * contract fills with the gateway service, the heartbeat service AND the
 * heartbeat timer. A registry that stored `hermes-x-heartbeat.timer` in
 * `systemd.gateway_unit` therefore reported no drift at all: the wrong unit, in
 * the right set. The contract names the roles; this reads the one it means.
 */
function gatewayPatternFrom(contract: FleetContract): string | null {
  const perAgent = contract.service_model?.per_agent;
  if (!isRecord(perAgent)) return null;
  return nonEmptyString(perAgent.gateway_unit);
}

/**
 * Read `.project.json` ONLY under a path the classifier accepted.
 *
 * `join()` on a relative `project_path` resolves against the CALLER'S working
 * directory, so without this guard the manifest an agent is judged against
 * depended on where the operator was standing. Measured, before the guard: a row
 * declaring `project_path: relrepo` run from a directory containing an
 * unrelated `relrepo/.project.json` reported `manifest.present: true`,
 * `agrees: false`, and two `manifest-disagrees` notes -- another repository's
 * binding, attributed to this agent as evidence. Correlation already refuses a
 * non-absolute value for exactly this reason; the manifest read did not.
 *
 * `ok` and `symlink` are the two classifications that name an existing absolute
 * directory. Following a symlinked `project_path` to its manifest is deliberate
 * and documented in the README; resolving a relative, absent, out-of-root, or
 * non-directory value is not.
 */
const MANIFEST_READABLE_CLASSIFICATIONS = new Set<FleetPathClassification>(["ok", "symlink"]);

function readManifest(repoPath: string | null, classification: FleetPathClassification): { present: boolean; parsed: Record<string, unknown> | null; path: string | null } {
  if (!repoPath || !MANIFEST_READABLE_CLASSIFICATIONS.has(classification)) return { present: false, parsed: null, path: null };
  const path = join(repoPath, ".project.json");
  if (!existsSync(path)) return { present: false, parsed: null, path };
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) return { present: true, parsed: null, path };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return { present: true, parsed: isRecord(parsed) ? parsed : null, path };
  } catch {
    return { present: true, parsed: null, path };
  }
}

/**
 * One row per raw agent entry, with per-field authoritative-source provenance.
 *
 * Everything a value could be inferred from -- a basename, a manifest, a
 * convenient default -- is deliberately not consulted. An unknown is `null` at
 * state `unresolved`, named against the store that should have supplied it.
 */
export function buildInventoryRow(entry: RawEntry, ctx: InventoryContext): FleetInventoryRow {
  const own = ctx.authority;
  const agentNamespaceOwner = own.ownerOf("agents.{agent_id}");
  const raw = isRecord(entry.value) ? entry.value : {};
  const agentId = entry.key;
  const findings: string[] = [];
  const paths: Record<string, FleetPathView> = {};

  const note = (code: string, path: string, source: string | null, severity: FleetInventoryFinding["severity"], detail: string): void => {
    if (!findings.includes(code)) findings.push(code);
    addFinding(ctx, { code, field: path, agent_id: agentId, source, severity, detail });
  };

  if (agentNamespaceOwner === null) {
    note("authority-owner-undeclared", "agents.{agent_id}", null, "error",
      "the contract declares no authority owner for the agent namespace; provenance cannot be attributed");
  }
  if (entry.malformed) {
    note("agent-row-malformed", "agents.{agent_id}", agentNamespaceOwner, "error",
      `agent row is not a mapping (${typeof entry.value}); only its raw identity key is usable`);
  }
  if (!entry.keyIsString) {
    note("agent-id-not-a-string", "agents.{agent_id}", agentNamespaceOwner, "error",
      "agent identity key is not a string; the raw key is reported verbatim and never used as a path segment");
  }

  const idSafe = isSafePathSegment(agentId);
  if (!idSafe) {
    note("agent-id-unsafe", "agents.{agent_id}", agentNamespaceOwner, "error",
      "agent id is not a safe single path segment; no unit name or directory is derived from it");
  }

  // -- plain registry scalars ------------------------------------------------
  const scalar = (key: string, path: string): FleetFieldValue<string> => {
    const owner = own.ownerOf(path);
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") return field(bounded(value), owner, "resolved");
    if (value !== undefined && typeof value !== "string") {
      note("agent-field-malformed", path, owner, "warn", `${key} is a ${typeof value}, not a string`);
    }
    return unresolved<string>(owner);
  };

  const nestedScalar = (blockKey: string, key: string, path: string): FleetFieldValue<string> => {
    const owner = own.ownerOf(path);
    const block = raw[blockKey];
    if (block === undefined) return unresolved<string>(owner);
    if (!isRecord(block)) {
      note("agent-field-malformed", `agents.{agent_id}.${blockKey}`, own.ownerOf(`agents.{agent_id}.${blockKey}`), "warn",
        `${blockKey} is a ${typeof block}, not a mapping`);
      return unresolved<string>(owner);
    }
    const value = block[key];
    if (typeof value === "string" && value.trim() !== "") return field(bounded(value), owner, "resolved");
    if (value !== undefined && typeof value !== "string") {
      note("agent-field-malformed", path, owner, "warn", `${blockKey}.${key} is a ${typeof value}, not a string`);
    }
    return unresolved<string>(owner);
  };

  const repo = scalar("repo", "agents.{agent_id}.repo");
  const role = scalar("role", "agents.{agent_id}.role");
  const identity = scalar("identity", "agents.{agent_id}.identity");
  // The RUNTIME this row describes, read rather than assumed. Redis ASM already
  // keys agents by runtime type (hermes|claude|codex); the registry was the last
  // layer hard-coding hermes, so a row that does not state one is `unresolved`
  // and never silently reported as a Hermes agent.
  const type = scalar("type", "agents.{agent_id}.type");
  const projectPath = scalar("project_path", "agents.{agent_id}.project_path");
  const roleDir = scalar("role_dir", "agents.{agent_id}.role_dir");
  const profileName = scalar("profile_name", "agents.{agent_id}.profile_name");
  const hindsightWriteBank = nestedScalar("hindsight", "write_bank", "agents.{agent_id}.hindsight.write_bank");

  // -- correlation: two registries only; the manifest is never a tiebreaker ---
  const projectSlugOwner = own.ownerOf("projects.{slug}.slug");
  const repoPathOwner = own.ownerOf("projects.{slug}.repo_path");
  let correlated: ProjectIndexEntry | undefined;
  let basis: string | null = null;
  // The index is keyed by `resolve(expandHome(repo_path))`, so the lookup must
  // expand `~` too or a "~/code/x" spelling never finds the record for the same
  // repository. A RELATIVE value is refused outright rather than resolved:
  // `resolve()` would silently anchor it to whatever directory the operator
  // happened to be standing in, making correlation depend on the caller's cwd.
  // `classifyPath` has already reported it as `relative`.
  if (projectPath.value) {
    const expanded = expandHome(projectPath.value, ctx.home);
    if (isAbsolute(expanded)) {
      correlated = ctx.projectsByRepoPath.get(resolve(expanded));
      if (correlated) basis = "project_path";
    }
  }
  if (!correlated && repo.value) {
    correlated = ctx.projectsBySlug.get(repo.value.toLowerCase());
    if (correlated) basis = "repo";
  }

  const projectId = correlated
    ? field(bounded(correlated.slug), projectSlugOwner, "resolved")
    : unresolved<string>(projectSlugOwner);
  const repoPathValue = correlated?.repoPath ?? null;
  const repoPath = repoPathValue
    ? field(shownPath(repoPathValue), repoPathOwner, "resolved")
    : unresolved<string>(repoPathOwner);
  const correlation = basis
    ? field(basis, projectSlugOwner, "resolved")
    : unresolved<string>(projectSlugOwner);

  if (!correlated) {
    note("project-record-missing", "projects.{slug}.repo_path", repoPathOwner, "warn",
      `no project record matches ${projectPath.value ? shownPath(projectPath.value) : "an undeclared project_path"}`);
  }

  // -- declared paths, classified and never followed -------------------------
  paths.project_path = classifyPath(projectPath.value, { directory: true });
  if (projectPath.value && paths.project_path.classification !== "ok") {
    note("project-path-unusable", "agents.{agent_id}.project_path", projectPath.source, "warn",
      `project_path is ${paths.project_path.classification}`);
  }
  paths.role_dir = classifyPath(roleDir.value, { directory: true });
  if (roleDir.value && paths.role_dir.classification !== "ok") {
    note("role-dir-unusable", "agents.{agent_id}.role_dir", roleDir.source, "warn",
      `role_dir is ${paths.role_dir.classification}`);
  }

  // -- expected runtime path -------------------------------------------------
  const runtimeValue = roleDir.value ? join(roleDir.value, ROLE_RUNTIME_DIRNAME) : null;
  paths.runtime_path = classifyPath(runtimeValue, { root: roleDir.value ?? null, directory: true });
  const runtimePath = runtimeValue && paths.runtime_path.classification === "ok"
    ? field(shownPath(runtimeValue), roleDir.source, "resolved")
    : runtimeValue
      ? field(shownPath(runtimeValue), roleDir.source, "unresolved")
      : unresolved<string>(roleDir.source);
  if (runtimeValue && paths.runtime_path.classification !== "ok") {
    note("runtime-path-unusable", "agents.{agent_id}.role_dir", roleDir.source, "warn",
      `expected runtime directory is ${paths.runtime_path.classification}`);
  }

  // -- contained profile path ------------------------------------------------
  const profileOwner = own.ownerOf("profiles.{profile_name}");
  let profilePathValue: string | null = null;
  if (profileName.value && ctx.profilePathTemplate) {
    if (isSafePathSegment(profileName.value)) {
      profilePathValue = ctx.profilePathTemplate.replaceAll("{profile_name}", profileName.value);
    } else {
      note("profile-name-unsafe", "agents.{agent_id}.profile_name", profileName.source, "error",
        "profile_name is not a safe single path segment; no profile path is derived from it");
    }
  }
  paths.profile_path = classifyPath(profilePathValue, { root: ctx.profileRoot, directory: true });
  let profileState: FleetFieldState = paths.profile_path.classification === "ok" ? "resolved" : "unresolved";
  if (profilePathValue && paths.profile_path.classification === "symlink") {
    profileState = "unresolved";
    note("profile-path-symlinked", "agents.{agent_id}.profile_name", profileOwner, "error",
      `profile root entry is a symlink to ${paths.profile_path.link_target ?? "an unreadable target"}; the contract declares service_model.profile_layout.symlink_allowed: false`);
  } else if (profilePathValue && paths.profile_path.classification !== "ok") {
    note("profile-path-unusable", "agents.{agent_id}.profile_name", profileOwner, "warn",
      `profile directory is ${paths.profile_path.classification}`);
  }
  const profilePath = profilePathValue
    ? field(shownPath(profilePathValue), profileOwner, profileState)
    : unresolved<string>(profileOwner);

  // -- expected owned unit names (EXPECTED, never probed) --------------------
  const unitOwner = own.ownerOf("agents.{agent_id}.systemd.gateway_unit");
  let expectedUnits: FleetFieldValue<string[]>;
  if (idSafe && ctx.unitPatterns.length) {
    // `replaceAll`: a pattern is operator-authored, and a second `{agent_id}`
    // would otherwise survive literally into a name reported as expected.
    const names = ctx.unitPatterns.map((pattern) => bounded(pattern.replaceAll("{agent_id}", agentId)));
    expectedUnits = field(names, unitOwner, "unobserved");
  } else {
    expectedUnits = unresolved<string[]>(unitOwner);
  }
  const storedGateway = nonEmptyString(isRecord(raw.systemd) ? raw.systemd.gateway_unit : undefined);
  const expectedGateway = idSafe && ctx.gatewayPattern
    ? bounded(ctx.gatewayPattern.replaceAll("{agent_id}", agentId))
    : null;
  if (storedGateway && expectedGateway && bounded(storedGateway) !== expectedGateway) {
    note("systemd-unit-name-drift", "agents.{agent_id}.systemd.gateway_unit", unitOwner, "warn",
      `stored gateway unit ${bounded(storedGateway)} is not ${expectedGateway}, the name the contract's service model derives`);
  }
  // Emitted, not just compared: it is the unit name systemd actually sees, it is
  // AC5's unit-name conflict dimension, and without it on the row the drift
  // finding above names a value the envelope never shows.
  const gatewayUnit = storedGateway
    ? field(bounded(storedGateway), unitOwner, "resolved")
    : unresolved<string>(unitOwner);

  // -- stored board binding (projected from the project registry) ------------
  const plane = isRecord(raw.plane) ? raw.plane : {};
  const boardOwner = own.ownerOf("agents.{agent_id}.plane.identifier");
  const binding: FleetBoardBinding = {
    workspace: nonEmptyString(plane.workspace) ? bounded(plane.workspace as string) : null,
    project_id: nonEmptyString(plane.project_id) ? bounded(plane.project_id as string) : null,
    identifier: nonEmptyString(plane.identifier) ? bounded(plane.identifier as string) : null,
  };
  const board = binding.identifier || binding.project_id || binding.workspace
    ? field(binding, boardOwner, "resolved")
    : unresolved<FleetBoardBinding>(boardOwner);
  if (!board.value) {
    note("board-binding-missing", "agents.{agent_id}.plane.identifier", boardOwner, "info",
      "the agent row stores no board binding");
  }

  // -- stored Bloodbank routing record; activation is REPORTED, never granted -
  const bloodbank = isRecord(raw.bloodbank) ? raw.bloodbank : {};
  const scopeOwner = own.ownerOf("agents.{agent_id}.bloodbank.gateway_scope");
  const targetOwner = own.ownerOf("agents.{agent_id}.bloodbank.target_agent_id");
  const bloodbankScope = nonEmptyString(bloodbank.gateway_scope)
    ? field(bounded(bloodbank.gateway_scope as string), scopeOwner, "resolved")
    : unresolved<string>(scopeOwner);
  const bloodbankTarget = nonEmptyString(bloodbank.target_agent_id)
    ? field(bounded(bloodbank.target_agent_id as string), targetOwner, "resolved")
    : unresolved<string>(targetOwner);

  // The contract declares strict: true and default: allow. No key means
  // enabled: an ABSENT flag resolves to the declared default, `true` -- the
  // value the shared gateway routes on. A PRESENT non-boolean is not "probably
  // true" or "probably false": it is unresolved, the gateway treats it as
  // disabled, and it is reported loudly as an error.
  const activationPresent = isRecord(raw.bloodbank) && "enabled" in raw.bloodbank && raw.bloodbank.enabled !== undefined;
  const activationRaw = activationPresent ? (raw.bloodbank as Record<string, unknown>).enabled : true;
  const activation = typeof activationRaw === "boolean"
    ? field(activationRaw, ctx.activationOwner, "resolved")
    : unresolved<boolean>(ctx.activationOwner);
  if (activation.value === null) {
    note("activation-flag-invalid", ctx.activationField, ctx.activationOwner, "error",
      "the activation flag is present but not a strict boolean; it is treated as disabled (an absent flag would mean enabled)");
  }
  const activationField = field(bounded(ctx.activationField), ctx.activationOwner, "resolved");

  // -- the manifest: confirming evidence, never a source and never a tiebreak -
  const manifestRead = readManifest(projectPath.value, paths.project_path.classification);
  const manifestNotes: string[] = [];
  let agrees: boolean | null = null;
  if (manifestRead.present && manifestRead.parsed) {
    const disagreements: string[] = [];
    const provider = isRecord(manifestRead.parsed.ticket_provider) ? manifestRead.parsed.ticket_provider : {};
    const compare = (label: string, manifestValue: unknown, registryValue: string | null): void => {
      const seenValue = nonEmptyString(manifestValue);
      if (!seenValue || !registryValue) return;
      if (seenValue.trim() === registryValue.trim()) return;
      disagreements.push(bounded(`${label}: manifest ${seenValue.trim()} vs registry ${registryValue.trim()}`));
    };
    compare("identifier", provider.identifier, binding.identifier);
    compare("board_id", provider.board_id, binding.project_id);
    compare("workspace", provider.workspace, binding.workspace);
    const projectId = nonEmptyString(manifestRead.parsed.project_id) ?? nonEmptyString(manifestRead.parsed.project_slug);
    compare("project_id", projectId?.toLowerCase(), correlated?.slug.toLowerCase() ?? null);
    manifestNotes.push(...disagreements);
    agrees = disagreements.length === 0;
    if (!agrees) {
      note("manifest-disagrees", "agents.{agent_id}.plane.identifier", boardOwner, "warn",
        `.project.json contradicts the registries (${manifestNotes.join("; ")}); the manifest owns the project definition; refresh its registry index`);
    }
  } else if (manifestRead.present && !manifestRead.parsed) {
    manifestNotes.push("manifest present but unreadable");
    note("manifest-unreadable", "agents.{agent_id}.project_path", projectPath.source, "warn",
      ".project.json is present but could not be read as JSON");
  } else if (projectPath.value && !MANIFEST_READABLE_CLASSIFICATIONS.has(paths.project_path.classification)) {
    // Distinct from `manifest-missing`: nothing was looked for. Saying "carries
    // no .project.json" about a path this command refused to resolve would be a
    // claim about a repository it never reached.
    note("manifest-not-consulted", "agents.{agent_id}.project_path", projectPath.source, "warn",
      `project_path is ${paths.project_path.classification}, so no .project.json was read; resolving it would depend on the caller's working directory`);
  } else if (projectPath.value) {
    note("manifest-missing", "agents.{agent_id}.project_path", projectPath.source, "info",
      "the repository carries no .project.json to confirm the registries");
  }
  // An announced clip. Every other cap in this module records what it dropped;
  // a bare `.slice()` here would be the one place the envelope quietly said less
  // than it knew.
  if (manifestNotes.length > MAX_MANIFEST_NOTES) {
    note("manifest-notes-truncated", "agents.{agent_id}.project_path", projectPath.source, "info",
      `${manifestNotes.length - MAX_MANIFEST_NOTES} of ${manifestNotes.length} manifest notes dropped`);
  }
  const manifest: FleetManifestEvidence = {
    path: classifyPath(manifestRead.path, {}),
    present: manifestRead.present,
    agrees,
    notes: manifestNotes.slice(0, MAX_MANIFEST_NOTES),
  };

  // `type` is declared by the contract (`agents.{agent_id}.type`) but is not yet
  // a member of `FleetInventoryRow`. Widened locally so this module compiles and
  // emits the field today; the row type is the owning module's to extend.
  const row: FleetInventoryRow = {
    agent_id: entry.keyIsString && idSafe
      ? field(agentId, agentNamespaceOwner, "resolved")
      : field(agentId, agentNamespaceOwner, "unresolved"),
    // The DEFAULT lifecycle class. A registered row is `managed_agent` because
    // it exists in the registry the contract declares as its owner, and a
    // malformed one is `unclassified` because nothing about it could be read.
    //
    // Neither is the last word: `declaredRowClass` runs over the whole row set
    // below and promotes any row the contract has recorded an entry for. It has
    // to happen there rather than here because it is a read of contract POLICY
    // about the fleet, not of the entry in front of us.
    classification: entry.malformed
      ? field("unclassified", agentNamespaceOwner, "unresolved")
      : field("managed_agent", agentNamespaceOwner, "resolved"),
    correlation,
    project_id: projectId,
    repo,
    repo_path: repoPath,
    role,
    identity,
    type,
    role_dir: roleDir.value
      ? field(shownPath(roleDir.value), roleDir.source, paths.role_dir.classification === "ok" ? "resolved" : "unresolved")
      : roleDir,
    profile_name: profileName,
    hindsight_write_bank: hindsightWriteBank,
    profile_path: profilePath,
    runtime_path: runtimePath,
    expected_units: expectedUnits,
    gateway_unit: gatewayUnit,
    board,
    bloodbank_scope: bloodbankScope,
    bloodbank_target: bloodbankTarget,
    activation,
    activation_field: activationField,
    manifest,
    paths,
    conflicts: [],
    findings,
    malformed: entry.malformed || !entry.keyIsString,
  };
  return row;
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/** Lexical path normalization for comparison only. Never follows a link. */
function normalizePathValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = posix.normalize(value).replace(/\/+$/u, "");
  return normalized === "" ? "/" : normalized;
}

/**
 * A group id that is identical for every participant, on every machine, forever.
 *
 * NFC + trim before hashing so two spellings of one value collide as they
 * should. Deliberately NOT casefolded: a case-only collision is itself drift
 * worth naming, and folding it would merge two genuinely distinct groups.
 */
export function conflictGroupId(fieldPath: string, value: string): string {
  const normalized = value.normalize("NFC").trim();
  return `conflict:${fieldPath}:${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12)}`;
}

interface Dimension {
  key: string;
  field: string;
  kind: "agent" | "project";
}

/**
 * The identity dimensions AC5 names, plus the stable named-agent identity and
 * the project-registry-internal duplicates `loadProjectRegistry` refuses to
 * load past.
 *
 * Every dimension gets its OWN field path so two dimensions can never mint the
 * same group id for the same value. `projects.{slug}` (a duplicate registry key)
 * and `projects.{slug}.slug` (two agents claiming one project) would otherwise
 * collide on exactly the case where telling them apart matters.
 */
const DIMENSIONS = {
  agentId: { key: "agent-id", field: "agents.{agent_id}", kind: "agent" },
  repo: { key: "repo", field: "agents.{agent_id}.repo", kind: "agent" },
  projectPath: { key: "project-path", field: "agents.{agent_id}.project_path", kind: "agent" },
  stableIdentity: { key: "stable-identity", field: "agents.{agent_id}.identity", kind: "agent" },
  profileName: { key: "profile-name", field: "agents.{agent_id}.profile_name", kind: "agent" },
  boardIdentifier: { key: "board-identifier", field: "agents.{agent_id}.plane.identifier", kind: "agent" },
  bloodbankTarget: { key: "bloodbank-target", field: "agents.{agent_id}.bloodbank.target_agent_id", kind: "agent" },
  // AC5's seventh dimension. The unit name that reaches systemd is the STORED
  // one, and two agents can store the same one; the names derived from the
  // contract's per-agent patterns are `f(agent_id)`, so a collision there is
  // only ever a duplicate agent id, which `agentId` already reports.
  gatewayUnit: { key: "gateway-unit", field: "agents.{agent_id}.systemd.gateway_unit", kind: "agent" },
  projectId: { key: "project-id", field: "projects.{slug}.slug", kind: "agent" },
  projectKey: { key: "project-key", field: "projects.{slug}", kind: "project" },
  projectRepoPath: { key: "project-repo-path", field: "projects.{slug}.repo_path", kind: "project" },
  projectBoardId: { key: "project-board-id", field: "projects.{slug}.ticket_provider.board_id", kind: "project" },
  projectIdentifier: { key: "project-identifier", field: "projects.{slug}.ticket_provider.identifier", kind: "project" },
} as const satisfies Record<string, Dimension>;

interface ConflictInput {
  rows: FleetInventoryRow[];
  projects: ProjectIndexEntry[];
  duplicateProjectKeys: string[];
  authority: FleetAuthorityIndex;
  contract: FleetContract;
}

/**
 * The lifecycle classes a CONTRACT ENTRY can declare a registry row into,
 * strongest first.
 *
 * Only these two, and the order is the rule: `retired` is a sighting of a mode
 * the contract has withdrawn, `intentionally_unmanaged` is state an operator
 * decided to observe and leave alone, and a row an operator has ruled on that
 * ALSO matches a retired mode is a retired one -- reporting it as "leave it
 * alone" would file the strongest statement under the weakest.
 *
 * `managed_agent` is the default and is declared by the row's existence, not by
 * an entry. `managed_shared_service` describes state that is not a per-agent row
 * at all, so no agent row can be declared into it. `unclassified` is what a
 * malformed row gets and nothing may promote it.
 */
const DECLARED_ROW_CLASSES = ["retired", "intentionally_unmanaged"] as const;

/**
 * Does one classification entry claim THIS agent row?
 *
 * ONE SPELLING: `source` equal to the CONCRETE row path `agents.<agent_id>`,
 * compared as a whole string.
 *
 * `participants` was the second spelling and it has been removed, because it
 * conflated two rulings about two different SCOPES. `matchException` reads
 * `participants` to permit one identity-conflict GROUP -- a statement about one
 * field path shared by named claimants. Reading the same list here turned that
 * into a statement about the whole ROW: "these two agents may share a profile
 * name" silently also meant "these rows are state the control plane observes
 * and leaves alone". MEASURED before the fix -- a contract permitting a shared
 * `profile_name` reclassified BOTH participating rows to
 * `intentionally_unmanaged`.
 *
 * Nothing broke today only because both roads happened to land in the
 * `exception` member bucket. The damage was deferred: `row.classification`
 * becomes an input to what a reconciliation plan skips (stories 1.11, 1.15), and
 * a convergence engine declining to touch a row because someone permitted a
 * profile-name collision is exactly the unearned exemption this epic exists to
 * prevent -- and one that would be very hard to trace back to here.
 *
 * EXACT, not a prefix: `agents.alpha-pm` must not also claim `agents.alpha-pm-2`.
 * And the `{agent_id}` PLACEHOLDER form is deliberately not matched -- it is the
 * SHAPE of a path rather than an instance of one, and every authority block in
 * the contract writes it that way, so honouring it would let a single entry
 * sweep the whole fleet into a class nobody ruled on.
 */
function entryClaimsAgent(entry: Record<string, unknown>, agentId: string): boolean {
  return nonEmptyString(entry.source) === `agents.${agentId}`;
}

/**
 * The lifecycle class the CONTRACT declares for one agent row, or null.
 *
 * DW-30's second half. The first half typed the field against
 * `FLEET_CLASSIFICATION_IDS`; this is what gives it something other than one of
 * two constants to say. A row is `managed_agent` because it exists in the
 * registry the contract declares as its owner -- unless the contract has
 * recorded an entry that names it, which is the only thing that may say
 * otherwise.
 *
 * The tracked contract declares zero entries in both classes today, so every
 * live row still resolves `managed_agent` and `fleet inventory` output is
 * unchanged. That is the point: this reads policy rather than inventing it.
 */
export function declaredRowClass(contract: FleetContract, agentId: string): FleetClassificationId | null {
  for (const id of DECLARED_ROW_CLASSES) {
    const entries = contract.classifications?.[id]?.entries ?? [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (entryClaimsAgent(entry, agentId)) return id;
    }
  }
  return null;
}

/**
 * Does an `intentionally_unmanaged` entry declare this exact group permitted?
 *
 * The entry's `source` must equal the group's field path AND its `participants`
 * must equal the group's participant set EXACTLY. A superset must not silently
 * absorb a third claimant that nobody ruled on -- that is the difference between
 * an operator decision and an operator decision quietly widening itself.
 */
export function matchException(group: FleetConflictGroup, contract: FleetContract): { id: string } | null {
  const entries = contract.classifications?.intentionally_unmanaged?.entries ?? [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (nonEmptyString(entry.source) !== group.field) continue;
    const declared = Array.isArray(entry.participants)
      ? entry.participants.filter((item): item is string => typeof item === "string")
      : null;
    if (!declared) continue;
    const wanted = new Set(group.participants);
    const got = new Set(declared);
    if (wanted.size !== got.size) continue;
    let same = true;
    for (const item of wanted) if (!got.has(item)) { same = false; break; }
    if (!same) continue;
    const id = nonEmptyString(entry.id);
    if (id) return { id: bounded(id) };
  }
  return null;
}

export function detectConflicts(input: ConflictInput): FleetConflictGroup[] {
  const buckets = new Map<string, { dimension: Dimension; value: string; participants: Set<string> }>();

  const claim = (dimension: Dimension, rawValue: unknown, participant: string): void => {
    const value = nonEmptyString(rawValue);
    if (value === null) return;
    const normalized = value.normalize("NFC").trim();
    const id = conflictGroupId(dimension.field, normalized);
    const bucket = buckets.get(id) ?? { dimension, value: normalized, participants: new Set<string>() };
    bucket.participants.add(participant);
    buckets.set(id, bucket);
  };

  // Duplicate raw agent identity keys: one row per raw entry means the same id
  // appears twice in `rows`, so the participant set would collapse to one name.
  // Count occurrences instead.
  const idCounts = new Map<string, number>();
  for (const row of input.rows) {
    const id = row.agent_id.value;
    if (id === null) continue;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  for (const row of input.rows) {
    const agentId = row.agent_id.value;
    if (agentId === null) continue;
    claim(DIMENSIONS.repo, row.repo.value, agentId);
    // Lexically normalized, so two spellings of one repository ("/x/y",
    // "/x/y/" and "/x/y/../y") are one claim rather than three innocent-looking
    // ones. NOT `resolve()`: the declared value is already home-redacted, and
    // resolving a "~/..." string would silently prefix it with the working
    // directory. Not `realpath` either -- following a link is what this command
    // must never do.
    claim(DIMENSIONS.projectPath, normalizePathValue(row.paths.project_path?.declared), agentId);
    claim(DIMENSIONS.stableIdentity, row.identity.value, agentId);
    claim(DIMENSIONS.profileName, row.profile_name.value, agentId);
    claim(DIMENSIONS.boardIdentifier, row.board.value?.identifier ?? null, agentId);
    claim(DIMENSIONS.bloodbankTarget, row.bloodbank_target.value, agentId);
    claim(DIMENSIONS.gatewayUnit, row.gateway_unit.value, agentId);
    claim(DIMENSIONS.projectId, row.project_id.value, agentId);
  }

  for (const project of input.projects) {
    claim(DIMENSIONS.projectKey, project.slug, project.key);
    // Normalized exactly as the agent-side path dimension is, and for the same
    // reasons: `resolve()` would bake this host's $HOME into a group id the
    // README promises is identical on every machine, and would silently prefix
    // a "~/..." spelling with the working directory.
    claim(DIMENSIONS.projectRepoPath, normalizePathValue(project.repoPath ? shownPath(project.repoPath) : null), project.key);
    // Board keys are scoped and, for the identifier, case-folded -- because that
    // is how the project registry itself defines uniqueness. Reporting exactly
    // the duplicates `loadProjectRegistry` refuses to load past is the point;
    // a stricter or looser comparison here would report a different registry.
    claim(DIMENSIONS.projectBoardId, project.boardId ? `${project.providerScope}/${project.boardId}` : null, project.key);
    claim(DIMENSIONS.projectIdentifier, project.identifier ? `${project.providerScope}/${project.identifier.toUpperCase()}` : null, project.key);
  }

  const groups: FleetConflictGroup[] = [];
  for (const [id, bucket] of buckets) {
    if (bucket.participants.size < 2) continue;
    groups.push({
      id,
      field: bucket.dimension.field,
      dimension: bucket.dimension.key,
      value: shownPath(bucket.value),
      participants: [...bucket.participants].sort((a, b) => (a < b ? -1 : 1)),
      participant_kind: bucket.dimension.kind,
      owners: [input.authority.ownerOf(bucket.dimension.field)].filter((owner): owner is string => owner !== null),
      permitted: false,
      exception_id: null,
    });
  }

  for (const [agentId, count] of idCounts) {
    if (count < 2) continue;
    groups.push({
      id: conflictGroupId(DIMENSIONS.agentId.field, agentId),
      field: DIMENSIONS.agentId.field,
      dimension: DIMENSIONS.agentId.key,
      value: bounded(agentId),
      participants: [agentId],
      participant_kind: "agent",
      owners: [input.authority.ownerOf(DIMENSIONS.agentId.field)].filter((owner): owner is string => owner !== null),
      permitted: false,
      exception_id: null,
    });
  }
  for (const key of input.duplicateProjectKeys) {
    groups.push({
      id: conflictGroupId(DIMENSIONS.projectKey.field, key),
      field: DIMENSIONS.projectKey.field,
      dimension: DIMENSIONS.projectKey.key,
      value: bounded(key),
      participants: [key],
      participant_kind: "project",
      owners: [input.authority.ownerOf(DIMENSIONS.projectKey.field)].filter((owner): owner is string => owner !== null),
      permitted: false,
      exception_id: null,
    });
  }

  for (const group of groups) {
    const exception = matchException(group, input.contract);
    if (exception) {
      group.permitted = true;
      group.exception_id = exception.id;
    }
  }

  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Every field of a row that carries the value a conflict dimension groups on. */
const CONFLICT_FIELD_KEYS: Record<string, keyof FleetInventoryRow> = {
  "agents.{agent_id}.repo": "repo",
  "agents.{agent_id}.identity": "identity",
  "agents.{agent_id}.profile_name": "profile_name",
  "agents.{agent_id}.plane.identifier": "board",
  "agents.{agent_id}.bloodbank.target_agent_id": "bloodbank_target",
  "agents.{agent_id}.systemd.gateway_unit": "gateway_unit",
  "projects.{slug}.slug": "project_id",
  "agents.{agent_id}": "agent_id",
};
// `agents.{agent_id}.project_path` is deliberately absent. The row carries no
// cell for it (`paths.project_path` is a classification, not a field value), and
// the nearest-looking cell, `repo_path`, is `projects.{slug}.repo_path` -- a
// different field, in a different store, under a different owner. Stamping it
// told a reader the project registry's path was contested when it was not, and
// on an uncorrelated row it emitted `{value: null, state: "conflicted"}`, which
// the row's own value/state rule forbids. The group is still on the row, in
// `row.conflicts`.

function projectIndex(store: RawStore): ProjectIndexEntry[] {
  const entries: ProjectIndexEntry[] = [];
  for (const entry of store.entries) {
    const record = isRecord(entry.value) ? entry.value : {};
    const provider = isRecord(record.ticket_provider) ? record.ticket_provider : {};
    entries.push({
      key: entry.key,
      slug: (nonEmptyString(record.project_id) ?? nonEmptyString(record.slug) ?? entry.key).toLowerCase(),
      repoPath: nonEmptyString(record.repo_path),
      identifier: nonEmptyString(provider.identifier),
      boardId: nonEmptyString(provider.board_id),
      workspace: nonEmptyString(provider.workspace),
      // Mirrors `ticketProviderScope` in src/project/index.ts. Two projects on
      // different providers may hold the same board key without colliding, so a
      // scope-blind comparison would invent a conflict the store itself allows.
      providerScope: `${nonEmptyString(provider.type) ?? ""}/${(nonEmptyString(provider.workspace) ?? "").toLowerCase()}`,
    });
  }
  return entries;
}

function storeView(resolved: ResolvedStore, owner: string | null, store: string | null, raw: RawStore | null): FleetStoreView {
  return {
    id: resolved.id,
    owner,
    store,
    env_keys: [...resolved.envKeys],
    configured_path: shownPath(resolved.configuredPath),
    inspected_path: shownPath(resolved.inspectedPath),
    overridden: resolved.overridden,
    exists: raw !== null,
    source_rows: raw?.sourceRows ?? 0,
    parse: raw?.parse ?? "unreadable",
  };
}

/** The authority block whose `store` names this store id, for the store view. */
function authorityFor(contract: FleetContract, storeName: string): { owner: string | null; store: string | null } {
  for (const authority of Object.values(contract.authorities)) {
    if (authority.store === storeName) return { owner: authority.owner, store: authority.store };
  }
  return { owner: null, store: storeName };
}

/**
 * The whole fleet, as the two canonical registries actually state it.
 *
 * A fleet that disagrees with itself is DATA, not a command failure: the
 * envelope invariant nulls `data` on `ok:false`, so reporting conflicts as a
 * failure would blank the inventory on exactly the runs where it matters. Only a
 * COMMAND failure -- an unreadable registry, an unknown `--agent`, a bad flag --
 * throws from here.
 */
export function collectFleetInventory(options: FleetInventoryOptions = {}): FleetInventory {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  const contractPath = resolveFleetContractPath(options.contract);
  const loaded = loadFleetContract(contractPath);
  const validation = validateFleetContract(loaded.document);
  const first = validation.diagnostics[0];
  if (!validation.contract || first) {
    throw new FleetError(
      first?.code ?? "INVALID_INPUT",
      `fleet contract is not usable: ${first ? `${first.path}: ${first.message}` : "validation produced no contract"}`,
      false,
      { contract_path: shownPath(contractPath) },
    );
  }
  const contract = validation.contract;

  const stores = resolveInventoryStores(options);
  const agentRaw = readAgentRegistryRaw(stores.agents.inspectedPath);
  const projectRaw = readProjectRegistryRaw(stores.projects.inspectedPath);

  const authority = buildAuthorityIndex(contract);
  const layout = resolveProfileLayout(contract, env, home);
  const execution = contract.activation?.execution_authority;
  const activationField = nonEmptyString(execution?.field) ?? "agents.{agent_id}.bloodbank.enabled";
  const activationOwner = nonEmptyString(execution?.owner) ?? authority.ownerOf(activationField);

  const projects = projectIndex(projectRaw);
  const projectsByRepoPath = new Map<string, ProjectIndexEntry>();
  const projectsBySlug = new Map<string, ProjectIndexEntry>();
  for (const project of projects) {
    if (project.repoPath) {
      const key = resolve(expandHome(project.repoPath, home));
      if (!projectsByRepoPath.has(key)) projectsByRepoPath.set(key, project);
    }
    if (!projectsBySlug.has(project.slug)) projectsBySlug.set(project.slug, project);
  }

  const ctx: InventoryContext = {
    contract,
    authority,
    profileRoot: layout.root,
    profilePathTemplate: layout.template,
    unitPatterns: unitPatternsFrom(contract),
    gatewayPattern: gatewayPatternFrom(contract),
    activationField,
    activationOwner,
    projectsByRepoPath,
    projectsBySlug,
    home,
    findings: [],
    droppedFindings: 0,
  };

  const indexStatuses = isRecord(projectRaw.top.__registry_status) ? projectRaw.top.__registry_status : {};
  for (const [projectId, rawStatus] of Object.entries(indexStatuses)) {
    if (!isRecord(rawStatus) || rawStatus.status === "ok") continue;
    addFinding(ctx, {
      code: "project-manifest-unavailable", field: `projects.${projectId}`, agent_id: null,
      source: authority.ownerOf("projects.{slug}.project_id"), severity: "error",
      detail: `Project ${projectId} manifest is ${String(rawStatus.status)}; the index retains its last valid snapshot. ${typeof rawStatus.error === "string" ? rawStatus.error : "Repair its canonical .project.json."}`,
    });
  }

  // Suppressed under an override: the two env keys did not choose this run's
  // store, so pointing an operator at them would be pointing at the wrong repair.
  if (stores.disagreement && !stores.agents.overridden) {
    addFinding(ctx, {
      code: "agent-registry-store-env-disagreement",
      field: "agents.{agent_id}",
      agent_id: null,
      source: authority.ownerOf("agents.{agent_id}.repo"),
      severity: "warn",
      detail: `${stores.disagreement}; this run treats ${shownPath(stores.agents.configuredPath)} as the configured store`,
    });
  }

  // A store whose keyed collection is missing or is not a mapping is a store
  // this command could NOT read -- it is not an empty fleet. Left unsaid, a
  // registry with a mistyped `agents:` key reported "healthy, 0 of 0 rows" at
  // exit 0: the silent vanishing the independent count exists to prevent,
  // arriving one level above the count.
  for (const [store, raw, collection] of [
    [stores.agents, agentRaw, "agents"] as const,
    [stores.projects, projectRaw, "projects"] as const,
  ]) {
    if (raw.collection === "ok") continue;
    addFinding(ctx, {
      code: "registry-collection-unreadable",
      field: `${collection}.{key}`,
      agent_id: null,
      source: authority.ownerOf(`${collection}.{key}`),
      severity: "error",
      detail: raw.collection === "missing"
        ? `${store.id} declares no ${collection}: mapping; the file parsed but carries no fleet to inventory`
        : `${store.id}'s ${collection}: key is not a mapping; the file parsed but carries no fleet to inventory`,
    });
  }
  for (const [store, raw, collection] of [
    [stores.agents, agentRaw, "agents"] as const,
    [stores.projects, projectRaw, "projects"] as const,
  ]) {
    if (raw.collection !== "ok" || raw.countIndependent) continue;
    addFinding(ctx, {
      code: "source-count-not-independent",
      field: `${collection}.{key}`,
      agent_id: null,
      source: authority.ownerOf(`${collection}.{key}`),
      severity: "error",
      detail: `${store.id}'s ${collection}: mapping was read but could not be counted by a separate parse; source_rows fell back to the reader's own array and cannot disagree with it`,
    });
  }
  if (layout.root === null) {
    addFinding(ctx, {
      code: "profile-layout-undeclared",
      field: "service_model.profile_layout.root",
      agent_id: null,
      source: authority.ownerOf("profiles.{profile_name}"),
      severity: "error",
      detail: "the contract declares no usable profile_layout.root; no profile path can be derived",
    });
  }
  for (const [store, raw] of [[stores.agents, agentRaw] as const, [stores.projects, projectRaw] as const]) {
    if (raw.schemaVersion === null || raw.schemaVersion === SUPPORTED_REGISTRY_SCHEMA) continue;
    addFinding(ctx, {
      code: "registry-schema-version-unsupported",
      field: "schema_version",
      agent_id: null,
      source: null,
      severity: "error",
      detail: `${store.id} declares schema_version ${raw.schemaVersion}; this build reads version ${SUPPORTED_REGISTRY_SCHEMA} and would report a later shape as if it were one`,
    });
  }
  if (ctx.unitPatterns.length === 0) {
    addFinding(ctx, {
      code: "service-model-undeclared",
      field: "service_model.per_agent",
      agent_id: null,
      source: authority.ownerOf("agents.{agent_id}.systemd.gateway_unit"),
      severity: "error",
      detail: "the contract declares no per-agent unit-name patterns; no expected unit name can be derived",
    });
  }

  // Checked per row, not once before the loop: a 1000-agent registry spends
  // most of a run in here (an `lstat` and a `.project.json` read per row), and a
  // cancellation that is only noticed after the last row has been built is not a
  // cancellation. `throwIfCancelled` is a no-op when no caller supplied a
  // context, so the unbudgeted path is unchanged.
  //
  // `remainingMs` is checked BESIDE it, not instead of it. Inventory spawns no
  // probe, so it never reaches the pre-spawn budget check inside `probe()` --
  // and without this call `--deadline-ms`/`deadlineMs` was accepted, documented
  // as "Fail with TIMEOUT if the whole run has not finished within this budget",
  // and then enforced nowhere: `fleet inventory --deadline-ms 1` ran to
  // completion and exited 0. A flag that names a guarantee has to carry it.
  const runContext = options.runContext;
  const allRows = agentRaw.entries.map((entry) => {
    if (runContext) {
      throwIfCancelled(runContext);
      remainingMs(runContext);
    }
    return buildInventoryRow(entry, ctx);
  });
  allRows.sort((a, b) => {
    const left = a.agent_id.value ?? "";
    const right = b.agent_id.value ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const conflicts = detectConflicts({
    rows: allRows,
    projects,
    duplicateProjectKeys: projectRaw.duplicateKeys,
    authority,
    contract,
  });

  // Stamp participation back onto the rows, so a row is self-describing and a
  // reader never has to join two arrays to learn a value is contested.
  const byParticipant = new Map<string, FleetConflictGroup[]>();
  for (const group of conflicts) {
    if (group.participant_kind !== "agent") continue;
    for (const participant of group.participants) {
      const list = byParticipant.get(participant) ?? [];
      list.push(group);
      byParticipant.set(participant, list);
    }
  }
  for (const row of allRows) {
    const id = row.agent_id.value;
    if (id === null) continue;
    for (const group of byParticipant.get(id) ?? []) {
      if (!row.conflicts.includes(group.id)) row.conflicts.push(group.id);
      const key = CONFLICT_FIELD_KEYS[group.field];
      if (key) {
        const target = row[key] as FleetFieldValue<unknown>;
        if (target && typeof target === "object" && "state" in target) target.state = "conflicted";
      }
      if (!row.findings.includes("identity-conflict")) row.findings.push("identity-conflict");
      addFinding(ctx, {
        code: "identity-conflict",
        field: group.field,
        agent_id: id,
        source: group.owners[0] ?? null,
        severity: group.permitted ? "info" : "error",
        detail: `${group.value} is claimed by ${group.participants.join(", ")}${group.permitted ? ` (permitted by ${group.exception_id})` : ""}`,
      });
    }
    row.conflicts.sort((a, b) => (a < b ? -1 : 1));
  }

  // -- lifecycle class: resolved against the contract's DECLARED entries -----
  //
  // DW-30's second half. Every well-formed row used to get the bare string
  // `managed_agent` and every malformed one `unclassified`, typed against
  // nothing -- so a typo compiled and shipped, and the field could never report
  // `intentionally_unmanaged` or `retired` even though the contract declares
  // both classes and has entry lists for them. A value that can only ever be
  // one of two constants carries no information.
  //
  // DECLARED, and only declared. This does not infer a class from an observed
  // conflict, a permitted exception, or anything else this command noticed: an
  // operator ruling recorded under `classifications.*.entries` is the one thing
  // that may promote a row, and if the contract says nothing the row stays
  // `managed_agent`. The shipped contract declares no entries in either class,
  // so every live row resolves exactly as it did before.
  //
  // A MALFORMED row is never promoted. Nothing about it could be read, so there
  // is no identity to match an entry against, and `unclassified` is the honest
  // answer rather than a class an entry claimed for a row it may not be about.
  for (const row of allRows) {
    if (row.malformed) continue;
    const id = row.agent_id.value;
    if (id === null) continue;
    const declared = declaredRowClass(contract, id);
    if (declared === null) continue;
    row.classification = { ...row.classification, value: declared, state: "resolved" };
  }
  for (const group of conflicts) {
    if (group.participant_kind !== "project") continue;
    addFinding(ctx, {
      code: "project-registry-duplicate",
      field: group.field,
      agent_id: null,
      source: group.owners[0] ?? null,
      severity: group.permitted ? "info" : "error",
      detail: `${group.value} is claimed by ${group.participants.join(", ")}${group.permitted ? ` (permitted by ${group.exception_id})` : ""}`,
    });
  }

  // -- scope -----------------------------------------------------------------
  const wanted = options.agentId?.trim();
  let scope: FleetInventoryScope = { kind: "fleet", agent_id: null, label: "whole registered fleet" };
  let selectedRows = allRows;
  if (wanted) {
    selectedRows = allRows.filter((row) => row.agent_id.value === wanted);
    if (selectedRows.length === 0) {
      throw new FleetError("NOT_FOUND", "No agent with that id is registered", false, { agent_id: bounded(wanted, 128) });
    }
    scope = { kind: "agent", agent_id: bounded(wanted, 128), label: `scoped to agent ${bounded(wanted, 128)}` };
  }

  const truncated: string[] = [];
  let rows = selectedRows;
  const rowCap = options.rowCap ?? FLEET_INVENTORY_MAX_ROWS;
  if (rows.length > rowCap) {
    truncated.push(`rows: ${rows.length - rowCap} of ${rows.length} rows dropped`);
    rows = rows.slice(0, rowCap);
  }
  if (ctx.droppedFindings > 0) {
    truncated.push(`findings: ${ctx.droppedFindings} of ${ctx.findings.length + ctx.droppedFindings} findings dropped`);
  }
  const findings = [...ctx.findings].sort((a, b) => (
    a.field < b.field ? -1 : a.field > b.field ? 1
      : a.code < b.code ? -1 : a.code > b.code ? 1
        : (a.agent_id ?? "") < (b.agent_id ?? "") ? -1 : (a.agent_id ?? "") > (b.agent_id ?? "") ? 1
          : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0
  ));
  let reportedConflicts = conflicts;
  if (reportedConflicts.length > MAX_CONFLICT_GROUPS) {
    truncated.push(`conflicts: ${reportedConflicts.length - MAX_CONFLICT_GROUPS} of ${reportedConflicts.length} groups dropped`);
    reportedConflicts = reportedConflicts.slice(0, MAX_CONFLICT_GROUPS);
    // Rows were stamped from the full set. Left alone, `row.conflicts` would
    // name ids absent from `data.conflicts` and every join a consumer makes
    // across the two arrays would dangle on exactly the runs the cap fires.
    const kept = new Set(reportedConflicts.map((group) => group.id));
    for (const row of rows) row.conflicts = row.conflicts.filter((id) => kept.has(id));
  }

  const malformedRows = allRows.filter((row) => row.malformed).length;
  const correlatedRows = allRows.filter((row) => row.project_id.value !== null).length;
  const unpermitted = conflicts.filter((group) => !group.permitted).length;
  // A malformed row is already counted, once, in `malformed_rows`. Naming the
  // row-integrity codes rather than prefix-matching "agent-row" is the fix for a
  // real double-book: one scalar row with a non-string key raised
  // `agent-row-malformed` (excluded) AND `agent-id-not-a-string` (counted), so
  // one defect added one -- or with an unsafe key, two -- to a metric the
  // exclusion exists to keep at zero.
  const malformedAgentIds = new Set(
    allRows.filter((row) => row.malformed).map((row) => row.agent_id.value).filter((id): id is string => id !== null),
  );
  const contractViolations = ctx.findings.filter((finding) => {
    if (finding.severity !== "error") return false;
    if (ROW_INTEGRITY_CODES.has(finding.code)) return false;
    // The shape of a row that `malformed_rows` already counts is not a second
    // contract violation. On a well-formed row the same code still counts.
    if (ROW_SHAPE_CODES.has(finding.code) && finding.agent_id !== null && malformedAgentIds.has(finding.agent_id)) return false;
    return true;
  }).length;
  const unresolvedRows = allRows.filter((row) => (
    row.project_id.state !== "resolved" || row.profile_path.state !== "resolved" || row.role_dir.state !== "resolved"
  )).length;

  const totals: FleetInventoryTotals = {
    source_rows: agentRaw.sourceRows,
    emitted_rows: allRows.length,
    selected: selectedRows.length,
    observed: rows.length,
    malformed_rows: malformedRows,
    registered_agents: allRows.length,
    project_records: projectRaw.sourceRows,
    correlated: correlatedRows,
    uncorrelated: allRows.length - correlatedRows,
    conflict_groups: conflicts.length,
    permitted_conflict_groups: conflicts.length - unpermitted,
    findings: ctx.findings.length + ctx.droppedFindings,
  };

  const health: FleetInventoryHealth = {
    healthy: unpermitted === 0 && malformedRows === 0 && contractViolations === 0 && truncated.length === 0
      && agentRaw.parse === "ok" && projectRaw.parse === "ok"
      && agentRaw.collection === "ok" && projectRaw.collection === "ok"
      && totals.source_rows === totals.emitted_rows,
    conflicts: unpermitted,
    permitted_conflicts: totals.permitted_conflict_groups,
    contract_violations: contractViolations,
    malformed_rows: malformedRows,
    unresolved_rows: unresolvedRows,
    // A store whose COLLECTION could not be read. A `salvaged` parse is not
    // one: a single scalar agent row set `parse: "salvaged"` and made the human
    // report print "1 unreadable stores" about a store that returned every row
    // it had. `malformed_rows` already counts that row, and `data.stores[].parse`
    // already reports the salvage.
    collection_errors: (agentRaw.collection === "ok" ? 0 : 1) + (projectRaw.collection === "ok" ? 0 : 1),
    truncated: truncated.length > 0,
  };

  const agentAuthority = authorityFor(contract, AGENT_STORE);
  const projectAuthority = authorityFor(contract, PROJECT_STORE);

  return {
    contract_path: shownPath(contractPath),
    contract_version: contract.contract_version,
    scope,
    stores: [
      storeView(stores.agents, agentAuthority.owner, agentAuthority.store, agentRaw),
      storeView(stores.projects, projectAuthority.owner, projectAuthority.store, projectRaw),
    ],
    totals,
    health,
    rows,
    conflicts: reportedConflicts,
    findings,
    truncated,
  };
}
