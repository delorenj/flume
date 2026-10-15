// FLUME-52 employee-native Plane identity, through the built `flume` CLI only.
//
// Pilot (`px`) owns every Plane read and write, so the only double here is a stateful FAKE px
// (FLUME_PX_BIN): users, personal access tokens, boards and ticket comments, px's refusal codes,
// and modes that lie, hang or answer with something that is not JSON. It logs every argv, so
// "only `identity verify` and `show` were ever invoked" and "zero px calls for a gate" are
// measured. Each personal access token the fake holds is collected and then scanned for in
// everything any process printed and every file Flume wrote.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync("/tmp/flume52-");
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

const GROLF = "292ac356-3640-474e-ac01-8b0611ed6a91";
const RERE = "ba82e3bd-9b21-4066-9737-bd6279cf00f7";
const THIRD = "0c5b2a77-4d1e-4f6a-9b8e-2a3f4c5d6e7f";
const JARAD = "a95d7646-1d2e-4b3c-8a4f-5e6d7c8b9a01";
const OUTSIDER = "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b";
const STALE = ["62b4fef6-b0fe-4cd2-bcd7-53737a61feb4", "b29eaffc-cc8d-4de1-a10b-7425c67177ab", "fe4e8e5f-8936-4964-ad8a-ffeaacc99b88", "db1ac9dc-6180-47d0-aa87-e1bf46d10707"];
const REF = { grolf: "op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/5td5eddyyhjnbbsgfoovfi5x2y", rererere: "op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/gwxsutraup26mm4h7vkqj64ivu", third: "op://DeLoSecrets/thirdthirdthirdthirdthird0/fieldfieldfield0000000000fi", jarad: "op://DeLoSecrets/jaradjaradjaradjaradjarad0/operatorfield000000000000ab" };
const INSTANCE = "https://plane.delo.sh/33god";
const BOARD = { TEST: "0711da94-284a-4db1-86e8-d7ca37c26d45", FLUME: "bf5663f0-8d37-41c6-97a3-437d45d64523", WORKF: "7235e207-73a9-421e-8f1f-7f2435387dc0", "33GOD": "15258893-0206-4e8f-aea6-340eb217988c" };
const C1 = "b405f5b4-3525-4980-b9b2-4ad40b145d73", C2 = "2d4fe4fa-c167-4aac-a25b-7cb5c18c72e8", C3 = "3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a", C4 = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";
/** Every personal access token the fake holds, plus an operator one in the environment; scanned for at the end. */
const PAT = { grolf: "plane_api_GROLF_planted_value_91ac3e", rererere: "plane_api_RERERERE_planted_value_77be2d", third: "plane_api_THIRD_planted_value_55cd1f", jarad: "plane_api_JARAD_planted_value_33de0a" };
const OPERATOR_KEY = "plane_api_OPERATOR_planted_value_11ff9b";
const secrets = [...Object.values(PAT), OPERATOR_KEY];

