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
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync("/tmp/flume56-");
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

const ACCOUNT = "a".repeat(32), ZONE = "z".replace(/z/g, "b").repeat(32), KVNS = "c".repeat(32);
const ISSUER = "https://fixture.cloudflareaccess.com";
const CF_TOKEN = "fixture-cloudflare-provisioning-token";
const TOKEN_REF = "op://DeLoSecrets/Cloudflare/provisioning-token";
const CREATED_SECRET = "created-access-client-secret-value";
/** Every secret the suite creates; scanned for in every artifact at the end. */
const secrets = new Set([CF_TOKEN, CREATED_SECRET]);

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
const itemsPath = process.env.OP_ITEMS;
const items = () => fs.existsSync(itemsPath) ? JSON.parse(fs.readFileSync(itemsPath, "utf8")) : [];
const save = (list) => fs.writeFileSync(itemsPath, JSON.stringify(list, null, 2));
const fid = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
if (args[0] === "read") {
  if (args[1] === ${JSON.stringify(TOKEN_REF)}) { process.stdout.write(${JSON.stringify(CF_TOKEN)}); process.exit(0); }
  process.exit(2);
}
if (args[0] === "item" && args[1] === "list") {
  process.stdout.write(JSON.stringify(items().map(({ id, title }) => ({ id, title }))));
  process.exit(0);
}
if (args[0] === "item" && args[1] === "get") {
  const item = items().find((i) => i.title === args[2] || i.id === args[2]);
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
  if (process.env.OP_FAIL_EDIT === "1") { process.stderr.write("fixture: vault write refused\\n"); process.exit(1); }
  const list = items();
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
  save(list);
  process.stdout.write(JSON.stringify(item));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });

