/**
 * Who gets a ticket on a Plane board that several registry rows claim.
 *
 * This is a deliberate COPY of the n8n Bloodbank node's resolver, kept small and pure so flume can
 * answer "if this row stops claiming the board, who wins each ticket?" without importing bloodbank:
 *
 *   ~/code/33GOD/bloodbank/integrations/n8n-nodes-bloodbank/src/fleet.ts  resolveFleetAgentForBoard
 *   ~/code/33GOD/bloodbank/integrations/n8n-nodes-bloodbank/src/scope.ts  orderOwners, pickOwner, scopeFields
 *   ~/code/33GOD/bloodbank/integrations/n8n-nodes-bloodbank/src/registry.ts bloodbankActivation
 *
 * The rules, as read from that source:
 *   - every row whose `plane.project_id` or `plane.board_id` equals the board is a claimant;
 *   - claimants are ordered `scope_default: true` first, then by agent id (plain string order);
 *   - a ticket with no labels goes to the first claimant; a ticket with labels goes to the first
 *     claimant (in that order) declaring one of them in `scope_label`, else to the first claimant;
 *   - the chosen owner is then CHECKED, never skipped: it must have a `profile_name`, a `bloodbank`
 *     block whose `enabled` is absent or true, `gateway_scope: fleet` and `target_agent_id` equal to
 *     its own id. A claimant that fails is still the owner, and the ticket is dropped. That is why
 *     switching only `bloodbank.enabled` off is not a retirement: the board claim has to go.
 *
 * If the bloodbank source changes, change this with it (and tests/retire-regressions.mjs).
 */

export type Row = Record<string, unknown>;

function mapping(value: unknown): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function scopeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/** `scope_label` / `scope_labels`: one label or a list, lowercased, deduplicated, sorted. */
export function scopeLabelsOf(plane: Row): string[] {
  const value = plane.scope_label ?? plane.scope_labels;
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map(scopeText).filter((label): label is string => Boolean(label)))].sort();
}

/** The ids a row's `plane` block answers to on the wire (a webhook carries either). */
export function claimedBoards(row: unknown): string[] {
  const plane = mapping(mapping(row)?.plane);
  if (!plane) return [];
  return [...new Set([text(plane.project_id), text(plane.board_id)].filter(Boolean))];
}

export interface Eligibility {
  eligible: boolean;
  why: string;
}

/** Mirrors the four checks in `resolveFleetAgentForBoard`, in the same order. */
export function fleetEligibility(agentId: string, row: Row): Eligibility {
  if (!text(row.profile_name)) return { eligible: false, why: `${agentId} has no profile_name` };
  const bloodbank = mapping(row.bloodbank);
  if (!bloodbank) return { eligible: false, why: `${agentId} has no bloodbank block` };
  if (Object.hasOwn(bloodbank, "enabled")) {
    if (bloodbank.enabled === false) return { eligible: false, why: `${agentId} is registry-defined but bloodbank.enabled is false` };
    if (bloodbank.enabled !== true) return { eligible: false, why: `${agentId} has an invalid bloodbank.enabled (it must be a YAML boolean or absent)` };
  }
  if (bloodbank.gateway_scope !== "fleet") return { eligible: false, why: `${agentId} gateway_scope is not 'fleet'` };
  if (text(bloodbank.target_agent_id) !== agentId) {
    return { eligible: false, why: `${agentId} target_agent_id mismatch (${text(bloodbank.target_agent_id) || "unset"})` };
  }
  return { eligible: true, why: "eligible" };
}

export interface Claimant extends Eligibility {
  id: string;
  scopeLabels: string[];
  scopeDefault: boolean;
}

