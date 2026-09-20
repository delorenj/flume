import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

export type TreeSnapshot = Map<string, string>;

/** Snapshot operator-visible project files while excluding Git internals. */
export function snapshotTree(root: string, current = root, snapshot: TreeSnapshot = new Map()): TreeSnapshot {
  if (!existsSync(current)) return snapshot;
  const rel = relative(root, current) || ".";
  if (rel === ".git" || rel.startsWith(`.git${process.platform === "win32" ? "\\" : "/"}`)) return snapshot;
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) {
    snapshot.set(rel, `link:${readlinkSync(current)}`);
  } else if (stat.isFile()) {
    snapshot.set(rel, `file:${createHash("sha256").update(readFileSync(current)).digest("hex")}:${stat.mode & 0o777}`);
  } else if (stat.isDirectory()) {
    snapshot.set(rel, `dir:${stat.mode & 0o777}`);
    for (const name of readdirSync(current)) snapshotTree(root, join(current, name), snapshot);
  } else {
    snapshot.set(rel, `other:${stat.mode}`);
  }
  return snapshot;
}

export function changedTreePaths(root: string, before: TreeSnapshot, after: TreeSnapshot): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => path !== "." && before.get(path) !== after.get(path))
    .map((path) => join(root, path))
    .sort();
}
