// A SCRIPTED user manager for the fleet suites.
//
// Story 1.8 made `systemd` an observed domain in every scope, so a suite that
// seeds a fleet and asserts its agents are healthy now has to seed that fleet's
// SERVICE state too -- exactly as story 1.7 made every fixture profile
// renderer-clean. Without it the suites would either read this developer's own
// user manager (a fixture agent's units are not on it, so every agent would
// read `gateway-missing`) or read no manager at all (`manager-unavailable`, five
// `error` leaves per agent) and every "this agent is healthy" assertion would go
// red for a reason that has nothing to do with what it tests.
//
// The fake is installed on a case's PATH as `systemctl`, reads a JSON state
// file, appends every argv to an invocation log, and records the environment it
// was handed -- which is what lets a suite prove the observer's allowlist is the
// WHOLE environment a child receives and that no mutation verb was ever spawned.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_SYSTEMCTL_BIN = join(HERE, "fake-systemctl-bin.mjs");

/**
 * How many `-p` properties a `show` must ask for to be the SAMPLED window.
 *
 * The fake has to tell the sampled multi-unit `show` (which advances the
 * scripted window) from the ONE classification `show` over unregistered units
 * (which must not). It used to key that on `properties.includes("NRestarts")`
 * -- a production constant -- so dropping `NRestarts` from
 * `SYSTEMD_SHOW_PROPERTIES` would have made every stability window vacuously
 * unanimous with the suite still green. The threshold is a property of the
 * FAKE, and the suite asserts that the two production sets still straddle it,
 * so a set that stops separating them goes red rather than silent.
 */
export const FAKE_SAMPLED_PROPERTY_FLOOR = 12;

/** CLOCK_MONOTONIC now in microseconds -- the clock systemd's `*USecMonotonic` properties use. */
export function monotonicNowUs() {
  return process.hrtime.bigint() / 1000n;
}

/** `1w 5d 14h 16min 26.297365s`, the way systemd renders a monotonic timespan. */
export function formatTimespan(us) {
  const value = BigInt(us);
  if (value === 0n) return "0";
  const units = [["w", 604800000000n], ["d", 86400000000n], ["h", 3600000000n], ["min", 60000000n]];
  let rest = value;
  const parts = [];
  for (const [suffix, size] of units) {
    const count = rest / size;
    if (count > 0n) { parts.push(`${count}${suffix}`); rest -= count * size; }
  }
  if (rest > 0n) {
    const seconds = Number(rest) / 1e6;
    parts.push(`${seconds.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}s`);
  }
  return parts.join(" ");
}

/**
 * Write a `systemctl` shim into `dir` and seed its state.
 *
 * The shim is a two-line `sh` script that `exec`s this build's own node on the
 * fake, with the shim directory as its first argument. Everything the fake
 * needs travels in ARGV, never in the environment: the observer hands a child
 * only `service_manifest.probe.env_allowlist` plus four pins, so a fake that
 * wanted an env key of its own could not be configured at all -- and the
 * environment it records is therefore exactly what the observer passed.
 *
 * `dir` must live OUTSIDE any tree the suite snapshots for zero-write proof:
 * the fake writes its log, its recorded environment and its sample counter
 * beside itself on every invocation.
 */
