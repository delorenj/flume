import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import type {
  DeskProvisionOptions,
  DeskProvisionResult,
  NamedAgentContract,
  ResolvedNamedAgentContract,
  ResolvedSkill,
} from "./types.js";
import { validateNamedAgent } from "./validator.js";

/**
 * Expand leading '~' or '~/' in a path to the user's home directory.
 */
function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * Resolve the canonical filesystem path for an agent's desk.
 */
export function resolveDeskPath(
  contract: NamedAgentContract,
  options: DeskProvisionOptions = {},
): string {
  const home = options.home ?? homedir();
  if (contract.desk?.path) {
    const expanded = expandHome(contract.desk.path, home);
    if (isAbsolute(expanded)) return expanded;
    if (options.deskRoot) return resolve(options.deskRoot, expanded);
    return resolve(home, expanded);
  }
  if (options.deskRoot) {
    return join(options.deskRoot, contract.id);
  }
  return join(home, ".agents", "workforce", contract.id);
}

/**
 * Materialize an agent's desk directory and reconcile its .agents/skills symlinks.
 *
 * Adheres strictly to Skillex ADR-0001:
 * - Compiled .agents/skills are symlinks pointing directly to canonical skills in all-skills/.
 * - Never copies file payloads or SKILL.md into desk directories.
 * - Reconciles existing symlinks idempotently without deleting or altering user notes in the desk.
 */
export async function provisionDesk(
  contractInput: NamedAgentContract | ResolvedNamedAgentContract | string,
  options: DeskProvisionOptions = {},
): Promise<DeskProvisionResult> {
  let resolvedContract: ResolvedNamedAgentContract;

  if (typeof contractInput === "string") {
    resolvedContract = await validateNamedAgent(contractInput, {
      skillexRoot: options.skillexRoot,
      home: options.home,
    });
  } else if ("resolvedSkills" in contractInput && Array.isArray((contractInput as ResolvedNamedAgentContract).resolvedSkills)) {
    resolvedContract = contractInput as ResolvedNamedAgentContract;
  } else {
    resolvedContract = await validateNamedAgent(contractInput, {
      skillexRoot: options.skillexRoot,
      home: options.home,
    });
  }

  const resolvedSkills: ResolvedSkill[] = options.resolvedSkills ?? resolvedContract.resolvedSkills;
  const deskPath = resolveDeskPath(resolvedContract, options);
  const skillsDir = join(deskPath, ".agents", "skills");

  if (options.dryRun) {
    return {
      deskPath,
      skillsDir,
      created: resolvedSkills.length,
      updated: 0,
      preserved: 0,
      removed: 0,
      skills: resolvedSkills.map((s) => ({ name: s.name, target: s.path })),
    };
  }

  // 1. Create desk root and .agents/skills
  try {
    mkdirSync(deskPath, { recursive: true });
  } catch (err) {
    throw new Error(
      `Filesystem creation error for desk directory at "${deskPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    mkdirSync(skillsDir, { recursive: true });
  } catch (err) {
    throw new Error(
      `Filesystem creation error for skills directory at "${skillsDir}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Reconcile symlinks in .agents/skills
  const desiredSkills = new Map<string, string>();
  for (const skill of resolvedSkills) {
    desiredSkills.set(skill.name, skill.path);
  }

  let created = 0;
  let updated = 0;
  let preserved = 0;
  let removed = 0;
  const finalSkills: Array<{ name: string; target: string }> = [];

  // Read existing entries in .agents/skills
  let existingEntries;
  try {
    existingEntries = readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Filesystem read error for skills directory at "${skillsDir}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const seen = new Set<string>();

  for (const entry of existingEntries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(skillsDir, entry.name);

    if (desiredSkills.has(entry.name)) {
      seen.add(entry.name);
      const desiredTarget = desiredSkills.get(entry.name)!;

      if (entry.isSymbolicLink()) {
        let currentTarget: string;
        try {
          currentTarget = readlinkSync(entryPath);
        } catch (err) {
          throw new Error(
            `Filesystem readlink error at "${entryPath}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const resolvedCurrent = isAbsolute(currentTarget)
          ? resolve(currentTarget)
          : resolve(skillsDir, currentTarget);
        const resolvedDesired = resolve(desiredTarget);

        if (resolvedCurrent === resolvedDesired) {
          preserved++;
          finalSkills.push({ name: entry.name, target: desiredTarget });
        } else {
          try {
            unlinkSync(entryPath);
            symlinkSync(desiredTarget, entryPath);
          } catch (err) {
            throw new Error(
              `Filesystem error updating symlink at "${entryPath}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          updated++;
          finalSkills.push({ name: entry.name, target: desiredTarget });
        }
      } else {
        throw new Error(
          `Conflict: "${entryPath}" is a regular file or directory. Skills in desk must be symlinks.`,
        );
      }
    } else {
      // Unmanaged / stale skill symlink
      if (entry.isSymbolicLink()) {
        try {
          unlinkSync(entryPath);
          removed++;
        } catch (err) {
          throw new Error(
            `Filesystem error removing stale symlink at "${entryPath}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  // Add missing desired skills
  for (const [name, target] of desiredSkills.entries()) {
    if (!seen.has(name)) {
      const entryPath = join(skillsDir, name);
      try {
        symlinkSync(target, entryPath);
        created++;
        finalSkills.push({ name, target });
      } catch (err) {
        throw new Error(
          `Filesystem error creating symlink at "${entryPath}" -> "${target}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 3. Verify all symlinks point to valid canonical targets with SKILL.md
  for (const skill of finalSkills) {
    const skillMd = join(skill.target, "SKILL.md");
    if (!existsSync(skillMd)) {
      throw new Error(
        `Canonical skill "${skill.name}" is missing SKILL.md at ${skill.target}`,
      );
    }
  }

  // 4. Save contract.yaml in desk directory
  try {
    const contractPath = join(deskPath, "contract.yaml");
    writeFileSync(contractPath, YAML.stringify(resolvedContract), "utf8");
  } catch (err) {
    throw new Error(
      `Filesystem error writing contract.yaml at "${deskPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 5. Log reconciliation counts
  console.log(
    `[workforce] Desk provisioned at ${deskPath}: ${created} created, ${updated} updated, ${preserved} preserved, ${removed} removed`,
  );

  return {
    deskPath,
    skillsDir,
    created,
    updated,
    preserved,
    removed,
    skills: finalSkills,
  };
}

/**
 * Alias for provisionDesk.
 */
export const materializeDesk = provisionDesk;
