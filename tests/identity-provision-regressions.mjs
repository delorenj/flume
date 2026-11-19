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
    if (req.method === "GET" && url.pathname === `/accounts/${ACCOUNT}/access/service_tokens`) {
      const page = Number(url.searchParams.get("page") || "1"), size = cf.pageSize || 50;
      return send(200, { success: true, result: cf.tokens.slice((page - 1) * size, page * size), result_info: { total_pages: Math.max(1, Math.ceil(cf.tokens.length / size)) } });
    }
    if (req.method === "POST" && url.pathname === `/accounts/${ACCOUNT}/access/service_tokens`) {
      const token = { id: `token-${randomUUID().slice(0, 8)}`, name: JSON.parse(body).name, client_id: `${randomUUID().replace(/-/g, "")}.access`, client_secret: CREATED_SECRET, expires_at: "2027-10-13T00:00:00Z" };
      cf.tokens.push(token);
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
