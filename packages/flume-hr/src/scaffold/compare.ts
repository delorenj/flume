// The pure scaffold comparison core. NO fleet, parity, git or filesystem
// imports: both the fleet observer (`src/fleet/scaffold.ts`) and the recipe rule
// `hermes.pm-scaffold` (`src/parity/rules.ts`) depend on it, and a module that
// pulled either side in would make the two disagree about what "the same bytes"
// means the first time one of them moved.
//
// Three properties the callers rely on:
//
//   * BYTE-EXACT. A desired asset and an observed asset are compared by git
//     blob id (`sha1("blob <len>\0" + bytes)`), never by normalised text. The
//     rule used to fold CRLF to LF before comparing; the fanout that will be
//     built on this core writes bytes, so the comparison has to see them.
//   * GIT-FREE. Whether a mismatching blob is an OLDER template version
//     (`stale-content`) or somebody's edit (`locally-modified`) is decided by a
//     caller-supplied `inLineage` predicate. The observer answers it from the
//     template's object database; the filesystem-only rule answers `true` and
//     keeps its historical "stale" vocabulary.
//   * NO BODIES, NO PATHS BEYOND THE ROLE. Every finding carries a role-relative
//     path and either a 12-hex digest prefix or a type/mode word. Nothing here
//     ever returns file contents, an absolute path, or a symlink target.

import { createHash } from "node:crypto";

/**
 * The finding kinds, in the order a consumer should read them.
 *
 * `missing`          the desired asset is not there at all.
 * `stale-content`    present, different bytes, and the observed blob exists in
 *                    the template's lineage -- an older release of the asset.
 * `locally-modified` present, different bytes, and the observed blob exists in
 *                    no template version -- somebody edited it.
 * `wrong-mode`       same type, executable bit differs.
 * `wrong-type`       a directory or a symlink where a file was rendered, or
 *                    the reverse.
 * `unsafe-symlink`   a symlink whose target is absolute or leaves the repository.
 * `unexpected-owned` a tracked file inside an owned group the template did not
 *                    render at this gitlink.
 * `incomplete`       this build could not decide: a render input is missing, the
 *                    template needs control flow, or the bytes were unreadable.
 */
export const SCAFFOLD_ASSET_FINDING_KINDS = [
  "missing", "stale-content", "locally-modified", "wrong-mode",
  "wrong-type", "unsafe-symlink", "unexpected-owned", "incomplete",
] as const;
export type ScaffoldAssetFindingKind = (typeof SCAFFOLD_ASSET_FINDING_KINDS)[number];

/** Why a render could not produce desired bytes. Both are `incomplete`, never a guess. */
export type ScaffoldRenderFailureReason = "render-unsupported" | "input-missing";

export type ScaffoldRenderResult =
  | { ok: true; text: string }
  | { ok: false; reason: ScaffoldRenderFailureReason; detail: string };

