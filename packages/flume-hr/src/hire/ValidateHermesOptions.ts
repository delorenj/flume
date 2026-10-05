import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { Command, type InvokeResult } from "../engine/Command";
import { normalizeAgentRole, resolveContainedPath, resolveFlumeRoot } from "../kernel/paths";
import { declarationProblems, readRoleDeclaration, skillsProblems } from "../workforce/role";
import type { HermesAgentContext } from "./types";

export const EMAIL_UNSUPPORTED_MESSAGE =
  "Email provisioning is unavailable: the pinned Hermes template has no supported email provisioner. Omit --email; no files or external state were changed.";

const HARMLESS_ROLE_PLACEHOLDERS = new Set([".gitkeep", ".DS_Store", "Thumbs.db"]);

/**
 * Find pre-existing role content that requires explicit overwrite consent.
 * Empty directories and inert, single-link regular placeholder/OS metadata
 * files are harmless. Ignored runtime state, links, special files, and every
 * template-shaped file are not.
 */
export function existingRoleDirectoryBlockers(roleDir: string): string[] {
  let root;
  try {
    root = lstatSync(roleDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) return ["<target is not a real directory>"];

  const blockers: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // Do not trust a placeholder-looking name or Dirent type: lstat the leaf
      // without following it so sockets/FIFOs/devices, symlinks, and hardlinks
      // can never be treated as inert metadata.
      const stats = lstatSync(path);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        visit(path);
      } else if (
        !HARMLESS_ROLE_PLACEHOLDERS.has(entry.name) ||
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1
      ) {
        blockers.push(relative(roleDir, path));
      }
    }
  };
  visit(roleDir);
  return blockers.sort();
}

export function existingRoleRefusal(roleDir: string): string | undefined {
  const blockers = existingRoleDirectoryBlockers(roleDir);
  if (!blockers.length) return undefined;
  const sample = blockers.slice(0, 3).join(", ");
  const remainder = blockers.length > 3 ? ` and ${blockers.length - 3} more` : "";
  return `Hermes target directory is not empty at ${roleDir} (found ${sample}${remainder}); non-interactive mode will not render into it. Re-run with --force to re-render explicitly.`;
}

/**
 * Effect-free CLI/recipe option validation.
 *
 * This command deliberately runs before host config bootstrap or Copier. Flags
 * that cannot be honored must fail without leaving a half-started deployment.
 */
export class ValidateHermesOptions extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;

    if (ctx.skipEmail === false) {
      return { success: false, outcome: "failed", message: EMAIL_UNSUPPORTED_MESSAGE };
    }

    const role = normalizeAgentRole(ctx.role ?? "pm");
    const roleDir = resolveContainedPath(
      ctx.targetDir,
      join(ctx.targetDir, "agents", "hermes", role),
      "Hermes role directory",
    );
    const refusal = (ctx.yes || ctx.quiet) && !ctx.force && !ctx.onboard ? existingRoleRefusal(roleDir) : undefined;
    if (refusal) {
      return {
        success: false,
        outcome: "failed",
        message: refusal,
      };
    }

    // A bad declaration must be refused before Copier creates a desk or host
    // config. The same declaration/resolver still owns the final projection.
    try {
      const declaration = readRoleDeclaration(
        process.env.FLUME_ROLES_ROOT ?? resolveFlumeRoot(), role, ctx.agentId, ctx.profileName,
      );
      if (declaration.skills || declaration.chain || declaration.department || declaration.reports_to) {
        const employee = ctx.agentId ?? "";
        const problems = [
          ...declarationProblems(declaration, employee),
          ...await skillsProblems(declaration, employee),
        ];
        if (problems.length) throw new Error(problems.join("; "));
      }
    } catch (error) {
      return {
        success: false, outcome: "failed",
        message: `Role declaration: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return { success: true, outcome: "unchanged", message: "" };
  }
}
