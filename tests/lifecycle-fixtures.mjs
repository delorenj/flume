// Shared doubles for the FLUME-53 lifecycle suites. Not a suite itself (scripts/run-tests.mjs lists suites explicitly).
//
// Four outside worlds are faked, each stateful, each logging every call so a test can count exact mutations:
//   * Cloudflare   -- Access service tokens (paged), Email Routing rules (GET/PUT by id), KV with GET/PUT/DELETE, and fault
//                     modes that fail, fail AFTER committing, or claim success without doing it.
//   * GitHub       -- app-JWT verified GET /app, GET /app/installations/{id}, PUT|DELETE .../suspended, and a "key deleted" mode.
//   * px (Pilot)   -- `identity verify` and `show` only, with credential_rejected and a missing binary.
//   * gateway-tokens.py -- `status` and `revoke`, with an exit-1 mode and a "revoke says ok but nothing changed" mode.
// Nothing here inherits a real HOME, `op` session or binary.
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJwt, importSPKI, jwtVerify } from "jose";

/** Bytes and mtimes of everything under `path`: equal trees mean nothing was written. Lock files are flock's, not ours. */
export function tree(path) {
  let s;
  try { s = lstatSync(path); } catch { return null; }
  if (s.isSymbolicLink()) return { link: readlinkSync(path) };
  if (s.isDirectory()) return Object.fromEntries(readdirSync(path).sort().filter((n) => !n.endsWith(".lock")).map((n) => [n, tree(join(path, n))]));
  return { bytes: readFileSync(path).toString("base64"), mtime: s.mtimeMs };
}

// ---------------------------------------------------------------------------------------------------------------------
export async function fakeCloudflare({ account, zone, kvns, token, issuer }) {
  const cf = { calls: [], mode: {}, tokens: [], rules: [], kv: new Map(), url: "", server: undefined };
  cf.reset = () => {
    cf.calls.length = 0; cf.mode = {}; cf.kv = new Map();
    cf.tokens = [];
    cf.rules = [];
  };
  cf.count = (method, pattern) => cf.calls.filter((c) => c.method === method && (!pattern || pattern.test(c.path))).length;
  cf.mutations = () => cf.calls.filter((c) => c.method !== "GET");
  const send = (res, status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
  const ok = (res, result, extra = {}) => send(res, 200, { success: true, result, ...extra });
  cf.server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const url = new URL(req.url, "http://cf.fixture");
      cf.calls.push({ method: req.method, path: url.pathname, query: url.search });
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 403, { success: false, errors: [{ message: "bad token" }] });
      if (req.method === "GET" && url.pathname === `/accounts/${account}/access/service_tokens`) {
        const perPage = Number(url.searchParams.get("per_page") ?? 50), page = Number(url.searchParams.get("page") ?? 1);
        if (cf.mode.tokenList === "500") return send(res, 500, { success: false, errors: [{ message: "boom" }] });
        return ok(res, cf.tokens.slice((page - 1) * perPage, page * perPage), { result_info: { page, per_page: perPage, total_pages: Math.max(1, Math.ceil(cf.tokens.length / perPage)), total_count: cf.tokens.length } });
      }
      const del = url.pathname.match(new RegExp(`^/accounts/${account}/access/service_tokens/([^/]+)$`));
      if (req.method === "DELETE" && del) {
        if (cf.mode.tokenDelete === "500") return send(res, 500, { success: false, errors: [{ message: "boom" }] });
        if (cf.mode.tokenDelete === "noop") return ok(res, {});
        const index = cf.tokens.findIndex((t) => t.id === del[1]);
        if (index < 0) return send(res, 404, { success: false, errors: [{ message: "not found" }] });
        cf.tokens.splice(index, 1);
        if (cf.mode.tokenDelete === "500-after-delete") return send(res, 500, { success: false, errors: [{ message: "boom after commit" }] });
        return ok(res, {});
      }
      if (req.method === "GET" && url.pathname === `/zones/${zone}/email/routing/rules`) return ok(res, cf.rules);
      const rule = url.pathname.match(new RegExp(`^/zones/${zone}/email/routing/rules/([^/]+)$`));
      if (rule) {
        const index = cf.rules.findIndex((r) => r.id === rule[1]);
        if (index < 0) return send(res, 404, { success: false, errors: [{ message: "no such rule" }] });
        if (req.method === "GET") return ok(res, cf.rules[index]);
        if (req.method === "PUT") {
          if (cf.mode.rulePut === "500") return send(res, 500, { success: false, errors: [{ message: "boom" }] });
          if (cf.mode.rulePut !== "noop") cf.rules[index] = { ...cf.rules[index], ...JSON.parse(body), id: rule[1] };
          return ok(res, cf.rules[index]);
        }
      }
      const kv = url.pathname.match(new RegExp(`^/accounts/${account}/storage/kv/namespaces/${kvns}/values/(.+)$`));
      if (kv) {
        const key = decodeURIComponent(kv[1]);
        if (req.method === "GET") {
          if (cf.mode.kvGet === "500") return send(res, 500, { success: false, errors: [{ message: "boom" }] });
          return cf.kv.has(key) ? send(res, 200, cf.kv.get(key)) : send(res, 404, { success: false, errors: [{ code: 10009, message: "key not found" }] });
        }
        if (req.method === "PUT") {
          if (cf.mode.kvPut === "500") return send(res, 500, { success: false, errors: [{ message: "boom" }] });
          cf.kv.set(key, JSON.parse(body));
          return ok(res, {});
        }
        if (req.method === "DELETE") {
          if (cf.mode.kvDelete === "500") return send(res, 500, { success: false, errors: [{ message: "boom" }] });
          if (cf.mode.kvDelete === "noop") return ok(res, {});
          const had = cf.kv.delete(key);
          if (cf.mode.kvDelete === "500-after-delete") return send(res, 500, { success: false, errors: [{ message: "boom after commit" }] });
          return had ? ok(res, {}) : send(res, 404, { success: false, errors: [{ message: "key not found" }] });
        }
      }
      return send(res, 404, { success: false, errors: [{ message: `no fake route: ${req.method} ${url.pathname}` }] });
    });
  });
  await new Promise((done) => cf.server.listen(0, "127.0.0.1", done));
  cf.url = `http://127.0.0.1:${cf.server.address().port}`;
  cf.close = () => new Promise((done) => cf.server.close(done));
  void issuer;
  return cf;
}

