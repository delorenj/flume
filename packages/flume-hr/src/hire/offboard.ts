/**
 * Offboarding: an employee leaves the company. One command, everything an exit needs.
 *
 * Before 2026-11-24 this removed only the registry row, and `flume retire` only took the employee out of service (record
 * kept). Neither one finished an exit. The three launch directors were "retired" on 2026-11-18 when launch mode on the PM
 * replaced them, and six days later they were still in the org chart, the status line and Telegram. Their desks were still
 * served, one had been re-created seconds after it was archived (the gateway was still writing into it), and the role
 * directories in their repos were still there, ready for a scaffold refresh to provision them again. An exit is a sequence,
 * and every step must land, or the next tool puts the employee back.
 *
 * `flume offboard <employee> --apply` runs, in this order (a preview reports the same plan and writes nothing):
 *   1. service    `retireFromService`, never reimplemented: bloodbank off, the plane board claim removed, every live
 *                 channel parked (Telegram/Slack delta pinned off, the registry says offline + why).
 *   2. identity   when enrolled: `flume identity retire --revoke all` (status retired, tombstone, mailbox allowlist and
 *                 routing rule closed, Access/GitHub/gateway credentials revoked where this lifecycle may). A failure stops
 *                 here with the row kept, so a re-run can finish the revocation: the row is what the lifecycle reads.
 *   3. schedules  every registered Candybar whose runner runs this profile is archived (paused and hidden).
 *   4. unserve    the gateway control socket's `unserve-profile`: the profile's adapters stop now, no restart.
 *   5. desk       moved to `<fleet home>/profiles-retired/<profile>-<UTC stamp>` (never deleted).
 *   6. role dir   `git rm` of `<repo>/agents/hermes/<role>` with a path-scoped commit, then pushed, so no scaffold
 *                 refresh provisions the role again (`--keep-role-dir` skips it).
 *   7. record     the whole row (as it was before step 1) written to `<fleet home>/agents-retired/<id>-<stamp>.yaml`,
 *                 then the row removed from the registry under the registry lock, proven to touch nothing else.
 *   8. restart    only with `--restart`: one `hermes-gateway-restart`. Unserve already stopped the profile, and the
 *                 cron ticker re-reads profiles/ every cycle, so a restart is only needed when unserve could not run.
 *
 * What it cannot do is reported, never faked: a Telegram bot can only be deleted by its owner in @BotFather (there is no
 * Bot API call for that), and the employee's Hindsight bank and native Plane user are kept as history. Re-running is
 * safe: each step converges (an already-retired service, an already-retired identity, an archived candybar).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { resolveAgentRegistryPath, resolveFleetHomeDir } from "../kernel/fleet-paths";
import { hostPlatform, isLaunchdHost, LAUNCHD_GATEWAY_LABEL } from "../kernel/host-platform";
import { unserveProfileViaSocket } from "../workforce/channel";
import { retireEmployee } from "../workforce/lifecycle";
import { readLifecycleState } from "../workforce/lifecycle-state";
import { withRegistryLock } from "../workforce/role";
import { updateRegistryDocumentUnlocked } from "./PreserveRegistryComments";
import { retireFromService, type RetireResult } from "./retire";

export type OffboardAction = "done" | "would" | "skipped" | "failed" | "next-action";

export interface OffboardStep {
  step: "service" | "identity" | "schedules" | "unserve" | "desk" | "role-dir" | "record" | "restart";
  action: OffboardAction;
  detail: string;
  /** The exact command to run when `action` is `next-action` or `failed`. */
  command?: string;
}

