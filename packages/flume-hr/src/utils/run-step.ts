import { spawn, spawnSync } from "node:child_process";

/**
 * One child process run by a lifecycle step (hire, onboard, deferred effects).
 *
 * Every step used to be a `spawnSync` under a clack spinner. A synchronous
 * child blocks the event loop, so the spinner froze on its first frame and a
 * silent child (Copier tasks, a Plane call, a 1Password read) looked exactly
 * like a hang, for as long as it took, with no bound. This runner keeps the
 * loop alive so the operator sees a heartbeat, and bounds every unattended
 * child so a wedged one fails the step instead of the session.
 */
export interface StepOptions {
  /** What the operator is waiting on, e.g. "copier copy (agents/hermes/pm)". */
  label: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Capture stdout/stderr instead of giving the child the terminal. */
  capture?: boolean;
  /**
   * A human is answering the child's prompts. The prompts are the feedback and
   * the human sets the pace, so there is no heartbeat and no timeout.
   */
  interactive?: boolean;
  /** Wall-clock bound for an unattended child. Default FLUME_STEP_TIMEOUT_MS or 15 minutes. */
  timeoutMs?: number;
  /** How often an unattended child reports it is still running. Default 20s; 0 disables. */
  heartbeatMs?: number;
  /** Where heartbeats go. Default stderr; quiet runs (MCP) pass nothing to print. */
  heartbeat?: ((line: string) => void) | null;
}

export interface StepResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
  elapsedMs: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const KILL_GRACE_MS = 5000;

export function defaultStepTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FLUME_STEP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** The step's verdict for an operator: `exited with status 2`, `timed out after 15m00s`, ... */
export function describeStepFailure(result: StepResult): string {
  if (result.timedOut) return `timed out after ${formatElapsed(result.elapsedMs)}`;
  if (result.error) return result.error.message;
  if (result.signal) return `killed by ${result.signal}`;
  return `exited with status ${result.status}`;
}

export function runStep(command: string, args: readonly string[], options: StepOptions): Promise<StepResult> {
  const started = Date.now();
  const unattended = !options.interactive;
  const timeoutMs = unattended ? (options.timeoutMs ?? defaultStepTimeoutMs(options.env ?? process.env)) : 0;
  const heartbeatMs = unattended ? (options.heartbeatMs ?? 20_000) : 0;
  const heartbeat = options.heartbeat === undefined
    ? (line: string) => process.stderr.write(`${line}\n`)
    : options.heartbeat;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (result: Omit<StepResult, "stdout" | "stderr" | "timedOut" | "elapsedMs">) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut, elapsedMs: Date.now() - started });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
    } catch (error) {
      finish({ status: null, signal: null, error: error as Error });
      return;
    }
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("close", (status, signal) => finish({ status, signal }));
    // A grandchild (a Copier task's curl) can keep the pipes open after the
    // child itself is gone, which would hold "close" forever. Once a killed
    // child has exited, its result is final.
    child.on("exit", (status, signal) => {
      if (!timedOut) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ status, signal });
    });

    if (heartbeat && heartbeatMs > 0) {
      const beat = setInterval(() => {
        heartbeat(`  … ${options.label}: still running (${formatElapsed(Date.now() - started)})`);
      }, heartbeatMs);
      timers.push(beat as unknown as NodeJS.Timeout);
    }
    if (timeoutMs > 0) {
      timers.push(setTimeout(() => {
        timedOut = true;
        // The child shares the operator's process group (so Ctrl-C still reaches
        // it); take its direct children down with it, best effort.
        if (child.pid) spawnSync("pkill", ["-TERM", "-P", String(child.pid)], { stdio: "ignore", timeout: 2000 });
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        kill.unref();
      }, timeoutMs));
    }
  });
}
