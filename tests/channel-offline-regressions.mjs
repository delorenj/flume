// `flume channel`: park a chat bot on purpose, bring it back, rotate it.
//
// Operator requirement, verbatim: "can we just have a way to mark them 'offline'. There will always be
// rotation of tokens since telegram limits how many i can have active at once."
//
// Everything here runs the REAL built dist in a subprocess against a constructed HERMES home (never the
// live ~/.hermes). Three doubles stand in for the world: a Telegram/Slack HTTP server (getMe, auth.test),
// an `op` that answers from a map file, and a gateway control socket that behaves the way the real
// gateway's `unserve-profile` / `serve-profile` verbs do (it rewrites gateway_state.json). Tokens are
// planted strings; the suite scans every output and every file the CLI wrote for them at the end.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createSocket } from "node:net";
import { join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "flume-hr", "dist", "index.js");
if (!existsSync(CLI)) {
  console.error("SKIP channel-offline-regressions: dist/ is not built (npm run build)");
  process.exit(0);
}

const work = mkdtempSync("/tmp/flume-channel-");
const HOME = join(work, "home");
const FLEET = join(HOME, ".hermes");
const REG = join(FLEET, "agents-registry.yaml");
const BIN = join(work, "bin");
const SOCK = join(FLEET, "gateway.sock");
const STATE = join(FLEET, "gateway_state.json");
for (const dir of [join(FLEET, "profiles"), join(FLEET, ".profile-config-backups"), BIN]) mkdirSync(dir, { recursive: true });

let failures = 0;
let count = 0;
const check = async (name, fn) => {
  count += 1;
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
};

// ---- planted credentials: every one is scanned for at the end -------------------------------
const TOKEN = {
  ada: "111:AAplanted-ada-token-value-1",
  bob: "222:AAplanted-bob-token-value-2",
  cy: "444:AAplanted-cy-dead-token-value-4",
  rotated: "333:AAplanted-rotated-token-value-3",
  dup: "222:AAplanted-bob-again-token-value-5",
  revoked: "999:AAplanted-revoked-token-value-9",
  slack: "xoxb-planted-slack-bot-token-value",
  appslack: "xapp-planted-slack-app-token-value",
};
const BOT = {
  [TOKEN.ada]: { id: 111, username: "ada_pm_bot" },
  [TOKEN.bob]: { id: 222, username: "bob_pm_bot" },
  [TOKEN.rotated]: { id: 333, username: "cy_rotated_bot" },
  [TOKEN.dup]: { id: 222, username: "bob_pm_bot" },
};
const item = (name) => `${name}${"0".repeat(26)}`.slice(0, 26);
const REF = {
  ada: `op://DeLoSecrets/${item("adabot")}/credential`,
  bob: `op://DeLoSecrets/${item("bobbot")}/credential`,
  cy: `op://DeLoSecrets/${item("cybot")}/credential`,
  rotated: `op://DeLoSecrets/${item("cyrotated")}/credential`,
  dup: `op://DeLoSecrets/${item("dupbot")}/credential`,
  revoked: `op://DeLoSecrets/${item("revokedbot")}/credential`,
  slack: `op://DeLoSecrets/${item("adaslack")}/bot`,
  appslack: `op://DeLoSecrets/${item("adaslack")}/app`,
};
const OPMAP = join(work, "op-map.json");
writeFileSync(OPMAP, JSON.stringify({
  [REF.ada]: TOKEN.ada, [REF.bob]: TOKEN.bob, [REF.cy]: TOKEN.cy, [REF.rotated]: TOKEN.rotated,
  [REF.dup]: TOKEN.dup, [REF.revoked]: TOKEN.revoked, [REF.slack]: TOKEN.slack, [REF.appslack]: TOKEN.appslack,
}));

// ---- the fake `op` and `systemctl` ------------------------------------------------------------
writeFileSync(join(BIN, "op"), `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require("node:fs");
const args = process.argv.slice(2).filter((a) => a !== "--no-newline");
if (args[0] !== "read") process.exit(2);
appendFileSync(process.env.OP_LOG, args[1] + "\\n");
const value = JSON.parse(readFileSync(process.env.OP_MAP, "utf8"))[args[1]];
if (value === undefined) { process.stderr.write("[ERROR] not found\\n"); process.exit(1); }
process.stdout.write(value);
`);
writeFileSync(join(BIN, "systemctl"), `#!/bin/sh\necho "$@" >> "$SYSTEMCTL_LOG"\nexit 0\n`);
chmodSync(join(BIN, "op"), 0o755);
chmodSync(join(BIN, "systemctl"), 0o755);
const OPLOG = join(work, "op.log");
const SYSLOG = join(work, "systemctl.log");
writeFileSync(OPLOG, "");
writeFileSync(SYSLOG, "");