// ---------------------------------------------------------------------------------------------------------------------
export const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

/** One App per entry of `apps`: { id, slug, installation, publicKey }. */
export async function fakeGithub(apps) {
  const gh = { calls: [], mode: {}, url: "", apps: new Map(), jwts: new Set(), allJwts: new Set() };
  for (const app of apps) {
    gh.apps.set(app.id, { ...app, key: await importSPKI(app.publicKey, "RS256"), installations: new Map([[app.installation, { id: Number(app.installation), account: { login: "o", type: "Organization" }, suspended_at: null }]]) });
  }
  gh.reset = () => {
    gh.calls.length = 0; gh.mode = {}; gh.jwts.clear();
    for (const app of gh.apps.values()) for (const installation of app.installations.values()) installation.suspended_at = null;
  };
  gh.count = (method, pattern) => gh.calls.filter((c) => c.method === method && (!pattern || pattern.test(c.path))).length;
  gh.mutations = () => gh.calls.filter((c) => c.method !== "GET");
  const send = (res, status, body, extra = {}) => { res.writeHead(status, { "content-type": "application/json", ...extra }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    const url = new URL(req.url, "http://gh");
    gh.calls.push({ method: req.method, path: url.pathname });
    const authorization = String(req.headers.authorization ?? "");
    if (!/^bearer /iu.test(authorization)) return send(res, 401, { message: "Requires authentication" });
    const jwt = authorization.replace(/^bearer /iu, "");
    gh.jwts.add(jwt);
    gh.allJwts.add(jwt);
    let app;
    try {
      app = gh.apps.get(String(decodeJwt(jwt).iss));
      if (!app) throw new Error("unknown app");
      await jwtVerify(jwt, app.key, { algorithms: ["RS256"] });
    } catch { return send(res, 401, { message: "A JSON web token could not be decoded" }); }
    // The App's key was deleted at GitHub: every JWT it signs is now refused.
    if (gh.mode.keyRejected) return send(res, 401, { message: "A JSON web token could not be decoded" });
    if (req.method === "GET" && url.pathname === "/app") return send(res, 200, { id: Number(app.id), slug: app.slug, name: app.slug, client_id: `Iv1.${app.slug}`, owner: { login: "o", type: "Organization" } });
    const m = url.pathname.match(/^\/app\/installations\/(\d+)(\/suspended)?$/u);
    if (m) {
      const installation = app.installations.get(m[1]);
      if (!installation) return send(res, 404, { message: "Not Found" });
      if (!m[2] && req.method === "GET") {
        if (gh.mode.installationGet === "500") return send(res, 500, { message: "boom" });
        return send(res, 200, { ...installation, repository_selection: "selected", permissions: { issues: "write", metadata: "read" } });
      }
      if (m[2] && req.method === "PUT") {
        if (gh.mode.put === "500") return send(res, 500, { message: "boom" });
        if (gh.mode.put !== "noop") installation.suspended_at = new Date().toISOString();
        return send(res, 204);
      }
      if (m[2] && req.method === "DELETE") {
        if (gh.mode.delete === "500") return send(res, 500, { message: "boom" });
        if (gh.mode.delete !== "noop") installation.suspended_at = null;
        return send(res, 204);
      }
    }
    return send(res, 404, { message: "Not Found" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  gh.url = `http://127.0.0.1:${server.address().port}`;
  gh.close = () => new Promise((done) => server.close(done));
  gh.installationOf = (appId) => [...gh.apps.get(appId).installations.values()][0];
  return gh;
}

// ---------------------------------------------------------------------------------------------------------------------
/** A fake `op`: `op read <ref>` answers from the JSON map in OP_FIXTURE. */
export function writeFakeOp(path, serviceToken) {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("fs");
if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== ${JSON.stringify(serviceToken)}) process.exit(1);
const map = JSON.parse(fs.readFileSync(process.env.OP_FIXTURE, "utf8"));
const [verb, ref] = process.argv.slice(2);
if (verb !== "read" || !(ref in map)) process.exit(2);
process.stdout.write(map[ref]);
`, { mode: 0o755 });
}

/** Pilot, reduced to the two verbs Flume may call. State in PX_FAKE_STATE; every argv logged to PX_FAKE_LOG. */
export function writeFakePx(path) {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.PX_FAKE_STATE, "utf8"));
fs.appendFileSync(process.env.PX_FAKE_LOG, JSON.stringify({ argv: args }) + "\\n");
const out = (code, body) => { process.stdout.write(JSON.stringify(body)); process.exit(code); };
const refuse = (code, error) => out(1, { ok: false, error, code });
const flag = (name) => { const i = args.indexOf("--" + name); return i < 0 ? undefined : args[i + 1]; };
if (args[0] === "identity" && args[1] === "verify") {
  const ref = flag("key-ref"), uid = flag("user-id"), board = flag("board"), email = flag("email");
  const key = state.keys[ref];
  if (!key) refuse("credential_unresolvable", "could not resolve " + ref);
  if ((state.rejected || []).includes(ref)) refuse("credential_rejected", "Plane rejected " + ref + " (HTTP 401)");
  const me = state.users[key.user];
  if (me.id !== uid) refuse("wrong_employee", ref + " resolves to native user " + me.id);
  if (email && me.email !== email) refuse("wrong_employee", "users/me email is " + me.email);
  const found = Object.values(state.boards).find((b) => b.identifier.toLowerCase() === board.toLowerCase() || b.id === board.toLowerCase());
  if (!found) refuse("unknown_board", "board " + board + " is not a project");
  if (!found.members.includes(me.id)) refuse("not_project_member", me.id + " is not listed on board " + found.identifier);
  out(0, { ok: true, verified: true, employee: flag("employee"), native_user_id: me.id, email: me.email, display_name: me.name, workspace: { slug: flag("workspace"), role: 15 },
    board: { id: found.id, identifier: found.identifier, name: found.name, member: true }, plane: { observable: true, version: "1.3.1", edition: "PLANE_COMMUNITY" },
    credential: { ref, type: "plane_personal_access_token", header: "X-API-Key", expiry: { observable: false, reason: "Plane exposes a token's expiry only to its owner" },
      revocation: { native: "the owner deletes the token under Profile > Personal Access Tokens", board_access: "an admin removes the project membership", px_verb: null } },
    shared_key_fallback: false, verified_at: "2026-10-14T20:00:00.000Z" });
}
if (args[0] === "show") {
  const ticket = state.tickets[args[1]];
  if (!ticket) out(1, { ok: false, error: "no ticket " + args[1] });
  out(0, { ok: true, ticket: { ref: args[1], project: ticket.project, comments: ticket.comments } });
}
out(99, { ok: false, code: "forbidden_verb", error: "only identity verify and show are allowed here" });
`, { mode: 0o755 });
}

/** gateway-tokens.py, reduced to status and revoke. State in GW_STATE; every argv logged to GW_LOG. status carries extra fields it must never be copied from. */
export function writeFakeGateway(path) {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("fs");
const [verb, consumer] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.GW_STATE, "utf8"));
fs.appendFileSync(process.env.GW_LOG, JSON.stringify({ argv: [verb, consumer] }) + "\\n");
const fail = (message) => { process.stderr.write("token operation failed: " + message + "\\n"); process.exit(1); };
if (state.mode === "exit1") fail("gateway unreachable");
const tokens = state.consumers[consumer] || [];
if (verb === "status") {
  process.stdout.write(JSON.stringify({ consumer, tokens: tokens.map((t) => ({ id: t.id, name: t.name, status: t.status, group: "aai", expired_time: t.expired_time, model_limits: "m1,m2", key: t.planted_key })) }) + "\\n");
  process.exit(0);
}
if (verb === "revoke") {
  if (state.mode === "revoke-noop") { process.stdout.write(consumer + ": revoked " + tokens.length + " tokens\\n"); process.exit(0); }
  const count = tokens.length;
  state.consumers[consumer] = [];
  fs.writeFileSync(process.env.GW_STATE, JSON.stringify(state));
  process.stdout.write(consumer + ": revoked " + count + " tokens\\n");
  process.exit(0);
}
fail("unsupported verb");
`, { mode: 0o755 });
}
