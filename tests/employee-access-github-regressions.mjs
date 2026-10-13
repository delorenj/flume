// FLUME-50 GitHub credential adapter, through the built `flume` CLI only.
//
// Two doubles stand in for the outside world. A fake Cloudflare Access edge (as in
// FLUME-48) authenticates the employee; a fake GitHub API verifies every app JWT
// with the App's RS256 public key, records every call (who, what, with which kind
// of credential) and can be told to misbehave. The product code is the same in
// fixture and live; only FLUME_GITHUB_API_BASE differs, and with it `evidence`.
// Every key, JWT and token the suite sees is collected and then scanned for in
// everything the facade wrote and every process printed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import YAML from "yaml";
import { SignJWT, decodeJwt, exportJWK, generateKeyPair, importSPKI, jwtVerify } from "jose";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync("/tmp/flume50-");
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const AUD = "aud-fixture-tag";
const NAMES = ["ada", "bob", "cy", "dan", "eli"];
const CLIENT = Object.fromEntries(NAMES.map((n) => [n, `${n}-client-id.access`]));
const SECRET = Object.fromEntries(NAMES.map((n) => [n, `${n}-client-secret-value`]));
const VAULT = "vault-service-token-value";
const SIGNING_REF = "op://DeLoSecrets/flume-launcher/signing-key";
/** Everything secret the suite ever sees; scanned for in every artifact at the end. */
const secrets = new Set([VAULT, ...Object.values(SECRET)]);
const OPERATOR_GH = { GH_TOKEN: "operator-gh-token-canary-value", GITHUB_TOKEN: "operator-github-token-canary-value" };
for (const value of Object.values(OPERATOR_GH)) secrets.add(value);

const launcher = generateKeyPairSync("ed25519");
const launcherPrivate = launcher.privateKey.export({ type: "pkcs8", format: "pem" });
const launcherPublic = launcher.publicKey.export({ type: "spki", format: "pem" });
secrets.add(launcherPrivate.split("\n")[1]);

// -- the GitHub Apps -----------------------------------------------------------------------------
/** A 26-character 1Password item UUID. */
const item = (name) => `${name}${"0".repeat(26)}`.slice(0, 26);
const refFor = (name, field = "privatekeyfield") => `op://DeLoSecrets/${item(name)}/${field}`;
const rsa = (type) => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type, format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const APPS = {
  ada: { id: "1001", slug: "ada-app", client_id: "Iv1.adaclient", installation: "2001", keys: [rsa("pkcs1"), rsa("pkcs8")] },
  bob: { id: "1002", slug: "bob-app", client_id: "Iv1.bobclient", installation: "2002", keys: [rsa("pkcs8"), rsa("pkcs1")] },
};
for (const app of Object.values(APPS)) for (const key of app.keys) {
  const body = key.privateKey.split("\n")[1];
  assert.ok(body.length > 40);
  secrets.add(body);
}