export function installFakeSystemctl(dir, state) {
  mkdirSync(dir, { recursive: true });
  const script = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SYSTEMCTL_BIN)} ${JSON.stringify(dir)} "$@"\n`;
  writeFileSync(join(dir, "systemctl"), script, "utf8");
  chmodSync(join(dir, "systemctl"), 0o755);
  // `git` is spawned by name by every other observer in the same run, so a PATH
  // shim that carries only `systemctl` would make the scaffold and profile
  // observers unobservable for a reason this helper has no business causing.
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (realGit && !existsSync(join(dir, "git"))) symlinkSync(realGit, join(dir, "git"));
  const realPython = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  if (realPython && !existsSync(join(dir, "python3"))) symlinkSync(realPython, join(dir, "python3"));
  setFakeSystemctlState(dir, state);
  return dir;
}

export function setFakeSystemctlState(dir, state) {
  writeFileSync(join(dir, "systemctl-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  resetFakeSystemctl(dir);
}

/** Clear the invocation log, the recorded environments and the sample counter. */
export function resetFakeSystemctl(dir) {
  for (const name of ["systemctl-invocations.log", "systemctl-child-env.log"]) {
    rmSync(join(dir, name), { force: true });
  }
  writeFileSync(join(dir, "systemctl-sample.counter"), "0", "utf8");
}

/** Every `systemctl` argv the fake was spawned with, in order. */
export function fakeSystemctlInvocations(dir) {
  try {
    return readFileSync(join(dir, "systemctl-invocations.log"), "utf8")
      .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  } catch { return []; }
}

/** The verb of each invocation (`is-system-running`, `list-units`, `show`, ...). */
export function fakeSystemctlVerbs(dir) {
  return fakeSystemctlInvocations(dir).map((argv) => argv.filter((token) => !token.startsWith("-"))[0] ?? "");
}

/** The environment each `systemctl` child actually received. */
export function fakeSystemctlChildEnvs(dir) {
  try {
    return readFileSync(join(dir, "systemctl-child-env.log"), "utf8")
      .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  } catch { return []; }
}

/**
 * The canonical unit triple of ONE deferred agent, exactly as `70-systemd.sh`
 * provisions it and the template's own health helpers would read it healthy.
 *
 * Deferred rather than active because it is the shape most of the live fleet
 * actually has and because it needs no channel credential to be correct: the
 * gateway is disabled and inactive, the timer fires on policy, and the oneshot
 * completed its last tick.
 */
export function deferredAgentUnits({ agentId, profileName, profileRoot, roleDir, hermesBin = null, nowUs = monotonicNowUs() }) {
  const gateway = `hermes-${agentId}-gateway.service`;
  const timer = `hermes-${agentId}-heartbeat.timer`;
  const service = `hermes-${agentId}-heartbeat.service`;
  const launcher = roleDir === null ? (hermesBin ?? "/nonexistent/hermes") : join(roleDir, ".scripts", "credential-launch.sh");
  const home = join(profileRoot, profileName ?? agentId);
  const exec = (path, ...args) => `{ path=${path} ; argv[]=${[path, ...args].join(" ")} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
  const start = nowUs - 30_000_000n;
  const exit = nowUs - 29_000_000n;
  return {
    units: {
      [gateway]: {
        Id: gateway, Names: gateway, LoadState: "loaded", LoadError: "", UnitFileState: "disabled",
        ActiveState: "inactive", SubState: "dead", Result: "success", ExecMainStatus: "0", ExecMainCode: "0",
        NRestarts: "0", FragmentPath: "", DropInPaths: "", Type: "simple", Restart: "on-failure",
        ExecStart: exec(launcher, "gateway"),
        Environment: `HERMES_HOME=${home}`,
        ExecMainStartTimestampMonotonic: "0", ExecMainExitTimestampMonotonic: "0", TimeoutStartUSec: "1min 30s",
      },
      [timer]: {
        Id: timer, Names: timer, LoadState: "loaded", LoadError: "", UnitFileState: "enabled",
        ActiveState: "active", SubState: "waiting", Result: "success",
        FragmentPath: "", DropInPaths: "", Unit: service, Triggers: service,
        TimersMonotonic: [
          `{ OnUnitInactiveUSec=1min ; next_elapse=${formatTimespan(nowUs + 30_000_000n)} }`,
          `{ OnBootUSec=1min ; next_elapse=1min }`,
        ],
        LastTriggerUSecMonotonic: formatTimespan(exit),
        NextElapseUSecMonotonic: formatTimespan(nowUs + 30_000_000n),
      },
      [service]: {
        Id: service, Names: service, LoadState: "loaded", LoadError: "", UnitFileState: "static",
        ActiveState: "inactive", SubState: "dead", Result: "success", ExecMainStatus: "0", ExecMainCode: "1",
        FragmentPath: "", DropInPaths: "", Type: "oneshot", TriggeredBy: timer,
        ExecStart: exec(launcher, "heartbeat"),
        Environment: `HERMES_HOME=${home}`,
        ExecMainStartTimestampMonotonic: String(start),
        ExecMainExitTimestampMonotonic: String(exit),
        TimeoutStartUSec: "45min",
      },
    },
    list_units: [
      { unit: gateway, load: "loaded", active: "inactive", sub: "dead", description: `${agentId} gateway` },
      { unit: timer, load: "loaded", active: "active", sub: "waiting", description: `${agentId} heartbeat timer` },
      { unit: service, load: "loaded", active: "inactive", sub: "dead", description: `${agentId} heartbeat` },
    ],
    unit_files: [
      { unit_file: gateway, state: "disabled", preset: null },
      { unit_file: timer, state: "enabled", preset: null },
      { unit_file: service, state: "static", preset: null },
    ],
  };
}

