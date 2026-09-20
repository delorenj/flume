// Bounded, cancellable execution context for fleet observation commands.
//
// Nothing in `src/fleet/` or `src/mcp-server.ts` could express any of this
// before: `grep -n 'AbortController|signal|timeout|deadline|cancel'` over both
// returned zero matches. The inventory needed none of it -- it reads two files.
// A provenance run spawns child processes against arbitrary checkouts, so it
// needs all four of:
//
//   * a per-probe budget, so one hung repository cannot stall the fleet;
//   * a whole-run deadline, so a caller can bound the command itself;
//   * cancellation, so SIGINT (CLI) and an aborted request (MCP) both stop the
//     work AND kill the children it started;
//   * byte bounds, so a probe that decides to print a gigabyte does not become
//     this process's memory problem.
//
// `git`/`gitLine` in `src/describe/activity.ts` are the repo's only exported,
// both-bounded git pair and are deliberately NOT reused here: they hardcode
// `["-C", repo, ...args]` with no slot for the `--no-optional-locks` flag that
// must precede `-C`, they collapse timeout and failure into one bare
// `undefined`, and they are synchronous. `gitAsync` (`activity.ts:93`) is the
// model for the SIGKILL-on-timeout and manual byte counting below.

import { spawn } from "node:child_process";
import { FleetError } from "./types";
import type { FleetProbeOutcome } from "./types";

/** Per-probe wall-clock budget when a caller names none. */
export const FLEET_DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Bytes of stdout one probe may produce before it is killed. */
const PROBE_MAX_BYTES = 4 * 1024 * 1024;

/** Floor on a per-probe budget: below this, nothing can succeed and everything times out. */
const MIN_PROBE_TIMEOUT_MS = 1;

/**
 * One run's time and cancellation budget.
 *
 * Deliberately a value, not a class: both adapters construct one, hand it to the
 * core, and never mutate it. `signal` is the ONLY mutable thing in it, and it is
 * owned by whoever created the controller.
 */
export interface FleetRunContext {
  signal: AbortSignal;
  /** Epoch millis after which the whole run fails with TIMEOUT, or null for unbounded. */
  deadlineAt: number | null;
  probeTimeoutMs: number;
}

export interface FleetRunContextOptions {
  signal?: AbortSignal;
  /** Whole-run budget in millis. A positive integer, or undefined for unbounded. */
  deadlineMs?: number;
  probeTimeoutMs?: number;
  /** Injected clock, so a suite can pin a deadline without sleeping. */
  now?: () => number;
}

/**
 * A never-aborting signal, for callers that pass none.
 *
 * `AbortSignal.abort()` is the opposite (already aborted). A fresh controller's
 * signal is the "no cancellation was requested" value: nothing holds the
 * controller, so nothing can ever abort it, which is exactly the property this
 * constant exists to have. (An earlier version of this comment claimed the
 * controller was retained in a closure. There is no closure -- the controller is
 * discarded on the same line -- and a reader should not be told otherwise.)
 */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

export function createRunContext(options: FleetRunContextOptions = {}): FleetRunContext {
  const now = options.now ?? Date.now;
  const deadline = options.deadlineMs;
  if (deadline !== undefined) {
    if (!Number.isInteger(deadline) || deadline <= 0) {
      throw new FleetError("INVALID_INPUT", "deadlineMs must be a positive whole number of milliseconds");
    }
  }
  const probeTimeout = options.probeTimeoutMs ?? FLEET_DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isInteger(probeTimeout) || probeTimeout < MIN_PROBE_TIMEOUT_MS) {
    throw new FleetError("INVALID_INPUT", "probeTimeoutMs must be a positive whole number of milliseconds");
  }
  return {
    signal: options.signal ?? NEVER_ABORTED,
    deadlineAt: deadline === undefined ? null : now() + deadline,
    probeTimeoutMs: probeTimeout,
  };
}

/**
 * Fail the run if the caller has cancelled it.
 *
 * Called between units of work, never inside one: a half-built fact is worse
 * than a fact that was never started, and `CANCELLED` is a COMMAND failure whose
 * envelope carries no `data` at all.
 */
export function throwIfCancelled(ctx: FleetRunContext): void {
  if (ctx.signal.aborted) throw new FleetError("CANCELLED", "Fleet command was cancelled before it completed");
}

/**
 * Millis left on the whole-run deadline, or `Infinity` when there is none.
 *
 * Throws `TIMEOUT` rather than returning zero. A truncated provenance report is
 * exactly the kind of partial that must never be mistaken for a complete one, so
 * a blown deadline is a command failure -- unlike a per-PROBE timeout, which
 * downgrades one fact to `unobserved` and lets the run succeed.
 */
