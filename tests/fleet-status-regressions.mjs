// PJAN Epic 1 / Story 1.4: parse-safe, registry-wide fleet status.
//
// Two defect classes, and the suite exists for both:
//
//   1. NOTHING ANSWERED "IS THE FLEET CORRECT?". Nine observation domains
//      existed as scattered per-repository audits. The ways of aggregating them
//      that look right are all wrong: a host-scoped rule promoted into a
//      registry-wide claim (the category error PJAN-84 fixed), a domain that
//      silently disappears when nothing observed it, an aggregate that reports
//      `pass` for a domain it never read, and a `--agent` filter that probes the
//      whole fleet and then hides the results.
//   2. MACHINE OUTPUT TRUNCATED, SILENTLY, AT EXIT 0. `console.log(...)` +
//      `process.exit(n)` loses whatever `process.stdout` still has queued, and
//      on Linux stdout is ASYNCHRONOUS for a pipe. Measured on this runtime: a
//      200 000-character document reached a file complete and a pipe at 131 072
//      bytes, exit 0. `flume review --live` PARSES `flume audit
//      --json`, so that is no longer a latent bug in one command -- it is a
//      wrong answer about the whole fleet.
//
// The bar, carried from stories 1.1-1.3 plus one lesson those stories taught:
//
//   * Every case runs the REAL built `dist/index.js` in a real subprocess over
//     real OS pipes.
//   * stdout is asserted non-empty and parseable BEFORE anything is asserted
//     about its content.
//   * Every invocation is bracketed by a content+mtime snapshot of the scratch
//     tree, the tracked contract, and every probed repository's `.git/index`.
//   * The child-failure, child-timeout, cancellation and unmapped-rule cases are
//     driven through the DOCUMENTED `PJ_FLEET_CLI_ENTRY` seam against real
//     subprocess spawns, never mocks.
//   * DW-54 IS THE LESSON. Story 1.3's suite throws `SkipSuite` for its entire
//     body when any of the operator's three live sources is absent, so on a
//     fresh clone or in CI *nothing* is verified. Here the fleet is SYNTHETIC:
//     every registry, project, repository, profile and audit report is
//     constructed by this file. Only the handful of cases that assert against
//     the operator's real fleet may skip.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import {
  deferredAgentUnits,
  fakeSystemctlChildEnvs,
  fakeSystemctlInvocations,
  fakeSystemctlVerbs,
  installFakeSystemctl,
  mergeUnitSets,
  noBusIsolation,
  resetFakeSystemctl,
  setFakeSystemctlState,
  sharedGatewayUnits,
} from "./helpers/fake-systemctl.mjs";

const ROOT = resolve(import.meta.dirname, "..");
// The workspace that owns the CLI. `dist/` lives under the package; the handbook
// and the job-description template stay at the repo root.
const PKG = join(ROOT, "packages", "flume-hr");
const CLI = join(PKG, "dist", "index.js");
const TRACKED_CONTRACT = join(ROOT, "contracts", "handbook.yaml");

/** The nine domains, spelled out here so a silent narrowing in source fails a test. */
const DOMAINS = [
  "registry", "project_binding", "template_scaffold", "profile", "runtime",
  "systemd", "live_process", "bloodbank", "release_provenance",
];
/** Domains whose per-agent record the recipe audit can change. See AUDIT_PER_AGENT_DOMAINS. */
const AUDIT_FED = ["template_scaffold", "project_binding", "profile", "runtime"];
const DATA_KEYS = [
  "contract_path", "contract_version", "scope",
  "totals", "health", "agents", "domains", "host", "findings", "probes", "scaffold", "truncated",
];
/** Mirrors FLEET_STATUS_MAX_AGENTS / _MAX_OBSERVATIONS_PER_AGENT in src/fleet/types.ts. */
const MAX_AGENTS = 500;
const MAX_OBSERVATIONS = 200;

/**
 * The operator's real sources, derived and never written as a literal.
 *
 * `portable-test-paths-regressions` fails the build on a hardcoded `/home/<name>`
 * in any `*-regressions.mjs`, and a literal would also make the suite a fiction
 * on any other machine. Used ONLY by the skip-guarded live-source cases.
 */
const REAL_HOME = (() => { try { return userInfo().homedir; } catch { return homedir(); } })();
const REAL_AGENT_REGISTRY = process.env.HERMES_AGENTS_REGISTRY?.trim() || join(REAL_HOME, ".hermes", "agents-registry.yaml");
const REAL_PROJECT_REGISTRY = process.env.PJ_PROJECT_REGISTRY?.trim() || join(REAL_HOME, ".config", "pjangler", "projects.yaml");

const temp = mkdtempSync(join(tmpdir(), "fleet-status-"));
/**
 * Where the injected CLI entries live, and where they record what they saw.
 *
 * Deliberately OUTSIDE `temp`: `snapshotIsolated()` walks `temp` and asserts it is
 * byte-identical before and after every invocation, so a shim appending its own
 * pid or environment inside it would be indistinguishable from the command
 * writing there.
 */
const shimRoot = mkdtempSync(join(tmpdir(), "fleet-status-shims-"));

const scratchHome = join(temp, "home");
const reposRoot = join(temp, "repos");
const workdir = join(temp, "work");

let failures = 0;
let skipped = 0;

class SkipCase extends Error {}

function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP ${label}: ${reason}`);
}

/**
 * Skip from INSIDE a `check()` body, and leave that body for good.
 *
 * `skip()` alone printed `SKIP <label>` and then, because the body returned
 * normally, `check` printed `ok   <label>` for the same case -- counted in both
 * tallies. Carried from story 1.3's fix.
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
    if (error instanceof SkipCase) return;
    failures += 1;
    console.log(`  FAIL ${label}: ${String(error.message).split("\n")[0]}`);
  }
}

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

// ---------------------------------------------------------------------------
// A synthetic fleet: every source this suite reads is built here
// ---------------------------------------------------------------------------

/**
 * Two obviously-fake secrets, so the credential case is real without a real key.
 *
 * The live `~/.hermes/fleet.env` carries `PLANE_33GOD_API_KEY` and
 * `PLANE_AUTOMATICAI_API_KEY`. The scratch file keeps the KEY NAMES -- which is
 * what the allowlists have to exclude -- and replaces the values, because
 * writing a real credential into a file is what this repo forbids everywhere
 * else and a sentinel proves the same property.
 */
const SECRET_SENTINEL = "pjan14-not-a-real-credential-0000";
const CREDENTIAL_KEYS = ["PLANE_33GOD_API_KEY", "PLANE_AUTOMATICAI_API_KEY", "PJAN14_UNLISTED_SENTINEL"];

const GIT_IDENTITY = ["-c", "user.email=suite@invalid", "-c", "user.name=Suite", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

function git(cwd, args) {
  return spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
}

/**
 * The tracked template at the COMMITTED gitlink, read once through git objects.
 *
 * Story 1.6's scaffold observer compares every managed role directory against
 * this tree, so a synthetic role that carries only `role.yaml` now reads as 51
 * missing assets -- and the story's rule is to fix the FIXTURE, never to weaken
 * the observer. The bytes are read with `git show <gitlink>:<path>` as buffers,
 * never from the submodule worktree, for the same reason the observer does.
 */
const PINNED_TEMPLATE = (() => {
  const submodule = join(ROOT, "templates", "hermes-agent");
  const staged = git(ROOT, ["ls-tree", "HEAD", "--", "templates/hermes-agent"]).stdout;
  const gitlink = /([0-9a-f]{40})/u.exec(staged)?.[1];
  if (!gitlink) return null;
  const listed = spawnSync("git", ["ls-tree", "-r", "-z", gitlink, "--", "template"], {
    cwd: submodule, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  if (listed.status !== 0) return null;
  const files = [];
  for (const entry of listed.stdout.split("\u0000").filter(Boolean)) {
    const match = /^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/su.exec(entry);
    if (!match) continue;
    const [, mode, , path] = match;
    const bytes = spawnSync("git", ["show", `${gitlink}:${path}`], { cwd: submodule, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }).stdout;
    files.push({ mode, path: path.slice("template/".length), bytes });
  }
  return { gitlink, files };
})();

/**
 * Render the pinned template into a role directory: the five simple
 * substitutions the manifest declares, `.jinja` stripped, presence-only files
 * written as-is, modes from the tree. Written as the fanout would write it, so
 * the observer reads a clean scaffold and every 1.4/1.5 case keeps the
 * `template_scaffold` state it was written against.
 */
function renderPinnedRole(roleDir, inputs) {
  assert.ok(PINNED_TEMPLATE, "the tracked template must be readable at its committed gitlink for the fixture to be scaffold-clean");
  const presenceOnly = new Set(["role.yaml", "SOUL.md"]);
  for (const file of PINNED_TEMPLATE.files) {
    const rendered = file.path.endsWith(".jinja");
    const target = rendered ? file.path.slice(0, -".jinja".length) : file.path;
    let bytes = file.bytes;
    if (rendered && !presenceOnly.has(target)) {
      const text = bytes.toString("utf8").replace(/\{\{\s*([a-z_]+)\s*\}\}/gu, (whole, name) => (name in inputs ? inputs[name] : whole));
      bytes = Buffer.from(text, "utf8");
    }
    const full = join(roleDir, ...target.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, bytes);
    chmodSync(full, file.mode === "100755" ? 0o755 : 0o644);
  }
}

/** A real repository with one commit, a role scaffold rendered from the pinned template, and a `.project.json`. */
function makeRepo(slug) {
  const dir = join(reposRoot, slug);
  mkdirSync(join(dir, "agents", "hermes", "pm"), { recursive: true });
  renderPinnedRole(join(dir, "agents", "hermes", "pm"), {
    agent_id: `${slug}-pm`, role: "pm", target_repo: slug, display_name: `${slug} PM`, ticket_provider: "plane",
  });
  // The reconcile block is EXPLICIT (story 1.8): `enabled: false` without
  // `explicit_opt_out` is a `reconcile-opt-out-undeclared` warn, and no block
  // at all is `reconcile-undeclared` -- both true readings, and both about the
  // fixture rather than about what any case here tests.
  writeFileSync(join(dir, "agents", "hermes", "pm", "role.yaml"), YAML.stringify({
    role: "pm",
    reconcile: { enabled: false, explicit_opt_out: true },
  }), "utf8");
  writeFileSync(join(dir, ".project.json"), `${JSON.stringify({
    project_slug: slug,
    ticket_provider: { type: "plane", workspace: "suite", identifier: slug.toUpperCase(), board_id: `board-${slug}` },
  }, null, 2)}\n`, "utf8");
  assert.equal(git(dir, ["init", "--quiet"]).status, 0, `git init failed in ${dir}`);
  writeFileSync(join(dir, "README.md"), `# ${slug}\n`, "utf8");
  assert.equal(git(dir, ["add", "-A"]).status, 0);
  assert.equal(git(dir, ["commit", "--quiet", "-m", "seed"]).status, 0);
  return dir;
}

/**
 * A repository whose audit report exceeds the 64 KiB pipe buffer, built once.
 *
 * `hermes.untracked-runtimes` reports one detail line per role directory, so 400
 * long-named roles produce a ~3.7 MB report -- the payload the truncation defect
 * and the closed-pipe defect both need to be reachable.
 */
function auditScaleRepo() {
  const dir = join(temp, "audit-scale");
  if (existsSync(dir)) return dir;
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 400; index += 1) {
    const role = join(dir, "agents", "hermes", `role-with-a-fairly-long-name-number-${index}`);
    mkdirSync(role, { recursive: true });
    writeFileSync(join(role, "role.yaml"), "role: pm\n", "utf8");
  }
  assert.equal(git(dir, ["init", "--quiet"]).status, 0);
  return dir;
}

function agentRow(slug) {
  return {
    repo: slug,
    role: "pm",
    display_name: `${slug} PM`,
    project_path: join(reposRoot, slug),
    role_dir: join(reposRoot, slug, "agents", "hermes", "pm"),
    profile_name: `${slug}-pm`,
    provisioned_at: "2026-01-01T00:00:00.000Z",
    plane: { workspace: "suite", project_id: `board-${slug}`, identifier: slug.toUpperCase() },
    bloodbank: { enabled: false, gateway_scope: "fleet", target_agent_id: `${slug}-pm` },
    systemd: {
      gateway_unit: `hermes-${slug}-pm-gateway.service`,
      heartbeat_timer: `hermes-${slug}-pm-heartbeat.timer`,
    },
    // The canonical DEFERRED declaration (story 1.8): the shape most of the
    // live fleet has, and the one that is healthy without a channel credential.
    // Without it every fixture row would read `channel-undeclared` -- true, but
    // a reading about the fixture rather than about what each case tests.
    telegram: { provisioning_status: "disabled" },
    slack: { provisioning_status: "disabled" },
    hermes: {
      bin: join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc", "bin", "hermes"),
      repo: join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc"),
      fleet_env: join(scratchHome, ".hermes", "fleet.env"),
      git_url: "https://github.com/delorenj/hermes-agent.git",
      git_ref: "main",
      git_sha: "0".repeat(40),
    },
  };
}

/** A registry YAML file in `temp`, built from a list of agent slugs. */
// The fleet-shared Bloodbank gateway block the live registry carries. Story 1.8
// correlates `gateways.bloodbank.systemd_unit` against the contract's
// `service_model.fleet_shared.bloodbank_gateway_unit`, and a registry that
// names no unit is `registry-undeclared` -- a true reading, and one about the
// fixture rather than about what any case here tests.
const GATEWAYS_BLOCK = {
  bloodbank: {
    scope: "fleet",
    profile_name: "fleet-bloodbank-gateway",
    command_subject: "bloodbank.cmd.agent.invocation.start",
    target_field: "data.target_agent_id",
    systemd_unit: "hermes-fleet-bloodbank-gateway.service",
  },
};

function writeAgentRegistry(path, slugs) {
  const agents = {};
  for (const slug of slugs) agents[`${slug}-pm`] = agentRow(slug);
  writeFileSync(path, YAML.stringify({ schema_version: 1, gateways: GATEWAYS_BLOCK, agents }), "utf8");
  return path;
}

