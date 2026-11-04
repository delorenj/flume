// hermes.skillex-resync: the guard on the Skillex-only desk auto-resync.
//
// A strict desk's Skillex receipt records the all-skills commit it was synced
// against, so every catalog commit leaves every strict desk "sync pending". A
// systemd user path unit on the catalog HEAD and the `skillex-hermes-resync`
// Candybar (the single 15-minute clock; the .timer is retired) run skillex's
// hermes-skillex-resync.py, which records each real run in
// $XDG_STATE_HOME/skillex/hermes-resync.last.json. Nothing else notices when the
// unit or the Candybar is gone, a path unit tripped its trigger limit, the runs
// stopped, or a desk is refused, so this rule does.
//
// The Candybar API is a stub HTTP server on an ephemeral loopback port
// (CANDYBAR_API_URL); the live API at 127.0.0.1:8700 is never read.
//
// Everything here runs against a scratch fleet, a scratch state directory and
// the scripted systemd user manager every fleet suite uses
// (tests/helpers/fake-systemctl.mjs). No live unit, desk or record is read.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeSystemctlInvocations, fakeSystemctlVerbs, installFakeSystemctl, noBusIsolation, setFakeSystemctlState } from "./helpers/fake-systemctl.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const RULE = "hermes.skillex-resync";
const TIMER = "skillex-hermes-resync.timer";
const CANDYBAR = "skillex-hermes-resync";
const PATH_UNIT = "skillex-hermes-resync.path";
const INSTALL = "~/code/skillex/scripts/install-hermes-resync.sh install";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const scratchRoots = [];
after(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

/** A repository with one Hermes role: all discoverRoles() needs to run the rule. */
function makeRepo(dir) {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "agents", "hermes", "pm"), { recursive: true });
  writeFileSync(join(repo, "agents", "hermes", "pm", "role.yaml"), "repo: demo\nrole: pm\nagent_id: demo-pm\nprofile: demo-pm\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

/**
 * Every `systemctl` call that names a resync unit. `flume audit --rules X` runs
 * the whole audit and filters the report, so the log also holds the other rules'
 * calls; this is the slice that belongs to hermes.skillex-resync.
 */
const resyncCalls = (bin) => fakeSystemctlInvocations(bin).filter((argv) => argv.some((token) => token.includes("skillex-hermes-resync")));
const verbOf = (argv) => argv.filter((token) => !token.startsWith("-"))[0];

/** An ISO-UTC instant the way the resync script writes one (whole seconds, Z). */
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/u, "Z");

const unit = (name, over = {}) => ({
  Id: name,
  LoadState: "loaded",
  UnitFileState: "enabled",
  ActiveState: "active",
  SubState: "waiting",
  Result: "success",
  ...over,
});

/** The healthy path unit: installed, enabled, active. A unit left out reads `not-found`, like a real one. */
const HEALTHY_UNITS = { [PATH_UNIT]: unit(PATH_UNIT) };

/** What `GET /candybars` answers for a healthy resync: registered and enabled. */
const HEALTHY_CANDYBARS = [{ name: CANDYBAR, enabled: true, schedule: "*/15 * * * *" }, { name: "unrelated", enabled: false }];

