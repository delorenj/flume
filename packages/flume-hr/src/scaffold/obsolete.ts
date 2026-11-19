import { linkSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { blobId } from "./compare";

// Exact verbatim blobs shipped before template c738f69 removed these helpers.
// Do not use the permissive packaged-template lineage fallback for deletions.
const OBSOLETE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  "lifecycle.sh": ["269dc7bd0c63d8b4697f6d47e6ce50c342011efe"],
  "managed-execution.py": ["954b08256397ba7170391360f8214f33daec5f34", "6966a5e676681f20fd5d13fe965b871b8f33bb54"],
};

export interface ObsoleteScaffoldScript {
  path: string;
  removable: boolean;
  detail: string;
  /** Device/inode of the bytes classified; not a pathname-only authorization. */
  identity?: { dev: number; ino: number };
}

/**
 * Move the classified file into a private directory before checking its identity
 * and bytes. A replacement at the public pathname is never unlinked by this
 * operation. On a mismatch, restore without overwriting a new occupant; if the
 * name is occupied, leave the quarantined file for manual recovery.
 *
 * This narrows the race, not a check-then-unlink atomicity guarantee against
 * concurrent writers to the quarantined inode or mutable parent directories.
 */
export function removeObsoleteScaffoldScript(repoRoot: string, roleDir: string, obsolete: ObsoleteScaffoldScript): { removed: boolean; detail: string } {
  const name = obsolete.path.slice(".scripts/".length);
  const shipped = OBSOLETE_SCRIPTS[name];
  if (!obsolete.removable || !obsolete.identity || !shipped || obsolete.path !== `.scripts/${name}`) {
    return { removed: false, detail: "unverified obsolete helper" };
  }
  const parent = join(roleDir, ".scripts");
  const target = join(parent, name);
  let quarantine: string | undefined;
  let held: string | undefined;
  let moved = false;
  const result = { removed: false, detail: "" };
  try {
    if (!scaffoldScriptsHaveSafeParents(repoRoot, roleDir)) {
      result.detail = "unsafe parent directory at removal";
      return result;
    }
    const current = lstatSync(target);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== obsolete.identity.dev || current.ino !== obsolete.identity.ino) {
      result.detail = "helper changed since classification";
      return result;
    }
    quarantine = mkdtempSync(join(parent, ".flume-obsolete-"));
    if (!scaffoldScriptsHaveSafeParents(repoRoot, roleDir)) {
      result.detail = "unsafe parent directory at removal";
      return result;
    }
    held = join(quarantine, name);
    renameSync(target, held);
    moved = true;
    const stat = lstatSync(held);
    let publicNameOccupied = false;
    try { lstatSync(target); publicNameOccupied = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (publicNameOccupied || !scaffoldScriptsHaveSafeParents(repoRoot, roleDir) || !stat.isFile() || stat.isSymbolicLink()
      || stat.dev !== obsolete.identity.dev || stat.ino !== obsolete.identity.ino
      || stat.size > 64 * 1024 || !shipped.includes(blobId(readFileSync(held)))) {
      result.detail = "helper changed during removal or parent became unsafe";
      return result;
    }
    // The private name makes pathname replacement at the public name harmless.
    // Do not present this as a race-free lock against writers to the inode.
    unlinkSync(held);
    moved = false;
    result.removed = true;
    result.detail = "obsolete template-owned helper removed";
    return result;
  } catch (error) {
    result.detail = `removal interrupted (${error instanceof Error ? error.message : String(error)})`;
    return result;
  } finally {
    if (moved && held && scaffoldScriptsHaveSafeParents(repoRoot, roleDir)) {
      try {
        // link is exclusive: never overwrite a replacement that arrived mid-operation.
        linkSync(held, target);
        unlinkSync(held);
        moved = false;
      } catch { /* The quarantined file remains recoverable at its reported path. */ }
    }
    if (moved && held) result.detail += `; recover held file at ${held}`;
    if (quarantine) {
      try { rmdirSync(quarantine); } catch { /* A held file must remain visible to the operator. */ }
    }
  }
}

/** Refuse linked ancestors, including an in-repository link to somebody else's scripts. */
export function scaffoldScriptsHaveSafeParents(repoRoot: string, roleDir: string): boolean {
  const root = resolve(repoRoot);
  const role = resolve(roleDir);
  const rel = relative(root, role);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  const scripts = resolve(role, ".scripts");
  const scriptRel = relative(root, scripts);
  if (!scriptRel || scriptRel === ".." || scriptRel.startsWith(`..${sep}`)) return false;
  let current = root;
  for (const part of ["", ...scriptRel.split(sep)]) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}

/** Only two retired paths, absent from the current template, with byte-exact shipped content. */
export function obsoleteScaffoldScripts(repoRoot: string, roleDir: string, templateRoleDir: string): ObsoleteScaffoldScript[] {
  const out: ObsoleteScaffoldScript[] = [];
  try {
    const source = lstatSync(join(templateRoleDir, ".scripts"));
    if (!source.isDirectory() || source.isSymbolicLink()) return out;
  } catch { return out; }
  for (const [name, shipped] of Object.entries(OBSOLETE_SCRIPTS)) {
    const path = `.scripts/${name}`;
    try {
      lstatSync(join(templateRoleDir, path));
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        out.push({ path, removable: false, detail: "template absence cannot be verified" });
        continue;
      }
    }
    try {
      if (!scaffoldScriptsHaveSafeParents(repoRoot, roleDir)) {
        out.push({ path, removable: false, detail: "unsafe parent directory" });
        continue;
      }
      const target = join(roleDir, path);
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        out.push({ path, removable: false, detail: "not a regular file" });
        continue;
      }
      if (stat.size > 64 * 1024 || !shipped.includes(blobId(readFileSync(target)))) {
        out.push({ path, removable: false, detail: "locally-modified content" });
        continue;
      }
      out.push({ path, removable: true, detail: "obsolete template-owned helper", identity: { dev: stat.dev, ino: stat.ino } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") out.push({ path, removable: false, detail: "unreadable path" });
    }
  }
  return out;
}
