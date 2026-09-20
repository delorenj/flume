/**
 * Reading the host configuration at `~/.config/hermes-agent-template/config.toml`.
 *
 * In pjangler this existed twice -- once in `project/boardUrl.ts` and once in
 * `commands/hermes/EnsureTemplateConfig.ts` -- with a comment explaining that
 * the second could not import the first "without dragging the command layer
 * into the prompt bundle", and a drift tripwire in the test suite to catch them
 * disagreeing. Flume has no such bundling constraint, so there is one copy and
 * the tripwire is unnecessary.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the host configuration lives, honouring HERMES_TEMPLATE_CONFIG and XDG. */
export function resolveTemplateConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fromEnv = env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join(home, ".config");
  return join(base, "hermes-agent-template", "config.toml");
}

/**
 * Read `key` from `[section]` of a small TOML file.
 *
 * Scoped to exactly what is needed -- a handful of string scalars out of a
 * generated config. Not a TOML parser, and deliberately not pretending to be
 * one: anything it cannot confidently read comes back undefined and the caller
 * falls through to a default.
 */
export function readTomlScalar(text: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inSection = line === `[${section}]`;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    const value = line.slice(eq + 1).trim();
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(value);
    if (quoted) return quoted[1] ?? quoted[2];
    const bare = (value.split("#")[0] ?? "").trim();
    return bare || undefined;
  }
  return undefined;
}

/** Read the host config file, or undefined when it is absent or unreadable. */
export function readTemplateConfig(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  try {
    const path = resolveTemplateConfigPath(env, home);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}
