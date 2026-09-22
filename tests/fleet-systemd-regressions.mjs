// PJAN Epic 1 / Story 1.8 (PJAN-110): canonical systemd topology and service
// health, proven against the user manager itself.
//
// Before this story `pjangler fleet status --domain systemd` reported every
// agent `unsupported`: the unit names on an agent's record were the patterns
// `service_model.per_agent` derives, carried as expectations and never as
// observations. On the live fleet that hid a gateway enabled+active for an
// agent whose row declares its channels deferred, a verified-Telegram agent
// whose gateway is disabled, a heartbeat oneshot whose latest result is an exit
// code, a deferred agent whose empty delta inherits the fleet base's platform
// enablement, heartbeat pairs on disk the registry never recorded, a registered
// agent with no units at all, a retired consumer reference, and a set of
// unregistered `hermes-*` units nothing reported.
//
// This suite is the proof that the observer which replaces that:
//
//   * is READ-ONLY structurally -- the only `systemctl` verbs its invocation
//     log ever carries are `is-system-running`, `list-units`, `list-unit-files`
//     and `show`, and every child receives the manifest's allowlist and nothing
//     else (the recording fake proves both, and would have obeyed a mutation);
//   * samples the MANAGER, not the agents: one `show` per sample carries every
//     unit of interest, so a window costs `1 + 2 + samples` children regardless
//     of fleet size and every agent's window is the SAME window;
//   * derives the DESIRED gateway state from the registry's own messaging
//     declaration, so "deferred but enabled" and "verified but disabled" are
//     drift rather than two alternate healthy modes;
//   * reports every time-derived fact as a BUCKET -- no timestamp, age, pid,
//     duration or completion order reaches `data`, and two runs over one fixed
//     manager state produce byte-identical bytes;
//   * classifies every unregistered `hermes-*` unit and leaves it alone.
//
// The bar, carried from stories 1.4 through 1.7: every case runs the REAL built
// `dist/index.js` in a real subprocess; stdout is asserted parseable before
// anything else; every invocation is bracketed by a content+mtime snapshot of
// the scratch tree and the tracked contract; the fleet, its unit state and the
// audit reports are all CONSTRUCTED here. Only the one live case may skip.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  FAKE_SAMPLED_PROPERTY_FLOOR,
  fakeSystemctlChildEnvs,
  fakeSystemctlInvocations,
  fakeSystemctlVerbs,
  formatTimespan,
  installFakeSystemctl,
  mergeUnitSets,
  monotonicNowUs,
  noBusIsolation,
  resetFakeSystemctl,
  setFakeSystemctlState,
} from "./helpers/fake-systemctl.mjs";

const ROOT = resolve(import.meta.dirname, "..");
// The workspace that owns the CLI. `dist/` lives under the package; the handbook
// and the job-description template stay at the repo root.
const PKG = join(ROOT, "packages", "flume-hr");
const CLI = join(PKG, "dist", "index.js");
const MCP = join(PKG, "dist", "mcp-server.js");
const TRACKED_CONTRACT = join(ROOT, "contracts", "handbook.yaml");

/** The five declared leaves, in the byte order the observations sort in. */
const FIELDS = {
  topology: "agents.{agent_id}.systemd.gateway_unit",
  heartbeatTimerRow: "agents.{agent_id}.systemd.heartbeat_timer",
  gateway: "units.hermes-{agent_id}-gateway.service",
  timer: "units.hermes-{agent_id}-heartbeat.timer",
  service: "units.hermes-{agent_id}-heartbeat.service",
};
const FIELD_ORDER = [FIELDS.topology, FIELDS.heartbeatTimerRow, FIELDS.gateway, FIELDS.service, FIELDS.timer];
const UNREGISTERED_CLASSES = ["retired", "transient", "profile-correlated", "managed-exception", "unclassified"];
/** Mirrors FLEET_SYSTEMD_EXTRA_CLASSES: how an extra unit on an agent's topology leaf is classed. */
const EXTRA_CLASSES = ["retired", "duplicate-gateway"];
const READ_VERBS = ["is-system-running", "list-units", "list-unit-files", "show"];
const MUTATION_VERBS = [
  "daemon-reload", "daemon-reexec", "enable", "disable", "start", "stop", "restart", "try-restart",
  "reload", "reset-failed", "link", "unmask", "mask", "edit", "kill", "set-property", "revert", "preset",
];
/** Mirrors FLEET_STATUS_MAX_ITEMS in src/fleet/types.ts. */
const MAX_ITEMS = 100;
const DATA_KEYS = [
  "contract_path", "contract_version", "scope",
  "totals", "health", "agents", "domains", "host", "findings", "probes", "transitions", "scaffold", "profile", "systemd", "truncated",
];
const SECRET_SENTINEL = "pjan110-not-a-real-credential-0000";

const REAL_HOME = (() => { try { return userInfo().homedir; } catch { return homedir(); } })();
const REAL_AGENT_REGISTRY = process.env.HERMES_AGENTS_REGISTRY?.trim() || join(REAL_HOME, ".hermes", "agents-registry.yaml");
const REAL_PROJECT_REGISTRY = process.env.PJ_PROJECT_REGISTRY?.trim() || join(REAL_HOME, ".config", "pjangler", "projects.yaml");

const temp = mkdtempSync(join(tmpdir(), "fleet-systemd-"));
/** Shims and recorders live OUTSIDE `temp`, so their own bookkeeping can never read as the command writing. */
const shimRoot = mkdtempSync(join(tmpdir(), "fleet-systemd-shims-"));
const scratchHome = join(temp, "home");
const fleetHome = join(scratchHome, ".hermes");
const profileRoot = join(fleetHome, "profiles");
const reposRoot = join(temp, "repos");
const workdir = join(temp, "work");
const systemctlShim = join(shimRoot, "systemctl-bin");

let failures = 0;
let skipped = 0;

class SkipCase extends Error {}

