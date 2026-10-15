// FLUME-53: the lifecycle coordinator. Suspend, restore and retire an employee's access without losing who they were.
//
// The shape of every operation:
//   * Preview by default. A preview reads (Cloudflare and GitHub GETs, `px identity verify`, `gateway-tokens status`) and
//     writes NOTHING: no definition, no state or ledger file, no provider mutation. A blocker is known before any provider call.
//   * Local status is written FIRST on suspend/retire and LAST on restore. The facade reads status on every request, so a
//     crash or a provider outage in between fails closed: the employee is denied, never half-restored.
//   * Each provider-mutating step has a resource-scoped key (`cloudflare_access:token-delete:<client_id>`). A step recorded
//     `done` or `converged` is never executed again, by this operation or a later one in the same suspension episode; it is
//     reported `already-done` with its original `operation_id`. An `unresolved` step is simply tried again next run. A 404
//     on a DELETE, an already-suspended installation or `revoked 0 tokens` is `converged`, not a failure.
//   * The result never says "complete" while a static credential is usable or unverified: `complete_revocation` is true only
//     when every row is `revoked` or `not-issued`, and the text output says `revocation INCOMPLETE` otherwise.
//
// State is `<identityStateDir()>/lifecycle-state.json` (0600 in a 0700 directory) held under its own lock for the whole of an
// apply. The registry lock is never taken here: `setEmployeeStatus` takes it itself and flock is not re-entrant.
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { identityCensus, resolveEmployee, setEmployeeStatus, type IdentityBlocker, type IdentityCensus, type IdentityDefinition } from "./company";
import {
  ADAPTER_ORDER, DEFAULT_ADAPTERS, REVOCABLE, gatewayLink,
  type AdapterName, type CredentialRow, type EmploymentStatus, type LifecycleAdapter, type LifecycleContext, type PlannedStep, type StepOutcome,
} from "./lifecycle-adapters";
import {
  appendLifecycleLedger, lifecycleLedgerPath, lifecycleStatePath, readLifecycleState, withLifecycleLock, writeLifecycleState,
  type ContinuityBaseline, type LifecycleState, type StepRecord, type Tombstone,
} from "./lifecycle-state";
import { readPlaneReceipts } from "./plane";
import type { CompanyIdentity } from "./types";

export type LifecycleCommand = "suspend" | "restore" | "retire" | "credentials" | "continuity";
export interface LifecycleOptions {
  apply?: boolean;
  /** `--revoke`, repeatable: cloudflare_access | github | gateway (retire also accepts `all`). */
  revoke?: string[];
  /** Inject provider adapters (tests and future providers); the defaults are the real ones. */
  adapters?: Partial<Record<AdapterName, LifecycleAdapter>>;
  env?: NodeJS.ProcessEnv;
}

export interface StepReport {
  key: string;
  adapter: string;
  action: string;
  resource: string;
  outcome: "planned" | "done" | "converged" | "already-done" | "unresolved" | "skipped";
  operation_id?: string;
  provider_code?: string;
  detail?: string;
}

const adaptersOf = (options: LifecycleOptions): Record<AdapterName, LifecycleAdapter> => ({ ...DEFAULT_ADAPTERS, ...(options.adapters ?? {}) });

/** The order is the story's: sorted by REVOCABLE, never by the order the operator typed them. */
function revokeSet(command: "suspend" | "retire", requested: string[] | undefined): { revoke: AdapterName[]; blockers: IdentityBlocker[] } {
  const blockers: IdentityBlocker[] = [];
  const chosen = new Set<AdapterName>();
  for (const name of requested ?? []) {
    if (name === "all") {
      if (command === "retire") for (const adapter of REVOCABLE) chosen.add(adapter);
      else blockers.push({ code: "invalid-request", detail: "--revoke all is for retire; suspend names each adapter (cloudflare_access, github, gateway)" });
    } else if ((REVOCABLE as readonly string[]).includes(name)) chosen.add(name as AdapterName);
    else if (name === "plane") blockers.push({ code: "invalid-request", detail: "--revoke plane: a Plane PAT is employee-owned and static; Flume has no Plane client or revoke verb (the credentials report names the manual route)" });
    else if (name === "mail") blockers.push({ code: "invalid-request", detail: "--revoke mail: the mailbox is closed by suspend itself; there is nothing to name" });
    else blockers.push({ code: "invalid-request", detail: `--revoke "${name}" is not an adapter; use ${REVOCABLE.join(", ")}${command === "retire" ? " or all" : ""}` });
  }
  return { revoke: REVOCABLE.filter(name => chosen.has(name)), blockers };
}

