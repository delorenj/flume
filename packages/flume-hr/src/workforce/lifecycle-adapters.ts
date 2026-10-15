// FLUME-53: the providers' honest lifecycle semantics, one adapter each, in one place.
//
// An adapter does three things and nothing else: it INVENTORIES what one provider still lets the employee do (read-only),
// it PLANS the steps `suspend|retire` and `restore` run for it, and each step RUNS one resource-scoped provider mutation
// and reads it back. The coordinator (lifecycle.ts) owns ordering, convergence keys, the state and the ledger.
//
// What a row may say is decided here and only here:
//   * `revoked` is claimed for a static credential only when the provider has READ BACK its rejection or absence: an
//     Access service token that is gone from the provider's COMPLETE listing, a GitHub app-JWT `GET /app` that answers 401,
//     Pilot's `credential_rejected`, a gateway `status` that lists no tokens. A local status, a grant TTL or a step that
//     merely ran never makes a row `revoked` (see `staticRow()`, the one place a static row is allowed to become `revoked`).
//   * A GitHub installation that is suspended is `suspended-reversible`: un-suspending revives every unexpired token, and
//     anyone holding the App key can do it.
//   * A Plane PAT, a GitHub App private key and a gateway token with no expiry are static: `static-usable` until a
//     provider says otherwise, and `manual-action-required` once the employee is retired.
//   * A credential rotated AWAY from (`identity.rotate`) was never revoked by the rotation: it stays in the inventory as a
//     `previous-credential-reference` row, `manual-action-required` until a probe of that exact old reference reads back
//     the provider's rejection.
//   * A gateway key the desk merely INHERITS from the fleet base is still a key the desk can use: it is a `shared_consumer`
//     row, never `not-issued`, and no employee's lifecycle may revoke it.
// Nothing here ever holds, returns or logs a secret value: rows carry IDs, `op://` references and codes.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { resolveFlumeRoot } from "../kernel/paths";
import { accessStateDir } from "./access";
import { deskProfileOf, type IdentityBlocker, type IdentityCensus, type IdentityDefinition } from "./company";
import { githubBindingOf, githubEvidence, probeGithubAppKey, readGithubInstallation, writeGithubInstallationSuspension } from "./github";
import { readLifecycleLedger, type StepRecord } from "./lifecycle-state";
import { PLANE_CREDENTIAL_SEMANTICS, planeBindingOf, planeEvidence, readPlaneReceipts, verifyBoardViaPx } from "./plane";
import { cfOk, cfRequest, cloudflareEvidence, loadProvisioningConfig, opRead, type CfResponse, type CfRoutingRule, type CfServiceToken, type ProvisioningConfig } from "./provision";
import type { CompanyIdentity } from "./types";

export type AdapterName = "mail" | "cloudflare_access" | "github" | "plane" | "gateway";
export const ADAPTER_ORDER: readonly AdapterName[] = ["mail", "cloudflare_access", "github", "plane", "gateway"];
/** The adapters `--revoke` may name, in the order they run. Mail is closed by suspend itself; Plane has no revocation verb. */
export const REVOCABLE: readonly AdapterName[] = ["cloudflare_access", "github", "gateway"];

export type RowStatus = "revoked" | "suspended-reversible" | "residual-expiry" | "static-usable" | "manual-action-required" | "unverified" | "unresolved" | "not-issued";

export interface CredentialRow {
  provider: AdapterName;
  kind: string;
  id?: string;
  name?: string;
  /** gateway rows: the FLUME-39 consumer the desk reference names. */
  consumer?: string;
  ref?: string;
  static: boolean;
  status: RowStatus;
  expires_at?: string;
  provider_code?: string;
  evidence: "provider" | "fixture";
  /** Present exactly when `status` is `revoked`: what the provider itself read back. */
  read_back?: "rejected" | "absent";
  next_action: string;
  detail?: string;
  /** gateway rows only: the FLUME-39 owner of minting and rotation. */
  owner_ticket?: string;
  evidence_path?: string;
  evidence_status?: "present" | "unverified";
  shared_consumer?: boolean;
  /** gateway rows: where the desk's reference came from (its own delta, its generated config, the fleet base, the specialist launcher). */
  ref_source?: GatewayRefSource;
  /** previous-credential-reference rows: when the rotation away from this reference was recorded. */
  rotated_at?: string;
}

export type EmploymentStatus = "active" | "suspended" | "retired";

export interface LifecycleContext {
  employee: string;
  target: IdentityDefinition;
  census: IdentityCensus;
  block: CompanyIdentity;
  /** The status the coordinator has made true so far; the definition's own `block.status` can be older. */
  status: EmploymentStatus;
  /** This subject's step records, live. */
  steps: Record<string, StepRecord>;
  /** This subject's captures, live. */
  captures: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  cache: Map<string, unknown>;
  /**
   * Applies only (absent in previews and `credentials`, which write nothing): keep a definitive provider observation that a
   * later read may no longer be able to make (an installation GitHub answered 404 for, before the App key was deleted).
   */
  remember?: (name: string, value: unknown) => void;
}

export interface StepOutcome { result: "done" | "converged" | "unresolved"; provider_code?: string; detail?: string; data?: Record<string, unknown> }
export interface StepHooks {
  /** The operation this step runs in. */
  operation_id: string;
  /** Persist `value` under `name` in this subject's captures BEFORE the mutation it guards. */
  capture(name: string, value: unknown): void;
}

export interface PlannedStep {
  /** Resource-scoped convergence key, e.g. `cloudflare_access:token-delete:<client_id>`. */
  key: string;
  adapter: AdapterName;
  action: string;
  resource: string;
  description: string;
  /** Restore only: the suspension step key this step reverses; the coordinator clears it on success. */
  reverses?: string;
  /** Restore only: the captures this step consumes; the coordinator drops them on success (and nowhere else). */
  releases?: string[];
  /**
   * Irreversible steps only: the provider resources (IDs) this step would act on NOW. A `done` record covers the step only
   * while every live resource is one it already acted on (`data.resources`), so a re-minted token is revoked again while a
   * done DELETE is never repeated. `null` means the provider could not be read; the done record then stands.
   */
  live?(ctx: LifecycleContext): Promise<string[] | null>;
  run(ctx: LifecycleContext, hooks: StepHooks): Promise<StepOutcome>;
}

export interface SuspendPlanOptions { command: "suspend" | "retire"; revoke: boolean }

export interface LifecycleAdapter {
  name: AdapterName;
  /** Refusals knowable without a provider call. */
  blockers(ctx: LifecycleContext, options: SuspendPlanOptions): IdentityBlocker[];
  inventory(ctx: LifecycleContext): Promise<CredentialRow[]>;
  plan(ctx: LifecycleContext, options: SuspendPlanOptions): PlannedStep[];
  restorePlan(ctx: LifecycleContext): PlannedStep[];
}

const codeOf = (response: CfResponse): string => (response.http_status === 0 ? "provider-unavailable" : `http-${response.http_status}`);
const memo = async <T>(ctx: LifecycleContext, key: string, make: () => Promise<T> | T): Promise<T> => {
  if (!ctx.cache.has(key)) ctx.cache.set(key, await make());
  return ctx.cache.get(key) as T;
};

