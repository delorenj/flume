// PJAN Epic 1 / Story 1.2: discover the complete fleet and detect identity conflicts.
//
// The defect class this suite exists for is not "inventory has a bug". It is
// that nothing in this repo could answer "what is the whole fleet, and where
// does it disagree with itself?" without inventing part of the answer:
//
//   * `readHermesAgentBoards` projects 6 of ~43 live per-agent fields and throws
//     raw ENOENT on a missing file.
//   * `loadProjectRegistry` THROWS on exactly the duplicates (slug, repo_path,
//     board_id, identifier) this command has to REPORT. A suite that reused it
//     would test a loader that refuses to load the drift.
//   * `ownedRegistryEntries` is scoped to one repository on purpose.
//
// So the bar is the same awkward one story 1.1 set:
//
//   * Every case runs the REAL built `dist/index.js` in a real subprocess over
//     real OS pipes, because a complete document on a TTY and a truncated one
//     under capture is the defect this epic exists to stop reproducing.
//   * Every registry case is derived by `YAML.parseDocument`-MUTATING A COPY OF
//     A REAL REGISTRY. A hand-authored "invalid registry" drifts away from the
//     real one and then tests a file nobody has.
//   * stdout is asserted non-empty and parseable BEFORE anything is asserted
//     about its content.
//   * Every invocation, including the failing ones, is bracketed by a
//     content+mtime snapshot of the scratch HOME, the working directory and
//     TMPDIR, recording directories and symlinks as themselves.
//   * One case runs against the REAL configured registries and proves the
//     emitted row count equals an independent `YAML.parse` count of the live
//     `agents` keys, with both real files unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
// The workspace that owns the CLI. `dist/` lives under the package; the handbook
// stays at the repo root, so the two roots are not interchangeable.
const PKG = join(ROOT, "packages", "flume-hr");
const CLI = join(PKG, "dist", "index.js");
const TRACKED_CONTRACT = join(ROOT, "contracts", "handbook.yaml");

/**
 * The registries this fleet actually runs on.
 *
 * Derived, never written as a literal: `portable-test-paths-regressions` fails
 * the build on a hardcoded `/home/<name>` in any `*-regressions.mjs`, and a
 * literal would also make the suite a fiction on any other machine.
 */
const REAL_HOME = (() => { try { return userInfo().homedir; } catch { return homedir(); } })();
const REAL_AGENT_REGISTRY = process.env.HERMES_AGENTS_REGISTRY?.trim() || join(REAL_HOME, ".hermes", "agents-registry.yaml");
const REAL_PROJECT_REGISTRY = process.env.PJ_PROJECT_REGISTRY?.trim() || join(REAL_HOME, ".config", "pjangler", "projects.yaml");

/** A store this suite can copy: present, a regular file, and readable. */
const isReadableFile = (path) => { try { return lstatSync(path).isFile(); } catch { return false; } };

const temp = mkdtempSync(join(tmpdir(), "fleet-inventory-"));
const scratchHome = join(temp, "home");
let failures = 0;
let skipped = 0;

/** Thrown to leave the suite body when the host cannot express any case at all. */
class SkipSuite extends Error {}

/** A case the host cannot express (no live registry, say). Loud, never silent. */
function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP ${label}: ${reason}`);
}

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${String(error.message).split("\n")[0]}`);
  }
}

/**
 * A scratch HOME the command has no business writing to.
 *
 * Every store the fleet contract names is pointed inside it. The two canonical
 * registries are seeded with VERBATIM COPIES of the real ones, so the default
 * (unflagged) invocation inventories real fleet content without any risk of the
 * command reaching the real files. Git discovery is ceilinged and host git
 * config dropped for the same reason as the hermes deploy suite: otherwise
 * whatever checkout happens to contain TMPDIR answers for the fixture.
 */
function seedHome() {
  mkdirSync(join(scratchHome, ".hermes", "profiles"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "systemd", "user"), { recursive: true });
  copyFileSync(REAL_AGENT_REGISTRY, join(scratchHome, ".hermes", "agents-registry.yaml"));
  copyFileSync(REAL_PROJECT_REGISTRY, join(scratchHome, ".config", "pjangler", "projects.yaml"));
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
  PJ_PROJECT_REGISTRY: join(scratchHome, ".config", "pjangler", "projects.yaml"),
  HERMES_TEMPLATE_RUNTIME_SCAFFOLD: join(scratchHome, ".hermes", "runtime-scaffold"),
  RUNTIME_SCAFFOLD_DIR: join(scratchHome, ".hermes", "runtime-scaffold"),
  GIT_CEILING_DIRECTORIES: realpathSync(temp),
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
  TMPDIR: temp,
  NO_COLOR: "1",
};

/**
 * Content hash + mtime for every entry under a tree, keyed by relative path.
 *
 * Directories are recorded, not just walked: a command that created an empty
 * profile or registry directory was previously invisible. Symlinks are recorded
 * by target rather than followed -- which matters more here than anywhere,
 * because this suite deliberately plants a symlink in the profile root and the
 * command must classify it without following it.
 */
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

/** File digest + mtime for one path, for the real-registry zero-write proof. */
function fileFingerprint(path) {
  if (!existsSync(path)) return "absent";
  const stat = lstatSync(path);
  return `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${stat.mtimeMs}`;
}

function snapshot() {
  const entries = {};
  snapshotTree("home", scratchHome, entries);
  snapshotTree("cwd", temp, entries);
  snapshotTree("contracts", join(ROOT, "contracts"), entries);
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
    timeout: 60_000,
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
  return parsed.error.code;
}

/** A successful inventory envelope with its invariants already checked. */
function inventory(result) {
  const parsed = envelope(result);
  assert.equal(parsed.ok, true, `expected ok:true, got ${JSON.stringify(parsed.error)}`);
  assert.equal(parsed.error, null, "ok envelopes carry no error");
  assert.equal(parsed.command, "fleet.inventory");
  for (const key of ["stores", "totals", "health", "rows", "conflicts", "findings", "truncated"]) {
    assert.notEqual(parsed.data[key], undefined, `data.${key} must be present`);
  }
  return parsed.data;
}

/**
 * Derive a registry case by mutating a COPY of a real registry.
 *
 * Never a hand-authored fixture: a parallel invalid registry stops resembling
 * the real one the first time the real one changes, and then the suite proves
 * something about a file nobody has.
 */
function mutatedRegistry(name, sourcePath, mutate) {
  const document = YAML.parseDocument(readFileSync(sourcePath, "utf8"));
  mutate(document);
  const path = join(temp, `${name}.yaml`);
  writeFileSync(path, String(document), "utf8");
  return path;
}

function rawCopy(name, text) {
  const path = join(temp, `${name}.yaml`);
  writeFileSync(path, text, "utf8");
  return path;
}

/** The agent ids of a real registry, read independently of the command. */
function realAgentIds(path) {
  const parsed = YAML.parse(readFileSync(path, "utf8"));
  return Object.keys(parsed?.agents ?? {});
}

/**
 * A relocated package root carrying a mutated contract.
 *
 * The managed-exception mechanism lives IN the contract, so proving it through
 * the real built CLI needs the CLI to resolve a different contract.
 * `resolveFleetContractPath` walks up from the running module for `package.json`
 * + `contracts/handbook.yaml`, so a copy of the bundle beside a copy of
 * the contract is the whole trick. `node_modules` is symlinked because the
 * bundle keeps its dependencies external.
 *
 * `flume roster` DOES now take `--contract` (story 1.3 added it to both fleet
 * commands so the two adapters share one option surface). This relocation is
 * kept anyway, and deliberately: it proves contract resolution through the
 * DEFAULT path -- the walk-up every real invocation uses -- which the flag would
 * bypass rather than exercise.
 */