interface Prepared {
  blockers: IdentityBlocker[];
  target: IdentityDefinition;
  census: IdentityCensus;
  block: CompanyIdentity | null;
}

function prepare(employee: string): Prepared {
  const census = identityCensus();
  const target = resolveEmployee(census, employee);
  const blockers: IdentityBlocker[] = [];
  if (target.missing) blockers.push({ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path });
  else if (target.problem) blockers.push({ code: "invalid-definition", detail: target.problem, path: target.path });
  else if (target.path && isSymlink(target.path)) blockers.push({ code: "invalid-definition", detail: `refusing symlinked definition ${target.path}`, path: target.path });
  else if (!target.block) blockers.push({ code: "not-enrolled", detail: `${employee} has no company identity; run flume identity enroll ${employee} --apply first` });
  return { blockers, target, census, block: target.block };
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function contextOf(employee: string, prepared: Prepared, state: LifecycleState, env: NodeJS.ProcessEnv): LifecycleContext {
  const block = prepared.block!;
  return {
    employee, target: prepared.target, census: prepared.census, block, status: block.status as EmploymentStatus,
    steps: (state.steps[block.subject] ??= {}), captures: (state.captures[block.subject] ??= {}), env, cache: new Map(),
  };
}

/** Reads of every adapter, in a fixed order. A row list is never empty: each adapter says something even when it has nothing. */
async function inventoryAll(ctx: LifecycleContext, adapters: Record<AdapterName, LifecycleAdapter>): Promise<CredentialRow[]> {
  const rows: CredentialRow[] = [];
  for (const name of ADAPTER_ORDER) {
    try { rows.push(...await adapters[name].inventory(ctx)); }
    catch (error) {
      rows.push({ provider: name, kind: "inventory", static: false, status: "unresolved", provider_code: "internal-error", evidence: "fixture", next_action: `flume identity credentials ${ctx.employee}`, detail: firstLine(error) });
    }
  }
  return finalizeRows(rows, ctx.status);
}

/** A retired employee never "has static-usable" credentials: what is still usable needs a person. */
function finalizeRows(rows: CredentialRow[], status: EmploymentStatus): CredentialRow[] {
  return rows.map(row => {
    const next = { ...row };
    if (next.status === "revoked" && !next.read_back) { next.status = "unverified"; next.provider_code = "no-read-back"; }
    if (status === "retired" && next.status === "static-usable") next.status = "manual-action-required";
    return next;
  });
}

/** Stored mail is history: it is kept, and still addressed by the same prefix, whatever happens to access. */
const historyOf = (block: CompanyIdentity | null) => (block ? { history: { mailbox_prefix: `mail/${block.handle}/`, stored_mail: "kept" } } : {});

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
const DONE = new Set(["done", "converged"]);

function revocationSummary(rows: CredentialRow[]) {
  const incomplete = rows.filter(row => row.status !== "revoked" && row.status !== "not-issued")
    .map(row => ({ provider: row.provider, kind: row.kind, ...(row.id ? { id: row.id } : {}), ...(row.ref ? { ref: row.ref } : {}), status: row.status, ...(row.provider_code ? { provider_code: row.provider_code } : {}) }));
  return { complete_revocation: rows.length > 0 && incomplete.length === 0, incomplete };
}

const stepReport = (step: PlannedStep, outcome: StepReport["outcome"], extra: Partial<StepReport> = {}): StepReport => ({ key: step.key, adapter: step.adapter, action: step.action, resource: step.resource, outcome, ...extra });

const localStep = (employee: string, to: string): StepReport => ({ key: `local-status:${to}`, adapter: "local", action: "set-status", resource: employee, outcome: "planned" });

function summarize(reports: StepReport[]) {
  return {
    succeeded: reports.filter(r => ["done", "converged", "already-done"].includes(r.outcome)).map(r => r.key),
    unresolved: reports.filter(r => r.outcome === "unresolved").map(r => ({ key: r.key, adapter: r.adapter, provider_code: r.provider_code ?? "unresolved" })),
  };
}

// ---------------------------------------------------------------------------
// suspend / retire
// ---------------------------------------------------------------------------

async function suspendOrRetire(command: "suspend" | "retire", employee: string, options: LifecycleOptions) {
  const env = options.env ?? process.env;
  const adapters = adaptersOf(options);
  const to: "suspended" | "retired" = command === "suspend" ? "suspended" : "retired";
  const apply = Boolean(options.apply);
  const { revoke, blockers: revokeBlockers } = revokeSet(command, options.revoke);

  /** Everything knowable without a provider call. */
  const assess = (state: LifecycleState) => {
    const prepared = prepare(employee);
    const blockers = [...revokeBlockers, ...prepared.blockers];
    if (prepared.block?.status === "retired" && command === "suspend") blockers.push({ code: "retired-terminal", detail: "a retired identity is a tombstone; it cannot be suspended" });
    // A definition carrying a retired subject without being retired is a hand-copy (or a hand-edit): refused before anything is written.
    if (prepared.block && prepared.block.status !== "retired" && state.tombstones[prepared.block.subject]) blockers.push({ code: "retired-terminal", detail: `subject ${prepared.block.subject} was retired ${state.tombstones[prepared.block.subject]!.retired_at}; it never returns to service` });
    let ctx: LifecycleContext | undefined;
    if (prepared.block) {
      ctx = contextOf(employee, prepared, state, env);
      // An active employee starts a NEW episode. Records of steps restore cannot reverse (an Access token, a gateway token) or
      // left by an out-of-band reactivation must not make the next suspension report already-done. Suspended -> retired and
      // retries keep theirs.
      if (prepared.block.status === "active") { for (const key of Object.keys(ctx.steps)) delete ctx.steps[key]; for (const key of Object.keys(ctx.captures)) delete ctx.captures[key]; }
      for (const name of revoke) blockers.push(...adapters[name].blockers(ctx, { command, revoke: true }));
    }
    return { prepared, blockers, ctx };
  };
  const planOf = (ctx: LifecycleContext): PlannedStep[] => {
    const steps: PlannedStep[] = [];
    steps.push(...adapters.mail.plan(ctx, { command, revoke: false }));
    for (const name of REVOCABLE) if (revoke.includes(name)) steps.push(...adapters[name].plan(ctx, { command, revoke: true }));
    return steps;
  };
  const base = (prepared: Prepared) => ({ command, employee, apply, kind: prepared.target.kind, definition: prepared.target.path, person: prepared.target.person, from: prepared.block?.status ?? null, to, revoke, ...historyOf(prepared.block) });

  const firstState = readLifecycleState(env);
  const first = assess(firstState);
  if (first.blockers.length || !first.ctx) return { ok: false, ...base(first.prepared), blockers: first.blockers, steps: [] as StepReport[], credentials: [] as CredentialRow[], complete_revocation: false, incomplete: [] as unknown[], writes: [] as string[] };

  if (!apply) {
    const ctx = first.ctx;
    const reports: StepReport[] = [{ ...localStep(employee, to), detail: ctx.block.status === to ? `already ${to}` : `${ctx.block.status} -> ${to}` }];
    if (command === "retire") reports.push({ key: "tombstone", adapter: "local", action: "tombstone", resource: ctx.block.subject, outcome: "planned" });
    for (const step of planOf(ctx)) {
      const prior = ctx.steps[step.key];
      reports.push(prior && DONE.has(prior.status) ? stepReport(step, "already-done", { operation_id: prior.operation_id, detail: step.description }) : stepReport(step, "planned", { detail: step.description }));
    }
    // The preview shows what is usable NOW: status is still the old one.
    const rows = await inventoryAll(ctx, adapters);
    return { ok: true, ...base(first.prepared), blockers: first.blockers, steps: reports, credentials: rows, ...revocationSummary(rows), gateway_link: gatewayLink(env), writes: [] as string[], note: "Preview only: nothing was written and no provider was mutated. Pass --apply." };
  }

  const operationId = randomUUID();
  return withLifecycleLock(async () => {
    // Re-assessed under the lock: another operation may have finished while this one waited.
    const state = readLifecycleState(env);
    const now = assess(state);
    if (now.blockers.length || !now.ctx) return { ok: false, ...base(now.prepared), operation_id: operationId, blockers: now.blockers, steps: [] as StepReport[], credentials: [] as CredentialRow[], complete_revocation: false, incomplete: [] as unknown[], writes: [] as string[] };
    const ctx = now.ctx, block = ctx.block;
    const who = { operation_id: operationId, command, employee, handle: block.handle, subject: block.subject };
    const writes = new Set<string>();
    const persist = () => { writes.add(writeLifecycleState(state, env)); };
    const ledger = (line: Record<string, unknown>) => { writes.add(appendLifecycleLedger({ ...who, ...line }, env)); };
    const reports: StepReport[] = [];
    ledger({ event: "lifecycle.operation", phase: "started", revoke, from: block.status, to });

    // 1. Local status, first. If it cannot be written nothing else is attempted: the next request would not be denied.
    const status = await setEmployeeStatus(employee, to, { apply: true });
    const local: StepReport = { ...localStep(employee, to), outcome: status.ok ? (status.changed ? "done" : "converged") : "unresolved", ...(status.ok ? { detail: status.changed ? `${block.status} -> ${to}` : `already ${to}` } : { provider_code: status.blockers[0]?.code ?? "status-refused", detail: status.blockers[0]?.detail }) };
    reports.push(local);
    ledger({ event: "lifecycle.step", step: local.key, outcome: local.outcome, ...(local.provider_code ? { provider_code: local.provider_code } : {}) });
    if (!status.ok) {
      ledger({ event: "lifecycle.operation", phase: "finished", ok: false });
      return { ok: false, ...base(now.prepared), operation_id: operationId, blockers: status.blockers, steps: reports, ...summarize(reports), credentials: [] as CredentialRow[], complete_revocation: false, incomplete: [] as unknown[], writes: [...writes] };
    }
    ctx.status = to;

    // 2. Retire records a tombstone so the identity survives `flume offboard` removing its registry row.
    if (command === "retire") {
      if (!state.tombstones[block.subject]) {
        const tombstone: Tombstone = {
          subject: block.subject, handle: block.handle, email: block.email, retired_at: new Date().toISOString(), operation_id: operationId,
          bindings: Object.entries(block.bindings ?? {}).map(([provider, binding]) => ({ provider, principal: binding.principal, ...(binding.instance ? { instance: binding.instance } : {}) })),
        };
        state.tombstones[block.subject] = tombstone;
        persist();
        reports.push({ key: "tombstone", adapter: "local", action: "tombstone", resource: block.subject, outcome: "done", detail: `handle ${block.handle}, subject and ${tombstone.bindings.length} binding key(s) recorded` });
        ledger({ event: "lifecycle.tombstone", outcome: "done" });
      } else reports.push({ key: "tombstone", adapter: "local", action: "tombstone", resource: block.subject, outcome: "already-done", operation_id: state.tombstones[block.subject]!.operation_id });
    }

    // 3. Provider steps: the allowlist/routing first, then only the adapters named, in the fixed order.
    const hooks = { capture(name: string, value: unknown) { ctx.captures[name] = value; persist(); } };
    for (const step of planOf(ctx)) {
      const prior = ctx.steps[step.key];
      if (prior && DONE.has(prior.status)) {
        reports.push(stepReport(step, "already-done", { operation_id: prior.operation_id, detail: `${prior.status} by operation ${prior.operation_id}` }));
        ledger({ event: "lifecycle.step", step: step.key, outcome: "already-done", original_operation_id: prior.operation_id });
        continue;
      }
      let outcome: StepOutcome;
      try { outcome = await step.run(ctx, hooks); }
      catch (error) { outcome = { result: "unresolved", provider_code: "internal-error", detail: firstLine(error) }; }
      const record: StepRecord = { status: outcome.result, operation_id: operationId, at: new Date().toISOString(), ...(outcome.provider_code ? { provider_code: outcome.provider_code } : {}), ...(outcome.data ? { data: outcome.data } : {}) };
      ctx.steps[step.key] = record;
      persist();
      reports.push(stepReport(step, outcome.result, { operation_id: operationId, ...(outcome.provider_code ? { provider_code: outcome.provider_code } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}) }));
      ledger({ event: "lifecycle.step", step: step.key, adapter: step.adapter, outcome: outcome.result, ...(outcome.provider_code ? { provider_code: outcome.provider_code } : {}) });
    }

    // 4. What is still usable, read back from the providers after the steps.
    const rows = await inventoryAll(ctx, adapters);
    const summary = revocationSummary(rows);
    const unresolved = reports.some(r => r.outcome === "unresolved");
    ledger({ event: "lifecycle.operation", phase: "finished", ok: !unresolved, complete_revocation: summary.complete_revocation });
    return { ok: !unresolved, ...base(now.prepared), operation_id: operationId, blockers: [] as IdentityBlocker[], steps: reports, ...summarize(reports), credentials: rows, ...summary, gateway_link: gatewayLink(env), writes: [...writes], note: command === "suspend" ? "Suspended: the facade denies new access and mail by status. Provider credentials above are what remains usable." : "Retired: terminal. Stored mail is kept. Provider credentials above are what remains usable or needs a person." };
  }, env);
}

