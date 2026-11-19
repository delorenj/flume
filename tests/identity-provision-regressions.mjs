// FLUME-56 identity provisioning, through the built `flume` CLI only.
//
// A fake Cloudflare API (in-process HTTP server, reached via
// FLUME_CLOUDFLARE_API_BASE) and a stateful fake `op` binary stand in for the
// providers. The suite proves: preview writes nothing anywhere; apply creates
// the token, rule, allowlist key, vault item and binding; a second apply is a
// pure no-op; foreign name/rule collisions are blockers, never clobbers; a
// vault failure after token creation deletes the orphan at the provider; and
// no artifact (receipts, stdout, definitions) ever contains a secret value.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cli = process.env.FLUME_PROVISION_TEST_CLI || join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync(join(tmpdir(), "flume80-"));
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

const ACCOUNT = "a".repeat(32), ZONE = "z".replace(/z/g, "b").repeat(32), KVNS = "c".repeat(32);
const ISSUER = "https://fixture.cloudflareaccess.com";
const CF_TOKEN = "fixture-cloudflare-provisioning-token";
const TOKEN_REF = "op://DeLoSecrets/Cloudflare/provisioning-token";
const POLICY_REF = "op://DeLoSecrets/Cloudflare/access-policy-token";
const POLICY_TOKEN = "fixture-policy-credential-secret";
const POLICY_CONFIG = { api_token_ref: POLICY_REF, application_id: "app-fixture", policy_id: "policy-fixture", domain: "identity.fixture.test" };
const CREATED_SECRET = "created-access-client-secret-value";
/** Every secret the suite creates; scanned for in every artifact at the end. */
const secrets = new Set([CF_TOKEN, POLICY_TOKEN, CREATED_SECRET]);

// -- fixture workspace ------------------------------------------------------------------------
const dir = join(work, "fx"), home = join(dir, "home"), fleet = join(home, ".hermes"), registry = join(fleet, "agents-registry.yaml");
const bin = join(dir, "bin"), state = join(dir, "state"), configPath = join(dir, "identity-provisioning.yaml");
for (const p of [fleet, join(home, ".agents/workforce"), bin, state]) mkdirSync(p, { recursive: true });
writeFileSync(registry, "schema_version: 1\nagents: {}\n");

// A stateful fake `op`: items persist in OP_ITEMS so state survives across spawns.
writeFileSync(join(bin, "op"), `#!/usr/bin/env node
const fs = require("fs");
if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== "vault-session-token") process.exit(1);
const args = process.argv.slice(2);
const mode = process.env.OP_MODE || "";
const cachePath = process.env.OP_ITEMS + ".cache";
const editedPath = process.env.OP_ITEMS + ".edited";
const read = (path, fallback) => fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : fallback;
const log = (entry) => fs.appendFileSync(process.env.OP_CALLS, JSON.stringify(entry) + "\\n");
log({ command: args.slice(0, 2).join(" "), fresh: args.includes("--cache=false"), target: args[0] === "item" && ["get", "edit"].includes(args[1]) ? args[2] : undefined });
const itemsPath = process.env.OP_ITEMS;
const items = () => fs.existsSync(itemsPath) ? JSON.parse(fs.readFileSync(itemsPath, "utf8")) : [];
const save = (list) => fs.writeFileSync(itemsPath, JSON.stringify(list, null, 2));
const fid = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
if (args[0] === "read") {
  if (args[1] === ${JSON.stringify(POLICY_REF)} && process.env.OP_POLICY_UNAVAILABLE !== "1") { process.stdout.write(${JSON.stringify(POLICY_TOKEN)}); process.exit(0); }
  if (args[1] === ${JSON.stringify(TOKEN_REF)}) { process.stdout.write(${JSON.stringify(CF_TOKEN)}); process.exit(0); }
  process.exit(2);
}
if (args[0] === "item" && args[1] === "list") {
  if (mode === "list-failed") { process.stderr.write(${JSON.stringify(CF_TOKEN)}); process.exit(1); }
  process.stdout.write(JSON.stringify(items().map(({ id, title }) => ({ id, title }))));
  process.exit(0);
}
if (args[0] === "item" && args[1] === "get") {
  const edited = read(editedPath, []);
  if (mode === "unreadable" && edited.includes(args[2])) { process.stderr.write(${JSON.stringify(CREATED_SECRET)}); process.exit(1); }
  const source = mode === "stale" && !args.includes("--cache=false") ? read(cachePath, items()) : items();
  const item = source.find((i) => i.title === args[2] || i.id === args[2]);
  if (!item) process.exit(1);
  process.stdout.write(JSON.stringify(item));
  process.exit(0);
}
if (args[0] === "item" && args[1] === "create") {
  const title = args[args.indexOf("--title") + 1];
  const item = { id: "item-" + title.toLowerCase(), title, fields: [] };
  for (const a of args.slice(3)) {
    const m = a.match(/^([^\\[]+)\\[([^\\]]+)\\]=(.*)$/s);
    if (m) { const dot = m[1].lastIndexOf("."); const sec = dot > 0 ? m[1].slice(0, dot) : ""; const lbl = dot > 0 ? m[1].slice(dot + 1) : m[1];
      item.fields.push({ id: fid(m[1]), label: lbl, type: m[2], value: m[3], section: sec ? { label: sec } : undefined }); }
  }
  const list = items(); list.push(item); save(list);
  // The installed op prints a human table unless --format json is given (found live, FLUME-53 canary): a caller that
  // forgets the flag would parse "ID: ..." and strand an orphan item after it was created.
  if (!(args.includes("--format") && args[args.indexOf("--format") + 1] === "json")) { process.stdout.write("ID:       " + item.id + "\\nTitle:    " + title + "\\n"); process.exit(0); }
  process.stdout.write(JSON.stringify(item));
  process.exit(0);
}
if (args[0] === "item" && args[1] === "edit") {
  if (mode === "signal") process.kill(process.pid, "SIGTERM");
  if (process.env.OP_FAIL_EDIT === "1") { process.stderr.write(${JSON.stringify(CREATED_SECRET)}); process.exit(1); }
  const list = items();
  fs.writeFileSync(cachePath, JSON.stringify(list));
  const item = list.find((i) => i.id === args[2]);
  if (!item) process.exit(1);
  for (const a of args.slice(3)) {
    const m = a.match(/^([^\\[]+)\\[([^\\]]+)\\]=(.*)$/s);
    if (!m) continue;
    const dot = m[1].lastIndexOf(".");
    const sec = dot > 0 ? m[1].slice(0, dot) : "";
    const lbl = dot > 0 ? m[1].slice(dot + 1) : m[1];
    const existing = item.fields.find((f) => f.label === lbl && (f.section?.label ?? "") === sec);
    if (existing) { if (existing.value !== m[3]) { process.stderr.write("field holds a different value\\n"); process.exit(1); } }
    else item.fields.push({ id: fid(m[1]), label: lbl, type: m[2], value: m[3], section: sec ? { label: sec } : undefined });
  }
  fs.writeFileSync(editedPath, JSON.stringify([...read(editedPath, []), item.id]));
  if (mode === "wrong-value") item.fields.filter(f => f.section?.label === "Identity Service Token").forEach(f => f.value = "wrong");
  if (mode === "partial") item.fields = item.fields.filter(f => f.label !== "Client Secret");
  if (mode === "duplicate-id") item.fields.forEach(f => f.id = "duplicate");
  if (mode === "duplicate-field") item.fields.push({ ...item.fields.find(f => f.label === "Client Secret") });
  if (mode !== "success-empty") save(list);
  if (process.env.OP_REFUSE_BINDING) {
    const path = process.env.OP_REFUSE_BINDING;
    fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace('status: "active"', 'status: "retired"'));
  }
  if (mode === "persist-error") { process.stderr.write(${JSON.stringify(CREATED_SECRET)}); process.exit(1); }
  process.stdout.write(JSON.stringify(item));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });

// A fake Cloudflare API with just the surface provisioning uses.
const calls = [];
const cf = {
  tokens: [], rules: [], kv: new Map(), deleted: [],
  policy: { id: POLICY_CONFIG.policy_id, account_id: ACCOUNT, policy_resolution_account_id: ACCOUNT, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", name: "Employee facade", decision: "non_identity", precedence: 3, include: [{ service_token: { token_id: "unrelated-token" } }, { ip: { ip: "192.0.2.0/24" } }], exclude: [{ geo: { country_code: "XX" } }], require: [{ auth_method: { auth_method: "swk" } }], session_duration: "24h", approval_required: false },
};
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => body += c);
  req.on("end", () => {
    calls.push({ method: req.method, url: req.url, authed: req.headers.authorization === `Bearer ${CF_TOKEN}` });
    const send = (status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    const url = new URL(req.url, "http://cf.fixture");
    const ok = (result) => send(200, { success: true, result });
    if (url.pathname.includes("/access/apps/")) {
      assert.equal(req.headers.authorization, `Bearer ${POLICY_TOKEN}`, "policy call borrowed the issuance credential");
      if (cf.policyDenied || (req.method === "PUT" && cf.policyWriteDenied)) return send(403, { success: false, errors: [{ message: POLICY_TOKEN + CREATED_SECRET }] });
      if (cf.policyUnavailable) return send(503, { success: false, errors: [{ message: POLICY_TOKEN }] });
      if (url.pathname === `/accounts/${ACCOUNT}/access/apps/${POLICY_CONFIG.application_id}` && req.method === "GET") return ok({ id: POLICY_CONFIG.application_id, domain: cf.wrongDomain ? "wrong.example" : POLICY_CONFIG.domain });
      if (url.pathname === `/accounts/${ACCOUNT}/access/apps/${POLICY_CONFIG.application_id}/policies/${POLICY_CONFIG.policy_id}`) {
        if (req.method === "GET") {
          if (cf.policyMissing) return send(404, { success: false });
          return ok(cf.policy);
        }
        if (req.method === "PUT") {
          const parsed = JSON.parse(body);
          for (const key of ["id", "account_id", "policy_resolution_account_id", "created_at", "updated_at"]) assert.ok(!(key in parsed), `read-only ${key} sent to policy PUT`);
          if (!cf.policyNoop) Object.assign(cf.policy, parsed);
          if (cf.policyDrift) cf.policy.session_duration = "12h";
          if (cf.policyCommitError) return send(503, { success: false });
          return ok(cf.policy);
        }
      }
      return send(404, { success: false });
    }
    if (req.headers.authorization !== `Bearer ${CF_TOKEN}`) return send(403, { success: false, errors: [{ message: "bad token" }] });
    if (req.method === "GET" && url.pathname === `/accounts/${ACCOUNT}/access/service_tokens`) {
      const page = Number(url.searchParams.get("page") || "1"), size = cf.pageSize || 50;
      if (cf.onTokenList) { const hook = cf.onTokenList; cf.onTokenList = undefined; hook(); }
      const full = cf.samePageDuplicate ? [cf.tokens[0], cf.tokens[0]] : cf.repeatPage && page > 1 ? cf.tokens.slice(0, size) : cf.tokens.slice((page - 1) * size, page * size);
      const result = cf.malformedRows ? full.map(token => token?.id === cf.malformedRows.id ? cf.malformedRows.row(token) : token) : full;
      return send(200, { success: true, result, ...(cf.samePageDuplicate ? { result_info: { total_pages: 1 } } : cf.noPageMetadata ? {} : { result_info: cf.inconsistentPages ? { total_pages: page === 1 ? 2 : 3 } : cf.clampedPageMetadata ? { per_page: size } : { total_pages: Math.max(1, Math.ceil(cf.tokens.length / size)) } }) });
    }
    if (req.method === "POST" && url.pathname === `/accounts/${ACCOUNT}/access/service_tokens`) {
      const token = { id: `token-${randomUUID().slice(0, 8)}`, name: JSON.parse(body).name, client_id: `${randomUUID().replace(/-/g, "")}.access`, client_secret: CREATED_SECRET, expires_at: "2027-10-13T00:00:00Z" };
      cf.tokens.push(token);
      if (cf.onTokenCreate) { const hook = cf.onTokenCreate; cf.onTokenCreate = undefined; hook(token); }
      return ok(token);
    }
    const del = url.pathname.match(new RegExp(`^/accounts/${ACCOUNT}/access/service_tokens/([^/]+)$`));
    if (req.method === "GET" && del) {
      const token = cf.tokens.find(t => t.id === del[1]);
      return token ? ok(token) : send(404, { success: false });
    }
    if (req.method === "DELETE" && del) {
      if (cf.failDelete) return send(503, { success: false, errors: [{ message: CREATED_SECRET + CF_TOKEN }] });
      if (cf.lieDelete) return ok({});
      const index = cf.tokens.findIndex((t) => t.id === del[1]);
      if (index < 0) return send(404, { success: false, errors: [{ message: "not found" }] });
      cf.deleted.push(cf.tokens[index].id);
      cf.tokens.splice(index, 1);
      return ok({});
    }
    if (req.method === "GET" && url.pathname === `/zones/${ZONE}/email/routing/rules`) return send(200, { success: true, result: cf.rules, result_info: { total_pages: 1 } });
    const ruleMatch = url.pathname.match(new RegExp(`^/zones/${ZONE}/email/routing/rules/([^/]+)$`));
    if (ruleMatch && req.method === "GET") { const rule = cf.rules.find(r => r.id === ruleMatch[1]); return rule ? ok(rule) : send(404, { success: false }); }
    if (ruleMatch && req.method === "PUT") { const rule = cf.rules.find(r => r.id === ruleMatch[1]); if (!rule) return send(404, { success: false }); Object.assign(rule, JSON.parse(body)); return ok(rule); }
    if (req.method === "POST" && url.pathname === `/zones/${ZONE}/email/routing/rules`) {
      const rule = { id: `rule-${randomUUID().slice(0, 8)}`, enabled: true, ...JSON.parse(body) };
      cf.rules.push(rule);
      return ok(rule);
    }
    const kvMatch = url.pathname.match(new RegExp(`^/accounts/${ACCOUNT}/storage/kv/namespaces/${KVNS}/values/(.+)$`));
    if (kvMatch) {
      const key = decodeURIComponent(kvMatch[1]);
      if (req.method === "GET") {
        if (cf.onAllowlistRead) { const hook = cf.onAllowlistRead; cf.onAllowlistRead = undefined; hook(); }
        return cf.kv.has(key) ? send(200, cf.kv.get(key)) : send(404, { success: false, errors: [{ code: 10009, message: "key not found" }] });
      }
      if (req.method === "PUT") { cf.kv.set(key, JSON.parse(body)); return ok({}); }
      if (req.method === "DELETE") { cf.kv.delete(key); return ok({}); }
    }
    return send(404, { success: false, errors: [{ message: `no fake route: ${req.method} ${url.pathname}` }] });
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const cfBase = `http://127.0.0.1:${server.address().port}`;

writeFileSync(configPath, YAML.stringify({
  version: 1,
  cloudflare: { api_token_ref: TOKEN_REF, account_id: ACCOUNT, zone_id: ZONE, access_issuer: ISSUER, access_policy: POLICY_CONFIG },
  mailbox: { worker: "agents-facade", kv_namespace_id: KVNS },
  onepassword: { vault: "DeLoSecrets" },
}));

const baseEnv = {
  ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
  XDG_STATE_HOME: join(home, ".local/state"), PATH: `${bin}:${process.env.PATH}`,
  FLUME_PROVISION_CONFIG: configPath, FLUME_PROVISION_STATE: state, FLUME_CLOUDFLARE_API_BASE: cfBase,
  OP_SERVICE_ACCOUNT_TOKEN: "vault-session-token", OP_ITEMS: join(dir, "op-items.json"), OP_CALLS: join(dir, "op-calls.jsonl"), OP_CACHE: "on",
  FLUME_HOST_OVERLAY: "none", HERMES_FLEET_ENV: join(dir, "no-fleet.env"),
  PLANE_API_KEY: "", PLANE_DEFAULT_API_KEY: "", PLANE_33GOD_API_KEY: "", TRELLO_TOKEN: "",
};
const cliArtifacts = [];
/** The child talks to the in-process fake Cloudflare: a sync spawn would deadlock it. */
const runAsync = (args, extra = {}) => new Promise((done) => {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...baseEnv, ...extra }, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => stdout += b);
  child.stderr.on("data", (b) => stderr += b);
  child.on("close", (status) => { cliArtifacts.push(stdout, stderr); done({ status, stdout, stderr }); });
});
const json = (r, status = 0) => { assert.equal(r.status, status, r.stdout + r.stderr); return JSON.parse(r.stdout); };

