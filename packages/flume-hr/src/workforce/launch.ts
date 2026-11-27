/**
 * Project modes, wired: `flume launch status|enable|disable` (and the mode-first spelling
 * `flume mode ...`) plus the `hermes.launch-mode` audit rule.
 *
 * A repo's PM mode is repo DATA: the owner declares it in the repo's committed `.launch.yaml`
 * (`mode:` key) and agents never edit that file. `develop` is the default (no file, `mode:
 * develop`, or the legacy alias `mode: steady`) and runs no pass; `launch` races a finish line;
 * `polish` is around-the-clock exploratory QA; `live` is a lifecycle stage (in production) and
 * runs no pass. Launch and polish share every piece of machinery below -- same driver, wrappers,
 * Hermes job and Candybar entry; only the cadence, the job budget and the pass contract differ:
 *
 *   declaration   <repo>/.launch.yaml                       owner-edited, read here, never written
 *   driver        <desk>/.scripts/launch-pass.py            shipped by the hermes-agent template
 *   wrappers      <profile>/scripts/launch-{monitor,brief}.sh   real files that exec the driver
 *   Hermes job    profile cron job, pinned scheduler=external, lean (interval-driver)
 *   Candybar      <repo>/.candybars/<repo>-pm-launch-pass.candybar.toml, registered and enabled
 *   crank         pjangler crank on for the repo (`pj crank enable`), so its interactive agent
 *                 sessions keep moving too; skipped for a repo with no `.project.json`
 *
 * Candybar is the only clock: the job is pinned `external`, and nothing here schedules anything.
 * `enable` is idempotent and adopts what already exists (zero changes on a wired repo); `disable`
 * only pauses the Candybar job (manifest and Hermes job stay, so leaving a mode is reversible).
 * Writes only the wrappers, the Hermes job and the manifest, and asks pj to turn crank on (pj writes
 * `.project.json`); it commits nothing. `disable` leaves crank alone: crank also serves develop repos.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import { resolveAgentRegistryPath, resolveFleetHomeDir } from "../kernel/fleet-paths";
import { resolveFlumeRoot } from "../kernel/paths";
import type { RecipeOwnedCheck } from "../parity/rules";

export const RETIRED_LAUNCH_ROLES = ["launch-director", "paired-launch-director", "em"] as const;
export const LAUNCH_DECLARATION = ".launch.yaml";
export const LAUNCH_MONITOR = "launch-monitor.sh";
export const LAUNCH_BRIEF = "launch-brief.sh";
export const DEFAULT_TIMEZONE = "America/New_York";
export const JOB_PROMPT = "Follow the pass contract in the brief above.";
const LEAN_TOOLSETS = ["terminal", "file", "no_mcp"];
const MAX_ITERATIONS = 10;
const POLISH_MAX_ITERATIONS = 30;
const REASONING_EFFORT = "medium";
/** Polish cadence when the declaration names none (launch defaults to hourly, per repo). */
export const POLISH_DEFAULT_SCHEDULE = "*/15 * * * *";
/** Krebs WIP slots ("lanes") while polishing; develop and launch default to 2. */
export const POLISH_DEFAULT_WIP = 4;
const SCHEDULE = /^(\S+\s+){4}\S+$/u;

type Row = Record<string, unknown>;
const mapping = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;

export interface LaunchEnv { home?: string; fleetHome?: string; registryPath?: string }

function envPaths(env: LaunchEnv = {}) {
  const home = env.home ?? homedir();
  const fleetHome = env.fleetHome ?? resolveFleetHomeDir(process.env, home);
  const registry = env.registryPath ?? resolveAgentRegistryPath(process.env, home, fleetHome);
  return { home, fleetHome, registry };
}

// ---------------------------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------------------------

export type LaunchMode = "develop" | "launch" | "polish" | "live" | "absent" | "invalid";
/** The modes a pass runs for. develop (the default) and live run none. */
export type ActiveMode = "launch" | "polish";
export const isActiveMode = (mode: LaunchMode): mode is ActiveMode => mode === "launch" || mode === "polish";

/** The optional `polish:` block of the declaration. Every field is a hint with a default, never a limit. */
export interface PolishDeclaration {
  /** Krebs WIP slots ("lanes") while polishing; default POLISH_DEFAULT_WIP (develop/launch default is 2). */
  wip?: number;
  /** Candybar schedule of the pass; default POLISH_DEFAULT_SCHEDULE. */
  cadence?: string;
  /** Todo is topped up to this many polish tickets each pass; default 2 x wip. */
  todoDepth?: number;
  /** Repo commands a QA cycle may run (exploratory harness, e2e, screenshots). */
  qa?: string[];
  /** Hint areas, never a limit: anything, however small, is ticketable. */
  focus?: string[];
}

export interface LaunchDeclaration {
  path: string;
  exists: boolean;
  /**
   * The lifecycle is develop (the default: building, no pass) -> launch (racing to a finish line)
   * -> live (in production: people can buy it and use it); `polish` is around-the-clock exploratory
   * QA. `steady` is a LEGACY ALIAS that reads as `develop`. Only `launch` and `polish` run a pass.
   * `absent` = no file (develop); `invalid` = unreadable or an unknown mode (treated as develop, reported).
   */
  mode: LaunchMode;
  epic?: string;
  declared?: string;
  polish?: PolishDeclaration;
  error?: string;
}

/** The optional `polish:` block; a string return is the reason the declaration is invalid. */
function readPolishBlock(raw: unknown): PolishDeclaration | string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const block = mapping(raw);
  if (!block) return `${LAUNCH_DECLARATION} polish must be a mapping (got ${JSON.stringify(raw)})`;
  const out: PolishDeclaration = {};
  const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
  if (block.wip !== undefined) {
    if (!positiveInt(block.wip)) return `${LAUNCH_DECLARATION} polish.wip must be a positive integer (got ${JSON.stringify(block.wip)})`;
    out.wip = block.wip;
  }
  if (block.cadence !== undefined) {
    if (typeof block.cadence !== "string" || !SCHEDULE.test(block.cadence.trim())) return `${LAUNCH_DECLARATION} polish.cadence must be a 5-field cron expression (got ${JSON.stringify(block.cadence)})`;
    out.cadence = block.cadence.trim();
  }
  if (block.todo_depth !== undefined) {
    if (!positiveInt(block.todo_depth)) return `${LAUNCH_DECLARATION} polish.todo_depth must be a positive integer (got ${JSON.stringify(block.todo_depth)})`;
    out.todoDepth = block.todo_depth;
  }
  if (block.qa !== undefined) {
    if (!Array.isArray(block.qa) || block.qa.some((c) => typeof c !== "string" || !c.trim())) return `${LAUNCH_DECLARATION} polish.qa must be a list of command strings`;
    out.qa = (block.qa as string[]).map((c) => c.trim());
  }
  if (block.focus !== undefined) {
    if (!Array.isArray(block.focus) || block.focus.some((c) => typeof c !== "string" || !c.trim())) return `${LAUNCH_DECLARATION} polish.focus must be a list of words`;
    out.focus = (block.focus as string[]).map((c) => c.trim().toLowerCase());
  }
  return out;
}