export const suspendEmployee = (employee: string, options: LifecycleOptions = {}) => suspendOrRetire("suspend", employee, options);
export const retireEmployee = (employee: string, options: LifecycleOptions = {}) => suspendOrRetire("retire", employee, options);

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export async function restoreEmployee(employee: string, options: LifecycleOptions = {}) {
  const env = options.env ?? process.env;
  const adapters = adaptersOf(options);
  const apply = Boolean(options.apply);
  const assess = (state: LifecycleState) => {
    const prepared = prepare(employee);
    const blockers = [...prepared.blockers];
    if (prepared.block) {
      if (prepared.block.status === "retired" || state.tombstones[prepared.block.subject]) blockers.push({ code: "retired-terminal", detail: "a retired identity is a tombstone and never returns to service" });
      else if (prepared.block.status === "active") blockers.push({ code: "not-suspended", detail: `${employee} is active; restore returns a suspended employee to service` });
    }
    return { prepared, blockers, ctx: prepared.block ? contextOf(employee, prepared, state, env) : undefined };
  };
  const planOf = (ctx: LifecycleContext): PlannedStep[] => ADAPTER_ORDER.flatMap(name => adapters[name].restorePlan(ctx));
  const base = (prepared: Prepared) => ({ command: "restore" as const, employee, apply, kind: prepared.target.kind, definition: prepared.target.path, person: prepared.target.person, from: prepared.block?.status ?? null, to: "active", ...historyOf(prepared.block) });
  const refused = (prepared: Prepared, blockers: IdentityBlocker[], extra: Record<string, unknown> = {}) => ({ ok: false, ...base(prepared), blockers, steps: [] as StepReport[], credentials: [] as CredentialRow[], complete_revocation: false, incomplete: [] as unknown[], writes: [] as string[], ...extra });
  /** Revocations restore cannot undo: a deleted Access token and a revoked gateway token are gone. */
  const notReversed = (ctx: LifecycleContext) => Object.entries(ctx.steps).filter(([key, record]) => DONE.has(record.status) && (key.startsWith("cloudflare_access:") || key.startsWith("gateway:")))
    .map(([key, record]) => ({ key, operation_id: record.operation_id, note: key.startsWith("gateway:") ? "the gateway token stays revoked; FLUME-39 mints a new one (gateway-tokens.py mint)" : "the Access service token stays deleted; `flume identity provision` issues a new one" }));

  const first = assess(readLifecycleState(env));
  if (first.blockers.length || !first.ctx) return refused(first.prepared, first.blockers);
  if (!apply) {
    const ctx = first.ctx;
    const reports: StepReport[] = planOf(ctx).map(step => stepReport(step, "planned", { detail: step.description }));
    reports.push({ key: "local-status:active", adapter: "local", action: "set-status", resource: employee, outcome: "planned", detail: "suspended -> active, written last" });
    const rows = await inventoryAll(ctx, adapters);
    return { ok: true, ...base(first.prepared), blockers: [] as IdentityBlocker[], steps: reports, credentials: rows, ...revocationSummary(rows), gateway_link: gatewayLink(env), not_reversed: notReversed(ctx), writes: [] as string[], note: "Preview only: nothing was written and no provider was mutated. Pass --apply." };
  }

  const operationId = randomUUID();
  return withLifecycleLock(async () => {
    const state = readLifecycleState(env);
    const now = assess(state);
    if (now.blockers.length || !now.ctx) return refused(now.prepared, now.blockers, { operation_id: operationId });
    const ctx = now.ctx, block = ctx.block;
    const who = { operation_id: operationId, command: "restore", employee, handle: block.handle, subject: block.subject };
    const writes = new Set<string>();
    const persist = () => { writes.add(writeLifecycleState(state, env)); };
    const ledger = (line: Record<string, unknown>) => { writes.add(appendLifecycleLedger({ ...who, ...line }, env)); };
    const reports: StepReport[] = [];
    ledger({ event: "lifecycle.operation", phase: "started", from: block.status, to: "active" });
    const hooks = { capture(name: string, value: unknown) { ctx.captures[name] = value; persist(); } };
    for (const step of planOf(ctx)) {
      let outcome: StepOutcome;
      try { outcome = await step.run(ctx, hooks); }
      catch (error) { outcome = { result: "unresolved", provider_code: "internal-error", detail: firstLine(error) }; }
      if (outcome.result !== "unresolved") {
        // Reversed: the suspension step is no longer done, so a later suspend runs it again.
        if (step.reverses) delete ctx.steps[step.reverses];
        if (step.adapter === "mail") delete ctx.captures.mail_allowlist;
        persist();
      }
      reports.push(stepReport(step, outcome.result, { operation_id: operationId, ...(outcome.provider_code ? { provider_code: outcome.provider_code } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}) }));
      ledger({ event: "lifecycle.step", step: step.key, adapter: step.adapter, outcome: outcome.result, ...(outcome.provider_code ? { provider_code: outcome.provider_code } : {}) });
    }
    const unresolved = reports.some(r => r.outcome === "unresolved");
    if (!unresolved) {
      // 2. Local status, LAST: until every provider step holds, the employee stays denied.
      const status = await setEmployeeStatus(employee, "active", { apply: true });
      const local: StepReport = { key: "local-status:active", adapter: "local", action: "set-status", resource: employee, outcome: status.ok ? (status.changed ? "done" : "converged") : "unresolved", ...(status.ok ? {} : { provider_code: status.blockers[0]?.code ?? "status-refused", detail: status.blockers[0]?.detail }) };
      reports.push(local);
      ledger({ event: "lifecycle.step", step: local.key, outcome: local.outcome });
      if (status.ok) ctx.status = "active";
    } else {
      reports.push({ key: "local-status:active", adapter: "local", action: "set-status", resource: employee, outcome: "skipped", detail: "a restore step is unresolved; the employee stays suspended (fail closed)" });
    }
    const failed = reports.some(r => r.outcome === "unresolved");
    const rows = await inventoryAll(ctx, adapters);
    ledger({ event: "lifecycle.operation", phase: "finished", ok: !failed });
    return { ok: !failed, ...base(now.prepared), operation_id: operationId, blockers: [] as IdentityBlocker[], steps: reports, ...summarize(reports), credentials: rows, ...revocationSummary(rows), gateway_link: gatewayLink(env), not_reversed: notReversed(ctx), writes: [...writes], note: failed ? "Not restored: an unresolved step keeps the employee suspended. Re-run to continue." : "Restored: provider steps were reversed first and local status is active." };
  }, env);
}