// Enrolled specialist fixture: hire-free desk yaml, enrolled through the CLI.
const deskDir = join(home, ".agents/workforce/rhea");
mkdirSync(deskDir, { recursive: true });
writeFileSync(join(deskDir, "agent.yaml"), YAML.stringify({
  schema_version: 1, id: "rhea", display_name: "Rhea", role: "infra",
  charter: { purpose: "Fixture employee" }, skills: { set: "first" }, memory: { write_bank: "agent-rhea", recall_banks: [] },
}));
{
  const enrolled = json(spawnSync(process.execPath, [cli, "identity", "enroll", "rhea", "--apply", "--json"], { env: baseEnv, cwd: dir, encoding: "utf8" }));
  assert.equal(enrolled.identity.email, "rhea@agents.delo.sh");
}
const desk = () => YAML.parse(readFileSync(join(deskDir, "agent.yaml"), "utf8"));

// -- FLUME-80: the double deliberately models the incident's cache sequence ------------------
{
  const fixture = { id: "cache-probe", title: "Cache probe", fields: [] };
  writeFileSync(baseEnv.OP_ITEMS, JSON.stringify([fixture]));
  const fakeOp = args => spawnSync(join(bin, "op"), args, { env: { ...baseEnv, OP_MODE: "stale" }, encoding: "utf8" });
  assert.equal(fakeOp(["item", "edit", fixture.id, "Identity Service Token.Client ID[text]=probe.access"]).status, 0);
  const cached = JSON.parse(fakeOp(["item", "get", fixture.id]).stdout);
  const fresh = JSON.parse(fakeOp(["item", "get", fixture.id, "--cache=false"]).stdout);
  assert.equal(cached.fields.length, 0);
  assert.equal(fresh.fields[0].value, "probe.access");
  writeFileSync(baseEnv.OP_ITEMS, "[]");
  pass("isolated cache reproduction: edit persists, ordinary read is stale, fresh read sees field");
}

// -- 1. preview writes nothing ----------------------------------------------------------------
{
  const before = calls.length;
  const opStart = readFileSync(baseEnv.OP_CALLS, "utf8").length;
  const result = json(await runAsync(["identity", "provision", "rhea", "--json"]));
  assert.ok(!readFileSync(baseEnv.OP_CALLS, "utf8").slice(opStart).match(/item (edit|create)/), "preview mutated vault");
  assert.equal(result.ok, true);
  assert.equal(result.apply, false);
  assert.equal(result.capabilities["vault-item"].action, "create");
  assert.equal(result.capabilities["access-token"].action, "create");
  assert.equal(result.capabilities.mailbox.action, "create");
  assert.ok(calls.slice(before).every((c) => c.method === "GET"), "preview made a provider write");
  assert.equal(desk().company_identity.bindings, undefined, "preview wrote a binding");
  assert.ok(!existsSync(join(state, "receipts.jsonl")), "preview wrote receipts");
  pass("preview plans creates with remote GETs only and writes nothing");
}

