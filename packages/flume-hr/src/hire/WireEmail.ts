import { Command, type InvokeResult } from "../engine/Command";
import type { HermesAgentContext } from "./types";
import { EMAIL_UNSUPPORTED_MESSAGE } from "./ValidateHermesOptions";

/**
 * Compatibility guard for the retired `--email` surface.
 *
 * The pinned template exposes no email script or stable email provisioning
 * contract. Failing closed is safer than discovering that after Copier and
 * host provisioning have already mutated state. ValidateHermesOptions normally
 * catches this before all effects; this command is a defense-in-depth guard for
 * direct command callers.
 */
export class WireEmail extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    if (ctx.skipEmail !== false) {
      return { success: true, outcome: "skipped", message: "" };
    }
    return { success: false, outcome: "failed", message: EMAIL_UNSUPPORTED_MESSAGE };
  }
}
