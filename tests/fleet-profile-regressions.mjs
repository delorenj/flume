// PJAN Epic 1 / Story 1.7 (PJAN-109): generated profile health, proven, and
// the profile root's extras classified.
//
// Before this story `pjangler fleet status --domain profile` proved almost
// nothing: one `lstat` of the profile directory, generated-config health a
// declared deferral, nothing validating the identity file, the Hindsight bank
// pin or the skill core, and the profile root's unregistered entries reported
// by nothing. This suite is the proof that the observer which replaces that:
//
//   * gates every profile path first (real, contained, safely named,
//     unambiguous) and reads nothing beneath one that fails the gate;
//   * proves the generated config through the CANONICAL renderer's own check,
//     run at bytes proven identical to the committed gitlink -- the fixture
//     submodule carries the REAL renderer and lock-helper bytes read from this
//     repository's gitlink, so every case exercises the canonical check;
//   * proves the bank pin exactly and the skill core by bytes;
//   * classifies every unregistered root entry into one of five classes with
//     bounded evidence, and never proposes deleting anything;
//   * writes nothing, emits no body, value, memory, timestamp or absolute path,
//     and produces byte-identical `data` across runs and adapters.
//
// The bar, carried from stories 1.4 through 1.6: every case runs the REAL built
// `dist/index.js` in a real subprocess; stdout is asserted parseable before
// anything else; every invocation is bracketed by a content+mtime snapshot of
// the scratch tree and the tracked contract; the fleet, the profile root, the
// package roots and the audit reports are all CONSTRUCTED here. Only the one
// live AC11 case may skip.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(import.meta.dirname, "..");
// The workspace that owns the CLI. `dist/` lives under the package; the handbook
// and the job-description template stay at the repo root.
const PKG = join(ROOT, "packages", "flume-hr");
const CLI = join(PKG, "dist", "index.js");
const MCP = join(PKG, "dist", "mcp-server.js");
const TRACKED_CONTRACT = join(ROOT, "contracts", "handbook.yaml");
const SUBMODULE = join(ROOT, "templates", "hermes-agent");

/** The five declared leaves, in the byte order the observations sort in. */
const FIELDS = {
  path: "profiles.{profile_name}",
  config: "profiles.{profile_name}.config.yaml",
  bank: "profiles.{profile_name}.hindsight.config.json",
  identity: "profiles.{profile_name}.profile.yaml",
  skills: "profiles.{profile_name}.skills",
};
const FIELD_ORDER = [FIELDS.path, FIELDS.config, FIELDS.bank, FIELDS.identity, FIELDS.skills];
const EXTRA_CLASSES = ["approved-managed-exception", "intentionally-unmanaged", "retired-candidate", "unclassified", "debris-candidate"];
const CORE_SKILLS = ["33god-projects", "delonet-conventions", "delonet-dotenv", "hermes-pm-template-maintenance", "hindsight", "subagent-driven-development"];
/** Mirrors FLEET_STATUS_MAX_ITEMS in src/fleet/types.ts. */
const MAX_ITEMS = 100;
const DATA_KEYS = [
  "contract_path", "contract_version", "scope",
  "totals", "health", "agents", "domains", "host", "findings", "probes", "transitions", "scaffold", "profile", "truncated",
];
const SECRET_SENTINEL = "pjan109-not-a-real-credential-0000";

const REAL_HOME = (() => { try { return userInfo().homedir; } catch { return homedir(); } })();
const REAL_AGENT_REGISTRY = process.env.HERMES_AGENTS_REGISTRY?.trim() || join(REAL_HOME, ".hermes", "agents-registry.yaml");
const REAL_PROJECT_REGISTRY = process.env.PJ_PROJECT_REGISTRY?.trim() || join(REAL_HOME, ".config", "pjangler", "projects.yaml");

const temp = mkdtempSync(join(tmpdir(), "fleet-profile-"));
/** Shims and recorders live OUTSIDE `temp`, so their own bookkeeping can never read as the command writing. */
const shimRoot = mkdtempSync(join(tmpdir(), "fleet-profile-shims-"));
const scratchHome = join(temp, "home");
const reposRoot = join(temp, "repos");
const workdir = join(temp, "work");
const outside = join(scratchHome, "outside");

let failures = 0;
let skipped = 0;

class SkipCase extends Error {}

function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP ${label}: ${reason}`);
}

function skipCase(label, reason) {
  skip(label, reason);
  throw new SkipCase(reason);
}

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    if (error instanceof SkipCase) return;
    failures += 1;
    console.log(`  FAIL ${label}: ${String(error.message).split("\n")[0]}`);
  }
}

async function checkAsync(label, body) {
  try {
    await body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    if (error instanceof SkipCase) return;
    failures += 1;
    console.log(`  FAIL ${label}: ${String(error.message).split("\n")[0]}`);
  }
}

const GIT_IDENTITY = ["-c", "user.email=suite@invalid", "-c", "user.name=Suite", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

function git(cwd, args, options = {}) {
  return spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd, encoding: options.encoding ?? "utf8", maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      XDG_CONFIG_HOME: join(temp, "no-xdg-config"), GIT_DIR: undefined, GIT_WORK_TREE: undefined,
    },
  });
}

function gitOk(cwd, args, why) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, `${why ?? args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

function sha256Prefix(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// The REAL renderer, read from this repository's committed gitlink
// ---------------------------------------------------------------------------

const GITLINK = /([0-9a-f]{40})/u.exec(git(ROOT, ["ls-tree", "HEAD", "--", "templates/hermes-agent"]).stdout)?.[1] ?? null;

/** Bytes of one file at the committed gitlink, as a buffer. Never the worktree. */
function pinned(path) {
  assert.ok(GITLINK, "this checkout must commit a gitlink for templates/hermes-agent");
  const shown = git(SUBMODULE, ["show", `${GITLINK}:${path}`], { encoding: "buffer" });
  assert.equal(shown.status, 0, `git show ${GITLINK.slice(0, 12)}:${path} must succeed`);
  return shown.stdout;
}

const RENDERER_REL = "scripts/hermes-profile-config.py";
const LOCK_HELPER_REL = "template/.scripts/lib/profile-config-lock.py";
const PROFILE_SCRIPT_REL = "template/.scripts/10-hermes-profile.sh";
const RENDERER_BYTES = pinned(RENDERER_REL);
const LOCK_HELPER_BYTES = pinned(LOCK_HELPER_REL);

// ---------------------------------------------------------------------------
// A synthetic template repository carrying the real renderer
// ---------------------------------------------------------------------------

const TEMPLATE_REMOTE = "https://github.com/delorenj/hermes-agent-template.git";
const HERMES_REMOTE = "https://github.com/delorenj/hermes-agent.git";
const templateSource = join(temp, "template-source");
let TEMPLATE_HEAD = "";

function seedTemplate() {
  mkdirSync(join(templateSource, "scripts"), { recursive: true });
  mkdirSync(join(templateSource, "template", ".scripts", "lib"), { recursive: true });
  writeFileSync(join(templateSource, "copier.yml"), "_subdirectory: template\n_templates_suffix: .jinja\n", "utf8");
  writeFileSync(join(templateSource, RENDERER_REL), RENDERER_BYTES);
  chmodSync(join(templateSource, RENDERER_REL), 0o755);
  writeFileSync(join(templateSource, LOCK_HELPER_REL), LOCK_HELPER_BYTES);
  writeFileSync(join(templateSource, "template", "role.yaml.jinja"), "role: {{ role | tojson }}\n", "utf8");
  gitOk(templateSource, ["init", "--quiet"]);
  gitOk(templateSource, ["add", "-A"]);
  gitOk(templateSource, ["commit", "--quiet", "-m", "template with the canonical renderer"]);
  TEMPLATE_HEAD = gitOk(templateSource, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------------------
// The fleet: a base config, canonical skills, one profile per matrix row
// ---------------------------------------------------------------------------

const fleetHome = join(scratchHome, ".hermes");
const profilesRoot = join(fleetHome, "profiles");
const canonicalSkills = join(scratchHome, ".agents", "skills");

/** The fleet base. `external_dirs` carries the canonical dir (absolute) and one relative entry, as the live base does. */
function baseConfig() {
  return {
    model: { default: "fleet-model", provider: "fleet" },
    skills: { external_dirs: [canonicalSkills, "./agents/skills"], template_vars: true },
    memory: { provider: "hindsight", memory_enabled: true },
    mcp_servers: { hindsight: { command: "hindsight-mcp" } },
  };
}
const BASE_TEXT = YAML.stringify(baseConfig());

/** Hermes' own deep merge, replicated for the fixture: override wins, dicts recurse, a null override of a dict is ignored. */
function deepMerge(base, override) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    if (key === "x-pjangler-merge") continue;
    const current = out[key];
    if (current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)) out[key] = deepMerge(current, value);
    else if (current && typeof current === "object" && !Array.isArray(current) && value === null) continue;
    else out[key] = structuredClone(value);
  }
  return out;
}

const GENERATED_HEADER = "# GENERATED FILE -- DO NOT EDIT\n";

function generatedText(delta, base = baseConfig()) {
  return GENERATED_HEADER + YAML.stringify(deepMerge(base, delta ?? {}));
}

function seedCanonicalSkills() {
  for (const name of CORE_SKILLS) {
    mkdirSync(join(canonicalSkills, name), { recursive: true });
    writeFileSync(join(canonicalSkills, name, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n\nThe canonical ${name} skill.\n`, "utf8");
  }
  mkdirSync(join(canonicalSkills, "extra-tool"), { recursive: true });
  writeFileSync(join(canonicalSkills, "extra-tool", "SKILL.md"), "---\nname: extra-tool\n---\n\n# extra-tool\n", "utf8");
}

/**
 * A repository directory for one agent with a role-local runtime, so the
 * profile's singleton links have somewhere of their own to point.
 */
function makeRepo(slug) {
  const dir = join(reposRoot, slug);
  const runtime = join(dir, "agents", "hermes", "pm", "runtime");
  mkdirSync(join(runtime, "memories"), { recursive: true });
  writeFileSync(join(runtime, "SOUL.md"), `# ${slug} soul\n`, "utf8");
  writeFileSync(join(runtime, "memories", "MEMORY.md"), `secret memory ${SECRET_SENTINEL}\n`, "utf8");
  writeFileSync(join(dir, ".project.json"), `${JSON.stringify({ project_slug: slug, ticket_provider: { type: "plane", workspace: "suite", identifier: slug.toUpperCase(), board_id: `board-${slug}` } }, null, 2)}\n`, "utf8");
  return { dir, roleDir: join(dir, "agents", "hermes", "pm"), runtime };
}

/**
 * Seed one profile directory the way the template's provisioning would leave
 * it: identity file, delta, generated config, bank pin, six core skill links,
 * the copied PM skill, singleton links into the agent's own runtime, and the
 * renderer's persistent zero-byte lock PRE-CREATED so a check writes nothing.
 */
function seedProfile(name, options = {}) {
  const {
    identity = { name, display_name: `${name.replace(/-pm$/u, "")} PM` },
    identityText = null,
    delta = {},
    deltaText = null,
    generated = null,
    pin = { bank_id: `agent-${name}` },
    pinText = null,
    skills = "links",
    links = null,
    lock = true,
    root = profilesRoot,
  } = options;
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (identityText !== null) writeFileSync(join(dir, "profile.yaml"), identityText, "utf8");
  else if (identity !== null) writeFileSync(join(dir, "profile.yaml"), YAML.stringify(identity), "utf8");
  if (deltaText !== null) writeFileSync(join(dir, "config.delta.yaml"), deltaText, "utf8");
  else if (delta !== null) writeFileSync(join(dir, "config.delta.yaml"), Object.keys(delta).length ? YAML.stringify(delta) : "{}\n", "utf8");
  if (generated !== "none") writeFileSync(join(dir, "config.yaml"), generated ?? generatedText(delta ?? {}), "utf8");
  if (pinText !== null) { mkdirSync(join(dir, "hindsight"), { recursive: true }); writeFileSync(join(dir, "hindsight", "config.json"), pinText, "utf8"); }
  else if (pin !== null) { mkdirSync(join(dir, "hindsight"), { recursive: true }); writeFileSync(join(dir, "hindsight", "config.json"), `${JSON.stringify(pin, null, 2)}\n`, "utf8"); }
  if (skills === "links") {
    mkdirSync(join(dir, "skills"), { recursive: true });
    for (const skill of CORE_SKILLS) symlinkSync(join(canonicalSkills, skill), join(dir, "skills", skill));
    mkdirSync(join(dir, "skills", "software-development", "subagent-driven-development"), { recursive: true });
    cpSync(join(canonicalSkills, "subagent-driven-development", "SKILL.md"), join(dir, "skills", "software-development", "subagent-driven-development", "SKILL.md"));
  } else if (typeof skills === "function") {
    mkdirSync(join(dir, "skills"), { recursive: true });
    skills(join(dir, "skills"));
  }
  if (links !== null) {
    for (const [entry, target] of Object.entries(links)) symlinkSync(target, join(dir, entry));
  }
  if (lock) writeFileSync(join(root, `.${name}.config.lock`), "");
  return dir;
}

/** Every registered agent in the fixture, by profile name, with what makes its row special. */
const AGENTS = [];
const RUNTIMES = {};

function register(name, rowOverrides = {}) {
  AGENTS.push({ name, rowOverrides });
}

function seedFleet() {
  mkdirSync(workdir, { recursive: true });
  mkdirSync(profilesRoot, { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "hermes-agent-template"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "systemd", "user"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const release = join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc", "bin");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "hermes"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(release, "hermes"), 0o755);
  writeFileSync(join(fleetHome, "config.yaml"), BASE_TEXT, "utf8");
  seedCanonicalSkills();

  const repoFor = (name) => {
    const made = makeRepo(name.replace(/-pm$/u, ""));
    RUNTIMES[name] = made.runtime;
    return made;
  };
  const ownLinks = (name) => ({ "SOUL.md": join(RUNTIMES[name], "SOUL.md"), memories: join(RUNTIMES[name], "memories") });

  // -- the path gate ----------------------------------------------------------
  repoFor("clean-pm"); seedProfile("clean-pm", { links: ownLinks("clean-pm") }); register("clean-pm");
  repoFor("symlink-pm"); seedProfile("shared-profile", { identity: { name: "shared-profile" }, pin: { bank_id: "agent-shared-profile" }, lock: false });
  symlinkSync(join(profilesRoot, "shared-profile"), join(profilesRoot, "symlink-pm")); register("symlink-pm");
  repoFor("missing-pm"); register("missing-pm");
  repoFor("file-pm"); writeFileSync(join(profilesRoot, "file-pm"), "not a directory\n", "utf8"); register("file-pm");
  repoFor("twin-pm"); seedProfile("twin-pm", { links: ownLinks("twin-pm") }); mkdirSync(join(profilesRoot, "Twin-pm", "hindsight"), { recursive: true }); register("twin-pm");
  repoFor("unsafe-pm"); register("unsafe-pm", { profile_name: "Unsafe-PM" });
  repoFor("misowned-pm"); seedProfile("misowned-pm", { links: { "SOUL.md": join(RUNTIMES["clean-pm"], "SOUL.md"), memories: join(RUNTIMES["misowned-pm"], "memories") } }); register("misowned-pm");

  // -- the generated config ---------------------------------------------------
  repoFor("stale-pm");
  seedProfile("stale-pm", {
    links: ownLinks("stale-pm"),
    delta: { token: SECRET_SENTINEL },
    // Rendered from an OLDER base: one section differs, and its value is the sentinel.
    generated: GENERATED_HEADER + YAML.stringify({ ...deepMerge(baseConfig(), { token: SECRET_SENTINEL }), model: { default: SECRET_SENTINEL, provider: "fleet" } }),
  });
  register("stale-pm");
  repoFor("gensym-pm"); seedProfile("gensym-pm", { links: ownLinks("gensym-pm"), generated: "none" }); symlinkSync(join(fleetHome, "config.yaml"), join(profilesRoot, "gensym-pm", "config.yaml")); register("gensym-pm");
  repoFor("marker-pm"); seedProfile("marker-pm", { links: ownLinks("marker-pm"), generated: YAML.stringify(deepMerge(baseConfig(), {})) }); register("marker-pm");
  repoFor("nodelta-pm"); seedProfile("nodelta-pm", { links: ownLinks("nodelta-pm"), delta: null }); register("nodelta-pm");
  // A delta the renderer's PyYAML cannot parse: both files are regular, so the
  // observer spawns the check, and the renderer exits 1 with a FATAL on stderr
  // and no drift block on stdout.
  repoFor("crash-pm"); seedProfile("crash-pm", { links: ownLinks("crash-pm"), deltaText: "model: {unterminated\n" }); register("crash-pm");
  // Deltas that are not override-only: a frozen copy of the generated file
  // (marker and all) and a copy of the base. Both still merge to the base, so
  // the renderer reads them in sync; the observer does not.
  repoFor("frozen-pm"); seedProfile("frozen-pm", { links: ownLinks("frozen-pm"), deltaText: generatedText({}) }); register("frozen-pm");
  repoFor("basecopy-pm"); seedProfile("basecopy-pm", { links: ownLinks("basecopy-pm"), deltaText: BASE_TEXT }); register("basecopy-pm");

  // -- the bank pin -------------------------------------------------------------
  repoFor("alias-pm"); seedProfile("alias-pm", { links: ownLinks("alias-pm"), pin: { bank_id: "agent-Alias-pm" } }); register("alias-pm");
  repoFor("alias2-pm"); seedProfile("alias2-pm", { links: ownLinks("alias2-pm"), pin: { bank_id: "agent-alias2_pm" } }); register("alias2-pm");
  repoFor("custom-pm"); seedProfile("custom-pm", { links: ownLinks("custom-pm"), pin: { bank_id: "custom" } }); register("custom-pm");
  repoFor("template-pm"); seedProfile("template-pm", { links: ownLinks("template-pm"), pin: { bank_id_template: "agent-{profile}" } }); register("template-pm");
  repoFor("nopin-pm"); seedProfile("nopin-pm", { links: ownLinks("nopin-pm"), pin: null }); register("nopin-pm");
  repoFor("mismatch-pm"); seedProfile("mismatch-pm", { links: ownLinks("mismatch-pm"), pin: { bank_id: "agent-somebody-else" } }); register("mismatch-pm");
  repoFor("pinbad-pm"); seedProfile("pinbad-pm", { links: ownLinks("pinbad-pm"), pinText: "{not json" }); register("pinbad-pm");
  repoFor("pinlink-pm"); seedProfile("pinlink-pm", { links: ownLinks("pinlink-pm"), pin: null });
  mkdirSync(join(profilesRoot, "pinlink-pm", "hindsight"), { recursive: true });
  symlinkSync(join(profilesRoot, "clean-pm", "hindsight", "config.json"), join(profilesRoot, "pinlink-pm", "hindsight", "config.json"));
  register("pinlink-pm");

  // -- the skill core -----------------------------------------------------------
  repoFor("skills-pm");
  seedProfile("skills-pm", {
    links: ownLinks("skills-pm"),
    skills: (dir) => {
      symlinkSync(join(canonicalSkills, "no-such-skill"), join(dir, "hindsight"));
      mkdirSync(join(dir, "33god-projects"), { recursive: true });
      writeFileSync(join(dir, "33god-projects", "SKILL.md"), `# a replaced copy\n\n${SECRET_SENTINEL}\n`, "utf8");
      symlinkSync(join(canonicalSkills, "extra-tool"), join(dir, "extra-tool"));
      symlinkSync(join(canonicalSkills, "extra-tool"), join(dir, "extra-tool2"));
    },
  });
  register("skills-pm");
  // The shape 27 of 28 live profiles have: `skills` is a symlink into the
  // fleet home, holding optional skills only, and the core arrives through
  // the generated config's external_dirs.
  mkdirSync(join(fleetHome, "skills", "extra-linked"), { recursive: true });
  writeFileSync(join(fleetHome, "skills", "extra-linked", "SKILL.md"), "---\nname: extra-linked\n---\n\n# extra-linked\n", "utf8");
  repoFor("skills-link-pm"); seedProfile("skills-link-pm", { links: { ...ownLinks("skills-link-pm"), skills: join(fleetHome, "skills") }, skills: null }); register("skills-link-pm");
  mkdirSync(join(outside, "skills-dir", "hindsight"), { recursive: true });
  cpSync(join(canonicalSkills, "hindsight", "SKILL.md"), join(outside, "skills-dir", "hindsight", "SKILL.md"));
  repoFor("skills-outside-pm"); seedProfile("skills-outside-pm", { links: { ...ownLinks("skills-outside-pm"), skills: join(outside, "skills-dir") }, skills: null }); register("skills-outside-pm");
  repoFor("skills-dangling-pm"); seedProfile("skills-dangling-pm", { links: { ...ownLinks("skills-dangling-pm"), skills: join(fleetHome, "no-such-skills") }, skills: null }); register("skills-dangling-pm");
  repoFor("foreign-pm");
  mkdirSync(join(outside, "delonet-dotenv"), { recursive: true });
  cpSync(join(canonicalSkills, "delonet-dotenv", "SKILL.md"), join(outside, "delonet-dotenv", "SKILL.md"));
  seedProfile("foreign-pm", { links: ownLinks("foreign-pm"), skills: (dir) => { symlinkSync(join(outside, "delonet-dotenv"), join(dir, "delonet-dotenv")); } });
  register("foreign-pm");

  // -- the identity file --------------------------------------------------------
  repoFor("noid-pm"); seedProfile("noid-pm", { links: ownLinks("noid-pm"), identity: null }); register("noid-pm");
  repoFor("idlink-pm"); seedProfile("idlink-pm", { links: ownLinks("idlink-pm"), identity: null });
  symlinkSync(join(profilesRoot, "clean-pm", "profile.yaml"), join(profilesRoot, "idlink-pm", "profile.yaml")); register("idlink-pm");
  repoFor("idbad-pm"); seedProfile("idbad-pm", { links: ownLinks("idbad-pm"), identityText: "- a\n- list\n" }); register("idbad-pm");
  repoFor("idunknown-pm"); seedProfile("idunknown-pm", { links: ownLinks("idunknown-pm"), identity: { name: "idunknown-pm", description: SECRET_SENTINEL, mystery: 1 } }); register("idunknown-pm");
  repoFor("idconfig-pm"); seedProfile("idconfig-pm", { links: ownLinks("idconfig-pm"), identity: { name: "idconfig-pm", config: { inherit_from: "default", save_mode: "delta" } } }); register("idconfig-pm");
  repoFor("idname-pm"); seedProfile("idname-pm", { links: ownLinks("idname-pm"), identity: { name: "somebody-else" } }); register("idname-pm");
  repoFor("iddisplay-pm"); seedProfile("iddisplay-pm", { links: ownLinks("iddisplay-pm"), identity: { display_name: "Somebody Else" } }); register("iddisplay-pm");

  // -- the role directory ------------------------------------------------------
  // A row with no role_dir: the canonical default applies, so a link into
  // another agent's runtime is still misowned. A row with neither: the links
  // are unverifiable, said so, never silently ok.
  repoFor("norole-pm"); seedProfile("norole-pm", { links: { "SOUL.md": join(RUNTIMES["clean-pm"], "SOUL.md"), memories: join(RUNTIMES["norole-pm"], "memories") } }); register("norole-pm", { role_dir: undefined });
  repoFor("noproj-pm"); seedProfile("noproj-pm", { links: ownLinks("noproj-pm") }); register("noproj-pm", { role_dir: undefined, project_path: undefined });

  // -- the profile root's extras ----------------------------------------------
  seedProfile("clean-pm.bak", { identity: null, delta: null, generated: "none", pin: null, skills: null, lock: false });
  symlinkSync(join(fleetHome, "config.yaml"), join(profilesRoot, "clean-pm.bak", "config.yaml"));
  seedProfile("clean_pm", { identity: null, pin: null, skills: null, lock: false });
  seedProfile("oldtopo", { identity: null, generated: "none", skills: null, lock: false });
  symlinkSync(join(fleetHome, "config.yaml"), join(profilesRoot, "oldtopo", "config.yaml"));
  mkdirSync(join(outside, "linked-profile"), { recursive: true });
  writeFileSync(join(outside, "linked-profile", "config.yaml"), "x: 1\n", "utf8");
  symlinkSync(join(outside, "linked-profile"), join(profilesRoot, "linked"));
  mkdirSync(join(profilesRoot, "standalone"), { recursive: true });
  writeFileSync(join(profilesRoot, "standalone", "config.yaml"), GENERATED_HEADER + "x: 1\n", "utf8");
  writeFileSync(join(profilesRoot, "stray.txt"), "a stray file\n", "utf8");
  mkdirSync(join(profilesRoot, "empty"), { recursive: true });
  symlinkSync(join(profilesRoot, "no-such-target"), join(profilesRoot, "dangling"));
  seedProfile("fleet-bloodbank-gateway", { identity: { name: "fleet-bloodbank-gateway", role: "gateway" }, pin: { bank_id: "agent-fleet-bloodbank-gateway" }, skills: null, lock: false });
  seedProfile("unmanaged", { identity: null, pin: { bank_id: "agent-unmanaged" }, skills: null, lock: false });

  // A user unit naming one extra entry's directory as its HERMES_HOME.
  writeFileSync(join(scratchHome, ".config", "systemd", "user", "hermes-fleet-bloodbank-gateway.service"), [
    "[Service]",
    `Environment=HERMES_HOME=${join(profilesRoot, "fleet-bloodbank-gateway")}`,
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(scratchHome, ".config", "systemd", "user", "hermes-standalone-gateway.service"), [
    "[Service]",
    `Environment=HERMES_HOME=${join(profilesRoot, "standalone")}/`,
    "",
  ].join("\n"), "utf8");
  // A unit that is itself a link (systemctl link, a dotfiles manager) is read
  // through the link; a line assigning more than one variable names the first.
  mkdirSync(join(outside, "units"), { recursive: true });
  writeFileSync(join(outside, "units", "hermes-unmanaged.service"), ["[Service]", `Environment=HERMES_HOME=${join(profilesRoot, "unmanaged")}`, ""].join("\n"), "utf8");
  symlinkSync(join(outside, "units", "hermes-unmanaged.service"), join(scratchHome, ".config", "systemd", "user", "hermes-unmanaged.service"));
  writeFileSync(join(scratchHome, ".config", "systemd", "user", "hermes-linked.service"), ["[Service]", `Environment=HERMES_HOME=${join(profilesRoot, "linked")} HERMES_PROFILE=linked`, ""].join("\n"), "utf8");

  writeAgentRegistry(join(fleetHome, "agents-registry.yaml"));
  writeProjectRegistry(join(scratchHome, ".config", "pjangler", "projects.yaml"));
  writeFileSync(join(scratchHome, ".config", "hermes-agent-template", "config.toml"), [
    "[fleet]",
    `hermes_bin = "${join(release, "hermes")}"`,
    `hermes_repo = "${join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc")}"`,
    `hermes_git_url = "${HERMES_REMOTE}"`,
    'hermes_git_ref = "main"',
    `hermes_git_sha = "${"0".repeat(40)}"`,
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(fleetHome, "fleet.env"), [
    `HERMES_FLEET_HOME=${fleetHome}`,
    `HERMES_FLEET_BIN=${join(release, "hermes")}`,
    "HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/agents-registry.yaml",
    `PLANE_33GOD_API_KEY=${SECRET_SENTINEL}`,
    "",
  ].join("\n"), "utf8");
}

function agentRow(name, overrides = {}) {
  const slug = name.replace(/-pm$/u, "");
  return {
    repo: slug,
    role: "pm",
    display_name: `${slug} PM`,
    project_path: join(reposRoot, slug),
    role_dir: join(reposRoot, slug, "agents", "hermes", "pm"),
    profile_name: name,
    provisioned_at: "2026-01-01T00:00:00.000Z",
    plane: { workspace: "suite", project_id: `board-${slug}`, identifier: slug.toUpperCase() },
    bloodbank: { enabled: false, gateway_scope: "fleet", target_agent_id: name },
    systemd: { gateway_unit: `hermes-${name}-gateway.service` },
    hermes: {
      bin: join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc", "bin", "hermes"),
      repo: join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc"),
      fleet_env: join(fleetHome, "fleet.env"),
      git_url: HERMES_REMOTE,
      git_ref: "main",
      git_sha: "0".repeat(40),
    },
    ...overrides,
  };
}

function writeAgentRegistry(path, agentList = AGENTS) {
  const agents = {};
  for (const { name, rowOverrides } of agentList) agents[name] = agentRow(name, rowOverrides);
  writeFileSync(path, YAML.stringify({
    schema_version: 1,
    gateways: { bloodbank: { scope: "fleet", profile_name: "fleet-bloodbank-gateway", command_subject: "bloodbank.cmd.agent.invocation.start", target_field: "data.target_agent_id", systemd_unit: "hermes-fleet-bloodbank-gateway.service" } },
    agents,
  }), "utf8");
  return path;
}

function writeProjectRegistry(path, agentList = AGENTS) {
  const projects = {};
  for (const { name } of agentList) {
    const slug = name.replace(/-pm$/u, "");
    projects[slug] = {
      name: slug, slug, repo_path: join(reposRoot, slug), status: "active",
      ticket_provider: { type: "plane", workspace: "suite", identifier: slug.toUpperCase(), board_id: `board-${slug}` },
    };
  }
  writeFileSync(path, YAML.stringify({ schema_version: 1, projects }), "utf8");
  return path;
}

const isolation = {
  HOME: scratchHome,
  XDG_CONFIG_HOME: join(scratchHome, ".config"),
  XDG_DATA_HOME: join(scratchHome, ".local", "share"),
  XDG_STATE_HOME: join(scratchHome, ".local", "state"),
  XDG_CACHE_HOME: join(scratchHome, ".cache"),
  HERMES_FLEET_HOME: fleetHome,
  HERMES_AGENTS_REGISTRY: join(fleetHome, "agents-registry.yaml"),
  HERMES_FLEET_REGISTRY_FILE: join(fleetHome, "agents-registry.yaml"),
  HERMES_FLEET_ENV: join(fleetHome, "fleet.env"),
  HERMES_TEMPLATE_CONFIG: join(scratchHome, ".config", "hermes-agent-template", "config.toml"),
  PJ_PROJECT_REGISTRY: join(scratchHome, ".config", "pjangler", "projects.yaml"),
  HERMES_TEMPLATE_RUNTIME_SCAFFOLD: join(fleetHome, "runtime-scaffold"),
  RUNTIME_SCAFFOLD_DIR: join(fleetHome, "runtime-scaffold"),
  CANONICAL_SKILLS_DIR: undefined,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  // Git does its own housekeeping — auto-gc, repack, commit-graph,
  // multi-pack-index — on a schedule it decides, and it rewrites `.git/objects`
  // when it does. `snapshotTree` digests every path under the protected roots,
  // `.git` included, so a repack triggered by a child's ordinary `git` call
  // reads as "the CLI wrote to a protected root" and fails a case that has
  // nothing to do with it. It never fires on this box (the submodule is already
  // packed) and always fires in CI, where a fresh clone plus `npm pack` leaves
  // enough loose objects to cross the gc threshold — which is why CI has been
  // red since 2026-09-02 while every local run was green. Turn the housekeeping
  // off rather than stop watching `.git`: the guard keeps its teeth.
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  // TMPDIR can itself sit inside a git work tree on this machine, which would
  // make an unrelated checkout answer for every scratch repository below.
  GIT_CEILING_DIRECTORIES: realpathSync(temp),
  TMPDIR: temp,
  NO_COLOR: "1",
  // Present in the PARENT's environment so the narrow child environments have
  // something to exclude; never allowed to reach any output.
  PLANE_33GOD_API_KEY: SECRET_SENTINEL,
};

// ---------------------------------------------------------------------------
// Package roots: the build relocated beside a template it pins
// ---------------------------------------------------------------------------

const TRACKED_TEXT = readFileSync(TRACKED_CONTRACT, "utf8");

function contractDocument() {
  return YAML.parse(TRACKED_TEXT);
}

function writeContract(name, document) {
  const path = join(temp, `contract-${name}.yaml`);
  writeFileSync(path, YAML.stringify(document, { lineWidth: 0 }), "utf8");
  return path;
}

/** The tracked contract, mutated. */
function policyContract(mutate = () => {}) {
  const document = contractDocument();
  // This suite opts into a byte-policy. The shipped default has no mandatory
  // global projection; Node activation parity is checked independently.
  document.profile_manifest.skill_core.required = [...CORE_SKILLS];
  mutate(document);
  return document;
}

/**
 * A relocated package root whose `templates/hermes-agent` is a clone of the
 * synthetic template (carrying the REAL renderer bytes), with the gitlink
 * COMMITTED in the root. `after` may then break it in whichever way a case needs.
 */
function makePackageRoot(name, contractText, { after = () => {} } = {}) {
  const root = join(temp, name);
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "contracts"), { recursive: true });
  cpSync(CLI, join(root, "dist", "index.js"));
  cpSync(MCP, join(root, "dist", "mcp-server.js"));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "flume-fixture", version: "0.0.0", type: "module" }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "contracts", "handbook.yaml"), contractText, "utf8");

  const submodule = join(root, "templates", "hermes-agent");
  gitOk(root, ["clone", "--quiet", "--no-hardlinks", templateSource, submodule]);
  gitOk(submodule, ["checkout", "--quiet", TEMPLATE_HEAD]);
  gitOk(submodule, ["remote", "set-url", "origin", TEMPLATE_REMOTE]);
  writeFileSync(join(root, ".gitmodules"), ['[submodule "templates/hermes-agent"]', "\tpath = templates/hermes-agent", `\turl = ${TEMPLATE_REMOTE}`, ""].join("\n"), "utf8");
  gitOk(root, ["init", "--quiet"]);
  gitOk(root, ["add", ".gitmodules", "templates/hermes-agent"]);
  const staged = git(root, ["ls-files", "--stage", "--", "templates/hermes-agent"]).stdout;
  assert.match(staged, new RegExp(`^160000 ${TEMPLATE_HEAD} 0\t`, "u"), `the fixture root must stage the gitlink at ${TEMPLATE_HEAD}, got ${JSON.stringify(staged)}`);
  gitOk(root, ["commit", "--quiet", "-m", "pin the template"]);
  after(root, submodule);
  return root;
}

// ---------------------------------------------------------------------------
// Zero-write proof and the CLI runner
// ---------------------------------------------------------------------------

function snapshotTree(label, root, entries = {}) {
  if (!existsSync(root)) { entries[`${label}:<absent>`] = "absent"; return entries; }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      const key = `${label}:${relative(root, path)}`;
      const stat = lstatSync(path);
      if (entry.isSymbolicLink()) { entries[key] = `link:${readlinkSync(path)}:${stat.mtimeMs}`; continue; }
      if (entry.isDirectory()) { entries[key] = `dir:${stat.mtimeMs}`; walk(path); continue; }
      if (!entry.isFile()) { entries[key] = `other:${stat.mode}:${stat.mtimeMs}`; continue; }
      let digest;
      try { digest = createHash("sha256").update(readFileSync(path)).digest("hex"); }
      catch { digest = `unreadable:${stat.mode}:${stat.size}`; }
      entries[key] = `${digest}:${stat.mtimeMs}`;
    }
  };
  walk(root);
  return entries;
}

/** The scratch tree -- every profile, registry, repository and package root -- plus the tracked contract. */
function snapshotIsolated() {
  const entries = {};
  snapshotTree("temp", temp, entries);
  snapshotTree("contracts", join(ROOT, "contracts"), entries);
  return entries;
}

const FOREIGN_SCRATCH = /^\.(pjan|fleet|notebook|momo|project)-/u;

/** This repository's staged content, the submodule's status, and top-level direntries, asserted once for the suite. */
function snapshotShared() {
  const entries = {};
  for (const repo of [ROOT, SUBMODULE]) {
    if (!existsSync(join(repo, ".git"))) { entries[`staged:${repo}`] = "absent"; continue; }
    const listed = git(repo, ["--no-optional-locks", "ls-files", "--stage"]);
    entries[`staged:${repo}`] = listed.status === 0 ? createHash("sha256").update(listed.stdout).digest("hex") : `unreadable:${listed.status}`;
  }
  const porcelain = git(SUBMODULE, ["--no-optional-locks", "status", "--porcelain"]);
  entries["submodule:porcelain"] = porcelain.status === 0 ? porcelain.stdout : `unreadable:${porcelain.status}`;
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (FOREIGN_SCRATCH.test(entry.name)) continue;
    entries[`root:${entry.name}`] = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
  }
  return entries;
}

