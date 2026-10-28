/**
 * The host's service manager, and the one seam every platform decision goes through.
 *
 * The live fleet runs on Linux under systemd --user. A macOS host (a non-33GOD Hermes being
 * migrated in, for one) has launchd instead: no `systemctl`, no `flock(1)`, bash 3.2 at /bin/bash,
 * and ONE multiplexed gateway installed by `hermes gateway install` as the LaunchAgent
 * `ai.hermes.gateway` rather than a unit per agent.
 *
 * Nothing in flume reads `process.platform` for a service-manager decision directly; it asks
 * `hostPlatform()`, whose `FLUME_HOST_PLATFORM` override is the test seam. A suite simulates a Mac on
 * a Linux runner by setting it on the child it spawns, never by patching a global.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The LaunchAgent label `hermes gateway install` writes (hermes_cli/gateway_launchd.py). */
export const LAUNCHD_GATEWAY_LABEL = "ai.hermes.gateway";

/** What an operator runs on a launchd host to install and start the single multiplexed gateway. */
export const LAUNCHD_GATEWAY_INSTALL = "hermes gateway install";

/** The platform flume treats this host as. `FLUME_HOST_PLATFORM` overrides it (the test seam). */
export function hostPlatform(env: NodeJS.ProcessEnv = process.env): NodeJS.Platform {
  const forced = env.FLUME_HOST_PLATFORM?.trim();
  return (forced || process.platform) as NodeJS.Platform;
}

/** A host whose user services are launchd LaunchAgents, not systemd --user units. */
export function isLaunchdHost(platform: NodeJS.Platform = hostPlatform()): boolean {
  return platform === "darwin";
}

/** The one-line reason every systemd observer gives on a launchd host instead of a verdict. */
export function launchdNotObservable(subject = "systemd --user units"): string {
  return `${subject} are not observable on a launchd host (darwin); the gateway there is the single multiplexed LaunchAgent ${LAUNCHD_GATEWAY_LABEL}`;
}

/** The numeric uid launchd's per-user `gui/<uid>` domain is keyed by. */
export function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** `gui/<uid>/ai.hermes.gateway`: the service target `launchctl print|kickstart` takes. */
export function launchdGatewayTarget(uid: number | null = currentUid()): string {
  return `gui/${uid ?? "$(id -u)"}/${LAUNCHD_GATEWAY_LABEL}`;
}

/**
 * Every domain Hermes may have loaded the gateway into, in Hermes' own probe order
 * (`hermes_cli/gateway_launchd.py` `_probe_launchd_domain_for_label`): `gui/<uid>` (an Aqua
 * login), then `user/<uid>` (Background: `hermes gateway install` run over SSH or from a
 * non-Aqua session picks it, and it is the recommended domain on macOS 26+).
 */
export function launchdGatewayTargets(uid: number | null = currentUid()): string[] {
  const id = uid ?? "$(id -u)";
  return [`gui/${id}/${LAUNCHD_GATEWAY_LABEL}`, `user/${id}/${LAUNCHD_GATEWAY_LABEL}`];
}

/**
 * Fold one observation per domain into the gateway's: the first domain that has it loaded
 * (running, stopped or unreadable) answers; only when every domain says not-loaded is it not-loaded.
 */
export function pickLaunchdObservation(observations: LaunchdGatewayObservation[]): LaunchdGatewayObservation {
  const loaded = observations.find((observation) => observation.state !== "not-loaded");
  if (loaded) return loaded;
  const first = observations[0];
  if (!first) throw new Error("pickLaunchdObservation needs at least one observation");
  const domains = observations.map((observation) => observation.target.split("/").slice(0, 2).join("/"));
  return { ...first, detail: `${LAUNCHD_GATEWAY_LABEL} is not loaded in ${domains.join(" or ")}; run ${LAUNCHD_GATEWAY_INSTALL}` };
}

/**
 * The launchd gateway, as `launchctl print` reports it.
 *
 * `running`      loaded and launchd reports `state = running`.
 * `stopped`      loaded, but not running (`state = not running`, `exited`, `spawn scheduled`, ...).
 * `not-loaded`   launchd knows no such service in the user's gui domain (never installed, or booted out).
 * `unobservable` `launchctl` could not be asked or answered in a shape this build does not read.
 */
export type LaunchdGatewayState = "running" | "stopped" | "not-loaded" | "unobservable";

export interface LaunchdGatewayObservation {
  state: LaunchdGatewayState;
  /** launchd's own state word (`running`, `not running`, ...), or a stable code when it gave none. */
  word: string;
  pid: number | null;
  target: string;
  detail: string;
}

