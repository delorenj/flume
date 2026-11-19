// FLUME-56: live provider provisioning for one enrolled employee.
//
// `flume identity provision <employee>` turns enrollment (a local subject and
// address) into live company accounts: a Cloudflare Access service token, the
// Email Routing rule and mailbox-allowlist projection for the employee's
// address, and the 1Password identity item that holds the secrets. Preview is
// the default; --apply performs the mutations. Every step is idempotent: a
// second apply is a no-op, and a foreign resource with a colliding name is a
// blocker, never a clobber.
//
// Secrecy rules, stated plainly: the Cloudflare credential is an op://
// reference resolved with `op read` at call time; a created service-token
// secret exists only in process memory and the vault item. Receipts, logs and
// results carry IDs, references and outcomes -- never a secret value. Cleanup
// is allowed only after a failed edit and fresh confirmation that neither Access
// field persisted. Uncertain writes/bindings keep the token for reconciliation.
//
// What this command deliberately does NOT do: create GitHub Apps (the manifest
// flow needs an authenticated browser session; a later story owns it), sign up
// for any human account, send mail, or revoke anything (FLUME-53).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { pendingAccessIssuance, provisionStateDir } from "./access-issuance";
export { pendingAccessIssuance, provisionStateDir } from "./access-issuance";
import { accessRevocationConflict, bindEmployeeProvider, identityCensus, resolveEmployee, type IdentityBlocker, type IdentityDefinition } from "./company";
import { provisioningConfigProblems, COMPANY_MAIL_DOMAIN } from "./validator";
import { withRegistryLock } from "./role";

export interface ProvisioningConfig {
  version: 1;
  cloudflare: { api_token_ref: string; account_id: string; zone_id: string; access_issuer: string };
  mailbox: { worker: string; kv_namespace_id: string };
  onepassword: { vault: string };
}

export interface ProvisionOptions { apply?: boolean }

type CapabilityAction = "no-op" | "create" | "adopt" | "created" | "adopted" | "deleted-orphan" | "conflict" | "blocked";
export interface CapabilityResult { action: CapabilityAction; detail: string; refs?: Record<string, string>; changed?: boolean }

export function provisioningConfigPath(): string {
  return process.env.FLUME_PROVISION_CONFIG || join(process.env.HOME || homedir(), ".config", "flume", "identity-provisioning.yaml");
}

export function loadProvisioningConfig(path = provisioningConfigPath()): ProvisioningConfig {
  if (!existsSync(path)) throw new Error(`Provisioning configuration not found: ${path} (set FLUME_PROVISION_CONFIG; see docs/identity-provisioning.md)`);
  let parsed: unknown;
  try { parsed = YAML.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`Provisioning configuration is not valid YAML: ${(error as Error).message}`); }
  const problems = provisioningConfigProblems(parsed);
  if (problems.length) throw new Error(`Provisioning configuration ${path} is invalid: ${problems.join("; ")}`);
  return parsed as ProvisioningConfig;
}

/** Secret-free receipt lines: IDs, references and outcomes. */
function receipt(line: Record<string, unknown>): void {
  const dir = provisionStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "receipts.jsonl");
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------
// 1Password: op CLI. Secrets pass through argv to `op` only; nothing is logged.
// ---------------------------------------------------------------------------

