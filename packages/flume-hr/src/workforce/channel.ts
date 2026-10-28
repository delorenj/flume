import { execFile, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { resolveFlumeRoot } from "../kernel/paths";
import { CHANNEL_PARKED_STATUS } from "../org/types";
import { hostPlatform, isLaunchdHost, launchdGatewayTarget, observeLaunchdGateway } from "../kernel/host-platform";

/**
 * `flume channel`: park a chat channel on purpose, and bring it back.
 *
 * OFFLINE is not broken and not deferred-forever. It is the operator saying "this bot is parked":
 * the token was rotated out, Telegram caps how many bots may be active, or the bot was revoked.
 * Three things are true of a parked channel, and this module keeps them true together:
 *
 *   1. the delta still holds the credential REFERENCE (so `online` is one command),
 *   2. the delta pins `platforms.<p>.enabled: false` (the gateway does not try to connect),
 *   3. the registry row says `provisioning_status: offline`, with `offline_since`/`offline_reason`.
 *
 * `online` is also the rotation path: a new `--credential-ref` is resolved with `op` at APPLY time
 * only, to ask the platform who the bot is. The token is held in memory for that one request and is
 * never printed, logged, put in argv, or written anywhere.
 *
 * Every write goes through scripts/channel-state.py: registry flock, then the renderer's own profile
 * lock, the delta, ONE profile rendered by the canonical renderer (never an absorb), the registry
 * row last, and a byte-for-byte rollback if any step fails.
 *
 * What a running gateway does with that change was read from its source, not assumed
 * (gateway/run_profile_reconcile.py): a config re-scan only STARTS platforms that are newly enabled
 * and not already live or queued for reconnect. It never disconnects a platform that became
 * disabled, and a bot stuck in the reconnect queue is skipped. So a re-scan alone leaves a parked
 * bot connected, or leaves a rotated bot un-started. The least disruptive thing that does the job is
 * the gateway's own per-profile control verbs, `unserve-profile` then `serve-profile`: they stop and
 * rebuild THIS profile's adapters and nobody else's. A full `systemctl --user reload` (drain and
 * restart of every profile) is the fallback when the control socket does not answer.
 */

export const OFFLINE_STATUS = CHANNEL_PARKED_STATUS;
export const VERIFIED_STATUS = "verified";
export type ChannelPlatform = "telegram" | "slack";

interface PlatformSpec {
  /** The environment key that holds the bot credential, mapped by an op:// reference in the delta. */
  credentialEnv: string;
  /** A second reference the platform needs (Slack's app token). */
  appEnv?: string;
  /** Registry fields a verified channel carries. */
  identity: string[];
}

export const CHANNEL_PLATFORMS: Record<ChannelPlatform, PlatformSpec> = {
  telegram: { credentialEnv: "TELEGRAM_BOT_TOKEN", identity: ["bot_username", "bot_id"] },
  slack: { credentialEnv: "SLACK_BOT_TOKEN", appEnv: "SLACK_APP_TOKEN", identity: ["team_id", "team_name", "bot_user_id", "bot_id", "bot_username"] },
};

export interface ChannelBlocker { code: string; detail: string }

export interface ChannelOptions {
  platform?: string;
  reason?: string;
  credentialRef?: string;
  appTokenRef?: string;
  apply?: boolean;
  /** Leave the running gateway alone; the change is written but not picked up. */
  noReload?: boolean;
  /** How long to wait for gateway_state.json to show the new state. */
  confirmMs?: number;
  now?: string;
}

export interface GatewayPickup {
  /** `restart` is the launchd fallback: `hermes gateway restart`, else `launchctl kickstart -k`. */
  action: "none" | "skipped" | "profile-cycle" | "reload" | "restart";
  confirmed: boolean;
  detail: string;
  /** What gateway_state.json says about the channel afterwards, or null when it has no entry. */
  state: string | null;
}

export interface ChannelResult {
  ok: boolean;
  apply: boolean;
  action: "offline" | "online";
  employee: string;
  platform: string;
  profile: string | null;
  changed: boolean;
  from: { status: string | null; enabled: boolean | null; refs: string[] };
  to: { status: string; enabled: boolean };
  rotation?: { env: string; from: string | null; to: string };
  verified?: { bot_username?: string; bot_id?: string };
  writes: string[];
  gateway?: GatewayPickup;
  blockers: ChannelBlocker[];
  warnings: string[];
  note?: string;
}

// ---------------------------------------------------------------------------------------------
// Paths and readers
// ---------------------------------------------------------------------------------------------

function home(): string { return process.env.HOME || homedir(); }
function plain(value: string | undefined): string | undefined { return value && !value.includes("$") ? value : undefined; }
export function fleetHome(): string { return plain(process.env.HERMES_FLEET_HOME) ?? join(home(), ".hermes"); }
export function channelRegistryPath(): string {
  return plain(process.env.HERMES_AGENTS_REGISTRY) ?? plain(process.env.HERMES_FLEET_REGISTRY_FILE) ?? join(fleetHome(), "agents-registry.yaml");
}
function gatewayStatePath(): string { return plain(process.env.HERMES_GATEWAY_STATE_FILE) ?? join(fleetHome(), "gateway_state.json"); }
function rendererPath(): string {
  return process.env.FLUME_PROFILE_RENDERER ?? join(resolveFlumeRoot(), "templates/hermes-agent/scripts/hermes-profile-config.py");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYaml(path: string): Record<string, any> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = YAML.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch { return undefined; }
}

function readJson(path: string): Record<string, any> | undefined {
  try { const parsed = JSON.parse(readFileSync(path, "utf8")); return isRecord(parsed) ? parsed : undefined; } catch { return undefined; }
}

function parsePlatform(value: string | undefined): ChannelPlatform {
  const platform = (value ?? "telegram").toLowerCase();
  if (platform !== "telegram" && platform !== "slack") throw new Error(`--platform must be telegram or slack, got "${value}"`);
  return platform;
}

interface Employee {
  id: string;
  row: Record<string, any>;
  profile: string;
  desk: string;
  deltaPath: string;
}

function registryAgents(): Record<string, Record<string, any>> {
  const registry = readYaml(channelRegistryPath());
  if (!registry) throw new Error(`agent registry unreadable: ${channelRegistryPath()}`);
  return isRecord(registry.agents) ? registry.agents : {};
}

function resolveEmployee(name: string): Employee {
  const agents = registryAgents();
  let id = name;
  if (!isRecord(agents[id])) {
    const byProfile = Object.entries(agents).filter(([, row]) => isRecord(row) && row.profile_name === name).map(([key]) => key);
    if (byProfile.length !== 1) throw new Error(`no employee "${name}" in ${channelRegistryPath()}`);
    id = byProfile[0]!;
  }
  const row = agents[id]!;
  const profile = String(row.profile_name || id);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(profile)) throw new Error(`${id}: unsafe profile name "${profile}"`);
  const desk = join(fleetHome(), "profiles", profile);
  if (!existsSync(desk) || lstatSync(desk).isSymbolicLink() || !lstatSync(desk).isDirectory()) throw new Error(`${id}: ${desk} is not a real profile directory`);
  return { id, row, profile, desk, deltaPath: join(desk, "config.delta.yaml") };
}