/**
 * The only way a static credential becomes `revoked`: the provider answered with its rejection or absence (`readBack`).
 * Anything else -- a step that ran, a local status, a grant TTL, no answer at all -- is `otherwise`, never `revoked`.
 */
function staticRow(base: Omit<CredentialRow, "status" | "read_back">, readBack: "rejected" | "absent" | undefined, otherwise: Pick<CredentialRow, "status"> & Partial<CredentialRow>): CredentialRow {
  return readBack ? { ...base, status: "revoked", read_back: readBack } : { ...base, ...otherwise };
}

// ---------------------------------------------------------------------------
// Rotated-away credential references (the `identity.rotate` ledger)
// ---------------------------------------------------------------------------

interface RotatedRef { ref: string; principal: string; instance?: string; at: string }

/** Every `credential_ref` this subject rotated AWAY from at `provider`, newest first, without the one it holds now. */
function rotatedAway(ctx: LifecycleContext, provider: AdapterName): RotatedRef[] {
  const current = ctx.block.bindings?.[provider]?.credential_ref;
  const seen = new Set<string>(), out: RotatedRef[] = [];
  for (const line of readLifecycleLedger(ctx.env).reverse()) {
    if (line.event !== "identity.rotate" || line.subject !== ctx.block.subject || line.provider !== provider) continue;
    const ref = typeof line.previous_ref === "string" ? line.previous_ref : undefined;
    if (!ref || ref === current || seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, principal: String(line.principal ?? ""), ...(typeof line.instance === "string" ? { instance: line.instance } : {}), at: String(line.at ?? "") });
  }
  return out;
}

/** A rotated-away reference: revoked ONLY on a provider read-back of that exact reference, otherwise a person's job. */
function previousRow(provider: AdapterName, rotated: RotatedRef, evidence: CredentialRow["evidence"], route: string, readBack: "rejected" | "absent" | undefined, detail: string): CredentialRow {
  return staticRow(
    { provider, kind: "previous-credential-reference", ref: rotated.ref, ...(rotated.principal ? { id: rotated.principal } : {}), static: true, evidence, rotated_at: rotated.at, next_action: readBack ? "none: the provider rejects the old credential" : route, detail },
    readBack, { status: "manual-action-required" });
}

// ---------------------------------------------------------------------------
// Cloudflare (mail and Access share one token and one config)
// ---------------------------------------------------------------------------

type CloudflareHandle = { ok: true; token: string; config: ProvisioningConfig } | { ok: false; code: string; detail: string };

async function cloudflareOf(ctx: LifecycleContext): Promise<CloudflareHandle> {
  return memo(ctx, "cloudflare", () => {
    let config: ProvisioningConfig;
    try { config = loadProvisioningConfig(); } catch (error) { return { ok: false as const, code: "provisioning-config-unavailable", detail: (error as Error).message.split("\n")[0]!.slice(0, 200) }; }
    try { return { ok: true as const, token: opRead(config.cloudflare.api_token_ref), config }; }
    catch (error) { return { ok: false as const, code: "credential-unavailable", detail: (error as Error).message.split("\n")[0]!.slice(0, 200) }; }
  });
}

const kvPath = (cf: { config: ProvisioningConfig }, key: string): string => `/accounts/${cf.config.cloudflare.account_id}/storage/kv/namespaces/${cf.config.mailbox.kv_namespace_id}/values/${encodeURIComponent(key)}`;
const allowlistKey = (block: CompanyIdentity): string => `allowlist/${block.email.toLowerCase()}`;

const PAGE_SIZE = 50, MAX_PAGES = 100;

/**
 * Every item of a paged Cloudflare listing, or why it cannot be trusted. Absence is only ever concluded from a COMPLETE
 * listing: `result_info.total_pages` when the provider states it; otherwise pages are read until one is shorter than the
 * page size the provider says it SERVED (a clamped `per_page` is followed, not mistaken for the last page), or empty. A
 * listing that repeats a page or runs past the cap is `listing-incomplete`, which makes every row that relies on it unresolved.
 */
async function listAll<T extends { id: string }>(cf: { token: string }, path: string): Promise<{ ok: true; items: T[] } | { ok: false; code: string }> {
  const items: T[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const list = await cfRequest(cf.token, "GET", `${path}?per_page=${PAGE_SIZE}&page=${page}`);
    if (!cfOk(list)) return { ok: false, code: codeOf(list) };
    const result = (Array.isArray(list.body?.result) ? list.body.result : []) as T[];
    let fresh = 0;
    for (const item of result) if (!seen.has(item.id)) { seen.add(item.id); items.push(item); fresh++; }
    if (result.length > 0 && fresh === 0) return { ok: false, code: "listing-incomplete" };
    const info = (list.body?.result_info ?? {}) as { total_pages?: unknown; per_page?: unknown };
    const totalPages = Number(info.total_pages);
    if (Number.isFinite(totalPages) && totalPages >= 1) { if (page >= totalPages) return { ok: true, items }; continue; }
    if (result.length === 0) return { ok: true, items };
    const served = Number(info.per_page);
    if (Number.isFinite(served) && served > 0 && result.length < served) return { ok: true, items };
  }
  return { ok: false, code: "listing-incomplete" };
}

const listServiceTokens = (cf: { token: string; config: ProvisioningConfig }) => listAll<CfServiceToken>(cf, `/accounts/${cf.config.cloudflare.account_id}/access/service_tokens`);
const listRules = (cf: { token: string; config: ProvisioningConfig }) => listAll<CfRoutingRule>(cf, `/zones/${cf.config.cloudflare.zone_id}/email/routing/rules`);

/** The employee's OWN literal rule: a `to` matcher for exactly their address. Whether it is ours is decided by its action. */
const pointsAtWorker = (rule: CfRoutingRule, worker: string): boolean => rule.actions?.some(action => action.type === "worker" && (action.value ?? []).includes(worker)) ?? false;
/** A foreign rule listed first must not hide the employee's own: prefer the literal match that points at the mailbox worker. */
const literalRule = (rules: CfRoutingRule[], email: string, worker: string): CfRoutingRule | undefined => {
  const matches = rules.filter(rule => rule.matchers?.some(m => m.type === "literal" && m.field === "to" && m.value?.toLowerCase() === email.toLowerCase()));
  return matches.find(rule => pointsAtWorker(rule, worker)) ?? matches[0];
};

// ---------------------------------------------------------------------------
// mail
// ---------------------------------------------------------------------------

