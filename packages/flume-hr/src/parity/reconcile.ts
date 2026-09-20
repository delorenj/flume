/**
 * Fleet reconciliation: the roster's findings, as repairs.
 *
 * WHY THIS IS A SECOND RECIPE, AND NOT MORE CHECKS ON `hire`.
 *
 * Every check in `createHermesChecks()` opens with `discoverRoles(ctx.repoRoot)`
 * and is therefore about ONE repository -- correctly, because hiring is a thing
 * that happens to a repository. The findings `flume roster` reports are not:
 * fifteen of twenty-four agents live in fifteen different repositories, and the
 * two registries they disagree with are shared machine state under `~/.hermes`
 * and the project-registry service. A rule that can only see one repo can never
 * answer for them, which is exactly why every one of those findings arrived as a
 * bare string code with no rule id, no `fixable`, and no next action.
 *
 * So: one recipe whose checks read the FLEET -- the same read `flume roster`
 * does, through `collectFleetInventory`, so the two can never disagree about
 * what is wrong. `org/inventory.ts` owns the codes and `FINDING_RULE_IDS`
 * owns the code -> rule mapping; this module owns what to DO about each one.
 *
 * WHAT IS AND IS NOT MECHANICAL, and the line is drawn on purpose:
 *
 *   org.board-projection   the one cross-store write the handbook sanctions
 *                          (`pj project identity --apply`). Flume never writes
 *                          `agents.{agent_id}.plane.*` itself -- the handbook
 *                          assigns those three fields to `project-registry`.
 *   org.profile-path       real path repairs: create a missing profile
 *                          directory, materialise a symlinked one.
 *   org.runtime-path       create the missing role-local runtime directory.
 *   org.project-records    the WRITE is mechanical; "should this directory be
 *                          a registered project?" is a human decision, so it
 *                          needs an explicit opt-in and otherwise reports
 *                          exactly what it would register.
 *   org.identity-conflict  never automatic. No tool can decide which of two
 *                          agents owns a repository. It reports the two real
 *                          resolutions and stops.
 *
 * RESTRAINT IS INHERITED, not re-argued. `hermes.registry-parity` refuses to
 * prune unprovisioned rows ("report, never delete"); nothing here deletes a
 * registry row, a project record, or a directory it did not create. The one
 * destructive-looking act -- replacing a symlinked profile directory with a real
 * one -- COPIES from the link target and leaves the target untouched.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import YAML from "yaml";

import { Recipe } from "../engine/Recipe";
import type {
  LifecycleAuditFinding,
  LifecycleContext,
  LifecycleMigrationResult,
  RecipeCheck,
  RecipeInitResult,
  RecipeMetadata,
} from "../engine/types";
import { loadFleetContract, resolveFleetContractPath, validateFleetContract } from "../org/contract";
import { collectFleetInventory, resolveInventoryStores, resolveProfileLayout } from "../org/inventory";
import type { FleetInventory, FleetInventoryFinding } from "../org/types";

/**
 * The rules an operator may ask this recipe to RUN.
 *
 * `org.identity-conflict` is deliberately absent: its migration exists only to
 * say what the two resolutions are, and advertising it as remediable would put
 * `flume remediate` in front of a decision no command can make. `org/status.ts`
 * reads this to decide whether an inventory observation gets an `automatic`
 * repair class, so the set is the single answer to "can a command fix this?".
 */
export const ORG_REMEDIABLE_RULES: ReadonlySet<string> = new Set([
  "org.board-projection",
  "org.profile-path",
  "org.runtime-path",
  "org.project-records",
]);

/**
 * The opt-in that lets `org.project-records` create project records.
 *
 * An environment key rather than a `LifecycleContext` field because the context
 * is the engine's shape and every recipe shares it; this gate belongs to one
 * rule. `flume remediate --register-projects` sets it for the process, and
 * nothing else in the codebase reads it.
 */
export const REGISTER_PROJECTS_ENV = "FLUME_REGISTER_PROJECTS";

/** Walk caps for materialising a symlinked profile. A profile is MBs, not GBs. */
const MAX_MATERIALIZE_ENTRIES = 50_000;
const MAX_MATERIALIZE_BYTES = 512 * 1024 * 1024;

/** How long a `pj` probe may take before this rule gives up and says so. */
const PJ_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// The fleet read
// ---------------------------------------------------------------------------

interface FleetSnapshot {
  inventory: FleetInventory | null;
  /** Why the fleet could not be read. Null when it was. */
  unreadable: string | null;
  /** Raw, UNREDACTED registry rows. `row.paths.*` is display-redacted and cannot be opened. */
  rows: Map<string, Record<string, unknown>>;
  agentRegistryPath: string;
  projectRegistry: string;
  /** `<fleet home>/profiles/{profile_name}`, contract-derived. Null when the contract declares none. */
  profileTemplate: string | null;
  home: string;
}

