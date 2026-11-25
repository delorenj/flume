/**
 * Rehiring: an offboarded employee comes back, from the archives `flume offboard` left. The exit undone, one command.
 *
 * The incident (2026-11-24): `flume offboard tolt-director --apply` ran as part of retiring the launch directors, and the
 * same afternoon the operator wanted the TOLT director back. Its record, desk, role directory and identity were all
 * archived, not deleted, but nothing could put them back: a retired identity is terminal by design (its tombstone refuses
 * every status change, bind and launch), and a hand-restore of five archives is exactly how a half-employee ships.
 *
 * `flume rehire <employee> --apply` reads the newest `<fleet home>/agents-retired/<id>-<stamp>.yaml` (or `--archive`), and:
 *   1. role dir   copies `<id>-<stamp>.role-dir` back to the row's `role_dir` (or, with no copy, checks the removal
 *                 commit's parent out for that path). Committed in step 6, once the identity has written role.yaml.
 *   2. desk       moves `profiles-retired/<profile>-<stamp>` back to `profiles/<profile>` (memories, sessions, stores).
 *   3. record     the archived row, exactly as it was before the offboard, added under the registry lock with a
 *                 comment-preserving write proven to add that one row and touch nothing else. An id already in the org
 *                 chart is refused, unless this archive's own rehire receipt says this rehire put it there (a re-run).
 *   4. identity   when the offboard retired it: the recorded un-retire (`unretireEmployee`: the tombstone, proven to be this
 *                 offboard's own, MOVED to the lifecycle's unretired history, never deleted; status retired -> suspended),
 *                 then the ordinary `flume identity restore` (allowlist record re-put, routing rule re-enabled, status
 *                 active LAST). What cannot be reversed (a deleted Access token, a revoked gateway token) is listed.
 *                 An identity retired BEFORE this offboard is never lifted: that was its own decision.
 *   5. gateway    the desk's own FLUME-39 member key, when the retire revoked it, is minted again through the maintained
 *                 authority (`gateway-member-tokens.py --render --apply`, the same call hire makes). Without it the desk
 *                 cannot reach a model.
 *   6. commit     a path-scoped commit of the role directory in its repository, then a push.
 *   7. schedules  the Candybars THIS offboard archived are unarchived (and resumed if they were scheduling). One archived
 *                 before the offboard stays archived and is named.
 *   8. serve      the gateway control socket's `serve-profile`: the profile runs now, no restart.
 * Then it reports what it would take to put the employee back IN SERVICE, without doing it: routing (bloodbank), the board
 * claim, chat channels (a Telegram bot only its owner can create, in @BotFather), the deleted Access token.
 *
 * A preview (no --apply) writes nothing and reports the same plan. Re-running converges: each step checks what is already
 * back. A receipt `<id>-<stamp>.rehired.yaml` beside the archive records the run.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { resolveAgentRegistryPath, resolveFleetHomeDir } from "../kernel/fleet-paths";
import { serveProfileViaSocket } from "../workforce/channel";
import { consumerOf, readRef } from "../workforce/gateway-desk";
import { offboardTombstoneProof, restoreEmployee, unretireEmployee } from "../workforce/lifecycle";
import { readLifecycleState } from "../workforce/lifecycle-state";
import { lifecycleDrift, rowLifecycle } from "../workforce/registry-lifecycle";
import { withRegistryLock } from "../workforce/role";
import { provisionMemberCredential } from "./MemberGatewayCredential";
import { git, pushRepository } from "./offboard";
import { updateRegistryDocumentUnlocked } from "./PreserveRegistryComments";

export type RehireAction = "done" | "would" | "skipped" | "failed" | "next-action";

export interface RehireStep {
  step: "archive" | "role-dir" | "desk" | "record" | "identity" | "gateway" | "commit" | "schedules" | "serve";
  action: RehireAction;
  detail: string;
  /** The exact command to run when `action` is `next-action` or `failed`. */
  command?: string;
}

