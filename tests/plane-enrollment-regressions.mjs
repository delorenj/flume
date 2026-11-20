// FLUME-62/93: `flume identity provision <employee> --only plane` and `flume remediate org.plane-credential`.
//
// Pilot (`px identity enroll`) owns every Plane write, so the world here is a stateful FAKE px (FLUME_PX_BIN) that
// implements `identity enroll` (preview and --apply) and `identity verify`, logs every argv, and holds planted personal
// access tokens it never prints. The suite runs the REAL built dist against a constructed HERMES home (never the live
// ~/.hermes), with a fake gateway control socket that behaves like the real unserve-profile / serve-profile verbs.
// Every planted token value, plus the operator's own key in the environment, is scanned for at the end in everything any
// process printed and every file the suite's tree holds (except the fake px's own state).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createSocket } from "node:net";
import { join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "flume-hr", "dist", "index.js");
if (!existsSync(CLI)) {
  console.error("SKIP plane-enrollment-regressions: dist/ is not built (npm run build)");
  process.exit(0);
}

const work = mkdtempSync("/tmp/flume-plane-enroll-");
const HOME = join(work, "home");
const FLEET = join(HOME, ".hermes");
const REG = join(FLEET, "agents-registry.yaml");
const BIN = join(work, "bin");
const SOCK = join(FLEET, "gateway.sock");
const GSTATE = join(FLEET, "gateway_state.json");
const REPOS = join(work, "repos");
for (const dir of [join(FLEET, "profiles"), join(FLEET, ".profile-config-backups"), BIN, REPOS]) mkdirSync(dir, { recursive: true });

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
};

const INSTANCE = "https://plane.delo.sh/33god";
const OPERATOR_REF = "op://DeLoSecrets/Plane/Main/AutomaticAI API Token";
const OPERATOR_KEY = "plane_api_OPERATOR_planted_value_11ff9b";
const OTHER_USER = "0c5b2a77-4d1e-4f6a-9b8e-2a3f4c5d6e7f";
const OTHER_REF = "op://DeLoSecrets/otherotherotherotherother0/fieldfieldfield000000000000";
const BOARDS = { TEST: "0711da94-284a-4db1-86e8-d7ca37c26d45", WORKF: "7235e207-73a9-421e-8f1f-7f2435387dc0", "33GOD": "15258893-0206-4e8f-aea6-340eb217988c" };

