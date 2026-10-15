// Employee access facade: authenticate WHO is asking independently of the harness.
//
// An employee process proves itself with a Cloudflare Access service-token
// assertion (verified with jose: pinned issuer, audience and RS256, rotating
// JWKS), and the signed (issuer, common_name) pair is mapped to exactly one
// enrolled employee through their `cloudflare_access` binding. Nothing the
// caller writes -- a prompt, env var, flag, header or body field -- selects the
// employee. A second assertion, signed by the trusted launcher, binds the
// request to the run that was actually launched for that employee.
//
// Authorization is an operator-authored grant list in the configuration. This
// module never writes that file and has no approve endpoint. Every service
// except `github` gets a FIXTURE grant; `github` goes to the App adapter in
// ./github, which mints a single-repository installation token with the
// authenticated employee's own App. No live Access proof is claimed.
//
// Trust model, stated plainly: the evidence is possession of a scoped
// credential. A shared Unix UID is not a hostile-process boundary.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { SignJWT, createRemoteJWKSet, importSPKI, jwtVerify, type CryptoKey, type JWTVerifyGetKey, type KeyObject } from "jose";
import { identityCensus, resolveEmployee } from "./company";
import { githubBindingOf, githubEvidence, githubRequestShape, inspectGithubApp, issueGithubToken, type GithubInspection, type GithubRequestShape } from "./github";
import { readTombstones, tombstoneFor } from "./lifecycle-state";
import { PLANE_CREDENTIAL_SEMANTICS } from "./plane";
import { accessConfigProblems, accessRequestProblems, mailRequestProblems } from "./validator";
import type { CompanyIdentity, CompanyIdentityBinding } from "./types";

type IdentityDefinitionBlock = CompanyIdentity | null;

export const RUN_ISSUER = "flume-launcher";
export const RUN_AUDIENCE = "flume-access";
export const RUN_TTL_SECONDS = 12 * 60 * 60;
export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
export const RUN_ASSERTION_HEADER = "x-flume-run-assertion";
export const ACCESS_REQUEST_PATH = "/v1/access/requests";
/** FLUME-53: the origin route the agents-facade Worker calls before it reads a mailbox. */
export const MAIL_AUTHORIZE_PATH = "/v1/mail/authorize";
/** The Worker route an employee process posts to; the Worker authorizes it here, then reads only `mail/<handle>/`. */
export const MAIL_MESSAGES_PATH = "/v1/mail/messages";
const MAX_BODY_BYTES = 64 * 1024;

export interface AccessGrant { subject: string; service: string; resource: string; permissions: string[]; max_lifetime_seconds: number }
export interface AccessConfig {
  version: 1;
  url: string;
  listen?: { host?: string; port?: number };
  cloudflare_access: { issuer: string; audience: string };
  launcher: { signing_key_ref: string; public_key: string };
  grants: AccessGrant[];
}
export interface AccessRequest { version: 1; request_id: string; service: string; resource: string; permissions: string[]; lifetime_seconds?: number; employee?: string }
export interface AccessResult { http_status: number; body: Record<string, unknown> }
export interface MailRequest { operation: "list" | "read"; message_id?: string }

/** Where the operator keeps the access configuration. */
export function accessConfigPath(): string {
  return process.env.FLUME_ACCESS_CONFIG || join(process.env.HOME || homedir(), ".config", "flume", "employee-access.yaml");
}

/** Audit, idempotency and fixture-ledger files: IDs, scopes, lifetimes and outcomes only. */
export function accessStateDir(): string {
  const home = process.env.HOME || homedir();
  return process.env.FLUME_ACCESS_STATE || join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "flume", "access");
}

export function loadAccessConfig(path = accessConfigPath()): AccessConfig {
  if (!existsSync(path)) throw new Error(`Access configuration not found: ${path} (set FLUME_ACCESS_CONFIG; see docs/employee-access.md)`);
  let parsed: unknown;
  try { parsed = YAML.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`Access configuration is not valid YAML: ${(error as Error).message}`); }
  const problems = accessConfigProblems(parsed);
  if (problems.length) throw new Error(`Access configuration ${path} is invalid: ${problems.join("; ")}`);
  return parsed as AccessConfig;
}

