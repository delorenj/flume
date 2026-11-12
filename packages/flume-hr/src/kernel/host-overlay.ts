/**
 * The per-host overlay: the ONE sanctioned way two flume hosts differ.
 *
 * Two 33GOD peers run the same flume build (big-chungus and Damian's Mac Studio). Anything that is a
 * fact about a HOST -- which vault its `op://` references name, which Plane it talks to, which gateway
 * routes it may use, what its board's lane names are -- used to be a literal in flume's source or in a
 * tracked role.yaml, which made it Jarad's value on every machine that pulled the code. A literal
 * cannot be right for two hosts, so the value moved here.
 *
 * Contract:
 *   * ABSENT overlay = today's behaviour, byte for byte. Every default below is the value the code
 *     carried before the overlay existed, so an absent file changes nothing on big-chungus.
 *   * An overlay that exists but is BROKEN never falls back to the defaults. The defaults are one
 *     host's values; silently running another host on them is the failure this file exists to end
 *     (it would hand a Mac Jarad's vault name, or land a transition in Jarad's lane). Consumers
 *     refuse, or report a failing finding, with the reason.
 *   * An unknown key is an error, not a no-op: a typo in an overlay must not read as "not set".
 *   * No secret ever lives here. Only references (`op://...`), names and URLs; a value that looks like a
 *     credential is refused.
 *
 * Location: `FLUME_HOST_OVERLAY` (explicit; naming a missing file is an error), else
 * `$XDG_CONFIG_HOME/flume/host-overlay.yaml`, else `~/.config/flume/host-overlay.yaml`. Outside any repo,
 * so it can never be committed by accident and never travels with a pull. `FLUME_HOST_OVERLAY=none` forces
 * "no overlay" (every default), which is what the test runner sets so a developer's own overlay cannot
 * change a test's outcome; a file literally named `none` is spelled `./none`.
 *
 * Format (YAML, every section optional except `version`):
 *
 *   version: 1
 *   host: damians-mac-studio            # a label, shown in provenance only
 *   host_config:                        # values for ~/.config/hermes-agent-template/config.toml
 *     fleet: { runtime_scaffold_dir: ~/code/..., vox_url: https://..., onepassword_vault: ... }
 *     plane: { base: http://plane.local, workspace: ... }
 *   vault:                              # the 1Password vault every flume-composed op:// reference names
 *     name: SomeVault
 *     gateway_tokens_item: <item id>
 *   gateway:                            # what `hermes.gateway-routing` holds the fleet config to
 *     provider: automaticai
 *     host: api.automaticai.io
 *     label: AutomaticAI
 *     models: [automaticai/<account>/<model>, ...]   # REQUIRED once a gateway section exists
 *   lanes:                              # per-host ticket lane names, over a tracked role.yaml's map
 *     - match: { provider: plane, workspace: ..., board_id: ... }   # every key optional; none = every board
 *       replace: true                     # optional: ignore the tracked map for these boards (default: layer over it)
 *       states: { in_review: "In Review", started: "In Progress", ... }
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

export const HOST_OVERLAY_VERSION = 1;
export const HOST_OVERLAY_ENV = "FLUME_HOST_OVERLAY";
/** The `FLUME_HOST_OVERLAY` value that disables overlays outright. */
export const HOST_OVERLAY_DISABLED = "none";

/** The normalized ticket states a role.yaml `ticket_provider:` block can name a concrete lane for. */
export const LANE_BANDS = [
  "backlog",
  "unstarted",
  "started",
  "in_review",
  "completed",
  "cancelled",
  "awaiting_decision",
  "e2e_testing",
  "ready_for_documentation",
  "needs_re_evaluation",
] as const;
export type LaneBand = (typeof LANE_BANDS)[number];

export interface LaneRule {
  match: { provider?: string; workspace?: string; board_id?: string };
  states: Partial<Record<LaneBand, string>>;
  /**
   * false (default): `states` is laid over the role.yaml's tracked map, band by band.
   * true: the role.yaml's tracked map is IGNORED for a matching board and only `states` applies. A tracked map names
   * the owner's lanes ("E2E Testing & QA"); on a board that has no such lane the unnamed bands must fall back to the
   * adapter's own defaults, not to someone else's lane names.
   */
  replace: boolean;
}

