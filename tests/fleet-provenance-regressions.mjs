// PJAN Epic 1 / Story 1.3: report fleet provenance through a shared CLI and MCP.
//
// The defect class this suite exists for is not "provenance has a bug". It is
// that nothing could answer "which build is each agent actually running?" -- and
// that every cheap way of answering it is wrong in a way that looks right:
//
//   * `git -C <path>` WALKS UP. Without a top-level equality guard, an agent
//     pointed at a subdirectory reports an unrelated repository's remote and
//     HEAD as its own provenance, confidently.
//   * A plain `git status` WRITES `.git/index`. A read-only command that
//     refreshes an index on 28 repositories is not read-only.
//   * Absence reads as agreement. 21 of 28 live agents carry no `hermes.git_sha`
//     at all; a comparison that treats "nothing recorded" as "nothing wrong"
//     reports a healthy fleet running the wrong build.
//   * `~/.hermes/fleet.env` carries live Plane API keys beside the fleet paths
//     this command needs.
//
// So the bar is the one stories 1.1 and 1.2 set:
//
//   * Every case runs the REAL built `dist/index.js` (or `dist/mcp-server.js`)
//     in a real subprocess over real OS pipes.
//   * Every registry case is derived by `YAML.parseDocument`-MUTATING A COPY OF
//     THE REAL REGISTRY, and every checkout case is a real `git init`.
//   * stdout is asserted non-empty and parseable BEFORE anything is asserted
//     about its content.
//   * Every invocation, including the failing ones, is bracketed by a
//     content+mtime snapshot of the scratch HOME, the working directory and the
//     tracked contract -- plus the `.git/index` mtime of every repository the
//     run probed, which is what catches a missing `--no-optional-locks`.
//   * The probe-failure, probe-timeout and cancellation cases are driven by fake
//     `git` shims on PATH against the real binary spawn, not by mocks.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
// The workspace that owns the CLI. `dist/` lives under the package; the handbook
// and the job-description template stay at the repo root.
const PKG = join(ROOT, "packages", "flume-hr");
const CLI = join(PKG, "dist", "index.js");
const TRACKED_CONTRACT = join(ROOT, "contracts", "handbook.yaml");

/**
 * The real host sources, derived and never written as a literal.
 *
 * `portable-test-paths-regressions` fails the build on a hardcoded `/home/<name>`
 * in any `*-regressions.mjs`, and a literal would also make the suite a fiction
 * on any other machine.
 */
const REAL_HOME = (() => { try { return userInfo().homedir; } catch { return homedir(); } })();
const REAL_AGENT_REGISTRY = process.env.HERMES_AGENTS_REGISTRY?.trim() || join(REAL_HOME, ".hermes", "agents-registry.yaml");
const REAL_PROJECT_REGISTRY = process.env.PJ_PROJECT_REGISTRY?.trim() || join(REAL_HOME, ".config", "pjangler", "projects.yaml");
const REAL_TEMPLATE_CONFIG = process.env.HERMES_TEMPLATE_CONFIG?.trim()
  || join(process.env.XDG_CONFIG_HOME?.trim() || join(REAL_HOME, ".config"), "hermes-agent-template", "config.toml");
/**
 * The operator's fleet env -- READ ONLY to cross-check the shape below.
 *
 * `scripts/run-tests.mjs` deliberately points `HERMES_FLEET_ENV` at a file that
 * does not exist, so an inherited `PLANE_33GOD_API_KEY` can never become live
 * ammunition again. This suite honours that: it never requires the real file,
 * never copies it, and CONSTRUCTS its scratch fleet env instead (below). The
 * path is kept only so one skip-guarded check can prove the constructed shape
 * still matches the real one where the real one is reachable.
 */
const REAL_FLEET_ENV = join(REAL_HOME, ".hermes", "fleet.env");
const REAL_PROFILE_ROOT = join(REAL_HOME, ".hermes", "profiles");

const temp = mkdtempSync(join(tmpdir(), "fleet-provenance-"));
const scratchHome = join(temp, "home");
/**
 * Where a `git` shim records the pids it spawned.
 *
 * Deliberately OUTSIDE `temp`: `snapshot()` walks `temp` and asserts it is
 * byte-identical before and after every invocation, so a shim appending its own
 * pid inside it would be indistinguishable from the command writing there.
 */
const probeLog = mkdtempSync(join(tmpdir(), "fleet-provenance-probes-"));
let failures = 0;
let skipped = 0;

/** Thrown to leave the suite body when the host cannot express any case at all. */
class SkipSuite extends Error {}

/** Thrown by `skipCase()` so `check()` cannot go on to report the case as `ok`. */
class SkipCase extends Error {}

