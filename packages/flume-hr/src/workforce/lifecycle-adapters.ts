// FLUME-53: the providers' honest lifecycle semantics, one adapter each, in one place.
//
// An adapter does three things and nothing else: it INVENTORIES what one provider still lets the employee do (read-only),
// it PLANS the steps `suspend|retire` and `restore` run for it, and each step RUNS one resource-scoped provider mutation
// and reads it back. The coordinator (lifecycle.ts) owns ordering, convergence keys, the state and the ledger.
//
// What a row may say is decided here and only here:
//   * `revoked` is claimed for a static credential only when the provider has READ BACK its rejection or absence: an
//     Access service token that is gone from the provider's listing, a GitHub app-JWT `GET /app` that answers 401, Pilot's
//     `credential_rejected`, a gateway `status` that lists no tokens. A local status, a grant TTL or a step that merely
//     ran never makes a row `revoked` (see `staticRow()`, the one place a static row is allowed to become `revoked`).
//   * A GitHub installation that is suspended is `suspended-reversible`: un-suspending revives every unexpired token, and
//     anyone holding the App key can do it.
//   * A Plane PAT, a GitHub App private key and a gateway token with no expiry are static: `static-usable` until a
//     provider says otherwise, and `manual-action-required` once the employee is retired.
// Nothing here ever holds, returns or logs a secret value: rows carry IDs, `op://` references and codes.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { resolveFlumeRoot } from "../kernel/paths";
import { accessStateDir } from "./access";
import { deskProfileOf, type IdentityBlocker, type IdentityCensus, type IdentityDefinition } from "./company";
import { githubBindingOf, githubEvidence, probeGithubAppKey, readGithubInstallation, writeGithubInstallationSuspension } from "./github";
import { PLANE_CREDENTIAL_SEMANTICS, planeBindingOf, planeEvidence, readPlaneReceipts, verifyBoardViaPx } from "./plane";
import { cfError, cfOk, cfRequest, cloudflareEvidence, loadProvisioningConfig, opRead, type CfResponse, type CfRoutingRule, type CfServiceToken, type ProvisioningConfig } from "./provision";
import type { StepRecord } from "./lifecycle-state";
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
}

export interface StepOutcome { result: "done" | "converged" | "unresolved"; provider_code?: string; detail?: string; data?: Record<string, unknown> }
export interface StepHooks { capture(name: string, value: unknown): void }