const FAKE_PX = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.PX_FAKE_STATE, "utf8"));
fs.appendFileSync(process.env.PX_FAKE_LOG, JSON.stringify({ argv: args, canary: process.env.PX_ENV_CANARY || null }) + "\\n");
const out = (code, body) => { process.stdout.write(JSON.stringify(body)); process.exit(code); };
const refuse = (code, error) => out(1, { ok: false, error, code });
const flag = (name) => { const i = args.indexOf("--" + name); return i < 0 ? undefined : args[i + 1]; };
if (state.mode === "hang") { setTimeout(() => {}, 600000); return; }
if (state.mode === "nonjson") { process.stdout.write("<html>502 bad gateway</html>"); process.exit(0); }
if (args[0] === "identity" && args[1] === "verify") {
  const ref = flag("key-ref"), uid = flag("user-id"), board = flag("board"), email = flag("email");
  const key = state.keys[ref];
  if (!key) refuse("credential_unresolvable", "could not resolve " + ref);
  if ((state.rejected || []).includes(ref)) refuse("credential_rejected", "Plane rejected " + ref + " (HTTP 401)");
  const me = state.users[key.user];
  if (me.id !== uid) refuse("wrong_employee", ref + " resolves to native user " + me.id + ", not " + uid);
  if (email && me.email !== email) refuse("wrong_employee", "users/me email is " + me.email);
  const forced = (state.force || {})[ref + "|" + board] || (state.force || {})["*"];
  if (forced) refuse(forced, "forced " + forced);
  const found = Object.values(state.boards).find((b) => b.identifier.toLowerCase() === board.toLowerCase() || b.id === board.toLowerCase());
  if (!found) refuse("unknown_board", "board " + board + " is not a project");
  if (!found.members.includes(me.id)) refuse("not_project_member", me.id + " is not listed on board " + found.identifier);
  const result = {
    ok: true, verified: true, employee: flag("employee"), native_user_id: me.id, email: me.email, display_name: me.name,
    workspace: { slug: flag("workspace"), role: 15 }, board: { id: found.id, identifier: found.identifier, name: found.name, member: true },
    plane: { observable: true, version: "1.3.1", edition: "PLANE_COMMUNITY", latest_version: "v1.4.2", source: "GET /api/instances/ (unauthenticated)" },
    credential: { ref, type: "plane_personal_access_token", header: "X-API-Key",
      expiry: { observable: false, reason: "Plane exposes a token's expiry only to its owner's browser session", failure_signal: "HTTP 401 on users/me" },
      revocation: { native: "the owner deletes the token under Profile > Personal Access Tokens", board_access: "an admin removes the project membership", px_verb: null },
      enrollment: { supported: "manual", unsupported: ["token minting by API key"] } },
    shared_key_fallback: false, checks: [{ check: "users_me_matches_native_user_id", ok: true }], verified_at: "2026-10-14T20:00:00.000Z",
  };
  out(0, Object.assign(result, state.lie || {}));
}
if (args[0] === "show") {
  const ticket = state.tickets[args[1]];
  if (!ticket) refuse("not_found", "no ticket " + args[1]);
  out(0, { ok: true, ticket: { ref: args[1], project: ticket.project, comments: ticket.comments } });
}
out(99, { ok: false, code: "forbidden_verb", error: "only identity verify and show are allowed here" });
`;

const base = (over = {}) => ({
  mode: "ok", workspace: "33god", rejected: [], force: {}, lie: null,
  users: {
    [GROLF]: { id: GROLF, email: "grolf@agents.delo.sh", name: "Grolf" }, [RERE]: { id: RERE, email: "rererere@agents.delo.sh", name: "Rererere" },
    [THIRD]: { id: THIRD, email: "third@agents.delo.sh", name: "Third" }, [JARAD]: { id: JARAD, email: "jaradd@gmail.com", name: "Jarad" },
  },
  keys: { [REF.grolf]: { user: GROLF, pat: PAT.grolf }, [REF.rererere]: { user: RERE, pat: PAT.rererere }, [REF.third]: { user: THIRD, pat: PAT.third }, [REF.jarad]: { user: JARAD, pat: PAT.jarad } },
  boards: {
    TEST: { id: BOARD.TEST, identifier: "TEST", name: "Sandbox", members: [GROLF, RERE, THIRD] }, FLUME: { id: BOARD.FLUME, identifier: "FLUME", name: "Flume", members: [GROLF] },
    WORKF: { id: BOARD.WORKF, identifier: "WORKF", name: "Workforce", members: [RERE] }, "33GOD": { id: BOARD["33GOD"], identifier: "33GOD", name: "33GOD", members: [GROLF] },
  },
  tickets: { "TEST-14": { project: BOARD.TEST, comments: [
    { id: C1, actor_id: GROLF, actor_name: "Grolf", comment_html: "<p>[px-identity:grolf:px13-proof-1]</p>" },
    { id: C2, actor_id: RERE, actor_name: "Rererere", comment_html: "<p>[px-identity:rererere:px13-proof-1]</p>" },
    // Authored by rererere but wearing grolf's name and marker: text is never evidence.
    { id: C3, actor_id: RERE, actor_name: "Grolf", comment_html: "<p>[px-identity:grolf:spoof-1]</p>" },
    { id: C4, actor_id: THIRD, actor_name: "Third", comment_html: "<p>third</p>" },
  ] } },
  ...over,
});

/** Bytes and mtimes of everything under `path`: equal trees mean nothing was written. */
function tree(path) {
  let s;
  try { s = lstatSync(path); } catch { return null; }
  if (s.isSymbolicLink()) return { link: readlinkSync(path) };
  if (s.isDirectory()) return Object.fromEntries(readdirSync(path).sort().filter((n) => !n.endsWith(".lock")).map((n) => [n, tree(join(path, n))]));
  return { bytes: readFileSync(path).toString("base64"), mtime: s.mtimeMs };
}

function fixture(label) {
  const dir = join(work, label), home = join(dir, "home"), fleet = join(home, ".hermes"), registry = join(fleet, "agents-registry.yaml"), bin = join(dir, "bin");
  for (const p of [fleet, join(home, ".agents/workforce"), join(dir, "repos"), bin]) mkdirSync(p, { recursive: true });
  writeFileSync(registry, "# org comment\nschema_version: 1\nagents: {}\n");
  writeFileSync(join(bin, "px"), FAKE_PX, { mode: 0o755 });
  const statePath = join(dir, "px-state.json"), logPath = join(dir, "px-log.jsonl"), idState = join(dir, "identity-state");
  writeFileSync(logPath, "");
  const env = { ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
    HERMES_TEMPLATE_CONFIG: join(dir, "no-config"), HERMES_FLEET_ENV: join(dir, "no-env"), XDG_STATE_HOME: join(home, ".local/state"), PYTHONDONTWRITEBYTECODE: "1",
    CLOUDFLARE_API_TOKEN: "", FLUME_CLOUDFLARE_API_BASE: "http://127.0.0.1:9/never", FLUME_PX_BIN: join(bin, "px"), PX_FAKE_STATE: statePath, PX_FAKE_LOG: logPath,
    FLUME_IDENTITY_STATE: idState, PX_ENV_CANARY: "parent-env-passes-through", PLANE_API_KEY: OPERATOR_KEY, FLUME_PX_TIMEOUT_MS: "5000" };
  delete env.FLUME_IDENTITY_CANDIDATES;
  const px = { state: base(), save: () => writeFileSync(statePath, JSON.stringify(px.state)), set(patch) { Object.assign(px.state, patch); px.save(); },
    calls: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)), reset: () => writeFileSync(logPath, "") };
  px.save();
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, cwd: dir, encoding: "utf8", timeout: 60000 });
  const json = (r, status = 0) => { assert.equal(r.status, status, r.stdout + r.stderr); return JSON.parse(r.stdout); };
  const post = (id, roleYaml) => {
    const roleDir = join(dir, "repos", id, "agents/hermes/pm");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), roleYaml);
    const doc = YAML.parseDocument(readFileSync(registry, "utf8"));
    doc.setIn(["agents", id], { project_path: join(dir, "repos", id), role_dir: roleDir, profile_name: id, identity: id });
    writeFileSync(registry, String(doc));
    return join(roleDir, "role.yaml");
  };
  const named = (id, person) => post(id, `# operator note: keep me\nrepo: ${id}\nrole: pm\nagent_id: ${id}\nprofile: ${id}\nidentity:\n  name: ${person}\n  recall_banks:\n    - agent-${id}\n`);
  /** An enrolled employee: a post named for the person, enrolled through the CLI. */
  const employee = (post_, person) => { const path = named(post_, person); json(run(["identity", "enroll", post_, "--apply", "--json"])); return path; };
  const bind = (who, name, extra = {}) => run(["identity", "bind", who, "plane", "--principal", extra.principal ?? ({ grolf: GROLF, rererere: RERE, third: THIRD }[name]), "--instance", extra.instance ?? INSTANCE, "--credential-ref", extra.ref ?? REF[name], "--apply", "--json"]);
  const adopt = (who, boards, extra = [], envExtra = {}) => run(["identity", "adopt-actor", who, "plane", ...boards.flatMap((b) => ["--board", b]), ...extra, "--json"], envExtra);
  const block = (path) => YAML.parse(readFileSync(path, "utf8")).company_identity;
  const edit = (path, fn) => { const doc = YAML.parse(readFileSync(path, "utf8")); fn(doc.company_identity); const text = readFileSync(path, "utf8"); const head = text.slice(0, text.search(/^company_identity:/mu)); writeFileSync(path, head + YAML.stringify({ company_identity: doc.company_identity }, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" })); };
  const receipts = () => { const p = join(idState, "plane-verifications.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
  return { dir, home, registry, env, px, run, json, post, named, employee, bind, adopt, block, edit, receipts, idState, logPath };
}

const codes = (result) => result.blockers.map((b) => b.code);
/** A fresh world with grolf and rererere enrolled; optionally bound and adopted. */
function world(label, { bind = true, adopt = true } = {}) {
  const f = fixture(label);
  f.grolf = f.employee("33god-pm", "grolf");
  f.rere = f.employee("rere-pm", "rererere");
  if (bind) { f.json(f.bind("33god-pm", "grolf")); f.json(f.bind("rere-pm", "rererere")); }
  if (adopt) { f.json(f.adopt("33god-pm", ["TEST", "FLUME"], ["--apply"])); f.json(f.adopt("rere-pm", ["TEST"], ["--apply"])); f.px.reset(); }
  return f;
}
const verifyArgs = (...pairs) => ["comment", "verify-plane", "TEST-14", ...pairs.flatMap(([who, id]) => ["--comment", `${who}:${id}`]), "--json"];

try {
  // -- Bind: preview, apply, re-apply ----------------------------------------------------------
  {
    const f = fixture("bind-happy");
    const path = f.employee("33god-pm", "grolf");
    const before = tree(f.dir);
    const argv = ["identity", "bind", "33god-pm", "plane", "--principal", GROLF, "--instance", INSTANCE, "--credential-ref", REF.grolf, "--json"];
    const preview = f.json(f.run(argv));
    assert.equal(preview.changed, true);
    assert.equal(preview.apply, false);
    assert.deepEqual(preview.binding, { principal: GROLF, instance: INSTANCE, credential_ref: REF.grolf });
    assert.deepEqual(tree(f.dir), before, "a preview writes nothing");
    const applied = f.json(f.run([...argv, "--apply"]));
    assert.equal(applied.changed, true);
    assert.deepEqual(f.block(path).bindings.plane, { principal: GROLF, instance: INSTANCE, credential_ref: REF.grolf });
    assert.equal(f.block(path).bindings.plane.native_actor_id, undefined, "bind never writes native_actor_id");
    assert.equal(f.json(f.run([...argv, "--apply"])).changed, false);
    assert.equal(f.px.calls().length, 0, "bind makes no px call");
    pass("bind previews, writes bindings.plane on --apply, and an identical re-apply is changed:false; no px call");
  }

  // -- Bind: invalid -----------------------------------------------------------------------------
  {
    const f = fixture("bind-invalid");
    const path = f.employee("33god-pm", "grolf");
    const bytes = readFileSync(path, "utf8");
    const attempt = (over) => f.json(f.run(["identity", "bind", "33god-pm", "plane", "--principal", over.principal ?? GROLF, "--instance", over.instance ?? INSTANCE, "--credential-ref", over.ref ?? REF.grolf, ...(over.mode ? ["--attribution-mode", over.mode] : []), "--apply", "--json"]), 1);
    for (const [label, over, code] of [
      ["non-UUID principal", { principal: "not-a-uuid" }, "invalid-binding"],
      ["uppercase UUID principal", { principal: GROLF.toUpperCase() }, "invalid-binding"],
      ["a numeric GitHub-style principal", { principal: "123456" }, "invalid-binding"],
      ["instance without a workspace", { instance: "https://plane.delo.sh" }, "invalid-binding"],
      ["instance with a trailing slash", { instance: `${INSTANCE}/` }, "invalid-binding"],
      ["instance with an extra path", { instance: `${INSTANCE}/projects` }, "invalid-binding"],
      ["plain http instance", { instance: "http://plane.delo.sh/33god" }, "invalid-binding"],
      ["title-based reference", { ref: "op://DeLoSecrets/Plane Grolf/token" }, "invalid-credential-ref"],
      ["section-qualified reference", { ref: "op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/section/5td5eddyyhjnbbsgfoovfi5x2y" }, "invalid-credential-ref"],
      ["shared_bot_attributed", { mode: "shared_bot_attributed" }, "invalid-binding"],
    ]) {
      const result = attempt(over);
      assert.ok(codes(result).includes(code), `${label}: ${JSON.stringify(result.blockers)}`);
      assert.equal(result.changed, false, label);
    }
    assert.equal(readFileSync(path, "utf8"), bytes, "nothing was written");
    // A hand-edited binding that bind would have refused is refused at runtime too.
    f.edit(path, (b) => { b.bindings = { plane: { principal: GROLF, instance: `${INSTANCE}/extra`, credential_ref: REF.grolf } }; });
    const gate = f.json(f.adopt("33god-pm", ["TEST"]), 1);
    assert.deepEqual(codes(gate), ["provider-binding-invalid"]);
    assert.equal(f.px.calls().length, 0);
    pass("invalid principals, instances, references and attribution are refused at bind time and again at runtime, with no write and no px call");
  }

  // -- Bind: stale and foreign candidates ----------------------------------------------------------
  {
    const f = fixture("bind-candidates");
    const path = f.employee("33god-pm", "grolf");
    const bytes = readFileSync(path, "utf8");
    for (const principal of STALE) {
      const result = f.json(f.run(["identity", "bind", "33god-pm", "plane", "--principal", principal, "--instance", INSTANCE, "--credential-ref", REF.grolf, "--apply", "--json"]), 1);
      const hit = result.blockers.find((b) => b.code === "stale-candidate");
      assert.ok(hit, JSON.stringify(result.blockers));
      assert.match(hit.detail, /stale|alias|registry/u);
      assert.ok(hit.detail.includes(principal));
    }
    assert.equal(readFileSync(path, "utf8"), bytes);
    // Even a hand-edited binding to a stale principal cannot be adopted.
    f.edit(path, (b) => { b.bindings = { plane: { principal: STALE[1], instance: INSTANCE, credential_ref: REF.grolf } }; });
    assert.ok(codes(f.json(f.adopt("33god-pm", ["TEST"]), 1)).includes("stale-candidate"));
    assert.equal(f.px.calls().length, 0);
    pass("the four stale or foreign candidates are stale-candidate blockers at bind and at adopt, naming their disposition");
  }

  // -- Manual enrollment prerequisites -----------------------------------------------------------
  {
    const f = fixture("enrollment");
    f.employee("33god-pm", "grolf");
    const noRef = f.json(f.run(["identity", "bind", "33god-pm", "plane", "--principal", GROLF, "--instance", INSTANCE, "--json"]), 1);
    assert.ok(codes(noRef).includes("manual-enrollment-required"));
    const noBinding = f.json(f.adopt("33god-pm", ["TEST"]), 1);
    assert.deepEqual(codes(noBinding), ["no-provider-binding"]);
    for (const result of [noRef, noBinding]) {
      const text = result.enrollment.prerequisites.join("\n");
      for (const needle of ["grolf@agents.delo.sh", "sign in once", "personal access token", "expiry", "26-char item uuid", "board", "identity bind", "adopt-actor"]) assert.ok(text.includes(needle), `${needle} in ${text}`);
    }
    assert.equal(f.px.calls().length, 0);
    pass("bind without a credential and adopt without a binding list the manual enrollment prerequisites and call px zero times");
  }

  // -- Adopt: happy path ---------------------------------------------------------------------------
  {
    const f = world("adopt-happy", { adopt: false });
    f.px.reset();
    const registryBefore = readFileSync(f.registry, "utf8");
    // The registry carries a stale member id for the post: reported, never written.
    const reg = YAML.parseDocument(readFileSync(f.registry, "utf8"));
    reg.setIn(["agents", "33god-pm", "plane"], { member_id: STALE[1], key_ref: "op://DeLoSecrets/gone/apiKey" });
    writeFileSync(f.registry, String(reg));
    const registryStale = readFileSync(f.registry, "utf8");
    assert.notEqual(registryStale, registryBefore);
    const rolePath = f.grolf, roleBefore = readFileSync(rolePath, "utf8");
    const preview = f.json(f.adopt("33god-pm", ["TEST", "FLUME"]));
    assert.equal(preview.changed, true);
    assert.equal(preview.apply, false);
    assert.equal(readFileSync(rolePath, "utf8"), roleBefore, "a preview writes nothing");
    assert.equal(f.receipts().length, 0, "no receipt without --apply");
    assert.equal(f.px.calls().length, 2, "one verify per board");
    assert.ok(preview.warnings.some((w) => w.startsWith("legacy-registry-principal") && w.includes(STALE[1]) && w.includes(GROLF)), JSON.stringify(preview.warnings));
    f.px.reset();
    const applied = f.json(f.adopt("33god-pm", ["TEST", "FLUME"], ["--apply"]));
    assert.equal(applied.changed, true);
    assert.equal(f.block(rolePath).bindings.plane.native_actor_id, GROLF);
    assert.equal(applied.actor.id, GROLF);
    assert.deepEqual(applied.boards.map((b) => [b.identifier, b.id, b.member]), [["TEST", BOARD.TEST, true], ["FLUME", BOARD.FLUME, true]]);
    assert.equal(applied.plane.version, "1.3.1");
    assert.equal(applied.plane.edition, "PLANE_COMMUNITY");
    assert.equal(applied.credential.type, "plane_personal_access_token");
    assert.equal(applied.credential.static, true);
    assert.equal(applied.credential.expiry.observable, false);
    assert.ok(applied.credential.revocation.native);
    assert.equal(applied.credential.ref, REF.grolf);
    assert.equal(applied.shared_key_fallback, false);
    assert.equal(applied.evidence, "fixture");
    assert.equal(JSON.stringify(applied).includes("expires_at"), false);
    assert.equal(JSON.stringify(applied).includes("lifetime_seconds"), false);
    assert.equal(readFileSync(f.registry, "utf8"), registryStale, "the agent registry is never written");
    const calls = f.px.calls();
    assert.equal(calls.length, 2);
    for (const [i, board] of ["TEST", "FLUME"].entries()) {
      assert.deepEqual(calls[i].argv, ["identity", "verify", "--json", "--employee", "grolf", "--key-ref", REF.grolf, "--user-id", GROLF, "--email", "grolf@agents.delo.sh", "--workspace", "33god", "--base", "https://plane.delo.sh", "--board", board]);
      assert.equal(calls[i].canary, "parent-env-passes-through", "the parent environment reaches px unchanged");
    }
    const [receipt, ...rest] = f.receipts();
    assert.equal(rest.length, 0);
    assert.equal(receipt.kind, "plane.adopt");
    assert.equal(receipt.evidence, "fixture");
    assert.equal(receipt.native_actor_id, GROLF);
    assert.deepEqual(receipt.boards.map((b) => b.id), [BOARD.TEST, BOARD.FLUME]);
    assert.equal(receipt.credential_ref, REF.grolf);
    assert.equal(statSync(join(f.idState, "plane-verifications.jsonl")).mode & 0o777, 0o600);
    // Re-adopting is idempotent, and an identical rebind after adoption is still a no-op.
    const again = f.json(f.adopt("33god-pm", ["TEST"], ["--apply"]));
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(f.json(f.bind("33god-pm", "grolf")).changed, false);
    assert.equal(f.block(rolePath).bindings.plane.native_actor_id, GROLF);
    // The body outside the block is byte-for-byte what the operator wrote.
    assert.ok(readFileSync(rolePath, "utf8").startsWith("# operator note: keep me\n"));
    pass("adopt verifies every board through px argv exactly, stamps native_actor_id, reports static PAT semantics, warns on the legacy registry id without writing it, and is idempotent");
  }

  // -- Adopt: gates fire before any px call -----------------------------------------------------------
  {
    const f = world("adopt-gates", { adopt: false });
    f.json(f.run(["identity", "status", "rere-pm", "suspended", "--apply", "--json"]));
    f.employee("third-pm", "third");
    f.json(f.run(["identity", "status", "third-pm", "retired", "--apply", "--json"]));
    f.named("raw-pm", "rawperson"); // never enrolled
    const suspended = f.json(f.adopt("rere-pm", ["TEST"]), 1);
    assert.deepEqual(codes(suspended), ["employee-suspended"]);
    assert.deepEqual(codes(f.json(f.adopt("third-pm", ["TEST"]), 1)), ["employee-retired"]);
    assert.deepEqual(codes(f.json(f.adopt("raw-pm", ["TEST"]), 1)), ["not-enrolled"]);
    assert.deepEqual(codes(f.json(f.adopt("33god-pm", []), 1)), ["invalid-request"]);
    assert.deepEqual(codes(f.json(f.adopt("33god-pm", ["bad board!"]), 1)), ["invalid-request"]);
    assert.equal(f.px.calls().length, 0, "every gate fires with zero px calls");
    assert.equal(f.block(f.grolf).bindings.plane.native_actor_id, undefined);
    pass("a suspended, retired or unenrolled employee, and a request without a valid board, are refused with zero px calls");
  }

  // -- Adopt: px refuses ---------------------------------------------------------------------------------
  {
    const f = world("adopt-refused", { adopt: false });
    const bytes = readFileSync(f.grolf, "utf8");
    const expect = (patch, code, boards = ["TEST"], label = code) => {
      f.px.state = base();
      f.px.set(patch);
      f.px.reset();
      const result = f.json(f.adopt("33god-pm", boards, ["--apply"]), 1);
      const blocker = result.blockers.find((b) => b.code === "provider-refused");
      assert.ok(blocker, `${label}: ${JSON.stringify(result.blockers)}`);
      assert.equal(blocker.provider_code, code, label);
      assert.equal(readFileSync(f.grolf, "utf8"), bytes, `${label}: nothing written`);
      assert.equal(f.receipts().length, 0, `${label}: no receipt`);
      return result;
    };
    // wrong_employee: the binding names grolf but the reference resolves to Jarad's key.
    expect({ keys: { ...base().keys, [REF.grolf]: { user: JARAD, pat: PAT.jarad } } }, "wrong_employee");
    for (const code of ["not_employee_identity", "shared_identity", "shared_credential"]) expect({ force: { "*": code } }, code);
    expect({ boards: { ...base().boards, TEST: { ...base().boards.TEST, members: [RERE] } } }, "not_project_member");
    expect({ rejected: [REF.grolf] }, "credential_rejected");
    expect({}, "unknown_board", ["NOPE"]);
    // Every board must pass: TEST passes, WORKF (grolf is not a member) refuses, and nothing is written.
    const partial = expect({}, "not_project_member", ["TEST", "WORKF"], "second board refuses");
    assert.equal(partial.blockers.find((b) => b.code === "provider-refused").board, "WORKF");
    assert.equal(f.px.calls().length, 2);
    assert.equal(partial.ok, false);
    pass("every px refusal code is a provider-refused blocker carrying px's code, and a refusal on any board writes nothing even when other boards passed");
  }

  // -- Adopt: px disagrees with the binding ----------------------------------------------------------------
  {
    const f = world("adopt-mismatch", { adopt: false });
    const bytes = readFileSync(f.grolf, "utf8");
    const board = { id: BOARD.TEST, identifier: "TEST", name: "Sandbox", member: true };
    for (const [label, lie] of [
      ["another native user", { native_user_id: RERE }], ["another mailbox", { email: "rererere@agents.delo.sh" }], ["another workspace", { workspace: { slug: "other", role: 15 } }],
      ["board.member false", { board: { ...board, member: false } }], ["another board", { board: { ...board, id: BOARD.FLUME, identifier: "FLUME" } }],
      ["shared_key_fallback true", { shared_key_fallback: true }], ["shared_key_fallback null", { shared_key_fallback: null }],
      ["another credential reference", { credential: { ref: REF.rererere, type: "plane_personal_access_token", expiry: { observable: false }, revocation: {} } }],
      ["verified false", { verified: false }],
    ]) {
      f.px.state = base();
      f.px.set({ lie });
      const result = f.json(f.adopt("33god-pm", ["TEST"], ["--apply"]), 1);
      assert.deepEqual(codes(result), ["provider-result-mismatch"], label);
      assert.equal(readFileSync(f.grolf, "utf8"), bytes, label);
    }
    assert.equal(f.receipts().length, 0);
    pass("an exit-0 px answer that disagrees with the binding or the request is provider-result-mismatch and writes nothing");
  }

  // -- Adopt: px unusable ---------------------------------------------------------------------------------------
  {
    const f = world("adopt-unavailable", { adopt: false });
    const bytes = readFileSync(f.grolf, "utf8");
    const missing = f.json(f.adopt("33god-pm", ["TEST"], ["--apply"], { FLUME_PX_BIN: join(f.dir, "bin/not-installed") }), 1);
    assert.deepEqual(codes(missing), ["provider-unavailable"]);
    assert.equal(missing.evidence, "fixture", "FLUME_PX_BIN set means fixture evidence");
    f.px.reset();
    f.px.set({ mode: "hang" });
    const started = Date.now();
    const hung = f.json(f.adopt("33god-pm", ["TEST", "FLUME"], ["--apply"], { FLUME_PX_TIMEOUT_MS: "500" }), 1);
    assert.deepEqual(codes(hung), ["provider-unavailable"]);
    assert.match(hung.blockers[0].detail, /did not answer within 500ms/u);
    assert.ok(Date.now() - started < 20000);
    assert.equal(f.px.calls().length, 1, "a hang ends the run: no retry loop and no second board");
    f.px.set({ mode: "nonjson" });
    f.px.reset();
    const garbled = f.json(f.adopt("33god-pm", ["TEST", "FLUME"], ["--apply"]), 1);
    assert.deepEqual(codes(garbled), ["provider-unavailable"]);
    assert.equal(f.px.calls().length, 1);
    assert.equal(readFileSync(f.grolf, "utf8"), bytes);
    assert.equal(f.receipts().length, 0);
    pass("a missing binary, a timeout and non-JSON stdout are provider-unavailable, with no write and no retry");
  }

  // -- Adopt: actor collisions -----------------------------------------------------------------------------------------
  {
    const f = world("adopt-collisions", { adopt: false });
    const bytes = readFileSync(f.grolf, "utf8");
    // Another employee already adopted grolf's native user, under a different instance string.
    f.edit(f.rere, (b) => { b.bindings.plane = { principal: RERE, instance: INSTANCE, credential_ref: REF.rererere, native_actor_id: GROLF }; });
    const duplicate = f.json(f.adopt("33god-pm", ["TEST"], ["--apply"]), 1);
    assert.deepEqual(codes(duplicate), ["native-actor-duplicate"]);
    assert.equal(f.px.calls().length, 0);
    assert.equal(readFileSync(f.grolf, "utf8"), bytes);
    f.edit(f.rere, (b) => { b.bindings.plane = { principal: RERE, instance: INSTANCE, credential_ref: REF.rererere }; });
    // This binding already holds a different native_actor_id.
    f.edit(f.grolf, (b) => { b.bindings.plane.native_actor_id = THIRD; });
    const conflictBytes = readFileSync(f.grolf, "utf8");
    const conflict = f.json(f.adopt("33god-pm", ["TEST"], ["--apply"]), 1);
    assert.deepEqual(codes(conflict), ["native-actor-conflict"]);
    assert.equal(readFileSync(f.grolf, "utf8"), conflictBytes);
    assert.equal(f.px.calls().length, 0);
    pass("a native user adopted by another employee, or a different native_actor_id already on this binding, is refused before any px call");
  }

  // -- verify-plane: happy path ------------------------------------------------------------------------------------------
  {
    const f = world("verify-happy");
    const definitions = [readFileSync(f.grolf, "utf8"), readFileSync(f.rere, "utf8")];
    const preview = f.json(f.run(verifyArgs(["grolf", C1], ["rererere", C2])));
    assert.equal(f.receipts().filter((r) => r.kind === "plane.verify-comments").length, 0, "no receipt without --apply");
    assert.equal(preview.verdict, "native-distinct-verified");
    f.px.reset();
    const result = f.json(f.run([...verifyArgs(["grolf", C1], ["rererere", C2]), "--apply"]));
    assert.equal(result.ok, true);
    assert.equal(result.verdict, "native-distinct-verified");
    assert.deepEqual(result.comments.map((c) => [c.employee, c.authorship, c.actor_id]), [["grolf", "native-verified", GROLF], ["rererere", "native-verified", RERE]]);
    assert.notEqual(result.comments[0].actor_id, result.comments[1].actor_id);
    assert.equal(result.board_id, BOARD.TEST);
    assert.equal(result.evidence, "fixture");
    const calls = f.px.calls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["show", "TEST-14", "--json", "--workspace", "33god", "--base", "https://plane.delo.sh"]);
    const [receipt, ...extra] = f.receipts().filter((r) => r.kind === "plane.verify-comments");
    assert.equal(extra.length, 0);
    assert.equal(receipt.ref, "TEST-14");
    assert.equal(receipt.board_id, BOARD.TEST);
    assert.equal(receipt.evidence, "fixture");
    assert.deepEqual(receipt.comments.map((c) => [c.comment_id, c.actor_id]), [[C1, GROLF], [C2, RERE]]);
    assert.deepEqual([readFileSync(f.grolf, "utf8"), readFileSync(f.rere, "utf8")], definitions, "a receipt changes no definition");
    pass("verify-plane reads the ticket once through px show and records two distinct native-verified authors and one receipt");
  }

  // -- verify-plane: failures ------------------------------------------------------------------------------------------------
  {
    const f = world("verify-failures");
    f.employee("third-pm", "third");
    f.json(f.bind("third-pm", "third")); // bound, never adopted
    const fails = (args, reasonPattern) => {
      const result = f.json(f.run(args), 1);
      assert.equal(result.verdict, "not-native-distinct");
      assert.equal(result.ok, false);
      if (reasonPattern) assert.match(JSON.stringify(result.reasons), reasonPattern);
      return result;
    };
    const notAdopted = fails(verifyArgs(["grolf", C1], ["third", C4]), /not-native-verified:third/u);
    assert.equal(notAdopted.comments.find((c) => c.employee === "third").reason, "native-actor-not-adopted");
    assert.equal(notAdopted.comments.find((c) => c.employee === "grolf").authorship, "native-verified");
    // A comment by rererere that wears grolf's name and marker is not grolf's.
    const spoof = fails(verifyArgs(["grolf", C3], ["rererere", C2]));
    assert.equal(spoof.comments[0].reason, "author-mismatch");
    assert.equal(spoof.comments[0].actor_id, RERE);
    assert.equal(fails(verifyArgs(["grolf", "99999999-9999-4999-8999-999999999999"], ["rererere", C2])).comments[0].reason, "comment-not-found");
    // An actor that is not the binding's own principal is never trusted.
    f.edit(f.rere, (b) => { b.bindings.plane.native_actor_id = GROLF; });
    assert.equal(fails(verifyArgs(["grolf", C1], ["rererere", C2])).comments[1].reason, "native-actor-conflict");
    // Two employees hand-bound to one native user are one actor, whatever the comments say.
    f.edit(f.rere, (b) => { b.bindings.plane = { principal: GROLF, instance: INSTANCE, credential_ref: REF.rererere, native_actor_id: GROLF }; });
    f.px.state.tickets["TEST-14"].comments.push({ id: "5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c", actor_id: GROLF, actor_name: "Rererere", comment_html: "x" });
    f.px.save();
    const shared = fails(verifyArgs(["grolf", C1], ["rererere", "5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c"]), /shared-actor/u);
    assert.deepEqual(shared.comments.map((c) => c.authorship), ["native-verified", "native-verified"]);
    // One employee is not a distinctness proof.
    fails(verifyArgs(["grolf", C1]), /fewer-than-two-employees/u);
    // px unusable or ticket missing: the whole run is refused, not guessed.
    f.px.set({ mode: "hang" });
    const hung = f.json(f.run(verifyArgs(["grolf", C1], ["rererere", C2]), { FLUME_PX_TIMEOUT_MS: "500" }), 1);
    assert.equal(hung.code, "provider-unavailable");
    f.px.set({ mode: "ok" });
    const noTicket = f.json(f.run(["comment", "verify-plane", "TEST-99", "--comment", `grolf:${C1}`, "--json"]), 1);
    assert.equal(noTicket.code, "provider-refused");
    assert.equal(noTicket.provider_code, "not_found");
    f.json(f.run(["comment", "verify-plane", "not a ref", "--comment", `grolf:${C1}`, "--json"]), 1);
    f.json(f.run(["comment", "verify-plane", "TEST-14", "--comment", "grolf:not-a-uuid", "--json"]), 1);
    f.json(f.run(["comment", "verify-plane", "TEST-14", "--comment", `ghost:${C1}`, "--json"]), 1);
    pass("not-adopted, spoofed-author, missing-comment, shared-actor, single-employee and unusable-px runs all exit 1 without trusting text");
  }

  // -- verify-plane: history survives status changes, and no write verb is ever used --------------------------------
  {
    const f = world("verify-history");
    f.json(f.run(["identity", "status", "33god-pm", "retired", "--apply", "--json"]));
    f.json(f.run(["identity", "status", "rere-pm", "suspended", "--apply", "--json"]));
    const result = f.json(f.run(verifyArgs(["grolf", C1], ["rererere", C2])));
    assert.equal(result.verdict, "native-distinct-verified");
    assert.deepEqual(result.comments.map((c) => c.employee_status), ["retired", "suspended"]);
    pass("verify-plane still verifies the historical comments of a retired or suspended employee");
  }

  // -- Show, readiness, facade-free honesty, github unchanged ----------------------------------------------------------------
  {
    const f = world("show", { adopt: false });
    const before = f.json(f.run(["identity", "show", "33god-pm", "--json"]));
    assert.deepEqual(before.credentials.plane, { type: "plane_personal_access_token", static: true, ref: REF.grolf, verified: false, expiry: { observable: false } });
    f.json(f.adopt("33god-pm", ["TEST"], ["--apply"]));
    const shown = f.json(f.run(["identity", "show", "33god-pm", "--json"]));
    assert.equal(shown.identity.bindings.plane.native_actor_id, GROLF);
    assert.equal(shown.identity.bindings.plane.native_actor_id, shown.identity.bindings.plane.principal);
    const { plane } = shown.credentials;
    assert.equal(plane.type, "plane_personal_access_token");
    assert.equal(plane.static, true);
    assert.equal(plane.verified, true);
    assert.equal(plane.expiry.observable, false);
    assert.ok(plane.revocation.native);
    assert.equal(JSON.stringify(shown).includes("expires_at"), false);
    assert.equal(JSON.stringify(shown).includes("lifetime_seconds"), false);
    const readiness = f.json(f.run(["identity", "readiness", "--json"]));
    assert.equal(readiness.checks.plane_native_identity.status, "unproven");
    assert.equal(readiness.checks.plane_native_identity.ready, false);
    assert.equal(readiness.checks.plane_native_identity.cost, null);
    pass("identity show reports a static Plane PAT with unobservable expiry and px's revocation route, and readiness keeps plane_native_identity unproven");

    // GitHub keeps digits only: a UUID actor on a github binding makes the definition unusable at runtime.
    f.edit(f.grolf, (b) => { b.bindings.github = { principal: "1001", instance: "2001", credential_ref: "op://DeLoSecrets/ghghghghghghghghghghghghgh/privatekeyfield", native_actor_id: GROLF }; });
    const refused = f.json(f.run(["identity", "show", "33god-pm", "--json"]), 1);
    assert.match(refused.blockers[0].detail, /github actor ID format/u);
    pass("a UUID native_actor_id on a github binding is refused at runtime");
  }

  // -- Never a write verb, never a secret ----------------------------------------------------------------------------------------
  {
    const f = world("secrets");
    f.json(f.run(verifyArgs(["grolf", C1], ["rererere", C2]), {}));
    f.json(f.run([...verifyArgs(["grolf", C1], ["rererere", C2]), "--apply"]));
    f.px.set({ force: { "*": "wrong_employee" } });
    const refusedRun = f.run(["identity", "adopt-actor", "33god-pm", "plane", "--board", "TEST", "--json"]);
    const outputs = [refusedRun.stdout, refusedRun.stderr];
    for (const call of f.px.calls()) assert.ok((call.argv[0] === "identity" && call.argv[1] === "verify") || call.argv[0] === "show", JSON.stringify(call.argv));
    // The same holds across the whole suite's worlds: no world ever logged a forbidden verb.
    for (const name of readdirSync(work)) {
      const log = join(work, name, "px-log.jsonl");
      if (!existsSync(log)) continue;
      for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
        const { argv } = JSON.parse(line);
        assert.ok((argv[0] === "identity" && argv[1] === "verify") || argv[0] === "show", `${name}: ${argv.join(" ")}`);
        assert.ok(!argv.includes("comment"), `${name}: a comment verb`);
      }
    }
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    for (const file of walk(work)) {
      if (file.endsWith("px-state.json") || file.endsWith("/bin/px")) continue; // the fake holds its tokens by design
      const text = readFileSync(file, "utf8");
      for (const secret of secrets) assert.ok(!text.includes(secret), `${file} holds a planted PAT`);
    }
    for (const text of outputs) for (const secret of secrets) assert.ok(!text.includes(secret));
    pass("only identity verify and show were ever invoked, and no planted PAT is in any output, definition, registry or receipt");
  }

  console.log(`\n${count} company identity plane check groups passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