// -- fake GitHub API -----------------------------------------------------------------------------
async function fakeGithub() {
  const apps = new Map();
  for (const [name, app] of Object.entries(APPS)) {
    apps.set(app.id, {
      name, ...app,
      publicKeys: await Promise.all(app.keys.map((key) => importSPKI(key.publicKey, "RS256"))),
      installations: new Map([[app.installation, {
        id: Number(app.installation), account: { login: "o", type: "Organization" }, repository_selection: "selected", suspended_at: null,
        permissions: name === "ada" ? { issues: "write", pull_requests: "write", metadata: "read", contents: "read", repository_projects: "admin" } : { issues: "read", metadata: "read" },
        repos: name === "ada" ? ["sandbox", "other-repo"] : ["sandbox"],
      }]]),
    });
  }
  const gh = { url: "", calls: [], minted: new Map(), revoked: [], jwts: new Set(), clockOffsetMs: 0, sockets: new Set(), ids: 0, apps,
    // Fault injection, reset between scenarios.
    mode: {} };
  gh.reset = () => { gh.mode = {}; };
  const sendJson = (res, status, body, extra = {}) => {
    res.writeHead(status, { "content-type": "application/json", "x-github-request-id": `REQ-${++gh.ids}`, ...extra });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const nowMs = () => Date.now() + gh.clockOffsetMs;
  const tokenFor = (shape) => {
    if (shape === "ghs40") return `ghs_${randomBytes(18).toString("hex")}`;
    if (shape === "other520") return `xyz_${randomBytes(258).toString("hex")}`.slice(0, 520);
    return `ghs_${randomBytes(20).toString("hex")}`;
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://gh");
    const call = { method: req.method, path: url.pathname, query: url.search, body: text ? JSON.parse(text) : undefined, kind: "none", iss: undefined };
    gh.calls.push(call);
    const authorization = String(req.headers.authorization ?? "");
    let app;
    if (/^bearer /iu.test(authorization)) {
      const jwt = authorization.replace(/^bearer /iu, "");
      gh.jwts.add(jwt);
      secrets.add(jwt);
      call.kind = "jwt";
      try {
        const claims = decodeJwt(jwt);
        call.iss = String(claims.iss);
        app = apps.get(call.iss);
        if (!app) throw new Error("unknown app");
        let verified = false;
        for (const key of app.publicKeys) { try { await jwtVerify(jwt, key, { algorithms: ["RS256"] }); verified = true; break; } catch { /* try the next key */ } }
        if (!verified) throw new Error("bad signature");
        if (!claims.exp || !claims.iat) throw new Error("no exp/iat");
      } catch {
        return sendJson(res, 401, { message: "A JSON web token could not be decoded", documentation_url: "https://docs.github.com" });
      }
    } else if (/^token /iu.test(authorization)) {
      call.kind = "token";
      call.token = authorization.replace(/^token /iu, "");
    }
    const match = (pattern) => new RegExp(`^${pattern}$`, "u").exec(call.method === "GET" || call.method === "POST" || call.method === "DELETE" ? `${call.method} ${call.path}` : "");
    const need = () => (app ? true : (sendJson(res, 401, { message: "Requires authentication" }), false));
    let m;
    if (match("GET /app")) {
      if (!need()) return;
      return sendJson(res, 200, { id: Number(app.id), slug: app.slug, name: `${app.name} App`, client_id: app.client_id, owner: { login: "o", type: "Organization" } });
    }
    if (match("GET /app/installations")) {
      if (!need()) return;
      return sendJson(res, 200, [...app.installations.values()].map(({ repos: _repos, ...installation }) => installation));
    }
    if ((m = match("GET /app/installations/(\\d+)"))) {
      if (!need()) return;
      if (gh.mode.installationGet === "500-once" && !gh.mode.installationGetSeen) { gh.mode.installationGetSeen = true; return sendJson(res, 500, { message: "boom" }); }
      if (gh.mode.installationGet === "500") return sendJson(res, 500, { message: "boom" });
      const installation = app.installations.get(m[1]);
      if (!installation) return sendJson(res, 404, { message: "Not Found" });
      const { repos: _repos, ...visible } = installation;
      return sendJson(res, 200, visible);
    }
    if ((m = match("POST /app/installations/(\\d+)/access_tokens"))) {
      if (!need()) return;
      const installation = app.installations.get(m[1]);
      if (!installation) return sendJson(res, 404, { message: "Not Found" });
      if (gh.mode.post === "hang") { gh.sockets.add(res.socket); return; }
      if (gh.mode.redirect) { res.writeHead(307, { location: gh.mode.redirect }); return res.end(); }
      if (gh.mode.post === "500") return sendJson(res, 500, { message: "Server Error" });
      if (gh.mode.post === "403") return sendJson(res, 403, { message: "Resource not accessible by integration" });
      // GitHub matches repository names case-insensitively and answers with the canonical name.
      const canonical = (name) => installation.repos.find((repo) => repo.toLowerCase() === String(name).toLowerCase());
      const requestedNames = call.body.repositories ?? [];
      const missing = requestedNames.filter((name) => !canonical(name));
      const wanted = requestedNames.map(canonical);
      if (missing.length) return sendJson(res, 422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation.\nsecond line", errors: [{ resource: "Repository" }] });
      const requested = call.body.permissions ?? {};
      const token = tokenFor(gh.mode.tokenShape);
      secrets.add(token);
      const expiresMs = Date.now() + (gh.mode.expiresInSeconds ?? 3600) * 1000;
      const returned = gh.mode.post === "extra-perm" ? { ...requested, contents: "write" } : gh.mode.post === "level-up" ? { ...requested, issues: "write", metadata: "read" } : { ...requested, metadata: "read" };
      const repositories = gh.mode.post === "all-repos" ? undefined : gh.mode.post === "two-repos" ? installation.repos.map((name) => ({ id: 1, name, full_name: `o/${name}` })) : wanted.map((name) => ({ id: 1, name, full_name: `o/${name}` }));
      // A malformed 201: no token at all, or an expiry that does not parse.
      if (gh.mode.post === "no-token") return sendJson(res, 201, { expires_at: new Date(expiresMs).toISOString(), permissions: returned, repository_selection: "selected", repositories });
      gh.minted.set(token, { app: app.id, installation: m[1], repos: gh.mode.post === "all-repos" ? installation.repos : wanted, permissions: returned, expiresMs, revoked: false });
      return sendJson(res, 201, { token, expires_at: gh.mode.post === "bad-expiry" ? "not-a-date" : new Date(expiresMs).toISOString(), permissions: returned, repository_selection: gh.mode.post === "all-repos" ? "all" : "selected", ...(repositories ? { repositories } : {}) });
    }
    if (match("DELETE /installation/token")) {
      const entry = gh.minted.get(call.token);
      if (!entry) return sendJson(res, 401, { message: "Bad credentials" });
      if (gh.mode.revoke === "500") return sendJson(res, 500, { message: "revoke failed" });
      entry.revoked = true;
      gh.revoked.push(call.token);
      res.writeHead(204, { "x-github-request-id": `REQ-${++gh.ids}` });
      return res.end();
    }
    if ((m = match("GET /repos/([^/]+)/([^/]+)"))) {
      const entry = gh.minted.get(call.token);
      if (!entry || entry.revoked || entry.expiresMs < nowMs()) return sendJson(res, 401, { message: "Bad credentials" });
      if (m[1] !== "o" || !entry.repos.includes(m[2])) return sendJson(res, 404, { message: "Not Found" });
      return sendJson(res, 200, { full_name: `${m[1]}/${m[2]}`, app: entry.app });
    }
    return sendJson(res, 404, { message: "Not Found" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  gh.url = `http://127.0.0.1:${server.address().port}`;
  gh.close = () => { for (const socket of gh.sockets) socket.destroy(); return new Promise((done) => server.close(done)); };
  gh.mark = () => gh.calls.length;
  gh.since = (mark) => gh.calls.slice(mark);
  gh.posts = (mark = 0) => gh.calls.slice(mark).filter((c) => c.method === "POST");
  return gh;
}

// -- fake Cloudflare Access edge (as FLUME-48) ---------------------------------------------------
async function fakeEdge() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "edge-1", alg: "RS256", use: "sig" };
  const clients = new Map(NAMES.map((name) => [CLIENT[name], SECRET[name]]));
  const edge = { origin: "", url: "", seen: [] };
  edge.mint = async ({ clientId }) => {
    const token = await new SignJWT({ sub: "", type: "app", common_name: clientId }).setProtectedHeader({ alg: "RS256", kid: "edge-1" }).setIssuedAt().setIssuer(edge.url).setAudience(AUD).setExpirationTime("5m").sign(privateKey);
    secrets.add(token);
    return token;
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/cdn-cgi/access/certs") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ keys: [jwk] })); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const id = req.headers["cf-access-client-id"], secret = req.headers["cf-access-client-secret"];
    edge.seen.push({ url: req.url, client: id });
    if (!id || clients.get(id) !== secret) { res.writeHead(403, { "content-type": "application/json" }); return res.end('{"error":"access denied"}'); }
    const headers = { "content-type": "application/json", "cf-access-jwt-assertion": await edge.mint({ clientId: id }) };
    if (req.headers["x-flume-run-assertion"]) headers["x-flume-run-assertion"] = req.headers["x-flume-run-assertion"];
    const upstream = await fetch(`${edge.origin}${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(await upstream.text());
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  edge.url = `http://127.0.0.1:${server.address().port}`;
  edge.close = () => new Promise((done) => server.close(done));
  return edge;
}
const runJwt = async ({ sub }) => {
  const token = await new SignJWT({ harness: "plain" }).setProtectedHeader({ alg: "EdDSA" }).setIssuer("flume-launcher").setAudience("flume-access").setSubject(sub).setIssuedAt().setJti(randomUUID()).setExpirationTime("1h").sign(launcher.privateKey);
  secrets.add(token);
  return token;
};

// -- fixture -------------------------------------------------------------------------------------
const dir = join(work, "fx"), home = join(dir, "home"), fleet = join(home, ".hermes"), registry = join(fleet, "agents-registry.yaml");
const bin = join(dir, "bin"), state = join(dir, "state"), configPath = join(dir, "employee-access.yaml"), opLog = join(dir, "op-reads.log");
for (const p of [fleet, join(home, ".agents/workforce"), join(dir, "repos"), bin]) mkdirSync(p, { recursive: true });
writeFileSync(registry, "schema_version: 1\nagents: {}\n");
writeFileSync(join(bin, "op"), `#!/usr/bin/env node
const fs = require("fs");
if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== ${JSON.stringify(VAULT)}) process.exit(1);
const map = JSON.parse(fs.readFileSync(process.env.OP_FIXTURE, "utf8"));
const [verb, ref] = process.argv.slice(2);
fs.appendFileSync(process.env.OP_LOG, ref + "\\n");
if (verb !== "read" || !(ref in map)) process.exit(2);
process.stdout.write(map[ref]);
`, { mode: 0o755 });
// The consumer: authenticates to GitHub with the token it was handed, records only what it saw, never prints the token.
writeFileSync(join(dir, "consumer.cjs"), `const fs = require("fs");
(async () => {
  const r = await fetch(process.env.FAKE_GH + "/repos/o/sandbox", { headers: { authorization: "token " + process.env.GH_TOKEN } });
  fs.writeFileSync(process.argv[2], JSON.stringify({ status: r.status, same: process.env.GH_TOKEN === process.env.GITHUB_TOKEN && !!process.env.GH_TOKEN, hasCfSecret: "CF_ACCESS_CLIENT_SECRET" in process.env, hasRunAssertion: "FLUME_RUN_ASSERTION" in process.env, hasCfId: "CF_ACCESS_CLIENT_ID" in process.env, grant: process.env.FLUME_GRANT_ID, expires: process.env.FLUME_GRANT_EXPIRES_AT, token: process.env.GH_TOKEN }));
  console.log("consumer-ok:" + r.status);
  process.exit(Number(process.env.CONSUMER_EXIT || 0));
})();
`);

const edge = await fakeEdge();
const gh = await fakeGithub();
const issuer = edge.url;
const opMap = {
  [SIGNING_REF]: launcherPrivate,
  ...Object.fromEntries(NAMES.map((n) => [`op://DeLoSecrets/${n}-access/credential`, SECRET[n]])),
  [refFor("ada")]: APPS.ada.keys[0].privateKey,
  [refFor("ada", "rotatedkeyfield")]: APPS.ada.keys[1].privateKey,
  [refFor("bob")]: APPS.bob.keys[0].privateKey,
  // Ada's reference pointing at BOB's key: signs with the wrong App's key.
  [refFor("adawrong")]: APPS.bob.keys[0].privateKey,
  // A readable value that is not a PEM key.
  [refFor("dannotpem")]: "this-is-not-a-pem-private-key",
};
writeFileSync(join(dir, "op.json"), JSON.stringify(opMap));
const baseEnv = {
  ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
  HERMES_TEMPLATE_CONFIG: join(dir, "no-config"), HERMES_FLEET_ENV: join(dir, "no-env"),
  XDG_STATE_HOME: join(home, ".local/state"), PYTHONDONTWRITEBYTECODE: "1",
  PATH: `${bin}:${process.env.PATH}`, FLUME_ACCESS_CONFIG: configPath, FLUME_ACCESS_STATE: state,
  OP_SERVICE_ACCOUNT_TOKEN: VAULT, OP_FIXTURE: join(dir, "op.json"), OP_LOG: opLog,
  FLUME_GITHUB_API_BASE: gh.url, FLUME_GITHUB_TIMEOUT_MS: "1500", FAKE_GH: gh.url, ...OPERATOR_GH,
};
const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...baseEnv, ...extra }, cwd: dir, encoding: "utf8", timeout: 60000 });
const outputs = [];
/** Needed whenever the child talks to a fake in this process: a sync spawn would deadlock it. */
const runAsync = (args, extra = {}) => new Promise((done) => {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...baseEnv, ...extra }, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => stdout += b);
  child.stderr.on("data", (b) => stderr += b);
  child.on("close", (status) => { outputs.push(stdout, stderr); done({ status, stdout, stderr }); });
});
const json = (r, status = 0) => { assert.equal(r.status, status, r.stdout + r.stderr); outputs.push(r.stdout, r.stderr); return JSON.parse(r.stdout); };
/** Reads of GitHub App private keys only: the launcher also reads Access secrets for every `access run`. */
const opReads = () => (existsSync(opLog) ? readFileSync(opLog, "utf8").split("\n").filter(Boolean) : []).filter((ref) => /\/(privatekeyfield|rotatedkeyfield)$/u.test(ref));