// ---------------------------------------------------------------------------
// credentials (read-only)
// ---------------------------------------------------------------------------

export async function employeeCredentials(employee: string, options: LifecycleOptions = {}) {
  const env = options.env ?? process.env;
  const adapters = adaptersOf(options);
  const prepared = prepare(employee);
  const base = { command: "credentials" as const, employee, apply: false, kind: prepared.target.kind, definition: prepared.target.path, person: prepared.target.person, status: prepared.block?.status ?? null, ...historyOf(prepared.block) };
  if (prepared.blockers.length || !prepared.block) return { ok: false, ...base, blockers: prepared.blockers, credentials: [] as CredentialRow[], complete_revocation: false, incomplete: [] as unknown[], writes: [] as string[] };
  const ctx = contextOf(employee, prepared, readLifecycleState(env), env);
  const rows = await inventoryAll(ctx, adapters);
  return { ok: true, ...base, blockers: [] as IdentityBlocker[], credentials: rows, ...revocationSummary(rows), gateway_link: gatewayLink(env), writes: [] as string[], note: "Read-only: nothing was written." };
}

// ---------------------------------------------------------------------------
// continuity
// ---------------------------------------------------------------------------

function snapshotOf(ctx: { block: CompanyIdentity; target: IdentityDefinition }): ContinuityBaseline {
  const { block, target } = ctx;
  return {
    recorded_at: new Date().toISOString(), subject: block.subject, handle: block.handle, email: block.email, mailbox_prefix: `mail/${block.handle}/`,
    bindings: Object.fromEntries(Object.entries(block.bindings ?? {}).map(([provider, binding]) => [provider, {
      principal: binding.principal, ...(binding.instance ? { instance: binding.instance } : {}),
      ...(binding.native_actor_id ? { native_actor_id: binding.native_actor_id } : {}), ...(binding.credential_ref ? { credential_ref: binding.credential_ref } : {}),
    }])),
    definition: target.path, posts: target.posts,
  };
}