export const mailAdapter: LifecycleAdapter = {
  name: "mail",
  blockers: () => [],
  async inventory(ctx) {
    const evidence = cloudflareEvidence(ctx.env);
    const base = { provider: "mail" as const, kind: "mailbox-allowlist", id: allowlistKey(ctx.block), static: false, evidence };
    const cf = await cloudflareOf(ctx);
    if (!cf.ok) return [{ ...base, status: "unverified", provider_code: cf.code, next_action: "set FLUME_PROVISION_CONFIG (docs/identity-provisioning.md); the mailbox cannot be read or closed without it", detail: cf.detail }];
    const kv = await cfRequest(cf.token, "GET", kvPath(cf, allowlistKey(ctx.block)));
    if (kv.http_status !== 200 && kv.http_status !== 404) return [{ ...base, status: "unresolved", provider_code: codeOf(kv), next_action: `flume identity credentials ${ctx.employee}` }];
    const stored = `mail/${ctx.block.handle}/`;
    const kept = `stored mail under ${stored} is kept; Flume has no R2 client and never deletes mail`;
    if (kv.http_status === 200) return [{ ...base, status: "static-usable", next_action: `flume identity suspend ${ctx.employee} --apply deletes the allowlist key (reversible); the facade also denies by status`, detail: kept }];
    const closed = Object.keys(ctx.steps).some(key => key === `mail:allowlist-delete:${allowlistKey(ctx.block).slice("allowlist/".length)}` && ctx.steps[key]!.status !== "unresolved") || "mail_allowlist" in ctx.captures;
    if (!closed) return [{ ...base, status: "not-issued", next_action: `flume identity provision ${ctx.employee} --apply creates the mailbox`, detail: kept }];
    if (ctx.status !== "retired") return [{ ...base, status: "suspended-reversible", next_action: `flume identity restore ${ctx.employee} --apply re-puts the captured allowlist record`, detail: kept }];
    // Retired: the allowlist key is gone and the employee's own routing rule must be disabled (or absent) for the mailbox to be closed.
    const rules = await listRules(cf);
    if (!rules.ok) return [{ ...base, status: "unresolved", provider_code: rules.code, next_action: `flume identity retire ${ctx.employee} --apply`, detail: kept }];
    const rule = literalRule(rules.items, ctx.block.email, cf.config.mailbox.worker);
    const open = rule !== undefined && pointsAtWorker(rule, cf.config.mailbox.worker) && rule.enabled !== false;
    return [{ ...base, kind: "mailbox-allowlist+routing", status: open ? "unresolved" : "revoked", ...(open ? { provider_code: "routing-rule-enabled" } : { read_back: "absent" as const }), next_action: open ? `flume identity retire ${ctx.employee} --apply disables the routing rule` : "none: the mailbox is closed and its stored mail is kept", detail: kept }];
  },
  plan(ctx, options) {
    const address = ctx.block.email.toLowerCase();
    const steps: PlannedStep[] = [{
      key: `mail:allowlist-delete:${address}`, adapter: "mail", action: "allowlist-delete", resource: allowlistKey(ctx.block),
      description: `capture then delete KV ${allowlistKey(ctx.block)}, verify by GET 404`,
      async run(context, hooks) {
        const cf = await cloudflareOf(context);
        if (!cf.ok) return { result: "unresolved", provider_code: cf.code, detail: cf.detail };
        const path = kvPath(cf, allowlistKey(context.block));
        const before = await cfRequest(cf.token, "GET", path);
        if (before.http_status === 404) return { result: "converged", detail: "the allowlist key was already absent" };
        if (before.http_status !== 200) return { result: "unresolved", provider_code: codeOf(before), detail: "could not read the allowlist record before deleting it" };
        if (!before.body || typeof before.body !== "object" || Array.isArray(before.body)) return { result: "unresolved", provider_code: "kv-record-unreadable", detail: "the allowlist record is not a JSON object; it was not deleted because restore could not put it back" };
        // Captured and persisted BEFORE the delete, so a crash after the delete still leaves restore its record.
        hooks.capture("mail_allowlist", { key: allowlistKey(context.block), record: before.body });
        const removed = await cfRequest(cf.token, "DELETE", path);
        const committed = cfOk(removed), absent = removed.http_status === 404;
        if (!committed && !absent) return { result: "unresolved", provider_code: codeOf(removed), detail: "the allowlist delete did not succeed" };
        const after = await cfRequest(cf.token, "GET", path);
        if (after.http_status !== 404) return { result: "unresolved", provider_code: after.http_status === 200 ? "delete-not-effective" : codeOf(after), detail: "the allowlist key was not read back as absent" };
        return { result: absent && !committed ? "converged" : "done", detail: "allowlist key absent (GET 404)" };
      },
    }];
    if (options.command === "retire") {
      steps.push({
        key: `mail:routing-disable:${address}`, adapter: "mail", action: "routing-disable", resource: ctx.block.email,
        description: `disable the employee's own literal routing rule for ${ctx.block.email}, verify by GET`,
        async run(context) {
          const cf = await cloudflareOf(context);
          if (!cf.ok) return { result: "unresolved", provider_code: cf.code, detail: cf.detail };
          const rules = await listRules(cf);
          if (!rules.ok) return { result: "unresolved", provider_code: rules.code, detail: "could not list routing rules completely" };
          const rule = literalRule(rules.items, context.block.email, cf.config.mailbox.worker);
          if (!rule) return { result: "converged", detail: "no routing rule exists for this address" };
          // A rule that does not point at our worker is not ours: never touched.
          if (!pointsAtWorker(rule, cf.config.mailbox.worker)) return { result: "converged", detail: "the address has a rule that does not point at the mailbox worker; it is foreign and was left untouched" };
          if (rule.enabled === false) return { result: "converged", detail: `rule ${rule.id} was already disabled` };
          const path = `/zones/${cf.config.cloudflare.zone_id}/email/routing/rules/${rule.id}`;
          const put = await cfRequest(cf.token, "PUT", path, { name: rule.name, enabled: false, matchers: rule.matchers, actions: rule.actions });
          if (!cfOk(put)) return { result: "unresolved", provider_code: codeOf(put), detail: `routing rule ${rule.id} could not be disabled` };
          const read = await cfRequest(cf.token, "GET", path);
          if (!cfOk(read) || read.body?.result?.enabled !== false) return { result: "unresolved", provider_code: cfOk(read) ? "disable-not-effective" : codeOf(read), detail: `routing rule ${rule.id} was not read back as disabled` };
          return { result: "done", detail: `routing rule ${rule.id} disabled (GET enabled:false)`, data: { rule_id: rule.id } };
        },
      });
    }
    return steps;
  },
  restorePlan(ctx) {
    const address = ctx.block.email.toLowerCase();
    const key = `mail:allowlist-delete:${address}`;
    const captured = ctx.captures.mail_allowlist as { key?: string; record?: unknown } | undefined;
    if (!ctx.steps[key] && !captured) return [];
    return [{
      key: `mail:allowlist-restore:${address}`, adapter: "mail", action: "allowlist-restore", resource: allowlistKey(ctx.block), reverses: key, releases: ["mail_allowlist"],
      description: `re-PUT the captured KV record for ${allowlistKey(ctx.block)}, verify by GET`,
      async run(context) {
        const cf = await cloudflareOf(context);
        if (!cf.ok) return { result: "unresolved", provider_code: cf.code, detail: cf.detail };
        const path = kvPath(cf, allowlistKey(context.block));
        const held = context.captures.mail_allowlist as { key?: string; record?: unknown } | undefined;
        const current = await cfRequest(cf.token, "GET", path);
        if (!held?.record) {
          if (current.http_status === 200) return { result: "converged", detail: "the allowlist key is present and nothing was captured to restore" };
          if (current.http_status !== 404) return { result: "unresolved", provider_code: codeOf(current), detail: "could not read the allowlist key" };
          // Suspend found no key to delete (`converged`): there was no mailbox to put back. Only a delete THIS lifecycle did needs a record.
          if (context.steps[key]?.status !== "done") return { result: "converged", detail: "nothing was captured; the allowlist key did not exist when the employee was suspended" };
          return { result: "unresolved", provider_code: "no-captured-record", detail: "no allowlist record was captured; run `flume identity provision` to recreate the mailbox" };
        }
        if (held.key !== allowlistKey(context.block)) return { result: "unresolved", provider_code: "capture-mismatch", detail: "the captured allowlist key is not this employee's" };
        if (current.http_status === 200 && isDeepStrictEqual(current.body, held.record)) return { result: "converged", detail: "the allowlist record is already present and identical" };
        const put = await cfRequest(cf.token, "PUT", path, held.record);
        if (!cfOk(put)) return { result: "unresolved", provider_code: codeOf(put), detail: "the captured allowlist record could not be written back" };
        const read = await cfRequest(cf.token, "GET", path);
        if (read.http_status !== 200 || !isDeepStrictEqual(read.body, held.record)) return { result: "unresolved", provider_code: "restore-readback-mismatch", detail: "the allowlist record was not read back identical" };
        return { result: "done", detail: "allowlist record restored (GET identical)" };
      },
    }];
  },
};