const setBindings = (path, bindings) => {
  const doc = YAML.parseDocument(readFileSync(path, "utf8"));
  doc.setIn(["company_identity", "bindings"], bindings);
  writeFileSync(path, String(doc));
};
const cfBinding = (name) => ({ principal: CLIENT[name], instance: issuer, credential_ref: `op://DeLoSecrets/${name}-access/credential` });
const ghBinding = (name, overrides = {}) => ({ principal: APPS[name].id, instance: APPS[name].installation, credential_ref: refFor(name), attribution_mode: "native", ...overrides });
const roles = {};
const post = (id, person) => {
  const roleDir = join(dir, "repos", id, "agents/hermes/pm");
  mkdirSync(roleDir, { recursive: true });
  const path = join(roleDir, "role.yaml");
  writeFileSync(path, `repo: ${id}\nrole: pm\nagent_id: ${id}\nprofile: ${id}\nidentity:\n  name: ${person}\n  recall_banks:\n    - agent-${id}\n`);
  const doc = YAML.parseDocument(readFileSync(registry, "utf8"));
  doc.setIn(["agents", id], { project_path: join(dir, "repos", id), role_dir: roleDir, profile_name: id, identity: id });
  writeFileSync(registry, String(doc));
  roles[person] = path;
  return path;
};
const subject = {};
for (const name of NAMES) {
  post(`${name}-pm`, name);
  subject[name] = json(run(["identity", "enroll", `${name}-pm`, "--apply", "--json"])).identity.subject;
}
setBindings(roles.ada, { cloudflare_access: cfBinding("ada"), github: ghBinding("ada") });
setBindings(roles.bob, { cloudflare_access: cfBinding("bob"), github: ghBinding("bob") });
setBindings(roles.cy, { cloudflare_access: cfBinding("cy") }); // no github binding
setBindings(roles.dan, { cloudflare_access: cfBinding("dan"), github: ghBinding("ada", { principal: "1003", instance: "2003" }) }); // replaced per scenario
// eli is enrolled but unbound: `identity bind` tests use him.

const gh_ = (name, resource, permissions, max = 3600) => ({ subject: subject[name], service: "github", resource, permissions, max_lifetime_seconds: max });
const grants = () => [
  gh_("ada", "o/sandbox", ["issues:write", "issues:read", "pull_requests:read", "checks:write", "contents:write", "repository_projects:write"]),
  gh_("ada", "O/Sandbox", ["issues:write"]),
  gh_("ada", "other/x", ["issues:write"]),
  gh_("ada", "o/missing", ["issues:write"]),
  gh_("bob", "o/sandbox", ["issues:read"]),
  gh_("cy", "o/sandbox", ["issues:write"]),
  gh_("dan", "o/sandbox", ["issues:write"]),
  { subject: subject.ada, service: "fixture", resource: "repo:alpha", permissions: ["read"], max_lifetime_seconds: 600 },
];
const writeConfig = () => writeFileSync(configPath, YAML.stringify({
  version: 1, url: edge.url, listen: { host: "127.0.0.1", port: 0 }, cloudflare_access: { issuer, audience: AUD },
  launcher: { signing_key_ref: SIGNING_REF, public_key: launcherPublic }, grants: grants(),
}));
writeConfig();

