// Regression guard for the Hermes profile base+delta contract.
//
// Two audits used to disagree with reality in ways that failed SILENTLY, and
// both are cheap to re-break:
//
//   1. hermes.runtime-singleton once REQUIRED profiles/<p>/config.yaml to be a
//      symlink to the fleet base. That symlink detaches on the first in-agent
//      write (Hermes' atomic_yaml_write uses os.replace, which swaps a symlink
//      for a regular file), freezing the profile on a stale base forever — and
//      it left the profile unable to override anything. config.yaml is now a
//      GENERATED artifact and the symlink is a FAILURE, not the contract.
//
//   2. Fleet-base defects hit every agent at once and never surface as errors:
//      tts.provider "voxxy" (the service name; the registry key is "vox") falls
//      back to a built-in voice; a missing hooks: block silences Bloodbank
//      lifecycle events fleet-wide; "memory" in agent.disabled_toolsets muzzles
//      memory tools while auto recall/retain keeps running and masks it.
//
// These assert the audit REPORTS those states — a rule that only ever passes
// is indistinguishable from a rule that does nothing.
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const tmpRoots = [];

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// Minimal repo carrying one Hermes PM role — enough for discoverRoles().
function makeRepo() {
  const repo = tmp("pjangler-inherit-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  const roleDir = join(repo, "agents", "hermes", "pm");
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), "repo: demo\nrole: pm\nagent_id: demo-pm\nprofile: demo-pm\n");
  writeFileSync(join(repo, "AGENTS.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return { repo, roleDir };
}

// The home these fixtures pretend the fleet base config was written against.
// It is DERIVED rather than written as a literal: a `/home/<name>` (or
// `/Users/<name>`) literal anywhere in a release regression is rejected by
// tests/portable-test-paths-regressions.mjs, which cannot tell a synthetic
// placeholder from a leaked developer path -- and rightly so, since neither is
// portable off this machine.
const FLEET_HOME = mkdtempSync(join(tmpdir(), "hermes-fleet-home-"));
// The canonical publisher is the hook-hub client (bloodbank agent-hooks
// hooks.master.json: hermes publisher "bb-hook"); publish.py is legacy.
const hookCommand = (hook) =>
  `${join(FLEET_HOME, ".agents", "hooks", "bb-hook")} --cli hermes --native ${hook}`;
const legacyHookCommand = (hook) =>
  `python3 ${join(FLEET_HOME, ".agents", "hooks", "bloodbank", "publish.py")} --client hermes --hook ${hook}`;
const GATEWAY_MODELS = [
  "automaticai/personal/sol-6.1",
  "automaticai/personal/sol",
  "automaticai/personal/astra",
  "automaticai/personal/claude-opus-5.5",
  "automaticai/intelliforia/claude-opus-5.5",
  "automaticai/personal/kimi-k3",
  "automaticai/personal/kimi-k3s",
  "automaticai/personal/kimi-2.8",
  "automaticai/personal/glm-5.3",
  "automaticai/personal/glm-5.3-flash",
];

// Every auxiliary task Hermes routes through call_llm; an absent one is "auto".
// session_search and flush_memories are not auxiliary tasks in the fork.
const AUX_TASKS = [
  "vision", "web_extract", "compression", "skills_hub", "approval", "mcp", "title_generation",
  "memory_query_rewrite", "tts_audio_tags", "triage_specifier", "kanban_decomposer", "profile_describer",
  "goal_judge", "curator", "monitor", "background_review", "moa_reference", "moa_aggregator", "kanban_estimator",
];
const GATEWAY_AUX = Object.fromEntries(AUX_TASKS.map((task) => [task, { provider: "automaticai", model: "automaticai/personal/glm-5.3-flash", timeout: 30 }]));

const BASE_CONFIG = {
  // The main agent calls the gateway (`hermes.gateway-routing`: all inference).
  model: { provider: "automaticai", default: "automaticai/personal/kimi-2.8", base_url: "", api_mode: "chat_completions" },
  auxiliary: { free_only: true, ...GATEWAY_AUX },
  moa: {
    default_preset: "default",
    presets: {
      default: {
        reference_models: [
          { provider: "automaticai", model: "automaticai/personal/sol" },
          { provider: "custom:automaticai", model: "automaticai/personal/glm-5.3" },
        ],
        aggregator: { provider: "automaticai", model: "automaticai/personal/claude-opus-5.5" },
      },
    },
  },
  // Enabled, and pinned to the current session (`hermes.wake-word-session`).
  wake_word: { enabled: true, start_new_session: false },
  tts: { provider: "vox", vox: { voice: "carlin" } },
  hooks: {
    on_session_start: [{ command: hookCommand("on_session_start"), timeout: 5 }],
    on_session_end: [{ command: hookCommand("on_session_end"), timeout: 5 }],
    pre_tool_call: [{ command: hookCommand("pre_tool_call"), timeout: 5 }],
    post_tool_call: [{ command: hookCommand("post_tool_call"), timeout: 5 }],
  },
  memory: { provider: "hindsight" },
  agent: { disabled_toolsets: [] },
  skills: { external_dirs: [join(FLEET_HOME, ".agents", "skills")] },
  // Three entries so a delta can drop some without dropping all of them.
  plugins: { enabled: ["tts/vox", "telegram-platform", "openai-codex"] },
  // An OBJECT-valued list, the shape real deltas carry for providers.
  fallback_providers: [{ model: "automaticai/personal/kimi-2.8", provider: "automaticai" }],
  // What a Bloodbank-dispatched PM turn gets. Without it Hermes resolves the
  // platform to a nonexistent "hermes-bloodbank" toolset (MCP tools only).
  platform_toolsets: {
    bloodbank: ["delegation", "skills", "todo", "session_search", "terminal", "file", "web"],
  },
  // Hermes bounds every tool call (stock 420 s). A PM blocks in delegate_task until
  // its worker returns, so the stock bound cuts a real delegation short.
  timeouts: { tools: { concurrent_batch: 1800, sequential_call: 1800 } },
  // Delegated workers go through the AutomaticAI gateway via a NAMED provider whose
  // key_env Hermes resolves through the per-turn, per-profile secret scope.
  providers: {
    automaticai: {
      name: "AutomaticAI",
      api: "https://api.automaticai.io/v1",
      key_env: "AUTOMATICAI_GATEWAY_KEY",
      default_model: "automaticai/personal/kimi-2.8",
      api_mode: "chat_completions",
      extra_body: { reasoning_effort: "high" },
      models: GATEWAY_MODELS,
    },
  },
  delegation: { provider: "automaticai", model: "automaticai/personal/kimi-2.8", base_url: "", api_key: "", api_mode: "", reasoning_effort: "high" },
  secrets: { onepassword: { enabled: true, env: { AUTOMATICAI_GATEWAY_KEY: "op://vault/tokens/hermes-fleet-workers" } } },
};

function yamlDump(obj) {
  // Deliberately tiny: only what these fixtures need, so the test has no
  // dependency on the YAML lib's formatting.
  return JSON.stringify(obj, null, 2);
}

// Build a fleet home. `overrides` mutates the base config; `profileMode`
// selects the profile-side topology under test.
function makeFleet({ overrides = {}, profileMode = "rendered", profile = "demo-pm", delta = {}, linkProfile = false, env = "" } = {}) {
  const fleet = tmp("pjangler-inherit-fleet-");
  const cfg = { ...BASE_CONFIG, ...overrides };
  writeFileSync(join(fleet, "config.yaml"), yamlDump(cfg));
  writeFileSync(join(fleet, ".env"), env, { mode: 0o600 });
  mkdirSync(join(fleet, "skills"), { recursive: true });
  const pdir = join(fleet, "profiles", profile);
  // The legacy topology: profiles/<name> is a SYMLINK to a repo-local runtime
  // dir rather than a real directory. readdirSync(withFileTypes) reports such an
  // entry as a symlink, not a directory, so any rule that filters on
  // isDirectory() alone skips the profile entirely and reports nothing.
  if (linkProfile) {
    const real = tmp("pjangler-inherit-runtime-");
    mkdirSync(join(fleet, "profiles"), { recursive: true });
    symlinkSync(real, pdir);
  } else {
    mkdirSync(pdir, { recursive: true });
  }
  symlinkSync(join(fleet, ".env"), join(pdir, ".env"));
  symlinkSync(join(fleet, "skills"), join(pdir, "skills"));

  if (profileMode === "symlinked") {
    // The retired topology.
    symlinkSync(join(fleet, "config.yaml"), join(pdir, "config.yaml"));
  } else if (profileMode === "forked") {
    // A hand-forked copy: real file, but no generated header.
    writeFileSync(join(pdir, "config.yaml"), yamlDump(cfg));
    writeFileSync(join(pdir, "config.delta.yaml"), "{}\n");
  } else {
    writeFileSync(
      join(pdir, "config.yaml"),
      `# GENERATED FILE -- DO NOT EDIT.\n# source of truth : config.delta.yaml\n${yamlDump(cfg)}`,
    );
    writeFileSync(join(pdir, "config.delta.yaml"), yamlDump(delta));
    mkdirSync(join(pdir, "hindsight"), { recursive: true });
    writeFileSync(join(pdir, "hindsight", "config.json"), JSON.stringify({ bank_id: `agent-${profile}` }, null, 2));
  }
  return fleet;
}

// A registry in the fleet home, and extra rendered desks to match it. The
// bloodbank-toolsets rule reads both from the fleet home, so a fixture never
// touches the real ~/.hermes.
function writeRegistry(fleet, agents) {
  writeFileSync(join(fleet, "agents-registry.yaml"), yamlDump({ agents }));
}

function addProfile(fleet, name, cfg) {
  const pdir = join(fleet, "profiles", name);
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "config.yaml"), `# GENERATED FILE -- DO NOT EDIT.\n${yamlDump(cfg)}`);
  writeFileSync(join(pdir, "config.delta.yaml"), "{}\n");
}

