import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
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
  if (
    options.deskRoot &&
    (!contract.desk?.path ||
      contract.desk.path === `~/.agents/workforce/${contract.id}` ||
      contract.desk.path === join(home, ".agents", "workforce", contract.id))
  ) {
    return join(options.deskRoot, contract.id);
  }
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

/** The authored desk projection, excluding resolved runtime skill paths. */
export function renderDeskContract(contract: NamedAgentContract | ResolvedNamedAgentContract): string {
  const { resolvedSkills: _, ...cleanContract } = contract as ResolvedNamedAgentContract;
  return YAML.stringify(cleanContract);
}

/**
 * Materialize an agent's desk directory and reconcile its .agents/skills symlinks.
 *
 * Adheres strictly to Skillex ADR-0001:
 * - Compiled .agents/skills are symlinks pointing directly to canonical skills in all-skills/.
 * - Never copies file payloads or SKILL.md into desk directories.
 * - Reconciles existing symlinks idempotently without deleting or altering user notes in the desk.
 *
 * This is the portable named-agent desk (Story 2.1). It is NOT how a Hermes profile desk
 * receives skills: a strict (Skillex-only) Hermes desk refuses `<desk>/.agents/skills`, and its
 * role loadout is delivered as a Skillex selection instead (see `./selection.ts`).
 */
export async function provisionDesk(
  contractInput: NamedAgentContract | ResolvedNamedAgentContract | string,
  options: DeskProvisionOptions = {},
): Promise<DeskProvisionResult> {
  const shouldResolveSkills = !options.resolvedSkills;
  let resolvedContract: ResolvedNamedAgentContract;

  if (typeof contractInput === "string") {
    resolvedContract = await validateNamedAgent(contractInput, {
      skillexRoot: options.skillexRoot,
      home: options.home,
      deskRoot: options.deskRoot,
      resolveSkills: shouldResolveSkills,
    });
  } else if ("resolvedSkills" in contractInput && Array.isArray((contractInput as ResolvedNamedAgentContract).resolvedSkills)) {
    resolvedContract = contractInput as ResolvedNamedAgentContract;
  } else {
    resolvedContract = await validateNamedAgent(contractInput, {
      skillexRoot: options.skillexRoot,
      home: options.home,
      deskRoot: options.deskRoot,
      resolveSkills: shouldResolveSkills,
    });
  }

  const resolvedSkills: ResolvedSkill[] = options.resolvedSkills ?? resolvedContract.resolvedSkills;
  const deskPath = resolveDeskPath(resolvedContract, options);
  const skillsDir = join(deskPath, ".agents", "skills");

  // 1. Pre-validate skill targets before mutating filesystem
  for (const skill of resolvedSkills) {
    const skillMd = join(skill.path, "SKILL.md");
    if (!existsSync(skill.path) || !existsSync(skillMd)) {
      throw new Error(
        `Canonical skill "${skill.name}" is missing SKILL.md at ${skill.path}`,
      );
    }
  }

  // 2. Accurate diff inspection in dryRun mode
  if (options.dryRun) {
    const desiredSkills = new Map<string, string>();
    for (const skill of resolvedSkills) {
      desiredSkills.set(skill.name, skill.path);
    }

    let dryCreated = 0;
    let dryUpdated = 0;
    let dryPreserved = 0;
    let dryRemoved = 0;

    if (existsSync(skillsDir)) {
      let existingEntries: Dirent[];
      try {
        existingEntries = readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        existingEntries = [];
      }
      const seen = new Set<string>();

      for (const entry of existingEntries) {
        if (entry.name.startsWith(".")) continue;
        const entryPath = join(skillsDir, entry.name);

        if (desiredSkills.has(entry.name)) {
          seen.add(entry.name);
          const desiredTarget = desiredSkills.get(entry.name)!;

          if (entry.isSymbolicLink()) {
            let currentTarget = "";
            try {
              currentTarget = readlinkSync(entryPath);
            } catch {
              // Ignore read error
            }
            const resolvedCurrent = isAbsolute(currentTarget)
              ? resolve(currentTarget)
              : resolve(skillsDir, currentTarget);
            const resolvedDesired = resolve(desiredTarget);

            if (resolvedCurrent === resolvedDesired) {
              dryPreserved++;
            } else {
              dryUpdated++;
            }
          } else {
            dryUpdated++;
          }
        } else if (entry.isSymbolicLink()) {
          dryRemoved++;
        }
      }

      for (const name of desiredSkills.keys()) {
        if (!seen.has(name)) {
          dryCreated++;
        }
      }
    } else {
      dryCreated = resolvedSkills.length;
    }

    return {
      deskPath,
      skillsDir,
      created: dryCreated,
      updated: dryUpdated,
      preserved: dryPreserved,
      removed: dryRemoved,
      skills: resolvedSkills.map((s) => ({ name: s.name, target: s.path })),
    };
  }

  // 3. Create desk root and .agents/skills
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

  // 4. Reconcile symlinks in .agents/skills
  const desiredSkills = new Map<string, string>();
  for (const skill of resolvedSkills) {
    desiredSkills.set(skill.name, skill.path);
  }

  let created = 0;
  let updated = 0;
  let preserved = 0;
  let removed = 0;
  const finalSkills: Array<{ name: string; target: string }> = [];

  let existingEntries: Dirent[];
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

  // 5. Save contract.yaml in desk directory without runtime-only fields
  try {
    const contractPath = join(deskPath, "contract.yaml");
    const rendered = renderDeskContract(resolvedContract);
    if (!existsSync(contractPath) || readFileSync(contractPath, "utf8") !== rendered) writeFileSync(contractPath, rendered, "utf8");
  } catch (err) {
    throw new Error(
      `Filesystem error writing contract.yaml at "${deskPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 6. Log reconciliation counts
  if (!options.quiet) console.log(
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
