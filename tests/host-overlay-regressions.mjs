// Regression guard for the per-host overlay (packages/flume-hr/src/kernel/host-overlay.ts).
//
// Two 33GOD peers run one flume build. Anything that is a fact about a HOST used to be a literal in flume's source or
// in a tracked role.yaml, so it was the first host's value on every machine that pulled the code:
//
//   * hermes.gateway-routing hardcoded the `automaticai` provider, its host and its twelve curated routes;
//   * the host template config hardcoded the runtime scaffold path, the 1Password vault and the vox URL;
//   * every flume-composed op:// reference named the first host's vault;
//   * a tracked role.yaml carries its owner's ticket lane names, and Plane has no `in_review` state group, so a lane
//     name that does not exist on another host's board silently lands a transition somewhere wrong.
//
// What must hold, and what each section below pins:
//   A. NO overlay is today's behaviour, byte for byte (the default values, rendered text, audit verdicts).
//   B. An overlay changes exactly what it names, and nothing it does not.
//   C. A BROKEN overlay never falls back to the defaults: that would run one host on another's vault or lanes.
//   D. An overlay cannot smuggle in a typo (unknown key) or a credential (secret-shaped value).
//   E. With no overlay the lane resolver reads a role.yaml exactly as the shell adapter's own `tp_cfg` does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_GATEWAY_POLICY,
  DEFAULT_GATEWAY_TOKENS_ITEM,
  DEFAULT_VAULT_NAME,
  HOST_OVERLAY_ENV,
  HostOverlayError,
  LANE_BANDS,
  LaneOverlayError,
  consumerOf,
  gatewayPolicyOf,
  gatewayRefShape,
  hostConfigSchemaKeys,
  hostGatewayTokensItem,
  hostVaultName,
  loadHostOverlay,
  looksLikeSecret,
  mergeHostConfigFor,
  parseHostOverlay,
  readTicketProvider,
  renderHostConfig,
  resolveHostOverlayPath,
  resolveLaneMap,
  resolveRoleLanes,
} from "../packages/flume-hr/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const tmpRoots = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
process.on("exit", () => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

const NONE = { [HOST_OVERLAY_ENV]: "none" };
const parseOk = (text) => {
  const parsed = parseHostOverlay(text);
  assert.ok("overlay" in parsed, `expected a valid overlay, got: ${JSON.stringify(parsed.errors)}`);
  return parsed.overlay;
};
const parseErrors = (text) => {
  const parsed = parseHostOverlay(text);
  assert.ok("errors" in parsed, "expected the overlay to be refused");
  return parsed.errors.join("\n");
};

// A host whose overlay is a file at the default location under its own $HOME.
function hostWith(overlayText) {
  const home = tmp("flume-overlay-home-");
  if (overlayText !== undefined) {
    mkdirSync(join(home, ".config", "flume"), { recursive: true });
    writeFileSync(join(home, ".config", "flume", "host-overlay.yaml"), overlayText);
  }
  return { home, env: { HOME: home } };
}

const MAC = `
version: 1
host: second-host
host_config:
  fleet:
    runtime_scaffold_dir: ~/code/template/runtime-scaffold
    vox_url: http://127.0.0.1:8700
    vox_voice: default
  plane:
    base: http://plane.local
    workspace: second
vault:
  name: LocalVault
  gateway_tokens_item: local-gateway-tokens
gateway:
  provider: automaticai
  host: api.automaticai.io
  label: AutomaticAI
  models: [automaticai/second/sol, automaticai/second/kimi-2.8, automaticai/auto]
lanes:
  - match: { provider: plane, workspace: second }
    replace: true
    states: { backlog: Backlog, unstarted: Todo, started: In Progress, completed: Done, cancelled: Cancelled }
`;

// ---------------------------------------------------------------------------
// A. No overlay = the defaults, which are the values the code carried before overlays existed.
{
  const { home } = hostWith(undefined);
  const loaded = loadHostOverlay({}, home);
  assert.equal(loaded.status, "absent", "no file, no pointer: absent, not an error");
  assert.equal(loaded.path, join(home, ".config", "flume", "host-overlay.yaml"), "the default location is under ~/.config/flume");
  assert.equal(resolveHostOverlayPath({ XDG_CONFIG_HOME: "/xdg" }, home), "/xdg/flume/host-overlay.yaml", "XDG_CONFIG_HOME moves it");
  assert.equal(resolveHostOverlayPath({ [HOST_OVERLAY_ENV]: "/elsewhere/o.yaml", XDG_CONFIG_HOME: "/xdg" }, home), "/elsewhere/o.yaml", "the explicit pointer wins");
  assert.equal(loadHostOverlay(NONE, home).status, "absent", "FLUME_HOST_OVERLAY=none disables overlays (the test runner's hermetic setting)");

  assert.equal(DEFAULT_VAULT_NAME, "DeLoSecrets");
  assert.equal(DEFAULT_GATEWAY_TOKENS_ITEM, "yeurk5dpqkaarspvsn3cjtmkki");
  assert.equal(hostVaultName({}, home), "DeLoSecrets");
  assert.equal(hostGatewayTokensItem({}, home), "yeurk5dpqkaarspvsn3cjtmkki");
  assert.deepEqual(
    { provider: DEFAULT_GATEWAY_POLICY.provider, host: DEFAULT_GATEWAY_POLICY.host, label: DEFAULT_GATEWAY_POLICY.label, models: [...DEFAULT_GATEWAY_POLICY.models] },
    {
      provider: "automaticai",
      host: "api.automaticai.io",
      label: "AutomaticAI",
      models: [
        "automaticai/personal/sol-6.1", "automaticai/personal/sol", "automaticai/personal/astra",
        "automaticai/personal/claude-opus-5.5", "automaticai/intelliforia/claude-opus-5.5",
        "automaticai/personal/claude-sonnet-5.5", "automaticai/intelliforia/claude-sonnet-5.5",
        "automaticai/personal/kimi-k3", "automaticai/personal/kimi-k3s", "automaticai/personal/kimi-2.8",
        "automaticai/personal/glm-5.3", "automaticai/personal/glm-5.3-flash",
      ],
    },
    "the default gateway policy is exactly what the parity rule hardcoded",
  );
  assert.equal(gatewayPolicyOf(loaded), DEFAULT_GATEWAY_POLICY, "an absent overlay resolves to the default policy");
  assert.ok(Object.isFrozen(DEFAULT_GATEWAY_POLICY), "the default policy is frozen: nothing may edit it in place");

  // The host config: exactly the pre-overlay text. `home` is a parameter, so a fixture host renders without touching this one.
  const rendered = renderHostConfig({}, home);
  assert.doesNotMatch(rendered, /Host overlay:/, "no provenance line without an overlay");
  assert.match(rendered, /^onepassword_vault = "DeLoSecrets"$/m);
  assert.match(rendered, /^vox_url = "https:\/\/vox\.delo\.sh"$/m);
  assert.match(rendered, /^vox_voice = "carlin"$/m);
  assert.ok(rendered.includes(`runtime_scaffold_dir = "${join(home, "code", "33GOD", "flume", "templates", "hermes-agent", "runtime-scaffold")}"`), "the scaffold default is still derived from $HOME");
  assert.match(rendered, /^base = "https:\/\/plane\.delo\.sh"$/m);
  assert.match(rendered, /^workspace = "33god"$/m);
  assert.ok(rendered.includes(`# Bootstrapped by \`flume handbook bootstrap\` for $HOME=${home} (platform=`), "the header is unchanged");
  assert.equal(renderHostConfig(NONE, home), rendered, "'none' and 'absent' render identically");
}

// B. An overlay changes exactly what it names.
{
  const overlay = parseOk(MAC);
  assert.equal(overlay.host, "second-host");
  assert.deepEqual(overlay.vault, { name: "LocalVault", gatewayTokensItem: "local-gateway-tokens" });
  assert.equal(overlay.gateway.provider, "automaticai");
  assert.deepEqual([...overlay.gateway.models], ["automaticai/second/sol", "automaticai/second/kimi-2.8", "automaticai/auto"]);
  assert.equal(overlay.lanes.length, 1);

  const { home, env } = hostWith(MAC);
  assert.equal(loadHostOverlay(env, home).status, "ok");
  assert.equal(hostVaultName(env, home), "LocalVault");
  assert.equal(hostGatewayTokensItem(env, home), "local-gateway-tokens");

  const rendered = renderHostConfig(env, home);
  assert.match(rendered, /^# Host overlay: .*host-overlay\.yaml \(host: second-host\)$/m, "a rendered config says which overlay shaped it");
  assert.match(rendered, /^onepassword_vault = "LocalVault"$/m, "vault.name feeds the config's vault");
  assert.match(rendered, /^vox_url = "http:\/\/127\.0\.0\.1:8700"$/m);
  assert.match(rendered, /^vox_voice = "default"$/m);
  assert.ok(rendered.includes(`runtime_scaffold_dir = "${join(home, "code", "template", "runtime-scaffold")}"`), "`~/` in a path-valued key means THIS host's home");
  assert.match(rendered, /^base = "http:\/\/plane\.local"$/m);
  assert.match(rendered, /^workspace = "second"$/m);
  // Zero values belonging to the first host: this is the acceptance grep for a second host.
  // (The fixture home is masked first: a TMPDIR under a developer's real home is not a value the overlay left behind.)
  const grep = rendered.split("\n").map((line) => line.split(home).join("<home>")).filter((line) => /\/home\/[a-z]|DeLoSecrets|jarad|delo\.sh|33god/iu.test(line) && !/^#/.test(line));
  assert.deepEqual(grep, [], `nothing the first host owns may survive in a second host's config:\n${grep.join("\n")}`);
  // Keys the overlay did not name keep their schema values (the shared fork is not host-owned).
  assert.match(rendered, /^hermes_git_url = "https:\/\/github\.com\/delorenj\/hermes-agent\.git"$/m);
  assert.match(rendered, /^onepassword_item_prefix = "hermes-agent"$/m);

  // A consumer reference is recognised only in THIS host's vault and item.
  assert.equal(consumerOf("op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/hermes-fleet-workers"), "hermes-fleet-workers", "default host: unchanged");
  assert.equal(consumerOf("op://DeLoSecrets/other-item/hermes-fleet-workers"), undefined);
  assert.equal(gatewayRefShape(), "op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/<consumer>");
}
{
  // The same readers, through the process environment of a host with an overlay.
  const { home } = hostWith(MAC);
  const file = join(home, ".config", "flume", "host-overlay.yaml");
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { consumerOf, gatewayRefShape } from ${JSON.stringify(join(root, "packages", "flume-hr", "dist", "index.js"))};
    console.log(JSON.stringify({
      mine: consumerOf("op://LocalVault/local-gateway-tokens/desk-one"),
      firstHosts: consumerOf("op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/desk-one") ?? null,
      shape: gatewayRefShape(),
    }));
  `], { encoding: "utf8", env: { ...process.env, [HOST_OVERLAY_ENV]: file } });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { mine: "desk-one", firstHosts: null, shape: "op://LocalVault/local-gateway-tokens/<consumer>" },
    "a second host's references name ITS vault; the first host's shape is not a gateway reference there");
}

// B2. host_config merge: an overlay never overwrites an operator's existing value, and fills the missing ones from itself.
{
  const { home, env } = hostWith(MAC);
  const existing = '[fleet]\nvox_url = "http://operator-chosen:9999"\n\n[plane]\nbase = "http://operator-plane"\n';
  const merged = mergeHostConfigFor(Buffer.from(existing), env, home);
  assert.match(merged, /^vox_url = "http:\/\/operator-chosen:9999"$/m, "the operator's value wins over the overlay");
  assert.match(merged, /^base = "http:\/\/operator-plane"$/m);
  assert.match(merged, /^onepassword_vault = "LocalVault"$/m, "a missing key is filled from the overlay");
  assert.match(merged, /^workspace = "second"$/m);
  assert.doesNotMatch(merged, /DeLoSecrets|vox\.delo\.sh/, "no first-host default is merged into a second host's config");
}

// B3. The schema the overlay validates against.
{
  const keys = hostConfigSchemaKeys("/placeholder-home");
  assert.deepEqual(Object.keys(keys), ["fleet", "github", "plane", "hindsight"]);
  for (const key of ["runtime_scaffold_dir", "vox_url", "onepassword_vault"]) assert.ok(keys.fleet.includes(key), `[fleet] ${key} is overridable`);
}

// B4. The gateway rule, end to end through the CLI, against a fixture fleet.
const AUX_TASKS = [
  "vision", "web_extract", "compression", "skills_hub", "approval", "mcp", "title_generation",
  "memory_query_rewrite", "tts_audio_tags", "triage_specifier", "kanban_decomposer", "profile_describer",
  "goal_judge", "curator", "monitor", "background_review", "moa_reference", "moa_aggregator", "kanban_estimator",
];
function gatewayConfig({ provider, host, models, defaultModel }) {
  const route = (name) => `${provider}/${name}`;
  const aux = Object.fromEntries(AUX_TASKS.map((task) => [task, { provider, model: defaultModel, timeout: 30 }]));
  return {
    model: { provider, default: defaultModel, base_url: "", api_mode: "chat_completions" },
    auxiliary: { free_only: true, discovery: false, ...aux },
    moa: { default_preset: "default", presets: { default: { reference_models: [{ provider, model: models[0] }], aggregator: { provider, model: models[0] } } } },
    fallback_providers: [{ model: defaultModel, provider }],
    providers: {
      [provider]: {
        name: provider, api: `https://${host}/v1`, key_env: "GATEWAY_KEY", default_model: defaultModel, api_mode: "chat_completions",
        extra_body: { reasoning_effort: "high" }, models,
      },
    },
    delegation: { provider, model: defaultModel, base_url: "", api_key: "", api_mode: "", reasoning_effort: "high" },
    secrets: { onepassword: { enabled: true, env: { GATEWAY_KEY: `op://${route("vault")}/tokens/fleet` } } },
  };
}
function makeRepo() {
  const repo = tmp("flume-overlay-repo-");
  const git = (...args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const roleDir = join(repo, "agents", "hermes", "pm");
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), "repo: demo\nrole: pm\nagent_id: demo-pm\nprofile: demo-pm\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return repo;
}
function makeFleet(cfg) {
  const fleet = tmp("flume-overlay-fleet-");
  writeFileSync(join(fleet, "config.yaml"), JSON.stringify(cfg, null, 2));
  writeFileSync(join(fleet, ".env"), "", { mode: 0o600 });
  mkdirSync(join(fleet, "skills"), { recursive: true });
  const pdir = join(fleet, "profiles", "demo-pm");
  mkdirSync(pdir, { recursive: true });
  symlinkSync(join(fleet, ".env"), join(pdir, ".env"));
  symlinkSync(join(fleet, "skills"), join(pdir, "skills"));
  writeFileSync(join(pdir, "config.yaml"), `# GENERATED FILE -- DO NOT EDIT.\n${JSON.stringify(cfg, null, 2)}`);
  writeFileSync(join(pdir, "config.delta.yaml"), "{}\n");
  return fleet;
}
const repo = makeRepo();
function routing(fleet, env) {
  const r = spawnSync(process.execPath, [cli, "audit", "--rules", "hermes.gateway-routing", "--json"], {
    cwd: repo, encoding: "utf8", env: { ...process.env, HERMES_FLEET_HOME: fleet, ...env },
  });
  const finding = JSON.parse(r.stdout).rules.find((f) => f.id === "hermes.gateway-routing");
  assert.ok(finding, `hermes.gateway-routing must be reported: ${r.stdout}${r.stderr}`);
  return { ...finding, text: [finding.summary, ...finding.details].join("\n") };
}

