// PJAN Epic 1 / Story 1.5: partial health that is truthful and actionable.
//
// Story 1.4 reports WHAT every domain observed. It cannot say whether the answer
// is TRUSTWORTHY or ACTIONABLE, and the two failures are separate:
//
//   1. AN AGGREGATE THAT CLAIMS HEALTH OVER AN UNREAD FLEET. `health.healthy` is
//      `fail === 0 && error === 0`, so a run in which three of nine domains have
//      no observer at all and every audit-fed domain is `unobserved` still reads
//      `healthy: true`. Nothing declared which gaps were AUTHORIZED: three
//      `unsupported` literals in source authorized themselves.
//   2. FINDINGS NOBODY CAN ACT ON. An observation carried no severity, no
//      observed-versus-desired pair, no repair class and no next action, and the
//      command exited 0 on every collected result -- so a machine client had to
//      parse prose to decide what to do.
//
// The bar, carried from story 1.4 and its two review passes:
//
//   * Every case runs the REAL built `dist/index.js` in a real subprocess.
//   * stdout is asserted non-empty and parseable BEFORE anything is asserted
//     about its content.
//   * Every invocation is bracketed by a content+mtime snapshot of the scratch
//     tree and the tracked contract.
//   * HOST-INDEPENDENT END TO END. DW-54 is the lesson: story 1.3's suite threw
//     `SkipSuite` for its whole body when a live source was absent, so on a
//     fresh clone nothing was verified. Every source here -- registries,
//     repositories, profiles, the hermes release checkout, the tracked template
//     submodule, the fleet contract and the audit report -- is CONSTRUCTED by
//     this file. There is no skip in it except the one for an unbuilt `dist/`.
//   * A verdict is pinned by a DELTA wherever an absolute assertion could be
//     satisfied by the fixture's own unrelated state. Story 1.4's review found
//     three assertions that could not fail; the pattern is copied deliberately.
//
// FRESHNESS AND THE CLOCK. Freshness is emitted as a bucket, never as an age, so
// two runs milliseconds apart bucket identically -- unless a day boundary falls
// between them. Every timestamp this suite writes is therefore FAR from its
// threshold: the current side is written at suite start (zero days old against a
// 180-day window) and the stale side is the year 2000. Nothing here is ever
// within a day of flipping.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import YAML from "yaml";
import {
  deferredAgentUnits,
  installFakeSystemctl,
  mergeUnitSets,
  noBusIsolation,
  setFakeSystemctlState,
  sharedGatewayUnits,
} from "./helpers/fake-systemctl.mjs";

const ROOT = resolve(import.meta.dirname, "..");
// The workspace that owns the CLI. `dist/` lives under the package; the handbook
// and the job-description template stay at the repo root.
const PKG = join(ROOT, "packages", "flume-hr");
const CLI = join(PKG, "dist", "index.js");
const TRACKED_CONTRACT = join(ROOT, "contracts", "handbook.yaml");

/** The four axes story 1.5 adds, spelled out so a silent narrowing in source fails a test. */
const APPLICABILITIES = ["required", "optional", "not_applicable", "deferred", "exception"];
const EVIDENCE = ["direct", "declared", "derived", "absent"];
const FRESHNESS = ["current", "stale", "unknown", "not_applicable"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const REPAIRS = ["automatic", "approval-gated", "blocked", "other-owner", "manual", "none"];
const VERDICTS = ["healthy", "unhealthy", "unproven"];
const EXIT_CATEGORIES = ["ok", "unhealthy", "incomplete"];
const MEMBER_CLASSES = ["healthy", "unhealthy", "incomplete", "deferred", "exception", "unclassified"];
/** Mirrors FLEET_STATUS_MEMBER_PRECEDENCE. Its ORDER is behaviour, not decoration. */
const MEMBER_PRECEDENCE = ["unclassified", "unhealthy", "exception", "deferred", "incomplete", "healthy"];
const ACTIVATION_STATES = ["discovered", "installed", "healthy", "routing_ready", "activated"];
const TRANSITION_KINDS = ["appeared", "resolved", "state_changed", "severity_changed", "evidence_changed"];
/** Mirrors FLEET_STATUS_EXIT_CODES in src/fleet/types.ts. */
const EXIT_CODES = { ok: 0, unhealthy: 10, incomplete: 11 };
/** Mirrors FLEET_STATUS_MAX_TRANSITIONS in src/fleet/types.ts. */
const MAX_TRANSITIONS = 2000;
const DATA_KEYS = [
  "contract_path", "contract_version", "scope",
  "totals", "health", "agents", "domains", "host", "findings", "probes", "transitions", "scaffold", "truncated",
];

const temp = mkdtempSync(join(tmpdir(), "fleet-health-"));
/**
 * Where injected CLI entries live and record what they saw.
 *
 * Deliberately OUTSIDE `temp`: every invocation asserts `temp` is byte-identical
 * before and after, so a shim writing its own bookkeeping inside it would be
 * indistinguishable from the command under test writing there.
 */
const shimRoot = mkdtempSync(join(tmpdir(), "fleet-health-shims-"));

let failures = 0;
let skipped = 0;

class SkipCase extends Error {}

function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP ${label}: ${reason}`);
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
// A synthetic fleet, and a synthetic PACKAGE ROOT for it to be observed from
// ---------------------------------------------------------------------------

const GIT_IDENTITY = ["-c", "user.email=suite@invalid", "-c", "user.name=Suite", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

function git(cwd, args) {
  return spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
}

const TEMPLATE_REMOTE = "https://github.com/delorenj/hermes-agent.git";
const HERMES_REMOTE = "https://github.com/delorenj/hermes-agent.git";

/**
 * The tracked template at its COMMITTED gitlink, read once through git objects.
 *
 * Story 1.6's scaffold observer compares every managed role directory against
 * the template the package root pins, so a synthetic role carrying only
 * `role.yaml` reads as fifty missing assets. The story's rule is to fix the
 * FIXTURE, never to weaken the observer: the fixture package root gets a
 * template submodule whose tree IS the pinned tree, and every synthetic role is
 * rendered from it. The bytes come from `git show <gitlink>:<path>`, never from
 * the submodule worktree, for the same reason the observer reads objects.
 */
const PINNED_TEMPLATE = (() => {
  const submodule = join(ROOT, "templates", "hermes-agent");
  const gitlink = /([0-9a-f]{40})/u.exec(git(ROOT, ["ls-tree", "HEAD", "--", "templates/hermes-agent"]).stdout)?.[1];
  if (!gitlink) return null;
  const listed = git(submodule, ["ls-tree", "-r", "-z", gitlink, "--", "template"]);
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

/** The canonical renderer's bytes at the committed gitlink, read through git objects and never from the worktree. */
const PINNED_RENDERER = PINNED_TEMPLATE
  ? spawnSync("git", ["show", `${PINNED_TEMPLATE.gitlink}:scripts/hermes-profile-config.py`], { cwd: join(ROOT, "templates", "hermes-agent"), encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }).stdout
  : null;

/** Write the pinned template's tree, unrendered, into a fixture submodule. */
function writePinnedTemplateTree(submodule) {
  assert.ok(PINNED_TEMPLATE, "the tracked template must be readable at its committed gitlink for the fixture to have one");
  for (const file of PINNED_TEMPLATE.files) {
    const full = join(submodule, "template", ...file.path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, file.bytes);
    chmodSync(full, file.mode === "100755" ? 0o755 : 0o644);
  }
}

/**
 * Render the pinned template into a role directory as the fanout would: the
 * five simple substitutions the manifest declares, `.jinja` stripped,
 * presence-only files written as-is, modes from the tree.
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

/**
 * A relocated package root, so the FLEET-SCOPED template facts are this suite's.
 *
 * `resolveFlumeRoot()` walks up from the running `dist/index.js` for a
 * `package.json` beside `templates/hermes-agent/copier.yml`, and the provenance
 * core then reads `templates/hermes-agent` out of that root: its committed
 * gitlink, the URL `.gitmodules` declares, and whether its worktree is clean.
 *
 * Run from THIS checkout those three facts describe the operator's machine --
 * and `git status --porcelain` under a probe environment with `GIT_CONFIG_GLOBAL`
 * stripped reports untracked files a global excludes file would have hidden, so
 * the "clean" fact is host state wearing a fleet-fact's name. MEASURED: the same
 * submodule read clean through this repo's own git and dirty through the probe.
 *
 * So the suite builds its own root with its own template submodule, committed
 * clean, and every template fact then describes something this file created.
 */
function makePackageRoot(name, contractText) {
  const root = join(temp, name);
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "contracts"), { recursive: true });
  cpSync(CLI, join(root, "dist", "index.js"));
  // The bundle keeps its runtime dependencies external, so a relocated
  // `dist/index.js` needs a `node_modules` to resolve them from. A SYMLINK, not
  // a copy: `snapshotTree` records a link by its target and never descends, so
  // the zero-write proof stays cheap and this suite never walks a dependency
  // tree it does not own.
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "flume-fixture", version: "0.0.0", type: "module" }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "contracts", "handbook.yaml"), contractText, "utf8");

  const submodule = join(root, "templates", "hermes-agent");
  // The pinned template's own tree, so story 1.6's scaffold observer has the
  // real manifest to compare against and the roles `makeRepo` renders from
  // that same tree read clean whichever build observes them -- this fixture's
  // or the repository's own. The fixture is made scaffold-clean rather than
  // the observer being weakened: `cleanRoot` has to stay `proven: true` for
  // the right reason.
  mkdirSync(join(submodule, "template"), { recursive: true });
  writeFileSync(join(submodule, "README.md"), "# hermes-agent fixture\n", "utf8");
  // The root marker `resolveFlumeRoot` walks up for. It lives at the template's
  // own root, exactly as it does in the real submodule, and it is committed with
  // the rest so the worktree still reads clean.
  writeFileSync(join(submodule, "copier.yml"), "# fixture\n", "utf8");
  writePinnedTemplateTree(submodule);
  // The REAL renderer at the gitlink (story 1.7): the profile observer proves
  // its worktree bytes against the pinned tree before it spawns, so the
  // fixture submodule must carry the canonical script beside the lock helper
  // the template tree already holds under `.scripts/lib/`.
  assert.ok(PINNED_RENDERER, "the tracked template must carry scripts/hermes-profile-config.py at its committed gitlink");
  mkdirSync(join(submodule, "scripts"), { recursive: true });
  writeFileSync(join(submodule, "scripts", "hermes-profile-config.py"), PINNED_RENDERER);
  chmodSync(join(submodule, "scripts", "hermes-profile-config.py"), 0o755);
  assert.equal(git(submodule, ["init", "--quiet"]).status, 0);
  assert.equal(git(submodule, ["add", "-A"]).status, 0);
  assert.equal(git(submodule, ["commit", "--quiet", "-m", "template"]).status, 0);
  assert.equal(git(submodule, ["remote", "add", "origin", TEMPLATE_REMOTE]).status, 0);

  writeFileSync(join(root, ".gitmodules"), [
    '[submodule "templates/hermes-agent"]',
    "\tpath = templates/hermes-agent",
    `\turl = ${TEMPLATE_REMOTE}`,
    "",
  ].join("\n"), "utf8");
  assert.equal(git(root, ["init", "--quiet"]).status, 0);
  // `add` on a directory that carries its own `.git` stages a MODE 160000
  // gitlink, which is exactly what `git ls-files --stage` has to answer with for
  // `template.gitlink` to have a desired side at all.
  git(root, ["add", ".gitmodules", "templates/hermes-agent"]);
  const staged = git(root, ["ls-files", "--stage", "--", "templates/hermes-agent"]).stdout;
  assert.match(staged, /^160000 [0-9a-f]{40} 0\t/u, `the fixture root must stage a gitlink, got ${JSON.stringify(staged)}`);
  // COMMITTED, not merely staged. The scaffold observer reads the gitlink out
  // of HEAD and refuses a staged-but-uncommitted pin as `gitlink-unstable`,
  // which is correct and would make every fixture agent incomplete.
  assert.equal(git(root, ["commit", "--quiet", "-m", "pin the fixture template"]).status, 0, "the fixture root must commit its gitlink");
  return root;
}

/** A real hermes release checkout: an executable, an origin remote, and a known HEAD. */
function makeRelease(home) {
  const release = join(home, ".local", "share", "hermes-agent", "releases", "abc");
  mkdirSync(join(release, "bin"), { recursive: true });
  writeFileSync(join(release, "bin", "hermes"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(release, "bin", "hermes"), 0o755);
  assert.equal(git(release, ["init", "--quiet"]).status, 0);
  writeFileSync(join(release, "README.md"), "# hermes\n", "utf8");
  assert.equal(git(release, ["add", "-A"]).status, 0);
  assert.equal(git(release, ["commit", "--quiet", "-m", "release"]).status, 0);
  assert.equal(git(release, ["remote", "add", "origin", HERMES_REMOTE]).status, 0);
  const sha = git(release, ["rev-parse", "HEAD"]).stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/u);
  return { release, sha };
}

/** A repository with a role scaffold rendered from the pinned template, an ignored runtime directory and a `.project.json`. */
function makeRepo(reposRoot, slug) {
  const dir = join(reposRoot, slug);
  const role = join(dir, "agents", "hermes", "pm");
  mkdirSync(join(role, "runtime"), { recursive: true });
  renderPinnedRole(role, { agent_id: `${slug}-pm`, role: "pm", target_repo: slug, display_name: `${slug} PM`, ticket_provider: "plane" });
  // The reconcile block is EXPLICIT (story 1.8): `enabled: false` without
  // `explicit_opt_out` is a `reconcile-opt-out-undeclared` warn on the
  // heartbeat leaf, and a warn without a policy ruling blocks `proven`.
  writeFileSync(join(role, "role.yaml"), YAML.stringify({ role: "pm", reconcile: { enabled: false, explicit_opt_out: true } }), "utf8");
  writeFileSync(join(dir, ".project.json"), `${JSON.stringify({
    project_slug: slug,
    ticket_provider: { type: "plane", workspace: "suite", identifier: slug.toUpperCase(), board_id: `board-${slug}` },
  }, null, 2)}\n`, "utf8");
  assert.equal(git(dir, ["init", "--quiet"]).status, 0);
  writeFileSync(join(dir, "README.md"), `# ${slug}\n`, "utf8");
  assert.equal(git(dir, ["add", "-A"]).status, 0);
  assert.equal(git(dir, ["commit", "--quiet", "-m", "seed"]).status, 0);
  return dir;
}

