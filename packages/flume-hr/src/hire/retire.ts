/**
 * Retiring an employee: out of service, record kept.
 *
 * `flume offboard` deletes the row. `flume identity retire` is the company-identity lifecycle and
 * refuses an employee that was never enrolled. Neither takes a bot out of the ROUTING of a shared
 * Plane board, which is what a retired PM must stop doing.
 *
 * The incident this exists for (2026-11-02): pile-of-dumb-things-pm was "retired" by setting its
 * telegram provisioning_status to `retired` and nothing else. Its row kept `bloodbank.enabled: true`
 * and a `plane:` block claiming the shared TOLT board as scope_default, so the n8n Bloodbank node
 * kept choosing it as owner of every game, forge and unlabeled ticket for a day while the real PM got
 * none. It was hand-fixed on 2026-11-03. The subtlety that makes this a command and not a one-line
 * edit: setting only `bloodbank.enabled: false` does NOT help. The resolver still picks the row as the
 * board's owner and then refuses it as ineligible, silently dropping the ticket. The claim must go.
 *
 * What a retire does to the row (and nothing else):
 *   1. `bloodbank.enabled` -> false (gateway_scope / target_agent_id kept so it can be restored).
 *   2. the `plane:` block is deleted. Its old content is returned in the result, because deleting
 *      it from the registry is the point and losing it is not; no new key is added to the row
 *      (the registry contract does not declare one).
 *   3. every live chat channel is parked by calling `channelOffline` (never reimplemented), with
 *      noReload: the running gateway is left alone and the one restart is the operator's, below.
 * Then it reports, from the rows as they will be, who gets a ticket on every board the row claimed.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { resolveAgentRegistryPath, resolveFleetHomeDir } from "../kernel/fleet-paths";
import { hostPlatform, isLaunchdHost, LAUNCHD_GATEWAY_LABEL } from "../kernel/host-platform";
import { channelOffline, channelRegistryPath, CHANNEL_PLATFORMS, type ChannelPlatform } from "../workforce/channel";
import { agentsOf, boardRouting, claimedBoards, type BoardRouting, type Row } from "../workforce/board-routing";
import { withRegistryLock } from "../workforce/role";
import { updateRegistryDocumentUnlocked } from "./PreserveRegistryComments";

/** A channel in one of these is not live: nothing to park. Anything else with a block is. */
const NOT_LIVE_STATUSES = new Set(["deferred", "disabled", "offline", "retired"]);

export interface RetireChannel {
  platform: ChannelPlatform;
  /** `parked`: channelOffline ran. `would-park`: preview. `next-action`: not done here, see `command`. */
  action: "parked" | "would-park" | "next-action" | "skipped";
  detail: string;
  /** The exact command to run when `action` is `next-action`. */
  command?: string;
}

export interface RetireResult {
  ok: boolean;
  employeeId: string;
  registryPath: string;
  found: boolean;
  applied: boolean;
  /** Nothing left to do: routing already off and no live channel. */
  alreadyRetired: boolean;
  reason: string;
  bloodbank: { present: boolean; before: boolean | string | null; after: boolean | null; changed: boolean };
  /** The deleted `plane:` block, verbatim, so the history survives the deletion. null when the row had none. */
  removedPlane: unknown;
  channels: RetireChannel[];
  /** Per board the row claimed: the routing as it was, and as it is (or would be) after. */
  routing: Array<{ board: string; before: BoardRouting; after: BoardRouting }>;
  /** Every flag on the AFTER side, flattened: board-unowned, multiple-defaults, owner-ineligible. */
  flags: string[];
  nextActions: string[];
  leftBehind: string[];
  errors: string[];
}

export interface RetireOptions {
  apply?: boolean;
  reason?: string;
  homeDir?: string;
  registryPath?: string;
  platform?: NodeJS.Platform;
}

const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);

/** The row as it should be once retired: a pure function, used for the preview, the proof and the report. */
export function retiredRow(row: Row): { row: Row; removedPlane: unknown; bloodbank: RetireResult["bloodbank"] } {
  const next: Row = { ...row };
  let removedPlane: unknown = null;
  if (Object.hasOwn(next, "plane")) {
    removedPlane = next.plane;
    delete next.plane;
  }
  const bloodbank = isRow(row.bloodbank) ? row.bloodbank : undefined;
  const before = bloodbank ? (Object.hasOwn(bloodbank, "enabled") ? (typeof bloodbank.enabled === "boolean" ? bloodbank.enabled : String(bloodbank.enabled)) : null) : null;
  const changed = Boolean(bloodbank) && bloodbank!.enabled !== false;
  if (bloodbank) next.bloodbank = { ...bloodbank, enabled: false };
  return { row: next, removedPlane, bloodbank: { present: Boolean(bloodbank), before, after: bloodbank ? false : null, changed } };
}