// -- 2. apply provisions everything, idempotently ---------------------------------------------
{
  const application = await runAsync(["identity", "provision", "rhea", "--apply", "--json"], { OP_MODE: "stale" });
  if (process.env.FLUME_PROVISION_EXPECT_OLD_FAILURE === "1") {
    const old = json(application, 1);
    assert.equal(old.capabilities["access-token"].action, "blocked");
    assert.match(old.capabilities["access-token"].detail, /not readable.*deleted/);
    assert.equal(cf.tokens.length, 0);
    assert.equal(cf.deleted.length, 1);
    const persisted = JSON.parse(readFileSync(baseEnv.OP_ITEMS, "utf8")).find(i => i.id === "item-rhea");
    assert.ok(persisted.fields.some(f => f.section?.label === "Identity Service Token" && f.label === "Client ID"));
    assert.equal(desk().company_identity.bindings, undefined);
    const retry = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]), 1);
    assert.match(retry.capabilities["access-token"].detail, /different value/);
    assert.equal(cf.deleted.length, 2);
    pass("baseline reproduces persisted Client ID + stale verification + token deletion; retry mints/deletes again");
    server.close(); rmSync(work, { recursive: true, force: true });
    process.exit(0);
  }
  const applied = json(application);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.capabilities["access-token"].action, "created");
  assert.equal(applied.capabilities.mailbox.action, "created");
  assert.equal(applied.capabilities["vault-item"].action, "created");
  const block = desk().company_identity;
  assert.equal(block.bindings.cloudflare_access.principal, cf.tokens[0].client_id);
  assert.equal(block.bindings.cloudflare_access.instance, ISSUER);
  assert.match(block.bindings.cloudflare_access.credential_ref, /^op:\/\/DeLoSecrets\/item-rhea\/identity-service-token-client-secret$/u);
  assert.equal(cf.tokens.length, 1);
  assert.equal(cf.rules.length, 1);
  assert.equal(cf.rules[0].actions[0].type, "worker");
  assert.deepEqual(cf.rules[0].actions[0].value, ["agents-facade"]);
  assert.equal(cf.kv.get("allowlist/rhea@agents.delo.sh")?.subject, block.subject);
  const itemReads = readFileSync(baseEnv.OP_CALLS, "utf8").trim().split("\n").map(JSON.parse).filter(c => c.command === "item get" && c.target === "item-rhea");
  assert.ok(itemReads.length >= 2 && itemReads.every(c => c.fresh), "provisioner did not use scoped cache bypass by item ID");
  assert.ok(existsSync(join(state, "receipts.jsonl")));

  const callStart = calls.length;
  const opStart = readFileSync(baseEnv.OP_CALLS, "utf8").length;
  const itemsBefore = readFileSync(baseEnv.OP_ITEMS, "utf8");
  const again = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"], { OP_MODE: "stale" }));
  assert.ok(calls.slice(callStart).every(c => c.method === "GET"), "repeat apply mutated provider");
  assert.ok(!readFileSync(baseEnv.OP_CALLS, "utf8").slice(opStart).match(/item (edit|create)/), "repeat mutated vault");
  assert.equal(readFileSync(baseEnv.OP_ITEMS, "utf8"), itemsBefore);
  assert.equal(cf.deleted.length, 0, "stale cached state deleted a live token");
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  for (const cap of Object.values(again.capabilities)) assert.equal(cap.action, "no-op", JSON.stringify(cap));
  assert.equal(cf.tokens.length, 1, "second apply minted another token");
  assert.equal(cf.rules.length, 1, "second apply created another rule");
  pass("apply provisions token + rule + allowlist + vault item + binding; second apply is a no-op");
}

// -- FLUME-57: policy membership for an already-bound employee -------------------------------
{
  const token = cf.tokens[0], bindingBefore = readFileSync(join(deskDir, "agent.yaml"), "utf8");
  // Historical manually bound employee: no issuance/policy receipt exists, but fresh vault and provider facts agree.
  const receiptPath = join(state, "receipts.jsonl");
  writeFileSync(receiptPath, readFileSync(receiptPath, "utf8").split("\n").filter(line => line && JSON.parse(line).employee !== "rhea").join("\n") + "\n");
  assert.ok(cf.policy.include.some(rule => rule.service_token?.token_id === token.id), "new token was not granted membership");
  assert.ok(!cf.policy.include.some(rule => rule.service_token?.token_id === token.client_id), "client_id was mistaken for token ID");
  assert.equal(cf.policy.include.filter(rule => rule.service_token?.token_id === token.id).length, 1);
  cf.policy.include = cf.policy.include.filter(rule => rule.service_token?.token_id !== token.id);
  const unrelated = structuredClone(cf.policy);
  const before = calls.length, receiptBefore = readFileSync(join(state, "receipts.jsonl"), "utf8"), itemsBefore = readFileSync(baseEnv.OP_ITEMS, "utf8");
  const preview = json(await runAsync(["identity", "provision", "rhea", "--json"]));
  assert.equal(preview.capabilities["access-token"].action, "no-op");
  assert.equal(preview.capabilities["access-policy"].action, "adopt");
  assert.ok(calls.slice(before).every(call => call.method === "GET"));
  assert.equal(readFileSync(join(state, "receipts.jsonl"), "utf8"), receiptBefore);
  assert.deepEqual(cf.policy, unrelated);
  const repaired = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]));
  assert.equal(repaired.capabilities["access-policy"].action, "adopted");
  assert.equal(readFileSync(baseEnv.OP_ITEMS, "utf8"), itemsBefore);
  assert.equal(readFileSync(join(deskDir, "agent.yaml"), "utf8"), bindingBefore);
  assert.equal(cf.tokens.length, 1);
  assert.deepEqual(cf.policy, { ...unrelated, include: [...unrelated.include, { service_token: { token_id: token.id } }] });
  const repeatStart = calls.length, receiptAfter = readFileSync(join(state, "receipts.jsonl"), "utf8");
  json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]));
  assert.ok(calls.slice(repeatStart).every(call => call.method === "GET"));
  assert.equal(readFileSync(join(state, "receipts.jsonl"), "utf8"), receiptAfter);
  pass("FLUME-57 new and already-bound token IDs gain targeted read-back membership; preview inert, repeat no writes/remint/duplicates");

  for (const mode of ["policyDenied", "policyUnavailable", "policyWriteDenied", "policyNoop", "policyCommitError", "policyMissing", "wrongDomain"]) {
    cf.policy.include = cf.policy.include.filter(rule => rule.service_token?.token_id !== token.id);
    const policyBefore = structuredClone(cf.policy), start = calls.length;
    cf[mode] = true;
    const result = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]), 1);
    assert.equal(result.ok, false);
    assert.equal(result.capabilities["access-token"].action, "no-op");
    assert.equal(result.capabilities["access-policy"].action, "blocked");
    assert.equal(cf.tokens.length, 1);
    assert.ok(!calls.slice(start).some(call => call.method === "POST" || call.method === "DELETE"));
    if (mode !== "policyCommitError") assert.deepEqual(cf.policy, policyBefore);
    if (mode.includes("Denied")) assert.match(result.capabilities["access-policy"].detail, /permission-denied|Apps and Policies Edit/);
    cf[mode] = false;
    const retry = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]));
    assert.equal(retry.ok, true);
    assert.equal(cf.policy.include.filter(rule => rule.service_token?.token_id === token.id).length, 1);
    if (mode === "policyCommitError") assert.equal(retry.capabilities["access-policy"].action, "no-op");
    pass(`FLUME-57 ${mode}: explicit blocked/partial outcome, retained bound token and safe convergent retry`);
  }
  const configBefore = readFileSync(configPath, "utf8"), missing = YAML.parse(configBefore);
  delete missing.cloudflare.access_policy;
  writeFileSync(configPath, YAML.stringify(missing));
  const start = calls.length;
  const noConfig = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]), 1);
  assert.match(noConfig.capabilities["access-policy"].detail, /not-configured/);
  assert.ok(!calls.slice(start).some(call => call.url.includes("/access/apps/")));
  writeFileSync(configPath, configBefore);
  const unavailable = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"], { OP_POLICY_UNAVAILABLE: "1", CLOUDFLARE_API_TOKEN: CF_TOKEN }), 1);
  assert.match(unavailable.capabilities["access-policy"].detail, /credential-unavailable/);
  cf.policy.include.push({ any_valid_service_token: {} });
  const broad = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]), 1);
  assert.match(broad.capabilities["access-policy"].detail, /too-broad/);
  cf.policy.include.pop();
  const validPolicy = structuredClone(cf.policy);
  for (const invalid of [
    { ...validPolicy, decision: "allow" },
    { ...validPolicy, reusable: true },
    { ...validPolicy, include: [{ group: { service_token: { token_id: token.id } } }] },
    { ...validPolicy, include: null },
  ]) {
    cf.policy = invalid;
    const start = calls.length;
    const blocked = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]), 1);
    assert.equal(blocked.capabilities["access-policy"].action, "blocked");
    assert.ok(calls.slice(start).every(call => call.method === "GET"));
  }
  cf.policy = validPolicy;
  cf.policy.include = cf.policy.include.filter(rule => rule.service_token?.token_id !== token.id);
  cf.policyDrift = true;
  const drifted = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]), 1);
  assert.match(drifted.capabilities["access-policy"].detail, /readback-mismatch/);
  assert.ok(cf.policy.include.some(rule => rule.service_token?.token_id === token.id));
  cf.policyDrift = false;
  cf.policy.session_duration = validPolicy.session_duration; // fixture-only operator correction, not an automatic rollback
  json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]));
  pass("FLUME-57 full-policy readback detects non-membership setting drift instead of reporting ready");
  pass("FLUME-57 invalid, unresolved, shared and ambiguous policies fail closed with no policy write");
  pass("FLUME-57 missing config, missing explicit credential and broad policies block without global fallback");
}

