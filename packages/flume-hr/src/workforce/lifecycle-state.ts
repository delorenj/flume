// FLUME-53: the lifecycle's convergence state, ledger and tombstones.
//
// Two files under `identityStateDir()`: `lifecycle-state.json` (what each provider-mutating step already did, what a
// suspension captured so restore can put it back, retired-identity tombstones, continuity baselines) and the append-only
// `lifecycle-ledger.jsonl`. The directory is mode 0700 and both files 0600. Both are secret-free: IDs, `op://`
// references, step keys, outcomes and provider codes. Never a token, key, client secret or mail body.
//
// This module is deliberately small and imports no lifecycle logic, so `company.ts` can consult tombstones without a
// cycle through the coordinator.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { identityStateDir } from "./plane";
import { withRegistryLock } from "./role";

export const LIFECYCLE_STATE_FILE = "lifecycle-state.json";
export const LIFECYCLE_LEDGER_FILE = "lifecycle-ledger.jsonl";

export type StepStatus = "done" | "converged" | "unresolved";
export interface StepRecord { status: StepStatus; operation_id: string; at: string; provider_code?: string; data?: Record<string, unknown> }
export interface TombstoneBinding { provider: string; principal: string; instance?: string }
export interface Tombstone { subject: string; handle: string; email: string; bindings: TombstoneBinding[]; retired_at: string; operation_id: string }
export interface ContinuityBaseline {
  recorded_at: string;
  subject: string; handle: string; email: string; mailbox_prefix: string;
  bindings: Record<string, { principal: string; instance?: string; native_actor_id?: string; credential_ref?: string }>;
  definition: string; posts: string[];
}
export interface LifecycleState {
  version: 1;
  /** subject -> step key -> record. */
  steps: Record<string, Record<string, StepRecord>>;
  /** subject -> what a suspension took, so restore can put exactly it back. */
  captures: Record<string, Record<string, unknown>>;
  tombstones: Record<string, Tombstone>;
  continuity: Record<string, ContinuityBaseline>;
}

export const emptyLifecycleState = (): LifecycleState => ({ version: 1, steps: {}, captures: {}, tombstones: {}, continuity: {} });

export const lifecycleStatePath = (env: NodeJS.ProcessEnv = process.env): string => join(identityStateDir(env), LIFECYCLE_STATE_FILE);
export const lifecycleLedgerPath = (env: NodeJS.ProcessEnv = process.env): string => join(identityStateDir(env), LIFECYCLE_LEDGER_FILE);

function ensureDir(env: NodeJS.ProcessEnv): string {
  const dir = identityStateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * The state, or an empty one when no lifecycle command has ever applied. A file that exists and cannot be read is an
 * error: tombstones are a safety rail, and a rail that silently reads as empty is not one.
 */
export function readLifecycleState(env: NodeJS.ProcessEnv = process.env): LifecycleState {
  const path = lifecycleStatePath(env);
  if (!existsSync(path)) return emptyLifecycleState();
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked lifecycle state ${path}`);
  let parsed: Partial<LifecycleState>;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`Lifecycle state ${path} is not valid JSON: ${(error as Error).message.split("\n")[0]}`); }
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) throw new Error(`Lifecycle state ${path} has an unknown version`);
  return { ...emptyLifecycleState(), ...parsed };
}

/** Atomic replace (temporary file, then rename), mode 0600. */
export function writeLifecycleState(state: LifecycleState, env: NodeJS.ProcessEnv = process.env): string {
  const dir = ensureDir(env), path = join(dir, LIFECYCLE_STATE_FILE), temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return path;
}

/** One secret-free ledger line (mode 0600). */
export function appendLifecycleLedger(line: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string {
  const dir = ensureDir(env), path = join(dir, LIFECYCLE_LEDGER_FILE);
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function readLifecycleLedger(env: NodeJS.ProcessEnv = process.env): Array<Record<string, any>> {
  const path = lifecycleLedgerPath(env);
  if (!existsSync(path)) return [];
  const lines: Array<Record<string, any>> = [];
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try { lines.push(JSON.parse(text)); } catch { /* a torn line is not a record */ }
  }
  return lines;
}

/**
 * Hold the lifecycle lock for the whole of an apply. This is `flock` on `<state file>.lock` and nothing else: it must
 * never be taken inside the registry lock, nor wrap a call that takes it (`setEmployeeStatus` does), because flock is
 * not re-entrant. The two locks are different files, and are always taken in this order.
 */
export async function withLifecycleLock<T>(action: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  ensureDir(env);
  return withRegistryLock(lifecycleStatePath(env), async () => {
    const lock = `${lifecycleStatePath(env)}.lock`;
    if (existsSync(lock)) chmodSync(lock, 0o600);
    return action();
  });
}

/** Every tombstone, keyed by subject. Empty when there is no state file. */
export const readTombstones = (env: NodeJS.ProcessEnv = process.env): Tombstone[] => Object.values(readLifecycleState(env).tombstones);
