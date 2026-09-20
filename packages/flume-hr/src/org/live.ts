// The roster's two LIVE columns: what an agent is doing right now (ASM state in
// Redis) and what it is carrying (tickets on its board).
//
// Everything else in `src/org/` reads files that are true until someone edits
// them. These two facts are true for seconds. That difference drives every
// decision in this module:
//
//   * NO CLIENT LIBRARY. flume-hr has no redis dependency and no HTTP client,
//     and adding either to render two roster columns would be a dependency the
//     contract has to carry forever. `runtime.ts` already owns the one sanctioned
//     way to reach outside this process -- an argv-only, byte-capped,
//     deadline-aware, abort-aware bounded child -- so both facts are read by
//     shelling out to `redis-cli` and `px` through `probeText`.
//
//   * ABSENCE IS AN ANSWER, NOT AN ERROR. `asm:a:*` keys carry a 900-second TTL
//     and are written only when an agent fires a hook; agent-hooks' own
//     `core/agents.py` docstring warns that asm holds a minority of the agents
//     that are actually open (measured there: 2 scopes against 13 agents in
//     zellij panes). Most rows on a 25-agent roster will legitimately have no
//     live record. `found: false` is therefore a first-class, renderable result
//     and never a failure -- and it is kept DISTINCT from "Redis is unreachable",
//     which is a different thing an operator must be able to see.
//
//   * ONE HONEST NUMBER BEATS TWO INVENTED ONES. See `readTickets`.

import { statSync } from "node:fs";
import { createRunContext, mapBounded, probeEnv, probeText, type FleetRunContext } from "./runtime";

/* ------------------------------------------------------------------- shared */

/** Concurrency for the local Redis reads: cheap, local, unix-socket-fast. */
const REDIS_CONCURRENCY = 8;

/**
 * Concurrency for `px`: deliberately low.
 *
 * Every `px` invocation that does not inherit `PLANE_API_KEY` resolves
 * `op://DeLoSecrets/Plane/Main/apiKey` by spawning the 1Password CLI. Ten of
 * those at once earns a 1Password rate-limit, which `px` then reports as a
 * credential failure -- a false "your token is bad" that costs an afternoon.
 * Two at a time, and an operator who exports `PLANE_API_KEY` (inherited through
 * `probeEnv`) skips `op` entirely.
 */
const PX_CONCURRENCY = 2;

/** A Redis HGETALL is local and either answers immediately or is not answering. */
const REDIS_TIMEOUT_MS = 5_000;

/** `px` pages a whole Plane board over the network, after an `op read`. */
const PX_TIMEOUT_MS = 30_000;

/**
 * Field/value separator for `redis-cli -d`.
 *
 * The default separator is a newline, which makes the output ambiguous the
 * moment any value contains one. ASCII 0x1F (unit separator) cannot appear in a
 * cwd, a profile name or a timestamp, so the split is exact.
 */
const REDIS_FIELD_SEP = "\u001f";

