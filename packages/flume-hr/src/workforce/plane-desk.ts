// The last mile of an employee's native Plane identity: the desk RUNS the employee's own key.
//
// A desk's generated config.yaml inherits `secrets.onepassword.env.PLANE_API_KEY` from the fleet base
// (`~/.hermes/config.yaml`), which is the OPERATOR's key. Pilot (`px`) reads PLANE_API_KEY first, so an employee whose
// Plane identity is fully enrolled, bound and adopted still comments as the operator until its desk carries its own
// reference. This module projects exactly that one key:
//
//   want     = company_identity.bindings.plane.credential_ref, for an ACTIVE employee whose binding is ADOPTED
//              (native_actor_id == principal, i.e. Pilot verified the key is that user);
//   delta    : secrets.onepassword.env.PLANE_API_KEY = want, every other key and comment of config.delta.yaml kept;
//   render   : config.yaml re-rendered by the canonical renderer (scripts/channel-state.py `mode: desk-refs`);
//   pick-up  : that ONE profile cycled through the gateway control socket (unserve drops its secret snapshot, serve
//              re-pulls), never a gateway restart. Without a socket the write stands and the result says to run
//              `hermes-gateway-restart --reason ...` ONCE after the last projection.
//
// Suspended and retired employees are never projected (and reported). An employee with no adopted binding keeps the
// shared key: "shared-key: not yet enrolled" is a fact, not a failure. Nothing here reads or prints a secret value: only
// `op://` reference text.
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deskProfileOf, identityCensus, resolveEmployee, type IdentityCensus, type IdentityDefinition } from "./company";
import { appendPlaneReceipt, planeBindingOf } from "./plane";
import { readRef, type RefRead } from "./gateway-desk";
import { cycleProfileViaSocket, deskDirOf, desksUsingRef, fleetBaseConfigPath, readGateway, writeDeskRefs } from "./channel";
import type { LifecycleAuditFinding, LifecycleContext, LifecycleMigrationResult, RecipeCheck } from "../engine/types";

export const PLANE_KEY_ENV = "PLANE_API_KEY";
export const PLANE_CREDENTIAL_RULE = "org.plane-credential";
/** `flume remediate ... --no-reload` / `identity provision --no-reload`: write and render, leave the running gateway alone. */
export const NO_GATEWAY_RELOAD_ENV = "FLUME_NO_GATEWAY_RELOAD";

export type PlaneDeskStanding =
  | "own-key"          // the desk runs the employee's own adopted key
  | "projectable"      // adopted binding, desk still runs another (shared/operator or stale) key
  | "not-enrolled"     // shared key: no company identity or no plane binding yet
  | "not-adopted"      // shared key: plane binding not yet verified by Pilot (native_actor_id != principal)
  | "binding-invalid"  // shared key: the plane binding cannot be used as recorded
  | "suspended" | "retired" // never projected
  | "no-desk"          // adopted, but no real profile directory to project into
  | "blocked";         // adopted, but projecting would collide (the reference is another desk's)

export interface PlaneDeskRow {
  employee: string;
  handle: string | null;
  status: string | null;
  profile: string | null;
  standing: PlaneDeskStanding;
  /** The employee's own reference, when it has an adopted binding. */
  want: string | null;
  /** What the desk's delta / generated config / the fleet base hold for PLANE_API_KEY (references only). */
  delta: string | null;
  running: string | null;
  base: string | null;
  projectable: boolean;
  detail: string;
}

const text = (read: RefRead): string | null => (read.exists && read.ref ? read.ref : null);

function employeeName(definition: IdentityDefinition): string {
  return definition.posts[0] ?? basename(dirname(definition.path));
}

function realDir(path: string): boolean {
  try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}

