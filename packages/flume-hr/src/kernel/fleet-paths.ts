/**
 * Where the fleet lives on this host, resolved ONE way.
 *
 * `workforce/role.ts` has always honoured `HERMES_AGENTS_REGISTRY`, then the shell provisioner's
 * `HERMES_FLEET_REGISTRY_FILE`, then `$HERMES_FLEET_HOME/agents-registry.yaml`, then
 * `~/.hermes/agents-registry.yaml`. Other readers hardcoded the last one, so a host with a different
 * layout (a migrated Mac, a scratch fleet) was written by one module and read from elsewhere by the
 * next. Every reader that only needs the path asks these two functions.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** `$HERMES_FLEET_HOME`, else `<home>/.hermes`. Blank counts as unset. */
export function resolveFleetHomeDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.HERMES_FLEET_HOME?.trim() || join(home, ".hermes");
}

/** The agent registry (org chart) path: the same precedence `workforce/role.ts` projects through. */
export function resolveAgentRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fleetHome: string = resolveFleetHomeDir(env, home),
): string {
  return env.HERMES_AGENTS_REGISTRY?.trim() || env.HERMES_FLEET_REGISTRY_FILE?.trim() || join(fleetHome, "agents-registry.yaml");
}
