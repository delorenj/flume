/** Owning-PM reconciliation: fail-closed coverage and preview-first, per-desk installation. */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";
import { agentsOf, boardRouting, claimedBoards, claimantsOf, pickClaimant } from "./board-routing";
import { DEFAULT_TIMEZONE, defaultSchedule, readRegistryAgents, readProfileJobs, type LaunchEnv } from "./launch";
import { resolveFleetHomeDir } from "../kernel/fleet-paths";
import { resolveFlumeRoot } from "../kernel/paths";

const mapping = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const name = "pm-reconcile";
const SCRIPT = "pm-reconcile.py";
const BRIEF = "pm-reconcile-brief.sh";
const MONITOR = "pm-reconcile-monitor.sh";
const PROMPT = "Follow the pass contract in the brief above.";
const toolsets = ["terminal", "file", "no_mcp"];
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

export interface ReconcileScope { board: string; label: string; owner: string; eligible: boolean; reason: string }
export interface ReconcileCoverage {
  ok: boolean; repo: string; employee: string | null; enabled: boolean; board: string | null;
  scopes: ReconcileScope[]; problems: string[]; driver: boolean; wrappers: boolean;
  job: string | null; manifest: string | null;
}

export function reconcileCoverage(repoArg: string | undefined, env: LaunchEnv = {}): ReconcileCoverage {
  const repo = real(repoArg ?? process.cwd());
  const fleet = env.fleetHome ?? resolveFleetHomeDir(process.env, env.home);
  const registry = readRegistryAgents(env);
  const agents = agentsOf({ agents: registry.agents });
  const matches = Object.entries(agents).filter(([, raw]) => {
    const row = mapping(raw);
    return row?.role === "pm" && typeof row.project_path === "string" && real(row.project_path) === repo;
  });
  const problems: string[] = registry.error ? [registry.error] : [];
  const [employee, raw] = matches.length === 1 ? matches[0]! : [null, null];
  if (matches.length !== 1) problems.push(`expected one owning PM at ${repo}, found ${matches.length}`);
  const row = mapping(raw);
  const roleDir = typeof row?.role_dir === "string" ? row.role_dir : join(repo, "agents", "hermes", "pm");
  if (!real(roleDir).startsWith(repo + "/")) problems.push("PM role directory is outside owning repository");
  if (row?.role !== "pm" || mapping(row?.bloodbank)?.enabled === false) problems.push("PM retired or inactive");
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(employee ?? "")) problems.push("unsafe PM identifier");
  const roleFile = join(roleDir, "role.yaml");
  let enabled = false;
  try {
    const role = mapping(YAML.parse(readFileSync(roleFile, "utf8")));
    const policy = mapping(role?.reconcile);
    if (policy?.explicit_opt_out === true || policy?.enabled === false) problems.push(`${roleFile}: explicit reconciliation opt-out`);
    else if (policy?.explicit_opt_out !== false || policy?.enabled !== true) problems.push(`${roleFile}: reconciliation policy not explicitly enabled`);
    else enabled = true;
  } catch (e) { problems.push(`${roleFile}: policy unreadable (${(e as Error).message})`); }
  const boards = row ? claimedBoards(row) : [];
  // Registry board_id and project_id may be two aliases for the same Plane project.
  const boardIds = [...new Set(boards)];
  if (!boardIds.length) problems.push("PM claims no Plane board");
  let board: string | null = null;
  try {
    const role = mapping(YAML.parse(readFileSync(roleFile, "utf8")));
    const plane = mapping(role?.plane);
    const provider = mapping(role?.ticket_provider);
    const identifier = plane?.identifier ?? provider?.identifier;
    if (typeof identifier === "string" && /^[A-Z][A-Z0-9]*$/u.test(identifier)) board = identifier;
  } catch { /* policy read reports the error above */ }
  if (!board) problems.push("board identifier missing from PM role");
  let rolePolicy: Record<string, unknown> | undefined;
  try { rolePolicy = mapping(YAML.parse(readFileSync(roleFile, "utf8"))); } catch { /* reported above */ }
  const roleScope = rolePolicy?.board_scope;
  const allowedScope = Array.isArray(roleScope) && roleScope.every((s) => typeof s === "string") ? roleScope as string[] : null;
  if (roleScope === "advisory" || (roleScope !== undefined && roleScope !== "owner" && !allowedScope)) problems.push("board_scope is advisory or malformed");
  const scopes: ReconcileScope[] = [];
  if (board && employee && boardIds.length === 1) {
    const routing = boardRouting(agents, boardIds[0]!);
    if (routing.claimants.length > 1 && routing.routes.some((r) => r.label !== null && !r.declared)) {
      problems.push("shared board has unclaimed labels; fail closed until scope routing is explicit");
    }
    for (const route of routing.routes) {
      const label = route.label ?? "(unlabeled)";
      if (route.owner === employee) {
        const scoped = (!allowedScope || allowedScope.includes(label)) && (label !== "(unlabeled)" || (rolePolicy?.unlabeled_intake !== false && routing.claimants.length === 1));
        const eligible = scoped && route.eligible && (route.declared || route.label === null || routing.claimants.length === 1) && !routing.flags.some((f) => f.code === "multiple-defaults");
        scopes.push({ board, label, owner: employee, eligible, reason: eligible ? "owned" : route.why });
        if (!eligible && label !== "(unlabeled)") problems.push(`${board}/${label}: ambiguous or ineligible ownership`);
      }
    }
    if (!scopes.length) problems.push(`${employee} has no routed scopes on ${board}`);
  }
  const profile = typeof row?.profile_name === "string" ? row.profile_name : "";
  if (!profile) problems.push("PM has no profile");
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(profile)) problems.push("unsafe PM profile");
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(basename(repo))) problems.push("unsafe repository slug for manifest");
  const driver = existsSync(join(roleDir, ".scripts", SCRIPT)) && existsSync(join(roleDir, ".scripts", "pm-reconcile-liveness.mjs")) && existsSync(join(roleDir, ".scripts", "launch-pass.py"));
  if (!driver) problems.push(`${roleDir}/.scripts/PM reconcile, launch declaration reader or liveness adapter missing; refresh only the owned scripts first`);
  const scripts = join(fleet, "profiles", profile, "scripts");
  const wrapperOk = (p: string, mode: string) => {
    try { const st = lstatSync(p); return st.isFile() && !st.isSymbolicLink() && Boolean(st.mode & 0o111) && readFileSync(p, "utf8").includes(`exec python3 '${join(roleDir, ".scripts", SCRIPT)}' --${mode}`); }
    catch { return false; }
  };
  const wrappers = wrapperOk(join(scripts, MONITOR), "monitor") && wrapperOk(join(scripts, BRIEF), "brief");
  const jobs = profile ? readProfileJobs(profile, env).filter((j) => j.script === BRIEF || j.monitor_script === MONITOR || j.name === `${employee} PM reconcile`) : [];
  if (jobs.length > 1) problems.push(`duplicate PM reconcile jobs in ${profile}`);
  const manifest = join(repo, ".candybars", `${basename(repo)}-pm-reconcile.candybar.toml`);
  return { ok: problems.length === 0, repo, employee, enabled, board, scopes, problems, driver, wrappers,
    job: jobs.length === 1 ? String(jobs[0]!.id) : null, manifest: existsSync(manifest) ? manifest : null };
}