interface ContinuityCheck { field: string; status: "stable" | "rotated" | "moved" | "added" | "broken"; from?: unknown; to?: unknown }

function compareContinuity(baseline: ContinuityBaseline, current: ContinuityBaseline): ContinuityCheck[] {
  const checks: ContinuityCheck[] = [];
  const same = (field: string, from: unknown, to: unknown, differs: ContinuityCheck["status"] = "broken") => checks.push({ field, status: from === to ? "stable" : differs, ...(from === to ? { value: from } : { from, to }) } as ContinuityCheck);
  same("subject", baseline.subject, current.subject);
  same("handle", baseline.handle, current.handle);
  same("email", baseline.email, current.email);
  same("mailbox_prefix", baseline.mailbox_prefix, current.mailbox_prefix);
  for (const provider of new Set([...Object.keys(baseline.bindings), ...Object.keys(current.bindings)])) {
    const before = baseline.bindings[provider], after = current.bindings[provider];
    if (!before) { checks.push({ field: `${provider}`, status: "added", to: after!.principal }); continue; }
    if (!after) { checks.push({ field: `${provider}.principal`, status: "broken", from: before.principal, to: null }); continue; }
    same(`${provider}.principal`, before.principal, after.principal);
    same(`${provider}.instance`, before.instance ?? null, after.instance ?? null);
    same(`${provider}.native_actor_id`, before.native_actor_id ?? null, after.native_actor_id ?? null);
    same(`${provider}.credential_ref`, before.credential_ref ?? null, after.credential_ref ?? null, "rotated");
  }
  const movedFrom = JSON.stringify([baseline.definition, baseline.posts]), movedTo = JSON.stringify([current.definition, current.posts]);
  checks.push({ field: "post", status: movedFrom === movedTo ? "stable" : "moved", ...(movedFrom === movedTo ? {} : { from: baseline.posts, to: current.posts }) });
  return checks;
}

