/**
 * Path helpers Flume needs that used to live in pjangler's project module.
 *
 * Deliberately copied rather than imported. Flume and pjangler never import or
 * exec each other -- files on disk are the only ABI between them. These are
 * forty lines of pure, well-tested predicates; a package dependency across a
 * submodule boundary would cost more than the duplication does.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Validate caller-controlled names that become one filesystem path segment.
 * Keep this capability open-ended (titles are not an enum), while excluding
 * every spelling that can change the directory reached by a later join().
 */
export function validateSafePathSegment(value: string, label: string): string {
  const normalized = value.trim();
  const unsafe =
    !normalized ||
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    !SAFE_PATH_SEGMENT.test(normalized);
  if (unsafe) {
    throw new Error(
      `${label} must be a non-empty safe single path segment using letters, numbers, dots, underscores, or hyphens (no dot segments, absolute paths, separators, or traversal)`,
    );
  }
  return normalized;
}

function prospectiveRealPath(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

/** Resolve a prospective child and reject lexical or symlink-assisted escape. */
export function resolveContainedPath(parentDir: string, candidate: string, label: string): string {
  const physicalParent = prospectiveRealPath(parentDir);
  const physicalCandidate = prospectiveRealPath(candidate);
  const fromParent = relative(physicalParent, physicalCandidate);
  if (!fromParent || fromParent === ".." || fromParent.startsWith(`..${sep}`) || isAbsolute(fromParent)) {
    throw new Error(`${label} must remain contained beneath parent directory ${resolve(parentDir)}`);
  }
  return resolve(candidate);
}

/** A job title is one path segment; `pm` is the default and, today, the only one. */
export function normalizeAgentRole(value?: string): string {
  return value === undefined ? "pm" : validateSafePathSegment(value, "Agent title");
}

/** The fleet dotenv the ticket-provider adapters read, honouring HERMES_FLEET_ENV. */
export function ticketProviderFleetEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERMES_FLEET_ENV?.trim() || join(env.HOME || homedir(), ".hermes", "fleet.env");
}

/**
 * Locate Flume's own install root.
 *
 * The pjangler original anchored on `templates/commonproject/copier.yml`.
 * Flume anchors on the job descriptions it renders from instead, so a stray
 * pjangler checkout above us can never be mistaken for our root.
 */
export function resolveFlumeRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "templates", "hermes-agent", "copier.yml"))) return dir;
    dir = dirname(dir);
  }
  return resolve(process.cwd());
}

/**
 * Read `KEY=value` assignments out of a dotenv-shaped file.
 *
 * It does NOT expand `$VAR`. `HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/...`
 * comes back unexpanded, and a caller must report it that way rather than
 * inventing the expansion this reader deliberately does not perform.
 */
export function readShellAssignments(path: string, keys: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  if (!existsSync(path)) return found;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return found;
  }
  const wanted = new Set(keys);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (!wanted.has(key) || found[key] !== undefined) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.split(/\s+#/)[0]!.trim();
    }
    if (value) found[key] = value;
  }
  return found;
}
