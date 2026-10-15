// FLUME-51 review comments with verified employee authorship, through the built `flume` CLI only.
//
// Three doubles stand in for the outside world: a fake Cloudflare Access edge (as in FLUME-48/50), a fake
// `op`, and a fake GitHub that verifies every App JWT, mints installation tokens, and now also keeps issues,
// one pull request, comments and bot users. It records every call (who, what, which kind of credential) and
// can be told to misbehave. Product code is the same in fixture and live; only FLUME_GITHUB_API_BASE differs,
// and with it `evidence`. Every key, JWT and token the suite sees is collected and then scanned for in
// everything any process printed and every file the facade or the CLI wrote.
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
const work = mkdtempSync("/tmp/flume51-");
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

const AUD = "aud-fixture-tag";
const NAMES = ["ada", "bob", "cy", "dan", "fay", "gus", "hal"];
const CLIENT = Object.fromEntries(NAMES.map((n) => [n, `${n}-client-id.access`]));
const SECRET = Object.fromEntries(NAMES.map((n) => [n, `${n}-client-secret-value`]));
const VAULT = "vault-service-token-value";
const SIGNING_REF = "op://DeLoSecrets/flume-launcher/signing-key";
/** Everything secret the suite ever sees; scanned for in every artifact at the end. */
const secrets = new Set([VAULT, ...Object.values(SECRET)]);
const OPERATOR_GH = { GH_TOKEN: "operator-gh-token-canary-value", GITHUB_TOKEN: "operator-github-token-canary-value" };
for (const value of Object.values(OPERATOR_GH)) secrets.add(value);
const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);

const launcher = generateKeyPairSync("ed25519");
const launcherPrivate = launcher.privateKey.export({ type: "pkcs8", format: "pem" });
const launcherPublic = launcher.publicKey.export({ type: "spki", format: "pem" });
secrets.add(launcherPrivate.split("\n")[1]);

// -- the GitHub Apps and their bot users --------------------------------------------------------------
const item = (name) => `${name}${"0".repeat(26)}`.slice(0, 26);
const refFor = (name, field = "privatekeyfield") => `op://DeLoSecrets/${item(name)}/${field}`;
const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const APPS = Object.fromEntries(["ada", "bob", "cy", "dan", "fay"].map((name, index) => [name, { id: String(1001 + index), slug: `${name}-app`, installation: String(2001 + index), bot: 9001 + index, key: rsa() }]));
for (const app of Object.values(APPS)) secrets.add(app.key.privateKey.split("\n")[1]);
const botLogin = (name) => `${APPS[name].slug}[bot]`;
const PERMS = ["issues:write", "pull_requests:write"];

