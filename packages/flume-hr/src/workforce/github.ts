// FLUME-50: the GitHub App credential adapter behind the access facade.
//
// An employee's `github` binding names its OWN GitHub App (principal = App ID),
// the installation that App holds (instance = installation ID) and a vault
// reference to the App private key (credential_ref). This module reads that key
// inside the facade process only, asks GitHub (through @octokit/auth-app, which
// signs the app JWT and speaks the installation-token protocol) for a token
// restricted to exactly ONE repository and the requested permissions, verifies
// what GitHub actually returned, and hands the token back to the caller once.
//
// What is never done here: fall back to a PAT, GITHUB_TOKEN/GH_TOKEN, another
// employee's App or a shared App; hand-roll JWT signing; write a token, key or
// app JWT anywhere (ledger, errors, logs). A token that GitHub made broader or
// longer-lived than the grant is revoked, not relabelled.
import { createAppAuth } from "@octokit/auth-app";
import { request as baseRequest } from "@octokit/request";
import type { CompanyIdentityBinding } from "./types";
import { readVaultSecret } from "./vault";

export const GITHUB_OFFICIAL_API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 15_000;
/** GitHub fixes an installation token's lifetime; this much slack absorbs clock and rounding drift. */
const LIFETIME_SLACK_MS = 60_000;
const RETRY_DELAY_MS = 250;
const INSTALLATION_GET_ATTEMPTS = 2;
const REVOKE_ATTEMPTS = 2;

export type GithubLevel = "read" | "write";
/** Requests use read|write only; an installation may hold `admin` (e.g. repository_projects), which covers both. */
const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** `FLUME_GITHUB_API_BASE`, default https://api.github.com, without a trailing slash. */
export function githubApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FLUME_GITHUB_API_BASE || GITHUB_OFFICIAL_API_BASE).replace(/\/+$/u, "");
}
/** `FLUME_GITHUB_TIMEOUT_MS`: each provider call is aborted after this long. */
export function githubTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.FLUME_GITHUB_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}
/** `provider` evidence only against the real API; anything else is a double. */
export function githubEvidence(base: string = githubApiBase()): "provider" | "fixture" {
  return base === GITHUB_OFFICIAL_API_BASE ? "provider" : "fixture";
}

// ---------------------------------------------------------------------------
// Request shape and binding validation (pure; no vault, no network)
// ---------------------------------------------------------------------------

export interface ShapeProblem { code: "invalid-resource" | "invalid-permission" | "lifetime-not-supported"; detail: string }
export interface GithubRequestShape { owner: string; repo: string; permissions: Record<string, GithubLevel> }

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;
const PERMISSION = /^([a-z][a-z0-9_]{0,63}):(read|write)$/u;

/** `owner/repo` exactly, `<name>:<read|write>` permissions, and no requested lifetime. */
export function githubRequestShape(resource: string, permissions: string[], lifetimeSeconds?: number): { shape: GithubRequestShape } | { problem: ShapeProblem } {
  const parts = resource.split("/");
  if (parts.length !== 2 || !OWNER.test(parts[0]!) || !REPO.test(parts[1]!) || parts[1] === "." || parts[1] === "..") {
    return { problem: { code: "invalid-resource", detail: "resource must be exactly owner/repo (no wildcard, no bare owner)" } };
  }
  const map: Record<string, GithubLevel> = {};
  for (const permission of permissions) {
    const match = PERMISSION.exec(permission);
    if (!match || match[1]! in map) return { problem: { code: "invalid-permission", detail: "each permission must be <name>:<read|write>, once per name" } };
    map[match[1]!] = match[2] as GithubLevel;
  }
  if (lifetimeSeconds !== undefined) return { problem: { code: "lifetime-not-supported", detail: "GitHub fixes an installation token's lifetime; omit lifetime_seconds" } };
  return { shape: { owner: parts[0]!, repo: parts[1]!, permissions: map } };
}