/** One employee's standing. Pure over the census and the desk files; no write, no network. */
export function planeDeskRow(census: IdentityCensus, definition: IdentityDefinition): PlaneDeskRow {
  const block = definition.block;
  const profile = deskProfileOf(census, definition);
  const base = text(readRef(fleetBaseConfigPath(), PLANE_KEY_ENV));
  const desk = profile ? deskDirOf(profile) : null;
  const delta = desk ? text(readRef(join(desk, "config.delta.yaml"), PLANE_KEY_ENV)) : null;
  const generated = desk ? readRef(join(desk, "config.yaml"), PLANE_KEY_ENV) : ({ exists: false } as RefRead);
  // Hermes runs the generated file; without one, a render of the delta (else the base) is what would run.
  const running = generated.exists ? text(generated) : (delta ?? base);
  const row = (standing: PlaneDeskStanding, detail: string, want: string | null = null): PlaneDeskRow => ({
    employee: employeeName(definition), handle: block?.handle ?? null, status: block?.status ?? null, profile, standing, want,
    delta, running, base, projectable: standing === "projectable", detail,
  });
  if (definition.problem) return row("binding-invalid", `definition unreadable: ${definition.problem}`);
  if (!block) return row("not-enrolled", "shared-key: not yet enrolled (no company identity)");
  const binding = block.bindings?.plane;
  const own = binding?.credential_ref ?? null;
  if (block.status === "retired" || block.status === "suspended") {
    const still = own && running === own ? "; the desk STILL runs the employee's own key (suspend/retire does not unproject it: park the desk or rotate the key)" : "";
    return row(block.status, `${block.status}: never projected${still}`, own);
  }
  if (!binding) return row("not-enrolled", `shared-key: not yet enrolled (no plane binding; run flume identity provision ${employeeName(definition)} --only plane --apply)`);
  const bound = planeBindingOf(binding);
  if ("code" in bound) return row("binding-invalid", `shared-key: plane binding unusable (${bound.code}: ${bound.detail})`);
  if (binding.native_actor_id !== binding.principal) return row("not-adopted", `shared-key: plane binding not yet adopted (run flume identity adopt-actor ${employeeName(definition)} plane --board <board> --apply, or flume identity provision ${employeeName(definition)} --only plane --apply)`, own);
  const want = bound.facts.keyRef;
  if (!profile || !desk || !realDir(desk)) return row("no-desk", `adopted, but ${desk ?? "no desk"} is not a real profile directory; nothing to project into`, want);
  if (delta === want && running === want) return row("own-key", "runs its own adopted Plane key", want);
  const elsewhere = desksUsingRef(want, profile);
  if (elsewhere.length) return row("blocked", `adopted key ${want} is already mapped in desk(s) ${elsewhere.join(", ")}; two desks never share one employee's key`, want);
  const what = running === base ? "the fleet base (shared/operator) key" : running ? `another key (${running})` : "no Plane key";
  const parts = [`runs ${what}`];
  if (delta !== want) parts.push(`delta ${delta ? `holds ${delta}` : "has no PLANE_API_KEY"}`);
  if (generated.exists && generated.unreadable) parts.push("generated config.yaml unreadable");
  else if (delta === want && running !== want) parts.push("generated config.yaml is stale (not rendered since the delta changed)");
  return row("projectable", `${parts.join("; ")}; want its own ${want}`, want);
}

/** Every employee the identity census knows, with its desk standing. */
export function planeDeskCensus(): { rows: PlaneDeskRow[]; problems: string[] } {
  const census = identityCensus();
  const rows: PlaneDeskRow[] = [];
  const problems: string[] = [];
  for (const definition of census.definitions) {
    if (definition.missing) continue;
    try { rows.push(planeDeskRow(census, definition)); }
    catch (error) { problems.push(`${employeeName(definition)}: ${(error as Error).message}`); }
  }
  rows.sort((a, b) => a.employee.localeCompare(b.employee));
  return { rows, problems };
}

export interface PlaneDeskPickup { action: "none" | "skipped" | "profile-cycle" | "unpicked"; confirmed: boolean; detail: string }

export interface PlaneDeskResult {
  ok: boolean;
  apply: boolean;
  employee: string;
  profile: string | null;
  standing: PlaneDeskStanding;
  changed: boolean;
  from: { delta: string | null; running: string | null };
  to: string | null;
  writes: string[];
  gateway?: PlaneDeskPickup;
  receipt?: string;
  blockers: Array<{ code: string; detail: string }>;
  detail: string;
}

export interface PlaneDeskOptions { apply?: boolean; noReload?: boolean }

async function pickUpDesk(profile: string, noReload: boolean): Promise<PlaneDeskPickup> {
  const gateway = readGateway();
  if (!gateway.running) return { action: "none", confirmed: false, detail: "no running gateway: the desk runs its own key when the gateway next starts" };
  if (noReload) return { action: "skipped", confirmed: false, detail: `--no-reload: written, NOT picked up. Cycle ${profile} or, once after the last projection, run hermes-gateway-restart --reason "plane keys projected"` };
  const cycled = await cycleProfileViaSocket(profile);
  if (cycled.ok) return { action: "profile-cycle", confirmed: true, detail: cycled.detail };
  // Never a restart from here: one per desk would drain every profile N times. Batch it.
  return { action: "unpicked", confirmed: false, detail: `${cycled.detail}; written, NOT picked up. Once after the last projection: hermes-gateway-restart --reason "plane keys projected"` };
}