// ---------------------------------------------------------------------------
// cloudflare_access
// ---------------------------------------------------------------------------

export const cloudflareAccessAdapter: LifecycleAdapter = {
  name: "cloudflare_access",
  blockers: () => [],
  async inventory(ctx) {
    const evidence = cloudflareEvidence(ctx.env);
    const binding = ctx.block.bindings?.cloudflare_access;
    const base = { provider: "cloudflare_access" as const, kind: "access-service-token", static: true, evidence };
    const previous = rotatedAway(ctx, "cloudflare_access");
    if (!binding && !previous.length) return [{ ...base, status: "not-issued", next_action: `flume identity provision ${ctx.employee} --apply creates the Access service token` }];
    const cf = await cloudflareOf(ctx);
    const listed = cf.ok ? await listServiceTokens(cf) : undefined;
    const rows: CredentialRow[] = [];
    if (!binding) rows.push({ ...base, status: "not-issued", next_action: `flume identity provision ${ctx.employee} --apply creates the Access service token` });
    else {
      const row = { ...base, id: binding.principal, ref: binding.credential_ref };
      if (!cf.ok) rows.push({ ...row, status: "unverified", provider_code: cf.code, next_action: "set FLUME_PROVISION_CONFIG (docs/identity-provisioning.md); the token cannot be read or deleted without it", detail: cf.detail });
      else if (!listed!.ok) rows.push({ ...row, status: "unresolved", provider_code: listed!.code, next_action: `flume identity credentials ${ctx.employee}` });
      else {
        const token = listed!.items.find(candidate => candidate.client_id === binding.principal);
        rows.push(staticRow({ ...row, next_action: token ? `flume identity retire ${ctx.employee} --revoke cloudflare_access --apply deletes it; otherwise Access authenticates it until expires_at (the facade still denies by status)` : "none: the token no longer exists at Cloudflare", ...(token ? {} : { detail: "absent from the provider's complete service-token listing" }) },
          token ? undefined : "absent", { status: "static-usable", ...(token?.expires_at ? { expires_at: token.expires_at } : {}) }));
      }
    }
    // An old client secret cannot be probed; it dies only with its token, which the complete listing can show gone.
    const route = `Cloudflare cannot be asked about an old client secret: rotate or delete the service token in Zero Trust > Access > Service Auth (\`flume identity retire ${ctx.employee} --revoke cloudflare_access --apply\` deletes it by client_id)`;
    for (const rotated of previous) {
      const gone = listed?.ok && !listed.items.some(candidate => candidate.client_id === rotated.principal);
      rows.push(previousRow("cloudflare_access", rotated, evidence, route, gone ? "absent" : undefined,
        gone ? `the service token ${rotated.principal} is absent from the provider's complete listing, so no secret of it authenticates` : listed?.ok ? `the service token ${rotated.principal} is still listed; whether the old secret still authenticates is not observable` : `the service-token listing could not be read (${listed ? listed.code : cf.ok ? "unread" : cf.code})`));
    }
    return rows;
  },
  plan(ctx, options) {
    const binding = ctx.block.bindings?.cloudflare_access;
    if (!options.revoke) return [];
    if (!binding) return [];
    const key = `cloudflare_access:token-delete:${binding.principal}`;
    return [{
      key, adapter: "cloudflare_access", action: "token-delete", resource: binding.principal,
      description: `delete the Access service token ${binding.principal}, verify by listing again`,
      async live(context) {
        const cf = await cloudflareOf(context);
        if (!cf.ok) return null;
        const listed = await listServiceTokens(cf);
        if (!listed.ok) return null;
        const found = listed.items.find(candidate => candidate.client_id === binding.principal);
        return found ? [found.id] : [];
      },
      async run(context) {
        const cf = await cloudflareOf(context);
        if (!cf.ok) return { result: "unresolved", provider_code: cf.code, detail: cf.detail };
        const remembered = (context.steps[key]?.data as { token_id?: string } | undefined)?.token_id;
        const listed = await listServiceTokens(cf);
        if (!listed.ok && !remembered) return { result: "unresolved", provider_code: listed.code, detail: "could not list service tokens" };
        const found = listed.ok ? listed.items.find(candidate => candidate.client_id === binding.principal) : undefined;
        if (listed.ok && !found && !remembered) return { result: "converged", detail: "the service token is not at the provider", data: { resources: [] } };
        const id = found?.id ?? remembered!;
        const removed = await cfRequest(cf.token, "DELETE", `/accounts/${cf.config.cloudflare.account_id}/access/service_tokens/${id}`);
        const committed = cfOk(removed), absent = removed.http_status === 404;
        // The id is not a secret; keeping it lets a retry send the DELETE that a 500 left unanswered.
        if (!committed && !absent) return { result: "unresolved", provider_code: codeOf(removed), detail: "the service-token delete did not succeed", data: { token_id: id, resources: [id] } };
        const verify = await listServiceTokens(cf);
        if (!verify.ok) return { result: "unresolved", provider_code: verify.code, detail: "could not list service tokens to verify the delete", data: { token_id: id, resources: [id] } };
        if (verify.items.some(candidate => candidate.client_id === binding.principal)) return { result: "unresolved", provider_code: "delete-not-effective", detail: "the service token is still listed", data: { token_id: id, resources: [id] } };
        return { result: absent && !committed ? "converged" : "done", detail: "the service token is absent from the provider's listing", data: { token_id: id, resources: [id] } };
      },
    }];
  },
  restorePlan: () => [],
};

// ---------------------------------------------------------------------------
// github
// ---------------------------------------------------------------------------

function readProviderLedger(): Array<Record<string, any>> {
  const path = join(accessStateDir(), "provider-ledger.jsonl");
  if (!existsSync(path)) return [];
  const lines: Array<Record<string, any>> = [];
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try { lines.push(JSON.parse(text)); } catch { /* a torn line is not an observation */ }
  }
  return lines;
}

