import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import * as p from "@clack/prompts";
import { Command, type InvokeResult } from "../engine/Command";
import type { HermesAgentContext } from "./types";

/**
 * BotFather token wire-up for a per-(repo, role) Hermes bot.
 *
 * Token resolution order:
 *   1. $TELEGRAM_BOT_TOKEN
 *   2. op://DeLoSecrets/<vaultTitle>/token
 *   3. BotFather walkthrough + clack secret prompt, then offer to persist
 *      back to 1Password so future runs skip the prompt entirely.
 *
 * The vault item is per-bot (Telegram-Hermes-<repo>-<role>) because each
 * bot has its own token — unlike WireEmail's shared CF account credential.
 */
export class WireTelegram extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    if (ctx.skipTelegram) {
      return { success: true, message: "→ Telegram wire-up skipped" };
    }
    if (ctx.quiet) {
      return {
        success: false,
        outcome: "failed",
        message: "Telegram wiring is interactive and unavailable during quiet/non-interactive Hermes execution",
      };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would run BotFather token capture") };
    }

    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire telegram: missing target_repo/role/roleDir" };
    }

    const botHandle = `${targetRepo.toLowerCase().replace(/-/g, "_")}_${role.toLowerCase()}_bot`;
    const displayName = `${cap(targetRepo)} ${role.length <= 3 ? role.toUpperCase() : cap(role)}`;
    const vaultTitle = `Telegram-Hermes-${targetRepo.toLowerCase()}-${role.toLowerCase()}`;
    const vaultRef = `op://DeLoSecrets/${vaultTitle}/token`;

    let token = process.env.TELEGRAM_BOT_TOKEN;
    let source: "env" | "op" | "prompt" | null = token ? "env" : null;

    if (!token) {
      const tryOp = spawnSync("op", ["read", vaultRef], { encoding: "utf8" });
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
        source = "op";
        p.log.info(`✓ Telegram token loaded from ${vaultRef}`);
      }
    }

    if (!token) {
      p.log.step("BotFather steps");
      p.log.info(
        [
          "  1. Open Telegram, message @BotFather",
          "  2. /newbot",
          `  3. Display name:   ${displayName}`,
          `  4. Username:       ${botHandle}   (must end in _bot)`,
          "  5. Copy the HTTP API token from the reply.",
          "  6. /setjoingroups Disable",
          "  7. /setprivacy    Disable",
        ].join("\n")
      );

      const tokenAnswer = await p.password({
        message: `Paste the bot token for @${botHandle}`,
        mask: "•",
        validate: (v) => {
          const s = String(v ?? "").trim();
          if (!s) return "required";
          if (!/^[0-9]+:.+/.test(s)) return "expected '<digits>:<secret>' shape";
        },
      });
      if (p.isCancel(tokenAnswer)) {
        return { success: true, message: "→ Telegram skipped (no token).  Re-run later." };
      }
      token = String(tokenAnswer).trim();
      source = "prompt";

      const persist = await p.confirm({
        message: `Save to ${vaultRef} for next time?`,
        initialValue: true,
      });
      if (!p.isCancel(persist) && persist) {
        const create = spawnSync(
          "op",
          [
            "item",
            "create",
            "--category=API Credential",
            "--vault=DeLoSecrets",
            `--title=${vaultTitle}`,
            `token=${token}`,
            `bot_handle=${botHandle}`,
          ],
          { stdio: "inherit" }
        );
        if (create.status !== 0) {
          p.log.warn("Could not store in 1Password — token is still set for this run.");
        }
      }
    }

    const allowedAnswer = await p.text({
      message: "Your Telegram user id (allow-list for this bot)",
      placeholder: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      initialValue: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      validate: (v) =>
        /^[0-9](?:[0-9,]*[0-9])?$/.test(String(v).trim()) ? undefined : "comma-separated numeric ids",
    });
    if (p.isCancel(allowedAnswer)) {
      return { success: false, message: "✗ Aborted; Telegram step deferred." };
    }

    const script = join(roleDir, ".scripts", "30-telegram.sh");
    if (!existsSync(script)) {
      return {
        success: false,
        message: `✗ ${script} not found. Did Copier finish rendering the Hermes role?`,
      };
    }

    const marker = join(roleDir, ".scripts", ".done-30-telegram");
    if (existsSync(marker)) unlinkSync(marker);

    const spinner = p.spinner();
    spinner.start("Verifying token + wiring profile");
    const result = spawnSync("bash", [script], {
      stdio: "inherit",
      env: {
        ...process.env,
        // Interactive wiring is an explicit host-state operation: it writes the
        // profile. Set the gate rather than inheriting whatever a deferred MCP
        // render left in the environment, which would silently no-op this run.
        SKIP_HOST_STATE: "0",
        SKIP_TELEGRAM: "0",
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USERS: String(allowedAnswer).trim(),
      },
      cwd: roleDir,
    });
    spinner.stop(result.status === 0 ? "✓ Telegram wired" : "✗ Telegram step failed");

    if (result.status !== 0) {
      return { success: false, message: "Telegram wire-up failed.  See output above." };
    }

    const sourceLabel = source === "env" ? " (token: env)" : source === "op" ? " (token: op)" : "";
    return { success: true, message: `✓ Telegram: @${botHandle} ready${sourceLabel}` };
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