const hex = (text) => createHash("sha1").update(text).digest("hex");
const uuidOf = (text) => { const h = createHash("md5").update(text).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const keyRefOf = (handle) => `op://DeLoSecrets/${hex(`item-${handle}`).slice(0, 26)}/${hex(`field-${handle}`).slice(0, 26)}`;
/** The personal access token the fake vaults for a handle: a planted value, scanned for at the end. */
const patOf = (handle) => `plane_api_${handle.toUpperCase()}_planted_value_${hex(handle).slice(0, 6)}`;

// ---- the fake px ------------------------------------------------------------------------------
const FAKE_PX = `#!/usr/bin/env node
const fs = require("fs");
const crypto = require("crypto");
const args = process.argv.slice(2);
const statePath = process.env.PX_FAKE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(process.env.PX_FAKE_LOG, JSON.stringify({ argv: args }) + "\\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (code, body) => { process.stdout.write(JSON.stringify(body)); process.exit(code); };
const refuse = (code, error) => out(1, { ok: false, error, code });
const flags = (name) => args.flatMap((a, i) => (a === "--" + name ? [args[i + 1]] : []));
const flag = (name) => flags(name)[0];
const sha1 = (t) => crypto.createHash("sha1").update(t).digest("hex");
const uuidOf = (t) => { const h = crypto.createHash("md5").update(t).digest("hex"); return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-8" + h.slice(17, 20) + "-" + h.slice(20, 32); };
if (state.refuse) refuse(state.refuse, "forced " + state.refuse);

if (args[0] === "identity" && args[1] === "enroll") {
  const email = flag("email"), name = flag("display-name"), apply = args.includes("--apply");
  const handle = email.split("@")[0];
  if (!email.endsWith("@agents.delo.sh")) refuse("not_employee_email", email + " is not a company address");
  const admin = flags("admin-board");
  for (const b of admin) if (!state.boards[b]) refuse("unknown_board", "board " + b + " is not a project");
  let user = state.users[email];
  const created = !user;
  if (!user) user = { id: uuidOf(email), email, name };
  const boards = Object.entries(state.boards).map(([identifier, board]) => {
    const wanted = admin.includes(identifier) ? 20 : 15;
    const have = board.members[user.id];
    return { identifier, project_id: board.id, role: wanted, action: have === undefined ? "add" : have === wanted ? "unchanged" : "update" };
  });
  const passed = flag("key-ref");
  const existing = state.keys[passed || ""] && state.keys[passed].user === user.id ? passed : null;
  const keyRef = existing || "op://DeLoSecrets/" + sha1("item-" + handle).slice(0, 26) + "/" + sha1("field-" + handle).slice(0, 26);
  const have = Object.entries(state.keys).find(([, k]) => k.user === user.id);
  const reuse = existing || (have ? have[0] : null);
  const credential = { key_ref: reuse || keyRef, item_id: (reuse || keyRef).split("/")[3], field_id: (reuse || keyRef).split("/")[4], action: reuse ? "unchanged" : "create", type: "plane_personal_access_token", static: true };
  if (apply) {
    if (created) state.users[email] = user;
    for (const b of boards) state.boards[b.identifier].members[user.id] = b.role;
    if (!reuse) state.keys[keyRef] = { user: user.id, pat: state.pats[handle] };
    credential.action = reuse ? "unchanged" : "created";
    save();
  }
  out(0, {
    ok: true, evidence: "fixture", applied: apply, plane: { version: "1.3.1", workspace: "33god" },
    user: { id: user.id, email, display_name: name, created },
    workspace_member: { role: 15, created, reactivated: false },
    boards: boards.map((b) => apply ? Object.assign({}, b, { action: b.action === "unchanged" ? "unchanged" : b.action === "add" ? "added" : "updated" }) : b),
    credential: apply ? credential : Object.assign({}, credential, { key_ref: reuse || undefined }),
    verified: apply ? { users_me: user.id, boards: boards.map((b) => b.identifier) } : null,
    shared_key_fallback: false,
  });
}
if (args[0] === "identity" && args[1] === "verify") {
  const ref = flag("key-ref"), uid = flag("user-id"), board = flag("board"), email = flag("email");
  const key = state.keys[ref];
  if (!key) refuse("credential_unresolvable", "could not resolve " + ref);
  const me = Object.values(state.users).find((u) => u.id === key.user);
  if (me.id !== uid) refuse("wrong_employee", ref + " resolves to native user " + me.id + ", not " + uid);
  if (email && me.email !== email) refuse("wrong_employee", "users/me email is " + me.email);
  const found = state.boards[board];
  if (!found) refuse("unknown_board", "board " + board + " is not a project");
  if (found.members[me.id] === undefined) refuse("not_project_member", me.id + " is not listed on board " + board);
  out(0, {
    ok: true, verified: true, employee: flag("employee"), native_user_id: me.id, email: me.email, display_name: me.name,
    workspace: { slug: flag("workspace"), role: 15 }, board: { id: found.id, identifier: board, name: board, member: true },
    plane: { observable: true, version: "1.3.1", edition: "PLANE_COMMUNITY", latest_version: "v1.4.2", source: "fixture" },
    credential: { ref, type: "plane_personal_access_token", header: "X-API-Key",
      expiry: { observable: false, reason: "Plane exposes a token's expiry only to its owner's browser session", failure_signal: "HTTP 401 on users/me" },
      revocation: { native: "the owner deletes the token", board_access: "an admin removes the project membership", px_verb: null },
      enrollment: { supported: "manual", unsupported: [] } },
    shared_key_fallback: false, checks: [{ check: "users_me_matches_native_user_id", ok: true }], verified_at: "2026-11-19T20:00:00.000Z",
  });
}
out(99, { ok: false, code: "forbidden_verb", error: "only identity enroll and identity verify are allowed here" });
`;
const PXSTATE = join(work, "px-state.json");
const PXLOG = join(work, "px-log.jsonl");
const pxState = () => JSON.parse(readFileSync(PXSTATE, "utf8"));
const setPx = (patch) => writeFileSync(PXSTATE, JSON.stringify({ ...pxState(), ...patch }));
const HANDLES = ["rhea", "ivy", "kai", "lea", "sam", "zed"];
writeFileSync(PXSTATE, JSON.stringify({
  refuse: null, pats: Object.fromEntries(HANDLES.map((h) => [h, patOf(h)])),
  users: {},
  keys: {},
  boards: Object.fromEntries(Object.entries(BOARDS).map(([identifier, id]) => [identifier, { id, members: {} }])),
}));
writeFileSync(PXLOG, "");
writeFileSync(join(BIN, "px"), FAKE_PX, { mode: 0o755 });
writeFileSync(join(BIN, "op"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
writeFileSync(join(BIN, "hermes-gateway-restart"), `#!/bin/sh\necho "$@" >> "${join(work, "gateway-restart.log")}"\nexit 0\n`, { mode: 0o755 });
writeFileSync(join(work, "gateway-restart.log"), "");
const pxCalls = () => readFileSync(PXLOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).argv);
const enrollCalls = () => pxCalls().filter((a) => a[0] === "identity" && a[1] === "enroll");
const applyCalls = () => enrollCalls().filter((a) => a.includes("--apply"));

// ---- the fake gateway -------------------------------------------------------------------------
const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
const verbs = [];
writeFileSync(GSTATE, JSON.stringify({ pid: sleeper.pid, gateway_state: "running", platforms: {} }));
const socketServer = createSocket((connection) => {
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk.toString();
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(buffer.split("\n")[0]);
    verbs.push({ verb: request.verb, name: request.params?.name });
    connection.end(`${JSON.stringify({ ok: true, protocol: 1, result: { [request.verb === "serve-profile" ? "served" : "unserved"]: request.params?.name }, id: request.id })}\n`);
  });
});
await new Promise((ok) => socketServer.listen(SOCK, ok));