export interface ContinuityOptions extends LifecycleOptions { record?: boolean; comments?: string[] }

/**
 * `flume identity continuity <employee>`: is history still pointing at the same person? Compares the employee's identity now
 * with the baseline `--record --apply` stored: the same subject, handle, email, mailbox prefix, and per-provider principal and
 * `native_actor_id` are `stable`; a changed `credential_ref` is `rotated` and a changed post `moved` (both fine); a changed
 * handle, email, principal or actor is `broken`. `--comment <employee>:<uuid>` checks the `plane.verify-comments` receipts.
 */
export async function employeeContinuity(employee: string, options: ContinuityOptions = {}) {
  const env = options.env ?? process.env;
  const apply = Boolean(options.apply);
  const prepared = prepare(employee);
  const base = { command: "continuity" as const, employee, apply, kind: prepared.target.kind, definition: prepared.target.path, person: prepared.target.person };
  const blockers = [...prepared.blockers];
  const comments: Array<Record<string, unknown>> = [];
  if (blockers.length || !prepared.block) return { ok: false, ...base, status: "refused", blockers, checks: [] as ContinuityCheck[], comments, writes: [] as string[] };
  const block = prepared.block;
  const current = snapshotOf({ block, target: prepared.target });
  const run = async (): Promise<Record<string, any> & { ok: boolean }> => {
    const state = readLifecycleState(env);
    const byHandle = Object.values(state.continuity).find(candidate => candidate.handle === block.handle);
    const baseline = state.continuity[block.subject] ?? byHandle;
    const checks = baseline ? compareContinuity(baseline, current) : [];
    // Comment provenance: Plane comments are looked up in the receipts `flume comment verify-plane --apply` wrote.
    if (options.comments?.length) {
      const receipts = readPlaneReceipts(env).filter(line => line.kind === "plane.verify-comments");
      for (const spec of options.comments) {
        const plane = /^([^:]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(spec);
        const github = /^([^:]+):(issue|review):(\d+)$/u.exec(spec);
        if (github) { comments.push({ comment: spec, status: "not-recorded", reason: "a GitHub comment has no Flume receipt", next_action: "flume comment verify <owner/repo> --comment " + spec }); continue; }
        if (!plane) { comments.push({ comment: spec, status: "not-recorded", reason: "invalid-comment-spec", next_action: "use <employee>:<uuid> (Plane) or <employee>:<issue|review>:<id> (GitHub)" }); continue; }
        const line = receipts.flatMap(receipt => (receipt.comments ?? []) as Array<Record<string, any>>).filter(row => row.comment_id === plane[2] && row.subject === block.subject).pop();
        if (!line || line.authorship !== "native-verified") { comments.push({ comment: spec, status: "not-recorded", next_action: `flume comment verify-plane <REF> --comment ${spec} --apply` }); continue; }
        const adopted = block.bindings?.plane?.native_actor_id ?? null;
        comments.push({ comment: spec, status: line.native_actor_id === adopted && line.actor_id === adopted ? "stable" : "broken", native_actor_id: adopted, actor_id: line.actor_id ?? null });
      }
    }
    const broken = checks.filter(check => check.status === "broken").length > 0 || comments.some(row => row.status === "broken");
    const out: Record<string, any> & { ok: boolean } = {
      ok: baseline ? !broken : false, ...base, status: !baseline ? "no-baseline" : broken ? "broken" : "stable",
      ...(baseline ? { baseline_at: baseline.recorded_at } : {}), identity: current, checks, comments, blockers: [] as IdentityBlocker[], writes: [] as string[],
    };
    if (!baseline) (out.blockers as IdentityBlocker[]).push({ code: "no-baseline", detail: `no continuity baseline for ${employee}; record one with: flume identity continuity ${employee} --record --apply` });
    if (options.record) {
      if (baseline && broken) { (out.blockers as IdentityBlocker[]).push({ code: "continuity-broken", detail: "the baseline is not refreshed over a broken identity" }); out.ok = false; return out; }
      out.recorded = apply;
      if (apply) {
        state.continuity[block.subject] = current;
        out.writes = [writeLifecycleState(state, env)];
        appendLifecycleLedger({ event: "lifecycle.continuity", employee, handle: block.handle, subject: block.subject, recorded: true }, env);
        out.status = baseline ? out.status : "recorded";
        out.ok = !broken;
        out.blockers = [];
      } else {
        out.ok = !broken;
        out.blockers = [];
        out.note = "Preview only: the baseline was not written. Pass --apply.";
      }
    }
    return out;
  };
  return options.record && apply ? withLifecycleLock(run, env) : run();
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/** One screenful for a person; `--json` is the full record. */
export function formatLifecycleResult(result: Record<string, any>): string {
  const lines: string[] = [];
  if (result.error) lines.push(`✗ ${result.error}`);
  if (result.definition) lines.push(`${result.employee}: ${result.command}${result.apply ? " --apply" : " (preview)"} ${result.from ? `${result.from} -> ${result.to}` : result.status ?? ""}`.trimEnd());
  if (result.command === "rotate" && result.credential_ref) lines.push(`  ${result.provider} credential_ref ${result.previous_ref ?? "(none)"} -> ${result.credential_ref}${result.changed ? (result.apply ? " (written)" : " (preview; pass --apply)") : " (no change)"}`);
  if (result.verification?.next_action) lines.push(`  verify: ${result.verification.next_action}`);
  if (result.operation_id) lines.push(`  operation ${result.operation_id}`);
  for (const blocker of result.blockers ?? []) lines.push(`  ✗ ${blocker.code}: ${blocker.detail}`);
  for (const step of result.steps ?? []) lines.push(`  ${String(step.outcome).padEnd(12)} ${step.key}${step.provider_code ? ` [${step.provider_code}]` : ""}${step.detail ? ` — ${step.detail}` : ""}`);
  for (const check of result.checks ?? []) lines.push(`  ${String(check.status).padEnd(8)} ${check.field}${check.status === "stable" || check.value !== undefined ? "" : ` ${JSON.stringify(check.from ?? null)} -> ${JSON.stringify(check.to ?? null)}`}`);
  for (const comment of result.comments ?? []) lines.push(`  comment ${comment.comment}: ${comment.status}${comment.next_action ? ` (${comment.next_action})` : ""}`);
  for (const row of result.credentials ?? []) lines.push(`  ${String(row.status).padEnd(22)} ${row.provider}/${row.kind}${row.id ? ` ${row.id}` : ""}${row.expires_at ? ` expires ${row.expires_at}` : ""}${row.provider_code ? ` [${row.provider_code}]` : ""} (${row.evidence}) — ${row.next_action}`);
  for (const item of result.not_reversed ?? []) lines.push(`  not reversed: ${item.key} — ${item.note}`);
  if (Array.isArray(result.credentials) && result.credentials.length) {
    if (result.complete_revocation) lines.push("revocation COMPLETE: every credential is revoked or was never issued");
    else lines.push(`revocation INCOMPLETE: ${(result.incomplete ?? []).length} credential(s) still usable, expiring or unverified`);
  }
  if (result.gateway_link) lines.push(`gateway: owner ${result.gateway_link.owner_ticket}, evidence ${result.gateway_link.evidence_status} (${result.gateway_link.evidence_path})`);
  for (const write of result.writes ?? []) lines.push(`  wrote ${write}`);
  if (result.note) lines.push(result.note);
  return `${lines.join("\n")}\n`;
}

export { lifecycleLedgerPath, lifecycleStatePath };