function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP ${label}: ${reason}`);
}

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

const GIT_IDENTITY = ["-c", "user.email=suite@invalid", "-c", "user.name=Suite", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

function git(cwd, args) {
  return spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      XDG_CONFIG_HOME: join(temp, "no-xdg-config"), GIT_DIR: undefined, GIT_WORK_TREE: undefined,
    },
  });
}

function gitOk(cwd, args) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, `${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// The fleet: five agents, one per row of the I/O matrix
// ---------------------------------------------------------------------------

const NOW_ISO = new Date().toISOString();
const HERMES_RELEASE = join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc");
const HERMES_BIN = join(HERMES_RELEASE, "bin", "hermes");

/**
 * The five fixture agents, one per messaging shape the observer must tell apart.
 *
 * `capability` is what the ROW declares, never what the unit does: that split is
 * the whole point of the gateway leaf, so the fixture keeps the two independent
 * and every case sets the unit state itself.
 */
const AGENTS = [
  // `alpha-pm` is the matrix's canonical ACTIVE agent, so its delta is the one
  // the provisioner writes for a verified channel: telegram left ENABLED and
  // only the deferred platform pinned off. A `pinned` delta here would have
  // made the fixture contradict the row's own input column (`generated
  // platforms.telegram.enabled: true`) while nothing noticed, because the
  // `active` branch reads identity and the secret reference and never
  // enablement.
  { name: "alpha-pm", telegram: "verified", slack: "disabled", delta: "active", secret: true, identity: true },
  { name: "bravo-pm", telegram: "disabled", slack: "disabled", delta: "pinned" },
  { name: "charlie-pm", telegram: "disabled", slack: "disabled", delta: "empty" },
  { name: "delta-pm", telegram: "verified", slack: "disabled", delta: "pinned", secret: true, identity: true },
  { name: "echo-pm", telegram: null, slack: null, delta: "pinned" },
];
const AGENT_IDS = AGENTS.map((agent) => agent.name);

function slugOf(name) {
  return name.replace(/-pm$/u, "");
}

function roleDirOf(name) {
  return join(reposRoot, slugOf(name), "agents", "hermes", "pm");
}

function unitsOf(name) {
  return {
    gateway: `hermes-${name}-gateway.service`,
    timer: `hermes-${name}-heartbeat.timer`,
    service: `hermes-${name}-heartbeat.service`,
  };
}

function launcherOf(name) {
  return join(roleDirOf(name), ".scripts", "credential-launch.sh");
}

function makeRepo(name, { reconcile = { enabled: false, explicit_opt_out: true } } = {}) {
  const dir = join(reposRoot, slugOf(name));
  const role = join(dir, "agents", "hermes", "pm");
  mkdirSync(join(role, ".scripts"), { recursive: true });
  mkdirSync(join(role, "runtime", "logs"), { recursive: true });
  writeFileSync(join(role, ".scripts", "credential-launch.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(role, ".scripts", "credential-launch.sh"), 0o755);
  writeFileSync(join(role, "role.yaml"), YAML.stringify(reconcile === null ? { role: "pm" } : { role: "pm", reconcile }), "utf8");
  // The three files the observer must NEVER open, each carrying a sentinel: a
  // credential in the role's runtime env, its auth store, and its log.
  writeFileSync(join(role, "runtime", ".env"), `TELEGRAM_BOT_TOKEN=${SECRET_SENTINEL}\n`, "utf8");
  writeFileSync(join(role, "runtime", "auth.json"), `{"token":"${SECRET_SENTINEL}"}\n`, "utf8");
  writeFileSync(join(role, "runtime", "logs", "heartbeat.log"), `heartbeat used ${SECRET_SENTINEL}\n`, "utf8");
  writeFileSync(join(dir, ".project.json"), `${JSON.stringify({
    project_slug: slugOf(name),
    ticket_provider: { type: "plane", workspace: "suite", identifier: slugOf(name).toUpperCase(), board_id: `board-${slugOf(name)}` },
  }, null, 2)}\n`, "utf8");
  gitOk(dir, ["init", "--quiet"]);
  writeFileSync(join(dir, "README.md"), `# ${slugOf(name)}\n`, "utf8");
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "--quiet", "-m", "seed"]);
  return dir;
}

const PINNED_PLATFORMS = { platforms: { telegram: { enabled: false }, slack: { enabled: false } } };
/** What a VERIFIED telegram row's delta carries: the live channel enabled, the deferred one pinned off. */
const ACTIVE_PLATFORMS = { platforms: { telegram: { enabled: true }, slack: { enabled: false } } };

function baseConfig() {
  // The fleet base ENABLES telegram, which is exactly why a deferred platform
  // must be pinned false in the delta or it inherits enablement.
  return {
    model: { default: "fleet-model" },
    memory: { provider: "hindsight" },
    skills: { external_dirs: [join(scratchHome, ".agents", "skills")] },
    platforms: { telegram: { enabled: true } },
  };
}

function seedProfile(name, { delta = "pinned", secret = false } = {}) {
  const dir = join(profileRoot, name);
  mkdirSync(join(dir, "hindsight"), { recursive: true });
  const document = delta === "empty" ? {} : delta === "active" ? { ...ACTIVE_PLATFORMS } : { ...PINNED_PLATFORMS };
  if (secret) document.secrets = { onepassword: { env: { TELEGRAM_BOT_TOKEN: `op://DeLoSecrets/${name}/token` } } };
  writeFileSync(join(dir, "profile.yaml"), `name: ${name}\n`, "utf8");
  writeFileSync(join(dir, "config.delta.yaml"), YAML.stringify(document), "utf8");
  writeFileSync(join(dir, "config.yaml"), `# GENERATED FILE -- DO NOT EDIT\n${YAML.stringify({ ...baseConfig(), ...document })}`, "utf8");
  writeFileSync(join(dir, "hindsight", "config.json"), `{\n  "bank_id": "agent-${name}"\n}\n`, "utf8");
  return dir;
}

function agentRow(agent, overrides = {}) {
  const { name } = agent;
  const row = {
    repo: slugOf(name),
    role: "pm",
    display_name: `${slugOf(name)} PM`,
    project_path: join(reposRoot, slugOf(name)),
    role_dir: roleDirOf(name),
    profile_name: name,
    provisioned_at: NOW_ISO,
    plane: { workspace: "suite", project_id: `board-${slugOf(name)}`, identifier: slugOf(name).toUpperCase() },
    bloodbank: { enabled: false, gateway_scope: "fleet", target_agent_id: name },
    systemd: { gateway_unit: unitsOf(name).gateway, heartbeat_timer: unitsOf(name).timer },
    hermes: {
      bin: HERMES_BIN, repo: HERMES_RELEASE,
      fleet_env: join(fleetHome, "fleet.env"),
      git_url: "https://github.com/delorenj/hermes-agent.git", git_ref: "main", git_sha: "0".repeat(40),
    },
  };
  // A row DECLARES its capability; the identity fields and the delta's `op://`
  // reference are what a verified declaration must be backed by. Neither is a
  // value: the row carries a bot name and a numeric id, never a token.
  if (agent.telegram !== null && agent.telegram !== undefined) {
    row.telegram = { provisioning_status: agent.telegram };
    if (agent.identity) { row.telegram.bot_username = `${slugOf(name)}_bot`; row.telegram.bot_id = 4242; }
  }
  if (agent.slack !== null && agent.slack !== undefined) row.slack = { provisioning_status: agent.slack };
  return { ...row, ...overrides };
}

const GATEWAYS_BLOCK = {
  bloodbank: {
    scope: "fleet",
    profile_name: "fleet-bloodbank-gateway",
    command_subject: "bloodbank.cmd.agent.invocation.start",
    target_field: "data.target_agent_id",
    systemd_unit: "hermes-fleet-bloodbank-gateway.service",
  },
};

function writeAgentRegistry(path, agents = AGENTS, gateways = GATEWAYS_BLOCK) {
  const rows = {};
  for (const agent of agents) rows[agent.name] = agentRow(agent, agent.rowOverrides ?? {});
  writeFileSync(path, YAML.stringify({ schema_version: 1, gateways, agents: rows }), "utf8");
  return path;
}

function writeProjectRegistry(path, agents = AGENTS) {
  const projects = {};
  for (const agent of agents) {
    const slug = slugOf(agent.name);
    projects[slug] = {
      name: slug, slug, repo_path: join(reposRoot, slug), status: "active",
      ticket_provider: { type: "plane", workspace: "suite", identifier: slug.toUpperCase(), board_id: `board-${slug}` },
    };
  }
  writeFileSync(path, YAML.stringify({ schema_version: 1, projects }), "utf8");
  return path;
}

function seedScratch() {
  mkdirSync(workdir, { recursive: true });
  mkdirSync(profileRoot, { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "hermes-agent-template"), { recursive: true });
  mkdirSync(join(scratchHome, ".agents", "skills"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "systemd", "user"), { recursive: true });
  mkdirSync(join(HERMES_RELEASE, "bin"), { recursive: true });
  writeFileSync(HERMES_BIN, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(HERMES_BIN, 0o755);
  writeFileSync(join(fleetHome, "config.yaml"), YAML.stringify(baseConfig()), "utf8");

  for (const agent of AGENTS) {
    makeRepo(agent.name);
    seedProfile(agent.name, { delta: agent.delta, secret: agent.secret });
  }
  seedProfile("fleet-bloodbank-gateway", { delta: "pinned" });
  // The canonical renderer's per-profile lock, PRE-CREATED. An unfiltered
  // `--live` run reaches the profile observer, whose `check` child creates a
  // zero-byte lock on first use -- and creating it would move the profile
  // root's own mtime, which the zero-write snapshot reads as a write. Story 1.7
  // seeds them for the same reason.
  for (const name of [...AGENT_IDS, "fleet-bloodbank-gateway"]) {
    writeFileSync(join(profileRoot, `.${name}.config.lock`), "");
  }

  writeAgentRegistry(join(fleetHome, "agents-registry.yaml"));
  writeProjectRegistry(join(scratchHome, ".config", "pjangler", "projects.yaml"));

  writeFileSync(join(scratchHome, ".config", "hermes-agent-template", "config.toml"), [
    "[fleet]",
    `hermes_bin = "${HERMES_BIN}"`,
    `hermes_repo = "${HERMES_RELEASE}"`,
    'hermes_git_url = "https://github.com/delorenj/hermes-agent.git"',
    'hermes_git_ref = "main"',
    `hermes_git_sha = "${"0".repeat(40)}"`,
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(fleetHome, "fleet.env"), [
    `HERMES_FLEET_HOME=${fleetHome}`,
    `HERMES_FLEET_BIN=${HERMES_BIN}`,
    `HERMES_FLEET_REPO=${HERMES_RELEASE}`,
    "HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/agents-registry.yaml",
    "",
  ].join("\n"), "utf8");
}

const isolation = {
  HOME: scratchHome,
  XDG_CONFIG_HOME: join(scratchHome, ".config"),
  XDG_DATA_HOME: join(scratchHome, ".local", "share"),
  XDG_STATE_HOME: join(scratchHome, ".local", "state"),
  XDG_CACHE_HOME: join(scratchHome, ".cache"),
  HERMES_FLEET_HOME: fleetHome,
  HERMES_AGENTS_REGISTRY: join(fleetHome, "agents-registry.yaml"),
  HERMES_FLEET_REGISTRY_FILE: join(fleetHome, "agents-registry.yaml"),
  HERMES_FLEET_ENV: join(fleetHome, "fleet.env"),
  HERMES_TEMPLATE_CONFIG: join(scratchHome, ".config", "hermes-agent-template", "config.toml"),
  PJ_PROJECT_REGISTRY: join(scratchHome, ".config", "pjangler", "projects.yaml"),
  HERMES_TEMPLATE_RUNTIME_SCAFFOLD: join(fleetHome, "runtime-scaffold"),
  RUNTIME_SCAFFOLD_DIR: join(fleetHome, "runtime-scaffold"),
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
  // The scripted user manager. The bus address and runtime dir point at
  // nothing, so a case that clears this PATH reads `manager-unavailable`
  // rather than this developer's own manager -- where a fixture agent's units
  // do not exist and never will.
  PATH: `${systemctlShim}:${process.env.PATH}`,
  ...noBusIsolation(temp),
  // Present in the PARENT's environment so the narrow child environments have
  // something to exclude; never allowed to reach any output.
  PLANE_33GOD_API_KEY: SECRET_SENTINEL,
};

// ---------------------------------------------------------------------------
// Unit-state builders: one per shape the observer must tell apart
// ---------------------------------------------------------------------------

function execLine(path, ...args) {
  return `{ path=${path} ; argv[]=${[path, ...args].join(" ")} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
}

/**
 * One agent's canonical unit triple, with every knob a case might need.
 *
 * Defaults are the CORRECT reading for a deferred agent: gateway disabled and
 * inactive, timer enabled/active/waiting on policy, oneshot completed 30 s ago.
 */
function agentUnits(name, options = {}) {
  const {
    gatewayEnabled = false, gatewayActive = false, gatewaySub = null, gatewayRestarts = "0",
    gatewayResult = "success", gatewayExecStatus = "0", gatewayExec = null, gatewayHome = null,
    gatewayFragment = "", gatewaySamples = null, gatewayLoad = "loaded",
    // A `UnitFileState` outside the enabled/disabled vocabularies (`static`,
    // `generated`, `indirect`), and a whole `Environment=` line for the cases
    // about how systemd QUOTES one.
    gatewayFileState = null, gatewayEnvironment = null,
    timerEnabled = true, timerActive = "active", timerSub = "waiting", timerPaired = true,
    onUnitInactiveSec = 60, onBootSec = 60, lastTriggerAgoUs = 30_000_000n, lastTriggerNever = false,
    serviceActive = "inactive", serviceSub = "dead", serviceResult = "success", serviceExecStatus = "0",
    serviceStartAgoUs = 31_000_000n, serviceExitAgoUs = 30_000_000n, serviceNeverRan = false,
    serviceTimeoutStart = "45min", serviceExec = null, serviceType = "oneshot",
    present = { gateway: true, timer: true, service: true },
    nowUs = monotonicNowUs(),
  } = options;
  const unit = unitsOf(name);
  const launcher = launcherOf(name);
  const home = gatewayHome ?? join(profileRoot, name);
  const units = {};
  const listUnits = [];
  const unitFiles = [];

  if (present.gateway !== false) {
    const gatewayState = {
      Id: unit.gateway, Names: unit.gateway, LoadState: gatewayLoad, LoadError: "",
      UnitFileState: gatewayFileState ?? (gatewayEnabled ? "enabled" : "disabled"),
      ActiveState: gatewayActive ? "active" : "inactive",
      SubState: gatewaySub ?? (gatewayActive ? "running" : "dead"),
      Result: gatewayResult, ExecMainStatus: gatewayExecStatus, ExecMainCode: gatewayActive ? "0" : "0",
      NRestarts: gatewayRestarts, FragmentPath: gatewayFragment, DropInPaths: "",
      Type: "simple", Restart: "on-failure",
      ExecStart: gatewayExec ?? execLine(launcher, "gateway"),
      Environment: gatewayEnvironment ?? `HERMES_HOME=${home} HERMES_BIN=${HERMES_BIN} CODEX_HOME=${join(scratchHome, ".codex")} OP_SERVICE_ACCOUNT_TOKEN=${SECRET_SENTINEL}`,
      ExecMainStartTimestampMonotonic: gatewayActive ? String(nowUs - 600_000_000n) : "0",
      ExecMainExitTimestampMonotonic: "0", TimeoutStartUSec: "1min 30s",
    };
    units[unit.gateway] = gatewaySamples === null ? gatewayState : gatewaySamples.map((patch) => ({ ...gatewayState, ...patch }));
    listUnits.push({ unit: unit.gateway, load: gatewayLoad, active: gatewayState.ActiveState, sub: gatewayState.SubState, description: `${name} gateway` });
    unitFiles.push({ unit_file: unit.gateway, state: gatewayState.UnitFileState, preset: null });
  }

  if (present.timer !== false) {
    units[unit.timer] = {
      Id: unit.timer, Names: unit.timer, LoadState: "loaded", LoadError: "",
      UnitFileState: timerEnabled ? "enabled" : "disabled",
      ActiveState: timerActive, SubState: timerSub, Result: "success",
      FragmentPath: "", DropInPaths: "",
      Unit: timerPaired ? unit.service : "hermes-somebody-else-heartbeat.service",
      Triggers: timerPaired ? unit.service : "hermes-somebody-else-heartbeat.service",
      TimersMonotonic: [
        `{ OnUnitInactiveUSec=${formatTimespan(BigInt(onUnitInactiveSec) * 1_000_000n)} ; next_elapse=${formatTimespan(nowUs + 30_000_000n)} }`,
        `{ OnBootUSec=${formatTimespan(BigInt(onBootSec) * 1_000_000n)} ; next_elapse=${formatTimespan(BigInt(onBootSec) * 1_000_000n)} }`,
      ],
      LastTriggerUSecMonotonic: lastTriggerNever ? "0" : formatTimespan(nowUs - lastTriggerAgoUs),
      NextElapseUSecMonotonic: formatTimespan(nowUs + 30_000_000n),
    };
    listUnits.push({ unit: unit.timer, load: "loaded", active: timerActive, sub: timerSub, description: `${name} heartbeat timer` });
    unitFiles.push({ unit_file: unit.timer, state: timerEnabled ? "enabled" : "disabled", preset: null });
  }

  if (present.service !== false) {
    units[unit.service] = {
      Id: unit.service, Names: unit.service, LoadState: "loaded", LoadError: "",
      UnitFileState: "static", ActiveState: serviceActive, SubState: serviceSub,
      Result: serviceResult, ExecMainStatus: serviceExecStatus, ExecMainCode: "1",
      FragmentPath: "", DropInPaths: "", Type: serviceType, TriggeredBy: unit.timer,
      ExecStart: serviceExec ?? execLine(launcher, "heartbeat"),
      Environment: `HERMES_HOME=${home}`,
      ExecMainStartTimestampMonotonic: serviceNeverRan ? "0" : String(nowUs - serviceStartAgoUs),
      ExecMainExitTimestampMonotonic: serviceNeverRan || serviceExitAgoUs === null ? "0" : String(nowUs - serviceExitAgoUs),
      TimeoutStartUSec: serviceTimeoutStart,
    };
    listUnits.push({ unit: unit.service, load: "loaded", active: serviceActive, sub: serviceSub, description: `${name} heartbeat` });
    unitFiles.push({ unit_file: unit.service, state: "static", preset: null });
  }

  return { units, list_units: listUnits, unit_files: unitFiles };
}

function sharedGateway(options = {}) {
  const { unit = "hermes-fleet-bloodbank-gateway.service", profile = "fleet-bloodbank-gateway", nowUs = monotonicNowUs() } = options;
  return {
    units: {
      [unit]: {
        Id: unit, Names: unit, LoadState: "loaded", LoadError: "", UnitFileState: "enabled",
        ActiveState: "active", SubState: "running", Result: "success", ExecMainStatus: "0", ExecMainCode: "0",
        NRestarts: "0", FragmentPath: "", DropInPaths: "", Type: "simple", Restart: "on-failure",
        ExecStart: execLine(HERMES_BIN, "gateway", "run", "--replace"),
        Environment: `HERMES_HOME=${join(profileRoot, profile)}`,
        ExecMainStartTimestampMonotonic: String(nowUs - 600_000_000n),
        ExecMainExitTimestampMonotonic: "0", TimeoutStartUSec: "1min 30s",
      },
    },
    list_units: [{ unit, load: "loaded", active: "active", sub: "running", description: "fleet bloodbank gateway" }],
    unit_files: [{ unit_file: unit, state: "enabled", preset: null }],
  };
}

/**
 * The CANONICAL fleet state: every agent's units exactly as `70-systemd.sh`
 * provisions them for its own declaration, plus the fleet-shared gateway.
 *
 * `alpha-pm` and `delta-pm` declare Telegram verified, so their gateways are
 * enabled and running; the other three are deferred or undeclared and theirs
 * are disabled and inactive. A case then patches whichever agent it is about.
 */
function canonicalState(patches = {}) {
  const nowUs = monotonicNowUs();
  return mergeUnitSets(
    { manager: { stdout: "running", exit: 0 } },
    ...AGENTS.map((agent) => agentUnits(agent.name, {
      nowUs,
      gatewayEnabled: agent.telegram === "verified" || agent.slack === "verified",
      gatewayActive: agent.telegram === "verified" || agent.slack === "verified",
      ...(patches[agent.name] ?? {}),
    })),
    sharedGateway({ nowUs }),
    ...(patches.extra ?? []),
  );
}

function setState(state) {
  setFakeSystemctlState(systemctlShim, state);
}

// ---------------------------------------------------------------------------
// Zero-write proof and the CLI runner
// ---------------------------------------------------------------------------

function snapshotTree(label, root, entries = {}) {
  if (!existsSync(root)) { entries[`${label}:<absent>`] = "absent"; return entries; }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      const key = `${label}:${relative(root, path)}`;
      // The canonical renderer's per-profile lock is ITS read semantics, not a
      // write of ours: an unfiltered `--live` run reaches the profile observer,
      // whose `check` child creates a zero-byte `.{profile}.config.lock` on
      // first use (story 1.7 documents it as the one footprint). Excluded here
      // for the same reason that suite excludes it.
      if (/^\.[A-Za-z0-9_-]+\.config\.lock$/u.test(entry.name)) continue;
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

/** The scratch tree -- every profile, registry, repository and unit directory -- plus the tracked contract. */
function snapshotIsolated() {
  const entries = {};
  snapshotTree("temp", temp, entries);
  snapshotTree("contracts", join(ROOT, "contracts"), entries);
  return entries;
}

const FOREIGN_SCRATCH = /^\.(pjan|fleet|notebook|momo|project)-/u;

/** This repository's staged content and top-level direntries, asserted once for the suite. */
function snapshotShared() {
  const entries = {};
  const listed = git(ROOT, ["--no-optional-locks", "ls-files", "--stage"]);
  entries[`staged:${ROOT}`] = listed.status === 0 ? createHash("sha256").update(listed.stdout).digest("hex") : `unreadable:${listed.status}`;
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (FOREIGN_SCRATCH.test(entry.name)) continue;
    entries[`root:${entry.name}`] = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
  }
  return entries;
}

function assertUnchanged(before, after, what) {
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]);
  for (const key of changed) console.log(`       ${key}: ${before[key] ?? "<missing>"} -> ${after[key] ?? "<missing>"}`);
  assert.fail(`${what} wrote to a protected root: ${changed.join(", ")}`);
}

function cli(args, extraEnv = {}, cwd = workdir) {
  const before = snapshotIsolated();
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...isolation, ...extraEnv },
  });
  assertUnchanged(before, snapshotIsolated(), `pj ${args.join(" ")}`);
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
  return parsed.error.code;
}

function status(result) {
  const parsed = envelope(result);
  assert.equal(parsed.ok, true, `expected ok:true, got ${JSON.stringify(parsed.error)}`);
  assert.equal(parsed.command, "fleet.status");
  for (const key of DATA_KEYS) assert.notEqual(parsed.data[key], undefined, `data.${key} must be present`);
  for (const finding of parsed.data.findings) {
    // A contract path, not a source id. Checked by SHAPE rather than by
    // "contains no hyphen": `units.hermes-{agent_id}-gateway.service` is a
    // declared leaf and is full of hyphens. What separates the two is the ROOT
    // -- a plain identifier followed by a dot or nothing at all (`scaffold`,
    // `units.…`) -- while `fleet-systemd`, the source id this guard exists to
    // catch, is hyphenated at its root.
    assert.match(finding.field, /^[a-z_]+(?:\.|$)/u, `a finding's field must be a contract path, not a source id: ${finding.field}`);
  }
  return parsed.data;
}

/** `fleet status --domain systemd --json`, against the state a case just set. */
function systemdRun(extraArgs = [], extraEnv = {}) {
  resetFakeSystemctl(systemctlShim);
  return status(cli(["review", "--domain", "systemd", "--json", ...extraArgs], extraEnv));
}

function agentNamed(data, id) {
  const found = data.agents.find((agent) => agent.agent_id === id);
  assert.ok(found, `agent ${id} must be in data.agents (have ${data.agents.map((a) => a.agent_id).join(", ")})`);
  return found;
}

/** The observer's observation for one declared leaf on one agent record. */
function leafOf(agent, field) {
  const found = agent.observations.find((item) => item.source === "fleet-systemd" && item.field === field);
  assert.ok(found, `${agent.agent_id} must carry the ${field} observation`);
  return found;
}

function kindsOf(observation) {
  return (observation.items ?? []).map((item) => item.kind);
}

function detailsOf(observation) {
  return (observation.items ?? []).map((item) => item.detail);
}

/**
 * Every error leaf of one agent names ITS OWN unit and its OWN failure.
 *
 * Two collection-failure paths are driven by this suite -- `manager-unavailable`
 * and `manager-timeout` -- and both build their result from the one shape
 * `emptyAgentResult` returns, which is also what the unsampled-window
 * (`show-failed`, `show-timeout`, `show-too-large`) and `agent-id-unsafe` gates
 * return. Those four codes have no case of their own; this helper proves the
 * shape, not those gates.
 *
 * The two heartbeat leaves are the pair that can silently swap units, and the
 * two summary CODES are the pair that can silently blank: `heartbeat.code` is
 * the field a JSON consumer reads to learn why the domain is not proven, and
 * nothing asserted it on an error path until it had already been null for a
 * commit.
 */
function assertErrorLeavesNameTheirUnits(agent, code) {
  const units = unitsOf(agent.agent_id);
  const named = (field) => (leafOf(agent, field).items ?? []).map((item) => item.path);
  assert.deepEqual(named(FIELDS.gateway), [units.gateway], `${agent.agent_id} gateway item path`);
  assert.deepEqual(named(FIELDS.timer), [units.timer], `${agent.agent_id} timer item path`);
  assert.deepEqual(named(FIELDS.service), [units.service], `${agent.agent_id} service item path`);
  assert.deepEqual(named(FIELDS.topology), [units.gateway], `${agent.agent_id} topology item path`);
  assert.deepEqual(named(FIELDS.heartbeatTimerRow), [units.timer], `${agent.agent_id} heartbeat_timer row item path`);
  assert.equal(agent.systemd.gateway.unit, units.gateway, `${agent.agent_id} gateway view`);
  assert.equal(agent.systemd.heartbeat.timer.unit, units.timer, `${agent.agent_id} timer view`);
  assert.equal(agent.systemd.heartbeat.service.unit, units.service, `${agent.agent_id} service view`);
  assert.deepEqual(agent.systemd.topology.expected, [units.gateway, units.service, units.timer].sort(), `${agent.agent_id} expected stays sorted`);
  // The two summary codes NAME the failure. A leaf that carries an item and
  // reports no code tells a consumer the domain is `error` and nothing about
  // why -- on exactly the path where there is no other reading to fall back on.
  assert.equal(agent.systemd.gateway.code, code, `${agent.agent_id} gateway code`);
  assert.equal(agent.systemd.heartbeat.code, code, `${agent.agent_id} heartbeat code`);
  assert.equal(agent.systemd.heartbeat.state, "error", `${agent.agent_id} heartbeat state`);
}

function hostNamed(data, ruleId) {
  const found = data.host.find((finding) => finding.rule_id === ruleId);
  assert.ok(found, `data.host must carry ${ruleId} (have ${data.host.map((f) => f.rule_id).join(", ")})`);
  return found;
}

function entry(name, body) {
  const dir = join(shimRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "entry.mjs");
  writeFileSync(path, body, "utf8");
  return path;
}

function syntheticReport(rules) {
  return `
const rules = ${JSON.stringify(rules)};
const report = {
  repo: process.argv[3] ?? "",
  ok: rules.every((rule) => !(rule.status === "fail" && rule.scope !== "host")),
  hostOk: true,
  auditedAt: new Date().toISOString(),
  rules,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
process.exit(report.ok ? 0 : 1);
`;
}

const TRACKED_TEXT = readFileSync(TRACKED_CONTRACT, "utf8");

function contractDocument() {
  return YAML.parse(TRACKED_TEXT);
}

function writeContract(name, mutate = () => {}) {
  const document = contractDocument();
  mutate(document);
  const path = join(temp, `contract-${name}.yaml`);
  writeFileSync(path, YAML.stringify(document, { lineWidth: 0 }), "utf8");
  return path;
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("fleet systemd regressions (PJAN-110)");
  const sharedBefore = snapshotShared();
  seedScratch();
  installFakeSystemctl(systemctlShim, canonicalState());

  // -- AC1: five declarations, five readings --------------------------------

  check("five messaging declarations produce five gateway readings, and the child count is bounded", () => {
    setState(canonicalState({
      // `delta-pm` declares Telegram verified and its gateway is disabled.
      "delta-pm": { gatewayEnabled: false, gatewayActive: false },
      // `echo-pm` declares nothing and its gateway is enabled and running.
      "echo-pm": { gatewayEnabled: true, gatewayActive: true },
    }));
    const data = systemdRun();

    const gateway = (id) => leafOf(agentNamed(data, id), FIELDS.gateway);
    assert.equal(gateway("alpha-pm").state, "pass", JSON.stringify(kindsOf(gateway("alpha-pm"))));
    assert.equal(gateway("bravo-pm").state, "pass", JSON.stringify(kindsOf(gateway("bravo-pm"))));
    assert.equal(gateway("charlie-pm").state, "fail");
    // ONE item, for the one platform the fleet base actually enables. `slack`
    // is deferred on the same row and enabled by nobody, so there is no
    // inherited enablement to pin away and no item to raise -- see the
    // dedicated case below, which drives the base itself.
    assert.deepEqual(detailsOf(gateway("charlie-pm")), ["platform-enablement-inherited:telegram"]);
    assert.equal(gateway("delta-pm").state, "fail");
    assert.deepEqual(kindsOf(gateway("delta-pm")), ["verified-channel-gateway-disabled", "verified-channel-gateway-inactive"]);
    assert.equal(gateway("echo-pm").state, "fail");
    assert.deepEqual(kindsOf(gateway("echo-pm")), ["channel-undeclared"]);

    assert.deepEqual(data.systemd.capability, { active: 2, deferred: 2, undeclared: 1 });
    assert.equal(agentNamed(data, "alpha-pm").systemd.capability.declared, "active");
    assert.deepEqual(agentNamed(data, "alpha-pm").systemd.capability.platforms, { telegram: "verified", slack: "deferred" });
    assert.deepEqual(agentNamed(data, "charlie-pm").systemd.capability.delta_disabled, { telegram: null, slack: null });
    assert.deepEqual(agentNamed(data, "bravo-pm").systemd.capability.delta_disabled, { telegram: true, slack: true });

    // ONE manager probe, TWO listings, `samples` shows -- and nothing else:
    // this scripted manager carries no unregistered unit, so the one extra
    // classification `show` never runs.
    const verbs = fakeSystemctlVerbs(systemctlShim);
    const samples = data.systemd.window.samples;
    assert.deepEqual(verbs, ["is-system-running", "list-units", "list-unit-files", ...Array.from({ length: samples }, () => "show")], JSON.stringify(verbs));
    assert.equal(verbs.length, 1 + 2 + samples);
    for (const argv of fakeSystemctlInvocations(systemctlShim)) {
      for (const mutation of MUTATION_VERBS) assert.equal(argv.includes(mutation), false, `systemctl ${mutation} must never be spawned: ${JSON.stringify(argv)}`);
    }
  });

  check("every agent carries all five declared leaves, in one field each", () => {
    setState(canonicalState());
    const data = systemdRun();
    for (const id of AGENT_IDS) {
      const agent = agentNamed(data, id);
      const fields = agent.observations.filter((item) => item.source === "fleet-systemd").map((item) => item.field).sort();
      assert.deepEqual(fields, [...FIELD_ORDER].sort(), `${id}: ${JSON.stringify(fields)}`);
      assert.ok(agent.systemd, `${id} must carry its systemd summary`);
      assert.deepEqual(agent.systemd.topology.expected, [
        unitsOf(id).gateway, unitsOf(id).service, unitsOf(id).timer,
      ].sort());
      // Every leaf resolves an owner: all five are declared writable under the
      // contract's `systemd_lifecycle` authority.
      for (const field of FIELD_ORDER) {
        assert.equal(leafOf(agent, field).owner, "runtime-template", `${id} ${field}`);
        assert.equal(leafOf(agent, field).evidence, "direct", `${id} ${field} must be direct evidence, never derived`);
      }
    }
  });

  check("a canonical active agent reads five passes, a stable window, a successful tick and a current one", () => {
    // The matrix's first row, end to end. Every earlier case asserts what goes
    // WRONG on some leaf; nothing asserted the shape the whole fixture is
    // supposed to have -- so `stability.stable: true`, and `pass` on the
    // topology, heartbeat_timer row and both heartbeat leaves of an ACTIVE
    // agent, were unproven in either direction.
    setState(canonicalState());
    const data = systemdRun();
    const alpha = agentNamed(data, "alpha-pm");
    for (const field of FIELD_ORDER) {
      assert.equal(leafOf(alpha, field).state, "pass", `${field}: ${JSON.stringify(kindsOf(leafOf(alpha, field)))}`);
    }
    assert.equal(alpha.systemd.capability.declared, "active");
    assert.equal(alpha.systemd.gateway.stability.stable, true);
    assert.equal(alpha.systemd.gateway.stability.samples, data.systemd.window.samples);
    assert.deepEqual(alpha.systemd.gateway.stability.transitions, []);
    assert.deepEqual(alpha.systemd.gateway.entrypoint, { family: "launcher", pinned: true });
    assert.equal(alpha.systemd.gateway.home, "matches");
    assert.equal(alpha.systemd.heartbeat.latest_result, "success");
    assert.equal(alpha.systemd.heartbeat.tick, "current");
    assert.equal(alpha.systemd.heartbeat.schedule, "within-policy");
    assert.equal(alpha.systemd.heartbeat.timer.paired, true);
    assert.equal(data.systemd.agents.heartbeat_healthy >= 1, true, JSON.stringify(data.systemd.agents));
    // The row's stated input, asserted against the fixture rather than assumed:
    // this agent's GENERATED config really does carry telegram enabled.
    const generated = YAML.parse(readFileSync(join(profileRoot, "alpha-pm", "config.yaml"), "utf8"));
    assert.equal(generated.platforms.telegram.enabled, true, "the canonical active agent's generated config must enable its verified channel");
  });

  // -- AC2: the stability window --------------------------------------------

  check("a growing restart count is a crash loop and a changed sample is unstable", () => {
    setState(canonicalState({
      "alpha-pm": { gatewayEnabled: true, gatewayActive: true, gatewaySamples: [{ NRestarts: "3" }, { NRestarts: "4" }, { NRestarts: "5" }] },
      "delta-pm": {
        gatewayEnabled: true, gatewayActive: true,
        gatewaySamples: [
          {}, { ActiveState: "activating", SubState: "auto-restart" }, {},
        ],
      },
    }));
    const data = systemdRun();
    const alpha = agentNamed(data, "alpha-pm");
    const alphaGateway = leafOf(alpha, FIELDS.gateway);
    assert.equal(alphaGateway.state, "fail");
    assert.ok(kindsOf(alphaGateway).includes("crash-looping"), JSON.stringify(kindsOf(alphaGateway)));
    assert.deepEqual(alpha.systemd.gateway.stability.transitions, ["restarts 3 -> 5"]);
    assert.equal(alpha.systemd.gateway.stability.stable, false);
    assert.equal(alpha.systemd.gateway.restarts, 5);

    const delta = agentNamed(data, "delta-pm");
    const deltaGateway = leafOf(delta, FIELDS.gateway);
    assert.equal(deltaGateway.state, "fail");
    assert.ok(kindsOf(deltaGateway).includes("unstable"), JSON.stringify(kindsOf(deltaGateway)));
    assert.deepEqual(delta.systemd.gateway.stability.transitions, ["active/running -> activating/auto-restart", "activating/auto-restart -> active/running"]);
    assert.equal(delta.systemd.gateway.stability.stable, false);

    assert.equal(data.systemd.agents.crash_looping, 1);
    assert.ok(data.systemd.agents.unstable >= 2, JSON.stringify(data.systemd.agents));

    // NO per-sample reading escapes the SUMMARY. `restarts 3 -> 5` appears
    // exactly three times -- `gateway.stability.transitions`, the item's
    // `observed` half, and the observation `details[]` line that renders that
    // item -- and nowhere else; the intermediate sample (4) appears nowhere at
    // all, which is the whole point of reporting a transition rather than a
    // series.
    const occurrences = JSON.stringify(data).split("restarts 3 -> 5").length - 1;
    assert.equal(occurrences, 3, `the transition may appear only in the stability summary, its item and that item's rendered detail, found ${occurrences}`);
    assert.equal(JSON.stringify(data).includes("restarts 3 -> 4"), false, "an intermediate sample must never be reported");
    assert.equal(JSON.stringify(data).includes("restarts 4 -> 5"), false, "an intermediate sample must never be reported");
  });

  check("an activating gateway is never proven, even when every sample agrees", () => {
    setState(canonicalState({ "alpha-pm": { gatewayEnabled: true, gatewayActive: true, gatewaySub: "start-pre", gatewaySamples: [{ ActiveState: "activating", SubState: "start-pre" }, { ActiveState: "activating", SubState: "start-pre" }, { ActiveState: "activating", SubState: "start-pre" }] } }));
    const data = systemdRun();
    const gateway = leafOf(agentNamed(data, "alpha-pm"), FIELDS.gateway);
    assert.equal(gateway.state, "fail");
    assert.ok(kindsOf(gateway).includes("unstable"), JSON.stringify(kindsOf(gateway)));
    assert.ok(kindsOf(gateway).includes("verified-channel-gateway-inactive"), JSON.stringify(kindsOf(gateway)));
  });

  // -- AC3: heartbeat buckets ------------------------------------------------

  check("a heartbeat is a bucket: in-progress, stuck, failed, overdue and off-policy", () => {
    const nowUs = monotonicNowUs();
    setState(canonicalState({
      // Activating and YOUNGER than its own start timeout.
      "alpha-pm": { nowUs, serviceActive: "activating", serviceSub: "start", serviceStartAgoUs: 60_000_000n, serviceTimeoutStart: "45min" },
      // Activating and OLDER than it.
      "bravo-pm": { nowUs, serviceActive: "activating", serviceSub: "start", serviceStartAgoUs: 3_600_000_000n, serviceTimeoutStart: "45min" },
      // Completed, and the completion failed.
      "charlie-pm": { nowUs, serviceResult: "exit-code", serviceExecStatus: "209" },
      // Inactive, and the last trigger is older than 5 x 60 s.
      "delta-pm": { nowUs, gatewayEnabled: false, gatewayActive: false, lastTriggerAgoUs: 600_000_000n, serviceStartAgoUs: 601_000_000n, serviceExitAgoUs: 600_000_000n },
      // A schedule the policy does not declare.
      "echo-pm": { nowUs, onUnitInactiveSec: 300 },
    }));
    const data = systemdRun();
    const summary = (id) => agentNamed(data, id).systemd.heartbeat;

    // Whether the tick is HAPPENING is the TIMER's question -- the leaf that
    // already owns `tick-overdue`, `tick-never` and `schedule-off-policy` --
    // while whether the last COMPLETED run succeeded is the oneshot's. Both
    // halves are asserted as the item CODE plus the leaf state, never as the
    // summary bucket alone: a build that renamed the item or emitted a
    // different failing kind while still bucketing the same word stayed green
    // before.
    assert.equal(summary("alpha-pm").latest_result, "in-progress");
    const alphaTimer = leafOf(agentNamed(data, "alpha-pm"), FIELDS.timer);
    assert.deepEqual(kindsOf(alphaTimer), ["in-progress"], JSON.stringify(detailsOf(alphaTimer)));
    assert.equal(alphaTimer.state, "warn");
    assert.equal(leafOf(agentNamed(data, "alpha-pm"), FIELDS.service).state, "pass", "a tick still running has no completed result for its own leaf to fault");

    assert.equal(summary("bravo-pm").latest_result, "stuck");
    const bravoTimer = leafOf(agentNamed(data, "bravo-pm"), FIELDS.timer);
    assert.deepEqual(kindsOf(bravoTimer), ["stuck"], JSON.stringify(detailsOf(bravoTimer)));
    assert.equal(bravoTimer.state, "fail");

    assert.equal(summary("charlie-pm").latest_result, "failed");
    const charlieService = leafOf(agentNamed(data, "charlie-pm"), FIELDS.service);
    assert.equal(charlieService.state, "fail");
    assert.ok(detailsOf(charlieService).includes("latest-result-failed:exit-code"), JSON.stringify(detailsOf(charlieService)));
    // `Result` is read before `ExecMainStatus`, and the status is carried on the
    // summary rather than in the code -- 209 is the live `automatic-ai-pm`
    // reading this row was written from.
    assert.equal(summary("charlie-pm").service.exec_status, 209);
    assert.equal(summary("charlie-pm").service.result, "exit-code");

    assert.equal(summary("delta-pm").tick, "overdue");
    const deltaTimer = leafOf(agentNamed(data, "delta-pm"), FIELDS.timer);
    assert.ok(kindsOf(deltaTimer).includes("tick-overdue"), JSON.stringify(detailsOf(deltaTimer)));
    assert.equal(deltaTimer.state, "fail");

    assert.equal(summary("echo-pm").schedule, "off-policy");
    const echoTimer = leafOf(agentNamed(data, "echo-pm"), FIELDS.timer);
    assert.ok(kindsOf(echoTimer).includes("schedule-off-policy"), JSON.stringify(detailsOf(echoTimer)));
    assert.equal(echoTimer.state, "fail");
    assert.match(
      echoTimer.items.find((item) => item.kind === "schedule-off-policy").observed, /on_unit_inactive_sec 300s/u,
      "the item must name the schedule it OBSERVED, in the manifest's vocabulary",
    );

    assert.equal(summary("alpha-pm").tick, "current");
    assert.equal(summary("alpha-pm").schedule, "within-policy");

    // NO age, NO duration, NO monotonic reading, NO epoch.
    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes("USec"), false, "a USec property reached data");
    assert.equal(serialized.includes("Monotonic"), false, "a monotonic property reached data");
    assert.doesNotMatch(serialized, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u, "an ISO instant reached data");
    assert.doesNotMatch(serialized.replaceAll('"interval_ms":', '"<declared-window>":'), /"([a-z_]+_(ms|at|age|seconds)|age|duration|elapsed|timestamp)":/u, "an age-shaped key reached data");
  });

  check("a timer that has never fired is `never` only once the boot delay has passed twice over", () => {
    // `never` is claimed only once the host's uptime exceeds `on_boot_sec x 2`,
    // which made this case depend on THIS HOST: a box booted under 120 s ago
    // read `unknown` and turned it red for a reading the observer got right.
    // The contract declares the delay, so the contract is what moves -- 1 s,
    // which any host running this suite has already exceeded -- and the
    // fixture's own timer declares the same 1 s so the schedule stays on policy
    // and `tick-never` is the only finding.
    const contract = writeContract("boot-delay-1s", (document) => {
      document.service_manifest.heartbeat.on_boot_sec = 1;
    });
    const onBoot = Object.fromEntries(AGENT_IDS.map((id) => [id, { onBootSec: 1 }]));
    setState(canonicalState({ ...onBoot, "alpha-pm": { onBootSec: 1, lastTriggerNever: true, serviceNeverRan: true } }));
    resetFakeSystemctl(systemctlShim);
    const data = status(cli(["review", "--domain", "systemd", "--json", "--contract", contract]));
    const alpha = agentNamed(data, "alpha-pm");
    assert.equal(alpha.systemd.heartbeat.schedule, "within-policy", "the fixture's boot delay matches the contract's");
    assert.equal(alpha.systemd.heartbeat.tick, "never", "the declared boot delay has elapsed twice over");
    assert.equal(alpha.systemd.heartbeat.latest_result, "never");
    assert.deepEqual(kindsOf(leafOf(alpha, FIELDS.timer)), ["tick-never"], JSON.stringify(detailsOf(leafOf(alpha, FIELDS.timer))));
    assert.equal(leafOf(alpha, FIELDS.timer).state, "fail");
    assert.ok(kindsOf(leafOf(alpha, FIELDS.service)).includes("never-completed"));
    // Every OTHER agent's timer is on policy and current under the same
    // contract: the boot delay moved, not the reading.
    for (const id of AGENT_IDS.filter((name) => name !== "alpha-pm")) {
      assert.equal(leafOf(agentNamed(data, id), FIELDS.timer).state, "pass", `${id}: ${JSON.stringify(kindsOf(leafOf(agentNamed(data, id), FIELDS.timer)))}`);
    }
  });

  check("the overdue threshold is the declared multiple, read off the LATER of the two clocks", () => {
    const nowUs = monotonicNowUs();
    setState(canonicalState({
      // 290 s is inside `on_unit_inactive_sec x overdue_multiplier` (60 x 5)
      // and 310 s is outside it. The PAIR is what pins the multiplier: with a
      // multiplier of 1 the first reads overdue, with 10 the second reads
      // current, and either mutation goes red here.
      "alpha-pm": { nowUs, lastTriggerAgoUs: 290_000_000n, serviceStartAgoUs: 291_000_000n, serviceExitAgoUs: 290_000_000n },
      "bravo-pm": { nowUs, lastTriggerAgoUs: 310_000_000n, serviceStartAgoUs: 311_000_000n, serviceExitAgoUs: 310_000_000n },
      // Only the TIMER's last trigger is stale; the oneshot exited a moment ago.
      "charlie-pm": { nowUs, lastTriggerAgoUs: 600_000_000n, serviceStartAgoUs: 31_000_000n, serviceExitAgoUs: 30_000_000n },
      // The mirror: only the ONESHOT's exit is stale. Reading either clock
      // alone -- or the earlier of the two -- calls one of these two overdue.
      "delta-pm": { nowUs, lastTriggerAgoUs: 30_000_000n, serviceStartAgoUs: 601_000_000n, serviceExitAgoUs: 600_000_000n },
      // The schedule rule's OTHER limb: the boot delay, not the interval.
      "echo-pm": { nowUs, onBootSec: 120 },
    }));
    const data = systemdRun();
    const tickOf = (id) => agentNamed(data, id).systemd.heartbeat.tick;
    assert.equal(tickOf("alpha-pm"), "current", "290 s is inside 60 s x 5");
    assert.equal(kindsOf(leafOf(agentNamed(data, "alpha-pm"), FIELDS.timer)).includes("tick-overdue"), false);
    assert.equal(tickOf("bravo-pm"), "overdue", "310 s is outside 60 s x 5");
    assert.ok(kindsOf(leafOf(agentNamed(data, "bravo-pm"), FIELDS.timer)).includes("tick-overdue"));
    assert.equal(tickOf("charlie-pm"), "current", "the oneshot's exit is the later reading");
    assert.equal(tickOf("delta-pm"), "current", "the timer's last trigger is the later reading");
    const echoTimer = leafOf(agentNamed(data, "echo-pm"), FIELDS.timer);
    assert.equal(agentNamed(data, "echo-pm").systemd.heartbeat.schedule, "off-policy");
    assert.ok(kindsOf(echoTimer).includes("schedule-off-policy"), JSON.stringify(detailsOf(echoTimer)));
    assert.match(
      echoTimer.items.find((item) => item.kind === "schedule-off-policy").observed, /on_boot_sec 120s/u,
      "an off-policy BOOT delay is the same rule's other half",
    );
  });

  check("a timer that is disabled, inactive, wrongly paired or in a bad substate says which", () => {
    setState(canonicalState({
      "alpha-pm": { timerEnabled: false },
      "bravo-pm": { timerActive: "inactive", timerSub: "dead" },
      "charlie-pm": { timerPaired: false },
    }));
    const data = systemdRun();
    assert.deepEqual(kindsOf(leafOf(agentNamed(data, "alpha-pm"), FIELDS.timer)), ["timer-disabled"]);
    assert.deepEqual(kindsOf(leafOf(agentNamed(data, "bravo-pm"), FIELDS.timer)).slice(0, 2), ["timer-inactive", "timer-substate"]);
    assert.ok(kindsOf(leafOf(agentNamed(data, "charlie-pm"), FIELDS.timer)).includes("timer-unpaired"));
    assert.equal(agentNamed(data, "charlie-pm").systemd.heartbeat.timer.paired, false);
  });

  // -- AC4: reconcile policy and evidence -----------------------------------

  check("the reconcile policy is read for its declaration and its state file for the presence of keys", () => {
    const roles = {
      // reconcile ON with no state file at all.
      "alpha-pm": { reconcile: { enabled: true } },
      // OFF without an explicit opt-out.
      "bravo-pm": { reconcile: { enabled: false } },
      // OFF with one.
      "charlie-pm": { reconcile: { enabled: false, explicit_opt_out: true } },
      // No block at all.
      "delta-pm": null,
      // ON with a state file that evidences a FULL run.
      "echo-pm": { reconcile: { enabled: true } },
    };
    for (const [name, body] of Object.entries(roles)) {
      writeFileSync(join(roleDirOf(name), "role.yaml"), YAML.stringify(body === null ? { role: "pm" } : { role: "pm", ...body }), "utf8");
    }
    const statePath = join(roleDirOf("echo-pm"), "runtime", "continuous-ticket-sentinel-state.json");
    const alphaState = join(roleDirOf("alpha-pm"), "runtime", "continuous-ticket-sentinel-state.json");
    writeFileSync(statePath, `${JSON.stringify({
      last_decision: SECRET_SENTINEL,
      last_full_run_epoch: 1,
      last_runner_completed_at: "2026-01-01T00:00:00Z",
    })}\n`, "utf8");
    // The role trees, byte-for-byte, before and after: the sentinels planted in
    // `runtime/.env`, `auth.json` and `runtime/logs/heartbeat.log` are files the
    // observer must never open, and the state file it DOES open is opened for
    // reading only.
    const before = snapshotTree("roles", reposRoot);
    try {
      setState(canonicalState());
      resetFakeSystemctl(systemctlShim);
      const result = cli(["review", "--domain", "systemd", "--json"]);
      const data = status(result);
      const reconcile = (id) => agentNamed(data, id).systemd.heartbeat.reconcile;
      assert.deepEqual(reconcile("alpha-pm"), { declared: "enabled", evidence: "state-missing" });
      assert.ok(kindsOf(leafOf(agentNamed(data, "alpha-pm"), FIELDS.service)).includes("checkpoint-only"));
      assert.equal(leafOf(agentNamed(data, "alpha-pm"), FIELDS.service).state, "fail");
      assert.deepEqual(reconcile("bravo-pm"), { declared: "disabled", evidence: "not-applicable" });
      assert.ok(kindsOf(leafOf(agentNamed(data, "bravo-pm"), FIELDS.service)).includes("reconcile-opt-out-undeclared"));
      assert.equal(leafOf(agentNamed(data, "bravo-pm"), FIELDS.service).state, "warn");
      assert.deepEqual(reconcile("charlie-pm"), { declared: "opted-out", evidence: "not-applicable" });
      assert.equal(leafOf(agentNamed(data, "charlie-pm"), FIELDS.service).state, "pass");
      assert.deepEqual(reconcile("delta-pm"), { declared: "undeclared", evidence: "not-applicable" });
      assert.ok(kindsOf(leafOf(agentNamed(data, "delta-pm"), FIELDS.service)).includes("reconcile-undeclared"));
      assert.equal(leafOf(agentNamed(data, "delta-pm"), FIELDS.service).state, "warn", "a role that declares no policy is a gap to declare, not drift");
      assert.deepEqual(reconcile("echo-pm"), { declared: "enabled", evidence: "full-run" });
      assert.equal(leafOf(agentNamed(data, "echo-pm"), FIELDS.service).state, "pass");

      // The state file's VALUES never leave it: only the presence of two keys
      // is read, and `last_decision` carried a sentinel.
      assert.equal(result.stdout.includes(SECRET_SENTINEL), false, "a value from the heartbeat state file reached stdout");

      // The matrix's headline sub-case: reconcile ON with a state file that
      // EXISTS and evidences only a checkpoint. `alpha-pm` above has no state
      // file at all -- a different branch (`state-missing`) -- so the
      // key-presence predicate was only ever exercised in its true form. Three
      // shapes, because the predicate reads BOTH keys: with `||` in place of
      // `&&`, or either key name dropped, the one-key rows report `full-run`.
      for (const [label, body] of [
        ["neither key", { last_decision: SECRET_SENTINEL }],
        ["only last_full_run_epoch", { last_full_run_epoch: 1 }],
        ["only last_runner_completed_at", { last_runner_completed_at: "2026-01-01T00:00:00Z" }],
      ]) {
        writeFileSync(alphaState, `${JSON.stringify(body)}\n`, "utf8");
        setState(canonicalState());
        const partial = systemdRun();
        const alpha = agentNamed(partial, "alpha-pm");
        assert.deepEqual(alpha.systemd.heartbeat.reconcile, { declared: "enabled", evidence: "checkpoint-only" }, label);
        assert.ok(kindsOf(leafOf(alpha, FIELDS.service)).includes("checkpoint-only"), `${label}: ${JSON.stringify(kindsOf(leafOf(alpha, FIELDS.service)))}`);
        assert.equal(leafOf(alpha, FIELDS.service).state, "fail", label);
      }
    } finally {
      rmSync(statePath, { force: true });
      rmSync(alphaState, { force: true });
      for (const name of AGENT_IDS) {
        writeFileSync(join(roleDirOf(name), "role.yaml"), YAML.stringify({ role: "pm", reconcile: { enabled: false, explicit_opt_out: true } }), "utf8");
      }
    }
    const after = snapshotTree("roles", reposRoot);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => before[key] !== after[key] && !key.includes("role.yaml") && !key.includes("continuous-ticket-sentinel-state.json") && !key.endsWith("runtime") && !key.endsWith(join("hermes", "pm")));
    assert.deepEqual(changed, [], `the observer wrote to a role directory: ${changed.join(", ")}`);
  });

  check("an unreadable reconcile policy or state file is an error, never a verdict", () => {
    const policy = join(roleDirOf("alpha-pm"), "role.yaml");
    const saved = readFileSync(policy, "utf8");
    writeFileSync(policy, YAML.stringify({ role: "pm", reconcile: { enabled: true } }), "utf8");
    const statePath = join(roleDirOf("alpha-pm"), "runtime", "continuous-ticket-sentinel-state.json");
    writeFileSync(statePath, "{not json\n", "utf8");
    try {
      setState(canonicalState());
      const data = systemdRun();
      const alpha = agentNamed(data, "alpha-pm");
      assert.deepEqual(alpha.systemd.heartbeat.reconcile, { declared: "enabled", evidence: "state-unreadable" });
      assert.equal(leafOf(alpha, FIELDS.service).state, "error", "a file the observer could not parse is a collection failure, not drift");
    } finally {
      writeFileSync(policy, saved, "utf8");
      rmSync(statePath, { force: true });
    }
  });

  // -- AC5: topology drift ---------------------------------------------------

  check("retired keys, retired units, duplicates, misnames and absences are all topology", () => {
    const registry = join(temp, "topology-agents.yaml");
    const rows = AGENTS.map((agent) => {
      if (agent.name === "alpha-pm") {
        return { ...agent, rowOverrides: { systemd: { gateway_unit: unitsOf("alpha-pm").gateway, heartbeat_timer: unitsOf("alpha-pm").timer, checkpoint_timer: "hermes-alpha-pm-checkpoint.timer" } } };
      }
      if (agent.name === "bravo-pm") {
        return { ...agent, rowOverrides: { systemd: { gateway_unit: "hermes-bravo-pm-messaging.service", heartbeat_timer: unitsOf("bravo-pm").timer } } };
      }
      // `charlie-pm` declares NO heartbeat timer while the units are on disk.
      if (agent.name === "charlie-pm") return { ...agent, rowOverrides: { systemd: { gateway_unit: unitsOf("charlie-pm").gateway } } };
      return agent;
    });
    writeAgentRegistry(registry, rows);

    const nowUs = monotonicNowUs();
    setState(mergeUnitSets(
      { manager: { stdout: "running", exit: 0 } },
      ...AGENTS.filter((agent) => agent.name !== "echo-pm").map((agent) => agentUnits(agent.name, {
        nowUs,
        gatewayEnabled: agent.telegram === "verified", gatewayActive: agent.telegram === "verified",
      })),
      // The retired consumer, still on disk for alpha.
      {
        units: { "hermes-alpha-pm-consumer.service": { Id: "hermes-alpha-pm-consumer.service", LoadState: "loaded", UnitFileState: "disabled", ActiveState: "inactive", SubState: "dead" } },
        list_units: [{ unit: "hermes-alpha-pm-consumer.service", load: "loaded", active: "inactive", sub: "dead", description: "retired consumer" }],
        unit_files: [{ unit_file: "hermes-alpha-pm-consumer.service", state: "disabled", preset: null }],
      },
      // The unit bravo's ROW points at, which is not the canonical name.
      {
        units: { "hermes-bravo-pm-messaging.service": { Id: "hermes-bravo-pm-messaging.service", LoadState: "loaded", UnitFileState: "enabled", ActiveState: "active", SubState: "running" } },
        list_units: [{ unit: "hermes-bravo-pm-messaging.service", load: "loaded", active: "active", sub: "running", description: "second gateway" }],
        unit_files: [{ unit_file: "hermes-bravo-pm-messaging.service", state: "enabled", preset: null }],
      },
      // A SECOND unit with the canonical gateway SHAPE for the same agent --
      // two gateways racing one channel. This is what the duplicate rule reads
      // (`hermes-<id>-*gateway.service`); the misnamed unit above does not end
      // in `gateway.service` and is a different defect entirely, so before this
      // fixture the `duplicate-gateway` item was produced by no test at all and
      // deleting its emission turned nothing red.
      {
        units: { "hermes-bravo-pm-secondary-gateway.service": { Id: "hermes-bravo-pm-secondary-gateway.service", LoadState: "loaded", UnitFileState: "enabled", ActiveState: "active", SubState: "running" } },
        list_units: [{ unit: "hermes-bravo-pm-secondary-gateway.service", load: "loaded", active: "active", sub: "running", description: "a second canonical-shaped gateway" }],
        unit_files: [{ unit_file: "hermes-bravo-pm-secondary-gateway.service", state: "enabled", preset: null }],
      },
      sharedGateway({ nowUs }),
    ));
    const data = status(cli(["review", "--domain", "systemd", "--json", "--agent-registry", registry]));

    const alpha = agentNamed(data, "alpha-pm");
    const alphaTopology = leafOf(alpha, FIELDS.topology);
    assert.equal(alphaTopology.state, "fail");
    assert.ok(detailsOf(alphaTopology).includes("registry-retired-key:checkpoint_timer"), JSON.stringify(detailsOf(alphaTopology)));
    assert.ok(detailsOf(alphaTopology).includes("retired-unit:hermes-alpha-pm-consumer.service"), JSON.stringify(detailsOf(alphaTopology)));
    assert.deepEqual(alpha.systemd.topology.extra, [{ unit: "hermes-alpha-pm-consumer.service", class: "retired" }]);

    const bravo = agentNamed(data, "bravo-pm");
    const bravoTopology = leafOf(bravo, FIELDS.topology);
    assert.equal(bravoTopology.state, "fail");
    assert.ok(detailsOf(bravoTopology).includes("misnamed-gateway:hermes-bravo-pm-messaging.service"), JSON.stringify(detailsOf(bravoTopology)));
    assert.ok(detailsOf(bravoTopology).includes("duplicate-gateway:hermes-bravo-pm-secondary-gateway.service"), JSON.stringify(detailsOf(bravoTopology)));
    assert.deepEqual(bravo.systemd.topology.extra, [
      { unit: "hermes-bravo-pm-messaging.service", class: "duplicate-gateway" },
      { unit: "hermes-bravo-pm-secondary-gateway.service", class: "duplicate-gateway" },
    ], JSON.stringify(bravo.systemd.topology.extra));

    const charlie = agentNamed(data, "charlie-pm");
    const charlieRow = leafOf(charlie, FIELDS.heartbeatTimerRow);
    assert.equal(charlieRow.state, "fail");
    assert.deepEqual(kindsOf(charlieRow), ["registry-undeclared"]);

    // `echo-pm` has no unit at all.
    const echo = agentNamed(data, "echo-pm");
    const echoTopology = leafOf(echo, FIELDS.topology);
    assert.equal(echoTopology.state, "fail");
    assert.deepEqual(kindsOf(echoTopology).sort(), ["gateway-missing", "heartbeat-service-missing", "heartbeat-timer-missing"]);
    assert.deepEqual(kindsOf(leafOf(echo, FIELDS.gateway)), ["absent"]);
    assert.deepEqual(kindsOf(leafOf(echo, FIELDS.timer)), ["absent"]);
    assert.deepEqual(kindsOf(leafOf(echo, FIELDS.service)), ["absent"]);
    // The SEVERITY, on all three: `absent` reaches `fail` through the default
    // arm of three separate ternaries, so moving it into any warn arm would
    // have downgraded every one of them silently.
    for (const field of [FIELDS.gateway, FIELDS.timer, FIELDS.service]) {
      assert.equal(leafOf(echo, field).state, "fail", `${field}: a registered agent with no unit is drift, not a warning`);
    }
    assert.deepEqual(kindsOf(leafOf(echo, FIELDS.heartbeatTimerRow)), ["unit-missing"]);
    assert.equal(leafOf(echo, FIELDS.heartbeatTimerRow).state, "fail", "a row naming a timer the manager does not load is drift");
    assert.deepEqual(echo.systemd.topology.installed, []);
    assert.equal(echo.systemd.topology.missing.length, 3);
  });

  // -- AC6: the unregistered sweep -------------------------------------------

  check("a row naming a heartbeat timer the contract does not derive is misnamed, and fails", () => {
    // The one branch of that leaf's three no case drove: delete the arm and a
    // row pointing at a unit the provisioner will never touch reads `pass`.
    const registry = join(temp, "misnamed-timer-agents.yaml");
    writeAgentRegistry(registry, AGENTS.map((agent) => (
      agent.name === "delta-pm"
        ? { ...agent, rowOverrides: { systemd: { gateway_unit: unitsOf("delta-pm").gateway, heartbeat_timer: "hermes-delta-pm-tick.timer" } } }
        : agent
    )));
    setState(canonicalState());
    const data = status(cli(["review", "--domain", "systemd", "--json", "--agent-registry", registry]));
    const row = leafOf(agentNamed(data, "delta-pm"), FIELDS.heartbeatTimerRow);
    assert.deepEqual(detailsOf(row), ["misnamed-heartbeat-timer:hermes-delta-pm-tick.timer"], JSON.stringify(detailsOf(row)));
    assert.equal(row.state, "fail");
    assert.equal(agentNamed(data, "delta-pm").systemd.heartbeat.timer.unit, unitsOf("delta-pm").timer, "the LEAF still reads the canonical unit");
    // Every other agent's row leaf is untouched by the rename.
    for (const id of AGENT_IDS.filter((name) => name !== "delta-pm")) {
      assert.equal(leafOf(agentNamed(data, id), FIELDS.heartbeatTimerRow).state, "pass", id);
    }
  });

  check("every unregistered hermes unit lands in one of five classes and is left alone", () => {
    const contract = writeContract("managed-unit", (document) => {
      document.classifications.managed_shared_service.entries.push({
        id: "fleet-observability-shim",
        kind: "shared-service",
        owner: "runtime-template",
        source: "units.hermes-observability.service",
        lifecycle_state: "managed",
        rationale: "An operator declared this unit and the control plane leaves it alone.",
        policy_domains: ["systemd"],
      });
    });
    const nowUs = monotonicNowUs();
    setState(mergeUnitSets(
      canonicalState({}),
      {
        units: {
          // A unit whose HERMES_HOME is the fleet root, not a profile.
          "hermes-dashboard.service": { Id: "hermes-dashboard.service", LoadState: "loaded", UnitFileState: "enabled", ActiveState: "active", SubState: "running", Environment: `HERMES_HOME=${fleetHome}`, Description: "hermes dashboard" },
          // A unit whose HERMES_HOME names an UNREGISTERED profile directory.
          "hermes-stray-pm-gateway.service": { Id: "hermes-stray-pm-gateway.service", LoadState: "loaded", UnitFileState: "enabled", ActiveState: "active", SubState: "running", Environment: `HERMES_HOME=${join(profileRoot, "stray-pm")}`, Description: "stray gateway" },
          // A retired shape the contract's own `retired[].detect` matches.
          "hermes-old-pm-consumer.service": { Id: "hermes-old-pm-consumer.service", LoadState: "not-found", UnitFileState: "", ActiveState: "inactive", SubState: "dead" },
          // A transient scope whose description names a REGISTERED profile.
          "hermes-worker-proc_x.scope": { Id: "hermes-worker-proc_x.scope", LoadState: "loaded", UnitFileState: "transient", ActiveState: "active", SubState: "running", Description: `[systemd-run] /usr/bin/zsh -lic "hermes --profile alpha-pm chat -Q --query-file ${join(temp, "q.txt")}"` },
          // The unit a `managed_shared_service` entry claims.
          "hermes-observability.service": { Id: "hermes-observability.service", LoadState: "loaded", UnitFileState: "enabled", ActiveState: "active", SubState: "running", Description: "declared shared service" },
        },
        list_units: [
          { unit: "hermes-dashboard.service", load: "loaded", active: "active", sub: "running", description: "hermes dashboard" },
          { unit: "hermes-stray-pm-gateway.service", load: "loaded", active: "active", sub: "running", description: "stray gateway" },
          { unit: "hermes-old-pm-consumer.service", load: "not-found", active: "inactive", sub: "dead", description: "" },
          { unit: "hermes-worker-proc_x.scope", load: "loaded", active: "active", sub: "running", description: `[systemd-run] hermes --profile alpha-pm chat` },
          { unit: "hermes-observability.service", load: "loaded", active: "active", sub: "running", description: "declared shared service" },
        ],
        unit_files: [
          { unit_file: "hermes-dashboard.service", state: "enabled", preset: null },
          { unit_file: "hermes-stray-pm-gateway.service", state: "enabled", preset: null },
          { unit_file: "hermes-worker-proc_x.scope", state: "transient", preset: null },
          { unit_file: "hermes-observability.service", state: "enabled", preset: null },
        ],
      },
    ));
    const unitDirBefore = snapshotTree("units", join(scratchHome, ".config", "systemd", "user"));
    const data = status(cli(["review", "--domain", "systemd", "--json", "--contract", contract]));
    // Captured BEFORE the delta run below, which spawns its own children.
    const sweepVerbs = fakeSystemctlVerbs(systemctlShim);

    const finding = hostNamed(data, "systemd.unregistered");
    assert.equal(finding.state, "warn", finding.summary);
    const byUnit = new Map(finding.items.map((item) => [item.unit, item]));
    assert.equal(byUnit.get("hermes-dashboard.service").class, "unclassified");
    assert.equal(byUnit.get("hermes-stray-pm-gateway.service").class, "profile-correlated");
    assert.equal(byUnit.get("hermes-stray-pm-gateway.service").correlated_profile, "stray-pm");
    assert.equal(byUnit.get("hermes-old-pm-consumer.service").class, "retired");
    assert.equal(byUnit.get("hermes-worker-proc_x.scope").class, "transient");
    assert.equal(byUnit.get("hermes-worker-proc_x.scope").correlated_profile, "alpha-pm");
    assert.equal(byUnit.get("hermes-observability.service").class, "managed-exception");
    for (const item of finding.items) {
      assert.equal(item.process_reference, "unobserved", `${item.unit}: process attribution is story 1.9`);
      assert.ok(typeof item.guidance === "string" && item.guidance.length > 0, `${item.unit} must carry guidance`);
    }
    assert.deepEqual(Object.keys(data.systemd.unregistered.by_class).sort(), [...UNREGISTERED_CLASSES].sort());
    assert.equal(data.systemd.unregistered.total, 5);
    assert.equal(data.systemd.unregistered.coverage, "swept");
    // A warn with no `allowed_warnings` ruling keeps the fleet from claiming
    // proof -- by design, and an operator ruling is the only thing that lifts
    // it. Proven by the DELTA rather than by the fleet's verdict: `charlie-pm`
    // has a real gateway failure in this fixture, so the verdict is `unhealthy`
    // for a reason that has nothing to do with the sweep.
    assert.equal(data.health.proven, false);
    const ruled = writeContract("unregistered-allowed", (document) => {
      document.classifications.managed_shared_service.entries.push({
        id: "fleet-observability-shim", kind: "shared-service", owner: "runtime-template",
        source: "units.hermes-observability.service", lifecycle_state: "managed",
        rationale: "An operator declared this unit and the control plane leaves it alone.",
        policy_domains: ["systemd"],
      });
      document.health_policy.allowed_warnings.push({
        rule_id: "systemd.unregistered",
        reason: "The operator has reviewed every unregistered hermes unit on this host and is leaving them alone.",
        owner: "suite",
      });
    });
    const lifted = status(cli(["review", "--domain", "systemd", "--json", "--contract", ruled]));
    const liftedFinding = hostNamed(lifted, "systemd.unregistered");
    assert.equal(liftedFinding.state, "warn", "the state is unchanged; only the AUTHORIZATION is new");
    assert.ok(liftedFinding.justification, "an allowed_warnings ruling must be named on the finding");
    assert.ok(lifted.health.unjustified < data.health.unjustified, `the ruling must remove one unjustified reading: ${data.health.unjustified} -> ${lifted.health.unjustified}`);
    // The manager was swept; the unit DIRECTORY was not touched.
    assert.deepEqual(snapshotTree("units", join(scratchHome, ".config", "systemd", "user")), unitDirBefore);

    // ONE extra child, and only because there was something to classify.
    assert.equal(sweepVerbs.filter((verb) => verb === "show").length, data.systemd.window.samples + 1, JSON.stringify(sweepVerbs));
  });

  check("a listing the manager answered but this run could not read is a FINDING, not a buried reason", () => {
    // Three shapes, one per code `listFleet` can produce with an available
    // manager. Before this the sweep failed silently: `systemd.manager` read
    // `pass`, no `systemd.unregistered` finding was emitted AT ALL, and the
    // only trace was `data.systemd.unregistered.reason` several levels down the
    // payload -- so the host findings showed a clean sweep of a manager nobody
    // swept. The fake has implemented `malformed` since the story landed and no
    // case had ever used it.
    const shortTimeout = writeContract("listing-timeout", (document) => {
      document.service_manifest.probe.timeout_ms = 400;
    });
    const cases = [
      ["listing-malformed", { ...canonicalState(), malformed: true }, []],
      ["listing-failed", { ...canonicalState(), listing: { exit: 4 } }, []],
      ["listing-timeout", { ...canonicalState(), listing: { delay_ms: 3000 } }, ["--contract", shortTimeout]],
    ];
    for (const [reason, state, extraArgs] of cases) {
      setState(state);
      resetFakeSystemctl(systemctlShim);
      const data = status(cli(["review", "--domain", "systemd", "--json", ...extraArgs]));
      // The manager itself ANSWERED: this is not a manager failure, and saying
      // it was would send an operator to the wrong place.
      assert.equal(data.systemd.manager.code, "available", reason);
      assert.equal(hostNamed(data, "systemd.manager").state, "pass", reason);
      // ... and the sweep is visibly absent.
      assert.equal(data.systemd.unregistered.coverage, "not-swept", reason);
      assert.equal(data.systemd.unregistered.reason, reason, reason);
      assert.equal(data.systemd.unregistered.total, 0, reason);
      const finding = hostNamed(data, "systemd.unregistered");
      assert.equal(finding.state, "error", `${reason}: an unreadable sweep is a collection failure, never a clean one`);
      assert.match(finding.summary, new RegExp(reason, "u"), finding.summary);
      assert.ok(finding.details.some((line) => line.includes(reason)), `${reason}: ${JSON.stringify(finding.details)}`);
      assert.equal(data.health.proven, false, reason);
      // The per-agent leaves are still READ: the units come from `show`, which
      // this failure did not touch.
      assert.equal(leafOf(agentNamed(data, "alpha-pm"), FIELDS.gateway).state, "pass", reason);
    }
  });

  check("a listing that hit the unit cap says the sweep saw only a prefix", () => {
    // `Listing.truncated` was written and read nowhere: over-cap units vanished
    // with no note, no probe reason and no field, while the sibling
    // `max_unregistered_units` cap IS reported.
    const capped = writeContract("small-max-units", (document) => {
      document.service_manifest.limits.max_units = 2;
    });
    setState(canonicalState());
    resetFakeSystemctl(systemctlShim);
    const data = status(cli(["review", "--domain", "systemd", "--json", "--contract", capped]));
    assert.ok(
      data.truncated.some((note) => /more than 2 hermes-\* unit\(s\)/u.test(note)),
      `the cap must be reported: ${JSON.stringify(data.truncated)}`,
    );
    assert.ok(data.truncated.some((note) => note.startsWith("host[systemd.unregistered]")), JSON.stringify(data.truncated));
    // The uncapped run says nothing of the kind.
    setState(canonicalState());
    const whole = systemdRun();
    assert.equal(whole.truncated.some((note) => /more than \d+ hermes-\* unit\(s\)/u.test(note)), false, JSON.stringify(whole.truncated));
  });

  // -- AC7: the fleet-shared gateway and agent scope -------------------------

  check("the fleet-shared gateway is correlated once, by name and by home", () => {
    setState(canonicalState());
    const data = systemdRun();
    const finding = hostNamed(data, "systemd.shared-gateway");
    assert.equal(finding.state, "pass", finding.summary);
    assert.deepEqual(data.systemd.shared, {
      coverage: "observed",
      unit: "hermes-fleet-bloodbank-gateway.service",
      profile: "fleet-bloodbank-gateway",
      state: "healthy",
      code: null,
    });
  });

  check("a registry naming a different shared unit is an identity mismatch", () => {
    const registry = join(temp, "mismatched-gateway.yaml");
    writeAgentRegistry(registry, AGENTS, { bloodbank: { ...GATEWAYS_BLOCK.bloodbank, systemd_unit: "hermes-some-other-gateway.service" } });
    setState(canonicalState());
    const data = status(cli(["review", "--domain", "systemd", "--json", "--agent-registry", registry]));
    assert.equal(data.systemd.shared.state, "identity-mismatch");
    assert.equal(data.systemd.shared.code, "identity-mismatch");
    assert.equal(hostNamed(data, "systemd.shared-gateway").state, "fail");
  });

  check("--agent lists nothing, correlates nothing, and shows only that agent's units", () => {
    setState(canonicalState());
    const data = systemdRun(["--agent", "alpha-pm"]);
    assert.equal(data.systemd.shared.coverage, "unobserved");
    assert.equal(data.systemd.unregistered.coverage, "not-swept");
    assert.equal(data.systemd.unregistered.reason, "agent-scope");
    assert.equal(data.host.some((finding) => finding.rule_id === "systemd.shared-gateway"), false, "an --agent run must not report a coverage it never collected");
    assert.equal(data.host.some((finding) => finding.rule_id === "systemd.unregistered"), false);
    assert.ok(hostNamed(data, "systemd.manager"), "the manager is reported in EVERY scope");

    const verbs = fakeSystemctlVerbs(systemctlShim);
    assert.equal(verbs.includes("list-units"), false, "an --agent run lists nothing");
    assert.equal(verbs.includes("list-unit-files"), false);
    const shows = fakeSystemctlInvocations(systemctlShim).filter((argv) => argv.includes("show"));
    assert.ok(shows.length > 0, "the agent's own units must still be sampled");
    const named = shows[0].filter((token) => token.startsWith("hermes-"));
    const allowed = new Set([
      ...Object.values(unitsOf("alpha-pm")),
      "hermes-alpha-pm-consumer.service", "hermes-alpha-pm-checkpoint.timer", "hermes-alpha-pm-checkpoint.service",
    ]);
    for (const unit of named) assert.ok(allowed.has(unit), `an --agent run must name only alpha-pm's units and its retired candidates, got ${unit}`);
    assert.equal(data.systemd.agents.selected, 1);
    assert.equal(data.systemd.agents.total_registered, AGENTS.length);
    assert.equal(data.systemd.agents.unobserved, AGENTS.length - 1);
  });

  check("--agent scope cannot see the two readings that need a listing, and the difference is pinned", () => {
    // `duplicate-gateway` and the unit-file half of `registry-undeclared` both
    // come from the fleet listings, which an `--agent` run never spawns. That
    // is a real coverage difference and it was documented nowhere: the README
    // named only `shared.coverage` and `unregistered.coverage` as scope
    // dependent, so an operator reading a clean `--agent` topology leaf had no
    // way to know two of its codes could not fire at all.
    const registry = join(temp, "agent-scope-agents.yaml");
    // `charlie-pm` declares NO heartbeat timer while its units are on disk.
    writeAgentRegistry(registry, AGENTS.map((agent) => (
      agent.name === "charlie-pm"
        ? { ...agent, rowOverrides: { systemd: { gateway_unit: unitsOf("charlie-pm").gateway } } }
        : agent
    )));
    const second = {
      units: { "hermes-alpha-pm-second-gateway.service": { Id: "hermes-alpha-pm-second-gateway.service", LoadState: "loaded", UnitFileState: "enabled", ActiveState: "active", SubState: "running" } },
      list_units: [{ unit: "hermes-alpha-pm-second-gateway.service", load: "loaded", active: "active", sub: "running", description: "a second gateway" }],
      unit_files: [{ unit_file: "hermes-alpha-pm-second-gateway.service", state: "enabled", preset: null }],
    };
    setState(mergeUnitSets(canonicalState(), second));

    const fleetWide = status(cli(["review", "--domain", "systemd", "--json", "--agent-registry", registry]));
    assert.ok(
      detailsOf(leafOf(agentNamed(fleetWide, "alpha-pm"), FIELDS.topology)).includes("duplicate-gateway:hermes-alpha-pm-second-gateway.service"),
      JSON.stringify(detailsOf(leafOf(agentNamed(fleetWide, "alpha-pm"), FIELDS.topology))),
    );
    assert.deepEqual(kindsOf(leafOf(agentNamed(fleetWide, "charlie-pm"), FIELDS.heartbeatTimerRow)), ["registry-undeclared"]);

    setState(mergeUnitSets(canonicalState(), second));
    const alphaOnly = status(cli(["review", "--domain", "systemd", "--json", "--agent", "alpha-pm", "--agent-registry", registry]));
    assert.deepEqual(kindsOf(leafOf(agentNamed(alphaOnly, "alpha-pm"), FIELDS.topology)), [], "the duplicate is invisible without a listing");
    assert.deepEqual(agentNamed(alphaOnly, "alpha-pm").systemd.topology.extra, []);
    setState(mergeUnitSets(canonicalState(), second));
    const charlieOnly = status(cli(["review", "--domain", "systemd", "--json", "--agent", "charlie-pm", "--agent-registry", registry]));
    assert.deepEqual(
      kindsOf(leafOf(agentNamed(charlieOnly, "charlie-pm"), FIELDS.heartbeatTimerRow)), ["registry-undeclared"],
      "the timer is LOADED here, so the row leaf still reads it without a listing",
    );
  });

  // -- AC8: collection failures ----------------------------------------------

  check("no reachable user manager makes every leaf an error and samples nothing", () => {
    setState(canonicalState());
    // No `systemctl` on PATH at all, and a bus address that points at nothing.
    const emptyBin = join(shimRoot, "no-systemctl");
    mkdirSync(emptyBin, { recursive: true });
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    if (!existsSync(join(emptyBin, "git"))) symlinkSync(realGit, join(emptyBin, "git"));
    resetFakeSystemctl(systemctlShim);
    const data = status(cli(["review", "--domain", "systemd", "--json"], { PATH: emptyBin }));

    for (const id of AGENT_IDS) {
      for (const field of FIELD_ORDER) {
        const leaf = leafOf(agentNamed(data, id), field);
        assert.equal(leaf.state, "error", `${id} ${field}`);
        assert.deepEqual(kindsOf(leaf), ["manager-unavailable"], `${id} ${field}`);
      }
      // The UNIT each error leaf names. Asserting only `state` and the kind let
      // the two heartbeat leaves swap units on every collection-error path --
      // `expected` is sorted for the payload, and the canonical triple sorts
      // gateway, heartbeat.service, heartbeat.timer, so a positional read handed
      // the timer leaf the service and the service leaf the timer. This is the
      // path where an operator has the least other evidence.
      assertErrorLeavesNameTheirUnits(agentNamed(data, id), "manager-unavailable");
    }
    assert.equal(hostNamed(data, "systemd.manager").state, "error");
    assert.equal(data.systemd.manager.code, "manager-unavailable");
    assert.deepEqual(fakeSystemctlVerbs(systemctlShim), [], "the shim was not on PATH, so it recorded nothing");
    const probes = data.probes.filter((probe) => probe.kind === "systemd");
    assert.equal(probes.length, 1, `only the manager probe may run: ${JSON.stringify(probes)}`);
    assert.equal(probes[0].id, "systemd:is-system-running");
  });

  check("a manager this run could not reach leaves every other domain reading exactly as it did", () => {
    // The row's "registry/profile domains unaffected" clause, proven by
    // DIFFERENCE over two UNFILTERED runs whose only difference is the
    // manager's answer. Every other manager-failure case runs `--domain
    // systemd`, which never evaluates those domains at all -- so none of them
    // could have shown this in either direction.
    setState(canonicalState());
    resetFakeSystemctl(systemctlShim);
    const healthy = status(cli(["review", "--json"]));
    const reachable = healthy.agents.map((agent) => `${agent.agent_id} registry:${agent.domains.registry} profile:${agent.domains.profile}`);
    assert.ok(reachable.length === AGENTS.length && reachable.every((line) => !line.includes("undefined")), JSON.stringify(reachable));

    // `is-system-running` answering with an empty stdout: the matrix's own input.
    setState({ ...canonicalState(), manager: { stdout: "", exit: 1 } });
    const broken = status(cli(["review", "--json"]));
    assert.equal(broken.systemd.manager.code, "manager-unavailable");
    assert.equal(broken.systemd.manager.state, "unreachable");
    assert.equal(hostNamed(broken, "systemd.manager").state, "error");
    for (const id of AGENT_IDS) {
      for (const field of FIELD_ORDER) {
        assert.deepEqual(kindsOf(leafOf(agentNamed(broken, id), field)), ["manager-unavailable"], `${id} ${field}`);
        assert.equal(leafOf(agentNamed(broken, id), field).state, "error", `${id} ${field}`);
      }
      assertErrorLeavesNameTheirUnits(agentNamed(broken, id), "manager-unavailable");
    }
    assert.deepEqual(
      broken.agents.map((agent) => `${agent.agent_id} registry:${agent.domains.registry} profile:${agent.domains.profile}`),
      reachable,
      "a manager this run could not reach must not move a domain that never asked it anything",
    );
  });

  check("a manager that does not answer in time is a timeout, and the run still succeeds", () => {
    const contract = writeContract("short-timeout", (document) => {
      document.service_manifest.probe.timeout_ms = 300;
    });
    setState({ ...canonicalState(), manager: { stdout: "running", exit: 0, delay_ms: 3000 } });
    const started = Date.now();
    const data = status(cli(["review", "--domain", "systemd", "--json", "--contract", contract]));
    const elapsed = Date.now() - started;
    assert.equal(data.systemd.manager.code, "manager-timeout");
    assert.equal(hostNamed(data, "systemd.manager").state, "error");
    // PER AGENT, as the row says -- not on alpha-pm alone.
    for (const id of AGENT_IDS) {
      for (const field of FIELD_ORDER) {
        assert.deepEqual(kindsOf(leafOf(agentNamed(data, id), field)), ["manager-timeout"], `${id} ${field}`);
        assert.equal(leafOf(agentNamed(data, id), field).state, "error", `${id} ${field}`);
      }
      assertErrorLeavesNameTheirUnits(agentNamed(data, id), "manager-timeout");
    }
    // ZERO sampling, asserted over the whole invocation log and the probe
    // ledger rather than over `show` alone: a stray listing after a failed
    // probe would have passed the narrower check.
    assert.deepEqual(fakeSystemctlVerbs(systemctlShim), ["is-system-running"], "a failed manager probe skips every listing and every sample");
    assert.deepEqual(
      data.probes.filter((probe) => probe.kind === "systemd").map((probe) => `${probe.id}/${probe.outcome}/${probe.reason}`),
      ["systemd:is-system-running/timeout/manager-timeout"],
      JSON.stringify(data.probes.filter((probe) => probe.kind === "systemd")),
    );
    assert.ok(elapsed < 60_000, `the child must be killed at the declared budget, took ${elapsed} ms`);
  });

  check("a manager in a state the contract does not list is unavailable, and `degraded` is not", () => {
    setState({ ...canonicalState(), manager: { stdout: "offline", exit: 1 } });
    const offline = systemdRun();
    assert.equal(offline.systemd.manager.code, "manager-unavailable");
    assert.equal(offline.systemd.manager.state, "offline");

    setState({ ...canonicalState(), manager: { stdout: "degraded", exit: 1 } });
    const degraded = systemdRun();
    assert.equal(degraded.systemd.manager.code, "available", "degraded is an AVAILABLE manager: a failed unit elsewhere does not make the fleet unobservable");
    assert.equal(degraded.systemd.manager.state, "degraded");
    assert.equal(hostNamed(degraded, "systemd.manager").state, "pass");
  });

  check("a malformed property errors that unit's leaf and no other", () => {
    setState(canonicalState({ "alpha-pm": { gatewayEnabled: true, gatewayActive: true, gatewayRestarts: "abc" } }));
    const data = systemdRun();
    const alpha = leafOf(agentNamed(data, "alpha-pm"), FIELDS.gateway);
    assert.equal(alpha.state, "error");
    assert.ok(detailsOf(alpha).includes("property-malformed:NRestarts"), JSON.stringify(detailsOf(alpha)));
    assert.equal(agentNamed(data, "alpha-pm").systemd.gateway.restarts, null);
    // Every other unit is unaffected.
    assert.equal(leafOf(agentNamed(data, "alpha-pm"), FIELDS.timer).state, "pass");
    assert.equal(leafOf(agentNamed(data, "bravo-pm"), FIELDS.gateway).state, "pass");
    assert.equal(data.systemd.manager.code, "available");

    // The matrix's OTHER input: a property the manager did not report at all.
    // The fake omits any property whose value is `undefined`, so this is a
    // `show` block that carries the unit and not its `ActiveState` -- which
    // the observer must refuse to read rather than coerce to `""` and report
    // `inactive` about a property nobody read.
    setState(canonicalState({
      "alpha-pm": { gatewayEnabled: true, gatewayActive: true, gatewaySamples: [{ ActiveState: undefined }] },
      // The oneshot's own malformed-property site, which had no test at all.
      "charlie-pm": { serviceExecStatus: "abc" },
      // The CONTROL: an ABSENT unit reports every required property (systemd
      // prints all four for a `not-found` unit, with an empty UnitFileState),
      // so it must keep reading `absent` and never `property-malformed`.
      "delta-pm": { present: { gateway: false, timer: true, service: true } },
      // The GATEWAY's own numeric-parse site, which swallowed this silently:
      // `NaN` fails the `!== 0` test, so the unit read as a clean exit and the
      // summary carried `exec_status: null` with nothing to say why.
      "echo-pm": { gatewayEnabled: true, gatewayActive: true, gatewayExecStatus: "abc" },
    }));
    const missing = systemdRun();

    const alphaGateway = leafOf(agentNamed(missing, "alpha-pm"), FIELDS.gateway);
    assert.equal(alphaGateway.state, "error");
    assert.deepEqual(detailsOf(alphaGateway), ["property-malformed:ActiveState"], JSON.stringify(detailsOf(alphaGateway)));
    assert.equal(agentNamed(missing, "alpha-pm").systemd.gateway.active, null, "a property the manager did not report is null, never a word");
    // That unit's leaf ONLY: the same agent's other two units, and every other
    // agent, are read normally out of the same window.
    assert.equal(leafOf(agentNamed(missing, "alpha-pm"), FIELDS.timer).state, "pass");
    assert.equal(leafOf(agentNamed(missing, "alpha-pm"), FIELDS.service).state, "pass");
    assert.equal(leafOf(agentNamed(missing, "bravo-pm"), FIELDS.gateway).state, "pass");

    const charlieService = leafOf(agentNamed(missing, "charlie-pm"), FIELDS.service);
    assert.equal(charlieService.state, "error");
    assert.ok(detailsOf(charlieService).includes("property-malformed:ExecMainStatus"), JSON.stringify(detailsOf(charlieService)));
    assert.equal(agentNamed(missing, "charlie-pm").systemd.heartbeat.latest_result, "unknown");
    assert.equal(agentNamed(missing, "charlie-pm").systemd.heartbeat.service.exec_status, null);

    const deltaGateway = leafOf(agentNamed(missing, "delta-pm"), FIELDS.gateway);
    assert.deepEqual(kindsOf(deltaGateway), ["absent"], "an absent unit is a complete reading of a unit that is not there");
    assert.equal(deltaGateway.state, "fail");

    const echoGateway = leafOf(agentNamed(missing, "echo-pm"), FIELDS.gateway);
    assert.equal(echoGateway.state, "error");
    assert.ok(detailsOf(echoGateway).includes("property-malformed:ExecMainStatus"), JSON.stringify(detailsOf(echoGateway)));
    assert.equal(agentNamed(missing, "echo-pm").systemd.gateway.exec_status, null);
  });

  check("a fragment or a profile home outside the declared roots is unsafe, shown redacted", () => {
    setState(canonicalState({
      // Both unsafe paths sit UNDER the scratch HOME on purpose: a sibling of
      // HOME (`<tmp>/elsewhere`) passes through `redactHome` verbatim, so the
      // row's "path shown redacted" half would have been asserted over a string
      // that never needed redacting -- and replacing `shown(...)` with the raw
      // path would have broken nothing.
      "alpha-pm": { gatewayEnabled: true, gatewayActive: true, gatewayFragment: join(scratchHome, "elsewhere", "hermes-alpha-pm-gateway.service") },
      "delta-pm": { gatewayEnabled: true, gatewayActive: true, gatewayHome: join(scratchHome, "not-the-fleet-home") },
      // The POSITIVE control: a fragment inside the declared user unit
      // directory. The default fixture's `FragmentPath` is empty and
      // short-circuits, so nothing proved the allowlist ever ACCEPTS anything.
      "bravo-pm": { gatewayFragment: join(scratchHome, ".config", "systemd", "user", "hermes-bravo-pm-gateway.service") },
      // The RUNTIME control: `systemctl --user enable|link --runtime` installs
      // under `$XDG_RUNTIME_DIR/systemd/user`, and `enabled-runtime` /
      // `linked-runtime` are states this build already reads as legitimately
      // enabled -- so leaving that directory out of the safe set made the one
      // shape the enabled vocabulary explicitly allows read `fragment-unsafe`.
      "charlie-pm": { gatewayFragment: join(temp, "no-runtime", "systemd", "user", "hermes-charlie-pm-gateway.service") },
    }));
    const data = systemdRun();
    const alphaGateway = leafOf(agentNamed(data, "alpha-pm"), FIELDS.gateway);
    assert.ok(kindsOf(alphaGateway).includes("fragment-unsafe"), JSON.stringify(kindsOf(alphaGateway)));
    assert.equal(alphaGateway.state, "fail", "an unsafe fragment is drift, not a warning");
    assert.match(
      alphaGateway.items.find((item) => item.kind === "fragment-unsafe").observed, /^~\/elsewhere\//u,
      "the path must be shown home-redacted",
    );
    const deltaGateway = leafOf(agentNamed(data, "delta-pm"), FIELDS.gateway);
    assert.ok(kindsOf(deltaGateway).includes("home-unsafe"), JSON.stringify(kindsOf(deltaGateway)));
    assert.equal(deltaGateway.state, "fail");
    assert.equal(deltaGateway.items.find((item) => item.kind === "home-unsafe").observed, "~/not-the-fleet-home");
    assert.equal(agentNamed(data, "delta-pm").systemd.gateway.home, "unsafe");
    const bravoGateway = leafOf(agentNamed(data, "bravo-pm"), FIELDS.gateway);
    assert.equal(kindsOf(bravoGateway).includes("fragment-unsafe"), false, "a fragment in the declared unit directory is accepted");
    assert.equal(bravoGateway.state, "pass");
    const charlieGateway = leafOf(agentNamed(data, "charlie-pm"), FIELDS.gateway);
    assert.equal(
      kindsOf(charlieGateway).includes("fragment-unsafe"), false,
      `a runtime-installed fragment is accepted: ${JSON.stringify(detailsOf(charlieGateway))}`,
    );
    // And a home that is a REAL profile home, just not this agent's.
    setState(canonicalState({ "alpha-pm": { gatewayEnabled: true, gatewayActive: true, gatewayHome: join(profileRoot, "bravo-pm") } }));
    const second = systemdRun();
    assert.equal(agentNamed(second, "alpha-pm").systemd.gateway.home, "mismatch");
    assert.ok(kindsOf(leafOf(agentNamed(second, "alpha-pm"), FIELDS.gateway)).includes("home-mismatch"));
  });

  check("an entrypoint that is neither the launcher nor the row's pinned executable is unpinned", () => {
    const stray = join(scratchHome, ".local", "share", "hermes-agent", "releases", "def", ".venv", "bin", "hermes");
    setState(canonicalState({
      // BOTH units, because the row the matrix names (`automatic-ai-pm`) trips
      // this on its heartbeat oneshot -- a branch no case in this suite ever
      // reached, since nothing passed `serviceExec` at all.
      "alpha-pm": {
        gatewayEnabled: true, gatewayActive: true,
        gatewayExec: execLine(stray, "gateway", "run", "--replace"),
        serviceExec: execLine(stray, "heartbeat"),
      },
      "delta-pm": { gatewayEnabled: true, gatewayActive: true, gatewayExec: execLine(HERMES_BIN, "gateway", "run", "--replace") },
    }));
    const data = systemdRun();
    const alpha = agentNamed(data, "alpha-pm");
    assert.deepEqual(alpha.systemd.gateway.entrypoint, { family: "hermes-bin", pinned: false });
    assert.ok(kindsOf(leafOf(alpha, FIELDS.gateway)).includes("entrypoint-unpinned"));
    assert.equal(leafOf(alpha, FIELDS.gateway).state, "fail", "an unpinned entrypoint is drift, not a warning");
    assert.deepEqual(alpha.systemd.heartbeat.service.entrypoint, { family: "hermes-bin", pinned: false });
    assert.ok(kindsOf(leafOf(alpha, FIELDS.service)).includes("entrypoint-unpinned"), JSON.stringify(kindsOf(leafOf(alpha, FIELDS.service))));
    assert.equal(leafOf(alpha, FIELDS.service).state, "fail");
    const delta = agentNamed(data, "delta-pm");
    assert.deepEqual(delta.systemd.gateway.entrypoint, { family: "hermes-bin", pinned: true }, "the row's OWN hermes.bin is pinned");
    assert.equal(kindsOf(leafOf(delta, FIELDS.gateway)).includes("entrypoint-unpinned"), false);
    assert.deepEqual(delta.systemd.heartbeat.service.entrypoint, { family: "launcher", pinned: true }, "and the role launcher is pinned on the oneshot too");
    assert.equal(kindsOf(leafOf(delta, FIELDS.service)).includes("entrypoint-unpinned"), false);

    // A file whose name merely ENDS with the launcher's is not the launcher.
    // The family was matched by bare suffix, so `foo-credential-launch.sh`
    // anywhere on disk read as this role's own launcher -- the one family this
    // build is willing to call pinned when it resolves.
    setState(canonicalState({
      "alpha-pm": {
        gatewayEnabled: true, gatewayActive: true,
        gatewayExec: execLine(join(scratchHome, "elsewhere", "foo-credential-launch.sh"), "gateway"),
      },
    }));
    const lookalike = agentNamed(systemdRun(), "alpha-pm");
    assert.deepEqual(lookalike.systemd.gateway.entrypoint, { family: "other", pinned: false }, "a name that merely ends with the launcher's is another program");
  });

  check("a verified channel with no identity fields and no delta reference says both", () => {
    const registry = join(temp, "unbacked-verified.yaml");
    writeAgentRegistry(registry, AGENTS.map((agent) => (
      agent.name === "bravo-pm" ? { ...agent, telegram: "verified", identity: false } : agent
    )));
    setState(canonicalState({ "bravo-pm": { gatewayEnabled: true, gatewayActive: true } }));
    const data = status(cli(["review", "--domain", "systemd", "--json", "--agent-registry", registry]));
    const gateway = leafOf(agentNamed(data, "bravo-pm"), FIELDS.gateway);
    assert.equal(gateway.state, "fail");
    assert.ok(detailsOf(gateway).includes("channel-identity-incomplete:telegram"), JSON.stringify(detailsOf(gateway)));
    assert.ok(detailsOf(gateway).includes("channel-secret-unreferenced:telegram"), JSON.stringify(detailsOf(gateway)));
    // NAMES only: the environment key names reach the item, no value ever does.
    assert.equal(JSON.stringify(gateway).includes(SECRET_SENTINEL), false);
  });

  check("an undeclared row whose gateway is correctly disabled is a warning, not a failure", () => {
    setState(canonicalState({ "echo-pm": { gatewayEnabled: false, gatewayActive: false } }));
    const data = systemdRun();
    const gateway = leafOf(agentNamed(data, "echo-pm"), FIELDS.gateway);
    assert.equal(gateway.state, "warn", "a row that declares nothing and runs nothing is a gap, not drift");
    assert.deepEqual(kindsOf(gateway), ["channel-undeclared"]);
  });

  check("a deferred row whose gateway is enabled AND active says both, and fails", () => {
    // `bravo-pm` pins BOTH platforms false in its delta, so the only thing that
    // can move its gateway leaf is the unit's own enablement and activity: no
    // inherited-enablement item can be doing the work. (`charlie-pm`, the only
    // agent ever driven deferred+enabled+active before, has an empty delta and
    // failed its leaf independently -- so neither code's severity was
    // attributable and `deferred-but-active` was asserted nowhere at all.)
    setState(canonicalState({ "bravo-pm": { gatewayEnabled: true, gatewayActive: true } }));
    const data = systemdRun();
    const bravo = agentNamed(data, "bravo-pm");
    const gateway = leafOf(bravo, FIELDS.gateway);
    assert.deepEqual(kindsOf(gateway), ["deferred-but-enabled", "deferred-but-active"], JSON.stringify(detailsOf(gateway)));
    assert.deepEqual(detailsOf(gateway), ["deferred-but-enabled", "deferred-but-active"]);
    assert.equal(gateway.state, "fail", "a gateway running for a channel nobody verified is drift, not a warning");
    assert.equal(bravo.systemd.gateway.code, "deferred-but-enabled");
    assert.equal(bravo.systemd.capability.declared, "deferred");
    // The same fixture with the unit correctly disabled is the negative half.
    setState(canonicalState({ "bravo-pm": { gatewayEnabled: false, gatewayActive: false } }));
    const quiet = systemdRun();
    assert.equal(leafOf(agentNamed(quiet, "bravo-pm"), FIELDS.gateway).state, "pass");
  });

  check("a deferred platform is flagged inherited only when the fleet base actually enables it", () => {
    const basePath = join(fleetHome, "config.yaml");
    const savedBase = readFileSync(basePath, "utf8");
    const deltaPath = join(profileRoot, "charlie-pm", "config.delta.yaml");
    const savedDelta = readFileSync(deltaPath, "utf8");
    try {
      // The base ENABLES telegram, so `charlie-pm`'s empty delta inherits it --
      // and `slack`, deferred on the same row and enabled by nobody, is NOT
      // flagged: there is no enablement to pin away, and an item there would be
      // asking an operator to disable something nothing enables.
      setState(canonicalState());
      const inherited = systemdRun();
      const gateway = leafOf(agentNamed(inherited, "charlie-pm"), FIELDS.gateway);
      assert.deepEqual(detailsOf(gateway), ["platform-enablement-inherited:telegram"], JSON.stringify(detailsOf(gateway)));
      assert.equal(gateway.state, "fail");
      assert.equal(gateway.items[0].observed, "inherited");
      assert.equal(gateway.items[0].desired, "platforms.telegram.enabled: false");

      // THE CONTROL. The same delta-empty agent against a base that disables
      // telegram: the item is a claim about the base, and the base no longer
      // makes it. Nothing about the delta, the row or the unit changed.
      writeFileSync(basePath, YAML.stringify({ ...baseConfig(), platforms: { telegram: { enabled: false } } }), "utf8");
      const disabledBase = systemdRun();
      const control = leafOf(agentNamed(disabledBase, "charlie-pm"), FIELDS.gateway);
      assert.deepEqual(kindsOf(control), [], JSON.stringify(detailsOf(control)));
      assert.equal(control.state, "pass", "a deferred platform nothing enables needs no pin");

      // And a delta that pins the platform ON is still flagged against that
      // same base: what the item reports is the EFFECTIVE enablement, and the
      // delta is the half that wins when it has an opinion.
      writeFileSync(deltaPath, YAML.stringify({ platforms: { telegram: { enabled: true } } }), "utf8");
      const pinnedOn = systemdRun();
      const explicit = leafOf(agentNamed(pinnedOn, "charlie-pm"), FIELDS.gateway);
      assert.deepEqual(detailsOf(explicit), ["platform-enablement-inherited:telegram"]);
      assert.equal(explicit.items[0].observed, "true", "a delta that pins it on is not inheriting anything");
    } finally {
      writeFileSync(basePath, savedBase, "utf8");
      writeFileSync(deltaPath, savedDelta, "utf8");
    }
  });

  check("a unit-file state in neither vocabulary is said out loud, and the code names the deciding item", () => {
    // `static`, `generated` and `indirect` are none of enabled, disabled or
    // masked: nobody disabled a static unit, so a deferred gateway in that
    // state is not "correctly disabled" -- it is a reading this vocabulary
    // cannot classify, and the observer now says so instead of passing.
    setState(canonicalState({
      "alpha-pm": { gatewayFileState: "static", gatewayActive: false },
      "bravo-pm": { gatewayFileState: "generated" },
    }));
    const data = systemdRun();

    const alphaGateway = leafOf(agentNamed(data, "alpha-pm"), FIELDS.gateway);
    assert.deepEqual(kindsOf(alphaGateway).slice(0, 3), [
      "unit-file-state-unclassified", "verified-channel-gateway-disabled", "verified-channel-gateway-inactive",
    ], JSON.stringify(kindsOf(alphaGateway)));
    assert.equal(alphaGateway.state, "fail");
    assert.match(alphaGateway.items[0].observed, /static/u);
    // `desired` is clipped to 64 characters with no marker, so it has to FIT:
    // spelling both vocabularies here ended the sentence mid-word in the one
    // item whose job is to name the vocabulary the reading fell outside of.
    assert.ok(alphaGateway.items[0].desired.length <= 64, `desired is clipped at 64: ${alphaGateway.items[0].desired}`);
    assert.match(alphaGateway.items[0].desired, /enabled or a disabled UnitFileState$/u, alphaGateway.items[0].desired);
    // The CODE names the item that DECIDED the state. `items[0]` here is the
    // `warn` this case just added, so a build that reports the first item would
    // paint `gw unit-file-state-unclassified:static` beside a `fail` caused by
    // something else entirely.
    assert.equal(
      agentNamed(data, "alpha-pm").systemd.gateway.code, "verified-channel-gateway-disabled",
      "the gateway code must name the item whose own rank is the leaf's state",
    );
    assert.equal(kindsOf(alphaGateway)[0], "unit-file-state-unclassified", "and the warn really is first in the list");

    // On a DEFERRED row the same state is the whole finding: warn, because
    // nothing is proven either way -- not the pass it used to read.
    const bravoGateway = leafOf(agentNamed(data, "bravo-pm"), FIELDS.gateway);
    assert.deepEqual(kindsOf(bravoGateway), ["unit-file-state-unclassified"], JSON.stringify(detailsOf(bravoGateway)));
    assert.equal(bravoGateway.state, "warn");
    assert.equal(detailsOf(bravoGateway)[0], "unit-file-state-unclassified:generated");
    assert.equal(agentNamed(data, "bravo-pm").systemd.gateway.code, "unit-file-state-unclassified:generated");
    // And the ordinary enabled/disabled readings are untouched.
    assert.equal(leafOf(agentNamed(data, "charlie-pm"), FIELDS.gateway).state, "fail");
    assert.equal(kindsOf(leafOf(agentNamed(data, "delta-pm"), FIELDS.gateway)).includes("unit-file-state-unclassified"), false);
  });

  check("the heartbeat summary is the WORSE of its two leaves, carrying that leaf's code", () => {
    // `agents[].systemd.heartbeat.state`/`.code` is the one line the human
    // report paints for the heartbeat, and nothing asserted it: with the
    // worse-leaf reduce replaced by "the first leaf", a fleet whose timers are
    // disabled summarised as a `warn` about a reconcile policy.
    const policy = join(roleDirOf("alpha-pm"), "role.yaml");
    const saved = readFileSync(policy, "utf8");
    try {
      writeFileSync(policy, YAML.stringify({ role: "pm" }), "utf8");
      setState(canonicalState({ "alpha-pm": { timerEnabled: false } }));
      const data = systemdRun();
      const alpha = agentNamed(data, "alpha-pm");
      assert.equal(leafOf(alpha, FIELDS.timer).state, "fail", JSON.stringify(kindsOf(leafOf(alpha, FIELDS.timer))));
      assert.equal(leafOf(alpha, FIELDS.service).state, "warn", JSON.stringify(kindsOf(leafOf(alpha, FIELDS.service))));
      assert.equal(alpha.systemd.heartbeat.state, "fail", "the worse of the two halves decides the summary");
      assert.equal(alpha.systemd.heartbeat.code, "timer-disabled", "and the code comes from the half that decided it");
      // The rollup itself is proven by the two JSON assertions above. The human
      // report paints `hb <latest_result>·<tick>` and never the state or the
      // code, so all this adds is that the systemd cell is still rendered.
      resetFakeSystemctl(systemctlShim);
      const out = cli(["review", "--domain", "systemd"]).stdout;
      assert.match(out, /gw .+ hb /u, "the systemd cell must still carry a gateway and a heartbeat reading");
    } finally {
      writeFileSync(policy, saved, "utf8");
    }
  });

  check("a failed gateway result, an exec status, a non-oneshot type and an unloadable unit each say which", () => {
    // Four codes the README promises and no case drove. Every knob already
    // existed on the fixture; nothing had ever passed one.
    setState(canonicalState({
      "alpha-pm": { gatewayEnabled: true, gatewayActive: true, gatewayResult: "exit-code" },
      "delta-pm": { gatewayEnabled: true, gatewayActive: true, gatewayExecStatus: "3" },
      "charlie-pm": { serviceType: "simple" },
      "echo-pm": { gatewayLoad: "error" },
    }));
    const data = systemdRun();

    const alphaGateway = leafOf(agentNamed(data, "alpha-pm"), FIELDS.gateway);
    assert.ok(detailsOf(alphaGateway).includes("result-not-success:exit-code"), JSON.stringify(detailsOf(alphaGateway)));
    assert.equal(alphaGateway.state, "fail");
    assert.equal(agentNamed(data, "alpha-pm").systemd.gateway.result, "exit-code");

    const deltaGateway = leafOf(agentNamed(data, "delta-pm"), FIELDS.gateway);
    assert.ok(detailsOf(deltaGateway).includes("exec-status:3"), JSON.stringify(detailsOf(deltaGateway)));
    assert.equal(agentNamed(data, "delta-pm").systemd.gateway.exec_status, 3);

    const charlieService = leafOf(agentNamed(data, "charlie-pm"), FIELDS.service);
    assert.ok(kindsOf(charlieService).includes("type-not-oneshot"), JSON.stringify(kindsOf(charlieService)));
    assert.equal(charlieService.state, "fail");

    // A unit the manager knows and cannot load is neither absent nor readable:
    // it stops the gateway reading right there, with the load state named.
    const echoGateway = leafOf(agentNamed(data, "echo-pm"), FIELDS.gateway);
    assert.deepEqual(detailsOf(echoGateway), ["load-error:error"], JSON.stringify(detailsOf(echoGateway)));
    assert.equal(echoGateway.state, "fail");
    assert.equal(agentNamed(data, "echo-pm").systemd.gateway.load, "error");
  });

  check("a completed oneshot resting at active/exited is not a tick in flight", () => {
    // `RemainAfterExit=yes` leaves a SUCCESSFUL run sitting `active/exited`.
    // Reading `ActiveState` alone called that mid-tick, and it would have aged
    // into `stuck` and stayed there for the life of the unit.
    setState(canonicalState({
      "alpha-pm": { serviceActive: "active", serviceSub: "exited", serviceStartAgoUs: 3_600_000_000n, serviceExitAgoUs: 3_599_000_000n },
    }));
    const data = systemdRun();
    const alpha = agentNamed(data, "alpha-pm");
    assert.equal(alpha.systemd.heartbeat.latest_result, "success", "a completed run is a completed run");
    assert.deepEqual(kindsOf(leafOf(alpha, FIELDS.timer)), [], JSON.stringify(detailsOf(leafOf(alpha, FIELDS.timer))));
    assert.equal(leafOf(alpha, FIELDS.timer).state, "pass");
    assert.equal(leafOf(alpha, FIELDS.service).state, "pass");
    // The `activating` reading beside it still reports mid-tick.
    setState(canonicalState({ "alpha-pm": { serviceActive: "activating", serviceSub: "start", serviceStartAgoUs: 60_000_000n } }));
    assert.deepEqual(kindsOf(leafOf(agentNamed(systemdRun(), "alpha-pm"), FIELDS.timer)), ["in-progress"]);
  });

  check("a quoted Environment value is read whole, not truncated at its first space", () => {
    // systemd prints a value containing a space QUOTED. Splitting the line on
    // whitespace truncated `HERMES_HOME` at the space -- and the truncation
    // here lands exactly on this agent's real profile home, so the observer
    // reported `matches` for a unit rooted somewhere else entirely: a false
    // PASS, which is the worst shape this bug can take.
    const home = `${join(profileRoot, "alpha-pm")} extra/elsewhere`;
    setState(canonicalState({
      "alpha-pm": {
        gatewayEnabled: true, gatewayActive: true,
        gatewayEnvironment: `"HERMES_HOME=${home}" HERMES_BIN=${HERMES_BIN}`,
      },
    }));
    const data = systemdRun();
    const alpha = agentNamed(data, "alpha-pm");
    assert.equal(alpha.systemd.gateway.home, "mismatch", "the whole quoted value is the home, and it is not this agent's");
    const item = leafOf(alpha, FIELDS.gateway).items.find((entry) => entry.kind === "home-mismatch");
    assert.ok(item, JSON.stringify(kindsOf(leafOf(alpha, FIELDS.gateway))));
    assert.match(item.observed, /extra\/elsewhere$/u, `the item must carry the whole path: ${item.observed}`);
  });

  // -- AC9: rule agreement ---------------------------------------------------

  const SENTINEL_PASS = { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "pass", summary: "Hermes user units match each role's declared service state", details: [], fixable: true, scope: "host" };
  const SENTINEL_FAIL = { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "fail", summary: "1 systemd parity issue(s) detected", details: ["hermes-alpha-pm-gateway.service is deferred and should be disabled+inactive"], fixable: true, scope: "host" };
  const PARITY_PASS = { id: "hermes.registry-parity", title: "Fleet registry matches .project.json", status: "pass", summary: "Fleet registry is in parity", details: [], fixable: true, scope: "host" };
  // A REAL failing parity rule, worded as `src/parity/rules.ts` words it. The
  // `fail` arm of `systemdParityVerdict` had never executed: every fixture used
  // PARITY_PASS, so the retired-key/retired-unit half of the shared subset was
  // compared in one direction only.
  const PARITY_FAIL = {
    id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)",
    status: "fail", summary: "1 registry parity issue(s) detected",
    details: ["registry entry for bravo-pm carries retired systemd.checkpoint_timer; the fleet-shared Bloodbank gateway owns command ingress"],
    fixable: true, scope: "host",
  };

  check("the rule-agreement bridge is pinned to the words the rules actually produce", () => {
    // The two pattern lists in `status.ts` are hand-copies of details built in
    // `src/parity/rules.ts`. Nothing tied them together, so rewording a rule
    // would silently turn every real disagreement into `not_compared` -- or
    // raise a spurious GATING one -- with no test red anywhere.
    const status = readFileSync(join(PKG, "src", "org", "status.ts"), "utf8");
    const rules = readFileSync(join(PKG, "src", "parity", "rules.ts"), "utf8");
    const literals = (constant) => {
      const hit = new RegExp(`${constant}: readonly RegExp\\[\\] = \\[([^\\]]*)\\]`, "u").exec(status);
      assert.ok(hit, `${constant} must be declared as a list of patterns`);
      return [...hit[1].matchAll(/\/\^?([^/]+?)\/u/gu)].map((match) => match[1].replaceAll("\\", ""));
    };
    const patterns = [...literals("SYSTEMD_RULE_DETAIL_PATTERNS"), ...literals("SYSTEMD_PARITY_DETAIL_PATTERNS")];
    assert.equal(patterns.length, 5, JSON.stringify(patterns));
    for (const literal of patterns) {
      assert.ok(rules.includes(literal), `src/parity/rules.ts no longer produces "${literal}"; the agreement bridge is comparing against a string nothing emits`);
    }
    // And the fixtures this suite drives are worded the same way.
    for (const detail of [...SENTINEL_FAIL.details, ...PARITY_FAIL.details]) {
      assert.ok(
        patterns.some((literal) => detail.includes(literal)),
        `the fixture detail ${JSON.stringify(detail)} matches none of the build's patterns`,
      );
    }
  });

  check("a FAILING parity rule the observer cannot see is a disagreement in the other direction", () => {
    const shim = entry("parity-fail", syntheticReport([SENTINEL_PASS, PARITY_FAIL]));
    // `bravo-pm` is canonical: five clean leaves, no retired key, no retired
    // unit. The rule says the registry carries one. Both readings are kept.
    setState(canonicalState());
    resetFakeSystemctl(systemctlShim);
    const data = status(cli(["review", "--live", "--json", "--agent", "bravo-pm"], { PJ_FLEET_CLI_ENTRY: shim }));
    for (const field of FIELD_ORDER) assert.equal(leafOf(agentNamed(data, "bravo-pm"), field).state, "pass", field);
    const disagreement = data.findings.find((finding) => finding.code === "systemd-rule-disagreement" && finding.agent_id === "bravo-pm");
    assert.ok(disagreement, `expected a disagreement, got ${JSON.stringify(data.findings.map((f) => `${f.code}/${f.agent_id}`))}`);
    assert.match(disagreement.detail, /report fail while the systemd observer finds no drift/u, disagreement.detail);
    assert.equal(disagreement.gating, true);
    assert.deepEqual(data.systemd.rule_agreement, { compared: 1, agree: 0, disagree: 1, not_compared: 0 });
  });

  check("a rule that passes where the observer reads enablement drift is a recorded disagreement", () => {
    const shim = entry("sentinel-pass", syntheticReport([SENTINEL_PASS, PARITY_PASS]));
    // `charlie-pm` is deferred and its gateway is ENABLED: exactly what the
    // sentinel reads and claims is fine.
    setState(canonicalState({ "charlie-pm": { gatewayEnabled: true, gatewayActive: true } }));
    const data = status(cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    const disagreement = data.findings.find((finding) => finding.code === "systemd-rule-disagreement" && finding.agent_id === "charlie-pm");
    assert.ok(disagreement, `expected a disagreement, got ${JSON.stringify(data.findings.map((f) => `${f.code}/${f.agent_id}`))}`);
    assert.equal(disagreement.gating, true);
    // `severity` is the inventory-finding axis (`error`); the STATUS priority
    // axis it maps onto is the `high` this story asked for.
    assert.equal(disagreement.severity, "error");
    assert.equal(disagreement.status_severity, "high");
    assert.match(disagreement.detail, /systemd\.sentinel/u);
    // The DIRECTION, not just the two fixed halves of the sentence: with the
    // two interpolations swapped the detail still names the rule and still ends
    // "both readings are kept", and an operator would be told the opposite of
    // what happened.
    assert.match(disagreement.detail, /report pass while the systemd observer finds drift/u, disagreement.detail);
    assert.match(disagreement.detail, /both readings are kept/u);
    assert.ok(data.systemd.rule_agreement.disagree >= 1, JSON.stringify(data.systemd.rule_agreement));
  });

  check("a topology code the parity rule also reads is compared, and a passing rule there disagrees", () => {
    const shim = entry("parity-pass-topology", syntheticReport([SENTINEL_PASS, PARITY_PASS]));
    // The only divergence is a retired consumer unit on disk -- a TOPOLOGY
    // code, and one `hermes.registry-parity` reads. Every other leaf of this
    // agent is clean, so nothing else can be producing the disagreement, and
    // the topology half of the shared subset was driven by no case before.
    setState(mergeUnitSets(canonicalState(), {
      units: {
        "hermes-delta-pm-consumer.service": {
          Id: "hermes-delta-pm-consumer.service", LoadState: "loaded", UnitFileState: "disabled",
          ActiveState: "inactive", SubState: "dead",
        },
      },
      list_units: [{ unit: "hermes-delta-pm-consumer.service", load: "loaded", active: "inactive", sub: "dead", description: "retired consumer" }],
      unit_files: [{ unit_file: "hermes-delta-pm-consumer.service", state: "disabled", preset: null }],
    }));
    const data = status(cli(["review", "--live", "--json", "--agent", "delta-pm"], { PJ_FLEET_CLI_ENTRY: shim }));
    const topology = leafOf(agentNamed(data, "delta-pm"), FIELDS.topology);
    assert.deepEqual(detailsOf(topology), ["retired-unit:hermes-delta-pm-consumer.service"], JSON.stringify(detailsOf(topology)));
    const disagreement = data.findings.find((finding) => finding.code === "systemd-rule-disagreement" && finding.agent_id === "delta-pm");
    assert.ok(disagreement, `expected a disagreement, got ${JSON.stringify(data.findings.map((f) => `${f.code}/${f.agent_id}`))}`);
    assert.equal(disagreement.gating, true);
    assert.deepEqual(data.systemd.rule_agreement, { compared: 1, agree: 0, disagree: 1, not_compared: 0 });
  });

  check("drift outside the rules' coverage is not compared in either direction", () => {
    const shim = entry("sentinel-pass-2", syntheticReport([SENTINEL_PASS, PARITY_PASS]));
    // The ONLY divergence is an unstable window, which neither rule reads.
    setState(canonicalState({
      "alpha-pm": {
        gatewayEnabled: true, gatewayActive: true,
        gatewaySamples: [{}, { ActiveState: "activating", SubState: "auto-restart" }, {}],
      },
    }));
    const data = status(cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    assert.equal(data.findings.some((finding) => finding.code === "systemd-rule-disagreement" && finding.agent_id === "alpha-pm"), false,
      "an unstable window is coverage neither rule ever had");
    assert.ok(data.systemd.rule_agreement.not_compared >= 1, JSON.stringify(data.systemd.rule_agreement));

    // PINNED, over one selected agent. On the five-agent fleet `charlie-pm` and
    // `echo-pm` land in `not_compared` for their own reasons, so a fleet-wide
    // `>= 1` never showed that the UNSTABLE WINDOW is what lands there.
    setState(canonicalState({
      "alpha-pm": {
        gatewayEnabled: true, gatewayActive: true,
        gatewaySamples: [{}, { ActiveState: "activating", SubState: "auto-restart" }, {}],
      },
    }));
    const only = status(cli(["review", "--live", "--json", "--agent", "alpha-pm"], { PJ_FLEET_CLI_ENTRY: shim }));
    assert.ok(kindsOf(leafOf(agentNamed(only, "alpha-pm"), FIELDS.gateway)).includes("unstable"));
    assert.deepEqual(only.systemd.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 });

    // The clause names three code families; each one isolated on the agent
    // whose ONLY divergence is of that family. A SCHEDULE code: `bravo-pm` is
    // correctly deferred, so its off-policy timer is the whole divergence.
    setState(canonicalState({ "bravo-pm": { onUnitInactiveSec: 300 } }));
    const schedule = status(cli(["review", "--live", "--json", "--agent", "bravo-pm"], { PJ_FLEET_CLI_ENTRY: shim }));
    assert.ok(kindsOf(leafOf(agentNamed(schedule, "bravo-pm"), FIELDS.timer)).includes("schedule-off-policy"));
    assert.deepEqual(schedule.systemd.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 });

    // A CHANNEL code: `echo-pm` declares no platform at all and its units are
    // canonical, so `channel-undeclared` is the whole divergence.
    setState(canonicalState());
    const channel = status(cli(["review", "--live", "--json", "--agent", "echo-pm"], { PJ_FLEET_CLI_ENTRY: shim }));
    assert.deepEqual(kindsOf(leafOf(agentNamed(channel, "echo-pm"), FIELDS.gateway)), ["channel-undeclared"]);
    assert.deepEqual(channel.systemd.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 });
  });

  check("a rule and the observer that agree are counted as agreeing", () => {
    const shim = entry("sentinel-fail", syntheticReport([SENTINEL_FAIL, PARITY_PASS]));
    setState(canonicalState({ "charlie-pm": { gatewayEnabled: true, gatewayActive: true } }));
    const data = status(cli(["review", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: shim }));
    assert.ok(data.systemd.rule_agreement.agree >= 1, JSON.stringify(data.systemd.rule_agreement));
    assert.equal(data.findings.some((finding) => finding.code === "systemd-rule-disagreement" && finding.agent_id === "charlie-pm"), false);
  });

  // -- exceptions ------------------------------------------------------------

  check("an agent_exceptions ruling flips a drifted agent to exception and leaves health.healthy alone", () => {
    setState(canonicalState({ "charlie-pm": { gatewayEnabled: true, gatewayActive: true } }));
    const before = systemdRun();
    assert.equal(agentNamed(before, "charlie-pm").member_class, "unhealthy");
    assert.equal(before.systemd.agents.drifted >= 1, true);

    const ruled = writeContract("systemd-exception", (document) => {
      document.health_policy.agent_exceptions = [
        { domain: "systemd", agent_id: "charlie-pm", reason: "the operator runs this gateway by hand", owner: "suite" },
      ];
    });
    const after = status(cli(["review", "--domain", "systemd", "--json", "--contract", ruled]));
    const excepted = agentNamed(after, "charlie-pm");
    const gateway = leafOf(excepted, FIELDS.gateway);
    assert.equal(gateway.state, "fail", "the state is unchanged; only the AUTHORIZATION is new");
    assert.ok(gateway.justification, "the ruling must be named on the observation");
    assert.equal(gateway.justification.kind, "exception");
    assert.equal(gateway.justification.policy, "health_policy.agent_exceptions[0]");
    assert.equal(excepted.member_class, "exception");
    assert.equal(after.systemd.agents.exception_authorized, 1);
    assert.equal(after.health.healthy, before.health.healthy, "a ruling must not change health.healthy");
  });

  check("a ruling never excuses a collection error", () => {
    const ruled = writeContract("systemd-exception-error", (document) => {
      document.health_policy.agent_exceptions = [
        { domain: "systemd", agent_id: "alpha-pm", reason: "the operator runs this gateway by hand", owner: "suite" },
      ];
    });
    setState(canonicalState({ "alpha-pm": { gatewayEnabled: true, gatewayActive: true, gatewayRestarts: "abc" } }));
    const data = status(cli(["review", "--domain", "systemd", "--json", "--contract", ruled]));
    const gateway = leafOf(agentNamed(data, "alpha-pm"), FIELDS.gateway);
    assert.equal(gateway.state, "error");
    assert.equal(gateway.justification, null, "an error is this run failing to read, which no ruling can excuse");
  });

  // -- the domain gate and the manifest gate ---------------------------------

  check("--domain registry spawns no systemctl at all", () => {
    setState(canonicalState());
    resetFakeSystemctl(systemctlShim);
    const data = status(cli(["review", "--domain", "registry", "--json"]));
    assert.deepEqual(fakeSystemctlVerbs(systemctlShim), [], "a registry-only run must not touch the user manager");
    assert.deepEqual(data.probes.filter((probe) => probe.kind === "systemd"), []);
    assert.equal(data.systemd, null, "data.systemd is null when the domain was not selected");
    for (const agent of data.agents) assert.equal(agent.systemd, null);
  });

  check("a contract with no service_manifest reports five unsupported leaves and blocks proof", () => {
    const schema4 = writeContract("schema-4", (document) => {
      delete document.service_manifest;
      document.schema_version = 4;
      document.compatibility.max_schema_version = 4;
      // A schema-4 contract still carries the systemd deferral it had then.
      document.health_policy.deferred_capabilities = document.health_policy.deferred_capabilities
        .filter((entry) => entry.domain !== "systemd");
    });
    setState(canonicalState());
    resetFakeSystemctl(systemctlShim);
    const data = status(cli(["review", "--domain", "systemd", "--json", "--contract", schema4]));
    assert.equal(data.contract_version.length > 0, true);
    for (const id of AGENT_IDS) {
      for (const field of FIELD_ORDER) {
        const leaf = leafOf(agentNamed(data, id), field);
        assert.equal(leaf.state, "unsupported", `${id} ${field}`);
        assert.match(leaf.summary, /service_manifest/u, `${id} ${field} must name the block it lacks`);
        // The capability is what the POLICY would join on. The tracked policy
        // declares no `systemd`/`systemd.manifest` deferral, so the observation
        // is unjustified and blocks proof -- which is the difference between a
        // gap somebody signed off and a gap that authorized itself.
        assert.equal(leaf.justification, null, "nothing in the policy authorizes it");
        assert.notEqual(leaf.applicability, "deferred", `${id} ${field}`);
      }
      assert.equal(agentNamed(data, id).systemd, null);
    }
    assert.ok(data.health.unjustified > 0);
    assert.equal(data.systemd.manager.code, "manifest-undeclared");
    assert.equal(data.host.some((finding) => finding.rule_id.startsWith("systemd.")), false, "no manifest, no host finding");
    assert.deepEqual(fakeSystemctlVerbs(systemctlShim), [], "with no manifest there is nothing to sample");
    // And the SAME observation with a policy entry declaring the gap is
    // justified: remove the entry and it goes back to blocking proof.
    const declared = writeContract("schema-4-declared", (document) => {
      delete document.service_manifest;
      document.schema_version = 4;
      document.compatibility.max_schema_version = 4;
      document.health_policy.deferred_capabilities = document.health_policy.deferred_capabilities
        .filter((entry) => entry.domain !== "systemd")
        .concat([{ domain: "systemd", capability: "systemd.manifest", reason: "This deployment declares no canonical service state to prove.", owner_story: "1.8" }]);
    });
    const authorized = status(cli(["review", "--domain", "systemd", "--json", "--contract", declared]));
    const leaf = leafOf(agentNamed(authorized, "alpha-pm"), FIELDS.gateway);
    assert.equal(leaf.state, "unsupported", "the state is unchanged; only the AUTHORIZATION is new");
    assert.ok(leaf.justification, "a declared deferral must name the entry that authorizes it");
    assert.equal(leaf.justification.kind, "deferred_capability");
    assert.equal(leaf.applicability, "deferred");
  });

  // -- contract negatives: ONE rule each --------------------------------------

  const serviceRejects = (label, mutate, path, message) => {
    check(`the contract validator refuses ${label}`, () => {
      const contract = writeContract(`reject-${label.replace(/[^a-z0-9]+/giu, "-")}`, mutate);
      const parsed = envelope(cli(["handbook", "validate", "--contract", contract, "--json"]));
      assert.equal(errorCode(parsed), "INVALID_INPUT");
      const details = parsed.error.details ?? {};
      assert.equal(details.diagnostic_count, 1, `each negative must trip EXACTLY one rule: ${JSON.stringify(details)}`);
      // `fleet status` reports the FIRST diagnostic only (sorted by path), so a
      // mutation that broke two rules would be satisfied by whichever sorted
      // first and would prove nothing about the rule it meant to trip.
      assert.equal(details[`0:${path}`] !== undefined, true, `expected a diagnostic at ${path}, got ${JSON.stringify(details)}`);
      assert.match(details[`0:${path}`], message, details[`0:${path}`]);
    });
  };

  serviceRejects("an unknown service_manifest key", (document) => {
    document.service_manifest.sample_forever = true;
  }, "service_manifest.sample_forever", /unknown service_manifest key/u);

  serviceRejects("a window of zero samples", (document) => {
    document.service_manifest.stabilization.samples = 0;
  }, "service_manifest.stabilization.samples", /at least 1/u);

  serviceRejects("an enabled_path that names no platform", (document) => {
    document.service_manifest.messaging.enabled_path = "platforms.telegram.enabled";
  }, "service_manifest.messaging.enabled_path", /\{platform\} placeholder/u);

  serviceRejects("a retired candidate that is a canonical unit pattern", (document) => {
    document.service_manifest.unregistered.retired_candidates[0] = document.service_model.per_agent.gateway_unit;
  }, "service_manifest.unregistered.retired_candidates[0]", /per_agent pattern/u);

  serviceRejects("a secret_env for a platform the manifest does not declare", (document) => {
    document.service_manifest.messaging.secret_env.discord = ["DISCORD_BOT_TOKEN"];
  }, "service_manifest.messaging.secret_env.discord", /not a declared messaging platform/u);

  // `messaging.secret_env` is the ONE path in the whole contract grammar where
  // a credential-shaped KEY is allowed to sit -- the structure stage exempts it
  // from `SECRET_KEY` -- so the entire bound on it is this rule. Nothing else
  // catches a value here: no `SECRET_VALUE` pattern matches a bare lower-case
  // token, so weakening or deleting the `ENV_KEY` check would let a contract
  // carrying a real token validate, commit and ship.
  serviceRejects("a secret_env entry that is a value rather than an environment key", (document) => {
    document.service_manifest.messaging.secret_env.telegram = ["hunter2istheworstpassword"];
  }, "service_manifest.messaging.secret_env.telegram[0]", /secret_env must name environment keys, not values/u);

  serviceRejects("a multi-sample window with no wait between samples", (document) => {
    document.service_manifest.stabilization.interval_ms = 0;
  }, "service_manifest.stabilization.interval_ms", /must be positive when samples is greater than 1/u);

  serviceRejects("an env allowlist with no PATH", (document) => {
    document.service_manifest.probe.env_allowlist = document.service_manifest.probe.env_allowlist.filter((key) => key !== "PATH");
  }, "service_manifest.probe.env_allowlist", /must carry PATH/u);

  serviceRejects("a limit above this build's ceiling", (document) => {
    document.service_manifest.limits.max_units = 100_000;
  }, "service_manifest.limits.max_units", /ceiling/u);

  serviceRejects("a probe timeout too short for any child to answer", (document) => {
    document.service_manifest.probe.timeout_ms = 5;
  }, "service_manifest.probe.timeout_ms", /at least 100/u);

  check("the tracked contract validates at schema 5 and declares no systemd deferral", () => {
    const parsed = envelope(cli(["handbook", "validate", "--json"]));
    assert.equal(parsed.ok, true, JSON.stringify(parsed.error));
    assert.equal(parsed.data.schema_version, 5);
    const document = contractDocument();
    assert.equal(document.compatibility.max_schema_version, 5);
    assert.equal(
      document.health_policy.deferred_capabilities.some((entry) => entry.capability === "unit_topology"),
      false,
      "the unit_topology deferral is gone: the observer answers it",
    );
    // The manifest's own shape, pinned so a silent edit is visible.
    assert.deepEqual(document.service_manifest.messaging.platforms, ["telegram", "slack"]);
    assert.equal(document.service_manifest.entrypoint.home_env, "HERMES_HOME");
    assert.equal(document.service_manifest.entrypoint.launcher, ".scripts/credential-launch.sh");
    assert.deepEqual(document.service_manifest.unregistered.retired_candidates, [
      "hermes-{agent_id}-consumer.service", "hermes-{agent_id}-checkpoint.timer", "hermes-{agent_id}-checkpoint.service",
    ]);
  });

  // -- payload guarantees ----------------------------------------------------

  check("two runs over one fixed manager state produce byte-identical data", () => {
    setState(canonicalState());
    const first = systemdRun();
    const second = systemdRun();
    assert.equal(JSON.stringify(first), JSON.stringify(second), "data must be byte-identical across two runs over unchanged state");
  });

  check("the payload survives a pipe larger than the pipe buffer, complete", () => {
    setState(canonicalState());
    resetFakeSystemctl(systemctlShim);
    const outFile = join(temp, "systemd-payload.json");
    const result = spawnSync("sh", ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} review --json | cat > ${JSON.stringify(outFile)}`], {
      cwd: workdir, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...isolation },
    });
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(outFile, "utf8");
    assert.ok(Buffer.byteLength(text) > 64 * 1024, `the payload must exceed the pipe buffer to prove anything, got ${Buffer.byteLength(text)} bytes`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.data.systemd, "data.systemd must survive the pipe");
    for (const agent of parsed.data.agents) assert.ok(agent.systemd, `${agent.agent_id} must carry its systemd summary`);
  });

  check("no credential, no absolute home path and no unit-file body reaches stdout", () => {
    setState(canonicalState({
      "alpha-pm": {
        gatewayEnabled: true, gatewayActive: true,
        gatewayExec: execLine(launcherOf("alpha-pm"), "gateway", `--token=${SECRET_SENTINEL}`),
      },
      extra: [{
        units: {
          "hermes-leaky.scope": {
            Id: "hermes-leaky.scope", LoadState: "loaded", UnitFileState: "transient", ActiveState: "active", SubState: "running",
            Description: `[systemd-run] /usr/bin/zsh -lic "TOKEN=${SECRET_SENTINEL} hermes --profile alpha-pm chat"`,
          },
        },
        list_units: [{ unit: "hermes-leaky.scope", load: "loaded", active: "active", sub: "running", description: `[systemd-run] /usr/bin/zsh -lic "TOKEN=${SECRET_SENTINEL} hermes --profile alpha-pm chat"` }],
        unit_files: [{ unit_file: "hermes-leaky.scope", state: "transient", preset: null }],
      }],
    }));
    const result = cli(["review", "--domain", "systemd", "--json"]);
    assert.equal(result.stdout.includes(SECRET_SENTINEL), false, "a credential reached stdout");
    assert.equal(result.stdout.includes("op://"), false, "an op:// reference reached stdout");
    assert.equal(result.stdout.includes(`/home/${userInfo().username}`), false, "an absolute home path reached stdout");
    // And the human report, which paints the same values.
    const human = cli(["review", "--domain", "systemd"]);
    assert.equal(human.stdout.includes(SECRET_SENTINEL), false, "a credential reached the human report");
    const data = status(result);
    const leaky = hostNamed(data, "systemd.unregistered").items.find((item) => item.unit === "hermes-leaky.scope");
    assert.ok(leaky, "the transient scope must still be classified");
    assert.equal(leaky.class, "transient");
    assert.equal(leaky.correlated_profile, "alpha-pm", "an exact --profile token still correlates");
  });

  check("the human report carries a systemd cell and a domains block", () => {
    setState(canonicalState({ "charlie-pm": { gatewayEnabled: true, gatewayActive: true } }));
    resetFakeSystemctl(systemctlShim);
    const out = cli(["review", "--domain", "systemd"]).stdout;
    assert.match(out, /manager running/u, "the domains block must name the manager");
    assert.match(out, /window 3 sample\(s\)/u, "and the window it sampled over");
    assert.match(out, /shared gateway healthy/u);
    assert.match(out, /capability \d+ active, \d+ deferred/u);
    assert.match(out, /gw deferred-but-enabled/u, "the agent cell must name the gateway's code");
    assert.match(out, /hb success/u, "and the heartbeat's latest result");
  });

  await checkAsync("the MCP adapter reports byte-identical data", async () => {
    setState(canonicalState());
    resetFakeSystemctl(systemctlShim);
    const cliData = status(cli(["review", "--domain", "systemd", "--json"]));
    const transport = new StdioClientTransport({
      command: process.execPath, args: [MCP], cwd: workdir,
      env: { ...process.env, ...isolation },
    });
    const client = new Client({ name: "pjan110-suite", version: "0.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "flume_review", arguments: { domain: "systemd" } });
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.ok, true, JSON.stringify(parsed.error));
      assert.deepEqual(parsed.data.systemd, cliData.systemd, "data.systemd must be identical on both adapters");
      for (const agent of parsed.data.agents) {
        assert.deepEqual(agent.systemd, cliData.agents.find((item) => item.agent_id === agent.agent_id).systemd, `${agent.agent_id}`);
      }
    } finally {
      await client.close();
    }
  });

  // -- registration ----------------------------------------------------------

  check("the runner knows about systemd health", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.ok(runner.includes("fleet-systemd-regressions"), "the suite must be registered in scripts/run-tests.mjs");
  });

  check("the fake tells the sampled window from the classification show by SIZE, and the two sets still straddle it", () => {
    // The fake has to know which `show` advances its scripted window. It used
    // to ask `properties.includes("NRestarts")` -- a PRODUCTION constant --
    // so dropping that property from the observer would have frozen every
    // window at sample 0, made every stability claim vacuously unanimous, and
    // left this suite green. The marker is now the fake's own threshold, and
    // this is the assertion that keeps it a real separator.
    const source = readFileSync(join(PKG, "src", "org", "systemd.ts"), "utf8");
    const names = (constant) => {
      const hit = new RegExp(`${constant} = \\[([^\\]]*)\\]`, "u").exec(source);
      assert.ok(hit, `${constant} must be declared as a list`);
      return [...hit[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    };
    const sampled = names("SYSTEMD_SHOW_PROPERTIES");
    const classify = names("SYSTEMD_CLASSIFY_PROPERTIES");
    assert.ok(
      sampled.length > FAKE_SAMPLED_PROPERTY_FLOOR,
      `the sampled show asks for ${sampled.length} properties, which no longer clears the fake's floor of ${FAKE_SAMPLED_PROPERTY_FLOOR}`,
    );
    assert.ok(
      classify.length <= FAKE_SAMPLED_PROPERTY_FLOOR,
      `the classification show asks for ${classify.length} properties, which now clears the fake's floor of ${FAKE_SAMPLED_PROPERTY_FLOOR}`,
    );
  });

  check("both adapters carry the same status remediation, and neither promises a systemd observer that now exists", () => {
    // Story 1.8 edited this sentence in BOTH adapters (systemd left the list of
    // observers this release does not have). Nothing asserted the pair, so the
    // two copies could drift into telling a CLI caller and an MCP caller
    // different things about the same fleet.
    const line = (path) => {
      const source = readFileSync(join(PKG, "src", "org", path), "utf8");
      const hit = /"(Review data\.health\.unobserved:[^"]*)"/u.exec(source);
      assert.ok(hit, `${path} must carry the unobserved-domains remediation`);
      return hit[1];
    };
    const cliLine = line("cli.ts");
    assert.equal(cliLine, line("mcp.ts"), "the two adapters must give the same next action for the same fleet");
    assert.equal(/systemd/u.test(cliLine), false, "systemd is observed in this release; the remediation must not still name it");
    assert.match(cliLine, /1\.9\/1\.10/u, "and it must name the stories that still owe an observer");
  });

  check("the observer's read verbs and item vocabulary are exported and spelled the same in source", () => {
    const source = readFileSync(join(PKG, "src", "org", "systemd.ts"), "utf8");
    const verbs = /SYSTEMD_READ_VERBS = \[([^\]]*)\]/u.exec(source);
    assert.ok(verbs, "SYSTEMD_READ_VERBS must be declared as a list");
    assert.deepEqual([...verbs[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]), READ_VERBS);
    // Nothing in the module may name a mutation verb at all: the guard in
    // `systemctlArgv` is a runtime refusal, and this is the source-level one.
    for (const mutation of MUTATION_VERBS) {
      assert.equal(new RegExp(`"${mutation}"`, "u").test(source), false, `src/fleet/systemd.ts must not name systemctl ${mutation}`);
    }
    const types = readFileSync(join(PKG, "src", "org", "types.ts"), "utf8");
    const classes = /FLEET_SYSTEMD_UNREGISTERED_CLASSES = \[([^\]]*)\]/u.exec(types);
    assert.deepEqual([...classes[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]), UNREGISTERED_CLASSES);
    // Vocabulary with no emit site asks every consumer to handle a case this
    // build cannot produce. Both extra classes are emitted by `inspectAgent`
    // and both are asserted by the topology case.
    const extras = /FLEET_SYSTEMD_EXTRA_CLASSES = \[([^\]]*)\]/u.exec(types);
    assert.deepEqual([...extras[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]), EXTRA_CLASSES);
    for (const klass of EXTRA_CLASSES) {
      assert.ok(new RegExp(`class: "${klass}"`, "u").test(source), `nothing in the observer emits the extra class ${klass}`);
    }
    // Every item kind is NAMED by the observer -- some literally on a push,
    // some as the value of a `kind` variable a collection gate chooses. A kind
    // that appears in neither is vocabulary nothing can produce.
    const emitted = `${source}${readFileSync(join(PKG, "src", "org", "status.ts"), "utf8")}`;
    for (const kind of [...(/FLEET_SYSTEMD_ITEM_KINDS = \[([^\]]*)\]/u.exec(types)[1]).matchAll(/"([^"]+)"/gu)].map((match) => match[1])) {
      assert.ok(emitted.includes(`"${kind}"`), `the item kind ${kind} is exported vocabulary with no emit site`);
    }
  });

  // -- the live fleet ---------------------------------------------------------

  check("on the real fleet the observer's reading agrees with an independent systemctl show", () => {
    if (!existsSync(REAL_AGENT_REGISTRY) || !existsSync(REAL_PROJECT_REGISTRY)) {
      skipCase("live systemd", "this host has no live fleet registry");
    }
    const manager = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8", timeout: 20_000 });
    const managerState = (manager.stdout ?? "").trim();
    if (!["running", "degraded", "starting", "maintenance"].includes(managerState)) {
      skipCase("live systemd", `this host's user manager reports ${managerState || "nothing"}`);
    }
    const unitDir = join(REAL_HOME, ".config", "systemd", "user");
    const fragmentHash = () => {
      const names = existsSync(unitDir) ? readdirSync(unitDir).filter((name) => name.startsWith("hermes-")).sort() : [];
      const digest = createHash("sha256");
      // By CONTENT, never by `ls` metadata: a heartbeat tick every 60 s or a
      // concurrent `fleet:sync` moves an mtime while proving nothing about a
      // read-only observer, and a content hash fails only on a real write.
      for (const name of names) {
        const path = join(unitDir, name);
        try { if (lstatSync(path).isFile()) digest.update(name).update(readFileSync(path)); } catch { digest.update(`${name}:unreadable`); }
      }
      return digest.digest("hex");
    };
    const before = fragmentHash();

    const result = spawnSync(process.execPath, [CLI, "review", "--domain", "systemd", "--json"], {
      cwd: ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: process.env,
    });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.error));
    const data = parsed.data;
    assert.equal(data.systemd.manager.code, "available", `the live manager reported ${data.systemd.manager.state}`);

    // An INDEPENDENT reading of four units, compared field by field.
    const registry = YAML.parse(readFileSync(REAL_AGENT_REGISTRY, "utf8"));
    const liveIds = Object.keys(registry.agents ?? {});
    const liveId = liveIds.includes("pjangler-pm") ? "pjangler-pm" : liveIds[0];
    assert.ok(liveId, "the live registry must carry at least one agent");
    if (liveId !== "pjangler-pm") {
      // Said out loud rather than degraded quietly: the field-by-field
      // comparison below is about whichever agent this is, and a reader of the
      // log has to know it was not the one the spec names.
      console.log(`       live: pjangler-pm is not on this host; the parser comparison ran against ${liveId}`);
    }
    const sharedUnit = data.systemd.shared.unit;
    const units = [...Object.values(unitsOf(liveId)), sharedUnit].filter(Boolean);
    const show = spawnSync("systemctl", [
      "--user", "show", "--no-pager", "-p", "Id,LoadState,UnitFileState,ActiveState,SubState,Result,ExecMainStatus,NRestarts", ...units,
    ], { encoding: "utf8", timeout: 30_000, env: { ...process.env, SYSTEMD_PAGER: "", SYSTEMD_COLORS: "0", LC_ALL: "C" } });
    assert.equal(show.status, 0, show.stderr);
    const observed = new Map();
    for (const block of show.stdout.split(/\n[ \t]*\n/u)) {
      const map = new Map();
      for (const line of block.split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) map.set(line.slice(0, at), line.slice(at + 1));
      }
      if (map.has("Id")) observed.set(map.get("Id"), map);
    }
    const agent = data.agents.find((item) => item.agent_id === liveId);
    assert.ok(agent?.systemd, `${liveId} must carry a systemd summary`);
    // Load state and unit-file state are STATIC between two reads seconds
    // apart; activity is not, for the heartbeat pair specifically. The timer
    // fires every 60 s by policy, so `waiting -> running -> waiting` and the
    // oneshot's `dead -> start -> dead` are the fixture ticking under the
    // comparison, not the observer disagreeing with systemd. Those two units
    // are compared on what does not move plus a membership check on what does;
    // the gateway, which is meant to be continuously running, is compared
    // strictly.
    const TIMER_STATES = new Set(["waiting", "running", "elapsed", "dead"]);
    const compare = (view, map, label, { strictActivity = true } = {}) => {
      assert.equal(view.load, map.get("LoadState"), `${label} LoadState`);
      const file = map.get("UnitFileState");
      assert.equal(view.unit_file, file === "" ? null : file, `${label} UnitFileState`);
      if (strictActivity) {
        assert.equal(view.active, map.get("ActiveState"), `${label} ActiveState`);
        assert.equal(view.sub, map.get("SubState"), `${label} SubState`);
        return;
      }
      assert.ok(["active", "inactive", "activating", "deactivating"].includes(view.active), `${label} ActiveState ${view.active}`);
      assert.ok(TIMER_STATES.has(view.sub) || view.sub === map.get("SubState"), `${label} SubState ${view.sub} vs ${map.get("SubState")}`);
    };
    compare(agent.systemd.gateway, observed.get(unitsOf(liveId).gateway), `${liveId} gateway`);
    compare(agent.systemd.heartbeat.timer, observed.get(unitsOf(liveId).timer), `${liveId} timer`, { strictActivity: false });
    compare(agent.systemd.heartbeat.service, observed.get(unitsOf(liveId).service), `${liveId} service`, { strictActivity: false });
    assert.equal(agent.systemd.gateway.result, observed.get(unitsOf(liveId).gateway).get("Result"), "gateway Result");
    assert.equal(String(agent.systemd.gateway.restarts), observed.get(unitsOf(liveId).gateway).get("NRestarts"), "gateway NRestarts");
    if (sharedUnit && observed.has(sharedUnit)) {
      const sharedMap = observed.get(sharedUnit);
      const enabled = ["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"].includes(sharedMap.get("UnitFileState"));
      const healthy = enabled && sharedMap.get("ActiveState") === "active" && sharedMap.get("SubState") === "running";
      assert.equal(data.systemd.shared.state === "healthy", healthy, `the shared gateway reading must agree with ${sharedUnit}`);
    }

    // Every unit file the manager knows is OWNED, a retired candidate, the
    // shared unit, or listed as unregistered -- the CLASS is asserted, never a
    // count: the transient `hermes-worker-proc_*.scope` units are `systemd-run`
    // wrappers around live calls and appear and vanish on their own.
    const files = spawnSync("systemctl", ["--user", "list-unit-files", "hermes-*", "--output=json", "--no-pager", "--plain", "--no-legend"], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, SYSTEMD_PAGER: "", SYSTEMD_COLORS: "0", LC_ALL: "C" },
    });
    if (files.status === 0) {
      const listed = JSON.parse(files.stdout).map((row) => row.unit_file);
      const owned = new Set();
      for (const id of Object.keys(registry.agents ?? {})) {
        for (const unit of Object.values(unitsOf(id))) owned.add(unit);
        for (const suffix of ["consumer.service", "checkpoint.timer", "checkpoint.service"]) owned.add(`hermes-${id}-${suffix}`);
      }
      if (sharedUnit) owned.add(sharedUnit);
      const reported = new Set((data.host.find((f) => f.rule_id === "systemd.unregistered")?.items ?? []).map((item) => item.unit));
      const orphans = listed.filter((unit) => !owned.has(unit) && !reported.has(unit));
      assert.deepEqual(orphans, [], `every hermes unit file must be owned or reported: ${orphans.join(", ")}`);
    }

    // THE STORY'S OWN PROBLEM STATEMENT, asserted. The comparison above proves
    // the PARSER agrees with systemd field by field; it says nothing about the
    // eight named drifts this story exists to surface, so `deferred-but-enabled`
    // could have stopped firing for `pjangler-pm` with this case still green.
    // Each reading is guarded on the agent being present on THIS host and skips
    // out loud when it is not -- never silently, and never by pretending the
    // fleet is the fixture.
    const byId = new Map(data.agents.map((item) => [item.agent_id, item]));
    const liveLeaf = (id, field) => {
      const record = byId.get(id);
      if (record === undefined) return null;
      const found = (record.observations ?? []).find((item) => item.source === "fleet-systemd" && item.field === field);
      return found ?? null;
    };
    const liveCodes = (id, field) => (liveLeaf(id, field)?.items ?? []).map((item) => item.detail ?? item.kind);
    const liveExpectations = [
      // A gateway enabled and active for an agent whose row declares its
      // channels deferred, and whose empty delta inherits the base's enablement.
      ["pjangler-pm", FIELDS.gateway, ["deferred-but-enabled", "deferred-but-active"]],
      // A verified-Telegram agent whose gateway is disabled.
      ["drumjangler-pm", FIELDS.gateway, ["verified-channel-gateway-disabled"]],
      // A gateway entered from an executable the registry does not pin.
      //
      // Only `entrypoint-unpinned` is asserted. This agent is also
      // restart-looping, but `unstable` comes and goes between samples, and an
      // assertion on a flapping code is a test that fails on timing.
      //
      // This row used to read the heartbeat ONESHOT's failed result off
      // FIELDS.service. Per-agent heartbeat units are retired fleet-wide --
      // `systemctl --user list-unit-files | grep -c heartbeat` returns 0, and
      // every one of the 25 registered agents reads ["absent"] on both
      // heartbeat leaves, with no exceptions. Liveness is the gateway's
      // Restart=on-failure, scheduling is Bloodbank, persistence is krebs
      // leases. `entrypoint-unpinned` is a real and current drift; it simply
      // lives on the gateway leaf now, which is where the executable is.
      ["automatic-ai-pm", FIELDS.gateway, ["entrypoint-unpinned"]],
      // The retirement itself, asserted rather than assumed: a heartbeat leaf
      // reads absent, and it is the observer saying so, not the fixture.
      ["automatic-ai-pm", FIELDS.service, ["absent"]],
      // A deferred agent whose empty delta inherits the fleet base's telegram.
      ["ssbnk-pm", FIELDS.gateway, ["platform-enablement-inherited:telegram"]],
      // A registered agent with no units at all.
      ["delonet-director", FIELDS.gateway, ["absent"]],
    ];
    let liveAsserted = 0;
    for (const [id, field, codes] of liveExpectations) {
      if (!byId.has(id)) { skip("live systemd", `${id} is not registered on this host; its matrix row is proven only by its scripted analogue`); continue; }
      const leaf = liveLeaf(id, field);
      assert.ok(leaf, `${id} must carry the ${field} observation`);
      for (const code of codes) {
        assert.ok(liveCodes(id, field).includes(code), `${id} ${field}: expected ${code}, read ${JSON.stringify(liveCodes(id, field))}`);
      }
      assert.equal(leaf.state, "fail", `${id} ${field}`);
      liveAsserted += 1;
    }
    if (liveAsserted === 0) {
      // Every named agent skipped out loud above, so this host runs a different
      // fleet. That is not a defect in the observer and must not be a red
      // suite -- the case's own promise is that a missing agent SKIPS.
      skipCase("live systemd", "this host's registry names none of the five agents the matrix rows annotate");
    }
    if (byId.has("delonet-director")) {
      for (const field of [FIELDS.gateway, FIELDS.timer, FIELDS.service]) {
        assert.deepEqual(liveCodes("delonet-director", field), ["absent"], `delonet-director ${field}`);
      }
    }
    if (byId.has("ssbnk-pm")) {
      assert.equal(liveCodes("ssbnk-pm", FIELDS.gateway).filter((code) => code.startsWith("platform-enablement-inherited")).length, 1,
        "exactly one platform inherits enablement: the base enables telegram and nothing else");
    }
    // CORRELATION, not fleet health. Asserting the shared gateway is `healthy`
    // made a stopped Bloodbank unit -- an operator's runtime decision, on a
    // machine this suite does not own -- a red suite. What is always true, and
    // what this story owns, is that the host finding agrees with the reading it
    // is built from.
    const sharedFinding = hostNamed(data, "systemd.shared-gateway");
    assert.equal(
      sharedFinding.state,
      data.systemd.shared.state === "healthy" ? "pass" : data.systemd.shared.state === "error" || data.systemd.shared.state === "unobserved" ? "error" : "fail",
      `the shared-gateway finding must agree with data.systemd.shared.state (${data.systemd.shared.state})`,
    );
    if (data.systemd.shared.state !== "healthy") {
      skip("live systemd", `the fleet-shared Bloodbank gateway reads ${data.systemd.shared.state} on this host; its matrix row is proven by the scripted case`);
    }
    // The manager was asserted `available` at the top of this case, so the
    // finding it produces is a consequence of that, not of fleet health.
    assert.equal(hostNamed(data, "systemd.manager").state, "pass");
    // A sweep either happened or said why it did not -- the P2 contract, which
    // holds whatever the manager's listing did on this host.
    if (data.systemd.unregistered.coverage === "swept") {
      assert.equal(data.systemd.unregistered.reason, null);
    } else {
      const sweep = hostNamed(data, "systemd.unregistered");
      assert.equal(sweep.state, "error", `an unreadable sweep must be a finding: ${JSON.stringify(sweep)}`);
      assert.ok(sweep.summary.includes(data.systemd.unregistered.reason), sweep.summary);
    }

    assert.equal(fragmentHash(), before, "the observer wrote to the live unit directory");
    console.log(`       live: ${data.systemd.agents.total_registered} registered, manager ${data.systemd.manager.state}, `
      + `capability ${JSON.stringify(data.systemd.capability)}, shared ${data.systemd.shared.state}, `
      + `unregistered ${JSON.stringify(data.systemd.unregistered.by_class)}, ${liveId} gateway ${agent.systemd.gateway.state}, `
      + `${liveAsserted}/${liveExpectations.length} named live drift(s) asserted`);
  });

  check("no invocation in this suite wrote to this repository", () => {
    assertUnchanged(sharedBefore, snapshotShared(), "the suite");
  });

  console.log(failures === 0
    ? `fleet systemd regressions passed${skipped ? ` (${skipped} skipped)` : ""}`
    : `\n${failures} fleet systemd check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(shimRoot, { recursive: true, force: true });
}