function writeProjectRegistry(path, slugs) {
  const projects = {};
  for (const slug of slugs) {
    projects[slug] = {
      name: slug,
      slug,
      repo_path: join(reposRoot, slug),
      status: "active",
      ticket_provider: {
        type: "plane", workspace: "suite",
        identifier: slug.toUpperCase(), board_id: `board-${slug}`,
      },
    };
  }
  writeFileSync(path, YAML.stringify({ schema_version: 1, projects }), "utf8");
  return path;
}

/**
 * A registry YAML with an extra raw entry appended verbatim.
 *
 * Used by the cap cases: `zzzz-broken: not-a-mapping` is a MALFORMED row, which
 * makes its `registry` domain `fail`, and its id sorts last so the agent cap
 * drops its record. That is the exact shape the fleet-level counts used to lose.
 */
function writeAgentRegistryWith(path, slugs, extra) {
  const agents = {};
  for (const slug of slugs) agents[`${slug}-pm`] = agentRow(slug);
  writeFileSync(path, `${YAML.stringify({ schema_version: 1, gateways: GATEWAYS_BLOCK, agents })}\n${extra}\n`, "utf8");
  return path;
}


// ---------------------------------------------------------------------------
// Renderer-clean profiles (story 1.7 / PJAN-109)
//
// The profile observer now gates every registered profile and proves it through
// the canonical renderer's own check, so a fixture profile that carried only a
// marker file reads as an identity miss, a delta miss, a pin miss and a missing
// skill core. The FIXTURE is made clean, never the observer weakened: a fleet
// base, six canonical skills, and per profile the identity file, an empty
// delta, a generated config equal to the base, the bank pin, the skill links,
// and the renderer's zero-byte lock PRE-CREATED so a check writes nothing.
// ---------------------------------------------------------------------------
const PROFILE_CORE_SKILLS = ["33god-projects", "delonet-conventions", "delonet-dotenv", "hermes-pm-template-maintenance", "hindsight", "subagent-driven-development"];

function profileBase(home) {
  return { model: { default: "fleet-model" }, skills: { external_dirs: [join(home, ".agents", "skills")] }, memory: { provider: "hindsight" } };
}

function seedProfileFixtures(home) {
  mkdirSync(join(home, ".hermes", "profiles"), { recursive: true });
  writeFileSync(join(home, ".hermes", "config.yaml"), YAML.stringify(profileBase(home)), "utf8");
  for (const skill of PROFILE_CORE_SKILLS) {
    mkdirSync(join(home, ".agents", "skills", skill), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", skill, "SKILL.md"), `# ${skill}\n`, "utf8");
  }
}

// A deferred platform must be PINNED disabled in the delta, or it inherits the
// fleet base's enablement and the gateway would start without a credential.
// `70-systemd.sh`'s own deferral path writes exactly this (channel-transaction.py).
const DEFERRED_PLATFORMS = { platforms: { telegram: { enabled: false }, slack: { enabled: false } } };

function seedRendererCleanProfile(home, name) {
  const dir = join(home, ".hermes", "profiles", name);
  mkdirSync(join(dir, "hindsight"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "profile.yaml"), `name: ${name}\n`, "utf8");
  writeFileSync(join(dir, "config.delta.yaml"), YAML.stringify(DEFERRED_PLATFORMS), "utf8");
  writeFileSync(join(dir, "config.yaml"), `# GENERATED FILE -- DO NOT EDIT\n${YAML.stringify({ ...profileBase(home), ...DEFERRED_PLATFORMS })}`, "utf8");
  writeFileSync(join(dir, "hindsight", "config.json"), `{\n  "bank_id": "agent-${name}"\n}\n`, "utf8");
  for (const skill of PROFILE_CORE_SKILLS) symlinkSync(join(home, ".agents", "skills", skill), join(dir, "skills", skill));
  writeFileSync(join(home, ".hermes", "profiles", `.${name}.config.lock`), "");
  return dir;
}

const BASE_SLUGS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

function seedScratch() {
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(scratchHome, ".hermes", "profiles"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "hermes-agent-template"), { recursive: true });
  const release = join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc", "bin");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "hermes"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(release, "hermes"), 0o755);

  for (const slug of BASE_SLUGS) makeRepo(slug);

  // One real profile directory per agent, and ONE of them a symlink -- the
  // contract declares `service_model.profile_layout.symlink_allowed: false`, so
  // that agent's `profile` domain must report `fail` from the store read alone,
  // with no audit and no `--live`.
  seedProfileFixtures(scratchHome);
  for (const slug of BASE_SLUGS) {
    if (slug === "beta") continue;
    seedRendererCleanProfile(scratchHome, `${slug}-pm`);
  }
  mkdirSync(join(scratchHome, ".hermes", "profiles", "shared"), { recursive: true });
  // The delta is pinned even here: `beta-pm`'s PROFILE domain is the failure
  // this fixture exists to produce, and letting its gateway also read
  // `platform-enablement-inherited` would make a systemd assertion depend on a
  // profile-topology defect.
  writeFileSync(join(scratchHome, ".hermes", "profiles", "shared", "config.delta.yaml"), YAML.stringify(DEFERRED_PLATFORMS), "utf8");
  symlinkSync(join(scratchHome, ".hermes", "profiles", "shared"), join(scratchHome, ".hermes", "profiles", "beta-pm"));

  writeAgentRegistry(join(scratchHome, ".hermes", "agents-registry.yaml"), BASE_SLUGS);
  writeProjectRegistry(join(scratchHome, ".config", "pjangler", "projects.yaml"), BASE_SLUGS);

  installFakeSystemctl(systemctlShim, canonicalSystemdState());

  writeFileSync(join(scratchHome, ".config", "hermes-agent-template", "config.toml"), [
    "[fleet]",
    `hermes_bin = "${join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc", "bin", "hermes")}"`,
    `hermes_repo = "${join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc")}"`,
    'hermes_git_url = "https://github.com/delorenj/hermes-agent.git"',
    'hermes_git_ref = "main"',
    `hermes_git_sha = "${"0".repeat(40)}"`,
    "",
  ].join("\n"), "utf8");

  // Every credential key by NAME with a sentinel value, so the exclusion cases
  // are non-vacuous without a real secret ever touching disk.
  writeFileSync(join(scratchHome, ".hermes", "fleet.env"), [
    `HERMES_FLEET_HOME=${join(scratchHome, ".hermes")}`,
    `HERMES_FLEET_BIN=${join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc", "bin", "hermes")}`,
    `HERMES_FLEET_REPO=${join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc")}`,
    "HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/agents-registry.yaml",
    ...CREDENTIAL_KEYS.map((key) => `${key}=${SECRET_SENTINEL}`),
    "",
  ].join("\n"), "utf8");
}

/**
 * The scripted user manager every case in this suite observes.
 *
 * One canonical DEFERRED triple per fixture agent plus the fleet-shared
 * Bloodbank gateway: the shape `70-systemd.sh` provisions and the shape most of
 * the live fleet actually has. It lives outside `temp`, so the fake's own
 * invocation log never appears in a zero-write snapshot of the isolated roots.
 */
const systemctlShim = join(shimRoot, "systemctl-bin");
function canonicalSystemdState() {
  const profileRoot = join(scratchHome, ".hermes", "profiles");
  const hermesBin = join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc", "bin", "hermes");
  return mergeUnitSets(
    { manager: { stdout: "running", exit: 0 } },
    ...BASE_SLUGS.map((slug) => deferredAgentUnits({
      agentId: `${slug}-pm`,
      profileName: `${slug}-pm`,
      profileRoot,
      roleDir: join(reposRoot, slug, "agents", "hermes", "pm"),
      hermesBin,
    })),
    sharedGatewayUnits({ profileRoot, hermesBin }),
  );
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
  // Story 1.8: `systemd` is an OBSERVED domain in every scope now, so this
  // suite has to seed the fixture fleet's service state exactly as story 1.7
  // made every fixture profile renderer-clean. `systemctl` resolves to the
  // scripted manager below; the bus address and runtime dir point at nothing,
  // so a case that bypasses the shim reads `manager-unavailable` rather than
  // this developer's own user manager -- where a fixture agent's units do not
  // exist and never will.
  PATH: `${systemctlShim}:${process.env.PATH}`,
  ...noBusIsolation(temp),
  // The credential the audit child must never receive, present in the PARENT's
  // environment so the allowlist has something to exclude.
  PLANE_33GOD_API_KEY: SECRET_SENTINEL,
};

// ---------------------------------------------------------------------------
// Zero-write proof
// ---------------------------------------------------------------------------

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

// The PROBED-REPOSITORY index check that used to live here is not gone, it
// moved: every scratch repository is under `temp`, and `snapshotTree` digests
// each file's bytes -- `.git/index` included -- around EVERY invocation. So the
// defect the old helper existed for (a probe missing `--no-optional-locks`,
// which refreshes an index in place and shows up in no diff) is still caught per
// call, at full byte fidelity, on the repositories this suite controls. What it
// also did, and could not do honestly, was fingerprint THIS repository's index
// bytes: see `snapshotShared`.

/**
 * The surfaces a difference is ATTRIBUTABLE to the command under test.
 *
 * This suite's own isolated scratch tree, and the tracked contract. Nothing else
 * on the machine writes either, so a change here is the command's and an
 * assertion about it can be trusted.
 */
function snapshotIsolated() {
  const entries = {};
  snapshotTree("temp", temp, entries);
  snapshotTree("contracts", join(ROOT, "contracts"), entries);
  return entries;
}

/** Other suites' scratch directories in this repo root. Provably not this command's output. */
const FOREIGN_SCRATCH = /^\.(pjan|fleet|notebook|momo|project)-/u;

/**
 * The surfaces that are REAL to check and NOT attributable to one invocation.
 *
 * This repository's own `.git/index` and its top-level direntries. Worth
 * checking -- a command that writes the repo it runs in rather than the isolated
 * HOME is exactly the defect -- but this machine runs parallel agents by design,
 * so any of them can move both between two readings. Measured during one run of
 * this suite: `.pjan-67-trusted-lifecycle-FmLEQj` and
 * `.pjan-67-trusted-lifecycle-R2bRQf` appeared in this root while a case was
 * mid-invocation, created by a different process. Asserted ONCE for the whole
 * suite instead of around all ~50 invocations, so one external write produces one
 * honestly-worded failure rather than a random case going red.
 */
function snapshotShared() {
  const entries = {};
  // The index's CONTENT, not its bytes. `.git/index` carries stat data beside
  // the tracked entries, so a build that rewrites tracked `dist/*` and any later
  // reader that reconciles it both change the file while changing nothing about
  // what is tracked or staged. `ls-files --stage` is mode, object id, stage and
  // path -- exactly "was this repository modified" -- so a real `git add` still
  // moves it and stat churn does not.
  for (const repo of [ROOT, join(ROOT, "templates", "hermes-agent")]) {
    if (!existsSync(join(repo, ".git"))) { entries[`staged:${repo}`] = "absent"; continue; }
    const listed = git(repo, ["--no-optional-locks", "ls-files", "--stage"]);
    entries[`staged:${repo}`] = listed.status === 0
      ? createHash("sha256").update(listed.stdout).digest("hex")
      : `unreadable:${listed.status}`;
  }
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (FOREIGN_SCRATCH.test(entry.name)) continue;
    entries[`root:${entry.name}`] = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
  }
  return entries;
}

/**
 * Run the built CLI and prove the run wrote nothing to a protected root.
 *
 * `maxBuffer` is set explicitly: the default would itself truncate a large
 * capture, and a truncation introduced by the harness looks exactly like the
 * truncation defect the harness is here to detect.
 */
function cli(args, extraEnv = {}, cwd = workdir) {
  const before = snapshotIsolated();
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...isolation, ...extraEnv },
  });
  const after = snapshotIsolated();
  // NAME THE PATHS, do not just assert inequality: `check()` prints the first
  // line of a failure, so a bare "wrote to a protected root" told an operator
  // nothing about WHICH root.
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => before[key] !== after[key]);
    for (const key of changed) console.log(`       ${key}: ${before[key] ?? "<missing>"} -> ${after[key] ?? "<missing>"}`);
    assert.fail(`pj ${args.join(" ")} wrote to a protected root: ${changed.join(", ")}`);
  }
  return result;
}

