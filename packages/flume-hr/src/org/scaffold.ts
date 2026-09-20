// Read-only scaffold parity: every managed role directory against the tracked
// template at the COMMITTED gitlink, asset by asset.
//
// Before this, `template_scaffold` could not say whether any deployed PM
// scaffold matched the canonical template: the only comparison that existed
// (`hermes.pm-scaffold`) read desired bytes from pjangler's own mutable
// submodule worktree, compared text, ignored `momo`, modes, types, symlinks and
// extra tracked files, and returned prose. Measured on this repository: the
// launcher and eleven scripts stale, six owned assets missing, thirteen
// provisioning droppings tracked inside the role -- none of it visible to the
// fleet read model.
//
// Five disciplines:
//
//   * DESIRED BYTES COME FROM GIT OBJECTS AT THE COMMITTED GITLINK. `ls-tree
//     HEAD -- templates/hermes-agent` in the package root names the commit;
//     `ls-tree -r` and `cat-file --batch` at that commit produce the manifest
//     and the bytes. The submodule worktree, `PJANGLER_HERMES_TEMPLATE`, a
//     sibling clone, `gh:` and `PATH` are never consulted for desired state.
//     "Newer bytes from a dirty worktree" is structurally unreachable, and
//     pycache contamination is impossible because nothing untracked exists in
//     a tree.
//   * A BROKEN SOURCE IS AN ERROR, NEVER A FALLBACK. A mismatched or dirty
//     worktree, a staged-but-uncommitted pin, an uninitialized submodule, a
//     missing object, a contaminated tree, an uncovered path -- each is a host
//     finding that marks every selected agent's eight groups `error`. Nothing
//     renders "whatever is there".
//   * STALE IS LINEAGE, NOT COMMIT STATE. A mismatching verbatim blob that
//     exists in the template's object database is `stale-content`; one that
//     does not is `locally-modified`. A rendered asset is stale when it equals
//     the render of one of the last twelve versions of its Jinja source.
//     Uncommitted edits are an orthogonal `wip` flag. This is the exact input a
//     fanout needs to choose overwrite versus block.
//   * READ-ONLY, BYTE-STABLE, NO BODIES. Every git read goes through the
//     bounded probe runner with `--no-optional-locks`; every per-agent fan-out
//     is bounded and cancellable; nothing emitted carries a timestamp, a
//     realpath, a file body, a diff or a credential. Digests are 12-hex blob-id
//     prefixes.
//   * IGNORED RUNTIME AND FOREIGN FILES ARE COUNTED, NEVER NAMED. The role's
//     `runtime/`, git-ignored entries and tracked files outside every owned
//     group are the repository's business: they are counted so the envelope
//     says how much sits beside the scaffold, and never named, compared, or
//     proposed for deletion.
//
// This module never constructs a `FleetStatusObservation`. It returns typed
// per-agent group results, a source record and probe records; `status.ts`
// turns them into observations through its single construction point.

import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  blobId,
  classifyExtras,
  compareAssets,
  groupFor,
  matchesExcluded,
  renderTemplate,
  type ScaffoldAssetFinding,
  type ScaffoldDesiredAsset,
  type ScaffoldObservedAsset,
} from "../scaffold/compare";
import { mapBounded, probe, probeRaw, throwIfCancelled, type FleetRunContext } from "./runtime";
import {
  FLEET_STATUS_SCAFFOLD_CONCURRENCY,
  type FleetProbeRecord,
  type FleetScaffoldManifest,
  type FleetScaffoldSourceCode,
} from "./types";

/** Bytes of one owned asset this observer will read. Past it the asset is `incomplete: too-large`. */
export const SCAFFOLD_MAX_ASSET_BYTES = 4 * 1024 * 1024;

/** Tracked or status entries under one role directory this observer will walk. */
export const SCAFFOLD_MAX_ROLE_ENTRIES = 5000;

/** How many versions of a rendered asset's Jinja source count as its lineage. */
export const SCAFFOLD_LINEAGE_DEPTH = 12;

/** The probe `kind` every record this module emits carries. */
export const SCAFFOLD_PROBE_KIND = "scaffold";

export interface FleetScaffoldAgentInput {
  agentId: string;
  /** The row's `project_path`, home-expanded and resolved. Null when the row records none. */
  projectPath: string | null;
  /** The row's `role_dir` as recorded (home-expanded; may be relative). Null when the row is silent. */
  roleDir: string | null;
  role: string | null;
  /** Every declared render input by placeholder name; null where the store carries no value. */
  inputs: Readonly<Record<string, string | null>>;
}

export interface FleetScaffoldContext {
  run: FleetRunContext;
  /** The package root whose committed gitlink is the source of truth. */
  pjanglerRoot: string;
  manifest: FleetScaffoldManifest;
  agents: readonly FleetScaffoldAgentInput[];
  /** A path as it may be shown: bounded and home-redacted. Never a realpath. */
  shown: (path: string) => string;
}

