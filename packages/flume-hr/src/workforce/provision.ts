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
// results carry IDs, references and outcomes -- never a secret value. If the
// vault write after a token creation fails, the orphan token is deleted at the
// provider so no secret-less credential is left behind.
//
// What this command deliberately does NOT do: create GitHub Apps (the manifest
// flow needs an authenticated browser session; a later story owns it), sign up
// for any human account, send mail, or revoke anything (FLUME-53).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { bindEmployeeProvider, identityCensus, resolveEmployee, type IdentityBlocker, type IdentityDefinition } from "./company";
import { provisioningConfigProblems, COMPANY_MAIL_DOMAIN } from "./validator";

export interface ProvisioningConfig {
  version: 1;
  cloudflare: { api_token_ref: string; account_id: string; zone_id: string; access_issuer: string };
  mailbox: { worker: string; kv_namespace_id: string };
  onepassword: { vault: string };
}

export interface ProvisionOptions { apply?: boolean }

type CapabilityAction = "no-op" | "create" | "adopt" | "created" | "adopted" | "deleted-orphan" | "conflict" | "blocked";
export interface CapabilityResult { action: CapabilityAction; detail: string; refs?: Record<string, string> }

export function provisioningConfigPath(): string {
  return process.env.FLUME_PROVISION_CONFIG || join(process.env.HOME || homedir(), ".config", "flume", "identity-provisioning.yaml");
}

export function provisionStateDir(): string {
  const home = process.env.HOME || homedir();
  return process.env.FLUME_PROVISION_STATE || join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "flume", "provision");
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