export interface OffboardResult {
  ok: boolean;
  employeeId: string;
  registryPath: string;
  /** True when the record was present (or, for a ghost, the desk). */
  found: boolean;
  /** No org-chart row, only a leftover desk: schedules, unserve and desk ran; nothing else applied. */
  ghost?: boolean;
  /** True when the row was removed from the org chart by this run. */
  applied: boolean;
  reason: string;
  steps: OffboardStep[];
  /** Where the full record went (`agents-retired/<id>-<stamp>.yaml`), or would go on a preview. */
  archive: string | null;
  /** The desk archive, when one was (or would be) made. */
  deskArchive: string | null;
  /** What outlives the exit on purpose, or what this command cannot reach. */
  leftBehind: string[];
  nextActions: string[];
  errors: string[];
  /** The service retirement's own result (routing before and after, channels), verbatim. */
  service?: RetireResult;
  /** The identity lifecycle's own result, verbatim, when the employee was enrolled. */
  identity?: Record<string, unknown>;
}

export interface OffboardOptions {
  apply?: boolean;
  reason?: string;
  homeDir?: string;
  registryPath?: string;
  /** The service manager's platform; defaults to `hostPlatform()` (the FLUME_HOST_PLATFORM seam). */
  platform?: NodeJS.Platform;
  /** Leave `<repo>/agents/hermes/<role>` in its repository. */
  keepRoleDir?: boolean;
  /** Run one `hermes-gateway-restart` at the end. */
  restart?: boolean;
  /** The archive stamp's clock; tests pin it. */
  now?: Date;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// ---------------------------------------------------------------------------------------------
// Candybar: the schedules that run this employee
// ---------------------------------------------------------------------------------------------

interface ScheduledRun { id: string; name: string; enabled: boolean; archived: boolean; why: string }

function candybarUrl(): string { return (process.env.FLUME_CANDYBAR_API_URL || process.env.CANDYBAR_API_URL || "http://127.0.0.1:8700").replace(/\/+$/u, ""); }
function candybarBin(): string { return process.env.FLUME_CANDYBAR_BIN?.trim() || "candybar"; }

/** Why `runner` runs `profile`, or null. Exact tokens only: a profile name inside another word never matches. */
export function runnerRunsProfile(runner: unknown, profile: string): string | null {
  if (!isRow(runner)) return null;
  if (runner.kind === "hermes" && runner.profile === profile) return `hermes runner for profile ${profile}`;
  const argv = Array.isArray(runner.argv) ? runner.argv.map(String) : [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if ((arg === "-p" || arg === "--profile") && argv[i + 1] === profile) return `argv ${arg} ${profile}`;
    if (arg === `--profile=${profile}`) return `argv ${arg}`;
    if (new RegExp(`/profiles/${profile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(/|$)`, "u").test(arg)) return `argv path ${arg}`;
  }
  const env = isRow(runner.env) ? runner.env : {};
  for (const key of ["HERMES_HOME", "HERMES_PROFILE"]) {
    const value = text(env[key]);
    if (value === profile || value.endsWith(`/profiles/${profile}`)) return `env ${key}=${value}`;
  }
  return null;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function schedulesOf(profile: string): Promise<{ runs: ScheduledRun[]; error?: string }> {
  const base = candybarUrl();
  try {
    const listed = await getJson(`${base}/candybars`);
    const items = (Array.isArray(listed) ? listed : isRow(listed) && Array.isArray(listed.items) ? listed.items : []).filter(isRow);
    const runs: ScheduledRun[] = [];
    // One small GET per candybar on loopback; the list endpoint does not carry runners.
    await Promise.all(items.map(async (item) => {
      const id = text(item.id);
      if (!id) return;
      const detail = await getJson(`${base}/candybars/${encodeURIComponent(id)}/runner`).catch(() => null);
      const why = runnerRunsProfile(isRow(detail) ? detail.runner : null, profile);
      if (why) runs.push({ id, name: text(item.name) || id, enabled: item.enabled !== false, archived: item.archived === true, why });
    }));
    return { runs: runs.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (error) {
    return { runs: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// The role directory: a path-scoped removal commit in its own repository
// ---------------------------------------------------------------------------------------------

function git(cwd: string, args: string[], timeout = 60_000) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

/**
 * Remove `<repo>/agents/hermes/<role>`: copy the whole directory (tracked, modified, untracked and ignored files alike) to
 * `archive` first, then `git rm -r -f` the tracked part with a path-scoped commit and push, then clear what git does not
 * track. Nothing is lost: the identity step itself rewrites role.yaml (its company_identity status), and a role's ignored
 * `runtime/` is never in git, so a plain `git rm` would either refuse or leave the directory behind.
 */
function retireRoleDir(roleDir: string, employeeId: string, reason: string, archive: string): OffboardStep {
  const top = git(roleDir, ["rev-parse", "--show-toplevel"]);
  const repo = top.status === 0 ? top.stdout.trim() : "";
  const rel = repo ? relative(repo, roleDir) || "." : "";
  if (repo && (rel === "." || rel.startsWith(".."))) return { step: "role-dir", action: "failed", detail: `refusing to remove ${roleDir}: it is the repository root or outside it` };
  try {
    if (existsSync(archive)) return { step: "role-dir", action: "failed", detail: `${archive} already exists` };
    mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
    cpSync(roleDir, archive, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  } catch (error) {
    return { step: "role-dir", action: "failed", detail: `could not archive ${roleDir} to ${archive}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const tracked = repo ? git(repo, ["ls-files", "-z", "--", rel]).stdout : "";
  let commitNote = "";
  let pushStep: OffboardStep | null = null;
  if (tracked) {
    const removed = git(repo, ["rm", "-r", "-q", "-f", "--", rel]);
    if (removed.status !== 0) return { step: "role-dir", action: "failed", detail: `git rm ${rel} in ${repo}: ${removed.stderr.trim()} (archived to ${archive})` };
    // Path-scoped: other agents' staged work in this repository is never swept into the commit.
    const message = `chore(agents): offboard ${employeeId}\n\n${reason}. Removed by flume offboard so no scaffold refresh provisions the role again; the directory is archived at ${archive}.`;
    const committed = git(repo, ["commit", "-q", "-m", message, "--", rel]);
    if (committed.status !== 0) return { step: "role-dir", action: "failed", detail: `git commit in ${repo}: ${(committed.stderr || committed.stdout).trim()} (archived to ${archive})` };
    const sha = git(repo, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    commitNote = `commit ${sha}`;
    if (git(repo, ["rev-parse", "--abbrev-ref", "@{u}"]).status !== 0) {
      pushStep = { step: "role-dir", action: "next-action", detail: "", command: `git -C ${JSON.stringify(repo)} push -u origin HEAD` };
      commitNote += ", no upstream to push to";
    } else {
      let pushed = git(repo, ["push", "-q"], 120_000);
      if (pushed.status !== 0 && git(repo, ["pull", "-q", "--rebase", "--autostash"], 120_000).status === 0) pushed = git(repo, ["push", "-q"], 120_000);
      if (pushed.status !== 0) {
        pushStep = { step: "role-dir", action: "next-action", detail: "", command: `git -C ${JSON.stringify(repo)} pull --rebase --autostash && git -C ${JSON.stringify(repo)} push` };
        commitNote += `, push failed: ${pushed.stderr.trim().split("\n")[0]}`;
      } else commitNote += ", pushed";
    }
  }
  // What git does not track (ignored runtime/, caches) is in the archive; clear it so the directory is gone.
  try { rmSync(roleDir, { recursive: true, force: true }); } catch (error) {
    return { step: "role-dir", action: "failed", detail: `${commitNote ? `${commitNote}; ` : ""}could not clear ${roleDir}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const where = repo ? `${rel} in ${repo}` : roleDir;
  const detail = `removed ${where}${commitNote ? ` (${commitNote})` : tracked ? "" : " (nothing tracked)"}; archived to ${archive}`;
  return pushStep ? { ...pushStep, detail } : { step: "role-dir", action: "done", detail };
}

// ---------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------

async function removeRow(registryPath: string, employeeId: string): Promise<void> {
  await withRegistryLock(registryPath, async () => {
    updateRegistryDocumentUnlocked(registryPath, (doc) => {
      const current = doc.toJS() as { agents?: Record<string, unknown> };
      if (!current.agents || !Object.hasOwn(current.agents, employeeId)) throw new Error(`${employeeId} left the org chart while waiting for the registry lock`);
      doc.deleteIn(["agents", employeeId]);
      // Prove the surgery before it reaches disk: exactly this one row gone, nothing else moved.
      const after = YAML.parse(String(doc)) as { agents?: Record<string, unknown> };
      const agents = { ...current.agents };
      delete agents[employeeId];
      if (!isDeepStrictEqual(after, { ...current, agents })) throw new Error("refusing to write: removing the row would have changed something else");
    });
  });
}

interface VacateContext {
  profile: string; desk: string; deskArchive: string; fleetHome: string; apply: boolean; restart: string;
  step: (entry: OffboardStep) => void; result: OffboardResult;
}

/** The Candybars that run the profile, then unserve and archive its desk. Shared by a full exit and a ghost desk. */
async function vacateDesk({ profile, desk, deskArchive, fleetHome, apply, restart, step, result }: VacateContext): Promise<boolean> {
  // 3. schedules: the Candybars that run this profile.
  const schedules = await schedulesOf(profile);
  if (schedules.error) {
    result.leftBehind.push(`schedules: Candybar unreadable (${schedules.error}); nothing was checked for jobs that run ${profile}`);
    step({ step: "schedules", action: "next-action", detail: `Candybar unreadable: ${schedules.error}`, command: `candybar ls --all  # archive any candybar that runs ${profile}` });
  } else if (schedules.runs.length === 0) {
    step({ step: "schedules", action: "skipped", detail: `no registered candybar runs ${profile}` });
  } else {
    for (const run of schedules.runs) {
      if (run.archived) { step({ step: "schedules", action: "skipped", detail: `candybar ${run.name} already archived (${run.why})` }); continue; }
      if (!apply) { step({ step: "schedules", action: "would", detail: `archive candybar ${run.name} (${run.why})` }); continue; }
      const archived = spawnSync(candybarBin(), ["archive", run.id], { encoding: "utf8", timeout: 60_000, shell: false, env: { ...process.env, NO_COLOR: "1" } });
      if (archived.error || archived.status !== 0) {
        step({ step: "schedules", action: "failed", detail: `candybar archive ${run.name}: ${String(archived.stderr || archived.error?.message || `exit ${archived.status}`).trim().split("\n")[0]}`, command: `candybar archive ${run.name}` });
        result.errors.push(`schedules: candybar ${run.name} still scheduled`);
      } else {
        step({ step: "schedules", action: "done", detail: `archived candybar ${run.name} (${run.why})` });
      }
    }
  }

  // 4 + 5. unserve, then move the desk. Unserve first: a served profile is written into by the running gateway, which
  // re-created tolt-launch-director's desk seconds after it was archived on 2026-11-19.
  let unserved = false;
  if (!existsSync(desk)) {
    step({ step: "unserve", action: "skipped", detail: `no desk at ${desk}` });
    step({ step: "desk", action: "skipped", detail: `no desk at ${desk}` });
  } else if (!apply) {
    step({ step: "unserve", action: "would", detail: `unserve profile ${profile} through the gateway control socket` });
    step({ step: "desk", action: "would", detail: `move ${desk} -> ${deskArchive}` });
    result.deskArchive = deskArchive;
  } else {
    const down = await unserveProfileViaSocket(profile);
    unserved = down.ok;
    step(down.ok ? { step: "unserve", action: "done", detail: down.detail }
      : { step: "unserve", action: "next-action", detail: `${down.detail}; the desk is archived anyway and the gateway drops it at its next restart`, command: restart });
    if (existsSync(deskArchive)) {
      step({ step: "desk", action: "failed", detail: `${deskArchive} already exists` });
      result.errors.push(`desk: ${deskArchive} already exists`);
    } else {
      try {
        mkdirSync(join(fleetHome, "profiles-retired"), { recursive: true });
        renameSync(desk, deskArchive);
        result.deskArchive = deskArchive;
        step({ step: "desk", action: "done", detail: `moved ${desk} -> ${deskArchive} (memories, sessions and stores kept)` });
      } catch (error) {
        step({ step: "desk", action: "failed", detail: error instanceof Error ? error.message : String(error) });
        result.errors.push(`desk: not archived (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  return unserved;
}

const stampOf = (now: Date) => now.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");

// ---------------------------------------------------------------------------------------------
// offboard
// ---------------------------------------------------------------------------------------------

export async function offboardEmployee(employeeId: string, options: OffboardOptions = {}): Promise<OffboardResult> {
  const homeDir = options.homeDir ?? homedir();
  const registryPath = options.registryPath ?? resolveAgentRegistryPath(process.env, homeDir);
  const fleetHome = resolveFleetHomeDir(process.env, homeDir);
  const apply = Boolean(options.apply);
  const reason = text(options.reason) || "employee offboarded";
  const result: OffboardResult = {
    ok: true, employeeId, registryPath, found: false, applied: false, reason,
    steps: [], archive: null, deskArchive: null, leftBehind: [], nextActions: [], errors: [],
  };
  const fail = (error: string): OffboardResult => ({ ...result, ok: false, errors: [...result.errors, error] });

  if (!existsSync(registryPath)) return fail(`org chart not found at ${registryPath}`);
  const document = YAML.parseDocument(readFileSync(registryPath, "utf8"));
  if (document.errors.length) return fail(`org chart YAML is invalid: ${registryPath}`);
  const agents = (document.toJS() as { agents?: Record<string, unknown> }).agents ?? {};
  const row = Object.hasOwn(agents, employeeId) && isRow(agents[employeeId]) ? (agents[employeeId] as Row) : undefined;
  if (!row) {
    // A ghost desk: the row is already gone but profiles/<id> is still there (and still served). Seen 2026-11-24:
    // earshot-launch-director's desk held only a generated config.yaml four days after its row left the registry.
    const ghost = join(fleetHome, "profiles", employeeId);
    if (!existsSync(ghost)) return fail(`no employee "${employeeId}" in the org chart`);
    result.found = true;
    result.ghost = true;
    const stamp = stampOf(options.now ?? new Date());
    const restart = `hermes-gateway-restart --reason "offboarded ghost desk ${employeeId}"`;
    const step = (entry: OffboardStep) => { result.steps.push(entry); if (entry.command && (entry.action === "next-action" || entry.action === "failed")) result.nextActions.push(entry.command); };
    const unserved = await vacateDesk({ profile: employeeId, desk: ghost, deskArchive: join(fleetHome, "profiles-retired", `${employeeId}-${stamp}`), fleetHome, apply, restart, step, result });
    if (apply && !unserved && result.deskArchive) result.nextActions.push(`${restart}  # unserve could not run, so the gateway serves the profile until it restarts`);
    result.applied = apply && result.errors.length === 0;
    result.ok = result.errors.length === 0;
    return result;
  }
  result.found = true;

  const snapshot = structuredClone(row);
  const profile = text(row.profile_name) || employeeId;
  const desk = join(fleetHome, "profiles", profile);
  const stamp = stampOf(options.now ?? new Date());
  const deskArchive = join(fleetHome, "profiles-retired", `${profile}-${stamp}`);
  const recordArchive = join(fleetHome, "agents-retired", `${employeeId}-${stamp}.yaml`);
  const restart = `hermes-gateway-restart --reason "offboarded ${employeeId}"`;
  const step = (entry: OffboardStep) => { result.steps.push(entry); if (entry.command && (entry.action === "next-action" || entry.action === "failed")) result.nextActions.push(entry.command); };
  const stopped = () => ({ ...result, ok: false, leftBehind: [...result.leftBehind, `${employeeId} is still in the org chart: fix the failure above and re-run flume offboard ${employeeId} --apply (every step converges)`] });

  // 1. service: routing off, board claim gone, channels parked. Its own module, never reimplemented.
  const service = await retireFromService(employeeId, { apply, reason, homeDir, registryPath, platform: options.platform, now: options.now });
  result.service = service;
  const parts = [
    service.bloodbank.changed ? "bloodbank off" : null,
    service.removedPlane !== null ? "plane board claim removed" : null,
    ...service.channels.map((channel) => `${channel.platform} ${channel.action}`),
  ].filter(Boolean);
  if (!service.ok) {
    step({ step: "service", action: "failed", detail: service.errors.join("; ") || "retire did not finish", command: `flume retire ${employeeId} --apply` });
    result.errors.push(...service.errors.map((error) => `service: ${error}`));
    if (apply) return stopped();
  } else {
    step({ step: "service", action: service.alreadyRetired ? "skipped" : apply ? "done" : "would", detail: service.alreadyRetired ? "already out of service (routing off, no live channel)" : parts.join(", ") || "nothing to change" });
  }
  for (const flag of service.flags) result.leftBehind.push(`routing after the exit: ${flag}`);

  // 2. identity: the company identity lifecycle, when the employee has one.
  const identity = isRow(row.company_identity) ? row.company_identity : null;
  // The tombstone is the truth for "already retired": the identity lifecycle writes status into the definition it owns
  // (a PM's role.yaml), which this row may only mirror. Re-retiring after the desk is gone would read the fleet base's shared
  // gateway key as this employee's and report a revocation that was never this employee's to make.
  const tombstone = identity && text(identity.subject) ? readLifecycleState().tombstones[text(identity.subject)] : undefined;
  if (!identity) {
    step({ step: "identity", action: "skipped", detail: "never enrolled in a company identity: no mailbox, Access token or tombstone to handle" });
  } else if (identity.status === "retired" || tombstone) {
    step({ step: "identity", action: "skipped", detail: `${text(identity.email) || "identity"} already retired${tombstone ? ` on ${tombstone.retired_at}` : ""} (its tombstone outlives the row)` });
  } else {
    const retired = await retireEmployee(employeeId, { apply, revoke: ["all"] }) as Record<string, any>;
    result.identity = retired;
    const reports: Array<Record<string, any>> = Array.isArray(retired.steps) ? retired.steps : [];
    const count = (outcome: string) => reports.filter((r) => r.outcome === outcome).length;
    const summary = apply
      ? `${text(identity.email)} retired: ${count("done")} done, ${count("converged") + count("already-done")} already, ${count("skipped")} skipped, ${count("unresolved")} unresolved`
      : `${text(identity.email)} ${identity.status ?? "active"} -> retired: ${reports.map((r) => `${r.action ?? r.key}`).join(", ")}`;
    if (!retired.ok) {
      const blockers = (Array.isArray(retired.blockers) ? retired.blockers : []).map((b: Record<string, any>) => `${b.code}: ${b.detail}`);
      const unresolved = reports.filter((r) => r.outcome === "unresolved").map((r) => `${r.key}: ${r.provider_code ?? ""} ${r.detail ?? ""}`.trim());
      step({ step: "identity", action: "failed", detail: [...blockers, ...unresolved].join("; ") || summary, command: `flume identity retire ${employeeId} --revoke all --apply` });
      result.errors.push(`identity: ${[...blockers, ...unresolved].join("; ") || "retire did not finish"}`);
      if (apply) return stopped();
    } else {
      step({ step: "identity", action: apply ? "done" : "would", detail: summary });
      if (apply && retired.complete_revocation === false) {
        const open = (Array.isArray(retired.incomplete) ? retired.incomplete : []).map((row: Record<string, any>) => `${row.provider}/${row.kind}${row.id ? ` ${row.id}` : ""} ${row.status}`);
        result.leftBehind.push(`company identity: revocation INCOMPLETE${open.length ? ` (${open.join("; ")})` : ""}; these need a person`);
      }
      for (const r of reports.filter((r) => r.outcome === "skipped")) result.leftBehind.push(`identity ${r.key}: skipped (${r.provider_code ?? "not revocable here"})${r.detail ? `: ${r.detail}` : ""}`);
    }
  }
  const consumer = text(row.gateway_consumer);
  if (!identity && consumer && consumer !== "hermes") {
    result.nextActions.push(`python3 ~/code/client-portal/gateway/ops/gateway-tokens.py revoke ${consumer}  # its own gateway token; never enrolled, so the identity lifecycle could not revoke it`);
  }

  // 3, 4 + 5. schedules, unserve, desk.
  const unserved = await vacateDesk({ profile, desk, deskArchive, fleetHome, apply, restart, step, result });

  // 6. role directory.
  const roleDir = text(row.role_dir);
  if (!roleDir || !existsSync(roleDir)) {
    step({ step: "role-dir", action: "skipped", detail: roleDir ? `${roleDir} is already gone` : "no role directory on the row" });
  } else if (options.keepRoleDir) {
    step({ step: "role-dir", action: "skipped", detail: `kept ${roleDir} (--keep-role-dir)` });
    result.leftBehind.push(`role directory ${roleDir}: kept on request; a scaffold refresh can provision the role again until it is removed`);
  } else if (!apply) {
    step({ step: "role-dir", action: "would", detail: `git rm -r ${roleDir}, a path-scoped commit in its repository, then push` });
  } else {
    const removed = retireRoleDir(roleDir, employeeId, reason, join(fleetHome, "agents-retired", `${employeeId}-${stamp}.role-dir`));
    step(removed);
    if (removed.action === "failed") result.errors.push(`role-dir: ${removed.detail}`);
  }

  // 7. the record: archived in full, then the row removed. Last, so a failure above leaves the row for a re-run.
  if (!apply) {
    step({ step: "record", action: "would", detail: `archive the row to ${recordArchive}, then remove ${employeeId} from ${registryPath}` });
    result.archive = recordArchive;
  } else if (result.errors.length) {
    step({ step: "record", action: "skipped", detail: "kept: a step above failed, and the row is what a re-run reads" });
    return stopped();
  } else {
    try {
      mkdirSync(join(fleetHome, "agents-retired"), { recursive: true, mode: 0o700 });
      const archived = {
        employee: employeeId, offboarded_at: (options.now ?? new Date()).toISOString(), reason,
        desk_archive: result.deskArchive, removed_plane: service.removedPlane,
        steps: result.steps.map(({ step: name, action, detail }) => ({ step: name, action, detail })),
        record: snapshot,
      };
      writeFileSync(recordArchive, `# flume offboard ${employeeId}: the org-chart row as it was, kept as history.\n${YAML.stringify(archived)}`, { mode: 0o600, flag: "wx" });
      result.archive = recordArchive;
      await removeRow(registryPath, employeeId);
      result.applied = true;
      step({ step: "record", action: "done", detail: `archived to ${recordArchive}; removed from ${registryPath}` });
    } catch (error) {
      step({ step: "record", action: "failed", detail: error instanceof Error ? error.message : String(error) });
      result.errors.push(`record: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 8. restart, only on request (unserve already stopped the profile).
  if (apply && options.restart) {
    const restarted = spawnSync("hermes-gateway-restart", ["--reason", `offboarded ${employeeId}`], { encoding: "utf8", timeout: 900_000 });
    step(restarted.error || restarted.status !== 0
      ? { step: "restart", action: "failed", detail: String(restarted.stderr || restarted.error?.message || `exit ${restarted.status}`).trim().split("\n")[0] ?? "", command: restart }
      : { step: "restart", action: "done", detail: "hermes-gateway-restart finished" });
  } else if (apply && !unserved && result.deskArchive) {
    result.nextActions.push(`${restart}  # unserve could not run, so the gateway serves the profile until it restarts`);
  }

  // What outlives the exit, named so nobody thinks it is gone.
  const telegram = isRow(row.telegram) ? row.telegram : {};
  const bot = text(telegram.bot_username);
  if (bot && text(telegram.bot_id)) {
    const sharedWith = Object.entries(agents).filter(([id, other]) => id !== employeeId && isRow(other) && isRow(other.telegram) && text(other.telegram.bot_username) === bot).map(([id]) => id);
    result.leftBehind.push(sharedWith.length
      ? `Telegram bot @${bot} is also on ${sharedWith.join(", ")}: kept`
      : `Telegram bot @${bot}: nothing serves it now (silent), but it still exists. Only its owner can delete it: @BotFather /deletebot @${bot} (the Bot API has no call that deletes a bot)`);
  }
  const hindsight = isRow(row.hindsight) ? text(row.hindsight.write_bank) : "";
  if (hindsight) result.leftBehind.push(`Hindsight bank ${hindsight}: kept as history`);
  const bindings = identity && isRow(identity.bindings) ? Object.keys(identity.bindings) : [];
  if (bindings.includes("plane")) result.leftBehind.push("native Plane user: kept (its tickets and comments stay attributed); deactivate it in Plane if wanted");
  if (isLaunchdHost(options.platform ?? hostPlatform())) {
    result.leftBehind.push(`gateway: per-agent units are not observable on a launchd host; the multiplexed ${LAUNCHD_GATEWAY_LABEL} keeps serving profile ${profile} until its desk is removed and the gateway restarted (hermes gateway restart)`);
  } else {
    const unit = `hermes-${employeeId}-gateway.service`;
    if (existsSync(join(homeDir, ".config", "systemd", "user", unit))) result.leftBehind.push(`retired per-agent gateway unit ${unit} is still on disk: one host gateway serves every profile. Retire it with the role's .scripts/70-systemd.sh (it never stops the live host gateway)`);
  }

  if (result.errors.length) result.ok = false;
  return result;
}

const MARK: Record<OffboardAction, string> = { done: "✓", would: "·", skipped: "-", failed: "✗", "next-action": "!" };

export function formatOffboardResult(result: OffboardResult): string {
  const lines: string[] = [];
  if (!result.found) {
    lines.push(`✗ offboard ${result.employeeId} failed`);
    for (const error of result.errors) lines.push(`    ${error}`);
    return lines.join("\n");
  }
  const preview = !result.steps.some((s) => s.action === "done" || s.action === "failed") && !result.applied;
  lines.push(result.ghost ? (result.applied ? `✓ ghost desk ${result.employeeId} offboarded: no org-chart row; desk unserved and archived`
    : !result.ok ? `✗ ghost desk ${result.employeeId}: not finished` : `would offboard ghost desk ${result.employeeId} (no org-chart row; dry run; pass --apply)`)
    : result.applied ? `✓ ${result.employeeId} offboarded: out of the org chart, record archived`
    : !result.ok ? `✗ offboard ${result.employeeId}: not finished`
      : preview ? `would offboard ${result.employeeId} (dry run; pass --apply)` : `offboard ${result.employeeId}: not finished`);
  lines.push(`    ${result.registryPath}`);
  for (const s of result.steps) {
    lines.push(`  ${MARK[s.action]} ${s.step.padEnd(9)} ${s.detail}`);
  }
  for (const entry of result.service?.routing ?? []) {
    lines.push(`  board ${entry.board}, tickets ${result.applied ? "now go" : "would go"} to:`);
    for (const route of entry.after.routes) lines.push(`    ${(route.label ?? "(unlabeled)").padEnd(12)} ${route.owner ?? "nobody"}${route.owner !== null && !route.eligible ? "  (INELIGIBLE: dropped)" : ""}`);
  }
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