/** The fleet-shared Bloodbank gateway, healthy. */
export function sharedGatewayUnits({ unit = "hermes-fleet-bloodbank-gateway.service", profile = "fleet-bloodbank-gateway", profileRoot, hermesBin, nowUs = monotonicNowUs() }) {
  const exec = `{ path=${hermesBin} ; argv[]=${hermesBin} gateway run --replace ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
  return {
    units: {
      [unit]: {
        Id: unit, Names: unit, LoadState: "loaded", LoadError: "", UnitFileState: "enabled",
        ActiveState: "active", SubState: "running", Result: "success", ExecMainStatus: "0", ExecMainCode: "0",
        NRestarts: "0", FragmentPath: "", DropInPaths: "", Type: "simple", Restart: "on-failure",
        ExecStart: exec,
        Environment: `HERMES_HOME=${join(profileRoot, profile)}`,
        ExecMainStartTimestampMonotonic: String(nowUs - 600_000_000n),
        ExecMainExitTimestampMonotonic: "0", TimeoutStartUSec: "1min 30s",
      },
    },
    list_units: [{ unit, load: "loaded", active: "active", sub: "running", description: "fleet bloodbank gateway" }],
    unit_files: [{ unit_file: unit, state: "enabled", preset: null }],
  };
}

/** Fold several unit sets into one fake state. Later sets win on a name collision. */
export function mergeUnitSets(base, ...sets) {
  const state = {
    manager: { stdout: "running", exit: 0 },
    units: {},
    list_units: [],
    unit_files: [],
    ...base,
  };
  for (const set of sets) {
    Object.assign(state.units, set.units ?? {});
    for (const row of set.list_units ?? []) {
      const at = state.list_units.findIndex((entry) => entry.unit === row.unit);
      if (at === -1) state.list_units.push(row); else state.list_units[at] = row;
    }
    for (const row of set.unit_files ?? []) {
      const at = state.unit_files.findIndex((entry) => entry.unit_file === row.unit_file);
      if (at === -1) state.unit_files.push(row); else state.unit_files[at] = row;
    }
  }
  state.list_units.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  state.unit_files.sort((a, b) => (a.unit_file < b.unit_file ? -1 : a.unit_file > b.unit_file ? 1 : 0));
  return state;
}

/**
 * The environment keys that keep a case that FORGOT the shim away from this
 * host's own user manager: a bus address pointing at a socket that is not
 * there, and a runtime directory that is not this user's.
 *
 * Without them a suite would silently observe the developer's live fleet, and
 * every fixture agent would read `gateway-missing` because its units are not on
 * that manager -- a green-or-red that depends on whose laptop is running the
 * suite.
 */
export function noBusIsolation(temp) {
  return {
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(temp, "no-bus")}`,
    XDG_RUNTIME_DIR: join(temp, "no-runtime"),
  };
}