/** ISO instants FAR from every declared threshold. See the freshness note at the top. */
const NOW_ISO = new Date().toISOString();
const ANCIENT_ISO = "2000-01-01T00:00:00.000Z";

const scratchHome = join(temp, "home");
const reposRoot = join(temp, "repos");
const workdir = join(temp, "work");

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

const SLUGS = ["alpha", "beta"];

let RELEASE = "";
let RELEASE_SHA = "";

function agentRow(slug, overrides = {}) {
  const row = {
    repo: slug,
    role: "pm",
    display_name: `${slug} PM`,
    project_path: join(reposRoot, slug),
    role_dir: join(reposRoot, slug, "agents", "hermes", "pm"),
    profile_name: `${slug}-pm`,
    provisioned_at: NOW_ISO,
    plane: { workspace: "suite", project_id: `board-${slug}`, identifier: slug.toUpperCase() },
    bloodbank: { enabled: false, gateway_scope: "fleet", target_agent_id: `${slug}-pm` },
    systemd: {
      gateway_unit: `hermes-${slug}-pm-gateway.service`,
      heartbeat_timer: `hermes-${slug}-pm-heartbeat.timer`,
    },
    // The canonical DEFERRED declaration (story 1.8): the shape that is healthy
    // without a channel credential, and the one `70-systemd.sh` provisions when
    // no platform is verified.
    telegram: { provisioning_status: "disabled" },
    slack: { provisioning_status: "disabled" },
    hermes: {
      bin: join(RELEASE, "bin", "hermes"),
      repo: RELEASE,
      fleet_env: join(scratchHome, ".hermes", "fleet.env"),
      git_url: HERMES_REMOTE,
      git_ref: "main",
      git_sha: RELEASE_SHA,
    },
  };
  return { ...row, ...overrides };
}

function writeAgentRegistry(path, slugs, mutate = () => {}) {
  const agents = {};
  for (const slug of slugs) agents[`${slug}-pm`] = agentRow(slug);
  mutate(agents);
  writeFileSync(path, YAML.stringify({ schema_version: 1, gateways: GATEWAYS_BLOCK, agents }), "utf8");
  return path;
}

// The fleet-shared Bloodbank gateway block the live registry carries. Story 1.8
// correlates `gateways.bloodbank.systemd_unit` against the contract's own
// `service_model.fleet_shared.bloodbank_gateway_unit`.
const GATEWAYS_BLOCK = {
  bloodbank: {
    scope: "fleet",
    profile_name: "fleet-bloodbank-gateway",
    command_subject: "bloodbank.cmd.agent.invocation.start",
    target_field: "data.target_agent_id",
    systemd_unit: "hermes-fleet-bloodbank-gateway.service",
  },
};

function writeProjectRegistry(path, slugs, confirmedAt = () => NOW_ISO) {
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
        board_confirmed_at: confirmedAt(slug),
        identifier_fetched_at: NOW_ISO,
      },
    };
  }
  writeFileSync(path, YAML.stringify({ schema_version: 1, projects }), "utf8");
  return path;
}

function seedScratch() {
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(scratchHome, ".hermes", "profiles"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "hermes-agent-template"), { recursive: true });

  const made = makeRelease(scratchHome);
  RELEASE = made.release;
  RELEASE_SHA = made.sha;

  seedProfileFixtures(scratchHome);
  for (const slug of SLUGS) {
    makeRepo(reposRoot, slug);
    seedRendererCleanProfile(scratchHome, `${slug}-pm`);
  }

  writeAgentRegistry(join(scratchHome, ".hermes", "agents-registry.yaml"), SLUGS);
  writeProjectRegistry(join(scratchHome, ".config", "pjangler", "projects.yaml"), SLUGS);

  installFakeSystemctl(systemctlShim, canonicalSystemdState());

  writeFileSync(join(scratchHome, ".config", "hermes-agent-template", "config.toml"), [
    "[fleet]",
    `hermes_bin = "${join(RELEASE, "bin", "hermes")}"`,
    `hermes_repo = "${RELEASE}"`,
    `hermes_git_url = "${HERMES_REMOTE}"`,
    'hermes_git_ref = "main"',
    `hermes_git_sha = "${RELEASE_SHA}"`,
    // DECLARED, so `hermes.fleet_env` MATCHES rather than warning. The first
    // cut authorized that warning under `allowed_warnings` instead, which made
    // every agent carry a gap that is not a deferral and put the `deferred`
    // member bucket permanently out of reach -- authorizing a fixture's own
    // incompleteness is not the same as fixing it.
    `fleet_env = "${join(scratchHome, ".hermes", "fleet.env")}"`,
    `registry_file = "${join(scratchHome, ".hermes", "agents-registry.yaml")}"`,
    "",
  ].join("\n"), "utf8");

  writeFileSync(join(scratchHome, ".hermes", "fleet.env"), [
    `HERMES_FLEET_HOME=${join(scratchHome, ".hermes")}`,
    `HERMES_FLEET_BIN=${join(RELEASE, "bin", "hermes")}`,
    `HERMES_FLEET_REPO=${RELEASE}`,
    `HERMES_FLEET_REGISTRY_FILE=${join(scratchHome, ".hermes", "agents-registry.yaml")}`,
    "",
  ].join("\n"), "utf8");
}

/**
 * The scripted user manager every case in this suite observes.
 *
 * Story 1.8 made `systemd` an OBSERVED domain in every scope, so a suite whose
 * whole subject is "when may this fleet claim proof" has to seed the fleet's
 * service state -- exactly as story 1.7 made every fixture profile
 * renderer-clean. The state below is one canonical DEFERRED triple per agent
 * plus the fleet-shared gateway.
 */
const systemctlShim = join(shimRoot, "systemctl-bin");
function canonicalSystemdState() {
  const profileRoot = join(scratchHome, ".hermes", "profiles");
  const hermesBin = join(RELEASE, "bin", "hermes");
  return mergeUnitSets(
    { manager: { stdout: "running", exit: 0 } },
    ...SLUGS.map((slug) => deferredAgentUnits({
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
  // Git does its own housekeeping — auto-gc, repack, commit-graph,
  // multi-pack-index — on a schedule it decides, and it rewrites `.git/objects`
  // when it does. `snapshotTree` digests every path under the protected roots,
  // `.git` included, so a repack triggered by a child's ordinary `git` call
  // reads as "the CLI wrote to a protected root" and fails a case that has
  // nothing to do with it. It never fires on this box (the submodule is already
  // packed) and always fires in CI, where a fresh clone plus `npm pack` leaves
  // enough loose objects to cross the gc threshold — which is why CI has been
  // red since 2026-09-02 while every local run was green. Turn the housekeeping
  // off rather than stop watching `.git`: the guard keeps its teeth.
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
  // Story 1.8: `systemctl` resolves to the scripted manager above, and the bus
  // address and runtime dir point at nothing -- so a case that bypasses the
  // shim reads `manager-unavailable` rather than this developer's own user
  // manager, where a fixture agent's units do not exist and never will.
  PATH: `${systemctlShim}:${process.env.PATH}`,
  ...noBusIsolation(temp),
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

/**
 * The surfaces a difference is ATTRIBUTABLE to the command under test.
 *
 * This suite's own isolated scratch tree -- which holds every registry, every
 * repository, both git checkouts and the fixture package roots -- and the
 * TRACKED contract, which nothing in this suite should ever touch. Deliberately
 * not this repository's `.git/index`: DW-70 records that the machine runs
 * parallel agents by design, so a change there is not attributable to one
 * invocation. Every path this suite actually exercises is under `temp`.
 */
function snapshotIsolated() {
  const entries = {};
  snapshotTree("temp", temp, entries);
  snapshotTree("contracts", join(ROOT, "contracts"), entries);
  return entries;
}

/** Run the built CLI and prove the run wrote nothing to a protected root. */
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
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => before[key] !== after[key]);
    for (const key of changed) console.log(`       ${key}: ${before[key] ?? "<missing>"} -> ${after[key] ?? "<missing>"}`);
    assert.fail(`pj ${args.join(" ")} wrote to a protected root: ${changed.join(", ")}`);
  }
  return result;
}

/** Run the CLI shipped INSIDE a fixture package root, so its own template facts apply. */
function cliAt(packageRoot, args, extraEnv = {}) {
  const before = snapshotIsolated();
  const result = spawnSync(process.execPath, [join(packageRoot, "dist", "index.js"), ...args], {
    cwd: workdir,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...isolation, ...extraEnv },
  });
  const after = snapshotIsolated();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => before[key] !== after[key]);
    for (const key of changed) console.log(`       ${key}: ${before[key] ?? "<missing>"} -> ${after[key] ?? "<missing>"}`);
    assert.fail(`fixture pj ${args.join(" ")} wrote to a protected root: ${changed.join(", ")}`);
  }
  return result;
}

function envelope(result) {
  assert.notEqual(result.stdout, "", "stdout was empty; a passing assertion on empty output proves nothing");
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { assert.fail(`stdout is not one complete JSON document (${result.stdout.length} bytes): ${error.message}`); }
  assert.equal(parsed.schema_version, 1, "envelope schema_version");
  return parsed;
}

function errorCode(parsed) {
  assert.equal(parsed.ok, false, `expected a failure envelope, got ok:true`);
  assert.equal(parsed.data, null, "a failure envelope must carry no data");
  return parsed.error.code;
}

/**
 * A successful status payload, with story 1.5's invariants checked on EVERY one.
 *
 * Checked here rather than in one case, for the reason story 1.4's review
 * recorded twice: an axis asserted in a single case is an axis that can go
 * missing on every other path and stay green.
 */
function status(result) {
  const parsed = envelope(result);
  assert.equal(parsed.ok, true, `expected ok:true, got ${JSON.stringify(parsed.error)}`);
  assert.equal(parsed.command, "fleet.status");
  for (const key of DATA_KEYS) assert.notEqual(parsed.data[key], undefined, `data.${key} must be present`);
  const data = parsed.data;

  assert.ok(VERDICTS.includes(data.health.verdict), `unknown verdict ${data.health.verdict}`);
  assert.ok(EXIT_CATEGORIES.includes(data.health.exit_category), `unknown exit category ${data.health.exit_category}`);
  assert.equal(typeof data.health.proven, "boolean");
  assert.deepEqual(Object.keys(data.health.members).sort(), [...MEMBER_CLASSES].sort());

  const everyObservation = [
    ...data.agents.flatMap((agent) => agent.observations),
    ...data.domains.flatMap((rollup) => rollup.observations),
  ];
  for (const observation of everyObservation) {
    assert.ok(APPLICABILITIES.includes(observation.applicability), `unknown applicability ${observation.applicability}`);
    assert.ok(EVIDENCE.includes(observation.evidence), `unknown evidence ${observation.evidence}`);
    assert.ok(FRESHNESS.includes(observation.freshness), `unknown freshness ${observation.freshness}`);
    assert.ok(SEVERITIES.includes(observation.severity), `unknown severity ${observation.severity}`);
    assert.ok(REPAIRS.includes(observation.repair), `unknown repair ${observation.repair}`);
    assert.ok(["read-only", "requires-authorization"].includes(observation.next_action_class));
    if (observation.state === "pass" || observation.state === "skip") continue;
    // AC7, on every non-pass, on every path.
    assert.ok(typeof observation.owner === "string" && observation.owner.length > 0,
      `${observation.domain}/${observation.field} is ${observation.state} and names no owner`);
    assert.ok(typeof observation.observed === "string" && observation.observed.length > 0,
      `${observation.domain}/${observation.field} carries no observed side`);
    assert.ok(typeof observation.desired === "string" && observation.desired.length > 0,
      `${observation.domain}/${observation.field} carries no desired side`);
    assert.ok(typeof observation.next_action === "string" && observation.next_action.length > 0,
      `${observation.domain}/${observation.field} names no next action`);
    // A recommended command is READ-ONLY unless it is labelled, and a labelled
    // one must name the authorization in the string itself.
    if (observation.next_action_class === "requires-authorization") {
      assert.match(observation.next_action, /bloodbank\.enabled/u,
        `a requires-authorization action must name the authorization: ${observation.next_action}`);
    }
  }
  for (const finding of data.host) {
    assert.ok(SEVERITIES.includes(finding.severity), `unknown host severity ${finding.severity}`);
    assert.ok(REPAIRS.includes(finding.repair), `unknown host repair ${finding.repair}`);
    if (finding.state === "pass" || finding.state === "skip") continue;
    assert.ok(typeof finding.owner === "string" && finding.owner.length > 0, `host ${finding.rule_id} names no owner`);
    assert.ok(typeof finding.next_action === "string" && finding.next_action.length > 0, `host ${finding.rule_id} names no next action`);
  }
  return data;
}

