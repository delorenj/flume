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
  fallback_providers: [{ provider: "openai-codex", model: "gpt-5.6-sol" }],
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
    delta: { fallback_providers: [{ model: "gpt-5.6-sol", provider: "openai-codex" }] },
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

for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
console.log("hermes profile inheritance regressions passed");