// A fake Cloudflare API with just the surface provisioning uses.
const calls = [];
const cf = {
  tokens: [], rules: [], kv: new Map(), deleted: [],
};
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => body += c);
  req.on("end", () => {
    calls.push({ method: req.method, url: req.url, authed: req.headers.authorization === `Bearer ${CF_TOKEN}` });
    const send = (status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    const url = new URL(req.url, "http://cf.fixture");
    const ok = (result) => send(200, { success: true, result });
    if (req.headers.authorization !== `Bearer ${CF_TOKEN}`) return send(403, { success: false, errors: [{ message: "bad token" }] });
    if (req.method === "GET" && url.pathname === `/accounts/${ACCOUNT}/access/service_tokens`) return ok(cf.tokens);
    if (req.method === "POST" && url.pathname === `/accounts/${ACCOUNT}/access/service_tokens`) {
      const token = { id: `token-${randomUUID().slice(0, 8)}`, name: JSON.parse(body).name, client_id: `${randomUUID().replace(/-/g, "")}.access`, client_secret: CREATED_SECRET, expires_at: "2027-10-13T00:00:00Z" };
      cf.tokens.push(token);
      return ok(token);
    }
    const del = url.pathname.match(new RegExp(`^/accounts/${ACCOUNT}/access/service_tokens/([^/]+)$`));
    if (req.method === "DELETE" && del) {
      const index = cf.tokens.findIndex((t) => t.id === del[1]);
      if (index < 0) return send(404, { success: false, errors: [{ message: "not found" }] });
      cf.deleted.push(cf.tokens[index].id);
      cf.tokens.splice(index, 1);
      return ok({});
    }
    if (req.method === "GET" && url.pathname === `/zones/${ZONE}/email/routing/rules`) return ok(cf.rules);
    if (req.method === "POST" && url.pathname === `/zones/${ZONE}/email/routing/rules`) {
      const rule = { id: `rule-${randomUUID().slice(0, 8)}`, enabled: true, ...JSON.parse(body) };
      cf.rules.push(rule);
      return ok(rule);
    }
    const kvMatch = url.pathname.match(new RegExp(`^/accounts/${ACCOUNT}/storage/kv/namespaces/${KVNS}/values/(.+)$`));
    if (kvMatch) {
      const key = decodeURIComponent(kvMatch[1]);
      if (req.method === "GET") return cf.kv.has(key) ? send(200, cf.kv.get(key)) : send(404, { success: false, errors: [{ code: 10009, message: "key not found" }] });
      if (req.method === "PUT") { cf.kv.set(key, JSON.parse(body)); return ok({}); }
    }
    return send(404, { success: false, errors: [{ message: `no fake route: ${req.method} ${url.pathname}` }] });
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const cfBase = `http://127.0.0.1:${server.address().port}`;

writeFileSync(configPath, YAML.stringify({
  version: 1,
  cloudflare: { api_token_ref: TOKEN_REF, account_id: ACCOUNT, zone_id: ZONE, access_issuer: ISSUER },
  mailbox: { worker: "agents-facade", kv_namespace_id: KVNS },
  onepassword: { vault: "DeLoSecrets" },
}));

const baseEnv = {
  ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
  XDG_STATE_HOME: join(home, ".local/state"), PATH: `${bin}:${process.env.PATH}`,
  FLUME_PROVISION_CONFIG: configPath, FLUME_PROVISION_STATE: state, FLUME_CLOUDFLARE_API_BASE: cfBase,
  OP_SERVICE_ACCOUNT_TOKEN: "vault-session-token", OP_ITEMS: join(dir, "op-items.json"),
};
/** The child talks to the in-process fake Cloudflare: a sync spawn would deadlock it. */
const runAsync = (args, extra = {}) => new Promise((done) => {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...baseEnv, ...extra }, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => stdout += b);
  child.stderr.on("data", (b) => stderr += b);
  child.on("close", (status) => done({ status, stdout, stderr }));
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

// -- 1. preview writes nothing ----------------------------------------------------------------
{
  const before = calls.length;
  const result = json(await runAsync(["identity", "provision", "rhea", "--json"]));
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
  const applied = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]));
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
  assert.ok(existsSync(join(state, "receipts.jsonl")));

  const again = json(await runAsync(["identity", "provision", "rhea", "--apply", "--json"]));
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  for (const cap of Object.values(again.capabilities)) assert.equal(cap.action, "no-op", JSON.stringify(cap));
  assert.equal(cf.tokens.length, 1, "second apply minted another token");
  assert.equal(cf.rules.length, 1, "second apply created another rule");
  pass("apply provisions token + rule + allowlist + vault item + binding; second apply is a no-op");
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

  const applied = json(await runAsync(["identity", "provision", "iris", "--apply", "--json"]));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.capabilities["access-token"].action, "created");
  const irisItem = JSON.parse(readFileSync(itemsPath, "utf8")).find((i) => i.id === "item-iris");
  assert.equal(irisItem.fields.find((f) => f.section?.label === "Github App" && f.label === "Client ID").value, "github-app-client-id-value", "GitHub App field was overwritten");
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
  const refused = json(await runAsync(["identity", "provision", "finch", "--apply", "--json"]), 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.capabilities["access-token"].action, "blocked");
  assert.match(refused.capabilities["access-token"].detail, /already holds a different value/u);
  assert.equal(cf.tokens.filter((t) => t.name === "employee-finch").length, 0, "orphan finch token survived");
  pass("vault fields are section-qualified: a GitHub App Client ID never blocks, a different Access Client ID refuses");
}

// -- 7. no secret lands in any artifact ---------------------------------------------------------

// -- 6. no secret lands in any artifact ---------------------------------------------------------
{
  const receipts = existsSync(join(state, "receipts.jsonl")) ? readFileSync(join(state, "receipts.jsonl"), "utf8") : "";
  const artifacts = receipts + JSON.stringify(desk()) + readFileSync(configPath, "utf8");
  for (const secret of secrets) assert.ok(!artifacts.includes(secret), `artifact contains a secret: ${secret.slice(0, 6)}…`);
  pass("receipts, definitions and config carry IDs and references only");
}

server.close();
console.log(`identity-provision-regressions: ${count} passed`);