export function readLaunchDeclaration(repoRoot: string): LaunchDeclaration {
  const path = join(repoRoot, LAUNCH_DECLARATION);
  if (!existsSync(path)) return { path, exists: false, mode: "absent" };
  try {
    const doc = mapping(YAML.parse(readFileSync(path, "utf8")));
    // Every reader normalises: lowercase; `steady` is a legacy alias that reads as develop.
    const raw = typeof doc?.mode === "string" ? doc.mode.trim().toLowerCase() : doc?.mode;
    const mode = raw === "steady" ? "develop" : raw;
    const out: LaunchDeclaration = { path, exists: true, mode: "invalid" };
    if (typeof doc?.epic === "string") out.epic = doc.epic;
    if (doc?.declared !== undefined) out.declared = String(doc.declared);
    if (mode !== "develop" && mode !== "launch" && mode !== "polish" && mode !== "live") {
      out.error = `${LAUNCH_DECLARATION} mode must be "develop", "launch", "polish" or "live" ("steady" is a legacy alias for develop; got ${JSON.stringify(doc?.mode ?? null)})`;
      return out;
    }
    out.mode = mode;
    if (mode === "polish") {
      const polish = readPolishBlock(doc?.polish);
      if (typeof polish === "string") { out.mode = "invalid"; out.error = polish; return out; }
      if (polish) out.polish = polish;
    }
    return out;
  } catch (error) {
    return { path, exists: true, mode: "invalid", error: `${LAUNCH_DECLARATION} unreadable: ${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------------------------------------
// Registry: which desks serve this repo
// ---------------------------------------------------------------------------------------------

export interface Desk {
  id: string;
  role: string;
  repo: string;
  profile: string;
  roleDir: string;
  displayName: string;
  /** A retired row (`flume retire`): bloodbank off. Never a launch desk; a finding only while its title is a retired launch role (it still sits in the org chart until `flume offboard`). */
  retired: boolean;
  row: Row;
}

function realOrResolved(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function readRegistryAgents(env: LaunchEnv = {}): { agents: Row; path: string; error?: string } {
  const { registry } = envPaths(env);
  if (!existsSync(registry)) return { agents: {}, path: registry, error: `no agent registry at ${registry}` };
  try {
    return { agents: mapping(mapping(YAML.parse(readFileSync(registry, "utf8")))?.agents) ?? {}, path: registry };
  } catch (error) {
    return { agents: {}, path: registry, error: `agent registry unreadable at ${registry}: ${(error as Error).message}` };
  }
}

/** Every registry row that serves `repoRoot` (by project_path, falling back to the `repo` slug). */
export function desksOfRepo(repoRoot: string, env: LaunchEnv = {}): Desk[] {
  const root = realOrResolved(repoRoot), slug = basename(root);
  const desks: Desk[] = [];
  for (const [id, raw] of Object.entries(readRegistryAgents(env).agents)) {
    const row = mapping(raw);
    if (!row) continue;
    const projectPath = typeof row.project_path === "string" ? realOrResolved(row.project_path) : "";
    const serves = projectPath ? projectPath === root : row.repo === slug;
    if (!serves) continue;
    const bloodbank = mapping(row.bloodbank);
    desks.push({
      id, role: String(row.role ?? ""), repo: String(row.repo ?? slug), row,
      profile: String(row.profile_name ?? id),
      roleDir: typeof row.role_dir === "string" ? row.role_dir : join(root, "agents", "hermes", String(row.role ?? "pm")),
      displayName: String(row.display_name ?? id),
      retired: bloodbank !== undefined && bloodbank.enabled === false,
    });
  }
  return desks;
}

export interface PmDeskResult { desk?: Desk; error?: string }

/** The repo's one live PM desk. An unconverted em desk is named, never silently used. */
export function pmDeskOf(repoRoot: string, env: LaunchEnv = {}): PmDeskResult {
  const live = desksOfRepo(repoRoot, env).filter((desk) => !desk.retired);
  const pms = live.filter((desk) => desk.role === "pm");
  if (pms.length === 1) return { desk: pms[0]! };
  if (pms.length > 1) {
    const preferred = pms.filter((desk) => resolve(desk.roleDir) === resolve(repoRoot, "agents", "hermes", "pm"));
    if (preferred.length === 1) return { desk: preferred[0]! };
    return { error: `${pms.length} pm desks serve ${repoRoot} (${pms.map((d) => d.id).join(", ")}); launch mode needs exactly one` };
  }
  const em = live.find((desk) => desk.role === "em");
  if (em) return { error: `${em.id} still has role em (retired title); convert it to pm first: see docs/launch-mode.md "em to pm conversion"` };
  return { error: `no pm desk in the agent registry serves ${repoRoot}; hire one first: flume hire pm` };
}

// ---------------------------------------------------------------------------------------------
// Names, wrappers, job spec, manifest
// ---------------------------------------------------------------------------------------------

export interface LaunchNames {
  repo: string;
  candybar: string;
  manifestPath: string;
  scriptsDir: string;
  monitorPath: string;
  briefPath: string;
  driverPath: string;
  label: string;
}

export function launchNames(repoRoot: string, desk: Desk, env: LaunchEnv = {}): LaunchNames {
  const repo = desk.repo || basename(repoRoot);
  const scriptsDir = join(envPaths(env).fleetHome, "profiles", desk.profile, "scripts");
  return {
    repo, candybar: `${repo}-pm-launch-pass`,
    manifestPath: join(repoRoot, ".candybars", `${repo}-pm-launch-pass.candybar.toml`),
    scriptsDir, monitorPath: join(scriptsDir, LAUNCH_MONITOR), briefPath: join(scriptsDir, LAUNCH_BRIEF),
    driverPath: join(desk.roleDir, ".scripts", "launch-pass.py"),
    label: desk.displayName.replace(/\s+PM$/u, "") || repo,
  };
}

function wrapperText(kind: "monitor" | "brief", names: LaunchNames): string {
  return `#!/usr/bin/env bash
# interval-driver ${kind} for the ${names.label} launch pass; source of truth is in the ${names.repo} repo.
exec python3 ${names.driverPath} --${kind}
`;
}

function wrapperOk(path: string, kind: "monitor" | "brief", names: LaunchNames): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) return false;
    return readFileSync(path, "utf8").split("\n").some((line) => line.trim() === `exec python3 ${names.driverPath} --${kind}`);
  } catch { return false; }
}

/** A stable minute (5..54) per repo, so launch passes across repos do not all fire together. */
export function defaultSchedule(repo: string): string {
  let sum = 0;
  for (const ch of repo) sum = (sum * 31 + ch.charCodeAt(0)) % 1000;
  return `${5 + (sum % 50)} 8-22 * * *`;
}

/** The pass cadence a mode gets when nothing more specific is declared: polish every 15 minutes, launch hourly at a per-repo minute. */
export function modeDefaultSchedule(mode: ActiveMode, repo: string): string {
  return mode === "polish" ? POLISH_DEFAULT_SCHEDULE : defaultSchedule(repo);
}

/** The Hermes job's display name per mode (the launch name is unchanged since the first wiring). */
export function modeJobName(mode: ActiveMode, label: string): string {
  return mode === "polish" ? `${label} polish pass (every 15m)` : `${label} launch pass (hourly)`;
}

function manifestText(names: LaunchNames, schedule: string, timezone: string, profile: string, jobId: string, mode: ActiveMode): string {
  const maxIterations = mode === "polish" ? POLISH_MAX_ITERATIONS : MAX_ITERATIONS;
  const cadence = mode === "polish"
    ? (schedule === POLISH_DEFAULT_SCHEDULE ? "every 15 minutes by default" : `on "${schedule}"`)
    : `hourly at :${String(schedule.split(/\s+/u)[0]).padStart(2, "0")}, 08:00-22:00 ET by default`;
  return `# ${names.label} ${mode} pass (${profile}), ${cadence}.
#
# ${mode === "polish" ? "Polish" : "Launch"} mode is repo data: this pass does work only while .launch.yaml says \`mode: ${mode}\`.
# In develop mode the monitor prints exactly \`launch-mode: develop\`, so every fire costs 0 tokens.
#
# interval-driver pattern (~/.agents/skills/interval-driver):
#   monitor  agents/hermes/pm/.scripts/launch-pass.py --monitor  (unchanged = the agent never starts)
#   brief    agents/hermes/pm/.scripts/launch-pass.py --brief    (pass contract + declaration + snapshot + plan shape)
#   apply    agents/hermes/pm/.scripts/launch-pass.py --apply    (board-driver lease, capped writes, receipt, roadmap)
#   lean     toolsets terminal,file,no_mcp; no skills; max_iterations ${maxIterations}; ${REASONING_EFFORT} effort; no continuity
# Wrappers: ~/.hermes/profiles/${profile}/scripts/launch-{monitor,brief}.sh (real files; exec the repo).
# Hermes job ${jobId} is pinned scheduler=external: Candybar is its only clock.
# Wired by \`flume launch enable\`; \`flume launch disable\` pauses it when the repo leaves ${mode} mode.
[candybar]
name = "${names.candybar}"
schedule = "${schedule}"
timezone = "${timezone}"
enabled = false
tags = ["hermes-agent", "pm", "launch-mode"]

[candybar.runner]
kind = "hermes"
profile = "${profile}"
job_id = "${jobId}"
timeout_s = 1500
`;
}

interface ManifestFacts { schedule?: string; timezone?: string; profile?: string; jobId?: string; name?: string; header?: string }

function readManifest(path: string): { exists: boolean; facts?: ManifestFacts; error?: string } {
  if (!existsSync(path)) return { exists: false };
  try {
    const text = readFileSync(path, "utf8");
    const doc = mapping(parseToml(text));
    const c = mapping(doc?.candybar), r = mapping(c?.runner);
    return { exists: true, facts: {
      name: c?.name as string | undefined, schedule: c?.schedule as string | undefined, timezone: c?.timezone as string | undefined,
      profile: r?.profile as string | undefined, jobId: r?.job_id as string | undefined, header: text.split("\n", 1)[0] ?? "",
    } };
  } catch (error) { return { exists: true, error: (error as Error).message }; }
}

// ---------------------------------------------------------------------------------------------
// Hermes job store (read-only here; writes go through the Hermes Python helper)
// ---------------------------------------------------------------------------------------------

export type Job = Row;

export function readProfileJobs(profile: string, env: LaunchEnv = {}): Job[] {
  const file = join(envPaths(env).fleetHome, "profiles", profile, "cron", "jobs.json");
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const list = Array.isArray(doc) ? doc : mapping(doc)?.jobs;
    return (Array.isArray(list) ? list : []).filter((job): job is Job => mapping(job) !== undefined);
  } catch { return []; }
}

export function launchJobsOf(profile: string, env: LaunchEnv = {}): Job[] {
  return readProfileJobs(profile, env).filter((job) => job.script === LAUNCH_BRIEF && job.monitor_script === LAUNCH_MONITOR);
}

const sameSet = (a: unknown, b: string[]): boolean =>
  Array.isArray(a) && a.length === b.length && [...a].map(String).sort().join("\0") === [...b].sort().join("\0");

/** Updates that bring an existing launch job to the lean, externally scheduled shape. Empty = already there. */
export function jobUpdates(job: Job, wanted: { schedule?: string; timezone: string; maxIterations?: number }): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const maxIterations = wanted.maxIterations ?? MAX_ITERATIONS;
  if (job.scheduler !== "external") updates.scheduler = "external";
  if (!sameSet(job.enabled_toolsets, LEAN_TOOLSETS)) updates.enabled_toolsets = LEAN_TOOLSETS;
  const skills = job.skills;
  if ((Array.isArray(skills) && skills.length > 0) || (job.skill ?? null) !== null) { updates.skills = []; updates.skill = null; }
  if (mapping(job.economics)?.max_iterations !== maxIterations) updates.economics = { ...(mapping(job.economics) ?? {}), max_iterations: maxIterations };
  if (job.reasoning_effort !== REASONING_EFFORT) updates.reasoning_effort = REASONING_EFFORT;
  if (job.timezone !== wanted.timezone) updates.timezone = wanted.timezone;
  if (wanted.schedule !== undefined && mapping(job.schedule)?.expr !== wanted.schedule) updates.schedule = wanted.schedule;
  if (job.enabled === false) Object.assign(updates, { enabled: true, state: "scheduled", paused_at: null, paused_reason: null });
  return updates;
}

function hermesPython(env: LaunchEnv): string {
  return process.env.FLUME_HERMES_PYTHON?.trim() || join(envPaths(env).fleetHome, "hermes-agent", ".venv", "bin", "python");
}

function applyJob(profile: string, jobId: string | null, create: Record<string, unknown> | undefined, updates: Record<string, unknown>, env: LaunchEnv): { ok: boolean; job?: Job; error?: string } {
  const helper = join(resolveFlumeRoot(), "scripts", "launch-hermes-job.py");
  const child = spawnSync(hermesPython(env), [helper], {
    input: JSON.stringify({ profile, job_id: jobId, create, updates }), encoding: "utf8", timeout: 60_000, shell: false,
    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, HERMES_FLEET_HOME: envPaths(env).fleetHome },
  });
  try { return JSON.parse(String(child.stdout).trim().split("\n").pop() ?? "") as { ok: boolean; job?: Job; error?: string }; }
  catch { return { ok: false, error: `hermes job helper failed: ${String(child.stderr || child.error?.message || child.stdout).trim().slice(0, 400)}` }; }
}

// ---------------------------------------------------------------------------------------------
// Candybar (CLI; Candybar owns the clock and the registry)
// ---------------------------------------------------------------------------------------------

export interface CandybarState {
  observable: boolean;
  /** enabled | paused | archived | unregistered | unknown */
  state: string;
  sync?: string;
  schedule?: string;
  error?: string;
}

function candybarBin(): string { return process.env.FLUME_CANDYBAR_BIN?.trim() || "candybar"; }

function runCandybar(args: string[], cwd: string, timeout = 60_000) {
  return spawnSync(candybarBin(), args, { cwd, encoding: "utf8", timeout, shell: false, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } });
}

/** The repo's `<name>` candybar as `candybar ls --all --json` reports it from inside the repo. */
export function candybarState(repoRoot: string, name: string): CandybarState {
  const run = runCandybar(["ls", "--all", "--json"], repoRoot);
  if (run.error || run.status !== 0) {
    return { observable: false, state: "unknown", error: `candybar ls failed: ${String(run.error?.message ?? run.stderr).trim().slice(0, 200)}` };
  }
  try {
    const entries = JSON.parse(String(run.stdout)) as Row[];
    const entry = entries.find((e) => e.name === name);
    if (!entry) return { observable: true, state: "unregistered" };
    return { observable: true, state: String(entry.state ?? "unknown"), sync: String(entry.sync ?? ""), ...(typeof entry.schedule === "string" ? { schedule: entry.schedule } : {}) };
  } catch (error) {
    return { observable: false, state: "unknown", error: `candybar ls output unreadable: ${(error as Error).message}` };
  }
}

function lastCandybarRun(repoRoot: string, name: string): { when?: string; result?: string } {
  const run = runCandybar(["history", name, "--runs", "1", "--json"], repoRoot, 30_000);
  if (run.error || run.status !== 0) return {};
  try {
    const parsed = JSON.parse(String(run.stdout)) as unknown;
    const list = Array.isArray(parsed) ? parsed : mapping(parsed)?.runs;
    const first = mapping(Array.isArray(list) ? list[0] : undefined);
    if (!first) return {};
    const when = first.startedAt ?? first.started_at ?? first.started;
    const result = first.result ?? first.status ?? first.outcome;
    return { ...(when !== undefined ? { when: String(when) } : {}), ...(result !== undefined ? { result: String(result) } : {}) };
  } catch { return {}; }
}

// ---------------------------------------------------------------------------------------------
// Crank (pjangler): a launching repo keeps its interactive agent sessions cranked
// ---------------------------------------------------------------------------------------------

/**
 * The repo's crank policy as `pj crank status --json` resolves it. pj owns the crank block (project
 * `.project.json` over the global crank.toml), so flume asks rather than re-deriving the rule.
 * `applicable: false` = not a pjangler project (no `.project.json`): crank does not apply.
 */
export interface CrankState { applicable: boolean; observable: boolean; enabled?: boolean; source?: string; interval?: string; error?: string }

function pjBin(): string { return process.env.FLUME_PJ_BIN?.trim() || "pj"; }

function runPj(args: string[], cwd: string, timeout = 60_000) {
  return spawnSync(pjBin(), args, { cwd, encoding: "utf8", timeout, shell: false, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } });
}

export function crankState(repoRoot: string): CrankState {
  if (!existsSync(join(repoRoot, ".project.json"))) return { applicable: false, observable: true };
  const run = runPj(["crank", "status", "--json"], repoRoot, 30_000);
  if (run.error || run.status !== 0) {
    return { applicable: true, observable: false, error: `pj crank status failed: ${String(run.error?.message ?? run.stderr).trim().slice(0, 200)}` };
  }
  try {
    const policy = mapping(mapping(JSON.parse(String(run.stdout)))?.policy);
    if (!policy || typeof policy.enabled !== "boolean") return { applicable: true, observable: false, error: "pj crank status --json has no policy.enabled" };
    return {
      applicable: true, observable: true, enabled: policy.enabled,
      ...(typeof policy.enabledSource === "string" ? { source: policy.enabledSource } : {}),
      ...(typeof policy.interval === "string" ? { interval: policy.interval } : {}),
    };
  } catch (error) {
    return { applicable: true, observable: false, error: `pj crank status output unreadable: ${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

/** The polish metrics ledger the pass driver keeps at <role dir>/runtime/polish-metrics.json. */
export interface PolishMetrics { cycles: number; proposed: number; implemented: number; updatedAt: string | null }

/**
 * Read the polish metrics ledger. proposed = improvements proposed, implemented = proposed refs now
 * in the completed state group, cycles = total QA cycles. A missing or broken file is "no metrics",
 * never an error: the status line and this reader only display it.
 */
export function readPolishMetrics(roleDir: string): PolishMetrics | null {
  try {
    const doc = mapping(JSON.parse(readFileSync(join(roleDir, "runtime", "polish-metrics.json"), "utf8")));
    if (!doc) return null;
    return {
      cycles: typeof doc.cycles === "number" && Number.isFinite(doc.cycles) ? doc.cycles : 0,
      proposed: Array.isArray(doc.proposed) ? doc.proposed.length : 0,
      implemented: Array.isArray(doc.implemented) ? doc.implemented.length : 0,
      updatedAt: typeof doc.updated_at === "string" ? doc.updated_at : null,
    };
  } catch { return null; }
}

export interface LaunchStatus {
  ok: boolean;
  repo: string;
  /** Mirror of declaration.mode, top-level so a status line can read one key. */
  mode: LaunchMode;
  declaration: { path: string; mode: LaunchDeclaration["mode"]; epic: string | null; declared: string | null; polish: PolishDeclaration | null; error: string | null };
  desk: { id: string; role: string; profile: string; roleDir: string } | null;
  driver: boolean;
  wrappers: { monitor: boolean; brief: boolean };
  job: { id: string; enabled: boolean; scheduler: string; schedule: string; lastRun: string | null; lastStatus: string | null } | null;
  manifest: { path: string; exists: boolean; inSync: boolean };
  candybar: CandybarState & { lastRun: { when?: string; result?: string } | null };
  crank: CrankState;
  /** Non-null only in polish mode; metrics null until the first cycle writes the ledger. */
  polish: { metrics: PolishMetrics | null } | null;
  retiredDesks: string[];
  problems: string[];
}

/** What the audit and `status` both conclude: launch passes must follow the declaration, and retired roles must go. */
export function launchProblems(input: {
  declaration: LaunchDeclaration; desk: PmDeskResult; deskExtras: Desk[]; driver: boolean; wrappers: { monitor: boolean; brief: boolean };
  jobs: Job[]; manifestExists: boolean; candybar: CandybarState; names?: LaunchNames; crank?: CrankState;
}): { problems: string[]; fixable: boolean } {
  const problems: string[] = [];
  let fixable = true;
  const { declaration, candybar } = input;
  for (const desk of input.deskExtras) {
    fixable = false;
    // A row with a retired title is a finding until it leaves the org chart. `flume retire` (record kept) used to clear
    // it, which is how three launch directors stayed in the registry, the status line and Telegram for six days after
    // launch mode replaced them (2026-11-18 to 2026-11-24). `flume offboard` is the whole exit.
    problems.push(desk.role === "em" && !desk.retired
      ? `${desk.id}: role em is retired; convert it to pm (docs/launch-mode.md "em to pm conversion"), or run: flume offboard ${desk.id} --apply`
      : `${desk.id}: role ${desk.role} is retired${desk.retired ? " and the employee is out of service, but still in the org chart" : ""}; launch mode on the PM replaced it; run: flume offboard ${desk.id} --apply`);
  }
  if (declaration.mode === "invalid" && declaration.error) { fixable = false; problems.push(declaration.error); }
  const enabled = candybar.state === "enabled";
  if (isActiveMode(declaration.mode)) {
    const mode = declaration.mode;
    if (!input.desk.desk) { fixable = false; problems.push(`mode: ${mode} but ${input.desk.error}`); }
    else {
      if (!input.driver) { fixable = false; problems.push(`${input.desk.desk.id}: .scripts/launch-pass.py missing; run: flume remediate hermes.pm-scaffold --scripts-only`); }
      if (!input.wrappers.monitor || !input.wrappers.brief) problems.push(`${input.desk.desk.id}: launch wrapper scripts missing or not real executables; run: flume launch enable`);
      const external = input.jobs.filter((job) => job.scheduler === "external" && job.enabled !== false);
      if (input.jobs.length === 0) problems.push(`${input.desk.desk.id}: no Hermes launch job (script ${LAUNCH_BRIEF}); run: flume launch enable`);
      else if (external.length === 0) problems.push(`${input.desk.desk.id}: Hermes launch job is not an enabled scheduler=external job; run: flume launch enable`);
      if (!input.manifestExists) problems.push("Candybar manifest missing; run: flume launch enable");
      if (!candybar.observable) problems.push(`Candybar not observable (${candybar.error ?? "unknown"}); launch pass state unverified`);
      else if (!enabled) problems.push(`Candybar ${input.names?.candybar ?? "<repo>-pm-launch-pass"} is ${candybar.state}, mode is ${mode}; run: flume launch enable`);
    }
    // An active mode keeps momentum in the interactive sessions too: crank on is part of launch and polish.
    const crank = input.crank;
    if (crank?.applicable) {
      if (!crank.observable) problems.push(`Crank not observable (${crank.error ?? "unknown"}); crank policy unverified`);
      else if (crank.enabled === false) problems.push(`crank is off (${crank.source ?? "default"}), mode is ${mode}; run: flume launch enable`);
    }
  } else if (enabled) {
    const why = declaration.mode === "live" ? "live: in production, no finish line"
      : declaration.mode === "absent" ? "absent, so develop: the default mode, no pass"
      : "develop: the default mode, no pass";
    problems.push(`Candybar ${input.names?.candybar ?? "<repo>-pm-launch-pass"} is enabled but ${LAUNCH_DECLARATION} is ${declaration.mode} (${why}); run: flume launch disable`);
  }
  return { problems, fixable };
}

export function launchStatus(repoArg: string | undefined, env: LaunchEnv = {}): LaunchStatus {
  const repoRoot = realOrResolved(repoArg ?? process.cwd());
  const declaration = readLaunchDeclaration(repoRoot);
  const found = pmDeskOf(repoRoot, env);
  const desk = found.desk;
  const names = desk ? launchNames(repoRoot, desk, env) : undefined;
  const candybarName = names?.candybar ?? `${basename(repoRoot)}-pm-launch-pass`;
  const candybar = candybarState(repoRoot, candybarName);
  const jobs = desk ? launchJobsOf(desk.profile, env) : [];
  const wrappers = names ? { monitor: wrapperOk(names.monitorPath, "monitor", names), brief: wrapperOk(names.briefPath, "brief", names) } : { monitor: false, brief: false };
  const manifest = names ? readManifest(names.manifestPath) : { exists: false };
  const extras = desksOfRepo(repoRoot, env).filter((d) => (RETIRED_LAUNCH_ROLES as readonly string[]).includes(d.role));
  const driver = names ? existsSync(names.driverPath) : false;
  const crank: CrankState = isActiveMode(declaration.mode) ? crankState(repoRoot) : { applicable: false, observable: true };
  const { problems } = launchProblems({ declaration, desk: found, deskExtras: extras, driver, wrappers, jobs, manifestExists: manifest.exists, candybar, crank, ...(names ? { names } : {}) });
  const job = jobs[0];
  const jobFacts = job ? {
    id: String(job.id), enabled: job.enabled !== false, scheduler: String(job.scheduler ?? "internal"),
    schedule: String(mapping(job.schedule)?.expr ?? job.schedule_display ?? ""),
    lastRun: typeof job.last_run_at === "string" ? job.last_run_at : null, lastStatus: typeof job.last_status === "string" ? job.last_status : null,
  } : null;
  const inSync = Boolean(manifest.facts && job && manifest.facts.jobId === job.id && manifest.facts.profile === desk?.profile
    && manifest.facts.schedule === jobFacts?.schedule && manifest.facts.name === names?.candybar);
  return {
    ok: problems.length === 0, repo: repoRoot, mode: declaration.mode,
    declaration: { path: declaration.path, mode: declaration.mode, epic: declaration.epic ?? null, declared: declaration.declared ?? null, polish: declaration.polish ?? null, error: declaration.error ?? null },
    desk: desk ? { id: desk.id, role: desk.role, profile: desk.profile, roleDir: desk.roleDir } : null,
    driver, wrappers, job: jobFacts,
    manifest: { path: names?.manifestPath ?? "", exists: manifest.exists, inSync },
    candybar: { ...candybar, lastRun: candybar.state === "unregistered" || !candybar.observable ? null : lastCandybarRun(repoRoot, candybarName) },
    crank,
    polish: declaration.mode === "polish" ? { metrics: desk ? readPolishMetrics(desk.roleDir) : null } : null,
    retiredDesks: extras.map((d) => `${d.id} (${d.role})`),
    problems,
  };
}

export function formatLaunchStatus(s: LaunchStatus): string {
  const lines = [
    `launch status: ${s.repo} (mode: ${s.mode})`,
    `  declaration  ${s.declaration.mode}${s.declaration.epic ? `  epic ${s.declaration.epic}` : ""}${s.declaration.declared ? `  declared ${s.declaration.declared}` : ""}`,
    `  pm desk      ${s.desk ? `${s.desk.id} (profile ${s.desk.profile})` : "none"}${s.desk && !s.driver ? "  [driver .scripts/launch-pass.py missing]" : ""}`,
    `  wrappers     monitor ${s.wrappers.monitor ? "ok" : "missing"}, brief ${s.wrappers.brief ? "ok" : "missing"}`,
    `  hermes job   ${s.job ? `${s.job.id} ${s.job.enabled ? "enabled" : "disabled"} scheduler=${s.job.scheduler} "${s.job.schedule}" last ${s.job.lastStatus ?? "never"}${s.job.lastRun ? ` at ${s.job.lastRun}` : ""}` : "none"}`,
    `  manifest     ${s.manifest.exists ? `${s.manifest.path} (${s.manifest.inSync ? "matches job" : "differs from job"})` : "missing"}`,
    `  candybar     ${s.candybar.state}${s.candybar.sync ? ` (sync ${s.candybar.sync})` : ""}${s.candybar.lastRun?.when ? `  last run ${s.candybar.lastRun.when} ${s.candybar.lastRun.result ?? ""}` : ""}`,
    `  crank        ${!s.crank.applicable ? "n/a (no .project.json)" : !s.crank.observable ? `unknown (${s.crank.error ?? "unreadable"})` : `${s.crank.enabled ? "on" : "off"}${s.crank.interval ? ` every ${s.crank.interval}` : ""}${s.crank.source ? ` (${s.crank.source})` : ""}`}`,
  ];
  if (s.polish) {
    const m = s.polish.metrics;
    lines.push(`  polish       ${m ? `${m.cycles} cycle(s), ${m.proposed} proposed, ${m.implemented} implemented${m.updatedAt ? ` (updated ${m.updatedAt})` : ""}` : "no cycles yet"}`);
  }
  if (s.retiredDesks.length) lines.push(`  retired roles still live: ${s.retiredDesks.join(", ")}`);
  lines.push(s.problems.length ? `problems:\n${s.problems.map((p) => `  - ${p}`).join("\n")}` : "ok");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------------------------

export interface LaunchAction { target: string; action: "create" | "update" | "adopt" | "unchanged" | "skip"; detail: string }
export interface LaunchPlan {
  ok: boolean;
  repo: string;
  operation: "enable" | "disable";
  dryRun: boolean;
  actions: LaunchAction[];
  changes: number;
  error?: string;
}

export interface LaunchOptions extends LaunchEnv { dryRun?: boolean; schedule?: string; timezone?: string }

function fail(repo: string, operation: LaunchPlan["operation"], dryRun: boolean, error: string): LaunchPlan {
  return { ok: false, repo, operation, dryRun, actions: [], changes: 0, error };
}

export function enableLaunch(repoArg: string | undefined, options: LaunchOptions = {}): LaunchPlan {
  const repoRoot = realOrResolved(repoArg ?? process.cwd());
  const dryRun = Boolean(options.dryRun);
  const bad = (error: string) => fail(repoRoot, "enable", dryRun, error);
  const declaration = readLaunchDeclaration(repoRoot);
  if (!isActiveMode(declaration.mode)) {
    return bad(`${LAUNCH_DECLARATION} must say \`mode: launch\` or \`mode: polish\` (it is ${declaration.mode}${declaration.error ? `: ${declaration.error}` : ""}); the owner declares the mode, flume never writes that file`);
  }
  const mode = declaration.mode;
  const otherMode: ActiveMode = mode === "polish" ? "launch" : "polish";
  if (options.schedule !== undefined && !SCHEDULE.test(options.schedule.trim())) return bad(`--schedule must be a 5-field cron expression, got "${options.schedule}"`);
  const found = pmDeskOf(repoRoot, options);
  if (!found.desk) return bad(found.error ?? "no pm desk");
  const desk = found.desk;
  const names = launchNames(repoRoot, desk, options);
  if (!existsSync(names.driverPath)) return bad(`${names.driverPath} is missing; the desk predates the launch driver. Run: flume remediate hermes.pm-scaffold ${repoRoot} --scripts-only`);
  if (!existsSync(join(envPaths(options).fleetHome, "profiles", desk.profile))) return bad(`Hermes profile ${desk.profile} does not exist under ${envPaths(options).fleetHome}/profiles`);

  const actions: LaunchAction[] = [];

  // 1. Wrappers (real files in the profile's scripts/; Hermes refuses symlinks)
  const wrapperTargets = [["monitor", names.monitorPath], ["brief", names.briefPath]] as const;
  const wrapperWrites: Array<() => void> = [];
  for (const [kind, path] of wrapperTargets) {
    if (wrapperOk(path, kind, names)) { actions.push({ target: path, action: "unchanged", detail: `exec ${names.driverPath} --${kind}` }); continue; }
    actions.push({ target: path, action: existsSync(path) ? "update" : "create", detail: `exec ${names.driverPath} --${kind}` });
    wrapperWrites.push(() => {
      mkdirSync(names.scriptsDir, { recursive: true });
      writeFileSync(path, wrapperText(kind, names), { mode: 0o755 });
      chmodSync(path, 0o755);
    });
  }

  // 2. The Hermes job: adopt an existing launch/polish job, else create one
  const existing = launchJobsOf(desk.profile, options);
  if (existing.length > 1) return bad(`profile ${desk.profile} has ${existing.length} launch jobs (${existing.map((j) => j.id).join(", ")}); keep one`);
  const job = existing[0];
  const explicitSchedule = options.schedule?.trim();
  const jobSchedule = job ? String(mapping(job.schedule)?.expr ?? "") : "";
  // Schedule precedence: --schedule > the declaration's polish.cadence > an adopted job's own
  // schedule > the mode default. A job still on the OTHER mode's factory default was never
  // hand-tuned: switching modes retunes it to this mode's default.
  const modeDefault = modeDefaultSchedule(mode, names.repo);
  const handTuned = jobSchedule && jobSchedule !== modeDefaultSchedule(otherMode, names.repo) ? jobSchedule : "";
  const schedule = explicitSchedule ?? (mode === "polish" ? declaration.polish?.cadence : undefined) ?? (handTuned || modeDefault);
  const maxIterations = mode === "polish" ? POLISH_MAX_ITERATIONS : MAX_ITERATIONS;
  let jobId = job ? String(job.id) : "";
  const jobTimezone = typeof job?.timezone === "string" && job.timezone ? job.timezone : "";
  const effectiveTz = options.timezone ?? (jobTimezone || DEFAULT_TIMEZONE);
  let jobPlan: { create?: Record<string, unknown>; updates: Record<string, unknown> };
  if (job) {
    const updates = jobUpdates(job, { schedule, timezone: effectiveTz, maxIterations });
    if (job.name === modeJobName(otherMode, names.label)) updates.name = modeJobName(mode, names.label);
    jobPlan = { updates };
    const keys = Object.keys(updates);
    actions.push({ target: `hermes job ${jobId} (${desk.profile})`, action: keys.length ? "update" : "adopt", detail: keys.length ? `set ${keys.join(", ")}` : "already lean and scheduler=external" });
  } else {
    jobPlan = {
      create: { prompt: JOB_PROMPT, schedule, name: modeJobName(mode, names.label), script: LAUNCH_BRIEF, monitor_script: LAUNCH_MONITOR, timezone: effectiveTz, reasoning_effort: REASONING_EFFORT },
      updates: { enabled_toolsets: LEAN_TOOLSETS, skills: [], skill: null, economics: { max_iterations: maxIterations } },
    };
    actions.push({ target: `hermes job (${desk.profile})`, action: "create", detail: `scheduler=external, schedule "${schedule}" ${effectiveTz}, lean (terminal,file,no_mcp; max_iterations ${maxIterations})` });
  }

  // 3. The Candybar manifest
  const manifest = readManifest(names.manifestPath);
  const manifestMatches = (id: string) => Boolean(manifest.facts && manifest.facts.name === names.candybar && manifest.facts.schedule === schedule
    && manifest.facts.timezone === effectiveTz && manifest.facts.profile === desk.profile && manifest.facts.jobId === id
    && (manifest.facts.header ?? "").startsWith(`# ${names.label} ${mode} pass`));
  let manifestWrite: ((id: string) => void) | undefined;
  if (job && manifestMatches(jobId)) actions.push({ target: names.manifestPath, action: "unchanged", detail: `${names.candybar} "${schedule}" ${effectiveTz}` });
  else {
    actions.push({ target: names.manifestPath, action: manifest.exists ? "update" : "create", detail: `${names.candybar} "${schedule}" ${effectiveTz} -> job ${jobId || "<new>"}` });
    manifestWrite = (id) => {
      mkdirSync(join(repoRoot, ".candybars"), { recursive: true });
      writeFileSync(names.manifestPath, manifestText(names, schedule, effectiveTz, desk.profile, id, mode));
    };
  }

  // 4. Candybar registration + enablement
  const cb = manifest.exists ? candybarState(repoRoot, names.candybar) : undefined;
  if (cb && !cb.observable) return bad(`cannot read Candybar state (${cb.error}); refusing to guess`);
  if (!manifestWrite && cb && cb.state === "enabled" && cb.sync === "ok") {
    actions.push({ target: `candybar ${names.candybar}`, action: "unchanged", detail: "registered, in sync, enabled" });
  } else {
    const registered = Boolean(cb && cb.state !== "unregistered");
    if (manifestWrite || !registered || (cb?.sync ?? "") !== "ok") {
      actions.push({ target: `candybar ${names.candybar}`, action: registered ? "update" : "create", detail: `candybar register --name ${names.candybar}${registered ? " --update" : ""}` });
    }
    if (manifestWrite || !cb || cb.state !== "enabled") actions.push({ target: `candybar ${names.candybar}`, action: "update", detail: "candybar resume (enabled)" });
  }

  // 5. Crank: an active mode (launch or polish) cranks the pjangler project's interactive sessions (pj owns the write)
  const crank = crankState(repoRoot);
  let crankInterval: string | undefined;
  if (!crank.applicable) { /* no .project.json: not a pjangler project, crank does not apply */ }
  else if (!crank.observable) actions.push({ target: "crank", action: "skip", detail: `unverified (${crank.error ?? "pj unreadable"}); run: pj crank enable` });
  else if (crank.enabled) actions.push({ target: "crank", action: "unchanged", detail: `on every ${crank.interval ?? "?"} (${crank.source ?? "?"})` });
  else {
    crankInterval = crank.interval ?? "5m";
    actions.push({ target: "crank", action: "update", detail: `pj crank enable --interval ${crankInterval}` });
  }

  const changes = actions.filter((a) => a.action === "create" || a.action === "update").length;
  const plan: LaunchPlan = { ok: true, repo: repoRoot, operation: "enable", dryRun, actions, changes };
  if (dryRun || changes === 0) return plan;

  // Apply, in dependency order: wrappers, job, manifest, register, resume.
  for (const write of wrapperWrites) write();
  if (jobPlan.create || Object.keys(jobPlan.updates).length) {
    const applied = applyJob(desk.profile, jobId || null, jobPlan.create, jobPlan.updates, options);
    if (!applied.ok || !applied.job) return { ...plan, ok: false, error: applied.error ?? "Hermes job update failed" };
    jobId = String(applied.job.id);
    if (applied.job.scheduler !== "external") return { ...plan, ok: false, error: `Hermes job ${jobId} is not scheduler=external after update; refusing to leave a second clock` };
  }
  if (manifestWrite) manifestWrite(jobId);
  const state = candybarState(repoRoot, names.candybar);
  if (!state.observable) return { ...plan, ok: false, error: state.error ?? "candybar unreadable" };
  if (state.state === "unregistered" || (state.sync ?? "") !== "ok") {
    const reg = runCandybar(["register", "--name", names.candybar, ...(state.state === "unregistered" ? [] : ["--update"])], repoRoot);
    if (reg.status !== 0) return { ...plan, ok: false, error: `candybar register failed: ${String(reg.stderr || reg.stdout).trim().slice(0, 300)}` };
  }
  const after = candybarState(repoRoot, names.candybar);
  if (after.state !== "enabled") {
    const resume = runCandybar(["resume", names.candybar], repoRoot);
    if (resume.status !== 0) return { ...plan, ok: false, error: `candybar resume failed: ${String(resume.stderr || resume.stdout).trim().slice(0, 300)}` };
  }
  const final = candybarState(repoRoot, names.candybar);
  if (final.state !== "enabled") return { ...plan, ok: false, error: `candybar ${names.candybar} is ${final.state} after enable` };
  if (crankInterval) {
    const on = runPj(["crank", "enable", "--interval", crankInterval], repoRoot, 120_000);
    if (on.error || on.status !== 0) return { ...plan, ok: false, error: `pj crank enable failed: ${String(on.error?.message ?? on.stderr ?? on.stdout).trim().slice(0, 300)}` };
    const after = crankState(repoRoot);
    if (!after.enabled) return { ...plan, ok: false, error: "crank is still off after pj crank enable" };
  }
  return plan;
}

export function disableLaunch(repoArg: string | undefined, options: LaunchOptions = {}): LaunchPlan {
  const repoRoot = realOrResolved(repoArg ?? process.cwd());
  const dryRun = Boolean(options.dryRun);
  const found = pmDeskOf(repoRoot, options);
  const name = found.desk ? launchNames(repoRoot, found.desk, options).candybar : `${basename(repoRoot)}-pm-launch-pass`;
  const state = candybarState(repoRoot, name);
  if (!state.observable) return fail(repoRoot, "disable", dryRun, `cannot read Candybar state (${state.error}); refusing to guess`);
  if (state.state !== "enabled") {
    return { ok: true, repo: repoRoot, operation: "disable", dryRun, changes: 0, actions: [{ target: `candybar ${name}`, action: "unchanged", detail: state.state === "unregistered" ? "not registered, nothing to pause" : `already ${state.state}` }] };
  }
  const plan: LaunchPlan = { ok: true, repo: repoRoot, operation: "disable", dryRun, changes: 1, actions: [{ target: `candybar ${name}`, action: "update", detail: "candybar pause (manifest and Hermes job kept)" }] };
  if (dryRun) return plan;
  const pause = runCandybar(["pause", name], repoRoot);
  if (pause.status !== 0) return { ...plan, ok: false, error: `candybar pause failed: ${String(pause.stderr || pause.stdout).trim().slice(0, 300)}` };
  const after = candybarState(repoRoot, name);
  if (after.state === "enabled") return { ...plan, ok: false, error: `candybar ${name} is still enabled after pause` };
  return plan;
}

export function formatLaunchPlan(plan: LaunchPlan): string {
  const verb = plan.dryRun ? "would" : "did";
  const lines = [`launch ${plan.operation}${plan.dryRun ? " (dry run)" : ""}: ${plan.repo}`];
  for (const a of plan.actions) lines.push(`  ${a.action.padEnd(9)} ${a.target}  ${a.detail}`);
  if (plan.error) lines.push(`error: ${plan.error}`);
  else lines.push(plan.changes === 0 ? "nothing to change" : `${verb} ${plan.changes} change(s)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Audit rule: hermes.launch-mode (project scope)
// ---------------------------------------------------------------------------------------------

const LAUNCH_MODE_ID = "hermes.launch-mode";
const LAUNCH_MODE_TITLE = "Launch passes and crank follow .launch.yaml, and no retired launch role is live";

interface LaunchModeReading {
  skip: boolean;
  problems: string[];
  warnings: string[];
  fixable: boolean;
  checked: string;
}

function readLaunchMode(repoRoot: string, homeDir: string): LaunchModeReading {
  const env: LaunchEnv = { home: homeDir };
  const declaration = readLaunchDeclaration(repoRoot);
  const desks = desksOfRepo(repoRoot, env);
  const hasCandybars = existsSync(join(repoRoot, ".candybars"));
  if (!declaration.exists && desks.length === 0 && !hasCandybars) return { skip: true, problems: [], warnings: [], fixable: false, checked: "" };
  const found = pmDeskOf(repoRoot, env);
  const names = found.desk ? launchNames(repoRoot, found.desk, env) : undefined;
  const candybarName = names?.candybar ?? `${basename(repoRoot)}-pm-launch-pass`;
  const candybar: CandybarState = isActiveMode(declaration.mode) || hasCandybars ? candybarState(repoRoot, candybarName) : { observable: true, state: "unregistered" };
  const jobs = found.desk ? launchJobsOf(found.desk.profile, env) : [];
  const wrappers = names ? { monitor: wrapperOk(names.monitorPath, "monitor", names), brief: wrapperOk(names.briefPath, "brief", names) } : { monitor: false, brief: false };
  const extras = desks.filter((d) => (RETIRED_LAUNCH_ROLES as readonly string[]).includes(d.role));
  const crank: CrankState = isActiveMode(declaration.mode) ? crankState(repoRoot) : { applicable: false, observable: true };
  const { problems: all, fixable } = launchProblems({
    declaration, desk: found, deskExtras: extras, driver: names ? existsSync(names.driverPath) : false, wrappers, jobs,
    manifestExists: names ? existsSync(names.manifestPath) : false, candybar, crank, ...(names ? { names } : {}),
  });
  const warnings = all.filter((p) => p.startsWith("Candybar not observable") || p.startsWith("Crank not observable"));
  return { skip: false, problems: all.filter((p) => !warnings.includes(p)), warnings, fixable, checked: `mode ${declaration.mode}, ${desks.length} desk(s)` };
}

export const launchModeCheck: RecipeOwnedCheck = {
  id: LAUNCH_MODE_ID,
  title: LAUNCH_MODE_TITLE,
  audit: (ctx) => {
    const base = { id: LAUNCH_MODE_ID, title: LAUNCH_MODE_TITLE };
    const reading = readLaunchMode(ctx.repoRoot, ctx.homeDir);
    if (reading.skip) return { ...base, status: "skip", summary: "No launch declaration, desk or Candybar manifest in this repo", details: [], fixable: false };
    if (reading.problems.length) {
      return { ...base, status: "fail", summary: `${reading.problems.length} launch-mode problem(s) (${reading.checked})`, details: [...reading.problems, ...reading.warnings], fixable: reading.fixable };
    }
    if (reading.warnings.length) return { ...base, status: "warn", summary: `launch pass state unverified (${reading.checked})`, details: reading.warnings, fixable: false };
    return { ...base, status: "pass", summary: `launch mode consistent (${reading.checked})`, details: [], fixable: false };
  },
  migrate: (ctx, finding) => {
    const base = { id: finding.id, title: finding.title, changedFiles: [] as string[] };
    const declaration = readLaunchDeclaration(ctx.repoRoot);
    const reading = readLaunchMode(ctx.repoRoot, ctx.homeDir);
    if (reading.skip || reading.problems.length === 0) return { ...base, status: "noop", summary: "launch mode already consistent", details: [] };
    if (!reading.fixable) {
      return { ...base, status: "blocked", summary: "Retired roles and a missing driver are per-employee decisions: offboard the employee (flume offboard <id> --apply), convert em to pm (docs/launch-mode.md), or refresh the desk scripts", details: reading.problems };
    }
    const env: LaunchEnv = { home: ctx.homeDir };
    const plan = isActiveMode(declaration.mode) ? enableLaunch(ctx.repoRoot, { ...env, dryRun: ctx.dryRun }) : disableLaunch(ctx.repoRoot, { ...env, dryRun: ctx.dryRun });
    const details = plan.actions.filter((a) => a.action !== "unchanged" && a.action !== "adopt").map((a) => `${a.action} ${a.target}: ${a.detail}`);
    if (!plan.ok) return { ...base, status: "blocked", summary: plan.error ?? `flume launch ${plan.operation} failed`, details };
    return { ...base, status: plan.changes ? "applied" : "noop", summary: `flume launch ${plan.operation}${ctx.dryRun ? " (dry run)" : ""}: ${plan.changes} change(s)`, details };
  },
};
