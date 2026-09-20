// Load, validate, and re-serialize the tracked fleet contract.
//
// Strictly read-only: the only file this module opens is the contract itself.
// No registry, profile, repository, service, process, Bloodbank, or network
// access happens here, and none may be added -- every later Epic 1 story reads
// its authority answers from this module, so a write introduced here would
// become a write nobody asked any of them to make.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  FLEET_ACTIVATION_STATES,
  FLEET_AUTHORITY_KEYS,
  FLEET_CLASSIFICATION_IDS,
  FLEET_CLASSIFICATION_KEYS,
  FLEET_CLASSIFICATION_REQUIRED_FIELDS,
  FLEET_COMPATIBILITY_KEYS,
  FLEET_CONTRACT_OPTIONAL_ROOT_KEYS,
  FLEET_CONTRACT_ROOT_KEYS,
  FLEET_EXTENSION_PREFIX,
  FLEET_HEALTH_POLICY_AGENT_EXCEPTION_KEYS,
  FLEET_HEALTH_POLICY_DEFERRED_KEYS,
  FLEET_HEALTH_POLICY_FRESHNESS_KEYS,
  FLEET_HEALTH_POLICY_KEYS,
  FLEET_HEALTH_POLICY_SKIP_KEYS,
  FLEET_HEALTH_POLICY_WARNING_KEYS,
  FLEET_FORBIDDEN_KEYS,
  FLEET_HEALTHY_CLASSIFICATIONS,
  FLEET_HEALTHY_SECTIONS,
  FLEET_PROFILE_MANIFEST_EXTRAS_KEYS,
  FLEET_PROFILE_MANIFEST_IDENTITY_KEYS,
  FLEET_PROFILE_MANIFEST_KEYS,
  FLEET_PROFILE_MANIFEST_LIMITS_KEYS,
  FLEET_PROFILE_MANIFEST_MEMORY_KEYS,
  FLEET_PROFILE_MANIFEST_RENDERER_KEYS,
  FLEET_PROFILE_MANIFEST_SKILL_CORE_KEYS,
  FLEET_PROJECTION_KEYS,
  FLEET_RETIRED_IDS,
  FLEET_RETIRED_KEYS,
  FLEET_SCAFFOLD_MANIFEST_KEYS,
  FLEET_SCAFFOLD_PRESENCE_ONLY_KEYS,
  FLEET_SERVICE_MANIFEST_ENTRYPOINT_KEYS,
  FLEET_SERVICE_MANIFEST_HEARTBEAT_KEYS,
  FLEET_SERVICE_MANIFEST_KEYS,
  FLEET_SERVICE_MANIFEST_LIMITS_KEYS,
  FLEET_SERVICE_MANIFEST_MESSAGING_KEYS,
  FLEET_SERVICE_MANIFEST_PROBE_KEYS,
  FLEET_SERVICE_MANIFEST_STABILIZATION_KEYS,
  FLEET_SERVICE_MANIFEST_UNREGISTERED_KEYS,
  FLEET_STATUS_DOMAINS,
  FLEET_SUPPORTED_SCHEMA_VERSIONS,
  PROFILE_MAX_EXTRA_SKILLS,
  PROFILE_MAX_FILE_BYTES,
  PROFILE_MAX_ROOT_ENTRIES,
  PROFILE_MAX_UNIT_FILES,
  SYSTEMD_MAX_FILE_BYTES,
  SYSTEMD_MAX_INTERVAL_MS,
  SYSTEMD_MAX_PROBE_TIMEOUT_MS,
  SYSTEMD_MAX_SAMPLES,
  SYSTEMD_MAX_SHOW_BYTES,
  SYSTEMD_MAX_UNITS,
  SYSTEMD_MAX_UNREGISTERED_UNITS,
  FleetError,
  type FleetContract,
  type FleetDiagnostic,
  type FleetExtension,
} from "./types";
import { groupFor } from "../scaffold/compare";

/** Name of the tracked contract, relative to the package root. */
export const FLEET_CONTRACT_RELATIVE_PATH = join("contracts", "handbook.yaml");

/** A contract larger than this is not a declaration; it is an accident. */
const FLEET_CONTRACT_MAX_BYTES = 1_048_576;

/** Path used for findings about the document as a whole. */
const DOCUMENT_PATH = "contract";

const SEMVER = /^\d+\.\d+\.\d+$/u;
const OWNER_NAME = /^[a-z][a-z0-9-]*$/u;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/u;
const DIRECTION = /^[a-z0-9_]+_to_[a-z0-9_]+$/u;
const FIELD_PATH = /^[A-Za-z0-9_{}-]+(?:\.[A-Za-z0-9_{}-]+)*$/u;
// `(?:\/|$)` matters: without it a bare `/home/someone` -- no trailing slash --
// walked straight through, and `/root` was never covered at all.
const HOST_PATH = /\/(?:home|Users|root)\/[A-Za-z0-9._-]+(?:\/|$)/u;
const SECRET_KEY = /(api_key|apikey|password|passwd|secret|token|credential)/iu;
/** The one path exempt from `SECRET_KEY`: it names environment KEYS, and the service-manifest stage proves each is one. */
const SERVICE_SECRET_ENV_PATH = "service_manifest.messaging.secret_env";
/** Longest `retired[].detect` pattern accepted. Long patterns are the ones that hurt. */
const FLEET_DETECT_MAX_PATTERN_BYTES = 200;
// A quantified group that itself contains a quantifier -- `(a+)+`, `(a*)*`,
// `(?:ab+)*` -- is the classic exponential-backtracking shape.
const NESTED_QUANTIFIER = /\((?:\?[:=!])?[^)]*[+*}][^)]*\)\s*[+*{]/u;
// Credential-SHAPED values, not the word "secret" in prose. A key-name scan
// alone let `store: "sk-live-..."` through, and a prose scan would flag every
// note that explains why credentials are banned.
const SECRET_VALUE = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}\b/u,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
  /(?:api[_-]?key|password|passwd|secret|token|credential)\s*[:=]\s*\S{8,}/iu,
];

type FleetContractDocument = ReturnType<typeof YAML.parseDocument>;

export interface LoadedFleetContract {
  /** Resolved absolute path. Redact before this reaches an operator. */
  path: string;
  text: string;
  document: FleetContractDocument;
}

export interface FleetContractValidation {
  diagnostics: FleetDiagnostic[];
  /** Populated only when `diagnostics` is empty. */
  contract: FleetContract | null;
  extensions: FleetExtension[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize a store name into the token a `direction` is built from. */
function storeToken(store: string): string {
  return store.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/**
 * Walk up from this module for the package root that also ships the contract.
 *
 * `resolveFlumeRoot` in `src/parity/index.ts` is not exported, so this is one
 * more site duplicating the walk. Both markers are required: `package.json`
 * alone matches a nested dependency directory, and the bundled `dist/index.js`
 * has to land on the same root as the unbundled source.
 */
export function resolveFleetContractPath(override?: string): string {
  if (override !== undefined && override.trim() !== "") return resolve(override);
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, FLEET_CONTRACT_RELATIVE_PATH))) {
      return join(dir, FLEET_CONTRACT_RELATIVE_PATH);
    }
    dir = dirname(dir);
  }
  return resolve(process.cwd(), FLEET_CONTRACT_RELATIVE_PATH);
}

export function loadFleetContract(path: string): LoadedFleetContract {
  if (!existsSync(path)) throw new FleetError("NOT_FOUND", "Fleet contract not found", false, {});
  const stat = statSync(path);
  if (!stat.isFile()) throw new FleetError("INVALID_INPUT", "Fleet contract is not a regular file", false, {});
  if (stat.size > FLEET_CONTRACT_MAX_BYTES) {
    throw new FleetError("INVALID_INPUT", `Fleet contract exceeds ${FLEET_CONTRACT_MAX_BYTES} bytes`, false, {});
  }
  const text = readFileSync(path, "utf8");
  return { path, text, document: YAML.parseDocument(text) };
}

/**
 * Walk a dotted path into the policy tree, or `undefined` if it does not exist.
 *
 * Used to prove `retired[].superseded_by` names a real block of this contract
 * rather than a section someone has since renamed.
 */
function resolveContractPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const segment of path.split(".")) {
    if (!isRecord(node)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/** The serializer the byte-stable round trip is defined against. */
export function serializeFleetContract(document: FleetContractDocument): string {
  return String(document);
}

/**
 * Split a plain contract tree into the policy view and its extensions.
 *
 * An `x-` key at any depth is metadata for whoever wrote it. It is lifted out
 * before any rule looks at the tree, so a namespaced key can never become
 * implicit policy, and it is reported separately so it stays visible.
 */
export function collectFleetExtensions(value: unknown): { policy: unknown; extensions: FleetExtension[] } {
  const extensions: FleetExtension[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`));
    if (!isRecord(node)) return node;
    // Null prototype, deliberately. `yaml` hands back `__proto__` as a real own
    // key, but assigning it onto a normal object literal sets the prototype
    // instead of creating a property -- so the key silently VANISHED from the
    // policy tree and no rule could ever see it. With no prototype in the
    // chain there is no setter to hijack, the key survives as data, and the
    // forbidden-key rule below can reject it.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(node)) {
      const child = path ? `${path}.${key}` : key;
      if (key.startsWith(FLEET_EXTENSION_PREFIX)) extensions.push({ path: child, value: item });
      else result[key] = walk(item, child);
    }
    return result;
  };
  const policy = walk(value, "");
  extensions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { policy, extensions };
}

/** Every scalar leaf in a subtree, addressed by dotted path. Keys included. */
function scalars(node: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => scalars(item, `${path}[${index}]`, out));
    return;
  }
  if (isRecord(node)) {
    for (const [key, item] of Object.entries(node)) {
      const child = path ? `${path}.${key}` : key;
      out.push({ path: child, text: key });
      scalars(item, child, out);
    }
    return;
  }
  if (node !== null && node !== undefined) out.push({ path, text: String(node) });
}

function sortDiagnostics(items: FleetDiagnostic[]): FleetDiagnostic[] {
  return [...items].sort((a, b) => (
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  ));
}

/**
 * Validate a parsed contract document.
 *
 * Stages run in a fixed order and the first stage to produce findings stops the
 * run: a contract whose schema version this build cannot read must not also be
 * lectured about its authorities, and a structurally broken file has no field
 * paths worth checking for conflicts. That ordering is what lets each exit code
 * answer exactly one question.
 */
export function validateFleetContract(document: FleetContractDocument): FleetContractValidation {
  const parseErrors = document.errors.slice(0, 20).map<FleetDiagnostic>((error) => {
    const at = error.linePos?.[0];
    const where = at ? ` at line ${at.line} column ${at.col}` : "";
    // The parser's own message quotes source fragments; only its stable code
    // and position cross the boundary.
    return { code: "INVALID_INPUT", path: DOCUMENT_PATH, message: `YAML parse failed (${error.code})${where}` };
  });
  if (parseErrors.length) return { diagnostics: parseErrors, contract: null, extensions: [] };

  // `toJS()` still throws after a clean parse -- an alias bomb trips the
  // library's own `maxAliasCount` only when the tree is materialised. Left
  // unhandled it escaped the diagnostics pipeline entirely and surfaced as
  // INTERNAL_ERROR/exit 6, which this taxonomy reserves for defects in US. A
  // hostile input file is the caller's problem, and says so: INVALID_INPUT.
  let tree: unknown;
  try { tree = document.toJS() as unknown; }
  catch { return { diagnostics: [{ code: "INVALID_INPUT", path: DOCUMENT_PATH, message: "contract could not be materialised (alias expansion or depth limit)" }], contract: null, extensions: [] }; }
  const { policy, extensions } = collectFleetExtensions(tree);
  if (!isRecord(policy)) {
    return { diagnostics: [{ code: "INVALID_INPUT", path: DOCUMENT_PATH, message: "contract must be a mapping" }], contract: null, extensions };
  }

  const stages: Array<() => FleetDiagnostic[]> = [
    () => validateVersion(policy),
    () => sortDiagnostics(validateStructure(policy, extensions)),
    () => validateAuthorityConflicts(policy as unknown as FleetContract),
    () => sortDiagnostics(validateClassifications(policy as unknown as FleetContract)),
    () => sortDiagnostics(validateRetiredModes(policy as unknown as FleetContract)),
    () => sortDiagnostics(validateHealthPolicy(policy)),
    () => sortDiagnostics(validateScaffoldManifest(policy)),
    () => sortDiagnostics(validateProfileManifest(policy)),
    () => sortDiagnostics(validateServiceManifest(policy)),
  ];
  for (const stage of stages) {
    const findings = stage();
    if (findings.length) return { diagnostics: findings, contract: null, extensions };
  }
  return { diagnostics: [], contract: policy as unknown as FleetContract, extensions };
}

function validateVersion(policy: Record<string, unknown>): FleetDiagnostic[] {
  const declared = policy.schema_version;
  if (!Number.isSafeInteger(declared)) {
    return [{ code: "INVALID_INPUT", path: "schema_version", message: "schema_version must be an integer" }];
  }
  const version = Number(declared);
  const { min, max } = FLEET_SUPPORTED_SCHEMA_VERSIONS;
  if (version < min || version > max) {
    return [{
      code: "UNSUPPORTED_SCHEMA_VERSION",
      path: "schema_version",
      message: `contract schema_version ${version} is outside the supported range ${min}..${max}`,
    }];
  }
  const compatibility = policy.compatibility;
  if (!isRecord(compatibility)) {
    return [{ code: "INVALID_INPUT", path: "compatibility", message: "compatibility must be a mapping" }];
  }
  const lower = compatibility.min_schema_version;
  const upper = compatibility.max_schema_version;
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)) {
    return [{ code: "INVALID_INPUT", path: "compatibility", message: "compatibility bounds must be integers" }];
  }
  if (Number(lower) > Number(upper)) {
    return [{ code: "INVALID_INPUT", path: "compatibility", message: "compatibility min_schema_version exceeds max_schema_version" }];
  }
  if (version < Number(lower) || version > Number(upper)) {
    return [{
      code: "UNSUPPORTED_SCHEMA_VERSION",
      path: "compatibility",
      message: `schema_version ${version} is outside the contract's own declared range ${String(lower)}..${String(upper)}`,
    }];
  }
  return [];
}