/**
 * Project the employee's own adopted Plane key into its desk (preview unless `apply`). Idempotent: a desk that already
 * runs the key is `changed: false`. Every standing other than `projectable` writes nothing; `suspended`, `retired`,
 * `blocked` and an unusable binding are `ok: false`, the shared-key standings (`not-enrolled`, `not-adopted`) are
 * `ok: true` (not a failure, just not yet).
 */
export async function projectPlaneKey(employee: string, options: PlaneDeskOptions = {}): Promise<PlaneDeskResult> {
  const census = identityCensus();
  const definition = resolveEmployee(census, employee);
  const row = planeDeskRow(census, definition);
  const base = { apply: Boolean(options.apply), employee, profile: row.profile, standing: row.standing, from: { delta: row.delta, running: row.running }, to: row.want, detail: row.detail };
  const refused = ["suspended", "retired", "blocked", "binding-invalid", "no-desk"].includes(row.standing);
  if (row.standing !== "projectable") {
    return { ...base, ok: !refused, changed: false, writes: [], blockers: refused ? [{ code: `plane-desk-${row.standing}`, detail: row.detail }] : [] };
  }
  if (!options.apply) return { ...base, ok: true, changed: true, writes: [], blockers: [], detail: `${row.detail} (preview; --apply writes the delta, re-renders and cycles the profile)` };
  const done = writeDeskRefs(row.profile!, { [PLANE_KEY_ENV]: row.want! }, { [PLANE_KEY_ENV]: row.delta });
  if (!done.ok) return { ...base, ok: false, changed: false, writes: [], blockers: [{ code: done.code ?? "write-failed", detail: done.error ?? "desk write failed" }] };
  const after = planeDeskRow(identityCensus(), definition);
  if (after.standing !== "own-key") return { ...base, ok: false, changed: true, writes: done.writes, blockers: [{ code: "readback-mismatch", detail: `after the write the desk reads ${after.standing}: ${after.detail}` }] };
  const receipt = appendPlaneReceipt({ kind: "plane.desk-projection", employee, handle: row.handle, profile: row.profile, env: PLANE_KEY_ENV, credential_ref: row.want, previous_delta_ref: row.delta, previous_running_ref: row.running });
  const gateway = await pickUpDesk(row.profile!, Boolean(options.noReload) || process.env[NO_GATEWAY_RELOAD_ENV] === "1");
  return { ...base, ok: true, changed: true, standing: "own-key", writes: done.writes, gateway, receipt, blockers: [], detail: `desk ${row.profile} now runs its own key ${row.want}` };
}