export function remainingMs(ctx: FleetRunContext, now: () => number = Date.now): number {
  throwIfCancelled(ctx);
  if (ctx.deadlineAt === null) return Number.POSITIVE_INFINITY;
  const left = ctx.deadlineAt - now();
  if (left <= 0) throw new FleetError("TIMEOUT", "Fleet command exceeded its deadline before it completed");
  return left;
}

export interface FleetProbeResult {
  outcome: FleetProbeOutcome;
  /** Trimmed stdout on `ok`, null on every other outcome. Never stderr. */
  value: string | null;
}

/**
 * A bounded child's full result, including the halves `probe` deliberately drops.
 *
 * `code` is the process exit status, null when the child was killed or never ran.
 * It is what separates "exited 1 WITH a complete report" -- which
 * `pjangler audit` does by design on a drifted repository -- from "exited 127
 * with nothing", and `auditRepository` reads it to categorize the difference.
 *
 * `overflow` says the child was killed for exceeding `PROBE_MAX_BYTES` rather
 * than for saying nothing. Without it a report one byte past the cap is
 * indistinguishable from an empty one, and the real audit report on this fleet
 * is already 3.7 MB against a 4 MiB cap -- so the two are one growth spurt apart
 * and must not report the same reason.
 *
 * `value` is trimmed stdout, and unlike `FleetProbeResult` it SURVIVES a nonzero
 * exit when the caller asked it to -- see `captureSelf`.
 */
export interface FleetCaptureResult extends FleetProbeResult {
  code: number | null;
  overflow: boolean;
}

/** A bounded child's stdout as BYTES. `probeRaw` returns this; `probe` decodes and trims. */
export interface FleetRawProbeResult {
  outcome: FleetProbeOutcome;
  /** Untrimmed stdout bytes on `ok`, null on every other outcome. Never stderr. */
  value: Buffer | null;
}

interface BoundedChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Bytes to feed the child on stdin, after which stdin is closed.
   *
   * `git cat-file --batch` and `--batch-check` read their object list from
   * stdin, and one such child over N ids is what keeps a lineage lookup at one
   * spawn rather than one per blob. Absent, stdin is `ignore` exactly as before.
   */
  input?: string | Uint8Array;
  /**
   * Keep stdout as raw bytes: no `setEncoding`, no `trim`.
   *
   * A blob read through `cat-file --batch` is followed by a newline git adds
   * and may itself end in whitespace; `trim()` would corrupt it, and a UTF-8
   * decode would corrupt any blob that is not UTF-8. The text path is unchanged
   * for every existing caller.
   */
  raw?: boolean;
  /**
   * Keep stdout when the child exits nonzero.
   *
   * `probe` says no: a `git remote get-url origin` that exits 1 produced no
   * value worth keeping. `captureSelf` says yes, because `pjangler audit`
   * deliberately exits 1 on a drifted repository (`src/index.ts`) while printing
   * the complete report -- and discarding it would throw away exactly the
   * findings the caller spawned the child for.
   */
  keepStdoutOnFailure?: boolean;
  /**
   * Wall-clock budget for THIS child, replacing `ctx.probeTimeoutMs`.
   *
   * Still floored by `remainingMs`, so a whole-run deadline always wins. It
   * exists because the per-probe budget is sized for a local `git` read and the
   * audit child is not one: the bmad rule inside it gives `npm view` an 8 s
   * timeout of its own (`src/parity/rules.ts`), so inheriting a 5 s budget made
   * every repository time out on a cold cache -- reported as `unobserved` for a
   * reason no operator could see.
   */
  timeoutMs?: number;
}

/**
 * Git's repository-redirection variables. Every one of them can make
 * `git -C <path> ...` answer about a DIFFERENT repository than `<path>`.
 *
 * They are deleted rather than merely overridden because there is no correct
 * value to override them with: `-C <path>` is the only repository selector this
 * module wants, and any of these present in the ambient environment silently
 * wins over it. `GIT_DIR` alone defeats the top-level-equality guard in
 * `probeCheckout` -- the guard reads `rev-parse --show-toplevel`, which would
 * answer with the redirected repository's toplevel and compare equal to nothing
 * this command probed. `GIT_INDEX_FILE` is worse: it can point `status` at an
 * index OUTSIDE the probed tree, which is a write to a path the read-only
 * guarantee never covered.
 *
 * This is not hypothetical ambient state. A git hook, a `git` wrapper, and
 * `direnv` all export `GIT_DIR`, and both this repo's own suites unset these
 * keys in their isolation blocks -- the production path did not.
 */