/**
 * One fleet read per audit pass, invalidated around every migration.
 *
 * `RecipeRegistry.verifyMigration` re-audits every applied rule to prove it
 * converged, and `migrateAll` re-audits the non-fixable ones after the fixable
 * ones have run. A snapshot that survived a migration would make both of those
 * re-reads answer from BEFORE the write -- a migration that changed nothing
 * would verify green. So every `migrate` in this module clears it on the way in
 * and on the way out.
 */
let snapshot: { key: string; value: FleetSnapshot } | null = null;

export function invalidateFleetSnapshot(): void {
  snapshot = null;
}

function snapshotKey(ctx: LifecycleContext): string {
  return `${ctx.homeDir ?? homedir()}\u0000${ctx.registryPath ?? ""}`;
}

function readFleet(ctx: LifecycleContext): FleetSnapshot {
  const key = snapshotKey(ctx);
  if (snapshot && snapshot.key === key) return snapshot.value;
  const value = readFleetUncached(ctx);
  snapshot = { key, value };
  return value;
}

/**
 * Read both registries, and CATEGORISE a failure rather than throwing it.
 *
 * Same shape as `kernel/project-contract.ts`'s `probeProjectContracts`: a fleet
 * rule that throws because the project-registry service is down turns every
 * `flume audit` on the machine into a stack trace, in a repository that has
 * nothing to do with the outage. An unread fleet is reported as unread.
 */
function readFleetUncached(ctx: LifecycleContext): FleetSnapshot {
  const home = ctx.homeDir ?? homedir();
  const options = { home, ...(ctx.registryPath ? { projectRegistry: ctx.registryPath } : {}) };
  const base: FleetSnapshot = {
    inventory: null,
    unreadable: null,
    rows: new Map(),
    agentRegistryPath: join(home, ".hermes", "agents-registry.yaml"),
    projectRegistry: ctx.registryPath ?? "",
    profileTemplate: null,
    home,
  };

  let stores;
  try {
    stores = resolveInventoryStores(options);
    base.agentRegistryPath = stores.agents.inspectedPath;
    base.projectRegistry = stores.projects.inspectedPath;
  } catch (err) {
    return { ...base, unreadable: `the fleet registries could not be located: ${message(err)}` };
  }

  try {
    const contractPath = resolveFleetContractPath();
    const validation = validateFleetContract(loadFleetContract(contractPath).document);
    if (validation.contract) {
      base.profileTemplate = resolveProfileLayout(validation.contract, process.env, home).template;
    }
  } catch {
    // A contract this run could not read costs the profile path template and
    // nothing else; `collectFleetInventory` reports the contract itself.
    base.profileTemplate = null;
  }

  try {
    base.rows = readRawAgentRows(stores.agents.inspectedPath);
  } catch (err) {
    return { ...base, unreadable: `the agent registry could not be parsed: ${message(err)}` };
  }

  try {
    base.inventory = collectFleetInventory({ ...options, rowCap: Infinity });
  } catch (err) {
    return { ...base, unreadable: `the fleet inventory could not be collected: ${message(err)}` };
  }
  return base;
}

/**
 * The registry rows as WRITTEN, for the repairs that touch the filesystem.
 *
 * `FleetInventoryRow` carries every path home-redacted and length-bounded,
 * because it is a report. Opening `~/.hermes/profiles/x` fails, and re-expanding
 * a redacted value is a guess. So the report says WHICH rows are wrong and this
 * says what their values actually are.
 */