/** Launcher side: the run assertion that binds a request to one launched run of one employee. */
export async function signRunAssertion(privateKey: CryptoKey | KeyObject, claims: { subject: string; runId: string; harness: string }): Promise<string> {
  return new SignJWT({ harness: claims.harness })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(RUN_ISSUER)
    .setAudience(RUN_AUDIENCE)
    .setSubject(claims.subject)
    .setJti(claims.runId)
    .setIssuedAt()
    .setExpirationTime(`${RUN_TTL_SECONDS}s`)
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// State: audit, idempotency, fixture-provider ledger
// ---------------------------------------------------------------------------

class AccessState {
  constructor(readonly dir: string) {}
  private ensure(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  private append(file: string, line: Record<string, unknown>): void {
    this.ensure();
    const path = join(this.dir, file);
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  audit(line: Record<string, unknown>): void { this.append("audit.jsonl", { at: new Date().toISOString(), event: "access.request", ...line }); }
  ledger(line: Record<string, unknown>): void { this.append("fixture-ledger.jsonl", { at: new Date().toISOString(), provider: "fixture", ...line }); }
  /** IDs, scopes, expiry, HTTP status and x-github-request-id. Never a token, key, app JWT or a prefix/hash of one. */
  providerLedger(line: Record<string, unknown>): void { this.append("provider-ledger.jsonl", { at: new Date().toISOString(), provider: "github", ...line }); }
  idempotency(): Record<string, { hash: string; result: Record<string, unknown>; http_status?: number }> {
    const path = join(this.dir, "idempotency.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  saveIdempotency(records: Record<string, unknown>): void {
    this.ensure();
    const path = join(this.dir, "idempotency.json"), temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(records), { mode: 0o600 });
    renameSync(temporary, path);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

type Tag = { evidence: string; provider: string };
const FIXTURE: Tag = { evidence: "fixture", provider: "fixture" };
/** What a result says about where it came from: real provider evidence only against the real GitHub API. */
const tagFor = (service: string): Tag => (service === "github" ? { evidence: githubEvidence(), provider: "github" } : FIXTURE);

/** One line to stderr, never a secret: the first line of the message only. */
function logFailure(what: string, error: unknown): void {
  process.stderr.write(`flume access: ${what}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}\n`);
}

/** The scope and requested lifetime of a validated request, for audit lines. */
const scopeOf = (request: AccessRequest) => ({ service: request.service, resource: request.resource, permissions: request.permissions, ...(request.lifetime_seconds !== undefined ? { lifetime_seconds: request.lifetime_seconds } : {}) });

function refusal(http_status: number, code: string, detail: string, kind: "error" | "denied" = "error", tag: Tag = FIXTURE): AccessResult {
  return { http_status, body: { ok: false, status: kind, code, detail, ...tag } };
}

function header(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.trim() ? first.trim() : undefined;
}

export interface AccessFacade {
  handle(headers: IncomingMessage["headers"], readBody: () => Promise<string>): Promise<AccessResult>;
  /** FLUME-53: who is this, and are they active? The Worker owns the mailbox; this only decides. */
  handleMail(headers: IncomingMessage["headers"], readBody: () => Promise<string>): Promise<AccessResult>;
}

export async function createAccessFacade(initial: AccessConfig, options: { state?: string; configPath?: string } = {}): Promise<AccessFacade> {
  const issuer = initial.cloudflare_access.issuer, audience = initial.cloudflare_access.audience;
  const jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/u, "")}/cdn-cgi/access/certs`));
  const runKey = await importSPKI(initial.launcher.public_key, "EdDSA");
  const state = new AccessState(options.state ?? accessStateDir());
  let grants = initial.grants;
  // Single-flight: one request at a time decides idempotency and issues, so two
  // identical concurrent requests cannot both issue.
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };

  const finish = (result: AccessResult, who: Record<string, unknown> = {}, event?: string): AccessResult => {
    const body = result.body;
    state.audit({ ...(event ? { event } : {}), outcome: body.code ?? body.status, http_status: result.http_status, ...who, ...(body.grant_id ? { grant_id: body.grant_id } : {}), ...(typeof body.lifetime_seconds === "number" ? { lifetime_seconds: body.lifetime_seconds } : {}), ...(typeof body.expires_at === "string" ? { expires_at: body.expires_at } : {}), ...(body.replayed ? { replayed: true } : {}) });
    return result;
  };

  async function authenticate(headers: IncomingMessage["headers"]): Promise<{ failure: AccessResult } | { issuer: string; clientId: string }> {
    const assertion = header(headers, ACCESS_ASSERTION_HEADER);
    if (!assertion) return { failure: refusal(401, "missing-assertion", "no Cloudflare Access assertion; the origin accepts only requests that came through Access") };
    try {
      const { payload } = await jwtVerify(assertion, jwks, { issuer, audience, algorithms: ["RS256"], requiredClaims: ["exp"] });
      // Service-token assertions carry an empty `sub`; a human token has no common_name. Email and display headers are never identity.
      if (typeof payload.common_name !== "string" || !payload.common_name) return { failure: refusal(401, "missing-machine-identity", "the assertion carries no service-token common_name") };
      return { issuer: String(payload.iss), clientId: payload.common_name };
    } catch {
      return { failure: refusal(401, "invalid-assertion", "the Cloudflare Access assertion did not verify") };
    }
  }

  async function verifyRun(headers: IncomingMessage["headers"], subject: string): Promise<{ failure: AccessResult } | { runId: string; harness: string }> {
    const token = header(headers, RUN_ASSERTION_HEADER);
    if (!token) return { failure: refusal(401, "missing-run", "no run assertion; start the process with `flume launch` or `flume access run`") };
    try {
      const { payload } = await jwtVerify(token, runKey, { issuer: RUN_ISSUER, audience: RUN_AUDIENCE, algorithms: ["EdDSA"], requiredClaims: ["exp", "jti", "sub"] });
      if (typeof payload.harness !== "string" || !payload.harness || typeof payload.jti !== "string") return { failure: refusal(401, "invalid-run", "the run assertion is malformed") };
      if (payload.sub !== subject) return { failure: refusal(401, "run-subject-mismatch", "the run was launched for a different employee than the one Access authenticated") };
      return { runId: payload.jti, harness: payload.harness };
    } catch {
      return { failure: refusal(401, "invalid-run", "the run assertion did not verify") };
    }
  }

  function policy(subject: string, request: AccessRequest): { grant: AccessGrant; lifetime: number } | undefined {
    for (const grant of grants) {
      if (grant.subject !== subject || grant.service !== request.service || grant.resource !== request.resource) continue;
      const lifetime = request.lifetime_seconds ?? grant.max_lifetime_seconds;
      if (lifetime > grant.max_lifetime_seconds) continue;
      if (!request.permissions.every(permission => grant.permissions.includes(permission))) continue;
      return { grant, lifetime };
    }
    return undefined;
  }

  const decide = async (subject: string, handle: string, binding: CompanyIdentityBinding | undefined, run: { runId: string; harness: string }, request: AccessRequest): Promise<AccessResult> => {
    const who = { subject, handle, run_id: run.runId, harness: run.harness, request_id: request.request_id, ...scopeOf(request) };
    // Plane credentials are employee-owned static PATs: no grant here can carry, shorten or extend one, and a local grant TTL
    // must never be readable as the token's expiry. Refused before any policy match, never persisted, audit line only.
    if (request.service === "plane") {
      return finish({ http_status: 403, body: { ok: false, status: "denied", code: "static-provider-credential", detail: "a Plane personal access token is static and owned by the employee; it is not issued, scoped or expired by an access grant. Pilot (`px identity verify`) verifies it by reference", evidence: "none", provider: "plane", credential_semantics: PLANE_CREDENTIAL_SEMANTICS } }, who);
    }
    const key = `${subject}/${request.request_id}`;
    const hash = createHash("sha256").update(canonical(request)).digest("hex");
    const records = state.idempotency();
    const stored = records[key];
    const github = request.service === "github", tag = tagFor(request.service);
    if (stored) {
      if (stored.hash !== hash) return finish(refusal(409, "conflict", "request_id was already used with a different request body", "error", tag), who);
      // The credential was never stored, so a replay returns the original grant identity and expiry, not the value.
      return finish({ http_status: stored.http_status ?? 200, body: { ...stored.result, replayed: true, ...(stored.result.status === "granted" ? { credential_redelivered: false } : {}) } }, who);
    }
    // github: the request shape is checked before policy, and a malformed request is a denial that is never persisted.
    const shaped = github ? githubRequestShape(request.resource, request.permissions, request.lifetime_seconds) : undefined;
    if (shaped && "problem" in shaped) return finish(refusal(403, shaped.problem.code, shaped.problem.detail, "denied", tag), who);
    const approved = policy(subject, request);
    let body: Record<string, unknown>;
    if (!approved) {
      body = { ok: false, status: "approval_required", version: 1, request_id: request.request_id, subject, handle, run_id: run.runId, harness: run.harness, service: request.service, resource: request.resource, permissions: request.permissions, reason: "outside the operator-approved grants; the employee cannot approve its own access", replayed: false, ...tag };
      records[key] = { hash, result: body };
      state.saveIdempotency(records);
      return finish({ http_status: 200, body }, who);
    }
    if (shaped && "shape" in shaped) return decideGithub(subject, handle, binding, run, request, shaped.shape, approved.lifetime, { key, hash, records, who });
    const issuedAt = new Date(), grantId = randomUUID(), expiresAt = new Date(issuedAt.getTime() + approved.lifetime * 1000).toISOString();
    const { permissions } = request;
    body = { ok: true, status: "granted", version: 1, request_id: request.request_id, subject, handle, run_id: run.runId, harness: run.harness, grant_id: grantId, service: request.service, resource: request.resource, permissions, lifetime_seconds: approved.lifetime, issued_at: issuedAt.toISOString(), expires_at: expiresAt, replayed: false, ...FIXTURE };
    // Ledger and idempotency record are written before the credential exists in the response, and never hold it.
    state.ledger({ grant_id: grantId, subject, run_id: run.runId, request_id: request.request_id, service: request.service, resource: request.resource, permissions, expires_at: expiresAt });
    records[key] = { hash, result: body };
    state.saveIdempotency(records);
    return finish({ http_status: 200, body: { ...body, credential: { kind: "fixture-bearer", value: `fixture-${randomBytes(18).toString("hex")}` } } }, { ...who, grant_id: grantId });
  };

  /** The operator approved this github request: bind check, then the provider. Only granted and unverified outcomes persist. */
  async function decideGithub(subject: string, handle: string, binding: CompanyIdentityBinding | undefined, run: { runId: string; harness: string }, request: AccessRequest, shape: GithubRequestShape, approvedLifetime: number, ctx: { key: string; hash: string; records: ReturnType<AccessState["idempotency"]>; who: Record<string, unknown> }): Promise<AccessResult> {
    const tag = tagFor("github");
    const bound = githubBindingOf(binding);
    if ("code" in bound) return finish(refusal(403, bound.code, bound.detail, "denied", tag), ctx.who);
    const grantId = randomUUID();
    const outcome = await issueGithubToken({
      facts: bound.facts, shape, approvedLifetimeSeconds: approvedLifetime,
      context: { grant_id: grantId, subject, run_id: run.runId, request_id: request.request_id },
      ledger: line => state.providerLedger(line),
    });
    const persist = (body: Record<string, unknown>, http_status: number) => {
      ctx.records[ctx.key] = { hash: ctx.hash, result: body, ...(http_status !== 200 ? { http_status } : {}) };
      state.saveIdempotency(ctx.records);
    };
    if (outcome.status === "denied") return finish(refusal(403, outcome.code, outcome.detail, "denied", tag), ctx.who);
    if (outcome.status === "error") return finish(refusal(outcome.http_status, outcome.code, outcome.detail, "error", tag), ctx.who);
    if (outcome.status === "unverified") {
      const body = { ok: false, status: "unverified", code: outcome.code, version: 1, request_id: request.request_id, subject, handle, run_id: run.runId, harness: run.harness, service: request.service, resource: request.resource, permissions: request.permissions, detail: outcome.detail, ...(outcome.cause ? { cause: outcome.cause } : {}), ...(outcome.residual_expires_at ? { residual_expires_at: outcome.residual_expires_at } : {}), replayed: false, ...tag };
      persist(body, 502);
      return finish({ http_status: 502, body }, ctx.who);
    }
    const lifetime = Math.max(0, Math.round((Date.parse(outcome.expires_at) - Date.parse(outcome.issued_at)) / 1000));
    const body = { ok: true, status: "granted", version: 1, request_id: request.request_id, subject, handle, run_id: run.runId, harness: run.harness, grant_id: grantId, service: request.service, resource: request.resource, repository: outcome.repository, permissions: outcome.permissions, repository_selection: outcome.repository_selection, app_id: outcome.app_id, installation_id: outcome.installation_id, lifetime_seconds: lifetime, issued_at: outcome.issued_at, expires_at: outcome.expires_at, replayed: false, ...tag };
    // The idempotency record never holds the token; the first response is its only channel.
    persist(body, 200);
    return finish({ http_status: 200, body: { ...body, credential: { kind: "github-installation-token", value: outcome.token } } }, { ...ctx.who, grant_id: grantId });
  }

  type Client = { issuer: string; clientId: string };

  /** The one enrolled employee a signed client maps to, from a census read NOW (every request, and again before issuing). */
  function employeeOf(client: Client): { failure: AccessResult } | { block: NonNullable<IdentityDefinitionBlock> } {
    const matches = identityCensus().definitions.filter(definition => {
      const binding = definition.block?.bindings?.cloudflare_access;
      return binding && binding.instance === client.issuer && binding.principal === client.clientId;
    });
    if (matches.length !== 1) return { failure: matches.length ? refusal(403, "ambiguous-client", "the signed client is bound to more than one employee") : refusal(403, "unknown-client", "the signed client is not bound to any employee") };
    return { block: matches[0]!.block! };
  }

  /**
   * Is this employee in service right now? The definition's status, unless a retirement tombstone names its subject or its
   * handle: a retired role.yaml reverted to `active` by a checkout, or a hand-written block around a retired handle, is still
   * retired here. Tombstones that cannot be read fail CLOSED: nothing is granted or authorized on a guess.
   */
  function standing(block: NonNullable<IdentityDefinitionBlock>, deniedDetail: string, tag: Tag = FIXTURE): AccessResult | undefined {
    let retired;
    try { retired = tombstoneFor(readTombstones(), block); } catch (error) {
      logFailure("retirement tombstones unreadable; refusing", error);
      return refusal(503, "lifecycle-state-unavailable", "the retirement tombstones could not be read; nothing is granted or authorized until they can (fail closed)", "error", tag);
    }
    const status = retired ? "retired" : block.status;
    if (status !== "active") return refusal(403, `employee-${status}`, `the employee is ${status}${retired ? ` (retired ${retired.by} tombstone, ${retired.tombstone.retired_at})` : ""}; ${deniedDetail}`, "denied", tag);
    return undefined;
  }

  /** Steps 1-3, shared by access and mail: the signed client, the one enrolled employee it maps to, and the launched run. */
  async function identify(headers: IncomingMessage["headers"], event?: string): Promise<{ failure: AccessResult } | { block: NonNullable<IdentityDefinitionBlock>; client: Client; run: { runId: string; harness: string }; who: Record<string, unknown> }> {
    // 1. authenticate the assertion
    const authenticated = await authenticate(headers);
    if ("failure" in authenticated) return { failure: finish(authenticated.failure, {}, event) };
    // 2. map the signed client to exactly one enrolled employee. The census is read on EVERY request.
    const mapped = employeeOf(authenticated);
    if ("failure" in mapped) return { failure: finish(mapped.failure, {}, event) };
    const block = mapped.block;
    // 3. verify the run
    const run = await verifyRun(headers, block.subject);
    if ("failure" in run) return { failure: finish(run.failure, { subject: block.subject, handle: block.handle }, event) };
    return { block, client: authenticated, run, who: { subject: block.subject, handle: block.handle, run_id: run.runId, harness: run.harness } };
  }

  return {
    async handle(headers, readBody) {
      try {
        const identified = await identify(headers);
        if ("failure" in identified) return identified.failure;
        const { block, who } = identified;
        const run = identified.run;
        const subject = block.subject, handle = block.handle;
        // 4. validate the body
        let body: unknown;
        try { body = JSON.parse(await readBody()); } catch { return finish(refusal(400, "invalid-request", "the request body is not valid JSON"), who); }
        const problems = accessRequestProblems(body);
        if (problems.length) return finish({ http_status: 400, body: { ok: false, status: "error", code: "invalid-request", detail: problems.join("; ").slice(0, 400), ...FIXTURE } }, who);
        const request = body as AccessRequest;
        const scoped = { ...who, request_id: request.request_id, ...scopeOf(request) };
        // 5. employee and status checks
        if (request.employee !== undefined && request.employee !== handle && request.employee !== subject) {
          return finish(refusal(403, "employee-mismatch", "the request names a different employee than the one Access authenticated", "denied", tagFor(request.service)), scoped);
        }
        const out = standing(block, "no new access is issued", tagFor(request.service));
        if (out) return finish(out, scoped);
        // 6-8. idempotency, policy, fixture issue
        return await serialized(async () => {
          // Re-checked INSIDE the queue: a request that waited behind a slow GitHub mint must not be issued after a
          // `suspend` or `retire` wrote its status while it waited.
          const now = employeeOf(identified.client);
          if ("failure" in now) return finish(now.failure, scoped);
          const late = now.block.subject !== subject ? refusal(403, "unknown-client", "the signed client no longer maps to the employee that was authenticated") : standing(now.block, "no new access is issued", tagFor(request.service));
          if (late) return finish(late, scoped);
          if (options.configPath) {
            // The operator approves by editing the file; the facade only ever reads it. A file that cannot be read
            // fails closed: a revoked grant must not stay live behind a YAML or schema error.
            try { grants = loadAccessConfig(options.configPath).grants; } catch (error) { grants = []; logFailure(`grants reload failed for ${options.configPath}; every request needs approval`, error); }
          }
          return await decide(subject, handle, now.block.bindings?.github, run, request);
        });
      } catch (error) {
        logFailure("internal error", error);
        return { http_status: 500, body: { ok: false, status: "error", code: "internal-error", detail: "the access facade failed; nothing was issued", ...FIXTURE } };
      }
    },

    /**
     * FLUME-53 mail authorize: the same assertion, client mapping, run, body and FRESH status pipeline as an access request.
     * It decides identity and employment and nothing else; the Worker reads storage only after an `authorized` answer.
     * The handle comes only from the verified machine identity. The audit line never holds mail content or codes.
     */
    async handleMail(headers, readBody) {
      const event = "mail.authorize";
      try {
        const identified = await identify(headers, event);
        if ("failure" in identified) return identified.failure;
        const { block, who } = identified;
        let body: unknown;
        try { body = JSON.parse(await readBody()); } catch { return finish(refusal(400, "invalid-request", "the request body is not valid JSON"), who, event); }
        const problems = mailRequestProblems(body);
        if (problems.length) return finish(refusal(400, "invalid-request", problems.join("; ").slice(0, 400)), who, event);
        const request = body as MailRequest;
        const named = { ...who, operation: request.operation, ...(request.message_id ? { message_id: request.message_id } : {}) };
        const out = standing(block, "the mailbox is closed to reads");
        if (out) return finish(out, named, event);
        return finish({ http_status: 200, body: { ok: true, status: "authorized", handle: block.handle, subject: block.subject, run_id: identified.run.runId, harness: identified.run.harness, mailbox_prefix: `mail/${block.handle}/`, operation: request.operation } }, named, event);
      } catch (error) {
        logFailure("internal error", error);
        return { http_status: 500, body: { ok: false, status: "error", code: "internal-error", detail: "the mail authorization failed; nothing was read", ...FIXTURE } };
      }
    },
  };
}

function readLimited(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("body too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Start the facade. Binds to loopback unless told otherwise; the only way in is Access in front of it. */
export async function startAccessServer(config: AccessConfig, options: { host?: string; port?: number; state?: string; configPath?: string } = {}): Promise<{ server: Server; url: string }> {
  const facade = await createAccessFacade(config, options);
  const server = createServer(async (request, response) => {
    const send = (result: AccessResult) => {
      response.writeHead(result.http_status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(`${JSON.stringify(result.body)}\n`);
    };
    // Nothing thrown here may escape: an unhandled rejection in this handler would take the facade down before authentication.
    try {
      let path: string;
      try { path = new URL(request.url ?? "/", "http://facade").pathname; } catch { return send(refusal(400, "invalid-request", "unparseable request target")); }
      if (path !== ACCESS_REQUEST_PATH && path !== MAIL_AUTHORIZE_PATH) return send(refusal(404, "not-found", "unknown path"));
      if (request.method !== "POST") return send(refusal(405, "method-not-allowed", "POST only"));
      send(await (path === MAIL_AUTHORIZE_PATH ? facade.handleMail : facade.handle)(request.headers, () => readLimited(request)));
    } catch (error) {
      logFailure("request handler failed", error);
      if (response.headersSent) response.destroy();
      else send(refusal(500, "internal-error", "the access facade failed; nothing was issued"));
    }
  });
  const host = options.host ?? config.listen?.host ?? "127.0.0.1", port = options.port ?? config.listen?.port ?? 8787;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  return { server, url: `http://${host}:${typeof address === "object" && address ? address.port : port}` };
}

// ---------------------------------------------------------------------------
// The plain client
// ---------------------------------------------------------------------------

export interface AccessClientInput { service: string; resource: string; permissions: string[]; lifetimeSeconds?: number; requestId?: string; employee?: string }

/** `flume access request`: reads only what the launcher put in the environment. Identity is never an argument. */
export async function requestAccess(input: AccessClientInput, env: NodeJS.ProcessEnv = process.env): Promise<AccessResult> {
  const body: AccessRequest = {
    version: 1, request_id: input.requestId ?? randomUUID(), service: input.service, resource: input.resource, permissions: input.permissions,
    ...(input.lifetimeSeconds !== undefined ? { lifetime_seconds: input.lifetimeSeconds } : {}),
    ...(input.employee !== undefined ? { employee: input.employee } : {}),
  };
  return postAsLaunched(ACCESS_REQUEST_PATH, body, env);
}

/** The launcher's environment or an error naming what is missing: identity is never an argument. */
function launchedEnv(env: NodeJS.ProcessEnv): void {
  const missing = ["FLUME_ACCESS_URL", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "FLUME_RUN_ASSERTION"].filter(name => !env[name]);
  if (missing.length) throw new Error(`Not launched by Flume: missing ${missing.join(", ")} (start this process with \`flume launch\` or \`flume access run\`)`);
}

async function postAsLaunched(path: string, body: unknown, env: NodeJS.ProcessEnv): Promise<AccessResult> {
  launchedEnv(env);
  const response = await fetch(`${env.FLUME_ACCESS_URL!.replace(/\/$/u, "")}${path}`, {
    method: "POST",
    // Never follow a redirect: it would re-send the client secret and run assertion to whatever origin it names.
    redirect: "manual",
    headers: { "content-type": "application/json", "cf-access-client-id": env.CF_ACCESS_CLIENT_ID!, "cf-access-client-secret": env.CF_ACCESS_CLIENT_SECRET!, [RUN_ASSERTION_HEADER]: env.FLUME_RUN_ASSERTION! },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text); } catch { parsed = { ok: false, status: "error", code: "bad-response", detail: `HTTP ${response.status} without a JSON body` }; }
  return { http_status: response.status, body: parsed };
}

/**
 * `flume mail list|read <id>` (FLUME-53): ask the agents-facade Worker for this employee's mail. Plain client: the Worker
 * learns who is asking from the Access assertion and the run assertion the launcher set, never from an argument, and there
 * is no send path. Only the authenticated employee's `mail/<handle>/` prefix is ever read, and only while they are active.
 */
export async function requestMail(input: MailRequest, env: NodeJS.ProcessEnv = process.env): Promise<AccessResult> {
  return postAsLaunched(MAIL_MESSAGES_PATH, { operation: input.operation, ...(input.message_id !== undefined ? { message_id: input.message_id } : {}) }, env);
}

/** The result with any non-fixture credential value removed: a GitHub token is delivered to a child, never printed. */
export function printableResult(body: Record<string, unknown>): Record<string, unknown> {
  const credential = body.credential as { kind?: unknown } | undefined;
  if (!credential || credential.kind === "fixture-bearer") return body;
  return { ...body, credential: { kind: credential.kind, delivered: false, note: "withheld from output; only `--exec` delivers it, to the consumer's environment" } };
}

/**
 * `flume access request --exec -- <consumer>`: the only way a GitHub token leaves the client. The consumer gets the
 * parent environment minus the Access client secret and run assertion, plus GH_TOKEN, GITHUB_TOKEN, the grant's id
 * and expiry, and the granted subject, repository, App ID and installation ID (FLUME_EMPLOYEE_SUBJECT, FLUME_GITHUB_*). The token reaches no stdout, stderr or file of ours. Resolves to the consumer's exit code.
 */
export function execWithGithubToken(body: Record<string, unknown>, command: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const credential = body.credential as { kind?: string; value?: string } | undefined;
  if (body.status === "granted" && body.replayed === true) throw new Error("This request_id was already granted: the token is delivered only on the first response, so pass a fresh --request-id (or omit it)");
  if (body.status !== "granted" || credential?.kind !== "github-installation-token" || !credential.value) throw new Error("No GitHub installation token was granted; the consumer was not started");
  const { CF_ACCESS_CLIENT_SECRET: _secret, FLUME_RUN_ASSERTION: _assertion, ...rest } = env;
  // The four FLUME_ identity facts come from the granted body, never from the caller: they are what `flume comment` checks the employee's binding against.
  const childEnv: NodeJS.ProcessEnv = { ...rest, GH_TOKEN: credential.value, GITHUB_TOKEN: credential.value, FLUME_GRANT_ID: String(body.grant_id), FLUME_GRANT_EXPIRES_AT: String(body.expires_at), FLUME_EMPLOYEE_SUBJECT: String(body.subject), FLUME_GITHUB_REPOSITORY: String(body.repository), FLUME_GITHUB_APP_ID: String(body.app_id), FLUME_GITHUB_INSTALLATION_ID: String(body.installation_id) };
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(command[0]!, command.slice(1), { env: childEnv, stdio: "inherit" });
    child.once("error", error => reject(new Error(`Cannot run ${command[0]}: ${error.message}`)));
    child.once("close", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}

/** `flume access github-inspect`: read-only discovery for an enrolled employee's binding, or an explicit App. */
export async function githubInspect(options: { employee?: string; appId?: string; keyRef?: string }): Promise<GithubInspection> {
  if (options.employee && (options.appId || options.keyRef)) return { ok: false, observed_at: new Date().toISOString(), evidence: githubEvidence(), error: "pass --employee, or --app-id with --key-ref, not both" };
  if (options.employee) {
    const target = resolveEmployee(identityCensus(), options.employee);
    if (target.problem) return { ok: false, observed_at: new Date().toISOString(), evidence: githubEvidence(), error: `definition for ${options.employee} is unreadable: ${target.problem}` };
    const bound = githubBindingOf(target.block?.bindings?.github);
    if ("code" in bound) return { ok: false, observed_at: new Date().toISOString(), evidence: githubEvidence(), error: `${bound.code}: ${bound.detail}` };
    return inspectGithubApp({ appId: bound.facts.appId, keyRef: bound.facts.keyRef });
  }
  if (!options.appId || !options.keyRef) return { ok: false, observed_at: new Date().toISOString(), evidence: githubEvidence(), error: "pass --employee, or both --app-id and --key-ref" };
  return inspectGithubApp({ appId: options.appId, keyRef: options.keyRef });
}
