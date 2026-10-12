// FLUME-48 employee access, through the built `flume` CLI only.
//
// A fake Cloudflare Access edge stands in for the real one: it checks the
// CF-Access client id/secret, mints the RS256 assertion exactly as the edge does
// (empty `sub`, `common_name` = client id, `type: "app"`), serves the JWKS at
// <issuer>/cdn-cgi/access/certs and proxies to the facade origin. The product
// code is the same in fixture and live; only the issuer differs. Every secret the
// suite creates is collected and then scanned for in everything the facade wrote.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import YAML from "yaml";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { addSetSkills, createSet } from "@delorenj/skillex";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync("/tmp/flume48-");
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

const AUD = "aud-fixture-tag";
const CLIENT = { ada: "ada-client-id.access", bob: "bob-client-id.access", cy: "cy-client-id.access" };
const SECRET = { ada: "ada-client-secret-value", bob: "bob-client-secret-value", cy: "cy-client-secret-value" };
const VAULT = "vault-service-token-value";
const GATEWAY = "ada-gateway-key-value";
const SIGNING_REF = "op://DeLoSecrets/flume-launcher/signing-key";
const HERMES_REF = "op://DeLoSecrets/hermes-ada/credential";
/** Everything secret the suite ever creates; scanned for in every artifact at the end. */
const secrets = new Set([VAULT, GATEWAY, ...Object.values(SECRET)]);

