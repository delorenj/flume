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
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
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
const hookCommand = (hook) =>
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

const BASE_CONFIG = {
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
function makeFleet({ overrides = {}, profileMode = "rendered", profile = "demo-pm", delta = {}, linkProfile = false } = {}) {
  const fleet = tmp("pjangler-inherit-fleet-");
  const cfg = { ...BASE_CONFIG, ...overrides };
  writeFileSync(join(fleet, "config.yaml"), yamlDump(cfg));
  writeFileSync(join(fleet, ".env"), "");
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

for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
console.log("hermes profile inheritance regressions passed");
