/**
 * A held, kernel-scoped advisory lock on `<file>.lock`, portable to hosts without `flock(1)`.
 *
 * Linux keeps doing exactly what flume always did: `flock -w 30 <lock> sh -c 'printf "locked\n";
 * read release'`, a child that holds flock(2) on the lock file until its stdin closes. macOS ships
 * no flock(1), so there the same child is a few lines of python3 calling `fcntl.flock` -- the SAME
 * flock(2) lock on the same file. Both shapes interoperate with every other writer on the host:
 * the template's `flock -w` in _lib.sh / fleet-sync.sh, channel-state.py's `fcntl.flock`, and each
 * other. Neither leaves a stale logical lock: the kernel drops it when the holder exits, and the
 * holder exits when its parent closes stdin or dies.
 */

import { spawn } from "node:child_process";
import { onPath } from "./host-platform";

export type FileLockHelper = "flock" | "python3";

/** Seconds a writer waits for a held lock before giving up, as `flock -w 30` always has. */
export const LOCK_WAIT_SECONDS = 30;

/**
 * The python3 twin of `flock -w <seconds> <lock> sh -c 'printf "locked\n"; read release'`.
 *
 * Same open flags as util-linux flock(1) (read-only, create 0666, no controlling tty) plus
 * O_NOFOLLOW; same exit status (1) on a timeout; same "locked" handshake on stdout; released when
 * stdin reaches a newline or EOF.
 */
export const PYTHON_FLOCK_HELPER = String.raw`
import errno, fcntl, os, sys, time
path, wait = sys.argv[1], float(sys.argv[2])
flags = os.O_RDONLY | os.O_CREAT | getattr(os, "O_NOCTTY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
try:
    fd = os.open(path, flags, 0o666)
except OSError as error:
    sys.stderr.write("flume-lock: cannot open %s: %s\n" % (path, error.strerror))
    sys.exit(1)
deadline = time.monotonic() + wait
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except OSError as error:
        if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EACCES, errno.EINTR):
            sys.stderr.write("flume-lock: %s: %s\n" % (path, error.strerror))
            sys.exit(1)
        if time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(0.05)
sys.stdout.write("locked\n")
sys.stdout.flush()
sys.stdin.readline()
`;

/** `flock(1)` when it is on PATH (every Linux host), else the python3 helper. `FLUME_LOCK_HELPER` forces one. */
export function resolveLockHelper(env: NodeJS.ProcessEnv = process.env): FileLockHelper {
  const forced = env.FLUME_LOCK_HELPER?.trim();
  if (forced === "flock" || forced === "python3") return forced;
  return onPath("flock", env) ? "flock" : "python3";
}

/** The argv that holds `lock` for as long as the child's stdin stays open. */
export function lockHelperArgv(helper: FileLockHelper, lock: string, waitSeconds: number = LOCK_WAIT_SECONDS): [string, string[]] {
  if (helper === "flock") return ["flock", ["-w", String(waitSeconds), lock, "sh", "-c", 'printf "locked\\n"; read release']];
  return ["python3", ["-I", "-c", PYTHON_FLOCK_HELPER, lock, String(waitSeconds)]];
}

export interface FileLockOptions {
  helper?: FileLockHelper;
  waitSeconds?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run `action` while holding an exclusive flock(2) on `lock`. Not re-entrant: never nest one lock file. */
export async function withFileLock<T>(lock: string, action: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const env = options.env ?? process.env;
  const helper = options.helper ?? resolveLockHelper(env);
  const [command, args] = lockHelperArgv(helper, lock, options.waitSeconds ?? LOCK_WAIT_SECONDS);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
  // Registered up front: a holder that dies mid-action has already closed by the time `finally` runs.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stdin.on("error", () => { /* a holder that already exited cannot be told to release */ });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT"
      ? new Error(`Registry lock unavailable: ${command} is not on PATH (flume holds ${lock} with flock(1) where it exists, else python3's fcntl.flock)`)
      : error));
    child.once("exit", (code) => reject(new Error(`Registry lock unavailable (exit ${code})`)));
  });
  try { return await action(); } finally {
    child.stdin.end("\n");
    await closed;
  }
}
