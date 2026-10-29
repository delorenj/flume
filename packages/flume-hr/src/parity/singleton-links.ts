// The profile -> runtime link contract, in one place.
//
// A Hermes desk (~/.hermes/profiles/<agent>) links its per-agent state into the
// repo-local, git-ignored runtime dir <role>/runtime/. Two readers need the same
// answer to "is this link good?": the `hermes.runtime-singleton` rule (audit and
// migrate, `parity/rules.ts`) and the profile observer behind `flume review`
// (`org/profile.ts`). They used to keep parallel copies of the entry lists and
// BOTH treated a link that points at the right place as healthy whether or not
// the place existed. That is the re-hire bug: Hermes (hermes_cli/config_home.py)
// refuses to create the target of a link ("Directory link is unavailable ...
// Hermes has not replaced the link or created its missing target"), so a correct
// link into a fresh runtime dir stops the profile from initializing, on every
// gateway start, while the audit says "verified".
//
// This module is fs-only on purpose: the observer must not import the recipe
// world (rules.ts), and neither reader may grow a second implementation of the
// judgement below.

import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs";

// Person-owned. SOUL.md is load-bearing: Hermes reads it from HERMES_HOME and
// seeds the stock "You are Hermes Agent, created by Nous Research" default into
// any fresh profile dir, which would silently shadow each agent's real identity.
export const OWNED_PROFILE_ENTRIES = [
  "memories",
  "sessions",
  "workspace",
  "logs",
  "cron",
  "plans",
  "hooks",
  "pairing",
  "audio_cache",
  "image_cache",
] as const;

export const OWNED_PROFILE_FILES = ["SOUL.md", "state.db", "kanban.db"] as const;

/**
 * Owned files whose target MUST exist for the link to be healthy.
 *
 * SOUL.md is the desk's identity: a link to a missing one means the desk has no
 * soul, and Hermes would seed the stock default over it. state.db and kanban.db
 * are deliberately absent: sqlite creates them on first open THROUGH the link,
 * so a dangling one is a desk that has not run yet, not a defect.
 */
const REQUIRED_PROFILE_FILES: ReadonlySet<string> = new Set(["SOUL.md"]);

/**
 * Creation mode for an owned directory flume has to materialize, by entry name.
 *
 * Everything else takes the process default (umask), like the runtime scaffold.
 * `pairing` holds the approved-user whitelist and pending pairing codes, so it
 * is owner-only; that is also the mode nearly every live desk's runtime/pairing already carries.
 */
const OWNED_DIR_MODES: Readonly<Record<string, number>> = { pairing: 0o700 };

export function isOwnedDirEntry(name: string): boolean {
  return (OWNED_PROFILE_ENTRIES as readonly string[]).includes(name);
}

/** Must the thing this owned entry's link points at exist for the link to be healthy? */
export function targetMustExist(name: string): boolean {
  return isOwnedDirEntry(name) || REQUIRED_PROFILE_FILES.has(name);
}

/** The mode flume creates an owned directory with, or undefined for the default. */
export function ownedDirMode(name: string): number | undefined {
  return OWNED_DIR_MODES[name];
}

export type LinkState = "ok" | "missing" | "not-a-symlink" | "wrong-target";

/** Where does `path` stand relative to the link it should be? Never follows the link. */
export function linkState(path: string, target: string): LinkState {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }
  if (!stat.isSymbolicLink()) return "not-a-symlink";
  try {
    return readlinkSync(path) === target ? "ok" : "wrong-target";
  } catch {
    return "wrong-target";
  }
}

/** A symlink whose target does not exist. False for anything that is not a symlink. */
export function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
}

/**
 * The re-hire defect: `path` is a symlink for an owned entry that must have a
 * live target, and the target is not usable -- absent (the link dangles), or the
 * wrong kind (an owned directory's link landing on a file, SOUL.md's on a
 * directory). Hermes reports a non-directory exactly like a missing one
 * ("Directory link is unavailable") and creates neither, and migrate refuses to
 * replace either, so the audit must not call them healthy.
 *
 * Independent of WHERE the link points, so the observer (which judges ownership
 * by containment) and the rule (which judges by exact target) share it. Stats
 * the target through the link; never reads or writes through it.
 */
export function lacksRequiredTarget(name: string, path: string): boolean {
  if (!targetMustExist(name)) return false;
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let target;
  try {
    target = statSync(path);
  } catch {
    // Dangling, a loop, or not traversable: Hermes cannot use it either.
    return true;
  }
  return isOwnedDirEntry(name) ? !target.isDirectory() : !target.isFile();
}