/** What `hermes.gateway-routing` holds a fleet config to. */
export interface GatewayPolicy {
  /** The named Hermes provider that carries inference to the gateway (`providers.<provider>`, `model.provider`). */
  provider: string;
  /** The gateway's host, as it appears in `providers.<provider>.api` and any `base_url`. */
  host: string;
  /** How findings name the gateway. */
  label: string;
  /** The curated route list `providers.<provider>.models` must equal. */
  models: readonly string[];
}

/** The routes big-chungus curates today (`providers.automaticai.models`). */
const DEFAULT_GATEWAY_MODELS = [
  "automaticai/personal/sol-6.1",
  "automaticai/personal/sol",
  "automaticai/personal/astra",
  "automaticai/personal/claude-opus-5.5",
  "automaticai/intelliforia/claude-opus-5.5",
  "automaticai/personal/claude-sonnet-5.5",
  "automaticai/intelliforia/claude-sonnet-5.5",
  "automaticai/personal/kimi-k3",
  "automaticai/personal/kimi-k3s",
  "automaticai/personal/kimi-2.8",
  "automaticai/personal/glm-5.3",
  "automaticai/personal/glm-5.3-flash",
] as const;

/** big-chungus's gateway policy: the value every host had before the overlay, and the default now. */
export const DEFAULT_GATEWAY_POLICY: GatewayPolicy = Object.freeze({
  provider: "automaticai",
  host: "api.automaticai.io",
  label: "AutomaticAI",
  models: DEFAULT_GATEWAY_MODELS,
});

/** big-chungus's vault and the FLUME-39 shared gateway-token item. */
export const DEFAULT_VAULT_NAME = "DeLoSecrets";
export const DEFAULT_GATEWAY_TOKENS_ITEM = "yeurk5dpqkaarspvsn3cjtmkki";

export interface HostOverlay {
  version: typeof HOST_OVERLAY_VERSION;
  /** A label for provenance output; never used for behaviour. */
  host?: string;
  /** section -> key -> value, over the pinned host-config schema (validated by the schema's owner). */
  hostConfig: Record<string, Record<string, string>>;
  vault: { name?: string; gatewayTokensItem?: string };
  /** Present only when the overlay has a `gateway:` section. */
  gateway?: GatewayPolicy;
  lanes: LaneRule[];
}

export type OverlayLoad =
  | { status: "absent"; path: string }
  | { status: "ok"; path: string; overlay: HostOverlay }
  | { status: "invalid"; path: string; errors: string[] };

/** Raised by consumers that have no way to report a finding: a broken overlay must stop them, not default them. */
export class HostOverlayError extends Error {
  readonly path: string;
  readonly errors: string[];
  constructor(path: string, errors: string[]) {
    super(`host overlay ${path} is invalid: ${errors.join("; ")}`);
    this.name = "HostOverlayError";
    this.path = path;
    this.errors = errors;
  }
}

/** Where this host's overlay lives, honouring FLUME_HOST_OVERLAY and XDG. */
export function resolveHostOverlayPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = env[HOST_OVERLAY_ENV]?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join(home, ".config");
  return join(base, "flume", "host-overlay.yaml");
}

const MAX_OVERLAY_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 1024;
const TOP_LEVEL_KEYS = new Set(["version", "host", "host_config", "vault", "gateway", "lanes"]);
const GATEWAY_KEYS = new Set(["provider", "host", "label", "models"]);
const VAULT_KEYS = new Set(["name", "gateway_tokens_item"]);
const LANE_RULE_KEYS = new Set(["match", "states", "replace"]);
const LANE_MATCH_KEYS = new Set(["provider", "workspace", "board_id"]);
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/u;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const PROVIDER = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A credential shape, refused wherever a value is read. The overlay is a plain, unguarded file: it holds
 * references and names, so a raw key here is always a mistake. Deliberately narrow (known vendor prefixes
 * and URL userinfo) -- this is a tripwire, not a scanner; the repo guards remain the scanner.
 */