// A desk rendered before the list existed: the generated config has no bloodbank key.
const NO_BLOODBANK = { ...BASE_CONFIG, platform_toolsets: undefined };
const withBloodbank = (list) => ({ ...BASE_CONFIG, platform_toolsets: { bloodbank: list } });
const PM_LIST = ["delegation", "skills", "todo", "session_search", "terminal", "file", "web"];

function audit(repo, fleet) {
  const r = spawnSync("node", [cli, "audit"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HERMES_FLEET_HOME: fleet },
  });
  // Audit exits non-zero when findings exist; stdout is the payload either way.
  return (r.stdout || "") + (r.stderr || "");
}

const { repo } = makeRepo();

// 1. A symlinked config.yaml is a FAILURE, not the contract.
{
  const out = audit(repo, makeFleet({ profileMode: "symlinked" }));
  assert.match(out, /config\.yaml is a symlink/, "symlinked profile config must be reported");
  assert.match(out, /config\.delta\.yaml missing/, "missing delta must be reported");
  assert.match(out, /identity-memory bank not pinned/, "unpinned identity bank must be reported");
}

// 2. A hand-forked real config (no generated header) must not pass as rendered.
{
  const out = audit(repo, makeFleet({ profileMode: "forked" }));
  assert.match(out, /not a rendered artifact/, "hand-forked config must be distinguished from a rendered one");
}

// 3. A correctly rendered profile satisfies the per-profile contract.
{
  const out = audit(repo, makeFleet({ profileMode: "rendered" }));
  assert.doesNotMatch(out, /config\.yaml is a symlink/, "rendered profile must not be flagged as symlinked");
  assert.doesNotMatch(out, /config\.delta\.yaml missing/, "rendered profile has a delta");
  assert.doesNotMatch(out, /identity-memory bank not pinned/, "rendered profile pins its bank");
}

// 4. Fleet-base defects are each reported, with the reason they stay silent.
{
  const out = audit(repo, makeFleet({ overrides: { tts: { provider: "voxxy" } } }));
  assert.match(out, /tts\.provider is "voxxy"/, "voxxy must be rejected in favor of the vox registry key");
}
{
  // null, not a delete: makeFleet spreads BASE_CONFIG first, so an absent key in
  // `overrides` cannot remove one. A null hooks: block is also the shape a
  // half-written config actually takes on disk.
  const out = audit(repo, makeFleet({ overrides: { hooks: null } }));
  assert.match(out, /no hooks: block in the fleet base/, "a missing hooks block must be reported");
}
{
  const out = audit(repo, makeFleet({ overrides: { agent: { disabled_toolsets: ["memory"] } } }));
  assert.match(out, /disabled_toolsets contains "memory"/, "a muzzled memory toolset must be reported");
}
{
  const out = audit(repo, makeFleet({ overrides: { skills: { external_dirs: [] } } }));
  assert.doesNotMatch(out, /skills\.external_dirs is empty/, "a real named profile overlay needs no external skills root");
}

// 5. A healthy fleet base reports none of the above — guards against a rule
//    that "passes" by matching everything.
{
  const out = audit(repo, makeFleet({ overrides: { fallback_providers: [{ provider: "openai-codex", model: "gpt-5.6-sol" }] } }));
  assert.match(out, /fallback_providers entry openai-codex\/gpt-5\.6-sol leaves AutomaticAI: a failed route must preserve its account and fail rather than switch providers/,
    "a direct fallback chain must be reported as a gateway bypass");
}
{
  const out = audit(repo, makeFleet({}));
  for (const pattern of [/tts\.provider is/, /no hooks: block/, /disabled_toolsets contains/, /external_dirs is empty/]) {
    assert.doesNotMatch(out, pattern, `healthy fleet base must not trip ${pattern}`);
  }
}