export function reconcileAuthority(repo: string | undefined, env: LaunchEnv = {}) {
  const c = reconcileCoverage(repo, env);
  // The driver never trusts a fallback route on a shared board, nor an inactive PM.
  const owned = c.scopes.filter((s) => s.eligible).map((s) => s.label);
  return { ok: c.ok && owned.length > 0, employee: c.employee, enabled: c.enabled, board: c.board, scopes: owned, problems: c.problems };
}

export function reconcileTicketAuthority(repo: string | undefined, labels: string[], env: LaunchEnv = {}) {
  const c = reconcileCoverage(repo, env);
  if (!c.ok || !c.employee || !c.board || !Array.isArray(labels) || !labels.every((l) => typeof l === "string")) {
    return { ok: false, employee: c.employee, board: c.board, scope: null, reason: "authority unavailable" };
  }
  const registry = readRegistryAgents(env);
  if (registry.error) return { ok: false, employee: c.employee, board: c.board, scope: null, reason: registry.error };
  const agents = agentsOf({ agents: registry.agents });
  const row = mapping(agents[c.employee]);
  const ids = row ? claimedBoards(row) : [];
  if (ids.length !== 1) return { ok: false, employee: c.employee, board: c.board, scope: null, reason: "board claim changed" };
  const scopeLabels = labels.filter((l) => l.startsWith("repo:"));
  const claimants = claimantsOf(agents, ids[0]!);
  if (claimants.length > 1 && !scopeLabels.length) return { ok: false, employee: c.employee, board: c.board, scope: null, reason: "unlabeled shared-board ticket requires owner intake" };
  if (scopeLabels.length > 1) return { ok: false, employee: c.employee, board: c.board, scope: null, reason: "ambiguous scope labels" };
  const scope = scopeLabels[0] ?? "(unlabeled)";
  const selected = pickClaimant(claimants, labels.map((l) => l.toLowerCase()));
  const declaredForScope = scope === "(unlabeled)" || Boolean(selected?.scopeLabels.includes(scope));
  const allowed = declaredForScope && c.scopes.some((s) => s.label === scope && s.eligible);
  return { ok: selected?.id === c.employee && selected.eligible && allowed, employee: c.employee, board: c.board, scope,
    reason: selected?.id === c.employee && allowed ? "owned" : "owner or declared scope changed" };
}

