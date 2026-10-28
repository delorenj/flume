/**
 * Offboarding: removing an employee's record from the org chart.
 *
 * This is the one write pjangler is NOT allowed to make. The handbook grants
 * `project-registry` three fields inside the agent registry -- the board
 * identifier, id and workspace, one-way projections out of `.project.json` --
 * and nothing else. Removing a whole row is `agent_operational_records`, and
 * Flume owns that authority. `pj project identity` used to delete rows here; now
 * it reports them and names this command.
 *
 * Deliberately NARROW. It removes the record and says plainly what it did not
 * touch. An employee leaving is not one atomic act -- their desk, their units
 * and their role directory all outlive the record, and a command that claimed
 * to have handled all of it would be lying. Those are reported so an operator
 * can finish the job, or leave them in place on purpose.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { resolveAgentRegistryPath, resolveFleetHomeDir } from "../kernel/fleet-paths";
import { hostPlatform, isLaunchdHost, LAUNCHD_GATEWAY_LABEL } from "../kernel/host-platform";

export interface OffboardResult {
  ok: boolean;
  employeeId: string;
  registryPath: string;
  /** True when the record was present and (on apply) removed. */
  found: boolean;
  applied: boolean;
  /** What outlives the record, so the operator is not misled into thinking it is gone. */
  leftBehind: string[];
  errors: string[];
}

export interface OffboardOptions {
  apply?: boolean;
  homeDir?: string;
  registryPath?: string;
  /** The service manager's platform; defaults to `hostPlatform()` (the FLUME_HOST_PLATFORM seam). */
  platform?: NodeJS.Platform;
}

export function offboardEmployee(employeeId: string, options: OffboardOptions = {}): OffboardResult {
  const homeDir = options.homeDir ?? homedir();
  const registryPath = options.registryPath ?? resolveAgentRegistryPath(process.env, homeDir);
  const errors: string[] = [];
  const leftBehind: string[] = [];

  if (!existsSync(registryPath)) {
    return { ok: false, employeeId, registryPath, found: false, applied: false, leftBehind, errors: [`org chart not found at ${registryPath}`] };
  }

  const original = readFileSync(registryPath, "utf8");
  const document = YAML.parseDocument(original);
  if (document.errors.length) {
    return { ok: false, employeeId, registryPath, found: false, applied: false, leftBehind, errors: [`org chart YAML is invalid: ${registryPath}`] };
  }

  const before = document.toJS() as { agents?: Record<string, unknown> };
  const agents = before.agents ?? {};
  const record = Object.hasOwn(agents, employeeId) ? (agents[employeeId] as Record<string, unknown>) : undefined;
  if (!record) {
    return { ok: false, employeeId, registryPath, found: false, applied: false, leftBehind, errors: [`no employee "${employeeId}" in the org chart`] };
  }

  // Name what survives BEFORE touching anything, so a dry run reports the same
  // list an apply does.
  const profileName = typeof record.profile_name === "string" ? record.profile_name : employeeId;
  const desk = join(resolveFleetHomeDir(process.env, homeDir), "profiles", profileName);
  if (existsSync(desk)) leftBehind.push(`desk ${desk} (still on disk)`);
  const roleDir = typeof record.role_dir === "string" ? record.role_dir : undefined;
  if (roleDir && existsSync(roleDir)) leftBehind.push(`role directory ${roleDir} (tracked in its own repository)`);
  if (isLaunchdHost(options.platform ?? hostPlatform())) {
    // No per-agent unit exists to report: one multiplexed LaunchAgent serves every profile it finds.
    leftBehind.push(`gateway: per-agent units are not observable on a launchd host; the multiplexed ${LAUNCHD_GATEWAY_LABEL} keeps serving profile ${profileName} until its desk is removed and the gateway restarted (hermes gateway restart)`);
  } else {
    const units = join(homeDir, ".config", "systemd", "user");
    for (const unit of [`hermes-${employeeId}-gateway.service`]) {
      if (existsSync(join(units, unit))) leftBehind.push(`systemd unit ${unit} (disable it yourself: systemctl --user disable --now ${unit})`);
    }
  }

  if (!options.apply) {
    return { ok: true, employeeId, registryPath, found: true, applied: false, leftBehind, errors };
  }

  document.deleteIn(["agents", employeeId]);

  // Prove the surgery before it reaches disk: the result must be the original
  // with exactly this one row gone, and nothing else moved.
  const text = document.toString();
  const after = YAML.parse(text) as { agents?: Record<string, unknown> };
  const expected = { ...before, agents: { ...agents } };
  delete (expected.agents as Record<string, unknown>)[employeeId];
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    return { ok: false, employeeId, registryPath, found: true, applied: false, leftBehind, errors: ["refusing to write: removing the row would have changed something else"] };
  }

  const temp = `${registryPath}.offboard.${process.pid}`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, registryPath);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* the temp file may never have been created */ }
    return { ok: false, employeeId, registryPath, found: true, applied: false, leftBehind, errors: [`could not write the org chart: ${error instanceof Error ? error.message : String(error)}`] };
  }

  return { ok: true, employeeId, registryPath, found: true, applied: true, leftBehind, errors };
}

export function formatOffboardResult(result: OffboardResult): string {
  const lines: string[] = [];
  if (!result.ok) {
    lines.push(`✗ offboard ${result.employeeId} failed`);
    for (const error of result.errors) lines.push(`    ${error}`);
    return lines.join("\n");
  }
  lines.push(result.applied
    ? `✓ ${result.employeeId} removed from the org chart`
    : `would remove ${result.employeeId} from the org chart (dry run; pass --apply)`);
  lines.push(`    ${result.registryPath}`);
  if (result.leftBehind.length) {
    lines.push("", "  Not touched — an employee outlives their record:");
    for (const item of result.leftBehind) lines.push(`    · ${item}`);
  }
  return lines.join("\n");
}
