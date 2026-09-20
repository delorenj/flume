// PJAN Epic 1 / Story 1.1: the fleet authority and managed-state contract.
//
// The defect class this suite exists for is not "validate has a bug". It is
// that every later fleet observation would otherwise invent its own answer to
// "who owns this field", and that a machine-readable fleet answer that looks
// right on a terminal can still be truncated the moment CI captures it.
//
// So the bar here is deliberately awkward:
//
//   * Every case runs the REAL built `dist/index.js` in a real subprocess over
//     real OS pipes. `pjangler audit --json` already proved that a command can
//     print a complete document to a TTY and a truncated one to a pipe, because
//     the process exited before stdout drained. A suite that called the
//     validator in-process would have re-certified that defect.
//   * Every invalid case is produced by MUTATING A COPY OF THE REAL TRACKED
//     CONTRACT at runtime, never by hand-authoring a parallel fixture. A
//     hand-written "invalid contract" drifts away from the real one the first
//     time the real one changes, and then it tests a file nobody ships.
//   * stdout is asserted non-empty and parseable BEFORE anything is asserted
//     about its content, so an empty capture fails loudly instead of passing
//     every `assert.match` vacuously.
//   * Every invocation, including the failing ones, is bracketed by a
//     content+mtime snapshot of FOUR roots -- the scratch HOME, the working
//     directory, TMPDIR, and the tracked contract -- recording directories and
//     symlinks as themselves. "Read-only" is a claim about the filesystem, and
//     a snapshot that covered only `$HOME`, only files, and followed symlinks
//     was three separate ways to miss a write.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
// The workspace that owns the CLI. `dist/` lives under the package; the
// handbook and the job-description template stay at the repo root, so the two
// roots are not interchangeable.
const PKG = join(ROOT, "packages", "flume-hr");
const CLI = join(PKG, "dist", "index.js");
/** Every TypeScript source tree in the monorepo, for the repo-wide scans below. */
const SRC_ROOTS = [join(PKG, "src"), join(ROOT, "packages", "flume-core", "src")];
const TRACKED_CONTRACT = join(ROOT, "contracts", "handbook.yaml");
const TRACKED_TEXT = readFileSync(TRACKED_CONTRACT, "utf8");

const temp = mkdtempSync(join(tmpdir(), "fleet-contract-"));
const scratchHome = join(temp, "home");
let failures = 0;

/**
 * How the CLI is required to render a path it read.
 *
 * TMPDIR is not portable: on this developer box it sits under the real home,
 * on a clean runner it is `/tmp`. The command redacts a home prefix to `~`
 * regardless of an overridden `$HOME`, so the expected string has to be
 * computed the same way instead of assumed to be the raw path.
 */
const PASSWD_HOME = (() => { try { return userInfo().homedir; } catch { return ""; } })();
const shown = (path) => (PASSWD_HOME && path.startsWith(`${PASSWD_HOME}/`) ? `~${path.slice(PASSWD_HOME.length)}` : path);

let skipped = 0;

/** A case the host cannot express (running as root, say). Loud, never silent. */
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
 * A scratch HOME the command has no business touching.
 *
 * Every store the fleet contract NAMES is pointed inside it, so a validator
 * that quietly resolved a registry -- or wrote a cache, a lock, or a repaired
 * copy -- would leave a trace the snapshot catches. Git discovery is ceilinged
 * and host git config dropped for the same reason it is in the hermes deploy
 * suite: without that, whatever checkout happens to contain TMPDIR answers for
 * the fixture.
 */
function seedHome() {
  mkdirSync(join(scratchHome, ".hermes", "profiles", "example"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(scratchHome, ".hermes", "agents-registry.yaml"), "schema_version: 1\nagents: {}\n");
  writeFileSync(join(scratchHome, ".config", "pjangler", "projects.yaml"), "schema_version: 1\nprojects: {}\n");
  writeFileSync(join(scratchHome, ".hermes", "profiles", "example", "config.yaml"), "memory: {}\n");
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
  // Both keys authorities.tracked_role_scaffold declares. Omitted, a loader that
  // starts honouring either would resolve the developer's REAL scaffold and the
  // zero-write snapshot below would never see the writes.
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
 * cache dir was previously invisible. Symlinks are recorded by their target
 * rather than followed: hashing through a link both misses a repointed link and
 * can hash the same bytes twice.
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
      // A fixture this suite deliberately made unreadable must not crash the
      // snapshot. Mode and mtime still change if anything touches it.
      let digest;
      try { digest = createHash("sha256").update(readFileSync(path)).digest("hex"); }
      catch { digest = `unreadable:${stat.mode}:${stat.size}`; }
      entries[key] = `${digest}:${stat.mtimeMs}`;
    }
  };
  walk(root);
  return entries;
}

/**
 * Everything the command could plausibly write to.
 *
 * `temp` is both the working directory and TMPDIR for every invocation, so one
 * tree covers two of the four. The package root is sampled shallowly plus the
 * `contracts/` tree in full -- hashing node_modules on every one of thirty-odd
 * invocations would cost minutes to catch nothing, while a stray file dropped
 * beside the checkout or a rewritten contract both show up here.
 */
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
 * Run the built CLI and prove the run wrote nothing to the scratch HOME.
 *
 * `maxBuffer` is set explicitly: the default would itself truncate a large
 * capture, and a truncation introduced by the harness looks exactly like the
 * truncation defect the harness is here to detect.
 */
function cli(args) {
  const before = snapshot();
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: temp,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...isolation },
  });
  const after = snapshot();
  assert.deepEqual(after, before, `pj ${args.join(" ")} wrote to a protected root`);
  return result;
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

/**
 * The error code of an envelope that must be a failure.
 *
 * Reading `parsed.error.code` straight off a success envelope fails with
 * "Cannot read properties of null", which tells the next reader nothing about
 * what actually went wrong.
 */
function errorCode(parsed) {
  assert.equal(parsed.ok, false, `expected a failure envelope, got ok:true with data ${JSON.stringify(parsed.data).slice(0, 200)}`);
  assert.notEqual(parsed.error, null, "a failure envelope must carry an error");
  return parsed.error.code;
}