interface Action { target: string; action: "create" | "update" | "unchanged" | "refuse"; detail: string }
export interface ReconcileInstall { ok: boolean; repo: string; applied: boolean; actions: Action[]; error?: string }

export function installReconcile(repoArg: string | undefined, apply = false, env: LaunchEnv = {}): ReconcileInstall {
  const c = reconcileCoverage(repoArg, env);
  const result: ReconcileInstall = { ok: c.ok, repo: c.repo, applied: false, actions: [] };
  if (!c.ok) return { ...result, error: c.problems.join("; ") };
  const fleet = env.fleetHome ?? resolveFleetHomeDir(process.env, env.home);
  const row = mapping(readRegistryAgents(env).agents[c.employee!])!;
  const profile = String(row.profile_name);
  const roleDir = String(row.role_dir ?? join(c.repo, "agents", "hermes", "pm"));
  const driver = join(roleDir, ".scripts", SCRIPT);
  const scripts = join(fleet, "profiles", profile, "scripts");
  const policyPath = join(roleDir, "runtime", "pm-reconcile.json");
  const policyText = JSON.stringify({ version: 1, enabled: true, employee: c.employee, repo: c.repo }, null, 2) + "\n";
  if (isSymlink(policyPath)) return { ...result, ok: false, error: "runtime policy is a symlink" };
  const existingPolicy = readFileIfRegular(policyPath);
  if (existingPolicy !== null) {
    try {
      const parsed = JSON.parse(existingPolicy) as Record<string, unknown>;
      if (parsed.version !== 1 || parsed.employee !== c.employee || real(String(parsed.repo ?? "")) !== c.repo || parsed.enabled !== true) {
        return { ...result, ok: false, error: "existing runtime policy conflicts with owning PM" };
      }
    } catch { return { ...result, ok: false, error: "runtime policy malformed" }; }
  }
  result.actions.push({ target: policyPath, action: existingPolicy === null ? "create" : "unchanged", detail: "local owning-PM policy; no credential" });
  if (!existsSync(join(fleet, "profiles", profile))) return { ...result, ok: false, error: `profile ${profile} missing` };
  if (isSymlink(scripts)) return { ...result, ok: false, error: "profile scripts directory is a symlink" };
  const wrap = (mode: string) => `#!/usr/bin/env bash\nexec python3 '${driver}' --${mode}\n`;
  const targets = [[MONITOR, "monitor"], [BRIEF, "brief"]] as const;
  for (const [file, mode] of targets) {
    const path = join(scripts, file);
    const text = wrap(mode);
    if (isSymlink(path)) return { ...result, ok: false, error: `wrapper ${path} is a symlink` };
    let same = false;
    try { const st = lstatSync(path); same = st.isFile() && !st.isSymbolicLink() && Boolean(st.mode & 0o111) && readFileSync(path, "utf8") === text; }
    catch { /* absent */ }
    result.actions.push({ target: path, action: same ? "unchanged" : existsSync(path) ? "update" : "create", detail: `real executable --${mode}` });
  }
  const jobs = readProfileJobs(profile, env).filter((j) => j.script === BRIEF || j.monitor_script === MONITOR || j.name === `${c.employee} PM reconcile`);
  if (jobs.length > 1) return { ...result, ok: false, error: "duplicate job conflict" };
  const existing = jobs[0];
  if (existing && (existing.scheduler !== "external" || existing.enabled !== false || existing.script !== BRIEF || existing.monitor_script !== MONITOR || existing.prompt !== PROMPT
    || existing.reasoning_effort !== "medium" || !Array.isArray(existing.enabled_toolsets) || [...existing.enabled_toolsets].sort().join() !== [...toolsets].sort().join()
    || !Array.isArray(existing.skills) || existing.skills.length !== 0 || mapping(existing.economics)?.max_iterations !== 10)) {
    return { ...result, ok: false, error: "existing reconcile job conflicts; never auto-resume or adopt a drifted job" };
  }
  const schedule = defaultSchedule(basename(c.repo));
  const timezone = DEFAULT_TIMEZONE;
  const jobId = existing ? String(existing.id) : "";
  result.actions.push({ target: `Hermes job ${profile}`, action: existing ? "unchanged" : "create", detail: "external scheduler; lean; no continuity" });
  if (jobId) {
    const stored = String(mapping(existing?.schedule)?.expr ?? "");
    if (!stored || !/^(\S+\s+){4}\S+$/u.test(stored)) return { ...result, ok: false, error: "existing job schedule unavailable" };
  }
  const manifest = join(c.repo, ".candybars", `${basename(c.repo)}-pm-reconcile.candybar.toml`);
  let current: Record<string, unknown> | undefined;
  if (existsSync(manifest)) {
    if (isSymlink(manifest)) return { ...result, ok: false, error: "manifest is a symlink" };
    try { current = mapping(parseToml(readFileSync(manifest, "utf8"))); }
    catch { return { ...result, ok: false, error: "manifest malformed" }; }
  }
  const candy = mapping(current?.candybar);
  const runner = mapping(candy?.runner);
  if (current && (candy?.name !== `${basename(c.repo)}-pm-reconcile` || candy?.enabled !== false || runner?.kind !== "hermes" || runner?.profile !== profile || (jobId && runner?.job_id !== jobId)
    || candy?.schedule !== mapping(existing?.schedule)?.expr || candy?.timezone !== existing?.timezone)) {
    return { ...result, ok: false, error: "manifest conflicts with owner/job" };
  }
  if (current && !jobId) return { ...result, ok: false, error: "manifest exists without matching Hermes job" };
  result.actions.push({ target: manifest, action: current ? "unchanged" : "create", detail: "disabled manifest; manual registration after review" });
  if (!apply) return result;
  // Apply only inert installation files. No Candybar register/resume, no gateway restart.
  if (existingPolicy === null) { mkdirSync(join(roleDir, "runtime"), { recursive: true }); writeFileSync(policyPath, policyText, { mode: 0o600 }); }
  for (const [file, mode] of targets) {
    const path = join(scripts, file), text = wrap(mode);
    if (readFileIfRegular(path) !== text) { mkdirSync(scripts, { recursive: true }); writeFileSync(path, text, { mode: 0o755 }); chmodSync(path, 0o755); }
  }
  let id = jobId;
  if (!id) {
    const helper = join(resolveFlumeRoot(), "scripts", "launch-hermes-job.py");
    const python = process.env.FLUME_HERMES_PYTHON?.trim() || join(fleet, "hermes-agent", ".venv", "bin", "python");
    const run = spawnSync(python, [helper], { input: JSON.stringify({ profile, job_id: null,
      create: { prompt: PROMPT, schedule, name: `${c.employee} PM reconcile`, script: BRIEF, monitor_script: MONITOR, timezone, reasoning_effort: "medium" },
      updates: { scheduler: "external", enabled_toolsets: toolsets, skills: [], skill: null, economics: { max_iterations: 10 }, enabled: false, state: "paused" } }),
      encoding: "utf8", timeout: 60_000, env: { ...process.env, HERMES_FLEET_HOME: fleet } });
    try { const doc = JSON.parse(run.stdout) as { ok: boolean; job: { id: string; scheduler: string; enabled: boolean }; error?: string };
      if (!doc.ok || doc.job?.scheduler !== "external" || doc.job?.enabled !== false) throw new Error(doc.error ?? "job not paused/external");
      id = doc.job.id;
    } catch (e) { return { ...result, ok: false, error: `Hermes job failed: ${(e as Error).message}; wrappers may be installed` }; }
  }
  if (!current) {
    mkdirSync(join(c.repo, ".candybars"), { recursive: true });
    writeFileSync(manifest, `[candybar]\nname = "${basename(c.repo)}-pm-reconcile"\nschedule = "${schedule}"\ntimezone = "${timezone}"\nenabled = false\ntags = ["hermes-agent", "pm", "reconcile"]\n\n[candybar.runner]\nkind = "hermes"\nprofile = "${profile}"\njob_id = "${id}"\ntimeout_s = 1500\n`);
  }
  return { ...result, applied: true };
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function readFileIfRegular(path: string): string | null {
  try { const st = lstatSync(path); return st.isFile() && !st.isSymbolicLink() ? readFileSync(path, "utf8") : null; }
  catch { return null; }
}