/** `op://<vault>/<item-uuid>/<field>`: exactly three segments, the item a 26-character 1Password UUID. */
export function githubCredentialRefProblem(reference: string): string | undefined {
  const match = /^op:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/u.exec(reference);
  if (!match) return "credential_ref must be op://<vault>/<item-uuid>/<field> with exactly three segments (a section-qualified path is refused; reference the field by its ID)";
  if (!/^[a-z0-9]{26}$/u.test(match[2]!)) return "credential_ref item must be the 26-character 1Password item UUID, not a title";
  return undefined;
}

/** Problems with a github binding's principal/instance, or an empty list. */
export function githubBindingProblems(binding: { principal?: string; instance?: string; credential_ref?: string; native_actor_id?: string }): string[] {
  const problems: string[] = [];
  // The schema admits a Plane UUID actor on any binding; a github actor is the bot user's numeric ID, always.
  if (binding.native_actor_id !== undefined && !/^\d+$/u.test(binding.native_actor_id)) problems.push("native_actor_id must be the numeric GitHub bot user ID");
  if (!binding.principal || !/^\d+$/u.test(binding.principal)) problems.push("principal must be the numeric GitHub App ID");
  if (!binding.instance || !/^\d+$/u.test(binding.instance)) problems.push("instance must be the numeric installation ID");
  if (!binding.credential_ref) problems.push("credential_ref must be an op:// reference to the App private key");
  return problems;
}

export interface GithubBindingFacts { appId: string; installationId: string; keyRef: string }

/** The authenticated employee's OWN github binding, or why it cannot be used. No fallback of any kind. */
export function githubBindingOf(binding: CompanyIdentityBinding | undefined): { facts: GithubBindingFacts } | { code: "no-provider-binding" | "provider-binding-invalid"; detail: string } {
  if (!binding) return { code: "no-provider-binding", detail: "the employee has no github binding; an operator binds one with `flume identity bind`" };
  const problems = githubBindingProblems(binding);
  if (problems.length) return { code: "provider-binding-invalid", detail: problems.join("; ") };
  // A hand-edited reference that `identity bind` would refuse (a title may resolve to a duplicate item) is never read.
  const refProblem = githubCredentialRefProblem(binding.credential_ref!);
  if (refProblem) return { code: "provider-binding-invalid", detail: refProblem };
  return { facts: { appId: binding.principal, installationId: binding.instance!, keyRef: binding.credential_ref! } };
}

// ---------------------------------------------------------------------------
// Transport: octokit request, a per-call timeout, and the last response's ids
// ---------------------------------------------------------------------------

export interface Transport {
  request: typeof baseRequest;
  last: { status?: number; requestId?: string };
}

/** The one provider transport: no redirects, every call aborted after `timeoutMs`, the last response's ids recorded. */
export function transport(base: string, timeoutMs: number): Transport {
  const last: Transport["last"] = {};
  const timedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    last.status = undefined;
    last.requestId = undefined;
    // A redirect would carry the credential somewhere the operator never named.
    const response = await fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    last.status = response.status;
    last.requestId = response.headers.get("x-github-request-id") ?? undefined;
    return response;
  };
  return { request: baseRequest.defaults({ baseUrl: base, request: { fetch: timedFetch } }), last };
}

/** GitHub's status, only when GitHub answered: octokit wraps a network error or timeout as status 500 with no `response`. */
export const statusOf = (error: unknown): number | undefined => (typeof (error as { status?: unknown })?.status === "number" && (error as { response?: unknown }).response ? (error as { status: number }).status : undefined);
export const requestIdOf = (error: unknown): string | undefined => {
  const value = (error as { response?: { headers?: Record<string, string> } })?.response?.headers?.["x-github-request-id"];
  return typeof value === "string" ? value : undefined;
};
/** The provider's message, first line only, capped. Never the request (which carries the Authorization header). */
export const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const isTimeout = (error: unknown): boolean => [(error as { name?: string })?.name, ((error as { cause?: { name?: string } })?.cause)?.name].some(name => name === "TimeoutError" || name === "AbortError");