export interface PlannedStep {
  /** Resource-scoped convergence key, e.g. `cloudflare_access:token-delete:<client_id>`. */
  key: string;
  adapter: AdapterName;
  action: string;
  resource: string;
  description: string;
  /** Restore only: the suspension step key this step reverses; the coordinator clears it on success. */
  reverses?: string;
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

async function listServiceTokens(cf: { token: string; config: ProvisioningConfig }): Promise<{ ok: true; tokens: CfServiceToken[] } | { ok: false; code: string }> {
  const tokens: CfServiceToken[] = [];
  const seen = new Set<string>();
  const perPage = 50;
  for (let page = 1; page <= 40; page++) {
    const list = await cfRequest(cf.token, "GET", `/accounts/${cf.config.cloudflare.account_id}/access/service_tokens?per_page=${perPage}&page=${page}`);
    if (!cfOk(list)) return { ok: false, code: codeOf(list) };
    const result = (list.body?.result ?? []) as CfServiceToken[];
    let fresh = 0;
    for (const token of result) if (!seen.has(token.id)) { seen.add(token.id); tokens.push(token); fresh++; }
    const totalPages = Number(list.body?.result_info?.total_pages);
    if (fresh === 0 || result.length < perPage || (Number.isFinite(totalPages) && page >= totalPages)) break;
  }
  return { ok: true, tokens };
}

async function listRules(cf: { token: string; config: ProvisioningConfig }): Promise<{ ok: true; rules: CfRoutingRule[] } | { ok: false; code: string }> {
  const list = await cfRequest(cf.token, "GET", `/zones/${cf.config.cloudflare.zone_id}/email/routing/rules`);
  return cfOk(list) ? { ok: true, rules: (list.body?.result ?? []) as CfRoutingRule[] } : { ok: false, code: codeOf(list) };
}

/** The employee's OWN literal rule: a `to` matcher for exactly their address. Whether it is ours is decided by its action. */
const literalRule = (rules: CfRoutingRule[], email: string): CfRoutingRule | undefined => rules.find(rule => rule.matchers?.some(m => m.type === "literal" && m.field === "to" && m.value?.toLowerCase() === email.toLowerCase()));
const pointsAtWorker = (rule: CfRoutingRule, worker: string): boolean => rule.actions?.some(action => action.type === "worker" && (action.value ?? []).includes(worker)) ?? false;

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
    const rule = literalRule(rules.rules, ctx.block.email);
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
          if (!rules.ok) return { result: "unresolved", provider_code: rules.code, detail: "could not list routing rules" };
          const rule = literalRule(rules.rules, context.block.email);
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
      key: `mail:allowlist-restore:${address}`, adapter: "mail", action: "allowlist-restore", resource: allowlistKey(ctx.block), reverses: key,
      description: `re-PUT the captured KV record for ${allowlistKey(ctx.block)}, verify by GET`,
      async run(context) {
        const cf = await cloudflareOf(context);
        if (!cf.ok) return { result: "unresolved", provider_code: cf.code, detail: cf.detail };
        const path = kvPath(cf, allowlistKey(context.block));
        const held = context.captures.mail_allowlist as { key?: string; record?: unknown } | undefined;
        const current = await cfRequest(cf.token, "GET", path);
        if (!held?.record) {
          return current.http_status === 200 ? { result: "converged", detail: "the allowlist key is present and nothing was captured to restore" } : { result: "unresolved", provider_code: "no-captured-record", detail: "no allowlist record was captured; run `flume identity provision` to recreate the mailbox" };
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
    if (!binding) return [{ ...base, status: "not-issued", next_action: `flume identity provision ${ctx.employee} --apply creates the Access service token` }];
    const row = { ...base, id: binding.principal, ref: binding.credential_ref };
    const cf = await cloudflareOf(ctx);
    if (!cf.ok) return [{ ...row, status: "unverified", provider_code: cf.code, next_action: "set FLUME_PROVISION_CONFIG (docs/identity-provisioning.md); the token cannot be read or deleted without it", detail: cf.detail }];
    const listed = await listServiceTokens(cf);
    if (!listed.ok) return [{ ...row, status: "unresolved", provider_code: listed.code, next_action: `flume identity credentials ${ctx.employee}` }];
    const token = listed.tokens.find(candidate => candidate.client_id === binding.principal);
    return [staticRow({ ...row, next_action: token ? `flume identity retire ${ctx.employee} --revoke cloudflare_access --apply deletes it; otherwise Access authenticates it until expires_at (the facade still denies by status)` : "none: the token no longer exists at Cloudflare", ...(token ? {} : { detail: "absent from the provider's service-token listing" }) },
      token ? undefined : "absent", { status: "static-usable", ...(token?.expires_at ? { expires_at: token.expires_at } : {}) })];
  },
  plan(ctx, options) {
    const binding = ctx.block.bindings?.cloudflare_access;
    if (!options.revoke) return [];
    if (!binding) return [];
    const key = `cloudflare_access:token-delete:${binding.principal}`;
    return [{
      key, adapter: "cloudflare_access", action: "token-delete", resource: binding.principal,
      description: `delete the Access service token ${binding.principal}, verify by listing again`,
      async run(context) {
        const cf = await cloudflareOf(context);
        if (!cf.ok) return { result: "unresolved", provider_code: cf.code, detail: cf.detail };
        const remembered = (context.steps[key]?.data as { token_id?: string } | undefined)?.token_id;
        const listed = await listServiceTokens(cf);
        if (!listed.ok && !remembered) return { result: "unresolved", provider_code: listed.code, detail: "could not list service tokens" };
        const found = listed.ok ? listed.tokens.find(candidate => candidate.client_id === binding.principal) : undefined;
        if (listed.ok && !found && !remembered) return { result: "converged", detail: "the service token is not at the provider" };
        const id = found?.id ?? remembered!;
        const removed = await cfRequest(cf.token, "DELETE", `/accounts/${cf.config.cloudflare.account_id}/access/service_tokens/${id}`);
        const committed = cfOk(removed), absent = removed.http_status === 404;
        // The id is not a secret; keeping it lets a retry send the DELETE that a 500 left unanswered.
        if (!committed && !absent) return { result: "unresolved", provider_code: codeOf(removed), detail: "the service-token delete did not succeed", data: { token_id: id } };
        const verify = await listServiceTokens(cf);
        if (!verify.ok) return { result: "unresolved", provider_code: verify.code, detail: "could not list service tokens to verify the delete", data: { token_id: id } };
        if (verify.tokens.some(candidate => candidate.client_id === binding.principal)) return { result: "unresolved", provider_code: "delete-not-effective", detail: "the service token is still listed", data: { token_id: id } };
        return { result: absent && !committed ? "converged" : "done", detail: "the service token is absent from the provider's listing", data: { token_id: id } };
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

export const githubAdapter: LifecycleAdapter = {
  name: "github",
  blockers: () => [],
  async inventory(ctx) {
    const evidence = githubEvidence();
    const base = { provider: "github" as const, evidence };
    const bound = githubBindingOf(ctx.block.bindings?.github);
    if ("code" in bound) {
      return [bound.code === "no-provider-binding"
        ? { ...base, kind: "app-private-key", static: true, status: "not-issued", next_action: `flume identity bind ${ctx.employee} github ... binds the employee's own App` }
        : { ...base, kind: "app-private-key", static: true, status: "unverified", provider_code: bound.code, next_action: "repair the github binding", detail: bound.detail }];
    }
    const facts = bound.facts;
    const rows: CredentialRow[] = [];
    // 1. the App private key: static, probed by what GitHub says to an app JWT it signs.
    const probe = await probeGithubAppKey({ appId: facts.appId, keyRef: facts.keyRef }, ctx.env);
    const keyBase = { ...base, kind: "app-private-key", ref: facts.keyRef, static: true, next_action: "delete the private key in the GitHub App settings (Developer settings > GitHub Apps > Private keys); `flume identity credentials` then re-probes: GET /app answering 401 is the only proof" };
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
      rows.push({ ...installationBase, status: "revoked", read_back: "absent", detail: "GitHub answered 404: no such installation", next_action: "none: the installation no longer exists" });
    } else {
      rows.push({ ...installationBase, status: installation.unresolved ? "unresolved" : "unverified", provider_code: installation.code, next_action: `flume identity credentials ${ctx.employee}` });
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
      async run() {
        if ("code" in bound) return { result: "unresolved", provider_code: bound.code, detail: bound.detail };
        const facts = { appId: bound.facts.appId, keyRef: bound.facts.keyRef, installationId: bound.facts.installationId };
        const before = await readGithubInstallation(facts, ctx.env);
        if (before.state === "absent") return { result: "converged", detail: "GitHub has no such installation" };
        if (before.state === "error") return { result: "unresolved", provider_code: before.code, detail: "could not read the installation" };
        if (before.suspended_at) return { result: "converged", detail: "the installation was already suspended; this lifecycle did not suspend it" };
        const put = await writeGithubInstallationSuspension(facts, true, ctx.env);
        if (!put.ok && put.absent) return { result: "converged", detail: "GitHub has no such installation" };
        if (!put.ok) return { result: "unresolved", provider_code: put.code, detail: "the installation could not be suspended" };
        const after = await readGithubInstallation(facts, ctx.env);
        if (after.state !== "present" || !after.suspended_at) return { result: "unresolved", provider_code: after.state === "error" ? after.code : "suspend-not-effective", detail: "the installation was not read back as suspended" };
        return { result: "done", detail: `installation suspended (suspended_at ${after.suspended_at})` };
      },
    }];
  },
  restorePlan(ctx) {
    const bound = githubBindingOf(ctx.block.bindings?.github);
    if ("code" in bound) return [];
    const key = `github:installation-suspend:${bound.facts.installationId}`;
    // Only an installation THIS lifecycle suspended (`done`) is ours to un-suspend; a `converged` one was already suspended.
    if (ctx.steps[key]?.status !== "done") return [];
    return [{
      key: `github:installation-unsuspend:${bound.facts.installationId}`, adapter: "github", action: "installation-unsuspend", resource: bound.facts.installationId, reverses: key,
      description: `un-suspend installation ${bound.facts.installationId}, verify suspended_at is null`,
      async run() {
        const facts = { appId: bound.facts.appId, keyRef: bound.facts.keyRef, installationId: bound.facts.installationId };
        const before = await readGithubInstallation(facts, ctx.env);
        if (before.state === "absent") return { result: "converged", detail: "GitHub has no such installation" };
        if (before.state === "error") return { result: "unresolved", provider_code: before.code, detail: "could not read the installation" };
        if (!before.suspended_at) return { result: "converged", detail: "the installation is not suspended" };
        const del = await writeGithubInstallationSuspension(facts, false, ctx.env);
        if (!del.ok && !del.absent) return { result: "unresolved", provider_code: del.code, detail: "the installation could not be un-suspended" };
        const after = await readGithubInstallation(facts, ctx.env);
        if (after.state !== "present" || after.suspended_at) return { result: "unresolved", provider_code: after.state === "error" ? after.code : "unsuspend-not-effective", detail: "the installation was not read back as active" };
        return { result: "done", detail: "installation un-suspended (suspended_at null)" };
      },
    }];
  },
};

// ---------------------------------------------------------------------------
// plane (read-only: Flume has no Plane client and no px write verb)
// ---------------------------------------------------------------------------

export const planeAdapter: LifecycleAdapter = {
  name: "plane",
  blockers: () => [],
  async inventory(ctx) {
    const evidence = planeEvidence(ctx.env);
    const base = { provider: "plane" as const, kind: "plane-personal-access-token", static: true, evidence };
    const revocation = `the employee deletes the token: ${PLANE_CREDENTIAL_SEMANTICS.revocation.native}; an admin may instead remove the board membership (${PLANE_CREDENTIAL_SEMANTICS.revocation.board_access}). Flume has no Plane client`;
    const binding = ctx.block.bindings?.plane;
    const bound = planeBindingOf(binding);
    if ("code" in bound || !binding) {
      return [!binding || ("code" in bound && bound.code === "no-provider-binding")
        ? { ...base, status: "not-issued", next_action: `flume identity bind ${ctx.employee} plane ... (the employee enrolls by hand first)` }
        : { ...base, status: "unverified", provider_code: "code" in bound ? bound.code : "provider-binding-invalid", next_action: "repair the plane binding", detail: "code" in bound ? bound.detail : undefined }];
    }
    const row = { ...base, ref: bound.facts.keyRef, next_action: revocation };
    // The board comes from Pilot's own earlier verification of THIS binding, never from a guess.
    const receipt = readPlaneReceipts(ctx.env).filter(line => line.kind === "plane.adopt" && line.subject === ctx.block.subject && line.credential_ref === binding.credential_ref && line.principal === binding.principal && line.instance === binding.instance).pop();
    const first = receipt?.boards?.[0] as { identifier?: string; id?: string } | undefined;
    const board = first?.identifier || first?.id;
    if (!board) return [{ ...row, status: "unverified", provider_code: "no-verified-board", detail: "no plane.adopt receipt for the current binding names a board; `flume identity adopt-actor <employee> plane --board <b> --apply` records one" }];
    const checked = verifyBoardViaPx(bound.facts, ctx.block.handle, ctx.block.email, board, ctx.env);
    if ("proof" in checked) return [{ ...row, status: "static-usable", detail: "Pilot verified the token as the employee's own; its expiry is not observable (a Plane PAT's expiry is shown only to its owner's session)" }];
    const blocker = checked.blocker;
    if (blocker.provider_code === "credential_rejected") return [staticRow({ ...row, provider_code: "credential_rejected", detail: "Pilot read back Plane's rejection of the token", next_action: "none: Plane rejects this token" }, "rejected", { status: "unverified" })];
    if (blocker.code === "provider-unavailable") return [{ ...row, status: "unresolved", provider_code: "provider-unavailable", detail: blocker.detail }];
    return [{ ...row, status: "unverified", provider_code: blocker.provider_code ?? blocker.code, detail: blocker.detail }];
  },
  plan: () => [],
  restorePlan: () => [],
};

// ---------------------------------------------------------------------------
// gateway (FLUME-39 owns minting and rotation; revocation here is `gateway-tokens.py revoke`)
// ---------------------------------------------------------------------------

/** The FLUME-39 shared item: `scripts/gateway-member-tokens.py` writes each consumer's token as one field of it. */
export const GATEWAY_TOKENS_ITEM = "yeurk5dpqkaarspvsn3cjtmkki";
const GATEWAY_REF = new RegExp(`^op://DeLoSecrets/${GATEWAY_TOKENS_ITEM}/([A-Za-z0-9_-]{1,40})$`, "u");

function gatewayBin(env: NodeJS.ProcessEnv): string {
  return env.FLUME_GATEWAY_TOKENS_BIN || join(env.HOME || "", "docker", "stacks", "ai", "newapi", "ops", "gateway-tokens.py");
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

interface GatewayDesk { profile: string | null; ref?: string; consumer?: string; shape: "ok" | "none" | "bad"; shared: boolean }

function gatewayDesk(ctx: LifecycleContext): GatewayDesk {
  const fleet = fleetHome(ctx.census, ctx.env);
  const profile = deskProfileOf(ctx.census, ctx.target);
  const ref = profile ? refIn(join(fleet, "profiles", profile, "config.delta.yaml")) : undefined;
  if (!ref) return { profile, shape: "none", shared: false };
  const match = GATEWAY_REF.exec(ref);
  if (!match) return { profile, ref, shape: "bad", shared: false };
  const consumer = match[1]!;
  const baseRef = refIn(join(fleet, "config.yaml"));
  let shared = baseRef === ref;
  for (const other of ctx.census.definitions) {
    if (shared || other.path === ctx.target.path || other.missing) continue;
    const otherProfile = deskProfileOf(ctx.census, other);
    const otherRef = otherProfile ? refIn(join(fleet, "profiles", otherProfile, "config.delta.yaml")) : undefined;
    if (otherRef && GATEWAY_REF.exec(otherRef)?.[1] === consumer) shared = true;
  }
  return { profile, ref, consumer, shape: "ok", shared };
}

/** The consumer behind an employee's desk gateway reference, only in the FLUME-39 shape; never inferred from a name. */
export function gatewayConsumerOf(census: IdentityCensus, target: IdentityDefinition, env: NodeJS.ProcessEnv = process.env): { consumer?: string; shape: "ok" | "none" | "bad"; shared: boolean } {
  const desk = gatewayDesk({ census, target, env } as LifecycleContext);
  return { ...(desk.consumer ? { consumer: desk.consumer } : {}), shape: desk.shape, shared: desk.shared };
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
    const desk = gatewayDesk(ctx);
    if (desk.shape === "none") return [{ code: "no-gateway-ref", detail: `the desk ${desk.profile ?? "(none)"} maps no AUTOMATICAI_GATEWAY_KEY in config.delta.yaml; there is no per-employee consumer to revoke` }];
    if (desk.shape === "bad") return [{ code: "gateway-ref-shape", detail: `the desk gateway reference is not op://DeLoSecrets/${GATEWAY_TOKENS_ITEM}/<consumer> (FLUME-39); a consumer is never inferred from a name` }];
    if (desk.shared) return [{ code: "shared-consumer", detail: `consumer ${desk.consumer} is shared with the fleet base or another desk; revoking it would cut them off too. Mint this employee a dedicated token first (FLUME-39)` }];
    return [];
  },
  async inventory(ctx) {
    const link = gatewayLink(ctx.env);
    const evidence = ctx.env.FLUME_GATEWAY_TOKENS_BIN ? "fixture" as const : "provider" as const;
    const base = { provider: "gateway" as const, kind: "gateway-token", static: true, evidence, ...link };
    const desk = gatewayDesk(ctx);
    if (desk.shape === "none") return [{ ...base, status: "not-issued", next_action: "FLUME-39 mints a per-employee gateway token; this desk maps none" }];
    if (desk.shape === "bad") return [{ ...base, ref: desk.ref, status: "unverified", provider_code: "gateway-ref-shape", next_action: `FLUME-39 owns the gateway reference shape (op://DeLoSecrets/${GATEWAY_TOKENS_ITEM}/<consumer>)` }];
    const consumer = desk.consumer!;
    const row = { ...base, ref: desk.ref, id: consumer, consumer, ...(desk.shared ? { shared_consumer: true } : {}) };
    const retireCommand = desk.shared ? "shared consumer: mint this employee a dedicated token (FLUME-39) before revoking" : `flume identity retire ${ctx.employee} --revoke gateway --apply runs gateway-tokens.py revoke ${consumer}`;
    const status = gatewayStatus(ctx.env, consumer);
    if (!status.ok) return [{ ...row, status: "unresolved", provider_code: status.code, next_action: `flume identity credentials ${ctx.employee}` }];
    if (!status.tokens.length) return [staticRow({ ...row, detail: "gateway-tokens status lists no tokens for this consumer", next_action: "none: no gateway token exists for this consumer" }, "absent", { status: "unverified" })];
    const now = Date.now() / 1000;
    return status.tokens.map((token): CredentialRow => {
      const tokenRow = { ...row, id: String(token.id), name: String(token.name ?? "") };
      const expired = typeof token.expired_time === "number" ? token.expired_time : undefined;
      if (token.status !== 1) return { ...tokenRow, status: "unverified", provider_code: "token-disabled", next_action: retireCommand };
      if (expired === undefined) return { ...tokenRow, status: "unverified", provider_code: "expiry-unreadable", next_action: retireCommand };
      if (expired === -1) return { ...tokenRow, status: "static-usable", detail: "expired_time -1: the gateway token never expires", next_action: retireCommand };
      if (expired <= now) return { ...tokenRow, status: "unverified", provider_code: "token-expired", expires_at: new Date(expired * 1000).toISOString(), next_action: retireCommand };
      return { ...tokenRow, status: "residual-expiry", expires_at: new Date(expired * 1000).toISOString(), next_action: retireCommand };
    });
  },
  plan(ctx, options) {
    if (!options.revoke) return [];
    const desk = gatewayDesk(ctx);
    if (desk.shape !== "ok") return [];
    const consumer = desk.consumer!;
    return [{
      key: `gateway:token-revoke:${consumer}`, adapter: "gateway", action: "token-revoke", resource: consumer,
      description: `gateway-tokens.py revoke ${consumer}, verify status lists no tokens`,
      async run(context) {
        const run = runGateway(context.env, ["revoke", consumer]);
        if (!run.ok) return { result: "unresolved", provider_code: run.code, detail: "gateway-tokens revoke did not succeed" };
        const count = /revoked (\d+) tokens?/u.exec(run.stdout);
        const verify = gatewayStatus(context.env, consumer);
        if (!verify.ok) return { result: "unresolved", provider_code: verify.code, detail: "could not read the gateway status after the revoke" };
        if (verify.tokens.length) return { result: "unresolved", provider_code: "revoke-not-effective", detail: "the gateway still lists tokens for this consumer" };
        return { result: count && Number(count[1]) === 0 ? "converged" : "done", detail: "gateway status lists no tokens" };
      },
    }];
  },
  restorePlan: () => [],
};

export const DEFAULT_ADAPTERS: Record<AdapterName, LifecycleAdapter> = {
  mail: mailAdapter, cloudflare_access: cloudflareAccessAdapter, github: githubAdapter, plane: planeAdapter, gateway: gatewayAdapter,
};