export function looksLikeSecret(value: string): boolean {
  return /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|ops_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/u.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]+@/iu.test(value);
}

function cleanString(value: unknown, label: string, errors: string[]): string | undefined {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    errors.push(`${label} must not be blank`);
    return undefined;
  }
  if (text.length > MAX_VALUE_CHARS) {
    errors.push(`${label} is longer than ${MAX_VALUE_CHARS} characters`);
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    errors.push(`${label} must be a single line without control characters`);
    return undefined;
  }
  if (looksLikeSecret(text)) {
    errors.push(`${label} looks like a credential: an overlay holds references and names only (use an op:// reference)`);
    return undefined;
  }
  return text;
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unknown key "${key}" (allowed: ${[...allowed].join(", ")})`);
  }
}

function parseHostConfig(value: unknown, errors: string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (value === undefined || value === null) return out;
  if (!isRecord(value)) {
    errors.push("host_config must be a mapping of section -> key -> value");
    return out;
  }
  for (const [section, body] of Object.entries(value)) {
    if (!isRecord(body)) {
      errors.push(`host_config.${section} must be a mapping of key -> value`);
      continue;
    }
    const keys: Record<string, string> = {};
    for (const [key, raw] of Object.entries(body)) {
      const text = cleanString(raw, `host_config.${section}.${key}`, errors);
      if (text !== undefined) keys[key] = text;
    }
    out[section] = keys;
  }
  return out;
}

function parseGateway(value: unknown, errors: string[]): GatewayPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    errors.push("gateway must be a mapping");
    return undefined;
  }
  unknownKeys(value, GATEWAY_KEYS, "gateway", errors);
  const before = errors.length;
  let provider: string = DEFAULT_GATEWAY_POLICY.provider;
  if (value.provider !== undefined) {
    const text = cleanString(value.provider, "gateway.provider", errors);
    if (text !== undefined) {
      if (!PROVIDER.test(text)) errors.push(`gateway.provider "${text}" must be lowercase letters, digits, "-" or "_"`);
      else provider = text;
    }
  }
  let host: string = DEFAULT_GATEWAY_POLICY.host;
  if (value.host !== undefined) {
    const text = cleanString(value.host, "gateway.host", errors)?.toLowerCase();
    if (text !== undefined) {
      if (!HOSTNAME.test(text)) errors.push(`gateway.host "${text}" must be a bare hostname (no scheme, port or path)`);
      else host = text;
    }
  }
  let label: string = DEFAULT_GATEWAY_POLICY.label;
  if (value.label !== undefined) {
    const text = cleanString(value.label, "gateway.label", errors);
    if (text !== undefined) {
      if (!NAME.test(text)) errors.push(`gateway.label "${text}" must be a short name`);
      else label = text;
    }
  }
  // The curated list is a fact about the host's ACCOUNTS. Defaulting it would hand another host big-chungus's
  // accounts ("personal", "intelliforia"), so a gateway section must name its own.
  const models: string[] = [];
  if (value.models === undefined || value.models === null) {
    errors.push("gateway.models is required once a gateway section exists (the curated route list is host-owned and has no safe default)");
  } else if (!Array.isArray(value.models) || value.models.length === 0) {
    errors.push("gateway.models must be a non-empty list of routes");
  } else {
    const route = new RegExp(`^${provider.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/[a-z0-9._-]+(?:/[a-z0-9._-]+)?$`, "u");
    const seen = new Set<string>();
    value.models.forEach((entry, index) => {
      const text = cleanString(entry, `gateway.models[${index}]`, errors);
      if (text === undefined) return;
      if (!route.test(text)) errors.push(`gateway.models[${index}] "${text}" is not a ${provider}/<account>[/<model>] route`);
      else if (seen.has(text)) errors.push(`gateway.models[${index}] "${text}" is listed twice`);
      else {
        seen.add(text);
        models.push(text);
      }
    });
  }
  if (errors.length > before) return undefined;
  return { provider, host, label, models };
}

function parseVault(value: unknown, errors: string[]): HostOverlay["vault"] {
  const out: HostOverlay["vault"] = {};
  if (value === undefined || value === null) return out;
  if (!isRecord(value)) {
    errors.push("vault must be a mapping");
    return out;
  }
  unknownKeys(value, VAULT_KEYS, "vault", errors);
  for (const [key, field] of [["name", "name"], ["gateway_tokens_item", "gatewayTokensItem"]] as const) {
    if (value[key] === undefined) continue;
    const text = cleanString(value[key], `vault.${key}`, errors);
    if (text === undefined) continue;
    // A vault or item name becomes one path segment of an op:// reference.
    if (!NAME.test(text)) errors.push(`vault.${key} "${text}" must be letters, digits, space, ".", "_" or "-" (it becomes a path segment of an op:// reference)`);
    else out[field] = text;
  }
  return out;
}

