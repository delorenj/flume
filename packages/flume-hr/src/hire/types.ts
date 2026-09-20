import type { CommandContext } from "../engine/Command";
import type { TrustedCopierIdentity } from "../kernel/preflight";

/**
 * Context for the hermes-agent recipe. Extends the base CommandContext with
 * the answers collected by PromptForAgentConfig (or supplied via CLI flags).
 *
 * Convention: PromptForAgentConfig mutates `context` in place with these
 * fields populated before downstream commands run.
 */
export interface HermesAgentContext extends CommandContext {
  // --- collected/provided ---
  targetRepo?: string;        // basename($PWD) by default
  role?: string;              // "pm" by default
  agentPurpose?: string;
  soulTone?: "direct" | "playful" | "formal" | "terse";
  modelProvider?: string;
  modelName?: string;
  modelBaseUrl?: string;
  modelApiMode?: string;
  modelKeyEnv?: string;
  ticketProvider?: TicketProvider;  // "plane" by default — board lives here

  // --- behavior toggles ---
  yes?: boolean;              // non-interactive; accept all defaults
  local?: boolean;            // local-only: defer Plane/systemd; runtime remains role-local
  live?: boolean;             // explicit external-effect authority (still requires per-effect opt-ins)
  forceConfig?: boolean;      // add missing pinned-schema fields to the host config
  skipTelegram?: boolean;
  skipEmail?: boolean;
  skipSystemd?: boolean;
  skipBloodbank?: boolean;
  skipPlane?: boolean;

  // MCP apply paths render and prove local lifecycle state first. The selected
  // external scripts run only from the owning recipe/project transaction after
  // that eligibility audit, then a read-only postcondition audit verifies the
  // result. CLI callers that omit this block retain their existing sequencing.
  deferredExternalEffects?: {
    ticketBoard: boolean;
    systemd: boolean;
    owner: "hermes" | "project";
  };
  // MCP provisioning defers host-global config/profile/fleet writes until the
  // freshly rendered repo-local projection has passed its structural
  // eligibility gate. This private flag is set only while that deferred host
  // phase is actually being applied.
  applyingDeferredHostEffects?: boolean;
  // MCP apply resolves and attests Copier before any mutation. The render
  // command revalidates this identity and invokes its canonical absolute path;
  // it must never resolve PATH a second time.
  trustedCopier?: TrustedCopierIdentity;

  // --- derived after copier runs ---
  agentId?: string;           // <targetRepo>-<role>
  profileName?: string;       // named Hermes profile, conventionally <targetRepo>-<role>
  roleDir?: string;           // <projectRoot>/agents/hermes/<role>
  runtimeRepo?: string;       // legacy compatibility metadata; runtime is role-local

  // --- final presentation (set only by HermesAgentRecipe) ---
  deploymentOutcome?: "planned" | "verified" | "verified-deferred" | "failed";
  deploymentDeferrals?: string[];
  deploymentPostconditions?: string[];
}

export const HERMES_AGENT_TEMPLATE = "gh:delorenj/hermes-agent-template";

export const SOUL_TONES = ["direct", "playful", "formal", "terse"] as const;

// NOTE: the fleet is PM-only (one `<repo>-pm` agent per repo), so the recipe no
// longer offers a role selection. `role` defaults to "pm" and is overridable
// only via the `--role` flag / MCP input for programmatic/edge use. The copier
// template still accepts a `role` value, so other roles remain reachable
// out-of-band — they're just not part of the interactive flow.

export type TicketProvider = "plane" | "trello";

export const TICKET_PROVIDERS = [
  { value: "plane", label: "Plane", hint: "self-hosted at plane.delo.sh (default)" },
  { value: "trello", label: "Trello", hint: "board = project" },
] as const;

export function deriveAgentId(repo: string, role: string): string {
  return `${repo}-${role}`.toLowerCase();
}

export function deriveProfileName(repo: string, role: string): string {
  return deriveAgentId(repo, role);
}