{
  const firstHost = gatewayConfig({ provider: "automaticai", host: "api.automaticai.io", models: [...DEFAULT_GATEWAY_POLICY.models], defaultModel: "automaticai/personal/kimi-2.8" });
  const fleet = makeFleet(firstHost);
  const control = routing(fleet, NONE);
  assert.equal(control.status, "pass", `no overlay: the first host's config passes exactly as before:\n${control.text}`);
  assert.equal(control.title, "All agent inference routes through the AutomaticAI gateway");

  // A second host curates its own routes. Held to the first host's list it FAILS (that was the hardcode)...
  const second = gatewayConfig({ provider: "automaticai", host: "api.automaticai.io", models: ["automaticai/second/sol", "automaticai/second/kimi-2.8", "automaticai/auto"], defaultModel: "automaticai/second/kimi-2.8" });
  const secondFleet = makeFleet(second);
  const hardcoded = routing(secondFleet, NONE);
  assert.equal(hardcoded.status, "fail", "without an overlay a second host's route list is held to the first host's");
  assert.match(hardcoded.text, /providers\.automaticai\.models omits automaticai\/personal\/sol-6\.1/);
  // ...and PASSES once its overlay names the routes it owns.
  const { home } = hostWith(MAC);
  const overlayFile = join(home, ".config", "flume", "host-overlay.yaml");
  const ok = routing(secondFleet, { [HOST_OVERLAY_ENV]: overlayFile });
  assert.equal(ok.status, "pass", `the overlay's curated list is what the rule enforces:\n${ok.text}`);
  // The same overlay still HOLDS the line: the first host's config is not acceptable on the second host.
  const crossed = routing(fleet, { [HOST_OVERLAY_ENV]: overlayFile });
  assert.equal(crossed.status, "fail");
  assert.match(crossed.text, /providers\.automaticai\.models omits automaticai\/second\/sol/);
  assert.match(crossed.text, /providers\.automaticai\.models adds uncurated route\(s\): automaticai\/personal\/sol-6\.1/);
}
{
  // A different PROVIDER and HOST: the rule names them, never "automaticai".
  const acme = gatewayConfig({ provider: "acme", host: "gw.acme.example", models: ["acme/team/m1", "acme/team/m2"], defaultModel: "acme/team/m1" });
  const fleet = makeFleet(acme);
  const { home } = hostWith(`version: 1\ngateway:\n  provider: acme\n  host: gw.acme.example\n  label: Acme\n  models: [acme/team/m1, acme/team/m2]\n`);
  const file = join(home, ".config", "flume", "host-overlay.yaml");
  const ok = routing(fleet, { [HOST_OVERLAY_ENV]: file });
  assert.equal(ok.status, "pass", `a config routed through another provider passes under that provider's overlay:\n${ok.text}`);
  assert.match(ok.title, /Acme gateway/, "findings name this host's gateway");
  // Break one route: the message names the overlay's provider and host, not the first host's.
  const broken = JSON.parse(JSON.stringify(acme));
  broken.delegation.provider = "direct";
  broken.providers.acme.api = "https://elsewhere.example/v1";
  const bad = routing(makeFleet(broken), { [HOST_OVERLAY_ENV]: file });
  assert.equal(bad.status, "fail");
  assert.match(bad.text, /delegation\.provider is "direct", not "acme"/);
  assert.match(bad.text, /providers\.acme\.api is .*, not the gw\.acme\.example gateway/);
  assert.doesNotMatch(bad.text, /automaticai|AutomaticAI/, "nothing of the first host's gateway leaks into a second host's findings");
  // The same acme config under NO overlay is a failing config on the first host (it is not routed through its gateway).
  const wrongHost = routing(fleet, NONE);
  assert.equal(wrongHost.status, "fail");
  assert.match(wrongHost.text, /no providers\.automaticai entry/);
}

