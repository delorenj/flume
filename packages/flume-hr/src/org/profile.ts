// Read-only generated-profile health: every registered profile gated, read and
// proven against the canonical renderer, plus every unregistered entry of the
// profile root classified for an operator.
//
// Before this, `profile` proved almost nothing: the only observation was the
// inventory's `lstat` of the profile directory, generated-config health was a
// declared deferral (`profile.render_generation`), nothing validated the
// identity file, the Hindsight bank pin or the skill core, and the profile
// root's unregistered entries -- a `.bak` directory, four symlinks, a case
// variant and an underscore variant of registered names, five standalone
// directories -- were reported by nothing (DW-25, DW-28). Every mutation story
// from 1.14 onward needs this read model first.
//
// Six disciplines:
//
//   * GATE FIRST, THEN LOOK. A profile path is read beneath only when it is a
//     real directory, contained, safely named and unambiguous (no other root
//     entry equals it case-insensitively, no other registry row names it, and
//     the root listing was complete enough to say so). A symlinked or
//     ambiguous profile is a hard `fail`, and anything read through it could
//     belong to another agent -- so the four dependent fields are
//     `unobserved` naming the gate code, not `error` (nothing failed to
//     collect) and not `skip` (nothing authorizes skipping). A directory the
//     observer could not even `lstat` is the one gate that IS an `error`, and
//     its dependents say so. The root itself is gated the same way one level
//     up: no component of it may be a symlink (DW-28), and a root that cannot
//     be enumerated is an error in every scope.
//   * RUN THE CANONICAL BYTES, NOT A CANONICAL LOCATION. The renderer cannot
//     be relocated (it loads its lock helper by relative path and refuses a
//     symlink), and the sibling-first locator the audit rule uses is exactly
//     the "newer bytes from a different checkout" hazard story 1.6 removed for
//     scaffolds. Both files' blob ids are proven equal to the blobs at the
//     COMMITTED gitlink before a single child spawns; otherwise
//     `profile.renderer` is an `error` host finding and nothing runs. A git
//     probe that fails is `unobserved`, never a content verdict: the renderer
//     can only be proven inside a git checkout of pjangler.
//   * THE RENDERER'S LOCK IS ITS READ SEMANTICS. `check` takes `flock` on a
//     persistent per-profile lock so a concurrent `render` cannot hand it a
//     half-written file. That is a consistency guarantee this observer wants,
//     not a mutation lock: it never takes a lock of its own, bounds the wait
//     so a held lock becomes a `renderer-timeout`, and excludes lock entries
//     from every count so its own footprint never changes its output.
//   * MEMBERSHIP IS BYTES. The template symlinks the core skills and copies one
//     of them, and 27 live profiles reach the core only through the generated
//     config's `skills.external_dirs`. A core skill is present when a
//     `SKILL.md` reachable through the roots Hermes actually loads resolves
//     inside an allowed root AND equals the canonical copy's digest. A foreign
//     realpath, a dangling link or a different digest never counts, and a
//     canonical projection that lacks a skill is one host finding beside the
//     per-agent items.
//   * READ-ONLY, BOUNDED, BYTE-STABLE, NO BODIES. Every read is `lstat`ed
//     first, opened without following, capped on the read itself and
//     re-checked after it (a torn read is `unreadable`, never digested); every
//     child is bounded and cancellable and runs with a narrow allowlisted
//     environment; nothing emitted is a file body, a config value, a delta
//     value, a memory, a link target outside the shown form, a timestamp or an
//     absolute path. Digests are 12-hex sha256 prefixes.
//   * EXTRAS ARE FINDINGS, NEVER A LICENCE. Every unregistered root entry lands
//     in exactly one of five classes with bounded evidence and guidance. Only a
//     contract-declared class is `pass`; everything else is `warn`, unjustified
//     by design until the operator classifies the entry in the contract.
//
// This module never constructs a `FleetStatusObservation`. It returns typed
// per-agent aspect results, a root record, a renderer record, a skill-core
// record, an extras record and probe records; `status.ts` turns them into
// observations through its single construction point.

import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { readTomlScalar } from "../kernel/host-config";
import { blobId } from "../scaffold/compare";
import { rootEntryGlob } from "./contract";
import { isSafePathSegment } from "./inventory";
import { mapBounded, probe, probeText, throwIfCancelled, type FleetRunContext } from "./runtime";
import {
  FLEET_STATUS_PROFILE_CONCURRENCY,
  type FleetContract,
  type FleetProbeRecord,
  type FleetProfileExtraClass,
  type FleetProfileItemKind,
  type FleetProfileManifest,
  type FleetProfilePathCode,
  type FleetProfilePythonCode,
  type FleetProfileRendererCode,
  type FleetProfileRendererState,
  type FleetProfileRootCode,
  type FleetStatusProfileExtraItem,
  type FleetStatusState,
} from "./types";

/** The probe `kind` every record this module emits carries. */
export const PROFILE_PROBE_KIND = "profile";

/** The shape Hermes' own resolver requires of a profile name before it will resolve a bank identity. */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/** Bytes of a generated config within which the generated-file marker must appear. */
export const PROFILE_MARKER_WINDOW_BYTES = 800;

/** Top-level sections the renderer names per drifted profile, at most. Mirrors `keys[:6]` in `cmd_check`. */
export const PROFILE_MAX_DRIFT_SECTIONS = 6;

/** Bytes of one systemd unit file the extras sweep will scan for a `HERMES_HOME=` reference. */
export const PROFILE_MAX_UNIT_FILE_BYTES = 64 * 1024;

/** Entries of one profile's own `skills` directory the observer will list. Its own cap, not the root's. */
export const PROFILE_MAX_SKILL_DIR_ENTRIES = 2000;

/**
 * The fleet base the renderer merges every delta over: `HERMES_HOME/config.yaml`
 * (`hermes-profile-config.py:88`, `BASE`). Named here, not derived from the
 * contract's per-profile `generated_file`: the two are the same name by
 * coincidence, and a layout that renamed one would not rename the other.
 */
export const RENDERER_BASE_FILE = "config.yaml";

/** The `[fleet]` key of the template config that names the canonical skills projection, as `10-hermes-profile.sh` reads it. */
export const CANONICAL_SKILLS_CONFIG_KEY = "canonical_skills_dir";

/**
 * The interpreter probe. Exits with codes IT controls -- 3 for a python older
 * than 3.11, 4 for a failed `import yaml` -- so the observer maps only those
 * two; every other nonzero or absent status is `renderer-python-unavailable`.
 */
export const PROFILE_PYTHON_PROBE = [
  "import sys",
  "if sys.version_info < (3, 11):",
  "    sys.exit(3)",
  "try:",
  "    import yaml",
  "except Exception:",
  "    sys.exit(4)",
  "sys.exit(0)",
  "",
].join("\n");

/**
 * The profile entries the template provisions as symlinks into the agent's
 * OWN role-local runtime. A link among them that points anywhere else belongs
 * to another agent.
 *
 * Mirrors `OWNED_PROFILE_ENTRIES` and `OWNED_PROFILE_FILES` in
 * `src/parity/rules.ts`, which is not imported here because it would pull the
 * whole recipe world into a read-only observer; the suite pins the two lists
 * equal (DW-92).
 */
export const PROFILE_SINGLETON_LINKS = [
  "memories", "sessions", "workspace", "logs", "cron", "plans", "hooks", "pairing", "audio_cache", "image_cache",
  "SOUL.md", "state.db", "kanban.db",
] as const;

/** Identifier words this module is willing to emit: a key, a section, a bank id, a root entry name. */
const WORD = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/u;
const SECTION = /^[A-Za-z0-9_.-]{1,64}$/u;

export interface FleetProfileAgentInput {
  agentId: string;
  /** The row's `profile_name`. Null when the row records none. */
  profileName: string | null;
  /** Stable named-agent identity. Null means this is a post/profile row. */
  stableIdentity?: string | null;
  /** Exact bank declared by the registry's `hindsight.write_bank`, when present. */
  declaredBank?: string | null;
  /** The row's `display_name`, compared against the identity file's when both exist. */
  displayName: string | null;
  /**
   * The role directory: the row's `role_dir`, else `<project_path>/agents/hermes/<role>`
   * exactly as the scaffold observer defaults it. Null when neither can be derived;
   * the singleton links are then `unverifiable`.
   */
  roleDir: string | null;
}

export interface FleetProfileContext {
  run: FleetRunContext;
  /** The package root whose committed gitlink pins the renderer. */
  pjanglerRoot: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** `resolveFleetHome(env, home)`: the ONE resolution the inventory also uses. */
  fleetHome: string;
  /** The profile root the contract's `service_model.profile_layout.root` resolves to, or null. */
  root: string | null;
  /** `service_model.profile_layout.generated_marker`. */
  generatedMarker: string;
  /** `service_model.profile_layout.generated_file` / `override_file`. */
  generatedFile: string;
  overrideFile: string;
  /** The host template config (`HERMES_TEMPLATE_CONFIG`, else `~/.config/hermes-agent-template/config.toml`), or null. */
  templateConfigPath: string | null;
  manifest: FleetProfileManifest;
  classifications: FleetContract["classifications"] | undefined;
  /** The registry's `gateways.bloodbank.profile_name`, or null. */
  gatewayProfileName: string | null;
  /** Every registered row's `profile_name`, for the sweep's exact-name skip and alias detection. */
  registeredProfileNames: readonly string[];
  /** Profile names more than one registry row claims. Every such row is gated `ambiguous`. */
  duplicateProfileNames: ReadonlySet<string>;
  agents: readonly FleetProfileAgentInput[];
  /** Fleet scope: sweep the root and classify extras. Agent scope never sweeps. */
  sweep: boolean;
  /** A path as it may be shown: bounded and home-redacted. Never a realpath. */
  shown: (path: string) => string;
}