export function op(args: string[], input?: string): { ok: boolean; stdout: string; stderr: string; uncertain?: boolean } {
  const run = spawnSync("op", args, { encoding: "utf8", input, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (run.error) return { ok: false, stdout: "", stderr: run.error.message, uncertain: true };
  return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: (run.stderr ?? "").trim(), uncertain: run.status === null || Boolean(run.signal) };
}

export function opRead(reference: string): string {
  const read = op(["read", reference]);
  if (!read.ok || !read.stdout.trim()) throw new Error("op read failed for provisioning credential (provider output withheld)");
  return read.stdout.trim();
}

interface OpItemField { id: string; label?: string; value?: string; section?: { id?: string; label?: string } }
interface OpItem { id: string; title: string; fields: OpItemField[] }
function validOpItem(item: OpItem): boolean {
  return typeof item?.id === "string" && Boolean(item.id) && typeof item.title === "string" && Array.isArray(item.fields) && item.fields.every(f =>
    f && typeof f.id === "string" && (f.label === undefined || typeof f.label === "string") &&
    (f.value === undefined || typeof f.value === "string") && (f.section?.label === undefined || typeof f.section.label === "string"));
}

function opItemGet(id: string, vault: string): OpItem {
  // A per-invocation flag wins over OP_CACHE without changing the operator's env.
  const got = op(["item", "get", id, "--vault", vault, "--format", "json", "--cache=false"]);
  if (!got.ok) throw new Error("fresh vault item read failed (provider output withheld)");
  try {
    const item = JSON.parse(got.stdout) as OpItem;
    if (!validOpItem(item) || item.id !== id) throw new Error();
    return item;
  } catch { throw new Error("fresh vault item response is invalid"); }
}

function opItemList(vault: string): Array<{ id: string; title: string }> {
  const listed = op(["item", "list", "--vault", vault, "--format", "json", "--cache=false"]);
  if (!listed.ok) throw new Error("fresh vault item list failed (provider output withheld)");
  try {
    const items = JSON.parse(listed.stdout);
    if (!Array.isArray(items) || items.some(i => typeof i.id !== "string" || typeof i.title !== "string")) throw new Error();
    return items;
  } catch { throw new Error("fresh vault item list response is invalid"); }
}

/** Resolve by title once, then address the immutable item ID for all reads/edits. */
function opFindIdentityItem(handle: string, vault: string): OpItem | null {
  const matches = opItemList(vault).filter(item => item.title.toLowerCase() === handle.toLowerCase());
  if (matches.length > 1) throw new Error("multiple identity items match this employee; reconcile by hand");
  return matches.length ? opItemGet(matches[0]!.id, vault) : null;
}

function opItemCreate(handle: string, email: string, vault: string): OpItem {
  const title = handle.charAt(0).toUpperCase() + handle.slice(1);
  const created = op([
    "item", "create", "--format", "json", "--category", "identity", "--title", title, "--vault", vault,
    `email[email]=${email}`, `username[text]=${handle}`,
  ]);
  if (!created.ok) throw new Error("vault item creation failed or is uncertain; inspect before retry (provider output withheld)");
  try {
    const item = JSON.parse(created.stdout) as OpItem;
    if (!validOpItem(item)) throw new Error();
    return item;
  } catch { throw new Error("vault item creation response is invalid; inspect before retry"); }
}

const ACCESS_SECTION = "Identity Service Token";
function accessFields(item: OpItem, label: string): OpItemField[] {
  return item.fields.filter(f => (f.label ?? "").toLowerCase() === label.toLowerCase() && f.section?.label === ACCESS_SECTION);
}
function hasAccessFields(item: OpItem): boolean {
  return accessFields(item, "Client ID").length + accessFields(item, "Client Secret").length > 0;
}

class AccessPersistenceError extends Error {
  constructor(message: string, readonly cleanupSafe = false) { super(message); }
}

/** Write the pair together, then verify values AND unique field IDs from a fresh read. */
function opAccessFieldsSet(item: OpItem, clientId: string, secret: string, vault: string): string {
  const before = opItemGet(item.id, vault);
  if (hasAccessFields(before)) throw new AccessPersistenceError("Access fields appeared after preflight; refusing to overwrite");
  const edit = op(["item", "edit", item.id, "--vault", vault,
    `${ACCESS_SECTION}.Client ID[text]=${clientId}`, `${ACCESS_SECTION}.Client Secret[concealed]=${secret}`]);
  let after: OpItem;
  try { after = opItemGet(item.id, vault); }
  catch { throw new AccessPersistenceError("vault verification uncertain; fresh read unavailable"); }
  const ids = accessFields(after, "Client ID"), secrets = accessFields(after, "Client Secret");
  const id = ids[0], secretField = secrets[0];
  if (after.id === item.id && ids.length === 1 && secrets.length === 1 && id?.value === clientId && secretField?.value === secret &&
      id.id && secretField.id && id.id !== secretField.id && after.fields.filter(f => f.id === secretField.id).length === 1 &&
      after.fields.filter(f => f.id === id.id).length === 1) return secretField.id;
  // Even a nonzero edit can have committed remotely. Never delete on its status alone.
  if (!edit.ok && !edit.uncertain && after.id === item.id && !hasAccessFields(after)) {
    throw new AccessPersistenceError("vault write failed; fresh read confirms no Access fields persisted", true);
  }
  throw new AccessPersistenceError("vault verification uncertain; Access pair not confirmed (provider output withheld)");
}

// ---------------------------------------------------------------------------
// Cloudflare API. The token is resolved once, never logged, never receipted.
// ---------------------------------------------------------------------------

export const CLOUDFLARE_OFFICIAL_API_BASE = "https://api.cloudflare.com/client/v4";
export interface CfResponse { http_status: number; body: any }

/** `FLUME_CLOUDFLARE_API_BASE`, default the official API, without a trailing slash. */
export function cloudflareApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FLUME_CLOUDFLARE_API_BASE || CLOUDFLARE_OFFICIAL_API_BASE).replace(/\/$/u, "");
}
/** `provider` evidence only against the real API; anything else is a double. */
export function cloudflareEvidence(env: NodeJS.ProcessEnv = process.env): "provider" | "fixture" {
  return cloudflareApiBase(env) === CLOUDFLARE_OFFICIAL_API_BASE ? "provider" : "fixture";
}