export interface RehireResult {
  ok: boolean;
  employeeId: string;
  registryPath: string;
  /** The offboard archive this rehire reads. */
  archive: string | null;
  /** True when the row is in the org chart after this run (restored now or by an earlier run of the same rehire). */
  applied: boolean;
  reason: string;
  steps: RehireStep[];
  /** What it would take to put the employee back in service; never done here. */
  inService: string[];
  nextActions: string[];
  errors: string[];
  /** The identity lifecycle's own results, verbatim. */
  identity?: { unretire?: Record<string, unknown>; restore?: Record<string, unknown> };
}

export interface RehireOptions {
  apply?: boolean;
  /** An explicit offboard archive; default the newest `agents-retired/<id>-<stamp>.yaml`. */
  archive?: string;
  reason?: string;
  homeDir?: string;
  registryPath?: string;
  /** Leave the profile unserved (default: serve it through the gateway control socket). */
  serve?: boolean;
  now?: Date;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);

interface Archive {
  path: string;
  stamp: string;
  employee: string;
  offboarded_at?: string;
  reason?: string;
  desk_archive?: string | null;
  identity_operation_id?: string;
  archived_schedules?: Array<{ id: string; name: string; enabled: boolean }>;
  steps: Array<{ step: string; action: string; detail: string }>;
  record: Row;
}

const ARCHIVE = (id: string) => new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-(\\d{8}T\\d{6}Z)\\.yaml$`, "u");

/** The newest offboard archive for `employeeId` (stamps sort as text), or the one named. */
function findArchive(fleetHome: string, employeeId: string, explicit?: string): { path: string; stamp: string } | { error: string } {
  if (explicit) {
    const m = /-(\d{8}T\d{6}Z)\.yaml$/u.exec(explicit);
    if (!m) return { error: `${explicit} is not an offboard archive (<id>-<YYYYMMDDTHHMMSSZ>.yaml)` };
    return existsSync(explicit) ? { path: explicit, stamp: m[1]! } : { error: `${explicit} does not exist` };
  }
  const dir = join(fleetHome, "agents-retired");
  const pattern = ARCHIVE(employeeId);
  const found = existsSync(dir) ? readdirSync(dir).map((name) => ({ name, m: pattern.exec(name) })).filter((entry) => entry.m).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const newest = found.at(-1);
  return newest ? { path: join(dir, newest.name), stamp: newest.m![1]! } : { error: `no offboard archive for "${employeeId}" in ${dir}` };
}

function readArchive(path: string, stamp: string): Archive | { error: string } {
  let parsed: unknown;
  try { parsed = YAML.parse(readFileSync(path, "utf8")); } catch (error) { return { error: `${path} cannot be read: ${firstLine(error)}` }; }
  if (!isRow(parsed) || !isRow(parsed.record) || !text(parsed.employee)) return { error: `${path} is not an offboard archive (no employee or record)` };
  const steps = Array.isArray(parsed.steps) ? parsed.steps.filter(isRow).map((s) => ({ step: text(s.step), action: text(s.action), detail: text(s.detail) })) : [];
  const schedules = Array.isArray(parsed.archived_schedules) ? parsed.archived_schedules.filter(isRow).map((s) => ({ id: text(s.id), name: text(s.name), enabled: s.enabled !== false })).filter((s) => s.id) : undefined;
  return {
    path, stamp, employee: text(parsed.employee), steps, record: parsed.record,
    ...(text(parsed.offboarded_at) ? { offboarded_at: text(parsed.offboarded_at) } : {}),
    ...(text(parsed.reason) ? { reason: text(parsed.reason) } : {}),
    ...(typeof parsed.desk_archive === "string" ? { desk_archive: parsed.desk_archive } : {}),
    ...(text(parsed.identity_operation_id) ? { identity_operation_id: text(parsed.identity_operation_id) } : {}),
    ...(schedules ? { archived_schedules: schedules } : {}),
  };
}

const stepOf = (archive: Archive, name: string) => archive.steps.find((s) => s.step === name);

// ---------------------------------------------------------------------------------------------
// The record: one row added, proven
// ---------------------------------------------------------------------------------------------

async function addRow(registryPath: string, employeeId: string, record: Row): Promise<void> {
  await withRegistryLock(registryPath, async () => {
    updateRegistryDocumentUnlocked(registryPath, (doc) => {
      const current = doc.toJS() as { agents?: Record<string, unknown> };
      if (current.agents && Object.hasOwn(current.agents, employeeId)) throw new Error(`${employeeId} joined the org chart while waiting for the registry lock`);
      doc.setIn(["agents", employeeId], doc.createNode(structuredClone(record)));
      // Prove the surgery before it reaches disk: exactly this one row added, as archived, nothing else moved.
      const after = YAML.parse(String(doc)) as { agents?: Record<string, unknown> };
      if (!isDeepStrictEqual(after, { ...current, agents: { ...(current.agents ?? {}), [employeeId]: record } })) throw new Error("refusing to write: adding the row would have changed something else");
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The role directory
// ---------------------------------------------------------------------------------------------

/** The removal commit the offboard recorded in its role-dir step (`... (commit abc1234, pushed) ...`). */
const removalCommit = (archive: Archive): string | undefined => /\bcommit ([0-9a-f]{7,40})\b/u.exec(stepOf(archive, "role-dir")?.detail ?? "")?.[1];

function repoOf(dir: string): { repo: string; rel: string } | null {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return null;
  const repo = top.stdout.trim();
  const rel = relative(repo, dir);
  return rel && !rel.startsWith("..") ? { repo, rel } : null;
}

/** The nearest existing ancestor of `dir`, so git can be asked about a directory that is not there yet. */
function existingAncestor(dir: string): string {
  let at = dir;
  while (!existsSync(at)) { const up = join(at, ".."); if (up === at) break; at = up; }
  return at;
}

/** Put the role directory back: the archived copy (everything, ignored runtime/ included), else the removal commit's parent. */
function restoreRoleDir(roleDir: string, copy: string, sha: string | undefined): { ok: boolean; detail: string } {
  if (existsSync(copy)) {
    try {
      cpSync(copy, roleDir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      return { ok: true, detail: `copied ${copy} -> ${roleDir}` };
    } catch (error) { return { ok: false, detail: `could not copy ${copy} -> ${roleDir}: ${firstLine(error)}` }; }
  }
  if (!sha) return { ok: false, detail: `no archived copy at ${copy} and no removal commit recorded; nothing to restore ${roleDir} from` };
  const where = repoOf(existingAncestor(roleDir));
  if (!where) return { ok: false, detail: `no archived copy at ${copy}, and ${roleDir} is not inside a git repository` };
  const rel = relative(where.repo, roleDir);
  const checkout = git(where.repo, ["checkout", `${sha}^`, "--", rel]);
  return checkout.status === 0 ? { ok: true, detail: `checked out ${rel} from ${sha}^ (the removal commit's parent) in ${where.repo}` } : { ok: false, detail: `git checkout ${sha}^ -- ${rel}: ${checkout.stderr.trim()}` };
}