function assertUnchanged(before, after, what) {
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]);
  for (const key of changed) console.log(`       ${key}: ${before[key] ?? "<missing>"} -> ${after[key] ?? "<missing>"}`);
  assert.fail(`${what} wrote to a protected root: ${changed.join(", ")}`);
}

/** Run the CLI shipped INSIDE a package root, and prove the run wrote nothing. */
function cliAt(packageRoot, args, extraEnv = {}, cwd = workdir) {
  const before = snapshotIsolated();
  const result = spawnSync(process.execPath, [join(packageRoot, "dist", "index.js"), ...args], {
    cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...isolation, ...extraEnv },
  });
  assertUnchanged(before, snapshotIsolated(), `fixture pj ${args.join(" ")}`);
  return result;
}

function envelope(result) {
  assert.notEqual(result.stdout, "", "stdout was empty; a passing assertion on empty output proves nothing");
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { assert.fail(`stdout is not one complete JSON document (${result.stdout.length} bytes): ${error.message}`); }
  assert.equal(parsed.schema_version, 1, "envelope schema_version");
  return parsed;
}

function errorCode(parsed) {
  assert.equal(parsed.ok, false, `expected a failure envelope, got ok:true with totals ${JSON.stringify(parsed.data?.totals)}`);
  assert.notEqual(parsed.error, null, "a failure envelope must carry an error");
  assert.equal(parsed.data, null, "a failure envelope must carry no data");
  return parsed.error.code;
}

function status(result) {
  const parsed = envelope(result);
  assert.equal(parsed.ok, true, `expected ok:true, got ${JSON.stringify(parsed.error)}`);
  assert.equal(parsed.command, "fleet.status");
  for (const key of DATA_KEYS) assert.notEqual(parsed.data[key], undefined, `data.${key} must be present`);
  for (const finding of parsed.data.findings) {
    // A dotted contract path, not a source id. Checked by SHAPE rather than by
    // "contains no hyphen": story 1.8 made `units.hermes-{agent_id}-gateway.service`
    // a declared leaf, so hyphens no longer separate a path from an id. What
    // still separates them is the ROOT: a contract path's first segment is a
    // plain identifier followed by a dot or nothing at all (`scaffold`,
    // `units.…`, `agents.…`), while every source id this guard exists to catch
    // (`recipe-audit`, `fleet-systemd`) is hyphenated at its root.
    assert.match(finding.field, /^[a-z_]+(?:\.|$)/u, `a finding's field must be a contract path, not a source id: ${finding.field}`);
  }
  return parsed.data;
}

function agentNamed(data, id) {
  const found = data.agents.find((agent) => agent.agent_id === id);
  assert.ok(found, `agent ${id} must be in data.agents (have ${data.agents.map((a) => a.agent_id).join(", ")})`);
  return found;
}

/** The observer's observation for one declared leaf on one agent record. */
function fieldOf(agent, field) {
  const found = agent.observations.find((item) => item.source === "fleet-profile" && item.field === field);
  assert.ok(found, `${agent.agent_id} must carry the ${field} observation`);
  return found;
}

function itemsOf(observation) {
  return observation.items ?? [];
}

function kindsOf(observation) {
  return itemsOf(observation).map((item) => item.kind);
}

function hostNamed(data, ruleId) {
  const found = data.host.find((finding) => finding.rule_id === ruleId);
  assert.ok(found, `data.host must carry ${ruleId} (have ${data.host.map((f) => f.rule_id).join(", ")})`);
  return found;
}

function textOf(value) {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Injected audit entries and PATH shims
// ---------------------------------------------------------------------------

function entry(name, body) {
  const dir = join(shimRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "entry.mjs");
  writeFileSync(path, body, "utf8");
  return path;
}

function syntheticReport(rules) {
  return `
const rules = ${JSON.stringify(rules)};
const report = {
  repo: process.argv[3] ?? "",
  ok: rules.every((rule) => !(rule.status === "fail" && rule.scope !== "host")),
  hostOk: true,
  auditedAt: new Date().toISOString(),
  rules,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
process.exit(report.ok ? 0 : 1);
`;
}

const SINGLETON_RULE_PASS = { id: "hermes.runtime-singleton", title: "Singleton runtime", status: "pass", summary: "singleton runtime contract satisfied", details: [], fixable: true, scope: "project" };
const SINGLETON_RULE_FAIL = { id: "hermes.runtime-singleton", title: "Singleton runtime", status: "fail", summary: "1 singleton issue(s)", details: ["config.delta.yaml missing — profile is not under base+delta inheritance: x"], fixable: true, scope: "project" };
const SINGLETON_RULE_OTHER_FAIL = { id: "hermes.runtime-singleton", title: "Singleton runtime", status: "fail", summary: "1 singleton issue(s)", details: ["shared seed missing: auth.json"], fixable: true, scope: "project" };
const SINGLETON_RULE_SYMLINK = { id: "hermes.runtime-singleton", title: "Singleton runtime", status: "fail", summary: "1 singleton issue(s)", details: ["profile dir is a symlink (must be a real dir): x"], fixable: true, scope: "project" };
const SINGLETON_RULE_WRONG_TARGET = { id: "hermes.runtime-singleton", title: "Singleton runtime", status: "fail", summary: "1 singleton issue(s)", details: ["wrong-target: x/SOUL.md -> y/runtime/SOUL.md"], fixable: true, scope: "project" };
const PROFILE_WIRING_WARN = { id: "hermes.profile-wiring", title: "Hermes profile wiring", status: "warn", summary: "the shared profile root is wired unusually", details: [], fixable: false, scope: "host" };

/** A PATH whose only `python3` is a script of the caller's choosing (or none), with a real `git` beside it. */
function pathShim(name, python3Body) {
  const dir = join(shimRoot, `path-${name}`);
  mkdirSync(dir, { recursive: true });
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realGit, "git must be on PATH");
  if (!existsSync(join(dir, "git"))) symlinkSync(realGit, join(dir, "git"));
  if (python3Body !== null) {
    writeFileSync(join(dir, "python3"), python3Body, "utf8");
    chmodSync(join(dir, "python3"), 0o755);
  }
  return dir;
}