const LANE_NAME_MAX = 80;

function parseLanes(value: unknown, errors: string[]): LaneRule[] {
  const out: LaneRule[] = [];
  if (value === undefined || value === null) return out;
  if (!Array.isArray(value)) {
    errors.push("lanes must be a list of { match, states } rules");
    return out;
  }
  value.forEach((entry, index) => {
    const label = `lanes[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be a mapping with "states" and an optional "match"`);
      return;
    }
    unknownKeys(entry, LANE_RULE_KEYS, label, errors);
    const match: LaneRule["match"] = {};
    if (entry.match !== undefined && entry.match !== null) {
      if (!isRecord(entry.match)) errors.push(`${label}.match must be a mapping`);
      else {
        unknownKeys(entry.match, LANE_MATCH_KEYS, `${label}.match`, errors);
        for (const key of LANE_MATCH_KEYS) {
          if (entry.match[key] === undefined) continue;
          const text = cleanString(entry.match[key], `${label}.match.${key}`, errors);
          if (text !== undefined) match[key as keyof LaneRule["match"]] = text;
        }
      }
    }
    const states: LaneRule["states"] = {};
    if (!isRecord(entry.states) || Object.keys(entry.states).length === 0) {
      errors.push(`${label}.states must name at least one band`);
    } else {
      for (const [band, raw] of Object.entries(entry.states)) {
        if (!(LANE_BANDS as readonly string[]).includes(band)) {
          errors.push(`${label}.states has unknown band "${band}" (allowed: ${LANE_BANDS.join(", ")})`);
          continue;
        }
        const text = cleanString(raw, `${label}.states.${band}`, errors);
        if (text === undefined) continue;
        // role.yaml lane names are read back by line-oriented adapters that strip one pair of quotes.
        if (text.includes('"') || text.length > LANE_NAME_MAX) errors.push(`${label}.states.${band} must be a lane name of at most ${LANE_NAME_MAX} characters with no double quote`);
        else states[band as LaneBand] = text;
      }
    }
    let replace = false;
    if (entry.replace !== undefined) {
      if (typeof entry.replace !== "boolean") errors.push(`${label}.replace must be true or false`);
      else replace = entry.replace;
    }
    out.push({ match, states, replace });
  });
  return out;
}

/** Parse overlay text. Pure: no I/O, so a fixture can be checked without a file. */
export function parseHostOverlay(text: string): { overlay: HostOverlay } | { errors: string[] } {
  let doc: unknown;
  try {
    doc = YAML.parse(text, { uniqueKeys: true });
  } catch (error) {
    return { errors: [`not valid YAML: ${(error as Error).message.split("\n")[0]}`] };
  }
  if (!isRecord(doc)) return { errors: ["the overlay must be a YAML mapping"] };
  const errors: string[] = [];
  unknownKeys(doc, TOP_LEVEL_KEYS, "the overlay", errors);
  if (doc.version !== HOST_OVERLAY_VERSION) errors.push(`version must be ${HOST_OVERLAY_VERSION} (found ${JSON.stringify(doc.version ?? null)})`);
  let host: string | undefined;
  if (doc.host !== undefined) host = cleanString(doc.host, "host", errors);
  const hostConfig = parseHostConfig(doc.host_config, errors);
  const vault = parseVault(doc.vault, errors);
  const gateway = parseGateway(doc.gateway, errors);
  const lanes = parseLanes(doc.lanes, errors);
  if (errors.length) return { errors };
  return { overlay: { version: HOST_OVERLAY_VERSION, ...(host ? { host } : {}), hostConfig, vault, ...(gateway ? { gateway } : {}), lanes } };
}

