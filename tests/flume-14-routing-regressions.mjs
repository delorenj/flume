import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readlinkSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = mkdtempSync(join(tmpdir(), "f14-"));
const fixture = join(root, "fixture");
const home = join(fixture, "home");
const profiles = join(home, "profiles");
const wanted = join(profiles, "alpha-pm");
const socket = join(root, "s");
const pointer = join(home, "gateway.sock.path");
const registry = join(fixture, "agents.yaml");
const projects = join(fixture, "projects.yaml");
const secret = "f14-planted-private-token";
mkdirSync(wanted, { recursive: true });
mkdirSync(join(profiles, "beta-pm"));
mkdirSync(join(fixture, "role"));
mkdirSync(join(fixture, "services"));
writeFileSync(join(fixture, "role", "role.yaml"), YAML.stringify({ bloodbank: { enabled: false }, credential: secret }));
writeFileSync(join(fixture, "services", "hermes-gateway.service"), `# private service sentinel ${secret}\n`);
writeFileSync(join(wanted, "config.delta.yaml"), YAML.stringify({ api_key: secret, platforms: { bloodbank: { enabled: false, extra: { target_profiles: { "alpha-pm": "beta-pm" }, fleet_registry: join(fixture, "adapter-registry.yaml") } } } }));
writeFileSync(join(wanted, "config.yaml"), `# GENERATED FILE -- DO NOT EDIT\napi_key: ${secret}\n`);
writeFileSync(join(wanted, "profile.yaml"), "name: alpha-pm\n");
writeFileSync(join(home, "config.yaml"), readFileSync(join(wanted, "config.delta.yaml")));
writeFileSync(join(fixture, "adapter-registry.yaml"), YAML.stringify({ schema_version: 1, agents: { "alpha-pm": { profile_name: "beta-pm", bloodbank: { gateway_scope: "fleet", target_agent_id: "alpha-pm" } } } }));
writeFileSync(projects, YAML.stringify({ schema_version: 1, projects: {} }));
writeFileSync(pointer, socket, { mode: 0o600 });
const initial = { repo: "alpha", profile_name: "alpha-pm", bloodbank: { gateway_scope: "fleet", target_agent_id: "alpha-pm" } };
function seed(row = initial, extra = {}) {
  writeFileSync(registry, YAML.stringify({ schema_version: 1, agents: { "alpha-pm": row, ...extra } }));
}
seed();
const bundle = join(root, "bloodbank.mjs");
await build({ entryPoints: [resolve(import.meta.dirname, "../packages/flume-hr/src/org/bloodbank.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle });
const { observeBloodbankRoute } = await import(pathToFileURL(bundle).href);
const context = ({ signal = new AbortController().signal, probeTimeoutMs = 300, deadlineMs = 2000 } = {}) =>
  ({ signal, probeTimeoutMs, deadlineAt: Date.now() + deadlineMs });
const call = (scope = "fleet", target = "alpha-pm", profile = "alpha-pm", run = context()) =>
  observeBloodbankRoute(run, home, profiles, "alpha-pm", profile, scope, target);
const good = { protocol: 1, id: 1, ok: true, result: {
  runtime_protocol: 1, hermes_home: home, state: "ready", capabilities: ["session-authority-v1"],
  served_profiles: [{ profile_id: wanted, home: wanted }],
} };
let reply = good;
let raw;
const requests = [];
const clients = new Set();
let onRequest;
let server;
async function listen() {
  server = createServer((client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.once("data", (bytes) => {
      requests.push(JSON.parse(bytes.toString("utf8")));
      onRequest?.();
      if (raw !== undefined) client.end(raw);
      else if (reply !== null) client.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((ok, reject) => { server.once("error", reject); server.listen(socket, ok); });
}
async function stop() {
  for (const client of clients) client.destroy();
  if (server?.listening) await new Promise((ok) => server.close(ok));
}
function snapshot() {
  const entries = {};
  function walk(path) {
    const stat = lstatSync(path);
    const key = relative(fixture, path);
    const data = [stat.mode, stat.mtimeMs, stat.size];
    if (stat.isSymbolicLink()) data.push(readlinkSync(path));
    else if (stat.isFile()) data.push(createHash("sha256").update(readFileSync(path)).digest("hex"));
    entries[key] = data;
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  }
  walk(fixture);
  return entries;
}

// Child/network spies apply to the real CLI, before any modules load. Every
// process launch, HTTP request and non-fixture socket is forbidden: this scoped
// review requires none. This traps invocation, publication/replay, consumption,
// acknowledgement and service control entrypoints rather than inferring safety
// from identify requests alone. A tripwire self-test below proves it is armed.
const guard = join(root, "guard.cjs");
const spy = join(root, "forbidden.jsonl");
writeFileSync(guard, `
const fs = require('node:fs');
const cp = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const deny = name => (...args) => { fs.appendFileSync(process.env.F14_SPY, JSON.stringify({name})+'\\n'); throw new Error('forbidden operation: '+name); };
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name] = deny('child_process.'+name);
for (const module of [http, https]) for (const name of ['request','get']) module[name] = deny('http.'+name);
globalThis.fetch = deny('fetch');
const connect = net.createConnection;
net.createConnection = net.connect = (...args) => {
  const path = typeof args[0] === 'string' ? args[0] : args[0]?.path;
  if (path !== process.env.F14_SOCKET) return deny('network.non-identify')();
  return connect(...args);
};
require('node:module').syncBuiltinESMExports();
`);
const cli = resolve(import.meta.dirname, "../packages/flume-hr/dist/index.js");
const env = { ...process.env, HERMES_FLEET_HOME: home, HERMES_FLEET_ENV: join(root, "absent.env"),
  FLUME_HOST_OVERLAY: "none", NO_COLOR: "1", F14_SPY: spy, F14_SOCKET: socket };
async function run({ json = true, domain = "bloodbank", deadline = 2000, cancel = false } = {}) {
  const before = snapshot();
  const child = spawn(process.execPath, ["--require", guard, cli, "review", "--domain", domain, "--agent", "alpha-pm",
    ...(json ? ["--json"] : []), "--agent-registry", registry, "--project-registry", projects, "--deadline-ms", String(deadline)], { cwd: fixture, env });
  if (cancel) onRequest = () => child.kill("SIGINT");
  let output = "", errors = "";
  child.stdout.on("data", (part) => { output += part; });
  child.stderr.on("data", (part) => { errors += part; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
  const code = await new Promise((ok, reject) => { child.on("error", reject); child.on("close", ok); });
  clearTimeout(timer);
  onRequest = undefined;
  assert.deepEqual(snapshot(), before, "registry, authority absence, profile/role config and service tree must remain content/mode/mtime-identical");
  assert.ok(!output.includes(secret) && !errors.includes(secret), "human and JSON output must not expose planted secrets");
  assert.equal(readFileSync(spy, "utf8"), "", "forbidden process/network operation");
  return { code, output, errors, parsed: json ? JSON.parse(output) : null };
}
function route(parsed) { return parsed.data.agents[0].observations.find((o) => o.source === "gateway-control-identify"); }
function assertGap(parsed) {
  assert.equal(parsed.ok, true);
  const agent = parsed.data.agents[0];
  assert.notEqual(agent.lifecycle.capability_readiness, "ready");
  assert.ok(!["routing_ready", "activated"].includes(agent.lifecycle.observed_state));
  const gap = agent.observations.find((o) => o.summary === "bloodbank-target-resolution-unsupported");
  assert.equal(gap.state, "unsupported");
  assert.equal(gap.justification.kind, "deferred_capability");
  assert.match(gap.details.join(" "), /target_profiles.*independently selected registry/);
}
let failures = 0, passed = 0;
async function check(label, fn) {
  try { await fn(); passed++; console.log(`  ok   ${label}`); }
  catch (error) { failures++; console.error(`  FAIL ${label}: ${error.stack}`); }
}
try {
  await listen();
  await check("forbidden-operation spies are armed for process, service and command transports", async () => {
    const child = spawn(process.execPath, ["--require", guard, "-e", "try{require('node:child_process').spawn('hermes',['invoke'])}catch{};try{require('node:child_process').execFileSync('systemctl',['restart','x'])}catch{};try{require('node:net').connect(5672,'localhost')}catch{};try{require('node:https').request('https://localhost')}catch{}"], { env });
    assert.equal(await new Promise((ok) => child.on("close", ok)), 0);
    assert.equal(readFileSync(spy, "utf8").trim().split("\n").length, 4);
    writeFileSync(spy, "");
  });
  await check("fresh identify proves session addressability only, using the existing argument-free verb", async () => {
    assert.equal((await call()).state, "pass");
    assert.deepEqual(requests.at(-1), { verb: "identify", id: 1, protocol: 1 });
  });
  await check("positive addressability preserves true/false/absent/invalid activation in real JSON and human CLI", async () => {
    for (const [value, expected] of [[undefined, "granted"], [true, "granted"], [false, "denied"], [secret, "denied"]]) {
      const row = structuredClone(initial);
      if (value !== undefined) row.bloodbank.enabled = value;
      seed(row); reply = good; raw = undefined;
      const { code, parsed } = await run();
      assert.equal(code, 0); assertGap(parsed);
      assert.equal(route(parsed).state, "pass");
      assert.equal(parsed.data.agents[0].lifecycle.capability_readiness, "unproven");
      assert.equal(parsed.data.agents[0].lifecycle.activation, expected);
      assert.equal(Object.hasOwn(YAML.parse(readFileSync(registry, "utf8")).agents["alpha-pm"].bloodbank, "enabled"), value !== undefined);
      const human = await run({ json: false });
      assert.match(human.output, /gateway-control-identify: pass gateway-serves-declared-profile/);
      assert.match(human.output, /Session-profile addressability only/);
      assert.match(human.output, /Bloodbank target resolution.*unsupported/);
      assert.match(human.output, new RegExp(`routing unproven.*activation ${expected}`));
    }
    seed();
  });
  await check("served intended profile with disabled adapter, conflicting override and separate adapter registry stays unproven", async () => {
    const config = YAML.parse(readFileSync(join(home, "config.yaml"), "utf8")).platforms.bloodbank;
    assert.equal(config.enabled, false);
    assert.equal(config.extra.target_profiles["alpha-pm"], "beta-pm");
    assert.equal(YAML.parse(readFileSync(config.extra.fleet_registry, "utf8")).agents["alpha-pm"].profile_name, "beta-pm");
    const { parsed } = await run(); assertGap(parsed);
    assert.equal(route(parsed).state, "pass");
    assert.equal(parsed.data.agents[0].lifecycle.capability_readiness, "unproven");
  });
  await check("prerequisites carry the actual bounded field, handbook owner and specific read-only investigation", async () => {
    const cases = [
      [{ bloodbank: { target_agent_id: "alpha-pm" } }, "routing-scope-missing", "bloodbank.gateway_scope", "agent-registry", /gateway_scope/],
      [{ bloodbank: { ...initial.bloodbank, gateway_scope: "local" } }, "routing-scope-not-fleet", "bloodbank.gateway_scope", "agent-registry", /gateway_scope/],
      [{ bloodbank: { gateway_scope: "fleet" } }, "routing-target-missing", "bloodbank.target_agent_id", "agent-registry", /target_agent_id/],
      [{ bloodbank: { ...initial.bloodbank, target_agent_id: "other" } }, "routing-target-mismatch", "bloodbank.target_agent_id", "agent-registry", /target_agent_id/],
      [{ profile_name: " " }, "routing-profile-missing-or-invalid", "profile_name", "agent-registry", /profile_name/],
      [{ profile_name: "missing" }, "routing-profile-unresolved", "profiles.{profile_name}.config.yaml", "runtime-template", /profile directory/],
    ];
    for (const [change, reason, field, owner, action] of cases) {
      seed({ ...initial, ...change });
      const { parsed } = await run(); assertGap(parsed);
      const got = route(parsed);
      assert.equal(got.summary, reason);
      assert.ok(got.field.endsWith(field)); assert.equal(got.owner, owner);
      assert.match(got.next_action, action); assert.equal(got.next_action_class, "read-only");
      assert.equal(parsed.data.agents[0].lifecycle.capability_readiness, "blocked");
    }
    seed(initial, { "beta-pm": { ...initial, repo: "beta" } });
    assert.equal(route((await run()).parsed).summary, "routing-profile-conflict");
    seed();
  });
  await check("negative served evidence and human output preserve proof boundary and runtime ownership", async () => {
    for (const served of [[], [...good.result.served_profiles, ...good.result.served_profiles], [{ profile_id: wanted, home: join(profiles, "beta-pm") }]]) {
      reply = { ...good, result: { ...good.result, served_profiles: served } };
      const { parsed } = await run(); assertGap(parsed);
      const got = route(parsed); assert.equal(got.state, "fail");
      assert.equal(got.field, "units.hermes-gateway.service"); assert.equal(got.owner, "runtime-template");
      assert.match(got.next_action, /identify response/);
      const { output } = await run({ json: false });
      assert.match(output, /gateway-control-identify: fail/);
      assert.match(output, /Session-profile addressability only/); assert.match(output, /Bloodbank target resolution.*unsupported/);
    }
  });
  await check("malformed, mismatched, incomplete, draining and oversized responses cannot prove healthy readiness or leak", async () => {
    for (const [response, reason] of [
      [secret + "\n", "gateway-inspection-malformed"],
      [JSON.stringify({ ...good, id: 2, error: secret }) + "\n", "gateway-inspection-invalid-envelope"],
      [JSON.stringify({ ...good, result: { ...good.result, hermes_home: "/wrong", secret } }) + "\n", "gateway-identity-mismatch"],
      [JSON.stringify({ ...good, result: { ...good.result, state: "draining", secret } }) + "\n", "gateway-not-ready"],
      [JSON.stringify({ ...good, result: { ...good.result, served_profiles: null, secret } }) + "\n", "gateway-route-evidence-missing"],
      [JSON.stringify({ ...good, result: { ...good.result, served_profiles: [{ profile_id: wanted + "/", home: wanted }] } }) + "\n", "gateway-route-evidence-invalid"],
      ['{"incomplete":true}', "gateway-inspection-incomplete"],
      ["x".repeat(512 * 1024 + 1), "gateway-inspection-oversized"],
    ]) {
      raw = response;
      const { parsed } = await run(); assertGap(parsed);
      assert.equal(route(parsed).summary, reason);
      assert.equal(parsed.data.health.proven, false); assert.equal(parsed.data.health.complete, false);
      assert.notEqual(parsed.data.health.verdict, "healthy");
      const { output } = await run({ json: false }); assert.match(output, new RegExp(reason));
    }
    raw = undefined; reply = good;
  });
  await check("denied socket access remains unobserved in real JSON/human CLI", async () => {
    chmodSync(socket, 0);
    try {
      const { parsed } = await run(); assertGap(parsed);
      assert.equal(route(parsed).summary, "gateway-inspection-denied");
      assert.equal(route(parsed).state, "unobserved");
      assert.match((await run({ json: false })).output, /gateway-inspection-denied/);
    } finally { chmodSync(socket, 0o700); }
  });
  await check("private pointer enforces 256-byte, permission and absolute-path limits without inspecting a peer", async () => {
    for (const [content, mode] of [[" ".repeat(257) + socket, 0o600], [socket, 0o644], ["relative.sock", 0o600]]) {
      writeFileSync(pointer, content); chmodSync(pointer, mode);
      const before = requests.length;
      assert.equal(route((await run()).parsed).summary, "gateway-control-socket-unavailable");
      assert.equal(requests.length, before);
    }
    writeFileSync(pointer, socket); chmodSync(pointer, 0o600);
  });
  await check("probe timeout, shared deadline and cancellation retain explicit no-partial-data semantics", async () => {
    reply = null;
    const started = Date.now();
    const timed = await call("fleet", "alpha-pm", "alpha-pm", context({ probeTimeoutMs: 25 }));
    assert.equal(timed.reason, "gateway-inspection-timeout"); assert.ok(Date.now() - started < 1000);
    await assert.rejects(() => call("fleet", "alpha-pm", "alpha-pm", context({ deadlineMs: 10, probeTimeoutMs: 5000 })), (e) => e.code === "TIMEOUT");
    const timedCli = await run({ deadline: 8000 });
    assertGap(timedCli.parsed);
    assert.equal(timedCli.code, 0);
    assert.equal(route(timedCli.parsed).summary, "gateway-inspection-timeout");
    assert.equal(timedCli.parsed.data.health.proven, false);
    assert.equal(timedCli.parsed.data.health.complete, false);
    assert.notEqual(timedCli.parsed.data.health.verdict, "healthy");
    for (const options of [{ deadline: 250 }, { cancel: true }]) {
      const { code, parsed } = await run(options);
      assert.equal(parsed.ok, false); assert.equal(parsed.data, null);
      assert.equal(parsed.error.code, options.cancel ? "CANCELLED" : "TIMEOUT");
      assert.equal(code, options.cancel ? 8 : 7);
    }
    reply = good;
  });
  await check("domain-filtered review keeps readiness and observed lifecycle out_of_scope", async () => {
    const before = requests.length;
    const { parsed } = await run({ domain: "registry" });
    assert.equal(parsed.data.agents[0].lifecycle.capability_readiness, "out_of_scope");
    assert.equal(parsed.data.agents[0].lifecycle.observed_state, "out_of_scope");
    assert.equal(requests.length, before);
  });
  await stop();
  await check("persisted prior success never replaces a fresh socket observation", async () => {
    writeFileSync(join(home, "historical-identify.json"), JSON.stringify(good));
    const { parsed } = await run(); assertGap(parsed);
    assert.equal(route(parsed).summary, "gateway-control-socket-unavailable");
    assert.equal(route(parsed).state, "unobserved");
    assert.equal(parsed.data.health.proven, false);
    assert.match((await run({ json: false })).output, /gateway-control-socket-unavailable/);
  });
  for (const request of requests) assert.deepEqual(request, { verb: "identify", id: 1, protocol: 1 });
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
console.log(`bloodbank routing: ${passed} passed, ${failures} failure(s)`);
if (failures) process.exitCode = 1;