/**
 * A SECOND home with one clean registered profile, so a case can put the
 * fleet home or the profile root behind a symlink without touching the main
 * fixture. The real directories live beside the link; the base, the canonical
 * projection (shared with the main fixture) and the registries are all there.
 */
function makeAltHome(name, { hermesIsLink = false, profilesIsLink = false } = {}) {
  const home = join(temp, name);
  const realFleet = hermesIsLink ? join(home, "real-hermes") : join(home, ".hermes");
  const realProfiles = profilesIsLink ? join(realFleet, "real-profiles") : join(realFleet, "profiles");
  mkdirSync(realProfiles, { recursive: true });
  mkdirSync(join(home, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(home, ".config", "hermes-agent-template"), { recursive: true });
  mkdirSync(join(home, ".agents"), { recursive: true });
  symlinkSync(canonicalSkills, join(home, ".agents", "skills"));
  writeFileSync(join(realFleet, "config.yaml"), BASE_TEXT, "utf8");
  if (hermesIsLink) symlinkSync(realFleet, join(home, ".hermes"));
  if (profilesIsLink) symlinkSync(realProfiles, join(realFleet, "profiles"));
  const fleet = join(home, ".hermes");
  const repo = makeRepo(`${name}-solo`);
  seedProfile("solo-pm", { root: realProfiles, links: { "SOUL.md": join(repo.runtime, "SOUL.md"), memories: join(repo.runtime, "memories") } });
  const rows = [{ name: "solo-pm", rowOverrides: { repo: `${name}-solo`, project_path: repo.dir, role_dir: repo.roleDir } }];
  writeAgentRegistry(join(realFleet, "agents-registry.yaml"), rows);
  writeProjectRegistry(join(home, ".config", "pjangler", "projects.yaml"), rows);
  cpSync(join(scratchHome, ".config", "hermes-agent-template", "config.toml"), join(home, ".config", "hermes-agent-template", "config.toml"));
  const env = {
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), HERMES_FLEET_HOME: fleet,
    HERMES_AGENTS_REGISTRY: join(fleet, "agents-registry.yaml"), HERMES_FLEET_REGISTRY_FILE: join(fleet, "agents-registry.yaml"),
    HERMES_FLEET_ENV: join(fleet, "no-fleet.env"), HERMES_TEMPLATE_CONFIG: join(home, ".config", "hermes-agent-template", "config.toml"),
    PJ_PROJECT_REGISTRY: join(home, ".config", "pjangler", "projects.yaml"),
  };
  return { home, fleet, realProfiles, env };
}

const STATUS_ARGS = ["review", "--domain", "profile", "--json"];

console.log("fleet profile health: every registered profile gated, read and proven; every extra classified");

