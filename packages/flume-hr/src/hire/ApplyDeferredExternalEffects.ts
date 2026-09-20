import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { Command, type InvokeResult } from "../engine/Command";
import type { HermesAgentContext } from "./types";
import { scrubInteractiveChannelCredentials, scrubTicketProviderCredentials } from "./RunCopierTemplate";

/**
 * Execute explicitly granted Hermes external phases after local lifecycle
 * eligibility has passed. Output is always captured: this command is reached
 * only through structured MCP transactions, whose stdout belongs to JSON-RPC.
 */
export class ApplyDeferredExternalEffects extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    const selected = ctx.deferredExternalEffects;
    if (!selected || (!selected.ticketBoard && !selected.systemd)) {
      return { success: true, outcome: "unchanged", message: "Hermes external effects not selected" };
    }
    if (!ctx.roleDir) {
      return { success: false, outcome: "failed", message: "Hermes roleDir is unavailable for deferred external effects" };
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PJANGLER_PROJECT_ROOT: ctx.targetDir,
      SKIP_HOST_STATE: "0",
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_SLACK: "1",
      SKIP_BLOODBANK: "1",
      // Role-local runtime is already converged by ApplyDeferredHostEffects.
      // External consent can never dispatch the retired GitHub runtime model.
      SKIP_RUNTIME_REPO: "1",
      SKIP_PLANE: selected.ticketBoard ? "0" : "1",
      SKIP_SYSTEMD: selected.systemd ? "0" : "1",
    };
    scrubInteractiveChannelCredentials(env);
    if (!selected.ticketBoard) scrubTicketProviderCredentials(env);

    const roleManifest = join(ctx.roleDir, "role.yaml");
    const scripts = [
      ...(selected.ticketBoard ? ["42-ticket-provider.sh"] : []),
      ...(selected.systemd ? ["70-systemd.sh"] : []),
      // Refresh fleet metadata after a board binding or systemd state
      // changes. 80-registry.sh is idempotent and performs no provider call.
      "80-registry.sh",
    ];
    const logs: string[] = [];
    for (const script of scripts) {
      const path = join(ctx.roleDir, ".scripts", script);
      if (!existsSync(path)) {
        return { success: false, outcome: "failed", message: `Deferred Hermes script is missing: ${path}` };
      }
      const result = spawnSync(path, [], { cwd: ctx.roleDir, env, encoding: "utf8" });
      if (String(result.stdout ?? "").trim()) logs.push(String(result.stdout).trim());
      if (String(result.stderr ?? "").trim()) logs.push(String(result.stderr).trim());
      if (result.error || result.status !== 0) {
        const detail = result.error?.message ?? logs.at(-1) ?? `status ${result.status ?? "unknown"}`;
        return { success: false, outcome: "failed", message: `${script} failed: ${detail}` };
      }
    }

    // The local render deliberately records every external phase as deferred,
    // allowing lifecycle eligibility to be proved without probing systemd or
    // implying cloud authority. Persist the granted/applied deployment state
    // only after every selected effect has completed successfully; a failed
    // child must leave the durable manifest truthfully deferred.
    try {
      const current = readFileSync(roleManifest, "utf8");
      const document = YAML.parseDocument(current);
      if (document.errors.length) throw document.errors[0];
      document.setIn(["deployment", "local_only"], Boolean(ctx.local));
      document.setIn(["deployment", "systemd"], selected.systemd ? "required" : "deferred");
      const next = String(document);
      if (next !== current) writeFileSync(roleManifest, next, "utf8");
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to record applied Hermes deployment metadata: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      success: true,
      outcome: "changed",
      message: `Applied deferred Hermes external effects: ${scripts.join(", ")}${logs.length ? `\n${logs.join("\n")}` : ""}`,
    };
  }
}