// -- fake GitHub API ----------------------------------------------------------------------------------
async function fakeGithub() {
  const apps = new Map();
  for (const [name, app] of Object.entries(APPS)) {
    apps.set(app.id, {
      name, ...app, publicKeys: [await importSPKI(app.key.publicKey, "RS256")],
      installations: new Map([[app.installation, { id: Number(app.installation), account: { login: "o", type: "Organization" }, repository_selection: "selected", suspended_at: null, permissions: { issues: "write", pull_requests: "write", metadata: "read" }, repos: ["sandbox"] }]]),
    });
  }
  const gh = { url: "", calls: [], minted: new Map(), jwts: new Set(), sockets: new Set(), ids: 0, apps, mode: {}, users: new Map(), comments: [], nextComment: 5000, targets: new Map([["3", "issue"], ["4", "issue"], ["5", "issue"], ["6", "issue"], ["7", "pull"]]) };
  gh.reset = () => { gh.mode = {}; };
  for (const [name, app] of Object.entries(APPS)) gh.users.set(botLogin(name), { id: app.bot, login: botLogin(name), type: "Bot" });
  gh.users.set("grolf", { id: 77, login: "grolf", type: "User" });
  const sendJson = (res, status, body, extra = {}) => {
    res.writeHead(status, { "content-type": "application/json", "x-github-request-id": `REQ-${++gh.ids}`, ...extra });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const shape = (c) => {
    const user = typeof c.user === "string" ? gh.users.get(c.user) : c.user;
    return {
      id: c.id, body: c.body, html_url: `https://github.example/o/sandbox/${c.kind === "issue" ? "issues" : "pull"}/${c.number}#comment-${c.id}`, user: { ...user },
      ...(c.kind === "issue" ? { issue_url: `${gh.url}/repos/o/sandbox/issues/${c.number}`, performed_via_github_app: c.app ? { id: Number(c.app) } : null }
        : { pull_request_url: `${gh.url}/repos/o/sandbox/pulls/${c.number}`, path: c.path, line: c.line, side: c.side, commit_id: c.commit_id, performed_via_github_app: null }),
    };
  };
  /** Store a comment as if somebody had already written it. */
  gh.seed = ({ kind = "issue", number, user, body, ...rest }) => {
    const comment = { id: gh.nextComment++, kind, number: String(number), user, body, ...rest };
    gh.comments.push(comment);
    return comment.id;
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
        for (const key of app.publicKeys) { try { await jwtVerify(jwt, key, { algorithms: ["RS256"] }); verified = true; break; } catch { /* next */ } }
        if (!verified) throw new Error("bad signature");
      } catch {
        return sendJson(res, 401, { message: "A JSON web token could not be decoded" });
      }
    } else if (/^token /iu.test(authorization)) {
      call.kind = "token";
      call.token = authorization.replace(/^token /iu, "");
    }
    const match = (pattern) => new RegExp(`^${pattern}$`, "u").exec(`${call.method} ${call.path}`);
    const need = () => (app ? true : (sendJson(res, 401, { message: "Requires authentication" }), false));
    let m;
    if (match("GET /app")) {
      if (!need()) return;
      return sendJson(res, 200, { id: Number(app.id), slug: app.slug, name: `${app.name} App`, client_id: `Iv1.${app.name}`, owner: { login: "o", type: "Organization" } });
    }
    if ((m = match("GET /users/([^/]+)"))) {
      // The actor lookup is PUBLIC: any credential here would be a leak.
      const login = decodeURIComponent(m[1]);
      const user = gh.users.get(login);
      if (!user) return sendJson(res, 404, { message: "Not Found" });
      return sendJson(res, 200, { ...user, ...(gh.mode.userOverride?.[login] ?? {}) });
    }
    if ((m = match("GET /app/installations/(\\d+)"))) {
      if (!need()) return;
      const installation = app.installations.get(m[1]);
      if (!installation) return sendJson(res, 404, { message: "Not Found" });
      const { repos: _repos, ...visible } = installation;
      return sendJson(res, 200, visible);
    }
    if ((m = match("POST /app/installations/(\\d+)/access_tokens"))) {
      if (!need()) return;
      const installation = app.installations.get(m[1]);
      if (!installation) return sendJson(res, 404, { message: "Not Found" });
      const canonical = (name) => installation.repos.find((repo) => repo.toLowerCase() === String(name).toLowerCase());
      const requestedNames = call.body.repositories ?? [];
      if (requestedNames.some((name) => !canonical(name))) return sendJson(res, 422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      const requested = call.body.permissions ?? {};
      const token = `ghs_${randomBytes(20).toString("hex")}`;
      secrets.add(token);
      const expiresMs = Date.now() + 3600 * 1000;
      const returned = { ...requested, metadata: "read" };
      gh.minted.set(token, { app: app.id, name: app.name, installation: m[1], repos: requestedNames.map(canonical), permissions: returned, expiresMs, revoked: false });
      return sendJson(res, 201, { token, expires_at: new Date(expiresMs).toISOString(), permissions: returned, repository_selection: "selected", repositories: requestedNames.map(canonical).map((name) => ({ id: 1, name, full_name: `o/${name}` })) });
    }

    // -- comments (installation tokens only) ------------------------------------------------------------
    const entry = call.kind === "token" ? gh.minted.get(call.token) : undefined;
    const live = entry && !entry.revoked && entry.expiresMs >= Date.now() ? entry : undefined;
    const level = (name) => ({ read: 1, write: 2, admin: 3 })[live?.permissions?.[name] ?? ""] ?? 0;
    const route = match("(GET|POST) /repos/o/([^/]+)/(issues|pulls)/(\\d+)/comments") ?? match("GET /repos/o/([^/]+)/(issues|pulls)/comments/(\\d+)") ?? match("GET /repos/o/([^/]+)/pulls/(\\d+)");
    if (route) {
      if (!live) return sendJson(res, 401, { message: "Bad credentials" });
      const isList = call.path.endsWith("/comments") && !/\/comments\/\d+$/u.test(call.path);
      const isOne = /\/comments\/\d+$/u.test(call.path);
      const [repoName, family] = isList ? [route[2], route[3]] : isOne ? [route[1], route[2]] : [route[1], "pulls"];
      const number = isList ? route[4] : isOne ? undefined : route[2];
      if (!live.repos.includes(repoName)) return sendJson(res, 404, { message: "Not Found" });
      const permission = family === "issues" ? "issues" : "pull_requests";
      if (isOne) {
        const found = gh.comments.find((c) => String(c.id) === route[3] && c.kind === (family === "issues" ? "issue" : "review"));
        if (level(permission) < 1) return sendJson(res, 403, { message: "Resource not accessible by integration" });
        return found ? sendJson(res, 200, shape(found)) : sendJson(res, 404, { message: "Not Found" });
      }
      const target = gh.targets.get(number);
      if (!target || (family === "pulls" && target !== "pull")) return sendJson(res, 404, { message: "Not Found" });
      if (!isList) { // GET the pull request itself
        if (level("pull_requests") < 1) return sendJson(res, 403, { message: "Resource not accessible by integration" });
        return sendJson(res, 200, { number: Number(number), head: { sha: gh.mode.headSha ?? HEAD } });
      }
      if (call.method === "GET") {
        if (level(permission) < 1) return sendJson(res, 403, { message: "Resource not accessible by integration" });
        if (gh.mode.commentRedirect) { res.writeHead(307, { location: gh.mode.commentRedirect }); return res.end(); }
        const all = gh.comments.filter((c) => c.number === number && c.kind === (family === "issues" ? "issue" : "review"));
        const perPage = Number(url.searchParams.get("per_page") ?? 30), page = Number(url.searchParams.get("page") ?? 1);
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const more = page * perPage < all.length;
        return sendJson(res, 200, slice.map(shape), more ? { link: `<${gh.url}${call.path}?per_page=${perPage}&page=${page + 1}>; rel="next"` } : {});
      }
      // POST
      if (level(permission === "issues" ? "issues" : "pull_requests") < 2) return sendJson(res, 403, { message: "Resource not accessible by integration" });
      if (gh.mode.commentPost === "500") return sendJson(res, 500, { message: "Server Error" });
      const review = family === "pulls";
      if (review) {
        const { commit_id, path, line, side } = call.body;
        if (!commit_id || path !== "proof.txt" || !(line >= 1 && line <= 3) || !["RIGHT", "LEFT"].includes(side)) return sendJson(res, 422, { message: "Unprocessable Entity\npull_request_review_thread.line must be part of the diff" });
      }
      const comment = { id: gh.nextComment++, kind: review ? "review" : "issue", number, user: botLogin(live.name), body: call.body.body, app: live.app,
        ...(review ? { path: call.body.path, line: gh.mode.locationDrift ? call.body.line + 1 : call.body.line, side: call.body.side, commit_id: call.body.commit_id } : {}) };
      gh.comments.push(comment);
      if (gh.mode.commentPost === "hang-after-store") { gh.sockets.add(res.socket); return; }
      if (gh.mode.commentPost === "500-after-store") return sendJson(res, 500, { message: "Server Error" });
      return sendJson(res, 201, shape(comment));
    }
    return sendJson(res, 404, { message: "Not Found" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  gh.url = `http://127.0.0.1:${server.address().port}`;
  gh.close = () => { for (const socket of gh.sockets) socket.destroy(); return new Promise((done) => server.close(done)); };
  gh.mark = () => gh.calls.length;
  gh.since = (mark) => gh.calls.slice(mark);
  return gh;
}

// -- fake Cloudflare Access edge ----------------------------------------------------------------------
async function fakeEdge() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "edge-1", alg: "RS256", use: "sig" };
  const clients = new Map(NAMES.map((name) => [CLIENT[name], SECRET[name]]));
  const edge = { origin: "", url: "" };
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

// -- fixture ------------------------------------------------------------------------------------------
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
// Records only the FLUME_ identity environment it was handed.
writeFileSync(join(dir, "envconsumer.cjs"), `const fs = require("fs");
fs.writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(["FLUME_EMPLOYEE_SUBJECT", "FLUME_GITHUB_REPOSITORY", "FLUME_GITHUB_APP_ID", "FLUME_GITHUB_INSTALLATION_ID", "FLUME_GRANT_ID"].map((k) => [k, process.env[k]]))));
`);

const edge = await fakeEdge();
const gh = await fakeGithub();
const issuer = edge.url;
const opMap = {
  [SIGNING_REF]: launcherPrivate,
  ...Object.fromEntries(NAMES.map((n) => [`op://DeLoSecrets/${n}-access/credential`, SECRET[n]])),
  ...Object.fromEntries(Object.entries(APPS).map(([n, app]) => [refFor(n), app.key.privateKey])),
};
writeFileSync(join(dir, "op.json"), JSON.stringify(opMap));
const baseEnv = {
  ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
  HERMES_TEMPLATE_CONFIG: join(dir, "no-config"), HERMES_FLEET_ENV: join(dir, "no-env"),
  XDG_STATE_HOME: join(home, ".local/state"), PYTHONDONTWRITEBYTECODE: "1",
  PATH: `${bin}:${process.env.PATH}`, FLUME_ACCESS_CONFIG: configPath, FLUME_ACCESS_STATE: state,
  OP_SERVICE_ACCOUNT_TOKEN: VAULT, OP_FIXTURE: join(dir, "op.json"), OP_LOG: opLog,
  FLUME_GITHUB_API_BASE: gh.url, FLUME_GITHUB_TIMEOUT_MS: "1500", ...OPERATOR_GH,
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
/** `flume ...` that talks to the fake GitHub, parsed as JSON. */
const flume = async (args, status = 0, extra = {}) => json(await runAsync(args, extra), status);

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
post("ivy-pm", "ivy"); // a post-holder who is never enrolled
setBindings(roles.ada, { cloudflare_access: cfBinding("ada"), github: ghBinding("ada") });
setBindings(roles.bob, { cloudflare_access: cfBinding("bob"), github: ghBinding("bob") });
setBindings(roles.cy, { cloudflare_access: cfBinding("cy"), github: ghBinding("cy", { attribution_mode: "shared_bot_attributed" }) });
setBindings(roles.dan, { cloudflare_access: cfBinding("dan"), github: ghBinding("dan", { attribution_mode: "shared_bot_attributed" }) });
setBindings(roles.fay, { cloudflare_access: cfBinding("fay"), github: ghBinding("fay") }); // bound, never adopted
setBindings(roles.gus, { cloudflare_access: cfBinding("gus") }); // no github binding
setBindings(roles.hal, { cloudflare_access: cfBinding("hal"), github: { principal: "1999", instance: "2999", credential_ref: refFor("hal"), attribution_mode: "native" } });
json(run(["identity", "status", "hal-pm", "retired", "--apply", "--json"]));

const gh_ = (name) => ({ subject: subject[name], service: "github", resource: "o/sandbox", permissions: ["issues:write", "issues:read", "pull_requests:write", "pull_requests:read"], max_lifetime_seconds: 3600 });
writeFileSync(configPath, YAML.stringify({
  version: 1, url: edge.url, listen: { host: "127.0.0.1", port: 0 }, cloudflare_access: { issuer, audience: AUD },
  launcher: { signing_key_ref: SIGNING_REF, public_key: launcherPublic }, grants: ["ada", "bob", "cy", "fay"].map(gh_),
}));

// -- facade process -----------------------------------------------------------------------------------
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
edge.origin = facade.url;

// -- helpers over the real chain: launcher -> Access edge -> facade -> App token -> `flume comment` -----
/** `flume access run <e> -- flume access request --service github --exec -- flume comment <args>`; stdout is the comment command's. */
const viaFlume = (name, commentArgs, { permissions = PERMS, extra = {} } = {}) => runAsync(
  ["access", "run", `${name}-pm`, "--", process.execPath, cli, "access", "request", "--service", "github", "--resource", "o/sandbox", ...permissions.flatMap((p) => ["--permission", p]), "--exec", "--", process.execPath, cli, "comment", ...commentArgs], extra);
const comment = async (name, args, status = 0, options) => json(await viaFlume(name, args, options), status);
const posted = (name, number, text, extraArgs = [], status = 0, options) => comment(name, ["post", "o/sandbox", String(number), "--body", text, ...extraArgs, "--json"], status, options);
const verify = (name, specs, status = 0) => comment(name, ["verify", "o/sandbox", ...specs.flatMap((s) => ["--comment", s]), "--json"], status);
const tokenCalls = (mark) => gh.since(mark).filter((c) => c.kind === "token");
const commentPosts = (mark) => tokenCalls(mark).filter((c) => c.method === "POST");
const routes = (mark) => tokenCalls(mark).map((c) => `${c.method} ${c.path}`);
const stored = (marker) => gh.comments.filter((c) => typeof c.body === "string" && c.body.includes(`<!-- flume-comment:${marker} -->`));
/** The consumer's environment, as `access request --exec` builds it, without going through the facade. */
const directEnv = (name, overrides = {}) => ({ GH_TOKEN: "direct-run-token-not-a-real-credential", FLUME_EMPLOYEE_SUBJECT: subject[name], FLUME_GITHUB_REPOSITORY: "o/sandbox", FLUME_GITHUB_APP_ID: APPS[name].id, FLUME_GITHUB_INSTALLATION_ID: APPS[name].installation, ...overrides });
const definitionText = (name) => readFileSync(roles[name], "utf8");
const authorOf = (r) => r.comment.author;

try {
  // -- the optional field is additive and validated ---------------------------------------------------------
  {
    setBindings(roles.fay, { cloudflare_access: cfBinding("fay"), github: ghBinding("fay", { native_actor_id: "not-digits" }) });
    const bad = json(run(["identity", "show", "fay-pm", "--json"]), 1);
    assert.ok(bad.blockers.some((b) => b.code === "invalid-definition"), "a non-numeric native_actor_id is refused by the schema");
    setBindings(roles.fay, { cloudflare_access: cfBinding("fay"), github: ghBinding("fay", { native_actor_id: "9005" }) });
    assert.equal(json(run(["identity", "show", "fay-pm", "--json"])).identity.bindings.github.native_actor_id, "9005", "a numeric string is valid on a block that stays version 1");
    assert.equal(json(run(["identity", "show", "fay-pm", "--json"])).identity.version, 1);
    setBindings(roles.fay, { cloudflare_access: cfBinding("fay"), github: ghBinding("fay") });
    pass("native_actor_id is an optional ^\\d+$ string on the binding; existing definitions stay valid");
  }

  // -- adopt-actor -------------------------------------------------------------------------------------------
  {
    const mark = gh.mark(), before = definitionText("ada");
    const preview = await flume(["identity", "adopt-actor", "ada-pm", "github", "--json"]);
    assert.equal(preview.ok, true);
    assert.equal(preview.changed, true);
    assert.equal(preview.apply, false);
    assert.deepEqual(preview.actor, { id: String(APPS.ada.bot), login: botLogin("ada"), type: "Bot", app_id: APPS.ada.id });
    assert.equal(preview.evidence, "fixture");
    assert.equal(definitionText("ada"), before, "a preview writes nothing");
    const traffic = gh.since(mark);
    assert.deepEqual(traffic.map((c) => `${c.method} ${decodeURIComponent(c.path)}`), ["GET /app", `GET /users/${botLogin("ada")}`], "slug from the App JWT, then the public user lookup");
    assert.deepEqual(traffic.map((c) => c.kind), ["jwt", "none"], "the user lookup carries no credential at all");

    const applied = await flume(["identity", "adopt-actor", "ada-pm", "github", "--apply", "--json"]);
    assert.equal(applied.ok, true);
    assert.equal(applied.changed, true);
    assert.deepEqual(applied.writes, [roles.ada]);
    const shown = json(run(["identity", "show", "ada-pm", "--json"])).identity.bindings.github;
    assert.deepEqual(shown, ghBinding("ada", { native_actor_id: String(APPS.ada.bot) }), "only native_actor_id was added to the binding");
    assert.equal((await flume(["identity", "adopt-actor", "ada-pm", "github", "--apply", "--json"])).changed, false, "re-adopting the same ID is a no-op");
    assert.equal(gh.since(mark).filter((c) => c.method !== "GET").length, 0, "adoption never mints, writes or posts");

    // conflict: a different ID is stored
    gh.mode.userOverride = { [botLogin("ada")]: { id: 424242 } };
    const afterApply = definitionText("ada");
    const conflict = await flume(["identity", "adopt-actor", "ada-pm", "github", "--apply", "--json"], 1);
    assert.ok(conflict.blockers.some((b) => b.code === "native-actor-conflict"));
    assert.equal(definitionText("ada"), afterApply);
    // not a Bot / a different login
    const bobBefore = definitionText("bob");
    gh.mode.userOverride = { [botLogin("bob")]: { type: "User" } };
    assert.ok((await flume(["identity", "adopt-actor", "bob-pm", "github", "--apply", "--json"], 1)).blockers.some((b) => b.code === "actor-not-bot"));
    gh.mode.userOverride = { [botLogin("bob")]: { login: "someone-else" } };
    assert.ok((await flume(["identity", "adopt-actor", "bob-pm", "github", "--apply", "--json"], 1)).blockers.some((b) => b.code === "actor-login-mismatch"));
    assert.equal(definitionText("bob"), bobBefore, "a refused adoption writes nothing");
    // duplicate: GitHub says bob's bot is ada's actor
    gh.mode.userOverride = { [botLogin("bob")]: { id: APPS.ada.bot } };
    assert.ok((await flume(["identity", "adopt-actor", "bob-pm", "github", "--apply", "--json"], 1)).blockers.some((b) => b.code === "native-actor-duplicate"));
    assert.equal(definitionText("bob"), bobBefore);
    gh.reset();
    assert.equal((await flume(["identity", "adopt-actor", "bob-pm", "github", "--apply", "--json"])).changed, true);
    // cy is shared_bot_attributed but ada is native: still a duplicate; two shared bindings may share an actor
    gh.mode.userOverride = { [botLogin("cy")]: { id: APPS.ada.bot } };
    assert.ok((await flume(["identity", "adopt-actor", "cy-pm", "github", "--apply", "--json"], 1)).blockers.some((b) => b.code === "native-actor-duplicate"), "shared vs native is still a duplicate");
    gh.reset();
    assert.equal((await flume(["identity", "adopt-actor", "cy-pm", "github", "--apply", "--json"])).changed, true);
    gh.mode.userOverride = { [botLogin("dan")]: { id: APPS.cy.bot } };
    const shared = await flume(["identity", "adopt-actor", "dan-pm", "github", "--apply", "--json"]);
    assert.equal(shared.changed, true, "two shared_bot_attributed bindings may name one actor");
    gh.reset();

    // refused: unbound, retired, unenrolled, unknown provider, unreadable key
    const mark2 = gh.mark();
    assert.ok((await flume(["identity", "adopt-actor", "gus-pm", "github", "--apply", "--json"], 1)).blockers.some((b) => b.code === "no-provider-binding"));
    assert.ok((await flume(["identity", "adopt-actor", "hal-pm", "github", "--apply", "--json"], 1)).blockers.some((b) => b.code === "retired-terminal"));
    assert.ok((await flume(["identity", "adopt-actor", "ivy-pm", "github", "--apply", "--json"], 1)).blockers.some((b) => b.code === "not-enrolled"));
    assert.ok((await flume(["identity", "adopt-actor", "ada-pm", "plane", "--json"], 1)).blockers.some((b) => b.code === "unsupported-provider"));
    assert.equal((await flume(["identity", "adopt-actor", "nobody-pm", "github", "--json"], 1)).ok, false);
    assert.equal(gh.since(mark2).length, 0, "no refusal reached GitHub");
    assert.equal(definitionText("fay").includes("native_actor_id"), false, "fay stays un-adopted for the not-adopted scenarios");
    pass("adopt-actor previews by default, reads the slug with the App JWT and the public bot user, writes only native_actor_id under the lock, and blocks conflicts, duplicates, non-Bots and bad employees");
  }

  // -- the exec environment -----------------------------------------------------------------------------------
  {
    const receipt = join(dir, "env-ada.json");
    const r = await runAsync(["access", "run", "ada-pm", "--", process.execPath, cli, "access", "request", "--service", "github", "--resource", "o/sandbox", "--permission", "issues:write", "--exec", "--", process.execPath, join(dir, "envconsumer.cjs"), receipt],
      { FLUME_EMPLOYEE_SUBJECT: "spoofed-subject", FLUME_GITHUB_REPOSITORY: "x/y", FLUME_GITHUB_APP_ID: "0", FLUME_GITHUB_INSTALLATION_ID: "0" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const seen = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(seen.FLUME_EMPLOYEE_SUBJECT, subject.ada, "taken from the granted body, not the caller's environment");
    assert.equal(seen.FLUME_GITHUB_REPOSITORY, "o/sandbox");
    assert.equal(seen.FLUME_GITHUB_APP_ID, APPS.ada.id);
    assert.equal(seen.FLUME_GITHUB_INSTALLATION_ID, APPS.ada.installation);
    assert.equal(seen.FLUME_GRANT_ID, JSON.parse(r.stderr).grant_id, "the FLUME-50 exec contract is unchanged");
    pass("--exec exports the granted subject, repository, App ID and installation ID, overriding anything the caller set");
  }

  // -- two native employees, posted and verified ----------------------------------------------------------------
  const first = {}; // comment ids by employee
  {
    const mark = gh.mark();
    const ada = await posted("ada", 3, "ada says hello");
    assert.equal(ada.ok, true);
    assert.equal(ada.status, "verified");
    assert.equal(ada.authorship, "native-verified");
    assert.equal(ada.reconciled, false);
    assert.equal(ada.evidence, "fixture");
    assert.deepEqual(authorOf(ada), { id: String(APPS.ada.bot), login: botLogin("ada"), type: "Bot" });
    assert.equal(ada.comment.performed_via_github_app_id, APPS.ada.id, "performed_via_github_app.id is recorded when GitHub returns it");
    assert.deepEqual(ada.comment.location, { number: "3" });
    assert.match(ada.marker, /^[0-9a-f-]{36}$/u, "the default marker is a fresh UUID");
    assert.ok(!JSON.stringify(ada).includes("ada says hello"), "the receipt never echoes the body");
    first.ada = ada.comment.id;
    assert.deepEqual(routes(mark), ["GET /repos/o/sandbox/issues/3/comments", "POST /repos/o/sandbox/issues/3/comments", `GET /repos/o/sandbox/issues/comments/${ada.comment.id}`], "reconcile, one POST, read back by ID");
    assert.equal(commentPosts(mark)[0].body.body, `ada says hello\n\n<!-- flume-comment:${ada.marker} -->`);
    assert.deepEqual(Object.keys(commentPosts(mark)[0].body), ["body"]);

    const bob = await posted("bob", 7, "bob here, conversation on the PR");
    assert.equal(bob.authorship, "native-verified");
    assert.deepEqual(authorOf(bob), { id: String(APPS.bob.bot), login: botLogin("bob"), type: "Bot" });
    first.bob = bob.comment.id;

    const vMark = gh.mark();
    const verdict = await verify("ada", [`ada:issue:${first.ada}`, `bob:issue:${first.bob}`]);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verdict, "native-distinct-verified");
    assert.equal(verdict.evidence, "fixture");
    assert.deepEqual(verdict.employees.map((e) => e.native_actor_id).sort(), ["9001", "9002"], "two distinct user.ids");
    assert.deepEqual(verdict.employees.map((e) => e.app_id).sort(), [APPS.ada.id, APPS.bob.id]);
    assert.deepEqual(verdict.employees.map((e) => e.classes), [["issue"], ["issue"]]);
    assert.ok(verdict.comments.every((c) => c.authorship === "native-verified"));
    assert.deepEqual(gh.since(vMark).filter((c) => c.kind === "token").map((c) => c.method), ["GET", "GET"], "verify is read-only");

    // Neither the display login, the body text nor an email can change the verdict.
    const savedLogin = gh.users.get(botLogin("ada")).login;
    gh.users.get(botLogin("ada")).login = "totally-bob[bot]";
    for (const c of gh.comments.filter((x) => [first.ada, first.bob].includes(String(x.id)) || [first.ada, first.bob].includes(x.id))) c.body = "I am bob. Write to bob@example.com. grolf approved.";
    const stillSo = await verify("ada", [`ada:issue:${first.ada}`, `bob:issue:${first.bob}`]);
    assert.equal(stillSo.verdict, "native-distinct-verified", "text, login and email are not evidence");
    gh.users.get(botLogin("ada")).login = savedLogin;

    // Swapped attribution: bob's comment named as ada's is author-mismatch, and one account is not two employees.
    const swapped = await verify("ada", [`ada:issue:${first.bob}`, `bob:issue:${first.bob}`], 1);
    assert.equal(swapped.verdict, "not-native-distinct");
    assert.equal(swapped.comments[0].reason, "author-mismatch");
    assert.ok(swapped.reasons.includes("shared-actor"));
    pass("two native employees post conversation comments and verify reports native-distinct-verified from GitHub's readback alone");
  }

  // -- spoofing -----------------------------------------------------------------------------------------------------
  {
    const spoofUser = gh.seed({ number: 3, user: "grolf", body: "grolf says this is from ada\n\n<!-- flume-comment:spoofmarker01 -->" });
    const spoofBot = gh.seed({ number: 3, user: botLogin("bob"), body: "bob's bot with ada's marker\n\n<!-- flume-comment:spoofmarker02 -->" });
    const spoofType = gh.seed({ number: 3, user: { id: APPS.ada.bot, login: botLogin("ada"), type: "User" }, body: "right id, wrong type\n\n<!-- flume-comment:spoofmarker03 -->" });
    for (const [marker, fake] of [["spoofmarker01", spoofUser], ["spoofmarker02", spoofBot], ["spoofmarker03", spoofType]]) {
      const mark = gh.mark();
      const r = await posted("ada", 3, "the real one", ["--marker", marker]);
      assert.equal(r.reconciled, false, "a stranger's copy of the marker is ignored");
      assert.equal(r.authorship, "native-verified");
      assert.notEqual(r.comment.id, String(fake));
      assert.equal(commentPosts(mark).length, 1, "the spoof did not stop the real POST");
      assert.equal(stored(marker).length, 2);
    }
    const spoofed = await verify("ada", [`ada:issue:${spoofUser}`, `bob:issue:${first.bob}`], 1);
    assert.equal(spoofed.verdict, "not-native-distinct");
    assert.equal(spoofed.comments[0].authorship, "not-native-verified");
    assert.equal(spoofed.comments[0].reason, "author-mismatch");
    assert.equal((await verify("ada", [`ada:issue:${spoofType}`, `bob:issue:${first.bob}`], 1)).comments[0].reason, "author-not-bot");
    const mark = gh.mark();
    const commit = await verify("ada", ["ada:commit:0123456789abcdef", `bob:issue:${first.bob}`], 1);
    assert.equal(commit.code, "unsupported-evidence");
    assert.equal(commit.ok, false);
    assert.equal(tokenCalls(mark).length, 0, "commit metadata is refused before any readback");
    assert.equal((await verify("ada", ["ada:email:ada@agents.delo.sh", `bob:issue:${first.bob}`], 1)).code, "unsupported-evidence");
    pass("a copied marker, a bot with the right id but the wrong type, and commit or email evidence never become authorship");
  }

  // -- inline review comment --------------------------------------------------------------------------------------
  let reviewId;
  {
    const mark = gh.mark();
    const args = ["--review", "--commit", HEAD, "--path", "proof.txt", "--line", "2", "--marker", "inline-marker-1"];
    const inline = await posted("ada", 7, "inline remark", args);
    assert.equal(inline.ok, true, JSON.stringify(inline));
    assert.equal(inline.authorship, "native-verified");
    assert.deepEqual(inline.comment.location, { pull_number: "7", path: "proof.txt", line: 2, side: "RIGHT", commit_id: HEAD });
    assert.equal(inline.comment.performed_via_github_app_id, undefined, "review comments do not reliably carry the App, so it is never required");
    assert.deepEqual(authorOf(inline), { id: String(APPS.ada.bot), login: botLogin("ada"), type: "Bot" });
    reviewId = inline.comment.id;
    assert.deepEqual(routes(mark), ["GET /repos/o/sandbox/pulls/7/comments", "GET /repos/o/sandbox/pulls/7", "POST /repos/o/sandbox/pulls/7/comments", `GET /repos/o/sandbox/pulls/comments/${reviewId}`]);
    assert.deepEqual(commentPosts(mark)[0].body, { body: "inline remark\n\n<!-- flume-comment:inline-marker-1 -->", commit_id: HEAD, path: "proof.txt", line: 2, side: "RIGHT" });

    const again = gh.mark();
    const repeat = await posted("ada", 7, "inline remark", args);
    assert.equal(repeat.reconciled, true);
    assert.equal(repeat.comment.id, reviewId);
    assert.equal(commentPosts(again).length, 0, "a re-run reconciles to the same comment");
    assert.equal(tokenCalls(again).filter((c) => c.path === "/repos/o/sandbox/pulls/7").length, 0, "no preflight once the comment exists");

    const verdict = await verify("ada", [`ada:issue:${first.ada}`, `ada:review:${reviewId}`, `bob:issue:${first.bob}`]);
    assert.equal(verdict.verdict, "native-distinct-verified");
    assert.deepEqual(verdict.employees.find((e) => e.handle === "ada").classes, ["issue", "review"], "the report lists the comment classes covered");
    pass("an inline review comment on the PR head reads back with matching author, PR, path, line, side and commit, and a re-run reconciles instead of posting");
  }

  // -- review failures -----------------------------------------------------------------------------------------------
  {
    const reviewArgs = (extra = []) => ["--review", "--commit", HEAD, "--path", "proof.txt", "--line", "2", ...extra];
    let mark = gh.mark();
    const stale = await posted("ada", 7, "x", ["--review", "--commit", OLD_HEAD, "--path", "proof.txt", "--line", "2"], 1);
    assert.equal(stale.code, "stale-commit");
    assert.equal(stale.head_sha, HEAD);
    assert.equal(commentPosts(mark).length, 0);
    mark = gh.mark();
    const outside = await posted("ada", 7, "x", ["--review", "--commit", HEAD, "--path", "proof.txt", "--line", "9", "--marker", "outside-diff-1"], 1);
    assert.equal(outside.code, "invalid-position");
    assert.equal(commentPosts(mark).length, 1);
    assert.equal(stored("outside-diff-1").length, 0);
    mark = gh.mark();
    const readOnly = await posted("ada", 7, "x", [...reviewArgs(), "--marker", "readonly-token-1"], 1, { permissions: ["issues:write", "pull_requests:read"] });
    assert.equal(readOnly.code, "insufficient-permissions");
    assert.equal(commentPosts(mark).length, 1);
    assert.equal(stored("readonly-token-1").length, 0);
    for (const extra of [["--start-line", "1"], ["--position", "2"], ["--event", "REQUEST_CHANGES"], ["--subject-type", "file"]]) {
      mark = gh.mark();
      const refused = await posted("ada", 7, "x", [...reviewArgs(), ...extra], 1);
      assert.equal(refused.code, "unsupported-review-mode", extra[0]);
      assert.equal(tokenCalls(mark).length, 0, `${extra[0]} is refused before any call to the repository`);
    }
    for (const partial of [["--review", "--path", "proof.txt", "--line", "2"], ["--review", "--commit", HEAD, "--line", "2"], ["--review", "--commit", HEAD, "--path", "proof.txt"]]) {
      mark = gh.mark();
      assert.equal((await posted("ada", 7, "x", partial, 1)).code, "unsupported-review-mode");
      assert.equal(tokenCalls(mark).length, 0);
    }
    assert.equal((await posted("ada", 7, "x", ["--commit", HEAD], 1)).code, "invalid-arguments", "review flags without --review");
    gh.mode.locationDrift = true;
    mark = gh.mark();
    const drift = await posted("ada", 7, "x", [...reviewArgs(), "--marker", "drifted-line-1"], 1);
    gh.reset();
    assert.equal(drift.status, "unverified");
    assert.equal(drift.code, "location-mismatch");
    assert.equal(drift.ok, false);
    assert.equal(commentPosts(mark).length, 1);
    assert.equal((await posted("ada", 999, "x", [...reviewArgs(), "--marker", "missing-target-1"], 1)).code, "target-not-found");
    assert.equal((await posted("ada", 999, "x", [], 1)).code, "target-not-found");
    pass("stale head, a line outside the diff, missing pull_requests:write, a drifted location, a missing target and every unsupported review mode fail with their explicit code");
  }

  // -- timeouts and ambiguity ----------------------------------------------------------------------------------------
  {
    for (const mode of ["hang-after-store", "500-after-store"]) {
      const marker = `timeout-created-${mode.length}`;
      gh.mode.commentPost = mode;
      const mark = gh.mark();
      const created = await posted("ada", 3, "stored then the answer was lost", ["--marker", marker]);
      gh.reset();
      assert.equal(created.ok, true, `${mode}: ${JSON.stringify(created)}`);
      assert.equal(created.reconciled, true, mode);
      assert.equal(created.authorship, "native-verified");
      assert.equal(commentPosts(mark).length, 1, `${mode}: exactly one POST`);
      assert.equal(stored(marker).length, 1);
    }
    gh.mode.commentPost = "500";
    let mark = gh.mark();
    const lost = await posted("ada", 3, "never stored", ["--marker", "timeout-lost-001"], 1);
    gh.reset();
    assert.equal(lost.status, "unverified");
    assert.equal(lost.code, "comment-ambiguous");
    assert.equal(lost.marker, "timeout-lost-001", "the caller gets the marker to re-run with");
    assert.equal(commentPosts(mark).length, 1, "never a second POST in the same invocation");
    assert.equal(stored("timeout-lost-001").length, 0);
    assert.equal(tokenCalls(mark).filter((c) => c.method === "GET").length, 2, "reconcile, then one more reconcile");
    mark = gh.mark();
    const rerun = await posted("ada", 3, "never stored", ["--marker", "timeout-lost-001"]);
    assert.equal(rerun.reconciled, false);
    assert.equal(commentPosts(mark).length, 1, "the re-run reconciles to nothing, then POSTs once");
    mark = gh.mark();
    assert.equal((await posted("ada", 3, "never stored", ["--marker", "timeout-lost-001"])).reconciled, true);
    assert.equal(commentPosts(mark).length, 0);
    assert.equal(stored("timeout-lost-001").length, 1);
    pass("a POST that timed out or 500ed after GitHub stored the comment is reconciled; one that stored nothing is comment-ambiguous; never two POSTs in one invocation");
  }

  // -- duplicates, an unreadable history, pagination -------------------------------------------------------------------
  {
    const a = gh.seed({ number: 4, user: botLogin("ada"), body: "one\n\n<!-- flume-comment:dup-marker-001 -->" });
    const b = gh.seed({ number: 4, user: botLogin("ada"), body: "two\n\n<!-- flume-comment:dup-marker-001 -->" });
    let mark = gh.mark();
    const dup = await posted("ada", 4, "three", ["--marker", "dup-marker-001"], 1);
    assert.equal(dup.code, "duplicate-comments");
    assert.deepEqual(dup.comment_ids.sort(), [String(a), String(b)]);
    assert.equal(commentPosts(mark).length, 0);

    for (let i = 0; i < 1001; i++) gh.seed({ number: 5, user: "grolf", body: `filler ${i}` });
    mark = gh.mark();
    const incomplete = await posted("ada", 5, "x", ["--marker", "incomplete-001"], 1);
    assert.equal(incomplete.code, "reconcile-incomplete");
    assert.equal(commentPosts(mark).length, 0);
    assert.equal(tokenCalls(mark).filter((c) => c.method === "GET").length, 10, "at most 10 pages");

    for (let i = 0; i < 150; i++) gh.seed({ number: 6, user: "grolf", body: `filler ${i}` });
    const early = gh.seed({ number: 6, user: botLogin("ada"), body: "page two\n\n<!-- flume-comment:paged-marker-1 -->" });
    for (let i = 0; i < 20; i++) gh.seed({ number: 6, user: "grolf", body: `more ${i}` });
    mark = gh.mark();
    const paged = await posted("ada", 6, "page two", ["--marker", "paged-marker-1"]);
    assert.equal(paged.reconciled, true);
    assert.equal(paged.comment.id, String(early));
    assert.equal(commentPosts(mark).length, 0);
    assert.ok(tokenCalls(mark).some((c) => c.query.includes("page=2")), "the marker was found on a later page");
    pass("two marked comments are duplicate-comments, an unlistable history is reconcile-incomplete, and a marker on page two is found; none of them POSTs");
  }

  // -- shared bot -----------------------------------------------------------------------------------------------------------
  {
    const cy = await posted("cy", 3, "cy through a shared bot");
    assert.equal(cy.ok, true);
    assert.equal(cy.authorship, "shared-bot-attributed", "only an explicitly configured binding is shared-bot-attributed");
    assert.equal(cy.attribution_mode, "shared_bot_attributed");
    const both = await verify("cy", [`cy:issue:${cy.comment.id}`, `dan:issue:${cy.comment.id}`], 1);
    assert.equal(both.verdict, "not-native-distinct");
    assert.ok(both.reasons.includes("shared-actor"));
    assert.ok(both.reasons.includes("shared-bot-attributed"));
    assert.ok(both.comments.every((c) => c.authorship === "shared-bot-attributed"));
    assert.notEqual(both.verdict, "native-distinct-verified", "a shared bot is never two native actors");

    // two NATIVE bindings hand-bound to one actor: both individually verify, the pair does not
    setBindings(roles.fay, { cloudflare_access: cfBinding("fay"), github: ghBinding("fay", { native_actor_id: String(APPS.ada.bot) }) });
    const sameActor = await verify("ada", [`ada:issue:${first.ada}`, `fay:issue:${first.ada}`], 1);
    assert.ok(sameActor.comments.every((c) => c.authorship === "native-verified"));
    assert.deepEqual(sameActor.reasons, ["shared-actor"]);
    // two natives on one App
    setBindings(roles.fay, { cloudflare_access: cfBinding("fay"), github: ghBinding("fay", { principal: APPS.ada.id, native_actor_id: String(APPS.bob.bot) }) });
    const sameApp = await verify("ada", [`ada:issue:${first.ada}`, `fay:issue:${first.bob}`], 1);
    assert.deepEqual(sameApp.reasons, ["shared-app"]);
    // one employee is not a distinct pair
    assert.deepEqual((await verify("ada", [`ada:issue:${first.ada}`], 1)).reasons, ["fewer-than-two-employees"]);
    // an unadopted employee has nothing to compare against
    setBindings(roles.fay, { cloudflare_access: cfBinding("fay"), github: ghBinding("fay") });
    const mark = gh.mark();
    const unadopted = await verify("ada", [`ada:issue:${first.ada}`, `fay:issue:${first.bob}`], 1);
    assert.equal(unadopted.comments[1].reason, "native-actor-not-adopted");
    assert.equal(tokenCalls(mark).length, 1, "no readback for a comment that cannot be compared");
    // an attribution mode that is unset is not native
    setBindings(roles.bob, { cloudflare_access: cfBinding("bob"), github: (({ attribution_mode: _drop, ...rest }) => rest)(ghBinding("bob", { native_actor_id: String(APPS.bob.bot) })) });
    const unset = await verify("ada", [`ada:issue:${first.ada}`, `bob:issue:${first.bob}`], 1);
    assert.equal(unset.comments[1].reason, "attribution-mode-unset");
    assert.equal(unset.comments[1].authorship, "not-native-verified");
    setBindings(roles.bob, { cloudflare_access: cfBinding("bob"), github: ghBinding("bob", { native_actor_id: String(APPS.bob.bot) }) });
    pass("a shared bot, two bindings on one actor or one App, one employee, an unadopted employee and an unset attribution mode are never native-distinct-verified");
  }

  // -- refused before any network call -----------------------------------------------------------------------------------
  {
    const mark = gh.mark();
    const direct = async (args, extra, status = 1) => json(await runAsync(args, extra), status);
    const fay = await direct(["comment", "post", "o/sandbox", "3", "--body", "x", "--json"], directEnv("fay"));
    assert.equal(fay.code, "native-actor-not-adopted");
    assert.equal((await direct(["comment", "post", "o/other", "3", "--body", "x", "--json"], directEnv("ada"))).code, "repository-not-granted");
    assert.equal((await direct(["comment", "post", "o/sandbox", "3", "--body", "x", "--json"], directEnv("ada", { FLUME_GITHUB_APP_ID: "9999" }))).code, "binding-mismatch");
    assert.equal((await direct(["comment", "post", "O/Sandbox", "3", "--body", "x", "--json"], directEnv("ada", { FLUME_GITHUB_APP_ID: "9999" }))).code, "binding-mismatch", "the repository match is case-insensitive");
    assert.equal((await direct(["comment", "post", "o/sandbox", "3", "--body", "x", "--json"], directEnv("ada", { FLUME_EMPLOYEE_SUBJECT: randomUUID() }))).code, "employee-not-found");
    assert.equal((await direct(["comment", "post", "o/sandbox", "3", "--body", "x", "--json"], directEnv("ada", { FLUME_EMPLOYEE_SUBJECT: subject.gus }))).code, "no-provider-binding");
    const noEnv = await direct(["comment", "post", "o/sandbox", "3", "--body", "x", "--json"], { FLUME_EMPLOYEE_SUBJECT: "", FLUME_GITHUB_REPOSITORY: "", FLUME_GITHUB_APP_ID: "", FLUME_GITHUB_INSTALLATION_ID: "" });
    assert.equal(noEnv.code, "missing-environment", "the operator's GH_TOKEN alone is not a grant");
    for (const [label, args, code] of [
      ["both bodies", ["--body", "x", "--body-file", "/dev/null"], "invalid-arguments"], ["no body", [], "invalid-arguments"], ["a short marker", ["--body", "x", "--marker", "short"], "invalid-arguments"],
      ["a marker with a space", ["--body", "x", "--marker", "has a space here"], "invalid-arguments"], ["an empty body file", ["--body-file", "/dev/null"], "invalid-arguments"],
    ]) assert.equal((await direct(["comment", "post", "o/sandbox", "3", ...args, "--json"], directEnv("ada"))).code, code, label);
    assert.equal((await direct(["comment", "post", "o/sandbox", "0", "--body", "x", "--json"], directEnv("ada"))).code, "invalid-arguments");
    assert.equal((await direct(["comment", "post", "o/*", "3", "--body", "x", "--json"], directEnv("ada"))).code, "invalid-arguments");
    // verify refusals
    assert.equal((await direct(["comment", "verify", "o/other", "--comment", "ada:issue:1", "--json"], directEnv("ada"))).code, "repository-not-granted");
    assert.equal((await direct(["comment", "verify", "o/sandbox", "--comment", "nobody:issue:1", "--json"], directEnv("ada"))).code, "employee-not-found");
    assert.equal((await direct(["comment", "verify", "o/sandbox", "--comment", "ada:issue:abc", "--json"], directEnv("ada"))).code, "invalid-arguments");
    assert.equal((await direct(["comment", "verify", "o/sandbox", "--comment", "ada-only", "--json"], directEnv("ada"))).code, "invalid-arguments");
    assert.equal((await direct(["comment", "verify", "o/sandbox", "--comment", "ada:issue:1", "--json"], { FLUME_GITHUB_REPOSITORY: "" })).code, "missing-environment");
    assert.equal(gh.since(mark).length, 0, "not one call reached GitHub");
    // evidence follows the API base even when nothing is sent
    const real = await direct(["comment", "post", "o/sandbox", "3", "--body", "x", "--json"], directEnv("fay", { FLUME_GITHUB_API_BASE: "https://api.github.com" }));
    assert.equal(real.code, "native-actor-not-adopted");
    assert.equal(real.evidence, "provider", "provider evidence only against https://api.github.com");
    assert.equal(fay.evidence, "fixture");
    assert.equal((await direct(["comment", "post", "o/sandbox", "3", "--body", "x", "--json"], directEnv("fay", { FLUME_GITHUB_API_BASE: "https://api.github.com/" }))).evidence, "provider");
    // via the facade: the minted token is never used for a comment when the employee is not adopted
    const viaFacade = gh.mark();
    assert.equal((await posted("fay", 3, "x", [], 1)).code, "native-actor-not-adopted");
    assert.equal(tokenCalls(viaFacade).length, 0);
    // human output
    const human = await runAsync(["comment", "post", "o/sandbox", "3", "--body", "x"], directEnv("ada", { FLUME_GITHUB_APP_ID: "9999" }));
    assert.equal(human.status, 1);
    assert.match(human.stdout, /^denied binding-mismatch: /u);
    pass("an unadopted employee, another repository, another App, an unknown subject and missing environment are refused with zero repository calls; evidence is provider only for the real API");
  }

  // -- no redirects, human output, body file ------------------------------------------------------------------------------------
  {
    const seen = [];
    const canary = createServer((req, res) => { seen.push(req.headers); res.writeHead(200); res.end("[]"); });
    await new Promise((done) => canary.listen(0, "127.0.0.1", done));
    gh.mode.commentRedirect = `http://127.0.0.1:${canary.address().port}/steal`;
    const r = await posted("ada", 3, "x", ["--marker", "redirect-marker-1"], 1);
    gh.reset();
    await new Promise((done) => canary.close(done));
    assert.equal(r.ok, false);
    assert.deepEqual(seen, [], "the redirect target never received a request, and so never the token");
    assert.equal(stored("redirect-marker-1").length, 0);

    writeFileSync(join(dir, "body.md"), "from a file\n");
    const fromFile = await comment("ada", ["post", "o/sandbox", "3", "--body-file", join(dir, "body.md"), "--marker", "body-file-001", "--json"]);
    assert.equal(fromFile.ok, true);
    assert.ok(stored("body-file-001")[0].body.startsWith("from a file\n\n<!-- flume-comment:body-file-001 -->"));
    const plain = await viaFlume("ada", ["post", "o/sandbox", "3", "--body", "plain output", "--marker", "plain-output-1"]);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /^native-verified: issue comment \d+ by ada-app\[bot\] \(9001\)/u);
    pass("a redirect is never followed, --body-file is read, and the default output is one readable line");
  }

  // -- readiness ----------------------------------------------------------------------------------------------------------------------
  {
    const report = json(run(["identity", "readiness", "--json"], { CLOUDFLARE_API_TOKEN: "" }));
    assert.equal(report.checks.github_native_authorship.status, "unproven");
    assert.equal(report.checks.github_native_authorship.ready, false);
    assert.equal(report.checks.github_native_authorship.cost, null);
    pass("readiness reports github_native_authorship as unproven");
  }

  // -- only minted tokens and App JWTs were ever presented ---------------------------------------------------------------------------
  {
    for (const call of gh.calls) {
      if (call.kind === "token") assert.ok(gh.minted.has(call.token), "only a token GitHub minted was ever presented");
    }
    assert.ok(![...gh.calls].some((c) => c.token === OPERATOR_GH.GH_TOKEN || c.token === OPERATOR_GH.GITHUB_TOKEN), "no PAT or GH_TOKEN fallback");
    assert.ok(![...gh.calls].some((c) => c.token === "direct-run-token-not-a-real-credential"), "refusals never reach GitHub");
    const lookups = gh.calls.filter((c) => c.path.startsWith("/users/"));
    assert.ok(lookups.length > 0 && lookups.every((c) => c.kind === "none"), "bot lookups are unauthenticated");
    const writes = gh.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/access_tokens") && !c.path.endsWith("/comments"));
    assert.deepEqual(writes, [], "the only writes are token mints and comments");
    assert.ok(gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/comments")).every((c) => c.kind === "token"));
    pass("GitHub only ever saw App JWTs, public bot lookups and minted installation tokens; the only writes were comments");
  }

  // -- no secret at rest, in logs or in output -----------------------------------------------------------------------------------------
  {
    const files = readdirSync(state).sort();
    assert.ok(files.every((file) => ["audit.jsonl", "fixture-ledger.jsonl", "idempotency.json", "provider-ledger.jsonl"].includes(file)), `unexpected state files: ${files}`);
    for (const file of files) assert.equal(statSync(join(state, file)).mode & 0o777, 0o600, `${file} is private`);
    const haystack = [
      ...files.map((file) => readFileSync(join(state, file), "utf8")),
      ...facadeOutputs.flatMap((out) => [out.stdout, out.stderr]), ...outputs,
      readFileSync(configPath, "utf8"), readFileSync(registry, "utf8"), ...Object.values(roles).map((path) => readFileSync(path, "utf8")),
    ];
    assert.ok(secrets.size > 30, `the scan covers ${secrets.size} secrets`);
    assert.ok(gh.minted.size >= 10);
    for (const secret of secrets) for (const text of haystack) assert.ok(!text.includes(secret), `a secret leaked: ${secret.slice(0, 12)}...`);
    for (const text of haystack) {
      assert.ok(!/BEGIN (RSA )?PRIVATE KEY/u.test(text), "no PEM header anywhere");
      assert.ok(!/ghs_[0-9a-f]{20,}/u.test(text), "no installation-token shape anywhere");
    }
    pass("no token, private key, App JWT or secret appears in any output, ledger, idempotency record or definition");
  }

  console.log(`\n${count} review-comment check groups passed`);
} finally {
  facade.child.removeAllListeners("close");
  facade.child.kill("SIGTERM");
  await edge.close();
  await gh.close();
  rmSync(work, { recursive: true, force: true });
}