/** One request-scoped stub of the Candybar API. `null` stands for an API that is down. */
async function withCandybarApi(candybars, fn) {
  if (candybars === null) return fn("http://127.0.0.1:1");
  const server = createServer((request, response) => {
    if (request.url === "/candybars") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(candybars));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

/** spawnSync's twin: the stub server lives in this process, so the CLI must not block it. */
function spawnAsync(command, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
}

const deskRecord = (desk, over = {}) => ({
  event: "desk",
  desk,
  project: `/work/${desk}`,
  status: "ok",
  show_exit: 0,
  ...over,
});

/** `hermes-resync.last.json`, schema 1, as a clean run writes it. */
function runRecord(over = {}) {
  return {
    schema: 1,
    event: "run",
    run_id: "20261002T120000Z-fixture",
    started_at: iso(11 * MINUTE),
    finished_at: iso(10 * MINUTE),
    duration_ms: 8000,
    trigger: "systemd",
    dry_run: false,
    status: "ok",
    exit: 0,
    counts: { total: 2, ok: 2, synced: 0, would_sync: 0, refused: 0, error: 0, busy: 0 },
    attention: [],
    message: "hermes-skillex-resync: ok - 2 strict desks (2 current), catalog abc1234, 1 pass, 8.0s",
    results: [deskRecord("alpha-pm"), deskRecord("beta-pm")],
    ...over,
  };
}

/**
 * One scenario: a fleet with strict desks, a state directory, a repo and a
 * scripted user manager. `record: null` leaves no last-run file at all.
 */
function scenario({ desks = ["alpha-pm", "beta-pm"], units = HEALTHY_UNITS, record = runRecord(), recordText = null, withSystemctl = true, candybars = HEALTHY_CANDYBARS } = {}) {
  const dir = scratch("flume-skillex-resync-");
  const home = join(dir, "home");
  const fleet = join(home, ".hermes");
  const state = join(home, ".local", "state");
  mkdirSync(join(fleet, "profiles"), { recursive: true });
  for (const desk of desks) {
    mkdirSync(join(fleet, "profiles", desk), { recursive: true });
    writeFileSync(join(fleet, "profiles", desk, ".skillex-only"), "Skillex owns this desk's skill projection.\n");
  }
  const recordPath = join(state, "skillex", "hermes-resync.last.json");
  const writeRecord = (value, text = null) => {
    mkdirSync(join(state, "skillex"), { recursive: true });
    writeFileSync(recordPath, text ?? `${JSON.stringify(value, null, 2)}\n`);
  };
  if (record !== null || recordText !== null) writeRecord(record, recordText);

  // PATH is a directory of exactly what the audit needs, so a case can omit systemctl.
  const bin = join(dir, "bin");
  if (withSystemctl) {
    installFakeSystemctl(bin, { manager: { stdout: "running", exit: 0 }, units, list_units: [], unit_files: [] });
  } else {
    mkdirSync(bin, { recursive: true });
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(realGit, join(bin, "git"));
  }
  const repo = makeRepo(dir);
  const env = {
    ...process.env,
    HOME: home,
    HERMES_FLEET_HOME: fleet,
    XDG_STATE_HOME: state,
    PATH: bin,
    NO_COLOR: "1",
    ...noBusIsolation(dir),
  };
  const runWith = (extraEnv, ...args) => withCandybarApi(candybars, (api) => spawnAsync(process.execPath, [cli, ...args], { cwd: repo, env: { ...env, CANDYBAR_API_URL: api, ...extraEnv } }));
  const run = (...args) => runWith({}, ...args);
  const audit = async (extraEnv = {}) => {
    const result = await runWith(extraEnv, "audit", "--rules", RULE, "--json");
    const finding = JSON.parse(result.stdout).rules.find((rule) => rule.id === RULE);
    assert.ok(finding, `${RULE} must be reported:\n${result.stdout}${result.stderr}`);
    return { ...finding, text: [finding.summary, ...finding.details].join("\n") };
  };
  return {
    dir, home, fleet, state, recordPath, bin, env, run, runWith, audit, writeRecord,
    setUnits: (next) => setFakeSystemctlState(bin, { manager: { stdout: "running", exit: 0 }, units: next, list_units: [], unit_files: [] }),
  };
}

test("a healthy auto-resync passes quietly", async () => {
  const f = await scenario().audit();
  assert.equal(f.status, "pass", f.text);
  assert.deepEqual(f.details, [], "a pass carries no detail");
  assert.equal(f.scope, "host", "it is machine state, not something the audited repo can fix");
  assert.equal(f.fixable, false);
  assert.match(f.summary, /^2 Skillex-only desk\(s\) resync automatically \(path unit active, candybar skillex-hermes-resync enabled, last run ok 1[01] min ago\)$/u);
});

test("it reads the units with one read-only show each", async () => {
  const s = scenario();
  assert.equal((await s.audit()).status, "pass");
  const calls = resyncCalls(s.bin);
  assert.equal(calls.length, 1, `one call, for the path unit (saw ${JSON.stringify(calls)})`);
  assert.deepEqual(calls.map(verbOf), ["show"], "and the verb is a read");
  const named = calls.map((argv) => argv.find((token) => token.startsWith("skillex-hermes-resync")));
  assert.deepEqual(named, [PATH_UNIT], "the retired timer is never asked about: the Candybar is the clock");
});

test("a partial run (a desk was busy) is clean: the next run retries it", async () => {
  const record = runRecord({
    status: "partial",
    counts: { total: 2, ok: 1, synced: 0, would_sync: 0, refused: 0, error: 0, busy: 1 },
    results: [deskRecord("alpha-pm"), deskRecord("beta-pm", { status: "busy", show_exit: 5 })],
  });
  const f = await scenario({ record }).audit();
  assert.equal(f.status, "pass", f.text);
  assert.match(f.summary, /last run partial 1[01] min ago/u);
});

test("no Skillex-only desk means nothing to resync, whatever the host looks like", async () => {
  // A legacy desk (no marker), one mid-cutover (a directory where the marker
  // goes) and a symlinked desk are none of them strict, so the resync skips
  // them and so does this rule. No units, no record: still a quiet pass.
  const s = scenario({ desks: [], units: {}, record: null });
  mkdirSync(join(s.fleet, "profiles", "legacy-pm"), { recursive: true });
  mkdirSync(join(s.fleet, "profiles", "half-pm", ".skillex-only"), { recursive: true });
  const real = join(s.dir, "elsewhere");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, ".skillex-only"), "marker behind a link\n");
  symlinkSync(real, join(s.fleet, "profiles", "linked-pm"));
  const f = await s.audit();
  assert.equal(f.status, "pass", f.text);
  assert.match(f.summary, /^No Skillex-only desk exists, so there is nothing to resync$/u);
  assert.deepEqual(f.details, []);
  assert.deepEqual(resyncCalls(s.bin), [], "no desk, so systemd is never asked about the resync units");
});

