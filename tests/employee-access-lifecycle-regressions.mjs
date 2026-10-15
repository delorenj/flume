// FLUME-53 facade, mail and receipts, through the built `flume` CLI only.
//
// A fake Cloudflare Access edge authenticates the employee and proxies to an in-test WORKER DOUBLE that mirrors
// agents-facade/src/index.ts (POST /v1/mail/messages: bounded closed body, the origin's /v1/mail/authorize decides identity
// and status, the KV allowlist must still hold the address, then only mail/<handle>/ of the authenticated handle is read) over an
// in-memory mailbox. The facade under test is the real `flume access serve`. A fake hermes, op and Cloudflare complete it.
// Every secret planted is scanned for in every state file, receipt and output at the end.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import YAML from "yaml";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { addSetSkills, createSet } from "@delorenj/skillex";
import { fakeCloudflare, writeFakeGateway, writeFakeOp } from "./lifecycle-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync("/tmp/flume53b-");
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

const AUD = "aud-fixture-tag";
const ISSUER_CF = "https://fixture.cloudflareaccess.com";
const CLIENT = { ada: "ada-client-id.access", bob: "bob-client-id.access" };
const SECRET = { ada: "ada-client-secret-value", bob: "bob-client-secret-value" };
const VAULT = "vault-service-token-value";
const GATEWAY = "ada-gateway-key-value";
const CF_TOKEN = "fixture-cloudflare-provisioning-token-secret";
const TOKEN_REF = "op://DeLoSecrets/Cloudflare/provisioning-token";
const SIGNING_REF = "op://DeLoSecrets/flume-launcher/signing-key";
const HERMES_REF = "op://DeLoSecrets/hermes-ada/credential";
const ACCOUNT = "a".repeat(32), ZONE = "b".repeat(32), KVNS = "c".repeat(32);
const MAIL_CODE = "mail-body-one-time-code-424242";
const secrets = new Set([VAULT, GATEWAY, CF_TOKEN, MAIL_CODE, ...Object.values(SECRET)]);

const launcher = generateKeyPairSync("ed25519");
const launcherPrivate = launcher.privateKey.export({ type: "pkcs8", format: "pem" });
const launcherPublic = launcher.publicKey.export({ type: "spki", format: "pem" });
secrets.add(launcherPrivate.split("\n")[1]);

const sha = (text) => createHash("sha256").update(text).digest("hex");
const mailbox = {
  ada: ["one", "two"].map((n) => { const raw = `Subject: ada ${n}\r\n\r\nyour code is ${MAIL_CODE}-${n}`; return { id: sha(raw), raw, from: "sender@example.test", subject: `ada ${n}` }; }),
  bob: [{ id: sha("bob secret mail"), raw: "Subject: bob\r\n\r\nbob secret mail", from: "sender@example.test", subject: "bob" }],
};

