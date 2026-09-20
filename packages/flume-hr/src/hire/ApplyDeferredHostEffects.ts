import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command, type InvokeResult } from "../engine/Command";
import { EnsureTemplateConfig } from "./EnsureTemplateConfig";
import { scrubInteractiveChannelCredentials, scrubTicketProviderCredentials } from "./RunCopierTemplate";
import type { HermesAgentContext } from "./types";

/**
 * Apply host-global Hermes state only after the rendered repo projection has
 * passed its read-only lifecycle eligibility gate. Output is always captured:
 * this phase is used by structured MCP transactions whose stdout is JSON-RPC.
 */
export class ApplyDeferredHostEffects extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    if (!ctx.deferredExternalEffects) {
      return { success: true, outcome: "unchanged", message: "Hermes host effects use template sequencing" };
    }
    if (!ctx.roleDir) {
      return { success: false, outcome: "failed", message: "Hermes roleDir is unavailable for deferred host effects" };
    }

    let config: InvokeResult;
    ctx.applyingDeferredHostEffects = true;
    try {
      config = await new EnsureTemplateConfig(ctx).invoke();
    } finally {
      ctx.applyingDeferredHostEffects = false;
    }
    if (!config.success) return config;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PJANGLER_PROJECT_ROOT: ctx.targetDir,
      SKIP_HOST_STATE: "0",
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_SLACK: "1",
      SKIP_BLOODBANK: "1",
      // The legacy name controls role-local runtime/profile convergence only.
      // It is a required host/local phase, never a GitHub repository effect.
      SKIP_RUNTIME_REPO: "0",
      SKIP_PLANE: "1",
      SKIP_SYSTEMD: "1",
    };
    // Config/profile/fleet setup never needs board credentials. Do not expose
    // ambient provider authority to these child processes even when a later,
    // separately gated provider phase was positively selected.
    scrubTicketProviderCredentials(env);
    scrubInteractiveChannelCredentials(env);

    const scripts = ["01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh"];
    const logs: string[] = [];
    for (const script of scripts) {
      const path = join(ctx.roleDir, ".scripts", script);
      if (!existsSync(path)) {
        return { success: false, outcome: "failed", message: `Deferred Hermes host script is missing: ${path}` };
      }
      const result = spawnSync(path, [], { cwd: ctx.roleDir, env, encoding: "utf8" });
      if (String(result.stdout ?? "").trim()) logs.push(String(result.stdout).trim());
      if (String(result.stderr ?? "").trim()) logs.push(String(result.stderr).trim());
      if (result.error || result.status !== 0) {
        const detail = result.error?.message ?? logs.at(-1) ?? `status ${result.status ?? "unknown"}`;
        return { success: false, outcome: "failed", message: `${script} failed: ${detail}` };
      }
    }
    return {
      success: true,
      outcome: "changed",
      message: `Applied deferred Hermes host effects: ${scripts.join(", ")}${logs.length ? `\n${logs.join("\n")}` : ""}`,
    };
  }
}