/** The capture that says THIS lifecycle owns an installation's suspension; written before the PUT, released only by restore. */
const suspensionCapture = (installationId: string): string => `github_suspend:${installationId}`;
/** A definitive 404 for an installation, kept because a deleted App key makes every later read 401. Installation IDs are never reused. */
const absenceCapture = (installationId: string): string => `github_installation_absent:${installationId}`;

const GITHUB_KEY_ROUTE = "delete the private key in the GitHub App settings (Developer settings > GitHub Apps > Private keys); `flume identity credentials` then re-probes: GET /app answering 401 is the only proof";

export const githubAdapter: LifecycleAdapter = {
  name: "github",
  blockers: () => [],
  async inventory(ctx) {
    const evidence = githubEvidence();
    const base = { provider: "github" as const, evidence };
    const rows: CredentialRow[] = [];
    const bound = githubBindingOf(ctx.block.bindings?.github);
    if ("code" in bound) {
      rows.push(bound.code === "no-provider-binding"
        ? { ...base, kind: "app-private-key", static: true, status: "not-issued", next_action: `flume identity bind ${ctx.employee} github ... binds the employee's own App` }
        : { ...base, kind: "app-private-key", static: true, status: "unverified", provider_code: bound.code, next_action: "repair the github binding", detail: bound.detail });
    } else {
      const facts = bound.facts;
      // 1. the App private key: static, probed by what GitHub says to an app JWT it signs.
      const probe = await probeGithubAppKey({ appId: facts.appId, keyRef: facts.keyRef }, ctx.env);
      const keyBase = { ...base, kind: "app-private-key", ref: facts.keyRef, static: true, next_action: GITHUB_KEY_ROUTE };
      rows.push(staticRow(keyBase, probe.state === "rejected" ? "rejected" : undefined,
        probe.state === "accepted" ? { status: "static-usable" } : probe.state === "rejected" ? { status: "unverified" } : { status: probe.state, provider_code: probe.code, next_action: `flume identity credentials ${ctx.employee}` }));
      // 2. the installation.
      const installation = await readGithubInstallation({ appId: facts.appId, keyRef: facts.keyRef, installationId: facts.installationId }, ctx.env);
      const installationBase = { ...base, kind: "installation", id: facts.installationId, static: false };
      let suspended = false;
      if (installation.state === "present") {
        suspended = installation.suspended_at !== null;
        rows.push(suspended
          ? { ...installationBase, status: "suspended-reversible", detail: `suspended_at ${installation.suspended_at}`, next_action: `flume identity restore ${ctx.employee} --apply un-suspends it if this lifecycle suspended it; anyone holding the App key can un-suspend it` }
          : { ...installationBase, status: "static-usable", next_action: `flume identity retire ${ctx.employee} --revoke github --apply suspends the installation (reversible; the App key still can un-suspend it)` });
      } else if (installation.state === "absent") {
        const observedAt = new Date().toISOString();
        if (!(absenceCapture(facts.installationId) in ctx.captures)) ctx.remember?.(absenceCapture(facts.installationId), { observed_at: observedAt });
        rows.push({ ...installationBase, status: "revoked", read_back: "absent", detail: "GitHub answered 404: no such installation", next_action: "none: the installation no longer exists" });
      } else {
        // Once the App key is deleted, GitHub answers 401 to the installation read as well: the row cannot be re-read. Only a
        // 404 an earlier apply recorded (before the key went) still speaks for it; without one the row stays honest and open.
        const remembered = ctx.captures[absenceCapture(facts.installationId)] as { observed_at?: string } | undefined;
        if (remembered) rows.push({ ...installationBase, status: "revoked", read_back: "absent", detail: `GitHub answered 404 for this installation at ${remembered.observed_at ?? "an earlier apply"}; it cannot be re-read now (${installation.code}) and installation IDs are never reused`, next_action: "none: the installation no longer exists" });
        else rows.push({ ...installationBase, status: installation.unresolved ? "unresolved" : "unverified", provider_code: installation.code,
          next_action: probe.state === "rejected" ? `GitHub rejects the App key, so the installation can no longer be read: if the App is uninstalled, nothing recorded it. Next time uninstall first, run \`flume identity retire ${ctx.employee} --revoke github --apply\` (it records GitHub's 404), then delete the key` : `flume identity credentials ${ctx.employee}` });
      }
      // 3. the unexpired installation tokens this facade issued, from its own ledger (GitHub cannot list them).
      const now = Date.now(), seen = new Set<string>();
      for (const line of readProviderLedger()) {
        if (line.subject !== ctx.block.subject || String(line.installation_id) !== facts.installationId) continue;
        const tokenBase = { ...base, kind: "installation-token", id: String(line.grant_id ?? "unknown"), static: false };
        let expires: number | undefined, status: RowStatus | undefined, code: string | undefined;
        if (line.event === "issued") { expires = Date.parse(String(line.expires_at)); status = suspended ? "suspended-reversible" : "residual-expiry"; }
        else if (line.event === "revoke-failed") { expires = Date.parse(String(line.expires_at)); status = "unverified"; code = "revoke-failed"; }
        else if (line.event === "ambiguous") { expires = Date.parse(String(line.at)) + 3_600_000; status = "unverified"; code = "issuance-ambiguous"; }
        if (status === undefined || expires === undefined || !Number.isFinite(expires) || expires <= now) continue;
        const identity = `${tokenBase.id}:${line.event}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        rows.push({ ...tokenBase, status, expires_at: new Date(expires).toISOString(), ...(code ? { provider_code: code } : {}), next_action: suspended ? "none until restore: the installation is suspended; GitHub fixes the token at expires_at (at most 1 hour)" : "none: GitHub fixes installation tokens at 1 hour and cannot revoke them in bulk; `--revoke github` suspends the installation meanwhile" });
      }
    }
    // 4. App private keys rotated away from: each is probed by itself, and only GitHub's 401 to it revokes the row.
    for (const rotated of rotatedAway(ctx, "github")) {
      const probe = /^\d+$/u.test(rotated.principal) ? await probeGithubAppKey({ appId: rotated.principal, keyRef: rotated.ref }, ctx.env) : { state: "unverified" as const, code: "no-app-id" };
      rows.push(previousRow("github", rotated, base.evidence, `delete the OLD private key in the GitHub App settings (Developer settings > GitHub Apps > Private keys); \`flume identity credentials ${ctx.employee}\` then re-probes it`, probe.state === "rejected" ? "rejected" : undefined,
        probe.state === "rejected" ? "GitHub answered 401 to an app JWT signed with the old key" : probe.state === "accepted" ? "GitHub still accepts an app JWT signed with the old key" : `the old key could not be probed (${probe.code})`));
    }
    return rows;
  },
  plan(ctx, options) {
    if (!options.revoke) return [];
    const bound = githubBindingOf(ctx.block.bindings?.github);
    if (!ctx.block.bindings?.github) return [];
    const key = "code" in bound ? "github:installation-suspend:unbound" : `github:installation-suspend:${bound.facts.installationId}`;
    return [{
      key, adapter: "github", action: "installation-suspend", resource: "code" in bound ? "github" : bound.facts.installationId,
      description: "code" in bound ? "suspend the GitHub installation" : `suspend installation ${bound.facts.installationId}, verify by GET suspended_at`,
      async run(context, hooks) {
        if ("code" in bound) return { result: "unresolved", provider_code: bound.code, detail: bound.detail };
        const facts = { appId: bound.facts.appId, keyRef: bound.facts.keyRef, installationId: bound.facts.installationId };
        const owned = suspensionCapture(facts.installationId);
        const before = await readGithubInstallation(facts, context.env);
        if (before.state === "absent") return { result: "converged", detail: "GitHub has no such installation" };
        if (before.state === "error") return { result: "unresolved", provider_code: before.code, detail: "could not read the installation" };
        if (before.suspended_at) {
          // Ours if THIS lifecycle sent the PUT (captured before it) and only lost the answer: a 5xx after commit, a failed read-back.
          const mine = context.captures[owned] as { operation_id?: string } | undefined;
          if (mine) return { result: "done", detail: `installation suspended (suspended_at ${before.suspended_at}) by this lifecycle's PUT of operation ${mine.operation_id ?? "unknown"}; its answer had been lost` };
          return { result: "converged", detail: "the installation was already suspended; this lifecycle did not suspend it" };
        }
        // Owned BEFORE the PUT, so a PUT that commits behind a 5xx or a lost read-back is still ours to report and to undo.
        hooks.capture(owned, { operation_id: hooks.operation_id, at: new Date().toISOString() });
        const put = await writeGithubInstallationSuspension(facts, true, context.env);
        if (!put.ok && put.absent) return { result: "converged", detail: "GitHub has no such installation" };
        if (!put.ok) return { result: "unresolved", provider_code: put.code, detail: "the installation could not be suspended (if the PUT committed anyway, the retry claims it)" };
        const after = await readGithubInstallation(facts, context.env);
        if (after.state !== "present" || !after.suspended_at) return { result: "unresolved", provider_code: after.state === "error" ? after.code : "suspend-not-effective", detail: "the installation was not read back as suspended" };
        return { result: "done", detail: `installation suspended (suspended_at ${after.suspended_at})` };
      },
    }];
  },
  restorePlan(ctx) {
    const bound = githubBindingOf(ctx.block.bindings?.github);
    if ("code" in bound) return [];
    const key = `github:installation-suspend:${bound.facts.installationId}`;
    const owned = suspensionCapture(bound.facts.installationId);
    // Only an installation THIS lifecycle suspended (`done`, or a PUT it sent and never heard back from) is ours to un-suspend;
    // a `converged` one was already suspended by someone else.
    if (ctx.steps[key]?.status !== "done" && !(owned in ctx.captures)) return [];
    return [{
      key: `github:installation-unsuspend:${bound.facts.installationId}`, adapter: "github", action: "installation-unsuspend", resource: bound.facts.installationId, reverses: key, releases: [owned],
      description: `un-suspend installation ${bound.facts.installationId}, verify suspended_at is null`,
      async run(context) {
        const facts = { appId: bound.facts.appId, keyRef: bound.facts.keyRef, installationId: bound.facts.installationId };
        const before = await readGithubInstallation(facts, context.env);
        if (before.state === "absent") return { result: "converged", detail: "GitHub has no such installation" };
        if (before.state === "error") return { result: "unresolved", provider_code: before.code, detail: "could not read the installation" };
        if (!before.suspended_at) return { result: "converged", detail: "the installation is not suspended" };
        const del = await writeGithubInstallationSuspension(facts, false, context.env);
        if (!del.ok && !del.absent) return { result: "unresolved", provider_code: del.code, detail: "the installation could not be un-suspended" };
        const after = await readGithubInstallation(facts, context.env);
        if (after.state !== "present" || after.suspended_at) return { result: "unresolved", provider_code: after.state === "error" ? after.code : "unsuspend-not-effective", detail: "the installation was not read back as active" };
        return { result: "done", detail: "installation un-suspended (suspended_at null)" };
      },
    }];
  },
};