export interface FleetScaffoldSourceRecord {
  /** The committed gitlink, 40-hex. Null when the parent records none. */
  gitlink: string | null;
  /** One of `FLEET_SCAFFOLD_SOURCE_CODES`, or `manifest-uncovered:<role-relative path>`. */
  integrity: string;
  detail: string;
  /** Assets the template renders at the gitlink. 0 when the source is unreadable. */
  assets: number;
}

export interface FleetScaffoldGroupResult {
  /** The declared leaf, e.g. `scaffold.scripts`. */
  group: string;
  /** The role-relative path the leaf owns, e.g. `.scripts/`. */
  role_path: string;
  state: "pass" | "fail" | "error";
  owned: number;
  matching: number;
  drifted: number;
  incomplete: number;
  unexpected: number;
  /** Every item, sorted by path then kind. The caller caps. */
  items: ScaffoldAssetFinding[];
}

export interface FleetScaffoldAgentResult {
  agentId: string;
  /** Absolute, lexically resolved. The caller redacts. Null when none could be resolved. */
  roleDir: string | null;
  roleDirSource: "registry" | "default";
  /** A stable category naming why nothing could be compared for this agent, or null. */
  error: string | null;
  groups: FleetScaffoldGroupResult[];
  assets: { owned: number; compared: number; matching: number; drifted: number; incomplete: number; unexpected_owned: number };
  /** Drifted owned paths that also carry an uncommitted change. Uncapped here. */
  wipOverlap: string[];
  wipPreserved: number;
  foreignTracked: number;
  ignoredEntries: number;
}

export interface FleetScaffoldParity {
  source: FleetScaffoldSourceRecord;
  /** One per input agent, in input order. */
  agents: FleetScaffoldAgentResult[];
  probes: FleetProbeRecord[];
}

/** `git --no-optional-locks -C <path> ...`, in that order. Same rule as provenance, same reason. */
function gitArgv(path: string, args: readonly string[]): string[] {
  return ["git", "--no-optional-locks", "-C", path, ...args];
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** One asset the tree at the gitlink renders, before any agent's inputs are applied. */
interface ManifestAsset {
  /** Path inside the submodule repository, e.g. `template/hermes.jinja`. */
  templatePath: string;
  /** Role-relative, render suffix stripped. */
  rolePath: string;
  sha: string;
  mode: string;
  type: "file" | "symlink";
  executable: boolean;
  rendered: boolean;
  group: string;
  presenceOnly: boolean;
}

interface SourceInspection {
  record: FleetScaffoldSourceRecord;
  submodule: string;
  assets: ManifestAsset[];
  /** Decoded Jinja sources for the rendered, content-compared assets, by template path. */
  renderSources: Map<string, { text: string } | { unsupported: string }>;
  probe: FleetProbeRecord;
}

/** Parse `git cat-file --batch` output into bytes by requested key, in request order. */
function parseBatch(output: Buffer, keys: readonly string[]): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  let offset = 0;
  for (const key of keys) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) { out.set(key, null); continue; }
    const header = output.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    const parts = header.split(" ");
    if (parts.length < 3 || parts[1] === "missing" || parts[1] === "ambiguous") { out.set(key, null); continue; }
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) { out.set(key, null); continue; }
    out.set(key, output.subarray(offset, offset + size));
    // The blob is followed by one newline git adds.
    offset += size + 1;
  }
  return out;
}

/**
 * Phase 1: is the SOURCE trustworthy, and what does it render?
 *
 * Every check reads the package root's git or the submodule's git through the
 * bounded runner. The first failing check names the integrity code and stops;
 * the worktree is consulted only to say whether it is canonical (mismatched or
 * dirty is an ERROR the operator must see) and never for a desired byte.
 */
