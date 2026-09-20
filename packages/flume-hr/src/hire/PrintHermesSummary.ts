import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { Command, type InvokeResult } from "../engine/Command";
import type { HermesAgentContext } from "./types";

interface DurableServiceState {
  gateway: string;
  heartbeat: string;
}

function readServiceState(roleDir: string | undefined): DurableServiceState {
  if (!roleDir || !existsSync(join(roleDir, "role.yaml"))) return { gateway: "planned", heartbeat: "planned" };
  try {
    const role = YAML.parse(readFileSync(join(roleDir, "role.yaml"), "utf8")) as {
      service_state?: { gateway?: unknown; heartbeat?: unknown };
    } | null;
    return {
      gateway: typeof role?.service_state?.gateway === "string" ? role.service_state.gateway : "unknown",
      heartbeat: typeof role?.service_state?.heartbeat === "string" ? role.service_state.heartbeat : "unknown",
    };
  } catch {
    return { gateway: "unknown", heartbeat: "unknown" };
  }
}

/** Render only claims established by the recipe's final postcondition phase. */
export function renderHermesSummary(ctx: HermesAgentContext): string {
  const outcome = ctx.deploymentOutcome ?? (ctx.dryRun ? "planned" : "failed");
  const service = readServiceState(ctx.roleDir);
  const deferrals = [...new Set(ctx.deploymentDeferrals ?? [])];
  const title = outcome === "planned"
    ? "Hermes deployment plan (no changes applied)"
    : outcome === "verified-deferred"
      ? "Hermes deployment healthy with deferred capabilities"
      : outcome === "verified"
        ? "Hermes deployment verified"
        : "Hermes deployment not verified";
  const lines = [
    title,
    `agent_id: ${ctx.agentId ?? "planned"}`,
    `role_dir: ${ctx.roleDir ?? join(ctx.targetDir, "agents", "hermes", ctx.role ?? "pm")}`,
    `runtime: local role runtime (${join(ctx.roleDir ?? join(ctx.targetDir, "agents", "hermes", ctx.role ?? "pm"), "runtime")})`,
    `heartbeat: ${service.heartbeat}`,
    `gateway: ${service.gateway}`,
  ];
  if (deferrals.length) lines.push(`deferred: ${deferrals.join(", ")}`);
  for (const assertion of ctx.deploymentPostconditions ?? []) lines.push(`verified: ${assertion}`);
  if (outcome === "planned") lines.push("Apply by rerunning without --dry-run.");
  return lines.join("\n");
}

export class PrintHermesSummary extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    return { success: ctx.deploymentOutcome !== "failed", outcome: "unchanged", message: renderHermesSummary(ctx) };
  }
}