function covers(granted: Record<string, string> | undefined, wanted: Record<string, GithubLevel>): boolean {
  return Object.entries(wanted).every(([name, level]) => (RANK[granted?.[name] ?? ""] ?? 0) >= RANK[level]!);
}
/** `returned` is a subset of `requested`; GitHub always adds metadata:read, which is read-only and accepted. */
function withinRequest(returned: Record<string, string>, requested: Record<string, GithubLevel>): boolean {
  return Object.entries(returned).every(([name, level]) => (name === "metadata" && level === "read") || (RANK[level] ?? 99) <= (RANK[requested[name] ?? ""] ?? 0));
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

export interface GithubIssueInput {
  facts: GithubBindingFacts;
  shape: GithubRequestShape;
  /** The operator grant's max_lifetime_seconds: the most a token may live. */
  approvedLifetimeSeconds: number;
  /** IDs only; copied onto every ledger line. */
  context: Record<string, unknown>;
  /** One secret-free line to provider-ledger.jsonl. */
  ledger: (line: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
}

export type GithubIssueOutcome =
  | { status: "granted"; token: string; app_id: string; installation_id: string; repository: string; permissions: string[]; repository_selection: string; issued_at: string; expires_at: string }
  | { status: "denied"; code: string; detail: string }
  | { status: "error"; http_status: number; code: string; detail: string }
  | { status: "unverified"; code: string; detail: string; residual_expires_at?: string; cause?: string };

const permissionList = (map: Record<string, string>): string[] => Object.entries(map).map(([name, level]) => `${name}:${level}`).sort();

/** Pre-check, mint, verify, and revoke anything that drifted. The returned token is the only place it ever lives. */
export async function issueGithubToken(input: GithubIssueInput): Promise<GithubIssueOutcome> {
  const env = input.env ?? process.env, base = githubApiBase(env), timeout = githubTimeoutMs(env);
  const { facts, shape } = input;
  const repository = `${shape.owner}/${shape.repo}`;
  const scope = { app_id: facts.appId, installation_id: facts.installationId, repository, permissions: permissionList(shape.permissions) };
  const line = (event: string, extra: Record<string, unknown> = {}) => input.ledger({ event, ...input.context, ...scope, ...extra });

  let privateKey: string;
  try { privateKey = readVaultSecret(facts.keyRef, "GitHub App private key"); }
  catch { return { status: "error", http_status: 502, code: "credential-unavailable", detail: "the employee's GitHub App private key could not be read from the vault; no provider call was made" }; }

  // (1) installation pre-check, authenticated by an app JWT that @octokit/auth-app signs.
  const probe = transport(base, timeout);
  let appJwt: string;
  try { appJwt = (await createAppAuth({ appId: facts.appId, privateKey, request: probe.request })({ type: "app" })).token; }
  catch { return { status: "denied", code: "app-key-invalid", detail: "the vaulted private key cannot sign an app JWT; no provider call was made" }; }

  type Installation = { account?: { login?: string } | null; suspended_at?: string | null; permissions?: Record<string, string> };
  let installation: Installation | undefined;
  for (let attempt = 1; attempt <= INSTALLATION_GET_ATTEMPTS && !installation; attempt++) {
    try {
      installation = (await probe.request("GET /app/installations/{installation_id}", { installation_id: Number(facts.installationId), headers: { authorization: `bearer ${appJwt}` } })).data as unknown as Installation;
    } catch (error) {
      const status = statusOf(error);
      if (status === 404) return { status: "denied", code: "installation-mismatch", detail: "this App has no installation with the bound installation ID" };
      if (status !== undefined && status < 500) return { status: "denied", code: "provider-refused", detail: firstLine(error) };
      if (attempt === INSTALLATION_GET_ATTEMPTS) return { status: "error", http_status: 502, code: "provider-unavailable", detail: "GitHub did not answer the installation check; nothing was minted" };
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (!installation) return { status: "error", http_status: 502, code: "provider-unavailable", detail: "GitHub did not answer the installation check; nothing was minted" };
  if (installation.suspended_at) return { status: "denied", code: "installation-suspended", detail: "the installation is suspended" };
  if ((installation.account?.login ?? "").toLowerCase() !== shape.owner.toLowerCase()) return { status: "denied", code: "repository-not-installed", detail: "the repository owner is not the account this installation belongs to" };
  if (!covers(installation.permissions, shape.permissions)) return { status: "denied", code: "excessive-permissions", detail: "the request asks for more than the installation holds" };

  // (2) exactly one POST through a fresh auth instance; repositories is always present with length 1.
  const mint = transport(base, timeout);
  line("attempt");
  let minted;
  try {
    minted = await createAppAuth({ appId: facts.appId, privateKey, request: mint.request })({ type: "installation", installationId: Number(facts.installationId), repositoryNames: [shape.repo], permissions: shape.permissions, refresh: true });
  } catch (error) {
    const status = statusOf(error), requestId = requestIdOf(error) ?? mint.last.requestId;
    if (status !== undefined && status >= 400 && status < 500) {
      line("refused", { http_status: status, github_request_id: requestId });
      return { status: "denied", code: "provider-refused", detail: firstLine(error) };
    }
    line("ambiguous", { ...(status !== undefined ? { http_status: status } : {}), reason: isTimeout(error) ? "timeout" : status === undefined ? "network" : "http-5xx", github_request_id: requestId });
    return { status: "unverified", code: "issuance-ambiguous", detail: "GitHub did not give a definite answer to the token request; installation tokens cannot be listed, so whether one was minted is unknown" };
  }
  const issuedAtMs = Date.now(), requestId = mint.last.requestId, httpStatus = mint.last.status;
  const token = minted.token;
  if (typeof token !== "string" || !token) {
    line("ambiguous", { http_status: httpStatus, reason: "no-token", github_request_id: requestId });
    return { status: "unverified", code: "issuance-ambiguous", detail: "GitHub answered without a token; whether one was minted is unknown" };
  }

  // (3) verify what GitHub actually returned.
  const expiresMs = Date.parse(minted.expiresAt);
  const names = minted.repositoryNames;
  let drift: "provider-scope-mismatch" | "provider-lifetime-exceeds-grant" | undefined;
  if (minted.repositorySelection !== "selected" || !names || names.length !== 1 || names[0]!.toLowerCase() !== shape.repo.toLowerCase() || !withinRequest(minted.permissions, shape.permissions)) drift = "provider-scope-mismatch";
  else if (!Number.isFinite(expiresMs) || expiresMs > issuedAtMs + input.approvedLifetimeSeconds * 1000 + LIFETIME_SLACK_MS) drift = "provider-lifetime-exceeds-grant";
  if (drift) {
    const residual = new Date(Number.isFinite(expiresMs) ? expiresMs : issuedAtMs + 3_600_000).toISOString();
    for (let attempt = 1; attempt <= REVOKE_ATTEMPTS; attempt++) {
      const revoke = transport(base, timeout);
      try {
        await revoke.request("DELETE /installation/token", { headers: { authorization: `token ${token}` } });
        line("revoked", { reason: drift, http_status: revoke.last.status, github_request_id: revoke.last.requestId });
        return { status: "denied", code: drift, detail: drift === "provider-scope-mismatch" ? "GitHub returned a token broader than the request; it was revoked" : "GitHub returned a token that outlives the grant; it was revoked" };
      } catch (error) {
        line("revoke-failed", { reason: drift, attempt, ...(statusOf(error) !== undefined ? { http_status: statusOf(error) } : {}), github_request_id: requestIdOf(error) ?? revoke.last.requestId, expires_at: residual });
        if (attempt < REVOKE_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }
    return { status: "unverified", code: "revoke-failed", cause: drift, residual_expires_at: residual, detail: `GitHub returned a token that violated the grant (${drift}) and it could not be revoked; it expires at the residual time` };
  }

  const expiresAt = new Date(expiresMs).toISOString();
  line("issued", { expires_at: expiresAt, repository_selection: minted.repositorySelection, http_status: httpStatus, github_request_id: requestId });
  return { status: "granted", token, app_id: facts.appId, installation_id: facts.installationId, repository, permissions: permissionList(minted.permissions), repository_selection: minted.repositorySelection, issued_at: new Date(issuedAtMs).toISOString(), expires_at: expiresAt };
}

// ---------------------------------------------------------------------------
// Read-only discovery
// ---------------------------------------------------------------------------

export interface GithubInspection {
  ok: boolean;
  observed_at: string;
  evidence: "provider" | "fixture";
  error?: string;
  app?: { id: number; slug: string; name: string | null; client_id: string | null; owner: { login: string | null; type: string | null } };
  bot_login?: string;
  installations?: Array<{ id: number; account: string | null; account_type: string | null; repository_selection: string | null; permissions: Record<string, string>; suspended: boolean; suspended_at: string | null }>;
  truncated?: boolean;
}

/** App-JWT GETs only: `/app` and `/app/installations`. Never mints, writes or adopts. */
export async function inspectGithubApp(input: { appId: string; keyRef: string; env?: NodeJS.ProcessEnv }): Promise<GithubInspection> {
  const env = input.env ?? process.env, base = githubApiBase(env);
  const result: GithubInspection = { ok: false, observed_at: new Date().toISOString(), evidence: githubEvidence(base) };
  if (!/^\d+$/u.test(input.appId)) return { ...result, error: "app id must be numeric" };
  let privateKey: string;
  try { privateKey = readVaultSecret(input.keyRef, "GitHub App private key"); }
  catch { return { ...result, error: "the GitHub App private key could not be read from the vault" }; }
  const api = transport(base, githubTimeoutMs(env));
  try {
    const jwt = (await createAppAuth({ appId: input.appId, privateKey, request: api.request })({ type: "app" })).token;
    const headers = { authorization: `bearer ${jwt}` };
    const app = (await api.request("GET /app", { headers })).data as Record<string, any>;
    const installations: NonNullable<GithubInspection["installations"]> = [];
    let truncated = false;
    for (let page = 1; page <= 5; page++) {
      const response = await api.request("GET /app/installations", { headers, per_page: 100, page });
      for (const item of response.data as Array<Record<string, any>>) {
        installations.push({ id: item.id, account: item.account?.login ?? null, account_type: item.account?.type ?? null, repository_selection: item.repository_selection ?? null, permissions: item.permissions ?? {}, suspended: Boolean(item.suspended_at), suspended_at: item.suspended_at ?? null });
      }
      if (!/rel="next"/u.test(String(response.headers.link ?? ""))) break;
      if (page === 5) truncated = true;
    }
    return { ...result, ok: true, observed_at: new Date().toISOString(), app: { id: app.id, slug: app.slug, name: app.name ?? null, client_id: app.client_id ?? null, owner: { login: app.owner?.login ?? null, type: app.owner?.type ?? null } }, bot_login: `${app.slug}[bot]`, installations, ...(truncated ? { truncated } : {}) };
  } catch (error) {
    return { ...result, error: statusOf(error) !== undefined ? `GitHub answered HTTP ${statusOf(error)}: ${firstLine(error)}` : "the GitHub App JWT could not be signed or GitHub did not answer" };
  }
}

// ---------------------------------------------------------------------------
// FLUME-53: lifecycle calls (the same transport, the same app JWT, no new client)
// ---------------------------------------------------------------------------

/** Why a provider call produced no answer: `http-<status>` when GitHub answered, else `provider-unavailable`. */
const failureCode = (error: unknown): string => (statusOf(error) !== undefined ? `http-${statusOf(error)}` : "provider-unavailable");

type AppSession = { api: Transport; headers: { authorization: string } } | { code: "credential-unavailable" | "app-key-invalid" };

/** The vault is asked for an App key once per reference per process; in memory only, never written anywhere. */
const keyCache = new Map<string, string>();

/** The App's private key from the vault, and an app JWT signed locally by @octokit/auth-app. No network. */
async function appSession(facts: { appId: string; keyRef: string }, env: NodeJS.ProcessEnv): Promise<AppSession> {
  let privateKey = keyCache.get(facts.keyRef);
  if (privateKey === undefined) {
    try { privateKey = readVaultSecret(facts.keyRef, "GitHub App private key"); }
    catch { return { code: "credential-unavailable" }; }
    keyCache.set(facts.keyRef, privateKey);
  }
  const api = transport(githubApiBase(env), githubTimeoutMs(env));
  try {
    const jwt = (await createAppAuth({ appId: facts.appId, privateKey, request: api.request })({ type: "app" })).token;
    return { api, headers: { authorization: `bearer ${jwt}` } };
  } catch { return { code: "app-key-invalid" }; }
}

/**
 * What GitHub says about the App's private key: `GET /app` with an app JWT it signs. A 401 is GitHub rejecting the key
 * (deleted or rotated away); a 200 for the bound App is the key still being accepted. Read-only.
 */
export type GithubKeyProbe =
  | { state: "accepted" }
  | { state: "rejected"; http_status: number }
  | { state: "unverified"; code: string }
  | { state: "unresolved"; code: string };

export async function probeGithubAppKey(facts: { appId: string; keyRef: string }, env: NodeJS.ProcessEnv = process.env): Promise<GithubKeyProbe> {
  const session = await appSession(facts, env);
  if ("code" in session) return { state: "unverified", code: session.code };
  try {
    const app = (await session.api.request("GET /app", { headers: session.headers })).data as Record<string, any>;
    if (String(app.id) !== facts.appId) return { state: "unverified", code: "app-mismatch" };
    return { state: "accepted" };
  } catch (error) {
    const status = statusOf(error);
    if (status === 401) return { state: "rejected", http_status: 401 };
    if (status !== undefined && status < 500) return { state: "unverified", code: `http-${status}` };
    return { state: "unresolved", code: failureCode(error) };
  }
}

export type GithubInstallationState =
  | { state: "present"; suspended_at: string | null; account: string | null }
  | { state: "absent" }
  | { state: "error"; code: string; unresolved: boolean };

/** `GET /app/installations/{id}` with the App's JWT. Read-only. */
export async function readGithubInstallation(facts: { appId: string; keyRef: string; installationId: string }, env: NodeJS.ProcessEnv = process.env): Promise<GithubInstallationState> {
  const session = await appSession(facts, env);
  if ("code" in session) return { state: "error", code: session.code, unresolved: false };
  try {
    const data = (await session.api.request("GET /app/installations/{installation_id}", { installation_id: Number(facts.installationId), headers: session.headers })).data as Record<string, any>;
    return { state: "present", suspended_at: typeof data.suspended_at === "string" && data.suspended_at ? data.suspended_at : null, account: data.account?.login ?? null };
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) return { state: "absent" };
    return { state: "error", code: failureCode(error), unresolved: status === undefined || status >= 500 };
  }
}

/**
 * `sent: false` means the request never left (no App session); `http_status` is GitHub's answer when it gave one. Together they
 * say whether a failed write DEFINITELY did not commit (never sent, or a 4xx) or might have (a 5xx, a timeout, a dropped answer).
 */
export type GithubInstallationWrite = { ok: true } | { ok: false; absent: boolean; code: string; sent: boolean; http_status?: number };

/** `PUT /app/installations/{id}/suspended` (suspend) or `DELETE` (un-suspend), both authenticated as the App. */
export async function writeGithubInstallationSuspension(facts: { appId: string; keyRef: string; installationId: string }, suspend: boolean, env: NodeJS.ProcessEnv = process.env): Promise<GithubInstallationWrite> {
  const session = await appSession(facts, env);
  if ("code" in session) return { ok: false, absent: false, code: session.code, sent: false };
  try {
    await session.api.request(suspend ? "PUT /app/installations/{installation_id}/suspended" : "DELETE /app/installations/{installation_id}/suspended", { installation_id: Number(facts.installationId), headers: session.headers });
    return { ok: true };
  } catch (error) {
    const status = statusOf(error);
    return { ok: false, absent: status === 404, code: failureCode(error), sent: true, ...(status !== undefined ? { http_status: status } : {}) };
  }
}

// ---------------------------------------------------------------------------
// FLUME-51: the bot user behind an App (the actor an operator adopts)
// ---------------------------------------------------------------------------

export type GithubBotActor =
  | { ok: true; evidence: "provider" | "fixture"; app_id: string; slug: string; login: string; id: string; type: "Bot" }
  | { ok: false; evidence: "provider" | "fixture"; code: string; detail: string };

/**
 * The native actor of an App: the slug from an app-JWT `GET /app`, then the public `GET /users/<slug>[bot]` with NO
 * credential. The user must be `type: Bot` with exactly that login. Read-only: never mints, never writes.
 */
export async function resolveGithubBotActor(input: { appId: string; keyRef: string; env?: NodeJS.ProcessEnv }): Promise<GithubBotActor> {
  const env = input.env ?? process.env, base = githubApiBase(env), evidence = githubEvidence(base);
  const fail = (code: string, detail: string): GithubBotActor => ({ ok: false, evidence, code, detail });
  let privateKey: string;
  try { privateKey = readVaultSecret(input.keyRef, "GitHub App private key"); }
  catch { return fail("credential-unavailable", "the GitHub App private key could not be read from the vault"); }
  const api = transport(base, githubTimeoutMs(env));
  let slug: string;
  try {
    const jwt = (await createAppAuth({ appId: input.appId, privateKey, request: api.request })({ type: "app" })).token;
    const app = (await api.request("GET /app", { headers: { authorization: `bearer ${jwt}` } })).data as Record<string, any>;
    if (String(app.id) !== input.appId) return fail("app-mismatch", `GitHub answered for App ${String(app.id)}, not the bound App ${input.appId}`);
    if (typeof app.slug !== "string" || !app.slug) return fail("app-slug-missing", "GitHub returned no slug for the App");
    slug = app.slug;
  } catch (error) {
    return fail("provider-unavailable", statusOf(error) !== undefined ? `GitHub answered HTTP ${statusOf(error)} for the App: ${firstLine(error)}` : "the GitHub App JWT could not be signed or GitHub did not answer");
  }
  const login = `${slug}[bot]`;
  try {
    const user = (await transport(base, githubTimeoutMs(env)).request("GET /users/{username}", { username: login })).data as Record<string, any>;
    if (user.type !== "Bot") return fail("actor-not-bot", `${login} is a ${String(user.type)} account, not a Bot`);
    if (user.login !== login) return fail("actor-login-mismatch", `GitHub returned user ${String(user.login)} for ${login}`);
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return fail("actor-id-missing", `GitHub returned no numeric ID for ${login}`);
    return { ok: true, evidence, app_id: input.appId, slug, login, id: String(user.id), type: "Bot" };
  } catch (error) {
    return fail("provider-unavailable", statusOf(error) !== undefined ? `GitHub answered HTTP ${statusOf(error)} for ${login}: ${firstLine(error)}` : `GitHub did not answer for ${login}`);
  }
}