async function inspectSource(ctx: FleetScaffoldContext): Promise<SourceInspection> {
  const { manifest } = ctx;
  const submodule = join(ctx.pjanglerRoot, manifest.template_submodule);
  const target = ctx.shown(submodule);
  const empty = (integrity: string, detail: string, gitlink: string | null, outcome: FleetProbeRecord["outcome"] = "failed"): SourceInspection => ({
    record: { gitlink, integrity, detail, assets: 0 },
    submodule,
    assets: [],
    renderSources: new Map(),
    probe: { id: `${SCAFFOLD_PROBE_KIND}:${target}`, kind: SCAFFOLD_PROBE_KIND, target, outcome, reason: integrity },
  });
  const unobserved = (step: string, outcome: "timeout" | "failed", gitlink: string | null): SourceInspection => (
    empty("source-unobserved", `the ${step} probe ${outcome === "timeout" ? "timed out" : "failed"} before the template source could be read`, gitlink, outcome)
  );

  // -- the committed gitlink, from HEAD, and its agreement with the index ----
  const committed = await probe(ctx.run, gitArgv(ctx.pjanglerRoot, ["ls-tree", "HEAD", "--", manifest.template_submodule]));
  throwIfCancelled(ctx.run);
  if (committed.outcome === "timeout") return unobserved("ls-tree HEAD", "timeout", null);
  const head = /^160000\s+commit\s+([0-9a-f]{40})\t/u.exec(committed.value ?? "");
  if (!head) {
    return empty("gitlink-missing", `HEAD of the package root records no gitlink for ${manifest.template_submodule}; the template has no committed pin to compare against`, null);
  }
  const gitlink = head[1]!;

  const staged = await probe(ctx.run, gitArgv(ctx.pjanglerRoot, ["ls-files", "--stage", "--", manifest.template_submodule]));
  throwIfCancelled(ctx.run);
  if (staged.outcome === "timeout") return unobserved("ls-files --stage", "timeout", gitlink);
  const index = /^160000\s+([0-9a-f]{40})\s/u.exec(staged.value ?? "");
  if (!index || index[1] !== gitlink) {
    return empty("gitlink-unstable", `the index pins ${manifest.template_submodule} at ${index ? index[1]!.slice(0, 12) : "nothing"} while HEAD pins ${gitlink.slice(0, 12)}; a staged, uncommitted pin is not a version anything can be compared against`, gitlink);
  }

  // -- the submodule is a repository root of its own -------------------------
  const toplevel = await probe(ctx.run, gitArgv(submodule, ["rev-parse", "--show-toplevel"]));
  throwIfCancelled(ctx.run);
  if (toplevel.outcome === "timeout") return unobserved("rev-parse --show-toplevel", "timeout", gitlink);
  // `git -C <path>` WALKS UP: an empty or absent submodule directory answers
  // the PARENT's root, and reading objects there would read pjangler's own
  // history as if it were the template's. The realpath guard is copied from
  // `probeCheckout` for exactly that reason.
  if (toplevel.outcome !== "ok" || !toplevel.value || canonical(toplevel.value) !== canonical(submodule)) {
    return empty("source-uninitialized", `${manifest.template_submodule} is not an initialized submodule checkout; run git submodule update to make the pinned template readable`, gitlink);
  }

  // -- the pinned commit exists, and the worktree is at it and clean ---------
  const object = await probe(ctx.run, gitArgv(submodule, ["cat-file", "-e", `${gitlink}^{commit}`]));
  throwIfCancelled(ctx.run);
  if (object.outcome === "timeout") return unobserved("cat-file -e", "timeout", gitlink);
  if (object.outcome !== "ok") {
    return empty("source-missing-object", `the committed gitlink ${gitlink.slice(0, 12)} names a commit the submodule's object database does not hold; fetch the template before comparing against it`, gitlink);
  }
  const worktreeHead = await probe(ctx.run, gitArgv(submodule, ["rev-parse", "HEAD"]));
  throwIfCancelled(ctx.run);
  if (worktreeHead.outcome === "timeout") return unobserved("rev-parse HEAD", "timeout", gitlink);
  if (worktreeHead.outcome !== "ok" || worktreeHead.value !== gitlink) {
    return empty("source-mismatched", `the template worktree is at ${worktreeHead.value ? worktreeHead.value.slice(0, 12) : "no commit"} while the parent commits ${gitlink.slice(0, 12)}; the checkout is not canonical`, gitlink);
  }
  // TRACKED changes only. DW-74 measured false dirt from untracked files the
  // stripped global excludes would have hidden; an untracked file changes no
  // desired byte and is not dirt for this observer.
  const dirty = await probe(ctx.run, gitArgv(submodule, ["status", "--porcelain", "--untracked-files=no"]));
  throwIfCancelled(ctx.run);
  if (dirty.outcome === "timeout") return unobserved("status --porcelain", "timeout", gitlink);
  if (dirty.outcome !== "ok") return unobserved("status --porcelain", "failed", gitlink);
  if ((dirty.value ?? "") !== "") {
    return empty("source-dirty", `the template worktree carries modified tracked files; desired bytes are read from the committed gitlink ${gitlink.slice(0, 12)} and never from a dirty checkout, and the checkout must be clean before it is canonical`, gitlink);
  }

  // -- the manifest: every blob under the render subdirectory at the gitlink -
  const tree = await probeRaw(ctx.run, gitArgv(submodule, ["ls-tree", "-r", "-z", gitlink, "--", manifest.template_subdirectory]));
  throwIfCancelled(ctx.run);
  if (tree.outcome === "timeout") return unobserved("ls-tree -r", "timeout", gitlink);
  if (tree.outcome !== "ok" || tree.value === null) return unobserved("ls-tree -r", "failed", gitlink);
  const prefix = `${manifest.template_subdirectory.replace(/\/+$/u, "")}/`;
  const assets: ManifestAsset[] = [];
  const entries = tree.value.toString("utf8").split("\u0000").filter((entry) => entry !== "");
  for (const entry of entries) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/su.exec(entry);
    if (!match) continue;
    const [, mode, type, sha, templatePath] = match as unknown as [string, string, string, string, string];
    if (!templatePath.startsWith(prefix)) continue;
    const raw = templatePath.slice(prefix.length);
    if (type !== "blob") {
      return empty("source-contaminated", `the tree at ${gitlink.slice(0, 12)} carries a ${type} at ${raw}; a template renders blobs only`, gitlink);
    }
    const excluded = matchesExcluded(raw, manifest.excluded_patterns);
    if (excluded !== null) {
      return empty("source-contaminated", `the tree at ${gitlink.slice(0, 12)} carries ${raw}, which matches the excluded pattern ${excluded}; a contaminated template cannot be the desired state`, gitlink);
    }
    const rendered = raw.endsWith(manifest.render_suffix);
    const rolePath = rendered ? raw.slice(0, -manifest.render_suffix.length) : raw;
    if (rolePath === "" || rolePath.endsWith("/")) {
      return empty("source-contaminated", `the tree at ${gitlink.slice(0, 12)} renders an unnamed asset from ${raw}`, gitlink);
    }
    const group = groupFor(rolePath, manifest.groups);
    if (group === null) {
      return empty(`manifest-uncovered:${rolePath}`, `the tree at ${gitlink.slice(0, 12)} renders ${rolePath}, which no scaffold_manifest.groups entry owns; declare a group for it before it can be compared`, gitlink);
    }
    assets.push({
      templatePath,
      rolePath,
      sha,
      mode,
      type: mode === "120000" ? "symlink" : "file",
      executable: mode === "100755",
      rendered,
      group,
      presenceOnly: manifest.presence_only.some((item) => item.path === rolePath),
    });
  }
  if (assets.length === 0) {
    return empty("source-empty", `the tree at ${gitlink.slice(0, 12)} renders nothing under ${manifest.template_subdirectory}; an empty template is not a desired state`, gitlink);
  }
  assets.sort((a, b) => (a.rolePath < b.rolePath ? -1 : a.rolePath > b.rolePath ? 1 : 0));

  // -- the rendered sources, in ONE batch, by blob id -------------------------
  const renderSources = new Map<string, { text: string } | { unsupported: string }>();
  const wanted = assets.filter((asset) => asset.rendered && !asset.presenceOnly && asset.type === "file");
  if (wanted.length > 0) {
    const ids = [...new Set(wanted.map((asset) => asset.sha))];
    const batch = await probeRaw(ctx.run, gitArgv(submodule, ["cat-file", "--batch"]), undefined, `${ids.join("\n")}\n`);
    throwIfCancelled(ctx.run);
    if (batch.outcome === "timeout") return unobserved("cat-file --batch", "timeout", gitlink);
    if (batch.outcome !== "ok" || batch.value === null) return unobserved("cat-file --batch", "failed", gitlink);
    const blobs = parseBatch(batch.value, ids);
    for (const asset of wanted) {
      const bytes = blobs.get(asset.sha) ?? null;
      if (bytes === null) {
        return empty("source-missing-object", `blob ${asset.sha.slice(0, 12)} for ${asset.rolePath} is absent from the submodule's object database`, gitlink);
      }
      const text = bytes.toString("utf8");
      // A source that does not round-trip through utf8 cannot be rendered as
      // text without changing bytes it never asked to change.
      renderSources.set(asset.templatePath, Buffer.from(text, "utf8").equals(bytes)
        ? { text }
        : { unsupported: "render-unsupported: template source is not UTF-8 text" });
    }
  }

  return {
    record: { gitlink, integrity: "ok", detail: `${assets.length} asset(s) rendered by the template at the committed gitlink ${gitlink.slice(0, 12)}`, assets: assets.length },
    submodule,
    assets,
    renderSources,
    probe: { id: `${SCAFFOLD_PROBE_KIND}:${target}`, kind: SCAFFOLD_PROBE_KIND, target, outcome: "ok", reason: null },
  };
}