export interface FleetProfileItem {
  /** Profile-relative (or a root entry name). Never absolute. */
  path: string;
  kind: FleetProfileItemKind;
  /** An identifier word or a 12-hex digest. Never a body. */
  desired: string | null;
  observed: string | null;
  /** A stable category carrying the subject: `unknown-key:foo`, `case-collision:Alpha-pm`. */
  detail: string | null;
}

/** One of the five per-agent fields, before it becomes an observation. */
export interface FleetProfileAspect {
  state: FleetStatusState;
  items: FleetProfileItem[];
  observed: string;
  desired: string;
  summary: string;
}

export interface FleetProfileRootRecord {
  state: "ok" | "error";
  code: FleetProfileRootCode;
  detail: string;
}

export interface FleetProfileRendererRecord {
  source: FleetProfileRendererCode;
  python: FleetProfilePythonCode;
  gitlink: string | null;
  detail: string;
}

/** The canonical projection as one host fact: which core skills it lacks, if any. */
export interface FleetProfileSkillCoreRecord {
  /** Where the canonical copies were looked for, shown. */
  canonicalDir: string;
  /** How the directory was chosen: the env override, the template config, or the manifest placeholder. */
  source: "env" | "template-config" | "manifest";
  /** Required skills with no readable canonical `SKILL.md`, sorted. */
  missing: string[];
}

export interface FleetProfileAgentResult {
  agentId: string;
  profileName: string | null;
  path: FleetProfileAspect & { code: FleetProfilePathCode };
  identity: FleetProfileAspect & { keys: string[] };
  config: FleetProfileAspect & {
    renderer: { state: FleetProfileRendererState; sections: string[] };
    digests: { base: string | null; delta: string | null; generated: string | null };
  };
  bank: FleetProfileAspect & { bankId: string | null; expectedBank: string | null; code: string | null };
  skills: FleetProfileAspect & {
    corePresent: number;
    coreMissing: string[];
    /** Optional skills beside the core, capped at `limits.max_extra_skills`. */
    extra: string[];
    /** Every optional skill seen, uncapped. */
    extraTotal: number;
    sourcesUnresolvable: number;
  };
  probe: FleetProbeRecord;
}

export interface FleetProfileExtras {
  /** Every classified entry, sorted by name. Uncapped here; the caller caps. */
  items: FleetStatusProfileExtraItem[];
  /** Root entries the sweep could not enumerate past `limits.max_root_entries`. */
  truncated: boolean;
}

export interface FleetProfileHealth {
  root: FleetProfileRootRecord;
  renderer: FleetProfileRendererRecord;
  skillCore: FleetProfileSkillCoreRecord;
  /** One per input agent, in input order. */
  agents: Map<string, FleetProfileAgentResult>;
  /** Null in agent scope and when the root could not be enumerated. */
  extras: FleetProfileExtras | null;
  /** Why `extras` is null, or null when it is not. */
  extrasReason: string | null;
  probes: FleetProbeRecord[];
}

// ---------------------------------------------------------------------------
// Small, safe primitives
// ---------------------------------------------------------------------------

/** `git --no-optional-locks -C <path> ...`, in that order. Same rule as provenance and scaffold, same reason. */
function gitArgv(path: string, args: readonly string[]): string[] {
  return ["git", "--no-optional-locks", "-C", path, ...args];
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** A 12-hex sha256 prefix: enough to say "these exact bytes", never the bytes. */
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/** An identifier the envelope may carry, or `unparsed` when the value is not one. */
function word(value: unknown): string {
  return typeof value === "string" && WORD.test(value) ? value : "unparsed";
}

export type EntryKind = "file" | "directory" | "symlink" | "other" | "absent" | "unreadable";

export interface EntryStat {
  kind: EntryKind;
  size: number;
}

/**
 * `lstat`, never `stat`: what the path IS, established without following it.
 *
 * Exported for the systemd observer (story 1.8), which reads a role's
 * reconcile policy and heartbeat state file with the same idiom.
 */
export function entryStat(path: string): EntryStat {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: "symlink", size: stat.size };
    if (stat.isDirectory()) return { kind: "directory", size: stat.size };
    if (stat.isFile()) return { kind: "file", size: stat.size };
    return { kind: "other", size: stat.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable", size: 0 };
  }
}

export type BoundedRead = { bytes: Buffer } | { error: "too-large" | "unreadable" };

/**
 * Read a regular file under the cap, without following a link, and without
 * ever digesting a torn read.
 *
 * The cap is enforced on the READ, not on a size read a moment earlier: the
 * file is opened with `O_NOFOLLOW`, `fstat`ed, read up to `cap + 1` bytes, and
 * `fstat`ed again; a size or mtime that moved between the two is a file
 * somebody was writing, which is retried once and then reported `unreadable`.
 *
 * Exported for the systemd observer (story 1.8): one read idiom, shared.
 */
export function readBounded(path: string, cap: number): BoundedRead {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = entryStat(path);
    if (before.kind !== "file") return { error: "unreadable" };
    if (before.size > cap) return { error: "too-large" };
    let fd: number;
    try { fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); } catch { return { error: "unreadable" }; }
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) return { error: "unreadable" };
      const buffer = Buffer.allocUnsafe(cap + 1);
      let total = 0;
      for (;;) {
        const got = readSync(fd, buffer, total, buffer.length - total, null);
        if (got === 0) break;
        total += got;
        if (total > cap) return { error: "too-large" };
      }
      const after = fstatSync(fd);
      if (after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.size === total) {
        return { bytes: Buffer.from(buffer.subarray(0, total)) };
      }
    } catch {
      return { error: "unreadable" };
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
  return { error: "unreadable" };
}

/**
 * A `{profile_name}` pattern as a glob over any name. The glob grammar is the
 * contract validator's own (`rootEntryGlob`), so the ignore list the validator
 * proved covers the lock pattern is matched here by the same rule.
 */
function patternGlob(pattern: string): RegExp {
  return rootEntryGlob(pattern.replaceAll("{profile_name}", "*"));
}

/** A registered name, case-folded with `_` and `-` unified: the two alias shapes the live root carries. */
function aliasKey(name: string): string {
  return name.toLowerCase().replaceAll("_", "-");
}

/** Structural equality over parsed YAML/JSON values. Key order is irrelevant; nothing is coerced. */
function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => stableEqual(item, b[index]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = Object.keys(a as Record<string, unknown>).sort();
    const right = Object.keys(b as Record<string, unknown>).sort();
    if (left.length !== right.length || left.some((key, index) => key !== right[index])) return false;
    return left.every((key) => stableEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function aspect(state: FleetStatusState, items: FleetProfileItem[], observed: string, desired: string, summary: string): FleetProfileAspect {
  return { state, items, observed, desired, summary };
}

function worst(items: readonly FleetProfileItem[], rank: (kind: FleetProfileItemKind) => FleetStatusState): FleetStatusState {
  let state: FleetStatusState = "pass";
  const order: FleetStatusState[] = ["pass", "warn", "fail", "error"];
  for (const item of items) {
    const candidate = rank(item.kind);
    if (order.indexOf(candidate) > order.indexOf(state)) state = candidate;
  }
  return state;
}

/** How much longer than the child budget the renderer is told it may wait on a lock. See `rendererEnv`. */
const RENDERER_LOCK_WAIT_MARGIN_SECONDS = 30;

/** The environment the renderer child and the python probe receive. An allowlist, never a filter. */
function rendererEnv(ctx: FleetProfileContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG"] as const) {
    const value = ctx.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.HOME = ctx.home;
  env.HERMES_FLEET_HOME = ctx.fleetHome;
  // The renderer's OWN lock wait is set LONGER than this observer's child
  // budget, deliberately. Its lock helper gives up with a FATAL on stderr and
  // exit 1 -- and stderr is never read here, so that exit would be
  // indistinguishable from any other renderer failure. Letting the child
  // outlive the lock wait means a held lock is reported for what it is: the
  // observer's own bounded `renderer-timeout`, on that one profile (DW-94).
  env.HERMES_PROFILE_CONFIG_LOCK_TIMEOUT_SECONDS = String(ctx.manifest.renderer.lock_timeout_seconds + RENDERER_LOCK_WAIT_MARGIN_SECONDS);
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONHASHSEED = "0";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

/** Wall-clock budget for one renderer child: the lock wait the contract allows, plus one second to read three small files. */
function rendererTimeoutMs(ctx: FleetProfileContext): number {
  return Math.ceil(ctx.manifest.renderer.lock_timeout_seconds * 1000) + 1_000;
}

// ---------------------------------------------------------------------------
// Phase 1: the root gate
// ---------------------------------------------------------------------------

class RootGate extends Error {
  constructor(readonly code: FleetProfileRootCode, readonly detail: string) { super(detail); }
}

/**
 * Is the profile root the directory the renderer reads, and is it reached
 * through real directories only?
 *
 * `classifyPath` lstats a leaf; an ancestor symlink beneath it was invisible
 * (DW-28). Every component of the fleet home and the root beneath the home
 * directory (or beneath the fleet home's parent, when the fleet home lives
 * elsewhere) is lstat'ed here, and none may be a symlink.
 */
function inspectRoot(ctx: FleetProfileContext): FleetProfileRootRecord {
  if (ctx.root === null) {
    return { state: "error", code: "layout-undeclared", detail: "the contract declares no service_model.profile_layout.root, so no profile root can be gated" };
  }
  const root = resolve(ctx.root);
  const expected = resolve(ctx.fleetHome, "profiles");
  if (root !== expected) {
    return { state: "error", code: "renderer-layout-mismatch", detail: `the contract's profile root is ${ctx.shown(root)} while the canonical renderer reads ${ctx.shown(expected)}; the two must be one directory` };
  }
  const home = resolve(ctx.home);
  const base = within(home, root) ? home : dirname(resolve(ctx.fleetHome));
  const segments = relative(base, root).split(sep).filter((segment) => segment !== "");
  let cursor = base;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]!);
    const last = index === segments.length - 1;
    const stat = entryStat(cursor);
    if (stat.kind === "absent") throw new RootGate("root-missing", `${ctx.shown(cursor)} does not exist; the profile root cannot be read`);
    if (stat.kind === "unreadable") throw new RootGate("root-unreadable", `${ctx.shown(cursor)} could not be lstat'ed`);
    if (stat.kind === "symlink") {
      throw new RootGate(last ? "root-symlink" : "root-ancestor-symlink", `${ctx.shown(cursor)} is a symlink; every profile path beneath it would resolve through it and lose its identity (the contract declares symlink_allowed: false)`);
    }
    if (stat.kind !== "directory") throw new RootGate("root-not-a-directory", `${ctx.shown(cursor)} is not a directory`);
  }
  return { state: "ok", code: "ok", detail: `${ctx.shown(root)} is a real directory reached through real directories` };
}

