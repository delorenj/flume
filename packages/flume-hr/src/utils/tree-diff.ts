import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, type BigIntStats } from "node:fs";
import { join, relative } from "node:path";

export type TreeSnapshot = Map<string, string>;

/**
 * Files above this size are fingerprinted by metadata instead of content. Every
 * file a hire writes is small text; the bytes above this line are a project's
 * build output, renders and venvs. tolt carries 47 GB of those, and hashing them
 * twice per hire ingredient turned one `flume hire` step into ten minutes of
 * silent disk reads.
 */
export const CONTENT_HASH_MAX_BYTES = 64 * 1024;

/**
 * A stat older than this is trusted to describe the bytes it was read with.
 * Timestamps are coarse (a kernel tick), so a file rewritten within the same
 * tick at the same size can keep its stat; such "racy" files are always re-read.
 */
const RACY_WINDOW_NS = 2_000_000_000n;

const hashCache = new Map<string, { stat: string; hash: string }>();

function statKey(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function fileFingerprint(path: string, stat: BigIntStats, nowNs: bigint): string {
  const mode = Number(stat.mode & 0o777n);
  const key = statKey(stat);
  if (stat.size > BigInt(CONTENT_HASH_MAX_BYTES)) return `meta:${key}:${mode}`;
  const cached = hashCache.get(path);
  if (cached?.stat === key) return `file:${cached.hash}:${mode}`;
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (nowNs - stat.ctimeNs > RACY_WINDOW_NS && nowNs - stat.mtimeNs > RACY_WINDOW_NS) {
    hashCache.set(path, { stat: key, hash });
  } else {
    hashCache.delete(path);
  }
  return `file:${hash}:${mode}`;
}

/**
 * Snapshot operator-visible project files while excluding Git internals.
 *
 * Small files are compared by content, so an identical rewrite still reads as
 * unchanged; their hashes are reused across snapshots while the stat is stable.
 * Large files are compared by metadata, so a rewrite of one always reads as a
 * change. Either way a snapshot costs one walk, not one read of every byte.
 */
export function snapshotTree(root: string, current = root, snapshot: TreeSnapshot = new Map()): TreeSnapshot {
  walkTree(root, current, snapshot, BigInt(Date.now()) * 1_000_000n);
  return snapshot;
}

/** Other agents write to the tree while it is walked; a vanished or unreadable entry is recorded, never fatal. */
function vanished(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return `unreadable:${code}`;
  throw error;
}

function walkTree(root: string, current: string, snapshot: TreeSnapshot, nowNs: bigint): void {
  const rel = relative(root, current) || ".";
  if (rel === ".git" || rel.startsWith(`.git${process.platform === "win32" ? "\\" : "/"}`)) return;
  let stat: BigIntStats;
  try {
    stat = lstatSync(current, { bigint: true });
  } catch (error) {
    if (rel !== ".") vanished(error);
    return;
  }
  try {
    if (stat.isSymbolicLink()) {
      snapshot.set(rel, `link:${readlinkSync(current)}`);
    } else if (stat.isFile()) {
      snapshot.set(rel, fileFingerprint(current, stat, nowNs));
    } else if (stat.isDirectory()) {
      snapshot.set(rel, `dir:${Number(stat.mode & 0o777n)}`);
      // A nested repository (submodule, vendored clone) is another repo's
      // worktree. A hire writes its gitlink, never its contents, and tolt's
      // submodules are 92% of its entries.
      if (rel !== "." && existsSync(join(current, ".git"))) {
        snapshot.set(rel, `repo:${Number(stat.mode & 0o777n)}`);
        return;
      }
      for (const name of readdirSync(current)) walkTree(root, join(current, name), snapshot, nowNs);
    } else {
      snapshot.set(rel, `other:${stat.mode}`);
    }
  } catch (error) {
    snapshot.set(rel, vanished(error));
  }
}

export function changedTreePaths(root: string, before: TreeSnapshot, after: TreeSnapshot): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => path !== "." && before.get(path) !== after.get(path))
    .map((path) => join(root, path))
    .sort();
}