// C. A broken overlay is a failure with a reason, never the defaults.
{
  const fleet = makeFleet(gatewayConfig({ provider: "automaticai", host: "api.automaticai.io", models: [...DEFAULT_GATEWAY_POLICY.models], defaultModel: "automaticai/personal/kimi-2.8" }));
  const { home } = hostWith("version: 1\ngateway:\n  provider: automaticai\n");
  const broken = join(home, ".config", "flume", "host-overlay.yaml");
  const f = routing(fleet, { [HOST_OVERLAY_ENV]: broken });
  assert.equal(f.status, "fail", "a gateway section with no models must not default to the first host's list");
  assert.match(f.text, /host overlay is invalid/);
  assert.match(f.text, /gateway\.models is required/);
  const missing = routing(fleet, { [HOST_OVERLAY_ENV]: join(home, "does-not-exist.yaml") });
  assert.equal(missing.status, "fail", "an explicit pointer to a missing file is not 'no overlay'");
  assert.match(missing.text, /names a file that does not exist/);

  const loaded = loadHostOverlay({ [HOST_OVERLAY_ENV]: broken }, home);
  assert.equal(loaded.status, "invalid");
  assert.throws(() => hostVaultName({ [HOST_OVERLAY_ENV]: broken }, home), HostOverlayError, "a vault reader refuses instead of answering with the first host's vault");
  assert.throws(() => renderHostConfig({ [HOST_OVERLAY_ENV]: broken }, home), HostOverlayError, "a config render refuses");
  assert.throws(() => resolveRoleLanes("ticket_provider:\n  name: plane\n", loaded), LaneOverlayError, "a lane resolver refuses");
  // consumerOf runs inside whole-fleet audits, so it must not crash them: it matches nothing instead.
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { consumerOf } from ${JSON.stringify(cli)};
    console.log(JSON.stringify(consumerOf("op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/desk-one") ?? null));
  `], { encoding: "utf8", env: { ...process.env, [HOST_OVERLAY_ENV]: broken } });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "null", "an unreadable overlay recognises no reference rather than the first host's shape");
}
{
  // bootstrap with a broken overlay: exit 1, a reason, and NOTHING written.
  const { home } = hostWith("version: 1\nvox_ulr: nope\n");
  const target = join(tmp("flume-overlay-out-"), "config.toml");
  const r = spawnSync(process.execPath, [cli, "handbook", "bootstrap"], {
    encoding: "utf8", env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", [HOST_OVERLAY_ENV]: "", HERMES_TEMPLATE_CONFIG: target },
  });
  assert.notEqual(r.status, 0, "a broken overlay must fail the bootstrap");
  assert.match(r.stdout + r.stderr, /host overlay .* is invalid: .*unknown key "vox_ulr"/, "the reason is printed");
  assert.equal(existsSync(target), false, "no config is written from a host whose overlay is broken");
}

// D. Typos and credentials are refused.
{
  assert.match(parseErrors("version: 1\nvoult: {}\n"), /unknown key "voult"/, "an unknown top-level key is an error, not a no-op");
  assert.match(parseErrors("version: 2\n"), /version must be 1/);
  assert.match(parseErrors("host: x\n"), /version must be 1/, "version is required");
  assert.match(parseErrors("version: 1\nvault:\n  nmae: x\n"), /vault has unknown key "nmae"/);
  assert.match(parseErrors("version: 1\nvault:\n  name: a/b\n"), /vault\.name "a\/b" must be letters/, "a vault name is one op:// path segment");
  assert.match(parseErrors("version: 1\nhost_config:\n  fleet:\n    vox_url: sk-abcdefghijklmnopqrstuvwxyz0123\n"), /looks like a credential/);
  assert.match(parseErrors("version: 1\nhost_config:\n  plane:\n    base: https://user:hunter2@plane.example\n"), /looks like a credential/);
  assert.match(parseErrors("version: 1\ngateway:\n  host: https://x.example/v1\n  models: [automaticai/a/b]\n"), /bare hostname/);
  assert.match(parseErrors("version: 1\ngateway:\n  models: [other/a/b]\n"), /not a automaticai\/<account>\[\/<model>\] route/);
  assert.match(parseErrors("version: 1\ngateway:\n  models: [automaticai/a/b, automaticai/a/b]\n"), /listed twice/);
  assert.match(parseErrors("version: 1\ngateway:\n  models: []\n"), /non-empty list/);
  assert.match(parseErrors("version: 1\nlanes:\n  - states: { review: X }\n"), /unknown band "review"/, "a misspelt band must not read as 'not set'");
  assert.match(parseErrors("version: 1\nlanes:\n  - match: { workspce: x }\n    states: { started: X }\n"), /unknown key "workspce"/);
  assert.match(parseErrors('version: 1\nlanes:\n  - states: { started: \'a "quoted" lane\' }\n'), /no double quote/, "adapters strip one pair of quotes: a lane name cannot carry one");
  assert.match(parseErrors("version: 1\nlanes:\n  - states: { started: X }\n    replace: yes please\n"), /replace must be true or false/);
  assert.match(parseErrors("version: 1\nlanes:\n  - match: {}\n"), /states must name at least one band/);
  assert.match(parseErrors("version: 1\nversion: 1\n"), /not valid YAML/, "a duplicate key is not silently last-wins");
  assert.match(parseErrors("- not\n- a mapping\n"), /must be a YAML mapping/);
  assert.equal(looksLikeSecret("op://LocalVault/item/field"), false, "an op:// reference is the sanctioned way to name a secret");
  assert.equal(looksLikeSecret("https://plane.local"), false);
  // A host_config key the schema does not carry fails at render time (the schema's owner validates it).
  const { home, env } = hostWith("version: 1\nhost_config:\n  fleet:\n    vox_ulr: http://x\n");
  assert.throws(() => renderHostConfig(env, home), /host_config\.fleet\.vox_ulr is not a key of \[fleet\]/);
  const { home: h2, env: e2 } = hostWith("version: 1\nhost_config:\n  nope:\n    a: b\n");
  assert.throws(() => renderHostConfig(e2, h2), /host_config\.nope is not a section/);
  const { home: h3, env: e3 } = hostWith("version: 1\nvault:\n  name: One\nhost_config:\n  fleet:\n    onepassword_vault: Two\n");
  assert.throws(() => renderHostConfig(e3, h3), /disagree; name the vault once/, "the vault is named once, or the same twice");
  const { home: h4, env: e4 } = hostWith("version: 1\nvault:\n  name: Same\nhost_config:\n  fleet:\n    onepassword_vault: Same\n");
  assert.match(renderHostConfig(e4, h4), /^onepassword_vault = "Same"$/m);
}

// E. Lanes. A role.yaml's tracked map is the default; an overlay lays over it or replaces it.
const ROLE = `repo: demo
role: pm
ticket_provider:
  name: "plane"
  board_id: "board-1"
  workspace: "ws-a"
  project: "board-1"
  backlog: "" # e.g. "Backlog"
  unstarted: "Todo"
  started: "In Progress"
  in_review: "E2E Testing & QA"
  completed: "Done"
  # needs_re_evaluation: "Not Real"
  awaiting_decision: "Awaiting Decision"
reconcile:
  enabled: false
`;
const absent = { status: "absent", path: "x" };
const lanes = (overlayText, role = ROLE) => resolveRoleLanes(role, { status: "ok", path: "x", overlay: parseOk(overlayText) });
{
  const { board, tracked } = readTicketProvider(ROLE);
  assert.deepEqual(board, { provider: "plane", workspace: "ws-a", board_id: "board-1" });
  assert.deepEqual(tracked, { unstarted: "Todo", started: "In Progress", in_review: "E2E Testing & QA", completed: "Done", awaiting_decision: "Awaiting Decision" },
    "empty and commented-out lanes are not lanes");
  const none = resolveRoleLanes(ROLE, absent);
  assert.deepEqual(none.effective, none.tracked, "no overlay: the tracked map, unchanged");
  assert.deepEqual(none.appliedRules, []);
  assert.equal(none.replaced, false);

  // Layer: the overlay's names win band by band; every band it does not name keeps the tracked name.
  const layered = lanes("version: 1\nlanes:\n  - match: { workspace: ws-a }\n    states: { in_review: In Review }\n");
  assert.equal(layered.effective.in_review, "In Review", "the overlay corrects the lane that does not exist on this host's board");
  assert.equal(layered.effective.started, "In Progress", "an unnamed band keeps the tracked name");
  assert.deepEqual(layered.appliedRules, [0]);
  assert.equal(layered.tracked.in_review, "E2E Testing & QA", "the tracked map is reported untouched alongside");

  // Replace: the tracked map names the owner's lanes, and none of them may reach a board that does not have them.
  const replaced = lanes("version: 1\nlanes:\n  - match: { provider: plane, workspace: ws-a }\n    replace: true\n    states: { started: Doing, completed: Shipped }\n");
  assert.deepEqual(replaced.effective, { started: "Doing", completed: "Shipped" }, "replace drops every tracked name it does not restate");
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.effective.in_review, undefined, "an unnamed band falls to the adapter's own default, not to the owner's lane");

  // Match: a rule applies only to the board it names; every key it names must match; none = every board.
  assert.deepEqual(lanes("version: 1\nlanes:\n  - match: { workspace: ws-b }\n    states: { started: X }\n").effective, none.tracked, "another workspace's rule does not apply");
  assert.deepEqual(lanes("version: 1\nlanes:\n  - match: { workspace: ws-a, board_id: other }\n    states: { started: X }\n").effective, none.tracked, "every named key must match");
  assert.equal(lanes("version: 1\nlanes:\n  - match: { provider: plane, board_id: board-1 }\n    states: { started: X }\n").effective.started, "X");
  assert.equal(lanes("version: 1\nlanes:\n  - states: { started: Everywhere }\n").effective.started, "Everywhere", "a rule with no match applies to every board");
  // Order: later wins per band; a later replace discards what an earlier rule laid down.
  assert.equal(lanes("version: 1\nlanes:\n  - states: { started: First }\n  - states: { started: Second }\n").effective.started, "Second");
  assert.deepEqual(lanes("version: 1\nlanes:\n  - states: { started: First, completed: Kept }\n  - replace: true\n    states: { started: Only }\n").effective, { started: "Only" });
  // resolveLaneMap is pure.
  assert.deepEqual(resolveLaneMap({ started: "A" }, { provider: "p", workspace: "w", board_id: "b" }, []).effective, { started: "A" });
  assert.ok(LANE_BANDS.includes("in_review") && LANE_BANDS.includes("e2e_testing") && LANE_BANDS.length === 10, "the bands are the ones a role.yaml can name");

  // A role.yaml with no ticket_provider block resolves to nothing and a board nobody can match except by an empty rule.
  const bare = resolveRoleLanes("repo: demo\n", absent);
  assert.deepEqual(bare.effective, {});
  assert.deepEqual(bare.board, { provider: "", workspace: "", board_id: "" });
}

// E2. With no overlay the resolver reads a role.yaml EXACTLY as the shell adapter does (providers/plane.sh `tp_cfg`).
// The snippet below is that function's body, verbatim. A trailing comment after a value is where a YAML parser and the
// adapter disagree (the adapter reads empty), so the fixture includes one.
{
  const TP_CFG = `
import sys, re, pathlib
text = pathlib.Path(sys.argv[1]).read_text()
m = re.search(r'(?ms)^ticket_provider:\\s*$(.*?)(?=^\\S)', text + "\\n\\x00")
block = m.group(1) if m else ""
for key in sys.argv[2:]:
    mm = re.search(rf'(?m)^\\s*{re.escape(key)}:\\s*"?([^"\\n]*)"?\\s*$', block)
    print(mm.group(1).strip() if mm else "")
`;
  const adapterRole = ROLE.replace('started: "In Progress"', 'started: "In Progress" # trailing note the adapter cannot see');
  const dir = tmp("flume-overlay-roles-");
  const files = {
    fixture: join(dir, "fixture.yaml"),
    comment: join(dir, "comment.yaml"),
    bare: join(dir, "bare.yaml"),
    repoPm: join(root, "agents", "hermes", "pm", "role.yaml"),
  };
  writeFileSync(files.fixture, ROLE);
  writeFileSync(files.comment, adapterRole);
  writeFileSync(files.bare, "repo: demo\nrole: pm\n");
  for (const [label, file] of Object.entries(files)) {
    const python = spawnSync("python3", ["-I", "-c", TP_CFG, file, ...LANE_BANDS], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    const wanted = python.stdout.split("\n").slice(0, LANE_BANDS.length);
    const got = resolveRoleLanes(readFileSync(file, "utf8"), absent);
    LANE_BANDS.forEach((band, i) => assert.equal(got.effective[band] ?? "", wanted[i], `${label}: ${band} must read as the adapter reads it`));
  }
  assert.equal(resolveRoleLanes(readFileSync(files.comment, "utf8"), absent).effective.started, undefined, "a value the adapter cannot see is not a lane");
}

// E3. The CLI: `flume lanes get` is the drop-in for `tp_cfg <band>`; `flume overlay show` validates a file.
{
  const dir = tmp("flume-overlay-cli-");
  const roleFile = join(dir, "role.yaml");
  writeFileSync(roleFile, ROLE);
  const overlayFile = join(dir, "overlay.yaml");
  writeFileSync(overlayFile, "version: 1\nlanes:\n  - match: { workspace: ws-a }\n    states: { in_review: In Review }\n");
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...NONE, ...env } });

  assert.equal(run(["lanes", "get", roleFile, "in_review"]).stdout, "E2E Testing & QA\n", "no overlay: the tracked lane");
  assert.equal(run(["lanes", "get", roleFile, "in_review", "--file", overlayFile]).stdout, "In Review\n", "--file lays an overlay over it");
  assert.equal(run(["lanes", "get", roleFile, "in_review"], { [HOST_OVERLAY_ENV]: overlayFile }).stdout, "In Review\n", "so does the environment");
  assert.equal(run(["lanes", "get", roleFile, "needs_re_evaluation"]).stdout, "\n", "an unnamed lane prints empty: the adapter default applies");
  assert.equal(run(["lanes", "get", roleFile, "bogus"]).status, 2, "an unknown band is refused");

  const shown = run(["lanes", "show", roleFile, "--json", "--file", overlayFile]);
  assert.equal(shown.status, 0, shown.stderr);
  const [row] = JSON.parse(shown.stdout);
  assert.equal(row.effective.in_review, "In Review");
  assert.equal(row.tracked.in_review, "E2E Testing & QA");

  const badFile = join(dir, "bad.yaml");
  writeFileSync(badFile, "version: 1\nlanes:\n  - states: { nope: X }\n");
  const refused = run(["lanes", "get", roleFile, "in_review", "--file", badFile]);
  assert.equal(refused.status, 1, "a broken overlay refuses; it does not answer with the tracked lane");
  assert.equal(refused.stdout, "", "and prints no lane for an adapter to act on");
  assert.match(refused.stderr, /unknown band "nope"/);

  const shownOverlay = run(["overlay", "show", "--json", "--file", overlayFile]);
  assert.equal(JSON.parse(shownOverlay.stdout).status, "ok");
  const shownBad = run(["overlay", "show", "--file", badFile]);
  assert.equal(shownBad.status, 1);
  assert.match(shownBad.stdout, /INVALID/);
  const shownAbsent = run(["overlay", "show"]);
  assert.equal(shownAbsent.status, 0);
  assert.match(shownAbsent.stdout, /every value is the default/);
  const rendered = run(["overlay", "render-config", "--file", overlayFile]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /^onepassword_vault = "DeLoSecrets"$/m, "an overlay that names no vault leaves the default vault");
}

console.log("host-overlay-regressions: ok");