function gateRoot(ctx: FleetProfileContext): FleetProfileRootRecord {
  try { return inspectRoot(ctx); }
  catch (error) {
    if (error instanceof RootGate) return { state: "error", code: error.code, detail: error.detail };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: renderer integrity, once
// ---------------------------------------------------------------------------

interface RendererInspection {
  record: FleetProfileRendererRecord;
  /** The submodule worktree the renderer runs in. */
  submodule: string;
  /** The script, absolute, inside `submodule`. */
  script: string;
  probes: FleetProbeRecord[];
}

/**
 * Prove the worktree copies of the renderer and its lock helper ARE the bytes
 * at the committed gitlink, then prove a python that can run them exists.
 *
 * The same gitlink discipline as the scaffold observer: `ls-tree HEAD` and
 * `ls-files --stage` must agree, the submodule must be a repository root of
 * its own (the realpath guard from `probeCheckout`), and the expected blob ids
 * come from the pinned tree. The worktree is then read ONLY to check that it
 * matches; a mismatch is an error, never a fallback. A git probe that does
 * not answer -- failed, timed out, cancelled -- is `renderer-source-unobserved`
 * carrying the outcome, never a content verdict.
 */
async function inspectRenderer(ctx: FleetProfileContext): Promise<RendererInspection> {
  const { manifest } = ctx;
  const submodule = join(ctx.pjanglerRoot, manifest.renderer.submodule);
  const script = join(submodule, manifest.renderer.script);
  const target = ctx.shown(submodule);
  const bad = (source: FleetProfileRendererCode, detail: string, gitlink: string | null, outcome: FleetProbeRecord["outcome"] = "failed"): RendererInspection => ({
    record: { source, python: "not-probed", gitlink, detail },
    submodule, script,
    probes: [{ id: `${PROFILE_PROBE_KIND}:${target}`, kind: PROFILE_PROBE_KIND, target, outcome, reason: source }],
  });
  const unobserved = (step: string, outcome: FleetProbeRecord["outcome"], gitlink: string | null): RendererInspection => (
    bad("renderer-source-unobserved", `the ${step} probe ${outcome === "timeout" ? "timed out" : outcome === "cancelled" ? "was cancelled" : "failed"} before the renderer source could be proven; the renderer can only be proven inside a git checkout of pjangler`, gitlink, outcome === "ok" ? "failed" : outcome)
  );

  // `git -C <path>` WALKS UP. A package root that is not a checkout root of
  // its own -- an extracted build sitting inside some other repository --
  // would read THAT repository's HEAD and be told it records no gitlink, a
  // content verdict about a tree that is not pjangler's. Unobserved instead.
  const packageTop = await probe(ctx.run, gitArgv(ctx.pjanglerRoot, ["rev-parse", "--show-toplevel"]));
  throwIfCancelled(ctx.run);
  if (packageTop.outcome !== "ok") return unobserved("rev-parse --show-toplevel", packageTop.outcome, null);
  if (!packageTop.value || canonical(packageTop.value) !== canonical(ctx.pjanglerRoot)) {
    return bad("renderer-source-unobserved", `the package root is not a git checkout root of its own (${packageTop.value ? ctx.shown(packageTop.value) : "no toplevel"} answers for it), so no committed gitlink of pjangler's can be read; the renderer can only be proven inside a git checkout of pjangler`, null);
  }

  const committed = await probe(ctx.run, gitArgv(ctx.pjanglerRoot, ["ls-tree", "HEAD", "--", manifest.renderer.submodule]));
  throwIfCancelled(ctx.run);
  if (committed.outcome !== "ok") return unobserved("ls-tree HEAD", committed.outcome, null);
  const head = /^160000\s+commit\s+([0-9a-f]{40})\t/u.exec(committed.value ?? "");
  if (!head) return bad("renderer-gitlink-missing", `HEAD of the package root records no gitlink for ${manifest.renderer.submodule}; the renderer has no committed pin to be proven against`, null);
  const gitlink = head[1]!;

  const staged = await probe(ctx.run, gitArgv(ctx.pjanglerRoot, ["ls-files", "--stage", "--", manifest.renderer.submodule]));
  throwIfCancelled(ctx.run);
  if (staged.outcome !== "ok") return unobserved("ls-files --stage", staged.outcome, gitlink);
  const index = /^160000\s+([0-9a-f]{40})\s/u.exec(staged.value ?? "");
  if (!index || index[1] !== gitlink) {
    return bad("renderer-gitlink-unstable", `the index pins ${manifest.renderer.submodule} at ${index ? index[1]!.slice(0, 12) : "nothing"} while HEAD pins ${gitlink.slice(0, 12)}; a staged, uncommitted pin proves nothing`, gitlink);
  }

  const toplevel = await probe(ctx.run, gitArgv(submodule, ["rev-parse", "--show-toplevel"]));
  throwIfCancelled(ctx.run);
  if (toplevel.outcome !== "ok") return unobserved("rev-parse --show-toplevel", toplevel.outcome, gitlink);
  // `git -C <path>` WALKS UP: an empty submodule directory answers the parent's
  // root, and `rev-parse <gitlink>:<script>` there would read pjangler's own
  // objects as if they were the template's.
  if (!toplevel.value || canonical(toplevel.value) !== canonical(submodule)) {
    return bad("renderer-source-missing", `${manifest.renderer.submodule} is not an initialized submodule checkout; run git submodule update before the renderer can be proven`, gitlink);
  }

  const files = [manifest.renderer.script, manifest.renderer.lock_helper];
  const expected = await probe(ctx.run, gitArgv(submodule, ["rev-parse", ...files.map((file) => `${gitlink}:${file}`)]));
  throwIfCancelled(ctx.run);
  if (expected.outcome === "timeout" || expected.outcome === "cancelled") return unobserved("rev-parse <gitlink>:<file>", expected.outcome, gitlink);
  const ids = (expected.value ?? "").split("\n").map((line) => line.trim());
  // A readable repository answering "no such path" IS a content verdict: the
  // tree at the pin does not carry the renderer contract this build knows.
  if (expected.outcome !== "ok" || ids.length !== files.length || !ids.every((id) => /^[0-9a-f]{40}$/u.test(id))) {
    return bad("renderer-source-missing", `the tree at the committed gitlink ${gitlink.slice(0, 12)} does not carry both ${files.join(" and ")}; a changed renderer contract needs a human decision, not a guessed parser`, gitlink);
  }
  for (let position = 0; position < files.length; position += 1) {
    const file = files[position]!;
    const full = join(submodule, file);
    const stat = entryStat(full);
    if (stat.kind === "absent") return bad("renderer-source-missing", `${file} is absent from the submodule worktree`, gitlink);
    // A copy that could not be READ is not a copy that differs: a failed
    // lstat, a torn read or a cap below the script's size proves nothing
    // about the bytes, so it is unobserved, never a content verdict.
    if (stat.kind === "unreadable") return bad("renderer-source-unobserved", `${file} in the submodule worktree could not be lstat'ed, so its bytes were never compared to the committed gitlink ${gitlink.slice(0, 12)}`, gitlink);
    if (stat.kind !== "file") return bad("renderer-source-mismatched", `${file} in the submodule worktree is a ${stat.kind}, not the regular file the committed gitlink pins`, gitlink);
    const read = readBounded(full, manifest.limits.max_file_bytes);
    if ("error" in read) return bad("renderer-source-unobserved", `${file} in the submodule worktree could not be read under the file cap (${read.error}), so its bytes were never compared to the committed gitlink ${gitlink.slice(0, 12)}`, gitlink);
    if (blobId(read.bytes) !== ids[position]) {
      return bad("renderer-source-mismatched", `${file} in the submodule worktree differs from the bytes at the committed gitlink ${gitlink.slice(0, 12)}; what runs must be what is pinned, so nothing runs`, gitlink);
    }
  }

  // Only now a child: the interpreter probe, with the same narrow environment
  // the renderer will get.
  const python = await probeText(ctx.run, "python3", ["-B", "-c", PROFILE_PYTHON_PROBE], { env: rendererEnv(ctx) });
  throwIfCancelled(ctx.run);
  let pythonCode: FleetProfilePythonCode = "ok";
  if (python.outcome !== "ok") {
    pythonCode = python.status === 3 ? "renderer-python-too-old" : python.status === 4 ? "renderer-pyyaml-missing" : "renderer-python-unavailable";
  }
  const probes: FleetProbeRecord[] = [
    { id: `${PROFILE_PROBE_KIND}:${target}`, kind: PROFILE_PROBE_KIND, target, outcome: "ok", reason: null },
    { id: `${PROFILE_PROBE_KIND}:python3`, kind: PROFILE_PROBE_KIND, target: "python3", outcome: python.outcome === "cancelled" ? "failed" : python.outcome, reason: pythonCode === "ok" ? null : pythonCode },
  ];
  const detail = pythonCode === "ok"
    ? `the renderer and its lock helper in the submodule worktree equal the bytes at the committed gitlink ${gitlink.slice(0, 12)}, and python3 with PyYAML is available`
    : `the renderer source is canonical at ${gitlink.slice(0, 12)} but no python3 with PyYAML at 3.11 or newer answered (${pythonCode}); no check can run`;
  return { record: { source: "ok", python: pythonCode, gitlink, detail }, submodule, script, probes };
}

// ---------------------------------------------------------------------------
// Phase 3: one agent
// ---------------------------------------------------------------------------

/** The fleet base config, read once and shared by every agent. */
interface BaseRecord {
  state: "ok" | "missing" | "symlink" | "not-a-file" | "too-large" | "unreadable";
  digest: string | null;
  /** The parsed mapping, for the override-only delta check. Null when unparseable. */
  parsed: Record<string, unknown> | null;
}

function readBase(ctx: FleetProfileContext): BaseRecord {
  const path = join(ctx.fleetHome, RENDERER_BASE_FILE);
  const stat = entryStat(path);
  if (stat.kind === "absent") return { state: "missing", digest: null, parsed: null };
  if (stat.kind === "symlink") return { state: "symlink", digest: null, parsed: null };
  if (stat.kind !== "file") return { state: "not-a-file", digest: null, parsed: null };
  const read = readBounded(path, ctx.manifest.limits.max_file_bytes);
  if ("error" in read) return { state: read.error, digest: null, parsed: null };
  let parsed: unknown = null;
  try { parsed = YAML.parse(read.bytes.toString("utf8")); } catch { parsed = null; }
  return { state: "ok", digest: digest(read.bytes), parsed: isMapping(parsed) ? parsed : null };
}

/** The canonical skill digests, read once. Null where the canonical copy is not a readable regular file. */
function readCanonicalCore(ctx: FleetProfileContext, canonicalDir: string): Map<string, { digest: string; real: string } | null> {
  const out = new Map<string, { digest: string; real: string } | null>();
  for (const name of ctx.manifest.skill_core.required) {
    const path = join(canonicalDir, name, "SKILL.md");
    let real: string;
    try { real = realpathSync(path); } catch { out.set(name, null); continue; }
    const read = readBounded(real, ctx.manifest.limits.max_file_bytes);
    out.set(name, "error" in read ? null : { digest: digest(read.bytes), real });
  }
  return out;
}

/**
 * Where the canonical skills live, in the order `10-hermes-profile.sh:36`
 * resolves it: the `CANONICAL_SKILLS_DIR` environment override, then the
 * template config's `[fleet] canonical_skills_dir`, then the manifest's
 * placeholder default.
 */
function resolveCanonicalDir(ctx: FleetProfileContext): { dir: string; source: FleetProfileSkillCoreRecord["source"] } {
  const expand = (value: string): string | null => {
    const expanded = value === "~" ? ctx.home : value.startsWith("~/") ? join(ctx.home, value.slice(2)) : value;
    return isAbsolute(expanded) ? resolve(expanded) : null;
  };
  const override = ctx.env[ctx.manifest.skill_core.canonical_dir_env]?.trim();
  if (override) {
    const dir = expand(override);
    if (dir !== null) return { dir, source: "env" };
  }
  if (ctx.templateConfigPath !== null) {
    // The template's own `config_get` follows a link here (a dotfiles manager
    // commonly leaves one), so the observer reads the config through it too.
    // Host configuration, not profile state: nothing inside a profile is
    // followed.
    let configPath: string | null = ctx.templateConfigPath;
    try { configPath = realpathSync(configPath); } catch { configPath = null; }
    const read = configPath === null ? null : readBounded(configPath, ctx.manifest.limits.max_file_bytes);
    if (read !== null && !("error" in read)) {
      const configured = readTomlScalar(read.bytes.toString("utf8"), "fleet", CANONICAL_SKILLS_CONFIG_KEY)?.trim();
      if (configured) {
        const dir = expand(configured);
        if (dir !== null) return { dir, source: "template-config" };
      }
    }
  }
  return {
    dir: resolve(ctx.manifest.skill_core.canonical_dir.replaceAll("{HOME}", ctx.home).replaceAll("{HERMES_FLEET_HOME}", ctx.fleetHome)),
    source: "manifest",
  };
}

/** What every agent shares: the gates, the base, the canonical core, and the root listing. */
interface Shared {
  root: FleetProfileRootRecord;
  renderer: RendererInspection;
  base: BaseRecord;
  canonicalDir: string;
  canonicalReal: string;
  canonicalCore: Map<string, { digest: string; real: string } | null>;
  fleetHomeReal: string;
  /** The profile root's entry names. Empty when the root is not ok. */
  rootEntries: string[];
  /** The listing stopped at the cap, so no name can be proven unambiguous. */
  rootTruncated: boolean;
}

function unobservedAspect(code: string): FleetProfileAspect {
  return aspect("unobserved", [], "not observed", "observed beneath a real, contained, unambiguous profile directory", `not observed: the profile path gate failed (${code})`);
}

function erroredAspect(code: string, detail: string): FleetProfileAspect {
  return aspect("error", [], code, "observed beneath a real profile root", detail);
}

// `too-large` and `unreadable` are collection failures on every field that
// reads a file: the observer could not establish the bytes, so it says so
// rather than calling the file malformed or missing.
const PATH_RANK = (kind: FleetProfileItemKind): FleetStatusState => (kind === "unreadable" ? "error" : kind === "unverifiable" ? "warn" : "fail");
const IDENTITY_RANK = (kind: FleetProfileItemKind): FleetStatusState => (
  kind === "too-large" || kind === "unreadable" ? "error" : kind === "unknown-key" ? "warn" : kind === "inert-config-block" ? "pass" : "fail"
);
const CONFIG_RANK = (kind: FleetProfileItemKind): FleetStatusState => (
  kind === "base-missing" || kind === "too-large" || kind === "unreadable" || kind === "renderer-failed" || kind === "renderer-timeout" || kind === "renderer-unavailable" ? "error" : "fail"
);
const BANK_RANK = (kind: FleetProfileItemKind): FleetStatusState => (kind === "too-large" || kind === "unreadable" ? "error" : "fail");
// `canonical-missing` is a FAIL, not an error: the canonical projection lacking
// a core skill is a fleet defect (no agent can run what nothing holds), not
// this observer failing to read something. Measured live: two of the six core
// skills are absent from the canonical directory on this host (DW-91).
const SKILLS_RANK = (kind: FleetProfileItemKind): FleetStatusState => (
  kind === "extra-skill" || kind === "source-unresolvable" ? "pass" : "fail"
);

function emptyResult(input: FleetProfileAgentInput, path: FleetProfileAspect & { code: FleetProfilePathCode }, dependents: FleetProfileAspect, probe: FleetProbeRecord): FleetProfileAgentResult {
  return {
    agentId: input.agentId,
    profileName: input.profileName,
    path,
    identity: { ...dependents, keys: [] },
    config: { ...dependents, renderer: { state: dependents.state === "error" ? "error" : "unobserved", sections: [] }, digests: { base: null, delta: null, generated: null } },
    bank: { ...dependents, bankId: null, expectedBank: null, code: null },
    skills: { ...dependents, corePresent: 0, coreMissing: [], extra: [], extraTotal: 0, sourcesUnresolvable: 0 },
    probe,
  };
}

async function inspectAgent(ctx: FleetProfileContext, shared: Shared, input: FleetProfileAgentInput): Promise<FleetProfileAgentResult> {
  const name = input.profileName;
  const profileDir = name !== null && ctx.root !== null && isSafePathSegment(name) ? join(ctx.root, name) : null;
  const target = ctx.shown(profileDir ?? input.agentId);
  const skipped = (reason: string): FleetProbeRecord => ({ id: `${PROFILE_PROBE_KIND}:${target}`, kind: PROFILE_PROBE_KIND, target, outcome: "skipped", reason });

  // -- the root gate, carried onto every agent --------------------------------
  if (shared.root.state !== "ok") {
    const code = `root:${shared.root.code}` as const;
    const path = { ...erroredAspect(code, `the profile root could not be gated (${shared.root.code}); nothing beneath it was read`), code };
    return emptyResult(input, path, erroredAspect(code, `not observed: the profile root could not be gated (${shared.root.code})`), skipped(code));
  }

  // -- the path gate ------------------------------------------------------------
  const gate = (code: FleetProfileItemKind & FleetProfilePathCode, detail: string | null, summary: string): FleetProfileAgentResult => {
    const items: FleetProfileItem[] = [{ path: name ?? "(unnamed)", kind: code, desired: "directory", observed: code, detail }];
    const state = PATH_RANK(code);
    const path = { ...aspect(state, items, code, "a real, contained, unambiguous profile directory under the declared root", summary), code };
    // An `unreadable` directory is the one gate that IS a collection failure:
    // the dependents are `error` and say why, never "not observed".
    const dependents = state === "error"
      ? erroredAspect(code, `not observed: the profile directory could not be lstat'ed (${code})`)
      : unobservedAspect(code);
    return emptyResult(input, path, dependents, skipped(code));
  };
  if (name === null) return gate("unnamed", null, "the row names no profile, so no profile directory can be gated");
  if (profileDir === null || !PROFILE_NAME_PATTERN.test(name)) {
    return gate("name-unsafe", null, "the profile name is not one safe lower-case segment; Hermes would resolve its identity to the shared bank and nothing here may follow it");
  }
  if (ctx.duplicateProfileNames.has(name)) {
    return gate("ambiguous", "ambiguous:duplicate-profile-name", "more than one registry row names this profile; which agent owns the directory is ambiguous, so nothing beneath it is read");
  }
  if (shared.rootTruncated) {
    // The collision gate cannot pass over a partial listing: a twin may sit
    // past the cap. A hard failure, never a vacuous pass.
    return gate("case-collision", "case-collision:unverified", "the profile root holds more entries than the sweep may enumerate, so no profile can be proven unambiguous");
  }
  const twin = shared.rootEntries.find((entry) => entry !== name && entry.toLowerCase() === name.toLowerCase());
  if (twin !== undefined) {
    return gate("case-collision", `case-collision:${word(twin)}`, "another root entry equals this profile name case-insensitively; which directory Hermes resolves is ambiguous, so neither is read");
  }
  const dirStat = entryStat(profileDir);
  if (dirStat.kind === "absent") return gate("missing", null, "the profile directory does not exist");
  if (dirStat.kind === "symlink") return gate("symlink", null, "the profile directory is a symlink; the contract declares symlink_allowed: false and anything beneath it may belong to another agent");
  if (dirStat.kind === "unreadable") return gate("unreadable", null, "the profile directory could not be lstat'ed; nothing beneath it could be collected");
  if (dirStat.kind !== "directory") return gate("not-a-directory", null, `the profile entry is a ${dirStat.kind}, not a directory`);

  // Post-gate: the singleton entries, which must be links into THIS agent's runtime.
  const pathItems: FleetProfileItem[] = [];
  const runtime = input.roleDir === null ? null : resolve(input.roleDir, "runtime");
  const runtimeReal = runtime === null ? null : canonical(runtime);
  for (const link of PROFILE_SINGLETON_LINKS) {
    const full = join(profileDir, link);
    const kind = entryStat(full).kind;
    if (kind === "absent") continue;
    if (kind === "unreadable") {
      pathItems.push({ path: link, kind: "unverifiable", desired: "a link into this agent's role-local runtime", observed: "an entry that could not be lstat'ed", detail: `unverifiable:${link}` });
      continue;
    }
    if (kind !== "symlink") {
      // The template provisions every one of these as a link into the agent's
      // runtime. A real file or directory here is state living inside the
      // profile instead -- the stock SOUL.md Hermes seeds into a fresh profile
      // directory, which silently shadows the agent's real identity. The rule
      // reads it as `not-a-symlink`; here it is the same misowned entry.
      pathItems.push({ path: link, kind: "misowned-link", desired: "a link into this agent's role-local runtime", observed: `a real ${kind}`, detail: `not-a-link:${link}` });
      continue;
    }
    if (runtime === null || runtimeReal === null) {
      // No role directory and nothing to derive one from: the link exists and
      // cannot be judged. Said so, never silently ok.
      pathItems.push({ path: link, kind: "unverifiable", desired: "a link into this agent's role-local runtime", observed: "a link nothing can judge", detail: `unverifiable:${link}` });
      continue;
    }
    let pointed: string;
    try { pointed = resolve(dirname(full), readlinkSync(full)); } catch {
      pathItems.push({ path: link, kind: "unverifiable", desired: "a link into this agent's role-local runtime", observed: "a link that could not be read", detail: `unverifiable:${link}` });
      continue;
    }
    // Contained as written, else contained by realpath: a role directory or a
    // link target spelled through a symlinked ancestor is still this agent's
    // runtime. Neither side is followed INTO -- only the two paths are resolved.
    if (!within(runtime, pointed) && !within(runtimeReal, canonical(pointed))) {
      pathItems.push({ path: link, kind: "misowned-link", desired: "a link into this agent's role-local runtime", observed: "a link elsewhere", detail: `misowned-link:${link}` });
    }
  }
  const pathState = worst(pathItems, PATH_RANK);
  const pathCode: FleetProfilePathCode = pathState === "pass" ? "ok" : pathItems.some((item) => item.kind === "misowned-link") ? "misowned-link" : "unverifiable";
  const pathAspect = {
    ...aspect(
      pathState,
      pathItems,
      pathCode,
      "a real, contained, unambiguous profile directory whose singleton links point into this agent's runtime",
      pathCode === "misowned-link"
        ? `${pathItems.filter((item) => item.kind === "misowned-link").length} singleton entr${pathItems.filter((item) => item.kind === "misowned-link").length === 1 ? "y is" : "ies are"} not a link into this agent's role-local runtime`
        : pathCode === "unverifiable"
          ? `${pathItems.length} singleton link(s) could not be judged: the row records no role_dir and no project_path to derive one from, or the link could not be read`
          : "the profile directory is real, contained, safely named and unambiguous",
    ),
    code: pathCode,
  };
  const { manifest } = ctx;
  const cap = manifest.limits.max_file_bytes;

  // -- identity file ------------------------------------------------------------
  const identityItems: FleetProfileItem[] = [];
  const identityKeys: string[] = [];
  {
    const file = manifest.identity.file;
    const full = join(profileDir, file);
    const stat = entryStat(full);
    if (stat.kind === "absent") identityItems.push({ path: file, kind: "missing", desired: "file", observed: "absent", detail: null });
    else if (stat.kind === "symlink") identityItems.push({ path: file, kind: "symlink", desired: "file", observed: "symlink", detail: null });
    else if (stat.kind === "unreadable") identityItems.push({ path: file, kind: "unreadable", desired: "file", observed: "could not be lstat'ed", detail: null });
    else if (stat.kind !== "file") identityItems.push({ path: file, kind: "malformed", desired: "file", observed: stat.kind, detail: null });
    else {
      const read = readBounded(full, cap);
      if ("error" in read) identityItems.push({ path: file, kind: read.error, desired: "file", observed: read.error, detail: null });
      else {
        let parsed: unknown;
        let malformed = false;
        try { parsed = YAML.parse(read.bytes.toString("utf8")); } catch { malformed = true; }
        if (malformed || (parsed !== null && parsed !== undefined && !isMapping(parsed))) {
          identityItems.push({ path: file, kind: "malformed", desired: "a mapping of identity keys", observed: "not a mapping", detail: null });
        } else if (parsed === null || parsed === undefined) {
          // An empty file declares no identity at all: the same gap as a
          // missing file, wearing the file's name.
          identityItems.push({ path: file, kind: "malformed", desired: "a mapping of identity keys", observed: "empty", detail: "empty" });
        } else {
          const record = parsed as Record<string, unknown>;
          for (const key of Object.keys(record).sort()) {
            const shownKey = word(key);
            identityKeys.push(shownKey);
            if (manifest.identity.allowed_keys.includes(key)) continue;
            if (manifest.identity.inert_keys.includes(key)) {
              identityItems.push({ path: file, kind: "inert-config-block", desired: "identity keys only", observed: shownKey, detail: `inert-key:${shownKey}` });
              continue;
            }
            identityItems.push({ path: file, kind: "unknown-key", desired: "identity keys only", observed: shownKey, detail: `unknown-key:${shownKey}` });
          }
          if ("name" in record && record.name !== name) {
            identityItems.push({ path: file, kind: "identity-mismatch", desired: name, observed: word(record.name), detail: "identity-mismatch:name" });
          }
          if ("display_name" in record && input.displayName !== null && record.display_name !== input.displayName) {
            identityItems.push({ path: file, kind: "identity-mismatch", desired: "the registry display_name", observed: "a different display_name", detail: "identity-mismatch:display_name" });
          }
        }
      }
    }
  }
  const identityState = worst(identityItems, IDENTITY_RANK);
  const identityAspect = {
    ...aspect(
      identityState,
      identityItems,
      identityState === "pass" ? "identity keys only" : identityItems.map((item) => item.detail ?? item.kind).join(", "),
      "an identity-only file, naming this profile when it declares name and the registry's display_name when it declares display_name",
      identityState === "pass"
        ? `${manifest.identity.file} carries ${identityKeys.length} identity key(s) and nothing Hermes reads as config`
        : `${manifest.identity.file}: ${identityItems.map((item) => item.detail ?? item.kind).join(", ")}`,
    ),
    keys: identityKeys,
  };

  // -- generated config ---------------------------------------------------------
  const configItems: FleetProfileItem[] = [];
  const digests = { base: shared.base.digest, delta: null as string | null, generated: null as string | null };
  let generatedParsed: Record<string, unknown> | null = null;
  let generatedRegular = false;
  let deltaRegular = false;
  {
    const file = ctx.generatedFile;
    const full = join(profileDir, file);
    const stat = entryStat(full);
    if (stat.kind === "absent") configItems.push({ path: file, kind: "generated-missing", desired: "a generated file", observed: "absent", detail: null });
    else if (stat.kind === "symlink") configItems.push({ path: file, kind: "generated-symlink", desired: "a generated file", observed: "symlink", detail: null });
    else if (stat.kind === "unreadable") configItems.push({ path: file, kind: "unreadable", desired: "a generated file", observed: "could not be lstat'ed", detail: null });
    else if (stat.kind !== "file") configItems.push({ path: file, kind: "generated-missing", desired: "a generated file", observed: stat.kind, detail: null });
    else {
      const read = readBounded(full, cap);
      if ("error" in read) configItems.push({ path: file, kind: read.error, desired: "a generated file", observed: read.error, detail: null });
      else {
        generatedRegular = true;
        digests.generated = digest(read.bytes);
        if (!read.bytes.subarray(0, PROFILE_MARKER_WINDOW_BYTES).toString("utf8").includes(ctx.generatedMarker)) {
          configItems.push({ path: file, kind: "marker-missing", desired: "the generated-file marker", observed: "no marker", detail: null });
        }
        let parsed: unknown = null;
        try { parsed = YAML.parse(read.bytes.toString("utf8")); } catch { parsed = null; }
        generatedParsed = isMapping(parsed) ? parsed : null;
      }
    }
    const deltaFile = ctx.overrideFile;
    const deltaFull = join(profileDir, deltaFile);
    const deltaStat = entryStat(deltaFull);
    if (deltaStat.kind === "absent") configItems.push({ path: deltaFile, kind: "delta-missing", desired: "an override-only delta", observed: "absent", detail: null });
    else if (deltaStat.kind === "symlink") configItems.push({ path: deltaFile, kind: "delta-symlink", desired: "a real file", observed: "symlink", detail: null });
    else if (deltaStat.kind === "unreadable") configItems.push({ path: deltaFile, kind: "unreadable", desired: "a real file", observed: "could not be lstat'ed", detail: null });
    else if (deltaStat.kind !== "file") configItems.push({ path: deltaFile, kind: "delta-missing", desired: "a real file", observed: deltaStat.kind, detail: null });
    else {
      const read = readBounded(deltaFull, cap);
      if ("error" in read) configItems.push({ path: deltaFile, kind: read.error, desired: "a real file", observed: read.error, detail: null });
      else {
        deltaRegular = true;
        digests.delta = digest(read.bytes);
        // Override-only means override-only: a delta that carries the
        // generated marker, or that spells out the whole base or the whole
        // generated mapping, is a frozen copy wearing the delta's name -- the
        // exact "freeze the base and never inherit again" shape the renderer
        // was written to end. Parsed for EQUALITY only; no value is kept.
        if (read.bytes.subarray(0, PROFILE_MARKER_WINDOW_BYTES).toString("utf8").includes(ctx.generatedMarker)) {
          configItems.push({ path: deltaFile, kind: "delta-not-override-only", desired: "an override-only delta", observed: "the generated marker", detail: "generated-marker" });
        } else {
          let parsed: unknown = null;
          try { parsed = YAML.parse(read.bytes.toString("utf8")); } catch { parsed = null; }
          // Only against a base that HOLDS something: over an empty base every
          // delta equals deep_merge({}, delta), and that is inheritance with
          // nothing to inherit, not a frozen copy.
          const baseHoldsKeys = shared.base.parsed !== null && Object.keys(shared.base.parsed).length > 0;
          if (isMapping(parsed) && Object.keys(parsed).length > 0 && baseHoldsKeys) {
            if (stableEqual(parsed, shared.base.parsed)) {
              configItems.push({ path: deltaFile, kind: "delta-not-override-only", desired: "an override-only delta", observed: "a copy of the base", detail: "equals-base" });
            } else if (generatedParsed !== null && stableEqual(parsed, generatedParsed)) {
              configItems.push({ path: deltaFile, kind: "delta-not-override-only", desired: "an override-only delta", observed: "a copy of the generated config", detail: "equals-generated" });
            }
          }
        }
      }
    }
  }
  let rendererState: FleetProfileRendererState;
  const sections: string[] = [];
  let probeRecord: FleetProbeRecord = skipped("renderer-not-run");
  if (shared.base.state !== "ok") {
    configItems.push({ path: RENDERER_BASE_FILE, kind: "base-missing", desired: "the fleet base config", observed: shared.base.state, detail: `base-${shared.base.state}` });
    rendererState = "error";
    probeRecord = skipped(`base-${shared.base.state}`);
  } else if (shared.renderer.record.source !== "ok" || shared.renderer.record.python !== "ok") {
    const code = shared.renderer.record.source !== "ok" ? shared.renderer.record.source : shared.renderer.record.python;
    configItems.push({ path: ctx.generatedFile, kind: "renderer-unavailable", desired: "the canonical renderer at the committed gitlink", observed: code, detail: code });
    rendererState = "error";
    probeRecord = skipped(code);
  } else if (!generatedRegular || !deltaRegular) {
    // The renderer's own answer here would be the same two lines this observer
    // already read off `lstat`; it is not spawned for them. A file that could
    // not be READ (as opposed to one that is not there) is a collection error.
    rendererState = configItems.some((item) => item.kind === "unreadable" || item.kind === "too-large") ? "error" : "fail";
    probeRecord = skipped(configItems.map((item) => item.kind).join(","));
  } else {
    const argv = manifest.renderer.check_argv.map((arg) => arg.replaceAll("{profile_name}", name));
    const result = await probeText(ctx.run, "python3", ["-B", shared.renderer.script, ...argv], {
      cwd: shared.renderer.submodule,
      env: rendererEnv(ctx),
      timeoutMs: rendererTimeoutMs(ctx),
      keepStdoutOnFailure: true,
    });
    throwIfCancelled(ctx.run);
    const text = result.value ?? "";
    if (result.outcome === "timeout") {
      configItems.push({ path: ctx.generatedFile, kind: "renderer-timeout", desired: "the renderer's check answering within its lock timeout", observed: "timeout", detail: "renderer-timeout" });
      rendererState = "error";
      probeRecord = { id: `${PROFILE_PROBE_KIND}:${target}`, kind: PROFILE_PROBE_KIND, target, outcome: "timeout", reason: "renderer-timeout" };
    } else if (result.outcome === "ok" && text.startsWith("OK:")) {
      rendererState = "in-sync";
      probeRecord = { id: `${PROFILE_PROBE_KIND}:${target}`, kind: PROFILE_PROBE_KIND, target, outcome: "ok", reason: null };
    } else if (result.outcome === "failed" && result.status === 1 && text.startsWith("PROFILE CONFIG DRIFT:")) {
      rendererState = "drifted";
      probeRecord = { id: `${PROFILE_PROBE_KIND}:${target}`, kind: PROFILE_PROBE_KIND, target, outcome: "ok", reason: "drifted" };
      // The child is only spawned when both files are regular, so the only
      // drift line the renderer can print for this profile is `drift in: ...`.
      // Anything else -- no line for this profile, an unrecognized reason, a
      // section name that is not a word -- is still drift, reported as one
      // `unparsed` item rather than a pass.
      let why: string | null = null;
      for (const line of text.split("\n")) {
        const match = /^\s+(\S+)\s+(.+?)\s*$/u.exec(line);
        if (match && match[1] === name) { why = match[2]!; break; }
      }
      if (why !== null && why.startsWith("drift in:")) {
        for (const raw of why.slice("drift in:".length).split(",").map((item) => item.trim()).filter((item) => item !== "").slice(0, PROFILE_MAX_DRIFT_SECTIONS)) {
          sections.push(SECTION.test(raw) ? raw : "unparsed");
        }
        sections.sort();
      }
      if (sections.length === 0) {
        configItems.push({ path: ctx.generatedFile, kind: "semantic-drift", desired: "deep_merge(base, delta)", observed: "drifted", detail: "unparsed" });
      } else {
        for (const section of sections) {
          configItems.push({ path: ctx.generatedFile, kind: "semantic-drift", desired: "deep_merge(base, delta)", observed: `section ${section}`, detail: section });
        }
      }
    } else {
      configItems.push({
        path: ctx.generatedFile, kind: "renderer-failed",
        desired: "OK or a drift report from the renderer's check",
        observed: result.status === null ? "killed" : `exit ${result.status}`,
        detail: "renderer-failed",
      });
      rendererState = "error";
      probeRecord = { id: `${PROFILE_PROBE_KIND}:${target}`, kind: PROFILE_PROBE_KIND, target, outcome: "failed", reason: "renderer-failed" };
    }
  }
  const configState = worst(configItems, CONFIG_RANK);
  // In sync means in sync AND nothing else to say: a marker-less or
  // non-override-only file beside an in-sync merge is not "in-sync".
  const configClean = rendererState === "in-sync" && configItems.length === 0;
  const configAspect = {
    ...aspect(
      configState,
      configItems,
      configClean ? "in-sync" : configItems.map((item) => item.detail ?? item.kind).join(", "),
      "config.yaml == deep_merge(base, config.delta.yaml), proven by the canonical renderer's check, from an override-only delta",
      configClean
        ? "the generated config equals deep_merge(base, delta) by the canonical renderer's check"
        : `${ctx.generatedFile}: ${configItems.map((item) => item.detail ?? item.kind).join(", ")}`,
    ),
    renderer: { state: rendererState, sections },
    digests,
  };

  // -- the Hindsight bank pin ---------------------------------------------------
  const bankItems: FleetProfileItem[] = [];
  // A named agent owns a bank by identity, not by post. The explicit registry
  // declaration wins for both named agents and existing special rows. Only a
  // row with neither declaration nor stable identity uses the historical PM
  // template, preserving agent-33god-pm and every other post bank.
  const named = input.stableIdentity !== undefined && input.stableIdentity !== null;
  const expectedBank = input.declaredBank !== undefined && input.declaredBank !== null
    ? input.declaredBank
    : named
      ? null
      : manifest.memory.bank_id_template.replaceAll("{profile_name}", name);
  const expectedBankLabel = expectedBank ?? "declared personal bank";
  let observedBank: string | null = null;
  {
    const file = manifest.memory.pin_file;
    const full = join(profileDir, ...file.split("/"));
    const stat = entryStat(full);
    if (stat.kind === "absent") bankItems.push({ path: file, kind: "pin-missing", desired: expectedBankLabel, observed: "absent", detail: null });
    else if (stat.kind === "symlink") bankItems.push({ path: file, kind: "pin-symlink", desired: expectedBankLabel, observed: "symlink", detail: null });
    else if (stat.kind === "unreadable") bankItems.push({ path: file, kind: "unreadable", desired: expectedBankLabel, observed: "could not be lstat'ed", detail: null });
    else if (stat.kind !== "file") bankItems.push({ path: file, kind: "pin-malformed", desired: expectedBankLabel, observed: stat.kind, detail: null });
    else {
      const read = readBounded(full, cap);
      if ("error" in read) bankItems.push({ path: file, kind: read.error, desired: expectedBankLabel, observed: read.error, detail: null });
      else {
        let parsed: unknown;
        let malformed = false;
        try { parsed = JSON.parse(read.bytes.toString("utf8")); } catch { malformed = true; }
        if (malformed || !isMapping(parsed)) {
          bankItems.push({ path: file, kind: "pin-malformed", desired: expectedBankLabel, observed: "not a JSON object", detail: null });
        } else {
          const id = parsed.bank_id;
          if (id === undefined) {
            // A generic template is not a pin: it is exactly the resolver
            // path that falls back to the shared bank.
            bankItems.push({ path: file, kind: "bank-missing", desired: expectedBankLabel, observed: "bank_id_template" in parsed ? "bank_id_template only" : "no bank_id", detail: "bank_id_template" in parsed ? "bank_id_template" : null });
          } else if (typeof id !== "string") {
            bankItems.push({ path: file, kind: "pin-malformed", desired: expectedBankLabel, observed: "bank_id is not a string", detail: null });
          } else {
            observedBank = word(id);
            if (expectedBank === null) bankItems.push({ path: file, kind: "bank-missing", desired: expectedBankLabel, observed: observedBank, detail: "registry bank declaration missing" });
            else if (id === expectedBank) { /* pinned */ }
            else if (manifest.memory.reserved_bank_ids.includes(id)) bankItems.push({ path: file, kind: "bank-custom", desired: expectedBankLabel, observed: observedBank, detail: null });
            else if (aliasKey(id) === aliasKey(expectedBank)) bankItems.push({ path: file, kind: "bank-alias", desired: expectedBankLabel, observed: observedBank, detail: null });
            else bankItems.push({ path: file, kind: "bank-mismatch", desired: expectedBankLabel, observed: observedBank, detail: null });
          }
        }
      }
    }
  }
  const bankState = worst(bankItems, BANK_RANK);
  const bankAspect = {
    ...aspect(
      bankState,
      bankItems,
      observedBank ?? bankItems.map((item) => item.observed ?? item.kind).join(", "),
      expectedBankLabel,
      bankState === "pass" ? `the Hindsight bank is pinned to ${expectedBankLabel}` : `${manifest.memory.pin_file}: ${bankItems.map((item) => item.kind).join(", ")}`,
    ),
    bankId: observedBank,
    expectedBank,
    code: bankItems[0]?.kind ?? null,
  };

  // -- the skill core -----------------------------------------------------------
  const skillItems: FleetProfileItem[] = [];
  const coreMissing: string[] = [];
  const extra: string[] = [];
  let corePresent = 0;
  let sourcesUnresolvable = 0;
  {
    const profileReal = canonical(profileDir);
    const roots: string[] = [];
    const addRoot = (path: string): void => { if (!roots.includes(path)) roots.push(path); };
    const skillsEntry = join(profileDir, "skills");
    const skillsStat = entryStat(skillsEntry);
    let profileSkillsRoot: string | null = null;
    if (skillsStat.kind === "directory") profileSkillsRoot = skillsEntry;
    else if (skillsStat.kind === "symlink") {
      skillItems.push({ path: "skills", kind: "core-foreign", desired: "a real profile skills directory managed by skillex profile sync", observed: "whole-root symlink", detail: "Run an explicit skillex profile migration; the shared target must remain untouched" });
    } else if (skillsStat.kind !== "absent") {
      // A regular file, a special file or an entry that could not be lstat'ed
      // where the template provisions a directory: Hermes loads nothing from
      // it. Recorded as a root that could not be used, never silently skipped;
      // the core may still resolve through `skills.external_dirs`.
      skillItems.push({ path: "skills", kind: "source-unresolvable", desired: "a skills directory", observed: skillsStat.kind, detail: `skills-not-a-directory:${skillsStat.kind}` });
    }
    if (profileSkillsRoot !== null) addRoot(profileSkillsRoot);
    if (generatedParsed !== null) {
      const skills = generatedParsed.skills;
      const external = isMapping(skills) ? skills.external_dirs : undefined;
      if (Array.isArray(external)) {
        external.forEach((entry, index) => {
          if (typeof entry !== "string" || entry === "") { sourcesUnresolvable += 1; skillItems.push({ path: `skills.external_dirs[${index}]`, kind: "source-unresolvable", desired: "an absolute directory", observed: "not a path", detail: null }); return; }
          const expanded = entry === "~" ? ctx.home : entry.startsWith("~/") ? join(ctx.home, entry.slice(2)) : entry;
          if (!isAbsolute(expanded)) { sourcesUnresolvable += 1; skillItems.push({ path: `skills.external_dirs[${index}]`, kind: "source-unresolvable", desired: "an absolute directory", observed: "relative", detail: null }); return; }
          addRoot(resolve(expanded));
        });
      }
    }
    for (const skill of manifest.skill_core.required) {
      const canonicalSkill = shared.canonicalCore.get(skill) ?? null;
      if (canonicalSkill === null) {
        skillItems.push({ path: `skills/${skill}`, kind: "canonical-missing", desired: "a readable canonical SKILL.md", observed: "absent", detail: `canonical-missing:${skill}` });
        coreMissing.push(skill);
        continue;
      }
      let decided = false;
      for (const root of roots) {
        const entry = join(root, skill);
        const entryKind = entryStat(entry).kind;
        if (entryKind === "absent") continue;
        decided = true;
        if (entryKind === "symlink") {
          let entryReal: string | null = null;
          try { entryReal = realpathSync(entry); } catch { entryReal = null; }
          if (entryReal === null) { skillItems.push({ path: `skills/${skill}`, kind: "core-dangling", desired: canonicalSkill.digest, observed: "dangling", detail: `core-dangling:${skill}` }); break; }
        }
        let real: string | null = null;
        try { real = realpathSync(join(entry, "SKILL.md")); } catch { real = null; }
        // The entry resolves but holds no SKILL.md: not a skill at all, so
        // `core-missing`; a link that resolves nowhere was `core-dangling` above.
        if (real === null) { skillItems.push({ path: `skills/${skill}`, kind: "core-missing", desired: canonicalSkill.digest, observed: "no SKILL.md", detail: `core-missing:${skill}` }); break; }
        const allowed = real === canonicalSkill.real || within(shared.canonicalReal, real) || within(shared.fleetHomeReal, real) || within(profileReal, real);
        if (!allowed) { skillItems.push({ path: `skills/${skill}`, kind: "core-foreign", desired: canonicalSkill.digest, observed: "outside every allowed root", detail: `core-foreign:${skill}` }); break; }
        const read = readBounded(real, cap);
        const seen = "error" in read ? null : digest(read.bytes);
        if (seen === canonicalSkill.digest) { corePresent += 1; break; }
        skillItems.push({ path: `skills/${skill}`, kind: "core-replaced", desired: canonicalSkill.digest, observed: seen ?? ("error" in read ? read.error : "unreadable"), detail: `core-replaced:${skill}` });
        break;
      }
      if (!decided) {
        skillItems.push({ path: `skills/${skill}`, kind: "core-missing", desired: canonicalSkill.digest, observed: "absent", detail: `core-missing:${skill}` });
      }
    }
    if (profileSkillsRoot !== null) {
      let entries: string[] = [];
      try { entries = readdirSync(profileSkillsRoot).sort(); } catch { entries = []; }
      const required = new Set<string>(manifest.skill_core.required);
      for (const entry of entries.slice(0, PROFILE_MAX_SKILL_DIR_ENTRIES)) {
        if (required.has(entry) || !isSafePathSegment(entry) || entry.startsWith(".")) continue;
        let real: string | null = null;
        try { real = realpathSync(join(profileSkillsRoot, entry, "SKILL.md")); } catch { real = null; }
        if (real === null || entryStat(real).kind !== "file") continue;
        extra.push(word(entry));
      }
    }
    // Every core skill with a defect is listed for the reader, whatever the
    // defect: missing, dangling, foreign, replaced, or absent from the
    // canonical projection.
    for (const item of skillItems) {
      if (item.path.startsWith("skills/") && item.kind !== "extra-skill") {
        const skill = item.path.slice("skills/".length);
        if (!coreMissing.includes(skill)) coreMissing.push(skill);
      }
    }
    coreMissing.sort();
    extra.sort();
  }
  const listedExtra = extra.slice(0, manifest.limits.max_extra_skills);
  for (const skill of listedExtra) skillItems.push({ path: `skills/${skill}`, kind: "extra-skill", desired: null, observed: "present", detail: null });
  const skillsState = worst(skillItems, SKILLS_RANK);
  const required = manifest.skill_core.required.length;
  // What failed, by name: the core skills that do not resolve, else the
  // `skills` entry's own defect (a dangling or foreign link) when every core
  // skill still resolved through another root.
  const entryDefects = skillItems.filter((item) => item.path === "skills" && item.kind !== "source-unresolvable").map((item) => item.detail ?? item.kind);
  const skillsAspect = {
    ...aspect(
      skillsState,
      skillItems,
      skillsState === "pass"
        ? `${corePresent}/${required} core skills present by bytes`
        : coreMissing.length
          ? `${corePresent}/${required} core skills present by bytes; ${coreMissing.join(", ")} not`
          : `${corePresent}/${required} core skills present by bytes; ${entryDefects.join(", ")}`,
      `every one of the ${required} core skills present by bytes through the roots Hermes loads`,
      skillsState === "pass"
        ? `${corePresent}/${required} core skills resolve to the canonical bytes${extra.length ? `, ${extra.length} optional skill(s) beside them` : ""}`
        : coreMissing.length
          ? `${corePresent}/${required} core skills resolve to the canonical bytes; ${coreMissing.join(", ")} do not`
          : `${corePresent}/${required} core skills resolve to the canonical bytes, but the profile's own skills entry is defective (${entryDefects.join(", ")})`,
    ),
    corePresent,
    coreMissing,
    extra: listedExtra,
    extraTotal: extra.length,
    sourcesUnresolvable,
  };

  return {
    agentId: input.agentId,
    profileName: name,
    path: pathAspect,
    identity: identityAspect,
    config: configAspect,
    bank: bankAspect,
    skills: skillsAspect,
    probe: probeRecord,
  };
}

// ---------------------------------------------------------------------------
// Phase 4: the extras sweep, fleet scope only
// ---------------------------------------------------------------------------

/**
 * The XDG config home: `XDG_CONFIG_HOME`, else `<home>/.config`.
 *
 * ONE resolution, shared by the extras sweep's unit-file scan and the systemd
 * observer's fragment-path gate (story 1.8), so the two can never disagree
 * about which directory holds the user units.
 */
export function resolveConfigHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
}

/** `HERMES_HOME=<path>` values named by user unit files, counted per path. Bounded in files and bytes. */
function unitReferences(ctx: FleetProfileContext): Map<string, number> {
  const counts = new Map<string, number>();
  const dir = join(resolveConfigHome(ctx.env, ctx.home), "systemd", "user");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".service") || name.endsWith(".timer")).sort(); } catch { return counts; }
  for (const name of names.slice(0, ctx.manifest.limits.max_unit_files)) {
    // A unit is commonly a link (`systemctl link`, a dotfiles manager) and is
    // read through it: host configuration, not profile state.
    let target = join(dir, name);
    try { target = realpathSync(target); } catch { continue; }
    const read = readBounded(target, PROFILE_MAX_UNIT_FILE_BYTES);
    if ("error" in read) continue;
    const text = read.bytes.toString("utf8");
    const seen = new Set<string>();
    // The value ends at whitespace or the line's end, so a line assigning more
    // than one variable (`Environment=HERMES_HOME=/a OTHER=b`) names `/a`.
    for (const match of text.matchAll(/^\s*Environment=(?:"?)HERMES_HOME=([^"\s]+?)\/?(?:"?)(?:\s|$)/gmu)) {
      const value = match[1]!.trim();
      if (!isAbsolute(value)) continue;
      seen.add(resolve(value));
    }
    for (const value of seen) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

interface DeclaredClaim {
  klass: FleetProfileExtraClass;
  detail: string;
}

/** The contract entry, if any, that claims one root entry by name. Every claim must declare `profile` among its policy domains. */
function declaredClaim(ctx: FleetProfileContext, name: string): DeclaredClaim | null {
  const entries = (id: string): Array<Record<string, unknown>> => {
    const block = ctx.classifications?.[id];
    return block && Array.isArray(block.entries) ? block.entries.filter((entry): entry is Record<string, unknown> => isMapping(entry)) : [];
  };
  const claims = (entry: Record<string, unknown>): boolean => {
    const domains = Array.isArray(entry.policy_domains) ? entry.policy_domains : [];
    if (!domains.includes("profile")) return false;
    const source = typeof entry.source === "string" ? entry.source : "";
    if (source === "gateways.bloodbank") return ctx.gatewayProfileName === name;
    return source === `profiles.${name}`;
  };
  for (const [id, klass] of [
    ["managed_shared_service", "approved-managed-exception"],
    ["intentionally_unmanaged", "intentionally-unmanaged"],
    ["retired", "retired-candidate"],
  ] as const) {
    const list = entries(id);
    for (let index = 0; index < list.length; index += 1) {
      if (claims(list[index]!)) return { klass, detail: `classifications.${id}.entries[${index}]` };
    }
  }
  return null;
}

function unclassifiedExtra(name: string, detail: string): FleetStatusProfileExtraItem {
  return {
    path: name, class: "unclassified", kind: "other", link_target: null, standalone: null, alias_of: null,
    unit_file_references: 0, process_reference: "unobserved", guidance: "manual-review", detail,
  };
}

function classifyExtra(ctx: FleetProfileContext, root: string, name: string, registered: ReadonlySet<string>, units: ReadonlyMap<string, number>): FleetStatusProfileExtraItem {
  const full = join(root, name);
  const stat = entryStat(full);
  // An entry the listing named that cannot now be seen is a finding for an
  // operator, never debris: something is moving under the sweep.
  if (stat.kind === "absent") return unclassifiedExtra(name, "vanished");
  if (stat.kind === "unreadable") return unclassifiedExtra(name, "unreadable");
  let kind: FleetStatusProfileExtraItem["kind"] = "other";
  let linkTarget: string | null = null;
  let standalone: "complete" | "incomplete" | null = null;
  let configSymlink = false;
  if (stat.kind === "symlink") {
    try { linkTarget = ctx.shown(readlinkSync(full)); } catch { linkTarget = null; }
    let real: string | null = null;
    try { real = realpathSync(full); } catch { real = null; }
    kind = real === null ? "dangling-symlink" : "symlink";
  } else if (stat.kind === "file") {
    kind = "file";
  } else if (stat.kind === "directory") {
    let children: string[];
    try { children = readdirSync(full); } catch { return unclassifiedExtra(name, "unreadable"); }
    kind = children.length === 0 ? "empty-directory" : "directory";
    if (kind === "directory") {
      const generated = entryStat(join(full, ctx.generatedFile));
      const delta = entryStat(join(full, ctx.overrideFile));
      const pin = entryStat(join(full, ...ctx.manifest.memory.pin_file.split("/")));
      standalone = generated.kind === "file" && delta.kind === "file" && pin.kind === "file" ? "complete" : "incomplete";
      configSymlink = generated.kind === "symlink";
    }
  }

  // An alias of a registered name: case, `_`/`-`, or a backup suffix on one.
  const byAlias = new Map<string, string>();
  for (const registeredName of registered) byAlias.set(aliasKey(registeredName), registeredName);
  let aliasOf: string | null = byAlias.get(aliasKey(name)) ?? null;
  let backupPattern: string | null = null;
  for (const pattern of ctx.manifest.extras.backup_patterns) {
    const match = rootEntryGlob(pattern).exec(name);
    if (!match) continue;
    backupPattern = pattern;
    // The first wildcard is the stem only when the pattern LEADS with it
    // (`*.bak`, `*-backup*`); for `old.*` it is the suffix, and a suffix names
    // nothing.
    const stem = pattern.startsWith("*") ? match[1] : undefined;
    if (aliasOf === null && typeof stem === "string" && stem !== "") aliasOf = byAlias.get(aliasKey(stem)) ?? null;
    break;
  }

  let klass: FleetProfileExtraClass;
  let detail: string | null;
  const claim = declaredClaim(ctx, name);
  if (claim !== null) { klass = claim.klass; detail = claim.detail; }
  else if (kind === "file" || kind === "empty-directory" || kind === "dangling-symlink" || kind === "other") { klass = "debris-candidate"; detail = kind; }
  else if (backupPattern !== null) { klass = "retired-candidate"; detail = `backup-pattern:${backupPattern}`; }
  else if (aliasOf !== null) { klass = "retired-candidate"; detail = `alias-of:${aliasOf}`; }
  else if (configSymlink) { klass = "retired-candidate"; detail = "config-symlink"; }
  else { klass = "unclassified"; detail = null; }

  const guidance: FleetStatusProfileExtraItem["guidance"] = klass === "approved-managed-exception" || klass === "intentionally-unmanaged"
    ? "exception"
    : klass === "retired-candidate" || klass === "debris-candidate"
      ? "retirement"
      : standalone === "complete" ? "adoption" : "manual-review";

  return {
    path: name,
    class: klass,
    kind,
    link_target: linkTarget,
    standalone,
    alias_of: aliasOf,
    unit_file_references: units.get(resolve(full)) ?? 0,
    process_reference: "unobserved",
    guidance,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Gate, read and prove every selected profile, and -- in fleet scope --
 * classify every unregistered entry of the profile root. The entry point
 * `status.ts` calls.
 */
export async function collectProfileHealth(ctx: FleetProfileContext): Promise<FleetProfileHealth> {
  throwIfCancelled(ctx.run);
  let root = gateRoot(ctx);
  const renderer = await inspectRenderer(ctx);
  const probes: FleetProbeRecord[] = [...renderer.probes];

  // The root is enumerated ONCE, bounded, and shared: the case-collision gate
  // needs every name, and the sweep needs every name once more. A root that
  // cannot be enumerated is an error in EVERY scope -- a `--agent` run cannot
  // prove its one profile unambiguous over a listing it never got.
  // The renderer's lock entries are the observer's own footprint: excluded by
  // `renderer.lock_pattern` itself and by the declared ignore list (which the
  // contract validator proves covers it) BEFORE the cap and before any count,
  // so a lock an earlier run created changes nothing this run reports.
  const ignored = [...ctx.manifest.extras.ignored_patterns, ctx.manifest.renderer.lock_pattern].map(patternGlob);
  let rootEntries: string[] = [];
  let rootTruncated = false;
  if (root.state === "ok" && ctx.root !== null) {
    try {
      const listed = readdirSync(ctx.root).sort().filter((name) => !ignored.some((pattern) => pattern.test(name)));
      rootTruncated = listed.length > ctx.manifest.limits.max_root_entries;
      rootEntries = listed.slice(0, ctx.manifest.limits.max_root_entries);
    } catch {
      root = { state: "error", code: "root-unreadable", detail: `${ctx.shown(ctx.root)} could not be enumerated; no profile beneath it can be proven unambiguous` };
    }
  }

  const resolvedCanonical = resolveCanonicalDir(ctx);
  const canonicalCore = readCanonicalCore(ctx, resolvedCanonical.dir);
  const shared: Shared = {
    root,
    renderer,
    base: readBase(ctx),
    canonicalDir: resolvedCanonical.dir,
    canonicalReal: canonical(resolvedCanonical.dir),
    canonicalCore,
    fleetHomeReal: canonical(ctx.fleetHome),
    rootEntries,
    rootTruncated,
  };
  const skillCore: FleetProfileSkillCoreRecord = {
    canonicalDir: ctx.shown(resolvedCanonical.dir),
    source: resolvedCanonical.source,
    missing: [...canonicalCore.entries()].filter(([, value]) => value === null).map(([name]) => name).sort(),
  };

  const results = await mapBounded(ctx.agents, FLEET_STATUS_PROFILE_CONCURRENCY, (input) => inspectAgent(ctx, shared, input));
  const agents = new Map<string, FleetProfileAgentResult>();
  const probeIds = new Set(probes.map((record) => record.id));
  for (const result of results) {
    agents.set(result.agentId, result);
    // ONE probe record per directory: two rows naming one profile are both
    // gated `ambiguous` and neither reads it, so the directory was skipped
    // once, not twice.
    if (probeIds.has(result.probe.id)) continue;
    probeIds.add(result.probe.id);
    probes.push(result.probe);
  }

  let extras: FleetProfileExtras | null = null;
  let extrasReason: string | null = null;
  if (!ctx.sweep) extrasReason = "agent-scope";
  else if (root.state !== "ok") extrasReason = `root:${root.code}`;
  else {
    const registered = new Set(ctx.registeredProfileNames);
    const units = unitReferences(ctx);
    const items: FleetStatusProfileExtraItem[] = [];
    let unsafe = 0;
    for (const name of rootEntries) {
      if (registered.has(name)) continue;
      if (!isSafePathSegment(name)) {
        unsafe += 1;
        items.push(unclassifiedExtra(`unparsed:${unsafe}`, "name-unsafe"));
        continue;
      }
      items.push(classifyExtra(ctx, ctx.root!, name, registered, units));
    }
    items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    extras = { items, truncated: rootTruncated };
  }

  return { root, renderer: renderer.record, skillCore, agents, extras, extrasReason, probes };
}