// ---------------------------------------------------------------------------
// plane (read-only: Flume has no Plane client and no px write verb)
// ---------------------------------------------------------------------------

/** The first board Pilot verified for this subject at this principal and instance, from the latest matching `plane.adopt` receipt. */
function verifiedBoard(ctx: LifecycleContext, match: (line: Record<string, any>) => boolean): string | undefined {
  const receipt = readPlaneReceipts(ctx.env).filter(line => line.kind === "plane.adopt" && line.subject === ctx.block.subject && match(line)).pop();
  const first = receipt?.boards?.[0] as { identifier?: string; id?: string } | undefined;
  return first?.identifier || first?.id || undefined;
}

export const planeAdapter: LifecycleAdapter = {
  name: "plane",
  blockers: () => [],
  async inventory(ctx) {
    const evidence = planeEvidence(ctx.env);
    const base = { provider: "plane" as const, kind: "plane-personal-access-token", static: true, evidence };
    const revocation = `the employee deletes the token: ${PLANE_CREDENTIAL_SEMANTICS.revocation.native}; an admin may instead remove the board membership (${PLANE_CREDENTIAL_SEMANTICS.revocation.board_access}). Flume has no Plane client`;
    const rows: CredentialRow[] = [];
    const binding = ctx.block.bindings?.plane;
    const bound = planeBindingOf(binding);
    if ("code" in bound || !binding) {
      rows.push(!binding || ("code" in bound && bound.code === "no-provider-binding")
        ? { ...base, status: "not-issued", next_action: `flume identity bind ${ctx.employee} plane ... (the employee enrolls by hand first)` }
        : { ...base, status: "unverified", provider_code: "code" in bound ? bound.code : "provider-binding-invalid", next_action: "repair the plane binding", detail: "code" in bound ? bound.detail : undefined });
    } else {
      const row = { ...base, ref: bound.facts.keyRef, next_action: revocation };
      // The board comes from Pilot's own earlier verification of THIS binding, never from a guess.
      const board = verifiedBoard(ctx, line => line.credential_ref === binding.credential_ref && line.principal === binding.principal && line.instance === binding.instance);
      if (!board) rows.push({ ...row, status: "unverified", provider_code: "no-verified-board", detail: "no plane.adopt receipt for the current binding names a board; `flume identity adopt-actor <employee> plane --board <b> --apply` records one" });
      else {
        const checked = verifyBoardViaPx(bound.facts, ctx.block.handle, ctx.block.email, board, ctx.env);
        if ("proof" in checked) rows.push({ ...row, status: "static-usable", detail: "Pilot verified the token as the employee's own; its expiry is not observable (a Plane PAT's expiry is shown only to its owner's session)" });
        else if (checked.blocker.provider_code === "credential_rejected") rows.push(staticRow({ ...row, provider_code: "credential_rejected", detail: "Pilot read back Plane's rejection of the token", next_action: "none: Plane rejects this token" }, "rejected", { status: "unverified" }));
        else if (checked.blocker.code === "provider-unavailable") rows.push({ ...row, status: "unresolved", provider_code: "provider-unavailable", detail: checked.blocker.detail });
        else rows.push({ ...row, status: "unverified", provider_code: checked.blocker.provider_code ?? checked.blocker.code, detail: checked.blocker.detail });
      }
    }
    // PATs rotated away from: Pilot verifies each OLD reference itself; only Plane's rejection of it revokes the row.
    for (const rotated of rotatedAway(ctx, "plane")) {
      const facts = planeBindingOf({ principal: rotated.principal, instance: rotated.instance, credential_ref: rotated.ref, attribution_mode: "native" });
      const board = verifiedBoard(ctx, line => line.principal === rotated.principal && line.instance === rotated.instance);
      let readBack: "rejected" | undefined, detail: string;
      if ("code" in facts) detail = `the old reference cannot be probed: ${facts.detail}`;
      else if (!board) detail = "no plane.adopt receipt names a board to probe the old token on";
      else {
        const checked = verifyBoardViaPx(facts.facts, ctx.block.handle, ctx.block.email, board, ctx.env);
        if ("proof" in checked) detail = "Pilot verified the OLD token: it still authenticates as the employee";
        else if (checked.blocker.provider_code === "credential_rejected") { readBack = "rejected"; detail = "Pilot read back Plane's rejection of the old token"; }
        else detail = `Pilot could not settle the old token (${checked.blocker.provider_code ?? checked.blocker.code})`;
      }
      rows.push(previousRow("plane", rotated, evidence, `the employee deletes the OLD token: ${PLANE_CREDENTIAL_SEMANTICS.revocation.native}; Flume has no Plane client`, readBack, detail));
    }
    return rows;
  },
  plan: () => [],
  restorePlan: () => [],
};