function readRawAgentRows(path: string): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  if (!existsSync(path)) return rows;
  const parsed: unknown = YAML.parse(readFileSync(path, "utf8"));
  const agents = isRecord(parsed) ? parsed.agents : undefined;
  if (!isRecord(agents)) return rows;
  for (const [id, value] of Object.entries(agents)) {
    if (isRecord(value)) rows.set(id, value);
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The inventory appends `; repair: flume remediate <id> --dry-run` to every
 * finding it raises, because a roster line is read on its own. A rule quoting
 * that finding under its OWN heading is not read on its own -- the id is two
 * inches up the page -- so the hint is stripped here rather than printed twice.
 */
const REPAIR_HINT = /;\s*repair: flume remediate \S+ --dry-run$/u;

function plainly(detail: string): string {
  return detail.replace(REPAIR_HINT, "");
}

function findingsFor(fleet: FleetSnapshot, codes: readonly string[]): FleetInventoryFinding[] {
  const wanted = new Set(codes);
  return (fleet.inventory?.findings ?? []).filter((finding) => wanted.has(finding.code) && finding.severity !== "info");
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** "This run could not read the fleet" -- reported, never thrown, never a pass. */
function unableToAssess(check: { id: string; title: string }, reason: string): LifecycleAuditFinding {
  return {
    id: check.id,
    title: check.title,
    status: "warn",
    summary: "the fleet could not be assessed",
    details: [reason, "nothing is claimed about the fleet on this run; re-run once the registries can be read"],
    fixable: false,
  };
}

function passing(check: { id: string; title: string }, summary: string): LifecycleAuditFinding {
  return { id: check.id, title: check.title, status: "pass", summary, details: [], fixable: false };
}

interface Outcome {
  details: string[];
  blockers: string[];
  changed: string[];
}

function outcome(): Outcome {
  return { details: [], blockers: [], changed: [] };
}

function settle(
  finding: LifecycleAuditFinding,
  result: Outcome,
  dryRun: boolean,
  summaries: { applied: string; planned: string; noop: string; blocked: string },
): LifecycleMigrationResult {
  const status = result.blockers.length
    ? "blocked"
    : result.changed.length
      ? (dryRun ? "skipped" : "applied")
      : "noop";
  return {
    id: finding.id,
    title: finding.title,
    status,
    summary: status === "blocked"
      ? summaries.blocked
      : status === "noop"
        ? summaries.noop
        : dryRun ? summaries.planned : summaries.applied,
    changedFiles: [...new Set(result.changed)],
    details: [...result.details, ...result.blockers.map((blocker) => `blocked: ${blocker}`)],
  };
}

function blocked(finding: LifecycleAuditFinding, summary: string, details: string[]): LifecycleMigrationResult {
  return { id: finding.id, title: finding.title, status: "blocked", summary, changedFiles: [], details };
}

// ---------------------------------------------------------------------------
// `pj`, the only writer of the fields it owns
// ---------------------------------------------------------------------------

interface PjResult {
  ok: boolean;
  /** Parsed stdout, when the invocation produced JSON. */
  json: Record<string, unknown> | null;
  detail: string;
}

function runPj(args: string[]): PjResult {
  const bin = process.env.PJANGLER_BIN?.trim() || "pj";
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: PJ_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status === null) {
    return { ok: false, json: null, detail: `\`${bin} ${args.join(" ")}\` could not run: ${result.error?.message ?? "no exit status"}` };
  }
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    json = isRecord(parsed) ? parsed : null;
  } catch {
    json = null;
  }
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-2).join(" ");
    return { ok: false, json, detail: `\`${bin} ${args.join(" ")}\` exited ${result.status}: ${tail || "no output"}` };
  }
  return { ok: true, json, detail: `\`${bin} ${args.join(" ")}\` exited 0` };
}

/** `--registry` is threaded so a run pointed at a fixture stays pointed at it. */
function registryArgs(ctx: LifecycleContext): string[] {
  return ctx.registryPath ? ["--registry", ctx.registryPath] : [];
}

// ---------------------------------------------------------------------------
// org.board-projection
// ---------------------------------------------------------------------------