function agentNamed(data, id) {
  const found = data.agents.find((agent) => agent.agent_id === id);
  assert.ok(found, `agent ${id} must be in data.agents`);
  return found;
}

function observationsOf(data) {
  return [
    ...data.agents.flatMap((agent) => agent.observations),
    ...data.domains.flatMap((rollup) => rollup.observations),
  ];
}

// ---------------------------------------------------------------------------
// Contract variants: the only thing that can AUTHORIZE a gap
// ---------------------------------------------------------------------------

const TRACKED_TEXT = readFileSync(TRACKED_CONTRACT, "utf8");

function contractDocument() {
  return YAML.parse(TRACKED_TEXT);
}

function writeContract(name, document) {
  const path = join(temp, `contract-${name}.yaml`);
  writeFileSync(path, YAML.stringify(document, { lineWidth: 0 }), "utf8");
  return path;
}

/**
 * Warnings this SYNTHETIC fleet raises that belong to the fixture.
 *
 * EMPTY, and that is the point. The first cut authorized `hermes.fleet_env` and
 * `fleet.registry_file` here, because the fixture's template config declared
 * neither value to compare against. That worked and it was the wrong fix: an
 * authorized warning is still a GAP, so every agent carried one, and
 * `classifyMember`'s `deferred` arm -- which requires every gap to be a
 * declared deferral -- became unreachable. The fixture now DECLARES both
 * values, so the facts match and there is nothing to authorize.
 *
 * Left as a named empty list rather than deleted: the next fixture warning
 * should land here and be argued about, not be quietly added to the tracked
 * contract.
 */
const FIXTURE_WARNINGS = [];

/** The tracked policy plus the fixture's own authorizations. */
function policyContract(mutate = () => {}) {
  const document = contractDocument();
  document.health_policy.allowed_warnings = [...document.health_policy.allowed_warnings, ...FIXTURE_WARNINGS];
  mutate(document);
  return document;
}

// ---------------------------------------------------------------------------
// Injected CLI entries: the documented PJ_FLEET_CLI_ENTRY observation seam
// ---------------------------------------------------------------------------

function entry(name, body) {
  const dir = join(shimRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "entry.mjs");
  writeFileSync(path, body, "utf8");
  return path;
}

const RECORD_PREAMBLE = `
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.argv[3] ?? "";
appendFileSync(join(HERE, "invocations"), REPO + "\\n");
`;