test("a repository with no Hermes role skips, like every host rule", async () => {
  const s = scenario();
  rmSync(join(s.dir, "repo", "agents"), { recursive: true, force: true });
  assert.equal((await s.audit()).status, "skip");
});

test("units that are not installed fail and name the install command", async () => {
  const f = await scenario({ units: {} }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.equal(f.fixable, false);
  assert.ok(!f.text.includes(TIMER), "the retired timer is not required");
  assert.ok(f.details.includes(`${PATH_UNIT} is not installed (LoadState=not-found)`), f.text);
  assert.ok(f.summary.includes(INSTALL), "the summary an operator reads in the banner names the fix");
  assert.ok(f.details.some((line) => line.startsWith(INSTALL) && /resets a failed unit/u.test(line)), "so does a detail line, with what it does");
  assert.match(f.text, /install-hermes-resync\.sh status/u, "and how to look at the result");
});

test("an installed but disabled unit fails and says so", async () => {
  const f = await scenario({ units: { [PATH_UNIT]: unit(PATH_UNIT, { UnitFileState: "disabled", ActiveState: "inactive", SubState: "dead" }) } }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.ok(f.details.includes(`${PATH_UNIT} is installed but not enabled (UnitFileState=disabled) and is not active (ActiveState=inactive, SubState=dead)`), f.text);
  assert.ok(!f.text.includes("candybar"), "the healthy Candybar is not blamed, in the detail or the summary");
  assert.ok(f.summary.includes(INSTALL));
});

test("a path unit that tripped its trigger limit has failed and stopped watching", async () => {
  const tripped = unit(PATH_UNIT, { ActiveState: "failed", SubState: "failed", Result: "trigger-limit-hit" });
  const f = await scenario({ units: { [PATH_UNIT]: tripped } }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.ok(f.details.includes(`${PATH_UNIT} has failed (Result=trigger-limit-hit) and no longer starts the resync`), f.text);
  assert.ok(f.summary.includes(INSTALL), "install resets a failed unit, so it is the fix here too");
});

test("an enabled unit that is not running fails", async () => {
  const f = await scenario({ units: { [PATH_UNIT]: unit(PATH_UNIT, { ActiveState: "inactive", SubState: "dead" }) } }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.ok(f.details.includes(`${PATH_UNIT} is not active (ActiveState=inactive, SubState=dead)`), f.text);
});

test("a masked or unloadable unit fails", async () => {
  const f = await scenario({ units: { [PATH_UNIT]: unit(PATH_UNIT, { LoadState: "masked", UnitFileState: "masked", ActiveState: "inactive" }) } }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.ok(f.details.includes(`${PATH_UNIT} cannot be loaded (LoadState=masked)`), f.text);
});

test("no recorded run fails even with healthy units", async () => {
  const f = await scenario({ record: null }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.match(f.summary, /no resync run is recorded/u);
  assert.match(f.text, /hermes-resync\.last\.json: no resync run is recorded, so no desk has ever been synced automatically/u);
  assert.ok(f.text.includes(INSTALL), "it names the install command, which also starts a run");
  assert.ok(!/units are not/u.test(f.text), "the units are fine, so they are not blamed");
});

test("the last run is stale past two hours, not before", async () => {
  const stale = await scenario({ record: runRecord({ finished_at: iso(2 * HOUR + MINUTE) }) }).audit();
  assert.equal(stale.status, "fail", stale.text);
  assert.match(stale.summary, /the last run finished 2 h [1-5] min ago \(limit 2 h\)/u);
  assert.match(stale.text, /over the 2 h limit; the Candybar is not firing or no run completes/u);
  assert.match(stale.text, /journalctl --user -u skillex-hermes-resync\.service/u, "it says where to look");
  assert.match(stale.text, /hermes-skillex-resync\.py runs one now/u, "and how to run one");

  const recent = await scenario({ record: runRecord({ finished_at: iso(2 * HOUR - MINUTE) }) }).audit();
  assert.equal(recent.status, "pass", recent.text);
  assert.match(recent.summary, /last run ok 1 h (59|58) min ago/u);
});

test("a desk the resync refused fails and names the cutover", async () => {
  const record = runRecord({
    status: "attention",
    exit: 1,
    counts: { total: 2, ok: 1, synced: 0, would_sync: 0, refused: 1, error: 0, busy: 0 },
    attention: ["beta-pm"],
    results: [
      deskRecord("alpha-pm"),
      deskRecord("beta-pm", {
        project: "/work/beta",
        status: "refused",
        show_exit: 3,
        reason: "foreign entries in a strict desk",
        findings: [{ code: "E_PROFILE_SKILLEX_ONLY", severity: "error", message: "unowned entry .hub", path: "/fleet/profiles/beta-pm/skills/.hub" }],
      }),
    ],
  });
  const f = await scenario({ record }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.match(f.summary, /the last run could not converge 1 desk\(s\)/u);
  const line = f.details.find((detail) => detail.startsWith("beta-pm: refused by the resync"));
  assert.ok(line, f.text);
  assert.match(line, /\(foreign entries in a strict desk; \/fleet\/profiles\/beta-pm\/skills\/\.hub\)/u);
  assert.match(line, /only a cutover clears it: preview python3 ~\/code\/skillex\/scripts\/hermes-skillex-cutover\.py --profile beta-pm --project \/work\/beta /u, "the recorded project, not a guess");
  assert.match(line, /then rerun with --apply; then run python3 ~\/code\/skillex\/scripts\/hermes-skillex-resync\.py/u);
  assert.ok(!f.text.includes("alpha-pm"), "a converged desk is not blamed");
  assert.ok(!/the last run ended attention/u.test(f.text), "the desks already explain the status, so it is not said twice");
});

test("a desk that errored fails and names the journal", async () => {
  const record = runRecord({
    status: "attention",
    exit: 1,
    attention: ["alpha-pm"],
    results: [deskRecord("alpha-pm", { status: "error", show_exit: 1, reason: "skillex timed out after 60s" }), deskRecord("beta-pm")],
  });
  const f = await scenario({ record }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.ok(f.details.includes("alpha-pm: the resync errored (skillex timed out after 60s); read journalctl --user -u skillex-hermes-resync.service -n 20 --no-pager, then run python3 ~/code/skillex/scripts/hermes-skillex-resync.py --profile alpha-pm"), f.text);
});

test("an attention name no desk record explains is still reported", async () => {
  const f = await scenario({ record: runRecord({ status: "attention", exit: 1, attention: ["gamma-pm"], results: [] }) }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.ok(f.details.some((line) => line.startsWith("gamma-pm: the last run lists it as needing a human")), f.text);
});

test("many unconverged desks are capped, with a count for the rest", async () => {
  const names = Array.from({ length: 8 }, (_, index) => `desk${index}-pm`);
  const record = runRecord({
    status: "attention",
    exit: 1,
    attention: names,
    results: names.map((name) => deskRecord(name, { status: "refused", show_exit: 3, reason: "foreign" })),
  });
  const f = await scenario({ desks: names, record }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.match(f.summary, /the last run could not converge 8 desk\(s\)/u);
  assert.equal(f.details.filter((line) => /refused by the resync/u.test(line)).length, 5);
  assert.ok(f.details.some((line) => /^\+3 more desk\(s\) the last run could not converge/u.test(line)), f.text);
});

test("a run that could not start fails with the reason it recorded", async () => {
  const record = runRecord({ status: "error", exit: 2, message: "hermes-skillex-resync: no usable skillex binary", counts: { total: 0, ok: 0, synced: 0, would_sync: 0, refused: 0, error: 0, busy: 0 }, results: [] });
  const f = await scenario({ record }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.match(f.summary, /the last run ended error/u);
  assert.match(f.text, /the last run ended error \(exit 2\): hermes-skillex-resync: no usable skillex binary; read journalctl/u);
});

test("an unreadable record fails; a record of an unknown schema only warns", async () => {
  const broken = await scenario({ record: null, recordText: "{ not json" }).audit();
  assert.equal(broken.status, "fail", broken.text);
  assert.match(broken.summary, /the last-run record is unreadable/u);
  assert.match(broken.text, /invalid JSON/u);

  const noTime = await scenario({ record: runRecord({ finished_at: "yesterday-ish" }) }).audit();
  assert.equal(noTime.status, "fail", noTime.text);
  assert.match(noTime.text, /finished_at is missing or not a timestamp/u);

  // A record this rule cannot read proves nothing either way: unable to assess.
  const future = await scenario({ record: runRecord({ schema: 2 }) }).audit();
  assert.equal(future.status, "warn", future.text);
  assert.match(future.text, /schema 2 is not the one this rule reads \(1\)/u);
});

test("an unreachable user manager is unable to assess, not a failure", async () => {
  // No systemctl on PATH at all: the observer cannot see the units. With a
  // clean, recent record that is a warning, never a pass and never a fail.
  // (Before systemctlUser tolerated a spawn that never started, this crashed
  // the WHOLE audit: `result.stdout` is null when the binary is missing.)
  const f = await scenario({ withSystemctl: false }).audit();
  assert.equal(f.status, "warn", f.text);
  assert.match(f.summary, /could not be fully assessed/u);
  assert.match(f.text, /systemctl --user show skillex-hermes-resync\.path failed/u);
});

test("an unreachable user manager does not hide a stale record", async () => {
  const f = await scenario({ withSystemctl: false, record: runRecord({ finished_at: iso(3 * HOUR) }) }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.match(f.summary, /the last run finished 3 h( [1-5] min)? ago/u);
});

test("every problem is reported in one finding", async () => {
  const f = await scenario({ units: {}, record: runRecord({ finished_at: iso(5 * HOUR) }) }).audit();
  assert.equal(f.status, "fail", f.text);
  assert.match(f.summary, /^2 Skillex-only desk\(s\) are not kept in sync automatically: skillex-hermes-resync\.path must be installed, enabled and active \(run .*\); the last run finished 5 h( [1-5] min)? ago \(limit 2 h\)$/u);
});

test("the schedule is the Candybar: unregistered, disabled or unreachable is not a pass", async () => {
  const unregistered = await scenario({ candybars: [{ name: "unrelated", enabled: true }] }).audit();
  assert.equal(unregistered.status, "fail", unregistered.text);
  assert.ok(unregistered.details.some((line) => line.startsWith(`candybar ${CANDYBAR} is not registered`)), unregistered.text);
  assert.match(unregistered.summary, /candybar skillex-hermes-resync must be registered and enabled/u);

  const disabled = await scenario({ candybars: [{ name: CANDYBAR, enabled: false }] }).audit();
  assert.equal(disabled.status, "fail", disabled.text);
  assert.ok(disabled.details.some((line) => line.startsWith(`candybar ${CANDYBAR} is registered but not enabled`)), disabled.text);

  // The API being down says nothing about the schedule: unable to assess, never a fail.
  const down = await scenario({ candybars: null }).audit();
  assert.equal(down.status, "warn", down.text);
  assert.ok(down.details.some((line) => /GET http:\/\/127\.0\.0\.1:1\/candybars failed/u.test(line)), down.text);
});

test("the retired timer is neither required nor consulted", async () => {
  const s = scenario({ units: { [PATH_UNIT]: unit(PATH_UNIT) } });
  const f = await s.audit();
  assert.equal(f.status, "pass", f.text);
  assert.ok(!resyncCalls(s.bin).some((argv) => argv.includes(TIMER)), "no systemctl call names the timer");
});

test("the record is found under XDG_STATE_HOME, else under ~/.local/state", async () => {
  const s = scenario();
  // XDG_STATE_HOME points somewhere with no record: the one under HOME is not consulted.
  const elsewhere = join(s.dir, "elsewhere-state");
  mkdirSync(elsewhere, { recursive: true });
  const moved = await s.runWith({ XDG_STATE_HOME: elsewhere }, "audit", "--rules", RULE, "--json");
  const movedFinding = JSON.parse(moved.stdout).rules.find((rule) => rule.id === RULE);
  assert.equal(movedFinding.status, "fail");
  assert.match(movedFinding.summary, /no resync run is recorded/u);
  assert.ok(movedFinding.details.some((line) => line.startsWith(join(elsewhere, "skillex"))), "the path it names is the one it read");

  // XDG_STATE_HOME unset: ~/.local/state, which is where the script defaults.
  const fallback = await s.runWith({ XDG_STATE_HOME: "" }, "audit", "--rules", RULE, "--json");
  assert.equal(JSON.parse(fallback.stdout).rules.find((rule) => rule.id === RULE).status, "pass");
});

test("remediation is blocked with the install command, and writes nothing", async () => {
  const s = scenario({ units: {} });
  const before = readFileSync(s.recordPath, "utf8");
  const result = await s.run("remediate", RULE, "--json");
  const report = JSON.parse(result.stdout);
  const outcome = report.results.find((item) => item.id === RULE);
  assert.ok(outcome, result.stdout + result.stderr);
  assert.equal(outcome.status, "blocked");
  assert.ok(outcome.details.some((line) => line.includes(INSTALL)), "the operator is told what to run");
  assert.deepEqual([...new Set(resyncCalls(s.bin).map(verbOf))], ["show"], "flume does not enable, start or reset a unit for this rule");
  assert.ok(!fakeSystemctlVerbs(s.bin).some((verb) => ["enable", "disable", "start", "stop", "restart", "reset-failed", "daemon-reload", "link"].includes(verb)), "nor any other verb that writes");
  assert.equal(readFileSync(s.recordPath, "utf8"), before, "and does not touch the record");
});

test("remediation of a healthy auto-resync is a no-op", async () => {
  const s = scenario();
  const report = JSON.parse((await s.run("remediate", RULE, "--json")).stdout);
  assert.equal(report.results.find((item) => item.id === RULE).status, "noop");
});

test("the rule is registered where its siblings are", async () => {
  const contract = JSON.parse(readFileSync(join(root, "skills", "agent-fleet-operations", "references", "pm-deployment-contract.json"), "utf8"));
  assert.ok(contract.employee_rule_ids.includes(RULE), "pm-deployment-contract.json employee_rule_ids");
  assert.ok(contract.employee_rule_ids.includes("hermes.wake-word-session"), "sanity: the sibling is there too");

  // A rule with no domain is reported as `audit-rule-unmapped` in fleet status.
  const status = readFileSync(join(root, "packages", "flume-hr", "src", "org", "status.ts"), "utf8");
  assert.match(status, /"hermes\.skillex-resync":\s*"profile"/u, "RULE_DOMAIN in src/org/status.ts");

  const skill = readFileSync(join(root, "skills", "agent-fleet-operations", "SKILL.md"), "utf8");
  assert.match(skill, /\| `hermes\.skillex-resync` \| host \|/u, "the rules table in agent-fleet-operations/SKILL.md");
  assert.ok(existsSync(cli), "the suite runs the built CLI");
});