/** A case the host cannot express. Loud, never silent. */
function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP ${label}: ${reason}`);
}

/**
 * Skip from INSIDE a `check()` body, and leave that body for good.
 *
 * `skip()` alone is not enough there. A body that called it and then `return`ed
 * printed `SKIP <label>` and, because it returned normally, `check` went on to
 * print `ok   <label>` for the very same case -- counted in both tallies and
 * indistinguishable in the summary from a case that actually ran. Four cases
 * call it this way (`a pinned-release executable matches`, `the recorded gitlink
 * stays the index SHA`, `an unexpanded shell reference is classified`, `the
 * configured pin equals an independent read`). On this host all four do run, so
 * the double-report was latent -- on a host without those conditions the suite
 * would have reported success for verification that never happened.
 */
function skipCase(label, reason) {
  skip(label, reason);
  throw new SkipCase(reason);
}

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    // A skip has already printed its own line and counted itself. Reporting it
    // as a FAIL here would be as wrong as reporting it as an `ok`.
    if (error instanceof SkipCase) return;
    failures += 1;
    console.log(`  FAIL ${label}: ${String(error.message).split("\n")[0]}`);
  }
}

/**
 * The same, awaited.
 *
 * Exactly one case needs it -- signalling a LIVE process, which `spawnSync`
 * cannot express. Passing an async body to `check` would return a promise it
 * never awaits, and the case would report `ok` before it had run.
 */
async function checkAsync(label, body) {
  try {
    await body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    if (error instanceof SkipCase) return;
    failures += 1;
    console.log(`  FAIL ${label}: ${String(error.message).split("\n")[0]}`);
  }
}

/**
 * Two obviously-fake secrets, so the credential case is real without a real key.
 *
 * The live `~/.hermes/fleet.env` carries `PLANE_33GOD_API_KEY` and
 * `PLANE_AUTOMATICAI_API_KEY`. The scratch copy keeps the KEY NAMES -- which is
 * what the allowlist has to exclude -- and replaces the values, because writing
 * a real credential into a file is exactly what this repo forbids everywhere
 * else and a sentinel proves the same property.
 */
const SECRET_SENTINEL = "pjan13-not-a-real-credential-0000";
const UNLISTED_KEY = "PJAN13_UNLISTED_SENTINEL";

/**
 * The credential env keys this repo already knows it has, read from the runner.
 *
 * `scripts/run-tests.mjs` blanks exactly these before every suite, after a run
 * that created seven real Plane boards. That list is tracked, authoritative, and
 * maintained -- so deriving the key names from it keeps this case correct when
 * the list changes, instead of freezing a hand-written copy that drifts.
 */
const CREDENTIAL_KEYS = (() => {
  const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
  const block = runner.slice(runner.indexOf("const HERMETIC_ENV"));
  return [...block.slice(0, block.indexOf("};")).matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)]
    .map((match) => match[1])
    .filter((key) => /KEY|TOKEN|SECRET|PASSWORD/.test(key));
})();

/**
 * A scratch HOME the command has no business writing to.
 *
 * Every source the provenance core reads is pointed inside it and seeded from
 * the REAL one: the two registries verbatim, the template config verbatim (its
 * pins are absolute paths that still resolve on this host, which is the point --
 * the probes have something real to observe), the fleet env with its key names
 * kept and its values replaced, and every generated profile config that exists.
 */
function seedHome() {
  mkdirSync(join(scratchHome, ".hermes", "profiles"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "hermes-agent-template"), { recursive: true });
  copyFileSync(REAL_AGENT_REGISTRY, join(scratchHome, ".hermes", "agents-registry.yaml"));
  copyFileSync(REAL_PROJECT_REGISTRY, join(scratchHome, ".config", "pjangler", "projects.yaml"));
  copyFileSync(REAL_TEMPLATE_CONFIG, join(scratchHome, ".config", "hermes-agent-template", "config.toml"));

  // CONSTRUCTED, never copied. The fleet paths come from the real template
  // config's own `[fleet]` block, so the host-pin facts compare real values;
  // `HERMES_FLEET_REGISTRY_FILE` keeps the live `$HERMES_FLEET_HOME/...`
  // spelling, which is the unexpanded-shell-reference case; and every credential
  // key the runner blanks appears by NAME with a sentinel value, so the
  // exclusion case is non-vacuous without a real secret ever touching disk.
  const configText = readFileSync(REAL_TEMPLATE_CONFIG, "utf8");
  const fleetScalar = (key) => {
    const section = configText.slice(configText.indexOf("[fleet]"));
    const body = section.slice(0, section.indexOf("\n[", 1) === -1 ? section.length : section.indexOf("\n[", 1));
    return (new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(body) ?? [])[1];
  };
  writeFileSync(join(scratchHome, ".hermes", "fleet.env"), [
    `HERMES_FLEET_HOME=${join(scratchHome, ".hermes")}`,
    `HERMES_FLEET_BIN=${fleetScalar("hermes_bin") ?? ""}`,
    `HERMES_FLEET_REPO=${fleetScalar("hermes_repo") ?? ""}`,
    "HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/agents-registry.yaml",
    ...CREDENTIAL_KEYS.map((key) => `${key}=${SECRET_SENTINEL}`),
    `${UNLISTED_KEY}=${SECRET_SENTINEL}`,
    "",
  ].join("\n"), "utf8");

  if (existsSync(REAL_PROFILE_ROOT)) {
    for (const entry of readdirSync(REAL_PROFILE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = join(REAL_PROFILE_ROOT, entry.name, "config.yaml");
      if (!existsSync(source)) continue;
      mkdirSync(join(scratchHome, ".hermes", "profiles", entry.name), { recursive: true });
      copyFileSync(source, join(scratchHome, ".hermes", "profiles", entry.name, "config.yaml"));
    }
  }
}

const isolation = {
  HOME: scratchHome,
  XDG_CONFIG_HOME: join(scratchHome, ".config"),
  XDG_DATA_HOME: join(scratchHome, ".local", "share"),
  XDG_STATE_HOME: join(scratchHome, ".local", "state"),
  XDG_CACHE_HOME: join(scratchHome, ".cache"),
  HERMES_FLEET_HOME: join(scratchHome, ".hermes"),
  HERMES_AGENTS_REGISTRY: join(scratchHome, ".hermes", "agents-registry.yaml"),
  HERMES_FLEET_REGISTRY_FILE: join(scratchHome, ".hermes", "agents-registry.yaml"),
  HERMES_FLEET_ENV: join(scratchHome, ".hermes", "fleet.env"),
  HERMES_TEMPLATE_CONFIG: join(scratchHome, ".config", "hermes-agent-template", "config.toml"),
  PJ_PROJECT_REGISTRY: join(scratchHome, ".config", "pjangler", "projects.yaml"),
  HERMES_TEMPLATE_RUNTIME_SCAFFOLD: join(scratchHome, ".hermes", "runtime-scaffold"),
  RUNTIME_SCAFFOLD_DIR: join(scratchHome, ".hermes", "runtime-scaffold"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  // Git repacks on its own schedule and rewrites `.git/objects` when it does;
  // the protected-root snapshot digests `.git` too, so that housekeeping reads
  // as "the CLI wrote here". It only crosses the gc threshold on a fresh clone,
  // which is why this was invisible locally and fatal in CI. Turn the
  // housekeeping off rather than stop watching `.git`.
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  // TMPDIR can itself sit inside a git work tree on this machine, which would
  // make an unrelated checkout answer for every scratch repository below.
  GIT_CEILING_DIRECTORIES: realpathSync(temp),
  TMPDIR: temp,
  NO_COLOR: "1",
};

/** Content hash + mtime for every entry under a tree, keyed by relative path. */
function snapshotTree(label, root, entries = {}) {
  if (!existsSync(root)) { entries[`${label}:<absent>`] = "absent"; return entries; }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      const key = `${label}:${relative(root, path)}`;
      const stat = lstatSync(path);
      if (entry.isSymbolicLink()) { entries[key] = `link:${readlinkSync(path)}:${stat.mtimeMs}`; continue; }
      if (entry.isDirectory()) { entries[key] = `dir:${stat.mtimeMs}`; walk(path); continue; }
      if (!entry.isFile()) { entries[key] = `other:${stat.mode}:${stat.mtimeMs}`; continue; }
      let digest;
      try { digest = createHash("sha256").update(readFileSync(path)).digest("hex"); }
      catch { digest = `unreadable:${stat.mode}:${stat.size}`; }
      entries[key] = `${digest}:${stat.mtimeMs}`;
    }
  };
  walk(root);
  return entries;
}

/** File digest + mtime for one path, for the real-source zero-write proof. */
function fileFingerprint(path) {
  if (!existsSync(path)) return "absent";
  const stat = lstatSync(path);
  return `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${stat.mtimeMs}`;
}

/**
 * Every repository this command probes, by its `.git/index`.
 *
 * This is the assertion that catches a missing `--no-optional-locks`: a plain
 * `git status` refreshes the index in place, which changes nothing a diff would
 * show and everything about whether this command is read-only. The submodule's
 * `.git` is a FILE pointing into the parent's `modules/` directory, so its index
 * is resolved through that rather than assumed to sit beside it.
 */
function gitIndexFingerprints() {
  const entries = {};
  const candidates = [ROOT, join(ROOT, "templates", "hermes-agent")];
  const registry = existsSync(REAL_AGENT_REGISTRY) ? YAML.parse(readFileSync(REAL_AGENT_REGISTRY, "utf8")) : null;
  for (const agent of Object.values(registry?.agents ?? {})) {
    const repo = agent?.hermes?.repo;
    if (typeof repo === "string" && repo.trim() && !candidates.includes(repo)) candidates.push(repo);
  }
  for (const candidate of candidates) {
    const dot = join(candidate, ".git");
    let indexPath = join(dot, "index");
    try {
      if (lstatSync(dot).isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
        if (pointer) indexPath = join(resolve(candidate, pointer[1].trim()), "index");
      }
    } catch { /* no .git here; recorded as absent below */ }
    entries[`gitindex:${candidate}`] = fileFingerprint(indexPath);
  }
  return entries;
}

function snapshot() {
  const entries = {};
  snapshotTree("home", scratchHome, entries);
  snapshotTree("cwd", temp, entries);
  snapshotTree("contracts", join(ROOT, "contracts"), entries);
  Object.assign(entries, gitIndexFingerprints());
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    entries[`root:${entry.name}`] = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
  }
  return entries;
}

/**
 * Run a built CLI and prove the run wrote nothing to a protected root.
 *
 * `maxBuffer` is set explicitly: the default would itself truncate a large
 * capture, and a truncation introduced by the harness looks exactly like the
 * truncation defect the harness is here to detect.
 */
function cliAt(cliPath, args, extraEnv = {}, cwd = temp) {
  const before = snapshot();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...isolation, ...extraEnv },
  });
  const after = snapshot();
  assert.deepEqual(after, before, `pj ${args.join(" ")} wrote to a protected root`);
  return result;
}

function cli(args, extraEnv = {}, cwd = temp) {
  return cliAt(CLI, args, extraEnv, cwd);
}

/** Machine output, asserted to exist before it is asserted to say anything. */
function envelope(result) {
  assert.notEqual(result.stdout, "", "stdout was empty; a passing assertion on empty output proves nothing");
  assert.ok(result.stdout.trim().length > 0, "stdout was blank");
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { assert.fail(`stdout is not one complete JSON document (${result.stdout.length} bytes): ${error.message}`); }
  assert.equal(parsed.schema_version, 1, "envelope schema_version");
  assert.equal(typeof parsed.command, "string");
  return parsed;
}

function errorCode(parsed) {
  assert.equal(parsed.ok, false, `expected a failure envelope, got ok:true with totals ${JSON.stringify(parsed.data?.totals)}`);
  assert.notEqual(parsed.error, null, "a failure envelope must carry an error");
  assert.equal(parsed.data, null, "a failure envelope must carry no data");
  return parsed.error.code;
}

/** A successful provenance envelope with its invariants already checked. */
function provenance(result) {
  const parsed = envelope(result);
  assert.equal(parsed.ok, true, `expected ok:true, got ${JSON.stringify(parsed.error)}`);
  assert.equal(parsed.error, null, "ok envelopes carry no error");
  assert.equal(parsed.command, "fleet.provenance");
  for (const key of ["contract_path", "contract_version", "scope", "sources", "totals", "health", "facts", "probes", "findings", "truncated"]) {
    assert.notEqual(parsed.data[key], undefined, `data.${key} must be present`);
  }
  return parsed.data;
}

function factsFor(data, id) {
  return data.facts.filter((fact) => fact.id === id);
}

function factFor(data, id, agentId = null) {
  return data.facts.find((fact) => fact.id === id && fact.agent_id === agentId);
}

/** Derive a registry case by mutating a COPY of the real registry. */
function mutatedRegistry(name, sourcePath, mutate) {
  const document = YAML.parseDocument(readFileSync(sourcePath, "utf8"));
  mutate(document);
  const path = join(temp, `${name}.yaml`);
  writeFileSync(path, String(document), "utf8");
  return path;
}

const GIT_IDENTITY = ["-c", "user.email=suite@invalid", "-c", "user.name=Suite", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

function git(cwd, args) {
  const result = spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  return result;
}

/** A real repository with `count` commits, returned with its commit shas oldest-first. */
function makeRepo(dir, count = 2, tracked = {}) {
  mkdirSync(dir, { recursive: true });
  assert.equal(git(dir, ["init", "--quiet"]).status, 0, `git init failed in ${dir}`);
  // `tracked` seeds files every revision carries. The template origin uses it
  // for `copier.yml`, which is the marker `resolveFlumeRoot` walks up for -- and
  // since the submodule OCCUPIES templates/hermes-agent in the scratch parent,
  // the marker can only arrive through the submodule's own history.
  for (const [name, body] of Object.entries(tracked)) writeFileSync(join(dir, name), body, "utf8");
  const shas = [];
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(dir, "file.txt"), `revision ${index}\n`, "utf8");
    assert.equal(git(dir, ["add", "-A"]).status, 0);
    assert.equal(git(dir, ["commit", "--quiet", "-m", `rev ${index}`]).status, 0);
    shas.push(git(dir, ["rev-parse", "HEAD"]).stdout.trim());
  }
  return shas;
}

/** A source this suite can copy: present, a regular file, and readable. */
const isReadableFile = (path) => { try { return lstatSync(path).isFile(); } catch { return false; } };

/** A `git` shim on PATH, so the probe-failure and probe-timeout cases are real spawns. */
function shim(name, body) {
  const dir = join(temp, `shim-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "git"), body, "utf8");
  chmodSync(join(dir, "git"), 0o755);
  return dir;
}