// `dirname`, not a hardcoded separator. This repo ships
// `portable-test-paths-regressions` specifically to keep suites off literal
// paths, and a suite that slices on "/" is the same class of assumption one
// layer down.
function invocationsOf(entryPath) {
  const file = join(dirname(entryPath), "invocations");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function resetEntry(entryPath) {
  rmSync(join(dirname(entryPath), "invocations"), { force: true });
}

function syntheticReport(rules) {
  return `${RECORD_PREAMBLE}
const rules = ${JSON.stringify(rules)};
const report = {
  repo: REPO,
  ok: rules.every((rule) => !(rule.status === "fail" && rule.scope !== "host")),
  hostOk: rules.every((rule) => rule.scope !== "host" || rule.status === "pass" || rule.status === "skip"),
  auditedAt: new Date().toISOString(),
  rules,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
process.exit(report.ok ? 0 : 1);
`;
}

const RULE = {
  scaffoldPass: { id: "hermes.pm-scaffold", title: "Scaffold parity", status: "pass", summary: "scaffold parity verified", details: [], fixable: true, scope: "project" },
  scaffoldFail: { id: "hermes.pm-scaffold", title: "Scaffold parity", status: "fail", summary: "18 orchestrator scaffold issue(s) detected", details: ["stale agents/hermes/pm/hermes"], fixable: true, scope: "project" },
  bindingPass: { id: "sot.project-json", title: "Project identity", status: "pass", summary: "identity parity verified", details: [], fixable: false, scope: "project" },
  profilePass: { id: "hermes.runtime-singleton", title: "Singleton runtime", status: "pass", summary: "singleton runtime contract satisfied", details: [], fixable: true, scope: "project" },
  runtimePass: { id: "hermes.untracked-runtimes", title: "Untracked runtimes", status: "pass", summary: "runtimes are untracked", details: [], fixable: true, scope: "project" },
  notebookSkip: { id: "notebook.remote-notebook", title: "Remote notebook", status: "skip", summary: "remote notebook was not observed", details: [], fixable: false, scope: "project" },
  bmadWarn: { id: "bmad.version", title: "BMAD currency", status: "warn", summary: "a newer BMAD release is published", details: [], fixable: false, scope: "project" },
  hostFail: { id: "hermes.profile-wiring", title: "Hermes profile wiring", status: "fail", summary: "the shared profile root is wired to the wrong home", details: [], fixable: false, scope: "host" },
};

/**
 * Every audit-fed domain answered, so nothing is left `unobserved`.
 *
 * Plus one declared SKIP, which the tracked contract's `allowed_skips`
 * authorizes. It is what the authorization deltas below remove -- and a skip is
 * deliberately not a `gap` for member purposes, so adding it here does not put
 * the `deferred` bucket out of reach the way an authorized WARNING would.
 */
const CLEAN_RULES = [RULE.scaffoldPass, RULE.bindingPass, RULE.profilePass, RULE.runtimePass, RULE.notebookSkip];

console.log("fleet health: four axes, one policy, one verdict a machine can act on");

try {
  if (!existsSync(CLI)) {
    skip("the whole suite", "dist/index.js is not built; run `npm run build` first");
    throw new SkipCase("unbuilt");
  }
  seedScratch();

  const cleanContract = writeContract("clean", policyContract());
  const cleanRoot = makePackageRoot("pkg-clean", readFileSync(cleanContract, "utf8"));
  const cleanShim = entry("clean", syntheticReport(CLEAN_RULES));

  // -- AC1 / AC2: the two verdicts are independent -------------------------

  check("a fully observed, fully authorized fleet is healthy, proven, and exit_category ok", () => {
    resetEntry(cleanShim);
    const result = cliAt(cleanRoot, ["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim });
    assert.equal(result.status, 0, `a proven fleet must exit 0: ${result.stderr}`);
    const data = status(result);
    assert.equal(data.health.unobserved, 0, `nothing may be left unobserved: ${JSON.stringify(data.health)}`);
    assert.equal(data.health.healthy, true, "no observation may fail");
    assert.equal(data.health.complete, true);
    assert.equal(data.health.fleet_complete, true);
    assert.equal(data.health.unjustified, 0, "every non-pass must be authorized by the contract");
    assert.equal(data.health.stale, 0);
    assert.equal(data.health.verdict, "healthy");
    assert.equal(data.health.proven, true);
    assert.equal(data.health.exit_category, "ok");
    for (const observation of observationsOf(data)) {
      assert.notEqual(observation.applicability, undefined);
      assert.notEqual(observation.evidence, undefined);
      assert.notEqual(observation.freshness, undefined);
    }
  });

  check("removing ONE policy entry makes the fleet unproven and leaves health.healthy untouched", () => {
    // A DELTA against the case above, on the identical fleet: the only change is
    // one `allowed_warnings` entry. An absolute assertion here would be
    // satisfied by any of the fixture's other states.
    const provenData = (() => {
      resetEntry(cleanShim);
      return status(cliAt(cleanRoot, ["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));
    })();

    const narrowed = writeContract("one-authorization-removed", policyContract((document) => {
      document.health_policy.allowed_skips = document.health_policy.allowed_skips
        .filter((entryItem) => entryItem.rule_id !== "notebook.remote-notebook");
    }));
    const narrowedRoot = makePackageRoot("pkg-one-authorization-removed", readFileSync(narrowed, "utf8"));
    resetEntry(cleanShim);
    const data = status(cliAt(narrowedRoot, ["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));

    assert.ok(data.health.unjustified >= 1, "the un-authorized warning must be counted as unjustified");
    assert.equal(data.health.proven, false, "an unjustified non-pass blocks proof");
    assert.equal(data.health.verdict, "unproven");
    assert.equal(data.health.exit_category, "incomplete");
    // THE POINT OF THE CASE: the two verdicts are independent.
    assert.equal(data.health.healthy, provenData.health.healthy, "health.healthy must be unchanged by an authorization change");
    assert.equal(data.health.healthy, true);
    assert.equal(data.health.failed, provenData.health.failed);
    const orphan = observationsOf(data).find((item) => item.rule_id === "notebook.remote-notebook");
    assert.ok(orphan, "the skip must still be reported");
    assert.equal(orphan.state, "skip", "the state is identical; only the authorization moved");
    assert.equal(orphan.justification, null, "and it must now carry no justification");
    assert.equal(orphan.severity, "medium", "an unjustified skip on a required domain is medium; a justified one is info");
  });

  // -- AC3: a contract with no health_policy at all -------------------------

  check("a contract with no health_policy loads, validates, and authorizes nothing", () => {
    const bare = writeContract("no-policy", (() => {
      const document = contractDocument();
      delete document.health_policy;
      // Back to schema 1 as well: `health_policy` is a root key and a new root
      // key is a grammar change, so a contract without it is a schema-1
      // contract and must still load on this build.
      document.schema_version = 1;
      document.compatibility.max_schema_version = 1;
      return document;
    })());

    const validated = envelope(cli(["handbook", "validate", "--contract", bare, "--json"]));
    assert.equal(validated.ok, true, `a schema-1 contract must still validate: ${JSON.stringify(validated.error)}`);
    assert.equal(validated.data.schema_version, 1);

    const bareRoot = makePackageRoot("pkg-no-policy", readFileSync(bare, "utf8"));
    resetEntry(cleanShim);
    const data = status(cliAt(bareRoot, ["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));
    assert.equal(data.health.proven, false, "a contract that authorizes nothing cannot produce a proven fleet");
    assert.ok(data.health.unjustified > 0, "every non-pass must be unjustified");
    for (const observation of observationsOf(data)) {
      if (!["warn", "skip", "unsupported"].includes(observation.state)) continue;
      assert.equal(observation.justification, null, `${observation.field} was justified by a contract that declares no policy`);
    }
    const finding = data.findings.find((item) => item.code === "health-policy-undeclared");
    assert.ok(finding, "a missing policy block must be named by a finding rather than failing the run");
    assert.match(finding.detail, /health_policy/u);
    assert.equal(finding.gating, true, "and it must be one of the reasons proof cannot be claimed");
  });

  // -- AC: deferred capabilities, declared and undeclared -------------------

  // `live_process`, not `systemd`: story 1.8 ANSWERED the `unit_topology`
  // deferral, so systemd is now an observed domain and can no longer stand for
  // "a capability no observer in this release can answer". Process attribution
  // (story 1.9) is the remaining one that still can.
  check("a contract-declared deferred capability is blocked, named, and does not reduce proof", () => {
    resetEntry(cleanShim);
    const data = status(cliAt(cleanRoot, ["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));
    const deferred = agentNamed(data, "alpha-pm").observations.find((item) => item.domain === "live_process");
    assert.ok(deferred, "the live_process domain must still appear");
    assert.equal(deferred.state, "unsupported", "the state is unchanged; only the AUTHORIZATION is new");
    assert.equal(deferred.applicability, "deferred");
    assert.equal(deferred.evidence, "absent");
    assert.equal(deferred.repair, "blocked");
    assert.ok(deferred.justification, "a declared deferral must name the entry that authorizes it");
    assert.match(deferred.justification.policy, /^health_policy\.deferred_capabilities\[\d+\]$/u);
    assert.equal(deferred.justification.kind, "deferred_capability");
    assert.equal(deferred.justification.owner, "1.9", "the entry names the story that owns the observer");
    assert.match(deferred.next_action, /1\.9/u, "the next action must name the owning story");
    assert.equal(deferred.next_action_class, "read-only");
    assert.equal(deferred.severity, "low", "a justified unsupported is low");
    assert.equal(data.health.proven, true, "a declared deferral does not reduce proof");
  });

  check("the same capability with the policy entry removed is unjustified and blocks proof", () => {
    const stripped = writeContract("no-live-process-deferral", policyContract((document) => {
      document.health_policy.deferred_capabilities = document.health_policy.deferred_capabilities
        .filter((item) => item.domain !== "live_process");
    }));
    const strippedRoot = makePackageRoot("pkg-no-live-process-deferral", readFileSync(stripped, "utf8"));
    resetEntry(cleanShim);
    const data = status(cliAt(strippedRoot, ["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));
    const deferred = agentNamed(data, "alpha-pm").observations.find((item) => item.domain === "live_process");
    assert.equal(deferred.state, "unsupported", "the same observation, in the same state");
    assert.equal(deferred.justification, null, "and now authorized by nothing");
    assert.notEqual(deferred.applicability, "deferred");
    assert.notEqual(deferred.repair, "blocked", "nothing declares it blocked, so it is not");
    assert.equal(deferred.severity, "medium", "an unjustified unsupported outranks a justified one");
    assert.ok(data.health.unjustified >= 1);
    assert.equal(data.health.proven, false);
    assert.equal(data.health.verdict, "unproven");
  });

  // -- AC5: freshness is a bucket, and exactly one reading is stale ---------

  check("one stale board confirmation is one stale reading, and no age reaches data", () => {
    const agents = join(temp, "fresh-agents.yaml");
    const projects = join(temp, "fresh-projects.yaml");
    writeAgentRegistry(agents, SLUGS);
    // `beta`'s board was confirmed in the year 2000 against a 180-day window and
    // `alpha`'s at suite start: 26 years past the threshold and zero days short
    // of it. Neither is within a day of flipping, which is the constraint a
    // bucketed freshness axis imposes on its own fixtures.
    writeProjectRegistry(projects, SLUGS, (slug) => (slug === "beta" ? ANCIENT_ISO : NOW_ISO));
    const data = status(cli([
      "review", "--json", "--contract", cleanContract,
      "--agent-registry", agents, "--project-registry", projects,
    ]));

    const stale = observationsOf(data).filter((item) => item.freshness === "stale");
    assert.equal(stale.length, 1, `exactly one reading must be stale, got ${stale.map((item) => `${item.agent_id}/${item.domain}`).join(", ")}`);
    assert.equal(stale[0].agent_id, "beta-pm");
    assert.equal(stale[0].domain, "project_binding");
    assert.equal(data.health.stale, 1);
    assert.equal(data.health.proven, false, "stale evidence cannot be proof");
    const alpha = agentNamed(data, "alpha-pm").observations
      .find((item) => item.domain === "project_binding" && item.source === "fleet-inventory");
    assert.equal(alpha.freshness, "current", "the agent inside the window must read current");

    // NO AGE, NO DURATION, NO TIMESTAMP. `data` has to be byte-identical across
    // two runs, and every one of those is what would break it.
    const serialized = JSON.stringify(data);
    assert.doesNotMatch(serialized, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u, "an ISO instant reached data");
    // Whole KEYS, not substrings: `"message"` contains `age` and `"package"`
    // contains it twice, and a scan that fires on either proves nothing about
    // determinism while making every future field name a hazard.
    // `data.systemd.window.interval_ms` is a POLICY constant read straight out
    // of `service_manifest.stabilization` -- the declared distance between two
    // samples, identical on every run on every host -- not an age, a duration
    // this run measured, or anything else that could move between two runs. It
    // is excluded by NAME rather than by loosening the pattern, and pinned to
    // the contract's own value below so it cannot quietly become an observation.
    const ageScan = serialized.replaceAll('"interval_ms":', '"<declared-window>":');
    assert.doesNotMatch(ageScan, /"([a-z_]+_(ms|at|age|seconds)|age|duration|elapsed|timestamp|observed_at)":/u, "an age-shaped key reached data");
    assert.equal(
      data.systemd.window.interval_ms,
      YAML.parse(readFileSync(cleanContract, "utf8")).service_manifest.stabilization.interval_ms,
      "the window is the contract's declared constant, never something this run measured",
    );

    const again = status(cli([
      "review", "--json", "--contract", cleanContract,
      "--agent-registry", agents, "--project-registry", projects,
    ]));
    assert.deepEqual(again, data, "two runs over unchanged state must produce identical data");
    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  // -- AC4: four lifecycle values, and none of them claims activation -------

  check("a row declaring activation reports four separate lifecycle values and never routing-ready", () => {
    const agents = join(temp, "activated-agents.yaml");
    writeAgentRegistry(agents, SLUGS, (rows) => {
      rows["alpha-pm"].bloodbank = { enabled: true, gateway_scope: "fleet", target_agent_id: "alpha-pm" };
      // `beta` declares a routing record with NO activation flag at all, which
      // is the third value the pair `true`/`false` cannot express.
      rows["beta-pm"].bloodbank = { gateway_scope: "fleet", target_agent_id: "beta-pm" };
    });
    const data = status(cli(["review", "--json", "--contract", cleanContract, "--agent-registry", agents]));

    const alpha = agentNamed(data, "alpha-pm");
    assert.deepEqual(Object.keys(alpha.lifecycle).sort(), ["activation", "capability_readiness", "desired_state", "observed_state"]);
    assert.equal(alpha.lifecycle.activation, "granted", "the strict flag is read verbatim");
    assert.equal(alpha.lifecycle.desired_state, "activated", "the registry declares the target");
    assert.equal(alpha.lifecycle.capability_readiness, "unproven", "nothing observed the gateway");
    assert.notEqual(alpha.lifecycle.capability_readiness, "ready");
    // NO FIELD MAY REPORT THE AGENT AS ROUTING-READY OR ACTIVATED. `desired_state`
    // is a statement of intent about the row; `observed_state` is the only field
    // that claims anything about the agent, and it cannot reach either state.
    assert.ok(!["routing_ready", "activated"].includes(alpha.lifecycle.observed_state),
      `observed_state claimed ${alpha.lifecycle.observed_state}`);

    const routing = alpha.observations.find((item) => item.domain === "bloodbank" && item.field === "agents.{agent_id}.bloodbank.gateway_scope");
    assert.ok(routing, "the routing record must be its own observation");
    assert.equal(routing.evidence, "declared", "a registry field nothing verified is declared evidence, never direct");

    const beta = agentNamed(data, "beta-pm");
    assert.equal(beta.lifecycle.activation, "undeclared");
    assert.equal(beta.lifecycle.desired_state, "routing_ready");
    const gate = beta.observations.find((item) => item.field === "agents.{agent_id}.bloodbank.enabled");
    assert.ok(gate, "the execution-authority field must be observed on its own");
    assert.equal(gate.state, "warn");
    assert.equal(gate.repair, "approval-gated", "the contract's own gate field decides the repair class");
    assert.equal(gate.next_action_class, "requires-authorization");
    assert.match(gate.next_action, /agents\.\{agent_id\}\.bloodbank\.enabled/u, "the action must name the authorization");
    assert.match(gate.next_action, /deny/u, "and the default it has to overcome");
    rmSync(agents, { force: true });
  });

  // -- AC6: a contradiction is recorded, never resolved ---------------------

  check("a store read that fails and an audit rule that passes on one field is a contradiction", () => {
    // `beta`'s profile directory is a symlink, which the contract declares
    // illegal and the store read proves. The audit rule for the same field
    // reports `pass`. Both readings are kept.
    const symlinked = join(scratchHome, ".hermes", "profiles", "beta-pm");
    const shared = join(scratchHome, ".hermes", "profiles", "shared-fixture");
    mkdirSync(shared, { recursive: true });
    rmSync(symlinked, { recursive: true, force: true });
    symlinkSync(shared, symlinked);
    try {
      const shim = entry("contradiction", syntheticReport([...CLEAN_RULES]));
      resetEntry(shim);
      const data = status(cli([
        "review", "--live", "--json", "--contract", cleanContract, "--domain", "profile",
      ], { PJ_FLEET_CLI_ENTRY: shim }));

      const beta = agentNamed(data, "beta-pm");
      const readings = beta.observations.filter((item) => item.domain === "profile" && item.field === "agents.{agent_id}.profile_name");
      assert.equal(readings.length, 2, `both readings must be kept, got ${readings.length}`);
      assert.deepEqual([...new Set(readings.map((item) => item.state))].sort(), ["fail", "pass"]);
      assert.deepEqual([...new Set(readings.map((item) => item.source))].sort(), ["fleet-inventory", "recipe-audit"]);
      // The worse state wins the rollup across the two readings, and since
      // story 1.7 the profile observer's four dependent fields behind a failed
      // path gate are `unobserved` -- which outranks `fail` under the declared
      // precedence, so the domain reads unobserved rather than fail. Both
      // readings of the shared field are asserted above; the rollup is not
      // where their contradiction shows.
      assert.equal(beta.domains.profile, "unobserved", "unobserved outranks fail in the rollup: nothing beneath a symlinked profile was read");

      const finding = data.findings.filter((item) => item.code === "status-contradiction");
      assert.equal(finding.length, 1, `exactly one contradiction finding, got ${finding.length}`);
      assert.equal(finding[0].agent_id, "beta-pm");
      assert.equal(finding[0].domain, "profile");
      assert.ok(typeof finding[0].source === "string" && finding[0].source.length > 0, "the finding must name its owner");
      assert.equal(data.health.contradictions, 1);
      assert.equal(data.health.complete, false, "a run that did not establish what is true is not complete");
      // Neither side is dropped and neither is chosen for being nicer.
      assert.ok(readings.some((item) => item.state === "pass"), "the favourable reading survives");
      assert.ok(readings.some((item) => item.state === "fail"), "and so does the unfavourable one");
    } finally {
      // `recursive` because this path is NOT always the symlink this case
      // created: `seedRendererCleanProfile` below leaves it a real directory,
      // and a fleet-status child can materialise it as one mid-case. A bare
      // `force` rm throws EISDIR on a directory, which surfaced as this case
      // failing with `Path is a directory` and masked whatever the try block
      // was actually asserting. The setup at the top of each case already
      // spells it `{ recursive: true, force: true }`; this is that same
      // teardown and must match it.
      rmSync(symlinked, { recursive: true, force: true });
      // Restored renderer-CLEAN (story 1.7), so every later case reads the
      // fleet this suite seeded rather than a marker-only profile.
      seedRendererCleanProfile(scratchHome, "beta-pm");
      rmSync(shared, { recursive: true, force: true });
    }
  });

  // -- AC8: the repair class is read off real fields ------------------------

  check("a fixable project rule repairs automatically; a host rule routes to the host", () => {
    const shim = entry("repairs", syntheticReport([RULE.scaffoldFail, RULE.bindingPass, RULE.profilePass, RULE.runtimePass, RULE.hostFail]));
    resetEntry(shim);
    const data = status(cli(["review", "--live", "--json", "--contract", cleanContract], { PJ_FLEET_CLI_ENTRY: shim }));

    const fixable = agentNamed(data, "alpha-pm").observations.find((item) => item.rule_id === "hermes.pm-scaffold");
    assert.ok(fixable, "the failing rule must be reported");
    assert.equal(fixable.repair, "automatic", "a fixable project rule has a migration recipe");
    assert.equal(fixable.next_action_class, "read-only");
    // The EXACT invocation, addressed by rule id and repository, and a dry run:
    // a next action a caller may run unread has to change nothing.
    assert.match(fixable.next_action, /^flume remediate hermes\.pm-scaffold \S+ --dry-run$/u,
      `next action must be the exact remediate invocation, got ${fixable.next_action}`);
    // The repository, home-redacted like every other path in `data` -- so the
    // assertion is on the suffix, never on an absolute path this suite cannot
    // predict (TMPDIR can itself live under the operator's home, and then the
    // whole prefix collapses to `~`).
    assert.ok(fixable.next_action.endsWith(`${join("repos", "alpha")} --dry-run`),
      `the action must name the repository the rule ran in: ${fixable.next_action}`);

    const host = data.host.find((item) => item.rule_id === "hermes.profile-wiring");
    assert.ok(host, "the host-scoped rule must reach data.host");
    assert.equal(host.repair, "other-owner", "no work in any repository changes a condition about this machine");
    assert.equal(host.next_action_class, "read-only");
    assert.equal(host.next_action.includes(reposRoot), false, "a host action must not route to a repository");
    assert.ok(typeof host.owner === "string" && host.owner.length > 0);
    // And it is in NEITHER verdict.
    for (const agent of data.agents) {
      assert.equal(agent.observations.some((item) => item.rule_id === "hermes.profile-wiring"), false,
        `${agent.agent_id} must not carry a host-scoped rule result`);
    }
  });

  check("an authorized skip is info and none; an unauthorized one is low and manual", () => {
    const shim = entry("skips", syntheticReport([...CLEAN_RULES, RULE.notebookSkip]));
    resetEntry(shim);
    const authorized = status(cli(["review", "--live", "--json", "--contract", cleanContract], { PJ_FLEET_CLI_ENTRY: shim }));
    const allowed = observationsOf(authorized).find((item) => item.rule_id === "notebook.remote-notebook");
    assert.ok(allowed, "the skip must be reported");
    assert.equal(allowed.state, "skip");
    // Both readings are `not_applicable` -- that is what a skip MEANS, and the
    // axis says nothing about who authorized it. The authorization lives in
    // `justification`, and it is what moves the severity and the repair class.
    assert.equal(allowed.applicability, "not_applicable");
    assert.equal(allowed.justification?.kind, "allowed_skip");
    assert.match(allowed.justification.policy, /^health_policy\.allowed_skips\[\d+\]$/u);
    assert.equal(allowed.severity, "info");
    assert.equal(allowed.repair, "none");

    const stripped = writeContract("no-skip-allowance", policyContract((document) => {
      document.health_policy.allowed_skips = document.health_policy.allowed_skips
        .filter((item) => item.rule_id !== "notebook.remote-notebook");
    }));
    resetEntry(shim);
    const unauthorized = status(cli(["review", "--live", "--json", "--contract", stripped], { PJ_FLEET_CLI_ENTRY: shim }));
    const orphan = observationsOf(unauthorized).find((item) => item.rule_id === "notebook.remote-notebook");
    assert.equal(orphan.state, "skip", "the state is identical; only the authorization moved");
    assert.equal(orphan.justification, null);
    // NOT `not_applicable`. The axis answers "was it required, and if not, on
    // WHOSE authority" -- a rule declaring itself not applicable is not an
    // authority, so an unauthorized skip on a required domain stays `required`.
    assert.equal(orphan.applicability, "required");
    assert.equal(orphan.severity, "medium", "an unjustified skip on a required domain outranks one on an optional");
    assert.equal(orphan.repair, "manual");
    assert.ok(unauthorized.health.unjustified > authorized.health.unjustified, "and the count must move with it");
  });

  // -- AC9: the sort ranks by priority, before every cap --------------------

  check("one gating finding among many low-severity ones survives both caps", () => {
    // Forty rules no domain table has heard of, each raising its own
    // `audit-rule-unmapped` (warn, medium, not gating), plus one contradiction
    // that IS gating -- produced last, by a symlinked profile whose audit half
    // reports pass, so arrival order buries it exactly where the report's cap
    // of 25 would drop it.
    const noisy = Array.from({ length: 40 }, (unused, index) => ({
      id: `zz.invented-${String(index).padStart(3, "0")}`,
      title: "an invented rule", status: "pass", summary: `invented rule ${index}`,
      details: [], fixable: false, scope: "project",
    }));
    const symlinked = join(scratchHome, ".hermes", "profiles", "beta-pm");
    const shared = join(scratchHome, ".hermes", "profiles", "shared-sort");
    mkdirSync(shared, { recursive: true });
    rmSync(symlinked, { recursive: true, force: true });
    symlinkSync(shared, symlinked);
    try {
      const shim = entry("sort", syntheticReport([...CLEAN_RULES, ...noisy]));
      resetEntry(shim);
      const args = ["review", "--live", "--json", "--contract", cleanContract];
      const data = status(cli(args, { PJ_FLEET_CLI_ENTRY: shim }));
      assert.ok(data.findings.length > 25, `the fixture must exceed the report's finding cap, got ${data.findings.length}`);

      const gating = data.findings.filter((item) => item.gating);
      assert.ok(gating.length >= 1, "the fixture must produce at least one gating finding");
      const firstGating = data.findings.findIndex((item) => item.gating);
      assert.equal(firstGating, 0, "every gating finding must sort ahead of every non-gating one");
      assert.equal(data.findings.slice(0, gating.length).every((item) => item.gating), true);
      // Severity never increases down the list, within a gating band.
      const rank = (severity) => SEVERITIES.indexOf(severity);
      for (let index = 1; index < data.findings.length; index += 1) {
        const previous = data.findings[index - 1];
        const current = data.findings[index];
        if (previous.gating !== current.gating) continue;
        assert.ok(rank(previous.status_severity) <= rank(current.status_severity),
          `findings are out of severity order at ${index}: ${previous.status_severity} then ${current.status_severity}`);
      }
      // TOTAL, so both adapters agree: two findings that tie on every other axis
      // still order by `finding_id`.
      assert.equal(new Set(data.findings.map((item) => item.finding_id)).size, data.findings.length,
        "every finding id must be unique or the sort is not total");

      // THE HUMAN PATH APPLIES THE SORT BEFORE ITS CAP.
      const report = cli(args.filter((item) => item !== "--json"), { PJ_FLEET_CLI_ENTRY: shim });
      assert.equal(report.status, 0);
      const findingsBlock = report.stdout.slice(report.stdout.indexOf("▸ Findings"));
      assert.ok(findingsBlock.length > 0, "the report must have a findings block");
      assert.ok(findingsBlock.includes(gating[0].code), `the gating finding ${gating[0].code} was dropped by the report's cap`);
      assert.ok(findingsBlock.includes("more finding(s)"), "the fixture must actually engage the report's cap");

      // The observation block is ranked by the same comparator, so the one
      // `critical` reading is visible among the low-severity crowd.
      const priority = report.stdout.slice(
        report.stdout.indexOf("▸ Highest-priority observations"),
        report.stdout.indexOf("▸ Findings"),
      );
      assert.ok(priority.includes("beta-pm · profile"), "the proven profile failure must lead the observation block");
      assert.ok(priority.includes("critical"), "and it must be shown with its severity");
    } finally {
      // `recursive` because this path is NOT always the symlink this case
      // created: `seedRendererCleanProfile` below leaves it a real directory,
      // and a fleet-status child can materialise it as one mid-case. A bare
      // `force` rm throws EISDIR on a directory, which surfaced as this case
      // failing with `Path is a directory` and masked whatever the try block
      // was actually asserting. The setup at the top of each case already
      // spells it `{ recursive: true, force: true }`; this is that same
      // teardown and must match it.
      rmSync(symlinked, { recursive: true, force: true });
      // Restored renderer-CLEAN (story 1.7), so every later case reads the
      // fleet this suite seeded rather than a marker-only profile.
      seedRendererCleanProfile(scratchHome, "beta-pm");
      rmSync(shared, { recursive: true, force: true });
    }
  });

  // -- AC10: six member buckets, over the SELECTION -------------------------

  check("every selected agent lands in exactly one member bucket, summing to the selection", () => {
    const shim = entry("members", syntheticReport([RULE.scaffoldFail, RULE.bindingPass, RULE.profilePass, RULE.runtimePass]));
    resetEntry(shim);
    const data = status(cli(["review", "--live", "--json", "--contract", cleanContract], { PJ_FLEET_CLI_ENTRY: shim }));
    const total = Object.values(data.health.members).reduce((sum, count) => sum + count, 0);
    assert.equal(total, data.scope.selected_agents, "the six counts must sum to the SELECTED agents");
    assert.equal(total, data.agents.length);
    for (const agent of data.agents) {
      assert.ok(MEMBER_CLASSES.includes(agent.member_class), `unknown member class ${agent.member_class}`);
      assert.equal(data.health.members[agent.member_class] >= 1, true);
    }
    assert.ok(data.health.members.unhealthy >= 1, "a failing rule must put its agent in the unhealthy bucket");
  });

  check("a contract-declared lifecycle class puts its row in the exception bucket", () => {
    // DW-30's second half, proven by making the branch FIRE rather than by
    // asserting it exists. `classifyMember` has an
    // `else if (classification === "intentionally_unmanaged")` arm, and until
    // `declaredRowClass` existed no input could reach it: every row was one of
    // two literals, so the `exception` bucket had one live path and one dead
    // one and could never be non-zero for a healthy agent.
    //
    // `source: agents.alpha-pm` rather than `participants` on purpose. Both
    // spellings claim a row, but `participants` ALSO justifies a conflict
    // group, which would reach the same bucket by the other road -- and a case
    // that cannot tell the two roads apart proves neither.
    const declared = writeContract("declared-class", policyContract((document) => {
      document.classifications.intentionally_unmanaged.entries = [{
        id: "alpha-pm-observed-only",
        kind: "managed-agent-exception",
        owner: "hermes-agent-registry",
        source: "agents.alpha-pm",
        lifecycle_state: "accepted",
        rationale: "This fixture declares alpha-pm as state the control plane observes and leaves alone.",
        policy_domains: ["profile"],
      }];
    }));

    // The contract has to still VALIDATE, or the case is proving that a broken
    // contract is refused rather than that a declared class is honoured.
    const validated = envelope(cli(["handbook", "validate", "--contract", declared, "--json"]));
    assert.equal(validated.ok, true, `the declaring contract must validate: ${JSON.stringify(validated.error)}`);

    const rows = JSON.parse(cli(["roster", "--json", "--contract", declared]).stdout).data.rows;
    const alphaRow = rows.find((row) => row.agent_id.value === "alpha-pm");
    const betaRow = rows.find((row) => row.agent_id.value === "beta-pm");
    assert.equal(alphaRow.classification.value, "intentionally_unmanaged", "the declared row must resolve to the declared class");
    assert.equal(alphaRow.classification.state, "resolved");
    assert.equal(betaRow.classification.value, "managed_agent", "and a row no entry names must be untouched");

    const args = ["review", "--json", "--domain", "registry", "--contract", declared];
    const data = status(cli(args));
    const alpha = agentNamed(data, "alpha-pm");
    assert.equal(alpha.healthy, true, "the branch is only reachable for an otherwise-healthy agent");
    assert.equal(alpha.member_class, "exception");
    assert.equal(data.health.members.exception, 1);
    assert.equal(agentNamed(data, "beta-pm").member_class, "healthy");
    assert.equal(
      Object.values(data.health.members).reduce((sum, count) => sum + count, 0),
      data.scope.selected_agents,
      "the six buckets must still sum to the selection",
    );

    // A DELTA against the identical run on a contract that declares nothing.
    // Without it, `exception: 1` could be produced by anything about the
    // fixture; with it, the entry is the only difference.
    const undeclared = status(cli(["review", "--json", "--domain", "registry", "--contract", cleanContract]));
    assert.equal(agentNamed(undeclared, "alpha-pm").member_class, "healthy");
    assert.equal(undeclared.health.members.exception, 0, "no entry, no exception");
    assert.equal(undeclared.health.members.healthy, data.health.members.healthy + 1);

    // `retired` is declarable on the same terms, and outranks the other class.
    const retired = writeContract("declared-retired", policyContract((document) => {
      document.classifications.retired.entries = [{
        id: "beta-pm-retired-sighting",
        kind: "retired-mode-sighting",
        owner: "hermes-agent-registry",
        source: "agents.beta-pm",
        lifecycle_state: "retired",
        rationale: "This fixture records beta-pm as a sighting of a mode the contract has withdrawn.",
        policy_domains: ["systemd"],
      }];
    }));
    const retiredRows = JSON.parse(cli(["roster", "--json", "--contract", retired]).stdout).data.rows;
    assert.equal(retiredRows.find((row) => row.agent_id.value === "beta-pm").classification.value, "retired");

    // THE PLACEHOLDER FORM CLAIMS NOBODY. `agents.{agent_id}` is the SHAPE of a
    // path -- every authority block in the contract spells it that way -- so
    // honouring it would let one entry sweep the whole fleet into a class
    // nobody ruled on.
    const shaped = writeContract("declared-placeholder", policyContract((document) => {
      document.classifications.intentionally_unmanaged.entries = [{
        id: "every-row-would-be-wrong",
        kind: "managed-agent-exception",
        owner: "hermes-agent-registry",
        source: "agents.{agent_id}",
        lifecycle_state: "accepted",
        rationale: "A path shape is not an instance, and this entry must claim no row at all.",
        policy_domains: ["profile"],
      }];
    }));
    const shapedRows = JSON.parse(cli(["roster", "--json", "--contract", shaped]).stdout).data.rows;
    for (const row of shapedRows) {
      assert.equal(row.classification.value, "managed_agent", `${row.agent_id.value} was swept up by a path SHAPE`);
    }

    // EXACT, NOT A PREFIX. `agents.alpha` must not claim `agents.alpha-pm`, or
    // one operator ruling reaches every row whose id happens to start the same
    // way -- the same widening the placeholder guard above refuses, one
    // character at a time.
    const prefixed = writeContract("declared-prefix", policyContract((document) => {
      document.classifications.intentionally_unmanaged.entries = [{
        id: "prefix-must-not-reach",
        kind: "managed-agent-exception",
        owner: "hermes-agent-registry",
        source: "agents.alpha",
        lifecycle_state: "accepted",
        rationale: "A prefix of a row path is not that row, and must claim nothing.",
        policy_domains: ["profile"],
      }];
    }));
    const prefixRows = JSON.parse(cli(["roster", "--json", "--contract", prefixed]).stdout).data.rows;
    for (const row of prefixRows) {
      assert.equal(row.classification.value, "managed_agent", `${row.agent_id.value} was claimed by a PREFIX of its path`);
    }
  });

  check("a fleet clipped past the agent cap produces the same six counts as one under it", () => {
    // The cap is 500 records. 520 rows means 20 are never emitted -- and the
    // member counts must still describe all 520, which is the exact defect
    // story 1.4's review found twice on `by_state` and `health`.
    const slugs = Array.from({ length: 520 }, (unused, index) => `cap${String(index).padStart(4, "0")}`);
    const agents = join(temp, "cap-agents.yaml");
    const projects = join(temp, "cap-projects.yaml");
    const rows = {};
    for (const slug of slugs) rows[`${slug}-pm`] = agentRow(slug);
    writeFileSync(agents, YAML.stringify({ schema_version: 1, agents: rows }), "utf8");
    writeProjectRegistry(projects, slugs);

    const args = ["review", "--json", "--domain", "registry", "--contract", cleanContract, "--agent-registry", agents, "--project-registry", projects];
    const clipped = status(cli(args));
    assert.equal(clipped.totals.agents, slugs.length, "every row must be counted");
    assert.ok(clipped.totals.emitted_agents < clipped.totals.agents, "the fixture must actually engage the agent cap");
    const total = Object.values(clipped.health.members).reduce((sum, count) => sum + count, 0);
    assert.equal(total, slugs.length, `the members must sum to every SELECTED agent, got ${total}`);
    assert.equal(clipped.scope.selected_agents, slugs.length);
    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  // -- AC11: baseline correlation -------------------------------------------

  check("--baseline names every transition kind and says nothing about what did not move", () => {
    const baseAgents = join(temp, "diff-base-agents.yaml");
    const baseProjects = join(temp, "diff-base-projects.yaml");
    const nextAgents = join(temp, "diff-next-agents.yaml");
    const nextProjects = join(temp, "diff-next-projects.yaml");
    makeRepo(reposRoot, "gamma");
    makeRepo(reposRoot, "delta");
    mkdirSync(join(scratchHome, ".hermes", "profiles", "gamma-pm"), { recursive: true });
    mkdirSync(join(scratchHome, ".hermes", "profiles", "delta-pm"), { recursive: true });

    // BEFORE: alpha, beta, gamma. AFTER: alpha, beta, delta -- gamma leaves,
    // delta arrives, and `beta` acquires an identity conflict with `alpha`,
    // which moves its registry observation's state, severity AND evidence
    // (a conflict is computed across rows, so the reading becomes derived).
    writeAgentRegistry(baseAgents, ["alpha", "beta", "gamma"]);
    writeProjectRegistry(baseProjects, ["alpha", "beta", "gamma"]);
    writeAgentRegistry(nextAgents, ["alpha", "beta", "delta"], (rows) => { rows["beta-pm"].repo = "alpha"; });
    writeProjectRegistry(nextProjects, ["alpha", "beta", "delta"]);

    const baseArgs = ["review", "--json", "--contract", cleanContract, "--agent-registry", baseAgents, "--project-registry", baseProjects];
    const baseline = join(temp, "diff-baseline.json");
    const baseResult = cli(baseArgs);
    status(baseResult);
    writeFileSync(baseline, baseResult.stdout, "utf8");

    const identical = status(cli([...baseArgs, "--baseline", baseline]));
    assert.deepEqual(identical.transitions, [], "a byte-identical baseline must produce no transitions");

    const nextArgs = ["review", "--json", "--contract", cleanContract, "--agent-registry", nextAgents, "--project-registry", nextProjects, "--baseline", baseline];
    const data = status(cli(nextArgs));
    const kinds = new Set(data.transitions.map((item) => item.kind));
    for (const kind of TRANSITION_KINDS) {
      assert.ok(kinds.has(kind), `no ${kind} transition was reported; got ${[...kinds].sort().join(", ")}`);
    }
    for (const transition of data.transitions) {
      assert.match(transition.finding_id, /^[0-9a-f]{12}$/u, "a transition is joined on a stable finding id");
      if (transition.kind === "appeared") assert.equal(transition.from, null);
      if (transition.kind === "resolved") assert.equal(transition.to, null);
    }
    assert.ok(data.transitions.some((item) => item.kind === "appeared" && item.agent_id === "delta-pm"));
    assert.ok(data.transitions.some((item) => item.kind === "resolved" && item.agent_id === "gamma-pm"));

    // UNCHANGED FINDINGS EMIT NOTHING, and carry the same id on both sides.
    const baseDoc = JSON.parse(readFileSync(baseline, "utf8")).data;
    const baseAlpha = baseDoc.agents.find((agent) => agent.agent_id === "alpha-pm").observations
      .filter((item) => item.domain === "live_process").map((item) => item.finding_id);
    const nextAlpha = agentNamed(data, "alpha-pm").observations
      .filter((item) => item.domain === "live_process").map((item) => item.finding_id);
    assert.deepEqual(nextAlpha, baseAlpha, "an unchanged observation keeps its id");
    assert.ok(baseAlpha.length > 0);
    const moved = new Set(data.transitions.map((item) => item.finding_id));
    for (const id of nextAlpha) assert.equal(moved.has(id), false, `${id} did not change and must emit no transition`);

    rmSync(join(reposRoot, "gamma"), { recursive: true, force: true });
    rmSync(join(reposRoot, "delta"), { recursive: true, force: true });
    rmSync(join(scratchHome, ".hermes", "profiles", "gamma-pm"), { recursive: true, force: true });
    rmSync(join(scratchHome, ".hermes", "profiles", "delta-pm"), { recursive: true, force: true });
    for (const path of [baseAgents, baseProjects, nextAgents, nextProjects, baseline]) rmSync(path, { force: true });
  });

  check("an unreadable or unparseable baseline is INVALID_INPUT at exit 2, before anything spawns", () => {
    const shim = entry("baseline-guard", syntheticReport(CLEAN_RULES));
    resetEntry(shim);
    const missing = cli(["review", "--live", "--json", "--baseline", join(temp, "no-such-baseline.json")], { PJ_FLEET_CLI_ENTRY: shim });
    const parsed = envelope(missing);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(missing.status, 2, `expected exit 2, got ${missing.status}`);
    assert.ok(JSON.stringify(parsed.error.details).includes("no-such-baseline.json"), "the error must name the path");
    assert.deepEqual(invocationsOf(shim), [], "no audit child may spawn before the flag is validated");

    const garbage = join(temp, "baseline-garbage.json");
    writeFileSync(garbage, "not json at all\n", "utf8");
    resetEntry(shim);
    const bad = cli(["review", "--live", "--json", "--baseline", garbage], { PJ_FLEET_CLI_ENTRY: shim });
    assert.equal(errorCode(envelope(bad)), "INVALID_INPUT");
    assert.equal(bad.status, 2);
    assert.deepEqual(invocationsOf(shim), [], "an unparseable baseline must be refused before collection too");

    const wrongShape = join(temp, "baseline-wrong-shape.json");
    writeFileSync(wrongShape, JSON.stringify({ hello: "world" }), "utf8");
    const shaped = cli(["review", "--json", "--baseline", wrongShape]);
    assert.equal(errorCode(envelope(shaped)), "INVALID_INPUT");
    assert.equal(shaped.status, 2, "valid JSON that is not a status document is still not a baseline");

    assert.equal(errorCode(envelope(cli(["review", "--json", "--baseline", ""]))), "INVALID_INPUT");
    assert.equal(errorCode(envelope(cli(["review", "--json", "--baseline", "--json"]))), "INVALID_INPUT");
    for (const path of [garbage, wrongShape]) rmSync(path, { force: true });
  });

  // -- AC12: the exit taxonomy is opt-in ------------------------------------

  check("--exit-code projects the category; without it every collected result is 0", () => {
    const failingShim = entry("exit-unhealthy", syntheticReport([RULE.scaffoldFail, RULE.bindingPass, RULE.profilePass, RULE.runtimePass]));
    resetEntry(failingShim);
    const unhealthy = cliAt(cleanRoot, ["review", "--live", "--json", "--exit-code"], { PJ_FLEET_CLI_ENTRY: failingShim });
    const unhealthyData = status(unhealthy);
    assert.equal(unhealthyData.health.verdict, "unhealthy");
    assert.equal(unhealthy.status, EXIT_CODES.unhealthy, `an unhealthy verdict must exit ${EXIT_CODES.unhealthy}`);
    assert.equal(JSON.parse(unhealthy.stdout).ok, true, "and the envelope must stay ok:true with complete data");

    resetEntry(failingShim);
    const unhealthyDefault = cliAt(cleanRoot, ["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: failingShim });
    assert.equal(unhealthyDefault.status, 0, "without --exit-code the same run exits 0");
    assert.equal(status(unhealthyDefault).health.exit_category, "unhealthy", "and still carries the discriminant");

    // A default run leaves the audit half unread, which is `unproven` rather
    // than `unhealthy` only when nothing has been PROVEN wrong -- so the fleet
    // this uses is the clean one, read without --live.
    const unproven = cliAt(cleanRoot, ["review", "--json", "--exit-code"]);
    const unprovenData = status(unproven);
    assert.equal(unprovenData.health.healthy, true, "nothing is proven wrong on this fleet");
    assert.equal(unprovenData.health.verdict, "unproven");
    assert.equal(unproven.status, EXIT_CODES.incomplete, `an unproven verdict must exit ${EXIT_CODES.incomplete}`);
    assert.equal(JSON.parse(unproven.stdout).ok, true);

    const unprovenDefault = cliAt(cleanRoot, ["review", "--json"]);
    assert.equal(unprovenDefault.status, 0);
    assert.equal(status(unprovenDefault).health.exit_category, "incomplete");

    resetEntry(cleanShim);
    const ok = cliAt(cleanRoot, ["review", "--live", "--json", "--exit-code"], { PJ_FLEET_CLI_ENTRY: cleanShim });
    assert.equal(status(ok).health.exit_category, "ok");
    assert.equal(ok.status, EXIT_CODES.ok, "a proven fleet exits 0 with or without the flag");

    // A COMMAND failure still wins: an unknown agent is exit 3, never 10 or 11.
    const notFound = cliAt(cleanRoot, ["review", "--json", "--exit-code", "--agent", "definitely-not-registered"]);
    assert.equal(errorCode(envelope(notFound)), "NOT_FOUND");
    assert.equal(notFound.status, 3, "an unreadable request is not an unhealthy fleet and must not share its band");
  });

  // -- AC13: the two adapters agree, on the id the diff joins on ------------

  await checkAsync("finding ids are identical on the CLI and the MCP adapter", async () => {
    // Imported lazily: the SDK is a dev dependency and this is the only case
    // that needs it, so an environment without it fails HERE rather than
    // preventing the other nineteen cases from running at all.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const env = { ...process.env, ...isolation };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(PKG, "dist", "mcp-server.js")], cwd: workdir, env });
    const client = new Client({ name: "fleet-health-suite", version: "1.0.0" });
    await client.connect(transport);
    try {
      const called = await client.callTool({ name: "flume_review", arguments: { contract: cleanContract, exitCode: true } });
      const mcp = JSON.parse(called.content.map((item) => (item.type === "text" ? item.text : "")).join(""));
      const cliRun = JSON.parse(cli(["review", "--json", "--contract", cleanContract]).stdout);
      assert.equal(mcp.ok, true, `MCP must succeed: ${JSON.stringify(mcp.error)}`);
      assert.deepEqual(mcp.data, cliRun.data, "data must deep-equal across the two adapters");
      assert.equal(mcp.data.health.exit_category, cliRun.data.health.exit_category);
      const ids = (payload) => payload.agents.flatMap((agent) => agent.observations.map((item) => item.finding_id));
      assert.ok(ids(mcp.data).length > 0);
      assert.deepEqual(ids(mcp.data), ids(cliRun.data), "every finding_id must match");
    } finally {
      await client.close();
    }
  });

  // -- T1: the member PRECEDENCE's order is behaviour, not a regex over source

  check("a failing agent on an incomplete run is unhealthy, not incomplete", () => {
    // The order of FLEET_STATUS_MEMBER_PRECEDENCE was pinned only by a regex
    // over `health.ts`'s text: swap `unhealthy` and `incomplete` and every
    // failing agent on a DEFAULT run silently becomes `incomplete`,
    // `members.unhealthy` drops to zero, and nothing fails. A default run is
    // the case that matters because the audit half is unread, so every agent
    // qualifies for `incomplete` and the two classes actually compete.
    const symlinked = join(scratchHome, ".hermes", "profiles", "beta-pm");
    const shared = join(scratchHome, ".hermes", "profiles", "shared-precedence");
    mkdirSync(shared, { recursive: true });
    rmSync(symlinked, { recursive: true, force: true });
    symlinkSync(shared, symlinked);
    try {
      const data = status(cli(["review", "--json", "--contract", cleanContract]));
      const beta = agentNamed(data, "beta-pm");
      assert.equal(beta.healthy, false, "the symlinked profile is a proven failure");
      assert.equal(beta.complete, false, "and a default run leaves the audit half unread");
      // BOTH candidates are live for this agent. The precedence is what picks.
      assert.equal(beta.member_class, "unhealthy", "a proven failure outranks an unread half");
      assert.ok(data.health.members.unhealthy >= 1);
      const alpha = agentNamed(data, "alpha-pm");
      assert.equal(alpha.healthy, true);
      assert.equal(alpha.member_class, "incomplete", "and an agent with only the unread half is incomplete");
    } finally {
      // `recursive` because this path is NOT always the symlink this case
      // created: `seedRendererCleanProfile` below leaves it a real directory,
      // and a fleet-status child can materialise it as one mid-case. A bare
      // `force` rm throws EISDIR on a directory, which surfaced as this case
      // failing with `Path is a directory` and masked whatever the try block
      // was actually asserting. The setup at the top of each case already
      // spells it `{ recursive: true, force: true }`; this is that same
      // teardown and must match it.
      rmSync(symlinked, { recursive: true, force: true });
      // Restored renderer-CLEAN (story 1.7), so every later case reads the
      // fleet this suite seeded rather than a marker-only profile.
      seedRendererCleanProfile(scratchHome, "beta-pm");
      rmSync(shared, { recursive: true, force: true });
    }
  });

  // -- T2: members.deferred, driven ----------------------------------------

  check("an agent whose only gaps are contract-declared deferrals is deferred", () => {
    // DW-30's shape again: a bucket no case drives is a bucket that can be
    // wrong forever. `deferred` needs an agent that is COMPLETE (so the audit
    // half was read) and whose every remaining non-pass is a declared
    // capability -- which means the fixture's own two warnings have to be
    // authorized as well, or they are gaps that are not deferrals.
    resetEntry(cleanShim);
    const data = status(cliAt(cleanRoot, ["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));
    assert.equal(data.health.complete, true, "the fixture must be complete or `deferred` cannot be reached");
    for (const agent of data.agents) {
      const gaps = agent.observations.filter((item) => item.state !== "pass" && item.state !== "skip");
      assert.ok(gaps.length > 0, `${agent.agent_id} must have gaps or the bucket is vacuous`);
      for (const gap of gaps) {
        assert.equal(gap.justification?.kind, "deferred_capability",
          `${agent.agent_id}/${gap.domain} is a gap that is not a declared deferral: ${gap.summary}`);
      }
      assert.equal(agent.member_class, "deferred");
    }
    assert.equal(data.health.members.deferred, data.scope.selected_agents);
    assert.equal(data.health.members.healthy, 0, "an agent with authorized gaps is not simply healthy");
  });

  // -- T3: the exception road THROUGH fleet status --------------------------

  check("a permitted identity conflict warns, is authorized, and is not fleet drift", () => {
    // The other exception road. `declaredRowClass` is covered above; this is
    // `ctx.exceptionFor` -> `justification.kind: "exception"`, which nothing
    // reached through `fleet status` before.
    //
    // It also pins the reconciliation between the two commands: `fleet
    // inventory` counts only UNPERMITTED groups into its aggregate, so a
    // permitted conflict that still read `fail` here made one registry produce
    // two opposite verdicts.
    const agents = join(temp, "permitted-agents.yaml");
    writeAgentRegistry(agents, SLUGS, (rows) => {
      rows["alpha-pm"].profile_name = "shared-profile";
      rows["beta-pm"].profile_name = "shared-profile";
    });
    mkdirSync(join(scratchHome, ".hermes", "profiles", "shared-profile"), { recursive: true });

    const unruled = writeContract("conflict-unruled", policyContract());
    const ruled = writeContract("conflict-ruled", policyContract((document) => {
      document.classifications.intentionally_unmanaged.entries = [{
        id: "shared-profile-ruled-ok",
        kind: "identity-conflict-exception",
        owner: "hermes-agent-registry",
        source: "agents.{agent_id}.profile_name",
        lifecycle_state: "accepted",
        rationale: "Two agents intentionally share one generated profile in this fixture.",
        policy_domains: ["profile"],
        participants: ["alpha-pm", "beta-pm"],
      }];
    }));

    const args = (contract) => ["review", "--json", "--domain", "registry", "--contract", contract, "--agent-registry", agents];
    const before = status(cli(args(unruled)));
    const after = status(cli(args(ruled)));

    // A DELTA. Without the ruling the identical fleet is drift.
    const betaBefore = agentNamed(before, "beta-pm").observations.find((o) => o.domain === "registry" && o.source === "fleet-inventory");
    assert.equal(betaBefore.state, "fail", "an unruled conflict is proven drift");
    assert.equal(betaBefore.justification, null);
    assert.equal(betaBefore.severity, "critical");
    assert.equal(before.health.verdict, "unhealthy");

    const betaAfter = agentNamed(after, "beta-pm").observations.find((o) => o.domain === "registry" && o.source === "fleet-inventory");
    assert.equal(betaAfter.state, "warn", "a ruled conflict is reported, and it is not drift");
    assert.equal(betaAfter.justification?.kind, "exception", "the ruling must be named on the observation");
    assert.match(betaAfter.justification.policy, /intentionally_unmanaged/u);
    assert.equal(betaAfter.severity, "low", "an authorized warn is low");
    assert.equal(after.health.healthy, true, "a permitted conflict is not fleet drift");
    assert.equal(after.health.unjustified, before.health.unjustified, "and it is not an unjustified gap either");

    // A FIELD-LEVEL RULING DOES NOT GRANT A ROW-LEVEL EXEMPTION.
    //
    // `matchException` reads `participants` to permit one identity-conflict
    // GROUP -- a statement about one field path shared by named claimants.
    // `declaredRowClass` used to read the same list, so permitting a shared
    // `profile_name` also reclassified both rows `intentionally_unmanaged`:
    // a statement about the WHOLE ROW nobody made. Nothing broke, because both
    // roads landed in the same member bucket -- but `row.classification` is an
    // input to what a reconciliation plan skips (1.11, 1.15), and a convergence
    // engine declining to touch a row because someone permitted a profile-name
    // collision is an unearned exemption that would be very hard to trace here.
    for (const contract of [unruled, ruled]) {
      const inventoryRows = JSON.parse(cli(["roster", "--json", "--contract", contract, "--agent-registry", agents]).stdout).data.rows;
      for (const row of inventoryRows) {
        assert.equal(
          row.classification.value, "managed_agent",
          `${row.agent_id.value}: permitting a conflict must not reclassify the row (contract ${contract})`,
        );
      }
    }
    // And the row is therefore NOT in the exception bucket on the strength of a
    // conflict ruling alone: the ruling authorized the observation, not the row.
    assert.equal(agentNamed(after, "beta-pm").member_class, "healthy",
      "a permitted conflict authorizes the OBSERVATION; the row is not exempted by it");

    // THE TWO COMMANDS AGREE. This is the finding: `fleet inventory` called
    // this fleet healthy while `fleet status` called it unhealthy.
    const inventory = JSON.parse(cli(["roster", "--json", "--contract", ruled, "--agent-registry", agents]).stdout).data;
    assert.equal(inventory.health.healthy, true, "the inventory's own aggregate ignores permitted groups");
    assert.equal(inventory.totals.permitted_conflict_groups, 1);
    assert.equal(
      after.health.healthy, inventory.health.healthy,
      "fleet status and fleet inventory must not disagree about whether an operator's ruling counts",
    );

    rmSync(agents, { force: true });
    rmSync(join(scratchHome, ".hermes", "profiles", "shared-profile"), { recursive: true, force: true });
  });

  // -- T5: every freshness bucket, driven ----------------------------------

  check("an absent, unparseable or future timestamp is unknown, and unknown blocks proof", () => {
    // DW-22's lesson: a bucket no fixture produces is a bucket nobody has ever
    // seen. `agentRow` always writes `provisioned_at` and `writeProjectRegistry`
    // always writes both project timestamps, so `unknown` was unreachable --
    // and `unknown` is the bucket a typo'd freshness field produces for the
    // WHOLE fleet, which is precisely when it must not read as fine.
    const projects = join(temp, "unknown-projects.yaml");
    const cases = {
      absent: (provider) => { delete provider.board_confirmed_at; },
      unparseable: (provider) => { provider.board_confirmed_at = "the day before yesterday"; },
      future: (provider) => { provider.board_confirmed_at = "2099-01-01T00:00:00.000Z"; },
    };
    for (const [label, mutate] of Object.entries(cases)) {
      const document = { schema_version: 1, projects: {} };
      for (const slug of SLUGS) {
        const provider = {
          type: "plane", workspace: "suite", identifier: slug.toUpperCase(), board_id: `board-${slug}`,
          board_confirmed_at: NOW_ISO, identifier_fetched_at: NOW_ISO,
        };
        if (slug === "beta") mutate(provider);
        document.projects[slug] = { name: slug, slug, repo_path: join(reposRoot, slug), status: "active", ticket_provider: provider };
      }
      writeFileSync(projects, YAML.stringify(document), "utf8");
      const data = status(cli(["review", "--json", "--contract", cleanContract, "--project-registry", projects]));
      const beta = agentNamed(data, "beta-pm").observations
        .find((item) => item.domain === "project_binding" && item.source === "fleet-inventory");
      assert.equal(beta.freshness, "unknown", `a ${label} timestamp must bucket unknown, got ${beta.freshness}`);
      assert.equal(data.health.freshness_unknown, 1, `${label}: exactly one reading must be unknown`);
      assert.equal(data.health.stale, 0, `${label}: unknown is not stale, and the two must not collapse`);
      assert.equal(data.health.proven, false, `${label}: evidence this run could not read is not proof`);
      const alpha = agentNamed(data, "alpha-pm").observations
        .find((item) => item.domain === "project_binding" && item.source === "fleet-inventory");
      assert.equal(alpha.freshness, "current", `${label}: the untouched agent must stay current`);
      // And it is ACTIONABLE: an unknown reading reaches the report.
      const report = cli(["review", "--contract", cleanContract, "--project-registry", projects]);
      assert.ok(report.stdout.includes("freshness unknown"), `${label}: the headline must name the bucket`);
      assert.match(report.stdout, /beta-pm · project_binding/u, `${label}: and the report must locate it`);
    }
    rmSync(projects, { force: true });
  });

  // -- H1: a baseline taken at a different scope is refused ----------------

  check("a baseline from another scope is refused rather than diffed", () => {
    const baseline = join(temp, "scope-baseline.json");
    const unfiltered = cli(["review", "--json", "--contract", cleanContract]);
    status(unfiltered);
    writeFileSync(baseline, unfiltered.stdout, "utf8");

    // The damage this prevents: every OTHER agent's findings would report
    // `resolved` -- "it got fixed" about observations the run never collected.
    const scoped = cli(["review", "--json", "--agent", "alpha-pm", "--contract", cleanContract, "--baseline", baseline]);
    const parsed = envelope(scoped);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(scoped.status, 2);
    assert.match(parsed.error.message, /different scope/u);
    assert.ok(parsed.error.details.baseline_scope, "the error must name the baseline's scope");
    assert.ok(parsed.error.details.current_scope, "and this run's");

    const domainScoped = cli(["review", "--json", "--domain", "registry", "--contract", cleanContract, "--baseline", baseline]);
    assert.equal(errorCode(envelope(domainScoped)), "INVALID_INPUT", "a --domain mismatch is refused too");

    // MATCHING scopes still work, including a narrowed pair.
    const narrowBase = cli(["review", "--json", "--agent", "alpha-pm", "--contract", cleanContract]);
    const narrowPath = join(temp, "scope-baseline-narrow.json");
    writeFileSync(narrowPath, narrowBase.stdout, "utf8");
    const narrowed = status(cli(["review", "--json", "--agent", "alpha-pm", "--contract", cleanContract, "--baseline", narrowPath]));
    assert.deepEqual(narrowed.transitions, [], "two runs at the SAME narrow scope diff cleanly");
    assert.equal(narrowed.scope.baseline, true, "and the scope records that a baseline was read");

    // `--live` is NOT part of the scope: reading more than the baseline did is
    // a real transition, not a mismatch.
    resetEntry(cleanShim);
    const live = cli(["review", "--json", "--agent", "alpha-pm", "--live", "--contract", cleanContract, "--baseline", narrowPath],
      { PJ_FLEET_CLI_ENTRY: cleanShim });
    const liveData = status(live);
    assert.ok(liveData.transitions.length > 0, "a live run against a default baseline must report what it newly observed");

    rmSync(baseline, { force: true });
    rmSync(narrowPath, { force: true });
  });

  check("a baseline that is not a fleet status document is refused by command", () => {
    const inventoryEnvelopePath = join(temp, "inventory-as-baseline.json");
    writeFileSync(inventoryEnvelopePath, cli(["roster", "--json", "--contract", cleanContract]).stdout, "utf8");
    // It is JSON, it carries a `data` object, and it yields zero snapshots --
    // so without the command check every current finding reports `appeared`
    // against a document that never described a status at all.
    const result = cli(["review", "--json", "--contract", cleanContract, "--baseline", inventoryEnvelopePath]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(parsed.error.message, /not a fleet status one/u);
    assert.equal(parsed.error.details.command, "fleet.inventory", "the error must name what it was given");
    rmSync(inventoryEnvelopePath, { force: true });
  });

  // -- C5: a clipped baseline cannot be diffed -----------------------------

  check("a baseline written by a clipped run is refused", () => {
    // The current side is every observation this run BUILT; a document carries
    // only what its caps let through. Diffed, every record the baseline dropped
    // comes back `appeared` over byte-identical state.
    const slugs = Array.from({ length: 520 }, (unused, index) => `clip${String(index).padStart(4, "0")}`);
    const agents = join(temp, "clip-agents.yaml");
    const projects = join(temp, "clip-projects.yaml");
    const rows = {};
    for (const slug of slugs) rows[`${slug}-pm`] = agentRow(slug);
    writeFileSync(agents, YAML.stringify({ schema_version: 1, agents: rows }), "utf8");
    writeProjectRegistry(projects, slugs);

    const args = ["review", "--json", "--domain", "registry", "--contract", cleanContract, "--agent-registry", agents, "--project-registry", projects];
    const clipped = cli(args);
    const data = status(clipped);
    assert.ok(data.totals.emitted_agents < data.totals.agents, "the fixture must actually engage the agent cap");
    const baseline = join(temp, "clip-baseline.json");
    writeFileSync(baseline, clipped.stdout, "utf8");

    const result = cli([...args, "--baseline", baseline]);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(result.status, 2);
    assert.match(parsed.error.message, /clipped/u, "the error must say why the document cannot be diffed");

    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
    rmSync(baseline, { force: true });
  });

  // -- T4: both transition caps, driven ------------------------------------

  check("the transition cap keeps the highest-severity transitions and records the clip", () => {
    // DW-22's recorded lesson, repeated: a cap nothing drives has never
    // executed. FLEET_STATUS_MAX_TRANSITIONS is 2000, so the fixture has to
    // move more findings than that -- 300 agents, every one appearing.
    const slugs = Array.from({ length: 300 }, (unused, index) => `tr${String(index).padStart(4, "0")}`);
    const emptyAgents = join(temp, "tr-empty-agents.yaml");
    const fullAgents = join(temp, "tr-full-agents.yaml");
    const projects = join(temp, "tr-projects.yaml");
    writeAgentRegistry(emptyAgents, SLUGS);
    const rows = {};
    for (const slug of SLUGS) rows[`${slug}-pm`] = agentRow(slug);
    for (const slug of slugs) rows[`${slug}-pm`] = agentRow(slug);
    writeFileSync(fullAgents, YAML.stringify({ schema_version: 1, agents: rows }), "utf8");
    writeProjectRegistry(projects, [...SLUGS, ...slugs]);

    const baseline = join(temp, "tr-baseline.json");
    const base = cli(["review", "--json", "--contract", cleanContract, "--agent-registry", emptyAgents, "--project-registry", projects]);
    status(base);
    writeFileSync(baseline, base.stdout, "utf8");

    const data = status(cli(["review", "--json", "--contract", cleanContract, "--agent-registry", fullAgents, "--project-registry", projects, "--baseline", baseline]));
    assert.equal(data.transitions.length, MAX_TRANSITIONS, `the cap must engage, got ${data.transitions.length}`);
    const note = data.truncated.find((item) => item.startsWith("transitions:"));
    assert.ok(note, "a clipped transitions array must record the clip");
    assert.match(note, /highest-severity ones are kept/u);
    assert.equal(data.health.truncated, true, "and the clip must reach the health verdict");

    // RANKED, not sliced by finding_id. A sha256 prefix is arbitrary with
    // respect to how much any of it matters.
    const rank = (item) => SEVERITIES.indexOf((item.to ?? item.from).severity);
    for (let index = 1; index < data.transitions.length; index += 1) {
      assert.ok(rank(data.transitions[index - 1]) <= rank(data.transitions[index]),
        `transitions are out of severity order at ${index}`);
    }

    // And the REPORT's own cap prints a count rather than truncating silently.
    const report = cli(["review", "--contract", cleanContract, "--agent-registry", fullAgents, "--project-registry", projects, "--baseline", baseline]);
    assert.match(report.stdout, /Transitions since the baseline/u);
    assert.match(report.stdout, /more transition\(s\); use --json/u, "the report must say how many it withheld");

    for (const path of [emptyAgents, fullAgents, projects, baseline]) rmSync(path, { force: true });
  });

  check("a clean diff prints the section, so it is not confused with no baseline", () => {
    const baseline = join(temp, "clean-diff-baseline.json");
    const first = cli(["review", "--json", "--contract", cleanContract]);
    status(first);
    writeFileSync(baseline, first.stdout, "utf8");
    const report = cli(["review", "--contract", cleanContract, "--baseline", baseline]);
    assert.equal(report.status, 0);
    assert.match(report.stdout, /Transitions since the baseline/u, "a baseline that moved nothing must still be reported");
    assert.match(report.stdout, /every finding is exactly as the baseline recorded it/u);
    // Without a baseline the section is absent, and the two absences mean
    // opposite things.
    const plain = cli(["review", "--contract", cleanContract]);
    assert.equal(plain.stdout.includes("Transitions since the baseline"), false);
    rmSync(baseline, { force: true });
  });

  // -- The gates that make this reachable on a fresh clone ------------------

  check("the suite and the mise task both know about story 1.5", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.match(runner, /tests\/fleet-health-regressions\.mjs/u, "a suite not listed in SUITES never runs");

    // Scoped to the read-only org section rather than to `org:review` alone:
    // the four tasks share one section comment, and that is where the exit
    // contract is stated once for all of them.
    const mise = readFileSync(join(ROOT, "mise.toml"), "utf8");
    const from = mise.indexOf("# The org chart");
    const to = mise.indexOf('[tasks."org:check"]');
    assert.ok(from >= 0 && to > from, "mise must group the read-only org tasks under one section");
    const section = mise.slice(from, to);
    assert.match(section, /\[tasks\."org:review"\]/u, "mise must expose org:review");
    assert.match(section, /--exit-code/u, "the org:review comment must name the opt-in exit projection");
    assert.match(section, /still exits 0/u, "and must keep stating that the default exits 0");
  });

  check("an agent_exceptions entry flips a drifted agent to exception and leaves health.healthy alone", () => {
    // Story 1.6 (PJAN-108). A DELTA on one contract entry: the same fleet, with
    // one role directory missing its `role.yaml`, once without a ruling and once
    // with `health_policy.agent_exceptions` naming it. The drift is still
    // reported and still `fail`; what moves is the agent's member bucket -- the
    // conflict-ruling precedent, on the scaffold axis.
    const drifted = join(reposRoot, "drifted");
    mkdirSync(join(drifted, "agents", "hermes", "pm", "runtime"), { recursive: true });
    writeFileSync(join(drifted, ".project.json"), `${JSON.stringify({
      project_slug: "drifted",
      ticket_provider: { type: "plane", workspace: "suite", identifier: "DRIFTED", board_id: "board-drifted" },
    }, null, 2)}\n`, "utf8");
    assert.equal(git(drifted, ["init", "--quiet"]).status, 0);
    writeFileSync(join(drifted, "README.md"), "# drifted\n", "utf8");
    assert.equal(git(drifted, ["add", "-A"]).status, 0);
    assert.equal(git(drifted, ["commit", "--quiet", "-m", "seed"]).status, 0);
    // Renderer-clean (story 1.7): the ruling is on the SCAFFOLD axis, so the
    // profile must carry no failure of its own or the agent could never be an
    // exception rather than unhealthy.
    const profile = seedRendererCleanProfile(scratchHome, "drifted-pm");
    // And service-clean (story 1.8), for exactly the same reason: a row with no
    // units on the scripted manager reads `gateway-missing`, which is a
    // SEPARATE proven failure the scaffold ruling does not cover -- the agent
    // would stay `unhealthy` for a reason this case is not about.
    setFakeSystemctlState(systemctlShim, mergeUnitSets(
      canonicalSystemdState(),
      deferredAgentUnits({
        agentId: "drifted-pm",
        profileName: "drifted-pm",
        profileRoot: join(scratchHome, ".hermes", "profiles"),
        roleDir: join(drifted, "agents", "hermes", "pm"),
        hermesBin: join(RELEASE, "bin", "hermes"),
      }),
    ));
    // An unregistered profile left in the root would be an extra for every
    // later fleet-scope sweep, so it goes with its lock -- on a failing
    // assertion too, or one red case cascades into every later sweep.
    try {
      const agents = writeAgentRegistry(join(temp, "exception-agents.yaml"), [...SLUGS, "drifted"]);
      const projects = writeProjectRegistry(join(temp, "exception-projects.yaml"), [...SLUGS, "drifted"]);
      const argv = ["review", "--live", "--json", "--agent-registry", agents, "--project-registry", projects];

      resetEntry(cleanShim);
      const before = status(cliAt(cleanRoot, argv, { PJ_FLEET_CLI_ENTRY: cleanShim }));
      const unruled = agentNamed(before, "drifted-pm");
      const roleYaml = unruled.observations.find((item) => item.field === "scaffold.role.yaml");
      assert.ok(roleYaml, "the role.yaml group must be observed");
      assert.equal(roleYaml.state, "fail", "a missing role.yaml is drift");
      assert.deepEqual(roleYaml.items.map((item) => item.kind), ["missing"]);
      assert.equal(roleYaml.justification, null, "nothing rules on it yet");
      assert.equal(unruled.member_class, "unhealthy");
      assert.equal(before.scaffold.agents.drifted, 1);
      assert.equal(before.scaffold.agents.exception_authorized, 0);

      const ruled = writeContract("agent-exception", policyContract((document) => {
        document.health_policy.agent_exceptions = [
          { domain: "template_scaffold", agent_id: "drifted-pm", reason: "the operator keeps this role's manifest by hand", owner: "suite" },
        ];
      }));
      const ruledRoot = makePackageRoot("pkg-agent-exception", readFileSync(ruled, "utf8"));
      resetEntry(cleanShim);
      const after = status(cliAt(ruledRoot, argv, { PJ_FLEET_CLI_ENTRY: cleanShim }));
      const excepted = agentNamed(after, "drifted-pm");
      const ruledYaml = excepted.observations.find((item) => item.field === "scaffold.role.yaml");
      assert.equal(ruledYaml.state, "fail", "the state is unchanged; only the AUTHORIZATION is new");
      assert.ok(ruledYaml.justification, "the ruling must be named on the observation");
      assert.equal(ruledYaml.justification.kind, "exception");
      assert.equal(ruledYaml.justification.policy, "health_policy.agent_exceptions[0]", "the policy path is the entry's own, not the intentionally_unmanaged literal");
      assert.equal(ruledYaml.applicability, "exception");
      assert.equal(excepted.member_class, "exception", "every proven failure carries the ruling, so the agent is an exception rather than unhealthy");
      assert.equal(after.scaffold.agents.exception_authorized, 1);
      assert.equal(after.scaffold.agents.drifted, 0);
      // The ruling moves the BUCKET and nothing else: `health.healthy` is about
      // proven drift, and the drift is still proven.
      assert.equal(after.health.healthy, before.health.healthy, "a ruling must not change health.healthy");
      assert.equal(after.health.healthy, false);
      assert.equal(after.health.failed, before.health.failed, "the fail is still counted");
      assert.equal(after.health.members.exception, before.health.members.exception + 1);
      assert.equal(after.health.members.unhealthy, before.health.members.unhealthy - 1);
    } finally {
      rmSync(profile, { recursive: true, force: true });
      rmSync(join(scratchHome, ".hermes", "profiles", ".drifted-pm.config.lock"), { force: true });
      setFakeSystemctlState(systemctlShim, canonicalSystemdState());
    }
  });

  check("every declared vocabulary is exported and spelled the same in source", () => {
    const types = readFileSync(join(PKG, "src", "org", "types.ts"), "utf8");
    const declared = (name) => {
      const match = new RegExp(`${name} = \\[([^\\]]+)\\]`, "u").exec(types);
      assert.ok(match, `${name} must be declared as a list`);
      return match[1].split(",").map((item) => item.trim().replace(/"/gu, "")).filter(Boolean);
    };
    assert.deepEqual(declared("FLEET_STATUS_APPLICABILITIES"), APPLICABILITIES);
    assert.deepEqual(declared("FLEET_STATUS_EVIDENCE"), EVIDENCE);
    assert.deepEqual(declared("FLEET_STATUS_FRESHNESS"), FRESHNESS);
    assert.deepEqual(declared("FLEET_STATUS_SEVERITIES"), SEVERITIES);
    assert.deepEqual(declared("FLEET_STATUS_SEVERITY_PRECEDENCE"), SEVERITIES);
    assert.deepEqual(declared("FLEET_STATUS_REPAIRS"), REPAIRS);
    assert.deepEqual(declared("FLEET_STATUS_VERDICTS"), VERDICTS);
    assert.deepEqual(declared("FLEET_STATUS_EXIT_CATEGORIES"), EXIT_CATEGORIES);
    assert.deepEqual(declared("FLEET_STATUS_MEMBER_CLASSES"), MEMBER_CLASSES);
    assert.deepEqual(declared("FLEET_STATUS_TRANSITION_KINDS"), TRANSITION_KINDS);
    assert.deepEqual(declared("FLEET_STATUS_FRESHNESS_PRECEDENCE"), ["stale", "unknown", "current", "not_applicable"]);
    assert.deepEqual(declared("FLEET_STATUS_SCOPE_PRECEDENCE"), ["fleet", "host", "agent"]);
    assert.deepEqual(declared("FLEET_STATUS_SCOPES"), ["fleet", "host", "agent"]);
    assert.deepEqual(declared("FLEET_STATUS_LIFECYCLE_STATES"), [...ACTIVATION_STATES, "out_of_scope"]);
    assert.deepEqual(declared("FLEET_STATUS_READINESS"), ["ready", "unproven", "blocked", "not_applicable", "out_of_scope"]);
    assert.deepEqual(declared("FLEET_STATUS_MEMBER_PRECEDENCE"), MEMBER_PRECEDENCE);

    // A PRECEDENCE CONSTANT NOTHING ITERATES IS DECORATION -- the exact defect
    // story 1.3's review found in FLEET_PROVENANCE_STATUS_PRECEDENCE.
    const health = readFileSync(join(PKG, "src", "org", "health.ts"), "utf8");
    assert.match(health, /FLEET_STATUS_SEVERITY_PRECEDENCE as readonly FleetStatusSeverity\[\]\)\.indexOf/u,
      "compareStatusFindings must rank by iterating the declared severity precedence");
    assert.match(health, /for \(const member of FLEET_STATUS_MEMBER_PRECEDENCE\)/u,
      "classifyMember must resolve by walking the declared member precedence");
    assert.match(health, /for \(const bucket of FLEET_STATUS_FRESHNESS_PRECEDENCE\)/u,
      "the freshness fold must walk its declared precedence");
    // AND THE ORDERINGS LIVE IN types.ts, not beside their only consumer. An
    // ordering declared in `health.ts` is one the vocabulary check above cannot
    // see, which is how `FLEET_STATUS_SEVERITY_PRECEDENCE` would have gone
    // unpinned too.
    for (const name of ["FRESHNESS_PRECEDENCE", "SCOPE_ORDER"]) {
      assert.equal(
        new RegExp(`^const ${name} = `, "mu").test(health), false,
        `${name} must be declared in src/fleet/types.ts, not in health.ts`,
      );
    }
  });

} catch (error) {
  if (!(error instanceof SkipCase)) throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(shimRoot, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} fleet health check(s) failed`);
  process.exit(1);
}
console.log(`fleet health regressions passed${skipped ? ` (${skipped} skipped)` : ""}`);