try {
  if (!existsSync(CLI) || !existsSync(MCP)) {
    skip("the whole suite", "dist/ is not built; run `npm run build` first");
    throw new SkipCase("unbuilt");
  }
  // Renderer-dependent cases skip INDIVIDUALLY, each printing its skip, when
  // no python3 with PyYAML at 3.11 or newer is on PATH; the contract,
  // registration, scoping, gate-code and extras cases run regardless.
  const python = spawnSync("python3", ["-B", "-c", "import sys\nif sys.version_info < (3, 11):\n    sys.exit(3)\ntry:\n    import yaml\nexcept Exception:\n    sys.exit(4)\nsys.exit(0)\n"], { encoding: "utf8" });
  const RENDERER_AVAILABLE = python.status === 0;
  const requireRenderer = (label) => { if (!RENDERER_AVAILABLE) skipCase(label, "python3 with PyYAML at 3.11 or newer is not on PATH; the canonical renderer cannot run"); };
  seedTemplate();
  seedFleet();
  git(ROOT, ["update-index", "--refresh"]);
  const sharedAtStart = snapshotShared();

  const mainRoot = makePackageRoot("pkg-main", YAML.stringify(policyContract(), { lineWidth: 0 }));
  const REGISTERED = AGENTS.length;

  // -- AC1: the path gate ------------------------------------------------------

  check("a symlinked, missing, file, case-colliding or unsafely named profile fails the gate and nothing beneath is read", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    for (const [id, code] of [["symlink-pm", "symlink"], ["missing-pm", "missing"], ["file-pm", "not-a-directory"], ["twin-pm", "case-collision"], ["unsafe-pm", "name-unsafe"]]) {
      const agent = agentNamed(data, id);
      const path = fieldOf(agent, FIELDS.path);
      assert.equal(path.state, "fail", `${id}: the gate is a fail, never an error`);
      assert.equal(path.observed, code, `${id}: the gate code is the observed side`);
      assert.deepEqual(kindsOf(path), [code]);
      assert.equal(path.rule_scope, "project");
      assert.equal(path.evidence, "direct");
      for (const field of [FIELDS.identity, FIELDS.config, FIELDS.bank, FIELDS.skills]) {
        const dependent = fieldOf(agent, field);
        assert.equal(dependent.state, "unobserved", `${id} ${field} is unobserved behind a failed gate`);
        assert.match(dependent.summary, new RegExp(`\\(${code}\\)`, "u"), `${id} ${field} names the gate code`);
        assert.equal(dependent.items, undefined);
      }
      assert.equal(agent.profile.path.code, code);
      assert.equal(agent.profile.renderer.state, "unobserved");
      assert.equal(agent.profile.bank.observed, null);
      // The inventory proves `installed` only where ITS lstat found a real
      // directory (twin-pm); the observer's fail then demotes healthy to
      // installed and never promotes discovered.
      assert.equal(agent.lifecycle.observed_state, id === "twin-pm" ? "installed" : "discovered", `${id}: the observer's fail demotes the lifecycle, never promotes it`);
    }
    const twin = fieldOf(agentNamed(data, "twin-pm"), FIELDS.path);
    assert.equal(itemsOf(twin)[0].detail, "case-collision:Twin-pm", "the colliding entry is named");
    assert.equal(data.profile.agents.blocked_at_path, 5);
    assert.equal(hostNamed(data, "profile.skill-core").state, "pass", "the fixture's canonical projection holds every core skill");
    // Renderer children ran only for gate-passing profiles: no probe of kind
    // profile targets a gated one with anything but `skipped`.
    for (const id of ["symlink-pm", "missing-pm", "file-pm", "twin-pm", "unsafe-pm"]) {
      const probes = data.probes.filter((probe) => probe.kind === "profile" && probe.target.endsWith(`/profiles/${id}`));
      assert.ok(probes.every((probe) => probe.outcome === "skipped"), `${id}: ${JSON.stringify(probes)}`);
    }
    if (RENDERER_AVAILABLE) assert.equal(data.probes.find((probe) => probe.kind === "profile" && probe.target.endsWith("/profiles/clean-pm")).outcome, "ok", "the clean profile's renderer probe ran");
  });

  check("a clean profile reads five passes, an in-sync renderer, three digests and a pinned bank", () => {
    requireRenderer("a clean profile reads five passes, an in-sync renderer, three digests and a pinned bank");
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const agent = agentNamed(data, "clean-pm");
    const fields = agent.observations.filter((item) => item.source === "fleet-profile");
    assert.deepEqual(fields.map((item) => item.field), FIELD_ORDER, "five observations, one per declared leaf, in byte order");
    for (const field of fields) {
      assert.equal(field.state, "pass", `${field.field} must pass on a clean profile: ${JSON.stringify(field.items)}`);
      // Informational items may ride a pass on the skills field only: the
      // base's relative `./agents/skills` entry is recorded as unresolvable.
      if (field.field === FIELDS.skills) assert.deepEqual(kindsOf(field), ["source-unresolvable"], "the relative external_dirs entry is recorded, never resolved");
      else assert.equal(field.items, undefined, `${field.field} carries no items key on a pass`);
      assert.equal(field.rule_id, null);
      assert.equal(field.evidence, "direct");
      assert.equal(field.justification, null);
    }
    assert.equal(fieldOf(agent, FIELDS.config).owner, "runtime-template");
    // All three used to answer `hermes-agent-template` against the renderer's
    // `hermes-profile-renderer`. Both were names for the same submodule, and the
    // profile tree is one authority now, so every leaf answers the same owner.
    assert.equal(fieldOf(agent, FIELDS.identity).owner, "runtime-template");
    assert.equal(fieldOf(agent, FIELDS.bank).owner, "runtime-template");
    assert.equal(fieldOf(agent, FIELDS.skills).owner, "runtime-template");
    // One block owns the whole profile tree since the 2026-09-22 trim, so the
    // directory resolves outright instead of by namespace majority.
    assert.equal(fieldOf(agent, FIELDS.path).owner, "runtime-template", "the directory resolves to the one profile-tree authority");
    assert.equal(agent.profile.renderer.state, "in-sync");
    assert.deepEqual(agent.profile.renderer.sections, []);
    for (const side of ["base", "delta", "generated"]) assert.match(agent.profile.digests[side], /^[0-9a-f]{12}$/u, `${side} digest`);
    assert.equal(agent.profile.digests.base, sha256Prefix(Buffer.from(BASE_TEXT, "utf8")));
    assert.deepEqual(agent.profile.bank, { observed: "agent-clean-pm", expected: "agent-clean-pm", state: "pass", code: null });
    assert.deepEqual(agent.profile.skills, { state: "pass", core_present: 6, core_missing: [], extra: [], sources_unresolvable: 1 });
    assert.deepEqual(agent.profile.identity, { state: "pass", keys: ["display_name", "name"] });
    assert.equal(agent.domains.profile, "unobserved", "without --live the audit half is still unread");
    assert.equal(agent.lifecycle.observed_state, "healthy", "a clean profile keeps the lifecycle the inventory proved");
  });

  check("a misowned singleton link is a path fail after the gate, and the dependents are still observed", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const agent = agentNamed(data, "misowned-pm");
    const path = fieldOf(agent, FIELDS.path);
    assert.equal(path.state, "fail");
    assert.deepEqual(itemsOf(path).map((item) => [item.path, item.kind, item.detail]), [["SOUL.md", "misowned-link", "misowned-link:SOUL.md"]]);
    assert.equal(agent.profile.path.code, "misowned-link");
    if (RENDERER_AVAILABLE) assert.equal(fieldOf(agent, FIELDS.config).state, "pass", "the gate passed, so the config was still proven");
    assert.equal(fieldOf(agent, FIELDS.bank).state, "pass");
    assert.equal(textOf(agent).includes(SECRET_SENTINEL), false, "the other agent's memory was never read");

    // No role_dir on the row: the canonical default <project_path>/agents/hermes/<role> judges the links.
    const norole = agentNamed(data, "norole-pm");
    assert.equal(norole.profile.path.code, "misowned-link", "the default role directory still catches a link into another agent's runtime");
    assert.deepEqual(itemsOf(fieldOf(norole, FIELDS.path)).map((item) => item.detail), ["misowned-link:SOUL.md"]);
    // Neither role_dir nor project_path: the links exist and nothing can judge them.
    const noproj = agentNamed(data, "noproj-pm");
    const noprojPath = fieldOf(noproj, FIELDS.path);
    assert.equal(noprojPath.state, "warn");
    assert.deepEqual(kindsOf(noprojPath), ["unverifiable", "unverifiable"]);
    assert.deepEqual(itemsOf(noprojPath).map((item) => item.detail).sort(), ["unverifiable:SOUL.md", "unverifiable:memories"]);
    assert.equal(noproj.profile.path.code, "unverifiable");
    assert.equal(fieldOf(noproj, FIELDS.bank).state, "pass", "an unverifiable link does not block the dependents");
    assert.equal(noproj.healthy, true, "a warn is not a proven failure");
  });

  // -- AC2: the generated config through the canonical renderer ------------

  check("a config rendered from an older base is semantic drift naming the section; a base edit flips a clean profile the same way", () => {
    requireRenderer("a config rendered from an older base is semantic drift naming the section; a base edit flips a clean profile the same way");
    const first = status(cliAt(mainRoot, STATUS_ARGS));
    const stale = agentNamed(first, "stale-pm");
    const config = fieldOf(stale, FIELDS.config);
    assert.equal(config.state, "fail");
    assert.deepEqual(itemsOf(config), [{ path: "config.yaml", kind: "semantic-drift", desired: "deep_merge(base, delta)", observed: "section model", detail: "model", wip: false }]);
    assert.equal(stale.profile.renderer.state, "drifted");
    assert.deepEqual(stale.profile.renderer.sections, ["model"]);
    assert.equal(fieldOf(stale, FIELDS.bank).state, "pass", "drift in the config says nothing about the pin");
    assert.equal(fieldOf(agentNamed(first, "clean-pm"), FIELDS.config).state, "pass");
    assert.equal(first.probes.find((probe) => probe.kind === "profile" && probe.target.endsWith("/profiles/stale-pm")).reason, "drifted");

    // The base edited in ONE section: every in-sync profile now drifts there.
    const original = readFileSync(join(fleetHome, "config.yaml"));
    writeFileSync(join(fleetHome, "config.yaml"), YAML.stringify({ ...baseConfig(), mcp_servers: { hindsight: { command: "hindsight-mcp-v2" } } }), "utf8");
    try {
      const second = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"]));
      const clean = agentNamed(second, "clean-pm");
      assert.equal(fieldOf(clean, FIELDS.config).state, "fail");
      assert.deepEqual(kindsOf(fieldOf(clean, FIELDS.config)), ["semantic-drift"]);
      assert.deepEqual(clean.profile.renderer.sections, ["mcp_servers"]);
      assert.notEqual(clean.profile.digests.base, agentNamed(first, "clean-pm").profile.digests.base, "the base digest moved");
      assert.equal(clean.profile.digests.generated, agentNamed(first, "clean-pm").profile.digests.generated, "the generated digest did not");
      assert.equal(second.profile.renderer.drifted, 1);
      assert.equal(clean.lifecycle.observed_state, "installed", "a proven config failure demotes healthy to installed");
    } finally {
      writeFileSync(join(fleetHome, "config.yaml"), original);
    }
    const third = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"]));
    assert.equal(fieldOf(agentNamed(third, "clean-pm"), FIELDS.config).state, "pass", "restored, the base proves in sync again");
    // No digest of the drifted value, no body, no value anywhere.
    assert.equal(first.agents.some((agent) => textOf(agent).includes("fleet-model")), false, "a config value reached the payload");
    assert.equal(textOf(first).includes("hindsight-mcp"), false, "a config value reached the payload");
  });

  check("a symlinked generated config, a missing marker and a missing delta are their own kinds and the renderer is not spawned for them", () => {
    requireRenderer("a symlinked generated config, a missing marker and a missing delta are their own kinds and the renderer is not spawned for them");
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const gensym = agentNamed(data, "gensym-pm");
    assert.deepEqual(kindsOf(fieldOf(gensym, FIELDS.config)), ["generated-symlink"]);
    assert.equal(fieldOf(gensym, FIELDS.config).state, "fail");
    assert.equal(gensym.profile.renderer.state, "fail");
    assert.equal(gensym.profile.digests.generated, null, "a symlink is never read");
    assert.equal(data.probes.find((probe) => probe.kind === "profile" && probe.target.endsWith("/profiles/gensym-pm")).outcome, "skipped");

    const marker = agentNamed(data, "marker-pm");
    assert.deepEqual(kindsOf(fieldOf(marker, FIELDS.config)), ["marker-missing"]);
    assert.equal(marker.profile.renderer.state, "in-sync", "the renderer compares parsed dicts and still runs for a marker-less regular file");
    assert.equal(fieldOf(marker, FIELDS.config).state, "fail");
    assert.notEqual(fieldOf(marker, FIELDS.config).observed, "in-sync", "an in-sync merge beside a marker-less file is not reported as in-sync");
    assert.doesNotMatch(fieldOf(marker, FIELDS.config).summary, /equals deep_merge/u);

    // Override-only means override-only: a frozen copy of the generated file
    // and a copy of the base both merge clean and both fail the delta.
    const frozen = agentNamed(data, "frozen-pm");
    assert.deepEqual(itemsOf(fieldOf(frozen, FIELDS.config)).map((item) => [item.path, item.kind, item.detail]), [["config.delta.yaml", "delta-not-override-only", "generated-marker"]]);
    assert.equal(fieldOf(frozen, FIELDS.config).state, "fail");
    assert.equal(frozen.profile.renderer.state, "in-sync", "the renderer still ran and still found the merge in sync");
    const basecopy = agentNamed(data, "basecopy-pm");
    assert.deepEqual(itemsOf(fieldOf(basecopy, FIELDS.config)).map((item) => [item.kind, item.detail]), [["delta-not-override-only", "equals-base"]]);
    assert.equal(textOf(basecopy).includes("fleet-model"), false, "the delta was parsed for equality only; no value reaches the payload");

    const nodelta = agentNamed(data, "nodelta-pm");
    assert.deepEqual(kindsOf(fieldOf(nodelta, FIELDS.config)), ["delta-missing"]);
    assert.equal(nodelta.profile.renderer.state, "fail");
    assert.equal(nodelta.profile.digests.delta, null);
    assert.equal(data.probes.find((probe) => probe.kind === "profile" && probe.target.endsWith("/profiles/nodelta-pm")).outcome, "skipped");
    assert.equal(data.profile.renderer.checked, data.profile.renderer.in_sync + data.profile.renderer.drifted + data.profile.renderer.failed + data.profile.renderer.timeout);
  });

  // -- AC3: renderer integrity -----------------------------------------------

  check("a worktree renderer edited by one byte is renderer-source-mismatched, every config field errors, and no python3 is spawned", () => {
    const root = makePackageRoot("pkg-mismatched", YAML.stringify(policyContract(), { lineWidth: 0 }), {
      after: (packageRoot, submodule) => {
        writeFileSync(join(submodule, RENDERER_REL), Buffer.concat([RENDERER_BYTES, Buffer.from("\n")]));
      },
    });
    const recorder = join(shimRoot, "python3-invocations.log");
    rmSync(recorder, { force: true });
    const realPython = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    const shim = pathShim("recording", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${recorder}"\nexec "${realPython}" "$@"\n`);
    const data = status(cliAt(root, STATUS_ARGS, { PATH: `${shim}:${process.env.PATH}` }));
    const renderer = hostNamed(data, "profile.renderer");
    assert.equal(renderer.state, "error");
    assert.equal(renderer.observed, "renderer-source-mismatched");
    assert.equal(renderer.domain, "profile");
    assert.equal(renderer.owner, "runtime-template");
    assert.equal(data.profile.renderer.source, "renderer-source-mismatched");
    assert.equal(data.profile.renderer.python, "not-probed");
    assert.equal(data.profile.renderer.gitlink, TEMPLATE_HEAD, "the committed gitlink is still reported; the worktree is what is wrong");
    for (const agent of data.agents) {
      if (agent.profile.path.state !== "pass") continue;
      const config = fieldOf(agent, FIELDS.config);
      assert.equal(config.state, "error", `${agent.agent_id} config must be error behind a broken renderer`);
      assert.ok(kindsOf(config).includes("renderer-unavailable"), `${agent.agent_id}: ${JSON.stringify(config.items)}`);
      assert.equal(itemsOf(config).find((item) => item.kind === "renderer-unavailable").detail, "renderer-source-mismatched");
      assert.equal(agent.profile.renderer.state, "error");
      assert.equal(fieldOf(agent, FIELDS.bank).state === "unobserved", false, "the pin is still read; only the renderer is withheld");
    }
    assert.equal(existsSync(recorder), false, "no child named python3 was spawned");
    assert.equal(data.probes.filter((probe) => probe.kind === "profile" && probe.outcome === "ok").length, 0, "zero successful profile probes behind a mismatched renderer");
    assert.equal(data.probes.some((probe) => probe.kind === "profile" && probe.target === "python3"), false, "the interpreter was not even probed");
    assert.equal(data.profile.agents.incomplete, data.profile.agents.real, "every real profile is incomplete, none drifted");
    assert.notEqual(data.health.verdict, "healthy");
  });

  check("an uninitialized submodule is renderer-source-missing; a missing, old or yaml-less python is its own code", () => {
    const contract = YAML.stringify(policyContract(), { lineWidth: 0 });
    const uninitialized = makePackageRoot("pkg-uninitialized", contract, { after: (root, submodule) => { rmSync(submodule, { recursive: true, force: true }); mkdirSync(submodule); } });
    const missing = status(cliAt(uninitialized, [...STATUS_ARGS, "--agent", "clean-pm"]));
    assert.equal(missing.profile.renderer.source, "renderer-source-missing");
    assert.equal(hostNamed(missing, "profile.renderer").state, "error");
    assert.equal(fieldOf(agentNamed(missing, "clean-pm"), FIELDS.config).state, "error");

    // The probe script owns exits 3 and 4; every other status is unavailable.
    for (const [name, body, code] of [
      ["absent", null, "renderer-python-unavailable"],
      ["old", "#!/bin/sh\nexit 3\n", "renderer-python-too-old"],
      ["noyaml", "#!/bin/sh\nexit 4\n", "renderer-pyyaml-missing"],
      ["crashing", "#!/bin/sh\nexit 1\n", "renderer-python-unavailable"],
    ]) {
      const shim = pathShim(name, body);
      const data = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"], { PATH: shim }));
      assert.equal(data.profile.renderer.source, "ok", `${name}: the source is fine`);
      assert.equal(data.profile.renderer.python, code, name);
      assert.equal(hostNamed(data, "profile.renderer").state, "error", name);
      assert.equal(hostNamed(data, "profile.renderer").observed, code, name);
      const config = fieldOf(agentNamed(data, "clean-pm"), FIELDS.config);
      assert.equal(config.state, "error", name);
      assert.equal(itemsOf(config).find((item) => item.kind === "renderer-unavailable").detail, code, name);
      assert.equal(data.probes.find((probe) => probe.kind === "profile" && probe.target === "python3").reason, code, name);
    }

    // A staged-but-uncommitted pin is unstable: nothing is proven and no
    // renderer probe runs at all.
    const unstable = makePackageRoot("pkg-unstable", contract, { after: (root, submodule) => {
      gitOk(submodule, ["commit", "--quiet", "--allow-empty", "-m", "a newer template"]);
      const newer = gitOk(submodule, ["rev-parse", "HEAD"]);
      gitOk(root, ["update-index", "--cacheinfo", `160000,${newer},templates/hermes-agent`]);
    } });
    const staged = status(cliAt(unstable, [...STATUS_ARGS, "--agent", "clean-pm"]));
    assert.equal(staged.profile.renderer.source, "renderer-gitlink-unstable");
    assert.equal(staged.profile.renderer.python, "not-probed");
    assert.equal(staged.profile.renderer.gitlink, TEMPLATE_HEAD, "the COMMITTED gitlink is reported, not the staged one");
    assert.equal(hostNamed(staged, "profile.renderer").state, "error");
    assert.equal(staged.probes.filter((probe) => probe.kind === "profile" && probe.outcome === "ok").length, 0, "zero renderer probes behind an unstable pin");
    assert.equal(fieldOf(agentNamed(staged, "clean-pm"), FIELDS.config).state, "error");
  });

  check("a held profile lock is a bounded renderer-timeout for that profile, and the run still succeeds", () => {
    const label = "a held profile lock is a bounded renderer-timeout for that profile, and the run still succeeds";
    requireRenderer(label);
    if (spawnSync("sh", ["-c", "command -v flock"], { encoding: "utf8" }).status !== 0) skipCase(label, "flock is not on PATH");
    const lock = join(profilesRoot, ".clean-pm.config.lock");
    const holder = spawn("flock", [lock, "sleep", "30"], { detached: true, stdio: "ignore" });
    try {
      // Wait until the holder ACTUALLY holds the lock: `flock -n` on it fails
      // only then. A fixed sleep proves nothing on a loaded machine.
      let held = false;
      for (let attempt = 0; attempt < 100 && !held; attempt += 1) {
        held = spawnSync("flock", ["-n", lock, "true"]).status !== 0;
        if (!held) spawnSync("sh", ["-c", "sleep 0.05"]);
      }
      assert.ok(held, "the fixture holder never took the lock");
      const started = Date.now();
      const data = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"]));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 20_000, `the timeout must be bounded by the lock timeout plus a margin, took ${elapsed} ms`);
      const config = fieldOf(agentNamed(data, "clean-pm"), FIELDS.config);
      assert.equal(config.state, "error");
      assert.deepEqual(kindsOf(config), ["renderer-timeout"]);
      assert.equal(agentNamed(data, "clean-pm").profile.renderer.state, "error");
      assert.equal(data.profile.renderer.timeout, 1);
      assert.equal(data.probes.find((probe) => probe.kind === "profile" && probe.target.endsWith("/profiles/clean-pm")).outcome, "timeout");
      assert.equal(hostNamed(data, "profile.renderer").state, "pass", "a held lock is one profile's condition, not the renderer's");
    } finally {
      try { process.kill(-holder.pid, "SIGKILL"); } catch { try { holder.kill("SIGKILL"); } catch { /* gone */ } }
    }
  });

  check("a profile root under a symlink -- the fleet home or the root itself -- is a profile.root error, every field errors, and no renderer is spawned", () => {
    // DW-28: the inventory lstats the leaf only, so an ancestor symlink was
    // invisible. The root gate walks every component below the home.
    const recorder = join(shimRoot, "python3-root-invocations.log");
    rmSync(recorder, { force: true });
    const realPython = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    const shim = pathShim("recording-root", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${recorder}"\nexec "${realPython}" "$@"\n`);
    for (const [name, layout, code] of [
      ["home-hermes-link", { hermesIsLink: true }, "root-ancestor-symlink"],
      ["home-profiles-link", { profilesIsLink: true }, "root-symlink"],
    ]) {
      const alt = makeAltHome(name, layout);
      const before = snapshotTree(name, alt.home);
      const result = cliAt(mainRoot, STATUS_ARGS, { ...alt.env, PATH: `${shim}:${process.env.PATH}` });
      assert.equal(result.status, 0, `${name}: a gated root is an observation, never a command failure: ${result.stderr}`);
      assertUnchanged(before, snapshotTree(name, alt.home), `${name}: the run`);
      const data = status(result);
      const rootFinding = hostNamed(data, "profile.root");
      assert.equal(rootFinding.state, "error", name);
      assert.equal(rootFinding.observed, code, name);
      assert.equal(rootFinding.domain, "profile");
      assert.match(rootFinding.details.join("\n"), new RegExp(`root ${code}`, "u"), name);
      assert.deepEqual(data.profile.root, { state: "error", code }, name);
      const agent = agentNamed(data, "solo-pm");
      for (const field of FIELD_ORDER) {
        const observation = fieldOf(agent, field);
        assert.equal(observation.state, "error", `${name} ${field} must be error behind a gated root`);
        assert.match(observation.summary, new RegExp(code, "u"), `${name} ${field} names the root code`);
      }
      assert.equal(agent.profile.path.code, `root:${code}`, name);
      assert.equal(agent.profile.renderer.state, "error", name);
      assert.equal(agent.profile.bank.observed, null, `${name}: nothing beneath the root was read`);
      assert.equal(agent.complete, false, name);
      const probes = data.probes.filter((probe) => probe.kind === "profile" && probe.target.endsWith("/profiles/solo-pm"));
      assert.deepEqual(probes.map((probe) => [probe.outcome, probe.reason]), [["skipped", `root:${code}`]], `${name}: the renderer probe is skipped, by name`);
      assert.deepEqual(data.profile.agents, {
        total_registered: 1, selected: 1, real: 0, blocked_at_path: 0,
        structurally_healthy: 0, drifted: 0, incomplete: 1, exception_authorized: 0, unobserved: 0,
      }, name);
      assert.equal(data.profile.renderer.checked, 0, name);
      assert.equal(data.profile.extras.coverage, "not-swept", `${name}: a gated root is never enumerated`);
      assert.equal(data.profile.extras.reason, `root:${code}`, name);
      assert.equal(data.host.some((finding) => finding.rule_id === "profile.extras"), false, name);
      assert.notEqual(data.health.verdict, "healthy", name);
    }
    // The interpreter probe may run; the RENDERER never did.
    const invocations = existsSync(recorder) ? readFileSync(recorder, "utf8") : "";
    assert.equal(invocations.includes("hermes-profile-config.py"), false, `the renderer was invoked behind a gated root: ${invocations}`);
  });

  check("a delta the renderer cannot parse is renderer-failed: exit 1 with no drift block, stderr never read, and the run still succeeds", () => {
    requireRenderer("a delta the renderer cannot parse is renderer-failed: exit 1 with no drift block, stderr never read, and the run still succeeds");
    const result = cliAt(mainRoot, [...STATUS_ARGS, "--agent", "crash-pm"]);
    assert.equal(result.status, 0, `a renderer crash is one profile's error, never a command failure: ${result.stderr}`);
    const data = status(result);
    const agent = agentNamed(data, "crash-pm");
    const config = fieldOf(agent, FIELDS.config);
    assert.equal(config.state, "error");
    assert.deepEqual(kindsOf(config), ["renderer-failed"]);
    assert.equal(itemsOf(config)[0].observed, "exit 1", "the exit status is the only thing kept from a child that said nothing usable");
    assert.equal(itemsOf(config)[0].detail, "renderer-failed");
    assert.equal(agent.profile.renderer.state, "error");
    assert.deepEqual(agent.profile.renderer.sections, []);
    assert.match(agent.profile.digests.delta, /^[0-9a-f]{12}$/u, "the delta bytes were still digested; nothing was parsed by the observer");
    const probe = data.probes.find((item) => item.kind === "profile" && item.target.endsWith("/profiles/crash-pm"));
    assert.ok(probe, "the renderer probe ran");
    assert.deepEqual([probe.outcome, probe.reason], ["failed", "renderer-failed"]);
    assert.equal(data.profile.renderer.failed, 1);
    assert.equal(data.profile.renderer.checked, 1, "a crashed check is still a checked profile");
    assert.equal(data.profile.renderer.in_sync + data.profile.renderer.drifted + data.profile.renderer.timeout, 0);
    assert.equal(data.profile.agents.incomplete, 1);
    assert.equal(agent.complete, false, "a collection error makes the agent incomplete");
    assert.equal(agent.healthy, false, "an error is never a pass");
    assert.equal(fieldOf(agent, FIELDS.bank).state, "pass", "the other fields are still read");
    assert.equal(fieldOf(agent, FIELDS.identity).state, "pass");
    assert.equal(hostNamed(data, "profile.renderer").state, "pass", "one profile's crash is not the renderer's integrity");
    // The renderer's FATAL names the delta's absolute path on stderr, which is
    // never read: neither the message nor the path reaches the payload.
    assert.equal(textOf(data).includes("cannot parse"), false, "the renderer's FATAL never reaches the payload");
    assert.equal(textOf(data).includes(profilesRoot), false, "no absolute profile path reaches the payload");
    // Fleet-wide, the same profile is the only failed check.
    const fleet = status(cliAt(mainRoot, STATUS_ARGS));
    assert.equal(fleet.profile.renderer.failed, 1);
    assert.equal(fieldOf(agentNamed(fleet, "crash-pm"), FIELDS.config).state, "error");
  });

  // -- AC4: the bank pin ----------------------------------------------------------

  check("pin variants read pass, bank-alias, bank-alias, bank-custom, bank-missing, pin-missing, bank-mismatch, pin-malformed, pin-symlink, with exact ids and no memory read", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const expect = (id, kind, observed) => {
      const agent = agentNamed(data, id);
      const bank = fieldOf(agent, FIELDS.bank);
      if (kind === null) { assert.equal(bank.state, "pass", id); assert.equal(bank.items, undefined); }
      else {
        assert.equal(bank.state, "fail", `${id}: ${JSON.stringify(bank.items)}`);
        assert.deepEqual(kindsOf(bank), [kind], id);
        assert.equal(bank.desired, `agent-${id}`, `${id}: desired carries the exact expected id`);
        if (observed !== undefined) assert.equal(bank.observed, observed, `${id}: observed carries the exact id`);
      }
      assert.equal(agent.profile.bank.expected, `agent-${id}`);
    };
    expect("clean-pm", null);
    expect("alias-pm", "bank-alias", "agent-Alias-pm");
    expect("alias2-pm", "bank-alias", "agent-alias2_pm");
    expect("custom-pm", "bank-custom", "custom");
    expect("template-pm", "bank-missing", "bank_id_template only");
    expect("nopin-pm", "pin-missing", "absent");
    expect("mismatch-pm", "bank-mismatch", "agent-somebody-else");
    expect("pinbad-pm", "pin-malformed");
    expect("pinlink-pm", "pin-symlink", "symlink");
    assert.equal(itemsOf(fieldOf(agentNamed(data, "template-pm"), FIELDS.bank))[0].detail, "bank_id_template", "a generic template never satisfies the pin");
    // EXACT, from the fixture: 31 real profiles, of which two alias, one
    // custom, two unpinned (template-pm, nopin-pm), one mismatched, two
    // invalid (pinbad-pm, pinlink-pm), and the rest pinned. The six sum to
    // `agents.real`.
    assert.deepEqual(data.profile.identity, { bank_ok: 23, bank_alias: 2, bank_custom: 1, bank_missing: 2, bank_mismatch: 1, bank_invalid: 2 });
    assert.equal(Object.values(data.profile.identity).reduce((sum, count) => sum + count, 0), data.profile.agents.real, "the bank buckets sum to the real profiles");
    assert.equal(data.profile.agents.real, 31);
    assert.equal(agentNamed(data, "pinbad-pm").profile.bank.code, "pin-malformed");
    assert.equal(agentNamed(data, "alias-pm").profile.bank.code, "bank-alias");
    assert.equal(textOf(data).includes("secret memory"), false, "nothing under memories/ was read");
  });

  // -- AC5: the skill core by bytes -------------------------------------------

  check("a dangling core link and a byte-different copy fail the core; the rest resolve through external_dirs; an optional skill is listed", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const agent = agentNamed(data, "skills-pm");
    const skills = fieldOf(agent, FIELDS.skills);
    assert.equal(skills.state, "fail");
    const core = itemsOf(skills).filter((item) => item.kind !== "extra-skill" && item.kind !== "source-unresolvable");
    assert.deepEqual(core.map((item) => [item.kind, item.detail]).sort(), [["core-dangling", "core-dangling:hindsight"], ["core-replaced", "core-replaced:33god-projects"]]);
    const replaced = core.find((item) => item.kind === "core-replaced");
    assert.match(replaced.desired, /^[0-9a-f]{12}$/u, "the canonical digest");
    assert.match(replaced.observed, /^[0-9a-f]{12}$/u, "the observed digest");
    assert.notEqual(replaced.desired, replaced.observed);
    assert.deepEqual(agent.profile.skills.core_missing, ["33god-projects", "hindsight"]);
    assert.equal(agent.profile.skills.core_present, 4, "the remaining four read present through skills.external_dirs");
    assert.deepEqual(agent.profile.skills.extra, ["extra-tool", "extra-tool2"]);
    assert.ok(kindsOf(skills).includes("extra-skill"));
    assert.equal(agent.profile.skills.sources_unresolvable, 1, "the relative external_dirs entry is counted, not resolved");
    assert.equal(textOf(agent).includes("a replaced copy"), false, "no SKILL.md body reaches the payload");

    const foreign = agentNamed(data, "foreign-pm");
    assert.deepEqual(itemsOf(fieldOf(foreign, FIELDS.skills)).filter((item) => item.kind !== "source-unresolvable").map((item) => [item.kind, item.detail]), [["core-foreign", "core-foreign:delonet-dotenv"]]);
    assert.equal(fieldOf(foreign, FIELDS.skills).state, "fail", "identical bytes outside every allowed root never count");
    assert.equal(foreign.profile.skills.core_present, 5);

    // Whole skills aliases are migration blockers regardless of their target.
    // Explicit byte-policy may still read external_dirs, but the unsupported
    // alias itself is not traversed or counted as a local skill collection.
    const linked = agentNamed(data, "skills-link-pm");
    assert.equal(fieldOf(linked, FIELDS.skills).state, "fail", "whole skills aliases need explicit migration");
    assert.deepEqual(linked.profile.skills.extra, [], "unsupported root aliases are not traversed");
    assert.equal(linked.profile.skills.core_present, 6);
    const outsideLink = agentNamed(data, "skills-outside-pm");
    assert.equal(fieldOf(outsideLink, FIELDS.skills).state, "fail");
    assert.deepEqual(itemsOf(fieldOf(outsideLink, FIELDS.skills)).filter((item) => item.kind !== "source-unresolvable").map((item) => [item.path, item.kind]), [["skills", "core-foreign"]]);
    assert.equal(outsideLink.profile.skills.core_present, 6, "the core still resolves through external_dirs; the entry itself is the defect");
    const danglingLink = agentNamed(data, "skills-dangling-pm");
    assert.deepEqual(itemsOf(fieldOf(danglingLink, FIELDS.skills)).filter((item) => item.kind !== "source-unresolvable").map((item) => [item.path, item.kind]), [["skills", "core-foreign"]]);

    // 31 real profiles, five with a skills defect; two missing required
    // skills, one replaced, and two local optional skills. Unsupported root
    // aliases contribute no traversed local entries.
    assert.deepEqual(data.profile.skills, { core_complete: 26, core_missing: 2, core_replaced: 1, extras_seen: 2 });
  });

  // -- identity-file shapes ------------------------------------------------------

  check("identity-file shapes: missing, symlink, malformed and a mismatched name fail; an unknown key warns; an inert config block is recorded and passes", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const expect = (id, state, kinds) => {
      const identity = fieldOf(agentNamed(data, id), FIELDS.identity);
      assert.equal(identity.state, state, `${id}: ${JSON.stringify(identity.items)}`);
      assert.deepEqual(kindsOf(identity), kinds, id);
      return identity;
    };
    expect("noid-pm", "fail", ["missing"]);
    expect("idlink-pm", "fail", ["symlink"]);
    expect("idbad-pm", "fail", ["malformed"]);
    const unknown = expect("idunknown-pm", "warn", ["unknown-key"]);
    assert.equal(itemsOf(unknown)[0].detail, "unknown-key:mystery");
    assert.equal(unknown.justification, null, "an unauthorized warn is unjustified");
    assert.deepEqual(agentNamed(data, "idunknown-pm").profile.identity.keys, ["description", "mystery", "name"], "key NAMES only");
    assert.equal(textOf(agentNamed(data, "idunknown-pm")).includes(SECRET_SENTINEL), false, "the description value never reaches the payload");
    const inert = expect("idconfig-pm", "pass", ["inert-config-block"]);
    assert.equal(itemsOf(inert)[0].detail, "inert-key:config");
    assert.equal(itemsOf(inert)[0].observed, "config");
    assert.equal(textOf(agentNamed(data, "idconfig-pm")).includes("inherit_from"), false, "the block is recorded as inert, never as inheritance and never by value");
    const name = expect("idname-pm", "fail", ["identity-mismatch"]);
    assert.equal(itemsOf(name)[0].detail, "identity-mismatch:name");
    assert.equal(itemsOf(name)[0].desired, "idname-pm");
    const display = expect("iddisplay-pm", "fail", ["identity-mismatch"]);
    assert.equal(itemsOf(display)[0].detail, "identity-mismatch:display_name");
    assert.equal(textOf(agentNamed(data, "iddisplay-pm")).includes("Somebody Else"), false, "the display value never reaches the payload");
  });

  // -- AC6: the extras sweep ------------------------------------------------------

  check("fleet scope classifies every unregistered root entry into one of five classes with evidence and guidance, and leaves the root untouched", () => {
    const rootBefore = snapshotTree("root", profilesRoot);
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    assertUnchanged(rootBefore, snapshotTree("root", profilesRoot), "the sweep");
    const extras = hostNamed(data, "profile.extras");
    assert.equal(extras.state, "warn");
    assert.equal(extras.domain, "profile");
    assert.equal(extras.justification, null, "an unclassified extra is unjustified by design");
    const byPath = Object.fromEntries((extras.items ?? []).map((item) => [item.path, item]));
    const expected = {
      "clean-pm.bak": ["retired-candidate", "directory", "retirement", "clean-pm"],
      clean_pm: ["retired-candidate", "directory", "retirement", "clean-pm"],
      oldtopo: ["retired-candidate", "directory", "retirement", null],
      linked: ["unclassified", "symlink", "manual-review", null],
      standalone: ["unclassified", "directory", "manual-review", null],
      "Twin-pm": ["retired-candidate", "directory", "retirement", "twin-pm"],
      "stray.txt": ["debris-candidate", "file", "retirement", null],
      empty: ["debris-candidate", "empty-directory", "retirement", null],
      dangling: ["debris-candidate", "dangling-symlink", "retirement", null],
      "fleet-bloodbank-gateway": ["approved-managed-exception", "directory", "exception", null],
      unmanaged: ["unclassified", "directory", "adoption", null],
      "shared-profile": ["unclassified", "directory", "adoption", null],
    };
    assert.deepEqual(Object.keys(byPath).sort(), Object.keys(expected).sort(), "every unregistered, non-lock entry appears exactly once");
    for (const [path, [klass, kind, guidance, alias]] of Object.entries(expected)) {
      const item = byPath[path];
      assert.equal(item.class, klass, `${path} class`);
      assert.equal(item.kind, kind, `${path} kind`);
      assert.equal(item.guidance, guidance, `${path} guidance`);
      assert.equal(item.alias_of, alias, `${path} alias_of`);
      assert.equal(item.process_reference, "unobserved", `${path}: live attribution is story 1.9`);
      assert.ok(EXTRA_CLASSES.includes(item.class));
    }
    assert.equal(byPath["clean-pm.bak"].detail, "backup-pattern:*.bak");
    assert.equal(byPath.clean_pm.detail, "alias-of:clean-pm");
    assert.equal(byPath.oldtopo.detail, "config-symlink");
    assert.equal(byPath["Twin-pm"].detail, "alias-of:twin-pm", "a case variant of a registered name is an alias, so a retired candidate");
    assert.equal(byPath["fleet-bloodbank-gateway"].detail, "classifications.managed_shared_service.entries[0]");
    assert.equal(byPath["fleet-bloodbank-gateway"].unit_file_references, 1);
    assert.equal(byPath.standalone.unit_file_references, 1, "a trailing slash in the unit's HERMES_HOME still counts");
    assert.equal(byPath.unmanaged.unit_file_references, 1, "a unit that is itself a link is read through the link");
    assert.equal(byPath.linked.unit_file_references, 1, "a line assigning more than one variable names the first value");
    assert.equal(byPath.standalone.standalone, "incomplete");
    assert.equal(byPath.unmanaged.standalone, "complete");
    assert.equal(byPath.linked.standalone, null, "a symlink is classified, never followed");
    assert.match(byPath.linked.link_target, /outside\/linked-profile$/u);
    assert.equal(byPath.linked.link_target.startsWith("/"), false, "the link target is shown, never absolute");
    assert.equal(byPath["clean-pm.bak"].standalone, "incomplete");
    assert.equal(Object.values(byPath).some((item) => item.path.startsWith(".")), false, "the renderer's lock files are never listed");
    assert.deepEqual(data.profile.extras, {
      coverage: "swept", reason: null, entries_total: 12,
      by_class: { "approved-managed-exception": 1, "intentionally-unmanaged": 0, "retired-candidate": 4, unclassified: 4, "debris-candidate": 3 },
      listed: 12, truncated: false,
    });
    assert.equal(data.health.verdict, "unhealthy", "the fixture carries proven failures; the warn alone would make it unproven");
    assert.doesNotMatch(textOf(extras), /\b(rm |git rm|delete |remove )\b/u, "nothing proposes deleting an entry");
    assert.equal(extras.next_action_class, "read-only");
  });

  check("a root whose every extra is declared reads profile.extras pass, and the slice can be healthy", () => {
    requireRenderer("a root whose every extra is declared reads profile.extras pass, and the slice can be healthy");
    // A SECOND home with one clean agent, the declared gateway profile and one
    // declared intentionally-unmanaged directory: the only way an extra becomes
    // `pass` is a contract classification naming it.
    const home2 = join(temp, "home2");
    const fleet2 = join(home2, ".hermes");
    const root2 = join(fleet2, "profiles");
    mkdirSync(root2, { recursive: true });
    mkdirSync(join(home2, ".config", "pjangler"), { recursive: true });
    mkdirSync(join(home2, ".config", "hermes-agent-template"), { recursive: true });
    writeFileSync(join(fleet2, "config.yaml"), BASE_TEXT, "utf8");
    // The canonical projection is shared: the second home's `.agents/skills`
    // resolves to the same directory the profile links point at.
    mkdirSync(join(home2, ".agents"), { recursive: true });
    symlinkSync(canonicalSkills, join(home2, ".agents", "skills"));
    const repo = makeRepo("solo");
    seedProfile("solo-pm", { root: root2, links: { "SOUL.md": join(repo.runtime, "SOUL.md"), memories: join(repo.runtime, "memories") } });
    seedProfile("fleet-bloodbank-gateway", { root: root2, identity: { name: "fleet-bloodbank-gateway" }, pin: { bank_id: "agent-fleet-bloodbank-gateway" }, skills: null, lock: false });
    seedProfile("keeper", { root: root2, identity: null, pin: null, skills: null, lock: false });
    // Declared, but for another policy domain: the claim does not reach the profile sweep.
    seedProfile("elsewhere", { root: root2, identity: null, pin: null, skills: null, lock: false });
    const soloFleet = [{ name: "solo-pm", rowOverrides: {} }];
    writeAgentRegistry(join(fleet2, "agents-registry.yaml"), soloFleet);
    writeProjectRegistry(join(home2, ".config", "pjangler", "projects.yaml"), soloFleet);
    cpSync(join(scratchHome, ".config", "hermes-agent-template", "config.toml"), join(home2, ".config", "hermes-agent-template", "config.toml"));
    const declared = policyContract((document) => {
      document.classifications.intentionally_unmanaged.entries = [
        {
          id: "keeper-profile", kind: "standalone-profile", owner: "operator", source: "profiles.keeper",
          lifecycle_state: "kept", rationale: "an operator-run profile the control plane observes and leaves alone", policy_domains: ["profile"],
        },
        {
          id: "elsewhere-profile", kind: "standalone-profile", owner: "operator", source: "profiles.elsewhere",
          lifecycle_state: "kept", rationale: "ruled on for systemd only; the profile sweep must not honour it", policy_domains: ["systemd"],
        },
      ];
    });
    const root = makePackageRoot("pkg-declared", YAML.stringify(declared, { lineWidth: 0 }));
    const env2 = {
      HOME: home2, XDG_CONFIG_HOME: join(home2, ".config"), HERMES_FLEET_HOME: fleet2,
      HERMES_AGENTS_REGISTRY: join(fleet2, "agents-registry.yaml"), HERMES_FLEET_REGISTRY_FILE: join(fleet2, "agents-registry.yaml"),
      HERMES_FLEET_ENV: join(fleet2, "no-fleet.env"), HERMES_TEMPLATE_CONFIG: join(home2, ".config", "hermes-agent-template", "config.toml"),
      PJ_PROJECT_REGISTRY: join(home2, ".config", "pjangler", "projects.yaml"),
    };
    // A claim without `profile` in its policy domains is no claim here.
    const undeclaredDomain = status(cliAt(root, STATUS_ARGS, env2));
    assert.equal(hostNamed(undeclaredDomain, "profile.extras").state, "warn");
    assert.equal((hostNamed(undeclaredDomain, "profile.extras").items ?? []).find((item) => item.path === "elsewhere").class, "unclassified", "a ruling for another policy domain does not reach the profile sweep");
    rmSync(join(root2, "elsewhere"), { recursive: true, force: true });

    const data = status(cliAt(root, STATUS_ARGS, env2));
    const extras = hostNamed(data, "profile.extras");
    assert.equal(extras.state, "pass", JSON.stringify(extras.items));
    const solo = agentNamed(data, "solo-pm");
    for (const field of FIELD_ORDER) assert.equal(fieldOf(solo, field).state, "pass", `${field}: ${JSON.stringify(fieldOf(solo, field).items)}`);
    assert.deepEqual((extras.items ?? []).map((item) => [item.path, item.class, item.guidance]).sort(), [
      ["fleet-bloodbank-gateway", "approved-managed-exception", "exception"],
      ["keeper", "intentionally-unmanaged", "exception"],
    ]);
    assert.equal((extras.items ?? []).find((item) => item.path === "keeper").detail, "classifications.intentionally_unmanaged.entries[0]");
    assert.deepEqual(data.profile.extras.by_class, { "approved-managed-exception": 1, "intentionally-unmanaged": 1, "retired-candidate": 0, unclassified: 0, "debris-candidate": 0 });
    assert.equal(data.profile.agents.structurally_healthy, 1);
    assert.equal(agentNamed(data, "solo-pm").healthy, true);
    assert.equal(data.health.healthy, true, "a clean profile behind a fully classified root has no proven failure");
    assert.equal(data.health.unjustified, 0, "every non-pass is authorized");

    // ONE unclassified entry beside them: the finding turns warn, health.healthy
    // stays true (a host condition is never a fleet failure), and the fleet
    // cannot claim proof until the operator classifies it in the contract.
    mkdirSync(join(root2, "orphan", "hindsight"), { recursive: true });
    const after = status(cliAt(root, STATUS_ARGS, env2));
    const warned = hostNamed(after, "profile.extras");
    assert.equal(warned.state, "warn");
    assert.equal(warned.justification, null, "unjustified by design");
    assert.equal((warned.items ?? []).find((item) => item.path === "orphan").class, "unclassified");
    assert.equal(after.health.healthy, true, "a host warn never makes the fleet unhealthy");
    assert.equal(after.health.unjustified, 1, "an unjustified host warn counts against proof");
    assert.equal(after.health.verdict, "unproven");
    assert.equal(after.health.proven, false);

    // The blunt instrument: `allowed_warnings` naming profile.extras blankets
    // every extra. The reading is unchanged; only its justification is.
    const blanket = policyContract((document) => {
      document.classifications.intentionally_unmanaged.entries = declared.classifications.intentionally_unmanaged.entries;
      document.health_policy.allowed_warnings.push({ rule_id: "profile.extras", reason: "the operator accepts every unregistered entry for now", owner: "suite" });
    });
    const blanketRoot = makePackageRoot("pkg-blanket", YAML.stringify(blanket, { lineWidth: 0 }));
    const lifted = status(cliAt(blanketRoot, STATUS_ARGS, env2));
    assert.equal(hostNamed(lifted, "profile.extras").state, "warn", "still a warn");
    assert.equal(hostNamed(lifted, "profile.extras").justification.kind, "allowed_warning");
    assert.equal(lifted.health.unjustified, 0);

    // A declared `retired` sighting is a retired-candidate that STAYS warn:
    // the contract has recorded that the entry should go.
    seedProfile("retiredone", { root: root2, identity: null, pin: null, skills: null, lock: false });
    const retired = policyContract((document) => {
      document.classifications.intentionally_unmanaged.entries = declared.classifications.intentionally_unmanaged.entries;
      document.classifications.retired.entries = [{
        id: "retiredone-profile", kind: "standalone-profile", owner: "operator", source: "profiles.retiredone",
        lifecycle_state: "retired", rationale: "superseded; to be removed", policy_domains: ["profile"],
      }];
    });
    const retiredRoot = makePackageRoot("pkg-retired", YAML.stringify(retired, { lineWidth: 0 }));
    const sighted = status(cliAt(retiredRoot, STATUS_ARGS, env2));
    const sighting = (hostNamed(sighted, "profile.extras").items ?? []).find((item) => item.path === "retiredone");
    assert.deepEqual([sighting.class, sighting.detail, sighting.guidance], ["retired-candidate", "classifications.retired.entries[0]", "retirement"]);
    assert.equal(hostNamed(sighted, "profile.extras").state, "warn", "a declared retired sighting stays warn until the entry is gone");

    // An entry the sweep cannot read is unclassified for manual review, never debris.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      skip("an unreadable extra is unclassified", "running as root, which reads every directory");
    } else {
      const sealed = join(root2, "sealed");
      mkdirSync(join(sealed, "hindsight"), { recursive: true });
      chmodSync(sealed, 0o000);
      try {
        // Direct spawn: the zero-write snapshot cannot walk a directory it may not read.
        const result = spawnSync(process.execPath, [join(root, "dist", "index.js"), ...STATUS_ARGS], {
          cwd: workdir, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...isolation, ...env2 },
        });
        const unreadable = (hostNamed(status(result), "profile.extras").items ?? []).find((item) => item.path === "sealed");
        assert.deepEqual([unreadable.class, unreadable.detail, unreadable.guidance], ["unclassified", "unreadable", "manual-review"]);
      } finally {
        chmodSync(sealed, 0o700);
        rmSync(sealed, { recursive: true, force: true });
      }
    }
  });

  check("a duplicate profile_name across rows gates every claimant ambiguous, and a row with no profile_name is unnamed", () => {
    // Two rows naming one profile: neither may read it, one probe per directory.
    const rows = [...AGENTS, { name: "dup-pm", rowOverrides: { profile_name: "clean-pm" } }, { name: "noname-pm", rowOverrides: { profile_name: undefined } }];
    const agents = writeAgentRegistry(join(temp, "dup-agents.yaml"), rows);
    const data = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent-registry", agents]));
    for (const id of ["clean-pm", "dup-pm"]) {
      const agent = agentNamed(data, id);
      const path = fieldOf(agent, FIELDS.path);
      assert.equal(path.state, "fail", id);
      assert.deepEqual(itemsOf(path).map((item) => [item.kind, item.detail]), [["ambiguous", "ambiguous:duplicate-profile-name"]], id);
      for (const field of [FIELDS.identity, FIELDS.config, FIELDS.bank, FIELDS.skills]) assert.equal(fieldOf(agent, field).state, "unobserved", `${id} ${field}`);
      assert.equal(agent.profile.path.code, "ambiguous", id);
      assert.equal(agent.profile.renderer.state, "unobserved", `${id}: no renderer spawn`);
    }
    const probes = data.probes.filter((probe) => probe.kind === "profile" && probe.target.endsWith("/profiles/clean-pm"));
    assert.equal(probes.length, 1, "one probe id per directory, however many rows claim it");
    assert.deepEqual([probes[0].outcome, probes[0].reason], ["skipped", "ambiguous"]);
    const unnamed = agentNamed(data, "noname-pm");
    assert.deepEqual(kindsOf(fieldOf(unnamed, FIELDS.path)), ["unnamed"]);
    assert.equal(unnamed.profile.path.code, "unnamed");
    assert.equal(fieldOf(unnamed, FIELDS.config).state, "unobserved");
    assert.equal(itemsOf(fieldOf(unnamed, FIELDS.path))[0].path, "(unnamed)", "the gate item is addressable even with no name");
    // Agent scope reads the SAME whole-fleet names: one selected row still
    // sees the other claimant it did not select.
    const scoped = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm", "--agent-registry", agents]));
    assert.equal(agentNamed(scoped, "clean-pm").profile.path.code, "ambiguous", "a --agent run is gated against rows it did not select");
    assert.equal(fieldOf(agentNamed(scoped, "clean-pm"), FIELDS.config).state, "unobserved");
  });

  check("the canonical skills directory follows CANONICAL_SKILLS_DIR, then the template config, then the manifest; a lacking projection is one named host finding", () => {
    // A second projection missing one core skill, named by the template config.
    // Five of the six project into the SAME skill directories (links, the way
    // skillex projects), so a profile's own links still resolve to the
    // canonical realpath; hindsight is simply absent.
    const partial = join(scratchHome, "partial-skills");
    mkdirSync(partial, { recursive: true });
    for (const skill of CORE_SKILLS.filter((name) => name !== "hindsight")) symlinkSync(join(canonicalSkills, skill), join(partial, skill));
    const config = join(temp, "config-partial.toml");
    writeFileSync(config, `${readFileSync(join(scratchHome, ".config", "hermes-agent-template", "config.toml"), "utf8")}canonical_skills_dir = "${partial}"\n`, "utf8");
    const viaConfig = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"], { HERMES_TEMPLATE_CONFIG: config }));
    const core = hostNamed(viaConfig, "profile.skill-core");
    assert.equal(core.state, "fail");
    assert.match(core.summary, /lacks 1 core skill\(s\): hindsight/u);
    assert.match(core.summary, /\(template-config\)/u, "the finding says how the directory was chosen");
    assert.equal(core.observed, "missing hindsight");
    assert.equal(core.summary.includes(partial), false, "the directory is shown, never absolute");
    const agent = agentNamed(viaConfig, "clean-pm");
    assert.deepEqual(itemsOf(fieldOf(agent, FIELDS.skills)).filter((item) => item.kind !== "source-unresolvable").map((item) => [item.kind, item.detail]), [["canonical-missing", "canonical-missing:hindsight"]]);
    assert.equal(fieldOf(agent, FIELDS.skills).state, "fail", "a fleet defect, not a collection error");
    assert.deepEqual(agent.profile.skills.core_missing, ["hindsight"]);
    assert.equal(agent.profile.skills.core_present, 5, "the other five still resolve: the partial projection links into the same skill directories");
    assert.equal(viaConfig.profile.skills.core_missing, 1);
    assert.equal(viaConfig.profile.skills.core_complete, 0);
    // The template's own config_get follows a link here; so does the observer.
    const linkedConfig = join(temp, "config-partial-link.toml");
    symlinkSync(config, linkedConfig);
    const viaLinkedConfig = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"], { HERMES_TEMPLATE_CONFIG: linkedConfig }));
    assert.equal(hostNamed(viaLinkedConfig, "profile.skill-core").state, "fail", "a linked template config is read through the link");
    assert.match(hostNamed(viaLinkedConfig, "profile.skill-core").summary, /\(template-config\)/u);
    // The environment override outranks the template config.
    const viaEnv = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"], { HERMES_TEMPLATE_CONFIG: config, CANONICAL_SKILLS_DIR: canonicalSkills }));
    assert.equal(hostNamed(viaEnv, "profile.skill-core").state, "pass");
    assert.match(hostNamed(viaEnv, "profile.skill-core").summary, /\(env\)/u);
    assert.equal(fieldOf(agentNamed(viaEnv, "clean-pm"), FIELDS.skills).state, "pass");
    // And the manifest placeholder is the default.
    const viaManifest = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"]));
    assert.match(hostNamed(viaManifest, "profile.skill-core").summary, /\(manifest\)/u);
  });

  check("a missing or symlinked fleet base is base-missing on the config field, the renderer probe is skipped, and nothing is checked", () => {
    for (const [name, shape, detail] of [["home-no-base", "missing", "base-missing"], ["home-link-base", "symlink", "base-symlink"]]) {
      const alt = makeAltHome(name);
      const base = join(alt.fleet, "config.yaml");
      rmSync(base);
      if (shape === "symlink") symlinkSync(join(fleetHome, "config.yaml"), base);
      const data = status(cliAt(mainRoot, STATUS_ARGS, alt.env));
      const config = fieldOf(agentNamed(data, "solo-pm"), FIELDS.config);
      assert.equal(config.state, "error", name);
      assert.deepEqual(itemsOf(config).map((item) => [item.path, item.kind, item.detail]), [["config.yaml", "base-missing", detail]], name);
      assert.equal(agentNamed(data, "solo-pm").profile.renderer.state, "error", name);
      assert.equal(agentNamed(data, "solo-pm").profile.digests.base, null, name);
      const probe = data.probes.find((item) => item.kind === "profile" && item.target.endsWith("/profiles/solo-pm"));
      assert.deepEqual([probe.outcome, probe.reason], ["skipped", detail], name);
      assert.equal(data.profile.renderer.checked, 0, name);
      if (RENDERER_AVAILABLE) assert.equal(hostNamed(data, "profile.renderer").state, "pass", `${name}: the renderer itself is fine`);
      assert.equal(fieldOf(agentNamed(data, "solo-pm"), FIELDS.bank).state, "pass", `${name}: the other fields are still read`);
    }
  });

  check("a contract whose profile root is not the renderer's is renderer-layout-mismatch on profile.root, with no renderer child", () => {
    const elsewhere = policyContract((document) => { document.service_model.profile_layout.root = "{HERMES_FLEET_HOME}/agents/{profile_name}"; });
    const root = makePackageRoot("pkg-layout", YAML.stringify(elsewhere, { lineWidth: 0 }));
    const data = status(cliAt(root, [...STATUS_ARGS, "--agent", "clean-pm"]));
    assert.deepEqual(data.profile.root, { state: "error", code: "renderer-layout-mismatch" });
    assert.equal(hostNamed(data, "profile.root").state, "error");
    assert.equal(hostNamed(data, "profile.root").observed, "renderer-layout-mismatch");
    const agent = agentNamed(data, "clean-pm");
    for (const field of FIELD_ORDER) assert.equal(fieldOf(agent, field).state, "error", field);
    assert.equal(agent.profile.path.code, "root:renderer-layout-mismatch");
    const probes = data.probes.filter((probe) => probe.kind === "profile" && !probe.target.endsWith("templates/hermes-agent") && probe.target !== "python3");
    assert.ok(probes.every((probe) => probe.outcome === "skipped"), `no renderer child behind a mismatched layout: ${JSON.stringify(probes)}`);
    assert.equal(data.profile.renderer.checked, 0);
  });

  check("lowered limits prove the counts are taken before every cap: extras, root entries, optional skills, and the items clip", () => {
    // max_extra_skills 1: skills-pm lists one, sees two; the fleet tally is uncapped.
    const skillsCap = policyContract((document) => { document.profile_manifest.limits.max_extra_skills = 1; });
    const capRoot = makePackageRoot("pkg-skills-cap", YAML.stringify(skillsCap, { lineWidth: 0 }));
    const capped = status(cliAt(capRoot, [...STATUS_ARGS, "--agent", "skills-pm"]));
    assert.deepEqual(agentNamed(capped, "skills-pm").profile.skills.extra, ["extra-tool"], "listed names are capped");
    assert.equal(capped.profile.skills.extras_seen, 2, "seen is counted uncapped");
    assert.equal(kindsOf(fieldOf(agentNamed(capped, "skills-pm"), FIELDS.skills)).filter((kind) => kind === "extra-skill").length, 1);

    // max_root_entries 3: the listing stops at the cap, so no profile can be
    // proven unambiguous -- every agent is gated, by name -- and the sweep says
    // it was truncated.
    const rootCap = policyContract((document) => { document.profile_manifest.limits.max_root_entries = 3; });
    const rootCapRoot = makePackageRoot("pkg-root-cap", YAML.stringify(rootCap, { lineWidth: 0 }));
    const truncated = status(cliAt(rootCapRoot, STATUS_ARGS));
    assert.equal(truncated.profile.extras.truncated, true);
    for (const agent of truncated.agents) {
      // A row the earlier gates already refuse (no safe name) never reaches
      // the collision gate; every other row is refused there, by name.
      if (agent.profile.path.code === "name-unsafe") continue;
      assert.equal(agent.profile.path.code, "case-collision", `${agent.agent_id} is gated over a partial listing`);
      assert.equal(itemsOf(fieldOf(agent, FIELDS.path))[0].detail, "case-collision:unverified", agent.agent_id);
      assert.equal(agent.profile.renderer.state, "unobserved", `${agent.agent_id}: nothing beneath is read`);
    }
    assert.equal(truncated.profile.agents.blocked_at_path, truncated.profile.agents.selected);
    assert.ok(truncated.truncated.some((note) => note.includes("host[profile.extras]") && note.includes("more than 3 entries")), JSON.stringify(truncated.truncated));

    // FLEET_STATUS_MAX_ITEMS: a root with 105 unregistered entries lists 100,
    // counts 105, and records the clip.
    const alt = makeAltHome("home-many-extras");
    for (let index = 0; index < 105; index += 1) writeFileSync(join(alt.realProfiles, `stray-${String(index).padStart(3, "0")}.txt`), "", "utf8");
    const many = status(cliAt(mainRoot, STATUS_ARGS, alt.env));
    const extras = hostNamed(many, "profile.extras");
    assert.equal((extras.items ?? []).length, MAX_ITEMS);
    assert.equal(many.profile.extras.entries_total, 105);
    assert.equal(many.profile.extras.listed, MAX_ITEMS);
    assert.equal(many.profile.extras.by_class["debris-candidate"], 105, "by_class is counted over every entry before the cap");
    assert.ok(many.truncated.some((note) => note.startsWith("host[profile.extras].items: 5 of 105 items dropped")), JSON.stringify(many.truncated));
    assert.equal(many.health.truncated, true);
  });

  // -- review pass: a collection failure is never a verdict ------------------

  check("a package root that is not a checkout root, a git that cannot answer, and a renderer copy that cannot be read under the cap are renderer-source-unobserved, never a verdict", () => {
    const contract = YAML.stringify(policyContract(), { lineWidth: 0 });
    const expectUnobserved = (data, name, summary) => {
      assert.equal(data.profile.renderer.source, "renderer-source-unobserved", name);
      assert.equal(data.profile.renderer.python, "not-probed", name);
      const finding = hostNamed(data, "profile.renderer");
      assert.equal(finding.state, "error", name);
      assert.equal(finding.observed, "renderer-source-unobserved", name);
      assert.match(finding.summary, summary, name);
      const config = fieldOf(agentNamed(data, "clean-pm"), FIELDS.config);
      assert.equal(config.state, "error", name);
      assert.equal(itemsOf(config).find((item) => item.kind === "renderer-unavailable").detail, "renderer-source-unobserved", name);
      assert.equal(data.probes.filter((probe) => probe.kind === "profile" && probe.outcome === "ok").length, 0, `${name}: nothing was proven`);
      assert.equal(data.probes.some((probe) => probe.kind === "profile" && probe.target === "python3"), false, `${name}: the interpreter was not probed`);
    };
    // 1. An extracted build sitting inside some OTHER repository: `git -C`
    //    walks up into it, and that repository's HEAD is not pjangler's.
    const outer = join(temp, "outer-repo");
    mkdirSync(outer, { recursive: true });
    gitOk(outer, ["init", "--quiet"]);
    writeFileSync(join(outer, "README.md"), "not pjangler\n", "utf8");
    gitOk(outer, ["add", "README.md"]);
    gitOk(outer, ["commit", "--quiet", "-m", "outer"]);
    const nested = makePackageRoot(join("outer-repo", "pkg-nested"), contract, { after: (root) => rmSync(join(root, ".git"), { recursive: true, force: true }) });
    const inside = status(cliAt(nested, [...STATUS_ARGS, "--agent", "clean-pm"]));
    expectUnobserved(inside, "nested", /not a git checkout root of its own/u);
    assert.equal(inside.profile.renderer.gitlink, null, "the outer repository's HEAD was never read as a pin");
    // 2. A git that cannot answer at all.
    const brokenGit = join(shimRoot, "path-git-broken");
    mkdirSync(brokenGit, { recursive: true });
    writeFileSync(join(brokenGit, "git"), "#!/bin/sh\necho 'fatal: not a git repository' >&2\nexit 128\n", "utf8");
    chmodSync(join(brokenGit, "git"), 0o755);
    const realPython = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    if (realPython) symlinkSync(realPython, join(brokenGit, "python3"));
    const broken = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"], { PATH: brokenGit }));
    expectUnobserved(broken, "broken-git", /rev-parse --show-toplevel probe failed/u);
    assert.equal(broken.profile.renderer.gitlink, null);
    // 3. A file cap below the script's size: the copy was never compared.
    const tiny = makePackageRoot("pkg-tiny-cap", YAML.stringify(policyContract((document) => { document.profile_manifest.limits.max_file_bytes = 1024; }), { lineWidth: 0 }));
    const capped = status(cliAt(tiny, [...STATUS_ARGS, "--agent", "clean-pm"]));
    expectUnobserved(capped, "tiny-cap", /could not be read under the file cap \(too-large\)/u);
    assert.equal(capped.profile.renderer.gitlink, TEMPLATE_HEAD, "the committed gitlink was read; the worktree copy was not");
  });

  check("a real file where the template provisions a singleton link is a misowned entry, and a role directory spelled through a symlink is still this agent's", () => {
    const alt = makeAltHome("home-singletons");
    // The stock identity Hermes seeds into a fresh profile directory: a REAL
    // SOUL.md where the template provisions a link into the runtime.
    const solo = join(alt.realProfiles, "solo-pm");
    rmSync(join(solo, "SOUL.md"));
    writeFileSync(join(solo, "SOUL.md"), "You are Hermes Agent, created by Nous Research\n", "utf8");
    // A row whose role_dir is spelled through a symlinked ancestor while the
    // template wrote the links by the real path.
    const viaLink = join(alt.home, "code");
    symlinkSync(reposRoot, viaLink);
    const linked = makeRepo("home-singletons-linked");
    seedProfile("linked-pm", { root: alt.realProfiles, links: { "SOUL.md": join(linked.runtime, "SOUL.md"), memories: join(linked.runtime, "memories") } });
    const rows = [
      { name: "solo-pm", rowOverrides: { repo: "home-singletons-solo", project_path: join(reposRoot, "home-singletons-solo"), role_dir: join(reposRoot, "home-singletons-solo", "agents", "hermes", "pm") } },
      { name: "linked-pm", rowOverrides: { repo: "home-singletons-linked", project_path: join(viaLink, "home-singletons-linked"), role_dir: join(viaLink, "home-singletons-linked", "agents", "hermes", "pm") } },
    ];
    writeAgentRegistry(join(alt.fleet, "agents-registry.yaml"), rows);
    writeProjectRegistry(join(alt.home, ".config", "pjangler", "projects.yaml"), rows);
    const data = status(cliAt(mainRoot, STATUS_ARGS, alt.env));
    const real = agentNamed(data, "solo-pm");
    const path = fieldOf(real, FIELDS.path);
    assert.equal(path.state, "fail");
    assert.deepEqual(itemsOf(path).map((item) => [item.path, item.kind, item.observed, item.detail]), [["SOUL.md", "misowned-link", "a real file", "not-a-link:SOUL.md"]]);
    assert.equal(real.profile.path.code, "misowned-link");
    assert.equal(fieldOf(real, FIELDS.bank).state, "pass", "the gate passed; the dependents are still read");
    assert.equal(textOf(real).includes("Nous Research"), false, "the file's body is never read");
    const through = agentNamed(data, "linked-pm");
    assert.equal(fieldOf(through, FIELDS.path).state, "pass", JSON.stringify(fieldOf(through, FIELDS.path).items));
    assert.equal(through.profile.path.code, "ok", "a link into the runtime by realpath is still this agent's runtime");
  });

  check("a root that cannot be enumerated is root-unreadable in every scope, and a profile or a file that cannot be read is an error, never a verdict", () => {
    const label = "a root that cannot be enumerated is root-unreadable in every scope, and a profile or a file that cannot be read is an error, never a verdict";
    if (typeof process.getuid === "function" && process.getuid() === 0) skipCase(label, "running as root, which reads every directory");
    const alt = makeAltHome("home-unreadable");
    // Direct spawns: the zero-write snapshot cannot walk a directory it may not read.
    const run = (args) => spawnSync(process.execPath, [join(mainRoot, "dist", "index.js"), ...args], {
      cwd: workdir, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...isolation, ...alt.env },
    });
    // 1. The root lists but its entries cannot be lstat'ed (no search bit):
    //    the ONE gate that is an error, with error dependents.
    chmodSync(alt.realProfiles, 0o400);
    try {
      const data = status(run(STATUS_ARGS));
      assert.equal(hostNamed(data, "profile.root").state, "pass", "the root itself was enumerated");
      const agent = agentNamed(data, "solo-pm");
      const path = fieldOf(agent, FIELDS.path);
      assert.equal(path.state, "error");
      assert.deepEqual(kindsOf(path), ["unreadable"]);
      for (const field of [FIELDS.identity, FIELDS.config, FIELDS.bank, FIELDS.skills]) {
        assert.equal(fieldOf(agent, field).state, "error", `${field} is an error behind a directory that could not be lstat'ed`);
        assert.match(fieldOf(agent, field).summary, /could not be lstat'ed \(unreadable\)/u);
      }
      assert.equal(agent.profile.path.code, "unreadable");
      assert.equal(agent.profile.renderer.state, "error");
      assert.deepEqual(data.profile.agents, { total_registered: 1, selected: 1, real: 0, blocked_at_path: 0, structurally_healthy: 0, drifted: 0, incomplete: 1, exception_authorized: 0, unobserved: 0 });
      assert.equal(agent.complete, false);
    } finally {
      chmodSync(alt.realProfiles, 0o755);
    }
    // 2. The root cannot be enumerated at all: an error in EVERY scope.
    chmodSync(alt.realProfiles, 0o300);
    try {
      for (const args of [STATUS_ARGS, [...STATUS_ARGS, "--agent", "solo-pm"]]) {
        const scope = args.includes("--agent") ? "agent scope" : "fleet scope";
        const data = status(run(args));
        assert.deepEqual(data.profile.root, { state: "error", code: "root-unreadable" }, scope);
        assert.equal(hostNamed(data, "profile.root").state, "error", scope);
        assert.equal(hostNamed(data, "profile.root").observed, "root-unreadable", scope);
        const agent = agentNamed(data, "solo-pm");
        for (const field of FIELD_ORDER) assert.equal(fieldOf(agent, field).state, "error", `${scope} ${field}`);
        assert.equal(agent.profile.path.code, "root:root-unreadable", scope);
        assert.equal(data.profile.extras.coverage, "not-swept", scope);
        assert.equal(data.profile.extras.reason, args.includes("--agent") ? "agent-scope" : "root:root-unreadable", scope);
        assert.equal(data.host.some((finding) => finding.rule_id === "profile.extras"), false, scope);
        assert.equal(data.profile.renderer.checked, 0, scope);
      }
    } finally {
      chmodSync(alt.realProfiles, 0o755);
    }
    // 3. Files the observer may not open, inside a profile it may: collection
    //    failures on their own fields, never malformed or missing.
    const solo = join(alt.realProfiles, "solo-pm");
    const sealed = ["profile.yaml", "config.delta.yaml", join("hindsight", "config.json")].map((file) => join(solo, file));
    for (const file of sealed) chmodSync(file, 0o000);
    try {
      const data = status(run([...STATUS_ARGS, "--agent", "solo-pm"]));
      const agent = agentNamed(data, "solo-pm");
      for (const field of [FIELDS.identity, FIELDS.bank]) {
        assert.equal(fieldOf(agent, field).state, "error", field);
        assert.deepEqual(kindsOf(fieldOf(agent, field)), ["unreadable"], field);
      }
      const config = fieldOf(agent, FIELDS.config);
      assert.equal(config.state, "error");
      assert.deepEqual(itemsOf(config).map((item) => [item.path, item.kind]), [["config.delta.yaml", "unreadable"]]);
      assert.equal(agent.profile.renderer.state, "error", "no check is spawned over a delta that could not be read");
      assert.equal(agent.profile.digests.delta, null);
      assert.equal(agent.profile.bank.code, "unreadable");
      assert.equal(data.profile.identity.bank_invalid, 1, "an unreadable pin is neither ok nor unpinned");
      assert.equal(fieldOf(agent, FIELDS.path).state, "pass", "the directory itself was fine");
      assert.equal(fieldOf(agent, FIELDS.skills).state, "pass");
      assert.equal(agent.complete, false);
      assert.equal(data.probes.find((probe) => probe.kind === "profile" && probe.target.endsWith("/profiles/solo-pm")).outcome, "skipped");
    } finally {
      for (const file of sealed) chmodSync(file, 0o644);
    }
  });

  check("a file over limits.max_file_bytes is too-large on its own field; a lowered max_unit_files drops the units past it; a backup pattern that does not lead with a wildcard names no stem", () => {
    const alt = makeAltHome("home-limits");
    const solo = join(alt.realProfiles, "solo-pm");
    const pad = "x".repeat(1024 * 1024);
    writeFileSync(join(solo, "profile.yaml"), `# ${pad}\nname: solo-pm\n`, "utf8");
    writeFileSync(join(solo, "hindsight", "config.json"), `{"bank_id": "agent-solo-pm", "pad": "${pad}"}\n`, "utf8");
    const scoped = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "solo-pm"], alt.env));
    const agent = agentNamed(scoped, "solo-pm");
    for (const field of [FIELDS.identity, FIELDS.bank]) {
      assert.equal(fieldOf(agent, field).state, "error", field);
      assert.deepEqual(kindsOf(fieldOf(agent, field)), ["too-large"], field);
    }
    assert.equal(agent.profile.bank.code, "too-large");
    assert.equal(scoped.profile.identity.bank_invalid, 1);
    assert.equal(textOf(agent).includes("xxxxxxxx"), false, "nothing of an oversized file reaches the payload");
    if (RENDERER_AVAILABLE) assert.equal(fieldOf(agent, FIELDS.config).state, "pass", "the config field is read on its own");
    const human = cliAt(mainRoot, ["review", "--domain", "profile", "--agent", "solo-pm"], alt.env);
    assert.match(human.stdout, /bank error/u, "an unreadable pin is painted as the error it is, never as unpinned");

    // Two units, one allowed: the second, by name, is never read. And a
    // backup pattern whose wildcard is not leading names no stem.
    const units = join(alt.home, ".config", "systemd", "user");
    mkdirSync(units, { recursive: true });
    for (const name of ["extra-a", "extra-b", "old.solo-pm", "solo-pm.bak"]) mkdirSync(join(alt.realProfiles, name, "hindsight"), { recursive: true });
    writeFileSync(join(units, "a-first.service"), ["[Service]", `Environment=HERMES_HOME=${join(alt.realProfiles, "extra-a")}`, ""].join("\n"), "utf8");
    writeFileSync(join(units, "b-second.service"), ["[Service]", `Environment=HERMES_HOME=${join(alt.realProfiles, "extra-b")}`, ""].join("\n"), "utf8");
    const limited = policyContract((document) => {
      document.profile_manifest.limits.max_unit_files = 1;
      document.profile_manifest.extras.backup_patterns.push("old.*");
    });
    const root = makePackageRoot("pkg-limits", YAML.stringify(limited, { lineWidth: 0 }));
    const fleet = status(cliAt(root, STATUS_ARGS, alt.env));
    const byPath = Object.fromEntries((hostNamed(fleet, "profile.extras").items ?? []).map((item) => [item.path, item]));
    assert.equal(byPath["extra-a"].unit_file_references, 1);
    assert.equal(byPath["extra-b"].unit_file_references, 0, "the unit past max_unit_files was never read");
    assert.deepEqual([byPath["solo-pm.bak"].class, byPath["solo-pm.bak"].detail, byPath["solo-pm.bak"].alias_of], ["retired-candidate", "backup-pattern:*.bak", "solo-pm"]);
    assert.deepEqual([byPath["old.solo-pm"].class, byPath["old.solo-pm"].detail, byPath["old.solo-pm"].alias_of], ["retired-candidate", "backup-pattern:old.*", null], "a wildcard that is not leading names no stem");
  });

  check("a core skill absent from every root is core-missing, a core entry with no SKILL.md is too, and a skills entry that is not a directory is recorded", () => {
    const alt = makeAltHome("home-core-missing");
    const links = (slug) => { const repo = makeRepo(slug); return { "SOUL.md": join(repo.runtime, "SOUL.md"), memories: join(repo.runtime, "memories") }; };
    const fiveLinks = (dir) => { for (const skill of CORE_SKILLS.filter((name) => name !== "hindsight")) symlinkSync(join(canonicalSkills, skill), join(dir, skill)); };
    // The delta REPLACES the base's external_dirs with nothing, so the
    // profile's own entry is the only root Hermes would load.
    seedProfile("absent-pm", { root: alt.realProfiles, links: links("home-core-missing-absent"), delta: { skills: { external_dirs: [] } }, skills: fiveLinks });
    seedProfile("hollow-pm", { root: alt.realProfiles, links: links("home-core-missing-hollow"), delta: { skills: { external_dirs: [] } }, skills: (dir) => { fiveLinks(dir); mkdirSync(join(dir, "hindsight")); } });
    seedProfile("fileskills-pm", { root: alt.realProfiles, links: links("home-core-missing-fileskills"), skills: null });
    writeFileSync(join(alt.realProfiles, "fileskills-pm", "skills"), "", "utf8");
    const row = (name, slug) => ({ name, rowOverrides: { repo: slug, project_path: join(reposRoot, slug), role_dir: join(reposRoot, slug, "agents", "hermes", "pm") } });
    const rows = [row("solo-pm", "home-core-missing-solo"), row("absent-pm", "home-core-missing-absent"), row("hollow-pm", "home-core-missing-hollow"), row("fileskills-pm", "home-core-missing-fileskills")];
    writeAgentRegistry(join(alt.fleet, "agents-registry.yaml"), rows);
    writeProjectRegistry(join(alt.home, ".config", "pjangler", "projects.yaml"), rows);
    const data = status(cliAt(mainRoot, STATUS_ARGS, alt.env));
    const absent = agentNamed(data, "absent-pm");
    assert.equal(fieldOf(absent, FIELDS.skills).state, "fail");
    assert.deepEqual(itemsOf(fieldOf(absent, FIELDS.skills)).map((item) => [item.kind, item.observed, item.detail]), [["core-missing", "absent", "core-missing:hindsight"]]);
    assert.deepEqual(absent.profile.skills, { state: "fail", core_present: 5, core_missing: ["hindsight"], extra: [], sources_unresolvable: 0 });
    assert.match(fieldOf(absent, FIELDS.skills).summary, /5\/6 core skills resolve to the canonical bytes; hindsight do not/u);
    const hollow = agentNamed(data, "hollow-pm");
    assert.deepEqual(itemsOf(fieldOf(hollow, FIELDS.skills)).map((item) => [item.kind, item.observed, item.detail]), [["core-missing", "no SKILL.md", "core-missing:hindsight"]]);
    assert.equal(hollow.profile.skills.core_present, 5);
    const fileSkills = agentNamed(data, "fileskills-pm");
    assert.equal(fieldOf(fileSkills, FIELDS.skills).state, "pass", "the core still resolves through external_dirs");
    assert.ok(itemsOf(fieldOf(fileSkills, FIELDS.skills)).some((item) => item.path === "skills" && item.kind === "source-unresolvable" && item.detail === "skills-not-a-directory:file"), JSON.stringify(fieldOf(fileSkills, FIELDS.skills).items));
    assert.equal(fileSkills.profile.skills.core_present, 6);
    assert.equal(data.profile.skills.core_missing, 2);
    assert.equal(data.profile.skills.core_complete, 2, "solo-pm and fileskills-pm");
  });

  check("an empty identity file declares nothing: malformed, never identity-only", () => {
    const alt = makeAltHome("home-empty-identity");
    writeFileSync(join(alt.realProfiles, "solo-pm", "profile.yaml"), "", "utf8");
    const data = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "solo-pm"], alt.env));
    const identity = fieldOf(agentNamed(data, "solo-pm"), FIELDS.identity);
    assert.equal(identity.state, "fail");
    assert.deepEqual(itemsOf(identity).map((item) => [item.kind, item.observed, item.detail]), [["malformed", "empty", "empty"]]);
    assert.deepEqual(agentNamed(data, "solo-pm").profile.identity, { state: "fail", keys: [] });
  });

  check("over an empty fleet base a delta equal to the generated config is inheritance with nothing to inherit, not a frozen copy", () => {
    requireRenderer("over an empty fleet base a delta equal to the generated config is inheritance with nothing to inherit, not a frozen copy");
    const alt = makeAltHome("home-empty-base");
    writeFileSync(join(alt.fleet, "config.yaml"), "{}\n", "utf8");
    const solo = join(alt.realProfiles, "solo-pm");
    const delta = { model: { default: "solo-model", provider: "solo" } };
    writeFileSync(join(solo, "config.delta.yaml"), YAML.stringify(delta), "utf8");
    writeFileSync(join(solo, "config.yaml"), GENERATED_HEADER + YAML.stringify(delta), "utf8");
    const data = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "solo-pm"], alt.env));
    const config = fieldOf(agentNamed(data, "solo-pm"), FIELDS.config);
    assert.equal(config.state, "pass", JSON.stringify(config.items));
    assert.equal(agentNamed(data, "solo-pm").profile.renderer.state, "in-sync");
    assert.equal(textOf(data).includes("solo-model"), false, "the delta was parsed for equality only");
  });

  check("a lock the renderer creates on first use is invisible to the next run and never counts toward the root cap", () => {
    requireRenderer("a lock the renderer creates on first use is invisible to the next run and never counts toward the root cap");
    const alt = makeAltHome("home-first-lock");
    const lock = join(alt.realProfiles, ".solo-pm.config.lock");
    rmSync(lock);
    // Direct spawns: the first run WRITES the lock, which the zero-write snapshot would rightly refuse.
    const run = () => spawnSync(process.execPath, [join(mainRoot, "dist", "index.js"), ...STATUS_ARGS], {
      cwd: workdir, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...isolation, ...alt.env },
    });
    const first = run();
    assert.equal(existsSync(lock), true, "the renderer's check created its lock on first use");
    assert.equal(lstatSync(lock).size, 0);
    const second = run();
    assert.equal(first.stdout, second.stdout, "the lock the first run created changes nothing the second reports");
    const data = status(first);
    assert.equal(fieldOf(agentNamed(data, "solo-pm"), FIELDS.config).state, "pass");
    assert.equal(data.profile.extras.entries_total, 0, "the lock is never an extra");
    assert.equal(hostNamed(data, "profile.extras").state, "pass");
    // With the root cap at ONE entry, the lock beside the one profile is not a second entry.
    const capped = makePackageRoot("pkg-root-cap-one", YAML.stringify(policyContract((document) => { document.profile_manifest.limits.max_root_entries = 1; }), { lineWidth: 0 }));
    const under = status(cliAt(capped, STATUS_ARGS, alt.env));
    assert.equal(under.profile.extras.truncated, false, "a lock entry never counts toward max_root_entries");
    assert.equal(agentNamed(under, "solo-pm").profile.path.code, "ok");
  });

  check("the renderer child runs in the submodule worktree with the allowlisted environment and nothing else", () => {
    requireRenderer("the renderer child runs in the submodule worktree with the allowlisted environment and nothing else");
    const recorder = join(shimRoot, "python3-env.log");
    rmSync(recorder, { force: true });
    const realPython = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
    const shim = pathShim("env-recording", [
      "#!/bin/sh",
      `printf '%s\\n' "argv=$*" "cwd=$PWD" "secret=\${PLANE_33GOD_API_KEY:-unset}" "lock=\${HERMES_PROFILE_CONFIG_LOCK_TIMEOUT_SECONDS:-unset}" "home=$HOME" "fleet=\${HERMES_FLEET_HOME:-unset}" "keys=$(env | cut -d= -f1 | sort | tr '\\n' ',')" "--" >> "${recorder}"`,
      `exec "${realPython}" "$@"`,
      "",
    ].join("\n"));
    status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"], { PATH: `${shim}:${process.env.PATH}` }));
    const records = readFileSync(recorder, "utf8").split("--\n").filter((record) => record.trim() !== "")
      .map((record) => Object.fromEntries(record.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])));
    const checkRun = records.find((record) => record.argv.includes("hermes-profile-config.py check --profile clean-pm"));
    assert.ok(checkRun, `the renderer's check ran: ${JSON.stringify(records)}`);
    assert.equal(realpathSync(checkRun.cwd), realpathSync(join(mainRoot, "templates", "hermes-agent")), "the check runs in the submodule worktree");
    assert.equal(checkRun.secret, "unset", "the parent's Plane key never reaches the child");
    assert.equal(checkRun.lock, "32", "the renderer's own lock wait is the contract's timeout plus the margin");
    assert.equal(checkRun.home, scratchHome);
    assert.equal(checkRun.fleet, fleetHome);
    // `NODE_V8_COVERAGE` is Node's own addition, not a leak: under coverage Node
    // injects it into every child it spawns, including one handed a fully
    // explicit `env`, so child coverage is collected. The renderer cannot
    // suppress it and it names a directory, not a secret. Without it this case
    // fails under `npm run test:coverage` — what CI runs — and passes under
    // `npm test`, which is why CI and local disagreed.
    const allowed = new Set(["PATH", "LANG", "HOME", "HERMES_FLEET_HOME", "HERMES_PROFILE_CONFIG_LOCK_TIMEOUT_SECONDS", "PYTHONDONTWRITEBYTECODE", "PYTHONHASHSEED", "PYTHONIOENCODING", "PWD", "OLDPWD", "SHLVL", "_", "NODE_V8_COVERAGE"]);
    const leaked = checkRun.keys.split(",").filter((key) => key !== "" && !allowed.has(key));
    assert.deepEqual(leaked, [], "no key outside the allowlist reaches the renderer");
    const probeRun = records.find((record) => record.argv.startsWith("-B -c "));
    assert.ok(probeRun, "the interpreter probe ran");
    assert.equal(probeRun.secret, "unset");
  });

  check("every rule-detail pattern the observer compares against matches a literal detail the rule actually emits", () => {
    // The agreement check reads `hermes.runtime-singleton`'s detail lines by
    // prefix. Each prefix is pinned here against the rule's own source, so a
    // reworded detail turns this red instead of silently making the two never
    // meet.
    const statusSource = readFileSync(join(PKG, "src", "org", "status.ts"), "utf8");
    const block = /const PROFILE_RULE_DETAIL_PATTERNS: readonly RegExp\[\] = \[([\s\S]*?)\];/u.exec(statusSource);
    assert.ok(block, "status.ts must declare PROFILE_RULE_DETAIL_PATTERNS");
    const patterns = [...block[1].matchAll(/\/((?:\\\/|[^\/\n])+)\/u/gu)].map((match) => new RegExp(match[1], "u"));
    assert.ok(patterns.length >= 9, `expected the nine patterns, parsed ${patterns.length}`);
    const rules = readFileSync(join(PKG, "src", "parity", "rules.ts"), "utf8");
    const auditStart = rules.indexOf('id: "hermes.runtime-singleton",');
    const audit = rules.slice(auditStart, rules.indexOf("migrate: (ctx, finding) => {", auditStart));
    const findings = rules.slice(rules.indexOf("function profileConfigFindings("), rules.indexOf("function isDanglingLink("));
    const literals = [];
    for (const source of [audit, findings]) {
      for (const match of source.matchAll(/(?:details|out)\.push\(\s*`([^`]*)`/gu)) literals.push(match[1]);
    }
    // `${state}: ...` is the link check; `linkState` returns these three words.
    const expanded = literals.flatMap((literal) => (literal.startsWith("${state}: ") ? ["missing", "not-a-symlink", "wrong-target"].map((word) => literal.replace("${state}", word)) : [literal]));
    assert.ok(expanded.length >= 8, `expected the rule's detail literals, found ${expanded.length}`);
    for (const pattern of patterns) {
      assert.ok(expanded.some((literal) => pattern.test(literal)), `pattern ${pattern} matches none of the rule's detail literals: ${JSON.stringify(expanded)}`);
    }
  });

  // -- AC7: scoping ------------------------------------------------------------------

  check("--agent inspects one profile, never sweeps, and keeps fleet totals; --domain registry spawns zero profile probes", () => {
    requireRenderer("--agent inspects one profile, never sweeps, and keeps fleet totals; --domain registry spawns zero profile probes");
    const scoped = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "clean-pm"]));
    assert.equal(scoped.profile.extras.coverage, "not-swept");
    assert.equal(scoped.profile.extras.reason, "agent-scope");
    assert.equal(scoped.profile.extras.entries_total, 0);
    assert.equal(scoped.host.some((finding) => finding.rule_id === "profile.extras"), false, "no profile.extras host finding in agent scope");
    assert.deepEqual(scoped.host.map((finding) => finding.rule_id).sort(), ["profile.renderer", "profile.root", "profile.skill-core"], "the three machine-level findings, never the sweep");
    assert.deepEqual(scoped.profile.agents, {
      total_registered: REGISTERED, selected: 1, real: 1, blocked_at_path: 0,
      structurally_healthy: 1, drifted: 0, incomplete: 0, exception_authorized: 0, unobserved: REGISTERED - 1,
    }, `got ${JSON.stringify(scoped.profile.agents)} for ${JSON.stringify(agentNamed(scoped, "clean-pm").profile)}`);
    const profileProbes = scoped.probes.filter((probe) => probe.kind === "profile");
    assert.ok(profileProbes.some((probe) => probe.target.endsWith("/profiles/clean-pm")), "the selected profile was read");
    assert.ok(profileProbes.every((probe) => !probe.target.includes("/profiles/stale-pm")), "no other profile was read");
    // The case-collision gate still knows the whole root in agent scope.
    const twin = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "twin-pm"]));
    assert.equal(agentNamed(twin, "twin-pm").profile.path.code, "case-collision");

    const registry = status(cliAt(mainRoot, ["review", "--domain", "registry", "--json"]));
    assert.deepEqual(registry.probes.filter((probe) => probe.kind === "profile"), [], "zero profile probes");
    assert.equal(registry.profile, null);
    for (const agent of registry.agents) {
      assert.ok("profile" in agent, "the key is present");
      assert.equal(agent.profile, null);
    }
  });

  // -- AC8: rule agreement under --live ------------------------------------------

  check("under --live the observer and hermes.runtime-singleton agree, disagree, or are not compared -- by name", () => {
    requireRenderer("under --live the observer and hermes.runtime-singleton agree, disagree, or are not compared -- by name");
    const passShim = entry("rule-pass", syntheticReport([SINGLETON_RULE_PASS]));
    const failShim = entry("rule-fail", syntheticReport([SINGLETON_RULE_FAIL]));
    const otherFailShim = entry("rule-other-fail", syntheticReport([SINGLETON_RULE_OTHER_FAIL]));
    const symlinkShim = entry("rule-symlink", syntheticReport([SINGLETON_RULE_SYMLINK]));
    const wrongTargetShim = entry("rule-wrong-target", syntheticReport([SINGLETON_RULE_WRONG_TARGET]));
    const live = (agent, shim) => status(cliAt(mainRoot, [...STATUS_ARGS, "--live", "--agent", agent], { PJ_FLEET_CLI_ENTRY: shim }));

    const agree = live("clean-pm", passShim);
    assert.deepEqual(agree.profile.rule_agreement, { compared: 1, agree: 1, disagree: 0, not_compared: 0 });
    assert.equal(agree.findings.some((finding) => finding.code === "profile-rule-disagreement"), false);

    const disagree = live("nodelta-pm", passShim);
    assert.deepEqual(disagree.profile.rule_agreement, { compared: 1, agree: 0, disagree: 1, not_compared: 0 });
    const finding = disagree.findings.find((item) => item.code === "profile-rule-disagreement");
    assert.ok(finding, "a disagreement is a finding");
    assert.equal(finding.agent_id, "nodelta-pm");
    assert.equal(finding.scope, "agent");
    assert.equal(finding.severity, "error");
    assert.equal(finding.status_severity, "high");
    assert.equal(finding.gating, true);
    assert.match(finding.detail, /reports pass while the profile observer finds drift/u);
    const agent = agentNamed(disagree, "nodelta-pm");
    assert.equal(agent.observations.find((item) => item.rule_id === "hermes.runtime-singleton").state, "pass", "the rule's reading stands");
    assert.equal(fieldOf(agent, FIELDS.config).state, "fail", "and so does the observer's");
    assert.equal(disagree.findings.some((item) => item.code === "status-contradiction"), false, "the two never meet in detectContradictions: different fields by design");

    const reverse = live("clean-pm", failShim);
    assert.deepEqual(reverse.profile.rule_agreement, { compared: 1, agree: 0, disagree: 1, not_compared: 0 });
    assert.match(reverse.findings.find((item) => item.code === "profile-rule-disagreement").detail, /reports fail while the profile observer finds no drift/u);

    // A rule fail about something the observer never reads is not compared.
    const other = live("clean-pm", otherFailShim);
    assert.deepEqual(other.profile.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 });
    // Semantic drift alone is coverage the rule never had: not compared.
    const semantic = live("stale-pm", passShim);
    assert.deepEqual(semantic.profile.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 });
    // The optional fleet policy rejects profile aliases while the core may
    // safely accept them. These are different policies, so do not manufacture
    // a disagreement or agreement from their path gates.
    const gatedDisagree = live("symlink-pm", passShim);
    assert.deepEqual(gatedDisagree.profile.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 });
    assert.equal(gatedDisagree.findings.some((item) => item.code === "profile-rule-disagreement"), false);
    assert.equal(fieldOf(agentNamed(gatedDisagree, "symlink-pm"), FIELDS.config).state, "unobserved", "the policy dependents stay unobserved");
    const gatedAgree = live("symlink-pm", symlinkShim);
    assert.deepEqual(gatedAgree.profile.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 });
    // A misowned singleton link is the rule's wrong-target reading.
    const misownedAgree = live("misowned-pm", wrongTargetShim);
    assert.deepEqual(misownedAgree.profile.rule_agreement, { compared: 1, agree: 1, disagree: 0, not_compared: 0 });
    const misownedDisagree = live("misowned-pm", passShim);
    assert.deepEqual(misownedDisagree.profile.rule_agreement, { compared: 1, agree: 0, disagree: 1, not_compared: 0 });
    // A real file where the rule expects a link is the rule's not-a-symlink reading.
    const notLinkShim = entry("rule-not-a-symlink", syntheticReport([{ ...SINGLETON_RULE_WRONG_TARGET, details: ["not-a-symlink: x/SOUL.md"] }]));
    const notLinkAgree = live("misowned-pm", notLinkShim);
    assert.deepEqual(notLinkAgree.profile.rule_agreement, { compared: 1, agree: 1, disagree: 0, not_compared: 0 });
    // A gate the rule never checks (a case-insensitive twin) is a partial reading: not compared.
    const twinGated = live("twin-pm", passShim);
    assert.deepEqual(twinGated.profile.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 });
  });

  check("a warning HOST rule counts against proof until an allowed_warnings entry lifts it, and never touches healthy", () => {
    // Story 1.7 widened `health.unjustified` to host findings. A host-scoped
    // rule for the profile domain that warns, with nothing authorizing it,
    // flips the verdict to unproven on a clean agent; the same run under a
    // contract naming the rule in `allowed_warnings` is justified again.
    const warnShim = entry("rule-host-warn", syntheticReport([SINGLETON_RULE_PASS, PROFILE_WIRING_WARN]));
    const before = status(cliAt(mainRoot, [...STATUS_ARGS, "--live", "--agent", "clean-pm"], { PJ_FLEET_CLI_ENTRY: warnShim }));
    const wiring = hostNamed(before, "hermes.profile-wiring");
    assert.equal(wiring.state, "warn");
    assert.equal(wiring.justification, null);
    assert.equal(before.health.unjustified, 1, "the host warn is the one unjustified gap");
    assert.equal(before.health.verdict, "unproven");
    const ruled = policyContract((document) => {
      document.health_policy.allowed_warnings.push({ rule_id: "hermes.profile-wiring", reason: "the shared profile root is wired on purpose", owner: "suite" });
    });
    const root = makePackageRoot("pkg-host-warn", YAML.stringify(ruled, { lineWidth: 0 }));
    const after = status(cliAt(root, [...STATUS_ARGS, "--live", "--agent", "clean-pm"], { PJ_FLEET_CLI_ENTRY: warnShim }));
    assert.equal(hostNamed(after, "hermes.profile-wiring").state, "warn", "the reading is unchanged");
    assert.equal(hostNamed(after, "hermes.profile-wiring").justification.kind, "allowed_warning");
    assert.equal(after.health.unjustified, 0);
    assert.equal(after.health.healthy, before.health.healthy, "a host warn never touched healthy either way");
  });

  check("a skipping HOST rule counts against proof until an allowed_skips entry lifts it", () => {
    const PROFILE_WIRING_SKIP = { ...PROFILE_WIRING_WARN, status: "skip", summary: "the shared profile root was not inspected" };
    const skipShim = entry("rule-host-skip", syntheticReport([SINGLETON_RULE_PASS, PROFILE_WIRING_SKIP]));
    const before = status(cliAt(mainRoot, [...STATUS_ARGS, "--live", "--agent", "clean-pm"], { PJ_FLEET_CLI_ENTRY: skipShim }));
    const wiring = hostNamed(before, "hermes.profile-wiring");
    assert.equal(wiring.state, "skip");
    assert.equal(wiring.justification, null);
    assert.equal(before.health.unjustified, 1, "the host skip is the one unjustified gap");
    assert.equal(before.health.verdict, "unproven");
    const ruled = policyContract((document) => {
      document.health_policy.allowed_skips.push({ rule_id: "hermes.profile-wiring", reason: "a default audit never inspects the shared root" });
    });
    const root = makePackageRoot("pkg-host-skip", YAML.stringify(ruled, { lineWidth: 0 }));
    const after = status(cliAt(root, [...STATUS_ARGS, "--live", "--agent", "clean-pm"], { PJ_FLEET_CLI_ENTRY: skipShim }));
    assert.equal(hostNamed(after, "hermes.profile-wiring").state, "skip", "the reading is unchanged");
    assert.equal(hostNamed(after, "hermes.profile-wiring").justification.kind, "allowed_skip");
    assert.equal(after.health.unjustified, 0);
    assert.equal(after.health.healthy, before.health.healthy, "a host skip never touched healthy either way");
  });

  // -- exceptions ride the existing axis ----------------------------------------

  check("an agent_exceptions entry makes a drifted profile an exception and leaves health.healthy alone", () => {
    requireRenderer("an agent_exceptions entry makes a drifted profile an exception and leaves health.healthy alone");
    const ruled = policyContract((document) => {
      document.health_policy.agent_exceptions = [
        { domain: "profile", agent_id: "stale-pm", reason: "this profile pins the older base on purpose", owner: "suite" },
      ];
    });
    const root = makePackageRoot("pkg-exception", YAML.stringify(ruled, { lineWidth: 0 }));
    const before = status(cliAt(mainRoot, STATUS_ARGS));
    const after = status(cliAt(root, STATUS_ARGS));
    const config = fieldOf(agentNamed(after, "stale-pm"), FIELDS.config);
    assert.equal(config.state, "fail", "the drift is still reported and still fail");
    assert.deepEqual(config.justification, { kind: "exception", policy: "health_policy.agent_exceptions[0]", reason: "this profile pins the older base on purpose", owner: null });
    assert.equal(config.applicability, "exception");
    assert.equal(fieldOf(agentNamed(after, "stale-pm"), FIELDS.bank).justification, null, "a passing field carries no ruling");
    assert.equal(agentNamed(before, "stale-pm").member_class, "unhealthy");
    assert.equal(agentNamed(after, "stale-pm").member_class, "exception");
    assert.equal(after.profile.agents.exception_authorized, before.profile.agents.exception_authorized + 1);
    assert.equal(after.profile.agents.drifted, before.profile.agents.drifted - 1);
    assert.equal(after.health.healthy, before.health.healthy, "a ruling never changes health.healthy");
    assert.equal(fieldOf(agentNamed(after, "nodelta-pm"), FIELDS.config).justification, null, "another agent's drift is untouched");
  });

  // -- caps, payloads, deadlines -----------------------------------------------------

  check("the payload survives a real pipe past 64 KiB, and two runs plus the MCP tool are byte-identical with no secret, body, value or timestamp", () => {
    requireRenderer("the payload survives a real pipe past 64 KiB, and two runs plus the MCP tool are byte-identical with no secret, body, value or timestamp");
    const before = snapshotIsolated();
    const piped = spawnSync("sh", ["-c", `"$0" "$@" | cat`, process.execPath, join(mainRoot, "dist", "index.js"), ...STATUS_ARGS], {
      cwd: workdir, env: { ...process.env, ...isolation }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000,
    });
    assertUnchanged(before, snapshotIsolated(), "the piped run");
    assert.ok(piped.stdout.length > 65_536, `payload is only ${piped.stdout.length} bytes; below the pipe buffer the defect cannot fire`);
    status(piped);
    const first = cliAt(mainRoot, STATUS_ARGS);
    const second = cliAt(mainRoot, STATUS_ARGS);
    assert.equal(first.stdout, second.stdout, "data is not byte-stable across two runs, lock files included");
    assert.equal(JSON.stringify(JSON.parse(first.stdout).data), JSON.stringify(JSON.parse(piped.stdout).data), "the piped run is the same data");
    const human = cliAt(mainRoot, ["review", "--domain", "profile"]);
    for (const [name, text] of [["--json", first.stdout], ["the human report", human.stdout]]) {
      assert.ok(text.length > 0, `${name} is empty`);
      assert.equal(text.includes(SECRET_SENTINEL), false, `the planted secret reached ${name}`);
      assert.equal(text.includes("fleet-model"), false, `a config value reached ${name}`);
      assert.equal(text.includes("hindsight-mcp"), false, `a config value reached ${name}`);
      assert.equal(text.includes("The canonical"), false, `a SKILL.md body reached ${name}`);
      assert.equal(text.includes("secret memory"), false, `a memory reached ${name}`);
      assert.equal(text.includes(GENERATED_HEADER.trim()), false, `the generated header reached ${name}`);
      assert.equal(text.includes(profilesRoot), false, `an absolute profile path reached ${name}`);
      assert.equal(text.includes(canonicalSkills), false, `an absolute canonical path reached ${name}`);
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u, `a timestamp reached ${name}`);
    }
    assert.match(human.stdout, /profile in-sync · bank ok · skills 6\/6/u, "the report prints the per-agent profile cell");
    assert.match(human.stdout, /root ok · renderer ok · python ok/u, "the report prints the domain gates");
    assert.match(human.stdout, /extras swept: \d+ unregistered entries/u, "the report prints the sweep");
    assert.match(human.stdout, /profile\.extras/u, "the report prints the extras host finding");
    assert.match(human.stdout, /semantic-drift config\.yaml/u, "the report prints typed items");
    // Every cell shape beyond the clean row, by fixture profile.
    assert.match(human.stdout, /profile drifted · bank ok · skills 6\/6 · drift in model/u, "a drifted row names its sections");
    assert.match(human.stdout, /profile symlink · bank unobserved · skills unobserved/u, "a gated row names its gate code and its unread dependents");
    assert.match(human.stdout, /profile unverifiable · bank ok/u, "an unverifiable link is painted as the warn it is");
    assert.match(human.stdout, /bank invalid/u, "a malformed pin reads bank invalid");
    assert.match(human.stdout, /bank unpinned/u, "a missing pin reads bank unpinned");
    assert.match(human.stdout, /bank agent-Alias-pm/u, "an aliased pin shows the id as read");
    assert.match(human.stdout, /identity warn/u, "an unknown identity key is a warn cell");
    assert.match(human.stdout, /skills 4\/6/u, "a profile lacking core skills prints the count");
    const scopedHuman = cliAt(mainRoot, ["review", "--domain", "profile", "--agent", "clean-pm"]);
    assert.match(scopedHuman.stdout, /extras not swept \(agent-scope\)/u, "an --agent report says the root was not swept");
  });

  await checkAsync("the MCP tool returns the same data as the CLI, profile summaries included", async () => {
    const cli = status(cliAt(mainRoot, STATUS_ARGS));
    const env = { ...process.env, ...isolation };
    const before = snapshotIsolated();
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(mainRoot, "dist", "mcp-server.js")], cwd: workdir, env });
    const client = new Client({ name: "fleet-profile-suite", version: "1.0.0" });
    await client.connect(transport);
    let result;
    try {
      result = await client.callTool({ name: "flume_review", arguments: { domain: "profile" } });
    } finally {
      await client.close();
    }
    assertUnchanged(before, snapshotIsolated(), "the MCP run");
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
    const parsed = JSON.parse(text);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data, cli, "MCP data must deep-equal the CLI's");
    assert.ok(parsed.data.profile, "data.profile is present over MCP");
    assert.ok(parsed.data.agents.every((agent) => agent.profile !== null), "every agents[].profile is present over MCP");
  });

  check("a blown --deadline-ms is TIMEOUT at exit 7 with no partial result", () => {
    const result = cliAt(mainRoot, [...STATUS_ARGS, "--deadline-ms", "1"]);
    assert.equal(result.status, 7, `expected exit 7, got ${result.status}`);
    assert.equal(errorCode(envelope(result)), "TIMEOUT");
  });

  // -- contracts: the manifest, and contracts that must not load -------------

  check("a schema-3 contract with no profile_manifest loads and reports every field unsupported under profile.manifest", () => {
    const bare = policyContract((document) => {
      delete document.profile_manifest;
      delete document.authorities.agent_profile_state;
      document.schema_version = 3;
      document.compatibility.max_schema_version = 3;
    });
    const root = makePackageRoot("pkg-no-manifest", YAML.stringify(bare, { lineWidth: 0 }));
    const data = status(cliAt(root, [...STATUS_ARGS, "--agent", "clean-pm"]));
    const agent = agentNamed(data, "clean-pm");
    const gaps = agent.observations.filter((item) => item.source === "fleet-profile");
    assert.deepEqual(gaps.map((item) => item.field), FIELD_ORDER);
    for (const gap of gaps) {
      assert.equal(gap.state, "unsupported");
      assert.match(gap.summary, /profile_manifest/u);
      assert.equal(gap.justification, null, "unjustified: the tracked policy declares no such deferral");
    }
    assert.equal(agent.profile, null);
    assert.equal(data.profile.root.code, "manifest-undeclared");
    assert.equal(data.profile.agents.unobserved, REGISTERED, "nothing was observed");
    assert.deepEqual(data.probes.filter((probe) => probe.kind === "profile"), [], "nothing is read without a manifest");
    assert.equal(data.host.some((finding) => finding.rule_id.startsWith("profile.")), false);
  });

  check("fleet status refuses a manifest that names nothing real, before any probe", () => {
    const cases = [
      ["unknown-key", (document) => { document.profile_manifest.renderer.timeout_seconds = 5; }, /profile_manifest\.renderer\.timeout_seconds/u],
      ["template-no-placeholder", (document) => { document.profile_manifest.memory.bank_id_template = "agent-shared"; }, /bank_id_template must carry/u],
      ["duplicate-skill", (document) => { document.profile_manifest.skill_core.required.push("hindsight"); }, /duplicate entry hindsight/u],
      ["absolute-canonical", (document) => { document.profile_manifest.skill_core.canonical_dir = "/srv/skills"; }, /canonical_dir must start with/u],
      ["argv-no-profile", (document) => { document.profile_manifest.renderer.check_argv = ["check", "--all"]; }, /exactly one argument must carry/u],
      ["argv-not-check", (document) => { document.profile_manifest.renderer.check_argv = ["render", "--profile", "{profile_name}"]; }, /read-only `check` subcommand/u],
      ["other-submodule", (document) => { document.profile_manifest.renderer.submodule = "templates/other"; }, /must equal scaffold_manifest\.template_submodule/u],
      ["limit-over-ceiling", (document) => { document.profile_manifest.limits.max_file_bytes = 2 * 1024 * 1024; }, /may not exceed this build's ceiling/u],
      ["undeclared-pin-leaf", (document) => { document.profile_manifest.memory.pin_file = "memory/pin.json"; }, /not declared writable by any authority/u],
      ["inert-and-allowed", (document) => { document.profile_manifest.identity.inert_keys.push("role"); }, /already an allowed identity key/u],
      ["lock-not-ignored", (document) => { document.profile_manifest.extras.ignored_patterns = ["*.tmp"]; }, /must cover renderer\.lock_pattern/u],
      ["lock-timeout-negative", (document) => { document.profile_manifest.renderer.lock_timeout_seconds = -1; }, /lock_timeout_seconds must be a positive number/u],
      ["lock-timeout-over-a-minute", (document) => { document.profile_manifest.renderer.lock_timeout_seconds = 61; }, /at most 60/u],
      ["lock-pattern-no-placeholder", (document) => { document.profile_manifest.renderer.lock_pattern = ".fleet.config.lock"; }, /lock_pattern must carry the \{profile_name\} placeholder/u],
      // The ignore list covers the path-shaped pattern (`?` matches `/`), so the ONE diagnostic is the path itself.
      ["lock-pattern-path", (document) => { document.profile_manifest.renderer.lock_pattern = "{profile_name}/lock"; document.profile_manifest.extras.ignored_patterns = ["*?lock"]; }, /never a path/u],
      ["canonical-dir-env-not-a-key", (document) => { document.profile_manifest.skill_core.canonical_dir_env = "not a key"; }, /canonical_dir_env must be an environment key/u],
      ["no-ignored-patterns", (document) => { document.profile_manifest.extras.ignored_patterns = []; }, /ignored_patterns must name the renderer's lock entries/u],
      ["wildcard-only-pattern", (document) => { document.profile_manifest.extras.ignored_patterns.push("?*"); }, /may not match every entry/u],
    ];
    for (const [name, mutate, hint] of cases) {
      const path = writeContract(name, policyContract(mutate));
      const result = cliAt(mainRoot, [...STATUS_ARGS, "--contract", path]);
      assert.equal(result.status, 2, `${name}: a contract that lies must exit 2, got ${result.status}: ${result.stdout.slice(0, 300)}`);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "INVALID_INPUT", name);
      // The message carries the first diagnostic; a manifest that lies in two
      // places lists every diagnostic under details, so the hint is matched there too.
      const diagnostics = [parsed.error.message, ...Object.values(parsed.error.details ?? {}).filter((value) => typeof value === "string")].join("\n");
      assert.match(diagnostics, hint, name);
      assert.match(parsed.error.message, /profile_manifest/u, name);
    }
  });

  check("the tracked contract validates at schema 5, and its skill core equals the template's CORE_RUNTIME_SKILLS at the gitlink", () => {
    // The TRACKED contract, which is its own canonical serialization; a
    // fixture root's re-serialized copy is not, by design.
    const result = cliAt(mainRoot, ["handbook", "validate", "--contract", TRACKED_CONTRACT, "--json"]);
    const parsed = envelope(result);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.error));
    assert.equal(parsed.data.schema_version, 5);
    const contract = contractDocument();
    // Story 1.8 bumped it again for `service_manifest`; this case pins the
    // MINIMUM the profile manifest needs, not the exact version, so the next
    // root-key story does not have to edit an assertion about a block it does
    // not touch.
    assert.ok(Number.parseInt(contract.contract_version.split(".")[1] ?? "0", 10) >= 4, contract.contract_version);
    assert.equal(contract.health_policy.deferred_capabilities.some((entry) => entry.capability === "profile.render_generation"), false, "the profile.render_generation deferral is gone: the observer answers it");
    // The three provisioned leaves merged into `agent_profile_state` beside the
    // renderer's four; they are still declared, just not in their own block.
    for (const leaf of [FIELDS.identity, FIELDS.bank, FIELDS.skills]) {
      assert.ok(contract.authorities.agent_profile_state.writable_fields.includes(leaf), `agent_profile_state must still declare ${leaf}`);
    }
    const script = pinned(PROFILE_SCRIPT_REL).toString("utf8");
    assert.doesNotMatch(script, /CORE_RUNTIME_SKILLS=/, "the template delegates selection to Skillex");
    assert.deepEqual(contract.profile_manifest.skill_core.required, [], "default fleet policy does not require a global projection");
    assert.match(contract.profile_manifest.skill_core.source, /explicit fleet byte-policy/);
    // And the singleton links the observer checks are the ones the rule provisions.
    const rules = readFileSync(join(PKG, "src", "parity", "rules.ts"), "utf8");
    const entriesBlock = /const OWNED_PROFILE_ENTRIES = \[([^\]]*)\]/u.exec(rules);
    const filesBlock = /const OWNED_PROFILE_FILES = \[([^\]]*)\]/u.exec(rules);
    assert.ok(entriesBlock && filesBlock, "rules.ts must declare the owned profile entries and files");
    const ruleLinks = [...`${entriesBlock[1]},${filesBlock[1]}`.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    const observer = readFileSync(join(PKG, "src", "org", "profile.ts"), "utf8");
    const observerBlock = /PROFILE_SINGLETON_LINKS = \[([^\]]*)\]/u.exec(observer);
    const observerLinks = [...observerBlock[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    assert.deepEqual([...observerLinks].sort(), [...ruleLinks].sort(), "PROFILE_SINGLETON_LINKS must mirror the rule's OWNED_PROFILE_ENTRIES + OWNED_PROFILE_FILES");
  });

  // -- the gates that make this reachable on a fresh clone --------------------

  check("the runner knows about profile health", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.match(runner, /tests\/fleet-profile-regressions\.mjs/u, "a suite not listed in SUITES never runs");
  });

  check("no invocation in this suite wrote to this repository or its template submodule", () => {
    assertUnchanged(sharedAtStart, snapshotShared(), "this suite");
  });

  // -- AC11: the live fleet, sampled independently ------------------------------

  check("on the real fleet every unregistered root entry is classified, every symlink is reported, and the renderer reading agrees with an independent check", () => {
    const label = "on the real fleet every unregistered root entry is classified, every symlink is reported, and the renderer reading agrees with an independent check";
    if (!existsSync(REAL_AGENT_REGISTRY) || !existsSync(REAL_PROJECT_REGISTRY)) skipCase(label, "the operator's live registries are not on this host");
    const realFleetHome = process.env.HERMES_FLEET_HOME?.trim() || join(REAL_HOME, ".hermes");
    const realRoot = join(realFleetHome, "profiles");
    if (!existsSync(realRoot) || !existsSync(join(realFleetHome, "config.yaml"))) skipCase(label, "the live profile root or fleet base is not on this host");
    const registered = YAML.parse(readFileSync(REAL_AGENT_REGISTRY, "utf8"))?.agents ?? {};
    if (!registered["pjangler-pm"]) skipCase(label, "the live registry has no pjangler-pm row");
    if (!existsSync(join(realRoot, "pjangler-pm", "config.delta.yaml"))) skipCase(label, "the live pjangler-pm profile carries no delta");

    const liveEnv = { ...process.env, NO_COLOR: "1" };
    const porcelainBefore = git(SUBMODULE, ["status", "--porcelain"]).stdout;
    // The real root, before and after: entry names, types and mtimes. The
    // renderer's check opens a profile's existing lock file, or creates it on
    // first use for a newly registered profile, so lock entries are the one
    // thing allowed to appear; nothing else may move.
    const rootSnapshot = () => readdirSync(realRoot).sort().filter((name) => !/^\..+\.config\.lock$/u.test(name)).map((name) => {
      const stat = lstatSync(join(realRoot, name));
      return `${name}:${stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other"}:${stat.mtimeMs}`;
    });
    const rootBefore = rootSnapshot();
    const result = spawnSync(process.execPath, [CLI, ...STATUS_ARGS], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000, env: liveEnv });
    assert.equal(result.status, 0, `the live fleet must report at exit 0: ${result.stderr}`);
    assert.equal(git(SUBMODULE, ["status", "--porcelain"]).stdout, porcelainBefore, "the submodule worktree is untouched by a live run");
    assert.deepEqual(rootSnapshot(), rootBefore, "the live profile root is untouched by a live run");
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.profile.agents.total_registered, Object.keys(registered).length);
    assert.equal(data.profile.renderer.source, "ok", `the live renderer must be canonical: ${JSON.stringify(data.profile.renderer)}`);
    assert.equal(data.profile.renderer.gitlink, GITLINK);
    assert.equal(data.profile.extras.coverage, "swept");

    // Independently: every non-registered, non-lock root entry appears with a
    // class, and every symlink entry is reported as one.
    const registeredNames = new Set(Object.values(registered).map((row) => row?.profile_name).filter((name) => typeof name === "string"));
    const extras = data.host.find((finding) => finding.rule_id === "profile.extras");
    assert.ok(extras, "the live root has a sweep");
    const listed = new Map((extras.items ?? []).map((item) => [item.path, item]));
    let symlinksSeen = 0;
    for (const name of readdirSync(realRoot)) {
      if (/^\..+\.config\.lock$/u.test(name)) continue;
      const stat = lstatSync(join(realRoot, name));
      if (registeredNames.has(name)) {
        if (stat.isSymbolicLink()) {
          const agentId = Object.entries(registered).find(([, row]) => row?.profile_name === name)?.[0];
          const agent = data.agents.find((candidate) => candidate.agent_id === agentId);
          assert.ok(agent, `registered symlinked profile ${name} must have a record`);
          assert.equal(agent.profile.path.code, "symlink", `${name} must read as a path fail`);
          symlinksSeen += 1;
        }
        continue;
      }
      const item = listed.get(name);
      assert.ok(item, `unregistered root entry ${name} must be classified`);
      assert.ok(EXTRA_CLASSES.includes(item.class), `${name} carries a class`);
      if (stat.isSymbolicLink()) { assert.ok(item.kind === "symlink" || item.kind === "dangling-symlink", `${name} must be reported as a symlink`); symlinksSeen += 1; }
    }

    // Independently: the canonical renderer's own check for pjangler-pm.
    const check_ = spawnSync("python3", ["-B", join(SUBMODULE, RENDERER_REL), "check", "--profile", "pjangler-pm"], {
      cwd: SUBMODULE, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: REAL_HOME, LANG: process.env.LANG ?? "C.UTF-8", HERMES_FLEET_HOME: realFleetHome, PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", PYTHONIOENCODING: "utf-8" },
    });
    const agent = data.agents.find((candidate) => candidate.agent_id === "pjangler-pm");
    assert.ok(agent, "pjangler-pm must have a record");
    if (check_.status === 0) {
      assert.match(check_.stdout, /^OK:/u);
      assert.equal(agent.profile.renderer.state, "in-sync", "the observer must agree with an independent in-sync check");
    } else {
      assert.match(check_.stdout, /^PROFILE CONFIG DRIFT:/u, `an independent check exited ${check_.status} without a drift block: ${check_.stderr}`);
      assert.equal(agent.profile.renderer.state, "drifted", "the observer must agree with an independent drifted check");
      const sections = /drift in: ([^\n]+)/u.exec(check_.stdout)?.[1]?.split(",").map((item) => item.trim()).sort() ?? [];
      assert.deepEqual(agent.profile.renderer.sections, sections, "the observer names the same drifted sections");
    }
    console.log(`       live: ${data.profile.agents.total_registered} registered, ${data.profile.agents.real} real, ${data.profile.agents.blocked_at_path} blocked at path, renderer ${data.profile.renderer.source} at ${GITLINK.slice(0, 12)} (${data.profile.renderer.in_sync} in sync, ${data.profile.renderer.drifted} drifted), ${symlinksSeen} symlink(s) reported, extras ${JSON.stringify(data.profile.extras.by_class)}, pjangler-pm renderer ${agent.profile.renderer.state} == independent exit ${check_.status}`);
  });
} catch (error) {
  if (!(error instanceof SkipCase)) throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(shimRoot, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} fleet profile check(s) failed`);
  process.exit(1);
}
console.log(`fleet profile regressions passed${skipped ? ` (${skipped} skipped)` : ""}`);