const GIT_REDIRECTION_KEYS = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES",
  "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
] as const;

/**
 * The environment one probe child gets.
 *
 * `GIT_TERMINAL_PROMPT=0` is the one that keeps a run bounded: without it a
 * checkout with an unauthenticated remote can block on a credential prompt
 * forever behind the timeout. The pager overrides stop git from paging into a
 * pipe nobody drains.
 *
 * `GIT_OPTIONAL_LOCKS=0` is deliberately NOT set. It would do the same job as
 * the `--no-optional-locks` flag every caller passes -- and that is the problem:
 * with both in place, deleting the flag changed nothing and the suite's
 * index-mtime assertion stayed green. Measured. One mechanism, provably
 * load-bearing, beats two that hide each other.
 */
export function probeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" };
  for (const key of GIT_REDIRECTION_KEYS) delete env[key];
  return env;
}

/**
 * Run one bounded child and parse its stdout into a single value.
 *
 * Four deliberate choices:
 *
 *   * SPAWNED BY NAME, never by absolute path and never through a shell. `PATH`
 *     applies, which is what lets a fake `git` shim make the probe-failure and
 *     probe-timeout cases real rather than mocked.
 *   * ARGV ONLY. No shell means no quoting, no globbing, and no way for a
 *     registry value to become a second command.
 *   * STDERR IS NEVER READ. `stdio` sends it to `ignore`, so there is no moment
 *     at which a subprocess's message -- which routinely carries absolute paths
 *     and payload fragments -- exists to be leaked into an envelope.
 *   * TIMEOUT AND FAILURE ARE DISTINCT. `git`/`gitAsync` return a bare
 *     `undefined` for both; a fact that says `unobserved` has to be able to say
 *     WHY, and "the probe was killed" and "the probe said no" are different
 *     answers to an operator.
 */
export async function probe(ctx: FleetRunContext, argv: readonly string[], cwd?: string): Promise<FleetProbeResult> {
  const [command, ...args] = argv;
  if (!command) return { outcome: "failed", value: null };
  // NARROWED, not widened. `runBoundedChild` returns a `FleetCaptureResult`,
  // which also carries `code` and `overflow` -- structural typing accepts that
  // silently, so every existing `probe` caller was receiving two keys its
  // declared type does not mention. A caller that spread a probe result into a
  // payload would have put them into a document the suite asserts is
  // byte-identical across runs and adapters.
  const { outcome, value } = await runBoundedChild(ctx, command, args, { cwd });
  return { outcome, value };
}

/**
 * `probe`, for a child whose stdout is BYTES and which may need stdin.
 *
 * Same budget, same kill rules, same byte cap, same argv-only spawn. The two
 * differences are the ones `cat-file --batch` forces: the output is neither
 * decoded nor trimmed, and `input` is written to the child's stdin and then
 * closed. Nothing else in this module reads a blob, so nothing else needs it.
 */
export async function probeRaw(
  ctx: FleetRunContext,
  argv: readonly string[],
  cwd?: string,
  input?: string | Uint8Array,
): Promise<FleetRawProbeResult> {
  const [command, ...args] = argv;
  if (!command) return { outcome: "failed", value: null };
  const { outcome, bytes } = await runBoundedChild(ctx, command, args, { cwd, input, raw: true });
  return { outcome, value: outcome === "ok" ? bytes : null };
}

/** What `probeText` needs beyond the argv: where, with what, for how long, and whether a nonzero exit keeps its report. */
export interface FleetProbeTextOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  keepStdoutOnFailure?: boolean;
}

/** `probe`, keeping the exit status and -- when asked -- the stdout of a child that exited nonzero. */
export interface FleetProbeTextResult extends FleetProbeResult {
  /** The process exit status, null when the child was killed or never ran. */
  status: number | null;
}

/**
 * `probe`, for a child whose REPORT rides a nonzero exit.
 *
 * The canonical profile renderer's `check` prints `PROFILE CONFIG DRIFT:` and
 * the drifted sections to stdout and then exits 1 -- by design, the same way
 * `pjangler audit` does. `probe` discards stdout on a nonzero exit, so routing
 * the renderer through it would report every drifted profile as `failed` with
 * the drift report thrown away. This variant keeps the text when
 * `keepStdoutOnFailure` says so, returns the exit status beside the outcome
 * (exit 1 with a drift block and exit 1 with a FATAL on stderr are different
 * answers, and stderr is never read), and takes the narrow `env`, `cwd` and
 * `timeoutMs` a renderer child needs. Same budget, same kill rules, same byte
 * cap, same argv-only spawn.
 */