/** `{{ name }}`, optional whitespace, a bare identifier. Nothing else is a placeholder. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;
/** Any Jinja delimiter left once the simple placeholders are removed. */
const JINJA_DELIMITER = /\{\{|\{%|\{#/u;

/**
 * Render a template that uses ONLY simple `{{ name }}` substitution.
 *
 * Anything else -- a `{% if %}`, a filter, a comment, whitespace control, a
 * placeholder no input declares -- is `render-unsupported`, and a declared input
 * with no value is `input-missing`. Neither is ever rendered "as best it can":
 * a desired byte this build invented would be compared against a deployed file
 * and reported as drift that no fanout could ever close.
 *
 * `inputs` maps every DECLARED input name to its value, or to null when the
 * store carries none. The distinction between "not declared" and "declared, no
 * value" is what separates the two failure reasons.
 */
export function renderTemplate(source: string, inputs: Readonly<Record<string, string | null>>): ScaffoldRenderResult {
  const stripped = source.replace(PLACEHOLDER, "");
  if (JINJA_DELIMITER.test(stripped)) {
    return { ok: false, reason: "render-unsupported", detail: "render-unsupported: template uses Jinja constructs beyond simple substitution" };
  }
  const undeclared = new Set<string>();
  const missing = new Set<string>();
  const text = source.replace(PLACEHOLDER, (whole: string, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(inputs, name)) { undeclared.add(name); return whole; }
    const value = inputs[name];
    if (value === null || value === undefined) { missing.add(name); return whole; }
    return value;
  });
  if (undeclared.size > 0) {
    return { ok: false, reason: "render-unsupported", detail: `render-unsupported: undeclared placeholder ${[...undeclared].sort().join(", ")}` };
  }
  if (missing.size > 0) {
    return { ok: false, reason: "input-missing", detail: `input-missing: ${[...missing].sort().join(", ")}` };
  }
  return { ok: true, text };
}

/** The git blob id of some bytes: `sha1("blob <len>\0" + bytes)`. The one digest notion, everywhere. */
export function blobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\u0000`, "latin1").update(bytes).digest("hex");
}

/** The 12-hex prefix a finding carries. Long enough to name a blob, short enough never to be a body. */
export function digestPrefix(id: string): string {
  return id.slice(0, 12);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]");
  return new RegExp(`^${escaped}$`, "u");
}

/**
 * The first excluded pattern a path matches, or null.
 *
 * Patterns are SEGMENT globs: `*.pyc` matches any path component, `.done-*`
 * matches a component that starts with `.done-`, and a trailing `/` makes the
 * pattern a DIRECTORY match -- `__pycache__/` matches `__pycache__/x.pyc` and
 * never a file that happens to be named `__pycache__`. A pattern that contains
 * an inner `/` is matched against the whole path instead.
 */
export function matchesExcluded(path: string, patterns: readonly string[]): string | null {
  const segments = path.split("/").filter((segment) => segment !== "");
  for (const pattern of patterns) {
    if (pattern === "" || pattern === "/") continue;
    const directory = pattern.endsWith("/");
    const glob = directory ? pattern.slice(0, -1) : pattern;
    if (glob === "") continue;
    if (glob.includes("/")) {
      const expression = globToRegExp(glob.replace(/^\/+/u, ""));
      if (directory ? segments.some((_, index) => index < segments.length - 1 && expression.test(segments.slice(0, index + 1).join("/"))) : expression.test(segments.join("/"))) return pattern;
      continue;
    }
    const expression = globToRegExp(glob);
    const candidates = directory ? segments.slice(0, -1) : segments;
    if (candidates.some((segment) => expression.test(segment))) return pattern;
  }
  return null;
}

/**
 * The declared group a role-relative path belongs to, longest prefix wins.
 *
 * A group value ending in `/` owns everything beneath it; any other value is
 * one exact file. `scaffold.sentinel.prompt.md: .scripts/sentinel.prompt.md`
 * therefore beats `scaffold.scripts: .scripts/` for that one file, which is what
 * lets the contract declare a leaf for the single rendered asset inside a
 * verbatim directory. Ties are broken by leaf name so two runs agree.
 */
export function groupFor(path: string, groups: Readonly<Record<string, string>>): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const leaf of Object.keys(groups).sort()) {
    const rolePath = groups[leaf]!;
    const matches = rolePath.endsWith("/") ? path.startsWith(rolePath) : path === rolePath;
    if (!matches) continue;
    const length = rolePath.endsWith("/") ? rolePath.length : rolePath.length + 1;
    if (length > bestLength) { best = leaf; bestLength = length; }
  }
  return best;
}

export type ScaffoldAssetType = "file" | "symlink";

/** One asset the template renders at the recorded gitlink, as the comparison sees it. */
export interface ScaffoldDesiredAsset {
  /** Role-relative, forward slashes, render suffix already stripped. */
  path: string;
  type: ScaffoldAssetType;
  executable: boolean;
  /**
   * The 40-hex blob id of the desired bytes (or, for a symlink, of its target
   * string -- which is how git stores one). Null when the asset is presence-only
   * or its render is incomplete.
   */
  blobId: string | null;
  /** Compared for type and mode only. Declared by contract policy, never inferred. */
  presenceOnly: boolean;
  /** Set when desired bytes could not be produced. The comparison reports it and compares nothing. */
  incomplete: { reason: ScaffoldRenderFailureReason; detail: string } | null;
}

/** What is on disk for one desired path, established by `lstat` and never by following it. */
export interface ScaffoldObservedAsset {
  present: boolean;
  type: "file" | "symlink" | "directory" | "other" | null;
  executable: boolean;
  /** Blob id of the observed bytes (or symlink target). Null when not read. */
  blobId: string | null;
  /** The observed entry is a symlink whose target is absolute or leaves the repository. */
  unsafeSymlink: boolean;
  /** A stable category (`too-large`, `unreadable`) when the bytes could not be read. Never a message. */
  unreadable: string | null;
  /** The working tree carries an uncommitted change to this path. */
  wip: boolean;
}

export interface ScaffoldAssetFinding {
  path: string;
  kind: ScaffoldAssetFindingKind;
  /** A 12-hex digest prefix, or a type/mode word. Never a body, never a target. */
  desired: string | null;
  observed: string | null;
  detail: string | null;
  wip: boolean;
}

export interface CompareAssetsOptions {
  /**
   * Whether `blobId` is a version of `path` the template ever shipped.
   *
   * Decides `stale-content` against `locally-modified`. The observer answers
   * from the template's object database; the filesystem-only rule cannot and
   * answers true, keeping its historical "stale" reading.
   */
  inLineage: (blobId: string, path: string) => boolean;
  /**
   * Compare the executable bit. Default true.
   *
   * The recipe rule passes false: its migration writes bytes and never lowers a
   * mode, so a mode finding there would be one `pjangler migrate` can never
   * close, and a rule that cannot pass after its own repair is a lie.
   */
  modes?: boolean;
}

function typeWord(asset: ScaffoldDesiredAsset): string {
  return asset.type;
}

function modeWord(executable: boolean): string {
  return executable ? "100755" : "100644";
}

/**
 * Compare every desired asset with what `observe` reports for it.
 *
 * At most one CONTENT finding per path, plus an independent `wrong-mode` when
 * the bit differs: a file that is both stale and wrongly moded is two facts,
 * and a consumer choosing overwrite versus block needs both. Presence-only
 * assets stop after type and mode. Findings are sorted by path, then kind, so
 * two runs over unchanged state produce identical lists.
 */
export function compareAssets(
  desired: readonly ScaffoldDesiredAsset[],
  observe: (asset: ScaffoldDesiredAsset) => ScaffoldObservedAsset,
  options: CompareAssetsOptions,
): ScaffoldAssetFinding[] {
  const out: ScaffoldAssetFinding[] = [];
  const compareModes = options.modes !== false;
  const push = (asset: ScaffoldDesiredAsset, seen: ScaffoldObservedAsset, kind: ScaffoldAssetFindingKind, desiredWord: string | null, observedWord: string | null, detail: string | null = null): void => {
    out.push({ path: asset.path, kind, desired: desiredWord, observed: observedWord, detail, wip: seen.wip });
  };

  for (const asset of desired) {
    const seen = observe(asset);
    if (asset.incomplete) {
      push(asset, seen, "incomplete", null, seen.present ? seen.type : "absent", asset.incomplete.detail);
      continue;
    }
    if (!seen.present) { push(asset, seen, "missing", typeWord(asset), "absent"); continue; }
    if (seen.type === "symlink" && seen.unsafeSymlink) { push(asset, seen, "unsafe-symlink", typeWord(asset), "symlink"); continue; }
    if (seen.type !== asset.type) { push(asset, seen, "wrong-type", typeWord(asset), seen.type ?? "unknown"); continue; }
    if (compareModes && asset.type === "file" && seen.executable !== asset.executable) {
      push(asset, seen, "wrong-mode", modeWord(asset.executable), modeWord(seen.executable));
    }
    if (asset.presenceOnly || asset.blobId === null) continue;
    if (seen.unreadable !== null || seen.blobId === null) {
      push(asset, seen, "incomplete", digestPrefix(asset.blobId), null, `unreadable: ${seen.unreadable ?? "unread"}`);
      continue;
    }
    if (seen.blobId === asset.blobId) continue;
    const kind: ScaffoldAssetFindingKind = options.inLineage(seen.blobId, asset.path) ? "stale-content" : "locally-modified";
    push(asset, seen, kind, digestPrefix(asset.blobId), digestPrefix(seen.blobId));
  }

  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

export interface ScaffoldExtrasInput {
  /** Every tracked path under the role directory, role-relative. */
  trackedPaths: readonly string[];
  /** The desired asset paths at this gitlink. */
  ownedPaths: ReadonlySet<string>;
  groups: Readonly<Record<string, string>>;
  /** The ignored role-local runtime directory. Nothing under it is ever owned or foreign. */
  runtimeDir: string;
  excludedPatterns: readonly string[];
}

export interface ScaffoldExtras {
  /** Tracked files inside an owned group that the template did not render. Named, never proposed for deletion. */
  unexpected: Array<{ path: string; group: string; detail: string | null }>;
  /** Tracked files outside every owned group. Counted, never named. */
  foreignTracked: number;
}

/**
 * Classify every tracked path the template does not own.
 *
 * A tracked file inside an owned group -- a `.done-*` marker the provisioner
 * committed, a `.gitignore.jinja` copied unrendered -- is `unexpected-owned`
 * and is named, because a fanout has to decide about it. A tracked file
 * outside every group is the repository's own business: counted so the
 * envelope says how much unrelated work sits beside the scaffold, never named
 * and never a finding.
 */
export function classifyExtras(input: ScaffoldExtrasInput): ScaffoldExtras {
  const unexpected: ScaffoldExtras["unexpected"] = [];
  let foreignTracked = 0;
  const runtimePrefix = `${input.runtimeDir.replace(/\/+$/u, "")}/`;
  for (const path of input.trackedPaths) {
    if (input.ownedPaths.has(path)) continue;
    if (path.startsWith(runtimePrefix)) { foreignTracked += 1; continue; }
    const group = groupFor(path, input.groups);
    if (group === null) { foreignTracked += 1; continue; }
    const excluded = matchesExcluded(path, input.excludedPatterns);
    unexpected.push({ path, group, detail: excluded === null ? null : `matches excluded pattern ${excluded}` });
  }
  unexpected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { unexpected, foreignTracked };
}
