import { lstatSync, readFileSync } from "node:fs";
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
      out.push({ path, removable: true, detail: "obsolete template-owned helper" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") out.push({ path, removable: false, detail: "unreadable path" });
    }
  }
  return out;
}