// -- facade process ------------------------------------------------------------------------------
const facadeOutputs = [];
const startFacade = () => new Promise((done, fail) => {
  const child = spawn(process.execPath, [cli, "access", "serve", "--port", "0"], { env: baseEnv, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const out = { child, stdout: "", stderr: "" };
  facadeOutputs.push(out);
  child.stderr.on("data", (b) => out.stderr += b);
  child.stdout.on("data", (b) => {
    out.stdout += b;
    const line = out.stdout.split("\n").find((l) => l.includes('"listening"'));
    if (line) { out.url = JSON.parse(line).url; done(out); }
  });
  child.on("close", (code) => fail(new Error(`facade exited ${code}: ${out.stderr}`)));
  setTimeout(() => fail(new Error("facade did not start")), 20000).unref();
});
let facade = await startFacade();
edge.origin = facade.url;
assert.equal(JSON.parse(facade.stdout.split("\n")[0]).github_api_base, gh.url);

let sequence = 0;
const body = (overrides = {}) => ({ version: 1, request_id: `gh-${String(++sequence).padStart(4, "0")}`, service: "github", resource: "o/sandbox", permissions: ["issues:write"], ...overrides });
const viaEdge = async (name, payload, runAssertion) => {
  const response = await fetch(`${edge.url}/v1/access/requests`, { method: "POST", headers: { "content-type": "application/json", "cf-access-client-id": CLIENT[name], "cf-access-client-secret": SECRET[name], "x-flume-run-assertion": runAssertion }, body: JSON.stringify(payload) });
  const text = await response.text();
  const credential = /"value":"([^"]+)"/u.exec(text);
  if (credential) secrets.add(credential[1]);
  return { status: response.status, body: JSON.parse(text) };
};
const lines = (file) => existsSync(join(state, file)) ? readFileSync(join(state, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const providerLedger = () => lines("provider-ledger.jsonl");
const denied = (r, code, status = 403) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.code, code, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
  assert.equal(r.body.provider, "github");
  assert.equal(r.body.evidence, "fixture", "a local double is never provider evidence");
  assert.equal(r.body.credential, undefined);
};
const idempotency = () => JSON.parse(existsSync(join(state, "idempotency.json")) ? readFileSync(join(state, "idempotency.json"), "utf8") : "{}");
const persisted = (name, requestId) => `${subject[name]}/${requestId}` in idempotency();
const flumeRequest = (name, args, extra = {}) => runAsync(["access", "run", `${name}-pm`, "--", process.execPath, cli, "access", "request", ...args], extra);

try {
  const runs = {};
  for (const name of NAMES) runs[name] = await runJwt({ sub: subject[name] });

  // -- Approved, delivered only to the exec child --------------------------------------------------
  {
    const mark = gh.mark(), receipt = join(dir, "consumer-ada.json");
    const result = await flumeRequest("ada", ["--service", "github", "--resource", "o/sandbox", "--permission", "issues:write", "--request-id", "approved-0001", "--exec", "--", process.execPath, join(dir, "consumer.cjs"), receipt]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "consumer-ok:200", "the consumer authenticated with the token, and stdout is the consumer's alone");
    const consumer = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(consumer.status, 200);
    assert.equal(consumer.same, true, "GH_TOKEN and GITHUB_TOKEN carry the same installation token");
    assert.ok(gh.minted.has(consumer.token), "the consumer holds a token GitHub minted");
    assert.notEqual(consumer.token, OPERATOR_GH.GH_TOKEN, "no operator token reaches the consumer");
    assert.equal(consumer.hasCfSecret, false);
    assert.equal(consumer.hasRunAssertion, false);
    assert.equal(consumer.hasCfId, true);
    const receiptJson = JSON.parse(result.stderr);
    assert.equal(receiptJson.status, "granted");
    assert.equal(receiptJson.subject, subject.ada);
    assert.equal(receiptJson.provider, "github");
    assert.equal(receiptJson.evidence, "fixture");
    assert.equal(receiptJson.app_id, APPS.ada.id);
    assert.equal(receiptJson.installation_id, APPS.ada.installation);
    assert.equal(receiptJson.repository, "o/sandbox");
    assert.equal(receiptJson.repository_selection, "selected");
    assert.deepEqual(receiptJson.permissions, ["issues:write", "metadata:read"]);
    assert.equal(receiptJson.expires_at, new Date(gh.minted.get(consumer.token).expiresMs).toISOString(), "the receipt reports the provider's expiry");
    assert.ok(Math.abs(receiptJson.lifetime_seconds - 3600) <= 2, "lifetime is derived from the provider expiry");
    assert.equal(receiptJson.credential.kind, "github-installation-token");
    assert.equal(receiptJson.credential.value, undefined, "the receipt never carries the token");
    assert.equal(consumer.grant, receiptJson.grant_id);
    assert.equal(consumer.expires, receiptJson.expires_at);
    const traffic = gh.since(mark);
    const posts = traffic.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { repositories: ["sandbox"], permissions: { issues: "write" } }, "exactly one repository and the requested permissions");
    assert.deepEqual([...new Set(traffic.filter((c) => c.kind === "jwt").map((c) => c.iss))], [APPS.ada.id], "only the authenticated employee's own App was used");
    assert.equal(traffic.filter((c) => c.kind === "token" && c.method !== "GET").length, 0);
    const exit = await flumeRequest("ada", ["--service", "github", "--resource", "o/sandbox", "--permission", "issues:write", "--exec", "--", process.execPath, join(dir, "consumer.cjs"), receipt], { CONSUMER_EXIT: "7" });
    assert.equal(exit.status, 7, "the consumer's exit code is the command's");
    const replayReceipt = join(dir, "consumer-replay.json"), postsBefore = gh.posts().length;
    const replayed = await flumeRequest("ada", ["--service", "github", "--resource", "o/sandbox", "--permission", "issues:write", "--request-id", "approved-0001", "--exec", "--", process.execPath, join(dir, "consumer.cjs"), replayReceipt]);
    assert.equal(replayed.status, 1);
    assert.match(JSON.parse(replayed.stdout).error, /only on the first response.*fresh --request-id/u);
    assert.equal(existsSync(replayReceipt), false, "the consumer is not started on a replay");
    assert.equal(gh.posts().length, postsBefore, "a replay never re-mints");
    pass("an approved github request mints one single-repository token with the employee's own App and delivers it only to the exec child");
  }

  // -- Client guard rails --------------------------------------------------------------------------
  {
    const mark = gh.mark(), seen = edge.seen.length, reads = opReads().length;
    const bare = await flumeRequest("ada", ["--service", "github", "--resource", "o/sandbox", "--permission", "issues:write"]);
    assert.notEqual(bare.status, 0);
    assert.match(JSON.parse(bare.stdout).error, /only with --exec/u);
    const fixtureExec = await flumeRequest("ada", ["--service", "fixture", "--resource", "repo:alpha", "--permission", "read", "--exec", "--", "true"]);
    assert.notEqual(fixtureExec.status, 0);
    const strayCommand = await flumeRequest("ada", ["--service", "fixture", "--resource", "repo:alpha", "--permission", "read", "--", "true"]);
    assert.notEqual(strayCommand.status, 0);
    assert.match(JSON.parse(strayCommand.stdout).error, /needs --exec/u);
    const noConsumer = await flumeRequest("ada", ["--service", "github", "--resource", "o/sandbox", "--permission", "issues:write", "--exec"]);
    assert.notEqual(noConsumer.status, 0);
    assert.equal(edge.seen.length, seen, "refused before any request left the client");
    assert.equal(gh.since(mark).length, 0);
    assert.equal(opReads().length, reads);
    // A refused request prints its (token-free) JSON to stdout and exits 1 without starting the consumer.
    const never = join(dir, "never.json");
    const unapproved = await flumeRequest("ada", ["--service", "github", "--resource", "o/not-granted", "--permission", "issues:write", "--exec", "--", process.execPath, join(dir, "consumer.cjs"), never]);
    assert.equal(unapproved.status, 1);
    assert.equal(JSON.parse(unapproved.stdout).status, "approval_required");
    assert.equal(existsSync(never), false, "no consumer without a grant");
    pass("service github without --exec, --exec on another service, and --exec without a consumer are refused before any request; a refusal never starts the consumer");
  }

  // -- Replay ------------------------------------------------------------------------------------
  {
    const mark = gh.mark();
    const original = body({ request_id: "replay-gh-0001" });
    const first = await viaEdge("ada", original, runs.ada);
    assert.equal(first.body.status, "granted");
    assert.equal(first.body.credential.kind, "github-installation-token");
    assert.equal(gh.posts(mark).length, 1);
    const again = await viaEdge("ada", { ...original }, runs.ada);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.grant_id, first.body.grant_id);
    assert.equal(again.body.expires_at, first.body.expires_at);
    assert.equal(again.body.credential, undefined, "a replay never re-discloses the token");
    assert.equal(gh.posts(mark).length, 1, "a replay never re-mints");
    const changed = await viaEdge("ada", { ...original, permissions: ["pull_requests:read"] }, runs.ada);
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, "conflict");
    assert.equal(gh.posts(mark).length, 1);
    pass("an identical replay returns the original grant without a second POST or the token; a changed body is 409");
  }

  // -- Unbound / malformed binding -----------------------------------------------------------------
  {
    const mark = gh.mark(), reads = opReads().length;
    denied(await viaEdge("cy", body(), runs.cy), "no-provider-binding");
    for (const [label, overrides] of [["non-digit app id", { principal: "app-one" }], ["non-digit installation", { instance: "inst" }]]) {
      setBindings(roles.dan, { cloudflare_access: cfBinding("dan"), github: ghBinding("ada", overrides) });
      denied(await viaEdge("dan", body(), runs.dan), "provider-binding-invalid");
    }
    for (const credential_ref of ["op://DeLoSecrets/Some Title/privatekeyfield", `op://DeLoSecrets/${item("ada")}/Github App/private key`]) {
      setBindings(roles.dan, { cloudflare_access: cfBinding("dan"), github: ghBinding("ada", { credential_ref }) });
      denied(await viaEdge("dan", body(), runs.dan), "provider-binding-invalid");
    }
    const { credential_ref: _omitted, ...noRef } = ghBinding("ada");
    setBindings(roles.dan, { cloudflare_access: cfBinding("dan"), github: noRef });
    denied(await viaEdge("dan", body(), runs.dan), "provider-binding-invalid");
    assert.equal(gh.since(mark).length, 0, "no provider call for an unbound or malformed binding");
    assert.equal(opReads().length, reads, "no App key read from the vault");
    pass("a missing or malformed github binding is denied before any vault read or provider call");
  }

  // -- Vault and key failures ---------------------------------------------------------------------
  {
    const mark = gh.mark();
    setBindings(roles.dan, { cloudflare_access: cfBinding("dan"), github: ghBinding("ada", { credential_ref: refFor("danmissing") }) });
    const missing = await viaEdge("dan", body(), runs.dan);
    assert.equal(missing.status, 502);
    assert.equal(missing.body.code, "credential-unavailable");
    assert.equal(missing.body.status, "error");
    setBindings(roles.dan, { cloudflare_access: cfBinding("dan"), github: ghBinding("ada", { credential_ref: refFor("dannotpem") }) });
    denied(await viaEdge("dan", body(), runs.dan), "app-key-invalid");
    assert.equal(gh.since(mark).length, 0, "no provider call when the key is unreadable or unusable");
    pass("an absent vault item is credential-unavailable and a non-PEM value is app-key-invalid, both before any provider call");
  }

  // -- Foreign / mismatch --------------------------------------------------------------------------
  {
    const mark = gh.mark();
    const mismatch = await viaEdge("ada", body({ employee: "bob" }), runs.ada);
    denied(mismatch, "employee-mismatch");
    assert.equal(mismatch.body.status, "denied");
    assert.equal(gh.since(mark).length, 0);
    // Ada's binding pointing at BOB's installation: only ada's App is ever presented, and GitHub says 404.
    setBindings(roles.ada, { cloudflare_access: cfBinding("ada"), github: ghBinding("ada", { instance: APPS.bob.installation }) });
    const foreign = await viaEdge("ada", body(), runs.ada);
    denied(foreign, "installation-mismatch");
    const traffic = gh.since(mark);
    assert.deepEqual([...new Set(traffic.map((c) => c.iss))], [APPS.ada.id], "only A's App iss was seen");
    assert.equal(traffic.filter((c) => c.method === "POST").length, 0);
    // Ada's reference holding BOB's private key: GitHub rejects the JWT, nobody is minted.
    setBindings(roles.ada, { cloudflare_access: cfBinding("ada"), github: ghBinding("ada", { credential_ref: refFor("adawrong") }) });
    const wrongKey = await viaEdge("ada", body(), runs.ada);
    denied(wrongKey, "provider-refused");
    assert.equal(gh.posts(mark).length, 0);
    setBindings(roles.ada, { cloudflare_access: cfBinding("ada"), github: ghBinding("ada") });
    // Bob authenticated as bob uses only bob's App.
    const bobMark = gh.mark();
    const bobGrant = await viaEdge("bob", body({ permissions: ["issues:read"] }), runs.bob);
    assert.equal(bobGrant.body.status, "granted");
    assert.equal(bobGrant.body.app_id, APPS.bob.id);
    assert.deepEqual([...new Set(gh.since(bobMark).filter((c) => c.kind === "jwt").map((c) => c.iss))], [APPS.bob.id]);
    pass("a foreign employee, a foreign installation and a foreign key are refused; only the authenticated employee's own App is ever presented");
  }

  // -- Not installed ---------------------------------------------------------------------------------
  {
    const mark = gh.mark();
    denied(await viaEdge("ada", body({ resource: "other/x" }), runs.ada), "repository-not-installed");
    assert.equal(gh.posts(mark).length, 0, "the owner is checked against the installation account before the POST");
    const refused = body({ resource: "o/missing" });
    const first = await viaEdge("ada", refused, runs.ada);
    denied(first, "provider-refused");
    assert.ok(!first.body.detail.includes("\n"), "only the provider message's first line");
    assert.match(first.body.detail, /does not exist or is not accessible/u);
    assert.equal(gh.posts(mark).length, 1);
    assert.equal(persisted("ada", refused.request_id), false, "a definitive provider refusal is not persisted");
    denied(await viaEdge("ada", refused, runs.ada), "provider-refused");
    assert.equal(gh.posts(mark).length, 2, "so the same id is evaluated again");
    gh.mode.post = "403";
    denied(await viaEdge("ada", body(), runs.ada), "provider-refused");
    gh.reset();
    pass("a repository outside the installation is repository-not-installed or provider-refused; neither mints a token or persists");
  }

  // -- Mixed case ----------------------------------------------------------------------------------
  {
    const mark = gh.mark();
    const r = await viaEdge("ada", body({ resource: "O/Sandbox" }), runs.ada);
    assert.equal(r.body.status, "granted", JSON.stringify(r.body));
    assert.equal(r.body.repository, "O/Sandbox");
    assert.equal(gh.posts(mark).length, 1);
    assert.deepEqual(gh.posts(mark)[0].body.repositories, ["Sandbox"], "the requested name is sent as granted");
    assert.equal(gh.since(mark).filter((c) => c.method === "DELETE").length, 0, "GitHub's canonical casing is not scope drift");
    pass("owner and repository match the installation and the returned token case-insensitively");
  }

  // -- Excess ----------------------------------------------------------------------------------------
  {
    const mark = gh.mark(), reads = opReads().length;
    const beyondGrant = await viaEdge("ada", body({ permissions: ["issues:write", "pull_requests:write"] }), runs.ada);
    assert.equal(beyondGrant.body.status, "approval_required");
    assert.equal(beyondGrant.body.provider, "github");
    assert.equal(beyondGrant.body.credential, undefined);
    const otherRepo = await viaEdge("ada", body({ resource: "o/unapproved" }), runs.ada);
    assert.equal(otherRepo.body.status, "approval_required");
    assert.equal(gh.since(mark).length, 0, "approval_required is decided before any binding read or provider call");
    assert.equal(opReads().length, reads, "approval_required made zero key reads");
    const beyondInstallation = await viaEdge("ada", body({ permissions: ["checks:write"] }), runs.ada);
    denied(beyondInstallation, "excessive-permissions");
    assert.equal(gh.posts(mark).length, 0);
    // The installation holds contents:read, so a granted contents:write is a level above what it has.
    const higherLevel = await viaEdge("ada", body({ permissions: ["contents:write"] }), runs.ada);
    denied(higherLevel, "excessive-permissions");
    assert.equal(gh.posts(mark).length, 0);
    // The installation holds repository_projects:admin, which covers a requested write.
    const adminCovers = await viaEdge("ada", body({ permissions: ["repository_projects:write"] }), runs.ada);
    assert.equal(adminCovers.body.status, "granted", JSON.stringify(adminCovers.body));
    assert.deepEqual(gh.posts(mark)[0].body.permissions, { repository_projects: "write" });
    pass("permissions beyond the grant are approval_required before any binding read; beyond the installation are excessive-permissions before any POST; an installation's admin level covers a write");
  }

  // -- Bad shape -------------------------------------------------------------------------------------
  {
    const mark = gh.mark(), reads = opReads().length, auditBefore = lines("audit.jsonl").length;
    const cases = [
      ["wildcard repo", { resource: "o/*" }, "invalid-resource"], ["bare owner", { resource: "o" }, "invalid-resource"], ["three segments", { resource: "o/a/b" }, "invalid-resource"],
      ["wildcard owner", { resource: "*/sandbox" }, "invalid-resource"], ["dot repo", { resource: "o/.." }, "invalid-resource"],
      ["admin level", { permissions: ["issues:admin"] }, "invalid-permission"], ["no level", { permissions: ["issues"] }, "invalid-permission"],
      ["duplicate name", { permissions: ["issues:read", "issues:write"] }, "invalid-permission"], ["uppercase", { permissions: ["Issues:write"] }, "invalid-permission"],
      ["lifetime set", { lifetime_seconds: 600 }, "lifetime-not-supported"],
    ];
    for (const [label, overrides, code] of cases) {
      const payload = body(overrides);
      denied(await viaEdge("ada", payload, runs.ada), code);
      assert.equal(persisted("ada", payload.request_id), false, `${label} is not persisted`);
    }
    assert.equal(gh.since(mark).length, 0);
    assert.equal(opReads().length, reads);
    assert.ok(lines("audit.jsonl").length > auditBefore, "a denial is still audited");
    pass("wildcards, bare owners, unknown levels and a requested lifetime are denied before the provider and are not persisted");
  }

  // -- Suspended installation ------------------------------------------------------------------------
  {
    const mark = gh.mark();
    gh.apps.get(APPS.ada.id).installations.get(APPS.ada.installation).suspended_at = "2026-10-01T00:00:00Z";
    denied(await viaEdge("ada", body(), runs.ada), "installation-suspended");
    assert.equal(gh.posts(mark).length, 0);
    gh.apps.get(APPS.ada.id).installations.get(APPS.ada.installation).suspended_at = null;
    pass("a suspended installation is denied before the POST");
  }

  // -- Scope and lifetime drift ----------------------------------------------------------------------
  {
    for (const [mode, code, set] of [
      ["all-repos", "provider-scope-mismatch", { post: "all-repos" }], ["two-repos", "provider-scope-mismatch", { post: "two-repos" }],
      ["extra-perm", "provider-scope-mismatch", { post: "extra-perm" }], ["long-expiry", "provider-lifetime-exceeds-grant", { expiresInSeconds: 7200 }],
    ]) {
      const mark = gh.mark();
      gh.mode = { ...set };
      const payload = body();
      const r = await viaEdge("ada", payload, runs.ada);
      denied(r, code);
      assert.equal(gh.posts(mark).length, 1, mode);
      assert.equal(gh.since(mark).filter((c) => c.method === "DELETE").length, 1, `${mode} is revoked`);
      const [token] = [...gh.minted].slice(-1)[0];
      assert.ok(gh.revoked.includes(token), `${mode}: the offending token was revoked`);
      assert.equal(persisted("ada", payload.request_id), false);
      gh.reset();
    }
    // GitHub answers a requested read with write: a higher level than asked is a scope mismatch too.
    {
      const mark = gh.mark();
      gh.mode = { post: "level-up" };
      denied(await viaEdge("ada", body({ permissions: ["issues:read"] }), runs.ada), "provider-scope-mismatch");
      assert.equal(gh.since(mark).filter((c) => c.method === "DELETE").length, 1);
      gh.reset();
    }
    // A redirect from the provider is never followed: the canary sees nothing and no token is granted.
    {
      const seen = [];
      const canary = createServer((req, res) => { seen.push(req.headers); res.writeHead(200); res.end("{}"); });
      await new Promise((done) => canary.listen(0, "127.0.0.1", done));
      gh.mode = { redirect: `http://127.0.0.1:${canary.address().port}/steal` };
      const r = await viaEdge("ada", body(), runs.ada);
      await new Promise((done) => canary.close(done));
      assert.notEqual(r.body.status, "granted");
      assert.equal(r.body.credential, undefined);
      assert.deepEqual(seen, [], "the redirect target never received a request");
      gh.reset();
    }
    // Revoke fails: bounded retries, unverified, residual window, persisted.
    {
      const mark = gh.mark();
      gh.mode = { post: "all-repos", revoke: "500" };
      const payload = body();
      const r = await viaEdge("ada", payload, runs.ada);
      assert.equal(r.status, 502);
      assert.equal(r.body.status, "unverified");
      assert.equal(r.body.code, "revoke-failed");
      assert.equal(r.body.cause, "provider-scope-mismatch");
      assert.ok(!Number.isNaN(Date.parse(r.body.residual_expires_at)));
      assert.equal(r.body.credential, undefined);
      assert.equal(gh.since(mark).filter((c) => c.method === "DELETE").length, 2, "a revoke gets at most 2 attempts");
      assert.equal(gh.posts(mark).length, 1);
      assert.equal(persisted("ada", payload.request_id), true);
      const replay = await viaEdge("ada", payload, runs.ada);
      assert.equal(replay.status, 502);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.status, "unverified");
      assert.equal(gh.posts(mark).length, 1, "a replay of an unrevoked outcome never re-mints");
      gh.reset();
    }
    pass("a token wider or longer-lived than the grant is revoked and denied; a failed revoke stays unverified with its residual window across replays");
  }

  // -- Ambiguous issuance ----------------------------------------------------------------------------
  {
    for (const [label, mode] of [["a 500", "500"], ["a hang", "hang"]]) {
      const mark = gh.mark();
      gh.mode = { post: mode };
      const payload = body();
      const r = await viaEdge("ada", payload, runs.ada);
      assert.equal(r.status, 502, label);
      assert.equal(r.body.status, "unverified");
      assert.equal(r.body.code, "issuance-ambiguous");
      assert.equal(r.body.credential, undefined);
      assert.equal(gh.posts(mark).length, 1, `${label}: exactly one POST`);
      const replay = await viaEdge("ada", payload, runs.ada);
      assert.equal(replay.status, 502);
      assert.equal(replay.body.code, "issuance-ambiguous");
      assert.equal(replay.body.replayed, true);
      assert.equal(gh.posts(mark).length, 1, `${label}: a replay never re-mints`);
      gh.reset();
      const fresh = await viaEdge("ada", body(), runs.ada);
      assert.equal(fresh.body.status, "granted", `${label}: a fresh id mints once`);
      assert.equal(gh.posts(mark).length, 2);
    }
    // The installation check is retried at most twice, then reported without a POST.
    {
      const mark = gh.mark();
      gh.mode = { installationGet: "500-once" };
      assert.equal((await viaEdge("ada", body(), runs.ada)).body.status, "granted");
      assert.equal(gh.since(mark).filter((c) => c.method === "GET").length, 2, "one transient 5xx is retried");
      const failing = gh.mark();
      gh.mode = { installationGet: "500" };
      const r = await viaEdge("ada", body(), runs.ada);
      assert.equal(r.status, 502);
      assert.equal(r.body.code, "provider-unavailable");
      assert.equal(gh.since(failing).filter((c) => c.method === "GET").length, 2, "at most 2 attempts");
      assert.equal(gh.posts(failing).length, 0);
      gh.reset();
    }
    // A malformed 201: no token is ambiguous and persisted; an unparseable expiry is revoked, not a crash.
    {
      const mark = gh.mark();
      gh.mode = { post: "no-token" };
      const payload = body();
      const r = await viaEdge("ada", payload, runs.ada);
      assert.equal(r.status, 502, JSON.stringify(r.body));
      assert.equal(r.body.status, "unverified");
      assert.equal(r.body.code, "issuance-ambiguous");
      assert.equal(r.body.credential, undefined);
      assert.equal(persisted("ada", payload.request_id), true);
      assert.ok(providerLedger().some((l) => l.event === "ambiguous" && l.reason === "no-token" && l.request_id === payload.request_id));
      assert.equal(gh.posts(mark).length, 1);
      const badMark = gh.mark();
      gh.mode = { post: "bad-expiry" };
      const bad = body();
      denied(await viaEdge("ada", bad, runs.ada), "provider-lifetime-exceeds-grant");
      assert.equal(gh.since(badMark).filter((c) => c.method === "DELETE").length, 1, "an unparseable expiry is revoked");
      const [token] = [...gh.minted].slice(-1)[0];
      assert.ok(gh.revoked.includes(token));
      assert.equal(persisted("ada", bad.request_id), false);
      gh.reset();
    }
    pass("a POST 500 or hang is issuance-ambiguous after exactly one POST and persists across replays; the installation check is bounded to two attempts");
  }

  // -- Rotation and expiry -----------------------------------------------------------------------------
  {
    const first = await viaEdge("ada", body(), runs.ada);
    setBindings(roles.ada, { cloudflare_access: cfBinding("ada"), github: ghBinding("ada", { credential_ref: refFor("ada", "rotatedkeyfield") }) });
    const mark = gh.mark(), reads = opReads().length;
    const rotated = await viaEdge("ada", body(), runs.ada);
    assert.equal(rotated.body.status, "granted");
    assert.ok(opReads().slice(reads).every((ref) => ref === refFor("ada", "rotatedkeyfield")), "the new key reference is the only one read");
    assert.equal(rotated.body.app_id, APPS.ada.id);
    assert.equal(rotated.body.installation_id, APPS.ada.installation);
    assert.equal(rotated.body.repository, "o/sandbox");
    for (const field of ["app_id", "installation_id", "repository"]) assert.equal(rotated.body[field], first.body[field], field);
    assert.equal(rotated.body.subject, subject.ada);
    assert.ok(gh.posts(mark).length === 1 && gh.since(mark).filter((c) => c.method === "GET").length === 1, "bounded attempts");
    // After the old token expires, a new request replaces it with the same identity.
    gh.clockOffsetMs = 2 * 3600 * 1000;
    const stale = await fetch(`${gh.url}/repos/o/sandbox`, { headers: { authorization: `token ${first.body.credential.value}` } });
    assert.equal(stale.status, 401, "the expired token no longer authenticates");
    const replacement = await viaEdge("ada", body(), runs.ada);
    assert.equal(replacement.body.status, "granted");
    assert.notEqual(replacement.body.credential.value, first.body.credential.value);
    for (const field of ["subject", "app_id", "installation_id"]) assert.equal(replacement.body[field], first.body[field], field);
    gh.clockOffsetMs = 0;
    setBindings(roles.ada, { cloudflare_access: cfBinding("ada"), github: ghBinding("ada") });
    pass("rotating the key reference or re-requesting after expiry keeps subject, app_id and installation_id and stays within bounded attempts");
  }

  // -- Token shapes ----------------------------------------------------------------------------------
  {
    for (const [shape, length] of [["ghs40", 40], ["other520", 520]]) {
      gh.mode = { tokenShape: shape };
      const receipt = join(dir, `shape-${shape}.json`);
      const r = await flumeRequest("ada", ["--service", "github", "--resource", "o/sandbox", "--permission", "issues:write", "--exec", "--", process.execPath, join(dir, "consumer.cjs"), receipt]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const consumer = JSON.parse(readFileSync(receipt, "utf8"));
      assert.equal(consumer.token.length, length);
      assert.equal(consumer.status, 200, `${shape} is usable`);
      gh.reset();
    }
    pass("a 40-character ghs_ token and a 520-character other-prefix token are both granted and usable");
  }

  // -- Fixture service is unchanged ------------------------------------------------------------------
  {
    const mark = gh.mark();
    const r = await viaEdge("ada", { version: 1, request_id: "fixture-gh-0001", service: "fixture", resource: "repo:alpha", permissions: ["read"] }, runs.ada);
    assert.equal(r.body.status, "granted");
    assert.equal(r.body.provider, "fixture");
    assert.equal(r.body.credential.kind, "fixture-bearer");
    secrets.add(r.body.credential.value);
    assert.equal(gh.since(mark).length, 0);
    const printed = await flumeRequest("ada", ["--service", "fixture", "--resource", "repo:alpha", "--permission", "read", "--request-id", "fixture-gh-0002"]);
    assert.equal(printed.status, 0);
    assert.match(JSON.parse(printed.stdout).credential.value, /^fixture-/u, "only a fixture-bearer credential is printed");
    pass("other services keep the existing fixture path and still print their fixture bearer");
  }

  // -- identity bind ---------------------------------------------------------------------------------
  {
    const definition = readFileSync(roles.eli, "utf8");
    const bindArgs = ({ principal = "1003", instance = "2003", ref = refFor("eli"), mode } = {}) => ["identity", "bind", "eli-pm", "github", "--principal", principal, "--instance", instance, "--credential-ref", ref, ...(mode ? ["--attribution-mode", mode] : []), "--json"];
    const base = bindArgs();
    const preview = json(run(base));
    assert.equal(preview.ok, true);
    assert.equal(preview.changed, true);
    assert.equal(preview.apply, false);
    assert.equal(readFileSync(roles.eli, "utf8"), definition, "a preview writes nothing");
    const invalid = [
      ["a title instead of an item UUID", { ref: "op://DeLoSecrets/Eli GitHub App/privatekeyfield" }, "invalid-credential-ref"],
      ["a section-qualified path", { ref: `op://DeLoSecrets/${item("eli")}/Github App/private key` }, "invalid-credential-ref"],
      ["a short item id", { ref: "op://DeLoSecrets/abc123/privatekeyfield" }, "invalid-credential-ref"],
      ["a non-digit principal", { principal: "one" }, "invalid-binding"],
      ["a non-digit instance", { instance: "two" }, "invalid-binding"],
      ["an unknown attribution mode", { mode: "borrowed" }, "invalid-binding"],
    ];
    for (const [label, override, code] of invalid) {
      const result = json(run(bindArgs(override)), 1);
      assert.ok(result.blockers.some((b) => b.code === code), label);
      assert.equal(readFileSync(roles.eli, "utf8"), definition, `${label} writes nothing`);
    }
    const plain = json(run(["identity", "bind", "eli-pm", "plane", "--principal", "u1", "--credential-ref", "not-an-op-ref", "--json"]), 1);
    assert.ok(plain.blockers.some((b) => b.code === "invalid-credential-ref"), "a non-github credential_ref must still be op://");
    const missingInstance = json(run(["identity", "bind", "eli-pm", "github", "--principal", "1003", "--credential-ref", refFor("eli"), "--json"]), 1);
    assert.ok(missingInstance.blockers.length);
    const notEnrolled = json(run(["identity", "bind", "nobody-pm", "github", "--principal", "1", "--instance", "2", "--credential-ref", refFor("eli"), "--json"]), 1);
    assert.equal(notEnrolled.ok, false);
    const applied = json(run([...base, "--apply"]));
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.binding, { principal: "1003", instance: "2003", credential_ref: refFor("eli") });
    const shown = json(run(["identity", "show", "eli-pm", "--json"]));
    assert.equal(shown.identity.bindings.github.principal, "1003");
    assert.equal(json(run([...base, "--apply"])).changed, false, "binding the same thing again is a no-op");
    const conflict = json(run(["identity", "bind", "eli-pm", "github", "--principal", "1004", "--instance", "2004", "--credential-ref", refFor("eli"), "--apply", "--json"]), 1);
    assert.ok(conflict.blockers.some((b) => b.code === "binding-conflict"), "rotation is deliberate, never a side effect");
    const duplicate = json(run(["identity", "bind", "cy-pm", "github", "--principal", APPS.ada.id, "--instance", APPS.ada.installation, "--credential-ref", refFor("ada"), "--json"]), 1);
    assert.ok(duplicate.blockers.some((b) => b.code === "binding-duplicate"), "an App installation belongs to one employee");
    const native = json(run(["identity", "bind", "cy-pm", "github", "--principal", "1099", "--instance", "2099", "--credential-ref", refFor("cy"), "--attribution-mode", "shared_bot_attributed", "--json"]));
    assert.equal(native.binding.attribution_mode, "shared_bot_attributed");
    pass("identity bind previews by default, refuses titles, section paths and non-digit IDs, reuses the binding blockers, and writes by reference only");
  }

  // -- github-inspect ----------------------------------------------------------------------------------
  {
    const mark = gh.mark();
    const report = json(await runAsync(["access", "github-inspect", "--employee", "ada-pm", "--json"]).then((r) => r));
    assert.equal(report.ok, true);
    assert.equal(report.app.id, 1001);
    assert.equal(report.app.slug, "ada-app");
    assert.equal(report.app.client_id, "Iv1.adaclient");
    assert.equal(report.app.owner.login, "o");
    assert.equal(report.bot_login, "ada-app[bot]");
    assert.equal(report.evidence, "fixture");
    assert.ok(!Number.isNaN(Date.parse(report.observed_at)));
    assert.equal(report.installations.length, 1);
    assert.deepEqual(report.installations[0], { id: 2001, account: "o", account_type: "Organization", repository_selection: "selected", permissions: { issues: "write", pull_requests: "write", metadata: "read", contents: "read", repository_projects: "admin" }, suspended: false, suspended_at: null });
    const traffic = gh.since(mark);
    assert.deepEqual(traffic.map((c) => `${c.method} ${c.path}`), ["GET /app", "GET /app/installations"], "app-JWT GETs only");
    assert.ok(traffic.every((c) => c.kind === "jwt" && c.iss === APPS.ada.id));
    const explicit = await runAsync(["access", "github-inspect", "--app-id", APPS.bob.id, "--key-ref", refFor("bob")]);
    assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
    assert.match(explicit.stdout, /bob-app\[bot\]/u);
    assert.match(explicit.stdout, /installation 2002: o \(selected\)/u);
    const wrong = await runAsync(["access", "github-inspect", "--app-id", APPS.ada.id, "--key-ref", refFor("adawrong"), "--json"]);
    assert.equal(wrong.status, 1);
    assert.equal(JSON.parse(wrong.stdout).ok, false);
    assert.ok(!wrong.stdout.includes("BEGIN"), "no key material in output");
    for (const args of [["--employee", "cy-pm"], ["--app-id", APPS.ada.id], ["--employee", "ada-pm", "--app-id", APPS.ada.id, "--key-ref", refFor("ada")]]) {
      const bad = await runAsync(["access", "github-inspect", ...args, "--json"]);
      assert.equal(bad.status, 1, args.join(" "));
    }
    assert.equal(gh.since(mark).filter((c) => c.method !== "GET").length, 0, "inspect never mints, writes or revokes");
    pass("github-inspect reads the App and its installations with app-JWT GETs only and never mints");
  }

  // -- Evidence --------------------------------------------------------------------------------------
  {
    const absent = refFor("evidenceabsent");
    for (const [base, evidence] of [["https://api.github.com", "provider"], ["https://api.github.com/", "provider"], [gh.url, "fixture"]]) {
      const r = await runAsync(["access", "github-inspect", "--app-id", "1", "--key-ref", absent, "--json"], { FLUME_GITHUB_API_BASE: base });
      assert.equal(r.status, 1);
      const report = JSON.parse(r.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.evidence, evidence, base);
    }
    pass("evidence is provider only against the real API base (with or without a trailing slash), fixture otherwise");
  }

  // -- Readiness -------------------------------------------------------------------------------------
  {
    const report = json(run(["identity", "readiness", "--json"], { CLOUDFLARE_API_TOKEN: "" }));
    assert.equal(report.checks.github_sandbox_installation.status, "unproven");
    assert.equal(report.checks.github_sandbox_installation.ready, false);
    assert.equal(report.checks.github_sandbox_installation.cost, null);
    pass("readiness reports github_sandbox_installation as unproven");
  }

  // -- No operator or foreign credential was ever presented ------------------------------------------
  {
    for (const call of gh.calls) {
      if (call.kind === "token") assert.ok(gh.minted.has(call.token), "only a token GitHub minted was ever presented");
      assert.ok(call.kind !== "none", "every call was authenticated by a JWT or a minted token");
    }
    assert.ok(![...gh.calls].some((c) => c.token === OPERATOR_GH.GH_TOKEN || c.token === OPERATOR_GH.GITHUB_TOKEN), "no PAT or GH_TOKEN fallback");
    pass("GitHub only ever saw app JWTs and minted installation tokens: no PAT, GH_TOKEN or GITHUB_TOKEN fallback");
  }

  // -- No secret at rest, in logs or in output -------------------------------------------------------
  {
    const files = readdirSync(state).sort();
    assert.deepEqual(files, ["audit.jsonl", "fixture-ledger.jsonl", "idempotency.json", "provider-ledger.jsonl"]);
    for (const file of files) assert.equal(statSync(join(state, file)).mode & 0o777, 0o600, `${file} is private`);
    const haystack = [
      ...files.map((file) => readFileSync(join(state, file), "utf8")),
      ...facadeOutputs.flatMap((out) => [out.stdout, out.stderr]), ...outputs,
      readFileSync(configPath, "utf8"), readFileSync(registry, "utf8"), ...Object.values(roles).map((path) => readFileSync(path, "utf8")),
    ];
    assert.ok(secrets.size > 30, `the scan covers ${secrets.size} secrets`);
    assert.ok(gh.jwts.size >= 10 && gh.minted.size >= 10);
    for (const secret of secrets) {
      assert.ok(secret.length > 8);
      for (const text of haystack) assert.ok(!text.includes(secret), `a secret leaked: ${secret.slice(0, 12)}...`);
    }
    for (const text of haystack) assert.ok(!/BEGIN (RSA )?PRIVATE KEY/u.test(text), "no PEM header anywhere");
    const ledger = providerLedger();
    const allowed = new Set(["at", "provider", "event", "grant_id", "subject", "run_id", "request_id", "app_id", "installation_id", "repository", "permissions", "expires_at", "repository_selection", "http_status", "github_request_id", "reason", "attempt"]);
    for (const entry of ledger) {
      for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `ledger key ${key}`);
      assert.equal(entry.provider, "github");
    }
    for (const event of ["attempt", "issued", "refused", "ambiguous", "revoked", "revoke-failed"]) assert.ok(ledger.some((l) => l.event === event), `ledger has ${event}`);
    assert.ok(ledger.filter((l) => l.event === "issued").every((l) => l.github_request_id && l.expires_at && l.http_status === 201 && l.app_id && l.installation_id));
    const audit = lines("audit.jsonl");
    assert.ok(audit.some((l) => l.outcome === "granted" && l.service === "github" && l.grant_id && l.expires_at));
    assert.ok(audit.some((l) => l.outcome === "issuance-ambiguous"));
    for (const entry of ledger.filter((l) => l.event === "issued")) assert.ok(JSON.stringify(entry).length < 600);
    pass("audit, idempotency, both ledgers, facade output, every process's output and the definitions hold no token, private key, app JWT or secret");
  }

  console.log(`\n${count} github credential check groups passed`);
} finally {
  facade.child.removeAllListeners("close");
  facade.child.kill("SIGTERM");
  await edge.close();
  await gh.close();
  rmSync(work, { recursive: true, force: true });
}