// -- 3. foreign collisions are blockers, never clobbers ---------------------------------------
{
  cf.rules.push({ id: "rule-foreign", enabled: true, name: "someone else's", matchers: [{ type: "literal", field: "to", value: "oriole@agents.delo.sh" }], actions: [{ type: "forward", value: ["jaradd@gmail.com"] }] });
  cf.tokens.push({ id: "token-foreign", name: "employee-oriole", client_id: "foreign.access" });
  const deskDir2 = join(home, ".agents/workforce/oriole");
  mkdirSync(deskDir2, { recursive: true });
  writeFileSync(join(deskDir2, "agent.yaml"), YAML.stringify({
    schema_version: 1, id: "oriole", display_name: "Oriole", role: "infra",
    charter: { purpose: "Fixture employee" }, skills: { set: "first" }, memory: { write_bank: "agent-oriole", recall_banks: [] },
  }));
  json(spawnSync(process.execPath, [cli, "identity", "enroll", "oriole", "--apply", "--json"], { env: baseEnv, cwd: dir, encoding: "utf8" }));

  const preview = json(await runAsync(["identity", "provision", "oriole", "--json"]), 1);
  assert.equal(preview.ok, false);
  assert.equal(preview.capabilities.mailbox.action, "conflict");
  assert.equal(preview.capabilities["access-token"].action, "conflict");
  const applied = json(await runAsync(["identity", "provision", "oriole", "--apply", "--json"]), 1);
  assert.equal(applied.ok, false);
  assert.equal(cf.rules.filter((r) => r.matchers?.[0]?.value === "oriole@agents.delo.sh" && r.actions[0].type === "worker").length, 0, "foreign rule was clobbered");
  assert.equal(cf.tokens.filter((t) => t.name === "employee-oriole").length, 1, "duplicate token minted");
  assert.equal(desk().company_identity.handle, "rhea", "another employee's definition changed");
  pass("a foreign rule or token name blocks provisioning instead of clobbering it");
}

// -- 4. a vault failure after token creation deletes the orphan --------------------------------
{
  cf.tokens.length = 0;
  const deskDir3 = join(home, ".agents/workforce/lark");
  mkdirSync(deskDir3, { recursive: true });
  writeFileSync(join(deskDir3, "agent.yaml"), YAML.stringify({
    schema_version: 1, id: "lark", display_name: "Lark", role: "infra",
    charter: { purpose: "Fixture employee" }, skills: { set: "first" }, memory: { write_bank: "agent-lark", recall_banks: [] },
  }));
  json(spawnSync(process.execPath, [cli, "identity", "enroll", "lark", "--apply", "--json"], { env: baseEnv, cwd: dir, encoding: "utf8" }));
  const result = json(await runAsync(["identity", "provision", "lark", "--apply", "--json"], { OP_FAIL_EDIT: "1" }), 1);
  assert.equal(result.ok, false);
  assert.equal(result.capabilities["access-token"].action, "blocked");
  assert.match(result.capabilities["access-token"].detail, /orphan token .* deleted/iu);
  assert.equal(cf.tokens.length, 0, "orphan token survived at the provider");
  assert.equal(cf.deleted.length, 1);
  const receipts = readFileSync(join(state, "receipts.jsonl"), "utf8");
  assert.match(receipts, /deleted-orphan/u);
  pass("a failed vault write deletes the orphaned token at the provider");
}

// -- 5. enrollment gate ------------------------------------------------------------------------
{
  const deskDir4 = join(home, ".agents/workforce/wren");
  mkdirSync(deskDir4, { recursive: true });
  writeFileSync(join(deskDir4, "agent.yaml"), YAML.stringify({
    schema_version: 1, id: "wren", display_name: "Wren", role: "infra",
    charter: { purpose: "Fixture employee" }, skills: { set: "first" }, memory: { write_bank: "agent-wren", recall_banks: [] },
  }));
  const result = json(await runAsync(["identity", "provision", "wren", "--apply", "--json"]), 1);
  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].code, "not-enrolled");
  pass("an unenrolled employee is refused before any provider call");
}

// -- 6. section-qualified vault fields ---------------------------------------------------------
{
  // Real collision (operator's items, 2026-10-13): an identity item whose
  // Github App section already holds a different "Client ID" must not block
  // provisioning; the Access service token's fields belong to the
  // "Identity Service Token" section.
  const deskDir5 = join(home, ".agents/workforce/iris");
  mkdirSync(deskDir5, { recursive: true });
  writeFileSync(join(deskDir5, "agent.yaml"), YAML.stringify({
    schema_version: 1, id: "iris", display_name: "Iris", role: "infra",
    charter: { purpose: "Fixture employee" }, skills: { set: "first" }, memory: { write_bank: "agent-iris", recall_banks: [] },
  }));
  json(spawnSync(process.execPath, [cli, "identity", "enroll", "iris", "--apply", "--json"], { env: baseEnv, cwd: dir, encoding: "utf8" }));
  const itemsPath = join(dir, "op-items.json");
  const seeded = JSON.parse(readFileSync(itemsPath, "utf8"));
  seeded.push({ id: "item-iris", title: "Iris", fields: [
    { id: "iris-gh", label: "Client ID", value: "github-app-client-id-value", section: { label: "Github App" } },
    { id: "iris-gh-secret", label: "Client Secret", value: "github-app-secret", section: { label: "Github App" } },
  ] });
  writeFileSync(itemsPath, JSON.stringify(seeded, null, 2));

  const applied = json(await runAsync(["identity", "provision", "iris", "--apply", "--json"], { OP_MODE: "stale" }));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.capabilities["access-token"].action, "created");
  const irisItem = JSON.parse(readFileSync(itemsPath, "utf8")).find((i) => i.id === "item-iris");
  assert.equal(irisItem.fields.find((f) => f.section?.label === "Github App" && f.label === "Client ID").value, "github-app-client-id-value", "GitHub App field was overwritten");
  assert.equal(irisItem.fields.find((f) => f.section?.label === "Github App" && f.label === "Client Secret").value, "github-app-secret");
  assert.deepEqual(irisItem.fields.filter(f => f.section?.label === "Github App"), seeded.find(i => i.id === "item-iris").fields);
  assert.deepEqual(JSON.parse(readFileSync(itemsPath, "utf8")).filter(i => i.id !== "item-iris"), seeded.filter(i => i.id !== "item-iris"), "another employee's item changed");
  const accessSecret = irisItem.fields.find(f => f.section?.label === "Identity Service Token" && f.label === "Client Secret");
  const irisBlock = YAML.parse(readFileSync(join(deskDir5, "agent.yaml"), "utf8")).company_identity;
  assert.equal(irisBlock.bindings.cloudflare_access.credential_ref, `op://DeLoSecrets/${irisItem.id}/${accessSecret.id}`);
  assert.equal(accessSecret.value, CREATED_SECRET);
  assert.ok(irisItem.fields.some((f) => f.section?.label === "Identity Service Token" && f.label === "Client ID"), "sectioned Access field not written");

  // The overwrite guard still holds WITHIN the section: a pre-existing
  // different Access Client ID is a refusal, and its orphan is deleted.
  const seeded2 = JSON.parse(readFileSync(itemsPath, "utf8"));
  seeded2.push({ id: "item-finch", title: "Finch", fields: [
    { id: "finch-cid", label: "Client ID", value: "existing-different.access", section: { label: "Identity Service Token" } },
  ] });
  writeFileSync(itemsPath, JSON.stringify(seeded2, null, 2));
  const deskDir6 = join(home, ".agents/workforce/finch");
  mkdirSync(deskDir6, { recursive: true });
  writeFileSync(join(deskDir6, "agent.yaml"), YAML.stringify({
    schema_version: 1, id: "finch", display_name: "Finch", role: "infra",
    charter: { purpose: "Fixture employee" }, skills: { set: "first" }, memory: { write_bank: "agent-finch", recall_banks: [] },
  }));
  json(spawnSync(process.execPath, [cli, "identity", "enroll", "finch", "--apply", "--json"], { env: baseEnv, cwd: dir, encoding: "utf8" }));
  // A stranded field is diagnosed before minting; preview and repeat apply stay inert.
  writeFileSync(join(state, "receipts.jsonl"), readFileSync(join(state, "receipts.jsonl"), "utf8") + JSON.stringify({ employee: "finch", capability: "access-token", token_id: "old-deleted-token", action: "deleted-orphan", deleted: true }) + "\n");
  const beforeCalls = calls.length, beforeItems = readFileSync(itemsPath, "utf8");
  const refusedPreview = json(await runAsync(["identity", "provision", "finch", "--json"]), 1);
  assert.equal(refusedPreview.capabilities["access-token"].action, "conflict");
  assert.equal(refusedPreview.capabilities["access-token"].refs.provider_match, "absent");
  assert.match(refusedPreview.capabilities["access-token"].refs.receipt_comparison, /old-deleted-token:deleted/);
  const jsonPreview = await runAsync(["identity", "provision", "finch", "--json"]);
  assert.match(jsonPreview.stdout, /"client_id_fields": "finch-cid"/u);
  assert.match(jsonPreview.stdout, /old-deleted-token:deleted/u);
  assert.match(readFileSync(join(root, "docs/identity-provisioning.md"), "utf8"), /flume identity provision <employee> --json/u);
  pass("documented JSON recovery preview exposes safe field IDs, provider comparison and receipt outcomes");
  assert.ok(calls.slice(beforeCalls).every(c => c.method === "GET"));
  assert.equal(readFileSync(itemsPath, "utf8"), beforeItems);
  const refused = json(await runAsync(["identity", "provision", "finch", "--apply", "--json"]), 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.capabilities["access-token"].action, "conflict");
  assert.equal(refused.capabilities.mailbox.action, "created", "partial mailbox result was lost");
  assert.match(refused.capabilities["access-token"].detail, /refusing overwrite/);
  const repeatStart = calls.length;
  json(await runAsync(["identity", "provision", "finch", "--apply", "--json"]), 1);
  assert.ok(calls.slice(repeatStart).every(c => c.method === "GET"), "stranded retry minted/deleted or rewrote mailbox");
  assert.equal(readFileSync(itemsPath, "utf8"), beforeItems);
  assert.equal(cf.tokens.filter((t) => t.name === "employee-finch").length, 0);
  // Authorized fixture-only reconciliation: remove exactly the known stale section.
  const repaired = JSON.parse(beforeItems);
  repaired.find(i => i.id === "item-finch").fields = [];
  writeFileSync(itemsPath, JSON.stringify(repaired));
  const retry = json(await runAsync(["identity", "provision", "finch", "--apply", "--json"]));
  assert.equal(retry.capabilities["access-token"].action, "created");
  const final = json(await runAsync(["identity", "provision", "finch", "--apply", "--json"]));
  assert.equal(final.changed, false);
  pass("section collision preserved; stranded metadata/provider/receipt conflict blocks minting; authorized fixture recovery converges");
}