function packageWithContract(name, mutate) {
  const dir = join(temp, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  copyFileSync(CLI, join(dir, "dist", "index.js"));
  const document = YAML.parseDocument(readFileSync(TRACKED_CONTRACT, "utf8"));
  mutate(document);
  writeFileSync(join(dir, "contracts", "handbook.yaml"), String(document), "utf8");
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, version: "0.0.0", type: "module" }, null, 2)}\n`, "utf8");
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return join(dir, "dist", "index.js");
}

console.log("fleet inventory: registry-wide discovery and identity conflicts");

/**
 * Every case below derives from the two REAL registries -- that is the point of
 * the suite, and it is not negotiable: a hand-authored registry stops resembling
 * the real one and then proves something about a file nobody has.
 *
 * But "the operator's laptop has them" is not a property of a test host. On a
 * fresh clone, on CI, on a second machine, `seedHome`'s `copyFileSync` threw
 * ENOENT straight out of the harness and `run-tests.mjs` reported the whole
 * suite FAILED -- indistinguishable from a real regression. A host that cannot
 * express these cases skips them, loudly, and the run stays honest.
 */
const missingStore = [
  [REAL_AGENT_REGISTRY, "the Hermes agent registry"],
  [REAL_PROJECT_REGISTRY, "the PJangler project registry"],
  // `existsSync` alone is not the question. On this host something had left a
  // root-owned DIRECTORY where `~/.config/pjangler/projects.yaml` belongs, which
  // is `exists: true` and then threw EISDIR out of `seedHome`'s copy -- the
  // loud skip this guard exists for, reported as a suite crash instead.
].find(([path]) => !isReadableFile(path));

try {
  if (missingStore) {
    skip(
      "the whole suite",
      `${missingStore[1]} is not on this host (${relative(REAL_HOME, missingStore[0])}); every case derives from a copy of a real registry`,
    );
    throw new SkipSuite();
  }
  seedHome();

  const liveIds = realAgentIds(REAL_AGENT_REGISTRY);

  /**
   * A case that needs N distinct live agents to express itself.
   *
   * `liveIds[0]` / `const [first, second] = liveIds` on a host with a smaller
   * fleet destructures `undefined` and the case reports FAIL -- the very
   * "indistinguishable from a real regression" outcome the suite-level guard
   * above was added to prevent, reproduced one level down. The guard only knows
   * whether the FILES exist; this knows whether they carry enough to mutate.
   */
  function checkWithAgents(count, label, body) {
    if (liveIds.length < count) { skip(label, `needs ${count} live agents, this host has ${liveIds.length}`); return; }
    check(label, body);
  }

  // -- the whole fleet, through the real built CLI --------------------------

  check("the human report leads with the health verdict and the real totals", () => {
    const result = cli(["roster"]);
    assert.notEqual(result.stdout, "", "human report must not be empty");
    assert.equal(result.status, 0, `an unhealthy fleet is data, not a failure exit: got ${result.status} ${result.stderr}`);
    const out = result.stdout;
    // The verdict has to precede the rows, or "the command worked" reads as
    // "the fleet is fine".
    assert.match(out.split("\n").slice(0, 3).join("\n"), /Fleet inventory healthy|Org chart ON NOTICE/, "health verdict must lead");
    assert.match(out, /source_rows\s+\d+/);
    assert.match(out, /emitted_rows\s+\d+/);
    assert.ok(out.indexOf("Fleet inventory") < out.indexOf("Agents"), "the verdict must come before the row dump");
  });

  check("--json is one complete envelope with every declared data key", () => {
    const result = cli(["roster", "--json"]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const data = inventory(result);
    assert.equal(data.scope.kind, "fleet");
    assert.ok(Array.isArray(data.rows));
    // Bigger than the observed 8 KiB truncation threshold, through a real pipe.
    assert.ok(result.stdout.length > 8192, `payload is only ${result.stdout.length} bytes; below the observed truncation threshold`);
  });

  check("source_rows is counted independently and equals emitted_rows", () => {
    const data = inventory(cli(["roster", "--json"]));
    const independent = realAgentIds(join(scratchHome, ".hermes", "agents-registry.yaml"));
    assert.equal(data.totals.source_rows, independent.length, "source_rows must equal an independent count of the raw agents keys");
    assert.equal(data.totals.emitted_rows, data.totals.source_rows, "a row lost between counting and building must be visible here");
    const ids = data.rows.map((row) => row.agent_id.value);
    assert.deepEqual([...new Set(ids)].sort(), [...independent].sort(), "every agent id appears exactly once");
    assert.equal(ids.length, independent.length);
  });

  check("rows are ordered by agent id byte order, deterministically", () => {
    const first = inventory(cli(["roster", "--json"])).rows.map((row) => row.agent_id.value);
    const second = inventory(cli(["roster", "--json"])).rows.map((row) => row.agent_id.value);
    assert.deepEqual(first, second, "two runs must agree");
    const sorted = [...first].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(first, sorted, "rows must be in byte order, not locale order");
  });

  // -- AC3: every field carries value + source + state ----------------------

  // `repo`, `correlation` and `gateway_unit` are `FleetFieldValue` cells on every
  // row and were absent from this allowlist -- `repo` is the very field the live
  // `automatic-ai` conflict sits on, so the AC3 sweep skipped the cell most
  // likely to be contested.
  const REQUIRED_FIELDS = [
    "agent_id", "classification", "correlation", "project_id", "repo", "repo_path",
    "role", "role_dir", "profile_name", "profile_path", "runtime_path",
    "expected_units", "gateway_unit", "board",
    "bloodbank_scope", "bloodbank_target", "activation", "activation_field",
  ];

  check("every row carries every required field as {value, source, state}", () => {
    const data = inventory(cli(["roster", "--json"]));
    assert.ok(data.rows.length > 0, "no rows to inspect");
    for (const row of data.rows) {
      for (const key of REQUIRED_FIELDS) {
        const cell = row[key];
        assert.ok(cell && typeof cell === "object", `${row.agent_id.value}.${key} is missing`);
        for (const part of ["value", "source", "state"]) {
          assert.ok(part in cell, `${row.agent_id.value}.${key} has no ${part}`);
        }
        assert.ok(
          ["resolved", "unresolved", "conflicted", "unobserved"].includes(cell.state),
          `${row.agent_id.value}.${key}.state is ${cell.state}`,
        );
        // Either the value is known and names who owns it, or it is explicitly
        // null and explicitly not resolved. Never a value with no provenance,
        // and never a silent absence.
        if (cell.value === null) {
          assert.ok(["unresolved", "unobserved"].includes(cell.state), `${row.agent_id.value}.${key} is null at state ${cell.state}`);
        } else {
          assert.ok(typeof cell.source === "string" && cell.source.length > 0, `${row.agent_id.value}.${key} has a value but no source`);
        }
      }
    }
  });

  check("the manifest is confirming evidence and is never a field's source", () => {
    const data = inventory(cli(["roster", "--json"]));
    const owners = new Set();
    for (const row of data.rows) {
      assert.ok(row.manifest && typeof row.manifest === "object", "every row carries a manifest block");
      assert.ok(["present", "agrees", "notes", "path"].every((key) => key in row.manifest));
      for (const key of REQUIRED_FIELDS) if (row[key].source) owners.add(row[key].source);
    }
    for (const owner of owners) {
      assert.ok(!/manifest|project\.json/i.test(owner), `.project.json leaked into a field source: ${owner}`);
    }
    // The owners actually used must all be authorities the contract declares.
    const contract = YAML.parse(readFileSync(TRACKED_CONTRACT, "utf8"));
    const declared = new Set(Object.values(contract.authorities).map((authority) => authority.owner));
    for (const owner of owners) assert.ok(declared.has(owner), `${owner} is not an authority the contract declares`);
  });

  check("expected unit names are reported as expectations, never as observations", () => {
    const data = inventory(cli(["roster", "--json"]));
    const contract = YAML.parse(readFileSync(TRACKED_CONTRACT, "utf8"));
    const patterns = Object.values(contract.service_model.per_agent);
    for (const row of data.rows) {
      if (row.expected_units.value === null) continue;
      assert.equal(row.expected_units.state, "unobserved", "systemd is not probed by this story");
      const wanted = patterns.map((pattern) => pattern.replace("{agent_id}", row.agent_id.value)).sort();
      assert.deepEqual([...row.expected_units.value].sort(), wanted, "unit names must come from the contract's service model");
    }
  });

  // -- AC2: an unlinked agent is still fully inventoried --------------------

  check("an agent with no project record is still emitted, with a named owner", () => {
    const emptyProjects = mutatedRegistry("no-projects", REAL_PROJECT_REGISTRY, (document) => {
      document.set("projects", document.createNode({}));
    });
    const data = inventory(cli(["roster", "--project-registry", emptyProjects, "--json"]));
    assert.equal(data.totals.emitted_rows, data.totals.source_rows, "every other agent must still be inventoried");
    assert.equal(data.totals.correlated, 0);
    assert.equal(data.totals.uncorrelated, data.totals.emitted_rows);
    for (const row of data.rows) {
      assert.equal(row.project_id.state, "unresolved");
      assert.equal(row.project_id.value, null);
      assert.ok(row.findings.includes("project-record-missing"), `${row.agent_id.value} raised no missing-record finding`);
    }
    const finding = data.findings.find((item) => item.code === "project-record-missing");
    assert.ok(finding, "a finding must name the missing record");
    assert.match(finding.field, /^projects\./, "the finding must name the project registry's field path");
    assert.equal(finding.source, "project-registry", "the finding must name the owning store");
  });

  // -- AC8: paths are classified, never followed ----------------------------

  check("a missing role directory is unresolved and nothing is created", () => {
    const target = join(scratchHome, "absent-role-dir");
    const registry = mutatedRegistry("absent-role-dir", REAL_AGENT_REGISTRY, (document) => {
      const agents = document.get("agents");
      const id = agents.items[0].key.value;
      document.setIn(["agents", id, "role_dir"], target);
    });
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const row = data.rows.find((item) => item.paths.role_dir.declared?.endsWith("absent-role-dir"));
    assert.ok(row, "the mutated row was not found");
    assert.equal(row.paths.role_dir.classification, "absent");
    assert.equal(row.role_dir.state, "unresolved");
    assert.equal(existsSync(target), false, "the command created the directory it was asked to inspect");
  });

  check("a symlinked profile directory is reported, cited, and never followed", () => {
    const linkTarget = join(temp, "elsewhere-profile");
    mkdirSync(linkTarget, { recursive: true });
    const profileName = "linked-profile";
    const linkPath = join(scratchHome, ".hermes", "profiles", profileName);
    if (!existsSync(linkPath)) symlinkSync(linkTarget, linkPath);
    const registry = mutatedRegistry("symlinked-profile", REAL_AGENT_REGISTRY, (document) => {
      const id = document.get("agents").items[0].key.value;
      document.setIn(["agents", id, "profile_name"], profileName);
    });
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const row = data.rows.find((item) => item.profile_name.value === profileName);
    assert.ok(row, "the mutated row was not found");
    assert.equal(row.paths.profile_path.classification, "symlink");
    assert.equal(row.profile_path.state, "unresolved");
    // The DECLARED path is reported; the realpath is evidence beside it, never
    // a substitute for it.
    assert.match(row.profile_path.value, /profiles\/linked-profile$/, "the declared path must survive");
    assert.ok(row.paths.profile_path.link_target?.includes("elsewhere-profile"), "the link target must be recorded as evidence");
    const finding = data.findings.find((item) => item.code === "profile-path-symlinked");
    assert.ok(finding, "a symlinked profile must raise a finding");
    assert.match(finding.detail, /symlink_allowed/, "the finding must cite the contract's declaration");
  });

  check("a relative path is classified, not resolved against the working directory", () => {
    const registry = mutatedRegistry("relative-role-dir", REAL_AGENT_REGISTRY, (document) => {
      const id = document.get("agents").items[0].key.value;
      document.setIn(["agents", id, "role_dir"], "agents/hermes/pm");
    });
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const row = data.rows.find((item) => item.paths.role_dir.declared === "agents/hermes/pm");
    assert.ok(row, "the mutated row was not found");
    assert.equal(row.paths.role_dir.classification, "relative");
  });

  // -- AC5: identity conflicts ----------------------------------------------

  checkWithAgents(2, "two agents sharing a board identifier land in one group, and exit stays 0", () => {
    const registry = mutatedRegistry("dup-identifier", REAL_AGENT_REGISTRY, (document) => {
      const [first, second] = document.get("agents").items.map((item) => item.key.value);
      document.setIn(["agents", first, "plane", "identifier"], "DUPES");
      document.setIn(["agents", second, "plane", "identifier"], "DUPES");
    });
    const result = cli(["roster", "--agent-registry", registry, "--json"]);
    assert.equal(result.status, 0, "a fleet that disagrees with itself is data, not a command failure");
    const data = inventory(result);
    const group = data.conflicts.find((item) => item.value === "DUPES");
    assert.ok(group, `no group for the injected duplicate: ${JSON.stringify(data.conflicts.map((item) => item.value))}`);
    assert.equal(group.field, "agents.{agent_id}.plane.identifier");
    assert.equal(group.participants.length, 2);
    assert.deepEqual(group.owners, ["project-registry"], "the group must name the declared owner of the field");
    assert.equal(data.health.healthy, false, "an unpermitted conflict is unhealthy");
    for (const id of group.participants) {
      const row = data.rows.find((item) => item.agent_id.value === id);
      assert.ok(row, `${id} was dropped from the rows`);
      assert.ok(row.conflicts.includes(group.id), "both rows must carry the identical group id");
      assert.equal(row.board.state, "conflicted", "the conflicting field must say so");
    }
  });

  checkWithAgents(2, "two agents sharing a repo slug land in one group under agents.{agent_id}.repo", () => {
    const registry = mutatedRegistry("dup-repo", REAL_AGENT_REGISTRY, (document) => {
      const [first, second] = document.get("agents").items.map((item) => item.key.value);
      document.setIn(["agents", first, "repo"], "shared-repo-slug");
      document.setIn(["agents", second, "repo"], "shared-repo-slug");
    });
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const group = data.conflicts.find((item) => item.value === "shared-repo-slug");
    assert.ok(group, "no group for the injected duplicate repo");
    assert.equal(group.field, "agents.{agent_id}.repo");
    assert.deepEqual(group.owners, ["agent-registry"]);
    assert.equal(group.participants.length, 2);
  });

  checkWithAgents(3, "two spellings of one repository path are one claim, not two", () => {
    // "/x/y", "/x/y/" and "/x/y/../y" are the same repository. Grouping on the
    // raw string would report three innocent-looking agents instead of one
    // three-way conflict -- and resolving with `realpath` would follow a link,
    // which this command must never do.
    const registry = mutatedRegistry("dup-project-path", REAL_AGENT_REGISTRY, (document) => {
      const [first, second, third] = document.get("agents").items.map((item) => item.key.value);
      const shared = join(scratchHome, "shared-project-path");
      document.setIn(["agents", first, "project_path"], shared);
      document.setIn(["agents", second, "project_path"], `${shared}/`);
      document.setIn(["agents", third, "project_path"], `${shared}/nested/..`);
    });
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const group = data.conflicts.find((item) => item.field === "agents.{agent_id}.project_path");
    assert.ok(group, `no project_path group: ${JSON.stringify(data.conflicts.map((item) => item.field))}`);
    assert.equal(group.participants.length, 3, "all three spellings must land in one group");
    assert.equal(
      data.conflicts.filter((item) => item.field === "agents.{agent_id}.project_path").length,
      1,
      "one repository must produce one group",
    );
  });

  checkWithAgents(2, "a group id is stable across runs and identical for every participant", () => {
    const registry = mutatedRegistry("dup-profile", REAL_AGENT_REGISTRY, (document) => {
      const [first, second] = document.get("agents").items.map((item) => item.key.value);
      document.setIn(["agents", first, "profile_name"], "shared-profile");
      document.setIn(["agents", second, "profile_name"], "shared-profile");
    });
    const first = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const second = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const groupA = first.conflicts.find((item) => item.value === "shared-profile");
    const groupB = second.conflicts.find((item) => item.value === "shared-profile");
    assert.ok(groupA && groupB, "no group for the injected duplicate profile");
    assert.equal(groupA.id, groupB.id, "the group id must be stable across runs");
    assert.match(groupA.id, /^conflict:agents\.\{agent_id\}\.profile_name:[0-9a-f]{12}$/);
    const ids = groupA.participants.map((id) => first.rows.find((row) => row.agent_id.value === id).conflicts);
    for (const list of ids) assert.ok(list.includes(groupA.id), "every participant carries the same id");
  });

  checkWithAgents(1, "a duplicate raw agent identity key is reported, not fatal", () => {
    // A duplicate mapping key is a parser ERROR by default -- the run would die
    // on the exact drift AC5 asks for. Written as raw text because a YAML
    // document object cannot hold two identical keys to begin with.
    const text = readFileSync(REAL_AGENT_REGISTRY, "utf8");
    const parsed = YAML.parse(text);
    const victim = Object.keys(parsed.agents)[0];
    const duplicated = `${text.trimEnd()}\n  ${victim}:\n    repo: duplicate-key-probe\n`;
    const path = rawCopy("duplicate-agent-key", duplicated);
    const data = inventory(cli(["roster", "--agent-registry", path, "--json"]));
    assert.equal(data.totals.source_rows, Object.keys(parsed.agents).length + 1, "both raw entries must be counted");
    assert.equal(data.totals.emitted_rows, data.totals.source_rows, "both raw entries must be emitted");
    const group = data.conflicts.find((item) => item.field === "agents.{agent_id}" && item.value === victim);
    assert.ok(group, `no duplicate-identity group for ${victim}`);
    assert.equal(data.health.healthy, false);
  });

  check("a project registry with a duplicate slug is reported, where the loader would throw", () => {
    const registry = mutatedRegistry("dup-project-slug", REAL_PROJECT_REGISTRY, (document) => {
      const [first, second] = document.get("projects").items.map((item) => item.key.value);
      document.setIn(["projects", first, "slug"], "shared-slug");
      document.setIn(["projects", second, "slug"], "shared-slug");
    });
    const result = cli(["roster", "--project-registry", registry, "--json"]);
    assert.equal(result.status, 0, "the command must succeed where loadProjectRegistry throws");
    const data = inventory(result);
    const group = data.conflicts.find((item) => item.field === "projects.{slug}" && item.value === "shared-slug");
    assert.ok(group, `no duplicate-slug group: ${JSON.stringify(data.conflicts.map((item) => `${item.field}=${item.value}`))}`);
    assert.equal(group.participant_kind, "project");
    assert.equal(group.participants.length, 2);
  });

  check("a project registry with a duplicate repo_path is reported", () => {
    const registry = mutatedRegistry("dup-repo-path", REAL_PROJECT_REGISTRY, (document) => {
      const [first, second] = document.get("projects").items.map((item) => item.key.value);
      const shared = join(scratchHome, "shared-repo-path");
      document.setIn(["projects", first, "repo_path"], shared);
      document.setIn(["projects", second, "repo_path"], shared);
    });
    const data = inventory(cli(["roster", "--project-registry", registry, "--json"]));
    const group = data.conflicts.find((item) => item.field === "projects.{slug}.repo_path");
    assert.ok(group, "no duplicate repo_path group");
    assert.equal(group.participants.length, 2);
  });

  // -- AC6: a declared managed exception -------------------------------------

  checkWithAgents(2, "a managed exception permits exactly its own group, and only while declared", () => {
    // Start from a copy of the real registry with the two LIVE conflicts removed,
    // so the only conflict in the fixture is the one this case injects. The live
    // conflicts are real drift for an operator to rule on; this story detects
    // them and deliberately ships no exception entry for them.
    const registry = mutatedRegistry("exception-fixture", REAL_AGENT_REGISTRY, (document) => {
      const agents = document.get("agents");
      const ids = agents.items.map((item) => item.key.value);
      const byRepo = new Map();
      const byIdentifier = new Map();
      for (const id of ids) {
        const repo = document.getIn(["agents", id, "repo"]);
        const identifier = document.getIn(["agents", id, "plane", "identifier"]);
        if (repo) byRepo.set(repo, [...(byRepo.get(repo) ?? []), id]);
        if (identifier) byIdentifier.set(identifier, [...(byIdentifier.get(identifier) ?? []), id]);
      }
      for (const map of [byRepo, byIdentifier]) {
        for (const list of map.values()) {
          if (list.length < 2) continue;
          for (const id of list.slice(1)) document.deleteIn(["agents", id]);
        }
      }
    });
    const baseline = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    assert.equal(baseline.conflicts.length, 0, `the fixture must start clean: ${JSON.stringify(baseline.conflicts.map((item) => item.value))}`);
    assert.equal(baseline.health.healthy, true, `the fixture must start healthy: ${JSON.stringify(baseline.health)}`);

    const survivors = YAML.parse(readFileSync(registry, "utf8"));
    const [alpha, beta] = Object.keys(survivors.agents);
    const conflicted = mutatedRegistry("exception-conflict", registry, (document) => {
      document.setIn(["agents", alpha, "profile_name"], "exception-profile");
      document.setIn(["agents", beta, "profile_name"], "exception-profile");
    });

    const unpermitted = inventory(cli(["roster", "--agent-registry", conflicted, "--json"]));
    const group = unpermitted.conflicts.find((item) => item.value === "exception-profile");
    assert.ok(group, "the injected conflict was not detected");
    assert.equal(group.permitted, false);
    assert.equal(unpermitted.health.healthy, false, "without an exception the identical fleet is unhealthy");

    // The exception is declared where the contract already has a home for it:
    // `classifications.intentionally_unmanaged.entries`. Extra keys on an entry
    // are accepted, so `participants` needs no schema change and no new root key
    // (which would bump contract_version and re-open story 1.1's surface).
    const permittedCli = packageWithContract("exception-pkg", (document) => {
      document.addIn(["classifications", "intentionally_unmanaged", "entries"], document.createNode({
        id: "exception-profile-shared",
        kind: "identity-conflict-exception",
        owner: "agent-registry",
        source: "agents.{agent_id}.profile_name",
        lifecycle_state: "accepted",
        rationale: "Two agents intentionally share one generated profile in this fixture.",
        policy_domains: ["identity", "profile"],
        participants: [alpha, beta].sort(),
      }));
    });
    const permitted = inventory(cliAt(permittedCli, ["roster", "--agent-registry", conflicted, "--json"]));
    const permittedGroup = permitted.conflicts.find((item) => item.value === "exception-profile");
    assert.ok(permittedGroup, "a permitted group is still fully reported");
    assert.equal(permittedGroup.permitted, true);
    assert.equal(permittedGroup.exception_id, "exception-profile-shared");
    assert.equal(permitted.health.healthy, true, `a permitted conflict keeps the aggregate healthy: ${JSON.stringify(permitted.health)}`);
    assert.equal(permitted.totals.permitted_conflict_groups, 1);

    // A superset must not silently absorb a third claimant nobody ruled on.
    const widened = mutatedRegistry("exception-widened", conflicted, (document) => {
      const third = Object.keys(YAML.parse(readFileSync(conflicted, "utf8")).agents).find((id) => id !== alpha && id !== beta);
      document.setIn(["agents", third, "profile_name"], "exception-profile");
    });
    const absorbed = inventory(cliAt(permittedCli, ["roster", "--agent-registry", widened, "--json"]));
    const widenedGroup = absorbed.conflicts.find((item) => item.value === "exception-profile");
    assert.ok(widenedGroup, "the widened group was not detected");
    assert.equal(widenedGroup.participants.length, 3);
    assert.equal(widenedGroup.permitted, false, "an exception must not absorb a claimant it never named");
    assert.equal(absorbed.health.healthy, false);
  });

  // -- AC7: a malformed row is one finding, not a dead run -------------------

  check("a malformed agent row keeps its raw key and never sinks the run", () => {
    const registry = mutatedRegistry("malformed-row", REAL_AGENT_REGISTRY, (document) => {
      const id = document.get("agents").items[0].key.value;
      document.setIn(["agents", id], "this row is a scalar, not a mapping");
    });
    const result = cli(["roster", "--agent-registry", registry, "--json"]);
    assert.equal(result.status, 0, "one bad row must not sink the run");
    const data = inventory(result);
    const victim = YAML.parse(readFileSync(registry, "utf8"));
    const id = Object.keys(victim.agents)[0];
    assert.equal(data.totals.malformed_rows, 1);
    assert.equal(data.totals.emitted_rows, data.totals.source_rows);
    const row = data.rows.find((item) => item.agent_id.value === id);
    assert.ok(row, "the malformed row's raw identity key must still be present");
    assert.equal(row.malformed, true);
    assert.ok(row.findings.includes("agent-row-malformed"));
    // Every other row is complete.
    for (const other of data.rows) {
      if (other.agent_id.value === id) continue;
      assert.equal(other.malformed, false, `${other.agent_id.value} was collateral damage`);
    }
  });

  check("a non-string field is a bounded diagnostic, never a unit name", () => {
    const registry = mutatedRegistry("non-string-role-dir", REAL_AGENT_REGISTRY, (document) => {
      const id = document.get("agents").items[0].key.value;
      document.setIn(["agents", id, "role_dir"], 42);
    });
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const finding = data.findings.find((item) => item.code === "agent-field-malformed");
    assert.ok(finding, "a non-string field must raise a finding");
    assert.ok(finding.detail.length <= 512, "diagnostics are bounded");
  });

  check("an unsafe agent id never becomes a unit name or a path segment", () => {
    const registry = mutatedRegistry("unsafe-agent-id", REAL_AGENT_REGISTRY, (document) => {
      const agents = document.get("agents");
      const donor = agents.items[0];
      document.setIn(["agents", "../escape"], donor.value.clone());
    });
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const row = data.rows.find((item) => item.agent_id.value === "../escape");
    assert.ok(row, "the raw identity key must still be reported");
    assert.equal(row.expected_units.value, null, "no unit name may be derived from an unsafe id");
    assert.equal(row.expected_units.state, "unresolved");
    assert.ok(row.findings.includes("agent-id-unsafe"));
    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes("hermes-../escape"), false, "an unsafe id reached a unit name");
  });

  // -- AC9: scoping -----------------------------------------------------------

  checkWithAgents(1, "--agent <known> emits one row and still reports the whole fleet size", () => {
    const wanted = liveIds[0];
    const result = cli(["roster", "--agent", wanted, "--json"]);
    assert.equal(result.status, 0);
    const data = inventory(result);
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].agent_id.value, wanted);
    assert.equal(data.scope.kind, "agent", "the result must be labelled scoped");
    assert.equal(data.scope.agent_id, wanted);
    assert.match(data.scope.label, /scoped/);
    assert.equal(data.totals.source_rows, liveIds.length, "totals still describe the full registered fleet");
    assert.equal(data.totals.emitted_rows, liveIds.length);
    assert.equal(data.totals.selected, 1);
    assert.equal(data.totals.observed, 1);
  });

  checkWithAgents(2, "a scoped run reports fleet health, never slice health", () => {
    // An agent with no conflict of its own must not make the run look clean
    // while the fleet is broken. Health, totals and conflicts stay fleet-wide;
    // only `rows` is sliced, and `scope` says so.
    const registry = mutatedRegistry("scoped-health", REAL_AGENT_REGISTRY, (document) => {
      const [first, second, third] = document.get("agents").items.map((item) => item.key.value);
      document.setIn(["agents", first, "profile_name"], "scoped-shared-profile");
      document.setIn(["agents", second, "profile_name"], "scoped-shared-profile");
      return third;
    });
    const ids = Object.keys(YAML.parse(readFileSync(registry, "utf8")).agents);
    const bystander = ids[2];
    const data = inventory(cli(["roster", "--agent-registry", registry, "--agent", bystander, "--json"]));
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].agent_id.value, bystander);
    assert.deepEqual(data.rows[0].conflicts, [], "the bystander has no conflict of its own");
    assert.equal(data.health.healthy, false, "a slice must not report healthy while the fleet is not");
    assert.ok(data.conflicts.length >= 1, "conflict groups stay fleet-wide");
  });

  check("--agent <unknown> is NOT_FOUND, exit 3, id bounded, no stack", () => {
    const result = cli(["roster", "--agent", "no-such-agent", "--json"]);
    assert.equal(result.status, 3);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "NOT_FOUND");
    assert.equal(parsed.error.details.agent_id, "no-such-agent", "the failure must name the id it was given");
    assert.ok(!/\bat \w+.*:\d+:\d+/.test(result.stdout + result.stderr), "no stack trace may reach the caller");
  });

  // -- AC10: overrides read only what they name ------------------------------

  check("an override is inspected while configured_path still names the canonical file", () => {
    const copy = rawCopy("verbatim-agent-copy", readFileSync(REAL_AGENT_REGISTRY, "utf8"));
    const before = { agents: fileFingerprint(REAL_AGENT_REGISTRY), projects: fileFingerprint(REAL_PROJECT_REGISTRY) };
    const data = inventory(cli(["roster", "--agent-registry", copy, "--json"]));
    const store = data.stores.find((item) => item.id === "agent-registry");
    assert.ok(store, "the agent store must be reported");
    assert.equal(store.overridden, true);
    assert.match(store.configured_path, /agents-registry\.yaml$/);
    assert.ok(!store.configured_path.includes("verbatim-agent-copy"), "an override must not rewrite the configured path");
    assert.ok(store.inspected_path.includes("verbatim-agent-copy"), "the inspected path must name the override");
    assert.deepEqual(
      { agents: fileFingerprint(REAL_AGENT_REGISTRY), projects: fileFingerprint(REAL_PROJECT_REGISTRY) },
      before,
      "the real registries were touched",
    );
  });

  check("a missing registry is NOT_FOUND, exit 3, with a home-redacted path", () => {
    const missing = join(scratchHome, "nope", "agents-registry.yaml");
    const result = cli(["roster", "--agent-registry", missing, "--json"]);
    assert.equal(result.status, 3);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "NOT_FOUND");
    assert.ok(!parsed.error.details.path.startsWith(scratchHome), `the scratch HOME leaked: ${parsed.error.details.path}`);
    assert.match(parsed.error.details.path, /^~\//, "a path under HOME must be redacted to ~");
  });

  check("an unparseable registry is INVALID_INPUT, exit 2, with no parser text echoed", () => {
    const text = readFileSync(REAL_AGENT_REGISTRY, "utf8");
    const truncated = rawCopy("truncated-registry", `${text.slice(0, Math.floor(text.length / 2))}\n  broken: [1, 2`);
    const result = cli(["roster", "--agent-registry", truncated, "--json"]);
    assert.equal(result.status, 2);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.match(parsed.error.message, /could not be parsed \([A-Z_]+\)/, "only the parser's stable code crosses the boundary");
    assert.ok(!parsed.error.message.includes("broken"), "the parser echoed source text");
  });

  for (const [flag, value, reason] of [
    ["--agent", "", "empty"],
    ["--agent-registry", "", "empty"],
    ["--project-registry", "", "empty"],
    ["--agent", "--json", "option-shaped"],
    ["--agent-registry", "--json", "option-shaped"],
    ["--project-registry", "--json", "option-shaped"],
  ]) {
    check(`${flag} refuses an ${reason} value`, () => {
      const result = cli(["roster", flag, value, "--json"]);
      assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "INVALID_INPUT");
      assert.equal(parsed.command, "fleet.inventory");
    });
  }

  // -- envelope plumbing ------------------------------------------------------

  check("a rejected argument list still answers in JSON, naming the inventory command", () => {
    const result = cli(["roster", "--json", "--bogus"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "fleet.inventory", "the envelope must name the command that failed");
    assert.equal(result.status, 2);
  });

  check("a rejected validate argument list still names the validate command", () => {
    const result = cli(["handbook", "validate", "--json", "--bogus"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "fleet.contract.validate", "the second command must not steal the first one's label");
  });

  check("the contract command still emits its own ten data keys", () => {
    // Making the data-key check per-command must not loosen it for validate.
    const parsed = envelope(cli(["handbook", "validate", "--json"]));
    assert.equal(parsed.ok, true);
    for (const key of ["contract_path", "authorities", "projections", "classifications", "service_model", "activation", "retired", "extensions", "truncated", "diagnostics"]) {
      assert.notEqual(parsed.data[key], undefined, `data.${key} disappeared`);
    }
  });

  check("a closed stdout is not an error", () => {
    const piped = spawnSync("bash", ["-c", `set -o pipefail; ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} roster --json | head -1`], {
      cwd: temp, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...isolation },
    });
    assert.equal(piped.status, 0, `pipeline exited ${piped.status}: ${piped.stderr}`);
    assert.equal(piped.stdout.trim(), "{", "head must still see the first line");
    assert.ok(!/EPIPE/.test(piped.stderr), `EPIPE reached stderr: ${piped.stderr}`);
  });

  checkWithAgents(1, "a control character in a registry cannot reach the terminal raw", () => {
    // The fields injected here must be fields the human report RENDERS. The
    // first cut injected into `display_name` and `repo`, neither of which
    // `rowLines` prints (`display_name` is not even a row field), so the
    // assertion passed because the values were never emitted at all -- it would
    // have stayed green with `bounded()` deleted from both. Written as a
    // JS string escape rather than a raw byte, so this file stays plain text.
    const id = liveIds[0];
    const escape = "\u001b[2J";
    const registry = mutatedRegistry("escape-injection", REAL_AGENT_REGISTRY, (document) => {
      document.setIn(["agents", id, "role"], `role${escape}x`);
      document.setIn(["agents", id, "profile_name"], `profile${escape}x`);
      document.setIn(["agents", id, "systemd", "gateway_unit"], `unit${escape}x`);
      document.setIn(["agents", id, "display_name"], `clear${escape}screen`);
      document.setIn(["agents", id, "repo"], `repo${escape}name`);
    });
    const human = cli(["roster", "--agent-registry", registry]);
    assert.equal(human.stdout.includes(escape), false, "an escape sequence reached the report");
    // Proof the injected value was actually rendered, so the assertion above is
    // about stripping and not about absence.
    assert.ok(/role\s?\[?2Jx/.test(human.stdout), `the injected role never reached the report: ${human.stdout.slice(0, 600)}`);
    // And the machine surface, which carries every field the report does not.
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    assert.equal(JSON.stringify(data).includes(escape), false, "an escape sequence reached the envelope");
    const row = data.rows.find((item) => item.agent_id.value === id);
    assert.ok(String(row.role.value).includes("2Jx"), `the injected role never reached the envelope: ${row.role.value}`);
  });

  check("the two Hermes registry env keys disagreeing is a finding, not a silent choice", () => {
    const copy = rawCopy("fleet-key-copy", readFileSync(REAL_AGENT_REGISTRY, "utf8"));
    const data = inventory(cli(["roster", "--json"], { HERMES_FLEET_REGISTRY_FILE: copy }));
    const finding = data.findings.find((item) => item.code === "agent-registry-store-env-disagreement");
    assert.ok(finding, "the contract records both keys because they disagree; the command must say when they do");
    assert.match(finding.detail, /HERMES_FLEET_REGISTRY_FILE/);
  });

  check("totals.findings counts what was found, not what survived a clip", () => {
    // The cap and the count are read from the same place, so a clipped run can
    // never report fewer findings than it made. (The live fleet is nowhere near
    // the 2000 cap, so this asserts the invariant rather than the clip.)
    const data = inventory(cli(["roster", "--json"]));
    assert.ok(data.totals.findings >= data.findings.length, "the count must never understate the list");
    if (data.totals.findings > data.findings.length) {
      assert.ok(
        data.truncated.some((note) => note.startsWith("findings:")),
        "a clip that is not announced is the failure `truncated` exists to prevent",
      );
    }
  });

  // -- the live fleet, unmediated --------------------------------------------

  check("the live configured registries inventory correctly and are left untouched", () => {
    // No existence branch here: `missingStore` has already thrown `SkipSuite` if
    // either registry is absent. The branch that used to sit here called
    // `skip()` and returned, after which `check()` printed `ok` anyway -- one
    // case counted twice, in a suite whose whole job is honest counting.
    const before = { agents: fileFingerprint(REAL_AGENT_REGISTRY), projects: fileFingerprint(REAL_PROJECT_REGISTRY) };
    // Deliberately NOT isolated: this case is the one that runs against real
    // state, which is the story's evidence bar. Zero writes are proven by the
    // fingerprints rather than by the scratch snapshot.
    const result = spawnSync(process.execPath, [CLI, "roster", "--json"], {
      cwd: ROOT, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const after = { agents: fileFingerprint(REAL_AGENT_REGISTRY), projects: fileFingerprint(REAL_PROJECT_REGISTRY) };
    assert.deepEqual(after, before, "a read-only command rewrote a live registry");
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const data = inventory(result);
    const independent = realAgentIds(REAL_AGENT_REGISTRY);
    assert.equal(data.totals.source_rows, independent.length, "source_rows must equal an independent count of the live agents keys");
    assert.equal(data.totals.emitted_rows, independent.length);
    assert.equal(data.rows.length, independent.length);
    assert.deepEqual(data.rows.map((row) => row.agent_id.value).sort(), [...independent].sort());
  });

  // -- wiring -----------------------------------------------------------------

  check("the suite is registered in the test runner", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.ok(runner.includes("tests/fleet-inventory-regressions.mjs"), "a suite absent from SUITES never runs");
  });

  check("mise exposes the gate and builds first", () => {
    const mise = readFileSync(join(ROOT, "mise.toml"), "utf8");
    assert.match(mise, /\[tasks\."org:roster"\]/, "the gate must exist");
    const block = mise.slice(mise.indexOf('[tasks."org:roster"]'));
    const body = block.slice(0, block.indexOf("\n[tasks") === -1 ? block.length : block.indexOf("\n[tasks"));
    assert.match(body, /depends = \["build"\]/, "without a build the gate fails with ERR_MODULE_NOT_FOUND, teaching nothing");
    assert.match(body, /\broster\b/);
  });

  // -- what a review pass found the first cut got wrong ----------------------

  checkWithAgents(2, "a conflict never stamps a field the conflict is not about", () => {
    // `agents.{agent_id}.project_path` (Hermes' field) used to stamp the row's
    // `repo_path` cell, which is `projects.{slug}.repo_path` -- a different
    // field, a different store, a different owner. On an uncorrelated row that
    // also emitted `{value: null, state: "conflicted"}`, which the row's own
    // value/state rule forbids. The group is reported; the wrong cell is not.
    const [first, second] = liveIds;
    const registry = mutatedRegistry("dup-project-path-stamp", REAL_AGENT_REGISTRY, (document) => {
      const shared = document.getIn(["agents", first, "project_path"]);
      document.setIn(["agents", second, "project_path"], shared);
    });
    const emptyProjects = rawCopy("no-projects-for-stamp", "schema_version: 1\nprojects: {}\n");
    const data = inventory(cli(["roster", "--agent-registry", registry, "--project-registry", emptyProjects, "--json"]));

    const group = data.conflicts.find((item) => item.field === "agents.{agent_id}.project_path");
    assert.ok(group, "two agents sharing one project_path must still be one group");
    assert.deepEqual([...group.participants].sort(), [first, second].sort());

    for (const id of [first, second]) {
      const row = data.rows.find((item) => item.agent_id.value === id);
      assert.ok(row, `${id} must still be emitted`);
      assert.ok(row.conflicts.includes(group.id), "the row must carry the group id");
      assert.notEqual(row.repo_path.state, "conflicted", "repo_path is a different field, in a different store");
    }

    // The invariant the mismapping broke, asserted across every row of every
    // conflicted fleet: a cell with no value cannot be "conflicted".
    for (const row of data.rows) {
      for (const [key, cell] of Object.entries(row)) {
        if (!cell || typeof cell !== "object" || !("state" in cell)) continue;
        if (cell.value !== null) continue;
        assert.ok(
          cell.state === "unresolved" || cell.state === "unobserved",
          `${row.agent_id.value}.${key} is ${cell.state} with no value`,
        );
      }
    }
  });

  check("a registry with no agents mapping is an unreadable store, never a healthy zero", () => {
    // The whole fleet vanishing behind a mistyped key used to read "healthy,
    // 0 of 0 rows" at exit 0 -- the silent empty this module's independent count
    // exists to prevent, arriving one level above the count.
    const renamed = rawCopy("collection-renamed", readFileSync(REAL_AGENT_REGISTRY, "utf8").replace(/^agents:/m, "agent:"));
    const result = cli(["roster", "--agent-registry", renamed, "--json"]);
    assert.equal(result.status, 0, "an unreadable collection is data, not a command failure");
    const data = inventory(result);
    assert.equal(data.health.healthy, false, "a store that could not be read is not a healthy fleet");
    assert.ok(data.health.collection_errors >= 1, "the unreadable store must be counted");
    const finding = data.findings.find((item) => item.code === "registry-collection-unreadable");
    assert.ok(finding, "the run must say WHICH store carried no fleet");
    assert.match(finding.detail, /agents/);
    assert.match(cli(["roster", "--agent-registry", renamed]).stdout, /ON NOTICE/, "the human report must not say healthy either");
  });

  checkWithAgents(1, "source_rows counts raw keys, so a duplicate id is two rows and not one", () => {
    // Proves the count is over RAW mapping keys rather than a de-duplicated
    // object: `Object.keys` would collapse these two into one and the count
    // would silently disagree with the fleet on disk.
    const victim = liveIds[0];
    const text = readFileSync(REAL_AGENT_REGISTRY, "utf8");
    const document = YAML.parseDocument(text);
    const block = String(new YAML.Document({ [victim]: document.getIn(["agents", victim]).toJSON() }))
      .split("\n").filter(Boolean).map((line) => `  ${line}`).join("\n");
    const duplicated = rawCopy("duplicate-agent-key", `${text.trimEnd()}\n${block}\n`);
    const data = inventory(cli(["roster", "--agent-registry", duplicated, "--json"]));
    assert.equal(data.totals.source_rows, liveIds.length + 1, "a duplicate key is two raw keys");
    assert.equal(data.totals.emitted_rows, data.totals.source_rows, "every raw key becomes a row");
    assert.equal(data.rows.filter((row) => row.agent_id.value === victim).length, 2, "both occurrences are emitted");
  });

  checkWithAgents(2, "two agents claiming one systemd unit are a conflict group", () => {
    // AC5's unit-name dimension. The stored gateway unit is the name systemd
    // actually sees, and two agents can store the same one; the names derived
    // from the contract's patterns are f(agent_id) and can only collide when the
    // ids do, which `agents.{agent_id}` already reports.
    const [first, second] = liveIds;
    const registry = mutatedRegistry("dup-gateway-unit", REAL_AGENT_REGISTRY, (document) => {
      const shared = document.getIn(["agents", first, "systemd", "gateway_unit"]);
      assert.ok(shared, "the real registry must carry a stored gateway unit to duplicate");
      document.setIn(["agents", second, "systemd", "gateway_unit"], shared);
    });
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const group = data.conflicts.find((item) => item.field === "agents.{agent_id}.systemd.gateway_unit");
    assert.ok(group, "a shared unit name must be reported");
    assert.deepEqual([...group.participants].sort(), [first, second].sort());
    assert.ok(group.owners.length > 0, "the group must name the declared owner");
    for (const id of [first, second]) {
      const row = data.rows.find((item) => item.agent_id.value === id);
      assert.equal(row.gateway_unit.state, "conflicted", "the contested field is the one that is stamped");
      assert.ok(row.conflicts.includes(group.id));
    }
  });

  checkWithAgents(1, "a malformed row is booked once, in malformed_rows, not again as a contract violation", () => {
    const clean = inventory(cli(["roster", "--json"]));
    const broken = rawCopy("one-scalar-row", `${readFileSync(REAL_AGENT_REGISTRY, "utf8").trimEnd()}\n  1234: not-a-mapping\n`);
    const data = inventory(cli(["roster", "--agent-registry", broken, "--json"]));
    assert.equal(data.health.malformed_rows, 1, "the bad row must be counted, once");
    assert.equal(
      data.health.contract_violations,
      clean.health.contract_violations,
      "a row's SHAPE is not a contract breach; malformed_rows is its counter",
    );
  });

  check("--project-registry reports its own configured/inspected split", () => {
    // AC10 names both flags. Only the agent store's split was ever asserted, so
    // swapping the project store's two fields would have told automation a
    // scratch copy was the canonical registry with nothing failing.
    const override = rawCopy("projects-override", "schema_version: 1\nprojects: {}\n");
    const data = inventory(cli(["roster", "--project-registry", override, "--json"]));
    const store = data.stores.find((item) => item.id === "pjangler-project-registry");
    assert.ok(store, "the project store must be reported");
    assert.equal(store.overridden, true);
    assert.ok(store.inspected_path.includes("projects-override"), `the inspected path must name the override: ${store.inspected_path}`);
    assert.ok(!store.configured_path.includes("projects-override"), "an override says which bytes to read, not which file is canonical");
    assert.match(store.configured_path, /projects\.yaml$/);
    const agents = data.stores.find((item) => item.id === "agent-registry");
    assert.equal(agents.overridden, false, "the other store is untouched by this flag");
  });

  for (const [label, args, code, expectedStatus] of [
    ["an unknown agent", ["roster", "--agent", "no-such-agent-anywhere"], "NOT_FOUND", 3],
    ["a missing registry", ["roster", "--agent-registry", join(scratchHome, "nope", "agents-registry.yaml")], "NOT_FOUND", 3],
  ]) {
    check(`${label} answers the HUMAN path with the detail that identifies it`, () => {
      // Every failing case was asserted through --json. The path an operator at
      // a terminal and `mise run fleet:inventory` actually take was unpinned, so
      // a formatter fault there would fall through to the last-resort JSON at
      // exit 6 with the whole suite still green.
      const result = cli(args);
      assert.equal(result.status, expectedStatus, `expected exit ${expectedStatus}, got ${result.status}: ${result.stderr}`);
      assert.notEqual(result.stdout.trim(), "", "the human path still owes an answer");
      assert.doesNotMatch(result.stdout, /^\s*[{[]/, "a human invocation must not emit a JSON envelope");
      assert.ok(result.stdout.includes(code), `the report must name ${code}`);
      assert.doesNotMatch(result.stdout, /\bat [A-Za-z$_][\w$.]*\s*\(/, "no stack frame may reach the operator");
      assert.doesNotMatch(result.stdout, /node:internal/, "no runtime internals may reach the operator");
    });
  }

  check("the human failure names the value that identifies it, home-redacted", () => {
    const result = cli(["roster", "--agent-registry", join(scratchHome, "nope", "agents-registry.yaml")]);
    assert.match(result.stdout, /~\//, "the path tried must be shown, and shown redacted");
    assert.ok(!result.stdout.includes(scratchHome), `the scratch HOME leaked: ${result.stdout}`);
  });

  checkWithAgents(1, "a disagreeing .project.json is evidence, never a value and never a tiebreaker", () => {
    // AC4. The only pin was that no field's `source` string matched /manifest/,
    // which a manifest-derived VALUE would pass too: `source` is always taken
    // from the contract's authority index regardless of where the value came
    // from. So this asserts on the value.
    const repo = join(temp, "manifest-repo");
    mkdirSync(repo, { recursive: true });
    const registryText = YAML.parse(readFileSync(REAL_AGENT_REGISTRY, "utf8"));
    // An agent that actually HAS a board binding, not just the first row.
    //
    // `compare()` skips every field whose registry side is null, so an agent with
    // no `plane` block has nothing for a manifest to contradict and `agrees`
    // comes back true whatever the manifest says. Three of the 25 live agents
    // are like that and one of them (`dumply`) now sorts first, so `liveIds[0]`
    // had quietly turned this case into a no-op.
    const victim = liveIds.find((id) => registryText.agents[id]?.plane?.identifier) ?? liveIds[0];
    const declared = registryText.agents[victim]?.plane?.identifier ?? null;
    writeFileSync(join(repo, ".project.json"), `${JSON.stringify({
      project_name: "contradiction",
      project_slug: "not-the-registry-slug",
      ticket_provider: { type: "plane", workspace: "elsewhere", identifier: "NOTREAL", board_id: "00000000-0000-0000-0000-000000000000" },
    }, null, 2)}\n`, "utf8");
    const registry = mutatedRegistry("manifest-disagrees", REAL_AGENT_REGISTRY, (document) => {
      document.setIn(["agents", victim, "project_path"], repo);
    });
    const data = inventory(cli(["roster", "--agent-registry", registry, "--json"]));
    const row = data.rows.find((item) => item.agent_id.value === victim);
    assert.ok(row, "the row must still be emitted");
    assert.equal(row.manifest.present, true, "the manifest must be seen");
    assert.equal(row.manifest.agrees, false, "a contradicting manifest must be recorded as disagreeing");
    assert.ok(row.manifest.notes.length > 0, "the disagreement must be described");
    assert.ok(
      data.findings.some((item) => item.code === "manifest-disagrees" && item.agent_id === victim),
      "the disagreement must be a finding",
    );
    // The values themselves: the registry's, or nothing. Never the manifest's.
    assert.notEqual(row.board.value?.identifier, "NOTREAL", "a manifest value must never become a field value");
    assert.notEqual(row.board.value?.workspace, "elsewhere");
    assert.notEqual(row.project_id.value, "not-the-registry-slug");
    if (declared) assert.equal(row.board.value?.identifier, declared, "the registry's value stands");
    assert.notEqual(row.board.source, null);
    assert.doesNotMatch(String(row.board.source), /manifest|project\.json/i);
  });

  checkWithAgents(1, "a manifest never FILLS a gap the registries left either", () => {
    // The disagreement case above only exercises rows where the registry has a
    // value to win with. The other half of "never a tiebreaker" is the row where
    // the registry has nothing: a manifest that quietly supplies the missing
    // binding would flip the cell from {value: null, state: "unresolved"} to a
    // manifest-sourced value carrying a registry's name as its `source`, and the
    // disagreement assertions would all still pass.
    const repo = join(temp, "manifest-gapfill-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".project.json"), `${JSON.stringify({
      project_name: "gapfill",
      project_slug: "manifest-only-slug",
      ticket_provider: { type: "plane", workspace: "manifest-only-workspace", identifier: "MANONLY", board_id: "11111111-1111-1111-1111-111111111111" },
    }, null, 2)}\n`, "utf8");
    const victim = liveIds[0];
    const registry = mutatedRegistry("manifest-gapfill", REAL_AGENT_REGISTRY, (document) => {
      document.setIn(["agents", victim, "project_path"], repo);
      document.deleteIn(["agents", victim, "plane"]);
    });
    const emptyProjects = rawCopy("no-projects-for-gapfill", "schema_version: 1\nprojects: {}\n");
    const data = inventory(cli(["roster", "--agent-registry", registry, "--project-registry", emptyProjects, "--json"]));
    const row = data.rows.find((item) => item.agent_id.value === victim);
    assert.ok(row, "the row must still be emitted");
    assert.equal(row.manifest.present, true, "the manifest must be seen");
    assert.equal(row.board.value, null, "a manifest value must never fill a registry gap");
    assert.equal(row.board.state, "unresolved", "an unknown stays explicitly unresolved");
    assert.equal(row.project_id.value, null, "nor may it supply a project id");
    assert.equal(row.project_id.state, "unresolved");
    assert.ok(
      data.findings.some((item) => item.code === "board-binding-missing" && item.agent_id === victim),
      "the gap must be reported as a gap",
    );
    assert.equal(
      JSON.stringify(row).includes("MANONLY") || JSON.stringify(row).includes("manifest-only"),
      false,
      "no manifest value reached the row at all",
    );
  });

  // -- what a SECOND review pass found, each pinned by the mutation that showed it

  checkWithAgents(1, "correlation actually correlates: a positive assertion, not only a negative one", () => {
    // Every correlation assertion in this suite used to be negative -- "0 when
    // the project registry is empty", "the manifest did not become project_id".
    // Blanking both index lookups therefore took the live fleet from 9 of 28
    // correlated to 0 of 28 with the whole suite still green, which means the
    // `expandHome` asymmetry a previous pass fixed could revert unseen.
    const projects = YAML.parse(readFileSync(REAL_PROJECT_REGISTRY, "utf8"))?.projects ?? {};
    const agents = YAML.parse(readFileSync(REAL_AGENT_REGISTRY, "utf8"))?.agents ?? {};
    const byRepoPath = new Map();
    for (const [key, record] of Object.entries(projects)) {
      if (typeof record?.repo_path === "string") byRepoPath.set(resolve(record.repo_path.replace(/^~(?=\/|$)/, REAL_HOME)), { key, record });
    }
    const pair = Object.entries(agents)
      .map(([id, row]) => [id, typeof row?.project_path === "string" ? byRepoPath.get(resolve(row.project_path.replace(/^~(?=\/|$)/, REAL_HOME))) : undefined])
      .find(([, match]) => match !== undefined);
    if (!pair) { skip("correlation actually correlates", "no live agent correlates to a project record on this host"); return; }
    const [agentId, match] = pair;

    const result = cli(["roster", "--json"], {
      HERMES_AGENTS_REGISTRY: REAL_AGENT_REGISTRY,
      PJ_PROJECT_REGISTRY: REAL_PROJECT_REGISTRY,
      HERMES_FLEET_REGISTRY_FILE: REAL_AGENT_REGISTRY,
    });
    const data = inventory(result);
    assert.ok(data.totals.correlated > 0, "a fleet whose registries do correlate must report correlated > 0");
    const row = data.rows.find((item) => item.agent_id.value === agentId);
    assert.ok(row, `${agentId} must be emitted`);
    assert.equal(row.correlation.state, "resolved", "a correlated row must say so");
    assert.equal(row.correlation.value, "project_path", "and name the basis it correlated on");
    assert.equal(row.project_id.state, "resolved");
    assert.equal(row.project_id.value, match.record.slug ?? match.key, "project_id must be the project registry's own slug");
    assert.ok(row.project_id.source, "a resolved cell names the authority that owns it");
    assert.equal(row.repo_path.state, "resolved");
  });

  checkWithAgents(1, "a ~-spelled path correlates from either side, not just when both are absolute", () => {
    // The asymmetry a previous pass fixed: the index is keyed by
    // `resolve(expandHome(repo_path))` while the lookup used bare
    // `resolve(project_path)`, so a `~/...` spelling of the SAME repository
    // could never find its record. Nothing pinned it, so it could revert.
    // Both spellings are exercised, because dropping `expandHome` from either
    // side breaks only that side.
    const projects = YAML.parse(readFileSync(REAL_PROJECT_REGISTRY, "utf8"))?.projects ?? {};
    const record = Object.keys(projects)[0];
    if (!record) { skip("a ~-spelled path correlates from either side", "the live project registry has no records"); return; }
    const agentId = liveIds[0];
    const suffix = "code/tilde-correlation";
    const expectedSlug = projects[record]?.slug ?? record;

    for (const [label, agentSpelling, recordSpelling] of [
      ["agent side spelled with ~", `~/${suffix}`, join(scratchHome, suffix)],
      ["record side spelled with ~", join(scratchHome, suffix), `~/${suffix}`],
    ]) {
      const agentsFile = mutatedRegistry(`tilde-agents-${label.replace(/\W+/gu, "-")}`, REAL_AGENT_REGISTRY, (doc) => {
        doc.setIn(["agents", agentId, "project_path"], agentSpelling);
      });
      const projectsFile = mutatedRegistry(`tilde-projects-${label.replace(/\W+/gu, "-")}`, REAL_PROJECT_REGISTRY, (doc) => {
        doc.setIn(["projects", record, "repo_path"], recordSpelling);
      });
      const data = inventory(cli([
        "roster",
        "--agent-registry", agentsFile,
        "--project-registry", projectsFile,
        "--agent", agentId, "--json",
      ]));
      const row = data.rows[0];
      assert.equal(row.correlation.state, "resolved", `${label}: one repository spelled two ways must find one record`);
      assert.equal(row.correlation.value, "project_path", `${label}: and correlate on the path, not fall through to the slug`);
      // Not `state === "resolved"`: moving this record's repo_path leaves its
      // slug reachable by the `repo` fallback, so a second agent may legitimately
      // claim it and stamp the cell `conflicted`. The VALUE is the correlation
      // evidence; the state belongs to AC5.
      assert.equal(row.project_id.value, expectedSlug, `${label}: project_id must be the project registry's own slug`);
      assert.notEqual(row.project_id.state, "unresolved", `${label}: a correlated row's project_id is not unresolved`);
    }
  });

  checkWithAgents(1, "the stored activation flag and Bloodbank record are actually read", () => {
    // The AC3 shape sweep accepts `{value: null, state: "unresolved"}` for every
    // cell, so forcing the activation flag and both Bloodbank cells to null left
    // the suite green while the command reported a fully activated fleet as
    // default-deny -- which stories 1.3-1.10 would consume as fleet truth.
    const agents = YAML.parse(readFileSync(REAL_AGENT_REGISTRY, "utf8"))?.agents ?? {};
    const withActivation = Object.entries(agents).filter(([, row]) => typeof row?.bloodbank?.enabled === "boolean");
    const withScope = Object.entries(agents).filter(([, row]) => typeof row?.bloodbank?.gateway_scope === "string");
    if (!withActivation.length || !withScope.length) { skip("the stored activation flag is actually read", "no live agent stores a Bloodbank block"); return; }

    const data = inventory(cli(["roster", "--json"], {
      HERMES_AGENTS_REGISTRY: REAL_AGENT_REGISTRY,
      HERMES_FLEET_REGISTRY_FILE: REAL_AGENT_REGISTRY,
      PJ_PROJECT_REGISTRY: REAL_PROJECT_REGISTRY,
    }));
    const resolvedActivation = data.rows.filter((row) => row.activation.state === "resolved");
    assert.equal(resolvedActivation.length, withActivation.length, "every stored boolean activation flag must be read as resolved");
    for (const [id, row] of withActivation) {
      const emitted = data.rows.find((item) => item.agent_id.value === id);
      assert.equal(emitted.activation.value, row.bloodbank.enabled, `${id} activation must be the STORED value`);
    }
    assert.equal(
      data.rows.filter((row) => row.bloodbank_scope.state === "resolved").length,
      withScope.length,
      "every stored gateway_scope must be read",
    );
  });

  checkWithAgents(2, "a repo_path group id is computed from a home-redacted value, not this host's path", () => {
    // The README promises a group id identical on every machine. Reverting the
    // redaction to `resolve(...)` bakes $HOME into the hash and every existing
    // check stays green, because the only id assertions are a shape regex and
    // same-machine stability.
    const projects = YAML.parse(readFileSync(REAL_PROJECT_REGISTRY, "utf8"))?.projects ?? {};
    const keys = Object.keys(projects);
    const donor = keys.find((key) => typeof projects[key]?.repo_path === "string");
    const other = keys.find((key) => key !== donor);
    if (!donor || !other) { skip("a repo_path group id is host-independent", "the live project registry has fewer than two records"); return; }
    const shared = projects[donor].repo_path;

    const collided = mutatedRegistry("shared-repo-path", REAL_PROJECT_REGISTRY, (doc) => {
      doc.setIn(["projects", other, "repo_path"], shared);
    });
    const data = inventory(cli(["roster", "--project-registry", collided, "--json"]));
    const group = data.conflicts.find((item) => item.field === "projects.{slug}.repo_path");
    assert.ok(group, "two records on one repo_path must be a group");

    // Recomputed here from the redacted value, exactly as an operator on another
    // machine would see it -- never from this host's absolute path.
    const redacted = shared.startsWith(`${REAL_HOME}/`) ? `~${shared.slice(REAL_HOME.length)}` : shared;
    const normalized = posix.normalize(redacted).replace(/\/+$/u, "").normalize("NFC").trim();
    const expected = `conflict:projects.{slug}.repo_path:${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12)}`;
    assert.equal(group.id, expected, "a group id must be reproducible without knowing this host's $HOME");
    assert.ok(!group.id.includes(REAL_HOME), "and must not carry it");
  });

  checkWithAgents(1, "a relative project_path is never resolved against the caller's directory", () => {
    // Measured before the fix: a row declaring `project_path: relrepo`, run from
    // a directory holding an unrelated `relrepo/.project.json`, reported
    // `manifest.present: true`, `agrees: false` and two disagreement notes --
    // another repository's binding, attributed to this agent as its evidence.
    const trap = join(temp, "cwd-trap");
    mkdirSync(join(trap, "relrepo"), { recursive: true });
    writeFileSync(
      join(trap, "relrepo", ".project.json"),
      `${JSON.stringify({ project_slug: "IMPOSTOR", ticket_provider: { type: "plane", workspace: "nope", identifier: "IMPOST" } })}\n`,
      "utf8",
    );
    const victim = liveIds[0];
    const relative_ = mutatedRegistry("relative-project-path", REAL_AGENT_REGISTRY, (doc) => {
      doc.setIn(["agents", victim, "project_path"], "relrepo");
    });
    const result = cli(["roster", "--agent-registry", relative_, "--agent", victim, "--json"], {}, trap);
    const row = inventory(result).rows[0];
    assert.equal(row.paths.project_path.classification, "relative");
    assert.equal(row.manifest.present, false, "a manifest under a cwd-relative path must never be read");
    assert.equal(row.manifest.agrees, null, "and must never produce agreement evidence");
    assert.deepEqual(row.manifest.notes, []);
    assert.ok(row.findings.includes("manifest-not-consulted"), "the refusal must be stated, not silent");
    assert.ok(!row.findings.includes("manifest-disagrees"), "the impostor manifest must not reach the row");
    assert.ok(!JSON.stringify(row).includes("IMPOSTOR"), "no byte of the caller's directory may reach the envelope");
  });

  checkWithAgents(1, "a malformed row with an unsafe id is booked once, not twice", () => {
    // The previous pass's own entry named `agent-id-unsafe` as one of the codes
    // leaking into `contract_violations`, and the set that replaced the prefix
    // match did not contain it. Measured: clean 0 violations, `1234:` 0,
    // `"../escape":` 1 -- while `malformed_rows` already said 1.
    const baseline = inventory(cli(["roster", "--json"])).health;
    for (const key of ["1234", "../escape"]) {
      const broken = rawCopy(
        `malformed-${key === "1234" ? "safe" : "unsafe"}-key`,
        `${readFileSync(REAL_AGENT_REGISTRY, "utf8").replace(/\s*$/, "")}\n  ${JSON.stringify(key)}:\n    - not-a-mapping\n`,
      );
      const health = inventory(cli(["roster", "--agent-registry", broken, "--json"])).health;
      assert.equal(health.malformed_rows, 1, `${key}: the row must be counted as malformed`);
      assert.equal(
        health.contract_violations, baseline.contract_violations,
        `${key}: one bad row must not also be booked as a contract violation`,
      );
      assert.equal(health.collection_errors, baseline.collection_errors,
        `${key}: a salvaged row is not an unreadable store`);
    }
  });

  checkWithAgents(1, "a well-formed row with an unsafe id is still a contract violation", () => {
    // The other half of the same fix: nothing else counts an unsafe id on a row
    // that IS a mapping under a string key, so dropping it outright would let it
    // ride at healthy.
    const baseline = inventory(cli(["roster", "--json"])).health;
    const broken = rawCopy(
      "wellformed-unsafe-key",
      `${readFileSync(REAL_AGENT_REGISTRY, "utf8").replace(/\s*$/, "")}\n  "../escape":\n    repo: escapee\n    role: pm\n`,
    );
    const health = inventory(cli(["roster", "--agent-registry", broken, "--json"])).health;
    assert.equal(health.malformed_rows, 0, "a mapping under a string key is not malformed");
    assert.equal(health.contract_violations, baseline.contract_violations + 1, "but an unsafe id must still be counted somewhere");
    assert.equal(health.healthy, false);
  });

  checkWithAgents(1, "the gateway unit drifts against the gateway pattern, not against any of the three", () => {
    // `expected_units` carries the gateway service, the heartbeat service AND
    // the heartbeat timer. Comparing the stored gateway unit against the whole
    // set meant storing the heartbeat timer name in `systemd.gateway_unit`
    // reported no drift at all: the wrong unit, in the right set.
    const contract = YAML.parse(readFileSync(TRACKED_CONTRACT, "utf8"));
    const timerPattern = contract?.service_model?.per_agent?.heartbeat_timer;
    if (typeof timerPattern !== "string") { skip("the gateway unit drifts against the gateway pattern", "the contract declares no heartbeat_timer pattern"); return; }
    const victim = liveIds[0];
    const swapped = mutatedRegistry("gateway-is-the-timer", REAL_AGENT_REGISTRY, (doc) => {
      doc.setIn(["agents", victim, "systemd", "gateway_unit"], timerPattern.replaceAll("{agent_id}", victim));
    });
    const data = inventory(cli(["roster", "--agent-registry", swapped, "--agent", victim, "--json"]));
    const row = data.rows[0];
    assert.ok(
      row.expected_units.value.includes(row.gateway_unit.value),
      "the stored name is deliberately one the contract derives -- just the wrong role",
    );
    assert.ok(row.findings.includes("systemd-unit-name-drift"), "a heartbeat timer in the gateway field is drift");
  });

  check("a registry announcing an unmodelled schema_version is refused, not read as v1", () => {
    // `schema_version` was parsed into the store and then consulted by nothing,
    // so a v2 registry would have been keyed and reported as if it were v1.
    const future = mutatedRegistry("future-schema", REAL_AGENT_REGISTRY, (doc) => { doc.set("schema_version", 2); });
    const data = inventory(cli(["roster", "--agent-registry", future, "--json"]));
    const finding = data.findings.find((item) => item.code === "registry-schema-version-unsupported");
    assert.ok(finding, "an unmodelled schema version must be stated");
    assert.match(finding.detail, /schema_version 2/);
    assert.equal(data.health.healthy, false, "and must not be reported as a healthy fleet");
  });

  check("the mise gate names a module that exists, not a substring that matches", () => {
    // Three regexes over mise.toml stayed green when the run line pointed at
    // dist/cli.js -- a path that does not exist -- because the header, the
    // depends and the word "roster" were all still there.
    const mise = readFileSync(join(ROOT, "mise.toml"), "utf8");
    const block = mise.slice(mise.indexOf('[tasks."org:roster"]'));
    const body = block.slice(0, block.indexOf("\n[tasks") === -1 ? block.length : block.indexOf("\n[tasks"));
    const run = /run\s*=\s*"([^"]+)"/.exec(body);
    assert.ok(run, "the gate must declare a run line");
    const script = /\{\{\s*config_root\s*\}\}\/(\S+)/.exec(run[1]);
    assert.ok(script, "the run line must resolve its module from config_root, not from the caller's cwd");
    assert.ok(existsSync(join(ROOT, script[1])), `the gate runs ${script[1]}, which does not exist`);
  });

} catch (error) {
  if (!(error instanceof SkipSuite)) throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} fleet inventory check(s) failed`);
  process.exit(1);
}
console.log(`fleet inventory regressions passed${skipped ? ` (${skipped} skipped)` : ""}`);