/** Trim a child's message into something safe to put in a roster cell. */
function reasonFrom(raw: string | null | undefined, fallback: string): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function textField(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

/** True only for a path that is a directory right now; any error is a `false`. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function numberField(raw: string | undefined): number | undefined {
  const value = textField(raw);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/* ---------------------------------------------------------------- ASM state */

/**
 * The CLIs agent-hooks knows how to key a scope for.
 *
 * Mirrors `COMM_FOR_CLI` in bloodbank/services/agent-hooks/core/asm.py. A type
 * this set does not contain cannot produce a key that exists, so it falls back
 * to `hermes` -- every provisioned fleet agent is a Hermes profile, and a wrong
 * guess here reads as "no live record" rather than as a wrong answer.
 */
const ASM_CLIS: ReadonlySet<string> = new Set(["claude", "codex", "copilot", "hermes", "antigravity"]);

/** What an unrecognised or missing runtime type is keyed as. */
export const ASM_DEFAULT_CLI = "hermes";

/** A profile name that can appear in a Redis key without quoting games. */
const SAFE_PROFILE = /^[A-Za-z0-9._-]{1,96}$/;

/** Normalise an agent's runtime type into the CLI segment of an ASM scope. */
export function asmCli(type: string | null | undefined): string {
  const normalised = String(type ?? "").trim().toLowerCase();
  return ASM_CLIS.has(normalised) ? normalised : ASM_DEFAULT_CLI;
}

/**
 * The Redis key holding one agent's live state.
 *
 * `asm:a:<scope>` where the scope is `<cli>:a:<profile>` -- see asm.py:108-110
 * and :205-210. The profile is the agent's PROFILE NAME, never its registry
 * agent id: for several agents the two differ, and joining on the agent id
 * silently reports every one of them as offline.
 */
export function asmStateKey(profileName: string, type?: string | null): string {
  return `asm:a:${asmCli(type)}:a:${profileName}`;
}

/** One agent, as `readLiveState` needs to see it. */
export interface LiveStateAgentRef {
  agentId: string;
  /** `profile_name` from the registry -- NOT the agent id. */
  profileName?: string | null;
  /** The agent's runtime/CLI type; anything unrecognised is treated as Hermes. */
  type?: string | null;
}

/**
 * One agent's live state, or the clearly-stated absence of one.
 *
 * Every field but `agentId` and `found` is optional because the hash is sparse:
 * agent-hooks writes what the transition knew, and a cron-driven turn has no
 * zellij pane, a gateway has no correlation id, and a freshly-seeded scope has
 * `state: "unknown"` written literally.
 */
export interface LiveAgentState {
  agentId: string;
  /** True only when Redis returned a non-empty hash for this agent's key. */
  found: boolean;
  /** The ASM state verbatim, including the literal `"unknown"` asm.py seeds. */
  state?: string;
  mainLane?: string;
  turn?: number;
  tools?: number;
  subs?: number;
  pid?: number;
  cwd?: string;
  /** Epoch millis the agent entered its current state (`since`). */
  sinceMs?: number;
  /** Epoch millis of the last hook write (`last_ms`) -- "last updated in redis". */
  lastMs?: number;
  /** Millis between `lastMs` and now. */
  stalenessMs?: number;
  /** `stalenessMs` as a short label ("12s", "4m", "2h"), ready for a cell. */
  staleness?: string;
  /** The key that was read, so an operator can check it by hand. */
  key?: string;
  /** Why there is no state: `no-live-record`, `no-profile-name`, or the failure. */
  reason?: string;
}

export interface ReadLiveStateOptions {
  /** An existing run budget; one unbounded context is created when absent. */
  ctx?: FleetRunContext;
  /** `redis-cli` by name, so PATH applies and a shim can stand in for it. */
  redisCli?: string;
  /** `-u <url>`; defaults to the same env chain asm.py's `_redis_url` uses. */
  redisUrl?: string;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** The same precedence as `_redis_url` in asm.py:127-133, minus the default. */
function resolveRedisUrl(explicit: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  return explicit ?? env.ASM_REDIS_URL ?? env.TOOLING_REDIS_URL ?? env.REDIS_URL ?? undefined;
}

/** Short, human staleness. Deliberately coarse: a roster cell is not a stopwatch. */
export function formatStaleness(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Split `redis-cli -d <sep> hgetall` output into a field map. */
function parseHash(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (raw === "") return fields;
  const parts = raw.split(REDIS_FIELD_SEP);
  // A dangling final token means a truncated reply; the pairs before it are
  // still exact, so they are kept rather than discarding the whole record.
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = parts[i];
    const value = parts[i + 1];
    if (key === undefined || value === undefined) continue;
    fields.set(key, value);
  }
  return fields;
}

/**
 * Read every agent's live ASM state from Redis.
 *
 * Returns one entry per input agent, keyed by `agentId`, ALWAYS -- an agent with
 * no record still gets a row saying so, because a roster that silently drops the
 * agents it could not resolve is a roster that lies about the size of the fleet.
 *
 * One `redis-cli ping` runs first. Without it, an unreachable Redis is
 * indistinguishable from a fleet where nobody fired a hook recently: both
 * produce 25 empty answers, and only one of them is a problem to fix.
 */
export async function readLiveState(
  agents: readonly LiveStateAgentRef[],
  options: ReadLiveStateOptions = {},
): Promise<Map<string, LiveAgentState>> {
  const out = new Map<string, LiveAgentState>();
  if (agents.length === 0) return out;

  const ctx = options.ctx ?? createRunContext({ probeTimeoutMs: options.timeoutMs ?? REDIS_TIMEOUT_MS });
  const now = options.now ?? Date.now;
  const command = options.redisCli ?? "redis-cli";
  const timeoutMs = options.timeoutMs ?? REDIS_TIMEOUT_MS;
  const env = probeEnv();
  const url = resolveRedisUrl(options.redisUrl, env);
  const connect = url ? ["-u", url] : [];

  const ping = await probeText(ctx, command, [...connect, "ping"], { env, timeoutMs, keepStdoutOnFailure: true });
  if (ping.outcome !== "ok" || ping.value !== "PONG") {
    const detail =
      ping.outcome === "timeout"
        ? `redis-cli timed out after ${timeoutMs}ms`
        : // stderr is never read by a probe, so redis-cli's own "Connection
          // refused" is not available here; the url it was pointed at is the
          // fact an operator actually needs.
          reasonFrom(ping.value, `${command} did not answer PING at ${url ?? "redis://127.0.0.1:6379 (default)"}`);
    const reason = `redis-unreachable: ${detail}`;
    for (const agent of agents) out.set(agent.agentId, { agentId: agent.agentId, found: false, reason });
    return out;
  }

  // Deduplicated by KEY, not by agent: two registry rows naming one profile are
  // one live agent, and reading the same hash twice would also let the two rows
  // disagree about it depending on which read landed first.
  const keyed = agents.map((agent) => {
    const profile = String(agent.profileName ?? "").trim();
    if (!profile) return { agent, key: null, reason: "no-profile-name" };
    if (!SAFE_PROFILE.test(profile)) return { agent, key: null, reason: `unsafe-profile-name: ${profile}` };
    return { agent, key: asmStateKey(profile, agent.type), reason: null };
  });

  const uniqueKeys = [...new Set(keyed.filter((row) => row.key !== null).map((row) => row.key as string))];
  const reads = await mapBounded(uniqueKeys, options.concurrency ?? REDIS_CONCURRENCY, async (key) => {
    const result = await probeText(ctx, command, [...connect, "-d", REDIS_FIELD_SEP, "hgetall", key], {
      env,
      timeoutMs,
      keepStdoutOnFailure: true,
    });
    return { key, result };
  });

  const byKey = new Map(reads.map((row) => [row.key, row.result]));

  for (const row of keyed) {
    const { agent } = row;
    if (row.key === null) {
      out.set(agent.agentId, { agentId: agent.agentId, found: false, reason: row.reason ?? "no-profile-name" });
      continue;
    }
    const result = byKey.get(row.key);
    if (!result || result.outcome !== "ok") {
      const detail =
        result?.outcome === "timeout" ? `timed out after ${timeoutMs}ms` : reasonFrom(result?.value, "hgetall failed");
      out.set(agent.agentId, { agentId: agent.agentId, found: false, key: row.key, reason: `redis-read-failed: ${detail}` });
      continue;
    }

    const fields = parseHash(result.value ?? "");
    if (fields.size === 0) {
      // The common, expected case. asm:a:* keys expire after 15 minutes and are
      // written only on a hook, so most of the fleet is legitimately silent.
      out.set(agent.agentId, { agentId: agent.agentId, found: false, key: row.key, reason: "no-live-record" });
      continue;
    }

    const lastMs = numberField(fields.get("last_ms"));
    const stalenessMs = lastMs === undefined ? undefined : Math.max(0, now() - lastMs);
    out.set(agent.agentId, {
      agentId: agent.agentId,
      found: true,
      key: row.key,
      state: textField(fields.get("state")),
      mainLane: textField(fields.get("main_lane")),
      turn: numberField(fields.get("turn")),
      tools: numberField(fields.get("tools")),
      subs: numberField(fields.get("subs")),
      pid: numberField(fields.get("pid")),
      cwd: textField(fields.get("cwd")),
      sinceMs: numberField(fields.get("since")),
      lastMs,
      stalenessMs,
      staleness: stalenessMs === undefined ? undefined : formatStaleness(stalenessMs),
    });
  }

  return out;
}

/* ------------------------------------------------------------------ tickets */

/**
 * Why `claimed` and `inProgress` are not filled in.
 *
 * MEASURED against the installed `px` (a symlink to ~/code/pilot/bin/pilot.js),
 * not guessed:
 *
 *   * `task list --json` emits ONLY `{id, sequence_id, name, state, created_at}`
 *     per issue (src/commands/task.js:29-35). There are no labels and no
 *     assignees in the payload, so the `agent:working` label and the assignee --
 *     the two things a claim IS -- cannot be counted from this CLI at all.
 *   * `state` is the raw Plane state UUID, not a name (src/plane.js:161). The
 *     only id->group map would be the board's state collection, and
 *     `px schema export` omits state ids (STATE_KEYS in src/commands/schema.js),
 *     so a UUID cannot be resolved to the "started" group.
 *   * `task list` accepts no `--group`: `flags.group` is read
 *     (src/commands/task.js:21) but no such option is declared, and parseArgs
 *     runs `strict: true`, so passing one is a hard parse error.
 *   * `.project.json` would carry a lane->state-id map under `execution.states`,
 *     which would close the gap -- but NO repo on this machine has an
 *     `execution` block (checked across every `.project.json` under ~/code;
 *     `px whoami --json` reports `"execution": null` on every one of them), and
 *     role.yaml's required lane map names lanes ("In Progress"), not their ids.
 *
 * And even with all of that, a claim could not be attributed to an agent: the
 * whole fleet authenticates to Plane with ONE shared API key, so every ticket
 * any agent claims is assigned to the same Plane user.
 *
 * So this returns the one number that is actually true -- how many issues are on
 * the agent's board -- and says, in `reason`, that it is board-wide.
 */
export const TICKETS_SHAPE_REASON =
  "board-wide total: px task list --json emits no labels/assignees and only a raw state UUID, " +
  "so claimed vs in-progress is not derivable; the fleet also shares one Plane identity";

/** One agent, as `readTickets` needs to see it. */
export interface TicketsAgentRef {
  agentId: string;
  /** The agent's checkout. `px` resolves the board FROM CWD, so this is required. */
  repoPath?: string | null;
}

/**
 * One agent's ticket counts, or a stated reason there are none to give.
 *
 * `known: false` means "not measured" and must render as `unknown`, never as
 * zero. Measured on this fleet: 20 of 25 agents have a repo with a Plane board
 * binding, 4 have a checkout with no `ticket_provider.board_id`, and 1 names a
 * checkout that no longer exists. Printing `0` for any of those last five --
 * when boards in this fleet really do range from 0 to 295 issues -- is the
 * single most misleading thing this column could do.
 */
export interface LiveTickets {
  agentId: string;
  known: boolean;
  /** Not populated by this provider -- see TICKETS_SHAPE_REASON. */
  claimed?: number;
  /** Not populated by this provider -- see TICKETS_SHAPE_REASON. */
  inProgress?: number;
  /** Issues on the agent's board. The one honest number available. */
  total?: number;
  /**
   * `total` broken down by Plane state UUID, highest count first in insertion order.
   *
   * The UUIDs are opaque here on purpose -- nothing reachable from this machine
   * maps a Plane state id to its lane name (see TICKETS_SHAPE_REASON). It is
   * carried anyway because it is the ONLY raw material an "In Progress" count
   * could ever be computed from, and a caller that acquires a lane->id map
   * later gets that count without another board read.
   */
  byState?: Record<string, number>;
  /** The board identifier `px` resolved from the repo (e.g. "PJAN"). */
  board?: string;
  /** Why the counts are missing, or what the number does and does not mean. */
  reason?: string;
}

export interface ReadTicketsOptions {
  ctx?: FleetRunContext;
  /** `px` by name, so PATH applies. */
  px?: string;
  concurrency?: number;
  timeoutMs?: number;
  /**
   * Extra environment for the `px` children, merged over `probeEnv()`.
   *
   * The one worth setting is `PLANE_API_KEY`: with it, `px` never shells out to
   * the 1Password CLI, which is both faster and the difference between reading
   * 10 boards and being rate-limited halfway through.
   */
  env?: NodeJS.ProcessEnv;
}

/** Count issues per Plane state UUID, ordered biggest bucket first. */
function tallyStates(issues: unknown): Record<string, number> | undefined {
  if (!Array.isArray(issues)) return undefined;
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const state = (issue as { state?: unknown } | null)?.state;
    if (typeof state !== "string" || state === "") continue;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
}

interface PxTaskListPayload {
  ok?: unknown;
  board?: unknown;
  count?: unknown;
  issues?: unknown;
  error?: unknown;
}

/**
 * Read each agent's board through `px`, one invocation per distinct repo.
 *
 * `px` resolves its board from the working directory, so the repo path is the
 * whole input; an agent without one is reported `known: false` rather than
 * being pointed at whatever board this process happens to be standing in.
 *
 * `keepStdoutOnFailure` is not optional here: `px` prints its JSON error
 * envelope to stdout and THEN exits 1 (src/output.js `fail`), so discarding
 * stdout on a nonzero exit would throw away the only explanation there is.
 */
export async function readTickets(
  agents: readonly TicketsAgentRef[],
  options: ReadTicketsOptions = {},
): Promise<Map<string, LiveTickets>> {
  const out = new Map<string, LiveTickets>();
  if (agents.length === 0) return out;

  const ctx = options.ctx ?? createRunContext({ probeTimeoutMs: options.timeoutMs ?? PX_TIMEOUT_MS });
  const command = options.px ?? "px";
  const timeoutMs = options.timeoutMs ?? PX_TIMEOUT_MS;
  const env = options.env ? { ...probeEnv(), ...options.env } : probeEnv();

  const repos = [
    ...new Set(
      agents
        .map((agent) => String(agent.repoPath ?? "").trim())
        .filter((repo) => repo !== ""),
    ),
  ];

  const reads = await mapBounded(repos, options.concurrency ?? PX_CONCURRENCY, async (repo) => {
    // Checked BEFORE the spawn. A cwd that does not exist makes `spawn` emit an
    // `error` event, which arrives as a bare `failed` with no stdout -- and
    // "px produced no output" is the wrong answer to "that checkout is gone".
    if (!isDirectory(repo)) return { repo, result: null, reason: `repo_path is not a directory: ${repo}` };
    const result = await probeText(ctx, command, ["task", "list", "--json"], {
      cwd: repo,
      env,
      timeoutMs,
      keepStdoutOnFailure: true,
    });
    return { repo, result, reason: null as string | null };
  });

  const byRepo = new Map<string, LiveTickets>();
  for (const { repo, result, reason } of reads) {
    const base: LiveTickets = { agentId: "", known: false };
    if (result === null) {
      byRepo.set(repo, { ...base, reason: reason ?? "not read" });
      continue;
    }
    if (result.outcome === "timeout") {
      byRepo.set(repo, { ...base, reason: `px timed out after ${timeoutMs}ms` });
      continue;
    }
    if (result.value === null) {
      // No stdout at all: `px` is not on PATH, or the cwd does not exist.
      byRepo.set(repo, { ...base, reason: `px produced no output (exit ${result.status ?? "killed"})` });
      continue;
    }

    let payload: PxTaskListPayload;
    try {
      payload = JSON.parse(result.value) as PxTaskListPayload;
    } catch {
      byRepo.set(repo, { ...base, reason: reasonFrom(result.value, "px emitted unparseable output") });
      continue;
    }

    if (payload.ok !== true) {
      byRepo.set(repo, { ...base, reason: reasonFrom(typeof payload.error === "string" ? payload.error : null, "px reported a failure") });
      continue;
    }

    const total =
      typeof payload.count === "number" ? payload.count : Array.isArray(payload.issues) ? payload.issues.length : undefined;
    if (total === undefined) {
      byRepo.set(repo, { ...base, reason: "px returned no issue count" });
      continue;
    }

    byRepo.set(repo, {
      ...base,
      known: true,
      total,
      byState: tallyStates(payload.issues),
      board: typeof payload.board === "string" ? payload.board : undefined,
      reason: TICKETS_SHAPE_REASON,
    });
  }

  for (const agent of agents) {
    const repo = String(agent.repoPath ?? "").trim();
    if (repo === "") {
      out.set(agent.agentId, { agentId: agent.agentId, known: false, reason: "no repo_path in the registry" });
      continue;
    }
    const row = byRepo.get(repo);
    if (!row) {
      out.set(agent.agentId, { agentId: agent.agentId, known: false, reason: "not read" });
      continue;
    }
    out.set(agent.agentId, { ...row, agentId: agent.agentId });
  }

  return out;
}
