import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { Command, type InvokeResult } from "../engine/Command";
import type { HermesAgentContext, TicketProvider } from "./types";
import { deriveAgentId, deriveProfileName } from "./types";

/**
 * Synergy with CommonProject: if this repo was bootstrapped by the base
 * template, its board provider already lives in .project.json. Read it so the
 * recipe defaults to the SAME provider the repo's board was created in, rather
 * than blindly defaulting to plane.
 */
function detectTicketProvider(targetDir: string): TicketProvider | undefined {
  try {
    const t = JSON.parse(readFileSync(join(targetDir, ".project.json"), "utf8"))
      ?.ticket_provider?.type;
    return t === "plane" || t === "trello" ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * First step of the hermes-agent recipe.
 *
 * A Hermes agent is, by design, always a single PM per repo named `<repo>-pm`
 * (see the unified single-PM fleet model). There is therefore nothing to
 * choose: repo, role, board, purpose, tone, and model all have one correct
 * default. This command applies those defaults unconditionally and — in
 * interactive mode — asks exactly ONE question: whether to wire the Telegram
 * bot now. The compatibility `--email` flag is rejected by the next effect-free
 * validation step because the pinned template has no email provisioner.
 *
 * Any field pre-supplied via a CLI flag (or by the MCP layer) is preserved;
 * we only fill in what's missing. Downstream commands read the mutated context.
 */
export class PromptForAgentConfig extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;

    // Default target_repo from the current working dir. Lowercase so the value
    // is a valid Hermes profile name, Telegram handle prefix, and systemd unit
    // slug — all of which reject uppercase.
    const defaultRepo = basename(ctx.targetDir).toLowerCase();

    // --- Defaults for everything (the PM-only, one-agent-per-repo model) ---
    ctx.targetRepo = (ctx.targetRepo ?? defaultRepo).toLowerCase();
    ctx.role ??= "pm"; // PM-only fleet: no other roles are offered.
    ctx.agentPurpose ??= `${ctx.role} agent for ${ctx.targetRepo}`;
    ctx.soulTone ??= "direct";
    ctx.modelProvider ??= ""; // inherit shared default profile
    ctx.modelName ??= ""; // inherit shared default profile
    ctx.modelBaseUrl ??= ""; // inherit shared default profile
    ctx.modelApiMode ??= ""; // inherit shared default profile
    ctx.modelKeyEnv ??= ""; // no profile-scoped credential override
    // Board provider: honor an explicit flag, else inherit the repo's existing
    // .project.json provider, else plane.
    ctx.ticketProvider ??= detectTicketProvider(ctx.targetDir) ?? "plane";
    // The default remains skipped; explicit --email is rejected before effects.
    ctx.skipEmail ??= true;

    ctx.agentId = deriveAgentId(ctx.targetRepo!, ctx.role!);
    ctx.profileName = deriveProfileName(ctx.targetRepo!, ctx.role!);

    if (ctx.quiet && !ctx.yes) {
      return {
        success: false,
        outcome: "failed",
        message: "Quiet Hermes execution must also set yes=true; interactive prompts are unavailable to structured callers",
      };
    }

    // --- Non-interactive: also skip the one human-input step (Telegram) ---
    if (ctx.yes) {
      ctx.skipTelegram ??= true;
      return {
        success: true,
        message: this.formatMessage(
          `✓ Non-interactive mode — using defaults  (repo=${ctx.targetRepo}, role=${ctx.role}, profile=${ctx.profileName})`
        ),
      };
    }

    // --- Interactive: the ONE and ONLY question is the Telegram wire-up ---
    p.intro("⚕  hermes-agent  ·  provision the PM agent for this repo");
    p.log.info(
      `agent ${ctx.agentId}   ·   board ${ctx.ticketProvider}   ·   tone ${ctx.soulTone}`
    );

    if (ctx.skipTelegram === undefined) {
      const botHandle = `${ctx.targetRepo!.replace(/-/g, "_")}_${ctx.role}_bot`;
      const wire = await p.confirm({
        message: `Wire up the Telegram bot (@${botHandle}) now?`,
        initialValue: true,
      });
      if (p.isCancel(wire)) return this.cancelled();
      ctx.skipTelegram = !wire;
    }

    return {
      success: true,
      message: this.formatMessage(
        `✓ Collected agent config  (agent_id=${ctx.agentId}, profile=${ctx.profileName})`
      ),
    };
  }

  private cancelled(): InvokeResult {
    p.cancel("Aborted by user.");
    return { success: false, message: "Aborted by user." };
  }
}
