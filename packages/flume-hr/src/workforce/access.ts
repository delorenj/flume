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
// module never writes that file and has no approve endpoint. Only a FIXTURE
// grant is issued: no provider is called and no live Access proof is claimed.
//
// Trust model, stated plainly: the evidence is possession of a scoped
// credential. A shared Unix UID is not a hostile-process boundary.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { SignJWT, createRemoteJWKSet, importSPKI, jwtVerify, type CryptoKey, type JWTVerifyGetKey, type KeyObject } from "jose";
import { identityCensus } from "./company";
import { accessConfigProblems, accessRequestProblems } from "./validator";

export const RUN_ISSUER = "flume-launcher";
export const RUN_AUDIENCE = "flume-access";
export const RUN_TTL_SECONDS = 12 * 60 * 60;
export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
export const RUN_ASSERTION_HEADER = "x-flume-run-assertion";
export const ACCESS_REQUEST_PATH = "/v1/access/requests";
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
  idempotency(): Record<string, { hash: string; result: Record<string, unknown> }> {
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

const FIXTURE = { evidence: "fixture", provider: "fixture" } as const;

/** One line to stderr, never a secret: the first line of the message only. */
function logFailure(what: string, error: unknown): void {
  process.stderr.write(`flume access: ${what}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}\n`);
}

/** The scope and requested lifetime of a validated request, for audit lines. */
const scopeOf = (request: AccessRequest) => ({ service: request.service, resource: request.resource, permissions: request.permissions, ...(request.lifetime_seconds !== undefined ? { lifetime_seconds: request.lifetime_seconds } : {}) });

function refusal(http_status: number, code: string, detail: string, kind: "error" | "denied" = "error"): AccessResult {
  return { http_status, body: { ok: false, status: kind, code, detail, ...FIXTURE } };
}

function header(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.trim() ? first.trim() : undefined;
}

export interface AccessFacade {
  handle(headers: IncomingMessage["headers"], readBody: () => Promise<string>): Promise<AccessResult>;
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

  const finish = (result: AccessResult, who: Record<string, unknown> = {}): AccessResult => {
    const body = result.body;
    state.audit({ outcome: body.code ?? body.status, http_status: result.http_status, ...who, ...(body.grant_id ? { grant_id: body.grant_id } : {}), ...(typeof body.lifetime_seconds === "number" ? { lifetime_seconds: body.lifetime_seconds } : {}), ...(typeof body.expires_at === "string" ? { expires_at: body.expires_at } : {}), ...(body.replayed ? { replayed: true } : {}) });
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

  const decide = (subject: string, handle: string, run: { runId: string; harness: string }, request: AccessRequest): AccessResult => {
    const who = { subject, handle, run_id: run.runId, harness: run.harness, request_id: request.request_id, ...scopeOf(request) };
    const key = `${subject}/${request.request_id}`;
    const hash = createHash("sha256").update(canonical(request)).digest("hex");
    const records = state.idempotency();
    const stored = records[key];
    if (stored) {
      if (stored.hash !== hash) return finish(refusal(409, "conflict", "request_id was already used with a different request body"), who);
      // The credential was never stored, so a replay returns the original grant identity and expiry, not the value.
      return finish({ http_status: 200, body: { ...stored.result, replayed: true, ...(stored.result.status === "granted" ? { credential_redelivered: false } : {}) } }, who);
    }
    const approved = policy(subject, request);
    let body: Record<string, unknown>;
    if (!approved) {
      body = { ok: false, status: "approval_required", version: 1, request_id: request.request_id, subject, handle, run_id: run.runId, harness: run.harness, service: request.service, resource: request.resource, permissions: request.permissions, reason: "outside the operator-approved grants; the employee cannot approve its own access", replayed: false, ...FIXTURE };
      records[key] = { hash, result: body };
      state.saveIdempotency(records);
      return finish({ http_status: 200, body }, who);
    }
    const issuedAt = new Date(), grantId = randomUUID(), expiresAt = new Date(issuedAt.getTime() + approved.lifetime * 1000).toISOString();
    const { permissions } = request;
    body = { ok: true, status: "granted", version: 1, request_id: request.request_id, subject, handle, run_id: run.runId, harness: run.harness, grant_id: grantId, service: request.service, resource: request.resource, permissions, lifetime_seconds: approved.lifetime, issued_at: issuedAt.toISOString(), expires_at: expiresAt, replayed: false, ...FIXTURE };
    // Ledger and idempotency record are written before the credential exists in the response, and never hold it.
    state.ledger({ grant_id: grantId, subject, run_id: run.runId, request_id: request.request_id, service: request.service, resource: request.resource, permissions, expires_at: expiresAt });
    records[key] = { hash, result: body };
    state.saveIdempotency(records);
    return finish({ http_status: 200, body: { ...body, credential: { kind: "fixture-bearer", value: `fixture-${randomBytes(18).toString("hex")}` } } }, { ...who, grant_id: grantId });
  };

  return {
    async handle(headers, readBody) {
      try {
        // 1. authenticate the assertion
        const authenticated = await authenticate(headers);
        if ("failure" in authenticated) return finish(authenticated.failure);
        // 2. map the signed client to exactly one enrolled employee
        const matches = identityCensus().definitions.filter(definition => {
          const binding = definition.block?.bindings?.cloudflare_access;
          return binding && binding.instance === authenticated.issuer && binding.principal === authenticated.clientId;
        });
        if (matches.length !== 1) return finish(matches.length ? refusal(403, "ambiguous-client", "the signed client is bound to more than one employee") : refusal(403, "unknown-client", "the signed client is not bound to any employee"));
        const block = matches[0]!.block!;
        const subject = block.subject, handle = block.handle;
        // 3. verify the run
        const run = await verifyRun(headers, subject);
        if ("failure" in run) return finish(run.failure, { subject, handle });
        const who = { subject, handle, run_id: run.runId, harness: run.harness };
        // 4. validate the body
        let body: unknown;
        try { body = JSON.parse(await readBody()); } catch { return finish(refusal(400, "invalid-request", "the request body is not valid JSON"), who); }
        const problems = accessRequestProblems(body);
        if (problems.length) return finish({ http_status: 400, body: { ok: false, status: "error", code: "invalid-request", detail: problems.join("; ").slice(0, 400), ...FIXTURE } }, who);
        const request = body as AccessRequest;
        // 5. employee and status checks
        if (request.employee !== undefined && request.employee !== handle && request.employee !== subject) {
          return finish(refusal(403, "employee-mismatch", "the request names a different employee than the one Access authenticated", "denied"), { ...who, request_id: request.request_id, ...scopeOf(request) });
        }
        if (block.status !== "active") return finish(refusal(403, `employee-${block.status}`, `the employee is ${block.status}; no new access is issued`, "denied"), { ...who, request_id: request.request_id, ...scopeOf(request) });
        // 6-8. idempotency, policy, fixture issue
        return await serialized(async () => {
          if (options.configPath) {
            // The operator approves by editing the file; the facade only ever reads it. A file that cannot be read
            // fails closed: a revoked grant must not stay live behind a YAML or schema error.
            try { grants = loadAccessConfig(options.configPath).grants; } catch (error) { grants = []; logFailure(`grants reload failed for ${options.configPath}; every request needs approval`, error); }
          }
          return decide(subject, handle, run, request);
        });
      } catch (error) {
        logFailure("internal error", error);
        return { http_status: 500, body: { ok: false, status: "error", code: "internal-error", detail: "the access facade failed; nothing was issued", ...FIXTURE } };
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
      if (path !== ACCESS_REQUEST_PATH) return send(refusal(404, "not-found", "unknown path"));
      if (request.method !== "POST") return send(refusal(405, "method-not-allowed", "POST only"));
      send(await facade.handle(request.headers, () => readLimited(request)));
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
  const missing = ["FLUME_ACCESS_URL", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "FLUME_RUN_ASSERTION"].filter(name => !env[name]);
  if (missing.length) throw new Error(`Not launched by Flume: missing ${missing.join(", ")} (start this process with \`flume launch\` or \`flume access run\`)`);
  const body: AccessRequest = {
    version: 1, request_id: input.requestId ?? randomUUID(), service: input.service, resource: input.resource, permissions: input.permissions,
    ...(input.lifetimeSeconds !== undefined ? { lifetime_seconds: input.lifetimeSeconds } : {}),
    ...(input.employee !== undefined ? { employee: input.employee } : {}),
  };
  const response = await fetch(`${env.FLUME_ACCESS_URL!.replace(/\/$/u, "")}${ACCESS_REQUEST_PATH}`, {
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
