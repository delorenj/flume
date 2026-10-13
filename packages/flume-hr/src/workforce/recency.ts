import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { identityCensus, resolveEmployee, type IdentityBlocker, type IdentityDefinition } from "./company";

/**
 * FLUME-55: the named-agent recall compass.
 *
 * A named agent that holds no repo-bound post has no bound directory to anchor
 * project context to. This is the deterministic component that fills that hole:
 * a machine-owned, most-recent-first list of the last 5 projects a person
 * interacted with, used to narrow personal-bank recall. No LLM touches the
 * write path; the list is data, never prompt text.
 *
 * Memory taxonomy (operator decision 2026-10-12):
 *   - Personal bank = episodic/narrative ("today I integrated Pilot into 33GOD").
 *   - Project banks = project facts. Recency only re-orders/narrows the
 *     DECLARED recall set; it never writes to a project bank and never invents
 *     bank membership.
 *
 * State: one small JSON document per person at
 *   $HERMES_FLEET_HOME/recency/<employee>.json  (default ~/.hermes/recency/)
 * — fleet machine state, uniform for post-holders and portable specialists,
 * never written into a tracked role definition or an authored desk file.
 * Writes are preview-by-default, atomic (same-dir temp + rename), and refused
 * for unknown or unnamed employees.
 */

export const RECENCY_CAP = 5;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export interface RecencyEntry { project: string; last_seen: string; source: string }
export interface RecencyState { version: 1; employee: string; entries: RecencyEntry[] }
export interface RecencyOptions { apply?: boolean; at?: string; source?: string }

function fleetHome(): string {
  return process.env.HERMES_FLEET_HOME || join(process.env.HOME || homedir(), ".hermes");
}

function recencyPath(employee: string): string {
  return join(fleetHome(), "recency", `${employee}.json`);
}

function stat(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** The employee must resolve to a NAMED person: recency is personal, never post-scoped. */
function namedTarget(employee: string): { target?: IdentityDefinition; blockers: IdentityBlocker[] } {
  const census = identityCensus();
  let target: IdentityDefinition;
  try { target = resolveEmployee(census, employee); } catch (error) {
    return { blockers: [{ code: "unknown-employee", detail: (error as Error).message }] };
  }
  const blockers: IdentityBlocker[] = [];
  if (target.missing) blockers.push({ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path });
  else if (target.problem) blockers.push({ code: "invalid-definition", detail: target.problem, path: target.path });
  else if (stat(target.path)?.isSymbolicLink()) blockers.push({ code: "invalid-definition", detail: `refusing symlinked definition ${target.path}`, path: target.path });
  else if (!target.person) blockers.push({ code: "unnamed", detail: `${employee} is not a named person; recency is personal, not post-scoped`, path: target.path });
  return { target, blockers };
}

export function readRecency(employee: string) {
  const { target, blockers } = namedTarget(employee);
  if (blockers.length) return { ok: false, employee, entries: [] as RecencyEntry[], blockers };
  const path = recencyPath(target!.person!);
  if (!existsSync(path)) return { ok: true, employee: target!.person, entries: [] as RecencyEntry[], blockers, exists: false, path };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return { ok: false, employee: target!.person, entries: [] as RecencyEntry[], blockers: [{ code: "invalid-state", detail: `recency state unreadable: ${(error as Error).message}`, path }] };
  }
  const state = parsed as Partial<RecencyState> | null;
  if (!state || state.version !== 1 || state.employee !== target!.person || !Array.isArray(state.entries)
      || state.entries.some(e => !e || typeof e.project !== "string" || !PROJECT.test(e.project) || typeof e.last_seen !== "string" || Number.isNaN(Date.parse(e.last_seen)) || typeof e.source !== "string")) {
    return { ok: false, employee: target!.person, entries: [] as RecencyEntry[], blockers: [{ code: "invalid-state", detail: `recency state at ${path} is not a version-1 document for ${target!.person}`, path }] };
  }
  return { ok: true, employee: target!.person, entries: state.entries as RecencyEntry[], blockers, exists: true, path };
}

