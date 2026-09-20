// Flush-safe stdout for commands whose output is a machine contract.
//
// THE DEFECT, MEASURED (node v26.4.0, this repo's pinned runtime):
//
//   console.log("x".repeat(200_000)); process.exit(0);
//     > file   200 001 B    complete
//     pty      200 002 B    complete
//     | cat    131 072 B    TRUNCATED, exit 0
//
//   node dist/index.js project doctor --json --registry <1500-project registry>
//     > file   300 218 B    valid JSON
//     | cat    131 072 B    invalid JSON, exit 0
//     spawn    146 176 B    invalid JSON, exit 0
//
// On Linux `process.stdout` is synchronous for files and TTYs and ASYNCHRONOUS
// for pipes. `process.exit()` tears the process down without draining the queued
// writes, so exactly the capture mode automation uses -- a pipe or a `spawn` --
// silently loses the tail AND still exits 0. Silent corruption of a document
// whose whole contract is "one complete parseable envelope".
//
// The mitigation this repo had was a COMMENT ("it never calls process.exit()").
// A comment is not a guarantee: the next author adds an exit, nothing fails, and
// the corruption comes back. So the guarantee here is an AWAITED DRAIN, and it
// holds whether or not anyone later calls `process.exit`.
//
// Two functions, because there are two honest situations:
//
//   * `writeStdout` -- the caller is going to return normally and let the
//     process exit on its own. Awaiting the write is enough.
//   * `exitAfterFlush` -- the caller must force termination (open handles, a
//     nonzero status commander will not carry). Both streams are drained FIRST,
//     then `process.exit` runs. Forced termination is kept; the truncation is
//     removed.
//
// EPIPE is swallowed, on purpose and only for EPIPE. `pj audit --json | head -1`
// closes the pipe mid-write; with no handling that surfaces as an unhandled
// `write EPIPE` and a stack trace from a command that promises neither. Any
// OTHER stream error is a real failure and is rethrown -- swallowing everything
// would turn a full disk into a silent success.

/** Ceiling on how long `exitAfterFlush` waits for a stream to drain. */
const DRAIN_DEADLINE_MS = 30_000;

/** Streams already carrying the persistent guard, so a second call adds no listener. */
const guarded = new WeakSet<object>();

/** Errors that mean "the reader is gone", which is not this process's problem. */
function isBrokenPipe(error: NodeJS.ErrnoException | null | undefined): boolean {
  const code = error?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
}

/**
 * Install a PERSISTENT broken-pipe guard on stdout and stderr.
 *
 * `writeStdout` handles an EPIPE that arrives while it is waiting, and removes
 * its listener when it settles -- which leaves the window this function closes.
 * MEASURED 5/5 on a 3.7 MB report: `pj audit --json | head -c 10` printed
 * "Unhandled 'error' event ... write EPIPE" with a stack, because the reader
 * closed the pipe after the write callback had already fired. `process.exit()`
 * used to mask that by racing it; removing the exit exposed it.
 *
 * Idempotent, and only ever swallows EPIPE: any other stream error still throws,
 * because a full disk must not read as a successful write.
 *
 * `ignoreBrokenPipe` in `src/fleet/output.ts` does the same job for the fleet
 * namespace and is left alone; this one lives here so any command in the binary
 * can adopt it without importing the fleet envelope module.
 */
export function guardBrokenPipe(streams: readonly NodeJS.WritableStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    if (!stream || guarded.has(stream)) continue;
    guarded.add(stream);
    stream.on("error", (error: NodeJS.ErrnoException) => { if (!isBrokenPipe(error)) throw error; });
  }
}

/**
 * Write `text` and resolve only once the bytes have left this process.
 *
 * The write callback is what carries the guarantee: node invokes it when the
 * chunk has been handed to the OS, which for a pipe is after the kernel buffer
 * accepted it. `"drain"` is awaited as well when `write()` returns false --
 * belt and braces, and the pair is what makes the promise mean "flushed" rather
 * than "queued".
 */
export function writeStdout(text: string, stream: NodeJS.WritableStream = process.stdout): Promise<void> {
  if (text.length === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: NodeJS.ErrnoException | null): void => {
      if (settled) return;
      settled = true;
      stream.removeListener("error", onError);
      stream.removeListener("drain", onDrain);
      stream.removeListener("close", onClose);
      if (error && !isBrokenPipe(error)) reject(error);
      else resolve();
    };
    const onError = (error: NodeJS.ErrnoException): void => finish(error);
    const onDrain = (): void => finish();
    const onClose = (): void => finish();

    stream.on("error", onError);
    stream.on("close", onClose);

    let flushed = true;
    try {
      // The callback fires asynchronously in every node stream implementation,
      // so `flushed` is always assigned before it runs.
      flushed = stream.write(text, (error) => finish(error));
    } catch (error) {
      finish(error as NodeJS.ErrnoException);
      return;
    }
    if (!flushed) stream.on("drain", onDrain);
  });
}

/** Resolve once `stream` has nothing left queued, or once waiting stops being useful. */
function drain(stream: NodeJS.WritableStream & { writableLength?: number; writableEnded?: boolean; destroyed?: boolean }): Promise<void> {
  if (typeof stream?.write !== "function") return Promise.resolve();
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  if ((stream.writableLength ?? 0) === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      stream.removeListener("drain", done);
      stream.removeListener("error", done);
      stream.removeListener("close", done);
      resolve();
    };
    // A bound, not a hope. Without it a reader that never reads and never closes
    // would hang a command that has already produced its whole answer.
    const timer = setTimeout(done, DRAIN_DEADLINE_MS);
    stream.on("drain", done);
    stream.on("error", done);
    stream.on("close", done);
  });
}

/**
 * Drain stdout AND stderr, then terminate with `code`.
 *
 * stderr is included because a diagnostic that never reached the terminal is
 * indistinguishable from a command that said nothing about why it failed -- the
 * same defect, on the other stream.
 *
 * Declared `Promise<never>`: control does not return. The unreachable throw is
 * there so a caller that forgets to `await` still gets a type error rather than
 * a silent race between the exit and the next statement.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  await drain(process.stdout);
  await drain(process.stderr);
  process.exit(code);
  /* c8 ignore next */
  throw new Error("unreachable: process.exit did not terminate the process");
}
