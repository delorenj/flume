// flume on a launchd host (macOS), proven on a Linux runner.
//
// A Mac has no flock(1), no systemctl, bash 3.2 at /bin/bash and ONE multiplexed gateway that
// `hermes gateway install` writes as the LaunchAgent ai.hermes.gateway. Nothing here patches a global:
// the platform is simulated through the FLUME_HOST_PLATFORM seam on the child each case spawns (or the
// pure helpers' explicit platform argument), and the missing tools by the PATH that child receives.
//
// What is proven:
//   * the registry lock's Linux argv is byte-identical to the one flume always spawned;
//   * the python3 fcntl.flock helper and flock(1) exclude each other on the same lock file, in both
//     directions, and withRegistryLock works on a PATH with no flock at all;
//   * `launchctl print` is classified (running / stopped / not-loaded / unobservable);
//   * the template shell libraries are never handed /bin/bash 3.2 on a launchd host;
//   * every agent-registry reader honours HERMES_FLEET_HOME / HERMES_AGENTS_REGISTRY;
//   * `systemd.sentinel` assesses a Mac from the launchd gateway and never spawns systemctl;
//   * `offboard` and a `hire --dry-run` say what a launchd host needs instead of deferring silently.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import YAML from "yaml";
import {
  hostPlatform, isLaunchdHost, launchdGatewayTarget, LAUNCHD_GATEWAY_LABEL, lockHelperArgv, modernBash,
  parseLaunchctlPrint, resolveAgentRegistryPath, resolveFleetHomeDir, resolveLockHelper, withFileLock,
} from "../packages/flume-hr/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const work = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), "flume-macos-")));
const which = (command) => spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).stdout.trim();
const FLOCK = which("flock");
const PYTHON3 = which("python3");
assert.ok(FLOCK, "this suite proves interop with flock(1), so the Linux runner must have it");
assert.ok(PYTHON3, "python3 is required");

let count = 0;
async function check(name, body) {
  await body();
  count += 1;
  console.log(`PASS ${name}`);
}

/** A directory holding executables, for a PATH a case controls completely. */
function bin(name, scripts = {}, links = {}) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, file), body);
    chmodSync(join(dir, file), 0o755);
  }
  for (const [file, target] of Object.entries(links)) if (!existsSync(join(dir, file))) symlinkSync(target, join(dir, file));
  return dir;
}

/** Is `lock` held by someone? flock -n exits 1 on a held lock and 0 (taking and dropping it) on a free one. */
const held = (lock) => spawnSync(FLOCK, ["-n", lock, "true"]).status === 1;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