function writeAtomic(path: string, bytes: string): string {
  const info = stat(path);
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`Refusing non-regular recency state ${path}`);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.recency-${process.pid}.tmp`;
  try { writeFileSync(tmp, bytes, { mode: 0o600 }); renameSync(tmp, path); }
  catch (error) { rmSync(tmp, { force: true }); throw error; }
  return path;
}

/** Record an agent↔project interaction. Preview unless apply. */
export async function touchProject(employee: string, project: string, options: RecencyOptions = {}) {
  const blockers: IdentityBlocker[] = [];
  if (!PROJECT.test(project)) blockers.push({ code: "invalid-project", detail: `project "${project}" must match ${PROJECT.source}` });
  const at = options.at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) blockers.push({ code: "invalid-project", detail: `--at must be an ISO timestamp, got "${at}"` });
  const { target, blockers: named } = namedTarget(employee);
  blockers.push(...named);
  const current: { ok: boolean; entries: RecencyEntry[]; blockers: IdentityBlocker[] } =
    blockers.length ? { ok: false, entries: [], blockers: [] } : readRecency(employee);
  if (!current.ok && !blockers.length) blockers.push(...current.blockers);
  const prior = current.ok ? current.entries! : [];
  const next: RecencyEntry[] = [
    { project, last_seen: at, source: options.source ?? "manual" },
    ...prior.filter(e => e.project !== project),
  ].slice(0, RECENCY_CAP);
  const changed = JSON.stringify(next) !== JSON.stringify(prior);
  const person = target?.person ?? employee;
  const path = recencyPath(person);
  const writes: string[] = [];
  if (!blockers.length && options.apply && changed) {
    writeAtomic(path, `${JSON.stringify({ version: 1, employee: person, entries: next }, null, 2)}\n`);
    writes.push(path);
  }
  return {
    ok: blockers.length === 0, apply: Boolean(options.apply), changed,
    employee: person, project, entries: next, previous: prior, cap: RECENCY_CAP,
    blockers, writes,
    note: "Machine-owned recency state only; no project bank was written and recall membership is unchanged.",
  };
}

/** Declared personal recall banks from the owning definition (post identity block or specialist memory block). */
function declaredBanks(target: IdentityDefinition): { writeBank: string; recallBanks: string[] } | null {
  try {
    const doc = (YAML.parse(target.text) ?? {}) as Record<string, unknown>;
    if (target.kind === "post") {
      const identity = (doc.identity ?? {}) as Record<string, unknown>;
      const name = typeof identity.name === "string" ? identity.name : "";
      if (!name) return null;
      const recall = Array.isArray(identity.recall_banks) ? identity.recall_banks.filter((b): b is string => typeof b === "string") : [];
      return { writeBank: `agent-${name}`, recallBanks: recall };
    }
    const memory = (doc.memory ?? {}) as Record<string, unknown>;
    if (typeof memory.write_bank !== "string") return null;
    const recall = Array.isArray(memory.recall_banks) ? memory.recall_banks.filter((b): b is string => typeof b === "string") : [];
    return { writeBank: memory.write_bank, recallBanks: recall };
  } catch { return null; }
}

/**
 * The effective personal recall list for a named agent, in priority order:
 * write bank first, then the DECLARED recall banks re-ordered most-recently-
 * interacted first, then the rest in declared order. With narrow=true the
 * declared set is INTERSECTED with recent projects instead of re-ordered —
 * the narrowing the recall compass exists for. Recency never adds a bank the
 * definition did not declare, and an empty list narrows nothing.
 */
export function effectiveRecall(employee: string, options: { narrow?: boolean } = {}) {
  const { target, blockers } = namedTarget(employee);
  const declared = target && !blockers.length ? declaredBanks(target) : null;
  if (!blockers.length && !declared) blockers.push({ code: "unnamed", detail: `${employee} declares no personal memory banks`, path: target?.path });
  if (blockers.length) return { ok: false, employee, write_bank: null, recall_banks: [] as string[], blockers };
  const current = readRecency(employee);
  if (!current.ok) return { ok: false, employee: target!.person, write_bank: null, recall_banks: [] as string[], blockers: current.blockers! };
  const declaredSet = new Set(declared!.recallBanks);
  const recentProjects = current.entries!.map(e => e.project);
  const recentDeclared = recentProjects.filter(p => declaredSet.has(p));
  const remainder = declared!.recallBanks.filter(b => !recentDeclared.includes(b));
  // An empty recency list narrows nothing, never an error: --narrow behaves
  // like the ordered list until the person has interacted with something.
  const recallBanks = options.narrow && recentDeclared.length
    ? [...new Set([declared!.writeBank, ...recentDeclared])]
    : [...new Set([declared!.writeBank, ...recentDeclared, ...remainder])];
  return {
    ok: true, employee: target!.person, write_bank: declared!.writeBank,
    narrow: Boolean(options.narrow),
    recent_projects: recentProjects,
    recall_banks: recallBanks,
    blockers,
    note: "Recall ordering/narrowing over the declared set only; project banks and bank membership are unchanged.",
  };
}
