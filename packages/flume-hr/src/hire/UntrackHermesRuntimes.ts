import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "node:child_process";
import { Command, type InvokeResult } from "../engine/Command";

function sectionHasPath(section: string, targetPath: string): boolean {
  return section
    .split(/\r?\n/)
    .some((line) => /^\s*path\s*=/.test(line) && line.replace(/^\s*path\s*=\s*/, "").trim() === targetPath);
}

function removeSubmodulePath(content: string, targetPath: string): string {
  return content
    .replace(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm, (section) =>
      sectionHasPath(section, targetPath) ? "" : section)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class UntrackHermesRuntimes extends Command {
  async invoke(): Promise<InvokeResult> {
    const targetDir = this.context.targetDir;
    const rolesDir = join(targetDir, "agents", "hermes");
    if (!existsSync(rolesDir)) {
      return {
        success: true,
        message: "No Hermes agents found (no agents/hermes directory).",
      };
    }

    const roles = readdirSync(rolesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    if (roles.length === 0) {
      return {
        success: true,
        message: "No Hermes agents found.",
      };
    }

    let modifiedAny = false;
    const details: string[] = [];

    for (const role of roles) {
      const roleDir = join("agents", "hermes", role);
      const runtimePath = join(roleDir, "runtime");
      const gitignorePath = join(roleDir, ".gitignore");
      const gitmodulesPath = join(targetDir, ".gitmodules");

      // 1. Check if runtime is tracked in git
      let isTracked = false;
      const lsResult = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
        cwd: targetDir,
        encoding: "utf8",
      });
      if (lsResult.status !== 0) {
        return {
          success: false,
          message: `✗ Failed to inspect runtime index at ${runtimePath}: ${lsResult.stderr.trim() || `exit ${lsResult.status}`}`,
        };
      }
      if (lsResult.status === 0 && lsResult.stdout.trim().length > 0) {
        isTracked = true;
      }

      let hasStaleMapping = false;
      let gitmodulesContent = "";
      if (existsSync(gitmodulesPath)) {
        gitmodulesContent = readFileSync(gitmodulesPath, "utf8");
        const sections = gitmodulesContent.match(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm) ?? [];
        hasStaleMapping = sections.some((section) => sectionHasPath(section, runtimePath));
      }

      // 2. Check if .gitignore ignores runtime/
      let isIgnored = false;
      const fullGitignorePath = join(targetDir, gitignorePath);
      if (existsSync(fullGitignorePath)) {
        const content = readFileSync(fullGitignorePath, "utf8");
        const lines = content.split(/\r?\n/).map((line) => line.trim());
        isIgnored = lines.includes("runtime/") || lines.includes("runtime");
      }

      if (isTracked || hasStaleMapping || !isIgnored) {
        modifiedAny = true;

        if (isTracked) {
          details.push(`untrack agents/hermes/${role}/runtime`);
          if (!this.context.dryRun) {
            const rmResult = spawnSync("git", ["rm", "--cached", "-r", "-f", "--", runtimePath], {
              cwd: targetDir,
              encoding: "utf8",
            });
            if (rmResult.status !== 0) {
              return {
                success: false,
                message: `✗ Failed to untrack ${runtimePath}: ${rmResult.stderr.trim() || `exit ${rmResult.status}`}`,
              };
            }
            const verifyResult = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
              cwd: targetDir,
              encoding: "utf8",
            });
            if (verifyResult.status !== 0 || verifyResult.stdout.trim()) {
              return {
                success: false,
                message: verifyResult.status !== 0
                  ? `✗ Failed to verify untracked runtime ${runtimePath}: ${verifyResult.stderr.trim() || `exit ${verifyResult.status}`}`
                  : `✗ Runtime remains tracked after index-only removal: ${runtimePath}`,
              };
            }
          }
        }

        if (hasStaleMapping) {
          details.push(`remove stale .gitmodules mapping for ${runtimePath}`);
          if (!this.context.dryRun) {
            const next = removeSubmodulePath(gitmodulesContent, runtimePath);
            writeFileSync(gitmodulesPath, next ? `${next}\n` : "", "utf8");
          }
        }

        if (!isIgnored) {
          details.push(`ignore runtime/ in agents/hermes/${role}/.gitignore`);
          if (!this.context.dryRun) {
            let content = "";
            if (existsSync(fullGitignorePath)) {
              content = readFileSync(fullGitignorePath, "utf8");
            }
            if (content && !content.endsWith("\n")) {
              content += "\n";
            }
            content += "runtime/\n";
            writeFileSync(fullGitignorePath, content, "utf8");
          }
        }
      }
    }

    if (!modifiedAny) {
      return {
        success: true,
        message: "✅ All Hermes agent runtimes are already untracked and gitignored.",
      };
    }

    const actionText = this.context.dryRun ? "Would make" : "Made";
    return {
      success: true,
      message: `${actionText} Hermes agent runtimes untracked and gitignored:\n${details.map(d => `  - ${d}`).join("\n")}`,
    };
  }
}