// ---- the fake Telegram / Slack ----------------------------------------------------------------
const apiCalls = [];
const http = createHttp((request, response) => {
  apiCalls.push(request.url.replace(/\/bot[^/]+\//u, "/bot<redacted>/"));
  const match = /^\/bot([^/]+)\/getMe$/u.exec(request.url);
  response.setHeader("content-type", "application/json");
  if (match) {
    const bot = BOT[decodeURIComponent(match[1])];
    if (!bot) { response.statusCode = 401; response.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" })); return; }
    response.end(JSON.stringify({ ok: true, result: { id: bot.id, is_bot: true, username: bot.username } }));
    return;
  }
  if (request.url === "/slack/auth.test") {
    const good = request.headers.authorization === `Bearer ${TOKEN.slack}`;
    response.end(JSON.stringify(good ? { ok: true, team_id: "T1", team: "Fixture", user_id: "U1", user: "ada_slack", bot_id: "B1" } : { ok: false, error: "invalid_auth" }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
await new Promise((ok) => http.listen(0, "127.0.0.1", ok));
const API = `http://127.0.0.1:${http.address().port}`;

// ---- the fake gateway: a pid that is alive, and the real control verbs' effect on the state file --
const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
const verbs = [];
const readState = () => JSON.parse(readFileSync(STATE, "utf8"));
const writeState = (state) => writeFileSync(STATE, JSON.stringify(state, null, 2));
const entry = (state, extra = {}) => ({ state, error_code: extra.error_code ?? null, updated_at: new Date().toISOString(), ...extra });
let socketServer;
function startSocket(options = {}) {
  socketServer = createSocket((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]);
      verbs.push({ verb: request.verb, name: request.params?.name });
      const name = request.params?.name;
      const state = readState();
      let result = {};
      if (request.verb === "unserve-profile") {
        for (const key of Object.keys(state.platforms)) if (key.startsWith(`${name}:`)) delete state.platforms[key];
        writeState(state);
        result = { unserved: name };
      } else if (request.verb === "serve-profile") {
        if (options.failServe) result = { error: `profile '${name}' is parked (gateway.parked)` };
        else {
          // Like _start_one_profile_adapters: only an ENABLED platform with a credential is started.
          const delta = YAML.parse(readFileSync(join(FLEET, "profiles", name, "config.delta.yaml"), "utf8")) ?? {};
          const base = YAML.parse(readFileSync(join(FLEET, "config.yaml"), "utf8")) ?? {};
          const enabled = delta.platforms?.telegram?.enabled ?? base.platforms?.telegram?.enabled;
          const ref = delta.secrets?.onepassword?.env?.TELEGRAM_BOT_TOKEN;
          if (enabled && ref) state.platforms[`${name}:telegram`] = entry("connected");
          writeState(state);
          result = { served: name };
        }
      }
      connection.end(`${JSON.stringify({ ok: true, protocol: 1, result, id: request.id })}\n`);
    });
  });
  return new Promise((ok) => socketServer.listen(SOCK, ok));
}

// ---- the fleet --------------------------------------------------------------------------------
function seedFleet() {
  writeFileSync(join(FLEET, "config.yaml"), YAML.stringify({ model: { default: "fleet-model" }, platforms: { telegram: { enabled: true } } }));
  const agents = {};
  const rows = {
    "ada-pm": { display_name: "Ada \u2014 the PM", hindsight: { write_bank: "agent-ada", recall_banks: ["agent-ada", "workspace-ada"] }, telegram: { provisioning_status: "verified", bot_username: "ada_pm_bot", bot_id: "111" }, slack: { provisioning_status: "verified", team_id: "T1", team_name: "Fixture", bot_user_id: "U1", bot_id: "B1", bot_username: "ada_slack" } },
    "bob-pm": { telegram: { provisioning_status: "verified", bot_username: "bob_pm_bot", bot_id: "222" } },
    // Like keepy-money-pm and nautilus-trader-pm: a bot name, no status, a token Telegram has revoked.
    "cy-pm": { telegram: { bot_username: "cy_old_bot" } },
  };
  for (const [id, extra] of Object.entries(rows)) {
    agents[id] = { repo: id.replace(/-pm$/u, ""), role: "pm", type: "hermes", display_name: `${id} display`, profile_name: id, project_path: `/tmp/none/${id}`, ...extra };
  }
  writeFileSync(REG, YAML.stringify({ schema_version: 1, agents }), { mode: 0o600 });
  const refs = { "ada-pm": { TELEGRAM_BOT_TOKEN: REF.ada, SLACK_BOT_TOKEN: REF.slack, SLACK_APP_TOKEN: REF.appslack }, "bob-pm": { TELEGRAM_BOT_TOKEN: REF.bob }, "cy-pm": { TELEGRAM_BOT_TOKEN: REF.cy } };
  for (const id of Object.keys(rows)) {
    const dir = join(FLEET, "profiles", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.delta.yaml"), `# keep me: an operator comment\n${YAML.stringify({
      skills: { project_discovery: true },
      secrets: { onepassword: { enabled: true, env: { AUTOMATICAI_GATEWAY_KEY: "op://DeLoSecrets/gwkey00000000000000000000/hermes", ...refs[id] } } },
      ...(id === "ada-pm" ? { platforms: { slack: { enabled: true } } } : {}),
    })}`, { mode: 0o600 });
    writeFileSync(join(dir, "config.yaml"), "# GENERATED FILE\nmodel:\n  default: stale\n", { mode: 0o600 });
  }
  writeState({
    pid: sleeper.pid, gateway_state: "running",
    platforms: {
      "ada-pm:telegram": entry("connected"), "bob-pm:telegram": entry("connected"),
      "cy-pm:telegram": entry("fatal", { error_code: "telegram_auth_error", error_message: "rejected" }),
    },
  });
  writeFileSync(join(FLEET, "org.yaml"), "version: 1\ncompany: {name: Fixture Co., handle: Fix}\nceo: {id: ceo, display_name: Boss, title: CEO}\n");
  writeFileSync(join(work, "projects.yaml"), "schema_version: 1\nprojects: {}\n");
}
seedFleet();
await startSocket();

// ---- running the CLI --------------------------------------------------------------------------
const outputs = [];
function flume(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: `${BIN}:${process.env.PATH}`, HOME, NO_COLOR: "1", TMPDIR: "/tmp",
        HERMES_FLEET_HOME: FLEET, HERMES_AGENTS_REGISTRY: REG, FLUME_TELEGRAM_API_BASE: API, FLUME_SLACK_API_BASE: `${API}/slack`,
        FLUME_CHANNEL_CONFIRM_MS: "4000", OP_MAP: OPMAP, OP_LOG: OPLOG, SYSTEMCTL_LOG: SYSLOG, ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => { outputs.push(stdout, stderr); done({ status, stdout, stderr }); });
  });
}
const json = async (args, env) => {
  const run = await flume([...args, "--json"], env);
  return { ...run, body: JSON.parse(run.stdout) };
};

const registry = () => YAML.parse(readFileSync(REG, "utf8"));
const delta = (id) => YAML.parse(readFileSync(join(FLEET, "profiles", id, "config.delta.yaml"), "utf8"));
const generated = (id) => YAML.parse(readFileSync(join(FLEET, "profiles", id, "config.yaml"), "utf8"));
const tell = () => {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "gateway.sock" || name === ".profile-config-backups" || name.endsWith(".lock")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else hash.update(path).update(readFileSync(path));
    }
  };
  walk(FLEET);
  return hash.digest("hex");
};

// ---- the cases --------------------------------------------------------------------------------

await check("list shows every wired channel with live state, and counts the active Telegram bots", async () => {
  const { body, status } = await json(["channel", "list"]);
  assert.equal(status, 0);
  const row = (id, platform = "telegram") => body.rows.find((r) => r.employee === id && r.platform === platform);
  assert.equal(row("ada-pm").standing, "online");
  assert.deepEqual(row("ada-pm").refs, ["TELEGRAM_BOT_TOKEN"], "reference NAMES only");
  assert.equal(row("cy-pm").standing, "broken");
  assert.equal(row("cy-pm").gateway.error_code, "telegram_auth_error");
  assert.ok(row("cy-pm").notes.some((n) => n.includes("flume channel offline cy-pm")), "a dead bot says how to park it");
  assert.equal(body.active_telegram_bots, 2, "ada and bob are connected; cy is fatal and does not count");
  const text = (await flume(["channel", "list"])).stdout;
  assert.match(text, /Telegram bots active right now: 2/u);
});

await check("offline previews by default and writes nothing", async () => {
  const before = tell();
  const { body, status } = await json(["channel", "offline", "cy-pm", "--reason", "Telegram rejected token"]);
  assert.equal(status, 0);
  assert.equal(body.apply, false);
  assert.equal(body.changed, true);
  assert.deepEqual(body.writes, []);
  assert.equal(tell(), before);
  assert.equal(verbs.length, 0, "a preview never touches the gateway");
});

await check("offline --apply parks the channel: reference kept, delta pinned off, registry records when and why, one profile cycled", async () => {
  const others = { ada: registry().agents["ada-pm"], bob: registry().agents["bob-pm"] };
  const adaGenerated = readFileSync(join(FLEET, "profiles", "ada-pm", "config.yaml"), "utf8");
  const registryBefore = readFileSync(REG, "utf8");
  const { body, status } = await json(["channel", "offline", "cy-pm", "--reason", "Telegram rejected token (telegram_auth_error); parked for rotation", "--apply"]);
  assert.equal(status, 0, JSON.stringify(body));
  assert.equal(body.changed, true);
  const row = registry().agents["cy-pm"].telegram;
  assert.equal(row.provisioning_status, "offline");
  assert.match(row.offline_since, /^\d{4}-\d\d-\d\dT/u);
  assert.equal(row.offline_reason, "Telegram rejected token (telegram_auth_error); parked for rotation");
  assert.equal(row.bot_username, "cy_old_bot", "the identity the row already had is kept");
  const d = delta("cy-pm");
  assert.equal(d.secrets.onepassword.env.TELEGRAM_BOT_TOKEN, REF.cy, "the credential REFERENCE stays so bringing it back is one command");
  assert.equal(d.platforms.telegram.enabled, false);
  assert.equal(generated("cy-pm").platforms.telegram.enabled, false, "the ONE profile was re-rendered through the canonical renderer");
  assert.match(readFileSync(join(FLEET, "profiles", "cy-pm", "config.delta.yaml"), "utf8"), /^# keep me: an operator comment/u);
  // Byte level, not parsed level: a whole-file dump would re-indent ada's lists and escape her em dash.
  const rowOf = (text, id) => text.match(new RegExp(`^  ${id}:\\n(?:   .*\\n)*`, "mu"))?.[0];
  for (const id of ["ada-pm", "bob-pm"]) assert.equal(rowOf(readFileSync(REG, "utf8"), id), rowOf(registryBefore, id), `${id}'s registry row is byte-identical`);
  assert.ok(rowOf(registryBefore, "ada-pm").includes("recall_banks"), "the control row really has a nested list");
  assert.ok(readFileSync(REG, "utf8").includes("Ada \u2014 the PM"), "non-ASCII text is not re-escaped");
  assert.deepEqual(registry().agents["ada-pm"], others.ada, "no other row moved");
  assert.deepEqual(registry().agents["bob-pm"], others.bob);
  assert.equal(readFileSync(join(FLEET, "profiles", "ada-pm", "config.yaml"), "utf8"), adaGenerated, "no other profile was rendered");
  assert.deepEqual(verbs, [{ verb: "unserve-profile", name: "cy-pm" }, { verb: "serve-profile", name: "cy-pm" }]);
  assert.equal(body.gateway.action, "profile-cycle");
  assert.equal(body.gateway.confirmed, true, JSON.stringify(body.gateway));
  assert.equal(readState().platforms["cy-pm:telegram"], undefined, "no live adapter, no fatal entry");
  assert.equal(readState().platforms["ada-pm:telegram"].state, "connected", "other profiles untouched");
  assert.equal(readFileSync(SYSLOG, "utf8"), "", "no full gateway reload was needed");
});

await check("list marks the parked channel with its reason, and the active count is unchanged", async () => {
  const { body } = await json(["channel", "list"]);
  const cy = body.rows.find((r) => r.employee === "cy-pm" && r.platform === "telegram");
  assert.equal(cy.standing, "offline");
  assert.match(cy.offline_reason, /parked for rotation/u);
  assert.deepEqual(cy.refs, ["TELEGRAM_BOT_TOKEN"]);
  assert.deepEqual(cy.notes, []);
  assert.equal(body.active_telegram_bots, 2);
  assert.match((await flume(["channel", "list"])).stdout, /parked since .*Telegram rejected token/u);
});

await check("offline is idempotent", async () => {
  const before = tell();
  const { body } = await json(["channel", "offline", "cy-pm", "--apply"]);
  assert.equal(body.ok, true);
  assert.equal(body.changed, false);
  assert.equal(tell(), before);
});

await check("flume org and flume roster mark the parked channel, and it is not a defect", async () => {
  const org = await flume(["org", "--agent-registry", REG, "--org", join(FLEET, "org.yaml")]);
  assert.match(org.stdout, /cy-pm.*\[telegram offline\]/u);
  assert.doesNotMatch(org.stdout.split("\n").find((l) => l.includes("ada-pm")) ?? "", /offline/u);
  const chart = JSON.parse((await flume(["org", "--json", "--agent-registry", REG, "--org", join(FLEET, "org.yaml")])).stdout);
  assert.equal(chart.ok, true, JSON.stringify(chart).slice(0, 300));
  assert.deepEqual(chart.data.nodes.find((n) => n.id === "cy-pm").channels_offline, ["telegram"]);
  assert.deepEqual(chart.data.nodes.find((n) => n.id === "ada-pm").channels_offline, []);
  const roster = await flume(["roster", "--agent-registry", REG, "--project-registry", join(work, "projects.yaml")]);
  assert.match(roster.stdout, /cy-pm.*\[telegram offline\]/u, roster.stdout.slice(0, 1500));
  const rosterJson = JSON.parse((await flume(["roster", "--json", "--agent-registry", REG, "--project-registry", join(work, "projects.yaml")])).stdout);
  assert.equal(rosterJson.ok, true);
  assert.deepEqual(rosterJson.data.rows.find((r) => r.agent_id.value === "cy-pm").channels_offline, ["telegram"]);
  assert.equal(rosterJson.data.findings.some((f) => /offline/u.test(JSON.stringify(f))), false, "parked is never a finding");
});

await check("online refuses when Telegram rejects the existing reference, and writes nothing", async () => {
  const before = tell();
  verbs.length = 0;
  const { body, status } = await json(["channel", "online", "cy-pm", "--apply"]);
  assert.equal(status, 1);
  assert.equal(body.ok, false);
  assert.equal(body.blockers[0].code, "auth-rejected");
  assert.match(body.blockers[0].detail, /rejected the token/u);
  assert.equal(tell(), before);
  assert.equal(registry().agents["cy-pm"].telegram.provisioning_status, "offline", "still parked");
  assert.deepEqual(verbs, []);
});

await check("online --credential-ref validates the reference shape", async () => {
  for (const bad of ["not-a-ref", "op://DeLoSecrets/My Item/credential", "op://DeLoSecrets/onlytwo", "https://x/y/z"]) {
    const { body, status } = await json(["channel", "online", "cy-pm", "--credential-ref", bad]);
    assert.equal(status, 1, bad);
    assert.equal(body.blockers[0].code, "invalid-reference", bad);
  }
  const titled = await json(["channel", "online", "cy-pm", "--credential-ref", "op://DeLoSecrets/some-title/credential"]);
  assert.equal(titled.status, 0, "a title-based reference is allowed in a preview");
  assert.ok(titled.body.warnings.some((w) => /UUID/u.test(w)));
  assert.deepEqual(titled.body.writes, []);
});

await check("online preview resolves nothing and asks no one", async () => {
  const opBefore = readFileSync(OPLOG, "utf8");
  const apiBefore = apiCalls.length;
  const { body, status } = await json(["channel", "online", "cy-pm", "--credential-ref", REF.rotated]);
  assert.equal(status, 0);
  assert.equal(body.rotation.from, REF.cy);
  assert.equal(body.rotation.to, REF.rotated);
  assert.equal(readFileSync(OPLOG, "utf8"), opBefore, "op is only called at apply time");
  assert.equal(apiCalls.length, apiBefore);
});

await check("online refuses a bot Telegram says is already assigned to another profile", async () => {
  const before = tell();
  const { body, status } = await json(["channel", "online", "cy-pm", "--credential-ref", REF.dup, "--apply"]);
  assert.equal(status, 1);
  assert.equal(body.blockers[0].code, "duplicate-bot");
  assert.match(body.blockers[0].detail, /bob-pm/u);
  assert.equal(tell(), before, "the delta, the render and the registry are all untouched");
});

await check("online refuses a reference another profile already carries", async () => {
  const { body, status } = await json(["channel", "online", "cy-pm", "--credential-ref", REF.bob, "--apply"]);
  assert.equal(status, 1);
  assert.equal(body.blockers[0].code, "reference-in-use");
  assert.match(body.blockers[0].detail, /bob-pm/u);
});

await check("online refuses a revoked token supplied as a new reference", async () => {
  const before = tell();
  const { body, status } = await json(["channel", "online", "cy-pm", "--credential-ref", REF.revoked, "--apply"]);
  assert.equal(status, 1);
  assert.equal(body.blockers[0].code, "auth-rejected");
  assert.equal(tell(), before);
});

await check("ROTATION: online with a new reference verifies the bot, records its identity, swaps the reference, re-enables, and starts it", async () => {
  verbs.length = 0;
  const { body, status } = await json(["channel", "online", "cy-pm", "--credential-ref", REF.rotated, "--apply"]);
  assert.equal(status, 0, JSON.stringify(body));
  assert.deepEqual(body.verified, { bot_username: "cy_rotated_bot", bot_id: "333" });
  const row = registry().agents["cy-pm"].telegram;
  assert.equal(row.provisioning_status, "verified");
  assert.equal(row.bot_username, "cy_rotated_bot");
  assert.equal(row.bot_id, "333");
  assert.equal("offline_since" in row, false);
  assert.equal("offline_reason" in row, false);
  const d = delta("cy-pm");
  assert.equal(d.secrets.onepassword.env.TELEGRAM_BOT_TOKEN, REF.rotated, "the old reference is replaced, not kept beside the new");
  assert.equal(d.platforms.telegram.enabled, true);
  assert.equal(generated("cy-pm").platforms.telegram.enabled, true);
  assert.deepEqual(verbs.map((v) => v.name), ["cy-pm", "cy-pm"]);
  assert.equal(body.gateway.confirmed, true, JSON.stringify(body.gateway));
  assert.equal(readState().platforms["cy-pm:telegram"].state, "connected");
});

await check("offline -> online with no reference keeps the reference byte for byte and re-verifies the existing bot", async () => {
  const refBefore = delta("ada-pm").secrets.onepassword.env.TELEGRAM_BOT_TOKEN;
  const off = await json(["channel", "offline", "ada-pm", "--apply"]);
  assert.equal(off.status, 0, JSON.stringify(off.body));
  assert.equal(off.body.gateway.confirmed, true);
  assert.equal(registry().agents["ada-pm"].telegram.offline_reason, "parked by the operator", "a default reason is recorded");
  assert.equal(readState().platforms["ada-pm:telegram"], undefined);
  assert.equal(delta("ada-pm").secrets.onepassword.env.TELEGRAM_BOT_TOKEN, refBefore);
  const apiBefore = apiCalls.length;
  const on = await json(["channel", "online", "ada-pm", "--apply"]);
  assert.equal(on.status, 0, JSON.stringify(on.body));
  assert.equal(on.body.rotation, undefined, "not a rotation");
  assert.equal(apiCalls.length, apiBefore + 1, "exactly one getMe");
  assert.equal(registry().agents["ada-pm"].telegram.provisioning_status, "verified");
  assert.equal(registry().agents["ada-pm"].telegram.bot_id, "111");
  assert.equal(delta("ada-pm").secrets.onepassword.env.TELEGRAM_BOT_TOKEN, refBefore);
  assert.equal(delta("ada-pm").platforms.telegram.enabled, true);
  assert.equal(readState().platforms["ada-pm:telegram"].state, "connected");
  assert.equal(delta("ada-pm").platforms.slack.enabled, true, "the other platform's pin is untouched");
});

await check("--no-reload writes the change and says honestly that the gateway was not told", async () => {
  verbs.length = 0;
  const { body, status } = await json(["channel", "offline", "bob-pm", "--no-reload", "--apply"]);
  assert.equal(status, 0);
  assert.equal(body.gateway.action, "skipped");
  assert.equal(body.gateway.confirmed, false);
  assert.match(body.gateway.detail, /never stops a running one/u);
  assert.equal(body.gateway.state, "connected", "the live channel is reported as it is");
  assert.deepEqual(verbs, []);
  assert.equal(registry().agents["bob-pm"].telegram.provisioning_status, "offline");
  const list = (await json(["channel", "list"])).body.rows.find((r) => r.employee === "bob-pm");
  assert.ok(list.notes.some((n) => /still shows it connected/u.test(n)), "list names the disagreement");
  const back = await json(["channel", "online", "bob-pm", "--no-reload", "--apply"]);
  assert.equal(back.status, 0);
  assert.equal(registry().agents["bob-pm"].telegram.provisioning_status, "verified");
});

await check("without a control socket the gateway is reloaded, and an unconfirmed result is reported as such", async () => {
  socketServer.close();
  rmSync(SOCK, { force: true });
  const { body, status } = await json(["channel", "offline", "ada-pm", "--apply"], { FLUME_CHANNEL_CONFIRM_MS: "1200" });
  assert.equal(status, 0);
  assert.equal(body.gateway.action, "reload");
  assert.equal(body.gateway.confirmed, false);
  assert.match(body.gateway.detail, /no gateway control socket/u);
  assert.match(readFileSync(SYSLOG, "utf8"), /--user reload hermes-gateway/u);
  await startSocket();
  await json(["channel", "online", "ada-pm", "--apply"]);
});

await check("on a launchd host the fallback is hermes gateway restart, then launchctl kickstart -k, never systemctl", async () => {
  socketServer.close();
  rmSync(SOCK, { force: true });
  const launchLog = join(work, "launchd.log");
  const macBin = join(work, "mac-bin");
  mkdirSync(macBin, { recursive: true });
  writeFileSync(join(macBin, "hermes"), `#!/bin/sh\necho "hermes $@" >> "${launchLog}"\nexit "\${FAKE_HERMES_EXIT:-0}"\n`);
  writeFileSync(join(macBin, "launchctl"), `#!/bin/sh\necho "launchctl $@" >> "${launchLog}"\nexit 0\n`);
  chmodSync(join(macBin, "hermes"), 0o755);
  chmodSync(join(macBin, "launchctl"), 0o755);
  const mac = { FLUME_HOST_PLATFORM: "darwin", PATH: `${macBin}:${BIN}:${process.env.PATH}`, FLUME_CHANNEL_CONFIRM_MS: "1200" };
  writeFileSync(SYSLOG, "");
  writeFileSync(launchLog, "");
  const first = await json(["channel", "offline", "ada-pm", "--apply"], mac);
  assert.equal(first.status, 0);
  assert.equal(first.body.gateway.action, "restart");
  assert.match(first.body.gateway.detail, /no gateway control socket; restarted the launchd gateway with hermes gateway restart/u);
  assert.equal(readFileSync(launchLog, "utf8"), "hermes gateway restart\n");
  writeFileSync(launchLog, "");
  const second = await json(["channel", "online", "ada-pm", "--apply"], { ...mac, FAKE_HERMES_EXIT: "1" });
  assert.equal(second.body.gateway.action, "restart");
  assert.match(second.body.gateway.detail, /hermes gateway restart failed.*launchctl kickstart -k gui\/\d+\/ai\.hermes\.gateway/u);
  assert.match(readFileSync(launchLog, "utf8"), /^hermes gateway restart\nlaunchctl kickstart -k gui\/\d+\/ai\.hermes\.gateway\n$/u);
  assert.equal(readFileSync(SYSLOG, "utf8"), "", "systemctl is never consulted on a launchd host");
  await startSocket();
});

await check("a gateway that refuses to serve the profile falls back to a reload", async () => {
  socketServer.close();
  rmSync(SOCK, { force: true });
  await startSocket({ failServe: true });
  writeFileSync(SYSLOG, "");
  const { body } = await json(["channel", "offline", "bob-pm", "--apply"], { FLUME_CHANNEL_CONFIRM_MS: "1200" });
  assert.equal(body.gateway.action, "reload");
  assert.match(body.gateway.detail, /serve-profile: .*parked/u);
  assert.match(readFileSync(SYSLOG, "utf8"), /reload hermes-gateway/u);
  socketServer.close();
  rmSync(SOCK, { force: true });
  await startSocket();
  await json(["channel", "online", "bob-pm", "--apply"]);
});

await check("slack works the same way: offline pins it off, online verifies with auth.test and records the identity", async () => {
  const off = await json(["channel", "offline", "ada-pm", "--platform", "slack", "--reason", "workspace seat limit", "--no-reload", "--apply"]);
  assert.equal(off.status, 0, JSON.stringify(off.body));
  assert.equal(registry().agents["ada-pm"].slack.provisioning_status, "offline");
  assert.equal(delta("ada-pm").platforms.slack.enabled, false);
  assert.equal(delta("ada-pm").secrets.onepassword.env.SLACK_APP_TOKEN, REF.appslack);
  assert.equal(registry().agents["ada-pm"].telegram.provisioning_status, "verified", "the other platform is not parked");
  const on = await json(["channel", "online", "ada-pm", "--platform", "slack", "--no-reload", "--apply"]);
  assert.equal(on.status, 0, JSON.stringify(on.body));
  assert.deepEqual(on.body.verified.bot_id, "B1");
  assert.equal(registry().agents["ada-pm"].slack.provisioning_status, "verified");
  assert.equal("offline_reason" in registry().agents["ada-pm"].slack, false);
  assert.equal(delta("ada-pm").platforms.slack.enabled, true);
  const bad = await json(["channel", "online", "ada-pm", "--platform", "telegram", "--app-token-ref", REF.appslack]);
  assert.equal(bad.body.blockers[0].code, "invalid-option");
});

await check("an unknown employee and an unknown platform are refused", async () => {
  const ghost = await json(["channel", "offline", "ghost-pm"]);
  assert.equal(ghost.status, 1);
  assert.match(ghost.body.blockers[0].detail, /no employee "ghost-pm"/u);
  const odd = await json(["channel", "offline", "ada-pm", "--platform", "irc"]);
  assert.equal(odd.status, 1);
  assert.match(odd.body.blockers[0].detail, /telegram or slack/u);
});

await check("the registry flock is honoured: a held lock times out and nothing is written", async () => {
  const before = tell();
  const holder = spawn("flock", [`${REG}.lock`, "sleep", "5"], { stdio: "ignore" });
  await new Promise((ok) => setTimeout(ok, 400));
  const { body, status } = await json(["channel", "offline", "bob-pm", "--no-reload", "--apply"], { HERMES_REGISTRY_LOCK_TIMEOUT_SECONDS: "1" });
  holder.kill();
  assert.equal(status, 1);
  assert.match(body.blockers[0].detail, /timed out waiting for registry lock/u);
  assert.equal(tell(), before);
});

await check("a write that fails part way puts every file back byte for byte", async () => {
  const before = tell();
  chmodSync(FLEET, 0o555); // the registry is replaced last, by a temp file in this directory
  let run;
  try { run = await json(["channel", "offline", "bob-pm", "--no-reload", "--apply"]); } finally { chmodSync(FLEET, 0o755); }
  assert.equal(run.status, 1, JSON.stringify(run.body));
  assert.equal(run.body.blockers[0].code, "internal");
  assert.equal(tell(), before, "the delta and the generated config written before the failure were restored");
});

await check("no planted credential reached any output, the registry, a delta or a generated config", async () => {
  const haystack = outputs.join("\n") + readdirSync(join(FLEET, "profiles")).filter((id) => !id.startsWith(".")).map((id) => ["config.delta.yaml", "config.yaml"].map((f) => readFileSync(join(FLEET, "profiles", id, f), "utf8")).join("\n")).join("\n") + readFileSync(REG, "utf8") + readFileSync(STATE, "utf8");
  for (const [name, value] of Object.entries(TOKEN)) assert.equal(haystack.includes(value), false, `${name} token leaked`);
  assert.equal(apiCalls.some((url) => url.includes("AAplanted")), false);
  assert.ok(apiCalls.length > 0);
});

http.close();
socketServer.close();
sleeper.kill();
rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? `channel-offline regressions passed (${count})` : `\n${failures} of ${count} channel-offline check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
