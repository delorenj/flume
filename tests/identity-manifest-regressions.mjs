// FLUME-93 identity manifest: `flume identity manifest <employee>` judges every v1 point from local evidence only.
//
// Each fixture is an isolated HOME: registry, role.yaml, desk delta + generated config, provisioning and identity
// receipts, a Holocene avatar store and a gateway state file. Nothing reads the operator's real employees, and no
// provider endpoint is configured that could answer.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "flume-manifest-"));
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

const SUBJECT = "11111111-2222-4333-8444-555555555555";
const PLANE_USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ITEM = "abcdefghijklmnopqrstuvwxyz";
const PLANE_REF = `op://DeLoSecrets/${ITEM}/planefield`;
const ACCESS_REF = `op://DeLoSecrets/${ITEM}/accessfield`;
const GATEWAY = (consumer) => `op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/${consumer}`;

function fixture(label) {
  const dir = join(work, label), home = join(dir, "home"), fleet = join(home, ".hermes"), registry = join(fleet, "agents-registry.yaml");
  const state = join(home, ".local/state"), avatars = join(home, ".local/share/holocene/avatars");
  for (const p of [fleet, join(state, "flume/provision"), join(state, "flume/identity"), join(avatars, "files")]) mkdirSync(p, { recursive: true });
  writeFileSync(registry, "schema_version: 1\nagents: {}\n");
  writeFileSync(join(fleet, "config.yaml"), YAML.stringify({ tts: { provider: "vox", voice: "kurzgesagt", vox: { voice: "kurzgesagt" } }, secrets: { onepassword: { env: { AUTOMATICAI_GATEWAY_KEY: GATEWAY("hermes") } } } }));
  const env = { ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
    XDG_STATE_HOME: state, FLUME_HOST_OVERLAY: "none", HOLOCENE_AVATAR_DIR: avatars, HERMES_GATEWAY_STATE_FILE: join(fleet, "gateway_state.json"),
    FLUME_PROVISION_STATE: "", FLUME_IDENTITY_STATE: "", CLOUDFLARE_API_TOKEN: "", FLUME_CLOUDFLARE_API_BASE: "http://127.0.0.1:9/never" };
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, cwd: dir, encoding: "utf8", timeout: 60000 });
  const json = (r, status = 0) => { assert.equal(r.status, status, r.stdout + r.stderr); return JSON.parse(r.stdout); };

  /** A PM post: role.yaml (optionally enrolled), registry row and a real desk directory. */
  const BASE_TTS = { provider: "vox", voice: "kurzgesagt", vox: { voice: "kurzgesagt" } };
  const post = (id, { identity, telegram, gatewayConsumer, voice, tts, person } = {}) => {
    const roleDir = join(dir, "repos", id, "agents/hermes/pm");
    mkdirSync(roleDir, { recursive: true });
    const role = { repo: id, role: "pm", agent_id: id, profile: id, ...(person ? { identity: { name: person } } : {}), ...(telegram ? { telegram } : {}), ...(identity ? { company_identity: identity } : {}) };
    writeFileSync(join(roleDir, "role.yaml"), YAML.stringify(role));
    const doc = YAML.parseDocument(readFileSync(registry, "utf8"));
    doc.setIn(["agents", id], { role_dir: roleDir, profile_name: id, ...(gatewayConsumer ? { gateway_consumer: gatewayConsumer } : {}), ...(telegram ? { telegram } : {}) });
    writeFileSync(registry, String(doc));
    const desk = join(fleet, "profiles", id);
    mkdirSync(desk, { recursive: true });
    const envRefs = { ...(gatewayConsumer ? { AUTOMATICAI_GATEWAY_KEY: GATEWAY(gatewayConsumer) } : {}), ...(identity?.bindings?.plane ? { PLANE_API_KEY: PLANE_REF } : {}), ...(telegram ? { TELEGRAM_BOT_TOKEN: `op://DeLoSecrets/${ITEM}/tgfield` } : {}) };
    const delta = { ...(Object.keys(envRefs).length ? { secrets: { onepassword: { env: envRefs } } } : {}), ...(voice ? { tts: { provider: "vox", voice, vox: { voice } } } : tts ? { tts } : {}), ...(telegram ? { platforms: { telegram: { enabled: true } } } : {}) };
    writeFileSync(join(desk, "config.delta.yaml"), YAML.stringify(delta));
    // The generated config is the fleet base merged with the delta: a desk with no own consumer runs the base's.
    // tts merges one provider level deep, as the renderer does.
    const mergedTts = { ...BASE_TTS, ...(delta.tts ?? {}), vox: { ...BASE_TTS.vox, ...(delta.tts?.vox ?? {}) } };
    const generated = { ...delta, tts: mergedTts, secrets: { onepassword: { env: { AUTOMATICAI_GATEWAY_KEY: GATEWAY("hermes"), ...envRefs } } } };
    writeFileSync(join(desk, "config.yaml"), YAML.stringify(generated));
  };
  const receipt = (row) => writeFileSync(join(state, "flume/provision/receipts.jsonl"), `${JSON.stringify(row)}\n`, { flag: "a" });
  const planeReceipt = (row) => writeFileSync(join(state, "flume/identity/plane-verifications.jsonl"), `${JSON.stringify(row)}\n`, { flag: "a" });
  const avatar = (id, file = `${id}.0123456789abcdef.jpg`) => {
    writeFileSync(join(avatars, "files", file), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    writeFileSync(join(avatars, "index.json"), JSON.stringify({ agents: { [id]: { file, hash: "0".repeat(64), source: "holocene", updatedAt: "2026-11-01T00:00:00.000Z" } } }));
  };
  const gateway = (id, state) => writeFileSync(join(fleet, "gateway_state.json"), JSON.stringify({ pid: process.pid, gateway_state: "running", platforms: { [`${id}:telegram`]: { state, updated_at: "2026-11-20T00:00:00Z" } } }));
  return { dir, home, env, run, json, post, receipt, planeReceipt, avatar, gateway };
}