export function cfRequest(token: string, method: string, path: string, payload?: unknown): Promise<CfResponse> {
  const base = cloudflareApiBase();
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(20_000),
  }).then(async response => {
    let body: any;
    try { body = await response.json(); } catch { body = undefined; }
    return { http_status: response.status, body };
  }).catch(error => ({ http_status: 0, body: { errors: [{ message: (error as Error).message }] } }));
}

export function cfOk(response: CfResponse): boolean {
  return response.http_status >= 200 && response.http_status < 300 && response.body?.success !== false;
}

export function cfError(response: CfResponse): string {
  const errors = Array.isArray(response.body?.errors) ? response.body.errors.map((e: any) => e.message ?? e.code ?? "?").join("; ") : "";
  return errors || `HTTP ${response.http_status || "no response"}`;
}

export interface CfServiceToken { id: string; name: string; client_id?: string; expires_at?: string }
/** A row missing either matching discriminator cannot establish token absence, even when pagination succeeds. */
export function validServiceTokenRow(value: unknown): value is CfServiceToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<CfServiceToken>;
  return typeof row.id === "string" && row.id.trim().length > 0 &&
    typeof row.name === "string" && row.name.trim().length > 0 &&
    typeof row.client_id === "string" && row.client_id.trim().length > 0;
}
// The lifecycle adapter retains cfError; provisioning withholds free-form provider messages.
const provisionCfError = (response: CfResponse) => `HTTP ${response.http_status || "no response"} (provider output withheld)`;
export interface CfRoutingRule { id: string; name?: string; enabled: boolean; matchers: Array<{ type: string; field?: string; value?: string }>; actions: Array<{ type: string; value?: string[] }> }

// ---------------------------------------------------------------------------
// The capabilities
// ---------------------------------------------------------------------------

const tokenName = (handle: string) => `employee-${handle}`;

