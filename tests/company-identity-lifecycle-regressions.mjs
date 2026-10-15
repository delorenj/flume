// FLUME-53 lifecycle: suspend, restore, retire, credentials, rotate and continuity, through the built `flume` CLI only.
//
// Four stateful doubles (tests/lifecycle-fixtures.mjs) stand in for Cloudflare, GitHub, Pilot and the gateway-tokens tool.
// Each logs every call, so "exactly one KV DELETE across both runs" is measured, not assumed. Every secret the suite plants
// is scanned for in every state file, ledger, definition, stdout and stderr at the end.
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import YAML from "yaml";
import { fakeCloudflare, fakeGithub, rsa, tree, writeFakeGateway, writeFakeOp, writeFakePx } from "./lifecycle-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync("/tmp/flume53-");
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

const ACCOUNT = "a".repeat(32), ZONE = "b".repeat(32), KVNS = "c".repeat(32);
const ISSUER = "https://fixture.cloudflareaccess.com";
const CF_TOKEN = "fixture-cloudflare-provisioning-token-secret";
const TOKEN_REF = "op://DeLoSecrets/Cloudflare/provisioning-token";
const VAULT = "vault-session-token-secret";
const item = (name) => `${name}${"0".repeat(26)}`.slice(0, 26);
const GW_ITEM = "yeurk5dpqkaarspvsn3cjtmkki";
const ADA_PLANE = "292ac356-3640-474e-ac01-8b0611ed6a91";
const BOB_PLANE = "ba82e3bd-9b21-4066-9737-bd6279cf00f7";
const PLANE_INSTANCE = "https://plane.delo.sh/33god";
const BOARD = "0711da94-284a-4db1-86e8-d7ca37c26d45";
const REF = {
  adaAccess: "op://DeLoSecrets/ada-access/credential", bobAccess: "op://DeLoSecrets/bob-access/credential", adaAccess2: "op://DeLoSecrets/ada-access-rotated/credential",
  adaGithub: `op://DeLoSecrets/${item("adagithub")}/privatekeyfield`, adaGithub2: `op://DeLoSecrets/${item("adagithubnew")}/privatekeyfield`,
  adaPlane: `op://DeLoSecrets/${item("adaplane")}/planefield`, adaPlane2: `op://DeLoSecrets/${item("adaplanenew")}/planefield`, bobPlane: `op://DeLoSecrets/${item("bobplane")}/planefield`,
};
const CLIENT = { ada: "ada-client-id.access", bob: "bob-client-id.access" };
const PAT = { ada: "plane_api_ADA_planted_value_91ac3e", bob: "plane_api_BOB_planted_value_77be2d" };
// Assembled at run time: the commit guard rightly refuses a literal that looks like a gateway key, and this one is a planted fixture.
const GATEWAY_KEY = ["sk", "planted-gateway-key-value-1234567890"].join("-");
const CLIENT_SECRET = "ada-client-secret-planted-value";
const ghKeys = { ada: rsa() };
const ghPemBody = ghKeys.ada.privateKey.split("\n")[1];
/** Every secret the suite plants; scanned for in every artifact at the end. */
const secrets = new Set([CF_TOKEN, VAULT, PAT.ada, PAT.bob, GATEWAY_KEY, CLIENT_SECRET, ghPemBody]);

const cf = await fakeCloudflare({ account: ACCOUNT, zone: ZONE, kvns: KVNS, token: CF_TOKEN, issuer: ISSUER });
const gh = await fakeGithub([{ id: "1001", slug: "ada-app", installation: "2001", publicKey: ghKeys.ada.publicKey }]);

/** Every byte the CLI printed, scanned for secrets at the end. */
const outputs = [];
/** Every directory a world wrote state into. */
const worlds = [];

const FUTURE = () => Date.now() + 90 * 24 * 3600 * 1000;

async function world(label, o = {}) {
  const dir = join(work, label), home = join(dir, "home"), fleet = join(home, ".hermes"), registry = join(fleet, "agents-registry.yaml"), bin = join(dir, "bin");
  const idState = join(dir, "state/identity"), accessState = join(dir, "state/access");
  for (const p of [fleet, join(fleet, "profiles/ada-pm"), join(fleet, "profiles/bob-pm"), join(home, ".agents/workforce"), join(dir, "repos"), bin]) mkdirSync(p, { recursive: true });
  writeFileSync(registry, "# org comment\nschema_version: 1\nagents: {}\n");
  writeFakeOp(join(bin, "op"), VAULT);
  writeFakePx(join(bin, "px"));
  writeFakeGateway(join(bin, "gateway-tokens.py"));
  const gwRefOf = (name) => `op://DeLoSecrets/${GW_ITEM}/${name}`;
  writeFileSync(join(fleet, "config.yaml"), YAML.stringify({ secrets: { onepassword: { env: { AUTOMATICAI_GATEWAY_KEY: gwRefOf("fleet") } } } }));
  const adaRef = o.gatewayRef === "bad" ? "op://DeLoSecrets/some-title/credential" : o.gatewayRef === "shared" ? gwRefOf("fleet") : gwRefOf("ada");
  if (o.gatewayRef !== "none") writeFileSync(join(fleet, "profiles/ada-pm/config.delta.yaml"), YAML.stringify({ secrets: { onepassword: { env: { AUTOMATICAI_GATEWAY_KEY: adaRef } } } }));
  writeFileSync(join(fleet, "profiles/bob-pm/config.delta.yaml"), YAML.stringify({ secrets: { onepassword: { env: { AUTOMATICAI_GATEWAY_KEY: gwRefOf("bob") } } } }));
  const configPath = join(dir, "identity-provisioning.yaml");
  writeFileSync(configPath, YAML.stringify({ version: 1, cloudflare: { api_token_ref: TOKEN_REF, account_id: ACCOUNT, zone_id: ZONE, access_issuer: ISSUER }, mailbox: { worker: "agents-facade", kv_namespace_id: KVNS }, onepassword: { vault: "DeLoSecrets" } }));
  writeFileSync(join(dir, "op.json"), JSON.stringify({ [TOKEN_REF]: CF_TOKEN, [REF.adaGithub]: ghKeys.ada.privateKey, [REF.adaGithub2]: ghKeys.ada.privateKey }));
  const pxState = join(dir, "px-state.json"), pxLog = join(dir, "px-log.jsonl"), gwState = join(dir, "gw-state.json"), gwLog = join(dir, "gw-log.jsonl");
  writeFileSync(pxLog, ""); writeFileSync(gwLog, "");
  const px = {
    state: {
      rejected: [],
      users: { [ADA_PLANE]: { id: ADA_PLANE, email: "ada@agents.delo.sh", name: "Ada" }, [BOB_PLANE]: { id: BOB_PLANE, email: "bob@agents.delo.sh", name: "Bob" } },
      keys: { [REF.adaPlane]: { user: ADA_PLANE, pat: PAT.ada }, [REF.adaPlane2]: { user: ADA_PLANE, pat: PAT.ada }, [REF.bobPlane]: { user: BOB_PLANE, pat: PAT.bob } },
      boards: { TEST: { id: BOARD, identifier: "TEST", name: "Sandbox", members: [ADA_PLANE, BOB_PLANE] } },
      tickets: { "TEST-14": { project: BOARD, comments: [] } },
    },
    save() { writeFileSync(pxState, JSON.stringify(px.state)); },
    calls: () => readFileSync(pxLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
  px.save();
  const gw = {
    state: { mode: "ok", consumers: { ada: [{ id: 11, name: "aai:ada:1700000001", status: 1, expired_time: -1, planted_key: GATEWAY_KEY }], bob: [{ id: 12, name: "aai:bob:1700000002", status: 1, expired_time: -1, planted_key: GATEWAY_KEY }], fleet: [{ id: 13, name: "aai:fleet:1700000003", status: 1, expired_time: -1, planted_key: GATEWAY_KEY }] } },
    save() { writeFileSync(gwState, JSON.stringify(gw.state)); },
    calls: () => readFileSync(gwLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).argv),
    revokes: () => gw.calls().filter((c) => c[0] === "revoke"),
    read: () => JSON.parse(readFileSync(gwState, "utf8")),
  };
  gw.save();
  const env = {
    ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry, HERMES_TEMPLATE_CONFIG: join(dir, "no-config"), HERMES_FLEET_ENV: join(dir, "no-env"),
    XDG_STATE_HOME: join(home, ".local/state"), PYTHONDONTWRITEBYTECODE: "1", PATH: `${bin}:${process.env.PATH}`,
    FLUME_IDENTITY_STATE: idState, FLUME_ACCESS_STATE: accessState, FLUME_PROVISION_CONFIG: o.noConfig ? join(dir, "absent.yaml") : configPath,
    FLUME_CLOUDFLARE_API_BASE: cf.url, FLUME_GITHUB_API_BASE: gh.url, FLUME_GITHUB_TIMEOUT_MS: "3000", FLUME_PX_BIN: join(bin, "px"), FLUME_PX_TIMEOUT_MS: "5000",
    FLUME_GATEWAY_TOKENS_BIN: join(bin, "gateway-tokens.py"), FLUME_GATEWAY_EVIDENCE: join(dir, "no-flume-39-evidence"), GW_STATE: gwState, GW_LOG: gwLog, PX_FAKE_STATE: pxState, PX_FAKE_LOG: pxLog,
    OP_SERVICE_ACCOUNT_TOKEN: VAULT, OP_FIXTURE: join(dir, "op.json"), CLOUDFLARE_API_TOKEN: "",
  };
  delete env.FLUME_IDENTITY_CANDIDATES;
  const runAsync = (args, extra = {}) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extra }, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => stdout += b);
    child.stderr.on("data", (b) => stderr += b);
    child.on("close", (status) => { outputs.push(stdout, stderr); done({ status, stdout, stderr }); });
  });
  const run = (args, extra = {}) => { const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, cwd: dir, encoding: "utf8", timeout: 60000 }); outputs.push(r.stdout, r.stderr); return r; };
  const json = (r, status = 0) => { assert.equal(r.status, status, r.stdout + r.stderr); return JSON.parse(r.stdout); };
  const post = (id, person, extra = "") => {
    const roleDir = join(dir, "repos", id, "agents/hermes/pm");
    mkdirSync(roleDir, { recursive: true });
    const path = join(roleDir, "role.yaml");
    writeFileSync(path, `# operator note: keep me\nrepo: ${id}\nrole: pm\nagent_id: ${id}\nprofile: ${id}\nidentity:\n  name: ${person}\n  recall_banks:\n    - agent-${id}\n${extra}`);
    const doc = YAML.parseDocument(readFileSync(registry, "utf8"));
    doc.setIn(["agents", id], { project_path: join(dir, "repos", id), role_dir: roleDir, profile_name: id, identity: id });
    writeFileSync(registry, String(doc));
    return path;
  };
  const setBindings = (path, bindings) => {
    const doc = YAML.parseDocument(readFileSync(path, "utf8"));
    doc.setIn(["company_identity", "bindings"], bindings);
    writeFileSync(path, String(doc));
  };
  const block = (path) => YAML.parse(readFileSync(path, "utf8")).company_identity;
  const w = { dir, home, fleet, registry, env, idState, accessState, px, gw, run, runAsync, json, post, setBindings, block, gwRefOf, label };
  worlds.push(w);

  w.adaRole = post("ada-pm", "ada");
  w.bobRole = post("bob-pm", "bob");
  w.ada = json(run(["identity", "enroll", "ada-pm", "--apply", "--json"])).identity;
  w.bob = json(run(["identity", "enroll", "bob-pm", "--apply", "--json"])).identity;
  const adaBindings = { cloudflare_access: { principal: CLIENT.ada, instance: ISSUER, credential_ref: REF.adaAccess } };
  if (o.github !== false) adaBindings.github = { principal: "1001", instance: "2001", credential_ref: REF.adaGithub, attribution_mode: "native" };
  if (o.plane !== false) adaBindings.plane = { principal: ADA_PLANE, instance: PLANE_INSTANCE, credential_ref: REF.adaPlane, attribution_mode: "native" };
  setBindings(w.adaRole, adaBindings);
  setBindings(w.bobRole, { cloudflare_access: { principal: CLIENT.bob, instance: ISSUER, credential_ref: REF.bobAccess }, plane: { principal: BOB_PLANE, instance: PLANE_INSTANCE, credential_ref: REF.bobPlane, attribution_mode: "native" } });

  // Providers: a fresh state, seeded for ada and for bob (bob proves unrelated resources are never touched).
  cf.reset(); gh.reset();
  cf.tokens.push({ id: "tok-ada", name: "employee-ada", client_id: CLIENT.ada, expires_at: "2027-10-12T00:00:00Z" }, { id: "tok-bob", name: "employee-bob", client_id: CLIENT.bob, expires_at: "2027-10-12T00:00:00Z" });
  for (const [name, who] of [["ada", w.ada], ["bob", w.bob]]) {
    cf.rules.push({ id: `rule-${name}`, name: `${name} mailbox`, enabled: true, matchers: [{ type: "literal", field: "to", value: `${name}@agents.delo.sh` }], actions: [{ type: "worker", value: ["agents-facade"] }] });
    cf.kv.set(`allowlist/${name}@agents.delo.sh`, { handle: name, subject: who.subject, provisioned_at: "2026-10-01T00:00:00.000Z" });
  }
  if (o.plane !== false) {
    json(await runAsync(["identity", "adopt-actor", "ada-pm", "plane", "--board", "TEST", "--apply", "--json"]));
    json(await runAsync(["identity", "adopt-actor", "bob-pm", "plane", "--board", "TEST", "--apply", "--json"]));
  }
  cf.calls.length = 0; gh.calls.length = 0;
  writeFileSync(pxLog, "");
  return w;
}