const identity = (handle, extra = {}) => ({ version: 1, subject: SUBJECT, handle, email: `${handle}@agents.delo.sh`, status: "active", enrolled_at: "2026-10-01T00:00:00.000Z", ...extra });
const planeBinding = { principal: PLANE_USER, instance: "https://plane.delo.sh/33god", credential_ref: PLANE_REF, attribution_mode: "native", native_actor_id: PLANE_USER };

try {
  // A fully provisioned employee: every required point and the optional Telegram point.
  {
    const f = fixture("complete");
    f.post("acme-pm", {
      identity: identity("acme", { bindings: { cloudflare_access: { principal: "x.access", instance: "https://delonet.cloudflareaccess.com", credential_ref: ACCESS_REF }, plane: planeBinding } }),
      telegram: { provisioning_status: "verified", bot_username: "acme_pm_bot", bot_id: "1234567890" },
      gatewayConsumer: "hermes-acme-pm", voice: "carlin", person: "acme",
    });
    f.receipt({ capability: "access-token", employee: "acme", action: "created", item: ITEM, at: "2026-10-01T00:00:00Z" });
    f.receipt({ capability: "mailbox-allowlist", employee: "acme", action: "created", key: "allowlist/acme@agents.delo.sh" });
    f.planeReceipt({ kind: "plane.adopt", subject: SUBJECT, credential_ref: PLANE_REF, principal: PLANE_USER, instance: planeBinding.instance, credential: { type: "plane_personal_access_token" }, evidence: "provider", boards: [] });
    f.avatar("acme-pm");
    f.gateway("acme-pm", "connected");
    const r = f.json(f.run(["identity", "manifest", "acme-pm", "--json"]));
    assert.equal(r.enrolled, true);
    assert.deepEqual(r.manifest, { version: 1, latest: 1, adopted: null });
    assert.deepEqual(r.points.map((p) => p.id), ["vault", "gateway", "plane", "inbox", "voice", "avatar", "telegram"]);
    for (const p of r.points) assert.equal(p.satisfied, true, `${p.id}: ${p.detail}`);
    assert.equal(r.satisfied, 6);
    assert.equal(r.total, 6);
    assert.deepEqual(r.optional, { satisfied: 1, total: 1 });
    // The person name resolves to the same employee.
    assert.equal(f.json(f.run(["identity", "manifest", "acme", "--json"])).satisfied, 6);
    const text = f.run(["identity", "manifest", "acme-pm"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /identity manifest v1 · 6\/6 required · 1\/1 optional/u);
    pass("a fully provisioned employee satisfies 6/6 required and 1/1 optional, by post or person");
  }

  // A post that was never enrolled still gets an honest answer: account points fail, desk points are judged.
  {
    const f = fixture("unenrolled");
    f.post("bare-pm", { voice: "walken" });
    f.avatar("bare-pm");
    const r = f.json(f.run(["identity", "manifest", "bare-pm", "--json"]));
    assert.equal(r.enrolled, false);
    const by = Object.fromEntries(r.points.map((p) => [p.id, p]));
    for (const id of ["vault", "plane", "inbox"]) assert.equal(by[id].satisfied, false, id);
    assert.match(by.vault.detail, /not enrolled/u);
    assert.equal(by.gateway.satisfied, false);
    assert.match(by.gateway.detail, /shared fleet consumer `hermes`/u);
    assert.equal(by.voice.satisfied, true);
    assert.match(by.voice.detail, /walken \(vox\)/u);
    assert.equal(by.avatar.satisfied, true);
    assert.equal(by.telegram.satisfied, false);
    assert.equal(r.satisfied, 2);
    assert.equal(r.total, 6);
    pass("an unenrolled post: account points unsatisfied, voice and avatar still judged, telegram not linked");
  }

  // Each point refuses the look-alike evidence that would otherwise read as satisfied.
  {
    const f = fixture("lookalikes");
    f.post("half-pm", {
      identity: identity("half", { status: "suspended", bindings: { cloudflare_access: { principal: "y.access", credential_ref: ACCESS_REF }, plane: { ...planeBinding, native_actor_id: undefined } } }),
      gatewayConsumer: "hermes-shared-key",
    });
    f.post("other-pm", { gatewayConsumer: "hermes-shared-key" });
    // Allowlist receipt exists but the employee is suspended; Access binding with no receipt naming the item.
    f.receipt({ capability: "mailbox-allowlist", employee: "half", action: "created", key: "allowlist/half@agents.delo.sh" });
    const r = f.json(f.run(["identity", "manifest", "half-pm", "--json"]));
    const by = Object.fromEntries(r.points.map((p) => [p.id, p]));
    assert.equal(by.vault.satisfied, false);
    assert.match(by.vault.detail, /no receipt/u);
    assert.equal(by.gateway.satisfied, false);
    assert.match(by.gateway.detail, /shared with other-pm/u);
    assert.equal(by.plane.satisfied, false);
    assert.equal(by.inbox.satisfied, false);
    assert.match(by.inbox.detail, /suspended/u);
    assert.equal(by.voice.satisfied, false);
    assert.match(by.voice.detail, /speaks the fleet default kurzgesagt/u);
    assert.equal(by.avatar.satisfied, false);
    assert.equal(r.satisfied, 0);
    pass("look-alikes are refused: unrecorded item, shared consumer, unadopted plane, suspended inbox, inherited voice");
  }

  // The second route to each point, and the look-alikes the first review caught.
  {
    const f = fixture("second-routes");
    // vault-item receipt with no Access binding; no allowlist receipt; vox-only delta voice (tts.voice still wins).
    f.post("vox-pm", { identity: identity("voxy"), tts: { vox: { voice: "carlin" } }, gatewayConsumer: "hermes-vox-pm",
      telegram: { provisioning_status: "verified", bot_username: "vox_pm_bot", bot_id: "42" } });
    f.receipt({ capability: "vault-item", employee: "voxy", action: "created", item_id: ITEM });
    f.receipt({ capability: "mailbox-rule", employee: "voxy", action: "created", address: "voxy@agents.delo.sh" });
    f.gateway("vox-pm", "disconnected");
    // A delta that pins the fleet default is not a personal voice.
    f.post("pin-pm", { voice: "kurzgesagt" });
    const r = f.json(f.run(["identity", "manifest", "vox-pm", "--json"]));
    const by = Object.fromEntries(r.points.map((p) => [p.id, p]));
    assert.equal(by.vault.satisfied, true, by.vault.detail);
    assert.match(by.vault.detail, /vault-item receipt/u);
    assert.equal(by.gateway.satisfied, true, by.gateway.detail);
    assert.equal(by.inbox.satisfied, false);
    assert.match(by.inbox.detail, /no mailbox allowlist receipt/u);
    assert.equal(by.voice.satisfied, false, "tts.vox.voice alone does not change what vox speaks");
    assert.match(by.voice.detail, /speaks the fleet default kurzgesagt \(vox\)/u);
    assert.equal(by.telegram.satisfied, false, "wired but disconnected is not online");
    assert.match(by.telegram.detail, /gateway state disconnected/u);
    const pin = Object.fromEntries(f.json(f.run(["identity", "manifest", "pin-pm", "--json"])).points.map((p) => [p.id, p]));
    assert.equal(pin.voice.satisfied, false);
    pass("second routes: vault-item receipt counts; vox-only voice, pinned default, missing allowlist and a disconnected bot do not");
  }

  // No registry: a distinct error, never "Employee not found" (a caller would read that as unhired).
  {
    const f = fixture("no-registry");
    rmSync(join(f.home, ".hermes/agents-registry.yaml"));
    const r = f.json(f.run(["identity", "manifest", "acme-pm", "--json"]), 1);
    assert.match(r.error, /Agent registry not readable/u);
    pass("a missing registry is 'not readable', not 'Employee not found'");
  }

  // No employee: the project at cwd (or --project), its PM first, as an agent CLI's /identity shows it.
  {
    const f = fixture("project");
    f.post("proj-pm", { voice: "walken" });
    f.post("proj-helper", {});
    const repo = join(f.dir, "repo"), sub = join(repo, "deep/er");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(repo, ".project.json"), JSON.stringify({ project_id: "proj", agents: { "proj-helper": { role: "helper" }, "proj-pm": { role: "pm" }, ghost: { role: "dev" } } }));
    const r = f.json(f.run(["identity", "manifest", "--project", sub, "--json"]));
    assert.equal(r.pm, "proj-pm");
    assert.deepEqual(r.agents.map((a) => a.employee), ["proj-pm", "proj-helper", "ghost"]);
    assert.equal(r.agents[2].ok, false);
    const md = f.run(["identity", "manifest", "--project", sub, "--markdown"]);
    assert.equal(md.status, 0, md.stderr);
    assert.match(md.stdout, /^\*\*proj\*\* · bound PM/u);
    assert.match(md.stdout, /\| ✓ \| voice \| walken \(vox\) \|/u);
    assert.match(md.stdout, /- \*\*ghost\*\* \(dev\) · `id none` · Employee not found/u);
    const none = f.run(["identity", "manifest", "--project", f.home, "--json"]);
    assert.equal(none.status, 1);
    assert.match(JSON.parse(none.stdout).error, /No \.project\.json/u);
    pass("no employee: the project's agents, PM first; markdown is the /identity view; no project is a clean error");
  }

  // An unknown employee is a clean failure, not a crash.
  {
    const f = fixture("unknown");
    const r = f.json(f.run(["identity", "manifest", "nobody", "--json"]), 1);
    assert.equal(r.ok, false);
    assert.match(r.error, /Employee not found/u);
    pass("an unknown employee fails with ok:false and exit 1");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`identity-manifest: ${count} passed`);