async function planAccessToken(config: ProvisioningConfig, block: NonNullable<IdentityDefinition["block"]>, cfToken: string): Promise<{ plan: CapabilityResult; apply: () => Promise<CapabilityResult> }> {
  const { account_id, access_issuer } = config.cloudflare;
  const vault = config.onepassword.vault;
  const stop = (action: "blocked" | "conflict", detail: string, refs?: Record<string, string>) => ({
    plan: { action, detail, ...(refs ? { refs } : {}) }, apply: async (): Promise<CapabilityResult> => ({ action, detail }),
  });
  const tokens: CfServiceToken[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | undefined;
  // A clamped full page is not absence. Without metadata, only an empty page ends the listing.
  for (let page = 1; page <= 100; page++) {
    const list = await cfRequest(cfToken, "GET", `/accounts/${account_id}/access/service_tokens?per_page=50&page=${page}`);
    const result = list.body?.result as CfServiceToken[] | undefined;
    if (!cfOk(list) || !Array.isArray(result) || result.some(t => !validServiceTokenRow(t))) return stop("blocked", "cannot list service tokens completely (provider output withheld)");
    for (const token of result) {
      if (seen.has(token.id)) return stop("blocked", "service-token inventory repeated an ID; reconcile by hand");
      seen.add(token.id); tokens.push(token);
    }
    const info = list.body?.result_info;
    const total = info?.total_pages, served = info?.per_page;
    if (total !== undefined && (!Number.isInteger(total) || total < page || total > 100 || (expectedTotal !== undefined && total !== expectedTotal) || (result.length === 0 && (page > 1 || page < total)))) return stop("blocked", "service-token pagination metadata inconsistent; reconcile by hand");
    if (total !== undefined) expectedTotal = total;
    if (expectedTotal !== undefined && total === undefined) return stop("blocked", "service-token pagination metadata inconsistent; reconcile by hand");
    if (served !== undefined && (!Number.isInteger(served) || served < 1 || result.length > served)) return stop("blocked", "service-token pagination metadata inconsistent; reconcile by hand");
    // Only a declared final page or a genuinely empty page proves completion.
    // A short nonempty response may be a provider clamp, never absence.
    if (total !== undefined ? page === total : result.length === 0) break;
    if (page === 100) return stop("blocked", "service-token inventory exceeded bounded pagination; reconcile by hand");
  }
  let item: OpItem | null;
  try { item = opFindIdentityItem(block.handle, vault); }
  catch { return stop("blocked", "fresh vault preflight unavailable; no token will be minted"); }
  const ids = item ? accessFields(item, "Client ID") : [], secrets = item ? accessFields(item, "Client Secret") : [];
  const remote = ids.length === 1 ? tokens.find(t => t.client_id === ids[0]?.value) : undefined;
  const named = tokens.find(t => t.name === tokenName(block.handle));
  const pending = pendingAccessIssuance(block.handle, block.subject, account_id);
  const bound = block.bindings?.cloudflare_access;
  const refs: Record<string, string> = {
    ...(item ? { item_id: item.id } : {}),
    vault_client_id: ids.length ? "present" : "absent", vault_client_secret: secrets.length ? "present" : "absent",
    client_id_fields: ids.map(f => f.id).join(","), client_secret_fields: secrets.map(f => f.id).join(","),
    provider_match: remote ? remote.id : "absent",
    receipt_comparison: accessReceiptSummary(block.handle),
  };
  if (bound) {
    const secret = secrets[0];
    if (remote && ids.length === 1 && secret?.value && secrets.length === 1 && item &&
        bound.principal === ids[0]?.value && bound.instance === access_issuer && bound.credential_ref === `op://${vault}/${item.id}/${secret.id}` &&
        secret.id && item.fields.filter(f => f.id === secret.id).length === 1 && ids[0]?.id && ids[0].id !== secret.id) {
      return { plan: { action: "no-op", detail: "binding, fresh vault fields and provider token agree", refs: { token_id: remote.id, item_id: item.id } }, apply: async () => ({ action: "no-op", detail: "already bound and live" }) };
    }
    return stop("conflict", "binding, fresh vault fields and provider inventory disagree; owner-approved reconciliation required (see docs/identity-provisioning.md)", refs);
  }
  if (ids.length || secrets.length) return stop("conflict", "Access fields already present without a binding; refusing overwrite or token creation. Compare provider_match and receipts; owner-approved reconciliation required (see docs/identity-provisioning.md)", refs);
  if (pending.uncertain || pending.token_ids.length) return stop("conflict", "issuance receipt may describe a retained unbound token; reconcile provider inventory before minting", refs);
  if (named) return stop("conflict", `service token ${named.id} already uses this employee's name without a binding; owner-approved reconciliation required`, refs);

  const plan: CapabilityResult = { action: "create", detail: `create Access service token ${tokenName(block.handle)}, vault it, bind it` };
  const apply = async (): Promise<CapabilityResult> => {
    let home: OpItem;
    // Recheck before minting, including races between preview and apply.
    try {
      const current = opFindIdentityItem(block.handle, vault);
      if (!current || hasAccessFields(current)) return { action: "conflict", detail: "vault preflight changed; no token minted; reconcile before retry" };
      home = current;
    } catch { return { action: "blocked", detail: "fresh vault preflight failed; no token minted" }; }
    const created = await cfRequest(cfToken, "POST", `/accounts/${account_id}/access/service_tokens`, { name: tokenName(block.handle), duration: "8760h" });
    if (!cfOk(created)) return { action: "blocked", detail: "token create failed or is uncertain; inspect provider inventory before retry (provider output withheld)" };
    const token = created.body?.result as { id: string; client_id: string; client_secret: string; expires_at?: string } | undefined;
    if (!token?.id || !token.client_id || !token.client_secret) return { action: "blocked", detail: "token create response incomplete; reconcile provider inventory before retry" };
    try {
      // Record the provider ID before attempting persistence; no creation secret is receipted.
      receipt({ capability: "access-token", employee: block.handle, subject: block.subject, account_id, action: "minted", token_id: token.id, client_id: token.client_id, item: home.id });
      const secretField = opAccessFieldsSet(home, token.client_id, token.client_secret, vault);
      const boundResult = await bindEmployeeProvider(block.handle, "cloudflare_access", {
        principal: token.client_id, instance: access_issuer, credential_ref: `op://${vault}/${home.id}/${secretField}`,
      }, { apply: true });
      if (!boundResult.ok) throw new AccessPersistenceError("binding write refused; vaulted token retained for reconciliation");
      receipt({ capability: "access-token", employee: block.handle, subject: block.subject, account_id, action: "created", token_id: token.id, client_id: token.client_id, expires_at: token.expires_at ?? null, item: home.id });
      return { action: "created", detail: `token ${token.id} vaulted and bound`, refs: { token_id: token.id, item_id: home.id } };
    } catch (error) {
      if (error instanceof AccessPersistenceError && error.cleanupSafe) {
        return withRegistryLock(identityCensus().registryPath, async () => {
          const census = identityCensus(), target = resolveEmployee(census, block.handle);
          const history = pendingAccessIssuance(block.handle, block.subject, account_id);
          if (history.uncertain || !history.token_ids.includes(token.id) || history.client_ids[token.id] !== token.client_id ||
              target.block?.bindings?.cloudflare_access || accessRevocationConflict(block.subject, target.path, token.client_id, token.id)) {
            return { action: "blocked", changed: true, detail: "orphan ownership or issuance history uncertain; token retained for owner reconciliation", refs: { token_id: token.id, item_id: home.id } };
          }
          const removed = await cfRequest(cfToken, "DELETE", `/accounts/${account_id}/access/service_tokens/${token.id}`);
          const check = await cfRequest(cfToken, "GET", `/accounts/${account_id}/access/service_tokens/${token.id}`);
          const deleted = cfOk(removed) && check.http_status === 404;
          const action = deleted ? "deleted-orphan" : "cleanup-unconfirmed";
          let recorded = true;
          try { receipt({ capability: "access-token", employee: block.handle, subject: block.subject, account_id, action, token_id: token.id, deleted }); } catch { recorded = false; }
          return { action: "blocked", changed: true, detail: `vault write failed; orphan token ${token.id} ${deleted ? "deleted (provider absence verified)" : "cleanup FAILED or unconfirmed — owner reconciliation required"}${recorded ? "" : "; receipt write failed"}`, refs: { token_id: token.id, item_id: home.id } };
        });
      }
      let recorded = true;
      try { receipt({ capability: "access-token", employee: block.handle, subject: block.subject, account_id, action: "reconciliation-required", token_id: token.id, item: home.id, deleted: false }); } catch { recorded = false; }
      return { action: "blocked", changed: true, detail: `vault/binding verification uncertain; token ${token.id} retained, not deleted. Owner-approved reconciliation required${recorded ? "" : "; receipt write failed"}`, refs: { token_id: token.id, item_id: home.id } };
    }
  };
  return { plan, apply };
}

/** Whitelist outcomes/IDs from existing receipts; never echo historical free-form reasons. */
function accessReceiptSummary(employee: string): string {
  const path = join(provisionStateDir(), "receipts.jsonl");
  if (!existsSync(path)) return "none";
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const rows = lines.map(line => JSON.parse(line)).filter(r => r.employee === employee && r.capability === "access-token").slice(-5);
    return rows.map(r => `${typeof r.token_id === "string" && /^[a-zA-Z0-9-]{1,80}$/u.test(r.token_id) ? r.token_id : "unknown"}:${r.deleted === true ? "deleted" : r.deleted === false ? "not-confirmed-deleted" : "recorded"}`).join(",") || "none";
  } catch { return "unavailable"; }
}