// ---------------------------------------------------------------------------
// gateway (FLUME-39 owns minting and rotation; revocation here is `gateway-tokens.py revoke`)
// ---------------------------------------------------------------------------

/** The FLUME-39 shared item: `scripts/gateway-member-tokens.py` writes each consumer's token as one field of it. */
export const GATEWAY_TOKENS_ITEM = "yeurk5dpqkaarspvsn3cjtmkki";
const GATEWAY_REF = new RegExp(`^op://DeLoSecrets/${GATEWAY_TOKENS_ITEM}/([A-Za-z0-9][A-Za-z0-9_-]{0,39})$`, "u");

function gatewayBin(env: NodeJS.ProcessEnv): string {
  return env.FLUME_GATEWAY_TOKENS_BIN || join(env.HOME || homedir(), "docker", "stacks", "ai", "newapi", "ops", "gateway-tokens.py");
}

export function gatewayLink(env: NodeJS.ProcessEnv = process.env) {
  const evidencePath = env.FLUME_GATEWAY_EVIDENCE || join(resolveFlumeRoot(), "_bmad-output", "implementation-artifacts", "FLUME-39");
  return { owner_ticket: "FLUME-39", evidence_path: evidencePath, evidence_status: (existsSync(evidencePath) ? "present" : "unverified") as "present" | "unverified" };
}

function fleetHome(census: IdentityCensus, env: NodeJS.ProcessEnv): string {
  return env.HERMES_FLEET_HOME || join(census.home, ".hermes");
}

function refIn(path: string): string | undefined {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return undefined;
    const doc = YAML.parse(readFileSync(path, "utf8")) as { secrets?: { onepassword?: { env?: Record<string, unknown> } } } | null;
    const ref = doc?.secrets?.onepassword?.env?.AUTOMATICAI_GATEWAY_KEY;
    return typeof ref === "string" ? ref : undefined;
  } catch { return undefined; }
}

export type GatewayRefSource = "delta" | "generated" | "base" | "launcher";
interface GatewayDesk { profile: string | null; ref?: string; source?: GatewayRefSource; consumer?: string; shape: "ok" | "none" | "bad"; shared: boolean }

/**
 * The reference a desk actually RUNS with, in the order Hermes resolves it: the desk's own `config.delta.yaml`, then its
 * generated `config.yaml`, then (a post's desk only) the fleet base `config.yaml` it inherits from. A portable specialist's
 * launcher injects its own reference, so a specialist never falls back to the base.
 */
function deskRef(fleet: string, profile: string | null, kind: IdentityDefinition["kind"], baseRef: string | undefined): { ref?: string; source?: GatewayRefSource } {
  if (profile) {
    const delta = refIn(join(fleet, "profiles", profile, "config.delta.yaml"));
    if (delta) return { ref: delta, source: "delta" };
    const generated = refIn(join(fleet, "profiles", profile, "config.yaml"));
    if (generated) return { ref: generated, source: "generated" };
  }
  return kind === "post" && baseRef ? { ref: baseRef, source: "base" } : {};
}

/** `launchSpecialist` reads this reference (not the FLUME-39 shape) and injects it whatever the desk config says. */
const launcherRef = (target: IdentityDefinition, profile: string | null): string => `op://DeLoSecrets/hermes-${target.person ?? profile ?? "unknown"}/credential`;

function gatewayDesk(ctx: Pick<LifecycleContext, "census" | "target" | "env">): GatewayDesk {
  const fleet = fleetHome(ctx.census, ctx.env);
  const baseRef = refIn(join(fleet, "config.yaml"));
  const profile = deskProfileOf(ctx.census, ctx.target);
  const own = deskRef(fleet, profile, ctx.target.kind, baseRef);
  const ownShaped = own.ref ? GATEWAY_REF.exec(own.ref) : null;
  if (ctx.target.kind === "specialist" && !ownShaped) return { profile, ref: launcherRef(ctx.target, profile), source: "launcher", shape: "bad", shared: false };
  if (!own.ref) return { profile, shape: "none", shared: false };
  // The same reference as the fleet base is the base consumer's key, whichever file carried it.
  const sharedWithBase = baseRef !== undefined && own.ref === baseRef;
  if (!ownShaped) return { profile, ref: own.ref, source: own.source, shape: "bad", shared: sharedWithBase };
  const consumer = ownShaped[1]!;
  let shared = sharedWithBase;
  for (const other of ctx.census.definitions) {
    if (shared || other.path === ctx.target.path || other.missing) continue;
    const otherRef = deskRef(fleet, deskProfileOf(ctx.census, other), other.kind, baseRef).ref;
    if (otherRef && GATEWAY_REF.exec(otherRef)?.[1] === consumer) shared = true;
  }
  return { profile, ref: own.ref, source: own.source, consumer, shape: "ok", shared };
}

/** The consumer behind an employee's desk gateway reference, only in the FLUME-39 shape; never inferred from a name. */
export function gatewayConsumerOf(census: IdentityCensus, target: IdentityDefinition, env: NodeJS.ProcessEnv = process.env): { consumer?: string; shape: "ok" | "none" | "bad"; shared: boolean; source?: GatewayRefSource } {
  const desk = gatewayDesk({ census, target, env });
  return { ...(desk.consumer ? { consumer: desk.consumer } : {}), shape: desk.shape, shared: desk.shared, ...(desk.source ? { source: desk.source } : {}) };
}