// 6. A delta list REPLACES the base list -- YAML deep-merge has no union
//    semantics for arrays. Observed on a real profile whose delta carried one
//    plugin the base already had, silently dropping the other sixteen.
{
  const out = audit(repo, makeFleet({ delta: { plugins: { enabled: ["tts/vox"] } } }));
  assert.match(out, /plugins\.enabled drops 2 fleet entries/, "a delta that replaces a base list must be reported");
  assert.match(out, /telegram-platform/, "the report must name what was lost, not just the count");
  assert.match(out, /removing "plugins\.enabled" from the delta restores inheritance/,
    "a delta that adds nothing is pure redundancy and the remedy must say so");
}

// 7. A delta that keeps every base entry and adds its own takes nothing away.
//    Without this the rule could 'pass' by flagging any delta that mentions a list.
{
  const out = audit(repo, makeFleet({
    delta: { plugins: { enabled: ["tts/vox", "telegram-platform", "openai-codex", "extra-plugin"] } },
  }));
  assert.doesNotMatch(out, /plugins\.enabled drops/, "a superset delta loses nothing and must not be reported");
}

// 8. A delta that drops some entries AND adds others states a real intent, so
//    the remedy must not tell the operator to delete their own addition.
{
  const out = audit(repo, makeFleet({
    delta: { plugins: { enabled: ["tts/vox", "extra-plugin"] } },
  }));
  assert.match(out, /plugins\.enabled drops 2 fleet entries/, "dropped entries are still reported when the delta adds");
  assert.match(out, /delta also adds extra-plugin/, "the remedy must acknowledge the delta's own additions");
  assert.doesNotMatch(out, /restores inheritance/, "a delta with additions must not be told to just delete the key");
}

// 9. A key the base never had cannot take anything away from it.
{
  const out = audit(repo, makeFleet({ delta: { mcp_servers: { allow: ["local-only"] } } }));
  assert.doesNotMatch(out, /drops \d+ fleet entr/, "a delta-only key overrides nothing");
}

// 10. An empty delta is the healthy case.
{
  const out = audit(repo, makeFleet({}));
  assert.doesNotMatch(out, /drops \d+ fleet entr/, "an empty delta must not trip the rule");
}

// 11. A SYMLINKED profile directory must still be scanned. withFileTypes uses
//     lstat semantics, so filtering on isDirectory() alone silently skipped
//     three real legacy profiles -- each carrying the very defect this rule
//     exists to find, and reporting a confident clean result over them.
{
  const out = audit(repo, makeFleet({
    linkProfile: true,
    delta: { plugins: { enabled: ["tts/vox"] } },
  }));
  assert.match(out, /plugins\.enabled drops 2 fleet entries/,
    "a symlinked profile dir must still be scanned for list overrides");
}

// 12. An object-valued entry re-listed with its keys in a DIFFERENT order is
//     the same entry. Comparing raw JSON.stringify would call it dropped and
//     tell the operator to restore something their delta already carries --
//     a false positive in exactly the place the rule is most likely believed.
{
  const out = audit(repo, makeFleet({
    delta: { fallback_providers: [{ provider: "automaticai", model: "automaticai/personal/kimi-2.8" }] },
  }));
  assert.doesNotMatch(out, /fallback_providers drops/,
    "entry identity must ignore object key order");
}

// 13. ...but a genuinely different provider IS a drop, so 12 cannot pass by
//     making the rule blind to object-valued lists altogether.
{
  const out = audit(repo, makeFleet({
    delta: { fallback_providers: [{ provider: "kimi-coding", model: "k3" }] },
  }));
  assert.match(out, /fallback_providers drops 1 fleet entry/,
    "a genuinely replaced object entry must still be reported");
}

// 14. Bloodbank-dispatched turns. The plugin registers no toolset and PM desks
//     do not enable it, so with no platform_toolsets.bloodbank list Hermes falls
//     back to a nonexistent "hermes-bloodbank" toolset: MCP tools only, nothing
//     errors, and no PM can delegate a worker. FLUME-25 found it; FLUME-26.
{
  const out = audit(repo, makeFleet({ overrides: { platform_toolsets: null } }));
  assert.match(out, /no platform_toolsets\.bloodbank list/, "a base with no bloodbank toolset list must be reported");
  assert.match(out, /hermes-bloodbank/, "the report must name the nonexistent fallback so the reader knows why it is silent");
}
{
  const out = audit(repo, makeFleet({ overrides: { platform_toolsets: { bloodbank: ["todo", "web"] } } }));
  assert.match(out, /platform_toolsets\.bloodbank is missing delegation, terminal, file, skills/,
    "a list without the delegating toolsets must name exactly what is missing");
}
{
  const out = audit(repo, makeFleet({}));
  assert.doesNotMatch(out, /platform_toolsets\.bloodbank/, "a healthy base must not trip the bloodbank toolset rule");
}

// 15. Per-employee. The base can be right while a desk was never re-rendered:
//     a routable PM whose GENERATED config lacks the list is just as unable to
//     delegate, and only a per-desk check can see it.
const routable = (role, extra = {}) => ({ role, profile_name: undefined, bloodbank: { enabled: true, ...extra } });
{
  const fleet = makeFleet({});
  addProfile(fleet, "stale-pm", NO_BLOODBANK); // rendered before the list existed
  writeRegistry(fleet, { "stale-pm": { ...routable("pm"), profile_name: "stale-pm" } });
  const out = audit(repo, fleet);
  assert.match(out, /stale-pm: no platform_toolsets\.bloodbank in its generated config/,
    "a routable PM that was never re-rendered must be reported by name");
  assert.match(out, /render --profile stale-pm/, "the report must give the exact re-render command");
}
{
  const fleet = makeFleet({});
  addProfile(fleet, "fresh-pm", withBloodbank(PM_LIST));
  writeRegistry(fleet, { "fresh-pm": { ...routable("pm"), profile_name: "fresh-pm" } });
  assert.doesNotMatch(audit(repo, fleet), /fresh-pm:/, "a routable PM carrying the list must not be reported");
}
{
  // `enabled` absent means enabled (the gateway's own gate), so it is routable.
  const fleet = makeFleet({});
  addProfile(fleet, "implicit-pm", NO_BLOODBANK);
  writeRegistry(fleet, { "implicit-pm": { role: "pm", profile_name: "implicit-pm", bloodbank: { gateway_scope: "fleet" } } });
  assert.match(audit(repo, fleet), /implicit-pm: no platform_toolsets\.bloodbank/,
    "a bloodbank block with no enabled key is routable and must be checked");
}
{
  // Routing switched off: the PM is not reachable over Bloodbank, so the list is moot.
  const fleet = makeFleet({});
  addProfile(fleet, "off-pm", NO_BLOODBANK);
  writeRegistry(fleet, { "off-pm": { role: "pm", profile_name: "off-pm", bloodbank: { enabled: false } } });
  assert.doesNotMatch(audit(repo, fleet), /off-pm:/, "a PM with routing disabled must not be reported");
}