try {
  // -- the registry lock --------------------------------------------------------------------------

  await check("Linux keeps the exact flock(1) argv flume always spawned", () => {
    assert.deepEqual(lockHelperArgv("flock", "/x/agents-registry.yaml.lock"),
      ["flock", ["-w", "30", "/x/agents-registry.yaml.lock", "sh", "-c", 'printf "locked\\n"; read release']]);
    assert.equal(resolveLockHelper({ PATH: dirname(FLOCK) }), "flock");
  });

  await check("a PATH without flock(1) selects the python3 helper; FLUME_LOCK_HELPER forces either", () => {
    const empty = bin("no-flock");
    assert.equal(resolveLockHelper({ PATH: empty }), "python3");
    assert.equal(resolveLockHelper({ PATH: empty, FLUME_LOCK_HELPER: "flock" }), "flock");
    assert.equal(resolveLockHelper({ PATH: dirname(FLOCK), FLUME_LOCK_HELPER: "python3" }), "python3");
    const [command, args] = lockHelperArgv("python3", "/x.lock", 7);
    assert.equal(command, "python3");
    assert.deepEqual(args.slice(-2), ["/x.lock", "7"]);
  });

  await check("a lock the python3 helper holds is held for flock(1), and released after", async () => {
    const lock = join(work, "py-holds.lock");
    let inside = null;
    await withFileLock(lock, async () => { inside = held(lock); }, { helper: "python3" });
    assert.equal(inside, true, "flock -n must see the python helper's lock");
    assert.equal(held(lock), false, "the lock is released when the action returns");
  });

  await check("a lock flock(1) holds makes the python3 helper wait, then time out with flock's exit status", async () => {
    const lock = join(work, "flock-holds.lock");
    const holder = spawn(FLOCK, [lock, "sleep", "10"], { stdio: "ignore" });
    try {
      const deadline = Date.now() + 5_000;
      while (!held(lock) && Date.now() < deadline) await sleep(20);
      assert.ok(held(lock), "fixture: flock(1) took the lock");
      const started = Date.now();
      let ran = false;
      await assert.rejects(withFileLock(lock, async () => { ran = true; }, { helper: "python3", waitSeconds: 0.5 }), /Registry lock unavailable \(exit 1\)/u);
      assert.equal(ran, false, "the action never runs without the lock");
      assert.ok(Date.now() - started < 5_000, "the wait is bounded by waitSeconds");
    } finally { holder.kill("SIGKILL"); }
  });

  await check("two python3 holders serialize on one lock file", async () => {
    const lock = join(work, "py-py.lock");
    const order = [];
    let releaseFirst;
    const gate = new Promise((done) => { releaseFirst = done; });
    const first = withFileLock(lock, async () => { order.push("first:in"); await gate; order.push("first:out"); }, { helper: "python3" });
    while (!order.includes("first:in")) await sleep(10);
    const second = withFileLock(lock, async () => { order.push("second:in"); }, { helper: "python3", waitSeconds: 10 });
    await sleep(300);
    assert.deepEqual(order, ["first:in"], "the second holder waits");
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:in", "first:out", "second:in"]);
  });

  await check("withRegistryLock works on a PATH with no flock(1) and still excludes flock(1) writers", async () => {
    const macPath = bin("mac-path", {}, { python3: PYTHON3 });
    const registry = join(work, "fleet", "agents-registry.yaml");
    const script = `
      const { withRegistryLock, resolveLockHelper } = await import(${JSON.stringify(cli)});
      if (resolveLockHelper() !== "python3") { console.log("wrong-helper"); process.exit(3); }
      await withRegistryLock(${JSON.stringify(registry)}, async () => {
        console.log("held");
        await new Promise((done) => process.stdin.once("data", done));
      });
      console.log("released");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, PATH: macPath }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    const closed = new Promise((done) => child.on("close", done));
    const deadline = Date.now() + 15_000;
    while (!out.includes("held") && Date.now() < deadline && child.exitCode === null) await sleep(20);
    assert.match(out, /held/u, `child never took the lock: ${out} ${err}`);
    assert.equal(held(`${registry}.lock`), true, "flock(1) sees the macOS-path holder");
    child.stdin.end("go\n");
    assert.equal(await closed, 0, err);
    assert.match(out, /released/u);
    assert.equal(held(`${registry}.lock`), false);
  });

  // -- the platform seam and launchd --------------------------------------------------------------

  await check("FLUME_HOST_PLATFORM is the platform seam; only darwin is a launchd host", () => {
    assert.equal(hostPlatform({ FLUME_HOST_PLATFORM: "darwin" }), "darwin");
    assert.equal(hostPlatform({ FLUME_HOST_PLATFORM: "  " }), process.platform);
    assert.equal(hostPlatform({}), process.platform);
    assert.equal(isLaunchdHost("darwin"), true);
    assert.equal(isLaunchdHost("linux"), false);
    assert.equal(launchdGatewayTarget(501), `gui/501/${LAUNCHD_GATEWAY_LABEL}`);
  });

  await check("launchctl print is classified by its top-level state, never a nested one", () => {
    const target = "gui/501/ai.hermes.gateway";
    const running = parseLaunchctlPrint({ status: 0, stderr: "", stdout: `${target} = {\n\tactive count = 1\n\tpath = /Users/d/Library/LaunchAgents/ai.hermes.gateway.plist\n\tendpoints = {\n\t\t"x" = {\n\t\t\tstate = idle\n\t\t}\n\t}\n\tstate = running\n\tpid = 4242\n}\n` }, target);
    assert.deepEqual({ state: running.state, word: running.word, pid: running.pid }, { state: "running", word: "running", pid: 4242 });
    const stopped = parseLaunchctlPrint({ status: 0, stderr: "", stdout: `${target} = {\n\tstate = not running\n\tlast exit code = 1\n}\n` }, target);
    assert.equal(stopped.state, "stopped");
    assert.match(stopped.detail, /launchctl kickstart -k gui\/501\/ai\.hermes\.gateway/u);
    const absent = parseLaunchctlPrint({ status: 113, stdout: "", stderr: 'Could not find service "ai.hermes.gateway" in domain for port\n' }, target);
    assert.equal(absent.state, "not-loaded");
    assert.match(absent.detail, /hermes gateway install/u);
    assert.equal(parseLaunchctlPrint({ status: null, stdout: "", stderr: "", error: "ENOENT" }, target).state, "unobservable");
    assert.equal(parseLaunchctlPrint({ status: 5, stdout: "", stderr: "boom" }, target).state, "unobservable");
  });

  await check("the template's shell libraries never get /bin/bash 3.2 on a launchd host", () => {
    assert.equal(modernBash({ PATH: "/nonexistent" }, "linux"), "bash", "Linux spawns plain bash exactly as before");
    const oldBash = bin("bash-3", { bash: "#!/bin/sh\nprintf '3.2'\n" });
    const newBash = bin("bash-5", { bash: "#!/bin/sh\nprintf '5.2'\n" });
    assert.equal(modernBash({ PATH: `${oldBash}${delimiter}${newBash}` }, "darwin"), join(newBash, "bash"));
    if (!["/opt/homebrew/bin/bash", "/usr/local/bin/bash"].some((path) => existsSync(path))) {
      assert.throws(() => modernBash({ PATH: oldBash }, "darwin"), /bash >= 4\.4.*3\.2.*brew install bash/su);
    }
  });

  await check("every registry reader resolves the same path: env, then HERMES_FLEET_HOME, then ~/.hermes", () => {
    assert.equal(resolveAgentRegistryPath({}, "/h"), "/h/.hermes/agents-registry.yaml");
    assert.equal(resolveAgentRegistryPath({ HERMES_FLEET_HOME: "/f" }, "/h"), "/f/agents-registry.yaml");
    assert.equal(resolveAgentRegistryPath({ HERMES_FLEET_HOME: "/f", HERMES_FLEET_REGISTRY_FILE: "/r2" }, "/h"), "/r2");
    assert.equal(resolveAgentRegistryPath({ HERMES_AGENTS_REGISTRY: "/r1", HERMES_FLEET_REGISTRY_FILE: "/r2" }, "/h"), "/r1");
    assert.equal(resolveAgentRegistryPath({ HERMES_AGENTS_REGISTRY: " " }, "/h"), "/h/.hermes/agents-registry.yaml", "blank is unset");
    assert.equal(resolveFleetHomeDir({ HERMES_FLEET_HOME: "/f" }, "/h"), "/f");
  });

  // -- the CLI on a simulated Mac -----------------------------------------------------------------

  const gitIsolation = { GIT_CEILING_DIRECTORIES: work, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const run = (args, cwd, env = {}) => spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", COLUMNS: "0", ...gitIsolation, ...env },
  });
  const systemctlLog = join(work, "systemctl.log");
  const recorder = bin("systemctl-recorder", { systemctl: `#!/bin/sh\necho "$@" >> "${systemctlLog}"\nexit 1\n` });
  const launchctl = {
    running: bin("launchctl-running", { launchctl: "#!/bin/sh\n[ \"$1\" = print ] || exit 64\nprintf '%s = {\\n\\tstate = running\\n\\tpid = 4242\\n}\\n' \"$2\"\n" }),
    stopped: bin("launchctl-stopped", { launchctl: "#!/bin/sh\nprintf '%s = {\\n\\tstate = not running\\n}\\n' \"$2\"\n" }),
    absent: bin("launchctl-absent", { launchctl: "#!/bin/sh\necho 'Could not find service \"ai.hermes.gateway\" in domain for port' >&2\nexit 113\n" }),
    broken: bin("launchctl-broken", { launchctl: "#!/bin/sh\necho 'launchctl: internal error' >&2\nexit 5\n" }),
    // Installed over SSH / a Background session: Hermes put the job in user/<uid>, not gui/<uid>.
    userDomain: bin("launchctl-user-domain", { launchctl: "#!/bin/sh\ncase \"$2\" in user/*) printf '%s = {\\n\\tstate = running\\n\\tpid = 4343\\n}\\n' \"$2\" ;; *) echo 'Could not find service \"ai.hermes.gateway\" in domain for user gui: 501' >&2; exit 113 ;; esac\n" }),
  };

  const repo = join(work, "mac-repo");
  mkdirSync(join(repo, "agents", "hermes", "pm"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "--quiet", "--initial-branch=main", "--template=", repo], { env: { ...process.env, ...gitIsolation } }).status, 0);
  // What a hire on a launchd host records: systemd deferred (there is none), the gateway not deferred.
  writeFileSync(join(repo, "agents", "hermes", "pm", "role.yaml"), "repo: mac-repo\nrole: pm\nagent_id: mac-repo-pm\ndeployment:\n  systemd: deferred\nservice_state:\n  gateway: installed\n");
  const macHome = join(work, "mac-home");
  mkdirSync(macHome, { recursive: true });
  const macEnv = (launchd) => ({ HOME: macHome, FLUME_HOST_PLATFORM: "darwin", PATH: `${launchd}${delimiter}${recorder}${delimiter}${process.env.PATH}` });
  const sentinel = (result) => {
    const report = JSON.parse(result.stdout);
    const finding = report.rules.find((rule) => rule.id === "systemd.sentinel");
    assert.ok(finding, `audit must report systemd.sentinel: ${result.stderr}`);
    return finding;
  };

  await check("systemd.sentinel on a launchd host is decided by ai.hermes.gateway and never spawns systemctl", () => {
    writeFileSync(systemctlLog, "");
    const cases = [
      [launchctl.running, "pass", /launchd gateway ai\.hermes\.gateway is running and serves 1 role\(s\) \(mac-repo-pm\)/u],
      [launchctl.stopped, "fail", /is not running, so 1 role\(s\)/u],
      [launchctl.absent, "fail", /is not-loaded/u],
      [launchctl.broken, "skip", /unable to assess on a launchd host/u],
      [launchctl.userDomain, "pass", /launchd gateway ai\.hermes\.gateway is running and serves 1 role\(s\) \(mac-repo-pm\)/u],
    ];
    for (const [launchd, status, summary] of cases) {
      const finding = sentinel(run(["audit", repo, "--json", "--rules", "systemd.sentinel"], repo, macEnv(launchd)));
      assert.equal(finding.status, status, JSON.stringify(finding));
      assert.match(finding.summary, summary);
      assert.match(finding.details.join("\n"), /per-agent systemd units are not observable on a launchd host/u);
      assert.equal(finding.fixable, false);
    }
    const absent = sentinel(run(["audit", repo, "--json", "--rules", "systemd.sentinel"], repo, macEnv(launchctl.absent)));
    assert.match(absent.details.join("\n"), /hermes gateway install installs and starts the LaunchAgent ai\.hermes\.gateway/u);
    assert.equal(readFileSync(systemctlLog, "utf8"), "", "no systemctl child on a launchd host");
  });

  await check("remediating systemd.sentinel on a launchd host writes nothing and names hermes gateway install", () => {
    writeFileSync(systemctlLog, "");
    const before = readFileSync(join(repo, "agents", "hermes", "pm", "role.yaml"), "utf8");
    const blocked = run(["remediate", "systemd.sentinel", repo, "--json"], repo, macEnv(launchctl.absent));
    const result = JSON.parse(blocked.stdout).results.find((entry) => entry.id === "systemd.sentinel");
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.deepEqual(result.changedFiles, []);
    assert.match(result.details.join("\n"), /hermes gateway install/u);
    const healthy = run(["remediate", "systemd.sentinel", repo, "--json"], repo, macEnv(launchctl.running));
    assert.equal(JSON.parse(healthy.stdout).results.find((entry) => entry.id === "systemd.sentinel").status, "noop");
    assert.equal(readFileSync(join(repo, "agents", "hermes", "pm", "role.yaml"), "utf8"), before);
    assert.equal(readFileSync(systemctlLog, "utf8"), "", "no systemctl child on a launchd host");
  });

  await check("the same repository on Linux still reads its deferred systemd declaration exactly as before", () => {
    const finding = sentinel(run(["audit", repo, "--json", "--rules", "systemd.sentinel"], repo, { HOME: macHome, PATH: `${recorder}${delimiter}${process.env.PATH}` }));
    assert.equal(finding.status, "pass");
    assert.equal(finding.summary, "systemd is intentionally deferred for every local-only Hermes role");
  });

  await check("flume review --domain systemd on a launchd host reads ai.hermes.gateway: unable to assess, never an error", () => {
    const fleet = join(work, "review-fleet");
    mkdirSync(join(fleet, "profiles"), { recursive: true });
    writeFileSync(join(fleet, "agents-registry.yaml"), YAML.stringify({ schema_version: 1, agents: { "alpha-pm": { profile_name: "alpha-pm" } } }));
    writeFileSync(join(work, "review-projects.yaml"), "schema_version: 1\nprojects: {}\n");
    writeFileSync(systemctlLog, "");
    const review = (launchd) => JSON.parse(run(["review", "--domain", "systemd", "--json"], work, {
      HOME: join(work, "review-home"), HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: join(fleet, "agents-registry.yaml"),
      HERMES_FLEET_REGISTRY_FILE: join(fleet, "agents-registry.yaml"), HERMES_FLEET_ENV: join(work, "no-such-fleet.env"),
      PJ_PROJECT_REGISTRY: join(work, "review-projects.yaml"), FLUME_HOST_PLATFORM: "darwin",
      PATH: `${launchd}${delimiter}${recorder}${delimiter}${process.env.PATH}`,
    }).stdout);
    const up = review(launchctl.running);
    assert.equal(up.ok, true, JSON.stringify(up.error));
    assert.deepEqual({ code: up.data.systemd.manager.code, state: up.data.systemd.manager.state }, { code: "launchd-host", state: "running" });
    const host = (data, id) => data.data.host.find((finding) => finding.rule_id === id);
    assert.equal(host(up, "systemd.manager").state, "pass");
    assert.equal(host(up, "systemd.shared-gateway").state, "unsupported");
    const leaves = up.data.agents.find((agent) => agent.agent_id === "alpha-pm").observations.filter((item) => item.source === "fleet-systemd");
    assert.equal(leaves.length, 2);
    for (const leaf of leaves) {
      assert.equal(leaf.state, "unsupported", "unable to assess, not a failure and not a pass");
      assert.deepEqual(leaf.items.map((item) => item.kind), ["launchd-host"]);
    }
    assert.equal(up.data.health.errors, 0);
    assert.equal(up.data.health.verdict, "unproven", "a Mac's systemd domain cannot claim proof");
    const down = review(launchctl.absent);
    assert.equal(host(down, "systemd.manager").state, "fail");
    const user = review(launchctl.userDomain);
    assert.equal(user.data.systemd.manager.state, "running", "a gateway Hermes loaded into user/<uid> is found");
    assert.equal(host(user, "systemd.manager").state, "pass");
    assert.equal(host(review(launchctl.broken), "systemd.manager").state, "unsupported");
    assert.equal(readFileSync(systemctlLog, "utf8"), "", "no systemctl child on a launchd host");
  });

  await check("offboard reads the registry under HERMES_FLEET_HOME and says what a launchd gateway still serves", () => {
    const fleet = join(work, "offboard-fleet");
    mkdirSync(join(fleet, "profiles", "mac-repo-pm"), { recursive: true });
    writeFileSync(join(fleet, "agents-registry.yaml"), YAML.stringify({ schema_version: 1, agents: { "mac-repo-pm": { profile_name: "mac-repo-pm" } } }));
    const env = { HOME: join(work, "offboard-home"), HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: "", HERMES_FLEET_REGISTRY_FILE: "" };
    const mac = JSON.parse(run(["offboard", "mac-repo-pm", "--json"], work, { ...env, FLUME_HOST_PLATFORM: "darwin" }).stdout);
    assert.equal(mac.ok, true, JSON.stringify(mac));
    assert.equal(mac.registryPath, join(fleet, "agents-registry.yaml"));
    assert.ok(mac.leftBehind.some((item) => item.startsWith(`desk ${join(fleet, "profiles", "mac-repo-pm")}`)), JSON.stringify(mac.leftBehind));
    assert.ok(mac.leftBehind.some((item) => /not observable on a launchd host.*ai\.hermes\.gateway/u.test(item)), JSON.stringify(mac.leftBehind));
    const linux = JSON.parse(run(["offboard", "mac-repo-pm", "--json"], work, env).stdout);
    assert.equal(linux.leftBehind.some((item) => /launchd/u.test(item)), false);
  });

  await check("hire on a launchd host defers to hermes gateway install instead of deferring silently", () => {
    const hireRepo = join(work, "hire-repo");
    mkdirSync(hireRepo, { recursive: true });
    assert.equal(spawnSync("git", ["init", "--quiet", "--initial-branch=main", "--template=", hireRepo], { env: { ...process.env, ...gitIsolation } }).status, 0);
    const copier = bin("copier-refuses", { copier: "#!/bin/sh\nexit 91\n" });
    const env = { HOME: join(work, "hire-home"), XDG_CONFIG_HOME: join(work, "hire-xdg"), PATH: `${copier}${delimiter}${process.env.PATH}`, PJANGLER_HERMES_TEMPLATE: "" };
    const mac = run(["hire", "--yes", "--dry-run"], hireRepo, { ...env, FLUME_HOST_PLATFORM: "darwin" });
    assert.equal(mac.status, 0, `${mac.stdout}\n${mac.stderr}`);
    assert.match(mac.stdout, /deferred: .*launchd gateway activation \(run hermes gateway install: one multiplexed ai\.hermes\.gateway serves every profile\)/u);
    assert.match(mac.stdout, /^next: hermes gateway install {2}\(installs and starts the LaunchAgent ai\.hermes\.gateway; check it with launchctl print gui\/\d+\/ai\.hermes\.gateway\)$/mu);
    assert.doesNotMatch(mac.stdout, /systemd service activation/u);
    const linux = run(["hire", "--yes", "--dry-run"], hireRepo, env);
    assert.equal(linux.status, 0, `${linux.stdout}\n${linux.stderr}`);
    assert.doesNotMatch(linux.stdout, /launchd|hermes gateway install/u);
    assert.equal(existsSync(join(hireRepo, "agents")), false, "a dry run renders nothing");
  });

  console.log(`\n${count} macOS portability checks passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