/** The platforms whose channel is live: a non-empty block whose status is not deferred/offline/retired. */
export function liveChannels(row: Row): ChannelPlatform[] {
  return (Object.keys(CHANNEL_PLATFORMS) as ChannelPlatform[]).filter((platform) => {
    const block = row[platform];
    if (!isRow(block) || Object.keys(block).length === 0) return false;
    return !(typeof block.provisioning_status === "string" && NOT_LIVE_STATUSES.has(block.provisioning_status));
  });
}

function failure(base: Omit<RetireResult, "ok" | "errors">, errors: string[]): RetireResult {
  return { ...base, ok: false, errors };
}

export async function retireFromService(employeeId: string, options: RetireOptions = {}): Promise<RetireResult> {
  const homeDir = options.homeDir ?? homedir();
  const registryPath = options.registryPath ?? resolveAgentRegistryPath(process.env, homeDir);
  const reason = (options.reason ?? "").trim() || "employee retired";
  const base: Omit<RetireResult, "ok" | "errors"> = {
    employeeId, registryPath, found: false, applied: false, alreadyRetired: false, reason,
    bloodbank: { present: false, before: null, after: null, changed: false },
    removedPlane: null, channels: [], routing: [], flags: [], nextActions: [], leftBehind: [],
  };

  if (!existsSync(registryPath)) return failure(base, [`org chart not found at ${registryPath}`]);
  const original = readFileSync(registryPath, "utf8");
  const document = YAML.parseDocument(original);
  if (document.errors.length) return failure(base, [`org chart YAML is invalid: ${registryPath}`]);

  const agents = agentsOf(document.toJS());
  const row = Object.hasOwn(agents, employeeId) && isRow(agents[employeeId]) ? (agents[employeeId] as Row) : undefined;
  if (!row) return failure(base, [`no employee "${employeeId}" in the org chart`]);
  if (Object.hasOwn(row, "bloodbank") && !isRow(row.bloodbank)) return failure({ ...base, found: true }, [`${employeeId}: bloodbank is not a mapping; refusing to guess how to disable it`]);

  const planned = retiredRow(row);
  const live = liveChannels(row);
  const needsRegistryWrite = planned.bloodbank.changed || Object.hasOwn(row, "plane");
  const result: RetireResult = {
    ...base, ok: true, found: true,
    alreadyRetired: !needsRegistryWrite && live.length === 0,
    bloodbank: planned.bloodbank, removedPlane: planned.removedPlane,
    errors: [],
  };

  // Routing, before and after, for every board this row claimed. `after` is the pure transform of the
  // same parsed rows the write will be proven against, so a preview reports what an apply produces.
  const after: Row = { ...agents, [employeeId]: planned.row };
  result.routing = claimedBoards(row).map((board) => {
    const before = boardRouting(agents, board);
    // Every label the board routed before, so one only this row declared is still reported after it leaves.
    const known = before.routes.flatMap((route) => (route.label === null ? [] : [route.label]));
    return { board, before, after: boardRouting(after, board, known) };
  });
  result.flags = result.routing.flatMap((entry) => entry.after.flags.map((flag) => `${flag.code}: ${flag.detail}`));
  if (result.bloodbank.present === false) result.nextActions.push(`${employeeId} has no bloodbank block: already unroutable by the bus; nothing to disable`);

  // Name what survives BEFORE touching anything, so a dry run reports the list an apply does.
  const profileName = typeof row.profile_name === "string" ? row.profile_name : employeeId;
  const desk = join(resolveFleetHomeDir(process.env, homeDir), "profiles", profileName);
  const restart = `hermes-gateway-restart --reason "retired ${employeeId}"`;
  if (existsSync(desk)) {
    result.leftBehind.push(`desk ${desk}: the shared gateway keeps loading it until the desk is removed AND the gateway restarted (${restart}; never raw systemctl)`);
  }
  const roleDir = typeof row.role_dir === "string" ? row.role_dir : undefined;
  if (roleDir && existsSync(roleDir)) result.leftBehind.push(`role directory ${roleDir} (tracked in its own repository)`);
  if (isLaunchdHost(options.platform ?? hostPlatform())) {
    result.leftBehind.push(`gateway: per-agent units are not observable on a launchd host; the multiplexed ${LAUNCHD_GATEWAY_LABEL} keeps serving profile ${profileName} until its desk is removed and the gateway restarted (hermes gateway restart)`);
  } else {
    const unit = `hermes-${employeeId}-gateway.service`;
    if (existsSync(join(homeDir, ".config", "systemd", "user", unit))) result.leftBehind.push(`systemd unit ${unit} (disable it yourself: systemctl --user disable --now ${unit})`);
  }

  if (options.apply && needsRegistryWrite) {
    try {
      await withRegistryLock(registryPath, async () => {
        updateRegistryDocumentUnlocked(registryPath, (doc) => {
          // Re-read under the lock: the plan above may be stale, and the proof must be against what is on disk now.
          const current = doc.toJS() as { agents?: Record<string, unknown> };
          const currentRow = current.agents?.[employeeId];
          if (!isRow(currentRow)) throw new Error(`${employeeId} left the org chart while waiting for the registry lock`);
          const edit = retiredRow(currentRow);
          if (edit.bloodbank.present) doc.setIn(["agents", employeeId, "bloodbank", "enabled"], false);
          if (Object.hasOwn(currentRow, "plane")) doc.deleteIn(["agents", employeeId, "plane"]);
          // Prove the surgery before it reaches disk: the result must be the original with exactly
          // this row's bloodbank.enabled and plane changed, and nothing else moved.
          const proven = YAML.parse(String(doc)) as { agents?: Record<string, unknown> };
          const expected = { ...current, agents: { ...current.agents, [employeeId]: edit.row } };
          if (!isDeepStrictEqual(proven, expected)) throw new Error("refusing to write: retiring the row would have changed something else");
          result.removedPlane = edit.removedPlane;
        });
      });
      result.applied = true;
    } catch (error) {
      return { ...result, ok: false, errors: [`could not write the org chart: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  // Channels: park each live one with the existing channelOffline, never reimplemented.
  for (const platform of live) {
    const command = `flume channel offline ${employeeId} --platform ${platform} --reason ${JSON.stringify(reason)} --apply`;
    if (channelRegistryPath() !== registryPath) {
      // channelOffline resolves the registry from the environment alone; do not let it write a different file.
      result.channels.push({ platform, action: "next-action", command, detail: `not parked here: channel parking reads the registry from the environment (${channelRegistryPath()}), not ${registryPath}` });
      result.nextActions.push(command);
      continue;
    }
    try {
      const parked = await channelOffline(employeeId, { platform, reason, apply: Boolean(options.apply), noReload: true });
      if (!parked.ok) {
        const why = parked.blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`).join("; ");
        result.channels.push({ platform, action: "next-action", command, detail: `channelOffline refused: ${why}` });
        result.nextActions.push(command);
        result.errors.push(`${platform}: could not be parked (${why})`);
      } else {
        result.channels.push({ platform, action: options.apply ? "parked" : "would-park", detail: parked.note ?? `${platform} ${parked.from.status ?? "unset"} -> ${parked.to.status}` });
      }
    } catch (error) {
      // Typically the desk is missing: channelOffline needs a real profile directory to render.
      const why = error instanceof Error ? error.message : String(error);
      result.channels.push({ platform, action: "next-action", command, detail: `channelOffline could not run: ${why}` });
      result.nextActions.push(command);
      if (options.apply) result.errors.push(`${platform}: could not be parked (${why})`);
    }
  }
  if (result.errors.length) result.ok = false;
  if (options.apply && result.channels.some((channel) => channel.action === "parked")) {
    result.nextActions.push(`${restart}  # one restart, after the last change; --no-reload left the gateway alone`);
  }
  return result;
}