// -- fake Cloudflare Access edge, proxying to the Worker double -------------------------------------------------------
async function fakeEdge() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "edge-1", alg: "RS256", use: "sig" };
  const clients = new Map(Object.keys(CLIENT).map((name) => [CLIENT[name], SECRET[name]]));
  const edge = { origin: "", url: "" };
  edge.mint = async ({ clientId }) => {
    const token = await new SignJWT({ sub: "", type: "app", ...(clientId ? { common_name: clientId } : {}) }).setProtectedHeader({ alg: "RS256", kid: "edge-1" }).setIssuedAt().setIssuer(edge.url).setAudience(AUD).setExpirationTime("5m").sign(privateKey);
    secrets.add(token);
    return token;
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/cdn-cgi/access/certs") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ keys: [jwk] })); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const id = req.headers["cf-access-client-id"], secret = req.headers["cf-access-client-secret"];
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

// -- the Worker double: agents-facade/src/index.ts readMail, over memory -----------------------------------------------
const MESSAGE_ID = /^[0-9a-f]{64}$/u, HANDLE = /^[a-z0-9][a-z0-9_-]{0,57}$/u;
async function fakeWorker(cfUrl) {
  const worker = { url: "", facade: "", storageReads: 0, authorizeCalls: 0 };
  const json = (status, body, res) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  const refusal = (res, status, code, detail) => json(status, { ok: false, status: "error", code, detail }, res);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://worker");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const forward = { ...req.headers }; delete forward.host; delete forward["content-length"]; delete forward.connection; delete forward["transfer-encoding"];
    if (url.pathname === "/v1/access/requests") {
      if (req.method !== "POST") return refusal(res, 405, "method-not-allowed", "POST only");
      if (!req.headers["cf-access-jwt-assertion"]) return refusal(res, 401, "missing-assertion", "no assertion");
      const upstream = await fetch(`${worker.facade}${url.pathname}`, { method: "POST", headers: forward, body: text });
      res.writeHead(upstream.status, { "content-type": "application/json" }); return res.end(await upstream.text());
    }
    if (url.pathname !== "/v1/mail/messages") return refusal(res, 404, "not-found", "unknown path");
    if (req.method !== "POST") return refusal(res, 405, "method-not-allowed", "POST only");
    if (!req.headers["cf-access-jwt-assertion"]) return refusal(res, 401, "missing-assertion", "no Cloudflare Access assertion; mail is readable only through Access");
    if (Buffer.byteLength(text) > 1024) return refusal(res, 413, "request-too-large", "mail request body exceeds the limit");
    let parsed;
    try { parsed = JSON.parse(text); } catch { return refusal(res, 400, "invalid-request", "body must be JSON"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refusal(res, 400, "invalid-request", "body must be an object");
    const extra = Object.keys(parsed).filter((k) => k !== "operation" && k !== "message_id");
    if (extra.length) return refusal(res, 400, "invalid-request", `unknown field: ${extra[0]}`);
    if (parsed.operation !== "list" && parsed.operation !== "read") return refusal(res, 400, "invalid-request", "operation must be list or read");
    if (parsed.operation === "read" && !(typeof parsed.message_id === "string" && MESSAGE_ID.test(parsed.message_id))) return refusal(res, 400, "invalid-request", "read requires message_id: a 64-hex content hash");
    if (parsed.operation === "list" && parsed.message_id !== undefined) return refusal(res, 400, "invalid-request", "list takes no message_id");
    worker.authorizeCalls++;
    const authorize = await fetch(`${worker.facade}/v1/mail/authorize`, { method: "POST", headers: forward, body: text });
    let auth;
    try { auth = await authorize.json(); } catch { return refusal(res, 502, "bad-origin-response", `the access facade answered HTTP ${authorize.status} without JSON`); }
    if (authorize.status !== 200 || auth.status !== "authorized") return json(authorize.status === 200 ? 403 : authorize.status, auth, res);
    const handle = auth.handle;
    if (typeof handle !== "string" || !HANDLE.test(handle)) return refusal(res, 502, "bad-origin-response", "the access facade returned no valid handle");
    const key = await fetch(`${cfUrl}/accounts/${ACCOUNT}/storage/kv/namespaces/${KVNS}/values/${encodeURIComponent(`allowlist/${handle}@agents.delo.sh`)}`, { headers: { authorization: `Bearer ${CF_TOKEN}` } });
    if (key.status !== 200) return json(403, { ok: false, status: "denied", code: "mailbox-closed", detail: "the mailbox allowlist entry is absent; the mailbox is closed to reads until the employee is restored" }, res);
    worker.storageReads++;
    const own = mailbox[handle] ?? [];
    const correlation = { handle, subject: auth.subject ?? null, run_id: auth.run_id ?? null, harness: auth.harness ?? null };
    if (parsed.operation === "list") return json(200, { ok: true, status: "listed", ...correlation, count: own.length, messages: own.map((m) => ({ id: m.id, size: m.raw.length, received_at: "2026-10-14T00:00:00.000Z", from: m.from, subject: m.subject })) }, res);
    const found = own.find((m) => m.id === parsed.message_id);
    if (!found) return json(404, { ok: false, status: "error", code: "message-not-found", detail: "no such message in this mailbox" }, res);
    return json(200, { ok: true, status: "read", ...correlation, id: found.id, size: found.raw.length, from: found.from, subject: found.subject, raw: found.raw }, res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  worker.url = `http://127.0.0.1:${server.address().port}`;
  worker.close = () => new Promise((done) => server.close(done));
  return worker;
}

const runJwt = async ({ sub, jti = randomUUID(), harness = "plain", exp = "1h" }) => {
  const token = await new SignJWT({ harness }).setProtectedHeader({ alg: "EdDSA" }).setIssuer("flume-launcher").setAudience("flume-access").setSubject(sub).setIssuedAt().setJti(jti).setExpirationTime(exp).sign(launcher.privateKey);
  secrets.add(token);
  return token;
};

// -- fixture ------------------------------------------------------------------------------------------------------------
const dir = join(work, "fx"), home = join(dir, "home"), fleet = join(home, ".hermes"), registry = join(fleet, "agents-registry.yaml");
const bin = join(dir, "bin"), state = join(dir, "state/access"), idState = join(dir, "state/identity"), catalog = join(dir, "skillex"), configPath = join(dir, "employee-access.yaml");
for (const p of [fleet, join(home, ".agents/workforce"), join(dir, "repos"), bin]) mkdirSync(p, { recursive: true });
writeFileSync(registry, "schema_version: 1\nagents: {}\n");
writeFakeOp(join(bin, "op"), VAULT);
writeFakeGateway(join(bin, "gateway-tokens.py"));
// A fake hermes: it asks for access and lists mail as the launched process, and records only what it saw.
writeFileSync(join(bin, "hermes"), `#!/usr/bin/env node
const fs = require("fs"), cp = require("child_process");
const call = (args) => cp.spawnSync(process.execPath, [process.env.FIXTURE_CLI, ...args], { env: process.env, encoding: "utf8" });
const request = call(["access", "request", "--service", "fixture", "--resource", "repo:alpha", "--permission", "read", "--request-id", process.env.FIXTURE_REQUEST_ID || "hermes-request-0001"]);
const mail = call(["mail", "list"]);
fs.writeFileSync(process.env.LAUNCH_RECEIPT, JSON.stringify({ args: process.argv.slice(2), creds: { id: process.env.CF_ACCESS_CLIENT_ID, secret: process.env.CF_ACCESS_CLIENT_SECRET, run: process.env.FLUME_RUN_ASSERTION, run_id: process.env.FLUME_RUN_ID }, request: { status: request.status }, mail: { status: mail.status, stdout: mail.stdout } }));
process.exit(0);
`, { mode: 0o755 });
writeFileSync(join(dir, "plain.cjs"), `const fs = require("fs"), cp = require("child_process");
const call = (args) => cp.spawnSync(process.execPath, [process.env.FIXTURE_CLI, ...args], { env: process.env, encoding: "utf8" });
const request = call(["access", "request", "--service", "fixture", "--resource", "repo:alpha", "--permission", "read", "--request-id", "plain-request-0001"]);
const mail = call(["mail", "list"]);
fs.writeFileSync(process.env.PLAIN_RECEIPT, JSON.stringify({ creds: { id: process.env.CF_ACCESS_CLIENT_ID, secret: process.env.CF_ACCESS_CLIENT_SECRET, run: process.env.FLUME_RUN_ASSERTION, run_id: process.env.FLUME_RUN_ID }, request: { status: request.status }, mail: { status: mail.status, stdout: mail.stdout } }));
`);

const edge = await fakeEdge();
const cf = await fakeCloudflare({ account: ACCOUNT, zone: ZONE, kvns: KVNS, token: CF_TOKEN, issuer: ISSUER_CF });
const worker = await fakeWorker(cf.url);
edge.origin = worker.url;
const issuer = edge.url;
writeFileSync(join(dir, "op.json"), JSON.stringify({
  [SIGNING_REF]: launcherPrivate, [HERMES_REF]: GATEWAY, [TOKEN_REF]: CF_TOKEN,
  "op://DeLoSecrets/ada-access/credential": SECRET.ada, "op://DeLoSecrets/bob-access/credential": SECRET.bob,
}));
const provisioning = join(dir, "identity-provisioning.yaml");
writeFileSync(provisioning, YAML.stringify({ version: 1, cloudflare: { api_token_ref: TOKEN_REF, account_id: ACCOUNT, zone_id: ZONE, access_issuer: ISSUER_CF }, mailbox: { worker: "agents-facade", kv_namespace_id: KVNS }, onepassword: { vault: "DeLoSecrets" } }));
const baseEnv = {
  ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
  HERMES_TEMPLATE_CONFIG: join(dir, "no-config"), HERMES_FLEET_ENV: join(dir, "no-env"), HERMES_FLEET_BIN: join(bin, "hermes"),
  XDG_STATE_HOME: join(home, ".local/state"), PJ_SKILLS_REGISTRY_ROOT: catalog, PYTHONDONTWRITEBYTECODE: "1",
  PATH: `${bin}:${process.env.PATH}`, FLUME_ACCESS_CONFIG: configPath, FLUME_ACCESS_STATE: state, FLUME_IDENTITY_STATE: idState,
  FLUME_PROVISION_CONFIG: provisioning, FLUME_CLOUDFLARE_API_BASE: cf.url, FLUME_GATEWAY_TOKENS_BIN: join(bin, "gateway-tokens.py"), FLUME_GATEWAY_EVIDENCE: join(dir, "no-flume-39-evidence"),
  GW_STATE: join(dir, "gw-state.json"), GW_LOG: join(dir, "gw-log.jsonl"), FLUME_PX_BIN: join(dir, "no-such-px"),
  OP_SERVICE_ACCOUNT_TOKEN: VAULT, OP_FIXTURE: join(dir, "op.json"), FIXTURE_CLI: cli, LAUNCH_RECEIPT: join(dir, "launch.json"), PLAIN_RECEIPT: join(dir, "plain.json"),
  CLOUDFLARE_API_TOKEN: "",
};
delete baseEnv.CF_ACCESS_CLIENT_ID; delete baseEnv.CF_ACCESS_CLIENT_SECRET; delete baseEnv.FLUME_RUN_ASSERTION; delete baseEnv.FLUME_ACCESS_URL;
const outputs = [];
const runAsync = (args, extra = {}, envBase = baseEnv) => new Promise((done) => {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...envBase, ...extra }, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => stdout += b);
  child.stderr.on("data", (b) => stderr += b);
  child.on("close", (status) => { outputs.push(stdout, stderr); done({ status, stdout, stderr }); });
});
const run = (args, extra = {}) => { const r = spawnSync(process.execPath, [cli, ...args], { env: { ...baseEnv, ...extra }, cwd: dir, encoding: "utf8", timeout: 60000 }); outputs.push(r.stdout, r.stderr); return r; };
const json = (r, status = 0) => { assert.equal(r.status, status, r.stdout + r.stderr); return JSON.parse(r.stdout); };

mkdirSync(join(catalog, "all-skills/alpha"), { recursive: true });
writeFileSync(join(catalog, "all-skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: fixture alpha\n---\n");
const skillex = { registryRoot: catalog, home, stateHome: baseEnv.XDG_STATE_HOME };
assert.ok((await createSet("first", skillex)).ok);
assert.ok((await addSetSkills("first", ["alpha"], skillex)).ok);
writeFileSync(join(fleet, "config.yaml"), YAML.stringify({ model: { provider: "automaticai", default: "automaticai/personal/sol" }, memory: { provider: "hindsight" } }));

const binding = (name) => ({ cloudflare_access: { principal: CLIENT[name], instance: issuer, credential_ref: `op://DeLoSecrets/${name}-access/credential` } });
const setBinding = (path, bindings) => { const doc = YAML.parseDocument(readFileSync(path, "utf8")); doc.setIn(["company_identity", "bindings"], bindings); writeFileSync(path, String(doc)); };
const source = join(dir, "ada.yaml");
writeFileSync(source, YAML.stringify({ schema_version: 1, id: "ada", display_name: "Ada", role: "infra", charter: { purpose: "Keep infra boring" }, skills: { set: "first" }, memory: { write_bank: "agent-ada", recall_banks: ["infra"] } }));
json(run(["hire", "--definition", source, "--json"]));
const adaDesk = join(home, ".agents/workforce/ada/agent.yaml");
const bobRoleDir = join(dir, "repos/bob-pm/agents/hermes/pm");
mkdirSync(bobRoleDir, { recursive: true });
const bobRole = join(bobRoleDir, "role.yaml");
writeFileSync(bobRole, "repo: bob-pm\nrole: pm\nagent_id: bob-pm\nprofile: bob-pm\nidentity:\n  name: bob\n  recall_banks:\n    - agent-bob-pm\n");
{ const doc = YAML.parseDocument(readFileSync(registry, "utf8")); doc.setIn(["agents", "bob-pm"], { project_path: join(dir, "repos/bob-pm"), role_dir: bobRoleDir, profile_name: "bob-pm", identity: "bob-pm" }); writeFileSync(registry, String(doc)); }
const subject = {};
for (const [name, id] of [["ada", "ada"], ["bob", "bob-pm"]]) subject[name] = json(run(["identity", "enroll", id, "--apply", "--json"])).identity.subject;
setBinding(adaDesk, binding("ada"));
setBinding(bobRole, binding("bob"));
json(run(["onboard", "--employee", "ada", "--json"]));
assert.ok(json(run(["audit", "--employee", "ada", "--json"])).ok);

const writeConfig = () => writeFileSync(configPath, YAML.stringify({
  version: 1, url: edge.url, listen: { host: "127.0.0.1", port: 0 }, cloudflare_access: { issuer, audience: AUD },
  launcher: { signing_key_ref: SIGNING_REF, public_key: launcherPublic },
  grants: [{ subject: subject.ada, service: "fixture", resource: "repo:alpha", permissions: ["read"], max_lifetime_seconds: 3600 }],
}));
writeConfig();

// The provider side of the mailbox: allowlist keys, the Access token and the routing rule.
for (const name of ["ada", "bob"]) {
  cf.kv.set(`allowlist/${name}@agents.delo.sh`, { handle: name, subject: subject[name], provisioned_at: "2026-10-01T00:00:00.000Z" });
}
cf.tokens.push({ id: "tok-ada", name: "employee-ada", client_id: CLIENT.ada, expires_at: "2027-10-12T00:00:00Z" });
cf.rules.push({ id: "rule-ada", name: "ada mailbox", enabled: true, matchers: [{ type: "literal", field: "to", value: "ada@agents.delo.sh" }], actions: [{ type: "worker", value: ["agents-facade"] }] });
writeFileSync(baseEnv.GW_STATE, JSON.stringify({ mode: "ok", consumers: {} }));
writeFileSync(baseEnv.GW_LOG, "");

// -- facade process -----------------------------------------------------------------------------------------------------
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
const facade = await startFacade();
worker.facade = facade.url;

const audit = () => (existsSync(join(state, "audit.jsonl")) ? readFileSync(join(state, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const mailAudit = () => audit().filter((l) => l.event === "mail.authorize");
const post = async (url, path, headers, payload) => {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
};
/** Straight at the facade origin with a hand-made Access assertion. */
const direct = async (clientId, payload, runAssertion, path = "/v1/mail/authorize") => post(facade.url, path, { ...(clientId ? { "cf-access-jwt-assertion": await edge.mint({ clientId }) } : {}), ...(runAssertion ? { "x-flume-run-assertion": runAssertion } : {}) }, payload);
/** Through the edge and the Worker double, as a launched employee process would. */
const viaEdge = (name, path, payload, runAssertion) => post(edge.url, path, { "cf-access-client-id": CLIENT[name], "cf-access-client-secret": SECRET[name], ...(runAssertion ? { "x-flume-run-assertion": runAssertion } : {}) }, payload);
const accessBody = (id) => ({ version: 1, request_id: id, service: "fixture", resource: "repo:alpha", permissions: ["read"] });

try {
  const adaRun = await runJwt({ sub: subject.ada }), bobRun = await runJwt({ sub: subject.bob });
  const FIRST = mailbox.ada[0].id;

  // -- 1. mail authorize ------------------------------------------------------------------------------------------------
  {
    const listed = await direct(CLIENT.ada, { operation: "list" }, adaRun);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(Object.keys(listed.body).sort(), ["handle", "harness", "mailbox_prefix", "ok", "operation", "run_id", "status", "subject"]);
    assert.equal(listed.body.status, "authorized"); assert.equal(listed.body.ok, true);
    assert.equal(listed.body.handle, "ada"); assert.equal(listed.body.subject, subject.ada); assert.equal(listed.body.mailbox_prefix, "mail/ada/"); assert.equal(listed.body.operation, "list"); assert.equal(listed.body.harness, "plain");
    const read = await direct(CLIENT.ada, { operation: "read", message_id: FIRST }, adaRun);
    assert.equal(read.status, 200); assert.equal(read.body.operation, "read");
    // The handle comes only from the verified machine identity: a body naming bob changes nothing and is refused as an unknown field.
    assert.equal((await direct(CLIENT.ada, { operation: "list", handle: "bob" }, adaRun)).status, 400);
    const lines = mailAudit();
    assert.equal(lines.length >= 3, true);
    const authorized = lines.filter((l) => l.outcome === "authorized");
    assert.deepEqual(authorized.map((l) => l.operation), ["list", "read"]);
    assert.equal(authorized[1].message_id, FIRST);
    for (const line of lines) { assert.equal(line.event, "mail.authorize"); assert.equal(JSON.stringify(line).includes(MAIL_CODE), false); assert.equal(line.raw, undefined); }
    assert.equal(authorized[0].subject, subject.ada); assert.equal(authorized[0].run_id.length > 0, true);
    pass("POST /v1/mail/authorize answers the Worker's contract for a valid run and writes one secret-free mail.authorize audit line per request");
  }

  // -- 2. body, assertion and run failures -------------------------------------------------------------------------------
  {
    const bad = [
      ["an extra field", { operation: "list", extra: 1 }], ["list with an id", { operation: "list", message_id: FIRST }], ["read without an id", { operation: "read" }],
      ["a non-hex id", { operation: "read", message_id: "z".repeat(64) }], ["a short id", { operation: "read", message_id: "ab" }], ["an unknown operation", { operation: "delete" }], ["no operation", {}],
    ];
    for (const [label, payload] of bad) { const r = await direct(CLIENT.ada, payload, adaRun); assert.equal(r.status, 400, label); assert.equal(r.body.code, "invalid-request", label); }
    assert.equal((await direct(CLIENT.ada, "not json", adaRun)).status, 400);
    assert.equal((await direct(undefined, { operation: "list" }, adaRun)).body.code, "missing-assertion");
    assert.equal((await direct(CLIENT.ada, { operation: "list" }, undefined)).body.code, "missing-run");
    assert.equal((await direct(CLIENT.ada, { operation: "list" }, bobRun)).body.code, "run-subject-mismatch");
    assert.equal((await direct("stranger.access", { operation: "list" }, adaRun)).body.code, "unknown-client");
    assert.equal((await post(facade.url, "/v1/mail/authorize", { "cf-access-jwt-assertion": "not-a-jwt", "x-flume-run-assertion": adaRun }, { operation: "list" })).body.code, "invalid-assertion");
    const methodGet = await fetch(`${facade.url}/v1/mail/authorize`);
    assert.equal(methodGet.status, 405);
    const denied = mailAudit().filter((l) => l.http_status >= 400);
    assert.ok(denied.length >= 12);
    pass("mail authorize refuses extra fields, list-with-id, read-without-id, non-hex ids, bad JSON, a missing or bad assertion, run or client with the access pipeline's codes");
  }

  // -- 3. the plain client through the edge and the Worker ----------------------------------------------------------------
  {
    const list = await runAsync(["access", "run", "ada", "--", process.execPath, cli, "mail", "list"]);
    const listed = JSON.parse(list.stdout);
    assert.equal(list.status, 0, list.stdout + list.stderr);
    assert.deepEqual(listed.messages.map((m) => m.id).sort(), mailbox.ada.map((m) => m.id).sort());
    assert.equal(listed.handle, "ada"); assert.equal(listed.harness, "plain");
    const read = await runAsync(["access", "run", "ada", "--", process.execPath, cli, "mail", "read", FIRST]);
    assert.equal(read.status, 0, read.stdout + read.stderr);
    assert.equal(JSON.parse(read.stdout).raw, mailbox.ada[0].raw);
    // Bob's message id from ada's process is indistinguishable from a nonexistent one.
    const foreign = await runAsync(["access", "run", "ada", "--", process.execPath, cli, "mail", "read", mailbox.bob[0].id]);
    assert.equal(foreign.status, 1); assert.equal(JSON.parse(foreign.stdout).code, "message-not-found");
    assert.equal(foreign.stdout.includes("bob secret mail"), false);
    // bob lists only bob's.
    const bobList = await runAsync(["access", "run", "bob-pm", "--", process.execPath, cli, "mail", "list"]);
    assert.deepEqual(JSON.parse(bobList.stdout).messages.map((m) => m.id), [mailbox.bob[0].id]);
    // Not launched: an error naming the missing environment.
    const bare = await runAsync(["mail", "list"]);
    assert.equal(bare.status, 1);
    assert.match(JSON.parse(bare.stdout).error, /Not launched by Flume: missing FLUME_ACCESS_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, FLUME_RUN_ASSERTION/u);
    // No identity flag, no send path.
    const flag = await runAsync(["access", "run", "ada", "--", process.execPath, cli, "mail", "list", "--employee", "bob"]);
    assert.notEqual(flag.status, 0); assert.match(flag.stderr, /unknown option/u);
    const send = await runAsync(["access", "run", "ada", "--", process.execPath, cli, "mail", "send", "x"]);
    assert.notEqual(send.status, 0);
    assert.match((await runAsync(["mail", "--help"])).stdout, /list/u);
    assert.equal(/^\s+send\b/mu.test((await runAsync(["mail", "--help"])).stdout), false, "mail has a send subcommand");
    pass("flume mail list|read reads only the launched employee's mailbox, has no identity flag and no send, and names the missing launcher environment");
  }

  // -- 4. AC1: suspension is denied at the facade, in mail and in access, with the SAME run assertion -----------------------
  {
    const before = { access: await viaEdge("ada", "/v1/access/requests", accessBody("ac1-before"), adaRun), mail: await viaEdge("ada", "/v1/mail/messages", { operation: "list" }, adaRun) };
    assert.equal(before.access.body.status, "granted"); assert.equal(before.mail.status, 200);
    const suspended = json(await runAsync(["identity", "suspend", "ada", "--apply", "--json"]));
    assert.equal(suspended.ok, true, JSON.stringify(suspended));
    assert.equal(suspended.complete_revocation, false);
    assert.equal(cf.kv.has("allowlist/ada@agents.delo.sh"), false);
    const grantsBefore = readFileSync(join(state, "fixture-ledger.jsonl"), "utf8").split("\n").filter(Boolean).length;
    const accessAfter = await viaEdge("ada", "/v1/access/requests", accessBody("ac1-after"), adaRun);
    assert.equal(accessAfter.status, 403); assert.equal(accessAfter.body.code, "employee-suspended"); assert.equal(accessAfter.body.credential, undefined);
    const authorizeAfter = await direct(CLIENT.ada, { operation: "list" }, adaRun);
    assert.equal(authorizeAfter.status, 403, "the facade's mail status check let a suspended employee through"); assert.equal(authorizeAfter.body.code, "employee-suspended");
    const reads = worker.storageReads;
    const mailAfter = await viaEdge("ada", "/v1/mail/messages", { operation: "list" }, adaRun);
    assert.equal(mailAfter.status, 403); assert.equal(mailAfter.body.code, "employee-suspended");
    assert.equal(worker.storageReads, reads, "the Worker read storage for a suspended employee");
    assert.equal(readFileSync(join(state, "fixture-ledger.jsonl"), "utf8").split("\n").filter(Boolean).length, grantsBefore, "a suspended employee was granted access");
    const refused = await runAsync(["access", "run", "ada", "--", process.execPath, cli, "mail", "list"]);
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Launch refused: ada is suspended/u);
    const denials = audit().filter((l) => l.outcome === "employee-suspended");
    assert.ok(denials.some((l) => l.event === "access.request") && denials.some((l) => l.event === "mail.authorize"));
    // mailbox-closed: an ACTIVE employee whose allowlist key is gone is still closed by the Worker.
    const restored = json(await runAsync(["identity", "restore", "ada", "--apply", "--json"]));
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal((await viaEdge("ada", "/v1/access/requests", accessBody("ac1-restored"), adaRun)).body.status, "granted");
    assert.equal((await viaEdge("ada", "/v1/mail/messages", { operation: "list" }, adaRun)).status, 200);
    assert.equal((await direct(CLIENT.ada, { operation: "list" }, adaRun)).status, 200);
    const saved = cf.kv.get("allowlist/ada@agents.delo.sh");
    cf.kv.delete("allowlist/ada@agents.delo.sh");
    const closed = await viaEdge("ada", "/v1/mail/messages", { operation: "list" }, adaRun);
    assert.equal(closed.status, 403); assert.equal(closed.body.code, "mailbox-closed");
    cf.kv.set("allowlist/ada@agents.delo.sh", saved);
    pass("after `identity suspend` the same run assertion is denied employee-suspended for access and mail, a new launch is refused, and restore returns both; the Worker closes a missing allowlist key");
  }

  // -- 5. AC4: cross-harness receipts -------------------------------------------------------------------------------------
  {
    // Start from a clean audit window for the receipts story: a fresh hermes run and a fresh plain run, each requesting access and listing mail.
    const sinceMark = new Date().toISOString();
    const hermes = await runAsync(["launch", "ada", "--", "chat"], { FIXTURE_REQUEST_ID: "hermes-request-0001" });
    assert.equal(hermes.status, 0, hermes.stdout + hermes.stderr);
    const hermesRun = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8"));
    assert.equal(hermesRun.request.status, 0); assert.equal(hermesRun.mail.status, 0);
    const plain = await runAsync(["access", "run", "ada", "--", process.execPath, join(dir, "plain.cjs")]);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    const plainRun = JSON.parse(readFileSync(join(dir, "plain.json"), "utf8"));
    assert.equal(plainRun.request.status, 0); assert.equal(plainRun.mail.status, 0);
    for (const r of [hermesRun, plainRun]) { secrets.add(r.creds.run); secrets.add(r.creds.secret); }
    assert.notEqual(hermesRun.creds.run_id, plainRun.creds.run_id);
    // Suspend, then the hermes run keeps knocking with its own assertion: that is its denial inside its window.
    const suspended = json(await runAsync(["identity", "suspend", "ada", "--apply", "--json"]));
    const through = (r, path, payload) => post(edge.url, path, { "cf-access-client-id": r.creds.id, "cf-access-client-secret": r.creds.secret, "x-flume-run-assertion": r.creds.run }, payload);
    assert.equal((await through(hermesRun, "/v1/access/requests", accessBody("hermes-after"))).body.code, "employee-suspended");
    assert.equal((await through(hermesRun, "/v1/mail/messages", { operation: "list" })).body.code, "employee-suspended");

    const all = json(await runAsync(["access", "receipts", "--employee", "ada", "--json"]));
    assert.equal(all.ok, true, JSON.stringify(all));
    assert.deepEqual(all.subjects, [subject.ada]);
    assert.ok(all.run_ids.includes(hermesRun.creds.run_id) && all.run_ids.includes(plainRun.creds.run_id));
    const harnessOf = Object.fromEntries(all.runs.map((r) => [r.run_id, r.harness]));
    assert.equal(harnessOf[hermesRun.creds.run_id], "hermes"); assert.equal(harnessOf[plainRun.creds.run_id], "plain");
    const kinds = (runId) => all.rows.filter((r) => r.run_id === runId).map((r) => r.kind);
    for (const id of [hermesRun.creds.run_id, plainRun.creds.run_id]) { assert.ok(kinds(id).includes("request"), `request for ${id}`); assert.ok(kinds(id).includes("grant"), `grant for ${id}`); assert.ok(kinds(id).includes("mail"), `mail for ${id}`); }
    assert.ok(kinds(hermesRun.creds.run_id).filter((k) => k === "denial").length >= 2, "the hermes run's denials");
    assert.equal(kinds(plainRun.creds.run_id).includes("denial"), false);
    assert.ok(all.rows.some((r) => r.kind === "denial" && r.event === "mail.authorize" && r.outcome === "employee-suspended"));
    // joined by correlation fields: a grant row and its request share request_id and grant_id
    const grant = all.rows.find((r) => r.kind === "grant" && r.run_id === hermesRun.creds.run_id);
    const request = all.rows.find((r) => r.kind === "request" && r.grant_id === grant.grant_id);
    assert.equal(request.request_id, grant.request_id); assert.equal(request.subject, grant.subject); assert.equal(request.run_id, grant.run_id);
    // the lifecycle operation, joined by subject and operation_id
    assert.ok(all.operations.some((op) => op.operation_id === suspended.operation_id && op.command === "suspend" && op.steps.some((s) => s.step === "mail:allowlist-delete:ada@agents.delo.sh")));
    assert.ok(all.rows.some((r) => r.kind === "lifecycle" && r.operation_id === suspended.operation_id && r.subject === subject.ada));
    assert.equal(all.gateway.owner_ticket, "FLUME-39"); assert.equal(all.gateway.evidence_status, "unverified"); assert.equal(all.gateway.attribution, "unverified");
    assert.deepEqual(all.writes, []);
    // whitelisted fields only, never a raw line
    const ALLOWED = new Set(["kind", "at", "event", "outcome", "http_status", "subject", "handle", "run_id", "harness", "request_id", "grant_id", "service", "resource", "permissions", "lifetime_seconds", "expires_at", "replayed", "operation", "message_id", "provider", "installation_id", "app_id", "repository", "github_request_id", "reason", "operation_id", "command", "employee", "phase", "step", "adapter", "provider_code", "ok", "complete_revocation", "from", "to", "revoke", "original_operation_id", "previous_ref", "credential_ref", "ref", "evidence", "comment_id", "actor_id", "native_actor_id", "authorship"]);
    for (const row of all.rows) for (const key of Object.keys(row)) assert.ok(ALLOWED.has(key), `row field ${key} is not whitelisted`);

    // --run: the hermes run's window contains the suspend (its denial is after it); the plain run's window does not.
    const hermesOnly = json(await runAsync(["access", "receipts", "--run", hermesRun.creds.run_id, "--json"]));
    assert.deepEqual(hermesOnly.run_ids, [hermesRun.creds.run_id]);
    assert.ok(hermesOnly.operations.some((op) => op.operation_id === suspended.operation_id), "the suspend inside the hermes run window");
    const plainOnly = json(await runAsync(["access", "receipts", "--run", plainRun.creds.run_id, "--json"]));
    assert.deepEqual(plainOnly.run_ids, [plainRun.creds.run_id]);
    assert.equal(plainOnly.operations.length, 0, "a lifecycle operation outside the plain run's window was joined to it");
    assert.equal(json(await runAsync(["access", "receipts", "--run", "no-such-run", "--json"]), 1).blockers[0].code, "run-not-found");
    assert.equal(json(await runAsync(["access", "receipts", "--json"]), 1).blockers[0].code, "invalid-request");
    const since = json(await runAsync(["access", "receipts", "--employee", "ada", "--since", new Date(Date.now() + 60_000).toISOString(), "--json"]));
    assert.equal(since.rows.length, 0);
    const recent = json(await runAsync(["access", "receipts", "--employee", "ada", "--since", sinceMark, "--json"]));
    assert.deepEqual([...recent.run_ids].sort(), [hermesRun.creds.run_id, plainRun.creds.run_id].sort(), "exactly the hermes and the plain run");
    // The FLUME-39 evidence branch: an existing evidence path links the attribution.
    const present = json(await runAsync(["access", "receipts", "--employee", "ada", "--json"], { FLUME_GATEWAY_EVIDENCE: dir }));
    assert.equal(present.gateway.evidence_status, "present"); assert.equal(present.gateway.attribution, "linked");
    const human = await runAsync(["access", "receipts", "--employee", "ada"]);
    assert.match(human.stdout, /2 run\(s\)|run\(s\)/u);

    // gateway proof: verified only when verified:true and every token_name is the employee's own consumer
    const base = { status: "ok", receipts: [{ token_name: "aai:ada:1700000001", request_id: "r1", session_id: "s1", created_at: "2026-10-14T00:00:00Z" }] };
    const proof = (name, body) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; };
    // The fixture desk maps no gateway reference, so no consumer exists: unverified even for a matching-looking proof.
    const noConsumer = json(await runAsync(["access", "receipts", "--employee", "ada", "--gateway-proof", proof("proof-none.json", { ...base, verified: true }), "--json"]));
    assert.equal(noConsumer.gateway.proof.status, "unverified"); assert.equal(noConsumer.gateway.proof.reason, "no-consumer");
    mkdirSync(join(fleet, "profiles/ada"), { recursive: true });
    writeFileSync(join(fleet, "profiles/ada/config.delta.yaml"), YAML.stringify({ secrets: { onepassword: { env: { AUTOMATICAI_GATEWAY_KEY: "op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/ada" } } } }));
    const match = json(await runAsync(["access", "receipts", "--employee", "ada", "--gateway-proof", proof("proof-ok.json", { ...base, verified: true }), "--json"]));
    assert.equal(match.gateway.proof.status, "verified"); assert.equal(match.gateway.consumer, "ada"); assert.equal(match.gateway.evidence_status, "unverified");
    const mismatch = json(await runAsync(["access", "receipts", "--employee", "ada", "--gateway-proof", proof("proof-bad.json", { ...base, verified: true, receipts: [...base.receipts, { token_name: "aai:bob:1700000002", request_id: "r2", session_id: "s2", created_at: "2026-10-14T00:00:01Z" }] }), "--json"]));
    assert.equal(mismatch.gateway.proof.status, "mismatch");
    const unverifiedProof = json(await runAsync(["access", "receipts", "--employee", "ada", "--gateway-proof", proof("proof-no.json", { ...base, verified: false }), "--json"]));
    assert.equal(unverifiedProof.gateway.proof.status, "unverified");
    const prefixTrick = json(await runAsync(["access", "receipts", "--employee", "ada", "--gateway-proof", proof("proof-prefix.json", { ...base, verified: true, receipts: [{ ...base.receipts[0], token_name: "aai:adamant:1700000001" }] }), "--json"]));
    assert.equal(prefixTrick.gateway.proof.status, "mismatch", "a consumer that merely starts with the employee's name is not the employee's");
    json(await runAsync(["identity", "restore", "ada", "--apply", "--json"]));
    pass("access receipts joins a hermes run, a plain run, grants, mail authorizations, denials and the lifecycle operation by subject, run_id and operation_id; --run windows; the gateway link is unverified and a proof matches only the employee's own consumer");
  }

  // -- 6. secrets ---------------------------------------------------------------------------------------------------------
  {
    const files = [];
    const walk = (d) => { for (const name of readdirSync(d)) { const p = join(d, name); const s = lstatSync(p); if (s.isDirectory()) walk(p); else if (s.isFile() && !p.includes("/bin/") && !/\/(op\.json|launch\.json|plain\.json|plain\.cjs|gw-state\.json)$/u.test(p) && !p.endsWith("/skillex")) files.push(p); } };
    walk(dir);
    let scanned = 0;
    for (const file of files) { const text = readFileSync(file, "utf8"); for (const secret of secrets) assert.equal(text.includes(secret), false, `a planted secret is in ${file}`); scanned++; }
    const texts = [...outputs, ...facadeOutputs.flatMap((o) => [o.stdout, o.stderr])];
    // Mail content is data the employee asked for: `mail read` prints it. Every other planted value must stay out of every output.
    for (const text of texts) for (const secret of secrets) if (secret !== MAIL_CODE) assert.equal(text.includes(secret), false, "a planted secret reached a process output");
    // mail content is data the employee asked for; it may be printed by `mail read` but never reaches an audit line or receipt.
    for (const line of readFileSync(join(state, "audit.jsonl"), "utf8").split("\n").filter(Boolean)) assert.equal(line.includes(MAIL_CODE), false);
    assert.equal(facadeOutputs.every((o) => !o.stderr.includes(MAIL_CODE)), true);
    assert.ok(scanned > 5);
    pass(`no planted secret appears in any of ${scanned} state, ledger or receipt files or in the facade's output`);
  }
} finally {
  for (const out of facadeOutputs) out.child.kill("SIGTERM");
  await edge.close(); await worker.close(); await cf.close();
}
console.log(`\n${count} facade, mail and receipts scenarios passed`);