/** Load this host's overlay. Absent is a normal answer; an explicit pointer to nothing, or a broken file, is not. */
export function loadHostOverlay(env: NodeJS.ProcessEnv = process.env, home = homedir()): OverlayLoad {
  if (env[HOST_OVERLAY_ENV]?.trim().toLowerCase() === HOST_OVERLAY_DISABLED) {
    return { status: "absent", path: `(disabled: ${HOST_OVERLAY_ENV}=${HOST_OVERLAY_DISABLED})` };
  }
  const path = resolveHostOverlayPath(env, home);
  const explicit = Boolean(env[HOST_OVERLAY_ENV]?.trim());
  if (!existsSync(path)) {
    return explicit
      ? { status: "invalid", path, errors: [`${HOST_OVERLAY_ENV} names a file that does not exist`] }
      : { status: "absent", path };
  }
  let text: string;
  try {
    const info = statSync(path);
    if (!info.isFile()) return { status: "invalid", path, errors: ["not a regular file"] };
    if (info.size > MAX_OVERLAY_BYTES) return { status: "invalid", path, errors: [`larger than ${MAX_OVERLAY_BYTES} bytes`] };
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { status: "invalid", path, errors: [`unreadable: ${(error as Error).message}`] };
  }
  const parsed = parseHostOverlay(text);
  return "errors" in parsed ? { status: "invalid", path, errors: parsed.errors } : { status: "ok", path, overlay: parsed.overlay };
}

/** The overlay, or undefined when there is none. A broken overlay THROWS: see the file header. */
export function requireHostOverlay(env: NodeJS.ProcessEnv = process.env, home = homedir()): HostOverlay | undefined {
  const loaded = loadHostOverlay(env, home);
  if (loaded.status === "invalid") throw new HostOverlayError(loaded.path, loaded.errors);
  return loaded.status === "ok" ? loaded.overlay : undefined;
}

/** The gateway policy a load resolves to: the overlay's section, else big-chungus's. Never call on an invalid load. */
export function gatewayPolicyOf(loaded: OverlayLoad): GatewayPolicy {
  return loaded.status === "ok" && loaded.overlay.gateway ? loaded.overlay.gateway : DEFAULT_GATEWAY_POLICY;
}

/** The vault every flume-composed op:// reference names on this host. */
export function hostVaultName(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return requireHostOverlay(env, home)?.vault.name ?? DEFAULT_VAULT_NAME;
}

/** The FLUME-39 shared item that holds each gateway consumer's token as one field. */
export function hostGatewayTokensItem(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return requireHostOverlay(env, home)?.vault.gatewayTokensItem ?? DEFAULT_GATEWAY_TOKENS_ITEM;
}

/**
 * The vault and gateway-token item for READING a reference back (consumerOf), where a broken overlay must not crash a
 * whole audit. `undefined` means "this host's vault is unknown": the reference then matches nothing and the caller
 * reports it as unverified, which is loud, and never as big-chungus's shape, which would be wrong.
 */
export function tryHostGatewayRefParts(env: NodeJS.ProcessEnv = process.env, home = homedir()): { vault: string; item: string } | undefined {
  const loaded = loadHostOverlay(env, home);
  if (loaded.status === "invalid") return undefined;
  const vault = loaded.status === "ok" ? loaded.overlay.vault : {};
  return { vault: vault.name ?? DEFAULT_VAULT_NAME, item: vault.gatewayTokensItem ?? DEFAULT_GATEWAY_TOKENS_ITEM };
}