function envelope(result) {
  assert.notEqual(result.stdout, "", "stdout was empty; a passing assertion on empty output proves nothing");
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

/** A successful status envelope with its invariants already checked. */
function status(result) {
  const parsed = envelope(result);
  assert.equal(parsed.ok, true, `expected ok:true, got ${JSON.stringify(parsed.error)}`);
  assert.equal(parsed.error, null, "ok envelopes carry no error");
  assert.equal(parsed.command, "fleet.status");
  for (const key of DATA_KEYS) assert.notEqual(parsed.data[key], undefined, `data.${key} must be present`);
  // Checked on EVERY envelope this suite parses, not in one case: `field` and
  // `source` were the two halves of a finding nobody had ever asserted, so all
  // four call sites shipped `source: null` (the human report printed "owner
  // undeclared" for every one) and a `field` of the literal source id
  // "recipe-audit", which also made the findings sort by `field` a no-op.
  for (const finding of parsed.data.findings) {
    // A dotted contract path, not a source id. Checked by SHAPE rather than by
    // "contains no hyphen": story 1.8 made `units.hermes-{agent_id}-gateway.service`
    // a declared leaf, so hyphens no longer separate a path from an id. What
    // still separates them is the ROOT: a contract path's first segment is a
    // plain identifier followed by a dot or nothing at all (`scaffold`,
    // `units.…`, `agents.…`), while every source id this guard exists to catch
    // (`recipe-audit`, `fleet-systemd`) is hyphenated at its root.
    assert.match(finding.field, /^[a-z_]+(?:\.|$)/u, `a finding's field must be a contract path, not a source id: ${finding.field}`);
    if (!/^(audit-|registry-declares-no-agents)/u.test(finding.code)) continue;
    assert.ok(
      typeof finding.source === "string" && finding.source.length > 0,
      `finding ${finding.code} must name the authority that owns its field`,
    );
  }
  return parsed.data;
}

function agentNamed(data, id) {
  const found = data.agents.find((agent) => agent.agent_id === id);
  assert.ok(found, `agent ${id} must be in data.agents`);
  return found;
}

// ---------------------------------------------------------------------------
// Injected CLI entries: the documented PJ_FLEET_CLI_ENTRY observation seam
// ---------------------------------------------------------------------------

/**
 * Write one injected entry and return its path.
 *
 * Entries live outside `temp` and record what they saw BESIDE THEMSELVES, so a
 * shim's own bookkeeping can never be mistaken for the command under test
 * writing to a protected root. Each behaviour gets its own FILE rather than
 * reading a mode out of the environment: the audit child's environment is
 * allowlisted by construction (that is the credential guarantee), so an
 * `PJ_SHIM_MODE` would be stripped before the shim could read it -- measured.
 */
function entry(name, body) {
  const dir = join(shimRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "entry.mjs");
  writeFileSync(path, body, "utf8");
  return path;
}

const RECORD_PREAMBLE = `
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.argv[3] ?? "";
appendFileSync(join(HERE, "invocations"), REPO + "\\n");
writeFileSync(join(HERE, "child-env.json"), JSON.stringify(Object.keys(process.env).sort()));
`;

function invocationsOf(entryPath) {
  const file = join(dirname_(entryPath), "invocations");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function childEnvKeys(entryPath) {
  const file = join(dirname_(entryPath), "child-env.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function resetEntry(entryPath) {
  for (const name of ["invocations", "child-env.json", "pids"]) {
    rmSync(join(dirname_(entryPath), name), { force: true });
  }
}

function dirname_(path) {
  return path.slice(0, path.lastIndexOf("/"));
}

/** An audit report this suite controls end to end, so scope and status are exact. */
function syntheticReport(rules) {
  return `${RECORD_PREAMBLE}
const rules = ${JSON.stringify(rules)};
const report = {
  repo: REPO,
  ok: rules.every((rule) => !(rule.status === "fail" && rule.scope !== "host")),
  hostOk: rules.every((rule) => rule.scope !== "host" || rule.status === "pass" || rule.status === "skip"),
  // A TIMESTAMP, deliberately. The status core has to drop it at the boundary or
  // two runs over unchanged state stop being byte-identical.
  auditedAt: new Date().toISOString(),
  rules,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
process.exit(report.ok ? 0 : 1);
`;
}

const HOST_FAIL_RULE = {
  id: "hermes.profile-wiring", title: "Hermes profile wiring", status: "fail",
  summary: "the shared profile root is wired to the wrong home", details: ["~/.hermes/profiles is not the configured root"],
  fixable: false, scope: "host",
};
const PROJECT_WARN_RULE = {
  id: "hermes.pm-scaffold", title: "Hermes orchestrator scaffold parity", status: "warn",
  summary: "3 orchestrator scaffold issue(s) detected", details: ["stale agents/hermes/pm/hermes"],
  fixable: true, scope: "project",
};
const PROJECT_PASS_RULE = {
  id: "hermes.runtime-singleton", title: "Singleton runtime contract", status: "pass",
  summary: "Singleton runtime contract satisfied", details: [], fixable: true, scope: "project",
};
const UNMAPPED_RULE = {
  id: "totally.invented-rule", title: "A rule no domain table has heard of", status: "fail",
  summary: "an unmapped rule must not disappear", details: [], fixable: false, scope: "project",
};

console.log("fleet status: nine domains, one traversal, one parse-safe document");

try {
  if (!existsSync(CLI)) {
    // The ONLY unconditional skip in this suite, and it is about this checkout
    // rather than about the host: with no build there is nothing to exercise.
    skip("the whole suite", "dist/index.js is not built; run `npm run build` first");
    throw new SkipCase("unbuilt");
  }
  seedScratch();

  // RECONCILE THIS REPO'S INDEX BEFORE ANY CASE SNAPSHOTS IT.
  //
  // The zero-write proof fingerprints this repository's own `.git/index`, and
  // `dist/` is TRACKED here -- so `npm run build`, the command the acceptance
  // criteria pair with `npm test`, leaves that index stat-dirty. The first
  // process to read it afterwards reconciles the stat data and writes it back,
  // and the proof then reported that as the command under test writing to a
  // protected root. It looked like flake: red on four different cases across one
  // session, green three runs in a row in between, because a full `npm test` has
  // 50 suites ahead of this one and whichever of them touches git first absorbs
  // the reconcile.
  //
  // MEASURED, and the CLI is NOT the writer. Every git probe passes
  // `--no-optional-locks` (verified by logging all 13 invocations of a run
  // through a PATH shim), and with the index already reconciled a plain run and
  // a `--live` run both leave it BYTE-IDENTICAL -- three build/run cycles,
  // stable each time. `ls-files --stage` and `status --porcelain` do not
  // reconcile it, which is exactly what `--no-optional-locks` buys; only an
  // explicit refresh does.
  //
  // So the test does it, once, deliberately, before it starts measuring. The
  // proof is unweakened: every case still asserts the command changed nothing.
  git(ROOT, ["update-index", "--refresh"]);
  const sharedAtStart = snapshotShared();

  // -- AC1: every agent, every domain, one complete envelope -----------------

  check("--json is one complete envelope carrying every declared data key", () => {
    const result = cli(["review", "--json"]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const data = status(result);
    assert.equal(data.scope.kind, "fleet");
    assert.equal(data.agents.length, BASE_SLUGS.length);
    // Bigger than the 64 KiB pipe buffer, through a real OS pipe. Below that the
    // truncation defect cannot fire and a green assertion proves nothing.
    assert.ok(result.stdout.length > 65_536, `payload is only ${result.stdout.length} bytes; the defect cannot reach it`);
  });

  check("every registered agent appears exactly once and carries all nine domains", () => {
    const data = status(cli(["review", "--json"]));
    const ids = data.agents.map((agent) => agent.agent_id);
    assert.deepEqual([...ids].sort(), BASE_SLUGS.map((slug) => `${slug}-pm`).sort());
    assert.equal(new Set(ids).size, ids.length, "an agent id must appear exactly once");
    for (const agent of data.agents) {
      assert.deepEqual(Object.keys(agent.domains).sort(), [...DOMAINS].sort(), `${agent.agent_id} must carry all nine domains`);
      const observed = new Set(agent.observations.map((observation) => observation.domain));
      for (const domain of DOMAINS) {
        assert.ok(observed.has(domain), `${agent.agent_id} has no observation for ${domain}`);
      }
    }
    assert.deepEqual(data.domains.map((rollup) => rollup.domain), DOMAINS, "data.domains must carry all nine, in order");
    const inventory = JSON.parse(cli(["roster", "--json"]).stdout).data;
    assert.equal(data.scope.total_registered_agents, inventory.totals.registered_agents);
    assert.equal(data.totals.agents, inventory.totals.registered_agents);
  });

  check("every observation names a domain, a state, a source, an id, and the command that returns it", () => {
    const data = status(cli(["review", "--json"]));
    const seenIds = new Map();
    for (const agent of data.agents) {
      for (const observation of agent.observations) {
        assert.ok(DOMAINS.includes(observation.domain), `unknown domain ${observation.domain}`);
        assert.ok(["pass", "warn", "skip", "fail", "unsupported", "unobserved", "error"].includes(observation.state), `unknown state ${observation.state}`);
        assert.equal(observation.agent_id, agent.agent_id);
        assert.ok(typeof observation.source === "string" && observation.source.length > 0);
        assert.match(observation.finding_id, /^[0-9a-f]{12}$/u, "finding_id must be a sha256 prefix");
        assert.match(observation.retrieval, /^flume review /u, "every observation must name the command that returns it");
        assert.ok(Array.isArray(observation.details));
        // A stable id must be UNIQUE per observation, or a consumer joining on
        // it silently merges two different findings into one.
        const key = observation.finding_id;
        assert.ok(!seenIds.has(key), `finding_id ${key} is shared by ${seenIds.get(key)} and ${observation.field}`);
        seenIds.set(key, `${agent.agent_id}/${observation.domain}/${observation.field}`);
      }
    }
  });

  // -- AC2: no --live means no audit child, no network, and it says so --------

  check("without --live no audit child runs and every audit-fed domain says why", () => {
    const shim = entry("never-called", syntheticReport([PROJECT_PASS_RULE]));
    resetEntry(shim);
    const data = status(cli(["review", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    assert.deepEqual(invocationsOf(shim), [], "a default run must spawn no audit child at all");
    assert.equal(data.totals.audits_attempted, 0);
    for (const agent of data.agents) {
      for (const domain of AUDIT_FED) {
        assert.equal(agent.domains[domain], "unobserved", `${agent.agent_id}.${domain} must be unobserved without --live`);
      }
      const reasons = agent.observations.filter((observation) => observation.source === "recipe-audit");
      assert.ok(reasons.length >= AUDIT_FED.length, "each audit-fed domain must carry its own reason");
      for (const reason of reasons) assert.match(reason.summary, /--live/u, "the reason must name --live");
    }
    assert.equal(data.health.complete, false, "a run that did not read the audit half is not complete");
  });

  check("a default run makes no network call and executes nothing off PATH", () => {
    // A real sentinel, not an argument: any of these being invoked leaves a file
    // behind, and its absence is the assertion.
    const bin = join(shimRoot, "no-network-bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["npm", "curl", "wget"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\ntouch ${JSON.stringify(join(bin, `called-${name}`))}\nexit 0\n`, "utf8");
      chmodSync(join(bin, name), 0o755);
      rmSync(join(bin, `called-${name}`), { force: true });
    }
    const result = cli(["review", "--json"], { PATH: `${bin}:${systemctlShim}:${process.env.PATH}` });
    assert.equal(result.status, 0);
    for (const name of ["npm", "curl", "wget"]) {
      assert.equal(existsSync(join(bin, `called-${name}`)), false, `a default run invoked ${name}`);
    }
  });

  // -- AC3 / AC4: host is not project ----------------------------------------

  check("a host-scoped fail is reported once, keeps its scope, and fails no agent", () => {
    const shim = entry("host-fail", syntheticReport([HOST_FAIL_RULE, PROJECT_PASS_RULE]));
    resetEntry(shim);
    const result = cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim });
    assert.equal(result.status, 0, "an unhealthy machine is data, not a command failure");
    const data = status(result);
    assert.equal(invocationsOf(shim).length, BASE_SLUGS.length, "one audit child per repository");
    const host = data.host.filter((finding) => finding.rule_id === HOST_FAIL_RULE.id);
    assert.equal(host.length, 1, `the host finding must be deduped to one, got ${data.host.length} entries`);
    assert.equal(host[0].state, "fail");
    assert.equal(host[0].domain, "profile");
    assert.match(host[0].retrieval, /--live/u);
    for (const agent of data.agents) {
      const promoted = agent.observations.filter((observation) => observation.rule_id === HOST_FAIL_RULE.id);
      assert.deepEqual(promoted, [], `${agent.agent_id} must not carry a host-scoped rule result`);
      assert.equal(agent.observations.some((observation) => observation.rule_scope === "host"), false);
    }
    // The host fail must not reach `healthy`. `beta-pm`'s symlinked profile is a
    // genuine project failure, so the fleet verdict is false for a reason that
    // is NOT the host finding -- assert on the agents that have no other fail.
    const clean = data.agents.filter((agent) => agent.agent_id !== "beta-pm");
    for (const agent of clean) {
      assert.equal(agent.healthy, true, `${agent.agent_id} must stay healthy despite a host-scoped fail`);
    }
  });

  check("a project-scoped warn rolls its domain up to warn and keeps the agent healthy", () => {
    const shim = entry("project-warn", syntheticReport([PROJECT_WARN_RULE, PROJECT_PASS_RULE]));
    resetEntry(shim);
    const data = status(cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    const agent = agentNamed(data, "alpha-pm");
    assert.equal(agent.domains.template_scaffold, "warn", "a warn must roll the domain up to warn, not be masked");
    assert.equal(agent.healthy, true, "a warn never gates healthy -- matching gatesProject in src/recipes/types.ts");
    const observation = agent.observations.find((item) => item.rule_id === PROJECT_WARN_RULE.id);
    assert.ok(observation, "the warn must be emitted as its own observation");
    assert.equal(observation.rule_scope, "project");
    assert.equal(observation.state, "warn");
    assert.equal(observation.summary, PROJECT_WARN_RULE.summary);
    assert.deepEqual(observation.details, PROJECT_WARN_RULE.details);
    assert.ok(typeof observation.owner === "string" && observation.owner.length > 0, "the owner must be resolved from the rule id");
  });

  check("a rule no domain table has heard of is reported, not dropped", () => {
    const shim = entry("unmapped", syntheticReport([UNMAPPED_RULE]));
    resetEntry(shim);
    const data = status(cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    const agent = agentNamed(data, "alpha-pm");
    const observation = agent.observations.find((item) => item.rule_id === UNMAPPED_RULE.id);
    assert.ok(observation, "an unmapped rule must still reach the report");
    assert.equal(observation.state, "fail");
    const finding = data.findings.find((item) => item.code === "audit-rule-unmapped");
    assert.ok(finding, "an unmapped rule must raise a finding so it cannot silently vanish");
    assert.match(finding.detail, /totally\.invented-rule/u);
    // ONE finding, not one per agent: eight repositories reported the same rule.
    assert.equal(data.findings.filter((item) => item.code === "audit-rule-unmapped").length, 1);
  });

  check("the audit child's timestamp never reaches data", () => {
    const shim = entry("timestamped", syntheticReport([PROJECT_PASS_RULE]));
    resetEntry(shim);
    const result = cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim });
    status(result);
    // The shim stamps a real `new Date().toISOString()` into every report. If it
    // survived, two runs would differ and the CLI/MCP parity check would become
    // a resemblance.
    assert.doesNotMatch(result.stdout, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u, "no ISO timestamp may enter the envelope");
    assert.doesNotMatch(result.stdout, /"auditedAt"/u, "auditedAt must be dropped at the boundary");
  });

  // -- AC5 / AC6: filters constrain COLLECTION, not just emission -------------

  check("--agent reports one agent, keeps totals fleet-wide, and probes nobody else", () => {
    const shim = entry("scoped", syntheticReport([PROJECT_PASS_RULE]));
    resetEntry(shim);
    const data = status(cli(["review", "--agent", "alpha-pm", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    assert.equal(data.agents.length, 1);
    assert.equal(data.agents[0].agent_id, "alpha-pm");
    assert.equal(data.scope.selected_agents, 1);
    assert.equal(data.scope.total_registered_agents, BASE_SLUGS.length);
    assert.match(data.scope.label, /scoped to agent alpha-pm/u, "the label must say the result is scoped");
    assert.equal(data.health.fleet_complete, false, "a scoped answer can never be fleet-complete");
    assert.deepEqual(invocationsOf(shim), [join(reposRoot, "alpha")], "no audit child may run for another agent");
    const probed = data.probes.filter((probe) => probe.kind === "checkout").map((probe) => probe.target);
    for (const slug of BASE_SLUGS) {
      if (slug === "alpha") continue;
      assert.equal(probed.some((target) => target.includes(`/${slug}`)), false, `a checkout probe ran for ${slug}`);
    }
  });

  check("--domain systemd emits one domain, observed off the manager, with no audit child", () => {
    const shim = entry("domain-systemd", syntheticReport([PROJECT_PASS_RULE]));
    resetEntry(shim);
    resetFakeSystemctl(systemctlShim);
    const result = cli(["review", "--domain", "systemd", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim });
    assert.equal(result.status, 0);
    const data = status(result);
    assert.deepEqual(data.domains.map((rollup) => rollup.domain), ["systemd"]);
    // OBSERVED now (story 1.8), not `unsupported`: the observer samples the
    // user manager itself, in every scope, without `--live` conjuring it.
    assert.equal(data.domains[0].state, "pass", `the scripted fleet is canonical, got ${JSON.stringify(data.domains[0].counts)}`);
    assert.deepEqual(invocationsOf(shim), [], "zero audit children: every systemd RULE is host-scoped");
    for (const agent of data.agents) {
      assert.deepEqual(Object.keys(agent.domains), ["systemd"], "the other eight must not be implied");
      assert.equal(agent.systemd.capability.declared, "deferred");
      assert.equal(agent.systemd.gateway.state, "pass", `${agent.agent_id}: ${JSON.stringify(agent.systemd.gateway)}`);
      assert.equal(agent.systemd.heartbeat.latest_result, "success");
      assert.equal(agent.systemd.heartbeat.tick, "current");
      assert.equal(agent.systemd.topology.state, "pass");
    }
    // The manager, the two listings, three samples, and nothing else. AC1's
    // bound: `1 + 2 + samples`, plus one classification `show` only when there
    // IS an unregistered unit -- and this scripted manager carries none.
    const verbs = fakeSystemctlVerbs(systemctlShim);
    assert.deepEqual(verbs, ["is-system-running", "list-units", "list-unit-files", "show", "show", "show"], JSON.stringify(verbs));
    const probes = data.probes.filter((probe) => probe.kind === "systemd");
    assert.equal(probes.length, 6, JSON.stringify(probes));
    assert.ok(probes.every((probe) => probe.outcome === "ok"), JSON.stringify(probes));
    // The observer's own three host findings ARE collected in every scope. The
    // two RULES that would corroborate them are host-scoped and their audit
    // child does not run, which is what the gap finding says.
    assert.deepEqual(
      data.host.map((finding) => finding.rule_id).sort(),
      ["systemd.manager", "systemd.shared-gateway", "systemd.unregistered"],
      JSON.stringify(data.host.map((finding) => `${finding.rule_id}=${finding.state}`)),
    );
    assert.ok(data.host.every((finding) => finding.state === "pass"), JSON.stringify(data.host.map((finding) => `${finding.rule_id}=${finding.state}:${finding.summary}`)));
    assert.equal(data.systemd.rule_agreement.compared, 0, "neither rule ran, so nothing was compared");
    const gap = data.findings.find((finding) => finding.code === "audit-host-rules-not-collected");
    assert.ok(gap, `an empty rule half must be explained, got ${JSON.stringify(data.findings.map((f) => f.code))}`);
    assert.match(gap.detail, /systemd\.sentinel/u, "the finding must name the rule it did not collect");
    assert.ok(typeof gap.source === "string" && gap.source.length > 0, "a finding must name the authority that owns its field");
    assert.match(gap.field, /^[a-z]+[.{]/u, "a finding's field must be a dotted contract path, not a source id");
  });

  check("the systemd observer spawns only read verbs, with only the allowlisted environment", () => {
    resetFakeSystemctl(systemctlShim);
    const data = status(cli(["review", "--domain", "systemd", "--json"]));
    assert.equal(data.systemd.manager.code, "available");
    const invocations = fakeSystemctlInvocations(systemctlShim);
    assert.ok(invocations.length > 0, "the observer must have reached the scripted manager");
    for (const argv of invocations) {
      assert.equal(argv[0], "--user", JSON.stringify(argv));
      const verb = argv.filter((token) => !token.startsWith("-"))[0];
      assert.ok(["is-system-running", "list-units", "list-unit-files", "show"].includes(verb), `read-only: ${verb}`);
    }
    for (const mutation of ["daemon-reload", "enable", "disable", "start", "stop", "restart", "reset-failed", "link", "mask", "edit", "kill"]) {
      assert.equal(
        invocations.some((argv) => argv.includes(mutation)), false,
        `the observer must never spawn systemctl ${mutation}`,
      );
    }
    // An ALLOWLIST, not a filter: the parent's Plane key is in `process.env`
    // and must not be in any child's.
    for (const record of fakeSystemctlChildEnvs(systemctlShim)) {
      // `PWD` is the SHIM's own addition -- the fake is reached through a one
      // line `sh` script and every POSIX shell exports `PWD` -- so it is
      // filtered here rather than pretended away: everything else in the
      // child's environment came from the observer's allowlist.
      // `NODE_V8_COVERAGE` is Node's own addition, not the observer's: when the
      // parent runs under coverage Node injects it into EVERY child it spawns,
      // even one given a fully explicit `env`, so that child coverage is
      // collected. The observer cannot suppress it and it carries nothing
      // sensitive. Filtered here for the same reason `PWD` already is —
      // otherwise this case fails under `npm run test:coverage` (which is what
      // CI runs) while passing under `npm test`.
      const keys = Object.keys(record.env).filter((key) => key !== "PWD" && key !== "NODE_V8_COVERAGE").sort();
      assert.deepEqual(
        keys,
        ["DBUS_SESSION_BUS_ADDRESS", "HOME", "LC_ALL", "PATH", "SYSTEMD_COLORS", "SYSTEMD_PAGER", "SYSTEMD_URLIFY", "XDG_RUNTIME_DIR"],
        JSON.stringify(keys),
      );
      assert.equal(record.env.PLANE_33GOD_API_KEY, undefined);
      assert.equal(JSON.stringify(record.env).includes(SECRET_SENTINEL), false, "no credential may reach a systemctl child");
    }
  });

  check("--domain registry --live spawns no audit child and no provenance probe", () => {
    const shim = entry("domain-registry", syntheticReport([PROJECT_PASS_RULE]));
    resetEntry(shim);
    const data = status(cli(["review", "--domain", "registry", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    assert.deepEqual(data.domains.map((rollup) => rollup.domain), ["registry"]);
    assert.deepEqual(invocationsOf(shim), [], "zero audit children");
    assert.deepEqual(data.probes, [], "zero provenance probes");
    assert.equal(data.scope.domain, "registry");
    assert.deepEqual(data.host, [], "no child ran, so nothing may appear in data.host");
    const gap = data.findings.find((finding) => finding.code === "audit-host-rules-not-collected");
    assert.ok(gap, "an empty host block must be explained");
    assert.match(gap.detail, /hermes\.registry-parity/u, "the finding must name the rule it did not collect");
  });

  check("an unknown --agent fails NOT_FOUND before anything spawns", () => {
    const shim = entry("never-for-typo", syntheticReport([PROJECT_PASS_RULE]));
    resetEntry(shim);
    const result = cli(["review", "--agent", "definitely-not-registered", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim });
    assert.equal(result.status, 3, `a typo must exit 3, got ${result.status}`);
    assert.equal(errorCode(envelope(result)), "NOT_FOUND");
    assert.doesNotMatch(result.stderr, /at .*\n\s+at /u, "no stack trace");
    // DW-56: story 1.3 validated --agent only AFTER the whole sweep, which made
    // a typo behind a slow fleet exit 7 instead of 3.
    assert.deepEqual(invocationsOf(shim), [], "the id must be rejected before a single child spawns");
  });

  check("an unknown --domain fails INVALID_INPUT and names the nine", () => {
    const shim = entry("never-for-domain", syntheticReport([PROJECT_PASS_RULE]));
    resetEntry(shim);
    const result = cli(["review", "--domain", "bogus", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim });
    assert.equal(result.status, 2, `a bad domain must exit 2, got ${result.status}`);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    for (const domain of DOMAINS) {
      assert.ok(parsed.error.message.includes(domain), `the message must name ${domain}`);
    }
    assert.deepEqual(invocationsOf(shim), []);
  });

  check("an option-shaped or empty flag value is refused, not consumed", () => {
    for (const args of [
      ["review", "--domain", "--json"],
      ["review", "--agent", ""],
      ["review", "--deadline-ms", "0x10", "--json"],
      ["review", "--deadline-ms", "1e3", "--json"],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 2, `${args.join(" ")} must exit 2, got ${result.status}`);
    }
  });

  // -- AC7 / AC8: a broken child is a categorized error, never a pass ---------

  check("a child that prints non-JSON errors ONE agent and leaves the rest byte-identical", () => {
    const clean = entry("selective-clean", syntheticReport([PROJECT_PASS_RULE]));
    const garbage = entry("selective-garbage", `${RECORD_PREAMBLE}
if (REPO.endsWith("/alpha")) { process.stdout.write("this is not json at all\\n"); process.exit(0); }
${syntheticReport([PROJECT_PASS_RULE]).slice(RECORD_PREAMBLE.length)}`);
    resetEntry(clean);
    resetEntry(garbage);
    const baseline = status(cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: clean }));
    const result = cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: garbage });
    assert.equal(result.status, 0, "a collection error is not a command failure");
    const data = status(result);
    const broken = agentNamed(data, "alpha-pm");
    for (const domain of AUDIT_FED) {
      assert.equal(broken.domains[domain], "error", `${domain} must be error, not pass`);
    }
    assert.equal(data.health.complete, false);
    assert.ok(data.health.collection_errors >= 1, "the unparseable child must be counted");
    assert.ok(data.findings.some((finding) => finding.code === "audit-failed"), "the collection error must be a finding");
    const before = new Map(baseline.agents.map((agent) => [agent.agent_id, JSON.stringify(agent)]));
    for (const agent of data.agents) {
      if (agent.agent_id === "alpha-pm") continue;
      assert.equal(JSON.stringify(agent), before.get(agent.agent_id), `${agent.agent_id} must be byte-identical to the clean run`);
    }
  });

  await checkAsync("a child that hangs times out to unobserved, leaves no survivor, and exits 0", async () => {
    const hang = entry("selective-hang", `${RECORD_PREAMBLE}
import { appendFileSync as record } from "node:fs";
if (REPO.endsWith("/alpha")) {
  record(join(HERE, "pids"), process.pid + "\\n");
  setTimeout(() => {}, 120000);
} else {
${syntheticReport([PROJECT_PASS_RULE]).slice(RECORD_PREAMBLE.length)}
}`);
    resetEntry(hang);
    const result = cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: hang });
    assert.equal(result.status, 0, "a per-child timeout downgrades one agent; the run still succeeds");
    const data = status(result);
    const stalled = agentNamed(data, "alpha-pm");
    for (const domain of AUDIT_FED) {
      assert.equal(stalled.domains[domain], "unobserved", `${domain} must be unobserved after a timeout`);
    }
    const reason = stalled.observations.find((observation) => observation.source === "recipe-audit");
    assert.match(reason.summary, /timeout/u, "the reason must name the timeout");
    const probe = data.probes.find((item) => item.kind === "audit" && item.outcome === "timeout");
    assert.ok(probe, "the timed-out child must be recorded as a probe");
    assert.equal(probe.reason, "timeout");
    for (const agent of data.agents) {
      if (agent.agent_id === "alpha-pm") continue;
      assert.notEqual(agent.domains.template_scaffold, "unobserved", `${agent.agent_id} must be unaffected`);
    }
    await new Promise((wake) => setTimeout(wake, 1500));
    const pidFile = join(dirname_(hang), "pids");
    const pids = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.ok(pids.length > 0, "the hanging child must actually have run for this case to mean anything");
    const survivors = pids.filter((pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } });
    assert.deepEqual(survivors, [], "no audit child may survive its own timeout");
  });

  check("a missing CLI entry is a categorized collection error, not a crash", () => {
    const missing = join(shimRoot, "there-is-no-entry-here.mjs");
    const result = cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: missing });
    assert.equal(result.status, 0, "no crash");
    const data = status(result);
    assert.equal(data.totals.audits_attempted, 0);
    const unavailable = data.findings.find((finding) => finding.code === "audit-cli-unavailable");
    assert.ok(unavailable, "a missing entry must be a visible finding");
    assert.ok(typeof unavailable.source === "string" && unavailable.source.length > 0, "and it must name the owning authority");
    assert.match(unavailable.field, /^[a-z_]+(?:\.|$)/u, "and carry a contract path, not a source id");
    for (const agent of data.agents) {
      for (const domain of AUDIT_FED) {
        assert.equal(agent.domains[domain], "unobserved", `${domain} must be unobserved, never assumed`);
      }
      const reason = agent.observations.find((observation) => observation.source === "recipe-audit");
      assert.match(reason.summary, /audit-cli-unavailable/u);
      // The inventory and provenance halves are STILL fully reported.
      assert.ok(["pass", "warn", "fail"].includes(agent.domains.registry), `registry must still be observed, got ${agent.domains.registry}`);
      assert.notEqual(agent.domains.release_provenance, undefined);
    }
    assert.equal(data.health.complete, false);
  });

  // -- AC11: whole-run deadline and cancellation are COMMAND failures --------

  check("a blown --deadline-ms is TIMEOUT at exit 7 with no partial result", () => {
    const result = cli(["review", "--live", "--deadline-ms", "1", "--json"]);
    assert.equal(result.status, 7, `expected exit 7, got ${result.status}`);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "TIMEOUT");
    assert.equal(parsed.data, null, "no partial result may claim health");
  });

  check("a deadline large enough to succeed still succeeds", () => {
    // Without this, a sign flip in `createRunContext` would leave every deadline
    // case green while turning the flag into a switch that fails at any value.
    const result = cli(["review", "--deadline-ms", "180000", "--json"]);
    assert.equal(result.status, 0, `a generous deadline must not fail: ${result.stderr}`);
    status(result);
  });

  await checkAsync("SIGINT is CANCELLED at exit 8 and kills the children it started", async () => {
    const hang = entry("cancel-hang", `${RECORD_PREAMBLE}
import { appendFileSync as record } from "node:fs";
record(join(HERE, "pids"), process.pid + "\\n");
setTimeout(() => {}, 120000);
`);
    resetEntry(hang);
    const before = snapshotIsolated();
    const captured = await new Promise((settle) => {
      const child = spawn(process.execPath, [CLI, "review", "--live", "--json"], {
        cwd: workdir,
        env: { ...process.env, ...isolation, PJ_FLEET_CLI_ENTRY: hang },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      // SIGINT must arrive AFTER a child exists, or the case proves nothing —
      // and a fixed delay cannot guarantee that. Under `npm run test:coverage`
      // (what CI runs) c8 instrumentation pushes first-child spawn past 2500ms,
      // so the interrupt landed before there was anything to kill and the case
      // failed on its own precondition. Poll for the pid file instead and only
      // then interrupt; the 30s ceiling keeps a genuinely stuck run from
      // hanging the suite.
      const pidPath = join(dirname_(hang), "pids");
      const armedAt = Date.now();
      const poll = setInterval(() => {
        const started = existsSync(pidPath) && readFileSync(pidPath, "utf8").trim() !== "";
        if (!started && Date.now() - armedAt < 30_000) return;
        clearInterval(poll);
        child.kill("SIGINT");
      }, 100);
      const guard = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("close", (code) => { clearInterval(poll); clearTimeout(guard); settle({ code, out }); });
    });
    assert.deepEqual(snapshotIsolated(), before, "a cancelled run must still have written nothing");
    assert.equal(captured.code, 8, `expected exit 8, got ${captured.code}`);
    const parsed = JSON.parse(captured.out);
    assert.equal(parsed.error?.code, "CANCELLED");
    assert.equal(parsed.data, null);
    await new Promise((wake) => setTimeout(wake, 2000));
    const pidFile = join(dirname_(hang), "pids");
    const pids = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.ok(pids.length > 0, "a child must have been started for this case to mean anything");
    const survivors = pids.filter((pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } });
    assert.deepEqual(survivors, [], "no audit child may survive a cancellation");
  });

  // -- AC9 / AC10: the flush fix, at a payload the defect can reach -----------

  await checkAsync("a >64 KiB envelope is byte-identical to a file, a pty, a pipe, and a spawn capture", async () => {
    const args = ["review", "--json"];
    const env = { ...process.env, ...isolation };
    const outFile = join(shimRoot, "status-file.json");
    rmSync(outFile, { force: true });

    const toFile = spawnSync("sh", ["-c", `exec "$0" "$@" > ${JSON.stringify(outFile)}`, process.execPath, CLI, ...args], { cwd: workdir, env, timeout: 180_000 });
    assert.equal(toFile.status, 0, "the file capture must succeed");
    const fileText = readFileSync(outFile, "utf8");
    assert.ok(fileText.length > 65_536, `payload is only ${fileText.length} bytes; below the pipe buffer the defect cannot fire`);

    const pipe = spawnSync("sh", ["-c", `"$0" "$@" | cat`, process.execPath, CLI, ...args], { cwd: workdir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    const spawned = spawnSync(process.execPath, [CLI, ...args], { cwd: workdir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });

    const captures = { file: fileText, pipe: pipe.stdout, spawn: spawned.stdout };
    if (spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" }).status === 0) {
      const ptyFile = join(shimRoot, "status-pty.json");
      rmSync(ptyFile, { force: true });
      const pty = spawnSync("script", ["-qec", `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${args.join(" ")} > ${JSON.stringify(ptyFile)}`, "/dev/null"], { cwd: workdir, env, timeout: 180_000 });
      assert.equal(pty.status, 0, "the pty capture must succeed");
      // A pty is line-disciplined, so LF is echoed as CRLF. The bytes this case
      // is about are the DOCUMENT's; the terminal's line ending is not one of
      // them, so it is normalized rather than asserted on.
      captures.pty = readFileSync(ptyFile, "utf8").replace(/\r\n/gu, "\n");
    } else {
      skip("the pty capture", "`script` is not on this host");
    }

    for (const [name, text] of Object.entries(captures)) {
      assert.ok(text.length > 0, `${name} captured nothing`);
      assert.equal(text.endsWith("}\n"), true, `${name} must end in exactly one newline after the closing brace`);
      assert.equal(text.endsWith("}\n\n"), false, `${name} must not end in two newlines`);
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (error) { assert.fail(`${name} (${text.length} bytes) is not one complete JSON document: ${error.message}`); }
      assert.equal(parsed.ok, true);
      assert.equal(text, fileText, `${name} differs from the file capture (${text.length} vs ${fileText.length} bytes)`);
    }
  });

  check("pjangler audit --json survives a pipe and a spawn at a payload past the buffer", () => {
    // The status core PARSES this child's stdout, so its truncation is a
    // correctness dependency of this story rather than adjacent cleanup. The
    // report is grown past 64 KiB by a repository with many role directories --
    // `hermes.untracked-runtimes` reports one detail line per role.
    const big = join(temp, "audit-scale");
    if (!existsSync(big)) {
      mkdirSync(big, { recursive: true });
      for (let index = 0; index < 400; index += 1) {
        const role = join(big, "agents", "hermes", `role-with-a-fairly-long-name-number-${index}`);
        mkdirSync(role, { recursive: true });
        writeFileSync(join(role, "role.yaml"), "role: pm\n", "utf8");
      }
      assert.equal(git(big, ["init", "--quiet"]).status, 0);
    }
    const env = { ...process.env, ...isolation };
    const pipe = spawnSync("sh", ["-c", `"$0" "$@" | cat`, process.execPath, CLI, "audit", big, "--json"], { cwd: workdir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    const spawned = spawnSync(process.execPath, [CLI, "audit", big, "--json"], { cwd: workdir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    assert.ok(pipe.stdout.length > 65_536, `the audit report is only ${pipe.stdout.length} bytes; below the buffer the defect cannot fire`);
    for (const [name, text] of [["pipe", pipe.stdout], ["spawn", spawned.stdout]]) {
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (error) { assert.fail(`audit --json through a ${name} (${text.length} bytes) is truncated: ${error.message}`); }
      assert.ok(Array.isArray(parsed.rules), `the ${name} capture must be a complete report`);
    }
    // The exit code is still the audit's own: 1 on a repository out of parity.
    // The flush fix keeps forced termination and removes only the truncation.
    assert.equal(pipe.status, 0, "the pipeline's status is `cat`'s");
    assert.equal(spawned.status, 1, "a drifted repository still exits 1");
  });

  check("--json into a closed pipe writes no stack trace", () => {
    const result = spawnSync("sh", ["-c", `"$0" "$@" | head -c 10`, process.execPath, CLI, "review", "--json"], {
      cwd: workdir, env: { ...process.env, ...isolation }, encoding: "utf8", timeout: 180_000,
    });
    assert.doesNotMatch(result.stderr ?? "", /EPIPE|Error:|at .*\n\s+at /u, `a closed pipe produced: ${result.stderr}`);
  });

  // -- AC13: bounds preserve the counts and name the way to the rest ----------

  check("a fleet past the agent cap keeps its totals and names the retrieval", () => {
    const slugs = Array.from({ length: MAX_AGENTS + 20 }, (unused, index) => `scale${index}`);
    const agents = join(temp, "scale-agents.yaml");
    const projects = join(temp, "scale-projects.yaml");
    writeAgentRegistry(agents, slugs);
    writeProjectRegistry(projects, slugs);
    // `--domain registry` so the cap is exercised without 520 audit children --
    // the cap is the subject, not the collection around it.
    const data = status(cli([
      "review", "--domain", "registry", "--json",
      "--agent-registry", agents, "--project-registry", projects,
    ]));
    assert.equal(data.totals.agents, slugs.length, "totals must count every registered agent");
    assert.equal(data.totals.emitted_agents, MAX_AGENTS);
    assert.equal(data.agents.length, MAX_AGENTS);
    const note = data.truncated.find((item) => item.startsWith("agents:"));
    assert.ok(note, `truncated must name the dotted path, got ${JSON.stringify(data.truncated)}`);
    assert.match(note, /flume review --agent <id> --json/u, "a clipped envelope must name how to get the rest");
    assert.equal(data.health.complete, false, "a clipped run is not complete");
    assert.equal(data.health.truncated, true);
    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  check("an agent past the observation cap keeps its counts and carries a retrieval", () => {
    // UNIQUE ids: `RecipeRegistry.register` refuses a duplicate rule id, so a
    // report repeating one is a shape the real audit cannot produce and a cap
    // proved against it would be proved against a fiction.
    const rules = Array.from({ length: MAX_OBSERVATIONS + 60 }, (unused, index) => ({
      id: `bulk.rule-${index}`, title: "bulk", status: "pass",
      summary: `bulk observation ${index}`, details: [], fixable: false, scope: "project",
    }));
    const shim = entry("bulk", syntheticReport(rules));
    resetEntry(shim);
    const data = status(cli(["review", "--agent", "alpha-pm", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    const agent = agentNamed(data, "alpha-pm");
    assert.equal(agent.truncated, true, "the clipped record must say so");
    assert.equal(agent.observations.length, MAX_OBSERVATIONS);
    assert.ok(data.totals.observations > data.totals.emitted_observations, "totals must still count everything");
    const note = data.truncated.find((item) => item.startsWith("agents.alpha-pm.observations:"));
    assert.ok(note, `truncated must name the dotted path, got ${JSON.stringify(data.truncated)}`);
    assert.ok(note.includes(agent.retrieval), "the truncation note must carry the same retrieval the record does");
    assert.equal(agent.complete, false, "a clipped record is not complete");
    // The clip alone must not move the health verdict: the rollup is computed
    // from the FULL set, so a bound on what the envelope carries cannot change
    // what it concludes.
    assert.equal(agent.healthy, true, "clipping is an incompleteness, never a drift");

    // RUN THE EMITTED COMMAND. A prefix regex proved only that a string had the
    // right shape -- and on an unfiltered run the shape it had was the exact
    // invocation that just clipped, so following it returned the same clipped
    // record. The retrieval has to NARROW, and the only way to know is to run it.
    const narrowed = /--domain (\S+)/u.exec(agent.retrieval);
    assert.ok(narrowed, `the retrieval must narrow to a domain, got "${agent.retrieval}"`);
    const domain = narrowed[1];
    const argv = agent.retrieval.replace(/^flume /u, "").split(" ");
    const after = status(cli(argv, { PJ_FLEET_CLI_ENTRY: shim }));
    const before = agent.observations.filter((item) => item.domain === domain).length;
    const returned = agentNamed(after, "alpha-pm").observations.filter((item) => item.domain === domain).length;
    assert.ok(
      returned > before,
      `the retrieval must return more of ${domain} than the clipped record carried: got ${returned}, had ${before}`,
    );
  });

  check("a failure past the agent cap still moves the fleet verdict", () => {
    // THE defect this case exists for: agents past `FLEET_STATUS_MAX_AGENTS` were
    // never built at all, and only the CLIPPED observations reached the
    // fleet-level counters. Measured on the pre-fix build with this exact
    // registry: health.healthy true, failed 0, domains[registry].state "pass" --
    // while `--agent zzzz-broken` on the same registry reported the failure. A
    // bound on what the envelope CARRIES must never move what it CONCLUDES.
    const slugs = Array.from({ length: MAX_AGENTS + 20 }, (unused, index) => `scale${String(index).padStart(4, "0")}`);
    const agents = join(temp, "cap-agents.yaml");
    const projects = join(temp, "cap-projects.yaml");
    writeAgentRegistryWith(agents, slugs, "  zzzz-broken: not-a-mapping");
    writeProjectRegistry(projects, slugs);
    const args = ["review", "--domain", "registry", "--json", "--agent-registry", agents, "--project-registry", projects];
    const data = status(cli(args));

    assert.equal(data.totals.agents, slugs.length + 1, "totals must count every registered agent");
    assert.equal(data.totals.emitted_agents, MAX_AGENTS);
    assert.equal(data.agents.some((agent) => agent.agent_id === "zzzz-broken"), false, "the failing row's RECORD is past the cap");
    assert.equal(data.totals.observations, slugs.length + 1, "every dropped agent's observations must still be counted");
    assert.equal(data.health.healthy, false, "the failure past the cap must still make the fleet unhealthy");
    assert.equal(data.health.failed, 1);
    assert.equal(data.totals.by_state.fail, 1, "by_state must see the dropped agent");
    assert.equal(data.domains[0].state, "fail", "the domain rollup must see it too");
    assert.equal(data.domains[0].counts.fail, 1);

    // And the same fleet, scoped to the dropped agent, must agree.
    const scoped = status(cli([...args.slice(0, 4), "--agent", "zzzz-broken", ...args.slice(4)]));
    assert.equal(scoped.health.healthy, false);
    assert.equal(scoped.health.failed, 1);

    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  check("a failure in an agent's clipped tail still moves the fleet verdict", () => {
    // The other half of the same defect: only `kept` reached the fleet counters,
    // so a `fail` sorted past `FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT` was
    // invisible to health. `template_scaffold` sorts last of the nine domains, so
    // the bulk rules and the failing one both land in the clipped tail.
    const rules = [
      ...Array.from({ length: MAX_OBSERVATIONS + 60 }, (unused, index) => ({
        id: `bulk.rule-${String(index).padStart(4, "0")}`, title: "bulk", status: "pass",
        summary: `bulk observation ${index}`, details: [], fixable: false, scope: "project",
      })),
      { id: "zzz.the-only-failure", title: "the only failure", status: "fail", summary: "sorted into the clipped tail", details: [], fixable: false, scope: "project" },
    ];
    const withFail = entry("tail-fail", syntheticReport(rules));
    const withoutFail = entry("tail-clean", syntheticReport(rules.slice(0, -1)));
    resetEntry(withFail);
    resetEntry(withoutFail);
    const argv = ["review", "--agent", "alpha-pm", "--live", "--json"];
    const dirty = status(cli(argv, { PJ_FLEET_CLI_ENTRY: withFail }));
    const clean = status(cli(argv, { PJ_FLEET_CLI_ENTRY: withoutFail }));
    const agent = agentNamed(dirty, "alpha-pm");
    assert.equal(agent.truncated, true);
    assert.equal(
      agent.observations.some((item) => item.rule_id === "zzz.the-only-failure"), false,
      "for this case to mean anything the failure must be in the DROPPED tail",
    );
    // A DELTA against the identical run without that one rule. An absolute
    // `failed >= 1` would have been satisfied by the synthetic fleet's own
    // fleet-scoped provenance failures and pinned nothing -- verified by
    // mutation: clipping `ctx.observations` back to `kept` left that assertion
    // green.
    assert.equal(
      dirty.health.failed, clean.health.failed + 1,
      "the failure the envelope dropped must still be counted exactly once",
    );
    assert.equal(dirty.health.healthy, false, "and it must still make the fleet unhealthy");
    assert.equal(agent.healthy, false, "as must the agent record");
  });

  await checkAsync("the audit child gets its own budget, not the git-probe one", async () => {
    // `FLEET_DEFAULT_PROBE_TIMEOUT_MS` is 5 000 ms and is sized for a local
    // `git` read. The audit child is a node startup plus 25 rules, one of which
    // gives `npm view` an 8 000 ms timeout of its OWN -- so on a cold cache the
    // inherited budget timed out every repository and reported `unobserved` for
    // a reason no operator could see. This shim sleeps 6 500 ms: past the probe
    // budget, inside the audit one.
    const shim = entry("slow-audit", `${RECORD_PREAMBLE}
const rules = ${JSON.stringify([PROJECT_PASS_RULE])};
setTimeout(() => {
  const report = { repo: REPO, ok: true, hostOk: true, auditedAt: new Date().toISOString(), rules };
  process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
  process.exit(0);
}, 6500);
`);
    resetEntry(shim);
    const data = status(cli(["review", "--agent", "alpha-pm", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    const probe = data.probes.find((item) => item.kind === "audit");
    assert.ok(probe, "the audit child must have been recorded");
    assert.equal(probe.outcome, "ok", `a 6.5 s child must fit the audit budget, got ${probe.outcome}/${probe.reason}`);
    assert.equal(data.totals.audits_observed, 1);
    assert.equal(agentNamed(data, "alpha-pm").domains.profile, "pass", "and its findings must land");
  });

  check("a child that prints past the byte cap is categorized as too large, not as silence", () => {
    // `PROBE_MAX_BYTES` is 4 MiB and the real audit report on this fleet is
    // already 3.7 MB. A child killed for saying too much and a child that said
    // nothing are different problems with different repairs, and they used to
    // report the same reason.
    const shim = entry("oversized", `${RECORD_PREAMBLE}
const chunk = "x".repeat(1024 * 1024);
for (let index = 0; index < 6; index += 1) process.stdout.write(chunk);
process.stdout.write("\\n");
`);
    resetEntry(shim);
    const result = cli(["review", "--agent", "alpha-pm", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim });
    assert.equal(result.status, 0, "an oversized child is a collection error, not a command failure");
    const data = status(result);
    const probe = data.probes.find((item) => item.kind === "audit");
    assert.ok(probe, "the audit child must have been recorded");
    assert.equal(probe.reason, "audit-output-too-large", `expected the byte-cap category, got ${probe.reason}`);
    const agent = agentNamed(data, "alpha-pm");
    for (const domain of AUDIT_FED) assert.equal(agent.domains[domain], "error");
    assert.ok(data.findings.some((finding) => finding.code === "audit-failed"));
  });

  check("an agent registry declaring no agents claims nothing", () => {
    // Measured on the pre-fix build: `agents: {}` returned
    // {healthy:true, complete:true, fleet_complete:true} over zero observations --
    // an aggregate turning absence into agreement.
    const agents = join(temp, "no-agents.yaml");
    const projects = join(temp, "no-projects.yaml");
    writeFileSync(agents, "schema_version: 1\nagents: {}\n", "utf8");
    writeFileSync(projects, "schema_version: 1\nprojects: {}\n", "utf8");
    const data = status(cli([
      "review", "--live", "--json",
      "--agent-registry", agents, "--project-registry", projects,
    ]));
    assert.equal(data.totals.agents, 0);
    assert.deepEqual(data.agents, []);
    assert.equal(data.health.fleet_complete, false, "zero rows is not a completely observed fleet");
    assert.equal(data.health.complete, false, "a registry this run could not read a fleet out of is a collection error");
    assert.ok(data.health.collection_errors >= 1);
    const finding = data.findings.find((item) => item.code === "registry-declares-no-agents");
    assert.ok(finding, `an empty registry must be a visible finding, got ${JSON.stringify(data.findings.map((f) => f.code))}`);
    assert.ok(typeof finding.source === "string" && finding.source.length > 0, "and it must name the authority that owns the field");
    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  check("two repositories disagreeing on one host rule report the WORST reading", () => {
    // First-wins dedupe kept whichever repository the alphabetical loop reached
    // first, so a `pass` from `alpha` masked a `fail` from a later one. `theta`
    // is deliberately not first.
    const shim = entry("host-disagree", `${RECORD_PREAMBLE}
const host = REPO.endsWith("/theta")
  ? { id: "systemd.sentinel", title: "systemd sentinel", status: "fail", summary: "a unit is missing on this host", details: ["hermes-theta-pm-gateway.service not found"], fixable: false, scope: "host" }
  : { id: "systemd.sentinel", title: "systemd sentinel", status: "pass", summary: "units match", details: [], fixable: false, scope: "host" };
const rules = [host];
const report = { repo: REPO, ok: true, hostOk: host.status === "pass", auditedAt: new Date().toISOString(), rules };
process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
process.exit(0);
`);
    resetEntry(shim);
    const data = status(cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    assert.equal(invocationsOf(shim).length, BASE_SLUGS.length, "every repository must have been audited");
    const sentinel = data.host.filter((finding) => finding.rule_id === "systemd.sentinel");
    assert.equal(sentinel.length, 1, "still exactly one entry per rule id");
    assert.equal(sentinel[0].state, "fail", "the worst reading must survive, not the first one");
    assert.ok(
      sentinel[0].details.some((line) => /repositories disagreed/u.test(line)),
      `the disagreement must be recorded, got ${JSON.stringify(sentinel[0].details)}`,
    );
    // A host-scoped fail is still not any agent's failure.
    for (const agent of data.agents) {
      assert.equal(agent.observations.some((item) => item.rule_id === "systemd.sentinel"), false);
    }
  });

  check("every provenance fact id maps to a declared domain", () => {
    // The mirror of `audit-rule-unmapped`. A fact id matching no prefix used to
    // be filed under release_provenance in silence, and the fallback
    // "no release fact" observation kept the presence assertion green.
    const source = readFileSync(join(PKG, "src", "org", "status.ts"), "utf8");
    const table = source.slice(source.indexOf("const FACT_PREFIX_DOMAIN"));
    const prefixes = [...table.slice(0, table.indexOf("] as const)")).matchAll(/\["([a-z_]+\.)",/gu)].map((match) => match[1]);
    assert.ok(prefixes.length >= 4, `FACT_PREFIX_DOMAIN must declare prefixes for this case to mean anything, found ${prefixes.length}`);

    const provenance = JSON.parse(cli(["record", "--json"]).stdout).data;
    const ids = [...new Set(provenance.facts.map((fact) => fact.id))].sort();
    assert.ok(ids.length > 0, "the provenance core must emit facts for this case to mean anything");
    const unmapped = ids.filter((id) => !prefixes.some((prefix) => id.startsWith(prefix)));
    assert.deepEqual(unmapped, [], `these fact ids match no declared prefix: ${unmapped.join(", ")}`);

    // And the running guard must agree: no fact reached the fallback.
    const data = status(cli(["review", "--json"]));
    assert.deepEqual(
      data.findings.filter((finding) => finding.code === "provenance-fact-unmapped"),
      [],
      "the guard must not fire on the facts this build actually produces",
    );
  });

  check("data.health.healthy is false on a drifted fleet and true on a clean slice", () => {
    // `healthy` was asserted NOWHERE: every hit was per-agent, or the report
    // regex /Workforce (IN GOOD STANDING|ON NOTICE)/ which matches either verdict.
    // Dropping the `byState.fail === 0` conjunct kept all 35 cases green.
    // beta-pm's profile directory is a symlink and the contract declares
    // symlink_allowed: false, so its profile domain is a guaranteed `fail`.
    const drifted = status(cli(["review", "--domain", "profile", "--agent", "beta-pm", "--json"]));
    assert.equal(drifted.health.healthy, false, "a symlinked profile directory must make the fleet verdict false");
    // TWO fails since story 1.7: the inventory's lstat on `agents.{agent_id}.profile_name`
    // and the profile observer's path gate on `profiles.{profile_name}` -- two
    // true readings of two things, on two fields, never a contradiction.
    assert.equal(drifted.health.failed, 2);

    const clean = status(cli(["review", "--domain", "profile", "--agent", "alpha-pm", "--json"]));
    assert.equal(clean.health.healthy, true, "and a slice with no fail and no error must read true");
    assert.equal(clean.health.failed, 0);
    assert.equal(clean.health.errors, 0);

    // Fleet-wide, the drifted agent is in scope, so the verdict is false.
    const whole = status(cli(["review", "--json"]));
    assert.equal(whole.health.healthy, false, "the fleet contains beta-pm, so the fleet verdict is false");
  });

  check("a rejected argument list still answers in JSON, naming the status command", () => {
    // Without this the `status:` entry in the null-prototype positional map is
    // unpinned: deleting it makes `fleet status --json --bogus` answer
    // command "fleet.contract.validate" with every other case still green.
    const result = cli(["review", "--json", "--bogus"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "fleet.status", "the envelope must name the command that failed");
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
  });

  check("--contract reads the file it names, and refuses one it cannot", () => {
    // Registered and documented, and exercised by nothing until now.
    const tracked = status(cli(["review", "--domain", "registry", "--json"]));
    const copy = join(temp, "contract-copy.yaml");
    writeFileSync(copy, readFileSync(TRACKED_CONTRACT, "utf8"), "utf8");
    const named = status(cli(["review", "--domain", "registry", "--json", "--contract", copy]));
    assert.equal(named.contract_version, tracked.contract_version, "a copy of the tracked contract must report the same version");
    assert.ok(named.contract_path.endsWith("contract-copy.yaml"), `the envelope must name the file it read, got ${named.contract_path}`);
    assert.notEqual(named.contract_path, tracked.contract_path, "and it must not echo the tracked path back");

    const broken = join(temp, "contract-broken.yaml");
    writeFileSync(broken, "schema_version: 1\ncontract_version: 1.0.0\n", "utf8");
    const refused = cli(["review", "--json", "--contract", broken]);
    assert.equal(errorCode(envelope(refused)), "INVALID_INPUT");
    assert.equal(refused.status, 2, "a contract missing its required blocks is a command failure");
    rmSync(copy, { force: true });
    rmSync(broken, { force: true });
  });

  check("pjangler audit --json into a closed pipe writes no stack trace", () => {
    // A regression from removing `process.exit` on the audit path: writeStdout
    // removes its own error listener when it settles, so an EPIPE arriving after
    // that reached the process as an unhandled 'error' event. MEASURED 5/5
    // against a 3.7 MB report before the persistent guard was installed.
    const big = auditScaleRepo();
    const result = spawnSync("sh", ["-c", `"$0" "$@" | head -c 10`, process.execPath, CLI, "audit", big, "--json"], {
      cwd: workdir, env: { ...process.env, ...isolation }, encoding: "utf8", timeout: 180_000,
    });
    assert.doesNotMatch(result.stderr ?? "", /EPIPE|Unhandled|at .*\n\s+at /u, `a closed pipe produced: ${(result.stderr ?? "").slice(0, 300)}`);
  });

  // -- AC14: credentials are excluded by construction -------------------------

  check("no credential reaches the JSON, the report, the findings, or a child environment", () => {
    const shim = entry("env-capture", syntheticReport([PROJECT_PASS_RULE]));
    resetEntry(shim);
    const json = cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim });
    const report = cli(["review", "--live"], { PJ_FLEET_CLI_ENTRY: shim });
    for (const [name, text] of [["--json", json.stdout], ["the human report", report.stdout]]) {
      assert.equal(text.includes(SECRET_SENTINEL), false, `the sentinel value reached ${name}`);
      for (const key of CREDENTIAL_KEYS) {
        assert.equal(text.includes(key), false, `the credential key name ${key} reached ${name}`);
      }
    }
    const keys = childEnvKeys(shim);
    assert.ok(Array.isArray(keys) && keys.length > 0, "the shim must have recorded its environment for this case to mean anything");
    for (const key of CREDENTIAL_KEYS) {
      assert.equal(keys.includes(key), false, `the audit child received ${key}`);
    }
    assert.ok(keys.includes("HOME") && keys.includes("PATH"), "the child must still receive what an audit needs");
  });

  // -- AC15: determinism and zero writes --------------------------------------

  check("two consecutive runs produce byte-identical data", () => {
    const shim = entry("determinism", syntheticReport([PROJECT_WARN_RULE, HOST_FAIL_RULE]));
    resetEntry(shim);
    for (const args of [["review", "--json"], ["review", "--live", "--json"]]) {
      const first = cli(args, { PJ_FLEET_CLI_ENTRY: shim });
      const second = cli(args, { PJ_FLEET_CLI_ENTRY: shim });
      assert.equal(first.stdout, second.stdout, `${args.join(" ")} is not byte-stable across two runs`);
      const data = JSON.parse(first.stdout).data;
      assert.equal(JSON.stringify(data), JSON.stringify(JSON.parse(second.stdout).data));
    }
  });

  check("the human report leads with the verdict, its reasons, and the completeness split", () => {
    const result = cli(["review"]);
    assert.notEqual(result.stdout, "", "the human report must not be empty");
    assert.equal(result.status, 0, `an unhealthy fleet is data, not a failure exit: got ${result.status} ${result.stderr}`);
    const out = result.stdout;
    // Story 1.5 moved the headline to the THREE-way verdict. `healthy` is still
    // reported -- as one of the reasons on the line below -- but the word the
    // headline leads with can no longer be "healthy" over a fleet whose
    // audit-fed half was never opened.
    assert.match(out.split("\n").slice(0, 3).join("\n"), /Workforce (IN GOOD STANDING|ON NOTICE|UNABLE TO ASSESS)/u, "the verdict must lead");
    for (const reason of ["failed", "errors", "warned", "unobserved", "unsupported", "skipped", "unjustified", "stale", "contradictions"]) {
      assert.match(out, new RegExp(`\\d+ ${reason}`, "u"), `the verdict's reasons must name ${reason}`);
    }
    assert.ok(out.indexOf("Workforce") < out.indexOf("Agents"), "the verdict must come before the agent dump");
    for (const domain of DOMAINS) assert.ok(out.includes(domain), `the report must name the ${domain} domain`);
    assert.match(out, /Host \(this machine/u, "the host block must be visibly separate from the agents");
    assert.ok(out.indexOf("Domains") < out.indexOf("Agents"), "the per-domain rollup must precede the agents");
  });

  check("health.healthy still computes exactly as story 1.4 defined it", () => {
    // THE GUARD AGAINST SOLVING 1.5 BY QUIETLY REDEFINING 1.4. Story 1.5 adds a
    // three-way `verdict` BESIDE `healthy`; the moment `healthy` starts folding
    // in coverage, staleness or authorization, the provenance split that keeps
    // "the fleet is wrong" apart from "this run did not see all of it" is gone
    // and every consumer of the old field is silently wrong.
    //
    // Recomputed here from the observations the same envelope carries, over
    // every EMITTED record -- so this is a derivation from the payload rather
    // than a restatement of the field.
    const data = status(cli(["review", "--json"]));
    const observations = [
      ...data.agents.flatMap((agent) => agent.observations),
      ...data.domains.flatMap((rollup) => rollup.observations),
    ];
    const failed = observations.filter((item) => item.state === "fail").length;
    const errored = observations.filter((item) => item.state === "error").length;
    assert.ok(failed > 0, "the fixture must carry a proven failure or this pins nothing");
    assert.equal(data.health.healthy, failed === 0 && errored === 0);
    assert.equal(data.health.healthy, false);

    // `unsupported`, `unobserved`, `skip`, `warn`, staleness and an
    // unauthorized gap must all leave it alone.
    assert.ok(data.health.unobserved > 0, "the default run leaves the audit half unread");
    assert.ok(data.health.unsupported > 0, "and three domains have no observer at all");
    assert.ok(data.health.unjustified > 0, "and the tracked contract authorizes none of this fixture's warnings");
    assert.equal(data.health.verdict, "unhealthy", "the new verdict is derived, not a second copy of healthy");

    // A clean SLICE still reads `healthy: true`, which is the 1.4 criterion the
    // three-way verdict is not allowed to break.
    const clean = status(cli(["review", "--json", "--agent", "alpha-pm", "--domain", "runtime"]));
    assert.equal(clean.health.healthy, true, "a slice with no fail and no error must still read healthy");
  });

  // -- The declared vocabulary is the code's, not a second copy ---------------

  check("the nine status domains are not the contract's three policy_domains", () => {
    const source = readFileSync(join(PKG, "src", "org", "types.ts"), "utf8");
    const block = source.slice(source.indexOf("FLEET_STATUS_DOMAINS"));
    for (const domain of DOMAINS) {
      assert.ok(block.includes(`"${domain}"`), `FLEET_STATUS_DOMAINS must declare ${domain}`);
    }
    // Parsed, not grepped: a `- ` list-item regex walks straight into the NEXT
    // entry of the enclosing list, which is how this case first "found" an
    // `id:` line among the policy domains.
    const contract = YAML.parse(readFileSync(TRACKED_CONTRACT, "utf8"));
    const policy = Object.values(contract.classifications ?? {})
      .flatMap((classification) => classification.entries ?? [])
      .flatMap((entry) => entry.policy_domains ?? []);
    assert.ok(policy.length > 0, "the contract must declare policy_domains for this case to mean anything");
    assert.deepEqual([...new Set(policy)].sort(), ["bloodbank", "profile", "systemd"], "the contract's axis is the three-value one");
    // The story HALTS rather than widening the contract, so the tracked file
    // must still not know about the six status domains that are not policy ones.
    for (const domain of DOMAINS) {
      if (["bloodbank", "profile", "systemd"].includes(domain)) continue;
      assert.equal(policy.includes(domain), false, `the contract's policy_domains must not have grown ${domain}`);
    }
  });

  check("the state precedence is read, not merely declared", () => {
    const source = readFileSync(join(PKG, "src", "org", "status.ts"), "utf8");
    assert.match(source, /for \(const state of FLEET_STATUS_STATE_PRECEDENCE\)/u, "rollUp must iterate the exported precedence constant");
    const types = readFileSync(join(PKG, "src", "org", "types.ts"), "utf8");
    const declared = /FLEET_STATUS_STATE_PRECEDENCE = \[\s*([^\]]+)\]/u.exec(types);
    assert.ok(declared, "the precedence must be declared as a list");
    const order = declared[1].split(",").map((item) => item.trim().replace(/"/gu, "")).filter(Boolean);
    assert.deepEqual(order, ["error", "unobserved", "unsupported", "fail", "warn", "skip", "pass"]);
  });

  // -- The gates that make this reachable on a fresh clone -------------------

  check("the suite and the mise task both know about status", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.match(runner, /tests\/fleet-status-regressions\.mjs/u, "a suite not listed in SUITES never runs");
    const mise = readFileSync(join(ROOT, "mise.toml"), "utf8");
    const task = mise.slice(mise.indexOf('[tasks."org:review"]'));
    assert.ok(task.startsWith('[tasks."org:review"]'), "mise must expose org:review");
    assert.match(task.slice(0, 600), /depends = \["build"\]/u, "without a build the task fails with ERR_MODULE_NOT_FOUND, which teaches nothing");
  });

  // -- Review pass 2: bounds, filters, and the assertions that could not fail -

  check("the INVENTORY row cap cannot move the fleet verdict either", () => {
    // The agent-cap case above proves `FLEET_STATUS_MAX_AGENTS` (500) does not
    // move the verdict. It could not see the SECOND bound one level down:
    // `collectFleetInventory` clips its own rows at `FLEET_INVENTORY_MAX_ROWS`
    // (1000), and status counts health out of the rows it is handed. Measured on
    // the pre-fix build with this exact registry: `healthy: true, failed: 0,
    // by_state.fail: 0, domains[registry].state: "pass"`, `totals.agents: 1021`
    // beside `totals.observations: 1000` -- and `--agent zzzz-broken` answered
    // NOT_FOUND at exit 3 for a row `totals.agents` was counting. 520 rows, the
    // largest fixture that existed, is below the cap and cannot reach this.
    const slugs = Array.from({ length: 1020 }, (unused, index) => `bulk${String(index).padStart(4, "0")}`);
    const agents = join(temp, "rowcap-agents.yaml");
    const projects = join(temp, "rowcap-projects.yaml");
    writeAgentRegistryWith(agents, slugs, "  zzzz-broken: not-a-mapping");
    writeProjectRegistry(projects, slugs);
    const args = ["review", "--domain", "registry", "--json", "--agent-registry", agents, "--project-registry", projects];
    const data = status(cli(args));

    assert.ok(slugs.length + 1 > 1000, "the fixture must exceed FLEET_INVENTORY_MAX_ROWS or it proves nothing");
    assert.equal(data.totals.agents, slugs.length + 1, "totals must count every registered row");
    assert.equal(
      data.totals.observations, slugs.length + 1,
      "every row past the inventory cap must still be OBSERVED and counted, not merely counted",
    );
    assert.equal(data.health.healthy, false, "a failing row past the inventory cap must still make the fleet unhealthy");
    assert.equal(data.health.failed, 1);
    assert.equal(data.totals.by_state.fail, 1, "by_state must see the row the inventory would have clipped");
    assert.equal(data.domains[0].state, "fail", "and so must the domain rollup");

    // The truncation note promises this command works. It must.
    assert.match(
      data.truncated.join(" "), /--agent <id>/u,
      "the clip note must name the retrieval it promises",
    );
    const scoped = status(cli([...args, "--agent", "zzzz-broken"]));
    assert.equal(scoped.agents.length + scoped.health.failed >= 1, true);
    assert.equal(scoped.health.healthy, false, "the promised retrieval must reach a row past the inventory cap");
    assert.equal(scoped.health.failed, 1);

    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  check("a filtered --live run says which host rules it collected and did not report", () => {
    // The mirror of `audit-host-rules-not-collected`, and the half that was
    // silent. When no child spawns, the run explains the empty `data.host`. When
    // a child DOES spawn -- because the selected domain is audit-fed -- every
    // host rule belonging to an unselected domain arrived and was dropped with no
    // finding and no note. Measured on the live fleet before this:
    // `--domain template_scaffold --live` spawned 28 children and discarded
    // `systemd.sentinel` (fail), `hermes.registry-parity` (fail) and
    // `hermes.profile-wiring` (fail) into `findings: []`, `truncated: []`.
    const shim = entry("host-dropped", syntheticReport([HOST_FAIL_RULE, PROJECT_PASS_RULE]));
    resetEntry(shim);
    // `template_scaffold` is audit-fed, so children DO spawn; HOST_FAIL_RULE is
    // `hermes.profile-wiring`, whose domain is `profile` -- not selected.
    const data = status(cli(
      ["review", "--domain", "template_scaffold", "--live", "--json"],
      { PJ_FLEET_CLI_ENTRY: shim },
    ));
    assert.ok(invocationsOf(shim).length > 0, "the fixture requires the audit child to have actually run");
    // Story 1.6 added ONE host finding of its own to this domain: the scaffold
    // source's integrity (`scaffold.source`), filed once for the machine's
    // checkout of the template. No AUDIT host rule belongs to the selected
    // domain in this fixture, which is what this case is about.
    assert.deepEqual(data.host.map((finding) => finding.rule_id), ["scaffold.source"], "no audit host rule belongs to the selected domain in this fixture");
    assert.equal(data.host[0].state, "pass", "the tracked template must be a canonical source for this suite");
    const dropped = data.findings.filter((finding) => finding.code === "audit-host-rules-not-reported");
    assert.equal(dropped.length, 1, `the dropped host rule must be named exactly once, got ${JSON.stringify(data.findings.map((f) => f.code))}`);
    assert.match(dropped[0].detail, /hermes\.profile-wiring/u, "the finding must name the rule");
    assert.match(dropped[0].detail, /profile/u, "and the domain that would have carried it");
    // NO STATE MAY BE CLAIMED. `hostByRule` resolves a host rule worst-wins
    // across repositories; this finding fires on the first one, so naming its
    // state would re-introduce the first-wins mask a previous pass removed.
    assert.equal(/\b(pass|fail|warn|skip)\b/u.test(dropped[0].detail), false, `the detail must claim no state: ${dropped[0].detail}`);
  });

  check("--domain registry spawns zero scaffold probes, and template_scaffold spawns one per selected role", () => {
    // Story 1.6 (PJAN-108). The scaffold observer is gated on its domain exactly
    // as the provenance families are: a filter that read every role directory
    // and then hid the result would not be a filter.
    const registry = status(cli(["review", "--domain", "registry", "--json"]));
    assert.deepEqual(registry.probes.filter((probe) => probe.kind === "scaffold"), [], "--domain registry must spawn no scaffold probe");
    assert.equal(registry.scaffold, null, "data.scaffold is null when the domain was not selected, and the key is still present");
    for (const agent of registry.agents) assert.equal(agent.scaffold, null, `${agent.agent_id}.scaffold must be null when the domain was not selected`);

    const scaffold = status(cli(["review", "--domain", "template_scaffold", "--json"]));
    const probes = scaffold.probes.filter((probe) => probe.kind === "scaffold");
    // One per selected role directory plus one for the template source.
    assert.equal(probes.length, BASE_SLUGS.length + 1, `expected ${BASE_SLUGS.length + 1} scaffold probes, got ${JSON.stringify(probes.map((p) => p.target))}`);
    assert.ok(scaffold.scaffold, "data.scaffold must be present when the domain is selected");
    assert.equal(scaffold.scaffold.source.integrity, "ok", `the tracked template must be a canonical source for this suite: ${JSON.stringify(scaffold.scaffold.source)}`);
    // THE FIXTURE IS SCAFFOLD-CLEAN. Every synthetic role is rendered from the
    // pinned template, so the observer's eight groups read `pass` and the
    // 1.4/1.5 cases above keep the rollups they were written against.
    assert.equal(scaffold.scaffold.agents.passing, BASE_SLUGS.length, `every synthetic role must match the pinned template: ${JSON.stringify(scaffold.scaffold.agents)}`);
    for (const agent of scaffold.agents) {
      assert.ok(agent.scaffold, `${agent.agent_id} must carry a scaffold summary`);
      assert.equal(agent.scaffold.assets.drifted, 0, `${agent.agent_id} must be scaffold-clean`);
      assert.equal(agent.scaffold.role_dir_source, "registry");
    }
  });

  check("a domain filter constrains which probe FAMILY runs, not just which agent", () => {
    // "Filters constrain collection" was enforced per agent and per source
    // GROUP, never per domain. The template probes (gitlink, submodule) produce
    // only `scaffold.*` facts and the checkout probes only `hermes.*` facts, so
    // both families ran for either domain and one family's facts were then
    // discarded. Measured before: `--domain template_scaffold` and
    // `--domain release_provenance` ran the IDENTICAL probe set,
    // `{checkout: 3, gitlink: 1, submodule: 1}`.
    const kinds = (data) => {
      const counts = {};
      for (const probe of data.probes) counts[probe.kind] = (counts[probe.kind] ?? 0) + 1;
      return counts;
    };
    const scaffold = kinds(status(cli(["review", "--domain", "template_scaffold", "--json"])));
    const release = kinds(status(cli(["review", "--domain", "release_provenance", "--json"])));
    const both = kinds(status(cli(["review", "--json"])));

    assert.equal(scaffold.checkout, undefined, `--domain template_scaffold must spawn no checkout probe, got ${JSON.stringify(scaffold)}`);
    assert.equal(release.gitlink, undefined, `--domain release_provenance must spawn no template probe, got ${JSON.stringify(release)}`);
    assert.equal(release.submodule, undefined, "nor a submodule probe");
    // Non-vacuous in the other direction: each family must still RUN for its own
    // domain, or "spawns nothing" would pass by spawning nothing at all.
    assert.ok((scaffold.gitlink ?? 0) > 0, `the template family must still run for its own domain, got ${JSON.stringify(scaffold)}`);
    assert.ok((release.checkout ?? 0) > 0, `the checkout family must still run for its own domain, got ${JSON.stringify(release)}`);
    // And an unfiltered run is unchanged: it collects both.
    assert.ok((both.gitlink ?? 0) > 0 && (both.checkout ?? 0) > 0, `an unfiltered run must collect both families, got ${JSON.stringify(both)}`);
  });

  check("a host finding's retrieval actually returns that finding", () => {
    // `retrieval` is a promise: run this and you get this record. For a host
    // finding whose domain is not in `AUDIT_PER_AGENT_DOMAINS` the narrowed
    // command spawns no child at all, so it returned `data.host: []` -- measured
    // for 4 of 6 host findings on the live fleet, each naming exactly the command
    // that could not return it.
    const shim = entry("host-retrieval", syntheticReport([
      { ...HOST_FAIL_RULE, id: "systemd.sentinel" },
      PROJECT_PASS_RULE,
    ]));
    resetEntry(shim);
    const data = status(cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    const finding = data.host.find((item) => item.rule_id === "systemd.sentinel");
    assert.ok(finding, `the host finding must be reported, got ${JSON.stringify(data.host.map((h) => h.rule_id))}`);
    assert.equal(
      /--domain (registry|systemd|bloodbank)\b/u.test(finding.retrieval), false,
      `a host retrieval must not narrow to a domain that spawns no child: ${finding.retrieval}`,
    );
    // RUN IT. An assertion about the string's shape is not the promise.
    const argv = finding.retrieval.replace(/^flume /u, "").split(" ");
    const again = status(cli(argv, { PJ_FLEET_CLI_ENTRY: shim }));
    assert.ok(
      again.host.some((item) => item.rule_id === "systemd.sentinel"),
      `the retrieval returned no host finding: ${finding.retrieval} -> ${JSON.stringify(again.host.map((h) => h.rule_id))}`,
    );
  });

  check("next_actions is emitted, and --json is not told to re-run with --json", () => {
    // `next_actions` had ZERO assertions in either suite, and the MCP parity loop
    // compares only `command`, `data` and `error` -- so the field is outside
    // everything that checks the two adapters agree. The CLI builder also drops
    // its last element by POSITION on the `--json` path.
    const human = envelope(cli(["review", "--json"]));
    assert.ok(Array.isArray(human.next_actions) && human.next_actions.length > 0, "an envelope must carry next_actions");
    assert.equal(
      human.next_actions.some((action) => /--json/u.test(action)), false,
      `a caller already reading JSON must not be told to re-run with --json: ${JSON.stringify(human.next_actions)}`,
    );
    // The guidance must still SAY something specific about this run's verdict.
    assert.ok(human.next_actions.join(" ").length > 20, "next_actions must not be empty guidance");
  });

  check("--agent probes the selected agent's checkout and NO other", () => {
    // The existing `--agent` case asserted that no non-selected slug appeared in
    // any probe target -- against a fixture where EVERY agent declares the same
    // `hermes.repo` (`.../releases/abc`) and provenance dedupes checkouts by
    // realpath. One probe existed, its target contained no slug at all, and the
    // seven-iteration loop was vacuous: reverting the scoping entirely, or
    // inverting it to skip the selected agent, left every assertion green.
    // Distinct checkouts per agent are what make the guarantee observable.
    const slugs = ["one", "two", "three"];
    for (const slug of slugs) {
      const repo = join(temp, "checkouts", slug);
      mkdirSync(repo, { recursive: true });
      assert.equal(git(repo, ["init", "--quiet"]).status, 0, `git init failed in ${repo}`);
      writeFileSync(join(repo, "README.md"), `# ${slug}\n`, "utf8");
      assert.equal(git(repo, ["add", "-A"]).status, 0);
      assert.equal(git(repo, ["commit", "--quiet", "-m", "seed"]).status, 0);
    }
    const agents = join(temp, "distinct-agents.yaml");
    const projects = join(temp, "distinct-projects.yaml");
    const rows = {};
    for (const slug of slugs) {
      rows[`${slug}-pm`] = { ...agentRow(slug), hermes: { ...agentRow(slug).hermes, repo: join(temp, "checkouts", slug) } };
    }
    writeFileSync(agents, YAML.stringify({ schema_version: 1, agents: rows }), "utf8");
    writeProjectRegistry(projects, slugs);
    const base = ["review", "--domain", "release_provenance", "--json", "--agent-registry", agents, "--project-registry", projects];

    const all = status(cli(base));
    const allTargets = all.probes.filter((probe) => probe.kind === "checkout").map((probe) => probe.target);
    for (const slug of slugs) {
      assert.ok(
        allTargets.some((target) => target.endsWith(`/${slug}`)),
        `an unfiltered run must probe ${slug}'s checkout; got ${JSON.stringify(allTargets)}`,
      );
    }

    const scoped = status(cli([...base, "--agent", "two-pm"]));
    const scopedTargets = scoped.probes.filter((probe) => probe.kind === "checkout").map((probe) => probe.target);
    // THE POSITIVE HALF, which is what was missing: the selected agent's own
    // checkout must have been read.
    assert.equal(scopedTargets.length, 1, `exactly one checkout may be probed under --agent, got ${JSON.stringify(scopedTargets)}`);
    assert.ok(scopedTargets[0].endsWith("/two"), `the SELECTED agent's checkout must be the one probed, got ${scopedTargets[0]}`);

    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  check("proven drift and a dirty checkout are fails, and they move health", () => {
    // `provenanceState` maps `mismatch` and `dirty` to `fail`, which is what lets
    // a wrong-build agent move `data.health.healthy` -- the single question this
    // command exists to answer. Nothing pinned it: the base fixture's declared
    // checkout is a plain directory that is never `git init`ed, so every
    // git-derived fact comes back missing/unobserved and no fact in the suite
    // reached `fail`. Changing `case "mismatch": return "fail"` to `"warn"` left
    // all 35 cases green (verified by mutation).
    const driftRepo = join(temp, "drift", "clean");
    const dirtyRepo = join(temp, "drift", "dirty");
    for (const repo of [driftRepo, dirtyRepo]) {
      mkdirSync(repo, { recursive: true });
      assert.equal(git(repo, ["init", "--quiet"]).status, 0, `git init failed in ${repo}`);
      writeFileSync(join(repo, "README.md"), "# drift\n", "utf8");
      assert.equal(git(repo, ["add", "-A"]).status, 0);
      assert.equal(git(repo, ["commit", "--quiet", "-m", "seed"]).status, 0);
    }
    // Uncommitted change in one of them -- `hermes.checkout_clean` desires
    // "clean" and carries `mismatchStatus: "dirty"`.
    writeFileSync(join(dirtyRepo, "README.md"), "# drift, edited\n", "utf8");

    const agents = join(temp, "drift-agents.yaml");
    const projects = join(temp, "drift-projects.yaml");
    const rows = {
      "clean-pm": { ...agentRow("clean"), hermes: { ...agentRow("clean").hermes, repo: driftRepo } },
      "dirty-pm": { ...agentRow("dirty"), hermes: { ...agentRow("dirty").hermes, repo: dirtyRepo } },
    };
    writeFileSync(agents, YAML.stringify({ schema_version: 1, agents: rows }), "utf8");
    writeProjectRegistry(projects, ["clean", "dirty"]);
    const data = status(cli([
      "review", "--domain", "release_provenance", "--json",
      "--agent-registry", agents, "--project-registry", projects,
    ]));

    // The template config pins `hermes_git_sha = "0"*40`; a real checkout's HEAD
    // is not that, so the comparison is a PROVEN mismatch rather than a gap.
    // Matched on the summary, not the field: TWO observations carry
    // `hermes.git_sha` -- the row's recorded sha against the pin, and the live
    // checkout's HEAD against the pin -- and only the second is the drift.
    const clean = agentNamed(data, "clean-pm");
    const head = clean.observations.find((item) => /the commit the declared checkout has checked out/u.test(item.summary));
    assert.ok(head, `the live HEAD comparison must be observed, got ${JSON.stringify(clean.observations.map((o) => o.summary.slice(0, 40)))}`);
    assert.equal(head.state, "fail", `a proven HEAD mismatch must be a fail, not a warn: got ${head.state}`);

    // The domain ROLLS UP to `unobserved`, not `fail` -- a fresh `git init` has
    // no origin remote, so `hermes.git_url` is unobserved and `unobserved`
    // outranks `fail` in the declared precedence. That is correct, and it is why
    // the fail has to be pinned in the COUNTS rather than in the rollup.
    const domain = data.domains.find((item) => item.domain === "release_provenance");
    assert.ok(domain, "the selected domain must be emitted");
    assert.ok(domain.counts.fail >= 1, `the domain counts must carry the fail, got ${JSON.stringify(domain.counts)}`);

    // `dirty` -> `fail`, pinned as a DELTA against the clean checkout rather
    // than as an absolute: the same fixture's clean repo must report `pass` for
    // the same comparison, or "some observation is a fail" would be satisfied by
    // the HEAD mismatch both agents share and pin nothing about dirtiness.
    const cleanliness = (agent) => {
      const found = agent.observations.find((item) => /uncommitted changes/u.test(item.summary));
      assert.ok(found, `the working-tree comparison must be observed for ${agent.agent_id}`);
      return found.state;
    };
    assert.equal(cleanliness(clean), "pass", "a committed checkout must report clean");
    assert.equal(cleanliness(agentNamed(data, "dirty-pm")), "fail", "a dirty declared checkout must be a fail");

    assert.equal(data.health.healthy, false, "proven drift must make the fleet unhealthy");
    assert.ok(data.health.failed >= 1, "and it must be counted");

    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  check("no invocation in this suite wrote to this repository", () => {
    // The whole-suite half of the zero-write proof. Every `cli()` call already
    // asserts the isolated scratch tree and the tracked contract are untouched;
    // this covers the two surfaces a single invocation cannot be held
    // responsible for -- this repo's own `.git/index` and its top-level
    // direntries -- once, at the end, where an external writer produces ONE
    // clearly-worded failure instead of turning a random case red.
    const after = snapshotShared();
    const changed = [...new Set([...Object.keys(sharedAtStart), ...Object.keys(after)])]
      .filter((key) => sharedAtStart[key] !== after[key]);
    for (const key of changed) console.log(`       ${key}: ${sharedAtStart[key] ?? "<missing>"} -> ${after[key] ?? "<missing>"}`);
    assert.deepEqual(
      changed, [],
      `this repository changed while the suite ran -- either an invocation wrote to it, or a concurrent process in this repo did: ${changed.join(", ")}`,
    );
  });

  // -- Live-source cases: the ONLY ones allowed to skip -----------------------

  check("the real fleet reports every registered agent across all nine domains", () => {
    if (!existsSync(REAL_AGENT_REGISTRY) || !existsSync(REAL_PROJECT_REGISTRY)) {
      skipCase("the real fleet reports every registered agent across all nine domains", "the operator's live registries are not on this host");
    }
    const registered = Object.keys(YAML.parse(readFileSync(REAL_AGENT_REGISTRY, "utf8"))?.agents ?? {});
    if (registered.length === 0) skipCase("the real fleet reports every registered agent across all nine domains", "the live registry declares no agents");
    const result = spawnSync(process.execPath, [CLI, "review", "--json"], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, `the live fleet must report at exit 0: ${result.stderr}`);
    const data = JSON.parse(result.stdout).data;
    assert.deepEqual(data.agents.map((agent) => agent.agent_id).sort(), [...registered].sort());
    assert.equal(data.scope.total_registered_agents, registered.length);
    for (const agent of data.agents) {
      assert.deepEqual(Object.keys(agent.domains).sort(), [...DOMAINS].sort());
    }
  });

  check("the real audit CLI, spawned as a child, feeds the live fleet's domains", () => {
    if (!existsSync(REAL_AGENT_REGISTRY) || !existsSync(REAL_PROJECT_REGISTRY)) {
      skipCase("the real audit CLI, spawned as a child, feeds the live fleet's domains", "the operator's live registries are not on this host");
    }
    // No shim: this is the real `dist/index.js audit` path, on the real fleet.
    const result = spawnSync(process.execPath, [CLI, "review", "--live", "--json"], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, `a live run must exit 0: ${result.stderr}`);
    const data = JSON.parse(result.stdout).data;
    assert.ok(data.totals.audits_attempted > 0, "a live run must spawn audit children");
    assert.equal(data.totals.audits_observed, data.totals.audits_attempted, "every real audit child must return a parseable report");
    const hostIds = data.host.map((finding) => finding.rule_id);
    assert.equal(new Set(hostIds).size, hostIds.length, "the host block must be deduped by rule id");
    assert.ok(hostIds.length > 0, "the live audit declares host-scoped rules; they must reach data.host");
  });
} catch (error) {
  if (!(error instanceof SkipCase)) throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(shimRoot, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} fleet status check(s) failed`);
  process.exit(1);
}
console.log(`fleet status regressions passed${skipped ? ` (${skipped} skipped)` : ""}`);