/** The desired asset list for ONE agent: verbatim blobs as they are, rendered ones through its inputs. */
function desiredFor(source: SourceInspection, input: FleetScaffoldAgentInput): ScaffoldDesiredAsset[] {
  return source.assets.map((asset) => {
    const base: ScaffoldDesiredAsset = {
      path: asset.rolePath,
      type: asset.type,
      executable: asset.executable,
      blobId: asset.sha,
      presenceOnly: asset.presenceOnly,
      incomplete: null,
    };
    if (asset.presenceOnly) return { ...base, blobId: null };
    if (!asset.rendered || asset.type !== "file") return base;
    const rendered = source.renderSources.get(asset.templatePath);
    if (!rendered) return { ...base, blobId: null, incomplete: { reason: "render-unsupported", detail: "render-unsupported: source not read" } };
    if ("unsupported" in rendered) return { ...base, blobId: null, incomplete: { reason: "render-unsupported", detail: rendered.unsupported } };
    const result = renderTemplate(rendered.text, input.inputs);
    if (!result.ok) return { ...base, blobId: null, incomplete: { reason: result.reason, detail: result.detail } };
    return { ...base, blobId: blobId(Buffer.from(result.text, "utf8")) };
  });
}

/** What one agent's role directory holds, read once, before any comparison. */
interface AgentScan {
  input: FleetScaffoldAgentInput;
  roleDir: string | null;
  roleDirSource: "registry" | "default";
  error: string | null;
  /** The repository root, canonical. Null until the checkout is proven. */
  top: string | null;
  observed: Map<string, ScaffoldObservedAsset>;
  tracked: string[];
  wipPaths: Set<string>;
  wipPreserved: number;
  ignoredEntries: number;
  probe: FleetProbeRecord;
}