export function op(args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const run = spawnSync("op", args, { encoding: "utf8", input, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (run.error) return { ok: false, stdout: "", stderr: run.error.message };
  return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: (run.stderr ?? "").trim() };
}

export function opRead(reference: string): string {
  const read = op(["read", reference]);
  if (!read.ok || !read.stdout.trim()) throw new Error(`op read failed for ${reference.split("/").slice(0, 3).join("/")}/…: ${read.stderr || "empty"}`);
  return read.stdout.trim();
}

interface OpItemField { id: string; label?: string; value?: string; section?: { id?: string; label?: string } }
interface OpItem { id: string; title: string; fields: OpItemField[] }

function opItemGet(title: string, vault: string): OpItem | null {
  const got = op(["item", "get", title, "--vault", vault, "--format", "json"]);
  if (!got.ok) return null;
  try { return JSON.parse(got.stdout) as OpItem; } catch { return null; }
}

function opItemList(vault: string): Array<{ id: string; title: string }> {
  const listed = op(["item", "list", "--vault", vault, "--format", "json"]);
  if (!listed.ok) throw new Error(`op item list failed: ${listed.stderr}`);
  try { return JSON.parse(listed.stdout) as Array<{ id: string; title: string }>; } catch { return []; }
}

/** Find the employee's identity item case-insensitively (the Grolf item is title-cased; a handle is not). */
function opFindIdentityItem(handle: string, vault: string): OpItem | null {
  const match = opItemList(vault).find(item => item.title.toLowerCase() === handle.toLowerCase());
  return match ? opItemGet(match.title, vault) : null;
}

function opItemCreate(handle: string, email: string, vault: string): OpItem {
  const title = handle.charAt(0).toUpperCase() + handle.slice(1);
  const created = op([
    // `--format json` is required: without it the installed op prints a human "ID: ..." table and the parse below throws
    // AFTER the item exists, which strands an orphan vault item (found live by the FLUME-53 canary).
    "item", "create", "--format", "json", "--category", "identity", "--title", title, "--vault", vault,
    `email[email]=${email}`, `username[text]=${handle}`,
  ]);
  if (!created.ok) throw new Error(`op item create failed: ${created.stderr}`);
  return JSON.parse(created.stdout) as OpItem;
}

/** Set one field on an item; returns the field id for op:// references. */
function opItemFieldSet(item: OpItem, section: string, label: string, type: "text" | "concealed", value: string, vault: string): string {
  // Identity items carry multiple same-named fields across sections (e.g. the
  // GitHub App's Client ID next to the Access service token's). Only the
  // SECTION-qualified field is ours to read or write.
  const existing = item.fields.find(f => (f.label ?? "").toLowerCase() === label.toLowerCase() && (f.section?.label ?? "") === section);
  if (existing) {
    if (existing.value !== undefined && existing.value !== value) throw new Error(`vault item "${item.title}" field "${section}.${label}" already holds a different value; refusing to overwrite`);
    return existing.id;
  }
  const edit = op(["item", "edit", item.id, "--vault", vault, `${section}.${label}[${type}]=${value}`]);
  if (!edit.ok) throw new Error(`op item edit failed for field "${section}.${label}": ${edit.stderr}`);
  const after = opItemGet(item.title, vault);
  const field = after?.fields.find(f => (f.label ?? "").toLowerCase() === label.toLowerCase() && (f.section?.label ?? "") === section);
  if (!field) throw new Error(`op item edit reported success but field "${section}.${label}" is not readable`);
  return field.id;
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
export interface CfRoutingRule { id: string; name?: string; enabled: boolean; matchers: Array<{ type: string; field?: string; value?: string }>; actions: Array<{ type: string; value?: string[] }> }

// ---------------------------------------------------------------------------
// The capabilities
// ---------------------------------------------------------------------------

const tokenName = (handle: string) => `employee-${handle}`;

async function planAccessToken(config: ProvisioningConfig, block: NonNullable<IdentityDefinition["block"]>, cfToken: string): Promise<{ plan: CapabilityResult; apply: () => Promise<CapabilityResult> }> {
  const { account_id, access_issuer } = config.cloudflare;
  const list = await cfRequest(cfToken, "GET", `/accounts/${account_id}/access/service_tokens?per_page=50`);
  if (!cfOk(list)) return { plan: { action: "blocked", detail: `cannot list service tokens: ${cfError(list)}` }, apply: async () => ({ action: "blocked", detail: "plan blocked" }) };
  const tokens = (list.body?.result ?? []) as CfServiceToken[];
  const named = tokens.find(t => t.name === tokenName(block.handle));
  const bound = block.bindings?.cloudflare_access;
  const boundRemote = bound ? tokens.find(t => t.client_id === bound.principal) : undefined;

  if (bound && boundRemote) return { plan: { action: "no-op", detail: `bound to "${boundRemote.name}" (${boundRemote.id})`, refs: { token_id: boundRemote.id } }, apply: async () => ({ action: "no-op", detail: "already bound and live", refs: { token_id: boundRemote.id } }) };
  if (bound && !boundRemote) return { plan: { action: "conflict", detail: `binding names principal ${bound.principal} but no such service token exists; stale binding — reconcile by hand` }, apply: async () => ({ action: "blocked", detail: "conflict" }) };
  if (named) return { plan: { action: "conflict", detail: `a service token named ${tokenName(block.handle)} already exists (${named.id}) but the employee is not bound; its creation secret is unrecoverable — delete it or bind it by hand` }, apply: async () => ({ action: "blocked", detail: "conflict" }) };

  const plan: CapabilityResult = { action: "create", detail: `create Access service token ${tokenName(block.handle)}, vault it, bind it` };
  const apply = async (): Promise<CapabilityResult> => {
    const created = await cfRequest(cfToken, "POST", `/accounts/${account_id}/access/service_tokens`, { name: tokenName(block.handle), duration: "8760h" });
    if (!cfOk(created)) return { action: "blocked", detail: `token create failed: ${cfError(created)}` };
    const token = created.body.result as { id: string; client_id: string; client_secret: string; expires_at?: string };
    const vault = config.onepassword.vault;
    try {
      const item = opFindIdentityItem(block.handle, vault) ?? opItemCreate(block.handle, block.email, vault);
      opItemFieldSet(item, "Identity Service Token", "Client ID", "text", token.client_id, vault);
      const secretField = opItemFieldSet(item, "Identity Service Token", "Client Secret", "concealed", token.client_secret, vault);
      const boundResult = await bindEmployeeProvider(block.handle, "cloudflare_access", {
        principal: token.client_id,
        instance: access_issuer,
        credential_ref: `op://${vault}/${item.id}/${secretField}`,
      }, { apply: true });
      if (!boundResult.ok) throw new Error(`binding write refused: ${(boundResult.blockers ?? []).map((b: IdentityBlocker) => `${b.code}: ${b.detail}`).join("; ")}`);
      receipt({ capability: "access-token", employee: block.handle, action: "created", token_id: token.id, client_id: token.client_id, expires_at: token.expires_at ?? null, item: item.id });
      return { action: "created", detail: `token ${token.id} vaulted at op://${vault}/${item.id} and bound`, refs: { token_id: token.id, item_id: item.id } };
    } catch (error) {
      // The secret is lost if we stop here: delete the orphan at the provider.
      const removed = await cfRequest(cfToken, "DELETE", `/accounts/${account_id}/access/service_tokens/${token.id}`);
      receipt({ capability: "access-token", employee: block.handle, action: "deleted-orphan", token_id: token.id, reason: (error as Error).message.slice(0, 200), deleted: cfOk(removed) });
      return { action: "blocked", detail: `vault/binding failed (${(error as Error).message.split("\n")[0]}); orphan token ${token.id} ${cfOk(removed) ? "deleted" : "DELETE FAILED — delete it by hand"}` };
    }
  };
  return { plan, apply };
}

async function planMailbox(config: ProvisioningConfig, block: NonNullable<IdentityDefinition["block"]>, cfToken: string): Promise<{ plan: CapabilityResult; apply: () => Promise<CapabilityResult> }> {
  const { zone_id } = config.cloudflare;
  const { worker, kv_namespace_id } = config.mailbox;
  const email = block.email;
  const rules = await cfRequest(cfToken, "GET", `/zones/${zone_id}/email/routing/rules`);
  if (!cfOk(rules)) return { plan: { action: "blocked", detail: `cannot list routing rules: ${cfError(rules)}` }, apply: async () => ({ action: "blocked", detail: "plan blocked" }) };
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
      if (!cfOk(created)) return { action: "blocked", detail: `routing rule create failed: ${cfError(created)}` };
      ruleId = (created.body.result as CfRoutingRule).id;
      receipt({ capability: "mailbox-rule", employee: block.handle, action: "created", rule_id: ruleId, address: email });
    }
    const put = await cfRequest(cfToken, "PUT", `/accounts/${config.cloudflare.account_id}/storage/kv/namespaces/${kv_namespace_id}/values/${encodeURIComponent(kvKey)}`, { handle: block.handle, subject: block.subject, provisioned_at: new Date().toISOString() });
    if (!cfOk(put)) return { action: "blocked", detail: `allowlist write failed: ${cfError(put)}${ruleId && !rule ? " (rule created; retry to finish)" : ""}` };
    receipt({ capability: "mailbox-allowlist", employee: block.handle, action: kv.http_status === 200 ? "no-op" : "created", key: kvKey });
    return { action: rule ? "adopted" : "created", detail: `rule ${ruleId} -> ${worker}; KV ${kvKey} written`, refs: { rule_id: ruleId! } };
  };
  return { plan, apply };
}

function planVaultItem(config: ProvisioningConfig, block: NonNullable<IdentityDefinition["block"]>): { plan: CapabilityResult; apply: () => Promise<CapabilityResult> } {
  const vault = config.onepassword.vault;
  const existing = opFindIdentityItem(block.handle, vault);
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
  capabilities["vault-item"] = await vaultItem.apply();
  capabilities["access-token"] = access.plan.action === "create" ? await access.apply() : access.plan;
  capabilities["mailbox"] = ["create", "adopt"].includes(mailbox.plan.action) ? await mailbox.apply() : mailbox.plan;
  const failed = Object.values(capabilities).some(c => c.action === "blocked" || c.action === "conflict");
  const changed = Object.values(capabilities).some(c => c.action === "created" || c.action === "adopted");
  return {
    ok: !failed, changed, capabilities, blockers, writes: changed ? [join(provisionStateDir(), "receipts.jsonl")] : [],
    note: "Receipts carry IDs and references only; secrets live in the vault item.",
    ...base,
  };
}