/** The operator's own shell credentials: an employee child must never inherit any of them. */
const OPERATOR_ENV = {
  GITHUB_PERSONAL_ACCESS_TOKEN: "operator-github-pat-value", PLANE_33GOD_API_KEY: "operator-plane-key-value", VAULT_TOKEN: "operator-vault-token-value",
  VAULT_UNSEAL_KEY_1: "operator-unseal-key-value", PGPASSWORD: "operator-pg-password-value", CLOUDFLARE_API_TOKEN: "operator-cloudflare-token-value",
  GOOGLE_CLIENT_SECRET: "operator-google-secret-value", MINIO_SECRET_KEY: "operator-minio-secret-value", HF_TOKEN: "operator-hf-token-value", FAL_KEY: "operator-fal-key-value",
  // Names and values the live operator shell exports past a bare suffix match.
  NOTION_API_KEY_RR: "operator-notion-key-value", POSTGRES_URL: "postgresql://operator:operator-pg-url-password@db.local:5432/app",
  RABBITMQ_PASS: "operator-rabbit-pass-value", GOOGLE_APPLICATION_CREDENTIALS: "/operator/gcp-credentials.json", GITHUB_PAT: "operator-github-pat-2-value",
  SSH_AUTH_SOCK: "/tmp/operator-ssh-agent.sock",
};
/** Names that merely contain a credential word, and so must survive. */
const HARMLESS_ENV = { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000", XAUTHORITY: "/tmp/fixture-xauthority", KEYTIMEOUT: "1", SERVICE_URL: "http://localhost:8080/a:b@c" };
for (const value of Object.values(OPERATOR_ENV)) secrets.add(value);

const launcher = generateKeyPairSync("ed25519");
const impostor = generateKeyPairSync("ed25519");
const launcherPrivate = launcher.privateKey.export({ type: "pkcs8", format: "pem" });
const launcherPublic = launcher.publicKey.export({ type: "spki", format: "pem" });
secrets.add(launcherPrivate.split("\n")[1]);

// -- fake Cloudflare Access edge ------------------------------------------------------------
async function fakeEdge() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "edge-1", alg: "RS256", use: "sig" };
  const clients = new Map(Object.keys(CLIENT).map((name) => [CLIENT[name], SECRET[name]]));
  const edge = { origin: "", url: "", seen: [], privateKey, otherKey: other.privateKey, jwksFetches: 0 };
  /** A JWT as the edge would sign it, or any malformed variant of it. */
  edge.mint = async ({ clientId, sub = "", iss = edge.url, aud = AUD, exp = "5m", noExp = false, nbf, key = privateKey, alg = "RS256", kid = "edge-1", email, humanSub } = {}) => {
    const claims = { sub: humanSub ?? sub, type: "app", ...(clientId ? { common_name: clientId } : {}), ...(email ? { email } : {}) };
    const jwt = new SignJWT(claims).setProtectedHeader({ alg, kid }).setIssuedAt().setIssuer(iss).setAudience(aud);
    if (!noExp) jwt.setExpirationTime(exp);
    if (nbf !== undefined) jwt.setNotBefore(nbf);
    const token = await jwt.sign(key);
    secrets.add(token);
    return token;
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      edge.jwksFetches++;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const id = req.headers["cf-access-client-id"], secret = req.headers["cf-access-client-secret"];
    edge.seen.push({ url: req.url, client: id });
    if (!id || clients.get(id) !== secret) { res.writeHead(403, { "content-type": "application/json" }); return res.end('{"error":"access denied"}'); }
    const headers = { "content-type": "application/json", "cf-access-jwt-assertion": await edge.mint({ clientId: id }) };
    // The edge overwrites identity headers; these pass-throughs prove the facade ignores them anyway.
    for (const name of ["x-flume-run-assertion", "x-employee", "cf-access-authenticated-user-email"]) if (req.headers[name]) headers[name] = req.headers[name];
    const upstream = await fetch(`${edge.origin}${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(await upstream.text());
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  edge.url = `http://127.0.0.1:${server.address().port}`;
  edge.close = () => new Promise((done) => server.close(done));
  return edge;
}

const runJwt = async ({ sub, jti = randomUUID(), noJti = false, noExp = false, harness = "plain", iss = "flume-launcher", aud = "flume-access", key = launcher.privateKey, exp = "1h" }) => {
  const jwt = new SignJWT({ harness }).setProtectedHeader({ alg: "EdDSA" }).setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt();
  if (!noJti) jwt.setJti(jti);
  if (!noExp) jwt.setExpirationTime(exp);
  const token = await jwt.sign(key);
  secrets.add(token);
  return token;
};

// -- fixture ----------------------------------------------------------------------------------
const dir = join(work, "fx"), home = join(dir, "home"), fleet = join(home, ".hermes"), registry = join(fleet, "agents-registry.yaml");
const bin = join(dir, "bin"), state = join(dir, "state"), catalog = join(dir, "skillex"), configPath = join(dir, "employee-access.yaml");
for (const p of [fleet, join(home, ".agents/workforce"), join(dir, "repos"), bin]) mkdirSync(p, { recursive: true });
writeFileSync(registry, "schema_version: 1\nagents: {}\n");
writeFileSync(join(bin, "op"), `#!/usr/bin/env node
const fs = require("fs");
if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== ${JSON.stringify(VAULT)}) process.exit(1);
const map = JSON.parse(fs.readFileSync(process.env.OP_FIXTURE, "utf8"));
const [verb, ref] = process.argv.slice(2);
if (verb !== "read" || !(ref in map)) process.exit(2);
process.stdout.write(map[ref]);
`, { mode: 0o755 });
writeFileSync(join(bin, "hermes"), `#!/usr/bin/env node
const fs = require("fs"), cp = require("child_process");
const request = cp.spawnSync(process.execPath, [process.env.FIXTURE_CLI, "access", "request", "--service", "fixture", "--resource", "repo:alpha", "--permission", "read", "--request-id", process.env.FIXTURE_REQUEST_ID || "hermes-request-0001"], { env: process.env, encoding: "utf8" });
fs.writeFileSync(process.env.LAUNCH_RECEIPT, JSON.stringify({ args: process.argv.slice(2), env: process.env, request: { status: request.status, stdout: request.stdout } }));
process.exit(0);
`, { mode: 0o755 });
writeFileSync(join(dir, "dump.cjs"), `require("fs").writeFileSync(process.argv[2], JSON.stringify({ env: process.env }));\n`);

const edge = await fakeEdge();
const issuer = edge.url;
writeFileSync(join(dir, "op.json"), JSON.stringify({
  [SIGNING_REF]: launcherPrivate,
  [HERMES_REF]: GATEWAY,
  "op://DeLoSecrets/ada-access/credential": SECRET.ada,
  "op://DeLoSecrets/bob-access/credential": SECRET.bob,
  "op://DeLoSecrets/cy-access/credential": SECRET.cy,
}));
const baseEnv = {
  ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
  HERMES_TEMPLATE_CONFIG: join(dir, "no-config"), HERMES_FLEET_ENV: join(dir, "no-env"), HERMES_FLEET_BIN: join(bin, "hermes"),
  XDG_STATE_HOME: join(home, ".local/state"), PJ_SKILLS_REGISTRY_ROOT: catalog, PYTHONDONTWRITEBYTECODE: "1",
  PATH: `${bin}:${process.env.PATH}`, FLUME_ACCESS_CONFIG: configPath, FLUME_ACCESS_STATE: state,
  OP_SERVICE_ACCOUNT_TOKEN: VAULT, OP_FIXTURE: join(dir, "op.json"), FIXTURE_CLI: cli, LAUNCH_RECEIPT: join(dir, "launch.json"),
  // Another employee's bootstrap secrets in the parent: they must never reach a child.
  ...OPERATOR_ENV, ...HARMLESS_ENV,
  CF_ACCESS_CLIENT_ID: CLIENT.bob, CF_ACCESS_CLIENT_SECRET: SECRET.bob, FLUME_RUN_ASSERTION: "foreign-run-assertion", FLUME_ACCESS_URL: "http://127.0.0.1:9/foreign", OPENAI_API_KEY: "foreign-inference-key", AUTOMATICAI_GATEWAY_KEY: "foreign-gateway-key",
};
const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...baseEnv, ...extra }, cwd: dir, encoding: "utf8", timeout: 60000 });
/** Needed whenever the child talks to the fake edge, which lives in this process: a sync spawn would deadlock it. */
const runAsync = (args, extra = {}) => new Promise((done) => {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...baseEnv, ...extra }, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => stdout += b);
  child.stderr.on("data", (b) => stderr += b);
  child.on("close", (status) => done({ status, stdout, stderr }));
});
const json = (r, status = 0) => { assert.equal(r.status, status, r.stdout + r.stderr); return JSON.parse(r.stdout); };