// ---- the fleet --------------------------------------------------------------------------------
const row = (id, board) => ({
  repo: id.replace(/-pm$/u, ""), role: "pm", type: "hermes", display_name: `${id} display`, profile_name: id,
  project_path: join(REPOS, id), role_dir: join(REPOS, id, "agents/hermes/pm"),
  plane: { workspace: "33god", project_id: BOARDS[board], identifier: board },
});
const FLEETDESK = [
  ["rhea-pm", "rhea", "TEST"], ["ivy-pm", "ivy", "WORKF"], ["kai-pm", "kai", "TEST"],
  ["lea-pm", "lea", "TEST"], ["sam-pm", "sam", "WORKF"], ["zed-pm", "zed", "WORKF"],
];
const BASE_CONFIG = { model: { default: "fleet-model" }, memory: { provider: "hindsight" }, secrets: { onepassword: { enabled: true, env: { PLANE_API_KEY: OPERATOR_REF, AUTOMATICAI_GATEWAY_KEY: "op://DeLoSecrets/gwkey00000000000000000000/hermes" } } } };
writeFileSync(join(FLEET, "config.yaml"), YAML.stringify(BASE_CONFIG));
const agents = {};
for (const [id, person, board] of FLEETDESK) {
  agents[id] = row(id, board);
  const roleDir = join(REPOS, id, "agents/hermes/pm");
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), `# operator note: keep me\nrepo: ${id}\nrole: pm\nagent_id: ${id}\nprofile: ${id}\nidentity:\n  name: ${person}\n  recall_banks:\n    - agent-${id}\n`);
  const desk = join(FLEET, "profiles", id);
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, "config.delta.yaml"), `# keep me: an operator comment\n${YAML.stringify({
    skills: { project_discovery: true },
    secrets: { onepassword: { enabled: true, env: { AUTOMATICAI_GATEWAY_KEY: `op://DeLoSecrets/gwkey00000000000000000000/${person}` } } },
  })}`, { mode: 0o600 });
  writeFileSync(join(desk, "config.yaml"), `# GENERATED FILE\n${YAML.stringify({ ...BASE_CONFIG, model: { default: "stale" } })}`, { mode: 0o600 });
}
writeFileSync(REG, YAML.stringify({ schema_version: 1, agents }), { mode: 0o600 });
writeFileSync(join(FLEET, "org.yaml"), "version: 1\ncompany: {name: Fixture Co., handle: Fix}\nceo: {id: ceo, display_name: Boss, title: CEO}\n");