/** Derive an invalid contract by mutating a copy of the real tracked one. */
function mutated(name, mutate) {
  const document = YAML.parseDocument(TRACKED_TEXT);
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

console.log("fleet contract authority + managed-state contract");
try {
  seedHome();

  // -- the tracked contract, through the real built CLI ---------------------

  check("canonical validate exits 0 and names every declared surface", () => {
    const result = cli(["handbook", "validate"]);
    assert.notEqual(result.stdout, "", "human report must not be empty");
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const out = result.stdout;
    assert.match(out, /Handbook valid/);
    // Story 1.5 bumped the tracked contract to schema 2 (`health_policy`),
    // story 1.6 to schema 3 (`scaffold_manifest`), story 1.7 to schema 4
    // (`profile_manifest`) and story 1.8 to schema 5 (`service_manifest`): each
    // is a new ROOT key, and a new root key is a grammar change. The build
    // still READS schema 1 through 4, which the supported-range line beside
    // this one states.
    assert.match(out, /schema 5/, "report must name the effective schema version");
    assert.match(out, /contract 1\.\d+\.\d+/, "report must name the contract version");
    for (const owner of ["project-registry", "hermes-agent-registry", "hermes-profile-renderer", "hermes-agent-template", "hermes-fleet-provisioner", "fleet-observer"]) {
      assert.ok(out.includes(owner), `report must name authority owner ${owner}`);
    }
    for (const klass of ["managed_agent", "managed_shared_service", "intentionally_unmanaged", "retired", "unclassified"]) {
      assert.ok(out.includes(klass), `report must name lifecycle class ${klass}`);
    }
    assert.ok(out.includes("hermes-{agent_id}-gateway.service"), "report must name the per-agent gateway unit");
    assert.ok(out.includes("hermes-{agent_id}-heartbeat.timer"), "report must name the per-agent heartbeat timer");
    assert.ok(out.includes("hermes-fleet-bloodbank-gateway.service"), "report must name the fleet-shared gateway");
    for (const mode of ["per-agent-bloodbank-consumer", "per-agent-checkpoint-timer", "n8n-owned-truth", "activation-by-discovery", "hard-coded-hermes-checkout-path"]) {
      assert.ok(out.includes(mode), `report must name superseded mode ${mode}`);
    }
  });

  check("human report never prints an absolute path under $HOME", () => {
    const result = cli(["handbook", "validate"]);
    for (const home of new Set([homedir(), PASSWD_HOME].filter(Boolean))) {
      assert.ok(!result.stdout.includes(home), `report leaked the home directory ${home}`);
    }
    assert.ok(result.stdout.includes("contracts/handbook.yaml"), "report must still name the contract it validated");
  });

  check("--json is one complete envelope through a real pipe", () => {
    const result = cli(["handbook", "validate", "--json"]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.error, null);
    assert.notEqual(parsed.data, null, "data must be populated on success");
    // Exact, not `>=`. The contract declares a fixed set; a loose bound would
    // stay green if a whole authority block were dropped.
    // Nine since story 1.7: `provisioned_profile_state` owns the three
    // provisioned profile leaves beside the renderer's four.
    assert.equal(parsed.data.authorities.length, 9, "envelope must carry exactly the declared authorities");
    assert.equal(parsed.data.projections.length, 6, "envelope must carry exactly the declared projections");
    assert.equal(parsed.data.classifications.length, 5, "envelope must carry five lifecycle classes");
    assert.equal(parsed.data.retired.length, 5, "envelope must carry exactly the declared retired modes");
    assert.equal(parsed.data.byte_stable, true, "tracked contract must round-trip byte-stably");
    assert.deepEqual(parsed.data.truncated, [], "the tracked contract must fit the envelope bounds without clipping");
  });

  check("a payload past the documented 8 KiB truncation threshold survives capture", () => {
    // 8 KiB is where `pjangler audit --json` was observed to truncate under
    // subprocess capture -- not the 64 KiB Linux pipe buffer. The size comes
    // from a fixture, not from the tracked contract, so trimming the contract
    // can never fail this test for an unrelated reason.
    const document = YAML.parseDocument(TRACKED_TEXT);
    document.setIn(["x-delonet/bulk"], Array.from({ length: 90 }, (_, index) => `${index}`.padStart(4, "0").repeat(50)));
    const path = rawCopy("bulk-extension", String(document));
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, `bulk extension must stay valid: ${JSON.stringify(parsed.error)}`);
    assert.ok(result.stdout.length > 8192, `payload is only ${result.stdout.length} bytes; below the observed truncation threshold`);
    assert.deepEqual(parsed.data.truncated, [], "this fixture is sized to fit the bounds exactly");
  });

  check("clipping an oversized value is reported, never silent", () => {
    const document = YAML.parseDocument(TRACKED_TEXT);
    document.setIn(["x-delonet/overflow"], Array.from({ length: 130 }, (_, index) => `item-${index}`));
    const path = rawCopy("overflow-extension", String(document));
    const parsed = envelope(cli(["handbook", "validate", "--contract", path, "--json"]));
    assert.equal(parsed.ok, true);
    const notes = parsed.data.truncated.join(" | ");
    assert.match(notes, /x-delonet\/overflow/, `truncation must name where it happened: ${notes}`);
    assert.match(notes, /30 of 130 items dropped/, `truncation must say how much was lost: ${notes}`);
  });

  check("the tracked contract re-serializes byte-identically", () => {
    assert.equal(String(YAML.parseDocument(TRACKED_TEXT)), TRACKED_TEXT, "tracked contract is not its own canonical serialization");
  });

  check("--contract validates the named file and reports the resolved path", () => {
    const copy = rawCopy("verbatim-copy", TRACKED_TEXT);
    const result = cli(["handbook", "validate", "--contract", copy]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stdout.includes(shown(copy)), "report must name the overridden contract path");
  });

  // -- authority split, declared not inferred --------------------------------

  check("Project Registry owns identity; Hermes Agent Registry owns operations", () => {
    const parsed = envelope(cli(["handbook", "validate", "--json"]));
    const byOwner = new Map();
    for (const authority of parsed.data.authorities) {
      for (const field of authority.writable_fields) byOwner.set(field, authority.owner);
    }
    assert.equal(byOwner.get("projects.{slug}.repo_path"), "project-registry");
    assert.equal(byOwner.get("projects.{slug}.ticket_provider.identifier"), "project-registry");
    assert.equal(byOwner.get("projects.{slug}.ticket_provider.board_id"), "project-registry");
    assert.equal(byOwner.get("agents.{agent_id}.role_dir"), "hermes-agent-registry");
    assert.equal(byOwner.get("agents.{agent_id}.profile_name"), "hermes-agent-registry");
    assert.equal(byOwner.get("gateways.bloodbank.systemd_unit"), "hermes-agent-registry");
  });

  check("every overlap projection declares one direction and one writer", () => {
    const parsed = envelope(cli(["handbook", "validate", "--json"]));
    const overlaps = [
      ["projects.{slug}.repo_path", "agents.{agent_id}.project_path"],
      ["projects.{slug}.slug", "agents.{agent_id}.repo"],
      ["projects.{slug}.ticket_provider.identifier", "agents.{agent_id}.plane.identifier"],
      ["projects.{slug}.ticket_provider.board_id", "agents.{agent_id}.plane.project_id"],
      ["projects.{slug}.ticket_provider.workspace", "agents.{agent_id}.plane.workspace"],
      ["agents.{agent_id}.role_dir", "projects.{slug}.agents.{role}.role_dir"],
    ];
    for (const [source, target] of overlaps) {
      const matches = parsed.data.projections.filter((item) => item.source === source && item.target === target);
      assert.equal(matches.length, 1, `${source} -> ${target} must be declared exactly once`);
      assert.match(matches[0].direction, /_to_/, "direction must name a source and a target");
      assert.equal(typeof matches[0].writable_by, "string");
      assert.ok(matches[0].writable_by.length > 0, "writable_by must name one owner");
    }
    // The one write that actually happens today: Plane -> project registry ->
    // hermes registry. Recording the wrong writer here would authorize the
    // hermes side to start writing board identity back.
    const identifier = parsed.data.projections.find((item) => item.target === "agents.{agent_id}.plane.identifier");
    assert.equal(identifier.writable_by, "project-registry");
    assert.equal(identifier.direction, "pjangler_project_registry_to_hermes_agent_registry");
    const roleDir = parsed.data.projections.find((item) => item.source === "agents.{agent_id}.role_dir");
    assert.equal(roleDir.direction, "hermes_agent_registry_to_pjangler_project_registry", "truth flows the other way for role_dir");
  });

  check("every projection endpoint is a field some authority really declares", () => {
    const parsed = envelope(cli(["handbook", "validate", "--json"]));
    const declared = new Map();
    for (const authority of parsed.data.authorities) {
      for (const field of authority.writable_fields) declared.set(field, authority.owner);
    }
    for (const projection of parsed.data.projections) {
      assert.ok(declared.has(projection.source), `${projection.source} is not declared by any authority`);
      assert.ok(declared.has(projection.target), `${projection.target} is not declared by any authority`);
      assert.equal(declared.get(projection.target), projection.writable_by, `${projection.target} must be writable by its declared writer`);
    }
  });

  check("a projection endpoint that no authority declares is rejected", () => {
    const path = mutated("dangling-target", (document) => {
      document.setIn(["projections", 0, "target"], "agent.{agent_id}.project_path");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(parsed.error.message, /is not declared writable by any authority/);
  });

  check("direction is derived from the two stores, so it cannot be prose", () => {
    for (const [name, value] of [
      ["backwards", "hermes_agent_registry_to_pjangler_project_registry"],
      ["three-hop", "hermes_agent_registry_to_project_registry_to_n0thing"],
    ]) {
      const path = mutated(`direction-${name}`, (document) => {
        document.setIn(["projections", 0, "direction"], value);
      });
      const result = cli(["handbook", "validate", "--contract", path, "--json"]);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "INVALID_INPUT", `a ${name} direction must be rejected`);
      assert.equal(result.status, 2);
      assert.match(parsed.error.message, /direction/);
    }
  });

  check("a duplicate projection is rejected", () => {
    const path = mutated("duplicate-projection", (document) => {
      document.getIn(["projections"]).add({
        field: "duplicate_repo_path",
        source: "projects.{slug}.repo_path",
        target: "agents.{agent_id}.project_path",
        direction: "pjangler_project_registry_to_hermes_agent_registry",
        writable_by: "hermes-agent-registry",
      });
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    assert.equal(errorCode(envelope(result)), "INVALID_INPUT");
    assert.equal(result.status, 2);
  });

  check("a duplicate field path within one authority is rejected", () => {
    const path = mutated("duplicate-field", (document) => {
      document.getIn(["authorities", "project_identity", "writable_fields"]).add("projects.{slug}.slug");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(parsed.error.message, /duplicate field path/);
  });

  check("a field claimed by two owners fails and names both, choosing neither", () => {
    const path = mutated("dual-owner", (document) => {
      const fields = document.getIn(["authorities", "agent_operational_records", "writable_fields"]);
      fields.add("projects.{slug}.ticket_provider.identifier");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, false);
    assert.equal(errorCode(parsed), "AUTHORITY_CONFLICT");
    assert.equal(result.status, 4, `expected exit 4, got ${result.status}`);
    const rendered = JSON.stringify(parsed.error);
    assert.ok(rendered.includes("projects.{slug}.ticket_provider.identifier"), "must name the conflicting field path");
    assert.ok(rendered.includes("hermes-agent-registry"), "must name the first claimant");
    assert.ok(rendered.includes("project-registry"), "must name the second claimant");
    assert.ok(rendered.includes("project_identity"), "must name the first claiming authority block");
    assert.ok(rendered.includes("agent_operational_records"), "must name the second claiming authority block");
    const human = cli(["handbook", "validate", "--contract", path]);
    assert.equal(human.status, 4);
    assert.match(human.stdout, /AUTHORITY_CONFLICT/);
  });

  check("two authority blocks sharing an owner still conflict over one field", () => {
    // Keying claims on the OWNER name hid this: `bloodbank_activation` and
    // `agent_operational_records` are both owned by `hermes-agent-registry`, so
    // both could claim the activation flag and "agree" -- collapsing the
    // discovery/execution split those two blocks exist to keep apart.
    const path = mutated("same-owner-dual-claim", (document) => {
      document.getIn(["authorities", "agent_operational_records", "writable_fields"]).add("agents.{agent_id}.bloodbank.enabled");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "AUTHORITY_CONFLICT");
    assert.equal(result.status, 4);
    const rendered = JSON.stringify(parsed.error);
    assert.ok(rendered.includes("bloodbank_activation"), "must name the activation block");
    assert.ok(rendered.includes("agent_operational_records"), "must name the block that reached for the flag");
  });

  check("the execution gate must be the sole field of its own authority block", () => {
    // Pointing the gate at a pure discovery field owned by the same authority
    // used to validate clean, which made the gate decorative.
    const path = mutated("gate-points-at-discovery", (document) => {
      document.setIn(["activation", "execution_authority", "field"], "agents.{agent_id}.bloodbank.gateway_scope");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(parsed.error.message, /and nothing else/);
  });

  // -- classification completeness ------------------------------------------

  check("every non-managed_agent class demands identity, provenance, and policy", () => {
    const parsed = envelope(cli(["handbook", "validate", "--json"]));
    const required = ["id", "kind", "owner", "source", "lifecycle_state", "rationale", "policy_domains"];
    for (const classification of parsed.data.classifications) {
      if (classification.id === "managed_agent") continue;
      for (const field of required) {
        assert.ok(classification.required_fields.includes(field), `${classification.id} must require ${field}`);
      }
    }
  });

  check("a managed_shared_service entry missing a required key is rejected", () => {
    for (const key of ["owner", "source", "rationale"]) {
      const path = mutated(`classification-missing-${key}`, (document) => {
        document.deleteIn(["classifications", "managed_shared_service", "entries", 0, key]);
      });
      const result = cli(["handbook", "validate", "--contract", path, "--json"]);
      const parsed = envelope(result);
      assert.equal(parsed.ok, false, `missing ${key} must fail`);
      assert.equal(errorCode(parsed), "INVALID_CLASSIFICATION");
      assert.equal(result.status, 4, `expected exit 4 for missing ${key}, got ${result.status}`);
      const rendered = JSON.stringify(parsed.error);
      assert.ok(rendered.includes(key), `diagnostic must name the missing key ${key}`);
      assert.ok(rendered.includes("fleet-bloodbank-gateway"), "diagnostic must name the entry");
      assert.ok(rendered.includes("classifications.managed_shared_service.entries[0]"), "diagnostic must carry the dotted field path");
    }
  });

  // -- retired modes are never an alternate healthy mode ---------------------

  check("declaring a per-agent Bloodbank consumer healthy fails as RETIRED_MODE", () => {
    const path = mutated("retired-consumer", (document) => {
      document.setIn(["service_model", "per_agent", "consumer_unit"], "hermes-{agent_id}-consumer.service");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "RETIRED_MODE");
    assert.equal(result.status, 4);
    assert.ok(JSON.stringify(parsed.error).includes("per-agent-bloodbank-consumer"));
  });

  check("the retired scan reaches authorities and projections, not just the service model", () => {
    const cases = [
      ["authority-writable-field", (document) => document.getIn(["authorities", "systemd_lifecycle", "writable_fields"]).add("units.hermes-{agent_id}-consumer.service"), "per-agent-bloodbank-consumer"],
      ["projection-field-name", (document) => document.setIn(["projections", 0, "field"], "hermes-{agent_id}-checkpoint.timer"), "per-agent-checkpoint-timer"],
      ["authority-note", (document) => document.getIn(["authorities", "agent_operational_records", "notes"]).add("Fleet truth is projected from the n8n supervisor workflow."), "n8n-owned-truth"],
    ];
    for (const [name, mutate, mode] of cases) {
      const path = mutated(`retired-scope-${name}`, mutate);
      const result = cli(["handbook", "validate", "--contract", path, "--json"]);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "RETIRED_MODE", `${name} must be caught: ${JSON.stringify(parsed.error)}`);
      assert.equal(result.status, 4);
      assert.ok(JSON.stringify(parsed.error).includes(mode), `${name} must name ${mode}`);
    }
  });

  check("the retired and unmanaged classes may still RECORD a retired sighting", () => {
    // The scan must not make the two classes that exist to hold this evidence
    // unusable for holding it.
    const path = mutated("retired-class-sighting", (document) => {
      document.getIn(["classifications", "retired", "entries"]).add({
        id: "stale-consumer-sighting",
        kind: "systemd-unit",
        owner: "hermes-fleet-provisioner",
        source: "units.hermes-example-pm-consumer.service",
        lifecycle_state: "retired",
        rationale: "Left by a pre-2026-07 template; a drain is planned.",
        policy_domains: ["systemd"],
      });
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, `recording a retired sighting must stay valid: ${JSON.stringify(parsed.error)}`);
    assert.equal(result.status, 0);
  });

  check("declaring a per-agent checkpoint timer healthy fails as RETIRED_MODE", () => {
    const path = mutated("retired-checkpoint", (document) => {
      document.setIn(["service_model", "per_agent", "checkpoint_timer"], "hermes-{agent_id}-checkpoint.timer");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    assert.equal(errorCode(envelope(result)), "RETIRED_MODE");
    assert.equal(result.status, 4);
  });

  check("declaring n8n-owned truth healthy fails as RETIRED_MODE", () => {
    const path = mutated("retired-n8n", (document) => {
      document.setIn(["service_model", "fleet_shared", "orchestrator"], "n8n");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    assert.equal(errorCode(envelope(result)), "RETIRED_MODE");
    assert.equal(result.status, 4);
  });

  check("a hard-coded Hermes checkout path fails as RETIRED_MODE", () => {
    const path = mutated("retired-checkout", (document) => {
      document.setIn(["service_model", "profile_layout", "root"], "$HOME/code/hermes-agent/profiles/{profile_name}");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    assert.equal(errorCode(envelope(result)), "RETIRED_MODE");
    assert.equal(result.status, 4);
  });

  check("activation-by-discovery fails: default-allow and non-strict both", () => {
    for (const [key, value] of [["default", "allow"], ["strict", false]]) {
      const path = mutated(`retired-activation-${key}`, (document) => {
        document.setIn(["activation", "execution_authority", key], value);
      });
      const result = cli(["handbook", "validate", "--contract", path, "--json"]);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "RETIRED_MODE", `execution_authority.${key} = ${value} must be rejected`);
      assert.equal(result.status, 4);
      assert.ok(JSON.stringify(parsed.error).includes("activation-by-discovery"));
    }
  });

  // -- activation is its own authority ---------------------------------------

  check("five distinct states, one strict default-deny execution field", () => {
    const parsed = envelope(cli(["handbook", "validate", "--json"]));
    assert.deepEqual(parsed.data.activation.states, ["discovered", "installed", "healthy", "routing_ready", "activated"]);
    const authority = parsed.data.activation.execution_authority;
    assert.equal(authority.field, "agents.{agent_id}.bloodbank.enabled");
    assert.equal(authority.owner, "hermes-agent-registry");
    assert.equal(authority.strict, true);
    assert.equal(authority.default, "deny");
    // The gate is only real if its owner is the declared writer of the field.
    const owning = parsed.data.authorities.filter((item) => item.writable_fields.includes(authority.field));
    assert.equal(owning.length, 1, "exactly one authority may write the activation flag");
    assert.equal(owning[0].owner, "hermes-agent-registry");
  });

  check("routing metadata is discovery, held apart from execution authority", () => {
    const parsed = envelope(cli(["handbook", "validate", "--json"]));
    const discovery = parsed.data.authorities.find((item) => item.writable_fields.includes("agents.{agent_id}.bloodbank.gateway_scope"));
    const execution = parsed.data.authorities.find((item) => item.writable_fields.includes("agents.{agent_id}.bloodbank.enabled"));
    assert.ok(discovery && execution, "both surfaces must be declared");
    assert.notEqual(discovery.id, execution.id, "discovery and execution must be separate authorities");
    assert.ok(!discovery.writable_fields.includes("agents.{agent_id}.bloodbank.enabled"), "the discovery authority must not be able to grant dispatch");
  });

  // -- malformed, missing, and forward-incompatible inputs -------------------

  check("a truncated contract fails as INVALID_INPUT with a line and column", () => {
    const cut = TRACKED_TEXT.indexOf("\nprojections:");
    assert.ok(cut > 0, "fixture assumption: the tracked contract declares projections");
    const path = rawCopy("truncated", `${TRACKED_TEXT.slice(0, cut)}\nprojections: [\n`);
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
    assert.match(parsed.error.message, /line \d+ column \d+/, "diagnostic must carry a line and column");
    assert.ok(!/\n\s+at /.test(JSON.stringify(parsed)), "no stack frames may reach the envelope");
  });

  check("a missing required block fails as INVALID_INPUT naming the block", () => {
    const path = mutated("no-authorities", (document) => { document.delete("authorities"); });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.ok(parsed.error.message.startsWith("authorities:"), `diagnostic must be pathed at authorities: ${parsed.error.message}`);
  });

  check("a missing contract file fails as NOT_FOUND naming the path, no stack", () => {
    const missing = join(temp, "nope.yaml");
    const result = cli(["handbook", "validate", "--contract", missing, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "NOT_FOUND");
    assert.equal(result.status, 3, `expected exit 3, got ${result.status}`);
    assert.equal(parsed.error.details.contract_path, shown(missing));
    assert.ok(!JSON.stringify(parsed).includes("ENOENT"), "raw runtime error text must not reach the envelope");
    const human = cli(["handbook", "validate", "--contract", missing]);
    assert.equal(human.status, 3);
    assert.ok(human.stdout.includes(shown(missing)), "human report must name the path");
    assert.ok(!/\n\s+at /.test(human.stdout + human.stderr), "no stack trace may be printed");
  });

  check("a forward schema version fails as UNSUPPORTED_SCHEMA_VERSION stating the range", () => {
    const path = mutated("future-schema", (document) => { document.set("schema_version", 99); });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "UNSUPPORTED_SCHEMA_VERSION");
    assert.equal(result.status, 5, `expected exit 5, got ${result.status}`);
    assert.match(parsed.error.message, /supported range 1\.\.5/, "diagnostic must state the supported range");
    assert.equal(parsed.error.details.diagnostic_count, 1, "a version this build cannot read must not be partially applied");
  });

  // -- namespaced extensions --------------------------------------------------

  check("x- extensions round-trip verbatim and stay out of policy", () => {
    const withExtensions = YAML.parseDocument(TRACKED_TEXT);
    withExtensions.setIn(["x-delonet/root-note"], "root level extension");
    withExtensions.setIn(["authorities", "project_identity", "x-delonet/nested-note"], "nested extension");
    const text = String(withExtensions);
    const path = rawCopy("extensions", text);

    // The serializer is the round trip: what the CLI reports must survive it.
    assert.equal(String(YAML.parseDocument(text)), text, "extension-bearing contract must be byte-stable");

    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, `extensions must not invalidate a contract: ${JSON.stringify(parsed.error)}`);
    assert.equal(result.status, 0);
    const paths = parsed.data.extensions.map((item) => item.path);
    assert.ok(paths.includes("x-delonet/root-note"), "root extension must be reported");
    assert.ok(paths.includes("authorities.project_identity.x-delonet/nested-note"), "nested extension must be reported");
    const project = parsed.data.authorities.find((item) => item.id === "project_identity");
    assert.ok(!Object.keys(project).some((key) => key.startsWith("x-")), "an extension must never appear as policy");
    assert.equal(readFileSync(path, "utf8"), text, "validation must not rewrite the contract it read");
  });

  // -- read-only, on the failing paths too ------------------------------------

  check("host paths and credential-shaped values are rejected", () => {
    const cases = [
      // No trailing slash, and /root, both walked straight through before.
      // Assembled at runtime: a literal `/home/<name>` in a *-regressions file
      // is banned outright by tests/portable-test-paths-regressions.mjs, and
      // that gate is right to not try to tell a synthetic one from a real one.
      ["host-no-slash", join("/", "home", "someone"), /absolute host path/],
      ["host-root", join("/", "root", "secrets"), /absolute host path/],
      // A key-name-only scan let a live-looking key through as a value.
      // Assembled at runtime for the same reason the host paths above are: a
      // credential-shaped literal in a tracked file trips the machine-wide
      // git-guard, and that guard is right not to try to tell a vendor's
      // published docs placeholder from a live key. The validator sees the
      // identical string either way.
      ["secret-value", ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("-"), /credential-shaped value/],
    ];
    for (const [name, value, expected] of cases) {
      const path = mutated(`unsafe-${name}`, (document) => { document.setIn(["authorities", "project_identity", "store"], value); });
      const result = cli(["handbook", "validate", "--contract", path, "--json"]);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "INVALID_INPUT", `${name} must be rejected`);
      assert.equal(result.status, 2);
      assert.match(parsed.error.message, expected);
    }
  });

  check("a credential parked in an x- extension is still rejected", () => {
    // An extension is not policy, but it is still a tracked file.
    const path = mutated("extension-credential", (document) => {
      // Assembled at runtime; see the secret-value case above.
      document.setIn(["x-delonet/provenance", "note"], `AKIA${"IOSFODNN7"}EXAMPLE`);
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    assert.equal(errorCode(envelope(result)), "INVALID_INPUT");
    assert.equal(result.status, 2);
  });

  check("a __proto__ key is data, and is rejected rather than vanishing", () => {
    // `yaml` hands `__proto__` back as a real own key; assigning it onto a
    // normal object literal set the prototype instead, so the key disappeared
    // from the policy tree and no rule could ever see it.
    const path = mutated("proto-key", (document) => { document.setIn(["service_model", "__proto__"], "pwn"); });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(parsed.error.message, /forbidden key name/);
  });

  check("an explicitly empty --contract is rejected, not silently redirected", () => {
    // `--contract "$UNSET"` used to fall through to the tracked contract and
    // report success about a file the caller never named.
    const result = cli(["handbook", "validate", "--contract", "", "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(parsed.error.message, /empty path/);
  });

  check("a non-canonical TRACKED contract fails; an operator file only reports", () => {
    // Same bytes, two verdicts, and that asymmetry is the point: the tracked
    // file is the canonical artifact, an operator's candidate owes nobody
    // canonical formatting.
    const drifted = `${TRACKED_TEXT}\n\n\n`;
    const path = rawCopy("non-canonical", drifted);
    assert.notEqual(String(YAML.parseDocument(drifted)), drifted, "fixture assumption: this text is not its own serialization");
    const override = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(override);
    assert.equal(parsed.ok, true, "an operator file needs no canonical formatting");
    assert.equal(parsed.data.byte_stable, false, "but the fact must still be reported");
    assert.equal(override.status, 0);
  });

  check("Commander rejecting the arguments still yields one JSON envelope", () => {
    // Zero bytes and exit 1 is outside this command's exit taxonomy, and
    // unparseable by whatever asked for --json in the first place.
    const result = cli(["handbook", "validate", "--json", "--bogus"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, false);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
  });

  check("an unreadable contract exits 6 as INTERNAL_ERROR, leaking nothing", () => {
    const path = rawCopy("unreadable", TRACKED_TEXT);
    chmodSync(path, 0o000);
    let readable = true;
    try { readFileSync(path, "utf8"); } catch { readable = false; }
    if (readable) {
      chmodSync(path, 0o644);
      skip("an unreadable contract exits 6 as INTERNAL_ERROR", "this process can read a 0o000 file (running as root?)");
      return;
    }
    try {
      const result = cli(["handbook", "validate", "--contract", path, "--json"]);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "INTERNAL_ERROR");
      assert.equal(result.status, 6, `expected exit 6, got ${result.status}`);
      const both = `${result.stdout}${result.stderr}`;
      assert.ok(!both.includes("EACCES"), "the raw errno must not reach the operator");
      assert.ok(!both.includes(PASSWD_HOME), "no absolute home path may leak");
      assert.ok(!/\n\s+at /.test(both), "no stack frames");
    } finally {
      chmodSync(path, 0o644);
    }
  });

  check("a path under another account's home is redacted, not passed through", () => {
    const foreign = join("/", "home", "not-this-operator", "fleet-contract.yaml");
    const result = cli(["handbook", "validate", "--contract", foreign, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "NOT_FOUND");
    assert.equal(result.status, 3);
    assert.equal(parsed.error.details.contract_path, "/home/<redacted>/fleet-contract.yaml");
  });

  check("a closed stdout is not an error", () => {
    // `... --json | head -1` closes the pipe mid-write.
    // bash, not sh: `pipefail` is not POSIX, and CI's /bin/sh is a dash that
    // rejects it with "Illegal option -o pipefail" and exits 2. This box's dash
    // accepts it silently, so the suite was green here and red in CI.
    // `set -o pipefail` matters: without it the pipeline reports HEAD's status,
    // which is 0 however the CLI died, so the assertion below could not fail.
    const piped = spawnSync("bash", ["-c", `set -o pipefail; ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} handbook validate --json | head -1`], {
      cwd: temp, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...isolation },
    });
    assert.equal(piped.status, 0, `pipeline exited ${piped.status}: ${piped.stderr}`);
    assert.equal(piped.stdout.trim(), "{", "head must still see the first line");
    assert.ok(!/EPIPE/.test(piped.stderr), `EPIPE reached stderr: ${piped.stderr}`);
  });

  check("src/org never calls process.exit()", () => {
    // The cheapest possible guard against the one defect the story names:
    // exiting before stdout drains is what truncates `audit --json`.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        readFileSync(path, "utf8").split("\n").forEach((line, index) => {
          if (/(?<!\/\/.*)\bprocess\.exit\s*\(/.test(line) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")) {
            offenders.push(`${relative(ROOT, path)}:${index + 1}`);
          }
        });
      }
    };
    walk(join(PKG, "src", "org"));
    assert.deepEqual(offenders, [], `process.exit() truncates buffered stdout: ${offenders.join(", ")}`);
  });

  check("a directory given as a contract fails as INVALID_INPUT, not a crash", () => {
    const result = cli(["handbook", "validate", "--contract", temp, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
  });

  check("no protected root changes across a run of several invocations", () => {
    // `cli()` already brackets each call. This widens the window to several
    // calls, which is the only way to catch a write that a later call reverts
    // -- and it compares against a baseline taken here, not one re-read after
    // the fact, which would have made the check unable to fail.
    const baseline = snapshot();
    assert.ok(Object.keys(baseline).some((key) => key.startsWith("home:")), "fixture assumption: the scratch HOME has content to protect");
    assert.ok(Object.keys(baseline).some((key) => key.startsWith("contracts:")), "fixture assumption: the tracked contract is covered");
    cli(["handbook", "validate"]);
    cli(["handbook", "validate", "--json"]);
    cli(["handbook", "validate", "--contract", join(temp, "nope.yaml"), "--json"]);
    assert.deepEqual(snapshot(), baseline);
  });

  // -- rules that were implemented but never exercised ----------------------
  // Each of these passed before only because every assertion read the TRACKED
  // contract, which satisfies the rule. Deleting the rule left the suite green.

  check("a symlinked profile root is refused", () => {
    // The one profile shape the contract exists to refuse: a symlinked root
    // loses profile identity and shared auth.
    const path = mutated("symlink-allowed", (doc) => {
      doc.setIn(["service_model", "profile_layout", "symlink_allowed"], true);
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(JSON.stringify(parsed.error), /symlink_allowed/);
  });

  check("collapsing the activation ladder is refused", () => {
    // Dropping installed/healthy/routing_ready re-merges discovery into
    // activation -- exactly what the retired mode activation-by-discovery names.
    const path = mutated("collapsed-states", (doc) => {
      doc.setIn(["activation", "states"], ["discovered", "activated"]);
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(JSON.stringify(parsed.error), /activation\.states/);
  });

  check("deleting a retired mode is refused, not silently accepted", () => {
    // retired[] is where the detect patterns live, so deleting an entry deletes
    // its detection. The completeness check is what stops that.
    const path = mutated("dropped-retired", (doc) => {
      const modes = doc.get("retired");
      const index = modes.items.findIndex((item) => String(item.get("id")) === "per-agent-checkpoint-timer");
      assert.notEqual(index, -1, "fixture assumption: the checkpoint-timer mode is declared");
      modes.items.splice(index, 1);
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(JSON.stringify(parsed.error), /per-agent-checkpoint-timer/);
  });

  check("a duplicate retired id cannot stand in for the mode it shadows", () => {
    const path = mutated("duplicate-retired", (doc) => {
      const modes = doc.get("retired");
      const index = modes.items.findIndex((item) => String(item.get("id")) === "per-agent-checkpoint-timer");
      modes.items[index].set("id", "n8n-owned-truth");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(JSON.stringify(parsed.error), /duplicate retired mode id/);
  });

  check("superseded_by must resolve to a real block of this contract", () => {
    // It is the only next step a RETIRED_MODE diagnostic offers an operator;
    // unresolved, it rots silently on the first rename.
    const path = mutated("dangling-superseded", (doc) => {
      doc.getIn(["retired", 0]).set("superseded_by", "service_model.fleet_shared.renamed_away");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(JSON.stringify(parsed.error), /does not resolve/);
  });

  check("a credential-shaped KEY is rejected, not just a credential-shaped value", () => {
    // The value half was covered. A short benign value under a key named
    // session_token trips no value pattern, so only the key rule catches it.
    const path = mutated("credential-key", (doc) => {
      doc.setIn(["service_model", "fleet_shared", "session_token"], "abcd1234");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(JSON.stringify(parsed.error), /credential-shaped keys/);
  });

  check("a credential in retired[].reason is still a credential", () => {
    // retired[] was exempted wholesale from the credential scan so that detect
    // could spell the banned shapes. Only detect is exempt now.
    const path = mutated("credential-in-reason", (doc) => {
      doc.getIn(["retired", 0]).set("reason", "leaked AKIAIOSFODNN7EXAMPLE while migrating");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(JSON.stringify(parsed.error), /credential-shaped value/);
  });

  check("a host path in retired[].reason is still a host path", () => {
    const path = mutated("host-path-in-reason", (doc) => {
      // Assembled, never written literally: portable-test-paths-regressions
      // fails the build on a machine-specific home path in a release suite.
      const foreign = join("/", "home", "someone-else", "hermes");
      doc.getIn(["retired", 0]).set("reason", `pinned to ${foreign} by hand`);
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(JSON.stringify(parsed.error), /absolute host path/);
  });

  check("a catastrophically backtracking detect pattern is refused, not run", () => {
    // Every detect pattern runs against every scalar leaf. ^(a+)+$ against a
    // 40-character note pinned a core and never returned; the CLI must answer.
    const path = mutated("redos-detect", (doc) => {
      doc.getIn(["retired", 0, "detect"]).add("^(a+)+$");
      doc.setIn(["authorities", "project_identity", "notes"], ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"]);
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(JSON.stringify(parsed.error), /backtrack catastrophically/);
  });

  check("two projections may not feed one target", () => {
    // One field, two upstream truths is the exact overlap this contract was
    // written to end.
    const path = mutated("forked-target", (doc) => {
      const projections = doc.get("projections");
      const clone = doc.createNode(projections.get(0).toJSON());
      clone.set("source", "projects.{slug}.status");
      clone.set("field", "forked_target");
      projections.add(clone);
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.match(JSON.stringify(parsed.error), /already fed by/);
  });

  check("a field pair may not flow in both directions", () => {
    const path = mutated("reversed-pair", (doc) => {
      const projections = doc.get("projections");
      const first = projections.get(0);
      const source = String(first.get("source"));
      const target = String(first.get("target"));
      const clone = doc.createNode(first.toJSON());
      clone.set("source", target);
      clone.set("target", source);
      clone.set("field", "reversed_pair");
      projections.add(clone);
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.match(JSON.stringify(parsed.error), /one direction only|already fed by/);
  });

  check("the per-agent unit patterns must stay three distinct names", () => {
    const path = mutated("collapsed-units", (doc) => {
      doc.setIn(["service_model", "per_agent", "heartbeat_service"], "hermes-{agent_id}-gateway.service");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.match(JSON.stringify(parsed.error), /three distinct patterns/);
  });

  check("the generated profile file may not shadow the override SSOT", () => {
    const path = mutated("collapsed-profile-files", (doc) => {
      doc.setIn(["service_model", "profile_layout", "generated_file"], "config.delta.yaml");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.match(JSON.stringify(parsed.error), /three distinct names/);
  });

  check("a profile root without {profile_name} collapses profile identity", () => {
    const path = mutated("shared-profile-root", (doc) => {
      doc.setIn(["service_model", "profile_layout", "root"], "{HERMES_FLEET_HOME}/profiles");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.match(JSON.stringify(parsed.error), /\{profile_name\} placeholder/);
  });

  // -- promises the envelope made but could not keep ------------------------

  check("--contract cannot swallow the flag that follows it", () => {
    // Commander binds the next token as the value, so `--contract --json` made
    // the FLAG the path and answered a JSON caller with the ANSI human report.
    const result = cli(["handbook", "validate", "--contract", "--json"]);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
    assert.match(result.stdout, /an option, not a path/);
  });

  check("--help alongside --json is a success, and prints one document", () => {
    // Help is a success Commander reports by throwing. Caught by the fleet JSON
    // branch it printed usage text AND a failure envelope, then exited 2.
    const result = cli(["handbook", "validate", "--help", "--json"]);
    assert.equal(result.status, 0, `help must exit 0, got ${result.status}: ${result.stderr}`);
    assert.equal(result.stdout.includes('"schema_version"'), false, "help must not be followed by an envelope");
  });

  check("an alias bomb is the caller's bad input, not our internal error", () => {
    // toJS() throws after a clean parse when the library's maxAliasCount trips.
    // Unhandled it surfaced as INTERNAL_ERROR/exit 6, which the taxonomy
    // reserves for defects in us.
    const lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
    for (let level = 1; level <= 8; level += 1) {
      const previous = `*a${level - 1}`;
      lines.push(`a${level}: &a${level} [${new Array(10).fill(previous).join(", ")}]`);
    }
    const path = rawCopy("alias-bomb", `${lines.join("\n")}\n`);
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2, "a hostile input file is exit 2, never exit 6");
  });

  check("a path under /root is redacted like any other home", () => {
    // HOST_PATH in contract.ts counts /root as a home directory; redactHome did
    // not, so the two answers to "what is a home" had drifted apart.
    const result = cli(["handbook", "validate", "--contract", "/root/handbook.yaml", "--json"]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "NOT_FOUND");
    assert.equal(parsed.error.details.contract_path, "/root/<redacted>/handbook.yaml");
  });

  check("a clipped details map says so, instead of quietly under-reporting", () => {
    // The human report lists every finding; details is capped. Without the
    // marker a 30-finding contract showed 18 entries and a count of 30, and the
    // only way to notice was to compare the two by hand.
    const path = mutated("many-findings", (doc) => {
      for (let index = 0; index < 30; index += 1) doc.set(`unknown_key_${index}`, "x");
    });
    const result = cli(["handbook", "validate", "--contract", path, "--json"]);
    const parsed = envelope(result);
    const details = parsed.error.details;
    assert.ok(details.diagnostic_count >= 30, `expected at least 30 findings, got ${details.diagnostic_count}`);
    assert.equal(typeof details.diagnostics_truncated, "string", "a clipped details map must announce the clip");
    assert.match(details.diagnostics_truncated, /showing \d+ of \d+ findings/);
  });

  check("a control character in a contract cannot reach the terminal raw", () => {
    // A candidate file is operator input, and every one of these strings is
    // printed as a row of the human report.
    const path = mutated("escape-injection", (doc) => {
      doc.getIn(["projections", 0]).set("field", "clear[2Jscreen");
    });
    const result = cli(["handbook", "validate", "--contract", path]);
    assert.equal(result.stdout.includes("[2J"), false, "an escape sequence reached the report");
  });

  check("no TypeScript source carries a raw NUL byte", () => {
    // A literal NUL makes GNU grep treat the file as binary. The machine-wide
    // pre-commit secret scan greps the unified diff, so one NUL anywhere in
    // that stream silently no-ops the whole scan for the commit carrying it.
    // Scoped to all of src/, not just src/fleet: the first one found here was
    // in src/fleet/contract.ts, the second in src/project/identity.ts, and both
    // were the same idea -- a NUL used as a composite-map-key separator.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        if (readFileSync(full).includes(0)) offenders.push(relative(ROOT, full));
      }
    };
    for (const src of SRC_ROOTS) walk(src);
    assert.deepEqual(offenders, [], `raw NUL byte in TypeScript source; write it as a \\u0000 escape:\n${offenders.join("\n")}`);
  });

  // -- health_policy: the sixth validation stage, one case per fail() branch --
  //
  // THE ONLY STAGE THAT HAD NO NEGATIVE TEST, and its failure mode is silent
  // and FLATTERING, which is the worst combination a validator can have. Delete
  // the `declaredFields.has(field)` check and a contract whose freshness entry
  // reads `board_confirmd_at` validates green; `evaluateFreshness` matches by
  // exact string, so every reading buckets `not_applicable`, `health.stale`
  // stays 0, and a fleet whose board confirmation is from the year 2000 reports
  // `proven: true`. The whole suite stays green while the policy silently
  // authorizes nothing and gates nothing.
  //
  // Each case below drives ONE `fail()` branch and asserts the diagnostic PATH,
  // not just the code -- the path is what tells an operator which entry to open,
  // and a stage that rejects the right file at the wrong path is barely better
  // than one that does not reject at all.
  const policyRejects = (name, mutate, path, hint) => {
    check(`health_policy: ${name}`, () => {
      const file = mutated(`health-policy-${name.replace(/[^a-z0-9]+/gu, "-")}`, (document) => {
        mutate(document.get("health_policy"), document);
      });
      const result = cli(["handbook", "validate", "--contract", file, "--json"]);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "INVALID_INPUT", `expected INVALID_INPUT for ${name}`);
      assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
      assert.ok(
        parsed.error.message.startsWith(`${path}:`),
        `the diagnostic must be addressed at ${path}, got ${parsed.error.message}`,
      );
      if (hint) assert.match(parsed.error.message, hint, `the diagnostic must say why: ${parsed.error.message}`);
    });
  };

  policyRejects("an unknown required domain", (policy) => {
    policy.set("required_domains", ["registry", "not_a_domain"]);
  }, "health_policy.required_domains[1]", /must name one of/u);

  policyRejects("a duplicate required domain", (policy) => {
    policy.set("required_domains", ["registry", "registry"]);
  }, "health_policy.required_domains[1]", /duplicate required domain/u);

  policyRejects("an unknown top-level policy key", (policy) => {
    policy.set("allowed_everything", []);
  }, "health_policy.allowed_everything", /unknown health_policy key/u);

  policyRejects("a deferred capability naming no domain of ours", (policy) => {
    policy.get("deferred_capabilities").get(0).set("domain", "not_a_domain");
  }, "health_policy.deferred_capabilities[0].domain", /must name one of/u);

  policyRejects("a deferral with no reason", (policy) => {
    policy.get("deferred_capabilities").get(0).set("reason", "   ");
  }, "health_policy.deferred_capabilities[0].reason", /non-empty/u);

  policyRejects("a deferral with no owning story", (policy) => {
    policy.get("deferred_capabilities").get(0).delete("owner_story");
  }, "health_policy.deferred_capabilities[0].owner_story", /non-empty/u);

  policyRejects("an unknown deferred_capabilities key", (policy) => {
    policy.get("deferred_capabilities").get(0).set("until", "someday");
  }, "health_policy.deferred_capabilities[0].until", /unknown deferred_capabilities key/u);

  policyRejects("an allowed warning with no owner", (policy) => {
    policy.get("allowed_warnings").get(0).set("owner", "");
  }, "health_policy.allowed_warnings[0].owner", /non-empty/u);

  policyRejects("an allowed skip naming both a domain and a rule", (policy, document) => {
    document.setIn(["health_policy", "allowed_skips"], [
      { domain: "registry", rule_id: "notebook.remote-notebook", reason: "both at once" },
    ]);
  }, "health_policy.allowed_skips[0]", /exactly one of domain or rule_id/u);

  policyRejects("an allowed skip naming neither", (policy, document) => {
    document.setIn(["health_policy", "allowed_skips"], [{ reason: "a reason for nothing in particular" }]);
  }, "health_policy.allowed_skips[0]", /exactly one of domain or rule_id/u);

  // THE ONE THE REVIEW NAMED. A typo'd field validates green without this and
  // buckets every reading `not_applicable` forever.
  policyRejects("a freshness field no authority declares", (policy) => {
    policy.get("freshness").get(0).set("field", "projects.{slug}.ticket_provider.board_confirmd_at");
  }, "health_policy.freshness[0].field", /not declared writable by any authority/u);

  policyRejects("a duplicate freshness policy for one field", (policy, document) => {
    const entry = policy.get("freshness").get(0).toJSON();
    document.addIn(["health_policy", "freshness"], document.createNode(entry));
  }, "health_policy.freshness[3].field", /duplicate freshness policy/u);

  policyRejects("a max_age_days of zero", (policy) => {
    policy.get("freshness").get(0).set("max_age_days", 0);
  }, "health_policy.freshness[0].max_age_days", /positive whole number of days/u);

  policyRejects("a fractional max_age_days", (policy) => {
    policy.get("freshness").get(0).set("max_age_days", 0.5);
  }, "health_policy.freshness[0].max_age_days", /positive whole number of days/u);

  policyRejects("a freshness entry applying to no domain of ours", (policy) => {
    policy.get("freshness").get(0).set("applies_to", "not_a_domain");
  }, "health_policy.freshness[0].applies_to", /must name one of/u);

  policyRejects("a health_policy that is not a mapping", (policy, document) => {
    document.set("health_policy", "yes please");
  }, "health_policy", /must be a mapping/u);

  // -- health_policy.agent_exceptions (story 1.6 / PJAN-108) -----------------

  policyRejects("an agent exception naming no domain of ours", (policy, document) => {
    document.setIn(["health_policy", "agent_exceptions"], [{ domain: "not_a_domain", agent_id: "alpha-pm", reason: "ruled", owner: "suite" }]);
  }, "health_policy.agent_exceptions[0].domain", /must name one of/u);

  policyRejects("an agent exception with a blank agent id", (policy, document) => {
    document.setIn(["health_policy", "agent_exceptions"], [{ domain: "template_scaffold", agent_id: "", reason: "ruled", owner: "suite" }]);
  }, "health_policy.agent_exceptions[0].agent_id", /registry key/u);

  policyRejects("an agent exception with no owner", (policy, document) => {
    document.setIn(["health_policy", "agent_exceptions"], [{ domain: "template_scaffold", agent_id: "alpha-pm", reason: "ruled" }]);
  }, "health_policy.agent_exceptions[0].owner", /non-empty/u);

  policyRejects("two agent exceptions on one (domain, agent_id)", (policy, document) => {
    document.setIn(["health_policy", "agent_exceptions"], [
      { domain: "template_scaffold", agent_id: "alpha-pm", reason: "ruled once", owner: "suite" },
      { domain: "template_scaffold", agent_id: "alpha-pm", reason: "ruled twice", owner: "suite" },
    ]);
  }, "health_policy.agent_exceptions[1]", /duplicate agent exception/u);

  policyRejects("an unknown agent_exceptions key", (policy, document) => {
    document.setIn(["health_policy", "agent_exceptions"], [{ domain: "template_scaffold", agent_id: "alpha-pm", reason: "ruled", owner: "suite", until: "someday" }]);
  }, "health_policy.agent_exceptions[0].until", /unknown agent_exceptions key/u);

  // -- scaffold_manifest: the seventh validation stage (story 1.6 / PJAN-108) --
  //
  // A manifest that matches nothing must fail to LOAD, because the failure mode
  // of one that loads is flattering: a group key no authority declares resolves
  // no owner, a presence-only path outside every group is compared for nothing,
  // and a render input fed by an undeclared field makes every rendered asset
  // `incomplete` forever while reading as if the registry were at fault.
  const manifestRejects = (name, mutate, path, hint) => {
    check(`scaffold_manifest: ${name}`, () => {
      const file = mutated(`scaffold-manifest-${name.replace(/[^a-z0-9]+/gu, "-")}`, (document) => {
        mutate(document.get("scaffold_manifest"), document);
      });
      const result = cli(["handbook", "validate", "--contract", file, "--json"]);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "INVALID_INPUT", `expected INVALID_INPUT for ${name}`);
      assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
      assert.ok(parsed.error.message.startsWith(`${path}:`), `the diagnostic must be addressed at ${path}, got ${parsed.error.message}`);
      if (hint) assert.match(parsed.error.message, hint, `the diagnostic must say why: ${parsed.error.message}`);
    });
  };

  manifestRejects("a manifest that is not a mapping", (manifest, document) => {
    document.set("scaffold_manifest", "yes please");
  }, "scaffold_manifest", /must be a mapping/u);

  manifestRejects("an unknown manifest key", (manifest) => {
    manifest.set("template_branch", "main");
  }, "scaffold_manifest.template_branch", /unknown scaffold_manifest key/u);

  manifestRejects("a group key no authority declares writable", (manifest) => {
    manifest.get("groups").set("scaffold.invented", "invented/");
  }, "scaffold_manifest.groups.scaffold.invented", /not declared writable/u);

  manifestRejects("a group path that escapes the role", (manifest) => {
    manifest.get("groups").set("scaffold.momo", "../momo");
  }, "scaffold_manifest.groups.scaffold.momo", /role-relative/u);

  manifestRejects("two groups owning one path", (manifest) => {
    manifest.get("groups").set("scaffold.momo", "hermes");
  }, "scaffold_manifest.groups.scaffold.momo", /duplicate group path/u);

  manifestRejects("a presence-only path that resolves to no group", (manifest) => {
    manifest.get("presence_only").get(0).set("path", "elsewhere/role.yaml");
  }, "scaffold_manifest.presence_only[0].path", /resolves to no declared group/u);

  manifestRejects("a presence-only entry with no reason", (manifest) => {
    manifest.get("presence_only").get(0).set("reason", "  ");
  }, "scaffold_manifest.presence_only[0].reason", /non-empty/u);

  manifestRejects("a render input fed by a field no authority declares", (manifest) => {
    manifest.get("render_inputs").set("display_name", "agents.{agent_id}.display_nmae");
  }, "scaffold_manifest.render_inputs.display_name", /not agents\.\{agent_id\} or a declared/u);

  manifestRejects("a render input fed by a root the observer cannot resolve", (manifest) => {
    manifest.get("render_inputs").set("role", "gateways.bloodbank.scope");
  }, "scaffold_manifest.render_inputs.role", /not agents\.\{agent_id\} or a declared/u);

  manifestRejects("an excluded pattern that matches every segment", (manifest) => {
    manifest.set("excluded_patterns", ["*"]);
  }, "scaffold_manifest.excluded_patterns[0]", /every segment/u);

  manifestRejects("a runtime_dir that is a path", (manifest) => {
    manifest.set("runtime_dir", "runtime/state");
  }, "scaffold_manifest.runtime_dir", /one safe path segment/u);

  manifestRejects("a render suffix that is not an extension", (manifest) => {
    manifest.set("render_suffix", "jinja");
  }, "scaffold_manifest.render_suffix", /dotted extension/u);

  check("scaffold_manifest: a schema-2 contract with no manifest still loads", () => {
    // OPTIONAL, and that is load-bearing: a contract that predates the block is
    // simply one that declares no scaffold to compare against. The observer
    // then reports `unsupported` under capability `scaffold.manifest`; the
    // contract itself must not be refused.
    const file = mutated("schema-2-no-manifest", (document) => {
      document.delete("scaffold_manifest");
      document.set("schema_version", 2);
      document.setIn(["compatibility", "max_schema_version"], 2);
    });
    const result = cli(["handbook", "validate", "--contract", file, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, `a schema-2 contract must still validate: ${JSON.stringify(parsed.error)}`);
    assert.equal(parsed.data.schema_version, 2);
  });

  check("scaffold_manifest: the tracked manifest validates and covers the eight declared leaves", () => {
    const result = cli(["handbook", "validate", "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, `the tracked contract must validate: ${JSON.stringify(parsed.error)}`);
    assert.equal(parsed.data.schema_version, 5, "story 1.6 bumped the tracked contract to schema 3, story 1.7 to 4 and story 1.8 to 5");
    const contract = YAML.parse(TRACKED_TEXT);
    const manifest = contract.scaffold_manifest;
    assert.ok(manifest, "the tracked contract must declare a scaffold_manifest or the rejections above prove nothing");
    const leaves = contract.authorities.tracked_role_scaffold.writable_fields;
    assert.deepEqual(Object.keys(manifest.groups).sort(), [...leaves].sort(), "every scaffold.* leaf must own exactly one group, and every group must be a declared leaf");
    assert.ok(manifest.presence_only.length >= 2, "role.yaml and SOUL.md are presence-only by policy");
    assert.deepEqual(contract.health_policy.agent_exceptions, [], "agent_exceptions ships empty; a ruling is written when it is made");
    assert.equal(
      contract.health_policy.deferred_capabilities.some((entry) => entry.capability === "scaffold.template_ref"), false,
      "the scaffold.template_ref deferral is gone: the observer answers it",
    );
  });

  // -- profile_manifest: the eighth validation stage (story 1.7 / PJAN-109) --
  //
  // A manifest that names nothing real must fail to LOAD: a bank-id template
  // with no placeholder would tell every profile to pin ONE bank, a `check`
  // argv that never names the profile would check every profile and follow
  // every symlink in the root, an absolute canonical directory would put a
  // host path in a tracked file, and a limit above this build's ceiling would
  // validate a memory problem.
  const profileRejects = (name, mutate, path, hint) => {
    check(`profile_manifest: ${name}`, () => {
      const file = mutated(`profile-manifest-${name.replace(/[^a-z0-9]+/gu, "-")}`, (document) => {
        mutate(document.get("profile_manifest"), document);
      });
      const result = cli(["handbook", "validate", "--contract", file, "--json"]);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "INVALID_INPUT", `expected INVALID_INPUT for ${name}`);
      assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
      assert.ok(parsed.error.message.startsWith(`${path}:`), `the diagnostic must be addressed at ${path}, got ${parsed.error.message}`);
      if (hint) assert.match(parsed.error.message, hint, `the diagnostic must say why: ${parsed.error.message}`);
    });
  };

  profileRejects("a manifest that is not a mapping", (manifest, document) => {
    document.set("profile_manifest", "yes please");
  }, "profile_manifest", /must be a mapping/u);
  profileRejects("an unknown key", (manifest) => {
    manifest.setIn(["renderer", "timeout_seconds"], 5);
  }, "profile_manifest.renderer.timeout_seconds", /unknown profile_manifest\.renderer key/u);
  profileRejects("a bank-id template with no placeholder", (manifest) => {
    manifest.setIn(["memory", "bank_id_template"], "agent-shared");
  }, "profile_manifest.memory.bank_id_template", /must carry the \{profile_name\} placeholder/u);
  profileRejects("a check argv that never names the profile", (manifest) => {
    manifest.setIn(["renderer", "check_argv"], ["check", "--all"]);
  }, "profile_manifest.renderer.check_argv", /exactly one argument/u);
  profileRejects("a duplicate core skill", (manifest) => {
    manifest.setIn(["skill_core", "required"], ["hindsight", "hindsight"]);
  }, "profile_manifest.skill_core.required[1]", /duplicate entry hindsight/u);
  profileRejects("an absolute canonical directory", (manifest) => {
    manifest.setIn(["skill_core", "canonical_dir"], "/srv/skills");
  }, "profile_manifest.skill_core.canonical_dir", /placeholder, never an absolute host path/u);
  profileRejects("a renderer in a different submodule from the scaffold's", (manifest) => {
    manifest.setIn(["renderer", "submodule"], "templates/other");
  }, "profile_manifest.renderer.submodule", /must equal scaffold_manifest\.template_submodule/u);
  profileRejects("a limit above this build's ceiling", (manifest) => {
    manifest.setIn(["limits", "max_root_entries"], 50000);
  }, "profile_manifest.limits.max_root_entries", /may not exceed this build's ceiling/u);
  profileRejects("a pin file under a leaf no authority declares", (manifest) => {
    manifest.setIn(["memory", "pin_file"], "memory/pin.json");
  }, "profile_manifest.memory.pin_file", /not declared writable by any authority/u);
  profileRejects("an ignore list that does not cover the renderer's lock pattern", (manifest) => {
    manifest.setIn(["extras", "ignored_patterns"], ["*.tmp"]);
  }, "profile_manifest.extras.ignored_patterns", /must cover renderer\.lock_pattern/u);
  profileRejects("a lock timeout that is not a positive number of seconds", (manifest) => {
    manifest.setIn(["renderer", "lock_timeout_seconds"], 0);
  }, "profile_manifest.renderer.lock_timeout_seconds", /positive number of seconds/u);
  profileRejects("an ignore pattern made of wildcards alone", (manifest) => {
    manifest.addIn(["extras", "ignored_patterns"], "?*");
  }, "profile_manifest.extras.ignored_patterns[1]", /may not match every entry/u);
  profileRejects("a non-list core", (manifest) => {
    manifest.setIn(["skill_core", "required"], "hindsight");
  }, "profile_manifest.skill_core.required", /list/u);

  check("profile_manifest: a schema-3 contract with no manifest still loads", () => {
    // OPTIONAL, and that is load-bearing: a contract that predates the block is
    // simply one that declares no generated-profile policy to prove. The
    // observer then reports every field `unsupported` under capability
    // `profile.manifest`; the contract itself must not be refused.
    const file = mutated("schema-3-no-profile-manifest", (document) => {
      document.delete("profile_manifest");
      document.deleteIn(["authorities", "provisioned_profile_state"]);
      document.set("schema_version", 3);
      document.setIn(["compatibility", "max_schema_version"], 3);
    });
    const result = cli(["handbook", "validate", "--contract", file, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, `a schema-3 contract must still validate: ${JSON.stringify(parsed.error)}`);
    assert.equal(parsed.data.schema_version, 3);
  });

  check("profile_manifest: the tracked manifest validates, owns three declared leaves, and the render_generation deferral is gone", () => {
    const result = cli(["handbook", "validate", "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, `the tracked contract must validate: ${JSON.stringify(parsed.error)}`);
    const contract = YAML.parse(TRACKED_TEXT);
    const manifest = contract.profile_manifest;
    assert.ok(manifest, "the tracked contract must declare a profile_manifest or the rejections above prove nothing");
    assert.equal(manifest.renderer.submodule, contract.scaffold_manifest.template_submodule);
    assert.deepEqual(manifest.renderer.check_argv, ["check", "--profile", "{profile_name}"]);
    assert.deepEqual(manifest.skill_core.required, [], "no mandatory global skill projection");
    assert.deepEqual(contract.authorities.provisioned_profile_state.writable_fields, [
      "profiles.{profile_name}.profile.yaml", "profiles.{profile_name}.hindsight.config.json", "profiles.{profile_name}.skills",
    ]);
    assert.equal(
      contract.health_policy.deferred_capabilities.some((entry) => entry.capability === "profile.render_generation"), false,
      "the profile.render_generation deferral is gone: the observer answers it",
    );
  });

  check("health_policy: a valid policy still validates, so the cases above are not vacuous", () => {
    // Every rejection above is only evidence if the UNMUTATED contract passes
    // this stage -- otherwise they could all be firing on something else.
    const result = cli(["handbook", "validate", "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, `the tracked contract must validate: ${JSON.stringify(parsed.error)}`);
    const policy = YAML.parse(TRACKED_TEXT).health_policy;
    assert.ok(policy, "the tracked contract must declare a health_policy or these cases prove nothing");
    // Two, not three: story 1.7 answered `profile.render_generation` and story
    // 1.8 answered `systemd`/`unit_topology`, leaving the live-process and
    // Bloodbank-liveness halves.
    assert.ok(policy.deferred_capabilities.length >= 2);
    assert.ok(policy.freshness.length >= 3);
    assert.ok(policy.allowed_skips.length >= 1);
    assert.ok(policy.allowed_warnings.length >= 1);
  });

  check("the suite is registered in the test runner", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.ok(runner.includes("tests/fleet-contract-regressions.mjs"), "a suite absent from SUITES never runs");
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} fleet contract check(s) failed`);
  process.exit(1);
}
console.log(`fleet contract regressions passed${skipped ? ` (${skipped} skipped)` : ""}`);