// 16. Least privilege. A routable employee that is NOT a delegating PM has never
//     had terminal, file or delegation on an unattended turn, and rendering the
//     base must not quietly hand them over.
{
  const fleet = makeFleet({});
  addProfile(fleet, "widened", withBloodbank(PM_LIST));
  writeRegistry(fleet, { widened: { ...routable("reporter"), profile_name: "widened" } });
  const out = audit(repo, fleet);
  assert.match(out, /widened \(role reporter\) is not a delegating PM but its Bloodbank turns can use delegation, terminal, file/,
    "a restricted employee that gained the power trio must be reported");
}
{
  const fleet = makeFleet({});
  addProfile(fleet, "pinned", withBloodbank([]));
  writeRegistry(fleet, { pinned: { ...routable("director"), profile_name: "pinned" } });
  assert.doesNotMatch(audit(repo, fleet), /pinned \(role/, "a restricted employee pinned to no toolsets must not be reported");
}

// 17. The tool deadline. A PM blocks inside delegate_task until its worker
//     returns, and Hermes cuts any tool call at 420 s by default. FLUME-25's real
//     worker outlasted it: the call errored, the worker kept running detached, and
//     the PM -- seeing it alive -- claimed the ticket and ended its turn.
{
  const out = audit(repo, makeFleet({ overrides: { timeouts: null } }));
  assert.match(out, /fleet base timeouts\.tools: sequential_call is unset \(stock 420 s\), concurrent_batch is unset/,
    "a base with no tool deadline must be reported with both keys");
}
{
  const out = audit(repo, makeFleet({ overrides: { timeouts: { tools: { sequential_call: 420, concurrent_batch: 1800 } } } }));
  assert.match(out, /sequential_call is 420 s/, "a stock-length deadline must be reported with its value");
  assert.doesNotMatch(out, /concurrent_batch is/, "only the key that is too short is named");
}
{
  // 0 disables the bound, which carries a delegation fine.
  const out = audit(repo, makeFleet({ overrides: { timeouts: { tools: { sequential_call: 0, concurrent_batch: 0 } } } }));
  assert.doesNotMatch(out, /timeouts\.tools/, "a disabled deadline must not be reported");
}
{
  const out = audit(repo, makeFleet({}));
  assert.doesNotMatch(out, /timeouts\.tools/, "a healthy base must not trip the deadline check");
}
{
  // The base can be right while a desk was rendered before the deadline existed.
  const fleet = makeFleet({});
  addProfile(fleet, "slow-pm", { ...withBloodbank(PM_LIST), timeouts: undefined });
  writeRegistry(fleet, { "slow-pm": { ...routable("pm"), profile_name: "slow-pm" } });
  const out = audit(repo, fleet);
  assert.match(out, /slow-pm: timeouts\.tools: sequential_call is unset/, "a stale routable PM must be reported by name");
  assert.match(out, /render --profile slow-pm/, "the report must give the exact re-render command");
}

// 18. Delegated workers route through the AutomaticAI gateway (policy: all agent
//     inference does). Each way of getting it wrong is silent: a base_url with no
//     api_key makes the child inherit the PARENT's key; a ${VAR} api_key reads plain
//     os.environ, which never holds a desk's own key in the multiplexed gateway.
{
  const out = audit(repo, makeFleet({ overrides: { delegation: { provider: "openrouter", model: "deepseek/deepseek-v4-flash", base_url: "", api_key: "" } } }));
  assert.match(out, /fleet base: delegation\.provider is "openrouter", not "automaticai": workers call a provider directly/,
    "a base whose workers use a direct provider must be reported");
  assert.match(out, /delegation\.model is "deepseek\/deepseek-v4-flash", not a canonical automaticai\/<account>\/<model> route/,
    "the model must be a canonical gateway route");
}
{
  const out = audit(repo, makeFleet({ overrides: { delegation: { ...BASE_CONFIG.delegation, base_url: "https://api.automaticai.io/v1" } } }));
  assert.match(out, /delegation\.base_url is set .* the child inherits the PARENT's key/,
    "a delegation base_url must be reported with the inherited-key hazard");
}
{
  const out = audit(repo, makeFleet({ overrides: { delegation: { ...BASE_CONFIG.delegation, api_key: "${AUTOMATICAI_GATEWAY_KEY}" } } }));
  assert.match(out, /delegation\.api_key is set: a literal or \$\{VAR\} here reads plain os\.environ/,
    "a ${VAR} api_key must be reported: it never sees a desk's own key");
}
{
  const out = audit(repo, makeFleet({ overrides: { providers: null } }));
  assert.match(out, /fleet base: no providers\.automaticai entry/, "a missing gateway provider must be reported");
}
{
  const out = audit(repo, makeFleet({ overrides: { providers: { automaticai: { ...BASE_CONFIG.providers.automaticai, key_env: "" } } } }));
  assert.match(out, /providers\.automaticai has no key_env, so no key reaches the gateway/, "a provider with no key_env has no key");
}
{
  const legacyCatalog = { ...BASE_CONFIG.providers.automaticai, models: ["automaticai/personal/kimi-2.8", "automaticai/personal/kimi-k3"] };
  const out = audit(repo, makeFleet({ overrides: { providers: { automaticai: legacyCatalog } } }));
  assert.match(out, /providers\.automaticai\.models omits automaticai\/personal\/sol-6\.1/,
    "the legacy two-model Hermes catalog must be reported as incomplete");
}
{
  const paidCatalog = { ...BASE_CONFIG.providers.automaticai, models: [...GATEWAY_MODELS, "automaticai/openrouter/claude-opus-5.5"] };
  const out = audit(repo, makeFleet({ overrides: { providers: { automaticai: paidCatalog } } }));
  assert.match(out, /providers\.automaticai\.models adds uncurated route\(s\): automaticai\/openrouter\/claude-opus-5\.5/,
    "a paid route outside the curated Hermes catalog must be reported");
}
{
  // Hermes only sends delegation.reasoning_effort for a provider literally named "custom";
  // a delegated child gets the configured name, so without a provider extra_body effort the
  // gateway applies the route default (kimi-2.8 = max).
  const { extra_body: _dropped, ...noEffort } = BASE_CONFIG.providers.automaticai;
  const out = audit(repo, makeFleet({ overrides: { providers: { automaticai: noEffort } } }));
  assert.match(out, /providers\.automaticai\.extra_body\.reasoning_effort is unset: Hermes never sends delegation\.reasoning_effort for a named provider/,
    "a gateway provider with no explicit effort must be reported: the route default is max");
}
{
  const out = audit(repo, makeFleet({ overrides: { secrets: { onepassword: { enabled: true, env: {} } } } }));
  assert.match(out, /secrets\.onepassword\.env maps no AUTOMATICAI_GATEWAY_KEY/, "an unmapped key variable must be reported");
}
{
  const out = audit(repo, makeFleet({ overrides: { secrets: { onepassword: { enabled: true, env: { AUTOMATICAI_GATEWAY_KEY: "sk-not-a-reference" } } } } }));
  assert.match(out, /AUTOMATICAI_GATEWAY_KEY is not an op:\/\/ reference \(a raw key must never be written to config\)/,
    "a raw key in config must be reported");
  assert.doesNotMatch(out, /sk-not-a-reference/, "the report must never echo the offending value");
}
{
  const out = audit(repo, makeFleet({}));
  assert.doesNotMatch(out, /delegation\.(provider|model|base_url|api_key)|providers\.automaticai|maps no AUTOMATICAI/, "a healthy base must not trip the routing rule");
}

// 19. Per member. The base can be right while a desk was rendered before the routing
//     existed, and a member may carry its own token or inherit the fleet one.
const PRE_ROUTING = { ...BASE_CONFIG, delegation: { provider: "openrouter", model: "deepseek/deepseek-v4-flash", base_url: "", api_key: "" } };
const OWN_TOKEN = { ...BASE_CONFIG, secrets: { onepassword: { enabled: true, env: { AUTOMATICAI_GATEWAY_KEY: "op://vault/tokens/hermes-own-pm" } } } };
{
  const fleet = makeFleet({});
  addProfile(fleet, "old-pm", PRE_ROUTING);
  writeRegistry(fleet, { "old-pm": { role: "pm", profile_name: "old-pm" } });
  const out = audit(repo, fleet);
  assert.match(out, /old-pm: delegation\.provider is "openrouter"/, "a member rendered before the routing must be reported by name");
  assert.match(out, /render --profile old-pm/, "the report must give the exact re-render command");
}
{
  const fleet = makeFleet({});
  addProfile(fleet, "own-pm", OWN_TOKEN);
  addProfile(fleet, "fleet-key-pm", BASE_CONFIG);
  writeRegistry(fleet, { "own-pm": { role: "pm", profile_name: "own-pm" }, "fleet-key-pm": { role: "pm", profile_name: "fleet-key-pm" } });
  const out = audit(repo, fleet);
  assert.doesNotMatch(out, /own-pm:|fleet-key-pm:/, "a member with its own token, and one inheriting the fleet token, are both fine");
}
{
  // The member override must also be an op:// reference.
  const fleet = makeFleet({});
  addProfile(fleet, "raw-pm", { ...BASE_CONFIG, secrets: { onepassword: { enabled: true, env: { AUTOMATICAI_GATEWAY_KEY: "sk-raw-member-key" } } } });
  writeRegistry(fleet, { "raw-pm": { role: "pm", profile_name: "raw-pm" } });
  const out = audit(repo, fleet);
  assert.match(out, /raw-pm: secrets\.onepassword\.env\.AUTOMATICAI_GATEWAY_KEY is not an op:\/\/ reference/, "a raw member key must be reported by name");
  assert.doesNotMatch(out, /sk-raw-member-key/, "the report must never echo a member's raw key");
}

// ---------------------------------------------------------------------------
// The helpers below read ONE rule's finding as JSON, so an assertion can name
// the rule it is about and check its status, not just grep the whole report.
function auditRule(repo, fleet, rule) {
  const r = spawnSync("node", [cli, "audit", "--rules", rule, "--json"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HERMES_FLEET_HOME: fleet },
  });
  const report = JSON.parse(r.stdout);
  const finding = report.rules.find((f) => f.id === rule);
  assert.ok(finding, `${rule} must be reported`);
  return { ...finding, text: [finding.summary, ...finding.details].join("\n") };
}