// A repository for `flume audit|remediate <repo>` (the org rules read the host, not the repo).
const REPO = join(work, "audit-repo");
mkdirSync(join(REPO, "agents", "hermes", "pm"), { recursive: true });
writeFileSync(join(REPO, "AGENTS.md"), "# fixture\n");

// ---- running the CLI --------------------------------------------------------------------------
const outputs = [];
function flume(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: work,
      env: {
        PATH: `${BIN}:${process.env.PATH}`, HOME, NO_COLOR: "1", TMPDIR: "/tmp",
        HERMES_FLEET_HOME: FLEET, HERMES_AGENTS_REGISTRY: REG, HERMES_FLEET_REGISTRY_FILE: REG,
        HERMES_TEMPLATE_CONFIG: join(work, "no-config"), HERMES_FLEET_ENV: join(work, "no-env"),
        XDG_STATE_HOME: join(HOME, ".local/state"), FLUME_IDENTITY_STATE: join(work, "identity-state"),
        FLUME_PROVISION_CONFIG: join(work, "no-provisioning.yaml"), PYTHONDONTWRITEBYTECODE: "1",
        FLUME_PX_BIN: join(BIN, "px"), PX_FAKE_STATE: PXSTATE, PX_FAKE_LOG: PXLOG, FLUME_PX_TIMEOUT_MS: "10000",
        PLANE_API_KEY: OPERATOR_KEY, ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => { outputs.push(stdout, stderr); done({ status, stdout, stderr }); });
  });
}
const json = async (args, env, status = 0) => {
  const run = await flume([...args, "--json"], env);
  assert.equal(run.status, status, `${args.join(" ")}\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(run.stdout);
};
const provision = (who, extra = [], env) => json(["identity", "provision", who, "--only", "plane", ...extra], env, 0);
const provisionAny = async (who, extra = []) => { const run = await flume(["identity", "provision", who, "--only", "plane", ...extra, "--json"]); return { status: run.status, body: JSON.parse(run.stdout) }; };

const role = (id) => join(REPOS, id, "agents/hermes/pm/role.yaml");
const block = (id) => YAML.parse(readFileSync(role(id), "utf8")).company_identity;
const delta = (id) => YAML.parse(readFileSync(join(FLEET, "profiles", id, "config.delta.yaml"), "utf8"));
const deltaText = (id) => readFileSync(join(FLEET, "profiles", id, "config.delta.yaml"), "utf8");
const generated = (id) => YAML.parse(readFileSync(join(FLEET, "profiles", id, "config.yaml"), "utf8"));
const planeKey = (config) => config?.secrets?.onepassword?.env?.PLANE_API_KEY;
const verbsFor = (name) => verbs.filter((v) => v.name === name).map((v) => v.verb);

function tree(path) {
  let info;
  try { info = lstatSync(path); } catch { return null; }
  if (info.isSymbolicLink()) return { link: readlinkSync(path) };
  if (info.isDirectory()) return Object.fromEntries(readdirSync(path).sort().filter((n) => !n.endsWith(".lock") && n !== "gateway.sock" && n !== ".profile-config-backups").map((n) => [n, tree(join(path, n))]));
  return readFileSync(path).toString("base64");
}
const world = () => ({ fleet: tree(FLEET), repos: tree(REPOS) });

// Enroll everyone the identity census should know (a company identity: subject, handle, email).
for (const [id] of FLEETDESK) {
  if (id === "zed-pm") continue; // zed stays unenrolled: shared-key, not a failure
  const run = await flume(["identity", "enroll", id, "--apply", "--json"]);
  assert.equal(run.status, 0, `enroll ${id}\n${run.stdout}${run.stderr}`);
}

// ---- the cases --------------------------------------------------------------------------------

await check("preview writes nothing: one px preview, no --apply, no desk or binding change", async () => {
  const before = world();
  const px = pxState();
  const body = await provision("rhea-pm");
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.changed, true);
  assert.equal(body.apply, false);
  assert.equal(body.capabilities.plane.action, "create", JSON.stringify(body.capabilities.plane));
  assert.equal(body.capabilities["plane-desk"].action, "create");
  assert.match(body.capabilities.plane.detail, /create native user rhea@agents\.delo\.sh/u);
  assert.equal(body.capabilities.plane.refs.verification_basis, "own-board");
  assert.equal(body.capabilities.plane.refs.verification_boards, "TEST");
  assert.deepEqual(world(), before, "a preview must not touch the fleet or any role.yaml");
  assert.deepEqual(pxState(), px, "a preview must not create a Plane user, membership or key");
  assert.equal(enrollCalls().length, 1);
  assert.equal(applyCalls().length, 0);
  const enroll = enrollCalls()[0];
  assert.deepEqual(enroll.slice(enroll.indexOf("--admin-board"), enroll.indexOf("--admin-board") + 2), ["--admin-board", "TEST"]);
  assert.ok(enroll.includes("--all-boards") && enroll.includes("--json") && !enroll.includes("--key-ref"), enroll.join(" "));
  assert.equal(verbs.length, 0);
});

await check("create: user + memberships + key, bound, adopted, desk runs its own key, only that profile cycled", async () => {
  const before = delta("rhea-pm");
  const baseBefore = readFileSync(join(FLEET, "config.yaml"), "utf8");
  const body = await provision("rhea-pm", ["--apply"]);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.changed, true);
  const user = uuidOf("rhea@agents.delo.sh");
  const ref = keyRefOf("rhea");
  assert.equal(body.capabilities.plane.action, "created", JSON.stringify(body.capabilities.plane));
  assert.equal(body.capabilities.plane.refs.user_id, user);
  assert.equal(body.capabilities.plane.refs.credential_ref, ref);
  assert.equal(body.capabilities["plane-desk"].action, "created", JSON.stringify(body.capabilities["plane-desk"]));
  assert.equal(body.capabilities["plane-desk"].refs.gateway, "profile-cycle");
  // The binding: native, by reference, adopted.
  const plane = block("rhea-pm").bindings.plane;
  assert.deepEqual({ ...plane }, { principal: user, instance: INSTANCE, credential_ref: ref, attribution_mode: "native", native_actor_id: user });
  // Pilot enrolled it on every board, admin on its own.
  const calls = applyCalls();
  assert.equal(calls.length, 1);
  assert.ok(pxState().boards.TEST.members[user] === 20 && pxState().boards.WORKF.members[user] === 15, JSON.stringify(pxState().boards));
  // Adoption was verified by Pilot on the employee's OWN board.
  assert.ok(pxCalls().some((a) => a[0] === "identity" && a[1] === "verify" && a[a.indexOf("--board") + 1] === "TEST"), "verify on TEST");
  // The desk: only PLANE_API_KEY changed; comment and every other key survived; the fleet base is untouched.
  assert.equal(planeKey(delta("rhea-pm")), ref);
  const without = structuredClone(delta("rhea-pm"));
  delete without.secrets.onepassword.env.PLANE_API_KEY;
  assert.deepEqual(without, before, "projection writes only PLANE_API_KEY");
  assert.match(deltaText("rhea-pm"), /^# keep me: an operator comment$/mu);
  assert.equal(planeKey(generated("rhea-pm")), ref, "the generated config.yaml was re-rendered");
  assert.equal(generated("rhea-pm").model.default, "fleet-model", "rendered through the canonical merge with the base");
  assert.equal(readFileSync(join(FLEET, "config.yaml"), "utf8"), baseBefore, "the fleet base keeps the operator key for everyone else");
  assert.deepEqual(verbsFor("rhea-pm"), ["unserve-profile", "serve-profile"]);
  assert.equal(verbs.every((v) => v.name === "rhea-pm"), true, "no other profile was cycled");
  assert.equal(readFileSync(join(work, "gateway-restart.log"), "utf8"), "", "the gateway was never restarted");
  // An unrelated employee's desk is untouched.
  assert.equal(planeKey(delta("ivy-pm")), undefined);
});

await check("a rerun is a pure no-op: one px preview, no writes, no gateway traffic", async () => {
  const before = world();
  const verbsBefore = verbs.length;
  const applies = applyCalls().length;
  const body = await provision("rhea-pm", ["--apply"]);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.changed, false, JSON.stringify(body));
  assert.equal(body.capabilities.plane.action, "no-op", JSON.stringify(body.capabilities.plane));
  assert.equal(body.capabilities["plane-desk"].action, "no-op");
  assert.deepEqual(world(), before);
  assert.equal(applyCalls().length, applies, "no --apply call on a converged employee");
  assert.equal(verbs.length, verbsBefore);
  const preview = await provision("rhea-pm");
  assert.equal(preview.changed, false);
  assert.equal(preview.capabilities.plane.action, "no-op");
});

await check("--no-reload writes and renders the desk but never touches the gateway", async () => {
  const verbsBefore = verbs.length;
  const body = await provision("ivy-pm", ["--apply", "--no-reload"]);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.capabilities["plane-desk"].action, "created");
  assert.equal(body.capabilities["plane-desk"].refs.gateway, "skipped");
  assert.equal(planeKey(delta("ivy-pm")), keyRefOf("ivy"));
  assert.equal(planeKey(generated("ivy-pm")), keyRefOf("ivy"));
  assert.equal(verbs.length, verbsBefore, "no socket traffic with --no-reload");
  // WORKF is its own board here: admin on WORKF, member on the rest.
  assert.equal(pxState().boards.WORKF.members[uuidOf("ivy@agents.delo.sh")], 20);
});

await check("binding-conflict: a binding to a different principal is refused and nothing is written", async () => {
  // kai is bound to somebody else's Plane user (the fake does not need that user to exist).
  const bound = await flume(["identity", "bind", "kai-pm", "plane", "--principal", OTHER_USER, "--instance", INSTANCE, "--credential-ref", OTHER_REF, "--apply", "--json"]);
  assert.equal(bound.status, 0, bound.stdout + bound.stderr);
  const before = world();
  const px = pxState();
  const applies = applyCalls().length;
  for (const extra of [[], ["--apply"]]) {
    const { status, body } = await provisionAny("kai-pm", extra);
    assert.notEqual(status, 0);
    assert.equal(body.ok, false);
    assert.equal(body.capabilities.plane.action, "conflict", JSON.stringify(body.capabilities.plane));
    assert.match(body.capabilities.plane.detail, /binding-conflict/u);
    assert.match(body.capabilities.plane.detail, new RegExp(OTHER_USER, "u"));
  }
  assert.deepEqual(world(), before, "a conflict writes nothing");
  assert.deepEqual(pxState(), px, "and never reaches the Plane write");
  assert.equal(applyCalls().length, applies);
  assert.equal(block("kai-pm").bindings.plane.principal, OTHER_USER, "the binding is untouched");
});

await check("px refusals are reported with px's own code and write nothing", async () => {
  setPx({ refuse: "operator_identity" });
  const before = world();
  const { status, body } = await provisionAny("lea-pm", ["--apply"]);
  assert.notEqual(status, 0);
  assert.equal(body.capabilities.plane.action, "blocked");
  assert.match(body.capabilities.plane.detail, /provider-refused \[px operator_identity\]/u);
  assert.deepEqual(world(), before);
  setPx({ refuse: null });
  const unavailable = await flume(["identity", "provision", "lea-pm", "--only", "plane", "--json"], { FLUME_PX_BIN: join(work, "no-such-px") });
  assert.notEqual(unavailable.status, 0);
  assert.match(JSON.parse(unavailable.stdout).capabilities.plane.detail, /provider-unavailable/u);
});

await check("audit reports an adopted identity whose desk runs the shared key; remediate fixes only that, and the audit passes", async () => {
  // lea: enrolled at Plane by hand, bound and adopted, desk never projected.
  const px = pxState();
  const user = uuidOf("lea@agents.delo.sh");
  const ref = keyRefOf("lea");
  px.users["lea@agents.delo.sh"] = { id: user, email: "lea@agents.delo.sh", name: "Lea" };
  px.keys[ref] = { user, pat: patOf("lea") };
  px.boards.TEST.members[user] = 20;
  writeFileSync(PXSTATE, JSON.stringify(px));
  assert.equal((await flume(["identity", "bind", "lea-pm", "plane", "--principal", user, "--instance", INSTANCE, "--credential-ref", ref, "--apply", "--json"])).status, 0);
  assert.equal((await flume(["identity", "adopt-actor", "lea-pm", "plane", "--board", "TEST", "--apply", "--json"])).status, 0);

  const run = await flume(["audit", REPO, "--rules", "org.plane-credential", "--json"]);
  const finding = JSON.parse(run.stdout).rules.find((r) => r.id === "org.plane-credential");
  assert.equal(finding.status, "fail", run.stdout);
  assert.equal(finding.fixable, true);
  assert.match(finding.details.join("\n"), /lea-pm \(lea-pm\): runs the fleet base \(shared\/operator\) key/u);
  assert.match(finding.details.join("\n"), /own-key: ivy-pm, rhea-pm|own-key: rhea-pm, ivy-pm|own-key:/u);
  assert.match(finding.details.join("\n"), /shared-key .*zed-pm/u, "an unenrolled employee is reported shared-key, not failed");
  assert.ok(!/zed-pm \(/u.test(finding.details.filter((d) => /fix:/u.test(d)).join("\n")), "zed is not a fix target");

  const rheaBefore = tree(join(FLEET, "profiles", "rhea-pm"));
  const dry = await flume(["remediate", "org.plane-credential", REPO, "--dry-run", "--json"]);
  const dryRule = JSON.parse(dry.stdout).results.find((r) => r.id === "org.plane-credential");
  assert.equal(dryRule.status, "skipped", dry.stdout);
  assert.equal(planeKey(delta("lea-pm")), undefined, "--dry-run writes nothing");

  const verbsBefore = verbs.length;
  const fixed = await flume(["remediate", "org.plane-credential", REPO, "--json"]);
  const rule = JSON.parse(fixed.stdout).results.find((r) => r.id === "org.plane-credential");
  assert.equal(rule.status, "applied", fixed.stdout);
  assert.equal(planeKey(delta("lea-pm")), ref);
  assert.equal(planeKey(generated("lea-pm")), ref);
  assert.deepEqual(verbs.slice(verbsBefore).map((v) => `${v.verb}:${v.name}`), ["unserve-profile:lea-pm", "serve-profile:lea-pm"], "only lea's profile was cycled");
  assert.deepEqual(tree(join(FLEET, "profiles", "rhea-pm")), rheaBefore, "an already-converged desk is untouched");
  assert.equal(planeKey(delta("zed-pm")), undefined);

  const again = JSON.parse((await flume(["audit", REPO, "--rules", "org.plane-credential", "--json"])).stdout).rules.find((r) => r.id === "org.plane-credential");
  assert.equal(again.status, "pass", JSON.stringify(again));
  const noop = JSON.parse((await flume(["remediate", "org.plane-credential", REPO, "--json"])).stdout).results.find((r) => r.id === "org.plane-credential");
  assert.equal(noop.status, "noop");
});

await check("a suspended employee is never projected and is reported; provisioning them is refused with zero px calls", async () => {
  const px = pxState();
  const user = uuidOf("sam@agents.delo.sh");
  const ref = keyRefOf("sam");
  px.users["sam@agents.delo.sh"] = { id: user, email: "sam@agents.delo.sh", name: "Sam" };
  px.keys[ref] = { user, pat: patOf("sam") };
  px.boards.WORKF.members[user] = 20;
  writeFileSync(PXSTATE, JSON.stringify(px));
  assert.equal((await flume(["identity", "bind", "sam-pm", "plane", "--principal", user, "--instance", INSTANCE, "--credential-ref", ref, "--apply", "--json"])).status, 0);
  assert.equal((await flume(["identity", "adopt-actor", "sam-pm", "plane", "--board", "WORKF", "--apply", "--json"])).status, 0);
  assert.equal((await flume(["identity", "status", "sam-pm", "suspended", "--apply", "--json"])).status, 0);
  const before = tree(join(FLEET, "profiles", "sam-pm"));
  const verbsBefore = verbs.length;
  const fixed = JSON.parse((await flume(["remediate", "org.plane-credential", REPO, "--json"])).stdout).results.find((r) => r.id === "org.plane-credential");
  assert.notEqual(fixed.status, "applied", JSON.stringify(fixed));
  assert.deepEqual(tree(join(FLEET, "profiles", "sam-pm")), before, "the suspended desk is untouched");
  assert.equal(planeKey(delta("sam-pm")), undefined);
  assert.equal(verbs.length, verbsBefore);
  const calls = pxCalls().length;
  const { status, body } = await provisionAny("sam-pm", ["--apply"]);
  assert.notEqual(status, 0);
  assert.equal(body.blockers[0].code, "employee-suspended");
  assert.equal(pxCalls().length, calls, "no px call for a suspended employee");
});

await check("an unenrolled employee is shared-key, not an error, and provisioning refuses them", async () => {
  const { status, body } = await provisionAny("zed-pm");
  assert.notEqual(status, 0);
  assert.equal(body.blockers[0].code, "not-enrolled");
  const found = JSON.parse((await flume(["audit", REPO, "--rules", "org.plane-credential", "--json"])).stdout).rules.find((r) => r.id === "org.plane-credential");
  assert.notEqual(found.status, "fail", "an unenrolled employee alone never fails the rule (sam is the suspended one)");
});

await check("without a plane: block and without --only plane the capability is deferred, not run", async () => {
  const calls = pxCalls().length;
  const config = join(work, "provisioning.yaml");
  writeFileSync(config, YAML.stringify({ version: 1, cloudflare: { api_token_ref: "op://DeLoSecrets/cf/token", account_id: "a".repeat(32), zone_id: "b".repeat(32), access_issuer: "https://x.cloudflareaccess.com" }, mailbox: { worker: "w", kv_namespace_id: "0".repeat(32) }, onepassword: { vault: "DeLoSecrets" } }));
  // `--only access` would need Cloudflare; the point here is the plane group alone with a config that has no plane block.
  const run = await flume(["identity", "provision", "rhea-pm", "--only", "plane", "--json"], { FLUME_PROVISION_CONFIG: config });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(pxCalls().length > calls, "an explicit --only plane runs regardless of the config");
  const bad = await flume(["identity", "provision", "rhea-pm", "--only", "nonsense", "--json"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--only takes access or plane/u);
});

await check("no planted token value appears in any output or any file", async () => {
  const secrets = [OPERATOR_KEY, ...HANDLES.map(patOf)];
  const hits = [];
  for (const text of outputs) for (const secret of secrets) if (text.includes(secret)) hits.push(`output contains ${secret}`);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path === PXSTATE) continue; // the fake Plane's own database holds the tokens it vaulted
      const info = lstatSync(path);
      if (info.isSymbolicLink() || name === "gateway.sock") continue;
      if (info.isDirectory()) { walk(path); continue; }
      const text = readFileSync(path, "utf8");
      for (const secret of secrets) if (text.includes(secret)) hits.push(`${path} contains ${secret}`);
    }
  };
  walk(work);
  assert.deepEqual(hits, []);
});

socketServer.close();
sleeper.kill();
if (!failures) rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall plane-enrollment cases passed");
process.exit(failures ? 1 : 0);