const BOARD_PROJECTION: RecipeCheck = {
  id: "org.board-projection",
  title: "Agent rows carry the board identity their repository's manifest declares",
  // The two registries and the board, none of which live in the audited repo.
  scope: "host",
  audit: (ctx) => {
    const fleet = readFleet(ctx);
    if (fleet.unreadable) return unableToAssess(BOARD_PROJECTION, fleet.unreadable);
    const findings = findingsFor(fleet, ["manifest-disagrees"]);
    if (!findings.length) return passing(BOARD_PROJECTION, "every agent row agrees with its repository's manifest");
    return {
      id: BOARD_PROJECTION.id,
      title: BOARD_PROJECTION.title,
      status: "warn",
      summary: `${findings.length} agent row(s) disagree with their repository manifest`,
      details: findings.map((finding) => `${finding.agent_id ?? "?"}: ${plainly(finding.detail)}`),
      fixable: true,
    };
  },
  migrate: (ctx, finding) => {
    invalidateFleetSnapshot();
    try {
      const fleet = readFleet(ctx);
      if (fleet.unreadable) return blocked(finding, "the fleet could not be read", [fleet.unreadable]);
      const findings = findingsFor(fleet, ["manifest-disagrees"]);
      if (!findings.length) return { id: finding.id, title: finding.title, status: "noop", summary: "No changes required", changedFiles: [], details: [] };
      const affected = new Set(findings.map((item) => item.agent_id).filter((id): id is string => Boolean(id)));

      // ALWAYS probe first, even on an apply. `pj project identity` is the only
      // sanctioned writer of `agents.{agent_id}.plane.*` (handbook:
      // `board_identity_projection`, owner project-registry), and its dry run is
      // the only way to learn whether it would move THESE rows. Applying blind
      // and reporting success is precisely what `verifyMigration` catches --
      // and `blocked` with the real reason is more use than a green line
      // followed by a red audit.
      const probe = runPj(["project", "identity", "--all", "--json", ...registryArgs(ctx)]);
      if (!probe.ok || !probe.json) {
        return blocked(finding, "the board-identity projection could not be probed", [
          probe.detail,
          "pjangler owns these fields; without it the projection cannot run at all",
          ...[...affected].map((id) => `${id}: still disagreeing, unassessed`),
        ]);
      }
      const changes = isRecord(probe.json.changes) ? probe.json.changes : {};
      const hermesChanges = Array.isArray(changes.hermes) ? changes.hermes : [];
      const planned = new Map<string, string[]>();
      for (const change of hermesChanges) {
        if (!isRecord(change)) continue;
        const agentId = text(change.agentId);
        if (!agentId || !affected.has(agentId)) continue;
        const list = planned.get(agentId) ?? [];
        list.push(`${text(change.field) ?? "?"}: ${text(change.from) ?? "''"} -> ${text(change.to) ?? "''"}`);
        planned.set(agentId, list);
      }

      if (planned.size === 0) {
        // The honest reading, and it took a live probe to get it: the agent row
        // and the board it names already agree, so the projection has nothing
        // to copy. What disagrees is the REPOSITORY's manifest, which names a
        // different board -- and no tool may pick a winner between "the agent
        // is on the wrong board" and "the manifest is stale".
        return blocked(finding, "the projection converges none of these rows", [
          "`pj project identity --all` reports no change for any disagreeing agent: each row's recorded board already reports the identity it stores, so the projection has nothing to copy",
          ...findings.map((item) => `${item.agent_id ?? "?"}: ${plainly(item.detail)}`),
          "resolve each one by deciding which side is right, then:",
          "  (a) re-bind the agent to the board its project record names -- `pj project link <project-id> <board-id> --apply`, or",
          "  (b) correct `ticket_provider` in that repository's .project.json to name the board the agent uses, then re-run this rule",
        ]);
      }

      const plan = [...planned.entries()].map(([agentId, lines]) => `${agentId}: ${lines.join("; ")}`);
      if (ctx.dryRun) {
        return {
          id: finding.id,
          title: finding.title,
          status: "skipped",
          summary: `Planned board-identity projection for ${planned.size} agent(s)`,
          changedFiles: [fleet.agentRegistryPath],
          details: [
            ...plan,
            `apply with \`pj project identity --all --apply\` (it reconciles every agent, not only these ${planned.size})`,
            ...findings.filter((item) => !planned.has(item.agent_id ?? "")).map((item) => `${item.agent_id ?? "?"}: NOT converged by the projection -- ${plainly(item.detail)}`),
          ],
        };
      }

      const applied = runPj(["project", "identity", "--all", "--apply", "--json", ...registryArgs(ctx)]);
      if (!applied.ok) return blocked(finding, "the board-identity projection failed", [applied.detail, ...plan]);
      return {
        id: finding.id,
        title: finding.title,
        status: "applied",
        summary: `Projected board identity onto ${planned.size} agent row(s)`,
        changedFiles: [fleet.agentRegistryPath],
        details: plan,
      };
    } finally {
      invalidateFleetSnapshot();
    }
  },
};

// ---------------------------------------------------------------------------
// org.profile-path
// ---------------------------------------------------------------------------

type ProfileRepair =
  | { kind: "create"; agentId: string; path: string }
  | { kind: "materialize"; agentId: string; path: string; target: string }
  | { kind: "blocked"; agentId: string; reason: string };

function profilePathFor(fleet: FleetSnapshot, agentId: string): string | null {
  const row = fleet.rows.get(agentId);
  const profileName = row ? text(row.profile_name) : null;
  if (!profileName || !fleet.profileTemplate) return null;
  // The same safety the inventory applies before deriving any path from a
  // registry value: a name that is not one path segment derives nothing.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(profileName)) return null;
  return fleet.profileTemplate.replaceAll("{profile_name}", profileName);
}

function planProfileRepairs(fleet: FleetSnapshot): ProfileRepair[] {
  const plans: ProfileRepair[] = [];
  for (const finding of findingsFor(fleet, ["profile-path-symlinked", "profile-path-unusable"])) {
    const agentId = finding.agent_id ?? "?";
    const path = finding.agent_id ? profilePathFor(fleet, finding.agent_id) : null;
    if (!path) {
      plans.push({ kind: "blocked", agentId, reason: `${agentId}: no usable profile path can be derived from the row (${plainly(finding.detail)}); correct agents.${agentId}.profile_name, or the contract's service_model.profile_layout` });
      continue;
    }
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      plans.push({ kind: "create", agentId, path });
      continue;
    }
    if (stat.isSymbolicLink()) {
      let target: string | null = null;
      try { target = realpathSync(path); } catch { target = null; }
      if (!target || !existsSync(target) || !statSync(target).isDirectory()) {
        plans.push({ kind: "blocked", agentId, reason: `${agentId}: ${path} is a symlink to ${target ?? "an unreadable target"}, which is not a directory this run can copy; repoint or remove the link by hand` });
        continue;
      }
      plans.push({ kind: "materialize", agentId, path, target });
      continue;
    }
    if (!stat.isDirectory()) {
      plans.push({ kind: "blocked", agentId, reason: `${agentId}: ${path} exists and is not a directory; this rule never deletes a file it did not create` });
      continue;
    }
    plans.push({ kind: "blocked", agentId, reason: `${agentId}: ${path} is already a real directory, yet the inventory still reports ${finding.code} (${plainly(finding.detail)})` });
  }
  return plans;
}