function validateStructure(policy: Record<string, unknown>, extensions: readonly FleetExtension[]): FleetDiagnostic[] {
  const findings: FleetDiagnostic[] = [];
  const fail = (path: string, message: string): void => { findings.push({ code: "INVALID_INPUT", path, message }); };

  for (const key of Object.keys(policy)) {
    if (!(FLEET_CONTRACT_ROOT_KEYS as readonly string[]).includes(key)) fail(key, "unknown top-level key");
  }
  for (const key of FLEET_CONTRACT_ROOT_KEYS) {
    // `health_policy` is in the allowlist -- it is real policy, not an `x-`
    // extension -- but it is not REQUIRED: a schema-1 contract predates it and
    // still has to load. Splitting the two loops is what makes the block
    // optional without also making a typo of it an accepted unknown key.
    if ((FLEET_CONTRACT_OPTIONAL_ROOT_KEYS as readonly string[]).includes(key)) continue;
    if (policy[key] === undefined) fail(key, "required top-level key is missing");
  }
  const compatibility = policy.compatibility;
  if (isRecord(compatibility)) {
    for (const key of Object.keys(compatibility)) {
      if (!(FLEET_COMPATIBILITY_KEYS as readonly string[]).includes(key)) fail(`compatibility.${key}`, "unknown compatibility key");
    }
  }
  if (typeof policy.contract_version !== "string" || !SEMVER.test(policy.contract_version)) {
    fail("contract_version", "contract_version must be a semantic version");
  }
  if (findings.length) return findings;

  // No host state, no credentials. Only `retired[].detect` is exempt from the
  // host-path rule: it is a detection vocabulary rather than a declaration, so
  // it has to be able to spell the very shapes the rule bans. Exempting the
  // WHOLE retired block was too wide -- `id`, `reason` and `superseded_by` are
  // ordinary prose, and a live-shaped key or another user's home directory
  // parked in a `reason:` validated clean. Extensions are NOT exempt either: an
  // `x-` key is not policy, but a credential in one is still a credential in a
  // tracked file.
  const leaves: Array<{ path: string; text: string }> = [];
  for (const [key, value] of Object.entries(policy)) {
    if (key !== "retired") { scalars(value, key, leaves); continue; }
    if (!Array.isArray(value)) { scalars(value, key, leaves); continue; }
    value.forEach((entry: unknown, index: number) => {
      if (!isRecord(entry)) { scalars(entry, `${key}[${index}]`, leaves); return; }
      for (const [entryKey, entryValue] of Object.entries(entry)) {
        if (entryKey === "detect") continue;
        scalars(entryValue, `${key}[${index}].${entryKey}`, leaves);
      }
    });
  }
  for (const extension of extensions) {
    leaves.push({ path: extension.path, text: extension.path });
    scalars(extension.value, extension.path, leaves);
  }
  for (const leaf of leaves) {
    if (HOST_PATH.test(leaf.text)) fail(leaf.path, "contract must not contain an absolute host path");
    // `service_manifest.messaging.secret_env` is the ONE credential-shaped key
    // this contract may carry, and it carries environment KEY NAMES
    // (`TELEGRAM_BOT_TOKEN`), never a value: the systemd observer checks that a
    // verified platform's delta REFERENCES them and reads nothing else. The
    // exemption is bounded, not blanket: `validateServiceManifest` refuses
    // anything under it that is not an upper-case environment key, so a value
    // cannot shelter there, and the value scan below still runs over it.
    if (SECRET_KEY.test(leaf.path) && !leaf.path.startsWith(SERVICE_SECRET_ENV_PATH)) fail(leaf.path, "contract must not carry credential-shaped keys");
    if (SECRET_VALUE.some((pattern) => pattern.test(leaf.text))) fail(leaf.path, "contract must not carry a credential-shaped value");
    if ((FLEET_FORBIDDEN_KEYS as readonly string[]).includes(leaf.text)) fail(leaf.path, `forbidden key name: ${leaf.text}`);
  }
  // A poisoned key that reached here as data is a hard stop: continuing would
  // run every later rule over a tree an attacker chose the shape of.
  if (findings.length) return findings;

  const owners = new Set<string>();
  // field path -> the single authority block that declares it writable. Built
  // here so projections can be checked against real declarations rather than
  // against a regex that would happily accept `project.{slug}.repo_path`.
  const fieldIndex = new Map<string, { id: string; owner: string; store: string }>();
  const authorities = policy.authorities;
  if (!isRecord(authorities) || Object.keys(authorities).length === 0) {
    fail("authorities", "authorities must be a non-empty mapping");
  } else {
    for (const [id, entry] of Object.entries(authorities)) {
      const at = `authorities.${id}`;
      if (!isRecord(entry)) { fail(at, "authority must be a mapping"); continue; }
      for (const key of Object.keys(entry)) {
        if (!(FLEET_AUTHORITY_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown authority key");
      }
      const owner = entry.owner;
      if (typeof owner !== "string" || !OWNER_NAME.test(owner)) fail(`${at}.owner`, "owner must be a lower-kebab identifier");
      else owners.add(owner);
      if (typeof entry.store !== "string" || entry.store.length === 0) fail(`${at}.store`, "store must be a non-empty name");
      const readOnly = entry.read_only;
      if (readOnly !== undefined && typeof readOnly !== "boolean") fail(`${at}.read_only`, "read_only must be a boolean");
      const storeEnv = entry.store_env;
      // A read-only observation surface has no store to resolve, so demanding
      // an env key there only produced a plausible-looking lie -- process
      // inventory does not come from HERMES_FLEET_HOME.
      if (!stringList(storeEnv)) fail(`${at}.store_env`, "store_env must be a list of environment keys");
      else if (storeEnv.length === 0 && readOnly !== true) fail(`${at}.store_env`, "store_env may only be empty on a read-only authority");
      else storeEnv.forEach((key, index) => { if (!ENV_KEY.test(key)) fail(`${at}.store_env[${index}]`, `not an environment key: ${key}`); });
      if (entry.notes !== undefined && !stringList(entry.notes)) fail(`${at}.notes`, "notes must be a list of strings");
      const fields = entry.writable_fields;
      if (!Array.isArray(fields)) { fail(`${at}.writable_fields`, "writable_fields must be a list"); continue; }
      const seen = new Set<string>();
      fields.forEach((field: unknown, index: number) => {
        const where = `${at}.writable_fields[${index}]`;
        if (typeof field !== "string" || !FIELD_PATH.test(field)) { fail(where, "not a dotted field path"); return; }
        if (seen.has(field)) fail(where, `duplicate field path: ${field}`);
        seen.add(field);
        if (typeof owner === "string" && typeof entry.store === "string" && !fieldIndex.has(field)) {
          fieldIndex.set(field, { id, owner, store: entry.store });
        }
      });
      if (readOnly === true && fields.length > 0) {
        fail(`${at}.writable_fields`, "a read-only authority may not declare writable fields");
      }
    }
  }

  const projections = policy.projections;
  if (!Array.isArray(projections)) fail("projections", "projections must be a list");
  else {
    const seenPairs = new Map<string, number>();
    const seenTargets = new Map<string, number>();
    projections.forEach((entry: unknown, index: number) => {
      const at = `projections[${index}]`;
      if (!isRecord(entry)) { fail(at, "projection must be a mapping"); return; }
      for (const key of Object.keys(entry)) {
        if (!(FLEET_PROJECTION_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown projection key");
      }
      for (const key of ["field", "source", "target"] as const) {
        const value = entry[key];
        if (typeof value !== "string" || value.length === 0) fail(`${at}.${key}`, `${key} must be a non-empty string`);
        else if (key !== "field" && !FIELD_PATH.test(value)) fail(`${at}.${key}`, "not a dotted field path");
      }
      const source = entry.source;
      const target = entry.target;
      const writableBy = entry.writable_by;
      if (typeof writableBy !== "string" || !owners.has(writableBy)) {
        fail(`${at}.writable_by`, "writable_by must name exactly one declared authority owner");
      }
      if (typeof source !== "string" || typeof target !== "string") return;

      if (source === target) fail(`${at}.target`, "a projection must cross two field paths, not point at itself");
      const pair = `${source} -> ${target}`;
      const previous = seenPairs.get(pair);
      if (previous !== undefined) fail(`${at}`, `duplicate projection: ${pair} is already declared at projections[${previous}]`);
      else seenPairs.set(pair, index);

      // One direction, one upstream. These two are the whole point of the
      // block: the reverse pair makes a field bidirectional, and a second
      // source feeding one target gives that field two upstream truths -- which
      // is exactly the overlap this contract was written to end.
      const reverse = seenPairs.get(`${target} -> ${source}`);
      if (reverse !== undefined && reverse !== index) {
        fail(`${at}.direction`, `a field pair may flow in one direction only; the reverse is declared at projections[${reverse}]`);
      }
      const fedBy = seenTargets.get(target);
      if (fedBy !== undefined) fail(`${at}.target`, `${target} is already fed by projections[${fedBy}]`);
      else seenTargets.set(target, index);

      // Referential integrity. Both ends must be fields some authority really
      // declares, and the target must be writable by the owner this projection
      // names -- otherwise `writable_by` is a label nobody has to honour, and a
      // typo in a path is indistinguishable from a real declaration.
      const from = fieldIndex.get(source);
      const to = fieldIndex.get(target);
      if (!from) fail(`${at}.source`, `${source} is not declared writable by any authority`);
      if (!to) fail(`${at}.target`, `${target} is not declared writable by any authority`);
      if (!from || !to) return;
      if (typeof writableBy === "string" && owners.has(writableBy) && to.owner !== writableBy) {
        fail(`${at}.writable_by`, `${writableBy} does not declare ${target} writable; ${to.owner} does`);
      }

      // Direction is DERIVED from the two stores, never trusted as prose. The
      // pattern check it replaces accepted a direction that was backwards, and
      // accepted a three-hop chain, because `[a-z0-9_]+` swallows `_to_`.
      if (from.store === to.store) {
        fail(`${at}.direction`, `a projection must cross two stores; both ends live in ${from.store}`);
        return;
      }
      const expected = `${storeToken(from.store)}_to_${storeToken(to.store)}`;
      const direction = entry.direction;
      if (typeof direction !== "string" || !DIRECTION.test(direction)) {
        fail(`${at}.direction`, `direction must be ${expected}`);
      } else if (direction !== expected) {
        fail(`${at}.direction`, `direction is ${direction} but ${source} -> ${target} flows ${expected}`);
      }
    });
  }

  const classifications = policy.classifications;
  if (!isRecord(classifications)) fail("classifications", "classifications must be a mapping");
  else {
    for (const key of Object.keys(classifications)) {
      if (!(FLEET_CLASSIFICATION_IDS as readonly string[]).includes(key)) fail(`classifications.${key}`, "unknown lifecycle class");
    }
    for (const id of FLEET_CLASSIFICATION_IDS) {
      const at = `classifications.${id}`;
      const entry = classifications[id];
      if (!isRecord(entry)) { fail(at, "lifecycle class is missing or is not a mapping"); continue; }
      for (const key of Object.keys(entry)) {
        if (!(FLEET_CLASSIFICATION_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown lifecycle class key");
      }
      const required = entry.required_fields;
      if (!stringList(required) || required.length === 0) fail(`${at}.required_fields`, "required_fields must be a non-empty list of names");
      const entries = entry.entries;
      if (!Array.isArray(entries)) fail(`${at}.entries`, "entries must be a list");
      else entries.forEach((item: unknown, index: number) => { if (!isRecord(item)) fail(`${at}.entries[${index}]`, "entry must be a mapping"); });
      if (entry.notes !== undefined && !stringList(entry.notes)) fail(`${at}.notes`, "notes must be a list of strings");
    }
  }

  const service = policy.service_model;
  if (!isRecord(service)) fail("service_model", "service_model must be a mapping");
  else {
    for (const key of ["per_agent", "fleet_shared", "profile_layout"] as const) {
      if (!isRecord(service[key])) fail(`service_model.${key}`, `${key} must be a mapping`);
    }
    const perAgent = isRecord(service.per_agent) ? service.per_agent : {};
    for (const key of ["gateway_unit", "heartbeat_service", "heartbeat_timer"] as const) {
      const value = perAgent[key];
      if (typeof value !== "string" || value.length === 0) fail(`service_model.per_agent.${key}`, `${key} must be a unit name pattern`);
      else if (!value.includes("{agent_id}")) fail(`service_model.per_agent.${key}`, "a per-agent unit pattern must carry the {agent_id} placeholder");
    }
    // Three names for three roles. Collapsed to one string they all validate,
    // and a provisioner then writes one unit where the contract declares two.
    const unitNames = ["gateway_unit", "heartbeat_service", "heartbeat_timer"]
      .map((key) => perAgent[key]).filter((value): value is string => typeof value === "string" && value.length > 0);
    if (unitNames.length === 3 && new Set(unitNames).size !== 3) {
      fail("service_model.per_agent", "gateway_unit, heartbeat_service and heartbeat_timer must be three distinct patterns");
    }
    const shared = isRecord(service.fleet_shared) ? service.fleet_shared : {};
    for (const key of ["bloodbank_gateway_unit", "bloodbank_gateway_profile", "command_subject", "target_field"] as const) {
      const value = shared[key];
      if (typeof value !== "string" || value.length === 0) fail(`service_model.fleet_shared.${key}`, `${key} must be a non-empty string`);
    }
    const layout = isRecord(service.profile_layout) ? service.profile_layout : {};
    if (typeof layout.root !== "string" || layout.root.length === 0) fail("service_model.profile_layout.root", "root must be a non-empty path pattern");
    // Without the placeholder every profile resolves to one directory, which
    // collapses profile identity exactly as a symlinked root would.
    else if (!layout.root.includes("{profile_name}")) fail("service_model.profile_layout.root", "a profile root must carry the {profile_name} placeholder");
    // A symlinked profile root loses profile identity and shared auth, so the
    // contract may not leave that as a permitted shape.
    if (layout.symlink_allowed !== false) fail("service_model.profile_layout.symlink_allowed", "symlink_allowed must be declared false");
    for (const key of ["identity_file", "override_file", "generated_file"] as const) {
      const value = layout[key];
      if (typeof value !== "string" || value.length === 0) fail(`service_model.profile_layout.${key}`, `${key} must be a non-empty file name`);
    }
    // The override file is the operator-owned SSOT and the generated file is
    // rewritten by the renderer. Declaring the same name for both tells the
    // renderer to overwrite the only file a human is supposed to edit.
    const layoutFiles = ["identity_file", "override_file", "generated_file"]
      .map((key) => layout[key]).filter((value): value is string => typeof value === "string" && value.length > 0);
    if (layoutFiles.length === 3 && new Set(layoutFiles).size !== 3) {
      fail("service_model.profile_layout", "identity_file, override_file and generated_file must be three distinct names");
    }
  }

  const activation = policy.activation;
  if (!isRecord(activation)) fail("activation", "activation must be a mapping");
  else {
    const states = activation.states;
    if (!stringList(states) || states.length !== FLEET_ACTIVATION_STATES.length || states.some((state, index) => state !== FLEET_ACTIVATION_STATES[index])) {
      fail("activation.states", `states must be exactly [${FLEET_ACTIVATION_STATES.join(", ")}]`);
    }
    const authority = activation.execution_authority;
    if (!isRecord(authority)) fail("activation.execution_authority", "execution_authority must be a mapping");
    else {
      const field = authority.field;
      if (typeof field !== "string" || !FIELD_PATH.test(field)) fail("activation.execution_authority.field", "field must be a dotted field path");
      if (typeof authority.strict !== "boolean") fail("activation.execution_authority.strict", "strict must be a boolean");
      if (typeof authority.default !== "string" || authority.default.length === 0) fail("activation.execution_authority.default", "default must be a non-empty decision");
      const owner = authority.owner;
      if (typeof owner !== "string" || !owners.has(owner)) fail("activation.execution_authority.owner", "owner must name a declared authority owner");
      else if (typeof field === "string" && isRecord(authorities)) {
        // Discovery is not dispatch. Checking only that SOME block with this
        // owner writes the field was not enough: `hermes-agent-registry` owns
        // both the operational records and the activation flag, so pointing the
        // gate at `bloodbank.gateway_scope` -- a pure discovery field -- passed.
        // The gate must be the sole field of its own authority block, which is
        // what makes the block a gate rather than a label.
        const declaring = Object.entries(authorities).filter(([, value]) => (
          isRecord(value) && Array.isArray(value.writable_fields) && value.writable_fields.includes(field)
        ));
        const holder = declaring[0];
        // More than one declarer is a dual-ownership problem, and the conflict
        // stage says it far better -- it names both blocks and both owners.
        // Complaining here first would swap a precise AUTHORITY_CONFLICT for a
        // vague INVALID_INPUT about the same fact.
        if (declaring.length > 1) { /* validateAuthorityConflicts owns this */ }
        else if (!holder) {
          fail("activation.execution_authority.field", `${field} is not declared writable by any authority`);
        } else if (!isRecord(holder[1]) || holder[1].owner !== owner) {
          fail("activation.execution_authority.field", `${field} is not declared writable by ${owner}`);
        } else if (!Array.isArray(holder[1].writable_fields) || holder[1].writable_fields.length !== 1) {
          fail(
            "activation.execution_authority.field",
            `authorities.${holder[0]} must declare ${field} and nothing else; an authority that also writes discovery metadata cannot be the execution gate`,
          );
        }
      }
    }
  }

  const retired = policy.retired;
  if (!Array.isArray(retired)) fail("retired", "retired must be a list");
  else {
    const ids = new Set<string>();
    retired.forEach((entry: unknown, index: number) => {
      const at = `retired[${index}]`;
      if (!isRecord(entry)) { fail(at, "retired mode must be a mapping"); return; }
      for (const key of Object.keys(entry)) {
        if (!(FLEET_RETIRED_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown retired-mode key");
      }
      for (const key of ["id", "reason", "superseded_by"] as const) {
        const value = entry[key];
        if (typeof value !== "string" || value.length === 0) fail(`${at}.${key}`, `${key} must be a non-empty string`);
      }
      // A duplicate id satisfies the completeness loop below with a stub, so a
      // real mode can be deleted and the contract still validates -- taking its
      // `detect` patterns, and therefore its detection, with it.
      if (typeof entry.id === "string") {
        if (ids.has(entry.id)) fail(`${at}.id`, `duplicate retired mode id: ${entry.id}`);
        ids.add(entry.id);
      }
      // `superseded_by` is the only thing a RETIRED_MODE diagnostic tells an
      // operator to do next. Unresolved, it rots silently on the first rename.
      if (typeof entry.superseded_by === "string" && entry.superseded_by.length > 0
          && resolveContractPath(policy, entry.superseded_by) === undefined) {
        fail(`${at}.superseded_by`, `${entry.superseded_by} does not resolve to a declared contract path`);
      }
      const detect = entry.detect;
      if (!stringList(detect) || detect.length === 0) { fail(`${at}.detect`, "detect must be a non-empty list of patterns"); return; }
      detect.forEach((pattern, patternIndex) => {
        // Every pattern here runs against every scalar leaf in the contract.
        // `--contract` is advertised for validating candidate files, so the
        // pattern list is operator input: `^(a+)+$` against a 40-character note
        // pinned a core and never returned. Refuse the shape rather than run it
        // -- a validator that hangs gives a worse answer than one that says no.
        if (pattern.length > FLEET_DETECT_MAX_PATTERN_BYTES) {
          fail(`${at}.detect[${patternIndex}]`, `detect pattern exceeds ${FLEET_DETECT_MAX_PATTERN_BYTES} characters`);
          return;
        }
        if (NESTED_QUANTIFIER.test(pattern)) {
          fail(`${at}.detect[${patternIndex}]`, "detect pattern nests a quantifier inside a quantified group and may backtrack catastrophically");
          return;
        }
        try { new RegExp(pattern, "iu"); }
        catch { fail(`${at}.detect[${patternIndex}]`, "detect pattern is not a valid regular expression"); }
      });
    });
    for (const id of FLEET_RETIRED_IDS) {
      if (!ids.has(id)) fail("retired", `retired must declare the superseded mode ${id}`);
    }
  }

  return findings;
}

function validateAuthorityConflicts(contract: FleetContract): FleetDiagnostic[] {
  // Claims are keyed on the AUTHORITY BLOCK, not the owner name. Keying on the
  // owner meant `bloodbank_activation` and `agent_operational_records` -- both
  // owned by `hermes-agent-registry` -- could each claim the activation flag
  // and agree, which silently collapses the discovery/execution split those two
  // blocks exist to keep apart. A field belongs to exactly one block.
  //
  // Projection targets are NOT claimed here any more; referential integrity in
  // the structure stage ties a projection to the block that declares its
  // target, so re-claiming it would report every healthy projection as a
  // conflict with itself.
  const claims = new Map<string, Array<{ id: string; owner: string }>>();
  for (const [id, authority] of Object.entries(contract.authorities)) {
    for (const field of authority.writable_fields) {
      const existing = claims.get(field);
      if (existing) existing.push({ id, owner: authority.owner });
      else claims.set(field, [{ id, owner: authority.owner }]);
    }
  }

  const findings: FleetDiagnostic[] = [];
  for (const field of [...claims.keys()].sort()) {
    const claimants = (claims.get(field) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (claimants.length > 1) {
      findings.push({
        code: "AUTHORITY_CONFLICT",
        path: `authorities.writable_fields.${field}`,
        message: `${field} claimed writable by: ${claimants.map((claim) => `${claim.id} (${claim.owner})`).join(", ")}`,
      });
    }
  }
  return findings;
}

function validateClassifications(contract: FleetContract): FleetDiagnostic[] {
  const findings: FleetDiagnostic[] = [];
  for (const id of FLEET_CLASSIFICATION_IDS) {
    const classification = contract.classifications[id];
    if (!classification) continue;
    const declared = new Set(classification.required_fields);
    // `managed_agent` is exempt: a registered agent row is not an exception
    // someone chose to keep, so it owes no rationale for existing.
    if (id !== "managed_agent") {
      for (const field of FLEET_CLASSIFICATION_REQUIRED_FIELDS) {
        if (!declared.has(field)) {
          findings.push({
            code: "INVALID_CLASSIFICATION",
            path: `classifications.${id}.required_fields`,
            message: `${id} must require ${field}`,
          });
        }
      }
    }
    classification.entries.forEach((entry, index) => {
      const name = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `#${index}`;
      for (const field of classification.required_fields) {
        const value = entry[field];
        const missing = value === undefined || value === null
          || (typeof value === "string" && value.trim() === "")
          || (Array.isArray(value) && value.length === 0);
        if (missing) {
          findings.push({
            code: "INVALID_CLASSIFICATION",
            path: `classifications.${id}.entries[${index}].${field}`,
            message: `${id} entry ${name} is missing required field ${field}`,
          });
        }
      }
    });
  }
  return findings;
}

function validateRetiredModes(contract: FleetContract): FleetDiagnostic[] {
  const findings: FleetDiagnostic[] = [];

  // Default-deny is the whole point of the activation gate. A contract that
  // relaxes either half has re-declared activation-by-discovery as healthy.
  const authority = contract.activation.execution_authority;
  if (authority.default !== "deny") {
    findings.push({
      code: "RETIRED_MODE",
      path: "activation.execution_authority.default",
      message: `activation-by-discovery: execution authority defaults to "${authority.default}" instead of deny`,
    });
  }
  if (authority.strict !== true) {
    findings.push({
      code: "RETIRED_MODE",
      path: "activation.execution_authority.strict",
      message: "activation-by-discovery: execution authority must be strict, so an absent or coercible flag never grants dispatch",
    });
  }

  // Everything a contract asserts is HEALTHY gets scanned. The first cut read
  // only service_model/activation/classifications, so a retired unit smuggled
  // into an authority's writable_fields, a projection targeting a checkpoint
  // timer, or `store: n8n-workflow-store` all validated clean.
  const leaves: Array<{ path: string; text: string }> = [];
  const tree = contract as unknown as Record<string, unknown>;
  for (const section of FLEET_HEALTHY_SECTIONS) scalars(tree[section], section, leaves);
  // Classifications selectively: `retired` and `intentionally_unmanaged` exist
  // to RECORD a sighting of exactly these patterns. Scanning them would make
  // the two classes unusable for their only job.
  for (const id of FLEET_HEALTHY_CLASSIFICATIONS) {
    const classification = contract.classifications?.[id];
    if (classification) scalars(classification.entries, `classifications.${id}.entries`, leaves);
  }
  const seen = new Set<string>();
  for (const mode of contract.retired) {
    for (const pattern of mode.detect) {
      let expression: RegExp;
      try { expression = new RegExp(pattern, "iu"); } catch { continue; }
      for (const leaf of leaves) {
        if (!expression.test(leaf.text)) continue;
        // `\u0000` as an ESCAPE, never a literal NUL byte. A raw NUL makes `file`
        // call this source `data` and makes GNU grep treat it as binary -- which
        // silently no-ops the machine-wide pre-commit secret scan, since that
        // scan greps the unified diff, for every commit touching this file.
        const key = `${leaf.path}\u0000${mode.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          code: "RETIRED_MODE",
          path: leaf.path,
          message: `declares the retired mode ${mode.id} as healthy; superseded by ${mode.superseded_by}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Validate the optional `health_policy` block.
 *
 * OPTIONAL, and that is load-bearing: a schema-1 contract carries no block at
 * all and must still validate. What it may not do is carry a block that LIES --
 * a domain nobody declares, a `max_age_days` that is not a positive whole
 * number of days, a deferral with no owner, or a freshness entry about a field
 * no authority writes. An unvalidated policy block is a policy that stops
 * authorizing anything the moment somebody typos a domain name, and it fails
 * open: every gap it was supposed to justify silently becomes unjustified.
 *
 * Runs LAST of the six stages. Everything it checks is expressed in terms of
 * the authorities and domains the earlier stages have already proven well
 * formed, so running it first would mean re-deriving them from a tree nobody
 * had validated.
 */
function validateHealthPolicy(policy: Record<string, unknown>): FleetDiagnostic[] {
  const block = policy.health_policy;
  if (block === undefined) return [];

  const findings: FleetDiagnostic[] = [];
  const fail = (path: string, message: string): void => { findings.push({ code: "INVALID_INPUT", path, message }); };
  if (!isRecord(block)) {
    fail("health_policy", "health_policy must be a mapping");
    return findings;
  }
  for (const key of Object.keys(block)) {
    if (!(FLEET_HEALTH_POLICY_KEYS as readonly string[]).includes(key)) fail(`health_policy.${key}`, "unknown health_policy key");
  }

  const domains = FLEET_STATUS_DOMAINS as readonly string[];
  const requireDomain = (value: unknown, at: string): void => {
    if (typeof value !== "string" || !domains.includes(value)) {
      fail(at, `must name one of ${domains.join(", ")}`);
    }
  };

  // Every field a policy entry addresses has to be a field some authority
  // declares writable. Without this, `board_confirmd_at` is a freshness policy
  // that matches nothing and reports every row `not_applicable` forever.
  const declaredFields = new Set<string>();
  const authorities = policy.authorities;
  if (isRecord(authorities)) {
    for (const entry of Object.values(authorities)) {
      if (!isRecord(entry) || !Array.isArray(entry.writable_fields)) continue;
      for (const field of entry.writable_fields) if (typeof field === "string") declaredFields.add(field);
    }
  }

  const required = block.required_domains;
  if (required !== undefined) {
    if (!Array.isArray(required)) fail("health_policy.required_domains", "required_domains must be a list");
    else {
      const seen = new Set<string>();
      required.forEach((value: unknown, index: number) => {
        const at = `health_policy.required_domains[${index}]`;
        requireDomain(value, at);
        if (typeof value !== "string") return;
        if (seen.has(value)) fail(at, `duplicate required domain: ${value}`);
        seen.add(value);
      });
    }
  }

  const deferred = block.deferred_capabilities;
  if (deferred !== undefined) {
    if (!Array.isArray(deferred)) fail("health_policy.deferred_capabilities", "deferred_capabilities must be a list");
    else {
      const seen = new Set<string>();
      deferred.forEach((entry: unknown, index: number) => {
        const at = `health_policy.deferred_capabilities[${index}]`;
        if (!isRecord(entry)) { fail(at, "deferred capability must be a mapping"); return; }
        for (const key of Object.keys(entry)) {
          if (!(FLEET_HEALTH_POLICY_DEFERRED_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown deferred_capabilities key");
        }
        requireDomain(entry.domain, `${at}.domain`);
        if (entry.capability !== undefined && (typeof entry.capability !== "string" || entry.capability.length === 0)) {
          fail(`${at}.capability`, "capability must be a non-empty name when it is declared");
        }
        // Both required, and this is the whole point of the entry: a deferral
        // that names no reason and no owning story is an excuse, and nothing
        // downstream can tell an operator when it stops being true.
        for (const key of ["reason", "owner_story"] as const) {
          const value = entry[key];
          if (typeof value !== "string" || value.trim().length === 0) fail(`${at}.${key}`, `${key} must be a non-empty string`);
        }
        const key = `${String(entry.domain)} ${typeof entry.capability === "string" ? entry.capability : ""}`;
        if (seen.has(key)) fail(at, "duplicate deferred capability: the same domain and capability is already declared");
        seen.add(key);
      });
    }
  }

  const warnings = block.allowed_warnings;
  if (warnings !== undefined) {
    if (!Array.isArray(warnings)) fail("health_policy.allowed_warnings", "allowed_warnings must be a list");
    else {
      warnings.forEach((entry: unknown, index: number) => {
        const at = `health_policy.allowed_warnings[${index}]`;
        if (!isRecord(entry)) { fail(at, "allowed warning must be a mapping"); return; }
        for (const key of Object.keys(entry)) {
          if (!(FLEET_HEALTH_POLICY_WARNING_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown allowed_warnings key");
        }
        for (const key of ["rule_id", "reason", "owner"] as const) {
          const value = entry[key];
          if (typeof value !== "string" || value.trim().length === 0) fail(`${at}.${key}`, `${key} must be a non-empty string`);
        }
      });
    }
  }

  const skips = block.allowed_skips;
  if (skips !== undefined) {
    if (!Array.isArray(skips)) fail("health_policy.allowed_skips", "allowed_skips must be a list");
    else {
      skips.forEach((entry: unknown, index: number) => {
        const at = `health_policy.allowed_skips[${index}]`;
        if (!isRecord(entry)) { fail(at, "allowed skip must be a mapping"); return; }
        for (const key of Object.keys(entry)) {
          if (!(FLEET_HEALTH_POLICY_SKIP_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown allowed_skips key");
        }
        const hasDomain = entry.domain !== undefined;
        const hasRule = entry.rule_id !== undefined;
        // Exactly one subject. An entry with neither matches nothing; an entry
        // with both is two policies wearing one reason, and only one of them
        // would ever be the one an operator meant.
        if (hasDomain === hasRule) fail(at, "an allowed skip must name exactly one of domain or rule_id");
        if (hasDomain) requireDomain(entry.domain, `${at}.domain`);
        if (hasRule && (typeof entry.rule_id !== "string" || entry.rule_id.trim().length === 0)) {
          fail(`${at}.rule_id`, "rule_id must be a non-empty string");
        }
        if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) fail(`${at}.reason`, "reason must be a non-empty string");
      });
    }
  }

  const freshness = block.freshness;
  if (freshness !== undefined) {
    if (!Array.isArray(freshness)) fail("health_policy.freshness", "freshness must be a list");
    else {
      const seen = new Set<string>();
      freshness.forEach((entry: unknown, index: number) => {
        const at = `health_policy.freshness[${index}]`;
        if (!isRecord(entry)) { fail(at, "freshness entry must be a mapping"); return; }
        for (const key of Object.keys(entry)) {
          if (!(FLEET_HEALTH_POLICY_FRESHNESS_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown freshness key");
        }
        const field = entry.field;
        if (typeof field !== "string" || !FIELD_PATH.test(field)) fail(`${at}.field`, "field must be a dotted field path");
        else if (!declaredFields.has(field)) fail(`${at}.field`, `${field} is not declared writable by any authority`);
        else if (seen.has(field)) fail(`${at}.field`, `duplicate freshness policy for ${field}`);
        else seen.add(field);
        const age = entry.max_age_days;
        // A whole number of DAYS, and positive. A zero or a fraction would make
        // every reading stale or make the bucket depend on the hour a run
        // happened to start, and `data` has to be byte-identical across two
        // consecutive runs.
        if (!Number.isSafeInteger(age) || Number(age) <= 0) fail(`${at}.max_age_days`, "max_age_days must be a positive whole number of days");
        requireDomain(entry.applies_to, `${at}.applies_to`);
      });
    }
  }

  const exceptions = block.agent_exceptions;
  if (exceptions !== undefined) {
    if (!Array.isArray(exceptions)) fail("health_policy.agent_exceptions", "agent_exceptions must be a list");
    else {
      const seen = new Set<string>();
      exceptions.forEach((entry: unknown, index: number) => {
        const at = `health_policy.agent_exceptions[${index}]`;
        if (!isRecord(entry)) { fail(at, "agent exception must be a mapping"); return; }
        for (const key of Object.keys(entry)) {
          if (!(FLEET_HEALTH_POLICY_AGENT_EXCEPTION_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown agent_exceptions key");
        }
        requireDomain(entry.domain, `${at}.domain`);
        // An agent id is one registry KEY: a safe single token, never a path,
        // never blank. A ruling on a blank id would match nothing and look
        // like it ruled on everything.
        if (typeof entry.agent_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.agent_id)) {
          fail(`${at}.agent_id`, "agent_id must be a registry key: letters, digits, dots, underscores or hyphens");
        }
        for (const key of ["reason", "owner"] as const) {
          const value = entry[key];
          if (typeof value !== "string" || value.trim().length === 0) fail(`${at}.${key}`, `${key} must be a non-empty string`);
        }
        // `\u0000` as an ESCAPE, never a literal NUL byte (see validateRetiredModes).
        const key = `${String(entry.domain)}\u0000${String(entry.agent_id)}`;
        if (seen.has(key)) fail(at, "duplicate agent exception: the same domain and agent_id is already ruled on");
        seen.add(key);
      });
    }
  }

  return findings;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const RENDER_INPUT_NAME = /^[a-z_][a-z0-9_]*$/u;

/**
 * One root-entry glob (`*` and `?` only) as a regular expression over a whole
 * name. Each `*` is a capturing group, so a caller that needs the stem a
 * leading `*` matched can read it. The ONE glob grammar: the profile observer
 * matches the ignore and backup lists with this same function, so the ignore
 * list this validator proves covers the lock pattern is matched by the same
 * rule at sweep time.
 */
export function rootEntryGlob(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "(.*)").replace(/\?/gu, ".");
  return new RegExp(`^${escaped}$`, "u");
}

/** A relative path that stays inside the tree it is relative to: no leading `/`, no `.`/`..` segment, no blank segment. */
function relativeInside(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.replace(/\/+$/u, "").split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Validate the optional `scaffold_manifest` block (schema 3).
 *
 * OPTIONAL: a schema-1/2 contract carries none and still loads; the scaffold
 * observer then reports every agent `unsupported` with capability
 * `scaffold.manifest`. What it may not do is carry a manifest that points at
 * nothing: a group key no authority declares writable (then `authority.ownerOf`
 * would resolve nobody for a real observation), a presence-only path that
 * resolves to no group, a render input fed by a field no authority writes, a
 * pattern list that would exclude everything. A manifest that matches nothing
 * must fail to load rather than compare nothing and report it as parity.
 *
 * Runs after `validateHealthPolicy`, for the same reason that stage runs after
 * the structural ones: everything here is expressed in terms of authorities the
 * earlier stages have proven well formed.
 */
function validateScaffoldManifest(policy: Record<string, unknown>): FleetDiagnostic[] {
  const block = policy.scaffold_manifest;
  if (block === undefined) return [];

  const findings: FleetDiagnostic[] = [];
  const fail = (path: string, message: string): void => { findings.push({ code: "INVALID_INPUT", path, message }); };
  if (!isRecord(block)) {
    fail("scaffold_manifest", "scaffold_manifest must be a mapping");
    return findings;
  }
  for (const key of Object.keys(block)) {
    if (!(FLEET_SCAFFOLD_MANIFEST_KEYS as readonly string[]).includes(key)) fail(`scaffold_manifest.${key}`, "unknown scaffold_manifest key");
  }
  for (const key of ["template_submodule", "template_subdirectory"] as const) {
    if (!relativeInside(block[key]) || (block[key] as string).endsWith("/")) fail(`scaffold_manifest.${key}`, `${key} must be a relative path inside the repository`);
  }
  const suffix = block.render_suffix;
  if (typeof suffix !== "string" || !/^\.[A-Za-z0-9]+$/u.test(suffix)) fail("scaffold_manifest.render_suffix", "render_suffix must be a dotted extension such as .jinja");
  const runtimeDir = block.runtime_dir;
  if (typeof runtimeDir !== "string" || !SAFE_SEGMENT.test(runtimeDir)) fail("scaffold_manifest.runtime_dir", "runtime_dir must be one safe path segment");

  // Every field a render input names has to be one some authority declares
  // writable, under one of the two roots the observer can resolve. A render
  // input fed by nothing would make every rendered asset `incomplete` forever
  // and read as though the template needed something the registry lacks.
  const declaredFields = new Set<string>();
  const authorities = policy.authorities;
  if (isRecord(authorities)) {
    for (const entry of Object.values(authorities)) {
      if (!isRecord(entry) || !Array.isArray(entry.writable_fields)) continue;
      for (const field of entry.writable_fields) if (typeof field === "string") declaredFields.add(field);
    }
  }
  const inputs = block.render_inputs;
  if (!isRecord(inputs)) fail("scaffold_manifest.render_inputs", "render_inputs must be a mapping of placeholder name to field path");
  else {
    for (const [name, field] of Object.entries(inputs)) {
      const at = `scaffold_manifest.render_inputs.${name}`;
      if (!RENDER_INPUT_NAME.test(name)) fail(at, "a render input name must be a lower-case identifier");
      if (typeof field !== "string" || !FIELD_PATH.test(field)) { fail(at, "must be a dotted field path"); continue; }
      const resolvable = field === "agents.{agent_id}"
        || ((field.startsWith("agents.{agent_id}.") || field.startsWith("projects.{slug}.")) && declaredFields.has(field));
      if (!resolvable) fail(at, `${field} is not agents.{agent_id} or a declared agents.{agent_id}.* / projects.{slug}.* writable field`);
    }
  }

  const groups = block.groups;
  const groupTable: Record<string, string> = {};
  if (!isRecord(groups) || Object.keys(groups).length === 0) fail("scaffold_manifest.groups", "groups must be a non-empty mapping of declared leaf to role-relative path");
  else {
    const seenPaths = new Map<string, string>();
    for (const [leaf, rolePath] of Object.entries(groups)) {
      const at = `scaffold_manifest.groups.${leaf}`;
      // The key IS a contract leaf: it must be a field some authority declares
      // writable, or an observation filed under it would resolve no owner.
      if (!declaredFields.has(leaf)) fail(at, `${leaf} is not declared writable by any authority`);
      if (!relativeInside(rolePath)) { fail(at, "must be a role-relative path; a trailing / owns a directory"); continue; }
      const previous = seenPaths.get(rolePath);
      if (previous !== undefined) fail(at, `duplicate group path ${rolePath}, already owned by ${previous}`);
      else seenPaths.set(rolePath, leaf);
      groupTable[leaf] = rolePath;
    }
  }

  const presence = block.presence_only;
  if (presence !== undefined) {
    if (!Array.isArray(presence)) fail("scaffold_manifest.presence_only", "presence_only must be a list");
    else {
      const seen = new Set<string>();
      presence.forEach((entry: unknown, index: number) => {
        const at = `scaffold_manifest.presence_only[${index}]`;
        if (!isRecord(entry)) { fail(at, "presence_only entry must be a mapping"); return; }
        for (const key of Object.keys(entry)) {
          if (!(FLEET_SCAFFOLD_PRESENCE_ONLY_KEYS as readonly string[]).includes(key)) fail(`${at}.${key}`, "unknown presence_only key");
        }
        const path = entry.path;
        if (!relativeInside(path) || path.endsWith("/")) fail(`${at}.path`, "path must be a role-relative file path");
        else if (Object.keys(groupTable).length > 0 && groupFor(path, groupTable) === null) fail(`${at}.path`, `${path} resolves to no declared group`);
        else if (seen.has(path)) fail(`${at}.path`, `duplicate presence_only path ${path}`);
        else seen.add(path);
        // A presence-only asset is a decision not to compare content, and a
        // decision needs a reason an operator can read.
        if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) fail(`${at}.reason`, "reason must be a non-empty string");
      });
    }
  }

  const excluded = block.excluded_patterns;
  if (excluded !== undefined) {
    if (!Array.isArray(excluded)) fail("scaffold_manifest.excluded_patterns", "excluded_patterns must be a list");
    else {
      excluded.forEach((pattern: unknown, index: number) => {
        const at = `scaffold_manifest.excluded_patterns[${index}]`;
        if (typeof pattern !== "string" || pattern.trim() === "" || pattern === "/" || pattern.startsWith("/")) { fail(at, "an excluded pattern must be a non-empty segment glob"); return; }
        // `*` alone would exclude every path and read a real template as
        // contaminated on its first file; `**` is not a segment glob.
        if (/^\*+\/?$/u.test(pattern) || pattern.includes("**")) fail(at, "an excluded pattern may not match every segment");
      });
    }
  }

  return findings;
}

/** The field paths every authority declares writable, for the manifest stages to root-check against. */
function declaredWritableFields(policy: Record<string, unknown>): Set<string> {
  const declared = new Set<string>();
  const authorities = policy.authorities;
  if (isRecord(authorities)) {
    for (const entry of Object.values(authorities)) {
      if (!isRecord(entry) || !Array.isArray(entry.writable_fields)) continue;
      for (const field of entry.writable_fields) if (typeof field === "string") declared.add(field);
    }
  }
  return declared;
}

/** A profile-relative file path as the `profiles.{profile_name}.*` leaf that owns it: `hindsight/config.json` -> `hindsight.config.json`. */
function profileLeafFor(relativePath: string): string {
  return `profiles.{profile_name}.${relativePath.replace(/\/+$/u, "").split("/").join(".")}`;
}

/**
 * Validate the optional `profile_manifest` block (schema 4).
 *
 * OPTIONAL: a schema-1..3 contract carries none and still loads; the profile
 * observer then reports every selected agent's five profile fields
 * `unsupported` with capability `profile.manifest`. What it may not do is
 * carry a manifest that names nothing real: a renderer in a different
 * submodule from the scaffold's, a bank-id template with no `{profile_name}`
 * (then every profile would be told to pin the same bank), a `check_argv`
 * that never names the profile, a canonical skill directory spelled as an
 * absolute host path, a duplicate core skill, a file the observer would file
 * under a leaf no authority declares, or a limit above the ceiling this build
 * can honour. A policy that matches nothing must fail to load rather than
 * prove nothing and report it as health.
 */
function validateProfileManifest(policy: Record<string, unknown>): FleetDiagnostic[] {
  const block = policy.profile_manifest;
  if (block === undefined) return [];

  const findings: FleetDiagnostic[] = [];
  const fail = (path: string, message: string): void => { findings.push({ code: "INVALID_INPUT", path, message }); };
  if (!isRecord(block)) {
    fail("profile_manifest", "profile_manifest must be a mapping");
    return findings;
  }
  const closed = (node: unknown, at: string, keys: readonly string[]): node is Record<string, unknown> => {
    if (!isRecord(node)) { fail(at, `${at.split(".").pop()} must be a mapping`); return false; }
    for (const key of Object.keys(node)) {
      if (!keys.includes(key)) fail(`${at}.${key}`, `unknown ${at} key`);
    }
    for (const key of keys) {
      if (node[key] === undefined) fail(`${at}.${key}`, `${key} is required`);
    }
    return true;
  };
  const nonEmpty = (value: unknown, at: string): value is string => {
    if (typeof value !== "string" || value.trim().length === 0) { fail(at, "must be a non-empty string"); return false; }
    return true;
  };
  const uniqueList = (value: unknown, at: string, each: (item: string, where: string) => void): string[] => {
    if (!Array.isArray(value)) { fail(at, "must be a list"); return []; }
    const seen = new Set<string>();
    const out: string[] = [];
    value.forEach((item: unknown, index: number) => {
      const where = `${at}[${index}]`;
      if (typeof item !== "string" || item.length === 0) { fail(where, "must be a non-empty string"); return; }
      if (seen.has(item)) fail(where, `duplicate entry ${item}`);
      seen.add(item);
      each(item, where);
      out.push(item);
    });
    return out;
  };

  closed(block, "profile_manifest", FLEET_PROFILE_MANIFEST_KEYS);
  const declared = declaredWritableFields(policy);
  const requireDeclared = (leaf: string, at: string): void => {
    if (!declared.has(leaf)) fail(at, `${leaf} is not declared writable by any authority`);
  };

  // -- renderer ---------------------------------------------------------------
  const renderer = block.renderer;
  if (closed(renderer, "profile_manifest.renderer", FLEET_PROFILE_MANIFEST_RENDERER_KEYS)) {
    for (const key of ["submodule", "script", "lock_helper"] as const) {
      const value = renderer[key];
      if (!relativeInside(value) || value.endsWith("/")) fail(`profile_manifest.renderer.${key}`, `${key} must be a relative path inside the repository`);
    }
    // ONE template, not two. The scaffold observer and the renderer read the
    // same submodule at the same committed gitlink; a manifest naming another
    // would let the renderer's bytes be pinned by nothing the scaffold pins.
    const scaffold = policy.scaffold_manifest;
    if (isRecord(scaffold) && typeof scaffold.template_submodule === "string" && typeof renderer.submodule === "string"
        && scaffold.template_submodule !== renderer.submodule) {
      fail("profile_manifest.renderer.submodule", `must equal scaffold_manifest.template_submodule (${scaffold.template_submodule})`);
    }
    const argv = renderer.check_argv;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((item: unknown) => typeof item === "string" && item.length > 0)) {
      fail("profile_manifest.renderer.check_argv", "check_argv must be a non-empty list of argument strings");
    } else {
      const named = argv.filter((item: string) => item.includes("{profile_name}")).length;
      // Exactly one: none would check every profile (and follow every
      // symlink in the root); two would hand the renderer a second positional
      // it has no parameter for.
      if (named !== 1) fail("profile_manifest.renderer.check_argv", "exactly one argument must carry the {profile_name} placeholder");
      if (argv[0] !== "check") fail("profile_manifest.renderer.check_argv", "the first argument must be the read-only `check` subcommand");
    }
    const timeout = renderer.lock_timeout_seconds;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 60) {
      fail("profile_manifest.renderer.lock_timeout_seconds", "lock_timeout_seconds must be a positive number of seconds, at most 60");
    }
    if (nonEmpty(renderer.lock_pattern, "profile_manifest.renderer.lock_pattern")) {
      if (!renderer.lock_pattern.includes("{profile_name}")) fail("profile_manifest.renderer.lock_pattern", "lock_pattern must carry the {profile_name} placeholder");
      if (renderer.lock_pattern.includes("/")) fail("profile_manifest.renderer.lock_pattern", "lock_pattern must be one root entry name, never a path");
    }
  }

  // -- identity ---------------------------------------------------------------
  const identity = block.identity;
  if (closed(identity, "profile_manifest.identity", FLEET_PROFILE_MANIFEST_IDENTITY_KEYS)) {
    const file = identity.file;
    if (!relativeInside(file) || file.endsWith("/") || file.includes("/")) fail("profile_manifest.identity.file", "file must be one file name inside the profile directory");
    else requireDeclared(profileLeafFor(file), "profile_manifest.identity.file");
    const allowed = uniqueList(identity.allowed_keys, "profile_manifest.identity.allowed_keys", (item, where) => {
      if (!RENDER_INPUT_NAME.test(item)) fail(where, "a key name must be a lower-case identifier");
    });
    uniqueList(identity.inert_keys, "profile_manifest.identity.inert_keys", (item, where) => {
      if (!RENDER_INPUT_NAME.test(item)) fail(where, "a key name must be a lower-case identifier");
      // A key cannot be both allowed identity and inert config: the observer
      // would record it and ignore it in the same breath.
      if (allowed.includes(item)) fail(where, `${item} is already an allowed identity key`);
    });
  }

  // -- memory -----------------------------------------------------------------
  const memory = block.memory;
  if (closed(memory, "profile_manifest.memory", FLEET_PROFILE_MANIFEST_MEMORY_KEYS)) {
    const pin = memory.pin_file;
    if (!relativeInside(pin) || pin.endsWith("/")) fail("profile_manifest.memory.pin_file", "pin_file must be a profile-relative file path");
    else requireDeclared(profileLeafFor(pin), "profile_manifest.memory.pin_file");
    if (nonEmpty(memory.bank_id_template, "profile_manifest.memory.bank_id_template")) {
      // Without the placeholder every profile would be told to pin ONE bank,
      // which is the exact merge of private memories the pin exists to prevent.
      if (!memory.bank_id_template.includes("{profile_name}")) fail("profile_manifest.memory.bank_id_template", "bank_id_template must carry the {profile_name} placeholder");
    }
    uniqueList(memory.reserved_bank_ids, "profile_manifest.memory.reserved_bank_ids", (item, where) => {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(item)) fail(where, "a reserved bank id must be a lower-case identifier");
    });
  }

  // -- skill core -------------------------------------------------------------
  const core = block.skill_core;
  if (closed(core, "profile_manifest.skill_core", FLEET_PROFILE_MANIFEST_SKILL_CORE_KEYS)) {
    const dir = core.canonical_dir;
    if (nonEmpty(dir, "profile_manifest.skill_core.canonical_dir")) {
      // A PLACEHOLDER root, never an absolute host path: the contract is
      // tracked and the canonical directory lives under whichever home runs it.
      if (!/^\{(?:HOME|HERMES_FLEET_HOME)\}\//u.test(dir)) fail("profile_manifest.skill_core.canonical_dir", "canonical_dir must start with the {HOME}/ or {HERMES_FLEET_HOME}/ placeholder, never an absolute host path");
      else if (!relativeInside(dir.replace(/^\{[A-Z_]+\}\//u, ""))) fail("profile_manifest.skill_core.canonical_dir", "canonical_dir must not leave its placeholder root");
    }
    if (typeof core.canonical_dir_env !== "string" || !ENV_KEY.test(core.canonical_dir_env)) fail("profile_manifest.skill_core.canonical_dir_env", "canonical_dir_env must be an environment key");
    const required = uniqueList(core.required, "profile_manifest.skill_core.required", (item, where) => {
      if (!SAFE_SEGMENT.test(item) || item.includes("/")) fail(where, "a skill name must be one safe path segment");
    });
    nonEmpty(core.source, "profile_manifest.skill_core.source");
    requireDeclared("profiles.{profile_name}.skills", "profile_manifest.skill_core");
  }

  // -- extras -----------------------------------------------------------------
  const extras = block.extras;
  if (closed(extras, "profile_manifest.extras", FLEET_PROFILE_MANIFEST_EXTRAS_KEYS)) {
    const pattern = (item: string, where: string): void => {
      // `*`, `**`, `?*`, `*?*`: every spelling made of wildcards alone matches
      // every entry, and an ignore list that matches every entry sweeps nothing.
      if (item.includes("/") || /^[*?]+$/u.test(item) || item.includes("**")) fail(where, "a pattern must be one root entry glob and may not match every entry");
    };
    const ignored = uniqueList(extras.ignored_patterns, "profile_manifest.extras.ignored_patterns", pattern);
    if (ignored.length === 0) fail("profile_manifest.extras.ignored_patterns", "ignored_patterns must name the renderer's lock entries, or the observer's own footprint would be classified");
    uniqueList(extras.backup_patterns, "profile_manifest.extras.backup_patterns", pattern);
    // The renderer's lock entries are the observer's own footprint. The sweep
    // excludes `renderer.lock_pattern` itself, and the declared ignore list
    // must cover it too, so the two cannot drift apart into a footprint that
    // is skipped by one rule and classified by the other.
    const lockPattern = isRecord(renderer) && typeof renderer.lock_pattern === "string" ? renderer.lock_pattern : null;
    if (lockPattern !== null && ignored.length > 0) {
      const sample = lockPattern.replaceAll("{profile_name}", "sample-profile");
      const covered = ignored.some((glob) => rootEntryGlob(glob.replaceAll("{profile_name}", "*")).test(sample));
      if (!covered) fail("profile_manifest.extras.ignored_patterns", `must cover renderer.lock_pattern (${lockPattern}); the renderer's lock entries would otherwise be classified as extras`);
    }
  }

  // -- limits -----------------------------------------------------------------
  const limits = block.limits;
  if (closed(limits, "profile_manifest.limits", FLEET_PROFILE_MANIFEST_LIMITS_KEYS)) {
    const ceilings: Record<(typeof FLEET_PROFILE_MANIFEST_LIMITS_KEYS)[number], number> = {
      max_file_bytes: PROFILE_MAX_FILE_BYTES,
      max_root_entries: PROFILE_MAX_ROOT_ENTRIES,
      max_unit_files: PROFILE_MAX_UNIT_FILES,
      max_extra_skills: PROFILE_MAX_EXTRA_SKILLS,
    };
    for (const key of FLEET_PROFILE_MANIFEST_LIMITS_KEYS) {
      const value = limits[key];
      if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`profile_manifest.limits.${key}`, `${key} must be a positive whole number`);
      else if (Number(value) > ceilings[key]) fail(`profile_manifest.limits.${key}`, `${key} may not exceed this build's ceiling of ${ceilings[key]}`);
    }
  }

  // The generated file the renderer proves is the one the service model names,
  // and the observation about it lands on a declared leaf.
  const layout = isRecord(policy.service_model) && isRecord(policy.service_model.profile_layout) ? policy.service_model.profile_layout : null;
  const generated = layout && typeof layout.generated_file === "string" ? layout.generated_file : null;
  if (generated !== null) requireDeclared(profileLeafFor(generated), "profile_manifest.renderer");

  return findings;
}

/** A unit-name PATTERN as the contract spells one: a systemd unit name with `{agent_id}` allowed as a segment. */
const UNIT_PATTERN = /^[A-Za-z0-9:_.@{}-]{1,255}\.(?:service|timer|socket|target|path|slice|scope)$/u;
/** A lower-case identifier word, for platform names and status words. */
const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;

/**
 * Validate the optional `service_manifest` block (schema 5).
 *
 * OPTIONAL: a schema-1..4 contract carries none and still loads; the systemd
 * observer then reports every selected agent's five systemd leaves
 * `unsupported` with capability `systemd.manifest`. What it may not do is
 * carry a manifest that names nothing real: a window of zero samples, a probe
 * environment that cannot find `systemctl`, a messaging status field no
 * authority declares, a `secret_env` for a platform the manifest does not list
 * (or one that is not an environment key -- the ONE credential-shaped path the
 * structure stage exempts, so this is where it is proven to carry names), an
 * `enabled_path` that never names the platform, a retired shape that equals a
 * canonical unit pattern, or a limit above the ceiling this build can honour.
 * A policy that matches nothing must fail to load rather than prove nothing
 * and report it as health.
 */
function validateServiceManifest(policy: Record<string, unknown>): FleetDiagnostic[] {
  const block = policy.service_manifest;
  if (block === undefined) return [];

  const findings: FleetDiagnostic[] = [];
  const fail = (path: string, message: string): void => { findings.push({ code: "INVALID_INPUT", path, message }); };
  if (!isRecord(block)) {
    fail("service_manifest", "service_manifest must be a mapping");
    return findings;
  }
  const closed = (node: unknown, at: string, keys: readonly string[]): node is Record<string, unknown> => {
    if (!isRecord(node)) { fail(at, `${at.split(".").pop()} must be a mapping`); return false; }
    for (const key of Object.keys(node)) {
      if (!keys.includes(key)) fail(`${at}.${key}`, `unknown ${at} key`);
    }
    for (const key of keys) {
      if (node[key] === undefined) fail(`${at}.${key}`, `${key} is required`);
    }
    return true;
  };
  const wholeNumber = (value: unknown, at: string, min: number, max: number, what: string): void => {
    if (!Number.isSafeInteger(value) || Number(value) < min) fail(at, `${what} must be a whole number of at least ${min}`);
    else if (Number(value) > max) fail(at, `${what} may not exceed this build's ceiling of ${max}`);
  };
  const nonEmpty = (value: unknown, at: string): value is string => {
    if (typeof value !== "string" || value.trim().length === 0) { fail(at, "must be a non-empty string"); return false; }
    return true;
  };
  const uniqueList = (value: unknown, at: string, each: (item: string, where: string) => void): string[] => {
    if (!Array.isArray(value)) { fail(at, "must be a list"); return []; }
    const seen = new Set<string>();
    const out: string[] = [];
    value.forEach((item: unknown, index: number) => {
      const where = `${at}[${index}]`;
      if (typeof item !== "string" || item.length === 0) { fail(where, "must be a non-empty string"); return; }
      if (seen.has(item)) fail(where, `duplicate entry ${item}`);
      seen.add(item);
      each(item, where);
      out.push(item);
    });
    return out;
  };

  closed(block, "service_manifest", FLEET_SERVICE_MANIFEST_KEYS);
  const declared = declaredWritableFields(policy);
  const requireDeclared = (leaf: string, at: string): void => {
    if (!declared.has(leaf)) fail(at, `${leaf} is not declared writable by any authority`);
  };
  const service = isRecord(policy.service_model) ? policy.service_model : null;
  const perAgent = service && isRecord(service.per_agent) ? service.per_agent : {};
  const shared = service && isRecord(service.fleet_shared) ? service.fleet_shared : {};
  const perAgentPatterns = Object.values(perAgent).filter((value): value is string => typeof value === "string" && value.length > 0);
  const sharedUnit = typeof shared.bloodbank_gateway_unit === "string" ? shared.bloodbank_gateway_unit : null;

  // -- stabilization ----------------------------------------------------------
  const stabilization = block.stabilization;
  if (closed(stabilization, "service_manifest.stabilization", FLEET_SERVICE_MANIFEST_STABILIZATION_KEYS)) {
    // At least ONE sample, or nothing is observed and "stable" is vacuous.
    wholeNumber(stabilization.samples, "service_manifest.stabilization.samples", 1, SYSTEMD_MAX_SAMPLES, "samples");
    wholeNumber(stabilization.interval_ms, "service_manifest.stabilization.interval_ms", 0, SYSTEMD_MAX_INTERVAL_MS, "interval_ms");
    // The same vacuity `samples >= 1` refuses, through the other knob: three
    // samples taken with no wait between them are three reads of one instant,
    // unanimous about nothing. Zero is still legal for a single-sample window,
    // where nothing waits at all.
    if (typeof stabilization.samples === "number" && stabilization.samples > 1
      && typeof stabilization.interval_ms === "number" && stabilization.interval_ms === 0) {
      fail("service_manifest.stabilization.interval_ms", "interval_ms must be positive when samples is greater than 1: samples with no wait between them cannot show a unit changing");
    }
  }

  // -- probe ------------------------------------------------------------------
  const probe = block.probe;
  if (closed(probe, "service_manifest.probe", FLEET_SERVICE_MANIFEST_PROBE_KEYS)) {
    // Below 100 ms nothing can answer and every child reads `manager-timeout`.
    wholeNumber(probe.timeout_ms, "service_manifest.probe.timeout_ms", 100, SYSTEMD_MAX_PROBE_TIMEOUT_MS, "timeout_ms");
    const allow = uniqueList(probe.env_allowlist, "service_manifest.probe.env_allowlist", (item, where) => {
      if (!ENV_KEY.test(item)) fail(where, `not an environment key: ${item}`);
    });
    // `systemctl` is spawned by name, so a child with no PATH finds nothing.
    if (Array.isArray(probe.env_allowlist) && !allow.includes("PATH")) fail("service_manifest.probe.env_allowlist", "env_allowlist must carry PATH, or no child can find systemctl");
    const states = uniqueList(probe.manager_available_states, "service_manifest.probe.manager_available_states", (item, where) => {
      if (!IDENTIFIER.test(item)) fail(where, "a manager state must be a lower-case word");
    });
    if (Array.isArray(probe.manager_available_states) && states.length === 0) fail("service_manifest.probe.manager_available_states", "must name at least one available manager state");
  }

  // -- entrypoint ---------------------------------------------------------------
  const entrypoint = block.entrypoint;
  if (closed(entrypoint, "service_manifest.entrypoint", FLEET_SERVICE_MANIFEST_ENTRYPOINT_KEYS)) {
    const launcher = entrypoint.launcher;
    if (!relativeInside(launcher) || launcher.endsWith("/")) fail("service_manifest.entrypoint.launcher", "launcher must be a role-relative file path");
    const bin = entrypoint.pinned_bin_field;
    if (typeof bin !== "string" || !FIELD_PATH.test(bin)) fail("service_manifest.entrypoint.pinned_bin_field", "pinned_bin_field must be a dotted field path");
    else if (!bin.startsWith("agents.{agent_id}.")) fail("service_manifest.entrypoint.pinned_bin_field", "pinned_bin_field must be a per-agent agents.{agent_id}.* field");
    else requireDeclared(bin, "service_manifest.entrypoint.pinned_bin_field");
    if (typeof entrypoint.home_env !== "string" || !ENV_KEY.test(entrypoint.home_env)) fail("service_manifest.entrypoint.home_env", "home_env must be an environment key");
  }

  // -- messaging --------------------------------------------------------------
  const messaging = block.messaging;
  if (closed(messaging, "service_manifest.messaging", FLEET_SERVICE_MANIFEST_MESSAGING_KEYS)) {
    const platforms = uniqueList(messaging.platforms, "service_manifest.messaging.platforms", (item, where) => {
      if (!IDENTIFIER.test(item)) fail(where, "a platform must be a lower-case identifier");
    });
    if (Array.isArray(messaging.platforms) && platforms.length === 0) fail("service_manifest.messaging.platforms", "must name at least one messaging platform");
    const statusField = messaging.status_field;
    if (typeof statusField !== "string" || !IDENTIFIER.test(statusField)) fail("service_manifest.messaging.status_field", "status_field must be a lower-case identifier");
    else {
      // The declaration the gateway state is DERIVED from has to be a field
      // some authority writes, or the derivation reads a key nobody owns.
      for (const platform of platforms) requireDeclared(`agents.{agent_id}.${platform}.${statusField}`, `service_manifest.messaging.platforms`);
    }
    const verified = messaging.verified_status;
    if (typeof verified !== "string" || !IDENTIFIER.test(verified)) fail("service_manifest.messaging.verified_status", "verified_status must be a lower-case identifier");
    const deferred = uniqueList(messaging.deferred_statuses, "service_manifest.messaging.deferred_statuses", (item, where) => {
      if (!IDENTIFIER.test(item)) fail(where, "a status must be a lower-case identifier");
      // One status cannot both enable and defer the gateway.
      if (item === verified) fail(where, `${item} is already the verified_status`);
    });
    if (Array.isArray(messaging.deferred_statuses) && deferred.length === 0) fail("service_manifest.messaging.deferred_statuses", "must name at least one deferred status");
    const enabledPath = messaging.enabled_path;
    if (typeof enabledPath !== "string" || !FIELD_PATH.test(enabledPath)) fail("service_manifest.messaging.enabled_path", "enabled_path must be a dotted key path");
    // Without the placeholder every platform would be judged by ONE key.
    else if (!enabledPath.includes("{platform}")) fail("service_manifest.messaging.enabled_path", "enabled_path must carry the {platform} placeholder");
    const perPlatform = (node: unknown, at: string, each: (item: string, where: string) => void): void => {
      if (!isRecord(node)) { fail(at, `${at.split(".").pop()} must be a mapping of platform to list`); return; }
      for (const [platform, list] of Object.entries(node)) {
        const where = `${at}.${platform}`;
        // A key for a platform the manifest does not list is policy about nothing.
        if (!platforms.includes(platform)) fail(where, `${platform} is not a declared messaging platform`);
        const items = uniqueList(list, where, each);
        if (Array.isArray(list) && items.length === 0) fail(where, "must name at least one entry");
      }
    };
    perPlatform(messaging.secret_env, "service_manifest.messaging.secret_env", (item, where) => {
      // The ONE credential-shaped path the structure stage exempts: it must
      // hold environment KEY NAMES and nothing that could be a value.
      if (!ENV_KEY.test(item)) fail(where, `secret_env must name environment keys, not values: ${item}`);
    });
    perPlatform(messaging.identity_fields, "service_manifest.messaging.identity_fields", (item, where) => {
      if (!IDENTIFIER.test(item)) fail(where, "an identity field must be a lower-case identifier");
    });
  }

  // -- heartbeat ----------------------------------------------------------------
  const heartbeat = block.heartbeat;
  if (closed(heartbeat, "service_manifest.heartbeat", FLEET_SERVICE_MANIFEST_HEARTBEAT_KEYS)) {
    wholeNumber(heartbeat.on_boot_sec, "service_manifest.heartbeat.on_boot_sec", 1, 86_400, "on_boot_sec");
    wholeNumber(heartbeat.on_unit_inactive_sec, "service_manifest.heartbeat.on_unit_inactive_sec", 1, 86_400, "on_unit_inactive_sec");
    wholeNumber(heartbeat.overdue_multiplier, "service_manifest.heartbeat.overdue_multiplier", 1, 1_000, "overdue_multiplier");
    wholeNumber(heartbeat.max_tick_seconds, "service_manifest.heartbeat.max_tick_seconds", 1, 86_400, "max_tick_seconds");
    for (const key of ["reconcile_policy_file", "reconcile_state_file"] as const) {
      const value = heartbeat[key];
      if (!relativeInside(value) || value.endsWith("/")) fail(`service_manifest.heartbeat.${key}`, `${key} must be a role-relative file path`);
    }
  }

  // -- unregistered -------------------------------------------------------------
  const unregistered = block.unregistered;
  let unitGlob: RegExp | null = null;
  if (closed(unregistered, "service_manifest.unregistered", FLEET_SERVICE_MANIFEST_UNREGISTERED_KEYS)) {
    const glob = unregistered.unit_glob;
    if (nonEmpty(glob, "service_manifest.unregistered.unit_glob")) {
      // A literal prefix, then wildcards: `*` alone would list every unit on
      // the manager and classify the desktop as unregistered Hermes.
      if (glob.includes("/") || /^[*?]/u.test(glob) || !/^[A-Za-z0-9@._-]+[*?][A-Za-z0-9@._*?-]*$|^[A-Za-z0-9@._-]+$/u.test(glob)) {
        fail("service_manifest.unregistered.unit_glob", "unit_glob must be a literal unit-name prefix followed by wildcards");
      } else unitGlob = rootEntryGlob(glob);
    }
    uniqueList(unregistered.retired_candidates, "service_manifest.unregistered.retired_candidates", (item, where) => {
      if (!UNIT_PATTERN.test(item)) fail(where, "a retired candidate must be a unit-name pattern");
      else if (!item.includes("{agent_id}")) fail(where, "a retired candidate must carry the {agent_id} placeholder");
      // A retired shape that IS a canonical pattern would retire the canon.
      else if (perAgentPatterns.includes(item)) fail(where, `${item} is a service_model.per_agent pattern, not a retired shape`);
      else if (sharedUnit !== null && item === sharedUnit) fail(where, `${item} is the fleet-shared gateway, not a retired shape`);
      else if (unitGlob !== null && !unitGlob.test(item.replaceAll("{agent_id}", "x"))) fail(where, `${item} falls outside unit_glob, so the sweep could never see it`);
    });
  }

  // -- limits -----------------------------------------------------------------
  const limits = block.limits;
  if (closed(limits, "service_manifest.limits", FLEET_SERVICE_MANIFEST_LIMITS_KEYS)) {
    const ceilings: Record<(typeof FLEET_SERVICE_MANIFEST_LIMITS_KEYS)[number], number> = {
      max_units: SYSTEMD_MAX_UNITS,
      max_unregistered_units: SYSTEMD_MAX_UNREGISTERED_UNITS,
      max_file_bytes: SYSTEMD_MAX_FILE_BYTES,
      max_show_bytes: SYSTEMD_MAX_SHOW_BYTES,
    };
    for (const key of FLEET_SERVICE_MANIFEST_LIMITS_KEYS) {
      wholeNumber(limits[key], `service_manifest.limits.${key}`, 1, ceilings[key], key);
    }
  }

  // The five leaves the observer files under are declared writable, so every
  // observation resolves an owner: the three per-agent unit patterns, the two
  // registry fields, and the fleet-shared gateway unit.
  for (const pattern of perAgentPatterns) requireDeclared(`units.${pattern}`, "service_manifest");
  if (sharedUnit !== null) requireDeclared(`units.${sharedUnit}`, "service_manifest");
  requireDeclared("agents.{agent_id}.systemd.gateway_unit", "service_manifest");
  requireDeclared("agents.{agent_id}.systemd.heartbeat_timer", "service_manifest");

  return findings;
}