/** A path-scoped commit of the restored role directory, then a push. Only the files tracked before the removal are force-added. */
function commitRoleDir(roleDir: string, employeeId: string, reason: string, archive: Archive): RehireStep {
  const where = repoOf(roleDir);
  if (!where) return { step: "commit", action: "skipped", detail: `${roleDir} is not inside a git repository (or is its root)` };
  const { repo, rel } = where;
  const sha = removalCommit(archive);
  const tracked = sha ? git(repo, ["ls-tree", "-r", "-z", "--name-only", `${sha}^`, "--", rel]) : null;
  const files = tracked && tracked.status === 0 ? tracked.stdout.split("\0").filter((file) => file && existsSync(join(repo, file))) : [];
  // The files the role tracked before (some may be ignored by a later .gitignore); without the removal commit, what git would add.
  const added = files.length ? git(repo, ["add", "-f", "--", ...files]) : git(repo, ["add", "--", rel]);
  if (added.status !== 0) return { step: "commit", action: "failed", detail: `git add in ${repo}: ${added.stderr.trim()}`, command: `git -C ${JSON.stringify(repo)} add -- ${rel}` };
  if (git(repo, ["diff", "--cached", "--quiet", "--", rel]).status === 0 && git(repo, ["diff", "--quiet", "--", rel]).status === 0) {
    return { step: "commit", action: "skipped", detail: `${rel} in ${repo} is already committed as restored` };
  }
  const message = `chore(agents): rehire ${employeeId}\n\n${reason}. Restored by flume rehire from ${archive.path}${sha ? `; undoes ${sha}` : ""}.`;
  // Path-scoped: other agents' staged work in this repository is never swept into the commit.
  const committed = git(repo, ["commit", "-q", "-m", message, "--", rel]);
  if (committed.status !== 0) return { step: "commit", action: "failed", detail: `git commit in ${repo}: ${(committed.stderr || committed.stdout).trim()}`, command: `git -C ${JSON.stringify(repo)} commit -- ${rel}` };
  const head = git(repo, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  const pushed = pushRepository(repo);
  const detail = `${rel} in ${repo} (commit ${head}, ${pushed.note})`;
  return pushed.command ? { step: "commit", action: "next-action", detail, command: pushed.command } : { step: "commit", action: "done", detail };
}

// ---------------------------------------------------------------------------------------------
// rehire
// ---------------------------------------------------------------------------------------------

function candybarBin(): string { return process.env.FLUME_CANDYBAR_BIN?.trim() || "candybar"; }

export async function rehireEmployee(employeeId: string, options: RehireOptions = {}): Promise<RehireResult> {
  const homeDir = options.homeDir ?? homedir();
  const registryPath = options.registryPath ?? resolveAgentRegistryPath(process.env, homeDir);
  const fleetHome = resolveFleetHomeDir(process.env, homeDir);
  const apply = Boolean(options.apply);
  const reason = text(options.reason) || "rehired: the offboard is undone";
  const result: RehireResult = { ok: true, employeeId, registryPath, archive: null, applied: false, reason, steps: [], inService: [], nextActions: [], errors: [] };
  const step = (entry: RehireStep) => {
    result.steps.push(entry);
    if (entry.command && (entry.action === "next-action" || entry.action === "failed")) result.nextActions.push(entry.command);
    if (entry.action === "failed") result.errors.push(`${entry.step}: ${entry.detail}`);
  };
  const fail = (error: string): RehireResult => ({ ...result, ok: false, errors: [...result.errors, error] });

  // ---- the archive and where everything goes back to -------------------------------------------
  const found = findArchive(fleetHome, employeeId, options.archive);
  if ("error" in found) return fail(found.error);
  const archive = readArchive(found.path, found.stamp);
  if ("error" in archive) return fail(archive.error);
  if (archive.employee !== employeeId) return fail(`${archive.path} is ${archive.employee}'s offboard, not ${employeeId}'s`);
  result.archive = archive.path;
  const record = archive.record;
  const profile = text(record.profile_name) || employeeId;
  const desk = join(fleetHome, "profiles", profile);
  const deskArchive = archive.desk_archive || join(fleetHome, "profiles-retired", `${profile}-${archive.stamp}`);
  const roleDir = text(record.role_dir);
  const roleCopy = archive.path.replace(/\.yaml$/u, ".role-dir");
  const receiptPath = archive.path.replace(/\.yaml$/u, ".rehired.yaml");
  const rerun = existsSync(receiptPath);
  step({ step: "archive", action: "done", detail: `${archive.path} (offboarded ${archive.offboarded_at ?? "?"}${archive.reason ? `: ${archive.reason}` : ""})${rerun ? "; an earlier rehire from it is on record, so this run converges" : ""}` });

  if (!existsSync(registryPath)) return fail(`org chart not found at ${registryPath}`);
  const document = YAML.parseDocument(readFileSync(registryPath, "utf8"));
  if (document.errors.length) return fail(`org chart YAML is invalid: ${registryPath}`);
  const agents = (document.toJS() as { agents?: Record<string, unknown> }).agents ?? {};
  const inChart = Object.hasOwn(agents, employeeId);
  if (inChart && !rerun) return fail(`"${employeeId}" is already in the org chart; there is nothing to rehire (refusing to overwrite a live row)`);

  // ---- 1. role directory (committed in step 6) --------------------------------------------------
  let roleRestored = false;
  if (!roleDir) step({ step: "role-dir", action: "skipped", detail: "the archived row names no role directory" });
  else if (existsSync(roleDir)) { roleRestored = true; step({ step: "role-dir", action: "skipped", detail: `${roleDir} is already there` }); }
  else if (!apply) step({ step: "role-dir", action: "would", detail: existsSync(roleCopy) ? `copy ${roleCopy} -> ${roleDir}` : `check ${roleDir} out from the removal commit's parent (${removalCommit(archive) ?? "no commit recorded"})` });
  else {
    const restored = restoreRoleDir(roleDir, roleCopy, removalCommit(archive));
    roleRestored = restored.ok;
    step({ step: "role-dir", action: restored.ok ? "done" : "failed", detail: restored.detail });
  }

  // ---- 2. desk ------------------------------------------------------------------------------------
  let deskBack = existsSync(desk);
  if (deskBack) step({ step: "desk", action: "skipped", detail: `${desk} is already there` });
  else if (!existsSync(deskArchive)) step({ step: "desk", action: "next-action", detail: `no archived desk at ${deskArchive}; a fresh desk needs provisioning`, command: `flume onboard  # from ${text(record.project_path) || "the employee's repo"}` });
  else if (!apply) step({ step: "desk", action: "would", detail: `move ${deskArchive} -> ${desk}` });
  else {
    try { mkdirSync(join(fleetHome, "profiles"), { recursive: true }); renameSync(deskArchive, desk); deskBack = true; step({ step: "desk", action: "done", detail: `moved ${deskArchive} -> ${desk} (memories, sessions and stores as they were)` }); }
    catch (error) { step({ step: "desk", action: "failed", detail: firstLine(error) }); }
  }

  // ---- 3. record -----------------------------------------------------------------------------------
  if (inChart) {
    step({ step: "record", action: "skipped", detail: `${employeeId} is in the org chart (put back by the earlier rehire on record)` });
    result.applied = true;
  } else if (!apply) {
    step({ step: "record", action: "would", detail: `add the archived row to ${registryPath}, exactly as it was before the offboard` });
  } else if (result.errors.length) {
    step({ step: "record", action: "skipped", detail: "not added: a step above failed; fix it and re-run" });
  } else {
    try {
      await addRow(registryPath, employeeId, record);
      result.applied = true;
      writeFileSync(receiptPath, `# flume rehire ${employeeId}: undoes ${archive.path}\n${YAML.stringify({ employee: employeeId, rehired_at: (options.now ?? new Date()).toISOString(), reason, archive: archive.path })}`, { mode: 0o600 });
      step({ step: "record", action: "done", detail: `restored the archived row to ${registryPath} (comment-preserving; nothing else touched)` });
    } catch (error) { step({ step: "record", action: "failed", detail: firstLine(error) }); }
  }

  // ---- 4. identity ---------------------------------------------------------------------------------
  const archivedIdentity = isRow(record.company_identity) ? record.company_identity : null;
  const identityStep = stepOf(archive, "identity");
  const subject = archivedIdentity ? text(archivedIdentity.subject) : "";
  let identityOk = true;
  let staysRetired = false;
  if (!archivedIdentity) {
    step({ step: "identity", action: "skipped", detail: "never enrolled in a company identity" });
  } else if (identityStep?.action !== "done") {
    // The identity was already retired when this offboard ran: its retirement was its own decision, never lifted here.
    const tombstone = subject ? readLifecycleState().tombstones[subject] : undefined;
    staysRetired = Boolean(tombstone);
    step({ step: "identity", action: tombstone ? "next-action" : "skipped", detail: tombstone
      ? `${text(archivedIdentity.email)} was retired before this offboard (tombstone ${tombstone.retired_at}); it is not this offboard's to lift. The employee works without a company identity; a new one needs a new handle (option ii)`
      : `this offboard did not retire ${text(archivedIdentity.email) || "the identity"} (${identityStep?.detail ?? "no identity step"})`,
      ...(tombstone ? { command: `flume identity enroll ${employeeId} --as-post --apply  # needs a fresh handle: "${text(archivedIdentity.handle)}" stays tombstoned` } : {}) });
  } else if (!apply) {
    const tombstone = subject ? readLifecycleState().tombstones[subject] : undefined;
    if (!tombstone) step({ step: "identity", action: "would", detail: `${text(archivedIdentity.email)}: no tombstone to lift; flume identity restore if suspended` });
    else {
      const proven = offboardTombstoneProof(employeeId, archive.path, archive as never, tombstone);
      step(proven.ok
        ? { step: "identity", action: "would", detail: `un-retire ${text(archivedIdentity.email)}: lift the tombstone of ${tombstone.retired_at} into the unretired history (proof: ${proven.proof}), retired -> suspended, then flume identity restore (mailbox reopened, status active last)` }
        : { step: "identity", action: "failed", detail: `the tombstone cannot be lifted: ${proven.detail}` });
    }
  } else if (!result.applied) {
    identityOk = false;
    step({ step: "identity", action: "skipped", detail: "not attempted: the row is not back in the org chart" });
  } else {
    const unretire = await unretireEmployee(employeeId, { apply: true, archive: archive.path, reason }) as Record<string, any>;
    result.identity = { unretire };
    if (!unretire.ok) {
      identityOk = false;
      step({ step: "identity", action: "failed", detail: `un-retire: ${(unretire.blockers ?? []).map((b: Record<string, string>) => `${b.code}: ${b.detail}`).join("; ") || "did not finish"}`, command: `flume rehire ${employeeId} --apply` });
    } else {
      const restore = await restoreEmployee(employeeId, { apply: true }) as Record<string, any>;
      result.identity.restore = restore;
      const blockedOnlyBecauseActive = !restore.ok && (restore.blockers ?? []).some((b: Record<string, string>) => b.code === "not-suspended");
      if (!restore.ok && !blockedOnlyBecauseActive) {
        identityOk = false;
        const unresolved = (restore.steps ?? []).filter((s: Record<string, string>) => s.outcome === "unresolved").map((s: Record<string, string>) => `${s.key}: ${s.provider_code ?? ""} ${s.detail ?? ""}`.trim());
        step({ step: "identity", action: "failed", detail: `un-retired to suspended, but restore did not finish: ${[...(restore.blockers ?? []).map((b: Record<string, string>) => `${b.code}: ${b.detail}`), ...unresolved].join("; ")}`, command: `flume identity restore ${employeeId} --apply` });
      } else {
        const lifted = (unretire.steps ?? []).some((s: Record<string, string>) => s.key === "tombstone-lift" && s.outcome === "done");
        const reopened = (restore.steps ?? []).filter((s: Record<string, string>) => s.adapter === "mail" && s.outcome === "done").map((s: Record<string, string>) => s.action);
        step({ step: "identity", action: "done", detail: `${text(archivedIdentity.email)} active again${lifted ? " (tombstone moved to the unretired history, ledger recorded)" : ""}${reopened.length ? `; mailbox: ${reopened.join(", ")}` : ""}` });
        for (const item of restore.not_reversed ?? []) {
          result.inService.push(`not reversible: ${item.note}`);
        }
      }
    }
  }

  // ---- 5. gateway: the desk's own member key, when the retire revoked it ---------------------------
  const deltaRef = readRef(join(apply ? desk : (existsSync(desk) ? desk : deskArchive), "config.delta.yaml"));
  const consumer = deltaRef.exists ? consumerOf(deltaRef.ref) : undefined;
  const revoked = subject && consumer ? readLifecycleState().steps[subject]?.[`gateway:token-revoke:${consumer}`] : undefined;
  if (!consumer) step({ step: "gateway", action: "skipped", detail: "the desk maps no FLUME-39 member key of its own (it runs the fleet key, or none)" });
  else if (staysRetired) step({ step: "gateway", action: "skipped", detail: `member key ${consumer} stays revoked: the identity was retired before this offboard and stays retired` });
  else if (!revoked || !["done", "converged"].includes(revoked.status)) step({ step: "gateway", action: "skipped", detail: `member key ${consumer} was never revoked; the desk keeps it` });
  else if (!apply) step({ step: "gateway", action: "would", detail: `mint member key ${consumer} again (revoked by operation ${revoked.operation_id}) through gateway-member-tokens.py --render --apply` });
  else if (!deskBack || !identityOk) step({ step: "gateway", action: "skipped", detail: `not minted: ${!deskBack ? "the desk is not back" : "the identity is not back"}`, command: `flume rehire ${employeeId} --apply` });
  else {
    try {
      const minted = provisionMemberCredential(profile);
      step({ step: "gateway", action: "done", detail: `member key ${minted.consumer}: token ${minted.token}, delta ${minted.delta}, render ${minted.render}` });
    } catch (error) {
      step({ step: "gateway", action: "failed", detail: firstLine(error), command: `python3 ~/code/33GOD/flume/scripts/gateway-member-tokens.py --members ${profile} --render --apply` });
    }
  }

  // ---- 6. commit the role directory ------------------------------------------------------------------
  if (!roleDir) { /* nothing to commit */ }
  else if (!apply) step({ step: "commit", action: "would", detail: `path-scoped commit of ${roleDir} in its repository, then push` });
  else if (!roleRestored) step({ step: "commit", action: "skipped", detail: "the role directory is not back" });
  else step(commitRoleDir(roleDir, employeeId, reason, archive));

  // ---- 7. schedules: only the ones THIS offboard archived --------------------------------------------
  const archivedHere = archive.archived_schedules
    ?? archive.steps.filter((s) => s.step === "schedules" && s.action === "done").map((s) => /^archived candybar (\S+)/u.exec(s.detail)?.[1]).filter((name): name is string => Boolean(name)).map((name) => ({ id: name, name, enabled: false, unknown: true }));
  const before = archive.steps.filter((s) => s.step === "schedules" && s.action === "skipped" && /already archived/u.test(s.detail)).map((s) => /candybar (\S+)/u.exec(s.detail)?.[1]).filter((name): name is string => Boolean(name));
  if (!archivedHere.length) step({ step: "schedules", action: "skipped", detail: "this offboard archived no candybar" });
  for (const run of archivedHere) {
    if (!apply) { step({ step: "schedules", action: "would", detail: `unarchive candybar ${run.name}${run.enabled ? " and resume it" : ""}` }); continue; }
    const call = (verb: string) => spawnSync(candybarBin(), [verb, run.id], { encoding: "utf8", timeout: 60_000, shell: false, env: { ...process.env, NO_COLOR: "1" } });
    const out = call("unarchive");
    if (out.error || out.status !== 0) { step({ step: "schedules", action: "failed", detail: `candybar unarchive ${run.name}: ${String(out.stderr || out.error?.message || `exit ${out.status}`).trim().split("\n")[0]}`, command: `candybar unarchive ${run.name}` }); continue; }
    if (run.enabled) {
      const resumed = call("resume");
      step(resumed.error || resumed.status !== 0
        ? { step: "schedules", action: "next-action", detail: `unarchived candybar ${run.name}; resume failed`, command: `candybar resume ${run.name}` }
        : { step: "schedules", action: "done", detail: `unarchived and resumed candybar ${run.name}` });
    } else {
      step({ step: "schedules", action: "done", detail: `unarchived candybar ${run.name} (left paused${"unknown" in run ? ": this archive did not record whether it was scheduling" : ", as it was"})` });
      if ("unknown" in run) result.inService.push(`candybar ${run.name} is unarchived but paused: candybar resume ${run.name}`);
    }
  }
  for (const name of before) result.inService.push(`candybar ${name} was archived before this offboard and stays archived; to schedule it again: candybar unarchive ${name} && candybar resume ${name}`);

  // ---- 8. serve --------------------------------------------------------------------------------------
  const restartCommand = `hermes-gateway-restart --reason "rehired ${employeeId}"`;
  if (options.serve === false) step({ step: "serve", action: "skipped", detail: "--no-serve: the gateway picks the desk up at its next restart" });
  else if (!apply) step({ step: "serve", action: "would", detail: `serve profile ${profile} through the gateway control socket` });
  else if (!deskBack) step({ step: "serve", action: "skipped", detail: "no desk to serve" });
  else {
    const up = await serveProfileViaSocket(profile);
    step(up.ok ? { step: "serve", action: "done", detail: up.detail } : { step: "serve", action: "next-action", detail: `${up.detail}; the gateway serves it at its next restart`, command: restartCommand });
  }

  // ---- what it would take to put it back in service ------------------------------------------------
  const bloodbank = isRow(record.bloodbank) ? record.bloodbank : {};
  if (bloodbank.enabled === false) result.inService.push(`routing: bloodbank.enabled is false (as archived), so nothing dispatches to ${employeeId}; set it true in the row (and role.yaml) only if it should take Bloodbank work`);
  if (isRow(record.plane)) result.inService.push(`board claim restored as archived: plane ${JSON.stringify(record.plane)}; check it does not take tickets another PM owns (flume retire --help shows the routing report)`);
  else result.inService.push("no Plane board claim (as archived): it takes no tickets from any board's router");
  for (const platform of ["telegram", "slack"] as const) {
    const block = isRow(record[platform]) ? record[platform] as Row : null;
    if (!block) continue;
    const status = text(block.provisioning_status);
    const bot = text(block.bot_username);
    // Slack is opt-in: a block that never held a bot is not a channel this employee lost.
    if (platform === "slack" && !text(block.bot_id) && !text(block.team_id)) continue;
    if (["deferred", "offline", "retired", "disabled", ""].includes(status)) {
      result.inService.push(platform === "telegram"
        ? `telegram: ${status || "not provisioned"}${bot ? ` (@${bot})` : ""}. A bot only its owner can create in @BotFather${bot ? ` (/newbot, username ${bot})` : ""}; vault its token, then: flume channel online ${employeeId} --platform telegram --credential-ref op://DeLoSecrets/<item-uuid>/credential --apply`
        : `slack: ${status || "not provisioned"}; flume channel online ${employeeId} --platform slack --credential-ref op://... --app-token-ref op://... --apply`);
    }
  }
  if (archivedIdentity && apply && result.applied) {
    try {
      const fresh = (YAML.parse(readFileSync(registryPath, "utf8")) as { agents?: Record<string, unknown> }).agents?.[employeeId];
      if (isRow(fresh)) for (const line of lifecycleDrift(fresh, rowLifecycle(employeeId, fresh, fleetHome))) result.inService.push(`registry projection: ${line} (flume remediate hermes.registry-parity)`);
    } catch { /* the projection is a report, never a reason to fail */ }
  }
  if (apply && result.applied) {
    try { writeFileSync(receiptPath, `# flume rehire ${employeeId}: undoes ${archive.path}\n${YAML.stringify({ employee: employeeId, rehired_at: (options.now ?? new Date()).toISOString(), reason, archive: archive.path, steps: result.steps })}`, { mode: 0o600 }); }
    catch { /* the receipt is history, the rehire already happened */ }
  }

  result.ok = result.errors.length === 0;
  return result;
}

const MARK: Record<RehireAction, string> = { done: "✓", would: "·", skipped: "-", failed: "✗", "next-action": "!" };

export function formatRehireResult(result: RehireResult): string {
  const lines: string[] = [];
  const preview = !result.steps.some((s) => s.action === "done" && s.step !== "archive") && !result.steps.some((s) => s.action === "failed") && !result.applied;
  lines.push(!result.archive ? `✗ rehire ${result.employeeId} failed`
    : !result.ok ? `✗ rehire ${result.employeeId}: not finished`
    : preview ? `would rehire ${result.employeeId} (dry run; pass --apply)`
    : `✓ ${result.employeeId} rehired: back in the org chart`);
  lines.push(`    ${result.registryPath}`);
  for (const s of result.steps) lines.push(`  ${MARK[s.action]} ${s.step.padEnd(9)} ${s.detail}`);
  for (const error of result.errors) if (!result.steps.some((s) => `${s.step}: ${s.detail}` === error)) lines.push(`  ✗ ${error}`);
  if (result.nextActions.length) {
    lines.push("", "  Next:");
    for (const action of result.nextActions) lines.push(`    · ${action}`);
  }
  if (result.inService.length) {
    lines.push("", "  To put it back in service (not done here):");
    for (const item of result.inService) lines.push(`    · ${item}`);
  }
  return lines.join("\n");
}