async function planMailbox(config: ProvisioningConfig, block: NonNullable<IdentityDefinition["block"]>, cfToken: string): Promise<{ plan: CapabilityResult; apply: () => Promise<CapabilityResult> }> {
  const { zone_id } = config.cloudflare;
  const { worker, kv_namespace_id } = config.mailbox;
  const email = block.email;
  const rules = await cfRequest(cfToken, "GET", `/zones/${zone_id}/email/routing/rules`);
  if (!cfOk(rules)) return { plan: { action: "blocked", detail: `cannot list routing rules: ${provisionCfError(rules)}` }, apply: async () => ({ action: "blocked", detail: "plan blocked" }) };
  const literal = (rules.body?.result ?? []) as CfRoutingRule[];
  const rule = literal.find(r => r.matchers?.some(m => m.type === "literal" && m.field === "to" && m.value?.toLowerCase() === email.toLowerCase()));
  const owned = rule?.actions?.some(a => a.type === "worker" && (a.value ?? []).includes(worker)) ?? false;
  const kvKey = `allowlist/${email.toLowerCase()}`;
  const kv = await cfRequest(cfToken, "GET", `/accounts/${config.cloudflare.account_id}/storage/kv/namespaces/${kv_namespace_id}/values/${encodeURIComponent(kvKey)}`);

  if (rule && !owned) return { plan: { action: "conflict", detail: `routing rule for ${email} exists but points at ${rule.actions.map(a => `${a.type}:${(a.value ?? []).join(",")}`).join("+")}, not worker ${worker} — reconcile by hand` }, apply: async () => ({ action: "blocked", detail: "conflict" }) };
  if (rule && owned && kv.http_status === 200) return { plan: { action: "no-op", detail: `rule ${rule.id} -> ${worker} and KV ${kvKey} both present`, refs: { rule_id: rule.id } }, apply: async () => ({ action: "no-op", detail: "mailbox already provisioned", refs: { rule_id: rule.id } }) };

  const needs: string[] = [];
  if (!rule) needs.push("routing rule");
  if (kv.http_status !== 200) needs.push("allowlist key");
  const plan: CapabilityResult = { action: rule && owned ? "adopt" : "create", detail: `${needs.join(" + ")} for ${email}${rule ? ` (adopting rule ${rule.id})` : ""}` };
  const apply = async (): Promise<CapabilityResult> => {
    let ruleId = rule?.id;
    if (!rule) {
      const created = await cfRequest(cfToken, "POST", `/zones/${zone_id}/email/routing/rules`, {
        name: `${block.handle} mailbox (${worker} worker)`, enabled: true,
        matchers: [{ type: "literal", field: "to", value: email }],
        actions: [{ type: "worker", value: [worker] }],
      });
      if (!cfOk(created)) return { action: "blocked", detail: `routing rule create failed: ${provisionCfError(created)}` };
      ruleId = (created.body.result as CfRoutingRule).id;
      receipt({ capability: "mailbox-rule", employee: block.handle, action: "created", rule_id: ruleId, address: email });
    }
    const put = await cfRequest(cfToken, "PUT", `/accounts/${config.cloudflare.account_id}/storage/kv/namespaces/${kv_namespace_id}/values/${encodeURIComponent(kvKey)}`, { handle: block.handle, subject: block.subject, provisioned_at: new Date().toISOString() });
    if (!cfOk(put)) return { action: "blocked", detail: `allowlist write failed: ${provisionCfError(put)}${ruleId && !rule ? " (rule created; retry to finish)" : ""}` };
    receipt({ capability: "mailbox-allowlist", employee: block.handle, action: kv.http_status === 200 ? "no-op" : "created", key: kvKey });
    return { action: rule ? "adopted" : "created", detail: `rule ${ruleId} -> ${worker}; KV ${kvKey} written`, refs: { rule_id: ruleId! } };
  };
  return { plan, apply };
}

