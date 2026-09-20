import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/**
 * The smallest `~/.hermes/config.yaml` that satisfies the `hermes.fleet-config`
 * parity rule.
 *
 * That rule is deliberately `fixable: false` — the fleet base carries values
 * whose correct setting is an operator decision, and pjangler will not guess
 * them. Nothing in provisioning writes this file, so a sandboxed HOME has no
 * fleet base at all and every end-to-end test that provisions an agent fails
 * its postcondition audit on a fleet the test never claimed to configure.
 * Seeding it is the test's job, exactly as it already seeds fleet.env and
 * agents-registry.yaml.
 *
 * Each key here maps to one invariant the rule enforces, and each of those
 * exists because a real fleet lost the capability silently:
 *   - tts.provider must be the registry key "vox", not the service name;
 *   - all four Bloodbank lifecycle hooks must call the canonical publisher;
 *   - memory.provider must be set, and "memory" must not be muzzled in
 *     agent.disabled_toolsets;
 *   - skills.external_dirs must be non-empty or no agent sees any skill.
 */
export function fleetBaseConfig(homeDir) {
  const publisher = join(homeDir, ".agents", "hooks", "bloodbank", "publish.py");
  const hook = (name) => [
    { command: `python3 ${publisher} --client hermes --hook ${name}`, timeout: 5 },
  ];
  return {
    tts: { provider: "vox", vox: { voice: "carlin" } },
    hooks: {
      on_session_start: hook("on_session_start"),
      on_session_end: hook("on_session_end"),
      pre_tool_call: hook("pre_tool_call"),
      post_tool_call: hook("post_tool_call"),
    },
    memory: { provider: "hindsight" },
    agent: { disabled_toolsets: [] },
    skills: { external_dirs: [join(homeDir, ".agents", "skills")] },
  };
}

/** Write that config into `<fleetHome>/config.yaml`, creating the directory. */
export function writeFleetBaseConfig(fleetHome, homeDir) {
  mkdirSync(fleetHome, { recursive: true });
  const path = join(fleetHome, "config.yaml");
  writeFileSync(path, YAML.stringify(fleetBaseConfig(homeDir)), "utf8");
  return path;
}
