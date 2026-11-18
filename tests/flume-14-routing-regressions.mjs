import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// A real AF_UNIX exchange against a fixture implementing Hermes control_socket.py's
// existing identify verb; every captured request is asserted non-mutating.
const root = mkdtempSync(join(tmpdir(), "bb-route-"));
const home = join(root, "home");
const profiles = join(home, "profiles");
const socket = join(home, "gateway.sock");
mkdirSync(join(profiles, "alpha-pm"), { recursive: true });
const bundle = join(root, "bloodbank.mjs");
await build({ entryPoints: [resolve(import.meta.dirname, "../packages/flume-hr/src/org/bloodbank.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle });
const { observeBloodbankRoute } = await import(pathToFileURL(bundle).href);
const createRunContext = ({ signal = new AbortController().signal, probeTimeoutMs = 500, deadlineMs = 2000 } = {}) =>
  ({ signal, probeTimeoutMs, deadlineAt: Date.now() + deadlineMs });
const wanted = join(profiles, "alpha-pm");
const good = { protocol: 1, id: 1, ok: true, result: {
  runtime_protocol: 1, hermes_home: home, state: "ready", capabilities: ["session-authority-v1"],
  served_profiles: [{ profile_id: wanted, home: wanted }],
} };
const controller = new AbortController();
const context = (ms = 500) => createRunContext({ signal: controller.signal, probeTimeoutMs: ms, deadlineMs: 2000 });
const call = (scope = "fleet", target = "alpha-pm", profile = "alpha-pm", run = context()) =>
  observeBloodbankRoute(run, home, profiles, "alpha-pm", profile, scope, target);
let requests = [];
let reply = good;
let server;
async function listen() {
  server = createServer((client) => {
    client.once("data", (bytes) => {
      requests.push(bytes.toString("utf8"));
      if (reply !== null) client.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((ok) => server.listen(socket, ok));
}
const stop = () => new Promise((ok) => server.close(ok));
let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (error) { failures++; console.error(`  FAIL ${label}: ${error.stack}`); }
}
try {
  await listen();
  await check("a fresh target-correlated served authority passes using only identify", async () => {
    const got = await call();
    assert.equal(got.state, "pass");
    assert.equal(got.evidence, "direct");
    assert.deepEqual(requests.map(JSON.parse), [{ verb: "identify", id: 1, protocol: 1 }]);
  });
  await check("handbook prerequisites fail without a socket request", async () => {
    const before = requests.length;
    for (const [scope, target, profile, reason] of [
      [null, "alpha-pm", "alpha-pm", "routing-scope-missing"],
      ["local", "alpha-pm", "alpha-pm", "routing-scope-not-fleet"],
      ["fleet", null, "alpha-pm", "routing-target-missing"],
      ["fleet", "other", "alpha-pm", "routing-target-mismatch"],
      ["fleet", "alpha-pm", null, "routing-profile-missing-or-invalid"],
      ["fleet", "alpha-pm", "missing", "routing-profile-unresolved"],
      ["fleet", "alpha-pm", "../escape", "routing-profile-missing-or-invalid"],
    ]) assert.equal((await call(scope, target, profile)).reason, reason);
    assert.equal(requests.length, before);
  });
  await check("absent and conflicting served routes have explicit negative evidence", async () => {
    reply = { ...good, result: { ...good.result, served_profiles: [] } };
    assert.equal((await call()).reason, "gateway-profile-not-served");
    reply = { ...good, result: { ...good.result, served_profiles: [...good.result.served_profiles, ...good.result.served_profiles] } };
    assert.equal((await call()).reason, "gateway-route-conflict");
  });
  await check("stale, malformed and secret-bearing replies never become ready or leak", async () => {
    for (const response of [
      { ...good, result: { ...good.result, state: "draining" } },
      { ...good, result: { ...good.result, served_profiles: null } },
      { ...good, result: { ...good.result, hermes_home: "/not-the-fleet" } },
      { ...good, result: { ...good.result, served_profiles: [{ profile_id: wanted, home: "/not-the-profile" }] } },
      { ok: false, id: 1, protocol: 1, error: "planted-private-token" },
    ]) {
      reply = response;
      const got = await call();
      assert.notEqual(got.state, "pass");
      assert.ok(!JSON.stringify(got).includes("planted-private-token"));
    }
  });
  await check("a hung peer times out at the per-probe limit; the run deadline rejects", async () => {
    reply = null;
    const started = Date.now();
    assert.equal((await call("fleet", "alpha-pm", "alpha-pm", context(30))).reason, "gateway-inspection-timeout");
    assert.ok(Date.now() - started < 1000);
    await assert.rejects(() => call("fleet", "alpha-pm", "alpha-pm", createRunContext({ deadlineMs: 1, probeTimeoutMs: 5000 })),
      (error) => error.code === "TIMEOUT");
  });
  await check("cancellation is a command failure", async () => {
    const abort = new AbortController();
    const pending = call("fleet", "alpha-pm", "alpha-pm", createRunContext({ signal: abort.signal, probeTimeoutMs: 500 }));
    abort.abort();
    await assert.rejects(pending, (error) => error.code === "CANCELLED");
  });
  await stop();
  await check("missing socket is an explicit gap, not a fabricated route", async () => {
    assert.equal((await call()).reason, "gateway-control-socket-unavailable");
  });
  await check("CLI keeps activation independent, including an absent key, without changing fixtures", async () => {
    const cli = resolve(import.meta.dirname, "../packages/flume-hr/dist/index.js");
    const registry = join(root, "agents.yaml");
    const projects = join(root, "projects.yaml");
    const initial = {
      "alpha-pm": { repo: "alpha", profile_name: "alpha-pm", bloodbank: { gateway_scope: "fleet", target_agent_id: "alpha-pm" } },
    };
    writeFileSync(projects, YAML.stringify({ schema_version: 1, projects: {} }));
    async function run() {
      const child = spawn(process.execPath, [cli, "review", "--domain", "bloodbank", "--agent", "alpha-pm", "--json",
        "--agent-registry", registry, "--project-registry", projects, "--deadline-ms", "1500"], {
        env: { ...process.env, HERMES_FLEET_HOME: home, NO_COLOR: "1" },
      });
      let output = "";
      let errors = "";
      child.stdout.on("data", (part) => { output += part; });
      child.stderr.on("data", (part) => { errors += part; });
      const code = await new Promise((ok) => child.on("close", ok));
      assert.equal(code, 0, errors);
      const answer = JSON.parse(output);
      assert.equal(answer.ok, true);
      return answer.data.agents[0];
    }
    for (const [key, value, expected] of [
      ["absent", undefined, "granted"], ["true", true, "granted"],
      ["false", false, "denied"], ["invalid", "planted-private-token", "denied"],
    ]) {
      const row = structuredClone(initial["alpha-pm"]);
      if (value !== undefined) row.bloodbank.enabled = value;
      const before = YAML.stringify({ schema_version: 1, agents: { "alpha-pm": row } });
      writeFileSync(registry, before);
      const agent = await run();
      assert.equal(agent.lifecycle.activation, expected, key);
      assert.equal(agent.lifecycle.capability_readiness, "unproven", key);
      assert.equal(readFileSync(registry, "utf8"), before);
      assert.ok(!JSON.stringify(agent).includes("planted-private-token"));
    }
  });
  await check("CLI keeps readiness independent of authority on a live fixture route", async () => {
    const registry = join(root, "positive-agents.yaml");
    const projects = join(root, "positive-projects.yaml");
    writeFileSync(registry, YAML.stringify({ schema_version: 1, agents: {
      "alpha-pm": { repo: "alpha", profile_name: "alpha-pm", bloodbank: { enabled: false, gateway_scope: "fleet", target_agent_id: "alpha-pm" } },
    } }));
    writeFileSync(projects, YAML.stringify({ schema_version: 1, projects: {} }));
    const before = readFileSync(registry);
    reply = good;
    await listen();
    try {
      const cli = resolve(import.meta.dirname, "../packages/flume-hr/dist/index.js");
      const child = spawn(process.execPath, [cli, "review", "--domain", "bloodbank", "--agent", "alpha-pm", "--json",
        "--agent-registry", registry, "--project-registry", projects, "--deadline-ms", "1500"], {
        env: { ...process.env, HERMES_FLEET_HOME: home, NO_COLOR: "1" },
      });
      let output = "";
      child.stdout.on("data", (part) => { output += part; });
      const code = await new Promise((ok) => child.on("close", ok));
      assert.equal(code, 0);
      const agent = JSON.parse(output).data.agents[0];
      assert.equal(agent.lifecycle.capability_readiness, "ready");
      assert.equal(agent.lifecycle.activation, "denied");
      assert.equal(agent.lifecycle.observed_state, "out_of_scope");
      assert.equal(agent.observations.find((o) => o.source === "gateway-control-identify").evidence, "direct");
      assert.deepEqual(readFileSync(registry), before);
      assert.deepEqual(requests.map(JSON.parse).at(-1), { verb: "identify", id: 1, protocol: 1 });
    } finally { await stop(); }
  });
  assert.deepEqual(readFileSync(bundle).length > 0, true);
} finally {
  if (server?.listening) await stop();
  rmSync(root, { recursive: true, force: true });
}
console.log(`bloodbank routing: ${failures} failure(s)`);
if (failures) process.exitCode = 1;