function remediate(repo, fleet, rule, extra = []) {
  const r = spawnSync("node", [cli, "remediate", rule, ...extra, "--json"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HERMES_FLEET_HOME: fleet },
  });
  return JSON.parse(r.stdout);
}

const withoutKey = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

// 20. The canonical Bloodbank publisher is the hook-hub client. bloodbank's
//     agent-hooks hooks.master.json names `bb-hook` as Hermes' publisher and
//     lists bloodbank/publish.py as a LEGACY forwarder; the rule used to require
//     publish.py, so it failed the correctly wired live fleet.
{
  const f = auditRule(repo, makeFleet({}), "hermes.fleet-config");
  assert.equal(f.status, "pass", `bb-hook --cli hermes --native <event> is the canonical publisher:\n${f.text}`);
}
{
  const hooks = Object.fromEntries(["on_session_start", "on_session_end", "pre_tool_call", "post_tool_call"]
    .map((h) => [h, [{ command: legacyHookCommand(h), timeout: 5 }]]));
  const f = auditRule(repo, makeFleet({ overrides: { hooks } }), "hermes.fleet-config");
  assert.equal(f.status, "fail");
  assert.match(f.text, /do not call the canonical publisher \(~\/\.agents\/hooks\/bb-hook --cli hermes --native <event>\) for: on_session_start, on_session_end, pre_tool_call, post_tool_call -- bloodbank\/publish\.py is a legacy publisher/,
    "a fleet still on the legacy publisher must be reported, naming every event");
}
{
  // A bb-hook call for the WRONG native event is not the canonical call for this one.
  const hooks = { ...BASE_CONFIG.hooks, post_tool_call: [{ command: hookCommand("pre_tool_call"), timeout: 5 }] };
  const f = auditRule(repo, makeFleet({ overrides: { hooks } }), "hermes.fleet-config");
  assert.match(f.text, /canonical publisher .* for: post_tool_call$/m, "only the miswired event is named");
}