export function formatPlaneDeskResult(result: PlaneDeskResult): string {
  const lines = [`${result.employee} plane desk${result.profile ? ` (${result.profile})` : ""}: ${result.standing}${result.changed ? result.apply ? " — projected" : " — would project (preview)" : ""}`];
  lines.push(`  ${result.detail}`);
  for (const write of result.writes) lines.push(`  wrote ${write}`);
  if (result.gateway) lines.push(`  gateway: ${result.gateway.confirmed ? "picked up" : "NOT picked up"} (${result.gateway.action}) ${result.gateway.detail}`);
  for (const blocker of result.blockers) lines.push(`  ✗ ${blocker.code}: ${blocker.detail}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// org.plane-credential: the audit finding and its remediation
// ---------------------------------------------------------------------------------------------

const TITLE = "Every adopted Plane identity runs its own key at its desk (no shared/operator PLANE_API_KEY)";

/** A row no command may fix: a collision, or an out-of-service employee whose desk still runs its own key. */
const needsOperator = (row: PlaneDeskRow): boolean =>
  row.standing === "blocked" || (["suspended", "retired"].includes(row.standing) && row.detail.includes("STILL"));

function audit(_ctx: LifecycleContext): LifecycleAuditFinding {
  const head = { id: PLANE_CREDENTIAL_RULE, title: TITLE, scope: "host" as const };
  let census: ReturnType<typeof planeDeskCensus>;
  try { census = planeDeskCensus(); }
  catch (error) { return { ...head, status: "skip", summary: `identity census unreadable: ${(error as Error).message.split("\n")[0]}`, details: [], fixable: false }; }
  const { rows, problems } = census;
  if (!rows.length && !problems.length) return { ...head, status: "skip", summary: "no employee definitions on this host", details: [], fixable: false };
  const projectable = rows.filter(row => row.projectable);
  const refused = rows.filter(needsOperator);
  const shared = rows.filter(row => ["not-enrolled", "not-adopted", "binding-invalid"].includes(row.standing));
  const own = rows.filter(row => row.standing === "own-key");
  const deskless = rows.filter(row => row.standing === "no-desk");
  const details = [
    ...projectable.map(row => `${row.employee} (${row.profile}): ${row.detail}; fix: flume remediate ${PLANE_CREDENTIAL_RULE}`),
    ...refused.map(row => `${row.employee}${row.profile ? ` (${row.profile})` : ""}: ${row.standing}: ${row.detail}`),
    ...problems,
    ...(own.length ? [`own-key: ${own.map(row => row.employee).join(", ")}`] : []),
    ...(deskless.length ? [`adopted but no desk (nothing to project into): ${deskless.map(row => row.employee).join(", ")}`] : []),
    ...(shared.length ? [`shared-key (not a failure; not yet enrolled/adopted): ${shared.map(row => row.employee).join(", ")}`] : []),
  ];
  const failing = projectable.length + refused.length + problems.length;
  return {
    ...head,
    status: projectable.length || refused.length ? "fail" : problems.length ? "warn" : "pass",
    summary: failing
      ? `${projectable.length} desk(s) run a shared/operator Plane key although their employee has an adopted identity${refused.length ? `; ${refused.length} need an operator` : ""}`
      : `${own.length} desk(s) run their own Plane key; ${shared.length} on the shared key (not yet enrolled)`,
    details,
    fixable: projectable.length > 0,
  };
}

async function migrate(ctx: LifecycleContext, finding: LifecycleAuditFinding): Promise<LifecycleMigrationResult> {
  const result = (status: LifecycleMigrationResult["status"], summary: string, changedFiles: string[], details: string[]): LifecycleMigrationResult => ({ id: finding.id, title: finding.title, status, summary, changedFiles, details });
  let rows: PlaneDeskRow[];
  try { rows = planeDeskCensus().rows; } catch (error) { return result("blocked", "identity census unreadable", [], [(error as Error).message]); }
  const targets = rows.filter(row => row.projectable);
  const refused = rows.filter(needsOperator).map(row => `${row.employee}: ${row.standing}: ${row.detail}`);
  if (!targets.length) return result(refused.length ? "blocked" : "noop", refused.length ? "Nothing projectable; the rows named need an operator" : "No changes required", [], refused);
  const changed: string[] = [];
  const details: string[] = [];
  const blockers: string[] = [...refused];
  for (const row of targets) {
    if (ctx.dryRun) { details.push(`${row.employee}: would set ${row.profile} PLANE_API_KEY -> ${row.want} (re-render, cycle the profile)`); continue; }
    const projected = await projectPlaneKey(row.employee, { apply: true });
    if (!projected.ok) { blockers.push(`${row.employee}: ${projected.blockers.map(b => `${b.code}: ${b.detail}`).join("; ")}`); continue; }
    changed.push(...projected.writes);
    details.push(`${row.employee}: ${projected.detail}${projected.gateway ? `; gateway ${projected.gateway.action}: ${projected.gateway.detail}` : ""}`);
  }
  if (ctx.dryRun) return result("skipped", `Planned: ${targets.length} desk(s) would run their own Plane key`, [], [...details, ...blockers]);
  const status = blockers.length ? (changed.length ? "partial" : "blocked") : "applied";
  return result(status, `${targets.length - (blockers.length - refused.length)} of ${targets.length} desk(s) now run their own Plane key`, changed, [...details, ...blockers]);
}

/** The host-scoped rule `flume audit` reports and `flume remediate org.plane-credential` repairs. */
export const PLANE_CREDENTIAL_CHECK: RecipeCheck = { id: PLANE_CREDENTIAL_RULE, title: TITLE, scope: "host", audit, migrate };

/** For a caller that wants to know whether a desk exists without opening one. */
export const deskExists = (profile: string): boolean => existsSync(deskDirOf(profile)) && realDir(deskDirOf(profile));