mkdirSync(join(catalog, "all-skills/alpha"), { recursive: true });
writeFileSync(join(catalog, "all-skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: fixture alpha\n---\n");
const skillex = { registryRoot: catalog, home, stateHome: baseEnv.XDG_STATE_HOME };
assert.ok((await createSet("first", skillex)).ok);
assert.ok((await addSetSkills("first", ["alpha"], skillex)).ok);
writeFileSync(join(fleet, "config.yaml"), YAML.stringify({ model: { provider: "automaticai", default: "automaticai/personal/sol" }, memory: { provider: "hindsight" } }));

const binding = (name, ref) => ({ cloudflare_access: { principal: CLIENT[name], instance: issuer, credential_ref: ref ?? `op://DeLoSecrets/${name}-access/credential` } });
const setBinding = (path, bindings) => {
  const doc = YAML.parseDocument(readFileSync(path, "utf8"));
  doc.setIn(["company_identity", "bindings"], bindings);
  writeFileSync(path, String(doc));
};
const post = (id, person) => {
  const roleDir = join(dir, "repos", id, "agents/hermes/pm");
  mkdirSync(roleDir, { recursive: true });
  const path = join(roleDir, "role.yaml");
  writeFileSync(path, `repo: ${id}\nrole: pm\nagent_id: ${id}\nprofile: ${id}\nidentity:\n  name: ${person}\n  recall_banks:\n    - agent-${id}\n`);
  const doc = YAML.parseDocument(readFileSync(registry, "utf8"));
  doc.setIn(["agents", id], { project_path: join(dir, "repos", id), role_dir: roleDir, profile_name: id, identity: id });
  writeFileSync(registry, String(doc));
  return path;
};

// ada: a portable specialist (Hermes harness). bob, cy, dee: post-holders.
const source = join(dir, "ada.yaml");
writeFileSync(source, YAML.stringify({ schema_version: 1, id: "ada", display_name: "Ada", role: "infra", charter: { purpose: "Keep infra boring" }, skills: { set: "first" }, memory: { write_bank: "agent-ada", recall_banks: ["infra"] } }));
json(run(["hire", "--definition", source, "--json"]));
const adaDesk = join(home, ".agents/workforce/ada/agent.yaml");
const bobRole = post("bob-pm", "bob"), cyRole = post("cy-pm", "cy");
post("dee-pm", "dee");
const subject = {};
for (const [name, id] of [["ada", "ada"], ["bob", "bob-pm"], ["cy", "cy-pm"]]) subject[name] = json(run(["identity", "enroll", id, "--apply", "--json"])).identity.subject;
setBinding(adaDesk, binding("ada"));
setBinding(bobRole, binding("bob"));
// cy is enrolled but has no cloudflare_access binding; dee is not enrolled at all.
json(run(["onboard", "--employee", "ada", "--json"]));
assert.ok(json(run(["audit", "--employee", "ada", "--json"])).ok);

const grants = (extra = []) => [
  { subject: subject.ada, service: "fixture", resource: "repo:alpha", permissions: ["read", "write"], max_lifetime_seconds: 3600 },
  { subject: subject.bob, service: "fixture", resource: "repo:alpha", permissions: ["read"], max_lifetime_seconds: 600 },
  ...extra,
];
const writeConfig = (list = grants()) => writeFileSync(configPath, YAML.stringify({
  version: 1, url: edge.url, listen: { host: "127.0.0.1", port: 0 }, cloudflare_access: { issuer, audience: AUD },
  launcher: { signing_key_ref: SIGNING_REF, public_key: launcherPublic }, grants: list,
}));
writeConfig();

// -- facade process ---------------------------------------------------------------------------
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

let sequence = 0;
const body = (overrides = {}) => ({ version: 1, request_id: `req-${String(++sequence).padStart(4, "0")}`, service: "fixture", resource: "repo:alpha", permissions: ["read"], ...overrides });
const send = async (url, headers, payload) => {
  const response = await fetch(`${url}/v1/access/requests`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  const text = await response.text();
  const credential = /"value":"(fixture-[0-9a-f]+)"/u.exec(text);
  if (credential) secrets.add(credential[1]);
  return { status: response.status, body: JSON.parse(text) };
};
/** Through the edge, with client credentials, as a real employee process would. */
const viaEdge = (name, payload, runAssertion, extra = {}) => send(edge.url, { "cf-access-client-id": CLIENT[name], "cf-access-client-secret": SECRET[name], ...(runAssertion ? { "x-flume-run-assertion": runAssertion } : {}), ...extra }, payload);
/** Straight at the origin with a hand-made assertion. */
const direct = async (claims, payload, runAssertion) => send(facade.url, { ...(claims ? { "cf-access-jwt-assertion": await edge.mint(claims) } : {}), ...(runAssertion ? { "x-flume-run-assertion": runAssertion } : {}) }, payload);
const lines = (file) => existsSync(join(state, file)) ? readFileSync(join(state, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const ledger = () => lines("fixture-ledger.jsonl");
const refused = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.code, code, JSON.stringify(r.body)); assert.equal(r.body.ok, false); assert.equal(r.body.evidence, "fixture"); assert.equal(r.body.provider, "fixture"); assert.equal(r.body.credential, undefined); };

try {
  const adaRun = await runJwt({ sub: subject.ada });
  const bobRun = await runJwt({ sub: subject.bob });

  // -- Valid A -------------------------------------------------------------------------------
  {
    const granted = await direct({ clientId: CLIENT.ada }, body(), adaRun);
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.status, "granted");
    assert.equal(granted.body.subject, subject.ada);
    assert.equal(granted.body.handle, "ada");
    assert.equal(granted.body.evidence, "fixture");
    assert.equal(granted.body.provider, "fixture");
    assert.equal(granted.body.replayed, false);
    assert.match(granted.body.credential.value, /^fixture-[0-9a-f]+$/u);
    assert.deepEqual(granted.body.permissions, ["read"]);
    assert.equal(ledger().length, 1);
    // Through the edge with a non-empty `sub` naming someone else: sub is ignored, common_name decides.
    const sneaky = await direct({ clientId: CLIENT.ada, sub: subject.bob }, body({ resource: "repo:alpha" }), adaRun);
    assert.equal(sneaky.body.subject, subject.ada);
    pass("a valid edge-minted assertion with an empty (or misleading) sub maps common_name to exactly one subject");
  }

  // -- Forged / foreign / expired / future / HS256 / unsigned -------------------------------
  {
    const before = { ledger: ledger().length, audit: lines("audit.jsonl").filter((l) => l.outcome === "granted").length };
    const wrongHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const unsigned = `${wrongHeader}.${Buffer.from(JSON.stringify({ iss: issuer, aud: AUD, exp: 4102444800, common_name: CLIENT.ada })).toString("base64url")}.`;
    const crafted = [
      ["signed by another key", { clientId: CLIENT.ada, key: edge.otherKey }],
      ["wrong issuer", { clientId: CLIENT.ada, iss: "https://evil.cloudflareaccess.com" }],
      ["wrong audience", { clientId: CLIENT.ada, aud: "someone-elses-app" }],
      ["expired", { clientId: CLIENT.ada, exp: Math.floor(Date.now() / 1000) - 120 }],
      ["not yet valid", { clientId: CLIENT.ada, nbf: Math.floor(Date.now() / 1000) + 3600 }],
      ["HS256 with a guessable secret", { clientId: CLIENT.ada, alg: "HS256", key: new TextEncoder().encode("0123456789abcdef0123456789abcdef") }],
      ["unknown kid", { clientId: CLIENT.ada, kid: "rotated-away" }],
    ];
    for (const [label, claims] of crafted) refused(await direct(claims, body(), adaRun), 401, "invalid-assertion");
    // A validly signed assertion that never expires is not accepted: `exp` is required.
    refused(await direct({ clientId: CLIENT.ada, noExp: true }, body(), adaRun), 401, "invalid-assertion");
    for (const token of [unsigned, "not-a-jwt", ""]) refused(await send(facade.url, { "cf-access-jwt-assertion": token || " ", "x-flume-run-assertion": adaRun }, body()), 401, token ? "invalid-assertion" : "missing-assertion");
    assert.equal(ledger().length, before.ledger, "no provider-ledger line for a forged assertion");
    assert.equal(lines("audit.jsonl").filter((l) => l.outcome === "granted").length, before.audit, "no audit grant for a forged assertion");
    pass("forged, foreign-issuer, wrong-audience, expired, future, HS256, unknown-kid and unsigned assertions are 401 invalid-assertion before any grant");
  }

  // -- Direct origin, human token, unknown client -------------------------------------------
  {
    const before = ledger().length;
    refused(await send(facade.url, { "cf-access-client-id": CLIENT.ada, "cf-access-client-secret": SECRET.ada, "cf-access-authenticated-user-email": "ada@agents.delo.sh", "x-flume-run-assertion": adaRun }, body()), 401, "missing-assertion");
    refused(await direct({ humanSub: "human-sub-1", email: "ada@agents.delo.sh" }, body(), adaRun), 401, "missing-machine-identity");
    refused(await direct({ clientId: "stranger-client.access" }, body(), adaRun), 403, "unknown-client");
    assert.equal(ledger().length, before);
    pass("direct-origin requests, human tokens and unbound clients are refused before any grant");
  }

  // -- Run binding ---------------------------------------------------------------------------
  {
    const before = ledger().length;
    refused(await direct({ clientId: CLIENT.ada }, body(), undefined), 401, "missing-run");
    refused(await direct({ clientId: CLIENT.ada }, body(), await runJwt({ sub: subject.ada, key: impostor.privateKey })), 401, "invalid-run");
    refused(await direct({ clientId: CLIENT.ada }, body(), await runJwt({ sub: subject.ada, exp: Math.floor(Date.now() / 1000) - 120 })), 401, "invalid-run");
    refused(await direct({ clientId: CLIENT.ada }, body(), await runJwt({ sub: subject.ada, aud: "elsewhere" })), 401, "invalid-run");
    refused(await direct({ clientId: CLIENT.ada }, body(), "garbage"), 401, "invalid-run");
    refused(await direct({ clientId: CLIENT.ada }, body(), await runJwt({ sub: subject.ada, noExp: true })), 401, "invalid-run");
    refused(await direct({ clientId: CLIENT.ada }, body(), await runJwt({ sub: subject.ada, noJti: true })), 401, "invalid-run");
    refused(await direct({ clientId: CLIENT.ada }, body(), bobRun), 401, "run-subject-mismatch");
    refused(await direct({ clientId: CLIENT.bob }, body(), adaRun), 401, "run-subject-mismatch");
    assert.equal(ledger().length, before);
    pass("missing, forged, expired, foreign and cross-employee run assertions are refused");
  }

  // -- Substitution: the caller cannot choose who they are -----------------------------------
  {
    const before = ledger().length;
    for (const employee of ["bob", "bob-pm", subject.bob]) {
      const r = await direct({ clientId: CLIENT.ada }, body({ employee }), adaRun);
      refused(r, 403, "employee-mismatch");
      assert.equal(r.body.status, "denied");
    }
    assert.equal(ledger().length, before);
    const viaHeaders = await viaEdge("ada", body({ resource: "repo:alpha" }), adaRun, { "x-employee": "bob", "cf-access-authenticated-user-email": "bob@agents.delo.sh" });
    assert.equal(viaHeaders.body.subject, subject.ada, "headers naming bob are ignored");
    assert.equal((await direct({ clientId: CLIENT.ada }, body({ employee: "ada" }), adaRun)).body.status, "granted");
    assert.equal((await direct({ clientId: CLIENT.ada }, body({ employee: subject.ada }), adaRun)).body.status, "granted");
    pass("a body employee other than the authenticated one is denied employee-mismatch; headers are ignored; self-naming is allowed");
  }

  // -- Not pre-approved, and a request cannot approve itself --------------------------------
  {
    const before = ledger().length;
    for (const [label, payload] of [
      ["other resource", body({ resource: "repo:secret" })],
      ["other service", body({ service: "other" })],
      ["extra permission", body({ permissions: ["read", "admin"] })],
      ["longer lifetime", body({ lifetime_seconds: 7200 })],
    ]) {
      const r = await direct({ clientId: CLIENT.ada }, payload, adaRun);
      assert.equal(r.status, 200, label);
      assert.equal(r.body.status, "approval_required", label);
      assert.equal(r.body.credential, undefined);
      assert.equal(r.body.evidence, "fixture");
    }
    const bobWrites = await direct({ clientId: CLIENT.bob }, body({ permissions: ["write"] }), bobRun);
    assert.equal(bobWrites.body.status, "approval_required", "bob's grant is his own: ada's write grant does not apply");
    assert.equal(ledger().length, before, "approval_required writes no ledger line");
    for (const extra of [{ approved: true }, { grant: { permissions: ["admin"] } }, { subject: subject.bob }]) refused(await direct({ clientId: CLIENT.ada }, { ...body(), ...extra }, adaRun), 400, "invalid-request");
    const { permissions: _omitted, ...incomplete } = body();
    refused(await direct({ clientId: CLIENT.ada }, incomplete, adaRun), 400, "invalid-request");
    refused(await direct({ clientId: CLIENT.ada }, "{not json", adaRun), 400, "invalid-request");
    refused(await direct({ clientId: CLIENT.ada }, body({ lifetime_seconds: 0 }), adaRun), 400, "invalid-request");
    assert.equal(ledger().length, before);
    assert.ok(!YAML.stringify(YAML.parse(readFileSync(configPath, "utf8"))).includes("repo:secret"), "the facade never writes the configuration");
    pass("unapproved resource, service, permission and lifetime return approval_required; self-approval fields and malformed bodies are 400");
  }

  // -- Replay and conflict -------------------------------------------------------------------
  {
    const before = ledger().length;
    const original = body({ request_id: "replay-0001", permissions: ["read", "write"], lifetime_seconds: 900 });
    const first = await direct({ clientId: CLIENT.ada }, original, adaRun);
    assert.equal(first.body.status, "granted");
    const again = await direct({ clientId: CLIENT.ada }, { lifetime_seconds: 900, permissions: ["read", "write"], request_id: "replay-0001", resource: "repo:alpha", service: "fixture", version: 1 }, adaRun);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.grant_id, first.body.grant_id);
    assert.equal(again.body.expires_at, first.body.expires_at);
    assert.equal(again.body.credential, undefined, "a replay never re-discloses the credential");
    assert.equal(again.body.credential_redelivered, false);
    assert.equal(ledger().length, before + 1, "one ledger line for the grant");
    refused(await direct({ clientId: CLIENT.ada }, { ...original, permissions: ["read"] }, adaRun), 409, "conflict");
    // Another employee's request_id space is separate.
    assert.equal((await direct({ clientId: CLIENT.bob }, { ...original, permissions: ["read"], lifetime_seconds: 300 }, bobRun)).body.status, "granted");
    // approval_required persists too: approving later does not rewrite history.
    const wanted = body({ request_id: "approval-0001", resource: "repo:beta" });
    assert.equal((await direct({ clientId: CLIENT.ada }, wanted, adaRun)).body.status, "approval_required");
    writeConfig(grants([{ subject: subject.ada, service: "fixture", resource: "repo:beta", permissions: ["read"], max_lifetime_seconds: 60 }]));
    const stale = await direct({ clientId: CLIENT.ada }, wanted, adaRun);
    assert.equal(stale.body.status, "approval_required");
    assert.equal(stale.body.replayed, true);
    const fresh = await direct({ clientId: CLIENT.ada }, body({ resource: "repo:beta" }), adaRun);
    assert.equal(fresh.body.status, "granted", "the operator approves by editing the configuration");
    assert.ok(Date.parse(fresh.body.expires_at) - Date.parse(fresh.body.issued_at) <= 60_000);
    writeConfig();
    // Idempotency lives on disk: a facade that crashed and restarted still replays instead of re-issuing.
    const issued = ledger().length;
    facade.child.removeAllListeners("close");
    facade.child.kill("SIGKILL");
    await new Promise((done) => facade.child.once("exit", done));
    facade = await startFacade();
    edge.origin = facade.url;
    const afterRestart = await direct({ clientId: CLIENT.ada }, original, adaRun);
    assert.equal(afterRestart.body.replayed, true);
    assert.equal(afterRestart.body.grant_id, first.body.grant_id);
    assert.equal(afterRestart.body.credential, undefined);
    assert.equal(ledger().length, issued, "a replay after restart writes no new ledger line");
    pass("an identical replay returns the original grant without the credential, even after a facade restart; a changed body is 409; approval_required persists");

    // -- Config reload fails closed ----------------------------------------------------------
    const goodConfig = readFileSync(configPath, "utf8"), beforeBroken = ledger().length;
    writeFileSync(configPath, "version: 1\nurl: [unterminated\n");
    const closed = await direct({ clientId: CLIENT.ada }, body(), adaRun);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "approval_required", "a grant that was live is not honoured behind a broken configuration");
    assert.equal(ledger().length, beforeBroken, "nothing is issued while the configuration is unreadable");
    for (let attempt = 0; attempt < 50 && !facade.stderr.includes("grants reload failed"); attempt++) await new Promise((done) => setTimeout(done, 100));
    assert.ok(facade.stderr.includes(`grants reload failed for ${configPath}`), facade.stderr);
    writeFileSync(configPath, goodConfig);
    assert.equal((await direct({ clientId: CLIENT.ada }, body(), adaRun)).body.status, "granted", "restoring the configuration restores the grants");
    pass("an unreadable configuration fails closed to approval_required, logs to stderr, and recovers when restored");
  }

  // -- Suspended -----------------------------------------------------------------------------
  {
    const before = ledger().length;
    json(run(["identity", "status", "ada", "suspended", "--apply", "--json"]));
    const r = await direct({ clientId: CLIENT.ada }, body(), adaRun);
    refused(r, 403, "employee-suspended");
    assert.equal(r.body.status, "denied");
    assert.equal(ledger().length, before);
    const noLaunch = run(["access", "run", "ada", "--", process.execPath, join(dir, "dump.cjs"), join(dir, "never.json")]);
    assert.notEqual(noLaunch.status, 0);
    assert.match(noLaunch.stderr, /suspended/u);
    assert.equal(existsSync(join(dir, "never.json")), false);
    refused(await direct({ clientId: CLIENT.ada }, body(), adaRun), 403, "employee-suspended");
    json(run(["identity", "status", "ada", "active", "--apply", "--json"]));
    assert.equal((await direct({ clientId: CLIENT.ada }, body(), adaRun)).body.status, "granted");
    pass("a suspended employee is denied employee-suspended and cannot be launched; reinstating restores access");
  }

  // -- Ambiguous binding ---------------------------------------------------------------------
  {
    const before = ledger().length;
    setBinding(cyRole, binding("ada", "op://DeLoSecrets/cy-access/credential"));
    refused(await direct({ clientId: CLIENT.ada }, body(), adaRun), 403, "ambiguous-client");
    setBinding(cyRole, { plane: { principal: "unrelated" } });
    assert.equal(ledger().length, before);
    assert.equal((await direct({ clientId: CLIENT.ada }, body(), adaRun)).body.status, "granted");
    pass("a client bound to two employees is refused rather than guessed");
  }

  // -- Launch: Hermes and plain share one contract ------------------------------------------
  {
    const receipts = {};
    const hermes = await runAsync(["launch", "ada", "--", "chat"], { FIXTURE_REQUEST_ID: "hermes-request-0001" });
    assert.equal(hermes.status, 0, hermes.stdout + hermes.stderr);
    receipts.hermes = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8"));
    assert.deepEqual(receipts.hermes.args, ["--profile", "ada", "chat"]);
    const plainClient = await runAsync(["access", "run", "ada", "--", process.execPath, cli, "access", "request", "--service", "fixture", "--resource", "repo:alpha", "--permission", "read", "--request-id", "plain-request-0001"]);
    assert.equal(plainClient.status, 0, plainClient.stdout + plainClient.stderr);
    receipts.plain = JSON.parse(plainClient.stdout);
    const hermesResult = JSON.parse(receipts.hermes.request.stdout);
    assert.equal(receipts.hermes.request.status, 0);
    for (const result of [hermesResult, receipts.plain]) { assert.equal(result.status, "granted"); assert.equal(result.subject, subject.ada); assert.equal(result.evidence, "fixture"); secrets.add(result.credential.value); }
    assert.equal(hermesResult.harness, "hermes");
    assert.equal(receipts.plain.harness, "plain");
    assert.notEqual(hermesResult.run_id, receipts.plain.run_id);
    assert.match(hermesResult.run_id, /^[0-9a-f-]{36}$/u);
    // A second plain launch is another run of the same employee.
    const dump = join(dir, "plain-env.json");
    assert.equal((await runAsync(["access", "run", "ada", "--", process.execPath, join(dir, "dump.cjs"), dump])).status, 0);
    const plainEnv = JSON.parse(readFileSync(dump, "utf8")).env;
    assert.notEqual(plainEnv.FLUME_RUN_ID, receipts.plain.run_id);
    for (const [label, env] of [["hermes", receipts.hermes.env], ["plain", plainEnv]]) {
      assert.equal(env.CF_ACCESS_CLIENT_ID, CLIENT.ada, label);
      assert.equal(env.CF_ACCESS_CLIENT_SECRET, SECRET.ada, label);
      assert.equal(env.FLUME_ACCESS_URL, edge.url, label);
      assert.ok(env.FLUME_RUN_ASSERTION && env.FLUME_RUN_ASSERTION !== "foreign-run-assertion", label);
      assert.deepEqual(Object.keys(env).filter((name) => /^(OP_|FLUME_ACCESS_(CONFIG|STATE))/u.test(name)), [], `${label}: no vault or facade configuration`);
      assert.equal(env.OPENAI_API_KEY, undefined, label);
      const values = Object.values(env);
      for (const [name, value] of Object.entries(OPERATOR_ENV)) { assert.equal(env[name], undefined, `${label} inherits operator ${name}`); assert.ok(!values.includes(value), `${label} leaks the value of operator ${name}`); }
      for (const [name, value] of Object.entries(HARMLESS_ENV)) assert.equal(env[name], value, `${label} lost ${name}`);
      for (const foreign of [VAULT, SECRET.bob, "foreign-run-assertion", "foreign-inference-key", "foreign-gateway-key", CLIENT.bob]) assert.ok(!values.includes(foreign), `${label} leaks ${foreign}`);
    }
    assert.equal(receipts.hermes.env.AUTOMATICAI_GATEWAY_KEY, GATEWAY, "Hermes gets its own gateway key");
    assert.equal(plainEnv.AUTOMATICAI_GATEWAY_KEY, undefined, "a plain child gets no gateway key");
    // The post-holder uses the same contract.
    const bob = await runAsync(["access", "run", "bob-pm", "--", process.execPath, cli, "access", "request", "--service", "fixture", "--resource", "repo:alpha", "--permission", "read", "--request-id", "bob-request-0001"]);
    const bobResult = JSON.parse(bob.stdout);
    assert.equal(bobResult.subject, subject.bob);
    // The client names no one: --employee may only repeat the authenticated employee.
    const impersonate = await runAsync(["access", "run", "ada", "--", process.execPath, cli, "access", "request", "--service", "fixture", "--resource", "repo:alpha", "--permission", "read", "--employee", "bob"]);
    assert.notEqual(impersonate.status, 0);
    assert.equal(JSON.parse(impersonate.stdout).code, "employee-mismatch");
    pass("flume launch (Hermes) and flume access run (plain) give the same subject, distinct runs and harnesses, and only that employee's access");
  }

  // -- Launcher refusals ---------------------------------------------------------------------
  {
    const probe = join(dir, "refused.json");
    for (const [employee, pattern] of [["dee-pm", /not enrolled/u], ["cy-pm", /no cloudflare_access binding/u], ["nobody", /not found/u]]) {
      const r = run(["access", "run", employee, "--", process.execPath, join(dir, "dump.cjs"), probe]);
      assert.notEqual(r.status, 0, employee);
      assert.match(r.stderr, pattern, employee);
    }
    assert.equal(existsSync(probe), false, "no refused launch started a child");
    // A wrong issuer on the binding is refused too.
    setBinding(cyRole, { cloudflare_access: { principal: CLIENT.cy, instance: "https://other.cloudflareaccess.com", credential_ref: "op://DeLoSecrets/cy-access/credential" } });
    assert.match(run(["access", "run", "cy-pm", "--", process.execPath, join(dir, "dump.cjs"), probe]).stderr, /issuer does not match/u);
    // Hermes: a retired employee cannot launch.
    json(run(["identity", "status", "bob-pm", "retired", "--apply", "--json"]));
    refused(await direct({ clientId: CLIENT.bob }, body(), bobRun), 403, "employee-retired");
    assert.match(run(["access", "run", "bob-pm", "--", process.execPath, join(dir, "dump.cjs"), probe]).stderr, /retired/u);
    assert.equal(existsSync(probe), false);
    pass("unenrolled, unbound, mis-issued, unknown and inactive employees are refused by the launcher before a child starts");
  }

  // -- Client and serve guard rails ----------------------------------------------------------
  {
    const bare = run(["access", "request", "--service", "fixture", "--resource", "repo:alpha", "--permission", "read"], { FLUME_ACCESS_URL: "", CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "", FLUME_RUN_ASSERTION: "" });
    assert.notEqual(bare.status, 0);
    assert.match(JSON.parse(bare.stdout).error, /Not launched by Flume/u);
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, YAML.stringify({ version: 1, url: "http://x", cloudflare_access: { issuer, audience: AUD }, launcher: { signing_key_ref: "plaintext-not-a-ref", public_key: launcherPublic }, grants: [] }));
    const refusedServe = run(["access", "serve", "--config", bad, "--port", "0"]);
    assert.notEqual(refusedServe.status, 0);
    assert.match(refusedServe.stderr, /invalid/u);
    const notFound = await fetch(`${facade.url}/anything`);
    assert.equal(notFound.status, 404);
    assert.equal((await fetch(`${facade.url}/v1/access/requests`)).status, 405);
    // A request target the URL parser rejects answers 400 and does not take the facade down.
    const target = new URL(facade.url);
    const raw = await new Promise((done, fail) => {
      const req = httpRequest({ host: target.hostname, port: target.port, path: "//", method: "GET" }, (res) => {
        let text = "";
        res.on("data", (b) => text += b);
        res.on("end", () => done({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on("error", fail);
      req.end();
    });
    assert.equal(raw.status, 400);
    assert.equal(raw.body.code, "invalid-request");
    assert.equal((await fetch(`${facade.url}/anything`)).status, 404, "the facade keeps serving");
    // The client never follows a redirect, so the client secret and run assertion cannot be sent to another origin.
    const landed = [];
    const elsewhere = createServer((req, res) => { landed.push(req.headers); res.writeHead(200); res.end("{}"); });
    await new Promise((done) => elsewhere.listen(0, "127.0.0.1", done));
    const bounce = createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${elsewhere.address().port}/steal` }); res.end(); });
    await new Promise((done) => bounce.listen(0, "127.0.0.1", done));
    const redirected = await runAsync(["access", "request", "--service", "fixture", "--resource", "repo:alpha", "--permission", "read"], { FLUME_ACCESS_URL: `http://127.0.0.1:${bounce.address().port}`, CF_ACCESS_CLIENT_ID: "any-client", CF_ACCESS_CLIENT_SECRET: "any-secret-value", FLUME_RUN_ASSERTION: "any-run-assertion" });
    await Promise.all([new Promise((done) => elsewhere.close(done)), new Promise((done) => bounce.close(done))]);
    assert.notEqual(redirected.status, 0);
    assert.equal(JSON.parse(redirected.stdout).code, "bad-response");
    assert.deepEqual(landed, [], "the redirect target never received a request");
    pass("the client refuses outside a launcher or a redirect, an invalid configuration refuses to serve, other paths, methods and unparseable targets are refused without a crash");
  }

  // -- Readiness stays unproven --------------------------------------------------------------
  {
    const report = json(run(["identity", "readiness", "--json"], { CLOUDFLARE_API_TOKEN: "" }));
    assert.equal(report.checks.access_assertion_policy.status, "unproven");
    assert.equal(report.checks.access_assertion_policy.ready, false);
    assert.equal(report.checks.access_assertion_policy.cost, null);
    assert.equal(report.ready, false);
    pass("readiness reports access_assertion_policy as unproven");
  }

  // -- No secret at rest, in logs or in output -----------------------------------------------
  {
    const files = readdirSync(state).sort();
    assert.deepEqual(files, ["audit.jsonl", "fixture-ledger.jsonl", "idempotency.json"]);
    for (const file of files) assert.equal(statSync(join(state, file)).mode & 0o777, 0o600, `${file} is private`);
    const haystack = [...files.map((file) => readFileSync(join(state, file), "utf8")), ...facadeOutputs.flatMap((out) => [out.stdout, out.stderr]), readFileSync(configPath, "utf8"), readFileSync(registry, "utf8"), readFileSync(adaDesk, "utf8"), readFileSync(bobRole, "utf8")];
    for (const secret of secrets) {
      assert.ok(secret.length > 8);
      for (const text of haystack) assert.ok(!text.includes(secret), `a secret leaked: ${secret.slice(0, 12)}...`);
    }
    const audit = lines("audit.jsonl");
    assert.ok(audit.some((l) => l.outcome === "granted" && l.grant_id && l.subject && l.run_id));
    // Every line written after the body validated carries the scope; a grant also carries its lifetime and expiry.
    const scoped = audit.filter((l) => l.request_id);
    assert.ok(scoped.length > 10);
    for (const line of scoped) { assert.equal(typeof line.service, "string", JSON.stringify(line)); assert.equal(typeof line.resource, "string", JSON.stringify(line)); assert.ok(Array.isArray(line.permissions) && line.permissions.length, JSON.stringify(line)); }
    for (const line of audit.filter((l) => l.outcome === "granted")) { assert.equal(typeof line.lifetime_seconds, "number"); assert.ok(!Number.isNaN(Date.parse(line.expires_at))); }
    for (const outcome of ["employee-mismatch", "employee-suspended", "approval_required", "conflict"]) assert.ok(audit.some((l) => l.outcome === outcome && l.service && l.resource && l.permissions), `${outcome} audit line carries the scope`);
    assert.ok(audit.some((l) => l.replayed && l.outcome === "granted" && l.expires_at && l.lifetime_seconds), "a replay audit line carries lifetime and expiry");
    assert.ok(audit.some((l) => l.outcome === "approval_required" && l.lifetime_seconds === 7200), "an unapproved request records the requested lifetime");
    assert.ok(audit.some((l) => l.outcome === "invalid-assertion"));
    for (const entry of ledger()) assert.deepEqual(Object.keys(entry).sort(), ["at", "expires_at", "grant_id", "permissions", "provider", "request_id", "resource", "run_id", "service", "subject"]);
    assert.ok(edge.jwksFetches >= 1, "the verifier read the rotating JWKS from the issuer");
    pass("audit, idempotency, ledger and facade output hold no credential, client secret, JWT, run assertion or vault token");
  }

  console.log(`\n${count} employee access check groups passed`);
} finally {
  facade.child.removeAllListeners("close");
  facade.child.kill("SIGTERM");
  await edge.close();
  rmSync(work, { recursive: true, force: true });
}