// 21. ALL inference routes through the gateway, not just delegated workers.
{
  const f = auditRule(repo, makeFleet({}), "hermes.gateway-routing");
  assert.equal(f.status, "pass", `a fully routed base must pass:\n${f.text}`);
  assert.match(f.summary, /Main, auxiliary, delegated, fallback and MoA inference route through the gateway/);
  assert.equal(f.title, "All agent inference routes through the AutomaticAI gateway");
}
{
  // The live shape that shipped: main model on direct Kimi Coding.
  const f = auditRule(repo, makeFleet({ overrides: { model: { provider: "kimi-coding", default: "kimi-for-coding", base_url: "https://api.kimi.com/coding?token=sk-leaky-query", api_mode: "anthropic_messages" } } }), "hermes.gateway-routing");
  assert.equal(f.status, "fail");
  assert.match(f.text, /fleet base: model\.provider is "kimi-coding", not "automaticai": the main agent calls a provider directly/);
  assert.match(f.text, /model\.base_url points at api\.kimi\.com, not the api\.automaticai\.io gateway/);
  assert.match(f.text, /model\.default is "kimi-for-coding", not a canonical automaticai\/<account>\/<model> route/);
  assert.doesNotMatch(f.text, /sk-leaky-query/, "only the host of a base_url is ever reported");
}
{
  const f = auditRule(repo, makeFleet({ overrides: { model: "kimi-for-coding" } }), "hermes.gateway-routing");
  assert.match(f.text, /model is the bare string "kimi-for-coding": Hermes auto-detects its provider/);
}
{
  // custom:automaticai names the same gateway provider, and a gateway base_url is fine.
  const f = auditRule(repo, makeFleet({ overrides: { model: { provider: "custom:automaticai", default: "automaticai/personal/glm-5.3", base_url: "https://api.automaticai.io/v1" } } }), "hermes.gateway-routing");
  assert.doesNotMatch(f.text, /model\.(provider|base_url|default)/, "custom:automaticai on the gateway URL is compliant");
}
{
  // The live shape: helpers on openrouter, one on auto, one task never configured.
  const auxiliary = {
    ...withoutKey(GATEWAY_AUX, "memory_query_rewrite"),
    free_only: true,
    vision: { provider: "openrouter", model: "qwen/qwen3.7-flash" },
    compression: { provider: "auto", model: "" },
  };
  const f = auditRule(repo, makeFleet({ overrides: { auxiliary } }), "hermes.gateway-routing");
  assert.equal(f.status, "fail");
  assert.match(f.text, /auxiliary task\(s\) are pinned to a provider other than "automaticai": vision \(openrouter\) -- a pinned provider is called directly/,
    "a pinned off-gateway task is reported on its own line");
  assert.match(f.text, /auxiliary task\(s\) follow the main model \("auto"\): compression \(auto\), memory_query_rewrite \(unset = auto\) -- the main provider is the gateway, but a failed call falls through Hermes' auxiliary fallbacks .*; set auxiliary\.discovery: false: /,
    "auto and ABSENT tasks are reported in one line, naming the one missing guard key");
  assert.doesNotMatch(f.text, /title_generation \(|free_only/, "compliant tasks and a true free_only are not reported");
}
{
  const f = auditRule(repo, makeFleet({ overrides: { auxiliary: null } }), "hermes.gateway-routing");
  assert.match(f.text, /follow the main model \("auto"\): vision \(unset = auto\), web_extract \(unset = auto\).*kanban_estimator \(unset = auto\) -- .*; set auxiliary\.free_only: true and auxiliary\.discovery: false: /,
    "an absent auxiliary block leaves every task on auto, and both guard keys are named");
  assert.match(f.text, /auxiliary\.free_only is unset \(Hermes default false\): any auxiliary call that falls through to "auto" can engage a PAID OpenRouter model/,
    "the hidden paid OpenRouter lane must be reported");
}
{
  const auxiliary = {
    ...GATEWAY_AUX,
    free_only: true,
    title_generation: { enabled: false, provider: "openrouter", model: "x/y" },
    curator: { provider: "custom:automaticai", model: "automaticai/personal/kimi-k3" },
    web_extract: { provider: "automaticai", model: "automaticai/personal/glm-5.3-flash", base_url: "https://openrouter.ai/api/v1" },
    approval: { provider: "automaticai", model: "deepseek/deepseek-v4-flash" },
  };
  const f = auditRule(repo, makeFleet({ overrides: { auxiliary } }), "hermes.gateway-routing");
  assert.doesNotMatch(f.text, /title_generation|curator/, "a disabled title_generation and a custom:automaticai task are compliant");
  assert.match(f.text, /set a base_url that is not the api\.automaticai\.io gateway, and base_url takes precedence over the provider: web_extract \(openrouter\.ai\)/);
  assert.match(f.text, /name a model that is not an automaticai\/<account>\/<model> route: approval \(deepseek\/deepseek-v4-flash\)/);
}
{
  // Only title_generation honors `enabled` (agent/title_generator.py); every other
  // auxiliary task ignores the key and still calls its configured provider.
  const auxiliary = {
    ...GATEWAY_AUX,
    free_only: true,
    vision: { enabled: false, provider: "openrouter", model: "qwen/qwen3.7-flash" },
    compression: { enabled: "no", provider: "auto" },
  };
  const f = auditRule(repo, makeFleet({ overrides: { auxiliary } }), "hermes.gateway-routing");
  assert.equal(f.status, "fail");
  assert.match(f.text, /pinned to a provider other than "automaticai": vision \(openrouter\)/,
    "enabled: false on a task Hermes never gates must not hide its off-gateway provider");
  assert.match(f.text, /follow the main model \("auto"\): compression \(auto\) -- /,
    "enabled: false must not hide an unguarded auto task either");
}
{
  // The owner's design: only vision pinned, every other helper follows the gateway
  // main model ("auto", "main" or absent), with both fall-through lanes closed by
  // auxiliary.free_only: true and the fork's auxiliary.discovery: false.
  const auxiliary = {
    free_only: true,
    discovery: false,
    vision: { provider: "automaticai", model: "automaticai/personal/glm-5.3-flash" },
    compression: { provider: "auto", model: "" },
    curator: { provider: "main" },
    approval: { provider: "auto", model: "auto" },
  };
  const f = auditRule(repo, makeFleet({ overrides: { auxiliary } }), "hermes.gateway-routing");
  assert.equal(f.status, "pass", `auto helpers behind a gateway main with free_only and discovery closed must pass:\n${f.text}`);
}
{
  // Same design without the fork guard: the auto helpers are reported, and the hint
  // names exactly the one key to set.
  const auxiliary = { free_only: true, vision: { provider: "automaticai", model: "automaticai/personal/glm-5.3-flash" } };
  const f = auditRule(repo, makeFleet({ overrides: { auxiliary } }), "hermes.gateway-routing");
  assert.equal(f.status, "fail");
  assert.match(f.text, /fleet base: auxiliary task\(s\) follow the main model \("auto"\): web_extract \(unset = auto\), .*kanban_estimator \(unset = auto\) -- the main provider is the gateway, but .*; set auxiliary\.discovery: false: /,
    "a missing auxiliary.discovery: false is the one thing to set");
  assert.doesNotMatch(f.text, /vision \(|pinned to a provider|free_only/, "the pinned gateway task and a true free_only are not reported");
  // A string is not the YAML boolean the guard needs.
  const g = auditRule(repo, makeFleet({ overrides: { auxiliary: { ...auxiliary, discovery: "false" } } }), "hermes.gateway-routing");
  assert.match(g.text, /set auxiliary\.discovery: false: /, "discovery must be the literal boolean false");
}
{
  // The guard does not excuse an explicit pin: a pinned openrouter task still fails.
  const auxiliary = {
    free_only: true,
    discovery: false,
    vision: { provider: "automaticai", model: "automaticai/personal/glm-5.3-flash" },
    web_extract: { provider: "openrouter", model: "google/gemini-3.6-flash" },
  };
  const f = auditRule(repo, makeFleet({ overrides: { auxiliary } }), "hermes.gateway-routing");
  assert.equal(f.status, "fail");
  assert.match(f.text, /auxiliary task\(s\) are pinned to a provider other than "automaticai": web_extract \(openrouter\) -- /);
  assert.doesNotMatch(f.text, /follow the main model/, "guarded auto tasks behind a gateway main are compliant");
}
{
  // The guard only helps when the main model it inherits is itself on the gateway.
  const auxiliary = { free_only: true, discovery: false };
  const f = auditRule(repo, makeFleet({ overrides: { auxiliary, model: { provider: "kimi-coding", default: "kimi-for-coding" } } }), "hermes.gateway-routing");
  assert.match(f.text, /follow the main model \("auto"\), and the main provider is not the "automaticai" gateway: vision \(unset = auto\), .* -- put model\.provider on automaticai, or pin auxiliary\.<task>\.provider: automaticai/);
  // A main on the gateway provider but a foreign base_url is not on the gateway either.
  const g = auditRule(repo, makeFleet({ overrides: { auxiliary, model: { ...BASE_CONFIG.model, base_url: "https://openrouter.ai/api/v1" } } }), "hermes.gateway-routing");
  assert.match(g.text, /and the main provider is not the "automaticai" gateway/);
}
{
  // An auto helper sends its own model to the gateway main, so it must be a route.
  const auxiliary = { free_only: true, discovery: false, compression: { provider: "auto", model: "google/gemini-3.6-flash" } };
  const f = auditRule(repo, makeFleet({ overrides: { auxiliary } }), "hermes.gateway-routing");
  assert.match(f.text, /name a model that is not an automaticai\/<account>\/<model> route: compression \(google\/gemini-3\.6-flash\)/);
}
{
  // The live MoA shape: direct references, and an aggregator with a model but no
  // provider -- which Hermes silently replaces with its stock openrouter slot.
  // The top-level enabled flag is ignored once presets exist.
  const moa = {
    enabled: false,
    presets: {
      default: {
        reference_models: [
          { provider: "openai-codex", model: "gpt-5.5" },
          { provider: "openrouter", model: "deepseek/deepseek-v4-pro" },
          { provider: "openrouter", model: "z-ai/glm-5.1", enabled: false },
        ],
        aggregator: { model: "deepseek/deepseek-v4-pro" },
      },
      quiet: { enabled: false, reference_models: [{ provider: "openrouter", model: "a/b" }], aggregator: { provider: "openrouter", model: "a/b" } },
    },
  };
  const f = auditRule(repo, makeFleet({ overrides: { moa } }), "hermes.gateway-routing");
  // load_config deep-merges the aggregator over the stock one: provider openrouter
  // comes from Hermes, the model from config.yaml.
  assert.match(f.text, /moa preset "default" is enabled and leaves AutomaticAI: reference openai-codex\/gpt-5\.5, reference openrouter\/deepseek\/deepseek-v4-pro, aggregator openrouter\/deepseek\/deepseek-v4-pro \(the configured aggregator has no provider or model, so Hermes fills it from its stock openrouter slot\)/);
  assert.match(f.text, /moa\.enabled at the top level is ignored when presets exist/);
  assert.doesNotMatch(f.text, /z-ai\/glm-5\.1|preset "quiet"/, "a disabled slot and a disabled preset make no call");
}
{
  const f = auditRule(repo, makeFleet({ overrides: { moa: null } }), "hermes.gateway-routing");
  assert.match(f.text, /no moa block, so Hermes' stock preset is enabled and leaves AutomaticAI: reference openai-codex\/gpt-5\.5 \(Hermes' stock slot/,
    "an absent moa block is Hermes' stock preset, enabled, on direct providers");
}
{
  // DEFAULT_CONFIG always carries an enabled stock presets.default, and load_config
  // deep-merges config.yaml over it -- so the legacy flat shape is IGNORED and a
  // flat `enabled: false` disables nothing.
  const f = auditRule(repo, makeFleet({ overrides: { moa: { enabled: false, reference_models: [{ provider: "openrouter", model: "a/b" }] } } }), "hermes.gateway-routing");
  assert.equal(f.status, "fail");
  assert.match(f.text, /moa preset "default" \(Hermes' built-in preset: config\.yaml does not override moa\.presets\.default, so load_config merges it in\) is enabled and leaves AutomaticAI: reference openai-codex\/gpt-5\.5 \(Hermes' stock slot/);
  assert.match(f.text, /the flat moa\.reference_models\/aggregator\/enabled keys are ignored because Hermes' built-in moa\.presets\.default always exists/);
}
{
  // A presets map without "default" still gets Hermes' stock default merged in.
  const gw = { provider: "automaticai", model: "automaticai/personal/glm-5.3" };
  const f = auditRule(repo, makeFleet({ overrides: { moa: { default_preset: "gw", presets: { gw: { reference_models: [gw], aggregator: gw } } } } }), "hermes.gateway-routing");
  assert.equal(f.status, "fail");
  assert.match(f.text, /moa preset "default" \(Hermes' built-in preset/, "the merged-in stock preset is reported");
  assert.doesNotMatch(f.text, /preset "gw"/, "the gateway-routed preset is compliant");
}
{
  // Overriding the stock preset itself is what turns it off.
  const f = auditRule(repo, makeFleet({ overrides: { moa: { presets: { default: { enabled: false } } } } }), "hermes.gateway-routing");
  assert.doesNotMatch(f.text, /moa/, "a disabled presets.default makes no call");
}
{
  const f = auditRule(repo, makeFleet({ overrides: { fallback_model: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" } } }), "hermes.gateway-routing");
  assert.match(f.text, /fallback_providers entry openrouter\/deepseek\/deepseek-v4-flash leaves AutomaticAI/, "the legacy fallback_model feeds the same chain");
}

// 22. A broken base is reported ONCE: members that merely inherit it are folded
//     into a count, while a member's own drift is still named.
{
  const kimi = { provider: "kimi-coding", default: "kimi-for-coding", base_url: "", api_mode: "anthropic_messages" };
  const fleet = makeFleet({ overrides: { model: kimi } });
  addProfile(fleet, "inherit-a", { ...BASE_CONFIG, model: kimi });
  addProfile(fleet, "inherit-b", { ...BASE_CONFIG, model: kimi });
  addProfile(fleet, "drift-pm", { ...BASE_CONFIG, model: kimi, auxiliary: { ...BASE_CONFIG.auxiliary, vision: { provider: "openrouter", model: "q/q" } } });
  writeRegistry(fleet, {
    "inherit-a": { role: "pm", profile_name: "inherit-a" },
    "inherit-b": { role: "pm", profile_name: "inherit-b" },
    "drift-pm": { role: "pm", profile_name: "drift-pm" },
  });
  const f = auditRule(repo, fleet, "hermes.gateway-routing");
  assert.match(f.text, /fleet base: model\.provider is "kimi-coding"/);
  assert.doesNotMatch(f.text, /inherit-[ab]:/, "a member that only inherits the base's problem is not repeated");
  assert.match(f.text, /3 member desk\(s\) inherit the fleet base problem\(s\) above; fix the base, then re-render/);
  assert.match(f.text, /drift-pm: auxiliary task\(s\) are pinned to a provider other than "automaticai": vision \(openrouter\) -- .*; re-render: hermes-profile-config\.py render --profile drift-pm/,
    "a member's own drift is still reported by name");
}
{
  const fleet = makeFleet({});
  addProfile(fleet, "stale-model-pm", { ...BASE_CONFIG, model: { provider: "kimi-coding", default: "kimi-for-coding" } });
  writeRegistry(fleet, { "stale-model-pm": { role: "pm", profile_name: "stale-model-pm" } });
  const f = auditRule(repo, fleet, "hermes.gateway-routing");
  assert.match(f.text, /stale-model-pm: model\.provider is "kimi-coding".*render --profile stale-model-pm/, "a desk rendered before the base moved is named");
  assert.doesNotMatch(f.text, /inherit the fleet base/, "a compliant base has nothing to inherit");
}

// 23. A wake word must not rotate the session: every wake -- false triggers
//     included -- called new_session(silent=True), which reset a /model switch
//     to model.default while the stale switch note was still sent.
{
  const f = auditRule(repo, makeFleet({}), "hermes.wake-word-session");
  assert.equal(f.status, "pass", "an enabled wake word pinned to the current session is fine");
}
{
  const f = auditRule(repo, makeFleet({ overrides: { wake_word: { enabled: true } } }), "hermes.wake-word-session");
  assert.equal(f.status, "fail");
  assert.match(f.text, /fleet base: wake_word\.enabled is true and wake_word\.start_new_session is unset \(Hermes default true\): every wake, a false trigger included, calls new_session\(silent=True\)/);
}
{
  const f = auditRule(repo, makeFleet({ overrides: { wake_word: { enabled: true, start_new_session: true } } }), "hermes.wake-word-session");
  assert.match(f.text, /start_new_session is true:/);
}
{
  const f = auditRule(repo, makeFleet({ overrides: { wake_word: { enabled: false, start_new_session: true } } }), "hermes.wake-word-session");
  assert.equal(f.status, "pass", "a disabled wake word never fires");
}
{
  const fleet = makeFleet({});
  addProfile(fleet, "voice-pm", { ...BASE_CONFIG, wake_word: { enabled: true, start_new_session: true } });
  writeRegistry(fleet, { "voice-pm": { role: "pm", profile_name: "voice-pm" } });
  const f = auditRule(repo, fleet, "hermes.wake-word-session");
  assert.match(f.text, /voice-pm: wake_word\.enabled is true .*render --profile voice-pm/, "a member enabling its own wake word is named");
}

// 24. A literal op:// value in a Hermes .env is sent as the key: every import
//     after the first reloads .env with override=True while the 1Password
//     source applies once per HERMES_HOME. Only variable NAMES are reported.
const OP_ENV = [
  "PLAIN_SETTING=keep-me",
  "KIMI_API_KEY=op://vault/kimi/credential",
  'export GLM_API_KEY="op://vault/glm/credential"',
  "UNMAPPED_KEY='op://vault/other/credential' # a comment",
  "CONFLICT_KEY=op://vault/one/credential",
  "",
].join("\n");
const OP_SECRETS = (enabled = true) => ({
  onepassword: {
    enabled,
    env: {
      AUTOMATICAI_GATEWAY_KEY: "op://vault/tokens/hermes-fleet-workers",
      KIMI_API_KEY: "op://vault/kimi/credential",
      GLM_API_KEY: "op://vault/glm/credential",
      CONFLICT_KEY: "op://vault/two/credential",
    },
  },
});
{
  const f = auditRule(repo, makeFleet({}), "hermes.dotenv-no-op-refs");
  assert.equal(f.status, "pass", `a clean .env passes:\n${f.text}`);
}
{
  const fleet = makeFleet({ env: OP_ENV, overrides: { secrets: OP_SECRETS() } });
  const f = auditRule(repo, fleet, "hermes.dotenv-no-op-refs");
  assert.equal(f.status, "fail");
  assert.equal(f.fixable, true, "redundant lines are safe to remove");
  assert.match(f.text, /\.env: KIMI_API_KEY, GLM_API_KEY already mapped to the same reference in secrets\.onepassword\.env/);
  assert.match(f.text, /\.env: UNMAPPED_KEY not mapped in .*config\.yaml -- move each reference into secrets\.onepassword\.env/);
  assert.match(f.text, /\.env: CONFLICT_KEY mapped to a DIFFERENT reference/);
  assert.doesNotMatch(f.text, /op:\/\/vault/, "a reference is compared, never printed");
  assert.doesNotMatch(f.text, /profiles\/demo-pm\/\.env/, "a profile .env symlinked to the fleet .env is the same file, reported once");

  // Dry run changes nothing.
  const before = readFileSync(join(fleet, ".env"), "utf8");
  remediate(repo, fleet, "hermes.dotenv-no-op-refs", ["--dry-run"]);
  assert.equal(readFileSync(join(fleet, ".env"), "utf8"), before, "a dry run must not touch the .env");

  // Remediation deletes ONLY the redundant lines and keeps the file private.
  const report = remediate(repo, fleet, "hermes.dotenv-no-op-refs");
  const after = readFileSync(join(fleet, ".env"), "utf8");
  assert.doesNotMatch(after, /KIMI_API_KEY|GLM_API_KEY/, "redundant op:// lines are removed");
  assert.match(after, /^PLAIN_SETTING=keep-me$/m, "unrelated lines survive");
  assert.match(after, /^UNMAPPED_KEY=/m, "an unmapped reference is never deleted (it would be lost)");
  assert.match(after, /^CONFLICT_KEY=/m, "a conflicting reference is an operator decision");
  assert.equal(statSync(join(fleet, ".env")).mode & 0o777, 0o600, "the .env keeps its private mode");
  assert.ok(lstatSync(join(fleet, "profiles", "demo-pm", ".env")).isSymbolicLink(), "the profile's .env symlink is not replaced by a file");
  const result = report.results.find((r) => r.id === "hermes.dotenv-no-op-refs");
  assert.equal(result.status, "partial", "lines an operator must move keep the rule failing");
  assert.doesNotMatch(JSON.stringify(report), /op:\/\/vault/, "the remediation report never prints a reference");
}
{
  // With the 1Password source off, nothing in config is resolved: never auto-delete.
  const fleet = makeFleet({ env: OP_ENV, overrides: { secrets: OP_SECRETS(false) } });
  const f = auditRule(repo, fleet, "hermes.dotenv-no-op-refs");
  assert.equal(f.fixable, false);
  assert.match(f.text, /secrets\.onepassword\.enabled is not true/);
  remediate(repo, fleet, "hermes.dotenv-no-op-refs");
  assert.match(readFileSync(join(fleet, ".env"), "utf8"), /^KIMI_API_KEY=/m, "a disabled source blocks every deletion");
}
{
  // A profile .env that is its own file is scanned against that profile's config.
  const fleet = makeFleet({});
  const envPath = join(fleet, "profiles", "demo-pm", ".env");
  rmSync(envPath);
  writeFileSync(envPath, "SLACK_BOT_TOKEN=op://vault/slack/bot\n", { mode: 0o600 });
  const f = auditRule(repo, fleet, "hermes.dotenv-no-op-refs");
  assert.match(f.text, /profiles\/demo-pm\/\.env: SLACK_BOT_TOKEN not mapped in .*profiles\/demo-pm\/config\.yaml -- move each reference into secrets\.onepassword\.env of .*profiles\/demo-pm\/config\.delta\.yaml, re-render \(hermes-profile-config\.py render --profile demo-pm\)/);
}

for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
console.log("hermes profile inheritance regressions passed");
