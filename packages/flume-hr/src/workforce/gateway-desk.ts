// Which AutomaticAI gateway consumer a desk runs on, read from the desk's own config files.
//
// ONE resolution, shared by the FLUME-53 gateway adapter (lifecycle-adapters.ts: inventory, revoke, receipts) and the
// registry projection for the ticket lifecycle (`hermes.registry-parity` -> `agents.<id>.gateway_consumer`). A leaf module
// on purpose: the parity rules import it without pulling in the lifecycle coordinator.
//
// Only the FLUME-39 reference shape names a consumer: `op://<vault>/<gateway tokens item>/<consumer>`, where the vault and
// item are this HOST's (kernel/host-overlay.ts; big-chungus's DeLoSecrets item unless the host overlay names its own). A consumer is
// never inferred from a profile or employee name. Nothing here reads a secret: only the `op://` reference text.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { DEFAULT_GATEWAY_TOKENS_ITEM, tryHostGatewayRefParts } from "../kernel/host-overlay";

/** The FLUME-39 shared item big-chungus uses (the default): `scripts/gateway-member-tokens.py` writes each consumer's token as one field of it. */
export const GATEWAY_TOKENS_ITEM = DEFAULT_GATEWAY_TOKENS_ITEM;

const regexEscape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const gatewayRefCache = new Map<string, RegExp>();
/** The reference pattern for this host's vault and token item, or undefined when its overlay is broken (nothing then matches). */
function gatewayRefPattern(): RegExp | undefined {
  const parts = tryHostGatewayRefParts();
  if (!parts) return undefined;
  const key = `${parts.vault}\u0000${parts.item}`;
  let pattern = gatewayRefCache.get(key);
  if (!pattern) {
    pattern = new RegExp(`^op://${regexEscape(parts.vault)}/${regexEscape(parts.item)}/([A-Za-z0-9][A-Za-z0-9_-]{0,39})$`, "u");
    gatewayRefCache.set(key, pattern);
  }
  return pattern;
}

/** The FLUME-39 reference shape as this host spells it, for next_action text. */
export function gatewayRefShape(): string {
  const parts = tryHostGatewayRefParts();
  return parts ? `op://${parts.vault}/${parts.item}/<consumer>` : "op://<host vault>/<gateway tokens item>/<consumer> (the host overlay is invalid, so this host's vault is unknown)";
}

/** What one desk config file says about the gateway key. A symlink, a non-file or bad YAML is `unreadable`, never "no key". */
export type RefRead = { exists: false } | { exists: true; ref?: string; unreadable?: true };

export function readRef(path: string): RefRead {
  let info;
  try { info = lstatSync(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { exists: false } : { exists: true, unreadable: true }; }
  if (info.isSymbolicLink() || !info.isFile()) return { exists: true, unreadable: true };
  try {
    const doc = YAML.parse(readFileSync(path, "utf8")) as { secrets?: { onepassword?: { env?: Record<string, unknown> } } } | null;
    const ref = doc?.secrets?.onepassword?.env?.AUTOMATICAI_GATEWAY_KEY;
    return { exists: true, ...(typeof ref === "string" ? { ref } : {}) };
  } catch { return { exists: true, unreadable: true }; }
}

export const refIn = (path: string): string | undefined => { const read = readRef(path); return read.exists ? read.ref : undefined; };
export const consumerOf = (ref: string | undefined): string | undefined => (ref ? gatewayRefPattern()?.exec(ref)?.[1] : undefined);

export type GatewayRefSource = "delta" | "generated" | "base" | "launcher";

export interface DeskRefs {
  /** The reference the desk RUNS with. */
  running: { ref?: string; source?: GatewayRefSource };
  /** The reference a render of the desk would produce: its delta's, else the fleet base's. */
  predicted: { ref?: string; source?: "delta" | "base" };
  drift: boolean;
  unreadable: boolean;
}

/**
 * Hermes runs a profile's GENERATED `config.yaml`, which is `deep_merge(<fleet>/config.yaml, <profile>/config.delta.yaml)` for a
 * post's desk and a specialist's alike. When that file exists its reference is the one that runs, whatever the delta says now:
 * `gateway-member-tokens.py --apply` edits the delta and re-renders only with `--render`, and a running gateway keeps the old
 * key until restarted. Without a generated config the desk would be rendered from its delta, then the base. A generated config
 * that disagrees with that render, or cannot be read, is DRIFT: neither key is provably the only one the desk uses.
 */
export function deskRefs(fleet: string, profile: string | null, baseRef: string | undefined): DeskRefs {
  const delta = profile ? refIn(join(fleet, "profiles", profile, "config.delta.yaml")) : undefined;
  const predicted: DeskRefs["predicted"] = delta ? { ref: delta, source: "delta" } : baseRef ? { ref: baseRef, source: "base" } : {};
  const generated: RefRead = profile ? readRef(join(fleet, "profiles", profile, "config.yaml")) : { exists: false };
  if (!generated.exists) return { running: predicted, predicted, drift: false, unreadable: false };
  const unreadable = Boolean(generated.unreadable);
  return { running: generated.ref ? { ref: generated.ref, source: "generated" } : {}, predicted, drift: unreadable || generated.ref !== predicted.ref, unreadable };
}

/** The fleet base config's gateway reference (`<fleet>/config.yaml`), if any. */
export const fleetBaseGatewayRef = (fleet: string): string | undefined => refIn(join(fleet, "config.yaml"));

export interface DeskGatewayConsumer {
  /** The consumer named by the reference the desk runs (FLUME-39 shape only). `hermes` is the fleet's shared base consumer. */
  consumer?: string;
  source?: GatewayRefSource;
  /** The desk's generated config cannot be read: the key it runs is unknown. */
  unreadable: boolean;
  drift: boolean;
}

/**
 * The consumer the desk of `profile` RUNS on, by the adapter's resolution: its generated `config.yaml`, else its
 * `config.delta.yaml`, else the fleet base. No `consumer` when the reference it runs is absent or not the FLUME-39 shape.
 */
export function deskGatewayConsumer(fleet: string, profile: string): DeskGatewayConsumer {
  const refs = deskRefs(fleet, profile, fleetBaseGatewayRef(fleet));
  const consumer = consumerOf(refs.running.ref);
  return { ...(consumer ? { consumer } : {}), ...(refs.running.source ? { source: refs.running.source } : {}), unreadable: refs.unreadable, drift: refs.drift };
}