// -- FLUME-80: ambiguous writes retain the token, never claim success ---------------------------
const enrolledFixtures = ["rhea", "oriole", "lark", "wren", "iris", "finch"];
const enrollFixture = name => {
  enrolledFixtures.push(name);
  const path = join(home, ".agents/workforce", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "agent.yaml"), YAML.stringify({ schema_version: 1, id: name, display_name: name, role: "infra", charter: { purpose: "Fixture employee" }, skills: { set: "first" }, memory: { write_bank: `agent-${name}`, recall_banks: [] } }));
  json(spawnSync(process.execPath, [cli, "identity", "enroll", name, "--apply", "--json"], { env: baseEnv, cwd: dir, encoding: "utf8" }));
};
for (const mode of ["unreadable", "wrong-value", "partial", "success-empty", "duplicate-id", "duplicate-field", "signal"]) {
  const name = `uncertain-${mode}`;
  enrollFixture(name);
  const before = calls.length;
  const result = json(await runAsync(["identity", "provision", name, "--apply", "--json"], { OP_MODE: mode }), 1);
  assert.equal(result.capabilities["access-token"].action, "blocked");
  assert.match(result.capabilities["access-token"].detail, /retained, not deleted/);
  assert.equal(result.capabilities["vault-item"].action, "created");
  assert.equal(result.capabilities.mailbox.action, "created");
  assert.ok(!calls.slice(before).some(c => c.method === "DELETE"));
  assert.equal(cf.tokens.filter(t => t.name === `employee-${name}`).length, 1);
  const retryStart = calls.length;
  json(await runAsync(["identity", "provision", name, "--apply", "--json"]), 1);
  assert.ok(calls.slice(retryStart).every(c => c.method === "GET"));
  pass(`uncertain ${mode}: explicit partial result, retained token, retry does not mint/delete`);
}
{
  enrollFixture("persist-error");
  const result = json(await runAsync(["identity", "provision", "persist-error", "--apply", "--json"], { OP_MODE: "persist-error" }));
  assert.equal(result.capabilities["access-token"].action, "created");
  pass("nonzero edit with freshly confirmed persisted pair completes binding without deletion");
}
{
  enrollFixture("binding-refused");
  const before = calls.length;
  const result = json(await runAsync(["identity", "provision", "binding-refused", "--apply", "--json"], { OP_REFUSE_BINDING: join(home, ".agents/workforce/binding-refused/agent.yaml") }), 1);
  assert.equal(result.capabilities["access-token"].action, "blocked");
  assert.match(result.capabilities["access-token"].detail, /retained, not deleted/);
  assert.ok(!calls.slice(before).some(c => c.method === "DELETE"));
  assert.ok(cf.tokens.some(t => t.name === "employee-binding-refused"));
  pass("binding refusal after confirmed vault persistence retains the live token");
}
{
  enrollFixture("paged-conflict");
  cf.tokens.push({ id: "paged-remote", name: "employee-paged-conflict", client_id: "paged.access" });
  cf.pageSize = 1;
  const before = calls.length;
  const result = json(await runAsync(["identity", "provision", "paged-conflict", "--json"]), 1);
  cf.pageSize = undefined;
  assert.equal(result.capabilities["access-token"].action, "conflict");
  assert.ok(calls.slice(before).some(c => c.url.includes("page=2")));
  assert.ok(calls.slice(before).every(c => c.method === "GET"));
  pass("provider pagination finds later-page name collision before minting");
}
{
  enrollFixture("secret-only");
  const seeded = JSON.parse(readFileSync(baseEnv.OP_ITEMS, "utf8"));
  seeded.push({ id: "item-secret-only", title: "Secret-only", fields: [{ id: "old-secret", label: "Client Secret", value: CREATED_SECRET, section: { label: "Identity Service Token" } }] });
  writeFileSync(baseEnv.OP_ITEMS, JSON.stringify(seeded));
  const before = calls.length;
  const result = json(await runAsync(["identity", "provision", "secret-only", "--json"]), 1);
  assert.equal(result.capabilities["access-token"].action, "conflict");
  assert.equal(result.capabilities["access-token"].refs.vault_client_id, "absent");
  assert.equal(result.capabilities["access-token"].refs.vault_client_secret, "present");
  assert.ok(calls.slice(before).every(c => c.method === "GET"));
  await runAsync(["identity", "provision", "secret-only"]); // Human error rendering is scanned too.
  pass("secret-only partial pair blocks without disclosing it in JSON or human output");
}
{
  const before = calls.length, itemBefore = readFileSync(baseEnv.OP_ITEMS, "utf8");
  const result = json(await runAsync(["identity", "provision", "iris", "--apply", "--json"], { OP_MODE: "list-failed" }), 1);
  assert.equal(result.capabilities["vault-item"].action, "blocked");
  assert.equal(result.capabilities["access-token"].action, "blocked");
  assert.equal(result.capabilities.mailbox.action, "no-op");
  assert.ok(calls.slice(before).every(c => c.method === "GET"));
  assert.equal(readFileSync(baseEnv.OP_ITEMS, "utf8"), itemBefore);
  pass("unavailable fresh vault inventory fails closed without treating read failure as item absence");
}
for (const failure of ["failDelete", "lieDelete"]) {
  const name = failure.toLowerCase();
  enrollFixture(name);
  cf[failure] = true;
  const result = json(await runAsync(["identity", "provision", name, "--apply", "--json"], { OP_FAIL_EDIT: "1" }), 1);
  cf[failure] = false;
  assert.equal(result.capabilities["access-token"].action, "blocked");
  assert.match(result.capabilities["access-token"].detail, /cleanup FAILED or unconfirmed/);
  const token = cf.tokens.find(t => t.name === `employee-${name}`);
  assert.ok(token);
  const receipts = readFileSync(join(state, "receipts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const row = receipts.filter(r => r.employee === name).find(r => r.action === "cleanup-unconfirmed");
  assert.equal(row.deleted, false);
  assert.ok(!receipts.some(r => r.employee === name && r.action === "deleted-orphan"));
  pass(`${failure}: cleanup not claimed without provider absence confirmation`);
}

{
  enrollFixture("retained-lifecycle");
  const provisioned = json(await runAsync(["identity", "provision", "retained-lifecycle", "--apply", "--json"], { OP_MODE: "unreadable" }), 1);
  const token = cf.tokens.find(t => t.name === "employee-retained-lifecycle");
  assert.ok(token);
  assert.equal(provisioned.capabilities["access-token"].action, "blocked");
  const receiptRows = readFileSync(join(state, "receipts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(receiptRows.some(r => r.token_id === token.id && r.subject && r.account_id === ACCOUNT && r.action === "minted"));
  const inventory = json(await runAsync(["identity", "credentials", "retained-lifecycle", "--json"]));
  const pending = inventory.credentials.find(r => r.kind === "pending-access-issuance" && r.id === token.id);
  assert.ok(pending, JSON.stringify(inventory.credentials));
  assert.equal(pending.status, "static-usable");
  assert.equal(inventory.complete_revocation, false);
  const human = await runAsync(["identity", "credentials", "retained-lifecycle"]);
  assert.match(human.stdout, /pending-access-issuance/u);
  assert.match(human.stdout, /revocation INCOMPLETE/u);
  const before = calls.length;
  const preview = json(await runAsync(["identity", "retire", "retained-lifecycle", "--revoke", "cloudflare_access", "--json"]));
  assert.ok(preview.steps.some(s => s.key === `cloudflare_access:pending-token-delete:${token.id}`));
  assert.ok(calls.slice(before).every(c => c.method === "GET"));
  cf.failDelete = true;
  const failed = json(await runAsync(["identity", "retire", "retained-lifecycle", "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  cf.failDelete = false;
  assert.ok(failed.steps.some(s => s.key === `cloudflare_access:pending-token-delete:${token.id}` && s.outcome === "unresolved"), JSON.stringify(failed.steps));
  assert.equal(failed.complete_revocation, false);
  assert.ok(cf.tokens.some(t => t.id === token.id));
  const retired = json(await runAsync(["identity", "retire", "retained-lifecycle", "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.ok(retired.steps.some(s => s.key === `cloudflare_access:pending-token-delete:${token.id}` && s.outcome === "done"), JSON.stringify(retired.steps));
  assert.ok(!cf.tokens.some(t => t.id === token.id));
  assert.equal(retired.credentials.find(r => r.kind === "pending-access-issuance" && r.id === token.id)?.status, "revoked");
  const againStart = calls.length;
  const again = json(await runAsync(["identity", "retire", "retained-lifecycle", "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.ok(again.steps.some(s => s.key === `cloudflare_access:pending-token-delete:${token.id}` && s.outcome === "already-done"));
  assert.ok(!calls.slice(againStart).some(c => c.method === "DELETE"));
  pass("real CLI provision failure to credentials and permissioned retirement: retained token inventoried, failed DELETE incomplete, verified retry and no-op repeat");
}
{
  enrollFixture("ownership-mismatch");
  json(await runAsync(["identity", "provision", "ownership-mismatch", "--apply", "--json"], { OP_MODE: "unreadable" }), 1);
  const token = cf.tokens.find(t => t.name === "employee-ownership-mismatch");
  token.name = "employee-foreign";
  const before = calls.length;
  const result = json(await runAsync(["identity", "retire", "ownership-mismatch", "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  assert.equal(result.complete_revocation, false);
  assert.ok(result.steps.some(s => s.provider_code === "pending-token-owner-mismatch"));
  assert.ok(cf.tokens.some(t => t.id === token.id));
  assert.ok(!calls.slice(before).some(c => c.method === "DELETE" && c.url.includes(token.id)));
  pass("retained receipt with changed provider ownership cannot authorize Access deletion or complete revocation");
}
{
  enrollFixture("principal-mismatch");
  json(await runAsync(["identity", "provision", "principal-mismatch", "--apply", "--json"], { OP_MODE: "unreadable" }), 1);
  const token = cf.tokens.find(t => t.name === "employee-principal-mismatch");
  token.client_id = "changed-principal.access";
  const before = calls.length;
  const result = json(await runAsync(["identity", "retire", "principal-mismatch", "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  assert.equal(result.complete_revocation, false);
  assert.ok(result.steps.some(s => s.provider_code === "pending-token-owner-mismatch"));
  assert.ok(!calls.slice(before).some(c => c.method === "DELETE" && c.url.includes(token.id)));
  pass("retained token with matching name but changed client ID cannot be deleted from issuance receipt");
}
{
  enrollFixture("retained-clamped");
  json(await runAsync(["identity", "provision", "retained-clamped", "--apply", "--json"], { OP_MODE: "unreadable" }), 1);
  const token = cf.tokens.find(t => t.name === "employee-retained-clamped");
  cf.pageSize = 1; cf.clampedPageMetadata = true;
  const inventory = json(await runAsync(["identity", "credentials", "retained-clamped", "--json"]));
  assert.equal(inventory.credentials.find(r => r.kind === "pending-access-issuance" && r.id === token.id)?.status, "static-usable");
  const before = calls.length;
  const result = json(await runAsync(["identity", "retire", "retained-clamped", "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.ok(result.steps.some(s => s.key === `cloudflare_access:pending-token-delete:${token.id}` && s.outcome === "done"));
  assert.ok(calls.slice(before).some(c => c.url.includes("service_tokens") && c.url.includes("page=2")));
  assert.ok(!cf.tokens.some(t => t.id === token.id));
  cf.pageSize = undefined; cf.clampedPageMetadata = false;
  pass("pending-token inventory and permissioned retirement read clamped provider pages through verified absence");
}
{
  enrollFixture("unscoped-receipt");
  writeFileSync(join(state, "receipts.jsonl"), readFileSync(join(state, "receipts.jsonl"), "utf8") + JSON.stringify({ employee: "unscoped-receipt", capability: "access-token", token_id: "legacy-token", action: "minted" }) + "\n");
  const inventory = json(await runAsync(["identity", "credentials", "unscoped-receipt", "--json"]));
  assert.equal(inventory.credentials.find(r => r.provider === "cloudflare_access")?.status, "unverified");
  assert.equal(inventory.complete_revocation, false);
  const before = calls.length;
  const result = json(await runAsync(["identity", "retire", "unscoped-receipt", "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.equal(result.complete_revocation, false);
  assert.ok(result.steps.some(s => s.provider_code === "issuance-receipt-uncertain" && s.outcome === "skipped"));
  assert.ok(!calls.slice(before).some(c => c.method === "DELETE" && c.url.includes("service_tokens")));
  pass("historical unscoped issuance receipt blocks complete revocation but never permits provider delete");
}
{
  enrollFixture("tampered-receipt");
  const token = { id: "tampered-token", name: "employee-tampered-receipt", client_id: "tampered.access" };
  cf.tokens.push(token);
  writeFileSync(join(state, "receipts.jsonl"), readFileSync(join(state, "receipts.jsonl"), "utf8") + JSON.stringify({ employee: "tampered-receipt", capability: "access-token", token_id: token.id, action: "deleted-orphan", deleted: true }) + "\n");
  const inventory = json(await runAsync(["identity", "credentials", "tampered-receipt", "--json"]));
  assert.ok(inventory.credentials.some(r => r.kind === "unattributed-access-token" && r.id === token.id && r.status === "unverified"));
  assert.equal(inventory.complete_revocation, false);
  pass("live named provider token defeats historical deleted receipt when issuance cannot be attributed");
}
{
  enrollFixture("clamped-pages");
  cf.tokens.push({ id: "clamped-remote", name: "employee-clamped-pages", client_id: "clamped.access" });
  cf.pageSize = 1; cf.clampedPageMetadata = true;
  const before = calls.length;
  const result = json(await runAsync(["identity", "provision", "clamped-pages", "--apply", "--json"]), 1);
  assert.equal(result.capabilities["access-token"].action, "conflict");
  assert.equal(cf.tokens.filter(t => t.name === "employee-clamped-pages").length, 1);
  assert.ok(calls.slice(before).some(c => c.url.includes("page=2")));
  cf.clampedPageMetadata = false;
  pass("clamped served per_page without total_pages discovers later-page token before apply");
}
{
  enrollFixture("metadata-less");
  cf.tokens.push({ id: "metadata-remote", name: "employee-metadata-less", client_id: "metadata.access" });
  cf.pageSize = 1; cf.noPageMetadata = true;
  const before = calls.length;
  const result = json(await runAsync(["identity", "provision", "metadata-less", "--apply", "--json"]), 1);
  assert.equal(result.capabilities["access-token"].action, "conflict");
  assert.ok(calls.slice(before).some(c => c.url.includes("page=2")));
  assert.ok(calls.slice(before).some(c => c.url.includes(`page=${cf.tokens.length + 1}`)));
  cf.noPageMetadata = false;
  pass("metadata-less inventory reads through empty page instead of minting duplicate");
}
{
  enrollFixture("repeated-page");
  cf.pageSize = 1; cf.clampedPageMetadata = true; cf.repeatPage = true;
  const before = calls.length;
  const result = json(await runAsync(["identity", "provision", "repeated-page", "--apply", "--json"]), 1);
  assert.equal(result.capabilities["access-token"].action, "blocked");
  assert.ok(calls.slice(before).some(c => c.url.includes("page=2")));
  assert.ok(!calls.slice(before).some(c => c.method === "POST" && c.url.includes("service_tokens")));
  cf.pageSize = undefined; cf.clampedPageMetadata = false; cf.repeatPage = false;
  pass("repeated provider page blocks token mint instead of claiming inventory complete");
}
{
  enrollFixture("inconsistent-pages");
  cf.pageSize = 1; cf.inconsistentPages = true;
  cf.tokens.push({ id: "inconsistent-filler", name: "someone-else", client_id: "unrelated.access" });
  const before = calls.length;
  const result = json(await runAsync(["identity", "provision", "inconsistent-pages", "--apply", "--json"]), 1);
  assert.equal(result.capabilities["access-token"].action, "blocked");
  assert.ok(calls.slice(before).some(c => c.url.includes("page=2")));
  assert.ok(!calls.slice(before).some(c => c.method === "POST" && c.url.includes("service_tokens")));
  cf.pageSize = undefined; cf.inconsistentPages = false;
  pass("inconsistent total_pages metadata blocks mint without claiming authoritative absence");
}
{
  enrollFixture("page-cap");
  cf.pageSize = 1; cf.repeatPage = false; cf.noPageMetadata = true;
  const before = calls.length;
  cf.tokens.push(...Array.from({ length: 101 }, (_, i) => ({ id: `cap-${i}`, name: `unrelated-${i}`, client_id: `cap-${i}.access` })));
  const result = json(await runAsync(["identity", "provision", "page-cap", "--apply", "--json"]), 1);
  assert.equal(result.capabilities["access-token"].action, "blocked");
  assert.ok(calls.slice(before).some(c => c.url.includes("page=100")));
  assert.ok(!calls.slice(before).some(c => c.url.includes("page=101") || c.method === "POST" && c.url.includes("service_tokens")));
  cf.pageSize = undefined; cf.noPageMetadata = false;
  cf.tokens.splice(cf.tokens.findIndex(t => t.id === "cap-0"), 101);
  pass("bounded 100-page inventory fails closed without mint or unbounded provider reads");
}
{
  enrollFixture("stranded-clamped");
  const seeded = JSON.parse(readFileSync(baseEnv.OP_ITEMS, "utf8"));
  seeded.push({ id: "item-stranded-clamped", title: "Stranded-clamped", fields: [{ id: "stranded-id", label: "Client ID", value: "stranded.access", section: { label: "Identity Service Token" } }] });
  writeFileSync(baseEnv.OP_ITEMS, JSON.stringify(seeded));
  cf.tokens.push({ id: "stranded-remote", name: "employee-stranded-clamped", client_id: "stranded.access" });
  writeFileSync(join(state, "receipts.jsonl"), readFileSync(join(state, "receipts.jsonl"), "utf8") + JSON.stringify({ employee: "stranded-clamped", capability: "access-token", token_id: "stranded-remote", action: "deleted-orphan", deleted: true }) + "\n");
  cf.pageSize = 1; cf.clampedPageMetadata = true;
  const result = json(await runAsync(["identity", "provision", "stranded-clamped", "--json"]), 1);
  assert.equal(result.capabilities["access-token"].refs.provider_match, "stranded-remote");
  assert.match(result.capabilities["access-token"].refs.receipt_comparison, /stranded-remote:deleted/u);
  cf.pageSize = undefined; cf.clampedPageMetadata = false;
  pass("later-page stranded token overrides historical deleted receipt; JSON preview reports actual provider match");
}

// -- Independent quality blockers: malformed inventory, cross-employee ownership, contradictory receipts --
const fixtureBlock = name => YAML.parse(readFileSync(join(home, ".agents/workforce", name, "agent.yaml"), "utf8")).company_identity;
const appendReceipt = row => writeFileSync(join(state, "receipts.jsonl"), readFileSync(join(state, "receipts.jsonl"), "utf8") + JSON.stringify(row) + "\n");
const retained = async name => {
  enrollFixture(name);
  json(await runAsync(["identity", "provision", name, "--apply", "--json"], { OP_MODE: "unreadable" }), 1);
  const token = cf.tokens.find(t => t.name === `employee-${name}`);
  assert.ok(token);
  return token;
};
const noTokenDelete = (before, token) => {
  assert.ok(cf.tokens.some(t => t.id === token.id), "another employee's or quarantined token was deleted");
  assert.ok(!calls.slice(before).some(c => c.method === "DELETE" && c.url.includes("service_tokens")), "unsafe Access DELETE attempted");
};
const bindFixture = (name, token, extra = {}) => {
  const result = spawnSync(process.execPath, [cli, "identity", "bind", name, "cloudflare_access", "--principal", token.client_id, "--instance", ISSUER, "--credential-ref", "op://DeLoSecrets/item-fixture/secret", "--apply", "--json"], { env: { ...baseEnv, ...extra }, cwd: dir, encoding: "utf8", timeout: 30_000 });
  cliArtifacts.push(result.stdout ?? "", result.stderr ?? "");
  return result;
};
{
  const token = await retained("duplicate-retained");
  enrollFixture("duplicate-preflight");
  assert.notEqual(cf.tokens[0].id, token.id);
  cf.samePageDuplicate = true;
  const before = calls.length;
  for (const args of [[], ["--apply"]]) {
    const result = json(await runAsync(["identity", "provision", "duplicate-preflight", ...args, "--json"]), 1);
    assert.equal(result.capabilities["access-token"].action, "blocked");
  }
  const inventory = json(await runAsync(["identity", "credentials", "duplicate-retained", "--json"]));
  const pending = inventory.credentials.find(r => r.kind === "pending-access-issuance" && r.id === token.id);
  assert.ok(pending && !["revoked", "not-issued"].includes(pending.status));
  assert.equal(pending.read_back, undefined);
  assert.equal(inventory.complete_revocation, false);
  const result = json(await runAsync(["identity", "retire", "duplicate-retained", "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  assert.equal(result.complete_revocation, false);
  assert.ok(result.steps.some(s => s.provider_code === "listing-incomplete"));
  assert.ok(!calls.slice(before).some(c => c.method === "POST" && c.url.includes("service_tokens")));
  noTokenDelete(before, token);
  cf.samePageDuplicate = false;
  pass("Q1 same-page duplicate IDs block preview/apply mint, retained inventory absence and false-clean retirement");
}
{
  enrollFixture("duplicate-bound");
  json(await runAsync(["identity", "provision", "duplicate-bound", "--apply", "--json"]));
  const token = cf.tokens.find(t => t.name === "employee-duplicate-bound");
  cf.failDelete = true;
  json(await runAsync(["identity", "suspend", "duplicate-bound", "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  cf.failDelete = false;
  cf.samePageDuplicate = true;
  const before = calls.length;
  const result = json(await runAsync(["identity", "retire", "duplicate-bound", "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  assert.equal(result.complete_revocation, false);
  assert.ok(result.steps.some(s => s.provider_code === "listing-incomplete"));
  noTokenDelete(before, token);
  cf.samePageDuplicate = false;
  pass("Q1 malformed duplicate page blocks bound-token retry even with a remembered failed DELETE ID");
}
for (const [variant, row] of [
  ["id-only", token => ({ id: token.id })],
  ["blank-name", token => ({ id: token.id, name: "  ", client_id: token.client_id })],
  ["blank-client", token => ({ id: token.id, name: token.name, client_id: "  " })],
  ["non-object", () => null],
]) {
  const name = `malformed-bound-${variant}`;
  enrollFixture(name);
  json(await runAsync(["identity", "provision", name, "--apply", "--json"]));
  const token = cf.tokens.find(t => t.name === `employee-${name}`);
  assert.ok(token);
  const beforeHealthy = json(await runAsync(["identity", "credentials", name, "--json"]));
  assert.equal(beforeHealthy.credentials.find(r => r.kind === "access-service-token")?.status, "static-usable");
  const healthyProvision = json(await runAsync(["identity", "provision", name, "--json"]));
  assert.equal(healthyProvision.capabilities["access-token"].action, "no-op");
  cf.malformedRows = { id: token.id, row };
  const before = calls.length;
  const blockedProvision = json(await runAsync(["identity", "provision", name, "--apply", "--json"]), 1);
  assert.equal(blockedProvision.capabilities["access-token"].action, "blocked");
  assert.ok(!calls.slice(before).some(c => c.method === "POST" && c.url.includes("service_tokens")));
  const inventory = json(await runAsync(["identity", "credentials", name, "--json"]));
  const bound = inventory.credentials.find(r => r.kind === "access-service-token");
  assert.equal(bound?.status, "unresolved");
  assert.equal(bound?.provider_code, "listing-incomplete");
  assert.equal(bound?.read_back, undefined);
  assert.equal(inventory.complete_revocation, false);
  const retired = json(await runAsync(["identity", "retire", name, "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  assert.equal(retired.complete_revocation, false);
  assert.ok(retired.steps.some(s => s.provider_code === "listing-incomplete" && s.outcome === "unresolved"));
  assert.notEqual(retired.credentials.find(r => r.kind === "access-service-token")?.status, "revoked");
  noTokenDelete(before, token);
  cf.malformedRows = undefined;
  const recovered = json(await runAsync(["identity", "retire", name, "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.ok(recovered.steps.some(s => s.key === `cloudflare_access:token-delete:${token.client_id}` && s.outcome === "done"));
  assert.ok(!cf.tokens.some(t => t.id === token.id));
  assert.equal(recovered.credentials.find(r => r.kind === "access-service-token")?.read_back, "absent");
  pass(`R1 ${variant}: malformed bound Access row blocks false absence and DELETE; complete listing recovers`);
}
{
  const token = await retained("malformed-unbound");
  cf.malformedRows = { id: token.id, row: current => ({ id: current.id }) };
  enrollFixture("malformed-preflight");
  const before = calls.length;
  for (const args of [[], ["--apply"]]) {
    const result = json(await runAsync(["identity", "provision", "malformed-preflight", ...args, "--json"]), 1);
    assert.equal(result.capabilities["access-token"].action, "blocked");
  }
  assert.ok(!calls.slice(before).some(c => c.method === "POST" && c.url.includes("service_tokens")));
  const inventory = json(await runAsync(["identity", "credentials", "malformed-unbound", "--json"]));
  const pending = inventory.credentials.find(r => r.kind === "pending-access-issuance" && r.id === token.id);
  assert.ok(pending && pending.status !== "revoked");
  assert.equal(pending.read_back, undefined);
  assert.equal(pending.provider_code, "listing-incomplete");
  assert.equal(inventory.complete_revocation, false);
  const retired = json(await runAsync(["identity", "retire", "malformed-unbound", "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  assert.equal(retired.complete_revocation, false);
  assert.ok(retired.steps.some(s => s.provider_code === "listing-incomplete"));
  noTokenDelete(before, token);
  cf.malformedRows = undefined;
  const recovered = json(await runAsync(["identity", "retire", "malformed-unbound", "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.ok(recovered.steps.some(s => s.key === `cloudflare_access:pending-token-delete:${token.id}` && s.outcome === "done"));
  assert.ok(!cf.tokens.some(t => t.id === token.id));
  assert.equal(recovered.credentials.find(r => r.kind === "pending-access-issuance" && r.id === token.id)?.read_back, "absent");
  const mint = json(await runAsync(["identity", "provision", "malformed-preflight", "--apply", "--json"]));
  assert.equal(mint.capabilities["access-token"].action, "created");
  pass("R1 ID-only unbound row blocks mint and false-clean retirement; full-row recovery permits verified deletion and mint");
}
{
  enrollFixture("malformed-no-binding");
  const token = { id: "unknown-malformed-token", name: "employee-malformed-no-binding", client_id: "malformed-no-binding.access" };
  cf.tokens.push(token);
  cf.malformedRows = { id: token.id, row: current => ({ id: current.id }) };
  const inventory = json(await runAsync(["identity", "credentials", "malformed-no-binding", "--json"]));
  const access = inventory.credentials.find(r => r.provider === "cloudflare_access");
  assert.equal(access?.status, "unverified");
  assert.equal(access?.provider_code, "listing-incomplete");
  assert.equal(inventory.complete_revocation, false);
  cf.malformedRows = undefined;
  const recovered = json(await runAsync(["identity", "credentials", "malformed-no-binding", "--json"]));
  assert.ok(recovered.credentials.some(r => r.kind === "unattributed-access-token" && r.id === token.id));
  cf.tokens.splice(cf.tokens.indexOf(token), 1);
  pass("R1 malformed unbound unreceipted token never claims not-issued; full listing exposes unattributed token");
}
{
  const token = await retained("reserved-issuance");
  enrollFixture("reserved-recipient");
  const rejected = json(bindFixture("reserved-recipient", token), 1);
  assert.ok(rejected.blockers.some(b => b.code === "pending-issuance-reserved"));
  assert.equal(fixtureBlock("reserved-recipient").bindings, undefined);
  pass("Q2 normal CLI bind refuses another subject's pending Access issuance");
}
for (const ownerState of ["active", "suspended", "tombstone"]) {
  const name = `owner-${ownerState}`, recipient = `recipient-${ownerState}`;
  enrollFixture(recipient);
  // Real CLI bind during issuance, before the minted journal line exists: also models pre-fix accepted bindings.
  cf.onTokenCreate = token => json(bindFixture(recipient, token));
  const token = await retained(name);
  assert.equal(fixtureBlock(recipient).bindings.cloudflare_access.principal, token.client_id);
  if (ownerState === "suspended") json(await runAsync(["identity", "status", recipient, "suspended", "--apply", "--json"]));
  if (ownerState === "tombstone") {
    json(await runAsync(["identity", "retire", recipient, "--revoke", "github", "--apply", "--json"]));
    rmSync(join(home, ".agents/workforce", recipient), { recursive: true });
    enrolledFixtures.splice(enrolledFixtures.indexOf(recipient), 1);
  }
  const before = calls.length;
  const result = json(await runAsync(["identity", "retire", name, "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  assert.equal(result.complete_revocation, false);
  assert.ok(result.steps.some(s => s.provider_code === "access-owner-conflict"));
  assert.equal(result.credentials.find(r => r.kind === "pending-access-issuance" && r.id === token.id)?.status, "unresolved");
  noTokenDelete(before, token);
  if (ownerState !== "tombstone") {
    const recipientInventory = json(await runAsync(["identity", "credentials", recipient, "--json"]));
    assert.equal(recipientInventory.credentials.find(r => r.kind === "access-service-token")?.status, "static-usable");
  }
  pass(`Q2 pending retirement preserves ${ownerState} owner's bound token and reports incomplete`);
}
{
  const token = await retained("late-owner");
  enrollFixture("late-recipient");
  const before = calls.length;
  cf.onAllowlistRead = () => {
    assert.equal(fixtureBlock("late-owner").status, "retired", "race was not after status publication");
    // Import a previously accepted binding through the real CLI with its old empty receipt projection.
    json(bindFixture("late-recipient", token, { FLUME_PROVISION_STATE: join(dir, "old-receipt-projection") }));
  };
  const result = json(await runAsync(["identity", "retire", "late-owner", "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  assert.ok(result.steps.some(s => s.provider_code === "access-owner-conflict"));
  assert.equal(result.complete_revocation, false);
  noTokenDelete(before, token);
  pass("Q2 re-reads census after status publication and provider listing before pending DELETE");
}
for (const variant of ["minted", "created", "deleted", "bound", "during-list", "deleted-client"]) {
  const name = `contradictory-${variant}`, token = await retained(name);
  const firstClient = token.client_id, block = fixtureBlock(name);
  if (variant === "bound") json(bindFixture(name, token));
  const contradictory = { employee: name, subject: block.subject, account_id: ACCOUNT, capability: "access-token", action: "minted", token_id: token.id, client_id: `changed-${variant}.access` };
  token.client_id = contradictory.client_id;
  if (variant === "during-list") cf.onTokenList = () => appendReceipt(contradictory);
  else if (variant !== "deleted-client") appendReceipt(contradictory);
  if (variant === "created") appendReceipt({ ...contradictory, action: "created" });
  if (variant === "deleted" || variant === "deleted-client") appendReceipt({ ...contradictory, action: "deleted-orphan", deleted: true });
  const before = calls.length;
  const result = json(await runAsync(["identity", "retire", name, "--revoke", "cloudflare_access", "--apply", "--json"]), variant === "during-list" ? 1 : 0);
  assert.equal(result.complete_revocation, false);
  assert.ok(result.steps.some(s => s.provider_code === "issuance-receipt-uncertain"));
  assert.ok(result.credentials.some(r => r.provider_code === "issuance-receipt-uncertain" && r.status === "unverified"));
  noTokenDelete(before, token);
  // Contradiction stays quarantined on repeat even if the provider returns the original attribution or absence.
  token.client_id = firstClient;
  const again = json(await runAsync(["identity", "retire", name, "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.equal(again.complete_revocation, false);
  noTokenDelete(before, token);
  pass(`Q3 ${variant}: contradictory scoped receipts quarantine Access deletion and prevent false completion`);
}
{
  const name = "identical-receipts", token = await retained(name), block = fixtureBlock(name);
  appendReceipt({ employee: name, subject: block.subject, account_id: ACCOUNT, capability: "access-token", action: "minted", token_id: token.id, client_id: token.client_id });
  const result = json(await runAsync(["identity", "retire", name, "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.ok(result.steps.some(s => s.key === `cloudflare_access:pending-token-delete:${token.id}` && s.outcome === "done"));
  assert.ok(!cf.tokens.some(t => t.id === token.id));
  pass("identical issuance receipts retain original attribution and allow verified retirement");
}

// -- FLUME-57: failure before mint, partial after mint, and lifecycle convergence ------------
{
  const name = "policy-new-denied";
  enrollFixture(name);
  cf.policyDenied = true;
  const before = calls.length;
  const refused = json(await runAsync(["identity", "provision", name, "--apply", "--json"]), 1);
  assert.match(refused.capabilities["access-policy"].detail, /permission-denied/);
  assert.ok(!calls.slice(before).some(call => call.method === "POST" && call.url.includes("service_tokens")));
  cf.policyDenied = false;
  pass("FLUME-57 policy read permission preflight blocks minting for a new employee");
}
for (const command of ["suspend", "retire"]) {
  const name = `policy-${command}`;
  enrollFixture(name);
  cf.policyWriteDenied = true;
  const partial = json(await runAsync(["identity", "provision", name, "--apply", "--json"]), 1);
  const token = cf.tokens.find(t => t.name === `employee-${name}`);
  assert.ok(token);
  assert.equal(partial.capabilities["access-token"].action, "created");
  assert.equal(partial.capabilities["access-policy"].action, "blocked");
  assert.equal(partial.changed, true);
  cf.policyWriteDenied = false;
  const retryStart = calls.length;
  json(await runAsync(["identity", "provision", name, "--apply", "--json"]));
  assert.ok(!calls.slice(retryStart).some(call => call.method === "POST"));
  const policyBefore = structuredClone(cf.policy);
  const previewStart = calls.length;
  json(await runAsync(["identity", command, name, "--revoke", "cloudflare_access", "--json"]));
  assert.ok(calls.slice(previewStart).every(call => call.method === "GET"));
  assert.equal(fixtureBlock(name).status, "active");
  assert.deepEqual(cf.policy, policyBefore);
  // Fail policy cleanup but allow the existing token-delete step to close authentication.
  cf.policyWriteDenied = true;
  const failed = json(await runAsync(["identity", command, name, "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
  assert.equal(failed.complete_revocation, false);
  assert.equal(fixtureBlock(name).status, command === "retire" ? "retired" : "suspended");
  assert.ok(failed.steps.some(step => step.action === "policy-membership-remove" && step.outcome === "unresolved"));
  assert.ok(failed.credentials.some(row => row.kind === "access-policy-membership" && row.status !== "revoked"));
  assert.ok(!cf.tokens.some(t => t.id === token.id), "token cleanup did not continue after policy failure");
  assert.ok(cf.policy.include.some(rule => rule.service_token?.token_id === token.id));
  cf.policyWriteDenied = false;
  const recovered = json(await runAsync(["identity", command, name, "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.equal(recovered.credentials.find(row => row.kind === "access-policy-membership").status, "revoked");
  assert.deepEqual(cf.policy, { ...policyBefore, include: policyBefore.include.filter(rule => rule.service_token?.token_id !== token.id) });
  assert.ok(recovered.steps.some(step => step.action === "policy-membership-remove" && step.outcome === "done"));
  const doneStart = calls.length;
  json(await runAsync(["identity", command, name, "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.ok(calls.slice(doneStart).every(call => call.method === "GET"), "repeat cleanup rewrote policy/deleted token");
  // A membership reintroduced out of band is new work even after a done lifecycle step.
  cf.policy.include.push({ service_token: { token_id: token.id } });
  const reintroduced = json(await runAsync(["identity", command, name, "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.ok(reintroduced.steps.some(step => step.action === "policy-membership-remove" && step.outcome === "done"));
  assert.ok(!cf.policy.include.some(rule => rule.service_token?.token_id === token.id));
  pass(`FLUME-57 ${command}: partial issuance retries without minting; denied policy cleanup remains incomplete after token deletion; captured-ID retry preserves others and repeats converge`);
}
{
  const name = "policy-external-delete";
  enrollFixture(name);
  json(await runAsync(["identity", "provision", name, "--apply", "--json"]));
  const token = cf.tokens.find(t => t.name === `employee-${name}`);
  cf.tokens = cf.tokens.filter(t => t.id !== token.id);
  const result = json(await runAsync(["identity", "retire", name, "--revoke", "cloudflare_access", "--apply", "--json"]));
  assert.equal(result.credentials.find(row => row.kind === "access-policy-membership").status, "revoked");
  assert.ok(!cf.policy.include.some(rule => rule.service_token?.token_id === token.id));
  pass("FLUME-57 subject-scoped receipt recovers policy membership after out-of-band token deletion");
}

// -- no secret lands in any artifact ---------------------------------------------------------
{
  secrets.add("github-app-secret");
  secrets.add("vault-session-token");
  const receipts = existsSync(join(state, "receipts.jsonl")) ? readFileSync(join(state, "receipts.jsonl"), "utf8") : "";
  const definitions = enrolledFixtures.map(name => readFileSync(join(home, ".agents/workforce", name, "agent.yaml"), "utf8")).join("\n");
  const artifacts = receipts + definitions + cliArtifacts.join("\n") + readFileSync(configPath, "utf8");
  for (const secret of secrets) assert.ok(!artifacts.includes(secret), "CLI/errors/receipts/definitions leaked a fixture secret");
  pass("all CLI JSON/stdout/stderr, receipts and definitions withhold secrets on success and every failure");
}

server.close();
rmSync(work, { recursive: true, force: true });
console.log(`identity-provision-regressions: ${count} passed`);