/** Refuse a copy whose size this rule has no business moving silently. */
function measureTree(root: string): { entries: number; bytes: number; overCap: boolean } {
  let entries = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let children;
    try {
      children = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      entries += 1;
      if (entries > MAX_MATERIALIZE_ENTRIES) return { entries, bytes, overCap: true };
      const path = join(current, child.name);
      if (child.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (child.isSymbolicLink()) continue;
      try {
        bytes += statSync(path).size;
      } catch {
        continue;
      }
      if (bytes > MAX_MATERIALIZE_BYTES) return { entries, bytes, overCap: true };
    }
  }
  return { entries, bytes, overCap: false };
}

const PROFILE_PATH: RecipeCheck = {
  id: "org.profile-path",
  title: "Every agent's profile directory is a real directory under the fleet profile root",
  scope: "host",
  audit: (ctx) => {
    const fleet = readFleet(ctx);
    if (fleet.unreadable) return unableToAssess(PROFILE_PATH, fleet.unreadable);
    const plans = planProfileRepairs(fleet);
    if (!plans.length) return passing(PROFILE_PATH, "every declared profile directory is a real directory");
    const repairable = plans.filter((plan) => plan.kind !== "blocked");
    const symlinked = plans.some((plan) => plan.kind === "materialize");
    return {
      id: PROFILE_PATH.id,
      title: PROFILE_PATH.title,
      // A symlinked profile root is the case the contract forbids outright
      // (`service_model.profile_layout.symlink_allowed: false`); an absent one
      // is a gap. They are not the same severity and are not reported as one.
      status: symlinked ? "fail" : "warn",
      summary: `${plans.length} profile director(ies) are not real directories under the fleet profile root`,
      details: plans.map((plan) => plan.kind === "blocked"
        ? plan.reason
        : plan.kind === "create"
          ? `${plan.agentId}: ${plan.path} is missing`
          : `${plan.agentId}: ${plan.path} is a symlink to ${plan.target}`),
      fixable: repairable.length > 0,
    };
  },
  migrate: (ctx, finding) => {
    invalidateFleetSnapshot();
    try {
      const fleet = readFleet(ctx);
      if (fleet.unreadable) return blocked(finding, "the fleet could not be read", [fleet.unreadable]);
      const plans = planProfileRepairs(fleet);
      const result = outcome();
      for (const plan of plans) {
        if (plan.kind === "blocked") {
          result.blockers.push(plan.reason);
          continue;
        }
        if (plan.kind === "create") {
          result.details.push(`create profile directory ${plan.path}`);
          result.changed.push(plan.path);
          if (!ctx.dryRun) mkdirSync(plan.path, { recursive: true });
          continue;
        }
        const size = measureTree(plan.target);
        if (size.overCap) {
          result.blockers.push(`${plan.agentId}: ${plan.target} exceeds this rule's copy budget (${size.entries} entries / ${size.bytes} bytes); move it into ${plan.path} yourself, then re-run`);
          continue;
        }
        result.details.push(`materialize ${plan.path}: copy ${size.entries} entr(ies) from ${plan.target}, then replace the symlink (the link target is left in place, untouched)`);
        result.changed.push(plan.path);
        if (ctx.dryRun) continue;
        // Copy to a sibling first, so a failed copy never leaves the profile
        // path as neither a link nor a directory.
        const staging = `${plan.path}.materializing`;
        try {
          rmSync(staging, { recursive: true, force: true });
          cpSync(plan.target, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
          unlinkSync(plan.path);
          renameSync(staging, plan.path);
        } catch (err) {
          rmSync(staging, { recursive: true, force: true });
          result.blockers.push(`${plan.agentId}: ${plan.path} could not be materialized: ${message(err)}`);
        }
      }
      return settle(finding, result, Boolean(ctx.dryRun), {
        applied: "Profile directories materialized",
        planned: "Planned profile-directory repairs",
        noop: "No changes required",
        blocked: "Profile-directory repair blocked",
      });
    } finally {
      invalidateFleetSnapshot();
    }
  },
};

// ---------------------------------------------------------------------------
// org.runtime-path
// ---------------------------------------------------------------------------

type RuntimeRepair =
  | { kind: "create"; agentId: string; path: string }
  | { kind: "blocked"; agentId: string; reason: string };

function planRuntimeRepairs(fleet: FleetSnapshot): RuntimeRepair[] {
  const plans: RuntimeRepair[] = [];
  for (const finding of findingsFor(fleet, ["runtime-path-unusable", "role-dir-unusable"])) {
    const agentId = finding.agent_id ?? "?";
    const row = finding.agent_id ? fleet.rows.get(finding.agent_id) : undefined;
    const roleDir = row ? text(row.role_dir) : null;
    if (!roleDir || !isAbsolute(roleDir)) {
      plans.push({ kind: "blocked", agentId, reason: `${agentId}: role_dir is ${roleDir ? "not absolute" : "undeclared"} (${plainly(finding.detail)}); correct agents.${agentId}.role_dir in the agent registry` });
      continue;
    }
    if (!existsSync(roleDir) || !statSync(roleDir).isDirectory()) {
      // A role directory is a PROVISIONED thing: role.yaml, the launcher, the
      // scaffold. Creating an empty one would manufacture an employee who was
      // never hired, and `hermes.registry-parity` already refuses the mirror
      // image of this (it reports an unprovisioned role rather than pruning it).
      plans.push({
        kind: "blocked",
        agentId,
        reason: `${agentId}: ${roleDir} is not a directory, and this rule never fabricates a role directory; either provision the role (\`flume onboard <role>\` in that repository) or correct agents.${agentId}.role_dir`,
      });
      continue;
    }
    // A ROLE DIRECTORY, proven, not assumed.
    //
    // `role_dir + "/runtime"` is the template's convention, and it is only
    // meaningful when `role_dir` really is a provisioned role directory --
    // `discoverRoles` identifies one by its `role.yaml` and nothing else.
    // Measured on the live org: `dumply`'s `role_dir` is its PROFILE directory
    // (`~/.hermes/profiles/dumply`), so a rule that took the derivation at face
    // value would have created runtime bytes inside a profile and reported it
    // as a repair, leaving the wrong `role_dir` exactly as wrong as it was.
    if (!existsSync(join(roleDir, "role.yaml"))) {
      plans.push({
        kind: "blocked",
        agentId,
        reason: `${agentId}: ${roleDir} carries no role.yaml, so it is not a provisioned role directory and no runtime directory belongs inside it; either provision the role there (\`flume onboard <role>\`) or point agents.${agentId}.role_dir at the real one`,
      });
      continue;
    }
    const runtime = join(roleDir, "runtime");
    let stat;
    try {
      stat = lstatSync(runtime);
    } catch {
      plans.push({ kind: "create", agentId, path: runtime });
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      plans.push({ kind: "blocked", agentId, reason: `${agentId}: ${runtime} is already a real directory, yet the inventory still reports ${finding.code}` });
      continue;
    }
    plans.push({ kind: "blocked", agentId, reason: `${agentId}: ${runtime} exists and is ${stat.isSymbolicLink() ? "a symlink" : "not a directory"}; this rule never replaces what it did not create` });
  }
  return plans;
}

const RUNTIME_PATH: RecipeCheck = {
  id: "org.runtime-path",
  title: "Every agent's role-local runtime directory exists",
  scope: "host",
  audit: (ctx) => {
    const fleet = readFleet(ctx);
    if (fleet.unreadable) return unableToAssess(RUNTIME_PATH, fleet.unreadable);
    const plans = planRuntimeRepairs(fleet);
    if (!plans.length) return passing(RUNTIME_PATH, "every declared role directory carries a real runtime directory");
    return {
      id: RUNTIME_PATH.id,
      title: RUNTIME_PATH.title,
      status: "warn",
      summary: `${plans.length} role/runtime path(s) are unusable`,
      details: plans.map((plan) => plan.kind === "blocked" ? plan.reason : `${plan.agentId}: ${plan.path} is missing`),
      fixable: plans.some((plan) => plan.kind === "create"),
    };
  },
  migrate: (ctx, finding) => {
    invalidateFleetSnapshot();
    try {
      const fleet = readFleet(ctx);
      if (fleet.unreadable) return blocked(finding, "the fleet could not be read", [fleet.unreadable]);
      const result = outcome();
      for (const plan of planRuntimeRepairs(fleet)) {
        if (plan.kind === "blocked") {
          result.blockers.push(plan.reason);
          continue;
        }
        result.details.push(`create runtime directory ${plan.path}`);
        result.changed.push(plan.path);
        if (!ctx.dryRun) mkdirSync(plan.path, { recursive: true });
      }
      return settle(finding, result, Boolean(ctx.dryRun), {
        applied: "Runtime directories created",
        planned: "Planned runtime-directory creation",
        noop: "No changes required",
        blocked: "Runtime-directory repair blocked",
      });
    } finally {
      invalidateFleetSnapshot();
    }
  },
};

// ---------------------------------------------------------------------------
// org.project-records
// ---------------------------------------------------------------------------

interface Registration {
  agentId: string;
  repoPath: string | null;
  slug: string | null;
  reason: string | null;
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/u;

function planRegistrations(fleet: FleetSnapshot): Registration[] {
  const plans: Registration[] = [];
  for (const finding of findingsFor(fleet, ["project-record-missing"])) {
    const agentId = finding.agent_id ?? "?";
    const row = finding.agent_id ? fleet.rows.get(finding.agent_id) : undefined;
    const repoPath = row ? text(row.project_path) : null;
    const slugSource = row ? text(row.repo) : null;
    const slug = slugSource ? slugSource.toLowerCase() : null;
    if (!repoPath || !isAbsolute(repoPath)) {
      plans.push({ agentId, repoPath, slug, reason: `project_path is ${repoPath ? "not absolute" : "undeclared"}, so there is no directory to register` });
      continue;
    }
    if (!existsSync(repoPath)) {
      plans.push({ agentId, repoPath, slug, reason: `${repoPath} does not exist` });
      continue;
    }
    if (!slug || !PROJECT_ID.test(slug) || slug.endsWith("-")) {
      plans.push({ agentId, repoPath, slug, reason: `agents.${agentId}.repo is not a usable project id${slug ? ` (${slug})` : ""}` });
      continue;
    }
    plans.push({ agentId, repoPath, slug, reason: null });
  }
  return plans;
}

function registrationCommand(plan: Registration, apply: boolean, ctx: LifecycleContext): string[] {
  return [
    "project", "init",
    "--target-dir", plan.repoPath!,
    "--id", plan.slug!,
    // A board is a second decision with a second cost: `pj project init` creates
    // one by default. Registering the record must not silently open a ticket
    // board for fourteen repositories.
    "--skip-board",
    // NON-INTERACTIVE, both of them. `pj project init` prompts by default, and a
    // migration that stops on a TUI prompt is a hang with no operator in front
    // of it -- `flume remediate` is run from cron and from a sibling agent.
    "--no-tui", "--yes",
    apply ? "--apply" : "--dry-run",
    "--json",
    ...registryArgs(ctx),
  ];
}

const PROJECT_RECORDS: RecipeCheck = {
  id: "org.project-records",
  title: "Every agent's repository is a registered project",
  scope: "host",
  audit: (ctx) => {
    const fleet = readFleet(ctx);
    if (fleet.unreadable) return unableToAssess(PROJECT_RECORDS, fleet.unreadable);
    const plans = planRegistrations(fleet);
    if (!plans.length) return passing(PROJECT_RECORDS, "every agent correlates to a project record");
    return {
      id: PROJECT_RECORDS.id,
      title: PROJECT_RECORDS.title,
      status: "warn",
      summary: `${plans.length} agent(s) have no project record`,
      details: [
        ...plans.map((plan) => plan.reason
          ? `${plan.agentId}: ${plan.reason}`
          : `${plan.agentId}: ${plan.repoPath} would be registered as project "${plan.slug}"`),
        `registering a directory as a project is an operator decision -- \`pj project init\` writes .project.json AND renders the CommonProject scaffold into the repository -- so it needs \`flume remediate ${PROJECT_RECORDS.id} --register-projects\` to authorize it`,
      ],
      fixable: true,
    };
  },
  migrate: (ctx, finding) => {
    invalidateFleetSnapshot();
    try {
      const fleet = readFleet(ctx);
      if (fleet.unreadable) return blocked(finding, "the fleet could not be read", [fleet.unreadable]);
      const plans = planRegistrations(fleet);
      if (!plans.length) return { id: finding.id, title: finding.title, status: "noop", summary: "No changes required", changedFiles: [], details: [] };

      const registrable = plans.filter((plan) => plan.reason === null);
      const preview = plans.map((plan) => plan.reason
        ? `${plan.agentId}: NOT registrable -- ${plan.reason}`
        : `${plan.agentId}: pj ${registrationCommand(plan, true, ctx).join(" ")}`);

      // THE GATE. "Is this directory a project?" is not a question a registry
      // walk can answer -- fourteen of these are somebody's checkout, a docker
      // stack and a dotfiles repo. And the write is not small: `pj project init`
      // writes `.project.json` and RENDERS the CommonProject scaffold into the
      // target. The migration exists so the answer is one command away, not so
      // it is taken on the operator's behalf.
      if (process.env[REGISTER_PROJECTS_ENV] !== "1") {
        return blocked(finding, "Project registration needs an explicit opt-in", [
          ...preview,
          `${registrable.length} of ${plans.length} would be registered; each runs \`pj project init\`, which also renders the CommonProject scaffold into that repository`,
          `re-run with \`flume remediate ${finding.id} --register-projects --dry-run\` to see pjangler's own plan for each one, then drop --dry-run to apply`,
        ]);
      }

      const result = outcome();
      for (const plan of plans) {
        if (plan.reason !== null) {
          result.blockers.push(`${plan.agentId}: ${plan.reason}`);
          continue;
        }
        const args = registrationCommand(plan, !ctx.dryRun, ctx);
        const run = runPj(args);
        if (!run.ok) {
          result.blockers.push(`${plan.agentId}: ${run.detail}`);
          continue;
        }
        result.details.push(`${plan.agentId}: ${ctx.dryRun ? "planned" : "registered"} project "${plan.slug}" at ${plan.repoPath}`);
        result.changed.push(join(plan.repoPath!, ".project.json"));
      }
      return settle(finding, result, Boolean(ctx.dryRun), {
        applied: "Project records created",
        planned: "Planned project-record creation",
        noop: "No changes required",
        blocked: "Project-record creation blocked",
      });
    } finally {
      invalidateFleetSnapshot();
    }
  },
};

// ---------------------------------------------------------------------------
// org.identity-conflict
// ---------------------------------------------------------------------------

const CONFLICT_RESOLUTIONS = [
  "resolve each group one of two ways, and only an operator can choose:",
  "  (a) rule it intentional -- add the group to `classifications.intentionally_unmanaged.entries[]` in contracts/handbook.yaml, which makes it a permitted conflict rather than a silent one, or",
  "  (b) change one claimant so the value is claimed once -- repoint the row/record, or retire the one that is abandoned",
];

const IDENTITY_CONFLICT: RecipeCheck = {
  id: "org.identity-conflict",
  title: "No two rows claim one identity (repo, board, identifier, unit name)",
  scope: "host",
  audit: (ctx) => {
    const fleet = readFleet(ctx);
    if (fleet.unreadable) return unableToAssess(IDENTITY_CONFLICT, fleet.unreadable);
    const groups = (fleet.inventory?.conflicts ?? []).filter((group) => !group.permitted);
    if (!groups.length) return passing(IDENTITY_CONFLICT, "no unpermitted identity conflicts");
    return {
      id: IDENTITY_CONFLICT.id,
      title: IDENTITY_CONFLICT.title,
      status: "fail",
      summary: `${groups.length} unpermitted identity conflict group(s)`,
      details: [
        ...groups.map((group) => `${group.field} ${group.value} is claimed by ${group.participants.join(", ")}`),
        ...CONFLICT_RESOLUTIONS,
      ],
      // NOT fixable, and that is the finding. Two agents claiming one repository
      // is a statement about intent, and there is no value a command could write
      // that is more likely right than wrong.
      fixable: false,
    };
  },
  migrate: (_ctx, finding) => blocked(
    finding,
    "An identity conflict is an operator ruling, never an automatic repair",
    [...finding.details.filter((detail) => !CONFLICT_RESOLUTIONS.includes(detail)), ...CONFLICT_RESOLUTIONS],
  ),
};

// ---------------------------------------------------------------------------
// The recipe
// ---------------------------------------------------------------------------

export function createOrgReconcileChecks(): RecipeCheck[] {
  return [BOARD_PROJECTION, PROFILE_PATH, RUNTIME_PATH, PROJECT_RECORDS, IDENTITY_CONFLICT];
}

/**
 * The fleet's own recipe: audited from any repository, repaired fleet-wide.
 *
 * It has no `init`. Every other recipe initializes a repository; this one is
 * about state that already exists on the machine, and "initializing the fleet"
 * would mean creating registry rows -- the one thing every rule here refuses to
 * do on its own.
 */
export class OrgReconcileRecipe extends Recipe {
  readonly checks = createOrgReconcileChecks();
  readonly metadata: RecipeMetadata = {
    id: "org-reconcile",
    name: "org-reconcile",
    description: "Reconcile the fleet registries with what is actually on this machine",
    dependencies: [],
    commands: ["audit", "remediate"],
    publicRuleIds: this.checks.map((check) => check.id),
  };

  override async init(ctx: LifecycleContext): Promise<RecipeInitResult> {
    return {
      recipeId: this.metadata.id,
      ok: true,
      dryRun: Boolean(ctx.dryRun),
      changedFiles: [],
      logs: ["org-reconcile has no initialization: it audits and repairs registries that already exist"],
      errors: [],
      phases: [],
    };
  }

  protected printNextSteps(): void {
    // `flume remediate --all` prints the plan; there is nothing to add here.
  }
}

/** Kept for the rare caller that wants the path without constructing a recipe. */
export function orgReconcileRuleIds(): string[] {
  return createOrgReconcileChecks().map((check) => check.id);
}
