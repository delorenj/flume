// The lane map a ticket adapter lands a transition in, resolved per HOST.
//
// A tracked role.yaml carries `ticket_provider:` with the lane NAMES of the board it was written against. Under Krebs
// lifecycle v2 (krebs/spec/lifecycle.v2.yaml) every Plane board has the five stock lanes, one per state group
// (LANE_BANDS); review and holds are labels (LIFECYCLE_LABELS), never a lane to name here. A lane name that does not
// exist on the board a host actually talks to still lands the transition somewhere wrong, so the tracked map is only
// the DEFAULT: a host overlay (`lanes:` in kernel/host-overlay.ts) can lay its own names over it, or replace it, for
// the boards it matches. No overlay = the tracked map unchanged, which is big-chungus's behaviour.
//
// This module is the one reading of that contract. The legacy shell adapter (hermes-agent-template
// providers/plane.sh `tp_cfg`) reads role.yaml directly and does not call it yet; `flume lanes get` is the
// drop-in for that read once the template adopts it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LANE_BANDS, loadHostOverlay, type LaneBand, type LaneRule, type OverlayLoad } from "../kernel/host-overlay";

export type LaneMap = Partial<Record<LaneBand, string>>;

export interface BoardIdentity {
  provider: string;
  workspace: string;
  board_id: string;
}

export interface LaneResolution {
  board: BoardIdentity;
  /** The role.yaml's own map (empty strings dropped). */
  tracked: LaneMap;
  /** What a transition must use on this host. */
  effective: LaneMap;
  /** Indexes into the overlay's `lanes:` that matched this board, in the order they were applied. */
  appliedRules: number[];
  /** Why the tracked map was set aside, when a matching rule said `replace`. */
  replaced: boolean;
}

/**
 * The `ticket_provider:` block of a role.yaml: board identity and the tracked lane names.
 *
 * Deliberately NOT a YAML parse. The shell adapter that lands transitions (hermes-agent-template providers/plane.sh
 * `tp_cfg`) reads each key with a line regex, so a value it cannot see is a value it does not use. This reads the same
 * way, key for key, so "no overlay" is provably what the adapter reads today (tests/host-overlay-regressions.mjs runs
 * the adapter's own snippet against this on the same files). A YAML parse would honour `started: "X" # note`, which
 * the adapter reads as empty.
 */
function tpBlock(roleYaml: string): string {
  const match = /^ticket_provider:\s*$([\s\S]*?)(?=^\S)/m.exec(`${roleYaml}\n\u0000`);
  return match?.[1] ?? "";
}

function tpValue(block: string, key: string): string {
  const match = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:\\s*"?([^"\\n]*)"?\\s*$`, "m").exec(block);
  return match ? match[1]!.trim() : "";
}

export function readTicketProvider(roleYaml: string): { board: BoardIdentity; tracked: LaneMap } {
  const block = tpBlock(roleYaml);
  const tracked: LaneMap = {};
  for (const band of LANE_BANDS) {
    const name = tpValue(block, band);
    if (name) tracked[band] = name;
  }
  return {
    board: {
      provider: tpValue(block, "name"),
      workspace: tpValue(block, "workspace"),
      // The adapter's order: `project`, then `board_id` (it also prefers the repo-root .project.json, which a role.yaml cannot see).
      board_id: tpValue(block, "project") || tpValue(block, "board_id"),
    },
    tracked,
  };
}

/** Does a rule apply to this board? Every key the rule names must match exactly; a rule naming none matches every board. */
export function ruleMatches(rule: LaneRule, board: BoardIdentity): boolean {
  const { provider, workspace, board_id } = rule.match;
  if (provider !== undefined && provider !== board.provider) return false;
  if (workspace !== undefined && workspace !== board.workspace) return false;
  if (board_id !== undefined && board_id !== board.board_id) return false;
  return true;
}

/** Pure resolution: tracked map + overlay rules -> the lane names this host uses. Rules apply in file order; a later rule wins per band. */
export function resolveLaneMap(tracked: LaneMap, board: BoardIdentity, rules: readonly LaneRule[]): LaneResolution {
  const appliedRules: number[] = [];
  let effective: LaneMap = { ...tracked };
  let replaced = false;
  rules.forEach((rule, index) => {
    if (!ruleMatches(rule, board)) return;
    appliedRules.push(index);
    if (rule.replace) {
      effective = {};
      replaced = true;
    }
    effective = { ...effective, ...rule.states };
  });
  return { board, tracked, effective, appliedRules, replaced };
}

export class LaneOverlayError extends Error {
  constructor(readonly path: string, readonly errors: string[]) {
    super(`host overlay ${path} is invalid, so this host's lane names are unknown: ${errors.join("; ")}`);
    this.name = "LaneOverlayError";
  }
}

/** Resolve a role.yaml for this host. A broken overlay throws: landing a transition in the wrong lane is silent, a refusal is not. */
export function resolveRoleLanes(roleYamlText: string, loaded: OverlayLoad = loadHostOverlay(process.env, homedir())): LaneResolution {
  if (loaded.status === "invalid") throw new LaneOverlayError(loaded.path, loaded.errors);
  const { board, tracked } = readTicketProvider(roleYamlText);
  return resolveLaneMap(tracked, board, loaded.status === "ok" ? loaded.overlay.lanes : []);
}

export function resolveRoleLanesAt(roleYamlPath: string, loaded?: OverlayLoad): LaneResolution {
  if (!existsSync(roleYamlPath)) throw new Error(`role.yaml not found: ${roleYamlPath}`);
  return resolveRoleLanes(readFileSync(roleYamlPath, "utf8"), loaded);
}

export function formatLaneResolution(path: string, resolution: LaneResolution): string {
  const rows = LANE_BANDS.filter((band) => resolution.effective[band] !== undefined || resolution.tracked[band] !== undefined).map((band) => {
    const tracked = resolution.tracked[band];
    const effective = resolution.effective[band];
    const note = tracked === effective ? "" : tracked === undefined ? "  (overlay)" : effective === undefined ? "  (tracked name dropped by overlay)" : `  (overlay; tracked "${tracked}")`;
    return `  ${band.padEnd(24)} ${effective === undefined ? "(adapter default)" : JSON.stringify(effective)}${note}`;
  });
  const head = `${path}  [${resolution.board.provider || "?"} ${resolution.board.workspace || "?"}/${resolution.board.board_id || "?"}]  overlay rules: ${resolution.appliedRules.length ? resolution.appliedRules.join(",") : "none"}${resolution.replaced ? " (replaced tracked map)" : ""}`;
  return [head, ...(rows.length ? rows : ["  (no lanes named: adapter defaults)"])].join("\n");
}

/** Every `agents/hermes/<role>/role.yaml` under a repo root, sorted. */
export function defaultRoleYamls(repoRoot: string): string[] {
  const dir = join(repoRoot, "agents", "hermes");
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(dir, entry.name, "role.yaml");
    if (existsSync(candidate)) out.push(candidate);
  }
  return out.sort();
}