function absent(): ScaffoldObservedAsset {
  return { present: false, type: null, executable: false, blobId: null, unsafeSymlink: false, unreadable: null, wip: false };
}

/**
 * Phase 3, per agent: resolve the role directory, prove the checkout, list the
 * tracked and dirty entries beneath it, and `lstat`/read every owned path.
 *
 * Nothing here compares. A scan is an I/O record; the comparison runs after
 * every scan is in, because lineage lookups are batched across agents.
 */
async function scanAgent(ctx: FleetScaffoldContext, source: SourceInspection, input: FleetScaffoldAgentInput): Promise<AgentScan> {
  const scan: AgentScan = {
    input, roleDir: null, roleDirSource: input.roleDir !== null ? "registry" : "default", error: null, top: null,
    observed: new Map(), tracked: [], wipPaths: new Set(), wipPreserved: 0, ignoredEntries: 0,
    probe: { id: "", kind: SCAFFOLD_PROBE_KIND, target: "", outcome: "skipped", reason: null },
  };
  const fail = (error: string, outcome: FleetProbeRecord["outcome"] = "skipped"): AgentScan => {
    scan.error = error;
    scan.probe = { ...scan.probe, outcome, reason: error };
    return scan;
  };
  const setTarget = (path: string): void => {
    const shown = ctx.shown(path);
    scan.probe = { ...scan.probe, id: `${SCAFFOLD_PROBE_KIND}:${shown}`, target: shown };
  };

  if (input.projectPath === null) { setTarget(input.agentId); return fail("repository-unreadable:no-project-path"); }
  setTarget(input.projectPath);

  const toplevel = await probe(ctx.run, gitArgv(input.projectPath, ["rev-parse", "--show-toplevel"]));
  throwIfCancelled(ctx.run);
  if (toplevel.outcome === "timeout") return fail("probe-timeout", "timeout");
  if (toplevel.outcome !== "ok" || !toplevel.value) return fail("repository-unreadable:not-a-repository", "failed");
  const top = canonical(toplevel.value);
  // The same walk-up guard as everywhere else: a `project_path` inside some
  // unrelated repository would otherwise be compared as if it were that
  // repository's scaffold.
  if (top !== canonical(input.projectPath)) return fail("repository-unreadable:not-a-repository-root");
  scan.top = top;

  // -- the role directory: the row's, else the canonical default -----------
  let roleDir: string;
  if (input.roleDir !== null) {
    roleDir = isAbsolute(input.roleDir) ? resolve(input.roleDir) : resolve(input.projectPath, input.roleDir);
  } else if (input.role !== null && input.role !== "" && input.role !== "." && input.role !== ".." && !input.role.includes("/")) {
    roleDir = join(input.projectPath, "agents", "hermes", input.role);
  } else {
    return fail("role-unresolved");
  }
  scan.roleDir = roleDir;
  setTarget(roleDir);

  let roleRel: string;
  let roleReal: string;
  try {
    const stat = lstatSync(roleDir);
    if (stat.isSymbolicLink()) return fail("role-dir-symlink");
    if (!stat.isDirectory()) return fail("role-dir-not-a-directory");
    roleReal = canonical(roleDir);
    // A role directory that IS the repository root is a registry shape this
    // observer cannot compare: every tracked file in the repository would be
    // "inside the role", and the runtime checkpoint repositories that record
    // it are not project scaffolds. Named for what it is.
    if (roleReal === top) return fail("role-dir-is-repository-root");
    if (!within(top, roleReal)) return fail("role-dir-outside-project");
    roleRel = relative(top, roleReal);
  } catch {
    // Absent: every owned asset will be `missing`. Containment is decided
    // lexically, against the declared project path and the canonical root.
    const lexical = resolve(roleDir);
    const project = resolve(input.projectPath);
    if (lexical === project || lexical === top) return fail("role-dir-is-repository-root");
    if (within(project, lexical)) roleRel = relative(project, lexical);
    else if (within(top, lexical)) roleRel = relative(top, lexical);
    else return fail("role-dir-outside-project");
    roleReal = lexical;
  }
  const rolePosix = roleRel.split(sep).join("/");
  // `:(literal)` so a role directory named with a glob character is one path,
  // not a pattern; `-C <top>` so the relative pathspec is anchored at the root.
  const pathspec = `:(literal)${rolePosix}`;

  const tracked = await probeRaw(ctx.run, gitArgv(top, ["ls-files", "-z", "--", pathspec]));
  throwIfCancelled(ctx.run);
  if (tracked.outcome === "timeout") return fail("probe-timeout", "timeout");
  if (tracked.outcome !== "ok" || tracked.value === null) return fail("repository-unreadable:probe-failed", "failed");
  const status = await probeRaw(ctx.run, gitArgv(top, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--", pathspec]));
  throwIfCancelled(ctx.run);
  if (status.outcome === "timeout") return fail("probe-timeout", "timeout");
  if (status.outcome !== "ok" || status.value === null) return fail("repository-unreadable:probe-failed", "failed");

  const toRole = (path: string): string | null => (
    path.startsWith(`${rolePosix}/`) ? path.slice(rolePosix.length + 1) : null
  );
  const trackedEntries = tracked.value.toString("utf8").split("\u0000").filter((entry) => entry !== "");
  const statusEntries = status.value.toString("utf8").split("\u0000");
  if (trackedEntries.length + statusEntries.length > SCAFFOLD_MAX_ROLE_ENTRIES) return fail("role-entries-exceeded");
  for (const entry of trackedEntries) {
    const rolePath = toRole(entry);
    if (rolePath !== null) scan.tracked.push(rolePath);
  }
  scan.tracked.sort();
  for (let index = 0; index < statusEntries.length; index += 1) {
    const entry = statusEntries[index]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy carries its ORIGINAL path as the next NUL-separated
    // field; it is not an entry of its own.
    if (xy[0] === "R" || xy[0] === "C") index += 1;
    const rolePath = toRole(path.replace(/\/$/u, ""));
    if (rolePath === null && !path.startsWith(`${rolePosix}/`)) continue;
    if (xy === "!!") { scan.ignoredEntries += 1; continue; }
    scan.wipPreserved += 1;
    if (xy !== "??" && rolePath !== null) scan.wipPaths.add(rolePath);
  }

  // -- every owned path, lstat'ed and read, never followed -------------------
  for (const asset of source.assets) {
    const full = join(roleReal, ...asset.rolePath.split("/"));
    const seen = absent();
    seen.wip = scan.wipPaths.has(asset.rolePath);
    try {
      const stat = lstatSync(full);
      seen.present = true;
      if (stat.isSymbolicLink()) {
        seen.type = "symlink";
        const link = readlinkSync(full);
        let resolvedTarget: string | null = null;
        try { resolvedTarget = realpathSync(resolve(dirname(full), link)); } catch { resolvedTarget = null; }
        seen.unsafeSymlink = isAbsolute(link) || (resolvedTarget !== null && !within(top, resolvedTarget));
        seen.blobId = blobId(Buffer.from(link, "utf8"));
      } else if (stat.isDirectory()) {
        seen.type = "directory";
      } else if (stat.isFile()) {
        seen.type = "file";
        seen.executable = (stat.mode & 0o111) !== 0;
        if (stat.size > SCAFFOLD_MAX_ASSET_BYTES) seen.unreadable = "too-large";
        else {
          try { seen.blobId = blobId(readFileSync(full)); } catch { seen.unreadable = "unreadable"; }
        }
      } else {
        seen.type = "other";
      }
    } catch {
      // ENOENT, or an unreadable parent: absent either way.
    }
    scan.observed.set(asset.rolePath, seen);
  }

  scan.probe = { ...scan.probe, outcome: "ok", reason: null };
  return scan;
}

/** The lineage answers, batched once across every scanned agent. */
interface Lineage {
  /** Observed verbatim blob ids that exist in the template's object database. */
  verbatim: Set<string>;
  /** Per agent index, per role path: blob ids of the last N renders of that asset with this agent's inputs. */
  rendered: Map<number, Map<string, Set<string>>>;
  /** True when a lineage probe could not run; stale-vs-modified is then undecidable. */
  unobserved: boolean;
}

/**
 * Phase 4: which mismatching blobs are OLDER TEMPLATE VERSIONS.
 *
 * Verbatim assets: one `cat-file --batch-check` over every mismatching observed
 * blob id -- present in the object database means some template version shipped
 * those bytes. Rendered assets: `log -n 12` over the Jinja source, one
 * `cat-file --batch` for every historical version, rendered per agent with that
 * agent's inputs. Both lazily, both deduped across agents, both bounded.
 */
async function resolveLineage(
  ctx: FleetScaffoldContext,
  source: SourceInspection,
  scans: readonly AgentScan[],
  desiredByAgent: readonly ScaffoldDesiredAsset[][],
): Promise<Lineage> {
  const lineage: Lineage = { verbatim: new Set(), rendered: new Map(), unobserved: false };
  const verbatimIds = new Set<string>();
  const renderedNeeded = new Map<string, Set<number>>();
  const assetByPath = new Map(source.assets.map((asset) => [asset.rolePath, asset] as const));

  scans.forEach((scan, index) => {
    if (scan.error !== null) return;
    for (const desired of desiredByAgent[index] ?? []) {
      if (desired.presenceOnly || desired.blobId === null || desired.type !== "file") continue;
      const seen = scan.observed.get(desired.path);
      if (!seen || !seen.present || seen.type !== "file" || seen.blobId === null || seen.blobId === desired.blobId) continue;
      const asset = assetByPath.get(desired.path);
      if (!asset) continue;
      if (asset.rendered) {
        const set = renderedNeeded.get(asset.templatePath) ?? new Set<number>();
        set.add(index);
        renderedNeeded.set(asset.templatePath, set);
      } else {
        verbatimIds.add(seen.blobId);
      }
    }
  });

  if (verbatimIds.size > 0) {
    const ids = [...verbatimIds].sort();
    const check = await probeRaw(ctx.run, gitArgv(source.submodule, ["cat-file", "--batch-check"]), undefined, `${ids.join("\n")}\n`);
    throwIfCancelled(ctx.run);
    if (check.outcome !== "ok" || check.value === null) lineage.unobserved = true;
    else {
      for (const line of check.value.toString("utf8").split("\n")) {
        const match = /^([0-9a-f]{40}) (\w+)/u.exec(line);
        if (match && match[2] !== "missing") lineage.verbatim.add(match[1]!);
      }
    }
  }

  if (renderedNeeded.size > 0) {
    const gitlink = source.record.gitlink!;
    const keys: string[] = [];
    const versions = new Map<string, string[]>();
    for (const templatePath of [...renderedNeeded.keys()].sort()) {
      const log = await probe(ctx.run, gitArgv(source.submodule, ["log", "--format=%H", "-n", String(SCAFFOLD_LINEAGE_DEPTH), gitlink, "--", templatePath]));
      throwIfCancelled(ctx.run);
      if (log.outcome !== "ok") { lineage.unobserved = true; continue; }
      const commits = (log.value ?? "").split("\n").map((line) => line.trim()).filter((line) => /^[0-9a-f]{40}$/u.test(line));
      const perPath = commits.map((commit) => `${commit}:${templatePath}`);
      versions.set(templatePath, perPath);
      keys.push(...perPath);
    }
    if (keys.length > 0) {
      const batch = await probeRaw(ctx.run, gitArgv(source.submodule, ["cat-file", "--batch"]), undefined, `${keys.join("\n")}\n`);
      throwIfCancelled(ctx.run);
      if (batch.outcome !== "ok" || batch.value === null) lineage.unobserved = true;
      else {
        const blobs = parseBatch(batch.value, keys);
        for (const [templatePath, agentIndexes] of renderedNeeded) {
          const asset = source.assets.find((item) => item.templatePath === templatePath);
          if (!asset) continue;
          const sources = (versions.get(templatePath) ?? [])
            .map((key) => blobs.get(key) ?? null)
            .filter((bytes): bytes is Buffer => bytes !== null)
            .map((bytes) => bytes.toString("utf8"));
          for (const index of agentIndexes) {
            const scan = scans[index]!;
            const rendered = new Set<string>();
            for (const text of sources) {
              const result = renderTemplate(text, scan.input.inputs);
              if (result.ok) rendered.add(blobId(Buffer.from(result.text, "utf8")));
            }
            const perAgent = lineage.rendered.get(index) ?? new Map<string, Set<string>>();
            perAgent.set(asset.rolePath, rendered);
            lineage.rendered.set(index, perAgent);
          }
        }
      }
    }
  }

  return lineage;
}

/** Eight error groups, for an agent nothing could be compared for. */
function erroredGroups(manifest: FleetScaffoldManifest, assets: readonly ManifestAsset[], detail: string): FleetScaffoldGroupResult[] {
  return Object.keys(manifest.groups).sort().map((group) => {
    const rolePath = manifest.groups[group]!;
    const owned = assets.filter((asset) => asset.group === group).length;
    return {
      group, role_path: rolePath, state: "error" as const,
      owned, matching: 0, drifted: 0, incomplete: owned, unexpected: 0,
      items: [{ path: rolePath, kind: "incomplete" as const, desired: null, observed: null, detail, wip: false }],
    };
  });
}

function emptyAgentResult(input: FleetScaffoldAgentInput, groups: FleetScaffoldGroupResult[], error: string, roleDir: string | null, roleDirSource: "registry" | "default"): FleetScaffoldAgentResult {
  const owned = groups.reduce((total, group) => total + group.owned, 0);
  return {
    agentId: input.agentId, roleDir, roleDirSource, error, groups,
    assets: { owned, compared: 0, matching: 0, drifted: 0, incomplete: owned, unexpected_owned: 0 },
    wipOverlap: [], wipPreserved: 0, foreignTracked: 0, ignoredEntries: 0,
  };
}

/**
 * Compare every managed role directory against the template at the committed
 * gitlink. The entry point `status.ts` calls.
 */
export async function collectScaffoldParity(ctx: FleetScaffoldContext): Promise<FleetScaffoldParity> {
  throwIfCancelled(ctx.run);
  const source = await inspectSource(ctx);
  const probes: FleetProbeRecord[] = [source.probe];
  const manifest = ctx.manifest;

  if (source.record.integrity !== "ok") {
    // No fallback. Every agent's eight groups are `error`, with the source code
    // on each, and no role directory is read at all.
    const detail = `source:${source.record.integrity}`;
    const agents = ctx.agents.map((input) => {
      const roleDir = input.roleDir !== null
        ? (isAbsolute(input.roleDir) ? resolve(input.roleDir) : input.projectPath === null ? null : resolve(input.projectPath, input.roleDir))
        : (input.projectPath !== null && input.role ? join(input.projectPath, "agents", "hermes", input.role) : null);
      const target = ctx.shown(roleDir ?? input.projectPath ?? input.agentId);
      probes.push({ id: `${SCAFFOLD_PROBE_KIND}:${target}`, kind: SCAFFOLD_PROBE_KIND, target, outcome: "skipped", reason: "source-unreadable" });
      return emptyAgentResult(input, erroredGroups(manifest, [], detail), detail, roleDir, input.roleDir !== null ? "registry" : "default");
    });
    return { source: source.record, agents, probes };
  }

  const scans = await mapBounded(ctx.agents, FLEET_STATUS_SCAFFOLD_CONCURRENCY, (input) => scanAgent(ctx, source, input));
  const desiredByAgent = ctx.agents.map((input) => desiredFor(source, input));
  const lineage = await resolveLineage(ctx, source, scans, desiredByAgent);

  const ownedPaths = new Set(source.assets.map((asset) => asset.rolePath));
  const agents = scans.map((scan, index): FleetScaffoldAgentResult => {
    probes.push(scan.probe);
    if (scan.error !== null) {
      return emptyAgentResult(scan.input, erroredGroups(manifest, source.assets, scan.error), scan.error, scan.roleDir, scan.roleDirSource);
    }
    const desired = desiredByAgent[index] ?? [];
    const renderedLineage = lineage.rendered.get(index) ?? new Map<string, Set<string>>();
    let findings = compareAssets(desired, (asset) => scan.observed.get(asset.path) ?? absent(), {
      inLineage: (id, path) => lineage.verbatim.has(id) || (renderedLineage.get(path)?.has(id) ?? false),
    });
    if (lineage.unobserved) {
      // A lineage probe failed, so stale-versus-modified is undecidable for
      // this run. Reported as incomplete rather than guessed either way.
      findings = findings.map((finding) => (
        finding.kind === "stale-content" || finding.kind === "locally-modified"
          ? { ...finding, kind: "incomplete" as const, detail: "lineage-unobserved" }
          : finding
      ));
    }
    const extras = classifyExtras({
      trackedPaths: scan.tracked,
      ownedPaths,
      groups: manifest.groups,
      runtimeDir: manifest.runtime_dir,
      excludedPatterns: manifest.excluded_patterns,
    });

    const groups = Object.keys(manifest.groups).sort().map((group): FleetScaffoldGroupResult => {
      const rolePath = manifest.groups[group]!;
      const ownedHere = source.assets.filter((asset) => asset.group === group);
      const ownedSet = new Set(ownedHere.map((asset) => asset.rolePath));
      const items: ScaffoldAssetFinding[] = findings.filter((finding) => ownedSet.has(finding.path));
      for (const extra of extras.unexpected) {
        if (extra.group !== group) continue;
        items.push({ path: extra.path, kind: "unexpected-owned", desired: null, observed: "tracked", detail: extra.detail, wip: scan.wipPaths.has(extra.path) });
      }
      items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
      const incompletePaths = new Set(items.filter((item) => item.kind === "incomplete").map((item) => item.path));
      const driftedPaths = new Set(items.filter((item) => item.kind !== "incomplete" && item.kind !== "unexpected-owned" && !incompletePaths.has(item.path)).map((item) => item.path));
      const unexpected = items.filter((item) => item.kind === "unexpected-owned").length;
      const owned = ownedHere.length;
      return {
        group, role_path: rolePath,
        state: incompletePaths.size > 0 ? "error" : driftedPaths.size > 0 || unexpected > 0 ? "fail" : "pass",
        owned,
        matching: owned - incompletePaths.size - driftedPaths.size,
        drifted: driftedPaths.size,
        incomplete: incompletePaths.size,
        unexpected,
        items,
      };
    });

    const totals = groups.reduce((sum, group) => ({
      owned: sum.owned + group.owned,
      compared: sum.compared + group.owned - group.incomplete,
      matching: sum.matching + group.matching,
      drifted: sum.drifted + group.drifted,
      incomplete: sum.incomplete + group.incomplete,
      unexpected_owned: sum.unexpected_owned + group.unexpected,
    }), { owned: 0, compared: 0, matching: 0, drifted: 0, incomplete: 0, unexpected_owned: 0 });
    const wipOverlap = [...new Set(groups.flatMap((group) => group.items).filter((item) => item.wip).map((item) => item.path))].sort();

    return {
      agentId: scan.input.agentId,
      roleDir: scan.roleDir,
      roleDirSource: scan.roleDirSource,
      error: null,
      groups,
      assets: totals,
      wipOverlap,
      wipPreserved: scan.wipPreserved,
      foreignTracked: extras.foreignTracked,
      ignoredEntries: scan.ignoredEntries,
    };
  });

  return { source: source.record, agents, probes };
}
