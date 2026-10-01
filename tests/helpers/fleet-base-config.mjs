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
 *   - all four Bloodbank lifecycle hooks must call the canonical publisher,
 *     the hook-hub client `bb-hook --cli hermes --native <event>` (publish.py
 *     is a legacy forwarder);
 *   - memory.provider must be set, and "memory" must not be muzzled in
 *     agent.disabled_toolsets;
 *   - skills.external_dirs must be non-empty or no agent sees any skill;
 *   - platform_toolsets.bloodbank must list delegation, terminal, file and
 *     skills (`hermes.bloodbank-toolsets`), or a Bloodbank-dispatched PM turn
 *     resolves to no native tools and cannot delegate a worker;
 *   - providers.automaticai + delegation.provider + the mapped fleet token,
 *     and the main model, every auxiliary task (pinned to the gateway, or "auto"
 *     behind a gateway main with auxiliary.free_only: true and auxiliary.discovery:
 *     false) and
 *     every enabled MoA slot on the gateway (`hermes.gateway-routing`), or some
 *     inference path calls a provider directly;
 *   - an enabled wake word must not start a new session
 *     (`hermes.wake-word-session`), or a wake silently resets the model.
 */
export function fleetBaseConfig(homeDir) {
  const publisher = join(homeDir, ".agents", "hooks", "bb-hook");
  const hook = (name) => [
    { command: `${publisher} --cli hermes --native ${name}`, timeout: 5 },
  ];
  const gatewayModels = [
    "automaticai/personal/sol-6.1",
    "automaticai/personal/sol",
    "automaticai/personal/astra",
    "automaticai/personal/claude-opus-5.5",
    "automaticai/intelliforia/claude-opus-5.5",
    "automaticai/personal/claude-sonnet-5.5",
    "automaticai/intelliforia/claude-sonnet-5.5",
    "automaticai/personal/kimi-k3",
    "automaticai/personal/kimi-k3s",
    "automaticai/personal/kimi-2.8",
    "automaticai/personal/glm-5.3",
    "automaticai/personal/glm-5.3-flash",
  ];
  return {
    model: { provider: "automaticai", default: "automaticai/personal/kimi-2.8", base_url: "", api_mode: "chat_completions" },
    // The owner's design: only vision is pinned; every other helper is absent
    // ("auto") and follows the gateway main model, with both fall-through lanes
    // closed (free_only: no paid OpenRouter backup; discovery: false, the fork key
    // that stops a failed call walking direct-key discovery).
    auxiliary: {
      free_only: true,
      discovery: false,
      vision: { provider: "automaticai", model: "automaticai/personal/glm-5.3-flash" },
    },
    moa: { presets: { default: { enabled: false } } },
    wake_word: { enabled: false, start_new_session: false },
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
    platform_toolsets: {
      bloodbank: ["delegation", "skills", "todo", "session_search", "terminal", "file", "web"],
    },
    // Stock tool deadline is 420 s; a delegation blocks its PM for longer.
    timeouts: { tools: { concurrent_batch: 1800, sequential_call: 1800 } },
    // Delegated workers go through the AutomaticAI gateway (`hermes.gateway-routing`).
    providers: {
      automaticai: {
        name: "AutomaticAI",
        api: "https://api.automaticai.io/v1",
        key_env: "AUTOMATICAI_GATEWAY_KEY",
        default_model: "automaticai/personal/kimi-2.8",
        api_mode: "chat_completions",
        extra_body: { reasoning_effort: "high" },
        models: gatewayModels,
      },
    },
    delegation: { provider: "automaticai", model: "automaticai/personal/kimi-2.8", base_url: "", api_key: "", api_mode: "", reasoning_effort: "high" },
    secrets: { onepassword: { enabled: true, env: { AUTOMATICAI_GATEWAY_KEY: "op://vault/tokens/hermes-fleet-workers" } } },
  };
}

/** Write that config into `<fleetHome>/config.yaml`, creating the directory. */
export function writeFleetBaseConfig(fleetHome, homeDir) {
  mkdirSync(fleetHome, { recursive: true });
  const path = join(fleetHome, "config.yaml");
  writeFileSync(path, YAML.stringify(fleetBaseConfig(homeDir)), "utf8");
  return path;
}