function deltaOf(employee: Employee): Record<string, any> { return readYaml(employee.deltaPath) ?? {}; }
function deltaRefs(delta: Record<string, any>): Record<string, string> {
  const env = delta.secrets?.onepassword?.env;
  const out: Record<string, string> = {};
  if (isRecord(env)) for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
}
function deltaEnabled(delta: Record<string, any>, platform: string): boolean | null {
  const value = delta.platforms?.[platform]?.enabled;
  return typeof value === "boolean" ? value : null;
}
function baseEnabled(platform: string): boolean | null {
  const value = readYaml(join(fleetHome(), "config.yaml"))?.platforms?.[platform]?.enabled;
  return typeof value === "boolean" ? value : null;
}

// ---------------------------------------------------------------------------------------------
// Live gateway
// ---------------------------------------------------------------------------------------------

interface LiveGateway { running: boolean; pid: number | null; platforms: Record<string, Record<string, any>> }

export function readGateway(): LiveGateway {
  const state = readJson(gatewayStatePath());
  if (!state) return { running: false, pid: null, platforms: {} };
  const pid = typeof state.pid === "number" ? state.pid : null;
  let alive = false;
  if (pid !== null) { try { process.kill(pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; } }
  return { running: alive, pid, platforms: isRecord(state.platforms) ? state.platforms : {} };
}

function controlRequest(socketPath: string, verb: string, params: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; result?: Record<string, any>; error?: string }> {
  return new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const finish = (value: { ok: boolean; result?: Record<string, any>; error?: string }) => { if (!done) { done = true; socket.destroy(); resolve(value); } };
    const socket = createConnection(socketPath);
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `control socket did not answer ${verb} in ${timeoutMs}ms` }));
    socket.on("error", (error) => finish({ ok: false, error: (error as Error).message }));
    socket.on("connect", () => socket.write(`${JSON.stringify({ verb, id: 1, protocol: 1, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        const result = isRecord(response.result) ? response.result : undefined;
        if (response.ok !== true) finish({ ok: false, error: String(response.error ?? "refused") });
        else if (result && typeof result.error === "string") finish({ ok: false, result, error: result.error });
        else finish({ ok: true, result });
      } catch { finish({ ok: false, error: "control socket answered something that is not JSON" }); }
    });
    socket.on("end", () => finish({ ok: false, error: "control socket closed without answering" }));
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for gateway_state.json to show the state the change should produce. */
async function confirmState(key: string, want: "offline" | "online", since: number, waitMs: number): Promise<{ confirmed: boolean; state: string | null }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const entry = readGateway().platforms[key];
    const state = typeof entry?.state === "string" ? entry.state : null;
    const fresh = entry && typeof entry.updated_at === "string" ? Date.parse(entry.updated_at) >= since - 1000 : false;
    if (want === "online" && state === "connected" && fresh) return { confirmed: true, state };
    // A parked channel has no live adapter. The gateway drops the entry when it unserves the
    // profile; a surviving entry counts only if it was rewritten after the change and is not live.
    if (want === "offline" && (entry === undefined || (fresh && state !== "connected" && state !== "fatal"))) return { confirmed: true, state };
    if (Date.now() >= deadline) return { confirmed: false, state };
    await sleep(500);
  }
}

async function pickUp(employee: Employee, platform: ChannelPlatform, want: "offline" | "online", options: ChannelOptions): Promise<GatewayPickup> {
  const gateway = readGateway();
  const key = `${employee.profile}:${platform}`;
  if (!gateway.running) return { action: "none", confirmed: false, detail: "no running gateway: the change applies when it next starts", state: null };
  if (options.noReload) {
    return { action: "skipped", confirmed: false, detail: "--no-reload: written, NOT picked up. A config re-scan starts a newly enabled channel but never stops a running one; cycle this profile or reload the gateway to finish", state: gateway.platforms[key]?.state ?? null };
  }
  const since = Date.now();
  const waitMs = options.confirmMs ?? (Number(process.env.FLUME_CHANNEL_CONFIRM_MS) || 20_000);
  const socket = join(fleetHome(), "gateway.sock");
  let detail = "";
  if (existsSync(socket)) {
    // unserve then serve: one profile's adapters are stopped and rebuilt from the file just rendered.
    const down = await controlRequest(socket, "unserve-profile", { name: employee.profile }, 10_000);
    // "not served" is fine: nothing to stop, and serve below starts it from the new config.
    if (!down.ok && !/not served/u.test(down.error ?? "")) detail = `unserve-profile: ${down.error}`;
    else {
      const up = await controlRequest(socket, "serve-profile", { name: employee.profile }, 20_000);
      if (up.ok) {
        const seen = await confirmState(key, want, since, waitMs);
        return { action: "profile-cycle", confirmed: seen.confirmed, state: seen.state, detail: `cycled profile ${employee.profile} through the gateway control socket (other profiles untouched)${up.result?.pending ? "; the gateway reported the start as still pending" : ""}` };
      }
      detail = `serve-profile: ${up.error}`;
    }
  } else detail = "no gateway control socket";
  if (isLaunchdHost(hostPlatform())) {
    // A launchd host has no `hermes-gateway` unit to reload. Hermes restarts its own LaunchAgent;
    // a bare kickstart of the label is the fallback when the CLI is not on PATH or refuses.
    const restarted = restartLaunchdGateway();
    if (!restarted.ok) return { action: "restart", confirmed: false, state: gateway.platforms[key]?.state ?? null, detail: `${detail}; ${restarted.detail}` };
    const seen = await confirmState(key, want, since, options.confirmMs ?? (Number(process.env.FLUME_CHANNEL_CONFIRM_MS) || 90_000));
    return { action: "restart", confirmed: seen.confirmed, state: seen.state, detail: `${detail}; ${restarted.detail} (every profile drains and restarts)` };
  }
  const reload = spawnSync("systemctl", ["--user", "reload", "hermes-gateway"], { encoding: "utf8", timeout: 30_000 });
  if (reload.status !== 0) return { action: "reload", confirmed: false, state: gateway.platforms[key]?.state ?? null, detail: `${detail}; systemctl --user reload hermes-gateway failed: ${(reload.stderr || reload.error?.message || `exit ${reload.status}`).trim()}` };
  // A reload drains and restarts every profile; give it room unless the caller bounded the wait.
  const seen = await confirmState(key, want, since, options.confirmMs ?? (Number(process.env.FLUME_CHANNEL_CONFIRM_MS) || 90_000));
  return { action: "reload", confirmed: seen.confirmed, state: seen.state, detail: `${detail}; reloaded hermes-gateway (SIGUSR1: every profile drains and restarts)` };
}

/** The launchd gateway restart: `hermes gateway restart`, then `launchctl kickstart -k gui/<uid>/ai.hermes.gateway`. */
function restartLaunchdGateway(): { ok: boolean; detail: string } {
  const failure = (label: string, run: ReturnType<typeof spawnSync>): string =>
    `${label} failed: ${(String(run.stderr ?? "") || (run.error as NodeJS.ErrnoException | undefined)?.code || run.error?.message || `exit ${run.status}`).trim()}`;
  const hermes = spawnSync("hermes", ["gateway", "restart"], { encoding: "utf8", timeout: 60_000 });
  if (!hermes.error && hermes.status === 0) return { ok: true, detail: "restarted the launchd gateway with hermes gateway restart" };
  // Kick the domain the gateway is actually loaded in (gui/<uid> or user/<uid>).
  const observed = observeLaunchdGateway();
  const target = observed.state === "running" || observed.state === "stopped" ? observed.target : launchdGatewayTarget();
  const kick = spawnSync("launchctl", ["kickstart", "-k", target], { encoding: "utf8", timeout: 30_000 });
  if (!kick.error && kick.status === 0) return { ok: true, detail: `${failure("hermes gateway restart", hermes)}; restarted it with launchctl kickstart -k ${target}` };
  return { ok: false, detail: `${failure("hermes gateway restart", hermes)}; ${failure(`launchctl kickstart -k ${target}`, kick)}` };
}

// ---------------------------------------------------------------------------------------------
// Verifying a bot with its platform. The token lives in this function and nowhere else.
// ---------------------------------------------------------------------------------------------

interface BotIdentity { fields: Record<string, string>; claims: Array<Record<string, string>> }

function readSecret(ref: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("op", ["read", "--no-newline", ref], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // The message never carries the reference's value; the reference itself is not a secret.
      if (error) reject(new Error(`could not resolve ${ref} with op`));
      else if (!stdout.trim()) reject(new Error(`${ref} resolved to an empty value`));
      else resolve(stdout.trim());
    });
  });
}

async function platformCall(url: string, init: RequestInit, token: string, platform: string): Promise<{ status: number; body: Record<string, any> }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    let body: Record<string, any> = {};
    try { const parsed = await response.json(); if (isRecord(parsed)) body = parsed; } catch { /* non-JSON body */ }
    return { status: response.status, body };
  } catch (error) {
    // Node puts the request URL in some fetch errors. The URL carries the token.
    const message = String((error as Error).message ?? error).split(token).join("***");
    throw new Error(`${platform} could not be reached to verify the bot (${message}); nothing was changed`);
  }
}

class Rejected extends Error {}

async function verifyBot(platform: ChannelPlatform, token: string): Promise<BotIdentity> {
  if (platform === "telegram") {
    const base = (process.env.FLUME_TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/u, "");
    const { status, body } = await platformCall(`${base}/bot${token}/getMe`, {}, token, "Telegram");
    if (status === 401 || status === 404 || body.ok === false) {
      throw new Rejected(`Telegram rejected the token (HTTP ${status}${typeof body.description === "string" ? `: ${body.description}` : ""}); the bot is revoked, deleted, or the reference is wrong`);
    }
    const result = body.result;
    if (status !== 200 || !isRecord(result) || result.id === undefined || !result.username) throw new Error(`Telegram getMe gave an unusable answer (HTTP ${status}); nothing was changed`);
    const id = String(result.id);
    return { fields: { bot_username: String(result.username), bot_id: id }, claims: [{ bot_id: id }] };
  }
  const base = (process.env.FLUME_SLACK_API_BASE || "https://slack.com/api").replace(/\/+$/u, "");
  const { status, body } = await platformCall(`${base}/auth.test`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }, token, "Slack");
  if (body.ok !== true) throw new Rejected(`Slack rejected the token (HTTP ${status}${typeof body.error === "string" ? `: ${body.error}` : ""}); the bot is revoked, or the reference is wrong`);
  const fields = { team_id: String(body.team_id ?? ""), team_name: String(body.team ?? ""), bot_user_id: String(body.user_id ?? ""), bot_id: String(body.bot_id ?? ""), bot_username: String(body.user ?? "") };
  if (!fields.team_id || !fields.bot_user_id) throw new Error("Slack auth.test gave an unusable answer; nothing was changed");
  return { fields, claims: [...(fields.bot_id ? [{ bot_id: fields.bot_id }] : []), { team_id: fields.team_id, bot_user_id: fields.bot_user_id }] };
}

const REFERENCE = /^op:\/\/[^/\s"'`$\\]+\/[^/\s"'`$\\]+\/[^\s"'`$\\]+$/u;
const ITEM_UUID = /^[a-z0-9]{26}$/u;

function referenceProblems(ref: string, label: string): { block?: string; warn?: string } {
  if (!REFERENCE.test(ref)) return { block: `${label} must look like op://<vault>/<item-uuid>/<field>` };
  const item = ref.split("/")[3] ?? "";
  return ITEM_UUID.test(item) ? {} : { warn: `${label} names its item by title, not UUID; the vault has duplicate titles and a duplicated one cannot resolve` };
}

// ---------------------------------------------------------------------------------------------
// The python transaction
// ---------------------------------------------------------------------------------------------

function transact(request: Record<string, unknown>): { ok: boolean; error?: string; code?: string; writes: string[] } {
  const script = join(resolveFlumeRoot(), "scripts/channel-state.py");
  const run = spawnSync("python3", ["-I", script], {
    input: JSON.stringify({ renderer: rendererPath(), fleet_home: fleetHome(), registry: channelRegistryPath(), ...request }),
    encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(run.stdout || "{}"); } catch { /* reported below */ }
  if (run.status === 0 && parsed.ok === true) return { ok: true, writes: [parsed.delta, parsed.generated, parsed.registry].filter((p): p is string => typeof p === "string") };
  return { ok: false, code: parsed.code, error: parsed.error ?? (run.stderr || run.error?.message || `channel-state exited ${run.status}`).trim(), writes: [] };
}

function blocked(base: Omit<ChannelResult, "ok" | "blockers" | "writes" | "warnings" | "changed">, blockers: ChannelBlocker[], warnings: string[] = []): ChannelResult {
  return { ...base, ok: false, changed: false, writes: [], blockers, warnings };
}

// ---------------------------------------------------------------------------------------------
// offline
// ---------------------------------------------------------------------------------------------

export async function channelOffline(name: string, options: ChannelOptions = {}): Promise<ChannelResult> {
  const platform = parsePlatform(options.platform);
  const spec = CHANNEL_PLATFORMS[platform];
  const employee = resolveEmployee(name);
  const block = isRecord(employee.row[platform]) ? employee.row[platform] : {};
  const delta = deltaOf(employee);
  const refs = Object.keys(deltaRefs(delta)).filter((key) => key === spec.credentialEnv || key === spec.appEnv);
  const base = {
    apply: Boolean(options.apply), action: "offline" as const, employee: employee.id, platform, profile: employee.profile,
    from: { status: (block.provisioning_status as string | undefined) ?? null, enabled: deltaEnabled(delta, platform), refs },
    to: { status: OFFLINE_STATUS, enabled: false },
  };
  const warnings: string[] = [];
  if (refs.length === 0) warnings.push(`no ${spec.credentialEnv} reference in the delta: nothing to bring back with \`online\` until you pass --credential-ref`);
  const since = (block.provisioning_status === OFFLINE_STATUS && typeof block.offline_since === "string") ? block.offline_since : (options.now ?? new Date().toISOString());
  const reason = (options.reason ?? "").trim() || (block.provisioning_status === OFFLINE_STATUS && block.offline_reason) || "parked by the operator";
  const alreadyParked = block.provisioning_status === OFFLINE_STATUS && deltaEnabled(delta, platform) === false && block.offline_reason === reason;
  if (alreadyParked) {
    const result: ChannelResult = { ...base, ok: true, changed: false, writes: [], blockers: [], warnings, note: `${platform} is already offline since ${since}` };
    // Idempotent, but still honest about the live channel.
    const live = readGateway().platforms[`${employee.profile}:${platform}`];
    if (live?.state === "connected") result.warnings.push("registry and delta say offline but the gateway still shows this channel connected; re-run with --apply to cycle it");
    if (!options.apply || live?.state !== "connected") return result;
    result.gateway = await pickUp(employee, platform, "offline", options);
    return result;
  }
  if (!options.apply) return { ...base, ok: true, changed: true, writes: [], blockers: [], warnings, note: "preview; pass --apply" };

  const done = transact({
    employee: employee.id, platform, profile_name: employee.profile,
    expect_status: base.from.status,
    registry_set: { provisioning_status: OFFLINE_STATUS, offline_since: since, offline_reason: reason },
    delta_enabled: false,
  });
  if (!done.ok) return blocked(base, [{ code: done.code ?? "write-failed", detail: done.error ?? "write failed" }], warnings);
  const result: ChannelResult = { ...base, ok: true, changed: true, writes: done.writes, blockers: [], warnings };
  result.gateway = await pickUp(employee, platform, "offline", options);
  return result;
}

// ---------------------------------------------------------------------------------------------
// online (re-enable, and rotate)
// ---------------------------------------------------------------------------------------------

function profilesUsingRef(ref: string, exceptProfile: string): string[] {
  const root = join(fleetHome(), "profiles");
  const found: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return found; }
  for (const profile of names) {
    if (profile === exceptProfile) continue;
    const refs = deltaRefs(readYaml(join(root, profile, "config.delta.yaml")) ?? {});
    if (Object.values(refs).includes(ref)) found.push(profile);
  }
  return found;
}

export async function channelOnline(name: string, options: ChannelOptions = {}): Promise<ChannelResult> {
  const platform = parsePlatform(options.platform);
  const spec = CHANNEL_PLATFORMS[platform];
  const employee = resolveEmployee(name);
  const block = isRecord(employee.row[platform]) ? employee.row[platform] : {};
  const delta = deltaOf(employee);
  const current = deltaRefs(delta);
  const base = {
    apply: Boolean(options.apply), action: "online" as const, employee: employee.id, platform, profile: employee.profile,
    from: { status: (block.provisioning_status as string | undefined) ?? null, enabled: deltaEnabled(delta, platform), refs: Object.keys(current).filter((key) => key === spec.credentialEnv || key === spec.appEnv) },
    to: { status: VERIFIED_STATUS, enabled: true },
  };
  const blockers: ChannelBlocker[] = [];
  const warnings: string[] = [];

  const newRefs: Record<string, string> = {};
  if (options.credentialRef) {
    const problem = referenceProblems(options.credentialRef, "--credential-ref");
    if (problem.block) blockers.push({ code: "invalid-reference", detail: problem.block });
    if (problem.warn) warnings.push(problem.warn);
    newRefs[spec.credentialEnv] = options.credentialRef;
  }
  if (options.appTokenRef) {
    if (!spec.appEnv) blockers.push({ code: "invalid-option", detail: `--app-token-ref does not apply to ${platform}` });
    else {
      const problem = referenceProblems(options.appTokenRef, "--app-token-ref");
      if (problem.block) blockers.push({ code: "invalid-reference", detail: problem.block });
      newRefs[spec.appEnv] = options.appTokenRef;
    }
  }
  const effective: Record<string, string> = { ...current, ...newRefs };
  for (const env of [spec.credentialEnv, spec.appEnv].filter((key): key is string => Boolean(key))) {
    if (!effective[env]) blockers.push({ code: "no-credential-reference", detail: `the delta has no ${env} reference; pass ${env === spec.credentialEnv ? "--credential-ref" : "--app-token-ref"} <op://...>` });
  }
  const botRef = effective[spec.credentialEnv];
  if (botRef && !blockers.length) {
    const elsewhere = profilesUsingRef(botRef, employee.profile);
    if (elsewhere.length) blockers.push({ code: "reference-in-use", detail: `${botRef} is already the ${spec.credentialEnv} of profile ${elsewhere.join(", ")}` });
  }
  const rotated = options.credentialRef && current[spec.credentialEnv] !== options.credentialRef
    ? { env: spec.credentialEnv, from: current[spec.credentialEnv] ?? null, to: options.credentialRef } : undefined;
  const out = { ...base, ...(rotated ? { rotation: rotated } : {}) };
  if (blockers.length) return blocked(out, blockers, warnings);
  const nothing = block.provisioning_status === VERIFIED_STATUS && deltaEnabled(delta, platform) === true && !rotated && !options.appTokenRef
    && !block.offline_since && !block.offline_reason;
  if (!options.apply) {
    return { ...out, ok: true, changed: !nothing, writes: [], blockers, warnings, note: `preview; --apply resolves ${botRef} with op and asks ${platform} who the bot is before anything is written` };
  }

  // Apply: ask the platform first. Nothing below runs, and nothing is written, if it will not vouch for the bot.
  let identity: BotIdentity;
  try { identity = await verifyBot(platform, await readSecret(botRef!)); }
  catch (error) {
    const code = error instanceof Rejected ? "auth-rejected" : "unverified";
    return blocked(out, [{ code, detail: (error as Error).message }], warnings);
  }
  const verified = { bot_username: identity.fields.bot_username, bot_id: identity.fields.bot_id };
  if (nothing && identity.claims.every((claim) => Object.entries(claim).every(([key, value]) => String(block[key] ?? "") === value))) {
    return { ...out, ok: true, changed: false, verified, writes: [], blockers: [], warnings, note: `${platform} is already online and the platform vouches for the bot` };
  }
  const claimant = Object.entries(registryAgents()).find(([id, row]) => id !== employee.id && isRecord(row?.[platform])
    && identity.claims.some((claim) => Object.entries(claim).every(([key, value]) => value !== "" && String(row[platform][key] ?? "") === value)));
  if (claimant) return blocked({ ...out, verified }, [{ code: "duplicate-bot", detail: `this ${platform} bot (${identity.fields.bot_username ?? identity.fields.bot_user_id}) is already assigned to ${claimant[0]}` }], warnings);

  const done = transact({
    employee: employee.id, platform, profile_name: employee.profile,
    expect_status: base.from.status,
    unique: identity.claims,
    registry_set: { provisioning_status: VERIFIED_STATUS, ...identity.fields },
    registry_unset: ["offline_since", "offline_reason"],
    delta_enabled: true,
    delta_refs: newRefs,
  });
  if (!done.ok) return blocked({ ...out, verified }, [{ code: done.code ?? "write-failed", detail: done.error ?? "write failed" }], warnings);
  const result: ChannelResult = { ...out, ok: true, changed: true, verified, writes: done.writes, blockers: [], warnings };
  result.gateway = await pickUp(employee, platform, "online", options);
  return result;
}

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

export interface ChannelRow {
  employee: string;
  platform: ChannelPlatform;
  /** online, offline, deferred, broken (fatal or enabled without a ref) or unwired */
  standing: "online" | "offline" | "deferred" | "broken" | "unwired";
  status: string | null;
  delta_enabled: boolean | null;
  base_enabled: boolean | null;
  refs: string[];
  bot_username: string | null;
  offline_since: string | null;
  offline_reason: string | null;
  gateway: { state: string | null; error_code: string | null; updated_at: string | null } | null;
  notes: string[];
}

export interface ChannelListResult {
  ok: boolean;
  rows: ChannelRow[];
  /** Deferred channels with no reference and nothing live, left out of `rows` unless --all. */
  hidden_quiet: number;
  totals: Record<string, number>;
  /** Telegram bots the gateway has connected right now: the number Telegram's active-bot cap counts. */
  active_telegram_bots: number;
  gateway_running: boolean;
  blockers: ChannelBlocker[];
}

export function channelList(employee?: string, options: { all?: boolean } = {}): ChannelListResult {
  const agents = registryAgents();
  const gateway = readGateway();
  const wanted = employee ? [resolveEmployee(employee).id] : Object.keys(agents);
  const rows: ChannelRow[] = [];
  for (const id of wanted.sort()) {
    const row = agents[id];
    if (!isRecord(row)) continue;
    const profile = String(row.profile_name || id);
    const delta = readYaml(join(fleetHome(), "profiles", profile, "config.delta.yaml")) ?? {};
    const refs = deltaRefs(delta);
    for (const platform of Object.keys(CHANNEL_PLATFORMS) as ChannelPlatform[]) {
      const spec = CHANNEL_PLATFORMS[platform];
      const block = isRecord(row[platform]) ? row[platform] : {};
      const present = Object.keys(refs).filter((key) => key === spec.credentialEnv || key === spec.appEnv);
      const status = typeof block.provisioning_status === "string" ? block.provisioning_status : null;
      const pinned = deltaEnabled(delta, platform);
      if (!status && present.length === 0 && pinned !== true) continue;
      const live = gateway.platforms[`${profile}:${platform}`];
      const state = typeof live?.state === "string" ? live.state : null;
      const effective = pinned ?? baseEnabled(platform);
      const notes: string[] = [];
      let standing: ChannelRow["standing"];
      if (status === OFFLINE_STATUS) {
        standing = "offline";
        if (pinned !== false) notes.push("registry says offline but the delta does not pin enabled: false");
        if (state === "connected") notes.push("gateway still shows it connected; cycle the profile or reload");
        else if (state === "fatal") notes.push("gateway_state.json still holds a stale fatal entry from before it was parked");
        if (present.length === 0) notes.push(`no ${spec.credentialEnv} reference kept`);
      } else if (status === "deferred" || status === "disabled") {
        standing = "deferred";
        if (state === "connected") notes.push(`registry says ${status} but the gateway has this channel connected`);
      } else if (status === VERIFIED_STATUS || effective === true) {
        if (state === "fatal") { standing = "broken"; notes.push(`gateway: ${live?.error_code ?? "fatal"}; rotate it, or park it: flume channel offline ${id} --platform ${platform} --reason ... --apply`); }
        else if (present.length === 0) { standing = "broken"; notes.push(`enabled with no ${spec.credentialEnv} reference`); }
        else standing = "online";
        if (status !== null && status !== VERIFIED_STATUS) notes.push(`registry status is ${status}, not verified`);
      } else standing = "unwired";
      rows.push({
        employee: id, platform, standing, status, delta_enabled: pinned, base_enabled: baseEnabled(platform), refs: present,
        bot_username: typeof block.bot_username === "string" ? block.bot_username : null,
        offline_since: typeof block.offline_since === "string" ? block.offline_since : null,
        offline_reason: typeof block.offline_reason === "string" ? block.offline_reason : null,
        gateway: live ? { state, error_code: live.error_code ?? null, updated_at: live.updated_at ?? null } : null,
        notes,
      });
    }
  }
  const totals: Record<string, number> = {};
  for (const row of rows) totals[row.standing] = (totals[row.standing] ?? 0) + 1;
  // A deferred channel nobody wired (no reference, nothing live) is the fleet default, not news.
  const quiet = (row: ChannelRow) => row.standing === "deferred" && row.refs.length === 0 && !row.gateway && row.notes.length === 0;
  const shown = options.all || employee ? rows : rows.filter((row) => !quiet(row));
  const active = Object.entries(gateway.platforms).filter(([key, value]) => key.endsWith(":telegram") && value?.state === "connected").length;
  return { ok: true, rows: shown, hidden_quiet: rows.length - shown.length, totals, active_telegram_bots: gateway.running ? active : 0, gateway_running: gateway.running, blockers: [] };
}

// ---------------------------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------------------------

export function formatChannelResult(result: ChannelResult): string {
  const lines: string[] = [];
  const head = `${result.employee} ${result.platform}`;
  if (!result.ok) {
    lines.push(`✗ ${head}: not ${result.action === "offline" ? "parked" : "brought online"}`);
    for (const blocker of result.blockers) lines.push(`  ✗ ${blocker.code}: ${blocker.detail}`);
  } else if (!result.changed) lines.push(`${head}: no change${result.note ? ` (${result.note})` : ""}`);
  else lines.push(`${head}: ${result.from.status ?? "unset"} -> ${result.to.status}${result.apply ? "" : " (preview)"}`);
  if (result.rotation) lines.push(`  rotate ${result.rotation.env}: ${result.rotation.from ?? "(none)"} -> ${result.rotation.to}`);
  if (result.verified) lines.push(`  verified bot ${result.verified.bot_username ?? "?"} (${result.verified.bot_id ?? "?"})`);
  for (const write of result.writes) lines.push(`  wrote ${write}`);
  if (result.gateway) lines.push(`  gateway: ${result.gateway.confirmed ? "confirmed" : "NOT confirmed"} (${result.gateway.action}) ${result.gateway.detail}${result.gateway.state ? `; state ${result.gateway.state}` : "; no live entry"}`);
  for (const warning of result.warnings) lines.push(`  ! ${warning}`);
  if (result.ok && result.changed && !result.apply && result.note) lines.push(`  ${result.note}`);
  return `${lines.join("\n")}\n`;
}

export function formatChannelList(result: ChannelListResult): string {
  const lines: string[] = [];
  const width = Math.max(8, ...result.rows.map((row) => row.employee.length));
  lines.push(`${"employee".padEnd(width)}  platform  standing  registry   delta  ref  gateway`);
  for (const row of result.rows) {
    const gw = row.gateway ? `${row.gateway.state ?? "?"}${row.gateway.error_code ? ` ${row.gateway.error_code}` : ""}` : "-";
    lines.push(`${row.employee.padEnd(width)}  ${row.platform.padEnd(8)}  ${row.standing.padEnd(8)}  ${(row.status ?? "-").padEnd(9)}  ${(row.delta_enabled === null ? "-" : String(row.delta_enabled)).padEnd(5)}  ${row.refs.length ? "yes" : "no "}  ${gw}`.trimEnd());
    if (row.standing === "offline") lines.push(`${" ".repeat(width + 2)}parked${row.offline_since ? ` since ${row.offline_since}` : ""}${row.offline_reason ? `: ${row.offline_reason}` : ""}`);
    for (const note of row.notes) lines.push(`${" ".repeat(width + 2)}! ${note}`);
  }
  const counts = Object.entries(result.totals).map(([key, value]) => `${value} ${key}`).join(", ") || "no channels";
  lines.push("");
  lines.push(`${counts}${result.hidden_quiet ? ` (${result.hidden_quiet} unwired deferred channel(s) hidden; --all shows them)` : ""}.`);
  lines.push(`Telegram bots active right now: ${result.active_telegram_bots}${result.gateway_running ? "" : " (gateway not running)"}`);
  return `${lines.join("\n")}\n`;
}