function runGateway(env: NodeJS.ProcessEnv, args: string[]): { ok: true; stdout: string } | { ok: false; code: string } {
  const run = spawnSync(gatewayBin(env), args, { encoding: "utf8", timeout: 90_000, shell: false, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env });
  if (run.error) return { ok: false, code: (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "provider-timeout" : "provider-unavailable" };
  if (run.status !== 0) return { ok: false, code: "provider-unavailable" };
  return { ok: true, stdout: run.stdout ?? "" };
}

interface GatewayToken { id: unknown; name: unknown; status: unknown; expired_time: unknown }

/** Only `id`, `name`, `status` and `expired_time` are ever copied out of the gateway's answer. */
function gatewayStatus(env: NodeJS.ProcessEnv, consumer: string): { ok: true; tokens: GatewayToken[] } | { ok: false; code: string } {
  const run = runGateway(env, ["status", consumer]);
  if (!run.ok) return run;
  let parsed: { consumer?: unknown; tokens?: unknown };
  try { parsed = JSON.parse(run.stdout); } catch { return { ok: false, code: "provider-result-mismatch" }; }
  if (parsed.consumer !== consumer || !Array.isArray(parsed.tokens)) return { ok: false, code: "provider-result-mismatch" };
  return { ok: true, tokens: (parsed.tokens as Array<Record<string, unknown>>).map(token => ({ id: token.id, name: token.name, status: token.status, expired_time: token.expired_time })) };
}

export const gatewayAdapter: LifecycleAdapter = {
  name: "gateway",
  blockers(ctx, options) {
    if (!options.revoke) return [];
    // A desk with no reference, or one that is not the FLUME-39 shape, plans no gateway step; the inventory row says why.
    const desk = gatewayDesk(ctx);
    if (desk.shared) return [{ code: "shared-consumer", detail: `the desk runs on ${desk.consumer ? `consumer ${desk.consumer}` : `reference ${desk.ref}`}${desk.source === "base" || desk.source === "generated" ? `, inherited from the fleet base config` : ""}, which is shared with the fleet base or another desk; revoking it would cut them off too. Mint this employee a dedicated token first (FLUME-39), or name only the other adapters (--revoke cloudflare_access --revoke github)` }];
    return [];
  },
  async inventory(ctx) {
    const link = gatewayLink(ctx.env);
    const evidence = ctx.env.FLUME_GATEWAY_TOKENS_BIN ? "fixture" as const : "provider" as const;
    const base = { provider: "gateway" as const, kind: "gateway-token", static: true, evidence, ...link };
    const desk = gatewayDesk(ctx);
    if (desk.shape === "none") return [{ ...base, status: "not-issued", next_action: "FLUME-39 mints a per-employee gateway token; neither this desk nor the fleet base maps one" }];
    const sharedFields = desk.shared ? { shared_consumer: true } : {};
    if (desk.shape === "bad") {
      return [{ ...base, ref: desk.ref, ...(desk.source ? { ref_source: desk.source } : {}), ...sharedFields, status: "unverified", provider_code: "gateway-ref-shape",
        next_action: `FLUME-39 owns the gateway reference shape (op://DeLoSecrets/${GATEWAY_TOKENS_ITEM}/<consumer>)`,
        ...(desk.source === "launcher" ? { detail: "a portable specialist's launcher injects this reference, which is not the FLUME-39 shape: no consumer can be named or revoked, and the key may be live" } : desk.shared ? { detail: "the desk runs on the fleet base gateway reference" } : {}) }];
    }
    const consumer = desk.consumer!;
    const row = { ...base, ref: desk.ref, ...(desk.source ? { ref_source: desk.source } : {}), id: consumer, consumer, ...sharedFields };
    const retireCommand = desk.shared
      ? `shared consumer${desk.source === "base" || desk.source === "generated" ? " inherited from the fleet base" : ""}: FLUME-39 mints this employee a dedicated token (gateway-tokens.py mint) and the desk maps it; until then this desk can use the shared key and no lifecycle may revoke it`
      : `flume identity retire ${ctx.employee} --revoke gateway --apply runs gateway-tokens.py revoke ${consumer}`;
    const status = gatewayStatus(ctx.env, consumer);
    if (!status.ok) return [{ ...row, status: "unresolved", provider_code: status.code, next_action: `flume identity credentials ${ctx.employee}` }];
    if (!status.tokens.length) return [staticRow({ ...row, detail: "gateway-tokens status lists no tokens for this consumer", next_action: "none: no gateway token exists for this consumer" }, "absent", { status: "unverified" })];
    const now = Date.now() / 1000;
    return status.tokens.map((token): CredentialRow => {
      const tokenRow = { ...row, id: String(token.id), name: String(token.name ?? "") };
      const expired = typeof token.expired_time === "number" ? token.expired_time : undefined;
      if (token.status !== 1) return { ...tokenRow, status: "unverified", provider_code: "token-disabled", next_action: retireCommand };
      if (expired === undefined) return { ...tokenRow, status: "unverified", provider_code: "expiry-unreadable", next_action: retireCommand };
      if (expired !== -1 && expired <= now) return { ...tokenRow, status: "unverified", provider_code: "token-expired", expires_at: new Date(expired * 1000).toISOString(), next_action: retireCommand };
      // A shared key the employee's desk can use is usable however long it lives: nothing this lifecycle runs can end it.
      if (desk.shared) return { ...tokenRow, status: "static-usable", ...(expired !== -1 ? { expires_at: new Date(expired * 1000).toISOString() } : {}), detail: "a live token of a shared consumer this desk runs on", next_action: retireCommand };
      if (expired === -1) return { ...tokenRow, status: "static-usable", detail: "expired_time -1: the gateway token never expires", next_action: retireCommand };
      return { ...tokenRow, status: "residual-expiry", expires_at: new Date(expired * 1000).toISOString(), next_action: retireCommand };
    });
  },
  plan(ctx, options) {
    if (!options.revoke) return [];
    const desk = gatewayDesk(ctx);
    if (desk.shape !== "ok" || desk.shared) return [];
    const consumer = desk.consumer!;
    return [{
      key: `gateway:token-revoke:${consumer}`, adapter: "gateway", action: "token-revoke", resource: consumer,
      description: `gateway-tokens.py revoke ${consumer}, verify status lists no tokens`,
      async live(context) {
        const status = gatewayStatus(context.env, consumer);
        return status.ok ? status.tokens.map(token => String(token.id)) : null;
      },
      async run(context) {
        // What this revoke acts on is recorded, so a token minted later (FLUME-39) is new work and these never are again.
        const before = gatewayStatus(context.env, consumer);
        const resources = before.ok ? before.tokens.map(token => String(token.id)) : [];
        const run = runGateway(context.env, ["revoke", consumer]);
        if (!run.ok) return { result: "unresolved", provider_code: run.code, detail: "gateway-tokens revoke did not succeed", data: { resources } };
        const count = /revoked (\d+) tokens?/u.exec(run.stdout);
        const verify = gatewayStatus(context.env, consumer);
        if (!verify.ok) return { result: "unresolved", provider_code: verify.code, detail: "could not read the gateway status after the revoke", data: { resources } };
        if (verify.tokens.length) return { result: "unresolved", provider_code: "revoke-not-effective", detail: "the gateway still lists tokens for this consumer", data: { resources } };
        return { result: count && Number(count[1]) === 0 ? "converged" : "done", detail: "gateway status lists no tokens", data: { resources } };
      },
    }];
  },
  restorePlan: () => [],
};

export const DEFAULT_ADAPTERS: Record<AdapterName, LifecycleAdapter> = {
  mail: mailAdapter, cloudflare_access: cloudflareAccessAdapter, github: githubAdapter, plane: planeAdapter, gateway: gatewayAdapter,
};