export async function probeText(
  ctx: FleetRunContext,
  command: string,
  argv: readonly string[],
  options: FleetProbeTextOptions = {},
): Promise<FleetProbeTextResult> {
  if (!command) return { outcome: "failed", value: null, status: null };
  const { outcome, value, code } = await runBoundedChild(ctx, command, argv, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    keepStdoutOnFailure: options.keepStdoutOnFailure ?? false,
  });
  return { outcome, value, status: code };
}

/**
 * Run one bounded child of THIS BUILD and keep its stdout whatever it exits with.
 *
 * `process.execPath` is the one deliberate absolute-path spawn in this module.
 * Everything else spawns by name so `PATH` applies -- which is what makes the
 * fake-`git` shim cases real. Here the opposite is required: a `node` picked off
 * `PATH` could be a different runtime than the one running this process, and a
 * status core that parses its own CLI's JSON must be parsing the SAME build's
 * JSON. `entry` is the module path to run; the caller resolves it (and the
 * documented `PJ_FLEET_CLI_ENTRY` seam is what lets a suite point it at a shim).
 *
 * The other half of the contract is `keepStdoutOnFailure`. `pjangler audit`
 * exits 1 on a drifted repository BY DESIGN, with the full report on stdout;
 * `probe` discards stdout on a nonzero exit, so routing this through `probe`
 * would report every drifted repository as `outcome: "failed"` with its findings
 * thrown away -- the exact opposite of what a status run is for.
 */
export function captureSelf(
  ctx: FleetRunContext,
  entry: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<FleetCaptureResult> {
  return runBoundedChild(ctx, process.execPath, [entry, ...args], { cwd, env, timeoutMs, keepStdoutOnFailure: true });
}

/** `FleetCaptureResult` plus the undecoded bytes, for the one caller that wants them. */
interface BoundedChildResult extends FleetCaptureResult {
  bytes: Buffer | null;
}

function runBoundedChild(
  ctx: FleetRunContext,
  command: string,
  args: readonly string[],
  options: BoundedChildOptions = {},
): Promise<BoundedChildResult> {
  const { cwd, env, keepStdoutOnFailure = false, timeoutMs, input, raw = false } = options;
  // Checked BEFORE the spawn, so a cancelled or expired run never starts one
  // more child. `remainingMs` throws TIMEOUT and CANCELLED; both are command
  // failures and must escape rather than become a probe outcome.
  //
  // `timeoutMs` overrides the PER-PROBE budget and never the whole-run one: a
  // caller may say its child needs longer than a `git` read, and no caller may
  // outlive the deadline the operator gave the command.
  const budget = Math.min(timeoutMs ?? ctx.probeTimeoutMs, remainingMs(ctx));

  return new Promise<BoundedChildResult>((settle) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd,
        // stdin is `ignore` unless a caller has bytes to feed it: a child that
        // could wait on a terminal it never gets is a child the timeout has to
        // kill, and nothing here should need killing to finish.
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        // Its own process GROUP, so `kill` below can reach the whole tree.
        // Measured: a shim that is `#!/bin/sh ... sleep 60` puts the sleep under
        // the sh. SIGKILLing the sh alone leaves the sleep holding the write end
        // of our stdout pipe, and the CLI then hung after writing its CANCELLED
        // envelope -- exit code set, process never leaving, because an active
        // handle kept the loop alive.
        detached: true,
        // An observation probe has no business inheriting a pager, an editor, a
        // credential helper, a terminal, or -- above all -- a redirected
        // repository. See `probeEnv` for what is stripped and why. A caller that
        // needs a NARROWER environment (the audit child, which must carry no
        // credential at all) passes its own.
        env: env ?? probeEnv(),
      });
    } catch {
      settle({ outcome: "failed", value: null, code: null, overflow: false, bytes: null });
      return;
    }

    // BYTES, accumulated as buffers and decoded once at the end. Counting
    // `chunk.length` on utf8 strings counted UTF-16 code units against a byte
    // cap (DW-59), and decoding chunk by chunk would split a multi-byte
    // sequence that straddled two reads. One concat, one decode, exact count.
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const collected = (): Buffer => Buffer.concat(chunks);
    const finish = (result: Omit<BoundedChildResult, "bytes" | "value"> & { keep: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      // Release the pipe, always. Node keeps the event loop alive for an open
      // stdio handle, so without this a probe we walked away from -- killed on
      // timeout or on abort -- kept the whole command from ever exiting, even
      // with `process.exitCode` already set and the envelope already written.
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      try { child.stdin?.destroy(); } catch { /* already closed */ }
      child.unref();
      const bytes = result.keep ? collected() : null;
      settle({
        outcome: result.outcome,
        code: result.code,
        overflow: result.overflow,
        bytes,
        // The TEXT value keeps its historical shape for every existing caller:
        // decoded as utf8 and trimmed. A raw caller reads `bytes` instead.
        value: bytes === null || raw ? null : bytes.toString("utf8").trim(),
      });
    };
    // The GROUP, not just the leader: a shell shim's own children are what keep
    // the pipe open after the shell dies. Falls back to the single process when
    // the group is already gone or the platform refuses the negative pid.
    const kill = (): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };

    const timer = setTimeout(() => { kill(); finish({ outcome: "timeout", code: null, overflow: false, keep: false }); }, budget);
    timer.unref?.();

    const onAbort = (): void => { kill(); finish({ outcome: "cancelled", code: null, overflow: false, keep: false }); };
    // If the caller cancelled between the budget check and the spawn, the
    // listener fires immediately and the child is killed on its first tick.
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const stdout = child.stdout;
    if (!stdout) { finish({ outcome: "failed", code: null, overflow: false, keep: false }); return; }
    stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      // `overflow`, not a bare failure: a child killed for saying too much and a
      // child that said nothing are different answers, and at 3.7 MB against a
      // 4 MiB cap the audit report is one growth spurt from needing the
      // distinction.
      if (size > PROBE_MAX_BYTES) { kill(); finish({ outcome: "failed", code: null, overflow: true, keep: false }); return; }
      chunks.push(chunk);
    });
    if (child.stdin) {
      // A child that exits before reading everything (git refusing a bad id)
      // closes the pipe under us; EPIPE on stdin is that child's answer, not
      // this process's error, and its exit status is what the caller reads.
      child.stdin.on("error", () => { /* the close handler reports the outcome */ });
      child.stdin.end(input);
    }
    child.on("error", () => finish({ outcome: "failed", code: null, overflow: false, keep: false }));
    child.on("close", (code) => {
      if (code !== 0) {
        // `keepStdoutOnFailure` is the whole reason this body was extracted from
        // `probe`. The outcome still says `failed`; what changes is that the
        // caller can read WHAT the child said before it said no.
        finish({ outcome: "failed", code, overflow: false, keep: keepStdoutOnFailure });
        return;
      }
      finish({ outcome: "ok", code, overflow: false, keep: true });
    });
  });
}