export function formatRetireResult(result: RetireResult): string {
  const lines: string[] = [];
  if (!result.found) {
    lines.push(`✗ retire ${result.employeeId} failed`);
    for (const error of result.errors) lines.push(`    ${error}`);
    return lines.join("\n");
  }
  if (!result.ok) lines.push(`✗ retire ${result.employeeId}: ${result.applied ? "registry written, but" : ""} not finished`);
  else if (result.alreadyRetired) lines.push(`${result.employeeId} is already retired (nothing to change)`);
  else lines.push(result.applied ? `✓ ${result.employeeId} retired (record kept)` : `would retire ${result.employeeId}, keeping the record (dry run; pass --apply)`);
  lines.push(`    ${result.registryPath}`);
  const verb = result.applied ? "" : "would ";
  if (result.bloodbank.changed) lines.push(`  ${verb}set bloodbank.enabled ${String(result.bloodbank.before ?? "(absent)")} -> false`);
  if (result.removedPlane !== null) lines.push(`  ${verb}remove the plane claim: ${JSON.stringify(result.removedPlane)}`);
  for (const channel of result.channels) lines.push(`  ${channel.platform}: ${channel.action} - ${channel.detail}${channel.command ? `\n      run: ${channel.command}` : ""}`);
  for (const entry of result.routing) {
    lines.push(`  board ${entry.board}, tickets now go to:`);
    for (const route of entry.after.routes) lines.push(`    ${(route.label ?? "(unlabeled)").padEnd(12)} ${route.owner ?? "nobody"}${route.label !== null && route.owner !== null && !route.declared ? "  (fallback: nobody declares it)" : ""}${route.owner !== null && !route.eligible ? "  (INELIGIBLE: dropped)" : ""}`);
    const lost = entry.before.routes.filter((route) => route.owner === result.employeeId).map((route) => route.label ?? "(unlabeled)");
    if (lost.length) lines.push(`    (before: ${lost.join(", ")} went to ${result.employeeId})`);
  }
  for (const flag of result.flags) lines.push(`  ! ${flag}`);
  for (const error of result.errors) lines.push(`  ✗ ${error}`);
  if (result.nextActions.length) {
    lines.push("", "  Next:");
    for (const action of result.nextActions) lines.push(`    · ${action}`);
  }
  if (result.leftBehind.length) {
    lines.push("", "  Not touched:");
    for (const item of result.leftBehind) lines.push(`    · ${item}`);
  }
  return lines.join("\n");
}