console.log("fleet provenance: recorded pins against live builds, through one core");

const missingSource = [
  [REAL_AGENT_REGISTRY, "the Hermes agent registry"],
  [REAL_PROJECT_REGISTRY, "the PJangler project registry"],
  [REAL_TEMPLATE_CONFIG, "the Hermes template config"],
  // `existsSync` alone is not the question. On this host something had left a
  // root-owned DIRECTORY where `~/.config/pjangler/projects.yaml` belongs, which
  // is `exists: true` and then threw EISDIR out of `seedHome`'s copy -- the
  // loud skip this guard exists for, reported as a suite crash instead.
].find(([path]) => !isReadableFile(path));

try {
  if (missingSource) {
    // A host that cannot express these cases skips them, loudly. An unguarded
    // `copyFileSync` of the operator's live sources turns SKIP into FAIL on any
    // other machine, which is indistinguishable from a real regression.
    skip("the whole suite", `${missingSource[1]} is not on this host (${relative(REAL_HOME, missingSource[0])}); every case derives from a copy of a real source`);
    throw new SkipSuite();
  }
  if (!existsSync(CLI)) {
    skip("the whole suite", "dist/index.js is not built; run `npm run build` first");
    throw new SkipSuite();
  }
  seedHome();

  const liveIds = Object.keys(YAML.parse(readFileSync(REAL_AGENT_REGISTRY, "utf8"))?.agents ?? {});

  function checkWithAgents(count, label, body) {
    if (liveIds.length < count) { skip(label, `needs ${count} live agents, this host has ${liveIds.length}`); return; }
    check(label, body);
  }

  // -- the whole fleet, through the real built CLI ---------------------------

  check("the human report leads with the verdict, its reasons, and the completeness split", () => {
    const result = cli(["record"]);
    assert.notEqual(result.stdout, "", "human report must not be empty");
    assert.equal(result.status, 0, `drift is data, not a failure exit: got ${result.status} ${result.stderr}`);
    const out = result.stdout;
    assert.match(out.split("\n").slice(0, 3).join("\n"), /Fleet provenance healthy|Employment records ON NOTICE/, "the verdict must lead");
    // The reasons were computed and shipped in JSON before they were rendered,
    // so an operator who cannot run --json could see THAT provenance was
    // unhealthy and never why.
    for (const reason of ["mismatched", "dirty", "missing", "unsupported", "unobserved", "probe failures"]) {
      assert.match(out, new RegExp(`\\d+ ${reason.replace(" ", "\\s")}`), `the verdict's reasons must name ${reason}`);
    }
    assert.ok(out.indexOf("Fleet provenance") < out.indexOf("Facts"), "the verdict must come before the fact dump");
    assert.match(out, /Probes/, "the report must name every probe");
  });

  check("--json is one complete envelope with every declared data key", () => {
    const result = cli(["record", "--json"]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const data = provenance(result);
    assert.equal(data.scope.kind, "fleet");
    assert.ok(Array.isArray(data.facts) && data.facts.length > 0);
    // Bigger than the observed 8 KiB truncation threshold, through a real pipe.
    assert.ok(result.stdout.length > 8192, `payload is only ${result.stdout.length} bytes; below the observed truncation threshold`);
  });

  // -- AC1: every agent, every fact attributed --------------------------------

  check("every registered agent appears, totals agree with the inventory, and no value is unattributed", () => {
    const data = provenance(cli(["record", "--json"]));
    const inventory = JSON.parse(cli(["roster", "--json"]).stdout).data;
    assert.equal(data.totals.agents, inventory.totals.registered_agents, "totals.agents must equal the inventory's registered_agents");
    const seen = new Set(data.facts.filter((fact) => fact.scope === "agent").map((fact) => fact.agent_id));
    const registered = new Set(inventory.rows.map((row) => row.agent_id.value));
    assert.deepEqual([...seen].sort(), [...registered].sort(), "every registered agent id must appear in data.facts");
    for (const fact of data.facts) {
      for (const key of ["desired", "observed"]) {
        const side = fact[key];
        assert.ok(side && typeof side === "object", `${fact.id}.${key} is missing`);
        for (const part of ["value", "source", "state", "family", "classification"]) {
          assert.ok(part in side, `${fact.id}.${key} has no ${part}`);
        }
        assert.ok(["present", "missing", "unsupported", "unobserved"].includes(side.state), `${fact.id}.${key}.state is ${side.state}`);
        // Either the value is known and names where it came from, or it is
        // explicitly null at a state that says why. Never a value with no
        // provenance, and never a silent absence.
        if (side.state === "present") {
          assert.ok(typeof side.source === "string" && side.source.length > 0, `${fact.id}.${key} is present with no source`);
        }
      }
      assert.ok(["match", "mismatch", "dirty", "missing", "unsupported", "unobserved"].includes(fact.status), `${fact.id}.status is ${fact.status}`);
    }
  });

  check("totals.by_status sums to the fact count and counts absence apart from match", () => {
    const data = provenance(cli(["record", "--json"]));
    const sum = Object.values(data.totals.by_status).reduce((total, count) => total + count, 0);
    assert.equal(sum, data.totals.facts, "every fact must land in exactly one status bucket");
    for (const status of ["missing", "unsupported", "unobserved"]) {
      assert.notEqual(data.totals.by_status[status], undefined, `${status} must be its own bucket`);
    }
    assert.equal(data.health.mismatched, data.totals.by_status.mismatch);
    assert.equal(data.health.missing, data.totals.by_status.missing);
    assert.equal(data.health.unobserved, data.totals.by_status.unobserved);
  });

  check("two consecutive runs produce byte-identical data", () => {
    const first = cli(["record", "--json"]);
    const second = cli(["record", "--json"]);
    assert.deepEqual(JSON.parse(second.stdout).data, JSON.parse(first.stdout).data, "data must not depend on time, duration, host, or completion order");
    assert.equal(JSON.stringify(JSON.parse(second.stdout).data), JSON.stringify(JSON.parse(first.stdout).data), "and must be byte-identical, not merely deep-equal");
  });

  // -- AC2: a recorded value that is absent is `missing`, never `match` -------

  checkWithAgents(2, "an agent with no recorded git_sha is missing, and its other facts survive", () => {
    const victim = liveIds[0];
    const stripped = mutatedRegistry("no-git-sha", REAL_AGENT_REGISTRY, (document) => {
      for (const id of liveIds) document.deleteIn(["agents", id, "hermes", "git_sha"]);
    });
    const data = provenance(cli(["record", "--agent-registry", stripped, "--json"]));
    for (const fact of factsFor(data, "hermes.git_sha")) {
      assert.equal(fact.status, "missing", `${fact.agent_id}: an absent recorded value is never a match`);
      assert.equal(fact.observed.value, null);
      assert.equal(fact.observed.state, "missing");
    }
    assert.equal(data.totals.by_status.missing >= liveIds.length, true, "totals.by_status.missing must count every one of them");
    // The agent is still fully reported: one missing value downgrades one fact.
    const others = data.facts.filter((fact) => fact.agent_id === victim && fact.id !== "hermes.git_sha");
    assert.ok(others.length > 3, "the agent's other facts must still be emitted");
    assert.ok(others.some((fact) => fact.status !== "missing"), "and must not all collapse to missing");
  });

  // -- AC3: the recorded gitlink cannot be moved by the worktree --------------

  /**
   * A relocated package root with a REAL submodule whose worktree can move.
   *
   * `resolvePjanglerRoot` and `resolveFleetContractPath` both walk up from the
   * running module for `package.json` plus their own marker, so a copy of the
   * bundle beside a copy of the contract and a `templates/` tree is the whole
   * trick -- and it means the gitlink case never touches the operator's own
   * checkout. `node_modules` is symlinked because the bundle keeps its
   * dependencies external.
   */
  function packageWithSubmodule(name) {
    const dir = join(temp, name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    mkdirSync(join(dir, "contracts"), { recursive: true });
    copyFileSync(CLI, join(dir, "dist", "index.js"));
    copyFileSync(TRACKED_CONTRACT, join(dir, "contracts", "handbook.yaml"));
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, version: "0.0.0", type: "module" }, null, 2)}\n`, "utf8");
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));

    const origin = join(temp, `${name}-template-origin`);
    const shas = makeRepo(origin, 2, { "copier.yml": "# marker\n" });
    assert.equal(git(dir, ["init", "--quiet"]).status, 0);
    writeFileSync(join(dir, "README.md"), "# scratch parent\n", "utf8");
    assert.equal(git(dir, ["add", "-A"]).status, 0);
    assert.equal(git(dir, ["commit", "--quiet", "-m", "scratch parent"]).status, 0);
    const added = git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", origin, "templates/hermes-agent"]);
    return { dir, cli: join(dir, "dist", "index.js"), origin, shas, added };
  }

  check("the recorded gitlink stays the index SHA no matter where the worktree is", () => {
    const scratch = packageWithSubmodule("gitlink-case");
    if (scratch.added.status !== 0) {
      skipCase("the recorded gitlink stays the index SHA", `git submodule add is unavailable here: ${String(scratch.added.stderr).split("\n")[0]}`);
    }
    const submodule = join(scratch.dir, "templates", "hermes-agent");
    const recorded = /^160000 ([0-9a-f]{40})/.exec(git(scratch.dir, ["ls-files", "--stage", "templates/hermes-agent"]).stdout);
    assert.ok(recorded, "the scratch parent must record a gitlink");

    // Matching first, so the mismatch below is a CHANGE and not the only state
    // this case has ever seen.
    const clean = provenance(cliAt(scratch.cli, ["record", "--json"], {}, scratch.dir));
    const before = factFor(clean, "template.gitlink");
    assert.equal(before.desired.value, recorded[1]);
    assert.equal(before.status, "match", "an unmoved worktree must report match");

    const other = scratch.shas.find((sha) => sha !== recorded[1]);
    assert.ok(other, "the scratch template needs a second commit to move to");
    assert.equal(git(submodule, ["checkout", "--quiet", other]).status, 0, "the worktree must move");

    const moved = provenance(cliAt(scratch.cli, ["record", "--json"], {}, scratch.dir));
    const fact = factFor(moved, "template.gitlink");
    assert.equal(fact.desired.value, recorded[1], "desired is the RECORDED gitlink and no worktree move may touch it");
    assert.equal(fact.observed.value, other, "observed is the worktree HEAD");
    assert.equal(fact.status, "mismatch");
    assert.equal(moved.health.healthy, false, "a moved template worktree is not a healthy fleet");

    assert.equal(git(submodule, ["checkout", "--quiet", recorded[1]]).status, 0, "restore the worktree");
    const restored = provenance(cliAt(scratch.cli, ["record", "--json"], {}, scratch.dir));
    assert.equal(factFor(restored, "template.gitlink").status, "match", "with the worktree restored the same run reports match");
  });

  // -- AC4: the observed executable is classified, never executed -------------

  checkWithAgents(1, "a legacy executable is a mismatch whose family is named, and it is never run", () => {
    // A real executable at the real legacy SHAPE, carrying a sentinel that would
    // prove execution. `~/.hermes/hermes-agent/...` is what 21 live agents point
    // at, and it is what the contract's retired `detect` patterns match.
    const legacyDir = join(scratchHome, ".hermes", "hermes-agent", ".venv", "bin");
    const sentinel = join(temp, "the-binary-was-executed");
    mkdirSync(legacyDir, { recursive: true });
    const legacyBin = join(legacyDir, "hermes");
    writeFileSync(legacyBin, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nexit 0\n`, "utf8");
    chmodSync(legacyBin, 0o755);

    const victim = liveIds[0];
    const registry = mutatedRegistry("legacy-executable", REAL_AGENT_REGISTRY, (document) => {
      document.setIn(["agents", victim, "hermes", "bin"], legacyBin);
    });
    const data = provenance(cli(["record", "--agent-registry", registry, "--agent", victim, "--json"]));
    const fact = factFor(data, "hermes.executable", victim);
    assert.ok(fact, "the mutated agent must carry an executable fact");
    assert.equal(fact.status, "mismatch");
    assert.equal(fact.observed.family, "hard-coded-hermes-checkout-path", "observed.family must name the retired family the contract declares");
    assert.equal(existsSync(sentinel), false, "the observed binary was EXECUTED; it must only ever be classified by path");

    // And the family comes from the contract, not from a literal in the module.
    const contract = YAML.parse(readFileSync(TRACKED_CONTRACT, "utf8"));
    assert.ok(contract.retired.some((mode) => mode.id === fact.observed.family), "the family must be a retired mode the contract declares");
  });

  check("a pinned-release executable matches and is classified as the pinned family", () => {
    const data = provenance(cli(["record", "--json"]));
    const matches = factsFor(data, "hermes.executable").filter((fact) => fact.status === "match");
    if (matches.length === 0) skipCase("a pinned-release executable matches", "no live agent points at the configured pin");
    for (const fact of matches) {
      assert.equal(fact.observed.family, "pinned-release", "the configured release root is checked BEFORE the retired patterns, which also match it");
    }
  });

  // -- AC5: an unusable checkout is unobserved, never someone else's identity --

  checkWithAgents(1, "an absent checkout is classified absent and its identity is unobserved, with a probe record", () => {
    const victim = liveIds[0];
    const absentRepo = join(scratchHome, "no-such-checkout");
    const registry = mutatedRegistry("absent-checkout", REAL_AGENT_REGISTRY, (document) => {
      document.setIn(["agents", victim, "hermes", "repo"], absentRepo);
    });
    const data = provenance(cli(["record", "--agent-registry", registry, "--agent", victim, "--json"]));
    assert.equal(factFor(data, "hermes.repository", victim).observed.classification, "absent");
    const identity = factFor(data, "hermes.checkout_identity", victim);
    assert.equal(identity.status, "unobserved", "an absent checkout may not be reported as a match");
    assert.equal(identity.observed.value, null);
    const record = data.probes.find((entry) => entry.target.endsWith("no-such-checkout"));
    assert.ok(record, "a skipped probe is still recorded");
    assert.equal(record.outcome, "skipped");
    assert.equal(record.reason, "absent");
    assert.equal(existsSync(absentRepo), false, "the command created the directory it was asked to inspect");
  });

  checkWithAgents(1, "a path inside another repository reports that repository's identity for nobody", () => {
    // `git -C <path>` WALKS UP: `git -C src rev-parse --show-toplevel` inside a
    // repository answers the repository ROOT. Without the top-level equality
    // guard, an agent pointed at a subdirectory inherits an unrelated
    // repository's remote and HEAD and reports them as its own provenance.
    const host = join(temp, "unrelated-repo");
    makeRepo(host, 1);
    assert.equal(git(host, ["remote", "add", "origin", "git@example.invalid:someone/unrelated.git"]).status, 0);
    const inner = join(host, "nested", "deep");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "keep.txt"), "x\n", "utf8");

    const victim = liveIds[0];
    const registry = mutatedRegistry("inside-another-repo", REAL_AGENT_REGISTRY, (document) => {
      document.setIn(["agents", victim, "hermes", "repo"], inner);
    });
    const data = provenance(cli(["record", "--agent-registry", registry, "--agent", victim, "--json"]));
    const identity = factFor(data, "hermes.checkout_identity", victim);
    assert.equal(identity.status, "unobserved");
    const record = data.probes.find((entry) => entry.target.includes("nested"));
    assert.ok(record, "the refused probe must be recorded");
    assert.equal(record.reason, "not-a-repository-root");
    assert.equal(
      JSON.stringify(data).includes("someone/unrelated.git"), false,
      "the surrounding repository's identity leaked into this agent's provenance",
    );
  });

  checkWithAgents(1, "a dirty checkout is dirty, and dirtiness never shadows the value comparison", () => {
    const dirty = join(temp, "dirty-checkout");
    makeRepo(dirty, 1);
    writeFileSync(join(dirty, "file.txt"), "uncommitted\n", "utf8");

    const victim = liveIds[0];
    const registry = mutatedRegistry("dirty-checkout", REAL_AGENT_REGISTRY, (document) => {
      document.setIn(["agents", victim, "hermes", "repo"], dirty);
    });
    const data = provenance(cli(["record", "--agent-registry", registry, "--agent", victim, "--json"]));
    assert.equal(factFor(data, "hermes.checkout_clean", victim).status, "dirty");
    // Cleanliness is its own fact, so the HEAD comparison beside it still says
    // what it says. A `dirty` that shadowed a `mismatch` would hide the drift.
    const head = factFor(data, "hermes.checkout_head", victim);
    assert.ok(["match", "mismatch", "missing"].includes(head.status), `checkout_head must still compare, got ${head.status}`);
    assert.equal(data.health.dirty > 0, true);
    assert.equal(data.health.healthy, false);
  });

  checkWithAgents(1, "probing a checkout whose cached stat is stale does not rewrite its index", () => {
    // THE read-only assertion, and the only one that can see a missing
    // `--no-optional-locks`. A plain `git status` rewrites `.git/index` ONLY
    // when it has stat information to refresh -- so on a repository git has
    // already looked at, dropping the flag changes nothing and an index-mtime
    // check stays green for the wrong reason. Measured on git 2.51.0: touch a
    // tracked file, and a plain `git status` bumps the index mtime while
    // `git --no-optional-locks status` leaves it alone. This case puts a
    // checkout in exactly that state first.
    const staleRepo = join(temp, "stale-index-checkout");
    makeRepo(staleRepo, 1);
    assert.equal(git(staleRepo, ["status", "--porcelain"]).status, 0, "prime git's cached stat");
    const indexPath = join(staleRepo, ".git", "index");
    const before = lstatSync(indexPath).mtimeMs;
    // A second of separation, because the mtime granularity that matters here
    // is the filesystem's and a same-second rewrite would be invisible.
    spawnSync("sleep", ["1.1"]);
    writeFileSync(join(staleRepo, "file.txt"), readFileSync(join(staleRepo, "file.txt")));
    assert.equal(lstatSync(indexPath).mtimeMs, before, "touching a tracked file must not itself move the index");

    const victim = liveIds[0];
    const registry = mutatedRegistry("stale-index", REAL_AGENT_REGISTRY, (document) => {
      document.setIn(["agents", victim, "hermes", "repo"], staleRepo);
    });
    const data = provenance(cli(["record", "--agent-registry", registry, "--agent", victim, "--json"]));
    // The probe must actually have READ this checkout, or the assertion below
    // is vacuous: a run that never opened the repository cannot have written to
    // it either.
    assert.equal(factFor(data, "hermes.checkout_clean", victim).observed.state, "present", "the case is vacuous unless the checkout was really probed");
    assert.equal(lstatSync(indexPath).mtimeMs, before, "the probe rewrote .git/index; a plain `git status` refreshes it and this command must never write");
  });

  // -- AC6: a failed probe downgrades its own fact and nothing else ------------

  check("a failing git leaves every non-git fact byte-identical and only downgrades what it touched", () => {
    const clean = provenance(cli(["record", "--json"]));
    const failing = shim("fail", "#!/bin/sh\nexit 3\n");
    const result = cli(["record", "--json"], { PATH: `${failing}:${process.env.PATH}` });
    assert.equal(result.status, 0, "a failed probe is not a command failure");
    const data = provenance(result);
    assert.equal(data.health.complete, false, "health.complete must say the run could not observe everything");
    assert.ok(data.probes.some((entry) => entry.outcome === "failed" && entry.reason === "probe-failed"), "the failure must be recorded as a probe");
    for (const fact of data.facts.filter((entry) => /checkout|gitlink|remote_url|worktree_clean/.test(entry.id))) {
      assert.equal(fact.status, "unobserved", `${fact.agent_id ?? "fleet"}.${fact.id} must be unobserved, never assumed`);
    }
    // The non-git domains are untouched, compared FACT BY FACT against the same
    // run without the shim -- not merely "still present".
    const key = (fact) => `${fact.scope}:${fact.agent_id}:${fact.id}`;
    const before = new Map(clean.facts.filter((fact) => !/checkout|gitlink|remote_url|worktree_clean/.test(fact.id)).map((fact) => [key(fact), fact]));
    const after = new Map(data.facts.filter((fact) => !/checkout|gitlink|remote_url|worktree_clean/.test(fact.id)).map((fact) => [key(fact), fact]));
    assert.equal(after.size, before.size, "no fact outside the git domain may appear or vanish");
    for (const [id, fact] of before) assert.deepEqual(after.get(id), fact, `${id} changed when only git broke`);
  });

  check("a hanging git times out per probe, the run still succeeds, and no child survives", () => {
    const pidfile = join(probeLog, "hang-pids");
    const hanging = shim("hang", `#!/bin/sh\necho $$ >> ${JSON.stringify(pidfile)}\nsleep 120\n`);
    const result = cli(["record", "--json"], { PATH: `${hanging}:${process.env.PATH}`, PJ13_PIDFILE: pidfile });
    assert.equal(result.status, 0, "a per-probe timeout is not a command failure");
    const data = provenance(result);
    assert.ok(data.probes.some((entry) => entry.outcome === "timeout" && entry.reason === "probe-timeout"), "a killed probe must be recorded as a timeout, distinct from a failure");
    assert.equal(data.health.complete, false);
    const pids = existsSync(pidfile) ? readFileSync(pidfile, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.ok(pids.length > 0, "the shim must actually have been spawned; a green assertion on zero children proves nothing");
    const alive = pids.filter((pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } });
    assert.deepEqual(alive, [], "a timed-out probe must leave no live child");
  });

  // -- AC7 / AC8: deadline and cancellation are COMMAND failures --------------

  check("a deadline smaller than a hanging probe fails with TIMEOUT and exit 7", () => {
    const hanging = shim("hang-deadline", "#!/bin/sh\nsleep 120\n");
    const result = cli(["record", "--deadline-ms", "1", "--json"], { PATH: `${hanging}:${process.env.PATH}` });
    assert.equal(errorCode(envelope(result)), "TIMEOUT");
    assert.equal(result.status, 7, `TIMEOUT must exit 7, got ${result.status}`);
    // A truncated provenance report is exactly the kind of partial that must
    // never be mistaken for a complete one, so `data` is null and nothing claims
    // to be healthy.
    assert.equal(envelope(result).data, null);
  });

  await checkAsync("SIGINT during a hanging probe reports CANCELLED, exits 8, and kills the child", async () => {
    // Async on purpose: this is the only case that has to signal a LIVE process,
    // so `spawnSync` cannot express it. The zero-write snapshot is taken by hand
    // around the run, exactly as `cliAt` does for every other case.
    const pidfile = join(probeLog, "cancel-pids");
    const hanging = shim("hang-cancel", `#!/bin/sh\necho $$ >> ${JSON.stringify(pidfile)}\nsleep 120\n`);
    const before = snapshot();
    const outcome = await new Promise((settle) => {
      const child = spawn(process.execPath, [CLI, "record", "--json"], {
        cwd: temp,
        env: { ...process.env, ...isolation, PATH: `${hanging}:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      const killer = setTimeout(() => child.kill("SIGINT"), 1500);
      const guard = setTimeout(() => { child.kill("SIGKILL"); }, 30_000);
      child.on("close", (code) => { clearTimeout(killer); clearTimeout(guard); settle({ code, out }); });
    });
    assert.deepEqual(snapshot(), before, "a cancelled run must still write nothing");
    assert.equal(outcome.code, 8, `CANCELLED must exit 8, got ${outcome.code}`);
    const parsed = JSON.parse(outcome.out);
    assert.equal(errorCode(parsed), "CANCELLED");
    const pids = existsSync(pidfile) ? readFileSync(pidfile, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.ok(pids.length > 0, "the shim must actually have been spawned");
    await new Promise((wake) => setTimeout(wake, 2000));
    const alive = pids.filter((pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } });
    assert.deepEqual(alive, [], "the shim's recorded child pid must be gone within two seconds");
  });

  // -- scope and flag guards --------------------------------------------------

  checkWithAgents(2, "--agent scopes the facts and never the totals or the verdict", () => {
    const victim = liveIds[0];
    const scoped = provenance(cli(["record", "--agent", victim, "--json"]));
    const whole = provenance(cli(["record", "--json"]));
    assert.equal(scoped.scope.kind, "agent");
    assert.deepEqual([...new Set(scoped.facts.map((fact) => fact.agent_id))].sort(), [null, victim].sort());
    assert.equal(scoped.totals.agents, whole.totals.agents, "totals still describe the whole registered fleet");
    assert.deepEqual(scoped.totals.by_status, whole.totals.by_status, "and so does the status tally");
    assert.deepEqual(scoped.health, whole.health, "a slice that could report healthy while the fleet is drifted is the one thing an aggregate must never do");
    assert.ok(scoped.totals.emitted_facts < whole.totals.emitted_facts, "the facts themselves are scoped");
  });

  check("an unknown agent is NOT_FOUND with exit 3 and no stack trace", () => {
    const result = cli(["record", "--agent", "definitely-not-registered", "--json"]);
    assert.equal(errorCode(envelope(result)), "NOT_FOUND");
    assert.equal(result.status, 3);
    assert.doesNotMatch(result.stderr, /at .*\(/, "a categorized failure must not print a stack trace");
  });

  check("every malformed flag value is INVALID_INPUT with exit 2", () => {
    for (const args of [
      ["record", "--agent", "", "--json"],
      ["record", "--agent", "--json"],
      ["record", "--deadline-ms", "abc", "--json"],
      ["record", "--deadline-ms", "0", "--json"],
      ["record", "--deadline-ms", "-5", "--json"],
      // `Number()` accepts both of these and `Number.isInteger` agrees, so
      // without a digits-only guard `0x10` silently became a 16ms deadline and
      // `1e3` a 1000ms one -- a value the caller never wrote, in a base they
      // never named. Measured before the guard: exit 7 and exit 0 respectively.
      ["record", "--deadline-ms", "0x10", "--json"],
      ["record", "--deadline-ms", "1e3", "--json"],
      ["record", "--deadline-ms", " ", "--json"],
      ["record", "--contract", "", "--json"],
    ]) {
      const result = cli(args);
      // `--agent --json` makes the FLAG the value, so `options.json` stays false
      // and the caller who asked for JSON gets an ANSI report. That one case is
      // asserted through the human path; every OTHER case promised JSON and must
      // deliver a parseable envelope carrying the code.
      //
      // The previous form computed `startsWith("{") ? errorCode(...) : "INVALID_INPUT"`
      // and then asserted the result equalled `"INVALID_INPUT"` -- so on the
      // human path it compared a literal to itself and only the exit status was
      // ever really checked. Which path a case takes is now DECLARED, not
      // inferred from the output the case is supposed to be testing.
      const humanPath = args[1] === "--agent" && args[2] === "--json";
      if (humanPath) {
        assert.ok(!result.stdout.trim().startsWith("{"), `${args.join(" ")} must render the human report, not JSON`);
      } else {
        assert.ok(result.stdout.trim().startsWith("{"), `${args.join(" ")} promised JSON and must emit an envelope`);
        assert.equal(errorCode(envelope(result)), "INVALID_INPUT", `${args.join(" ")} must be INVALID_INPUT`);
      }
      assert.equal(result.status, 2, `${args.join(" ")} must exit 2, got ${result.status}`);
    }
  });

  check("a parser failure still emits one parseable envelope naming the provenance command", () => {
    const result = cli(["record", "--json", "--not-a-flag"]);
    const parsed = envelope(result);
    assert.equal(parsed.command, "fleet.provenance", "the envelope must name the command that failed, not the first one in the namespace");
    assert.equal(errorCode(parsed), "INVALID_INPUT");
  });

  // -- AC9: credentials are excluded by construction --------------------------

  check("no fleet.env credential name or value reaches the JSON, the report, or the findings", () => {
    const json = cli(["record", "--json"]).stdout;
    const report = cli(["record"]).stdout;
    // The scratch fleet.env really does carry these keys; the seeding above
    // replaced only their VALUES, so the key names are the live ones.
    const seeded = readFileSync(join(scratchHome, ".hermes", "fleet.env"), "utf8");
    assert.ok(CREDENTIAL_KEYS.length >= 2, "the runner must still declare the credential keys this case derives from");
    for (const key of [...CREDENTIAL_KEYS, UNLISTED_KEY]) {
      assert.ok(seeded.includes(key), `the case is vacuous unless the scratch fleet.env carries ${key}`);
      assert.equal(json.includes(key), false, `${key} leaked into the JSON envelope`);
      assert.equal(report.includes(key), false, `${key} leaked into the human report`);
    }
    assert.equal(json.includes(SECRET_SENTINEL), false, "a credential VALUE leaked into the JSON envelope");
    assert.equal(report.includes(SECRET_SENTINEL), false, "a credential VALUE leaked into the human report");
    // And no raw environment map or subprocess output rode along as evidence: a
    // fact value is ONE parsed value, so it never carries a second assignment
    // beside it and never spans a line break.
    const data = JSON.parse(json).data;
    for (const fact of data.facts) {
      for (const side of [fact.desired, fact.observed]) {
        if (side.value === null) continue;
        assert.ok(side.value.length <= 512, `${fact.id}: every emitted string is bounded`);
        assert.doesNotMatch(side.value, /[\r\n]/, `${fact.id}: a fact value must never span lines`);
        assert.ok((side.value.match(/=/gu) ?? []).length <= 1, `${fact.id}: a fact value must not be an environment dump`);
      }
    }
  });

  check("the constructed fleet env still has the shape the real one has", () => {
    // The scratch fleet env is constructed, not copied -- the runner blanks
    // HERMES_FLEET_ENV on purpose. That is only safe while the construction
    // still resembles the real file, so where the real file IS reachable this
    // proves the key set has not drifted apart from it.
    if (!existsSync(REAL_FLEET_ENV)) skipCase("the constructed fleet env still has the shape the real one has", "the real fleet env is not reachable from this run");
    let realKeys;
    try { realKeys = [...readFileSync(REAL_FLEET_ENV, "utf8").matchAll(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1]); }
    catch { skipCase("the constructed fleet env still has the shape the real one has", "the real fleet env is not readable from this run"); }
    const seededKeys = [...readFileSync(join(scratchHome, ".hermes", "fleet.env"), "utf8").matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1]);
    // Only the keys the CODE reads. `FLEET_ENV_KEYS` in the core is the
    // allowlist that is the credential guarantee, so it is also the exact set
    // this scratch file has to be faithful about; the real file exports others
    // (a codex home, an oauth file) that no provenance fact consults, and
    // demanding those would make this check fail on a construction that is
    // correct.
    const core = readFileSync(join(PKG, "src", "org", "provenance.ts"), "utf8");
    const allowlist = [...(/const FLEET_ENV_KEYS = \[([^\]]*)\]/.exec(core)?.[1] ?? "").matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]);
    assert.ok(allowlist.length > 0, "the core must still declare a fleet-env allowlist for this check to mean anything");
    for (const key of allowlist) {
      assert.ok(seededKeys.includes(key), `the core reads ${key} and the constructed fleet env does not export it`);
    }
    for (const key of realKeys.filter((key) => allowlist.includes(key))) {
      assert.ok(seededKeys.includes(key), `the real fleet env exports ${key}, the core reads it, and the constructed one does not; the construction has drifted`);
    }
    for (const key of realKeys.filter((key) => /KEY|TOKEN|SECRET|PASSWORD/.test(key))) {
      assert.ok(seededKeys.includes(key), `the real fleet env carries the credential ${key} and the constructed one does not; the exclusion case would not cover it`);
    }
  });

  check("an unexpanded shell reference is classified, never expanded", () => {
    const data = provenance(cli(["record", "--json"]));
    const fact = factFor(data, "fleet.registry_file");
    assert.ok(fact, "the host pin facts must be reported");
    const seeded = readFileSync(join(scratchHome, ".hermes", "fleet.env"), "utf8");
    if (!/HERMES_FLEET_REGISTRY_FILE=\$/.test(seeded)) {
      skipCase("an unexpanded shell reference is classified", "this host's fleet.env does not spell the registry file with a shell reference");
    }
    assert.match(fact.observed.value, /^\$/, "the value must be reported verbatim");
    assert.equal(fact.observed.family, "shell-variable-reference");
    assert.equal(fact.status, "unsupported", "a comparison that would need an expansion is unsupported, not a match and not drift");
  });

  // -- AC10: the one gap this host records nothing for ------------------------

  check("neither deferred provenance question is carried any more: both are answered by fleet status observers", () => {
    const data = provenance(cli(["record", "--json"]));
    // Story 1.6 (PJAN-108) deleted `scaffold.template_ref`: the scaffold
    // observer compares every role directory against the template at the
    // committed gitlink, so no recorded ref is needed. Story 1.7 (PJAN-109)
    // deleted `profile.render_generation` on the same terms: the profile
    // observer proves the generated config through the canonical renderer's
    // own check, so no recorded generation identity is needed either -- and
    // one permanent `unsupported` beside five real observations was the
    // rollup lie DW-67 records.
    assert.deepEqual(factsFor(data, "scaffold.template_ref"), [], "the deleted scaffold.template_ref fact must not come back");
    assert.deepEqual(factsFor(data, "profile.render_generation"), [], "the deleted profile.render_generation fact must not come back");
    assert.equal(data.facts.some((fact) => fact.field.startsWith("profiles.")), false, "no profile-tree fact remains in provenance; the profile domain owns that tree");
  });

  // -- AC11: CLI and MCP are one core -----------------------------------------

  check("the MCP adapter exists, registers both tools, and adds no option the CLI lacks", () => {
    const source = readFileSync(join(PKG, "src", "org", "mcp.ts"), "utf8");
    for (const tool of ["flume_roster", "flume_record"]) {
      assert.match(source, new RegExp(`registerTool\\(\\s*["']${tool}["']`), `${tool} must be registered from the org module`);
    }
    // One-for-one with the CLI's flags. An option on one adapter and not the
    // other is precisely how "same core, two thin adapters" stops being true.
    const cliSource = readFileSync(join(PKG, "src", "org", "cli.ts"), "utf8");
    const block = cliSource.slice(cliSource.indexOf('program.command("record")'));
    const body = block.slice(0, block.indexOf(".action("));
    const flags = [...body.matchAll(/\.option\("(--[a-z-]+)/g)].map((match) => match[1]).sort();
    assert.deepEqual(flags, ["--agent", "--agent-registry", "--contract", "--deadline-ms", "--json", "--project-registry"], "the CLI flag surface changed; the MCP schema must change with it");
    const schema = [...source.matchAll(/^\s{2}([a-zA-Z]+): z\./gm)].map((match) => match[1]).sort();
    assert.deepEqual(schema, ["agent", "agentRegistry", "contract", "deadlineMs", "projectRegistry"], "the MCP input schema must mirror the CLI flags (minus --json, which is the CLI's rendering choice)");
  });

  // -- read-only, proven against the real sources -----------------------------

  check("a run against the REAL configured sources writes nothing and agrees with an independent read", () => {
    const guarded = [REAL_AGENT_REGISTRY, REAL_TEMPLATE_CONFIG, REAL_FLEET_ENV, TRACKED_CONTRACT];
    const before = { files: guarded.map(fileFingerprint), git: gitIndexFingerprints() };
    const result = spawnSync(process.execPath, [CLI, "record", "--json"], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      // The REAL environment: no isolation, because the point of this case is
      // that the configured sources are what got read.
      env: { ...process.env, NO_COLOR: "1" },
    });
    const after = { files: guarded.map(fileFingerprint), git: gitIndexFingerprints() };
    assert.deepEqual(after, before, "the real sources, and every probed repository's .git/index, must be unchanged");
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const data = provenance(result);

    // The recorded gitlink, read independently of the command.
    const staged = /^160000 ([0-9a-f]{40})/.exec(spawnSync("git", ["ls-files", "--stage", "templates/hermes-agent"], { cwd: ROOT, encoding: "utf8" }).stdout);
    assert.ok(staged, "the tracked template must record a gitlink");
    assert.equal(factFor(data, "template.gitlink").desired.value, staged[1], "desired must equal an independent `git ls-files --stage` read");

    // The configured pin, read WITHOUT `readTomlScalar` -- a grep, so a defect
    // in the reader cannot make both sides agree.
    const configText = readFileSync(REAL_TEMPLATE_CONFIG, "utf8");
    const section = configText.slice(configText.indexOf("[fleet]"));
    const grepped = /^\s*hermes_git_sha\s*=\s*"([^"]+)"/m.exec(section.slice(0, section.indexOf("\n[", 1) === -1 ? section.length : section.indexOf("\n[", 1)));
    if (!grepped) skipCase("the configured pin equals an independent read", "this host's template config declares no [fleet] hermes_git_sha");
    const shaFacts = factsFor(data, "hermes.git_sha");
    assert.ok(shaFacts.length > 0, "the fleet must report a git_sha fact per agent");
    for (const fact of shaFacts) assert.equal(fact.desired.value, grepped[1], "the desired pin must equal an independent grep of the config");
  });

  // -- gates ------------------------------------------------------------------

  check("the mise gate names a module that exists, not a substring that matches", () => {
    const mise = readFileSync(join(ROOT, "mise.toml"), "utf8");
    assert.ok(mise.includes('[tasks."org:record"]'), "the gate must exist");
    const block = mise.slice(mise.indexOf('[tasks."org:record"]'));
    const body = block.slice(0, block.indexOf("\n[tasks") === -1 ? block.length : block.indexOf("\n[tasks"));
    assert.match(body, /depends\s*=\s*\[\s*"build"\s*\]/, "without a build the gate fails with ERR_MODULE_NOT_FOUND, which teaches nothing");
    const run = /run\s*=\s*"([^"]+)"/.exec(body);
    assert.ok(run, "the gate must declare a run line");
    const script = /\{\{\s*config_root\s*\}\}\/(\S+)/.exec(run[1]);
    assert.ok(script, "the run line must resolve its module from config_root, not from the caller's cwd");
    assert.ok(existsSync(join(ROOT, script[1])), `the gate runs ${script[1]}, which does not exist`);
  });

  check("the suite is listed, so it actually runs", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.ok(runner.includes("tests/fleet-provenance-regressions.mjs"), "a suite not listed in SUITES never runs");
  });

  // -- gaps a reviewer demonstrated: each of these fails if its subject breaks --

  check("--contract is threaded, not merely accepted", () => {
    // Deleting `contract: options.contract` at the two CLI call sites used to
    // change nothing any suite could see: `--contract ""` still exited 2 from
    // `requireValue`, and the flag-list assertions read source text. So the flag
    // is proved here by its EFFECT -- the reported contract path and a fact the
    // contract's own content decides.
    const copy = join(temp, "candidate-contract.yaml");
    const document = YAML.parseDocument(readFileSync(join(ROOT, "contracts", "handbook.yaml"), "utf8"));
    // Narrow the retired modes' `detect` patterns to one that matches nothing.
    // `classifyExecutableFamily` asks the CONTRACT for the family it reports, so
    // a contract whose patterns match no live path must stop naming a retired
    // family -- while staying a VALID contract (emptying `retired` outright is
    // rejected: the contract must still declare its superseded modes).
    const retired = document.get("retired");
    assert.ok(retired && retired.items.length > 0, "the tracked contract must declare retired modes");
    for (const mode of retired.items) mode.set("detect", ["matches-no-path-on-any-host-xyzzy"]);
    writeFileSync(copy, String(document), "utf8");

    const tracked = provenance(cli(["record", "--json"]));
    const candidate = provenance(cli(["record", "--contract", copy, "--json"]));

    assert.notEqual(tracked.contract_path, candidate.contract_path, "the override must change the reported contract path");
    assert.match(candidate.contract_path, /candidate-contract\.yaml$/, "the reported path must be the override");

    const retiredFamilies = (data) => factsFor(data, "hermes.executable")
      .map((fact) => fact.observed.family)
      .filter((family) => family !== null && family !== "pinned-release" && family !== "unclassified");
    assert.ok(retiredFamilies(tracked).length > 0, "the tracked contract must name a retired family for this fleet");
    assert.equal(retiredFamilies(candidate).length, 0, "a contract whose detect patterns match nothing must name no retired family");
    // The facts are still emitted -- only the CONTRACT-derived classification moved.
    assert.equal(factsFor(candidate, "hermes.executable").length, factsFor(tracked, "hermes.executable").length, "the override changes classification, not which facts exist");

    // And the same override on `fleet inventory`, whose flag is equally new.
    const inventoryEnvelope = envelope(cli(["roster", "--contract", copy, "--json"]));
    assert.equal(inventoryEnvelope.ok, true);
    assert.match(inventoryEnvelope.data.contract_path, /candidate-contract\.yaml$/, "fleet inventory must honour --contract too");
  });

  check("a deadline large enough to finish lets the run finish, byte for byte", () => {
    // Every other deadline case expects FAILURE, so flipping the sign in
    // `createRunContext` -- or making `remainingMs` count the wrong way -- would
    // have left them all green while turning the flag into a switch that fails
    // at any value. The documented remedy in the failure guidance ("re-run with
    // a larger --deadline-ms") can only mean something if a larger one works.
    const unbounded = provenance(cli(["record", "--json"]));
    const bounded_ = provenance(cli(["record", "--deadline-ms", "600000", "--json"]));
    assert.deepEqual(bounded_, unbounded, "a generous deadline must not change the answer");
  });

  check("fleet inventory enforces the deadline its own flag promises", () => {
    // The flag and the MCP `deadlineMs` argument both document "Fail with
    // TIMEOUT if the whole run has not finished within this budget". Inventory
    // spawns no probe, so it never reaches the pre-spawn budget check inside
    // `probe()`: before `remainingMs` was called in the row loop,
    // `fleet inventory --deadline-ms 1` ran to completion and exited 0.
    const result = cli(["roster", "--deadline-ms", "1", "--json"]);
    assert.equal(errorCode(envelope(result)), "TIMEOUT", "an already-blown deadline must fail the inventory run");
    assert.equal(result.status, 7, `an inventory TIMEOUT must exit 7, got ${result.status}`);
  });

  check("the host pin facts compare the pair they name", () => {
    // `fleet.hermes_bin` and `fleet.hermes_repo` had no assertion at all, so
    // swapping the env keys in the `pairs` table -- reporting the launcher's
    // repo against the config's bin -- flipped both to `mismatch` with nothing
    // to notice. They are the host's own pin: the value every per-agent fact is
    // read against.
    const data = provenance(cli(["record", "--json"]));
    const seededText = readFileSync(join(scratchHome, ".hermes", "fleet.env"), "utf8");
    const seeded = Object.fromEntries([...seededText.matchAll(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/gmu)].map(([, k, v]) => [k, v.trim()]));
    for (const [id, envKey] of [["fleet.hermes_bin", "HERMES_FLEET_BIN"], ["fleet.hermes_repo", "HERMES_FLEET_REPO"]]) {
      const fact = factFor(data, id);
      assert.ok(fact, `${id} must be reported`);
      assert.ok(seeded[envKey], `the scratch fleet env must seed ${envKey} for this case to mean anything`);
      assert.equal(fact.observed.source, "hermes-fleet-env", `${id} must observe the fleet env`);
      assert.equal(fact.desired.source, "hermes-template-config", `${id} must desire the template config`);
      // Seeded from the config's own scalars, so agreement is the expected answer
      // and a crossed pair would be visible as `mismatch`.
      assert.equal(fact.status, "match", `${id} must match when the env is seeded from the config it is compared against`);
    }
  });

  check("the template remote url is read from .gitmodules, not assumed", () => {
    // `readSubmoduleUrl` is a hand-rolled `.gitmodules` section parser whose
    // entire output is the `desired` side of `template.remote_url`. Making it
    // return null unconditionally -- or flushing only the LAST section, an easy
    // off-by-one that would keep working on a two-entry file -- turned the fact
    // `missing` with nothing to catch it, because this fleet is already
    // unhealthy for other reasons.
    const data = provenance(cli(["record", "--json"]));
    const fact = factFor(data, "template.remote_url");
    assert.ok(fact, "template.remote_url must be reported");
    const declared = /\[submodule "templates\/hermes-agent"\][^[]*?url\s*=\s*(\S+)/s.exec(readFileSync(join(ROOT, ".gitmodules"), "utf8"));
    assert.ok(declared, "the suite's own independent read of .gitmodules must find the url");
    assert.equal(fact.desired.value, declared[1], "the desired side must be the url .gitmodules declares");
    assert.notEqual(fact.status, "missing", "a declared url must not report as missing");
  });

  check("a truncation-free drifted fleet separates healthy from complete", () => {
    // `healthy` used to include `truncated.length === 0`, so a clipped but
    // entirely drift-free run reported `healthy: false` -- the exact conflation
    // the two-verdict split exists to prevent, and a contradiction of both the
    // type's doc comment and the README.
    const data = provenance(cli(["record", "--json"]));
    const drifted = data.health.mismatched > 0 || data.health.dirty > 0 || data.health.missing > 0;
    assert.equal(data.health.healthy, !drifted, "healthy must be exactly the absence of drift");
    assert.equal(data.totals.classified_facts + data.totals.dropped_facts, data.totals.facts, "facts must split into classified and dropped");
    const bucketed = Object.values(data.totals.by_status).reduce((sum, n) => sum + n, 0);
    assert.equal(bucketed, data.totals.classified_facts, "every CLASSIFIED fact lands in exactly one status bucket");
  });

  check("a prototype-shaped command word still gets one parseable envelope", () => {
    // The positional word map was a plain object literal, so
    // `positional["constructor"]` answered with a function, that function became
    // the envelope's `command`, and `validateFleetEnvelope` threw out of the very
    // helper that exists to guarantee one parseable envelope. Measured before the
    // fix: a raw stack trace, zero JSON bytes, exit 1.
    for (const word of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
      const result = cli([word, "--json"]);
      const parsed = envelope(result);
      assert.equal(parsed.ok, false, `fleet ${word} --json must fail as an envelope`);
      assert.equal(typeof parsed.command, "string", `fleet ${word} --json must carry a string command`);
      assert.equal(parsed.error.code, "INVALID_INPUT");
      assert.ok(!result.stderr.includes("at validateFleetEnvelope"), `fleet ${word} --json must not print a stack trace`);
      assert.notEqual(result.status, 1, `fleet ${word} --json must stay inside the exit taxonomy, got ${result.status}`);
    }
  });

  check("a redirected git environment cannot answer for a probed checkout", () => {
    // `GIT_DIR` makes `git -C <path> rev-parse` answer about a DIFFERENT
    // repository, which defeats the top-level-equality guard that
    // `probeCheckout` calls its load-bearing defence. A git hook, a `git`
    // wrapper and direnv all export it. The probe env now deletes it, so the
    // answer must be identical with and without it set.
    const decoy = join(temp, "git-dir-decoy");
    makeRepo(decoy, 1);
    const clean = provenance(cli(["record", "--json"]));
    const redirected = provenance(cli(["record", "--json"], {
      GIT_DIR: join(decoy, ".git"),
      GIT_WORK_TREE: decoy,
    }));
    assert.deepEqual(redirected, clean, "an ambient GIT_DIR/GIT_WORK_TREE must not change what a probe observes");
  });

  check("the CLI and the MCP adapter give the same guidance, not just the same data", () => {
    // `next_actions` is a first-class envelope field the validator checks, and
    // the two adapters build it from hand-duplicated strings. The parity case
    // compares `command`, `data` and `error` only, so the copies could drift
    // indefinitely while staying green -- and `next_actions` is exactly the half
    // of "two thin adapters" that was copied.
    // Scoped to the two SUCCESS-path builders, which `src/fleet/mcp.ts` says are
    // "the CLI's own next_actions, reproduced exactly". The failure-path guidance
    // is deliberately NOT compared: it names the surface the caller used
    // (`--deadline-ms` on one side, `deadlineMs` on the other), so requiring it to
    // be identical would forbid the one difference that is correct.
    const guidance = (file) => {
      const source = readFileSync(join(PKG, "src", "org", file), "utf8");
      const lines = [];
      // `statusEnvelope` was added by story 1.4 and NOT added here, so the
      // status command's five hand-duplicated guidance strings were outside every
      // check that the two adapters agree.
      for (const fn of ["inventoryEnvelope", "provenanceEnvelope", "statusEnvelope"]) {
        const start = source.indexOf(`function ${fn}(`);
        assert.notEqual(start, -1, `${file} must define ${fn} for this case to mean anything`);
        const body = source.slice(start, source.indexOf("\n}", start));
        for (const match of body.matchAll(/"((?:[^"\\]|\\.){30,})"/g)) lines.push(match[1]);
      }
      return lines.sort();
    };
    const fromCli = guidance("cli.ts");
    const fromMcp = guidance("mcp.ts");
    assert.ok(fromMcp.length >= 9, `the MCP adapter must carry its guidance strings for this case to mean anything, found ${fromMcp.length}`);
    // SUBSET, not equality: the CLI carries one extra human-path line ("Re-run
    // with --json for the complete row set") that it pops before emitting JSON,
    // and which has no business existing on a protocol the caller reaches
    // programmatically. Every string the MCP adapter DOES emit must still be the
    // CLI's own.
    for (const line of fromMcp) {
      assert.ok(fromCli.includes(line), `the MCP adapter's guidance has drifted from the CLI's: "${line.slice(0, 70)}..."`);
    }
  });

} catch (error) {
  if (!(error instanceof SkipSuite)) throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(probeLog, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} fleet provenance check(s) failed`);
  process.exit(1);
}
console.log(`fleet provenance regressions passed${skipped ? ` (${skipped} skipped)` : ""}`);