/**
 * Wait `ms` between two observations, abort-aware and capped by the run deadline.
 *
 * The systemd observer samples the user manager several times over a declared
 * window, and the interval between samples is the one place this module
 * deliberately does nothing for a while. Three properties make that safe:
 *
 *   * CANCELLATION WAKES IT. An aborted signal rejects with `CANCELLED` at
 *     once, so a SIGINT during the window ends the run rather than waiting
 *     out the sleep first.
 *   * THE DEADLINE CAPS IT. The wait never runs past `remainingMs`; the probe
 *     that follows then throws `TIMEOUT` exactly as it would have without the
 *     sleep, so a whole-run budget is honoured to the millisecond it names.
 *   * THE TIMER KEEPS THE LOOP ALIVE. Deliberately NOT `unref`ed: the caller
 *     is awaiting this promise and nothing else may be pending, so an unref'd
 *     timer would let the process exit mid-window with the envelope unwritten.
 */
export function sleepBounded(ctx: FleetRunContext, ms: number): Promise<void> {
  // An ALREADY-aborted signal never fires `abort` for a listener added after
  // the fact, so the guarantee above ("cancellation wakes it") held only for a
  // cancellation that arrived DURING the sleep: a run cancelled a moment before
  // one waited out the whole interval before anything noticed.
  if (ctx.signal.aborted) return Promise.reject(new FleetError("CANCELLED", "Fleet command was cancelled before it completed"));
  const remaining = remainingMs(ctx);
  const wait = Math.max(0, Math.min(ms, Number.isFinite(remaining) ? remaining : ms));
  if (wait === 0) return Promise.resolve();
  return new Promise<void>((settle, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new FleetError("CANCELLED", "Fleet command was cancelled before it completed"));
    };
    const timer = setTimeout(() => {
      ctx.signal.removeEventListener("abort", onAbort);
      settle();
    }, wait);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `tasks` with at most `limit` in flight, preserving input order in the result.
 *
 * Bounded concurrency is a requirement, not an optimization: 28 agents can name
 * 28 distinct checkouts, and 28 simultaneous `git status` runs on a cold cache
 * is a self-inflicted load spike on the operator's own machine. Results are
 * indexed by position rather than push order, because ordering by COMPLETION
 * would make `data` depend on which probe happened to finish first -- and
 * `data` has to be byte-identical across two runs over identical state.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