/** Classify one `launchctl print gui/<uid>/<label>` answer. Pure, so it is tested without a Mac. */
export function parseLaunchctlPrint(
  result: { status: number | null; stdout: string; stderr: string; error?: string | null },
  target: string,
): LaunchdGatewayObservation {
  if (result.error) {
    return { state: "unobservable", word: "launchctl-unavailable", pid: null, target, detail: `launchctl print ${target} could not run: ${result.error}` };
  }
  if (result.status !== 0) {
    // launchctl exits 113 with "Could not find service" when the label is not loaded in the domain.
    if (result.status === 113 || /could not find service|not find service|no such process/iu.test(`${result.stderr}\n${result.stdout}`)) {
      return { state: "not-loaded", word: "not-loaded", pid: null, target, detail: `${LAUNCHD_GATEWAY_LABEL} is not loaded in ${target.split("/").slice(0, 2).join("/")}; run ${LAUNCHD_GATEWAY_INSTALL}` };
    }
    return { state: "unobservable", word: `exit-${result.status ?? "signal"}`, pid: null, target, detail: `launchctl print ${target} exited ${result.status ?? "on a signal"}${result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]}` : ""}` };
  }
  // Top-level properties are indented one tab; nested blocks (endpoints, sockets) indent further.
  const topLevel = (key: string): string | null => {
    const exact = new RegExp(`^\\t${key} = (.+)$`, "mu").exec(result.stdout);
    const loose = exact ?? new RegExp(`^\\s*${key} = (.+)$`, "mu").exec(result.stdout);
    return loose?.[1]?.trim() ?? null;
  };
  const word = topLevel("state");
  const pidText = topLevel("pid");
  const pid = pidText !== null && /^\d+$/u.test(pidText) ? Number(pidText) : null;
  if (word === null) {
    return { state: "unobservable", word: "state-unreported", pid, target, detail: `launchctl print ${target} reported no state` };
  }
  if (word === "running") {
    return { state: "running", word, pid, target, detail: `${LAUNCHD_GATEWAY_LABEL} is loaded and running` };
  }
  return { state: "stopped", word, pid, target, detail: `${LAUNCHD_GATEWAY_LABEL} is loaded but ${word}; start it with launchctl kickstart -k ${target} (or hermes gateway start)` };
}

/** Read-only `launchctl print` of the single multiplexed gateway, gui then user domain. Never mutates launchd. */
export function observeLaunchdGateway(options: { uid?: number | null; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): LaunchdGatewayObservation {
  const observations: LaunchdGatewayObservation[] = [];
  for (const target of launchdGatewayTargets(options.uid === undefined ? currentUid() : options.uid)) {
    const result: SpawnSyncReturns<string> = spawnSync("launchctl", ["print", target], {
      encoding: "utf8",
      env: options.env ?? process.env,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const observation = parseLaunchctlPrint({
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ? String((result.error as NodeJS.ErrnoException).code ?? result.error.message) : null,
    }, target);
    observations.push(observation);
    if (observation.state !== "not-loaded") break;
  }
  return pickLaunchdObservation(observations);
}

/** Every executable named `command` on `env.PATH`, in PATH order. Spawns nothing. */
export function allOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = [];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      found.push(candidate);
    } catch { /* not here */ }
  }
  return found;
}

/** The first executable named `command` on `env.PATH`, or null. Spawns nothing. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return allOnPath(command, env)[0] ?? null;
}

/** The oldest bash the template's shell libraries run under (`local -n`, `mapfile -d`). */
export const MIN_BASH = { major: 4, minor: 4 } as const;

/** Where a macOS host keeps a bash that is not the system 3.2, in the order they are tried. */
export const DARWIN_BASH_CANDIDATES = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"] as const;

function bashVersion(path: string, env: NodeJS.ProcessEnv): { major: number; minor: number } | null {
  const probe = spawnSync(path, ["--noprofile", "--norc", "-c", 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], { encoding: "utf8", env, timeout: 5_000 });
  const match = /^(\d+)\.(\d+)$/u.exec((probe.stdout ?? "").trim());
  return probe.status === 0 && match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

/**
 * The bash to run the template's shell libraries with.
 *
 * Linux returns `"bash"` untouched, exactly what flume always spawned. On a launchd host the first
 * bash >= 4.4 among `PATH` and the Homebrew locations wins; with none, it THROWS a message that names
 * the fix rather than letting /bin/bash 3.2 die on `local -n` halfway through a loader.
 */
export function modernBash(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = hostPlatform(env)): string {
  if (!isLaunchdHost(platform)) return "bash";
  const seen = new Set<string>();
  const found: string[] = [];
  for (const candidate of [...allOnPath("bash", env), ...DARWIN_BASH_CANDIDATES]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const version = bashVersion(candidate, env);
    if (version === null) continue;
    found.push(`${candidate} ${version.major}.${version.minor}`);
    if (version.major > MIN_BASH.major || (version.major === MIN_BASH.major && version.minor >= MIN_BASH.minor)) return candidate;
  }
  throw new Error(`flume needs bash >= ${MIN_BASH.major}.${MIN_BASH.minor} for the Hermes template's shell libraries; found ${found.length ? found.join(", ") : "no runnable bash"}. On macOS: brew install bash (it lands in /opt/homebrew/bin, which flume checks even when /bin comes first on PATH)`);
}