/** Claimants of `board`, in the resolver's canonical order (default first, then id). */
export function claimantsOf(agents: Row, board: string): Claimant[] {
  const found: Claimant[] = [];
  for (const [id, raw] of Object.entries(agents)) {
    const row = mapping(raw);
    const plane = mapping(row?.plane);
    if (!row || !plane || !claimedBoards(row).includes(board)) continue;
    found.push({ id, scopeLabels: scopeLabelsOf(plane), scopeDefault: plane.scope_default === true, ...fleetEligibility(id, row) });
  }
  return found.sort((a, b) => {
    if (a.scopeDefault !== b.scopeDefault) return a.scopeDefault ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface TicketRoute {
  /** The ticket label this route answers for; null is a ticket carrying no label. */
  label: string | null;
  owner: string | null;
  eligible: boolean;
  why: string;
  /** True when the owner declares this label; false when the ticket only lands there by the first-in-order fallback. */
  declared: boolean;
}

/** Who owns one ticket carrying `labels` (lowercased names) among already ordered claimants. */
export function pickClaimant(ordered: readonly Claimant[], labels: readonly string[]): Claimant | undefined {
  if (ordered.length === 0) return undefined;
  if (ordered.length === 1 || labels.length === 0) return ordered[0];
  const wanted = new Set(labels);
  return ordered.find((claimant) => claimant.scopeLabels.some((label) => wanted.has(label))) ?? ordered[0];
}

export type BoardFlagCode = "board-unowned" | "multiple-defaults" | "owner-ineligible" | "label-unclaimed";

export interface BoardFlag {
  code: BoardFlagCode;
  detail: string;
}

export interface BoardRouting {
  board: string;
  claimants: Claimant[];
  /** One route per label any claimant declares (plus any `alsoLabels`), then the unlabeled ticket. */
  routes: TicketRoute[];
  flags: BoardFlag[];
}

/**
 * `alsoLabels` are labels to route even though no remaining claimant declares them: retire passes the labels the
 * board knew BEFORE the change, so a label only the retired row declared (repo:game when tolt-pm leaves) is still
 * reported, with the claimant its tickets now fall back to.
 */
export function boardRouting(agents: Row, board: string, alsoLabels: readonly string[] = []): BoardRouting {
  const claimants = claimantsOf(agents, board);
  const extra = alsoLabels.map((label) => String(label).trim().toLowerCase()).filter(Boolean);
  const labels = [...new Set([...claimants.flatMap((claimant) => claimant.scopeLabels), ...extra])].sort();
  const routes: TicketRoute[] = [...labels, null].map((label) => {
    const owner = pickClaimant(claimants, label === null ? [] : [label]);
    return owner
      ? { label, owner: owner.id, eligible: owner.eligible, why: owner.why, declared: label === null || owner.scopeLabels.includes(label) }
      : { label, owner: null, eligible: false, why: `no registry row claims board ${board}`, declared: false };
  });
  const flags: BoardFlag[] = [];
  if (!claimants.some((claimant) => claimant.eligible)) {
    flags.push({
      code: "board-unowned",
      detail: claimants.length === 0
        ? `no row claims board ${board}; tickets fall back to the "<repo>-pm" row by convention, else are dropped`
        : `no eligible claimant left on board ${board} (${claimants.map((claimant) => claimant.id).join(", ")}); its tickets are dropped`,
    });
  }
  const defaults = claimants.filter((claimant) => claimant.scopeDefault).map((claimant) => claimant.id);
  if (defaults.length > 1) {
    flags.push({ code: "multiple-defaults", detail: `${defaults.length} rows declare plane.scope_default: true on board ${board} (${defaults.join(", ")}); the first by id wins every unmatched ticket` });
  }
  for (const route of routes) {
    if (route.label !== null && route.owner !== null && !route.declared) {
      flags.push({ code: "label-unclaimed", detail: `no claimant on board ${board} declares ${route.label}; those tickets fall back to ${route.owner}, the first in order` });
    }
    if (route.owner !== null && !route.eligible) {
      flags.push({ code: "owner-ineligible", detail: `${route.label ?? "(unlabeled)"} on board ${board} goes to ${route.owner}, which is ineligible: ${route.why}; those tickets are dropped` });
    }
  }
  return { board, claimants, routes, flags };
}

/** The agents mapping of a parsed registry, or {} when it has none. */
export function agentsOf(registry: unknown): Row {
  return mapping(mapping(registry)?.agents) ?? {};
}