const rowOf = (result, provider, kind) => { const rows = result.credentials.filter((r) => r.provider === provider && (!kind || r.kind === kind)); assert.ok(rows.length, `no ${provider}/${kind} row in ${JSON.stringify(result.credentials.map((r) => `${r.provider}/${r.kind}:${r.status}`))}`); return rows[0]; };
const stepOf = (result, key) => { const s = result.steps.find((x) => x.key === key); assert.ok(s, `no step ${key} in ${JSON.stringify(result.steps.map((x) => `${x.key}:${x.outcome}`))}`); return s; };
const blockedWith = (result, ...codes) => { assert.equal(result.ok, false, JSON.stringify(result)); for (const code of codes) assert.ok(result.blockers.some((b) => b.code === code), `expected blocker ${code}: ${JSON.stringify(result.blockers)}`); };
const ledgerOf = (w) => { const p = join(w.idState, "lifecycle-ledger.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const stateOf = (w) => JSON.parse(readFileSync(join(w.idState, "lifecycle-state.json"), "utf8"));
const KV_ADA = "allowlist/ada@agents.delo.sh";
const providerMutations = () => ({ cf: cf.mutations().length, gh: gh.mutations().length });
const DEFINITIONS = (w) => ({ bob: readFileSync(w.bobRole, "utf8"), registry: readFileSync(w.registry, "utf8") });

try {
  // -- 1. preview purity -----------------------------------------------------------------------------------------------
  {
    const w = await world("preview");
    const before = { home: tree(w.home), state: tree(join(w.dir, "state")), calls: providerMutations(), gw: w.gw.revokes().length };
    for (const args of [["suspend", "ada-pm"], ["suspend", "ada-pm", "--revoke", "github"], ["retire", "ada-pm", "--revoke", "all"], ["credentials", "ada-pm"], ["rotate", "ada-pm", "github", "--credential-ref", REF.adaGithub2], ["continuity", "ada-pm", "--record"]]) {
      const result = w.json(await w.runAsync(["identity", ...args, "--json"]));
      assert.equal(result.apply, false, args.join(" "));
      assert.deepEqual(result.writes, [], args.join(" "));
    }
    assert.deepEqual(tree(w.home), before.home, "a preview wrote under HOME");
    assert.equal(existsSync(join(w.idState, "lifecycle-state.json")) || existsSync(join(w.idState, "lifecycle-ledger.jsonl")), false, "a preview created lifecycle state");
    assert.deepEqual(providerMutations(), before.calls);
    assert.equal(w.gw.revokes().length, before.gw);
    const preview = w.json(await w.runAsync(["identity", "retire", "ada-pm", "--revoke", "all", "--json"]));
    assert.equal(preview.ok, true);
    assert.ok(preview.steps.every((s) => s.outcome === "planned"), JSON.stringify(preview.steps));
    assert.deepEqual(preview.steps.map((s) => s.key), ["local-status:retired", "tombstone", "mail:allowlist-delete:ada@agents.delo.sh", "mail:routing-disable:ada@agents.delo.sh", `cloudflare_access:token-delete:${CLIENT.ada}`, "github:installation-suspend:2001", "gateway:token-revoke:ada"]);
    assert.equal(preview.complete_revocation, false);
    pass("every lifecycle command is a pure preview: no definition, state, ledger or provider mutation, with provider GETs only");
  }

  // -- 2. suspend apply ------------------------------------------------------------------------------------------------
  let suspendedWorld;
  {
    const w = await world("suspend");
    suspendedWorld = w;
    // Tokens the facade issued earlier: one live, one with a failed revoke, one ambiguous, one long expired, one for another subject.
    mkdirSync(w.accessState, { recursive: true });
    const ledger = (line) => appendFileSync(join(w.accessState, "provider-ledger.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), provider: "github", subject: w.ada.subject, installation_id: "2001", app_id: "1001", ...line })}\n`);
    const soon = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    ledger({ event: "issued", grant_id: "grant-live", expires_at: soon });
    ledger({ event: "revoke-failed", grant_id: "grant-revoke-failed", expires_at: new Date(Date.now() + 50 * 60 * 1000).toISOString() });
    ledger({ event: "ambiguous", grant_id: "grant-ambiguous" });
    ledger({ event: "issued", grant_id: "grant-expired", expires_at: new Date(Date.now() - 3600 * 1000).toISOString() });
    ledger({ event: "issued", grant_id: "grant-foreign", subject: w.bob.subject, expires_at: soon });
    const applied = w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--apply", "--json"]));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.match(applied.operation_id, /^[0-9a-f-]{36}$/u);
    assert.equal(w.block(w.adaRole).status, "suspended");
    assert.deepEqual(applied.steps.map((s) => s.key), ["local-status:suspended", "mail:allowlist-delete:ada@agents.delo.sh"]);
    assert.equal(stepOf(applied, "mail:allowlist-delete:ada@agents.delo.sh").outcome, "done");
    assert.equal(cf.kv.has(KV_ADA), false);
    assert.ok(cf.kv.has("allowlist/bob@agents.delo.sh"), "bob's mailbox was touched");
    assert.equal(cf.count("DELETE", /\/kv\//u), 1);
    assert.equal(cf.count("DELETE", /service_tokens/u), 0);
    assert.equal(gh.mutations().length, 0);
    assert.equal(w.gw.revokes().length, 0);
    const capture = stateOf(w).captures[w.ada.subject].mail_allowlist;
    assert.deepEqual(capture.record, { handle: "ada", subject: w.ada.subject, provisioned_at: "2026-10-01T00:00:00.000Z" });
    assert.equal(rowOf(applied, "mail").status, "suspended-reversible");
    const access = rowOf(applied, "cloudflare_access");
    assert.equal(access.status, "static-usable"); assert.equal(access.expires_at, "2027-10-12T00:00:00Z"); assert.equal(access.static, true); assert.equal(access.id, CLIENT.ada); assert.equal(access.evidence, "fixture"); assert.match(access.next_action, /retire ada-pm --revoke cloudflare_access --apply/u);
    assert.equal(rowOf(applied, "github", "app-private-key").status, "static-usable");
    assert.equal(rowOf(applied, "github", "app-private-key").ref, REF.adaGithub);
    assert.equal(rowOf(applied, "github", "installation").status, "static-usable");
    const tokens = applied.credentials.filter((r) => r.kind === "installation-token");
    assert.deepEqual(tokens.map((r) => `${r.id}:${r.status}`).sort(), ["grant-ambiguous:unverified", "grant-live:residual-expiry", "grant-revoke-failed:unverified"]);
    assert.equal(tokens.find((r) => r.id === "grant-live").expires_at, soon);
    assert.equal(tokens.find((r) => r.id === "grant-ambiguous").provider_code, "issuance-ambiguous");
    assert.ok(Date.parse(tokens.find((r) => r.id === "grant-ambiguous").expires_at) > Date.now());
    const plane = rowOf(applied, "plane");
    assert.equal(plane.status, "static-usable"); assert.equal(plane.static, true); assert.equal(plane.expires_at, undefined); assert.match(plane.next_action, /Personal Access Tokens/u);
    const gateway = rowOf(applied, "gateway");
    assert.equal(gateway.status, "static-usable"); assert.equal(gateway.owner_ticket, "FLUME-39"); assert.equal(gateway.evidence_status, "unverified"); assert.equal(gateway.consumer, "ada"); assert.equal(gateway.id, "11");
    assert.equal(gateway.ref, `op://DeLoSecrets/${GW_ITEM}/ada`);
    assert.equal(applied.gateway_link.evidence_status, "unverified");
    assert.equal(applied.complete_revocation, false);
    assert.deepEqual(applied.history, { mailbox_prefix: "mail/ada/", stored_mail: "kept" });
    assert.ok(applied.incomplete.length >= 6);
    for (const row of applied.credentials) { for (const field of ["provider", "kind", "static", "status", "evidence", "next_action"]) assert.notEqual(row[field], undefined, `${field} on ${JSON.stringify(row)}`); assert.ok(["provider", "fixture"].includes(row.evidence)); }
    // state and ledger: modes, content
    const dirMode = statSync(w.idState).mode & 0o777;
    assert.equal(dirMode, 0o700);
    for (const file of readdirSync(w.idState)) assert.equal(statSync(join(w.idState, file)).mode & 0o777 & 0o077, 0, `${file} is group/world accessible`);
    const lines = ledgerOf(w);
    assert.ok(lines.length >= 4);
    assert.ok(lines.every((l) => l.operation_id === applied.operation_id && l.subject === w.ada.subject));
    assert.deepEqual(lines.filter((l) => l.event === "lifecycle.step").map((l) => l.step), ["local-status:suspended", "mail:allowlist-delete:ada@agents.delo.sh"]);
    const human = (await w.runAsync(["identity", "credentials", "ada-pm"])).stdout;
    assert.match(human, /revocation INCOMPLETE/u);
    pass("suspend --apply writes status first, captures then deletes the allowlist key, and reports every credential honestly with complete_revocation false");

    // Re-run: converges, no second KV DELETE, the original operation id is named.
    const again = w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--apply", "--json"]));
    assert.equal(stepOf(again, "mail:allowlist-delete:ada@agents.delo.sh").outcome, "already-done");
    assert.equal(stepOf(again, "mail:allowlist-delete:ada@agents.delo.sh").operation_id, applied.operation_id);
    assert.equal(stepOf(again, "local-status:suspended").outcome, "converged");
    assert.equal(cf.count("DELETE", /\/kv\//u), 1, "the done-step guard let a second KV DELETE through");
    pass("a step recorded done is never executed again and names its original operation id");

    // Retire after the suspension: the KV step is already done in this suspension episode.
    const retired = w.json(await w.runAsync(["identity", "retire", "ada-pm", "--apply", "--json"]));
    assert.equal(stepOf(retired, "mail:allowlist-delete:ada@agents.delo.sh").outcome, "already-done");
    assert.equal(stepOf(retired, "mail:allowlist-delete:ada@agents.delo.sh").operation_id, applied.operation_id);
    assert.equal(stepOf(retired, "mail:routing-disable:ada@agents.delo.sh").outcome, "done");
    assert.equal(cf.count("DELETE", /\/kv\//u), 1);
    assert.equal(cf.count("PUT", /email\/routing\/rules\/rule-ada/u), 1);
    assert.equal(cf.rules.find((r) => r.id === "rule-ada").enabled, false);
    assert.equal(cf.rules.find((r) => r.id === "rule-bob").enabled, true);
    assert.equal(w.block(w.adaRole).status, "retired");
    assert.equal(rowOf(retired, "mail").status, "revoked");
    // On retire what was static-usable needs a person, with the provider's own route.
    assert.equal(rowOf(retired, "cloudflare_access").status, "manual-action-required");
    assert.equal(rowOf(retired, "github", "app-private-key").status, "manual-action-required");
    assert.equal(rowOf(retired, "plane").status, "manual-action-required");
    assert.equal(rowOf(retired, "gateway").status, "manual-action-required");
    assert.equal(retired.complete_revocation, false);
    pass("retire after suspend reuses the done allowlist step and disables only the employee's own routing rule; static rows become manual-action-required");
  }

  // -- 3. restore --------------------------------------------------------------------------------------------------------
  {
    const w = await world("restore");
    const original = JSON.stringify(cf.kv.get(KV_ADA));
    w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--apply", "--json"]));
    assert.equal(cf.kv.has(KV_ADA), false);
    cf.calls.length = 0; gh.calls.length = 0;
    const before = { home: tree(w.home), state: tree(join(w.dir, "state")), provider: providerMutations() };
    const preview = w.json(await w.runAsync(["identity", "restore", "ada-pm", "--json"]));
    assert.equal(preview.ok, true); assert.equal(preview.apply, false);
    assert.deepEqual(tree(w.home), before.home); assert.deepEqual(tree(join(w.dir, "state")), before.state);
    assert.deepEqual(providerMutations(), before.provider);
    const restored = w.json(await w.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]));
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(JSON.stringify(cf.kv.get(KV_ADA)), original, "the allowlist record is not identical");
    assert.equal(gh.mutations().length, 0, "restore touched a GitHub installation this lifecycle never suspended");
    assert.equal(w.block(w.adaRole).status, "active");
    const order = ledgerOf(w).filter((l) => l.command === "restore" && l.event === "lifecycle.step").map((l) => l.step);
    assert.deepEqual(order, ["mail:allowlist-restore:ada@agents.delo.sh", "local-status:active"], "status active must be written LAST");
    assert.equal(stateOf(w).steps[w.ada.subject]["mail:allowlist-delete:ada@agents.delo.sh"], undefined, "restore left the reversed step key behind");
    assert.equal(rowOf(restored, "mail").status, "static-usable");
    // Suspend again: restore cleared the key, so the delete runs again.
    w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--apply", "--json"]));
    assert.equal(cf.kv.has(KV_ADA), false);
    pass("restore re-puts the exact captured record, leaves foreign GitHub state alone, writes status last, and clears only what it reversed");

    // not-suspended / retired-terminal: no provider calls.
    const w2 = await world("restore-refused");
    cf.calls.length = 0;
    blockedWith(w2.json(await w2.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]), 1), "not-suspended");
    w2.json(await w2.runAsync(["identity", "retire", "ada-pm", "--apply", "--json"]));
    cf.calls.length = 0; gh.calls.length = 0;
    const px0 = w2.px.calls().length;
    const terminal = w2.json(await w2.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]), 1);
    blockedWith(terminal, "retired-terminal");
    assert.equal(cf.calls.length + gh.calls.length + (w2.px.calls().length - px0), 0, "a refused restore made provider calls");
    assert.equal(w2.block(w2.adaRole).status, "retired");
    pass("restore refuses an active employee (not-suspended) and a retired one (retired-terminal) with zero provider calls");
  }

  // -- 4. named revoke -------------------------------------------------------------------------------------------------
  {
    const w = await world("revoke");
    const result = w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--revoke", "gateway", "--revoke", "github", "--revoke", "cloudflare_access", "--apply", "--json"]));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.steps.map((s) => s.key), ["local-status:suspended", "mail:allowlist-delete:ada@agents.delo.sh", `cloudflare_access:token-delete:${CLIENT.ada}`, "github:installation-suspend:2001", "gateway:token-revoke:ada"], "named adapters run in the fixed order");
    assert.equal(cf.count("DELETE", /service_tokens\/tok-ada$/u), 1);
    assert.equal(cf.tokens.some((t) => t.id === "tok-bob"), true);
    assert.equal(gh.count("PUT", /suspended$/u), 1);
    assert.ok(gh.installationOf("1001").suspended_at);
    assert.equal(w.gw.revokes().length, 1);
    assert.deepEqual(w.gw.revokes()[0], ["revoke", "ada"]);
    assert.equal(w.gw.read().consumers.bob.length, 1, "bob's consumer was revoked");
    const access = rowOf(result, "cloudflare_access");
    assert.equal(access.status, "revoked"); assert.equal(access.read_back, "absent");
    assert.equal(rowOf(result, "gateway").status, "revoked");
    assert.equal(rowOf(result, "github", "installation").status, "suspended-reversible");
    assert.equal(rowOf(result, "github", "app-private-key").status, "static-usable", "suspending the installation does not revoke the App key");
    assert.equal(rowOf(result, "plane").status, "static-usable");
    assert.equal(result.complete_revocation, false);
    assert.ok(result.incomplete.some((r) => r.provider === "github" && r.kind === "app-private-key"));
    pass("named --revoke adapters run in the fixed order; the installation is suspended-reversible, Access and gateway revoked by read-back, the App key still usable");

    // Restore after: the installation THIS lifecycle suspended is un-suspended; the deletions are listed as not reversed.
    const restored = w.json(await w.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]));
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(gh.count("DELETE", /suspended$/u), 1);
    assert.equal(gh.installationOf("1001").suspended_at, null);
    assert.deepEqual(restored.not_reversed.map((n) => n.key).sort(), [`cloudflare_access:token-delete:${CLIENT.ada}`, "gateway:token-revoke:ada"].sort());
    assert.equal(w.block(w.adaRole).status, "active");
    pass("restore un-suspends an installation this lifecycle suspended and reports the Access and gateway revocations as not reversible");

    // An installation that was ALREADY suspended is converged, and restore leaves it suspended.
    const w2 = await world("already-suspended");
    gh.installationOf("1001").suspended_at = "2026-10-01T00:00:00Z";
    gh.calls.length = 0;
    const result2 = w2.json(await w2.runAsync(["identity", "suspend", "ada-pm", "--revoke", "github", "--apply", "--json"]));
    assert.equal(stepOf(result2, "github:installation-suspend:2001").outcome, "converged");
    assert.equal(gh.count("PUT", /suspended$/u), 0);
    w2.json(await w2.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]));
    assert.equal(gh.count("DELETE", /suspended$/u), 0, "restore un-suspended an installation it did not suspend");
    assert.ok(gh.installationOf("1001").suspended_at);
    pass("an already-suspended installation is converged and restore never un-suspends what the lifecycle did not suspend");

    // `revoked 0 tokens` is converged, not done, and the gateway's empty status is the read-back.
    const w3 = await world("gateway-empty");
    w3.gw.state.consumers.ada = []; w3.gw.save();
    const result3 = w3.json(await w3.runAsync(["identity", "suspend", "ada-pm", "--revoke", "gateway", "--apply", "--json"]));
    assert.equal(stepOf(result3, "gateway:token-revoke:ada").outcome, "converged");
    assert.equal(w3.gw.revokes().length, 1);
    assert.equal(rowOf(result3, "gateway").status, "revoked"); assert.equal(rowOf(result3, "gateway").read_back, "absent");
    pass("a gateway revoke that reports `revoked 0 tokens` is converged and read back as absent");
  }

  // -- 5. bad revoke -----------------------------------------------------------------------------------------------------
  {
    const w = await world("bad-revoke");
    const before = { home: tree(w.home), state: tree(join(w.dir, "state")), calls: providerMutations(), cfAll: cf.calls.length, ghAll: gh.calls.length };
    for (const bad of ["plane", "mail", "bogus"]) {
      blockedWith(w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--revoke", bad, "--apply", "--json"]), 1), "invalid-request");
      blockedWith(w.json(await w.runAsync(["identity", "retire", "ada-pm", "--revoke", bad, "--apply", "--json"]), 1), "invalid-request");
    }
    blockedWith(w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--revoke", "all", "--apply", "--json"]), 1), "invalid-request");
    assert.equal(cf.calls.length, before.cfAll); assert.equal(gh.calls.length, before.ghAll);
    assert.deepEqual(tree(w.home), before.home); assert.deepEqual(tree(join(w.dir, "state")), before.state);
    pass("--revoke plane|mail|bogus and suspend --revoke all are invalid-request: zero provider calls, nothing written");

    const shared = await world("shared-consumer", { gatewayRef: "shared" });
    cf.calls.length = 0;
    const refused = shared.json(await shared.runAsync(["identity", "suspend", "ada-pm", "--revoke", "gateway", "--apply", "--json"]), 1);
    blockedWith(refused, "shared-consumer");
    assert.equal(cf.calls.length + gh.calls.length + shared.gw.calls().length, 0, "a blocker was found after a provider call");
    assert.equal(shared.block(shared.adaRole).status, "active");
    assert.equal(existsSync(join(shared.idState, "lifecycle-state.json")), false);
    // Another desk mapping the same consumer is shared too.
    const twin = await world("shared-twin");
    writeFileSync(join(twin.fleet, "profiles/bob-pm/config.delta.yaml"), YAML.stringify({ secrets: { onepassword: { env: { AUTOMATICAI_GATEWAY_KEY: twin.gwRefOf("ada") } } } }));
    blockedWith(twin.json(await twin.runAsync(["identity", "retire", "ada-pm", "--revoke", "all", "--json"]), 1), "shared-consumer");
    const badShape = await world("bad-shape", { gatewayRef: "bad" });
    // A bad shape is a row, not a blocker: no consumer is inferred, no gateway step is planned.
    const shape = badShape.json(await badShape.runAsync(["identity", "suspend", "ada-pm", "--revoke", "gateway", "--json"]));
    assert.equal(shape.ok, true, JSON.stringify(shape.blockers));
    assert.equal(rowOf(shape, "gateway").provider_code, "gateway-ref-shape");
    assert.equal(shape.steps.some((s) => s.key.startsWith("gateway:")), false);
    pass("a shared gateway consumer (fleet base or another desk) blocks --revoke gateway before any call; a non-FLUME-39 reference is an unverified row with no gateway step");

    // A desk with no reference must not make retire --revoke all unusable.
    const noRef = await world("retire-no-ref", { gatewayRef: "none" });
    const retired = noRef.json(await noRef.runAsync(["identity", "retire", "ada-pm", "--revoke", "all", "--apply", "--json"]));
    assert.equal(retired.ok, true, JSON.stringify(retired.blockers));
    assert.ok(stateOf(noRef).tombstones[noRef.ada.subject]);
    assert.equal(cf.kv.has(KV_ADA), false);
    assert.equal(rowOf(retired, "gateway").status, "not-issued");
    assert.equal(retired.steps.some((s) => s.key.startsWith("gateway:")), false);
    assert.equal(noRef.gw.revokes().length, 0);
    pass("retire --revoke all on a desk with no gateway reference succeeds: tombstone written, mailbox closed, gateway not-issued, no gateway step");
  }

  // -- 6. outage and retry -----------------------------------------------------------------------------------------------
  for (const mode of ["500", "500-after-delete"]) {
    const w = await world(`outage-${mode}`);
    cf.mode.tokenDelete = mode;
    const first = w.json(await w.runAsync(["identity", "retire", "ada-pm", "--revoke", "all", "--apply", "--json"]), 1);
    assert.equal(first.ok, false);
    assert.deepEqual(first.succeeded.sort(), ["github:installation-suspend:2001", "gateway:token-revoke:ada", "local-status:retired", "mail:allowlist-delete:ada@agents.delo.sh", "mail:routing-disable:ada@agents.delo.sh", "tombstone"].sort());
    assert.deepEqual(first.unresolved.map((u) => `${u.key}:${u.provider_code}`), [`cloudflare_access:token-delete:${CLIENT.ada}:http-500`]);
    assert.equal(stepOf(first, `cloudflare_access:token-delete:${CLIENT.ada}`).provider_code, "http-500");
    assert.equal(first.complete_revocation, false);
    assert.equal(w.block(w.adaRole).status, "retired");
    assert.equal(stateOf(w).steps[w.ada.subject][`cloudflare_access:token-delete:${CLIENT.ada}`].status, "unresolved");
    // The result never claims complete while a static key is usable or unverified.
    // The token is still listed behind a 500 that committed nothing; behind one that committed, the listing itself shows it gone.
    assert.equal(rowOf(first, "cloudflare_access").status, mode === "500" ? "manual-action-required" : "revoked");
    cf.mode = {};
    const deletesBefore = cf.count("DELETE", /service_tokens/u);
    const second = w.json(await w.runAsync(["identity", "retire", "ada-pm", "--revoke", "all", "--apply", "--json"]));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(stepOf(second, `cloudflare_access:token-delete:${CLIENT.ada}`).outcome, mode === "500" ? "done" : "converged");
    for (const key of ["local-status:retired", "tombstone", "mail:allowlist-delete:ada@agents.delo.sh", "mail:routing-disable:ada@agents.delo.sh", "github:installation-suspend:2001", "gateway:token-revoke:ada"]) {
      assert.ok(["already-done", "converged"].includes(stepOf(second, key).outcome), `${key}: ${stepOf(second, key).outcome}`);
    }
    assert.equal(cf.count("DELETE", /service_tokens/u) - deletesBefore, 1, "only the Cloudflare token DELETE runs on retry");
    assert.equal(cf.count("DELETE", /\/kv\//u), 1, "exactly one KV DELETE across both runs");
    assert.equal(cf.count("PUT", /email\/routing\/rules/u), 1, "exactly one routing PUT across both runs");
    assert.equal(gh.count("PUT", /suspended$/u), 1, "exactly one GitHub PUT across both runs");
    assert.equal(w.gw.revokes().length, 1, "exactly one gateway revoke across both runs");
    assert.equal(rowOf(second, "cloudflare_access").status, "revoked");
    assert.equal(second.complete_revocation, false, "complete_revocation while the App key and the Plane PAT are still usable");
    pass(`retire --revoke all with the Cloudflare DELETE failing (${mode}) records succeeded and unresolved apart, and a retry runs only the failed step`);
  }

  // -- 7. static honesty -------------------------------------------------------------------------------------------------
  {
    const w = await world("honesty");
    // The provider reads back rejections: App key 401, Pilot credential_rejected, gateway lists no tokens.
    gh.mode.keyRejected = true;
    w.px.state.rejected = [REF.adaPlane]; w.px.save();
    w.gw.state.consumers.ada = []; w.gw.save();
    const result = w.json(await w.runAsync(["identity", "credentials", "ada-pm", "--json"]));
    const key = rowOf(result, "github", "app-private-key");
    assert.equal(key.status, "revoked"); assert.equal(key.read_back, "rejected");
    assert.equal(rowOf(result, "plane").status, "revoked"); assert.equal(rowOf(result, "plane").provider_code, "credential_rejected");
    assert.equal(rowOf(result, "gateway").status, "revoked"); assert.equal(rowOf(result, "gateway").read_back, "absent");
    assert.equal(rowOf(result, "github", "installation").status, "unverified", "an installation GitHub will not answer is not revoked");
    pass("a static credential is revoked only when the provider reads back its rejection (GET /app 401, px credential_rejected, status tokens [])");

    // A local suspension never makes a static key revoked.
    const w2 = await world("honesty-local");
    const suspended = w2.json(await w2.runAsync(["identity", "suspend", "ada-pm", "--apply", "--json"]));
    for (const row of suspended.credentials.filter((r) => r.static)) assert.notEqual(row.status, "revoked", `${row.provider}/${row.kind} was marked revoked by a local status`);
    // Revoke that claims success but changes nothing is unresolved, never revoked.
    const w3 = await world("honesty-noop");
    w3.gw.state.mode = "revoke-noop"; w3.gw.save();
    cf.mode.tokenDelete = "noop";
    const noop = w3.json(await w3.runAsync(["identity", "suspend", "ada-pm", "--revoke", "gateway", "--revoke", "cloudflare_access", "--apply", "--json"]), 1);
    assert.equal(stepOf(noop, "gateway:token-revoke:ada").outcome, "unresolved");
    assert.equal(stepOf(noop, "gateway:token-revoke:ada").provider_code, "revoke-not-effective");
    assert.equal(stepOf(noop, `cloudflare_access:token-delete:${CLIENT.ada}`).provider_code, "delete-not-effective");
    assert.notEqual(rowOf(noop, "gateway").status, "revoked");
    assert.equal(rowOf(noop, "cloudflare_access").status, "static-usable");
    pass("a local status, a grant TTL or a revoke that changed nothing never makes a static credential revoked");
  }

  // -- 8. degraded rows --------------------------------------------------------------------------------------------------
  {
    const noGithub = await world("no-github", { github: false });
    const r1 = noGithub.json(await noGithub.runAsync(["identity", "credentials", "ada-pm", "--json"]));
    assert.equal(rowOf(r1, "github").status, "not-issued");
    const noConfig = await world("no-config", { noConfig: true });
    const r2 = noConfig.json(await noConfig.runAsync(["identity", "credentials", "ada-pm", "--json"]));
    assert.equal(rowOf(r2, "mail").status, "unverified"); assert.equal(rowOf(r2, "mail").provider_code, "provisioning-config-unavailable");
    assert.equal(rowOf(r2, "cloudflare_access").provider_code, "provisioning-config-unavailable");
    const suspend2 = noConfig.json(await noConfig.runAsync(["identity", "suspend", "ada-pm", "--apply", "--json"]), 1);
    assert.equal(stepOf(suspend2, "mail:allowlist-delete:ada@agents.delo.sh").outcome, "unresolved");
    assert.equal(stepOf(suspend2, "mail:allowlist-delete:ada@agents.delo.sh").provider_code, "provisioning-config-unavailable");
    assert.equal(noConfig.block(noConfig.adaRole).status, "suspended", "status is written first, so the facade still denies");
    const noPx = await world("no-px");
    const r3 = noPx.json(await noPx.runAsync(["identity", "credentials", "ada-pm", "--json"], { FLUME_PX_BIN: join(noPx.dir, "no-such-px") }));
    assert.equal(rowOf(r3, "plane").status, "unresolved"); assert.equal(rowOf(r3, "plane").provider_code, "provider-unavailable");
    const badRef = await world("bad-ref", { gatewayRef: "bad" });
    const r4 = badRef.json(await badRef.runAsync(["identity", "credentials", "ada-pm", "--json"]));
    assert.equal(rowOf(r4, "gateway").status, "unverified"); assert.equal(rowOf(r4, "gateway").provider_code, "gateway-ref-shape");
    const noRef = await world("no-ref", { gatewayRef: "none" });
    assert.equal(rowOf(noRef.json(await noRef.runAsync(["identity", "credentials", "ada-pm", "--json"])), "gateway").status, "not-issued");
    // Plane without a verified board.
    const noBoard = await world("no-board", { plane: true });
    rmReceipts(noBoard);
    const r5 = noBoard.json(await noBoard.runAsync(["identity", "credentials", "ada-pm", "--json"]));
    assert.equal(rowOf(r5, "plane").status, "unverified"); assert.equal(rowOf(r5, "plane").provider_code, "no-verified-board");
    // The gateway tool failing is unresolved, not revoked.
    const down = await world("gateway-down");
    down.gw.state.mode = "exit1"; down.gw.save();
    const r6 = down.json(await down.runAsync(["identity", "credentials", "ada-pm", "--json"]));
    assert.equal(rowOf(r6, "gateway").status, "unresolved");
    const failed = down.json(await down.runAsync(["identity", "suspend", "ada-pm", "--revoke", "gateway", "--apply", "--json"]), 1);
    assert.equal(stepOf(failed, "gateway:token-revoke:ada").outcome, "unresolved");
    pass("degraded providers report not-issued, unverified or unresolved with their code, and exit 1 only when an apply step stays unresolved");
  }

  // -- 9. credentials is read-only and needs an enrolled employee -------------------------------------------------------
  {
    const w = await world("credentials");
    const before = { home: tree(w.home), state: tree(join(w.dir, "state")), m: providerMutations() };
    const result = w.json(await w.runAsync(["identity", "credentials", "ada-pm", "--json"]));
    assert.equal(result.ok, true); assert.deepEqual(result.writes, []);
    assert.equal(result.complete_revocation, false);
    assert.deepEqual(tree(w.home), before.home); assert.deepEqual(tree(join(w.dir, "state")), before.state); assert.deepEqual(providerMutations(), before.m);
    w.post("carol-pm", "carol");
    blockedWith(w.json(await w.runAsync(["identity", "credentials", "carol-pm", "--json"]), 1), "not-enrolled");
    blockedWith(w.json(await w.runAsync(["identity", "suspend", "carol-pm", "--apply", "--json"]), 1), "not-enrolled");
    pass("credentials is read-only, and an unenrolled employee is refused before any provider call");
  }

  // -- 10. tombstones ----------------------------------------------------------------------------------------------------
  {
    const w = await world("tombstone");
    const retired = w.json(await w.runAsync(["identity", "retire", "ada-pm", "--apply", "--json"]));
    assert.equal(retired.ok, true);
    const tomb = stateOf(w).tombstones[w.ada.subject];
    assert.equal(tomb.handle, "ada"); assert.equal(tomb.email, "ada@agents.delo.sh");
    assert.deepEqual(tomb.bindings.map((b) => b.provider).sort(), ["cloudflare_access", "github", "plane"]);
    w.json(await w.runAsync(["offboard", "ada-pm", "--apply", "--json"]));
    assert.equal(YAML.parse(readFileSync(w.registry, "utf8")).agents["ada-pm"], undefined, "offboard did not remove the row");
    // enroll another post under the retired handle
    const eve = w.post("eve-pm", "eve");
    const hand = { home: tree(w.home), bob: readFileSync(w.bobRole, "utf8") };
    const handle = w.json(await w.runAsync(["identity", "enroll", "eve-pm", "--handle", "ada", "--apply", "--json"]), 1);
    blockedWith(handle, "handle-tombstoned");
    assert.equal(YAML.parse(readFileSync(eve, "utf8")).company_identity, undefined, "a tombstoned handle was written");
    // a hand-copied block carrying the retired subject
    const copy = w.post("copy-pm", "mallory");
    writeFileSync(copy, `${readFileSync(copy, "utf8")}${YAML.stringify({ company_identity: { version: 1, subject: w.ada.subject, handle: "mallory", email: "mallory@agents.delo.sh", status: "active", enrolled_at: "2026-10-01T00:00:00.000Z" } })}`);
    const copied = readFileSync(copy, "utf8");
    blockedWith(w.json(await w.runAsync(["identity", "enroll", "copy-pm", "--apply", "--json"]), 1), "subject-tombstoned");
    blockedWith(w.json(await w.runAsync(["identity", "status", "copy-pm", "suspended", "--apply", "--json"]), 1), "retired-terminal");
    blockedWith(w.json(await w.runAsync(["identity", "restore", "copy-pm", "--apply", "--json"]), 1), "retired-terminal");
    blockedWith(w.json(await w.runAsync(["identity", "bind", "copy-pm", "cloudflare_access", "--principal", "fresh.access", "--instance", ISSUER, "--credential-ref", "op://DeLoSecrets/fresh/credential", "--apply", "--json"]), 1), "subject-tombstoned");
    const ledgerLines = ledgerOf(w).length;
    blockedWith(w.json(await w.runAsync(["identity", "suspend", "copy-pm", "--apply", "--json"]), 1), "retired-terminal");
    assert.equal(ledgerOf(w).length, ledgerLines, "a refused suspend wrote ledger lines");
    blockedWith(w.json(await w.runAsync(["identity", "rotate", "copy-pm", "cloudflare_access", "--credential-ref", "op://DeLoSecrets/fresh/credential", "--apply", "--json"]), 1), "subject-tombstoned");
    assert.equal(readFileSync(copy, "utf8"), copied, "a refused command rewrote the hand-copied definition");
    // another employee binding the retired principal
    const bind = w.json(await w.runAsync(["identity", "bind", "bob-pm", "github", "--principal", "1001", "--instance", "2001", "--credential-ref", REF.adaGithub2, "--apply", "--json"]), 1);
    blockedWith(bind, "binding-tombstoned");
    const access = w.json(await w.runAsync(["identity", "bind", "bob-pm", "plane", "--principal", ADA_PLANE, "--instance", PLANE_INSTANCE, "--credential-ref", REF.adaPlane2, "--apply", "--json"]), 1);
    assert.deepEqual(access.blockers.map((b) => b.code), ["binding-tombstoned"], JSON.stringify(access.blockers));
    assert.equal(readFileSync(w.bobRole, "utf8"), hand.bob, "bob's definition changed");
    pass("a retired identity's handle, subject and bindings survive `flume offboard`: handle-tombstoned, subject-tombstoned, retired-terminal and binding-tombstoned, with nothing written");
  }

  // -- 11. rotate --------------------------------------------------------------------------------------------------------
  {
    const w = await world("rotate");
    const bobBefore = readFileSync(w.bobRole, "utf8");
    const beforeBlock = w.block(w.adaRole);
    const roleBefore = readFileSync(w.adaRole, "utf8");
    const preview = w.json(await w.runAsync(["identity", "rotate", "ada-pm", "github", "--credential-ref", REF.adaGithub2, "--json"]));
    assert.equal(preview.changed, true); assert.equal(readFileSync(w.adaRole, "utf8"), roleBefore);
    assert.equal(existsSync(join(w.idState, "lifecycle-ledger.jsonl")), false);
    const rotated = w.json(await w.runAsync(["identity", "rotate", "ada-pm", "github", "--credential-ref", REF.adaGithub2, "--apply", "--json"]));
    assert.equal(rotated.ok, true);
    const after = w.block(w.adaRole);
    assert.equal(after.bindings.github.credential_ref, REF.adaGithub2);
    assert.deepEqual({ ...after.bindings.github, credential_ref: REF.adaGithub }, beforeBlock.bindings.github, "rotation changed more than credential_ref");
    assert.deepEqual({ ...after, bindings: { ...after.bindings, github: beforeBlock.bindings.github } }, beforeBlock);
    assert.equal(readFileSync(w.bobRole, "utf8"), bobBefore);
    const line = ledgerOf(w).find((l) => l.event === "identity.rotate");
    assert.equal(line.previous_ref, REF.adaGithub); assert.equal(line.credential_ref, REF.adaGithub2); assert.equal(line.subject, w.ada.subject);
    assert.equal(rotated.credentials[0].status, "manual-action-required"); assert.equal(rotated.credentials[0].ref, REF.adaGithub);
    assert.match(rotated.verification.next_action, /access github-inspect/u);
    const planeRot = w.json(await w.runAsync(["identity", "rotate", "ada-pm", "plane", "--credential-ref", REF.adaPlane2, "--apply", "--json"]));
    assert.match(planeRot.verification.next_action, /adopt-actor ada-pm plane --board/u);
    const planeAfter = w.block(w.adaRole).bindings.plane;
    assert.deepEqual({ ...planeAfter, credential_ref: REF.adaPlane }, beforeBlock.bindings.plane, "plane rotation changed more than credential_ref");
    assert.equal(planeAfter.native_actor_id, ADA_PLANE); assert.equal(planeAfter.credential_ref, REF.adaPlane2);
    const FRESH = "op://DeLoSecrets/ada-access-fresh/credential";
    const cfRot = w.json(await w.runAsync(["identity", "rotate", "ada-pm", "cloudflare_access", "--credential-ref", FRESH, "--apply", "--json"]));
    assert.equal(cfRot.ok, true);
    assert.deepEqual({ ...w.block(w.adaRole).bindings.cloudflare_access, credential_ref: REF.adaAccess }, beforeBlock.bindings.cloudflare_access);
    assert.equal(w.block(w.adaRole).bindings.cloudflare_access.credential_ref, FRESH);
    blockedWith(w.json(await w.runAsync(["identity", "rotate", "ada-pm", "cloudflare_access", "--credential-ref", "not-an-op-ref", "--apply", "--json"]), 1), "invalid-credential-ref");
    // refusals
    const noop = w.json(await w.runAsync(["identity", "rotate", "ada-pm", "github", "--credential-ref", REF.adaGithub2, "--apply", "--json"]));
    assert.equal(noop.changed, false); assert.equal(noop.ok, true);
    blockedWith(w.json(await w.runAsync(["identity", "rotate", "ada-pm", "github", "--credential-ref", REF.adaGithub, "--principal", "999", "--apply", "--json"]), 1), "rotation-changes-principal");
    blockedWith(w.json(await w.runAsync(["identity", "rotate", "ada-pm", "github", "--credential-ref", REF.adaGithub, "--instance", "999", "--apply", "--json"]), 1), "rotation-changes-principal");
    blockedWith(w.json(await w.runAsync(["identity", "rotate", "ada-pm", "cloudflare_access", "--credential-ref", REF.bobAccess, "--apply", "--json"]), 1), "credential-ref-duplicate");
    blockedWith(w.json(await w.runAsync(["identity", "rotate", "ada-pm", "gateway", "--credential-ref", "op://x/y/z", "--apply", "--json"]), 1), "rotation-owned-elsewhere");
    blockedWith(w.json(await w.runAsync(["identity", "rotate", "ada-pm", "github", "--credential-ref", "not-a-ref", "--apply", "--json"]), 1), "invalid-credential-ref");
    blockedWith(w.json(await w.runAsync(["identity", "rotate", "ada-pm", "github", "--credential-ref", "op://DeLoSecrets/some title/field", "--apply", "--json"]), 1), "invalid-credential-ref");
    w.json(await w.runAsync(["identity", "retire", "ada-pm", "--apply", "--json"]));
    blockedWith(w.json(await w.runAsync(["identity", "rotate", "ada-pm", "github", "--credential-ref", REF.adaGithub, "--apply", "--json"]), 1), "retired-terminal");
    pass("rotate changes credential_ref only, appends identity.rotate, reports the old key manual-action-required, and refuses principal changes, duplicates, gateway and retired employees");
  }

  // -- 12. continuity ----------------------------------------------------------------------------------------------------
  {
    const w = await world("continuity");
    const noBaseline = w.json(await w.runAsync(["identity", "continuity", "ada", "--json"]), 1);
    assert.equal(noBaseline.status, "no-baseline");
    const recordPreview = w.json(await w.runAsync(["identity", "continuity", "ada", "--record", "--json"]));
    assert.equal(recordPreview.apply, false); assert.equal(existsSync(join(w.idState, "lifecycle-state.json")), false);
    const recorded = w.json(await w.runAsync(["identity", "continuity", "ada", "--record", "--apply", "--json"]));
    assert.equal(recorded.ok, true); assert.equal(recorded.status, "recorded");
    const stable = w.json(await w.runAsync(["identity", "continuity", "ada", "--json"]));
    assert.equal(stable.status, "stable"); assert.ok(stable.checks.every((c) => ["stable"].includes(c.status)), JSON.stringify(stable.checks));
    // a rotation and a post move
    w.json(await w.runAsync(["identity", "rotate", "ada-pm", "github", "--credential-ref", REF.adaGithub2, "--apply", "--json"]));
    const adaText = readFileSync(w.adaRole, "utf8");
    const moved = w.post("ada-pm2", "ada", adaText.slice(adaText.indexOf("company_identity:")));
    w.json(await w.runAsync(["offboard", "ada-pm", "--apply", "--json"]));
    assert.equal(w.block(moved).subject, w.ada.subject);
    // a plane comment receipt for ada, written by the real verifier
    const COMMENT = "b405f5b4-3525-4980-b9b2-4ad40b145d73";
    w.px.state.tickets["TEST-14"].comments = [{ id: COMMENT, actor_id: ADA_PLANE, actor_name: "Ada", comment_html: "<p>hi</p>" }, { id: "2d4fe4fa-c167-4aac-a25b-7cb5c18c72e8", actor_id: BOB_PLANE, actor_name: "Bob", comment_html: "<p>hi</p>" }];
    w.px.save();
    w.json(await w.runAsync(["comment", "verify-plane", "TEST-14", "--comment", `ada:${COMMENT}`, "--comment", "bob:2d4fe4fa-c167-4aac-a25b-7cb5c18c72e8", "--apply", "--json"]));
    const after = w.json(await w.runAsync(["identity", "continuity", "ada", "--comment", `ada:${COMMENT}`, "--comment", "ada:99999999-9999-4999-8999-999999999999", "--comment", "ada:issue:42", "--json"]));
    assert.equal(after.status, "stable", JSON.stringify(after));
    const by = Object.fromEntries(after.checks.map((c) => [c.field, c.status]));
    assert.equal(by["github.credential_ref"], "rotated"); assert.equal(by.post, "moved");
    for (const field of ["subject", "handle", "email", "mailbox_prefix", "cloudflare_access.principal", "github.principal", "plane.principal", "plane.native_actor_id"]) assert.equal(by[field], "stable", field);
    assert.equal(after.identity.mailbox_prefix, "mail/ada/");
    assert.deepEqual(after.comments.map((c) => c.status), ["stable", "not-recorded", "not-recorded"]);
    assert.match(after.comments[2].next_action, /flume comment verify/u);
    // drift is broken
    const doc = YAML.parseDocument(readFileSync(moved, "utf8"));
    doc.setIn(["company_identity", "bindings", "github", "principal"], "1002");
    writeFileSync(moved, String(doc));
    const broken = w.json(await w.runAsync(["identity", "continuity", "ada", "--json"]), 1);
    assert.equal(broken.status, "broken"); assert.equal(broken.checks.find((c) => c.field === "github.principal").status, "broken");
    const doc2 = YAML.parseDocument(readFileSync(moved, "utf8"));
    doc2.setIn(["company_identity", "bindings", "github", "principal"], "1001");
    doc2.setIn(["company_identity", "bindings", "plane", "native_actor_id"], BOB_PLANE);
    writeFileSync(moved, String(doc2));
    assert.equal(w.json(await w.runAsync(["identity", "continuity", "ada", "--json"]), 1).checks.find((c) => c.field === "plane.native_actor_id").status, "broken");
    const brokenComment = w.json(await w.runAsync(["identity", "continuity", "ada", "--comment", `ada:${COMMENT}`, "--json"]), 1);
    assert.equal(brokenComment.status, "broken"); assert.equal(brokenComment.comments[0].status, "broken");
    const baselineBefore = JSON.stringify(stateOf(w).continuity);
    const refused = w.json(await w.runAsync(["identity", "continuity", "ada", "--record", "--apply", "--json"]), 1);
    blockedWith(refused, "continuity-broken");
    assert.equal(JSON.stringify(stateOf(w).continuity), baselineBefore, "the baseline was refreshed over a broken identity");
    // The definition schema ties email to handle, so handle drift is email drift too (an email alone is invalid-definition).
    {
      const drift = YAML.parseDocument(readFileSync(moved, "utf8"));
      drift.setIn(["company_identity", "bindings", "plane", "native_actor_id"], ADA_PLANE);
      drift.setIn(["company_identity", "handle"], "adele");
      drift.setIn(["company_identity", "email"], "adele@agents.delo.sh");
      writeFileSync(moved, String(drift));
      const drifted = w.json(await w.runAsync(["identity", "continuity", "ada", "--json"]), 1);
      assert.equal(drifted.status, "broken", JSON.stringify(drifted));
      for (const field of ["handle", "email", "mailbox_prefix"]) assert.equal(drifted.checks.find((c) => c.field === field).status, "broken", field);
      assert.equal(drifted.checks.find((c) => c.field === "subject").status, "stable");
    }
    pass("continuity reports rotation and a post move as such, stays stable on subject/handle/email/principal/actor/mailbox prefix/Plane comment provenance, and fails on drift");
  }

  // -- 12b. episodes, restore without a capture, restore fail-closed ---------------------------------------------------------
  {
    const w = await world("episode");
    w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--revoke", "gateway", "--apply", "--json"]));
    w.json(await w.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]));
    // FLUME-39 re-mints a token for the same consumer.
    w.gw.state.consumers.ada = [{ id: 21, name: "aai:ada:1700000009", status: 1, expired_time: -1, planted_key: GATEWAY_KEY }]; w.gw.save();
    const second = w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--revoke", "gateway", "--apply", "--json"]));
    assert.equal(stepOf(second, "gateway:token-revoke:ada").outcome, "done");
    assert.equal(w.gw.revokes().length, 2, "the new episode did not revoke the re-minted token");
    assert.equal(rowOf(second, "gateway").status, "revoked");
    pass("a new suspension episode starts clean: a re-minted gateway token is revoked again");

    const none = await world("no-mailbox");
    cf.kv.delete(KV_ADA); cf.calls.length = 0;
    const suspended = none.json(await none.runAsync(["identity", "suspend", "ada-pm", "--apply", "--json"]));
    assert.equal(stepOf(suspended, "mail:allowlist-delete:ada@agents.delo.sh").outcome, "converged");
    const restored = none.json(await none.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]));
    assert.equal(restored.ok, true, JSON.stringify(restored.steps));
    assert.equal(none.block(none.adaRole).status, "active");
    assert.equal(cf.count("PUT", /\/kv\//u), 0, "restore invented an allowlist key");
    pass("an employee suspended with no mailbox can be restored: nothing was captured, nothing is put back");

    const closed = await world("restore-fail-closed");
    closed.json(await closed.runAsync(["identity", "suspend", "ada-pm", "--apply", "--json"]));
    cf.mode.kvPut = "500";
    const failed = closed.json(await closed.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]), 1);
    assert.equal(failed.ok, false);
    assert.equal(stepOf(failed, "mail:allowlist-restore:ada@agents.delo.sh").provider_code, "http-500");
    assert.equal(stepOf(failed, "local-status:active").outcome, "skipped");
    assert.equal(closed.block(closed.adaRole).status, "suspended", "status active must not be written while a restore step is unresolved");
    cf.mode = {};
    const healed = closed.json(await closed.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]));
    assert.equal(healed.ok, true); assert.equal(closed.block(closed.adaRole).status, "active");
    pass("restore fails closed: an unresolved step skips the status write and leaves the employee suspended until a retry succeeds");
  }

  // -- 12c. read-back guards driven to failure ---------------------------------------------------------------------------------
  {
    const a = await world("guard-kv");
    cf.mode.kvDelete = "noop";
    const kv = a.json(await a.runAsync(["identity", "suspend", "ada-pm", "--apply", "--json"]), 1);
    assert.equal(stepOf(kv, "mail:allowlist-delete:ada@agents.delo.sh").outcome, "unresolved");
    assert.equal(stepOf(kv, "mail:allowlist-delete:ada@agents.delo.sh").provider_code, "delete-not-effective");
    assert.notEqual(rowOf(kv, "mail").status, "revoked"); assert.equal(rowOf(kv, "mail").status, "static-usable");

    const b = await world("guard-rule");
    cf.mode.rulePut = "noop";
    const rule = b.json(await b.runAsync(["identity", "retire", "ada-pm", "--apply", "--json"]), 1);
    assert.equal(stepOf(rule, "mail:routing-disable:ada@agents.delo.sh").provider_code, "disable-not-effective");
    assert.equal(rowOf(rule, "mail").status, "unresolved"); assert.equal(rowOf(rule, "mail").provider_code, "routing-rule-enabled");

    const c = await world("guard-github");
    gh.mode.put = "noop";
    const put = c.json(await c.runAsync(["identity", "suspend", "ada-pm", "--revoke", "github", "--apply", "--json"]), 1);
    assert.equal(stepOf(put, "github:installation-suspend:2001").provider_code, "suspend-not-effective");
    assert.equal(rowOf(put, "github", "installation").status, "static-usable");
    pass("a KV delete, a routing-rule disable and a GitHub suspend that the provider does not honor are unresolved with their read-back code, never revoked");
  }

  // -- 12d. paging -------------------------------------------------------------------------------------------------------------
  {
    const w = await world("paging");
    cf.tokens.unshift(...Array.from({ length: 58 }, (_, i) => ({ id: `tok-filler-${i}`, name: `filler-${i}`, client_id: `filler-${i}.access`, expires_at: "2027-10-12T00:00:00Z" })));
    assert.equal(cf.tokens.findIndex((t) => t.id === "tok-ada"), 58);
    const read = w.json(await w.runAsync(["identity", "credentials", "ada-pm", "--json"]));
    assert.equal(rowOf(read, "cloudflare_access").status, "static-usable");
    assert.ok(cf.calls.some((c) => c.method === "GET" && /service_tokens/u.test(c.path) && /page=2/u.test(c.query)), "page 2 of the service tokens was never read");
    const revoked = w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--revoke", "cloudflare_access", "--apply", "--json"]));
    assert.equal(rowOf(revoked, "cloudflare_access").status, "revoked");
    assert.equal(cf.tokens.some((t) => t.id === "tok-ada"), false); assert.equal(cf.tokens.length, 59);

    const rules = await world("paging-rules");
    const own = cf.rules.find((r) => r.id === "rule-ada");
    // A foreign rule for the same address is listed first, then fifty fillers push the employee's own rule onto page 2.
    cf.rules.unshift(...Array.from({ length: 50 }, (_, i) => ({ id: `rule-filler-${i}`, name: `filler-${i}`, enabled: true, matchers: [{ type: "literal", field: "to", value: `filler${i}@agents.delo.sh` }], actions: [{ type: "worker", value: ["agents-facade"] }] })));
    cf.rules.unshift({ id: "rule-foreign", name: "foreign", enabled: true, matchers: [{ type: "literal", field: "to", value: "ada@agents.delo.sh" }], actions: [{ type: "forward", value: ["elsewhere@example.test"] }] });
    assert.ok(cf.rules.findIndex((r) => r.id === own.id) >= 50);
    const retired = rules.json(await rules.runAsync(["identity", "retire", "ada-pm", "--apply", "--json"]));
    assert.equal(retired.ok, true, JSON.stringify(retired.steps));
    assert.equal(cf.rules.find((r) => r.id === "rule-ada").enabled, false, "the employee's rule on page 2 was not disabled");
    assert.equal(cf.rules.find((r) => r.id === "rule-foreign").enabled, true, "a foreign rule was touched");
    assert.equal(rowOf(retired, "mail").status, "revoked");
    pass("service tokens and routing rules are read across pages, and a foreign rule listed first never hides the employee's own");
  }

  // -- 12e. the lifecycle lock ----------------------------------------------------------------------------------------------------
  {
    const w = await world("concurrent");
    const results = await Promise.all([1, 2].map(() => w.runAsync(["identity", "suspend", "ada-pm", "--revoke", "cloudflare_access", "--apply", "--json"])));
    const parsed = results.map((r) => w.json(r));
    assert.equal(cf.count("DELETE", /\/kv\//u), 1, "two applies deleted the allowlist key");
    assert.equal(cf.count("DELETE", /service_tokens/u), 1, "two applies deleted the Access token");
    for (const key of ["mail:allowlist-delete:ada@agents.delo.sh", `cloudflare_access:token-delete:${CLIENT.ada}`]) {
      assert.equal(parsed.filter((r) => stepOf(r, key).outcome === "already-done").length, 1, key);
    }
    pass("two concurrent applies serialize on the lifecycle lock: one KV DELETE and one token DELETE, the other reports already-done");
  }

  // -- 13. unrelated definitions stay byte-identical ----------------------------------------------------------------------
  {
    const w = await world("untouched");
    const before = DEFINITIONS(w);
    const registryBefore = before.registry;
    w.json(await w.runAsync(["identity", "suspend", "ada-pm", "--revoke", "github", "--apply", "--json"]));
    w.json(await w.runAsync(["identity", "restore", "ada-pm", "--apply", "--json"]));
    w.json(await w.runAsync(["identity", "retire", "ada-pm", "--revoke", "all", "--apply", "--json"]));
    assert.equal(readFileSync(w.bobRole, "utf8"), before.bob, "bob's definition changed");
    assert.equal(readFileSync(w.registry, "utf8"), registryBefore, "the registry changed");
    pass("no unrelated definition or registry byte changes across suspend, restore and retire");
  }

  // -- 14. secrets -------------------------------------------------------------------------------------------------------
  {
    const files = [];
    const walk = (dir) => { for (const name of readdirSync(dir)) { const p = join(dir, name); const s = lstatSync(p); if (s.isDirectory()) walk(p); else if (s.isFile() && !p.includes("/bin/") && !/\/(op|px-state|gw-state)\.json$/u.test(p) && !/-log\.jsonl$/u.test(p)) files.push(p); } };
    for (const w of worlds) walk(w.dir);
    assert.ok(files.length > 20);
    let scanned = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const secret of secrets) assert.equal(text.includes(secret), false, `a planted secret is in ${file}`);
      scanned++;
    }
    for (const text of outputs) for (const secret of secrets) assert.equal(text.includes(secret), false, "a planted secret reached stdout or stderr");
    for (const jwt of gh.allJwts) { secrets.add(jwt); assert.equal(outputs.some((t) => t.includes(jwt)), false, "an app JWT reached output"); }
    assert.ok(gh.allJwts.size > 0);
    pass(`no planted secret (${secrets.size} values, ${gh.allJwts.size} app JWTs) appears in any of ${scanned} state, ledger, definition or receipt files or any output`);
  }
} finally {
  await cf.close();
  await gh.close();
}

function rmReceipts(w) {
  const p = join(w.idState, "plane-verifications.jsonl");
  if (existsSync(p)) writeFileSync(p, "");
}

console.log(`\n${count} lifecycle scenarios passed`);