function planVaultItem(config: ProvisioningConfig, block: NonNullable<IdentityDefinition["block"]>): { plan: CapabilityResult; apply: () => Promise<CapabilityResult> } {
  const vault = config.onepassword.vault;
  let existing: OpItem | null;
  try { existing = opFindIdentityItem(block.handle, vault); }
  catch {
    return { plan: { action: "blocked", detail: "fresh vault inventory unavailable; no item creation attempted" }, apply: async () => ({ action: "blocked", detail: "fresh vault inventory unavailable" }) };
  }
  if (existing) return { plan: { action: "no-op", detail: `vault item "${existing.title}" (${existing.id}) exists`, refs: { item_id: existing.id } }, apply: async () => ({ action: "no-op", detail: "vault item exists", refs: { item_id: existing.id } }) };
  return {
    plan: { action: "create", detail: `1Password identity item "${block.handle}" in ${vault}` },
    apply: async () => {
      const item = opItemCreate(block.handle, block.email, vault);
      receipt({ capability: "vault-item", employee: block.handle, action: "created", item_id: item.id });
      return { action: "created", detail: `vault item "${item.title}" (${item.id}) created`, refs: { item_id: item.id } };
    },
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export async function provisionEmployee(employee: string, options: ProvisionOptions = {}) {
  const blockers: IdentityBlocker[] = [];
  const census = identityCensus();
  const target = resolveEmployee(census, employee);
  if (target.missing) blockers.push({ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path });
  else if (target.problem) blockers.push({ code: "invalid-definition", detail: target.problem, path: target.path });
  else if (!target.block) blockers.push({ code: "not-enrolled", detail: `${employee} has no company identity; run flume identity enroll ${employee} --apply first` });
  else if (target.block.status !== "active") blockers.push({ code: `employee-${target.block.status}`, detail: `the employee is ${target.block.status}; provisioning is for active employees` });

  let config: ProvisioningConfig | null = null;
  try { config = loadProvisioningConfig(); } catch (error) { blockers.push({ code: "invalid-config", detail: (error as Error).message }); }

  const base = { employee, kind: target.kind, definition: target.path, person: target.person, apply: Boolean(options.apply) };
  if (blockers.length || !target.block || !config) return { ok: false, changed: false, capabilities: {}, blockers, writes: [] as string[], ...base };
  const block = target.block;

  let cfToken: string | null = null;
  try { cfToken = opRead(config.cloudflare.api_token_ref); }
  catch (error) { return { ok: false, changed: false, capabilities: {}, blockers: [...blockers, { code: "credential-unavailable", detail: (error as Error).message }], writes: [] as string[], ...base }; }

  // Plan against live remote state (GETs only), then apply in an order that
  // never leaves a secret-bearing resource without its vault home.
  const vaultItem = planVaultItem(config, block);
  const access = await planAccessToken(config, block, cfToken);
  const mailbox = await planMailbox(config, block, cfToken);

  if (!options.apply) {
    const capabilities = { "vault-item": vaultItem.plan, "access-token": access.plan, mailbox: mailbox.plan };
    const planned = Object.values(capabilities).some(c => c.action === "create" || c.action === "adopt");
    const conflicted = Object.values(capabilities).some(c => c.action === "conflict" || c.action === "blocked");
    return { ok: !conflicted, changed: planned, capabilities, blockers, writes: [] as string[], note: "Preview only — provider reads, no writes. Pass --apply to provision.", ...base };
  }

  const capabilities: Record<string, CapabilityResult> = {};
  const applySafely = async (step: { apply: () => Promise<CapabilityResult> }): Promise<CapabilityResult> => {
    try { return await step.apply(); }
    catch { return { action: "blocked", detail: "capability failed or is uncertain; inspect state before retry (provider output withheld)" }; }
  };
  capabilities["vault-item"] = await applySafely(vaultItem);
  capabilities["access-token"] = ["blocked", "conflict"].includes(capabilities["vault-item"].action)
    ? { action: "blocked", detail: "vault home unavailable; no token minted" }
    : access.plan.action === "create" ? await applySafely(access) : access.plan;
  capabilities["mailbox"] = ["create", "adopt"].includes(mailbox.plan.action) ? await applySafely(mailbox) : mailbox.plan;
  const failed = Object.values(capabilities).some(c => c.action === "blocked" || c.action === "conflict");
  const changed = Object.values(capabilities).some(c => c.changed || c.action === "created" || c.action === "adopted");
  return {
    ok: !failed, changed, capabilities, blockers, writes: changed ? [join(provisionStateDir(), "receipts.jsonl")] : [],
    note: "Receipts carry IDs and references only; secrets live in the vault item.",
    ...base,
  };
}
