// PJAN Epic 1 / Story 1.6 (PJAN-108): tracked PM scaffold parity, fleet-wide.
//
// Before this story `pjangler fleet status` could not say whether ANY deployed
// PM scaffold matched the canonical template. `template_scaffold` read
// `unsupported`/`unobserved` for every agent on a default run, and the only
// comparison that existed (`hermes.pm-scaffold`) read desired bytes from the
// running build's own mutable submodule worktree, compared normalised text,
// ignored `momo`, modes, types, symlinks and extra tracked files, and returned
// prose. This suite is the proof that the observer which replaces that:
//
//   * takes desired state from git OBJECTS at the gitlink the package root has
//     COMMITTED -- never from a worktree, and a worktree that is not canonical
//     is an integrity ERROR, never a fallback;
//   * reports one observation per declared `scaffold.*` leaf with typed items
//     whose paths are role-relative and whose digests are blob-id prefixes;
//   * tells `stale-content` (an older template version) from
//     `locally-modified` (somebody's edit) by lineage, and carries an
//     uncommitted edit as an orthogonal `wip` flag;
//   * counts ignored runtime, foreign tracked files and unrelated WIP without
//     naming them, proposes no deletion, and writes nothing anywhere.
//
// The bar, carried from stories 1.4 and 1.5: every case runs the REAL built
// `dist/index.js` in a real subprocess; stdout is asserted parseable before
// anything else; every invocation is bracketed by a content+mtime snapshot of
// the scratch tree and the tracked contract; the fleet, the template repository
// (three commits, so stale is a DELTA from modified), the package roots and the
// audit reports are all CONSTRUCTED here. Only the one live AC10 case may skip.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

/** The eight declared leaves, in the byte order the observations sort in. */
const GROUPS = [
  "scaffold.SOUL.md", "scaffold.gitignore", "scaffold.hermes", "scaffold.momo",
  "scaffold.role.yaml", "scaffold.runtime-scaffold", "scaffold.scripts", "scaffold.sentinel.prompt.md",
];
const ITEM_KINDS = ["missing", "stale-content", "locally-modified", "wrong-mode", "wrong-type", "unsafe-symlink", "unexpected-owned", "incomplete"];
/** Mirrors FLEET_STATUS_MAX_ITEMS in src/fleet/types.ts. */
const MAX_ITEMS = 100;
const DATA_KEYS = [
  "contract_path", "contract_version", "scope",
  "totals", "health", "agents", "domains", "host", "findings", "probes", "transitions", "scaffold", "truncated",
];
const SECRET_SENTINEL = "pjan108-not-a-real-credential-0000";

const REAL_HOME = (() => { try { return userInfo().homedir; } catch { return homedir(); } })();
const REAL_AGENT_REGISTRY = process.env.HERMES_AGENTS_REGISTRY?.trim() || join(REAL_HOME, ".hermes", "agents-registry.yaml");
const REAL_PROJECT_REGISTRY = process.env.PJ_PROJECT_REGISTRY?.trim() || join(REAL_HOME, ".config", "pjangler", "projects.yaml");

const temp = mkdtempSync(join(tmpdir(), "fleet-scaffold-"));
/** Shims live OUTSIDE `temp`, so their own bookkeeping can never read as the command writing. */
const shimRoot = mkdtempSync(join(tmpdir(), "fleet-scaffold-shims-"));
const scratchHome = join(temp, "home");
const reposRoot = join(temp, "repos");
const workdir = join(temp, "work");

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

function git(cwd, args) {
  return spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd, encoding: "utf8",
    // No global config AND no global excludes: the default excludes file is
    // `$XDG_CONFIG_HOME/git/ignore`, which `GIT_CONFIG_GLOBAL` does not cover,
    // and this machine's ignores `*.pyc` -- which is exactly the file the
    // contaminated template version has to commit.
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

/** The git blob id prefix of some text -- the digest every item carries. `\u0000` as an ESCAPE, never a raw NUL byte. */
function blobPrefix(text) {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\u0000`, "latin1").update(bytes).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// A synthetic TEMPLATE with a history: three versions, so stale is a delta
// ---------------------------------------------------------------------------

const TEMPLATE_REMOTE = "https://github.com/delorenj/hermes-agent-template.git";
const HERMES_REMOTE = "https://github.com/delorenj/hermes-agent.git";

/**
 * The REAL renderer and lock helper at this repository's committed gitlink
 * (story 1.7): the synthetic template carries them so the profile observer,
 * which proves the worktree bytes against the pinned tree before it spawns,
 * finds a canonical renderer in every fixture root. The lock helper lives
 * under `template/.scripts/lib/`, so it is also a scaffold asset every clean
 * role carries verbatim.
 */
const PINNED_GITLINK = /([0-9a-f]{40})/u.exec(git(ROOT, ["ls-tree", "HEAD", "--", "templates/hermes-agent"]).stdout)?.[1] ?? null;
function pinnedBytes(path) {
  assert.ok(PINNED_GITLINK, "this checkout must commit a gitlink for templates/hermes-agent");
  const shown = spawnSync("git", ["show", `${PINNED_GITLINK}:${path}`], { cwd: join(ROOT, "templates", "hermes-agent"), encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(shown.status, 0, `git show ${PINNED_GITLINK.slice(0, 12)}:${path} must succeed`);
  return shown.stdout;
}
const RENDERER_BYTES = pinnedBytes("scripts/hermes-profile-config.py");
const LOCK_HELPER_BYTES = pinnedBytes("template/.scripts/lib/profile-config-lock.py");

/** The template sources, by version. Presence-only assets deliberately carry control flow. */
const SOUL_JINJA = "# {{ display_name }}\n\n{% if soul_tone == \"playful\" -%}\nplayful\n{%- else -%}\ndirect\n{%- endif %}\n";
const ROLE_YAML_JINJA = "role: {{ role | tojson }}\nagent_id: {{ agent_id | tojson }}\nprovisioned: {{ '%Y' | strftime }}\n";
const HERMES_JINJA = (version) => `#!/usr/bin/env bash\n# launcher for {{ agent_id }}\necho launcher v${version}\n`;
const MOMO_JINJA = "#!/usr/bin/env bash\n# momo for {{ target_repo }} ({{ role }})\necho momo\n";
const GITIGNORE_JINJA = "# {{ role }}\nruntime/\n.scripts/.provision.log\n.scripts/.done-*\n";
const PROMPT_JINJA = "# {{ display_name }} pass\n\nrepo {{ target_repo }} role {{ role }} provider {{ ticket_provider }}\n";
const LIB_SH = (version) => `#!/usr/bin/env bash\nlib_version() { echo ${version}; }\n`;
const HEARTBEAT_SH = "#!/usr/bin/env bash\necho heartbeat\n";
const FLEET_ENV_SH = "load_fleet_environment() { :; }\n";
const RS_README = "# runtime scaffold\n";
const RS_GITIGNORE_JINJA = "auth.json\n*.pem\n";

function templateFiles(version) {
  return {
    "SOUL.md.jinja": { mode: 0o644, text: SOUL_JINJA },
    "role.yaml.jinja": { mode: 0o644, text: ROLE_YAML_JINJA },
    "hermes.jinja": { mode: 0o755, text: HERMES_JINJA(version) },
    "momo.jinja": { mode: 0o755, text: MOMO_JINJA },
    ".gitignore.jinja": { mode: 0o644, text: GITIGNORE_JINJA },
    ".scripts/sentinel.prompt.md.jinja": { mode: 0o644, text: PROMPT_JINJA },
    ".scripts/_lib.sh": { mode: 0o755, text: LIB_SH(version) },
    ".scripts/heartbeat.sh": { mode: 0o755, text: HEARTBEAT_SH },
    ".scripts/lib/fleet-env.sh": { mode: 0o644, text: FLEET_ENV_SH },
    ".scripts/lib/profile-config-lock.py": { mode: 0o644, text: LOCK_HELPER_BYTES },
    ".runtime-scaffold/README.md": { mode: 0o644, text: RS_README },
    ".runtime-scaffold/.gitignore.jinja": { mode: 0o644, text: RS_GITIGNORE_JINJA },
  };
}

/** Assets the template renders at the pinned version. Presence-only ones count. */
const OWNED_ASSETS = Object.keys(templateFiles(3)).length;

function writeTemplateTree(repo, files) {
  for (const [path, file] of Object.entries(files)) {
    const full = join(repo, "template", ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.text, "utf8");
    chmodSync(full, file.mode);
  }
}


const templateSource = join(temp, "template-source");
/** Commit ids of the synthetic template's history, filled by `seedTemplate`. */
const COMMIT = { v1: "", v2: "", v3: "", contaminated: "", unsupported: "", bulk: "" };
/** How many verbatim scripts the `bulk` version adds, for the >64 KiB and item-cap cases. */
const BULK_SCRIPTS = 300;

function seedTemplate() {
  mkdirSync(templateSource, { recursive: true });
  gitOk(templateSource, ["init", "--quiet"]);
  writeFileSync(join(templateSource, "copier.yml"), "_subdirectory: template\n_templates_suffix: .jinja\n", "utf8");
  mkdirSync(join(templateSource, "scripts"), { recursive: true });
  writeFileSync(join(templateSource, "scripts", "hermes-profile-config.py"), RENDERER_BYTES);
  chmodSync(join(templateSource, "scripts", "hermes-profile-config.py"), 0o755);
  for (const version of [1, 2, 3]) {
    writeTemplateTree(templateSource, templateFiles(version));
    gitOk(templateSource, ["add", "-A"]);
    gitOk(templateSource, ["commit", "--quiet", "-m", `template v${version}`]);
    COMMIT[`v${version}`] = gitOk(templateSource, ["rev-parse", "HEAD"]);
  }
  // A CONTAMINATED version: a pycache file committed into the tree. Never a
  // desired state, whatever the operator's worktree looks like.
  gitOk(templateSource, ["checkout", "--quiet", "-b", "contaminated"]);
  mkdirSync(join(templateSource, "template", ".scripts", "__pycache__"), { recursive: true });
  writeFileSync(join(templateSource, "template", ".scripts", "__pycache__", "x.pyc"), "not really bytecode\n", "utf8");
  gitOk(templateSource, ["add", "-f", "-A"]);
  gitOk(templateSource, ["commit", "--quiet", "-m", "contaminated"]);
  COMMIT.contaminated = gitOk(templateSource, ["rev-parse", "HEAD"]);
  // An UNSUPPORTED version: control flow in one content-compared template and
  // an undeclared placeholder in another. Neither may be rendered "as best it
  // can": each asset is `incomplete` with the reason, the source stays intact,
  // and every other asset is still compared.
  gitOk(templateSource, ["checkout", "--quiet", COMMIT.v3]);
  gitOk(templateSource, ["checkout", "--quiet", "-b", "unsupported"]);
  writeFileSync(join(templateSource, "template", "momo.jinja"), "#!/usr/bin/env bash\n{% if role == \"pm\" %}echo pm{% else %}echo other{% endif %}\n", "utf8");
  writeFileSync(join(templateSource, "template", "hermes.jinja"), "#!/usr/bin/env bash\n# launcher for {{ agent_id }} ({{ launcher_flavor }})\n", "utf8");
  gitOk(templateSource, ["add", "-A"]);
  gitOk(templateSource, ["commit", "--quiet", "-m", "unsupported"]);
  COMMIT.unsupported = gitOk(templateSource, ["rev-parse", "HEAD"]);
  // A BULK version: three hundred verbatim scripts, for the item cap.
  gitOk(templateSource, ["checkout", "--quiet", COMMIT.v3]);
  gitOk(templateSource, ["checkout", "--quiet", "-b", "bulk"]);
  for (let index = 0; index < BULK_SCRIPTS; index += 1) {
    const full = join(templateSource, "template", ".scripts", "bulk", `${String(index).padStart(3, "0")}.sh`);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `#!/usr/bin/env bash\necho bulk ${index}\n`, "utf8");
    chmodSync(full, 0o755);
  }
  gitOk(templateSource, ["add", "-A"]);
  gitOk(templateSource, ["commit", "--quiet", "-m", "bulk"]);
  COMMIT.bulk = gitOk(templateSource, ["rev-parse", "HEAD"]);
  gitOk(templateSource, ["checkout", "--quiet", "main"]);
  assert.equal(gitOk(templateSource, ["rev-parse", "HEAD"]), COMMIT.v3, "main must be the pinned version");
}

// ---------------------------------------------------------------------------
// The EXPECTED rendered bytes, as literal strings -- never a render function
// ---------------------------------------------------------------------------

/** The exact bytes a clean role carries for `<slug>-pm`, rendered from v3. */
function cleanRoleFiles(slug, version = 3) {
  return {
    "role.yaml": { mode: 0o644, text: "role: pm\n" },
    "SOUL.md": { mode: 0o644, text: "# soul\n" },
    hermes: { mode: 0o755, text: `#!/usr/bin/env bash\n# launcher for ${slug}-pm\necho launcher v${version}\n` },
    momo: { mode: 0o755, text: `#!/usr/bin/env bash\n# momo for ${slug} (pm)\necho momo\n` },
    ".gitignore": { mode: 0o644, text: "# pm\nruntime/\n.scripts/.provision.log\n.scripts/.done-*\n" },
    ".scripts/sentinel.prompt.md": { mode: 0o644, text: `# ${slug} PM pass\n\nrepo ${slug} role pm provider plane\n` },
    ".scripts/_lib.sh": { mode: 0o755, text: `#!/usr/bin/env bash\nlib_version() { echo ${version}; }\n` },
    ".scripts/heartbeat.sh": { mode: 0o755, text: "#!/usr/bin/env bash\necho heartbeat\n" },
    ".scripts/lib/fleet-env.sh": { mode: 0o644, text: "load_fleet_environment() { :; }\n" },
    ".scripts/lib/profile-config-lock.py": { mode: 0o644, text: LOCK_HELPER_BYTES },
    ".runtime-scaffold/README.md": { mode: 0o644, text: "# runtime scaffold\n" },
    ".runtime-scaffold/.gitignore": { mode: 0o644, text: "auth.json\n*.pem\n" },
  };
}

function writeRole(roleDir, files) {
  for (const [path, file] of Object.entries(files)) {
    const full = join(roleDir, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.text, "utf8");
    chmodSync(full, file.mode);
  }
}

// ---------------------------------------------------------------------------
// The synthetic fleet: one agent per matrix row
// ---------------------------------------------------------------------------

/**
 * A repository with a clean role, then `drift` applied. Everything `drift`
 * does BEFORE returning is committed; anything it wants left as WIP it does
 * through the returned `after` callback.
 */
function makeRepo(slug, { roleRel = join("agents", "hermes", "pm"), drift = () => {}, after = () => {} } = {}) {
  const dir = join(reposRoot, slug);
  const roleDir = join(dir, roleRel);
  mkdirSync(roleDir, { recursive: true });
  writeRole(roleDir, cleanRoleFiles(slug));
  writeFileSync(join(dir, ".project.json"), `${JSON.stringify({
    project_slug: slug,
    ticket_provider: { type: "plane", workspace: "suite", identifier: slug.toUpperCase(), board_id: `board-${slug}` },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "README.md"), `# ${slug}\n`, "utf8");
  gitOk(dir, ["init", "--quiet"]);
  drift(dir, roleDir);
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "--quiet", "-m", "seed"]);
  after(dir, roleDir);
  return { dir, roleDir };
}


// ---------------------------------------------------------------------------
// Renderer-clean profiles (story 1.7 / PJAN-109)
//
// The profile observer now gates every registered profile and proves it through
// the canonical renderer's own check, so a fixture profile that carried only a
// marker file reads as an identity miss, a delta miss, a pin miss and a missing
// skill core. The FIXTURE is made clean, never the observer weakened: a fleet
// base, six canonical skills, and per profile the identity file, an empty
// delta, a generated config equal to the base, the bank pin, the skill links,
// and the renderer's zero-byte lock PRE-CREATED so a check writes nothing.
// ---------------------------------------------------------------------------
const PROFILE_CORE_SKILLS = ["33god-projects", "delonet-conventions", "delonet-dotenv", "hermes-pm-template-maintenance", "hindsight", "subagent-driven-development"];

function profileBase(home) {
  return { model: { default: "fleet-model" }, skills: { external_dirs: [join(home, ".agents", "skills")] }, memory: { provider: "hindsight" } };
}

function seedProfileFixtures(home) {
  mkdirSync(join(home, ".hermes", "profiles"), { recursive: true });
  writeFileSync(join(home, ".hermes", "config.yaml"), YAML.stringify(profileBase(home)), "utf8");
  for (const skill of PROFILE_CORE_SKILLS) {
    mkdirSync(join(home, ".agents", "skills", skill), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", skill, "SKILL.md"), `# ${skill}\n`, "utf8");
  }
}

function seedRendererCleanProfile(home, name) {
  const dir = join(home, ".hermes", "profiles", name);
  mkdirSync(join(dir, "hindsight"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "profile.yaml"), `name: ${name}\n`, "utf8");
  writeFileSync(join(dir, "config.delta.yaml"), "{}\n", "utf8");
  writeFileSync(join(dir, "config.yaml"), `# GENERATED FILE -- DO NOT EDIT\n${YAML.stringify(profileBase(home))}`, "utf8");
  writeFileSync(join(dir, "hindsight", "config.json"), `{\n  "bank_id": "agent-${name}"\n}\n`, "utf8");
  for (const skill of PROFILE_CORE_SKILLS) symlinkSync(join(home, ".agents", "skills", skill), join(dir, "skills", skill));
  writeFileSync(join(home, ".hermes", "profiles", `.${name}.config.lock`), "");
  return dir;
}

const SLUGS = ["match", "stale", "oldwrap", "edited", "missing", "mode", "type", "link", "droppings", "wip", "presence", "noname", "spaced", "defaulted"];
const ROLE_DIRS = {};

function seedFleet() {
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(scratchHome, ".hermes", "profiles"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "hermes-agent-template"), { recursive: true });
  const release = join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc", "bin");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "hermes"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(release, "hermes"), 0o755);
  mkdirSync(join(temp, "outside"), { recursive: true });
  writeFileSync(join(temp, "outside", "hermes"), "#!/bin/sh\necho outside\n", "utf8");

  ROLE_DIRS.match = makeRepo("match").roleDir;
  // An OLDER template version of a verbatim script: in the object database, so stale.
  ROLE_DIRS.stale = makeRepo("stale", { drift: (dir, role) => {
    writeFileSync(join(role, ".scripts", "_lib.sh"), LIB_SH(1), "utf8");
  } }).roleDir;
  // An OLDER render of the launcher: equals the render of v1, so stale by rendered lineage.
  ROLE_DIRS.oldwrap = makeRepo("oldwrap", { drift: (dir, role) => {
    writeFileSync(join(role, "hermes"), cleanRoleFiles("oldwrap", 1).hermes.text, "utf8");
  } }).roleDir;
  // Bytes no template version ever shipped -- and the planted secret rides in them.
  ROLE_DIRS.edited = makeRepo("edited", { drift: (dir, role) => {
    writeFileSync(join(role, "hermes"), `#!/usr/bin/env bash\n# launcher for edited-pm\necho launcher v3\necho ${SECRET_SENTINEL}\n`, "utf8");
  } }).roleDir;
  ROLE_DIRS.missing = makeRepo("missing", { drift: (dir, role) => { rmSync(join(role, "momo")); } }).roleDir;
  ROLE_DIRS.mode = makeRepo("mode", { drift: (dir, role) => { chmodSync(join(role, ".scripts", "heartbeat.sh"), 0o644); } }).roleDir;
  ROLE_DIRS.type = makeRepo("type", { drift: (dir, role) => {
    rmSync(join(role, "hermes"));
    mkdirSync(join(role, "hermes"));
    writeFileSync(join(role, "hermes", "inner"), "not a launcher\n", "utf8");
  } }).roleDir;
  ROLE_DIRS.link = makeRepo("link", { drift: (dir, role) => {
    rmSync(join(role, "hermes"));
    symlinkSync(join(temp, "outside", "hermes"), join(role, "hermes"));
  } }).roleDir;
  // Provisioning droppings COMMITTED into the role: a done-marker the role's
  // own .gitignore excludes (forced in), and an unrendered .jinja.
  ROLE_DIRS.droppings = makeRepo("droppings", { drift: (dir, role) => {
    writeFileSync(join(role, ".scripts", ".done-70-systemd"), "", "utf8");
    writeFileSync(join(role, ".runtime-scaffold", ".gitignore.jinja"), RS_GITIGNORE_JINJA, "utf8");
    gitOk(dir, ["add", "-f", join(relative(dir, role), ".scripts", ".done-70-systemd")]);
  } }).roleDir;
  // Ignored runtime bytes, an untracked note, a foreign tracked file, and an
  // UNCOMMITTED edit to the launcher.
  ROLE_DIRS.wip = makeRepo("wip", {
    drift: (dir, role) => { writeFileSync(join(role, "README.md"), "# a foreign tracked file\n", "utf8"); },
    after: (dir, role) => {
      mkdirSync(join(role, "runtime"), { recursive: true });
      writeFileSync(join(role, "runtime", "state.json"), `{"note":"${SECRET_SENTINEL}"}\n`, "utf8");
      writeFileSync(join(role, "notes.md"), "untracked operator notes\n", "utf8");
      writeFileSync(join(role, "hermes"), `${cleanRoleFiles("wip").hermes.text}# local experiment\n`, "utf8");
    },
  }).roleDir;
  ROLE_DIRS.presence = makeRepo("presence", { drift: (dir, role) => {
    writeFileSync(join(role, "role.yaml"), "role: pm\nreconcile:\n  enabled: false\n", "utf8");
    writeFileSync(join(role, "SOUL.md"), "# an operator-edited soul\n", "utf8");
  } }).roleDir;
  ROLE_DIRS.noname = makeRepo("noname").roleDir;
  ROLE_DIRS.spaced = makeRepo("spaced", { roleRel: join("agents", "hermes", "p m") }).roleDir;
  ROLE_DIRS.defaulted = makeRepo("defaulted").roleDir;

  seedProfileFixtures(scratchHome);
  for (const slug of SLUGS) seedRendererCleanProfile(scratchHome, `${slug}-pm`);
  writeAgentRegistry(join(scratchHome, ".hermes", "agents-registry.yaml"), SLUGS);
  writeProjectRegistry(join(scratchHome, ".config", "pjangler", "projects.yaml"), SLUGS);

  writeFileSync(join(scratchHome, ".config", "hermes-agent-template", "config.toml"), [
    "[fleet]",
    `hermes_bin = "${join(release, "hermes")}"`,
    `hermes_repo = "${join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc")}"`,
    `hermes_git_url = "${HERMES_REMOTE}"`,
    'hermes_git_ref = "main"',
    `hermes_git_sha = "${"0".repeat(40)}"`,
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(scratchHome, ".hermes", "fleet.env"), [
    `HERMES_FLEET_HOME=${join(scratchHome, ".hermes")}`,
    `HERMES_FLEET_BIN=${join(release, "hermes")}`,
    "HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/agents-registry.yaml",
    `PLANE_33GOD_API_KEY=${SECRET_SENTINEL}`,
    "",
  ].join("\n"), "utf8");
}

function agentRow(slug) {
  const row = {
    repo: slug,
    role: "pm",
    display_name: `${slug} PM`,
    project_path: join(reposRoot, slug),
    role_dir: ROLE_DIRS[slug] ?? join(reposRoot, slug, "agents", "hermes", "pm"),
    profile_name: `${slug}-pm`,
    provisioned_at: "2026-01-01T00:00:00.000Z",
    plane: { workspace: "suite", project_id: `board-${slug}`, identifier: slug.toUpperCase() },
    bloodbank: { enabled: false, gateway_scope: "fleet", target_agent_id: `${slug}-pm` },
    systemd: { gateway_unit: `hermes-${slug}-pm-gateway.service` },
    hermes: {
      bin: join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc", "bin", "hermes"),
      repo: join(scratchHome, ".local", "share", "hermes-agent", "releases", "abc"),
      fleet_env: join(scratchHome, ".hermes", "fleet.env"),
      git_url: HERMES_REMOTE,
      git_ref: "main",
      git_sha: "0".repeat(40),
    },
  };
  // The matrix's two registry shapes: a row with no display_name, and a row
  // with no role_dir (so the canonical default applies).
  if (slug === "noname") delete row.display_name;
  if (slug === "defaulted") delete row.role_dir;
  return row;
}

function writeAgentRegistry(path, slugs, mutate = () => {}) {
  const agents = {};
  for (const slug of slugs) agents[`${slug}-pm`] = agentRow(slug);
  mutate(agents);
  writeFileSync(path, YAML.stringify({ schema_version: 1, agents }), "utf8");
  return path;
}

function writeProjectRegistry(path, slugs) {
  const projects = {};
  for (const slug of slugs) {
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
  HERMES_FLEET_HOME: join(scratchHome, ".hermes"),
  HERMES_AGENTS_REGISTRY: join(scratchHome, ".hermes", "agents-registry.yaml"),
  HERMES_FLEET_REGISTRY_FILE: join(scratchHome, ".hermes", "agents-registry.yaml"),
  HERMES_FLEET_ENV: join(scratchHome, ".hermes", "fleet.env"),
  HERMES_TEMPLATE_CONFIG: join(scratchHome, ".config", "hermes-agent-template", "config.toml"),
  PJ_PROJECT_REGISTRY: join(scratchHome, ".config", "pjangler", "projects.yaml"),
  HERMES_TEMPLATE_RUNTIME_SCAFFOLD: join(scratchHome, ".hermes", "runtime-scaffold"),
  RUNTIME_SCAFFOLD_DIR: join(scratchHome, ".hermes", "runtime-scaffold"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  // Git repacks on its own schedule and rewrites `.git/objects` when it does;
  // the protected-root snapshot digests `.git` too, so that housekeeping reads
  // as "the CLI wrote here". It only crosses the gc threshold on a fresh clone,
  // which is why this was invisible locally and fatal in CI. Turn the
  // housekeeping off rather than stop watching `.git`.
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
  // Present in the PARENT's environment so the audit child's allowlist has
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

/** The tracked contract, mutated. The manifest is the tracked one: the fixture template mirrors its groups. */
function policyContract(mutate = () => {}) {
  const document = contractDocument();
  mutate(document);
  return document;
}

/**
 * A relocated package root whose `templates/hermes-agent` is a clone of the
 * synthetic template checked out at `commit`, with the gitlink COMMITTED in the
 * root. `after` may then break it in whichever way a case needs.
 */
function makePackageRoot(name, contractText, { commit = COMMIT.v3, after = () => {} } = {}) {
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
  gitOk(submodule, ["checkout", "--quiet", commit]);
  gitOk(submodule, ["remote", "set-url", "origin", TEMPLATE_REMOTE]);
  writeFileSync(join(root, ".gitmodules"), [
    '[submodule "templates/hermes-agent"]',
    "\tpath = templates/hermes-agent",
    `\turl = ${TEMPLATE_REMOTE}`,
    "",
  ].join("\n"), "utf8");
  gitOk(root, ["init", "--quiet"]);
  gitOk(root, ["add", ".gitmodules", "templates/hermes-agent"]);
  const staged = git(root, ["ls-files", "--stage", "--", "templates/hermes-agent"]).stdout;
  assert.match(staged, new RegExp(`^160000 ${commit} 0\t`, "u"), `the fixture root must stage the gitlink at ${commit}, got ${JSON.stringify(staged)}`);
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

/** The scratch tree -- every repository, registry, profile and package root -- plus the tracked contract. */
function snapshotIsolated() {
  const entries = {};
  snapshotTree("temp", temp, entries);
  snapshotTree("contracts", join(ROOT, "contracts"), entries);
  return entries;
}

const FOREIGN_SCRATCH = /^\.(pjan|fleet|notebook|momo|project)-/u;

/** This repository's staged content and top-level direntries, asserted once for the suite. */
function snapshotShared() {
  const entries = {};
  for (const repo of [ROOT, join(ROOT, "templates", "hermes-agent")]) {
    if (!existsSync(join(repo, ".git"))) { entries[`staged:${repo}`] = "absent"; continue; }
    const listed = git(repo, ["--no-optional-locks", "ls-files", "--stage"]);
    entries[`staged:${repo}`] = listed.status === 0 ? createHash("sha256").update(listed.stdout).digest("hex") : `unreadable:${listed.status}`;
  }
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
  // Every finding names a dotted contract path, never a source id -- carried
  // from 1.4 and applied to the two finding codes this story adds.
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
function groupOf(agent, leaf) {
  const found = agent.observations.find((item) => item.source === "fleet-scaffold" && item.field === leaf);
  assert.ok(found, `${agent.agent_id} must carry the ${leaf} group observation`);
  return found;
}

function itemsOf(observation) {
  return observation.items ?? [];
}

/** Every observation, item, detail and summary of one record, as one string -- what an operator would read. */
function textOf(agent) {
  return JSON.stringify(agent);
}

// ---------------------------------------------------------------------------
// Injected audit entries, for the --live rule-agreement cases
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

const SCAFFOLD_RULE_PASS = { id: "hermes.pm-scaffold", title: "Hermes orchestrator scaffold parity", status: "pass", summary: "1 orchestrator scaffold(s) verified", details: [], fixable: true, scope: "project" };
const SCAFFOLD_RULE_FAIL = { id: "hermes.pm-scaffold", title: "Hermes orchestrator scaffold parity", status: "fail", summary: "1 orchestrator scaffold issue(s) detected", details: ["x-pm: stale agents/hermes/pm/hermes"], fixable: true, scope: "project" };
const SCAFFOLD_RULE_SKIP = { id: "hermes.pm-scaffold", title: "Hermes orchestrator scaffold parity", status: "skip", summary: "No provisioned pm or director role present", details: [], fixable: false, scope: "project" };

const STATUS_ARGS = ["review", "--domain", "template_scaffold", "--json"];

console.log("fleet scaffold parity: every role directory against the template at the committed gitlink");

try {
  if (!existsSync(CLI) || !existsSync(MCP)) {
    skip("the whole suite", "dist/ is not built; run `npm run build` first");
    throw new SkipCase("unbuilt");
  }
  seedTemplate();
  seedFleet();
  // Reconcile this repository's index once before anything snapshots it (see
  // the note in fleet-status-regressions.mjs: a tracked `dist/` leaves it
  // stat-dirty after a build, and the first reader would otherwise absorb the
  // reconcile and be blamed for it).
  git(ROOT, ["update-index", "--refresh"]);
  const sharedAtStart = snapshotShared();

  const mainRoot = makePackageRoot("pkg-main", YAML.stringify(policyContract(), { lineWidth: 0 }));

  // -- AC3: one agent per drift class, each class exactly one item ------------

  check("a matching role reads eight passes with no items and is counted passing", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const agent = agentNamed(data, "match-pm");
    const groups = agent.observations.filter((item) => item.source === "fleet-scaffold");
    assert.deepEqual(groups.map((item) => item.field), GROUPS, "eight observations, one per declared leaf, in byte order");
    for (const group of groups) {
      assert.equal(group.state, "pass", `${group.field} must pass on a clean role: ${JSON.stringify(group.items)}`);
      assert.equal(group.items, undefined, `${group.field} must carry no items key at all on a pass`);
      assert.equal(group.rule_scope, "project");
      assert.equal(group.rule_id, null);
      assert.equal(group.owner, "hermes-agent-template", "the leaf is a declared writable field, so the owner is declared rather than walked up to");
      assert.match(group.observed, /^\d+\/\d+ assets match$/u);
      assert.match(group.desired, /^every asset in scaffold\.[A-Za-z.-]+ at gitlink [0-9a-f]{12}$/u);
      assert.equal(group.evidence, "direct");
    }
    assert.equal(agent.domains.template_scaffold, "unobserved", "without --live the audit half is still unread, and unobserved outranks pass in the rollup");
    assert.ok(agent.scaffold, "the record must carry a scaffold summary");
    assert.equal(agent.scaffold.source_gitlink, COMMIT.v3);
    assert.deepEqual(agent.scaffold.assets, { owned: OWNED_ASSETS, compared: OWNED_ASSETS, matching: OWNED_ASSETS, drifted: 0, incomplete: 0, unexpected_owned: 0 });
    assert.deepEqual(agent.scaffold.wip_overlap, []);
    assert.equal(agent.scaffold.role_dir_source, "registry");
  });

  check("an older verbatim script is stale-content, with both blob-id prefixes", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const scripts = groupOf(agentNamed(data, "stale-pm"), "scaffold.scripts");
    assert.equal(scripts.state, "fail");
    assert.deepEqual(itemsOf(scripts), [{
      path: ".scripts/_lib.sh", kind: "stale-content",
      desired: blobPrefix(LIB_SH(3)), observed: blobPrefix(LIB_SH(1)),
      detail: null, wip: false,
    }]);
    assert.match(scripts.details.join("\n"), /stale-content \.scripts\/_lib\.sh/u, "the detail line names the item");
    for (const leaf of GROUPS) if (leaf !== "scaffold.scripts") assert.equal(groupOf(agentNamed(data, "stale-pm"), leaf).state, "pass", `${leaf} is unaffected`);
  });

  check("an older RENDER of the launcher is stale-content by rendered lineage", () => {
    // A DELTA against `edited-pm`: both launchers differ from the pinned render;
    // only this one equals what an older template version rendered for this
    // agent. The distinction is lineage, and it is what a fanout needs to choose
    // overwrite versus block.
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const old = itemsOf(groupOf(agentNamed(data, "oldwrap-pm"), "scaffold.hermes"));
    assert.deepEqual(old.map((item) => [item.path, item.kind]), [["hermes", "stale-content"]]);
    assert.equal(old[0].desired, blobPrefix(cleanRoleFiles("oldwrap").hermes.text));
    assert.equal(old[0].observed, blobPrefix(cleanRoleFiles("oldwrap", 1).hermes.text));
    const edited = itemsOf(groupOf(agentNamed(data, "edited-pm"), "scaffold.hermes"));
    assert.deepEqual(edited.map((item) => [item.path, item.kind]), [["hermes", "locally-modified"]]);
    assert.equal(edited[0].desired, blobPrefix(cleanRoleFiles("edited").hermes.text));
  });

  check("missing, wrong-mode, wrong-type and unsafe-symlink each land on their own group", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    assert.deepEqual(itemsOf(groupOf(agentNamed(data, "missing-pm"), "scaffold.momo")), [
      { path: "momo", kind: "missing", desired: "file", observed: "absent", detail: null, wip: false },
    ]);
    assert.deepEqual(itemsOf(groupOf(agentNamed(data, "mode-pm"), "scaffold.scripts")), [
      { path: ".scripts/heartbeat.sh", kind: "wrong-mode", desired: "100755", observed: "100644", detail: null, wip: false },
    ]);
    assert.deepEqual(itemsOf(groupOf(agentNamed(data, "type-pm"), "scaffold.hermes")), [
      { path: "hermes", kind: "wrong-type", desired: "file", observed: "directory", detail: null, wip: false },
    ]);
    assert.deepEqual(itemsOf(groupOf(agentNamed(data, "link-pm"), "scaffold.hermes")), [
      { path: "hermes", kind: "unsafe-symlink", desired: "file", observed: "symlink", detail: null, wip: false },
    ]);
    for (const [slug, hit] of [["missing", "scaffold.momo"], ["mode", "scaffold.scripts"], ["type", "scaffold.hermes"], ["link", "scaffold.hermes"]]) {
      const agent = agentNamed(data, `${slug}-pm`);
      for (const leaf of GROUPS) {
        assert.equal(groupOf(agent, leaf).state, leaf === hit ? "fail" : "pass", `${slug}-pm ${leaf}`);
      }
      assert.equal(agent.scaffold.assets.drifted, 1);
      assert.equal(agent.healthy, false, "a drifted scaffold is a proven failure");
    }
  });

  check("tracked provisioning droppings are unexpected-owned on their groups and never a delete proposal", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const agent = agentNamed(data, "droppings-pm");
    assert.deepEqual(itemsOf(groupOf(agent, "scaffold.scripts")), [
      { path: ".scripts/.done-70-systemd", kind: "unexpected-owned", desired: null, observed: "tracked", detail: "matches excluded pattern .done-*", wip: false },
    ]);
    assert.deepEqual(itemsOf(groupOf(agent, "scaffold.runtime-scaffold")), [
      { path: ".runtime-scaffold/.gitignore.jinja", kind: "unexpected-owned", desired: null, observed: "tracked", detail: null, wip: false },
    ]);
    assert.equal(agent.scaffold.assets.unexpected_owned, 2);
    assert.equal(agent.scaffold.assets.drifted, 0, "an unexpected file is not a drifted owned asset");
    assert.doesNotMatch(textOf(agent), /\b(rm |git rm|delete|remove)\b/u, "nothing may propose deleting a tracked file");
    for (const observation of agent.observations) assert.equal(observation.next_action_class, "read-only");
  });

  check("ignored runtime, untracked notes and a foreign tracked file are counted, never named; only the WIP overlap is", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const agent = agentNamed(data, "wip-pm");
    const text = textOf(agent);
    assert.equal(text.includes("notes.md"), false, "an untracked note is never named");
    assert.equal(text.includes("state.json"), false, "an ignored runtime file is never named");
    assert.equal(text.includes("README.md"), false, "a foreign tracked file is never named");
    assert.ok(agent.scaffold.wip_preserved >= 1, `unrelated WIP is counted: ${JSON.stringify(agent.scaffold)}`);
    assert.equal(agent.scaffold.foreign_tracked, 1);
    assert.ok(agent.scaffold.ignored_entries >= 1, "the ignored runtime is counted");
    const launcher = itemsOf(groupOf(agent, "scaffold.hermes"));
    assert.deepEqual(launcher.map((item) => [item.path, item.kind, item.wip]), [["hermes", "locally-modified", true]], "the edited launcher carries the wip flag");
    assert.deepEqual(agent.scaffold.wip_overlap, ["hermes"], "and is the one path named in the overlap");
    // The worktree and `git status` are byte-identical before and after: every
    // `cliAt` call snapshots the whole scratch tree, `.git/index` included, and
    // fails if anything moved. Asserted explicitly here too, on this repository.
    const before = git(join(reposRoot, "wip"), ["status", "--porcelain", "--ignored=matching", "--untracked-files=all"]).stdout;
    status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "wip-pm"]));
    assert.equal(git(join(reposRoot, "wip"), ["status", "--porcelain", "--ignored=matching", "--untracked-files=all"]).stdout, before, "git status must be identical after the run");
  });

  check("presence-only assets pass whatever their content, and control flow in them is not rendered", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const agent = agentNamed(data, "presence-pm");
    assert.equal(groupOf(agent, "scaffold.role.yaml").state, "pass");
    assert.equal(groupOf(agent, "scaffold.SOUL.md").state, "pass");
    assert.equal(agent.scaffold.assets.drifted, 0);
    assert.equal(agent.healthy, true);
  });

  check("a row missing a render input makes ONE group error with input-missing, and the agent incomplete", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const agent = agentNamed(data, "noname-pm");
    const prompt = groupOf(agent, "scaffold.sentinel.prompt.md");
    assert.equal(prompt.state, "error");
    assert.deepEqual(itemsOf(prompt), [
      { path: ".scripts/sentinel.prompt.md", kind: "incomplete", desired: null, observed: "file", detail: "input-missing: display_name", wip: false },
    ]);
    for (const leaf of GROUPS) if (leaf !== "scaffold.sentinel.prompt.md") assert.equal(groupOf(agent, leaf).state, "pass", `${leaf} is unaffected`);
    assert.equal(agent.complete, false, "an undecided asset makes the agent incomplete");
    // Story 1.4 pins `healthy` as no fail AND no error, so a collection error
    // is not a clean bill either -- and `member_class` follows the precedence
    // 1.5 declared, where a proven problem outranks an unread half.
    assert.equal(agent.healthy, false, "an error is never a pass");
    assert.equal(agent.member_class, "unhealthy");
    assert.equal(data.scaffold.agents.incomplete >= 1, true, "and the scaffold bucket counts it incomplete");
    assert.equal(agent.scaffold.assets.incomplete, 1);
    assert.equal(agent.scaffold.assets.compared, OWNED_ASSETS - 1);
  });

  // -- AC2: the role directory comes from the registry ------------------------

  check("a registry role_dir with a space is compared; a silent row resolves the canonical default", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    const spaced = agentNamed(data, "spaced-pm");
    assert.equal(spaced.scaffold.role_dir_source, "registry");
    assert.ok(spaced.scaffold.role_dir.endsWith("agents/hermes/p m"), `got ${spaced.scaffold.role_dir}`);
    assert.equal(spaced.scaffold.assets.drifted, 0, "the spaced directory was compared and matches");
    for (const leaf of GROUPS) assert.equal(groupOf(spaced, leaf).state, "pass", `spaced-pm ${leaf}`);

    const defaulted = agentNamed(data, "defaulted-pm");
    assert.equal(defaulted.scaffold.role_dir_source, "default");
    assert.ok(defaulted.scaffold.role_dir.endsWith("agents/hermes/pm"), `got ${defaulted.scaffold.role_dir}`);
    assert.equal(defaulted.scaffold.assets.drifted, 0);
  });

  // -- the aggregate: counted over every selected agent -----------------------

  check("data.scaffold counts every selected agent into exactly one bucket, and the source is a host pass", () => {
    const data = status(cliAt(mainRoot, STATUS_ARGS));
    assert.deepEqual(data.scaffold.source, {
      gitlink: COMMIT.v3, integrity: "ok",
      detail: `${OWNED_ASSETS} asset(s) rendered by the template at the committed gitlink ${COMMIT.v3.slice(0, 12)}`,
    });
    assert.deepEqual(data.scaffold.agents, {
      total_registered: SLUGS.length, selected: SLUGS.length, applicable: SLUGS.length,
      passing: 4, drifted: 9, incomplete: 1, exception_authorized: 0, unobserved: 0,
    });
    assert.deepEqual(data.scaffold.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: SLUGS.length }, "without --live nothing is compared against the rule");
    const source = data.host.find((finding) => finding.rule_id === "scaffold.source");
    assert.ok(source, "source integrity is a host finding");
    assert.equal(source.state, "pass");
    assert.equal(source.domain, "template_scaffold");
    assert.equal(source.owner, "hermes-agent-template");
    for (const agent of data.agents) {
      assert.equal(agent.observations.some((item) => item.rule_id === "scaffold.source"), false, "the source finding never reaches an agent record");
    }
    // Every item path is role-relative and every digest a 12-hex prefix or a
    // type/mode word: no body, no absolute path, on any record.
    for (const agent of data.agents) {
      for (const observation of agent.observations) {
        for (const item of itemsOf(observation)) {
          assert.ok(ITEM_KINDS.includes(item.kind), `unknown item kind ${item.kind}`);
          assert.equal(item.path.startsWith("/"), false, `item path must be role-relative: ${item.path}`);
          assert.equal(item.path.includes(".."), false);
          for (const side of [item.desired, item.observed]) {
            if (side === null) continue;
            assert.match(side, /^(?:[0-9a-f]{12}|file|symlink|directory|other|absent|tracked|100755|100644)$/u, `a digest or a type/mode word, never a body: ${side}`);
          }
        }
      }
    }
  });

  // -- AC1: source integrity, every class, never a fallback -------------------

  check("a worktree at a different commit is source-mismatched, and dirty once it is back", () => {
    const root = makePackageRoot("pkg-mismatched", YAML.stringify(policyContract(), { lineWidth: 0 }), {
      after: (packageRoot, submodule) => {
        gitOk(submodule, ["checkout", "--quiet", COMMIT.v2]);
        // A modified TRACKED file too, for the second half.
        writeFileSync(join(submodule, "template", ".scripts", "heartbeat.sh"), "#!/usr/bin/env bash\necho edited in the worktree\n", "utf8");
      },
    });
    const mismatched = status(cliAt(root, STATUS_ARGS));
    const source = mismatched.host.find((finding) => finding.rule_id === "scaffold.source");
    assert.equal(source.state, "error");
    assert.equal(mismatched.scaffold.source.integrity, "source-mismatched");
    assert.equal(mismatched.scaffold.source.gitlink, COMMIT.v3, "the committed gitlink is still reported; the worktree is what is wrong");
    assert.equal(mismatched.scaffold.agents.incomplete, SLUGS.length, "every selected agent is incomplete");
    assert.equal(mismatched.scaffold.agents.passing, 0);
    for (const agent of mismatched.agents) {
      for (const leaf of GROUPS) {
        const group = groupOf(agent, leaf);
        assert.equal(group.state, "error", `${agent.agent_id} ${leaf} must be error under a broken source`);
        const items = itemsOf(group);
        assert.equal(items.length, 1);
        assert.equal(items[0].kind, "incomplete");
        assert.equal(items[0].detail, "source:source-mismatched");
        // NO DIGEST DERIVED FROM THE WORKTREE. Nothing was compared, so nothing
        // carries a blob id at all.
        assert.equal(items[0].desired, null);
        assert.equal(items[0].observed, null);
      }
      assert.equal(agent.complete, false);
      assert.equal(agent.scaffold.source_gitlink, COMMIT.v3);
    }
    assert.notEqual(mismatched.health.verdict, "healthy", "an unread scaffold is unproven at best");
    // Zero role directories were read: one skipped probe per agent, and the
    // source probe, and nothing else of this kind.
    const probes = mismatched.probes.filter((probe) => probe.kind === "scaffold");
    assert.equal(probes.filter((probe) => probe.outcome === "skipped").length, SLUGS.length, "no role directory is read behind a broken source");
    assert.equal(probes.find((probe) => probe.target.endsWith("templates/hermes-agent"))?.reason, "source-mismatched");

    // Back at the pinned commit, the modified tracked file remains: DIRTY.
    gitOk(join(root, "templates", "hermes-agent"), ["checkout", "--quiet", COMMIT.v3]);
    const dirty = status(cliAt(root, STATUS_ARGS));
    assert.equal(dirty.scaffold.source.integrity, "source-dirty");
    assert.equal(dirty.host.find((finding) => finding.rule_id === "scaffold.source").state, "error");
    for (const agent of dirty.agents) assert.equal(groupOf(agent, "scaffold.scripts").state, "error");
    // And an UNTRACKED file alone is not dirt for this observer (DW-74).
    gitOk(join(root, "templates", "hermes-agent"), ["checkout", "--quiet", "--", "template/.scripts/heartbeat.sh"]);
    writeFileSync(join(root, "templates", "hermes-agent", "template", "untracked-note.txt"), "an editor dropping\n", "utf8");
    const clean = status(cliAt(root, STATUS_ARGS));
    assert.equal(clean.scaffold.source.integrity, "ok", "an untracked file changes no desired byte and is not dirt");
    assert.equal(agentNamed(clean, "match-pm").scaffold.assets.drifted, 0);
  });

  check("an uninitialized submodule, a missing object, a staged pin and a contaminated tree are each their own code", () => {
    const contract = YAML.stringify(policyContract(), { lineWidth: 0 });
    const cases = [
      ["pkg-uninitialized", "source-uninitialized", { after: (root, submodule) => { rmSync(submodule, { recursive: true, force: true }); mkdirSync(submodule); } }],
      ["pkg-missing-object", "source-missing-object", { after: (root) => {
        gitOk(root, ["update-index", "--cacheinfo", `160000,${"0".repeat(39)}1,templates/hermes-agent`]);
        gitOk(root, ["commit", "--quiet", "-m", "pin a commit nobody has"]);
      } }],
      ["pkg-unstable", "gitlink-unstable", { after: (root) => {
        gitOk(root, ["update-index", "--cacheinfo", `160000,${COMMIT.v2},templates/hermes-agent`]);
      } }],
      ["pkg-contaminated", "source-contaminated", { commit: COMMIT.contaminated }],
    ];
    for (const [name, code, options] of cases) {
      const root = makePackageRoot(name, contract, options);
      const data = status(cliAt(root, [...STATUS_ARGS, "--agent", "match-pm"]));
      assert.equal(data.scaffold.source.integrity, code, `${name}: ${data.scaffold.source.detail}`);
      const source = data.host.find((finding) => finding.rule_id === "scaffold.source");
      assert.equal(source.state, "error", name);
      assert.match(source.observed, new RegExp(`^${code}$`, "u"));
      const agent = agentNamed(data, "match-pm");
      for (const leaf of GROUPS) {
        const group = groupOf(agent, leaf);
        assert.equal(group.state, "error", `${name} ${leaf}`);
        assert.equal(itemsOf(group)[0].detail, `source:${code}`);
      }
      assert.equal(data.scaffold.agents.incomplete, 1, name);
      assert.equal(agent.scaffold.role_dir_source, "registry");
    }
    // The contaminated tree names the pattern it tripped, never a body.
    const contaminated = status(cliAt(join(temp, "pkg-contaminated"), [...STATUS_ARGS, "--agent", "match-pm"]));
    assert.match(contaminated.scaffold.source.detail, /__pycache__/u);
    assert.equal(contaminated.scaffold.source.detail.includes("not really bytecode"), false);
  });

  check("a rendered path no group owns is manifest-uncovered, by name", () => {
    const uncovered = policyContract((document) => { delete document.scaffold_manifest.groups["scaffold.momo"]; });
    const root = makePackageRoot("pkg-uncovered", YAML.stringify(uncovered, { lineWidth: 0 }));
    const data = status(cliAt(root, [...STATUS_ARGS, "--agent", "match-pm"]));
    assert.equal(data.scaffold.source.integrity, "manifest-uncovered:momo");
    const agent = agentNamed(data, "match-pm");
    // Seven groups now: the contract declares seven, and each is an error.
    const groups = agent.observations.filter((item) => item.source === "fleet-scaffold");
    assert.equal(groups.length, GROUPS.length - 1);
    for (const group of groups) assert.equal(group.state, "error");
  });

  check("control flow or an undeclared placeholder in a content-compared template is render-unsupported, never rendered as best it can", () => {
    const root = makePackageRoot("pkg-unsupported", YAML.stringify(policyContract(), { lineWidth: 0 }), { commit: COMMIT.unsupported });
    const data = status(cliAt(root, [...STATUS_ARGS, "--agent", "match-pm"]));
    // The SOURCE is fine: an unrenderable template is a per-asset gap, not a
    // broken checkout, so it must never hide behind a source-integrity error.
    assert.equal(data.scaffold.source.integrity, "ok", data.scaffold.source.detail);
    const agent = agentNamed(data, "match-pm");
    const momo = groupOf(agent, "scaffold.momo");
    assert.equal(momo.state, "error");
    assert.deepEqual(itemsOf(momo), [
      { path: "momo", kind: "incomplete", desired: null, observed: "file", detail: "render-unsupported: template uses Jinja constructs beyond simple substitution", wip: false },
    ]);
    const hermes = groupOf(agent, "scaffold.hermes");
    assert.equal(hermes.state, "error");
    assert.deepEqual(itemsOf(hermes), [
      { path: "hermes", kind: "incomplete", desired: null, observed: "file", detail: "render-unsupported: undeclared placeholder launcher_flavor", wip: false },
    ]);
    for (const leaf of GROUPS) {
      if (leaf === "scaffold.momo" || leaf === "scaffold.hermes") continue;
      assert.equal(groupOf(agent, leaf).state, "pass", `${leaf} is unaffected by another asset's unrenderable source`);
    }
    assert.equal(agent.complete, false, "an undecided asset makes the agent incomplete");
    assert.equal(agent.scaffold.assets.incomplete, 2);
    assert.equal(agent.scaffold.assets.compared, OWNED_ASSETS - 2);
    assert.equal(agent.scaffold.assets.drifted, 0, "nothing was rendered as best it can and then called stale");
    assert.equal(data.scaffold.agents.incomplete, 1);
    // Presence-only assets with control flow are the SAME template mechanism
    // and stay `pass`: policy, not a parser accident, is what exempts them.
    assert.equal(groupOf(agent, "scaffold.SOUL.md").state, "pass");
  });

  // -- AC: exceptions ride the existing axis ---------------------------------

  check("an agent_exceptions entry makes a drifted agent an exception and leaves health.healthy alone", () => {
    const ruled = policyContract((document) => {
      document.health_policy.agent_exceptions = [
        { domain: "template_scaffold", agent_id: "stale-pm", reason: "this role pins the older library on purpose", owner: "suite" },
      ];
    });
    const root = makePackageRoot("pkg-exception", YAML.stringify(ruled, { lineWidth: 0 }));
    const before = status(cliAt(mainRoot, STATUS_ARGS));
    const after = status(cliAt(root, STATUS_ARGS));
    const scripts = groupOf(agentNamed(after, "stale-pm"), "scaffold.scripts");
    assert.equal(scripts.state, "fail", "the drift is still reported and still fail");
    assert.deepEqual(scripts.justification, {
      kind: "exception", policy: "health_policy.agent_exceptions[0]",
      reason: "this role pins the older library on purpose", owner: null,
    });
    assert.equal(scripts.applicability, "exception");
    assert.equal(groupOf(agentNamed(after, "stale-pm"), "scaffold.hermes").justification, null, "a passing group carries no ruling");
    assert.equal(agentNamed(before, "stale-pm").member_class, "unhealthy");
    assert.equal(agentNamed(after, "stale-pm").member_class, "exception");
    assert.equal(after.scaffold.agents.exception_authorized, before.scaffold.agents.exception_authorized + 1);
    assert.equal(after.scaffold.agents.drifted, before.scaffold.agents.drifted - 1);
    assert.equal(after.health.healthy, before.health.healthy, "a ruling never changes health.healthy");
    assert.equal(after.health.healthy, false);
    assert.equal(after.health.members.exception, before.health.members.exception + 1);
    // Another agent's identical drift is untouched by a ruling on this one.
    assert.equal(groupOf(agentNamed(after, "missing-pm"), "scaffold.momo").justification, null);
  });

  // -- AC5: rule agreement under --live ---------------------------------------

  check("under --live the observer and hermes.pm-scaffold agree, disagree, or are not compared -- by name", () => {
    const passShim = entry("rule-pass", syntheticReport([SCAFFOLD_RULE_PASS]));
    const failShim = entry("rule-fail", syntheticReport([SCAFFOLD_RULE_FAIL]));
    const skipShim = entry("rule-skip", syntheticReport([SCAFFOLD_RULE_SKIP]));
    const live = (agent, shim) => status(cliAt(mainRoot, [...STATUS_ARGS, "--live", "--agent", agent], { PJ_FLEET_CLI_ENTRY: shim }));

    const agree = live("match-pm", passShim);
    assert.deepEqual(agree.scaffold.rule_agreement, { compared: 1, agree: 1, disagree: 0, not_compared: 0 });
    assert.equal(agree.findings.some((finding) => finding.code === "scaffold-rule-disagreement"), false);

    const disagree = live("stale-pm", passShim);
    assert.deepEqual(disagree.scaffold.rule_agreement, { compared: 1, agree: 0, disagree: 1, not_compared: 0 });
    const finding = disagree.findings.find((item) => item.code === "scaffold-rule-disagreement");
    assert.ok(finding, "a disagreement is a finding");
    assert.equal(finding.agent_id, "stale-pm");
    assert.equal(finding.scope, "agent");
    assert.equal(finding.severity, "error");
    assert.equal(finding.gating, true);
    assert.match(finding.detail, /reports pass while the scaffold observer finds drift/u);
    // BOTH readings stand: the rule's pass and the observer's fail are both on the record.
    const agent = agentNamed(disagree, "stale-pm");
    assert.equal(agent.observations.find((item) => item.rule_id === "hermes.pm-scaffold").state, "pass");
    assert.equal(groupOf(agent, "scaffold.scripts").state, "fail");

    const reverse = live("match-pm", failShim);
    assert.deepEqual(reverse.scaffold.rule_agreement, { compared: 1, agree: 0, disagree: 1, not_compared: 0 });
    assert.match(reverse.findings.find((item) => item.code === "scaffold-rule-disagreement").detail, /reports fail while the scaffold observer finds no drift/u);

    const skipped_ = live("match-pm", skipShim);
    assert.deepEqual(skipped_.scaffold.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 }, "a skip is not compared");

    // Drift the rule never covered -- a wrong mode -- is not a disagreement with a rule pass.
    const uncovered = live("mode-pm", passShim);
    assert.deepEqual(uncovered.scaffold.rule_agreement, { compared: 1, agree: 1, disagree: 0, not_compared: 0 }, "a mode finding is coverage the rule never had, not a disagreement");

    // When the template worktree is the cause, the source integrity error is
    // present and the pair is NOT compared (DW-88 records why).
    const brokenRoot = join(temp, "pkg-uninitialized");
    const broken = status(cliAt(brokenRoot, [...STATUS_ARGS, "--live", "--agent", "match-pm"], { PJ_FLEET_CLI_ENTRY: passShim }));
    assert.equal(broken.host.find((item) => item.rule_id === "scaffold.source").state, "error");
    assert.deepEqual(broken.scaffold.rule_agreement, { compared: 0, agree: 0, disagree: 0, not_compared: 1 });
  });

  // -- AC7: scoping constrains collection -------------------------------------

  check("--agent reads one role directory and keeps fleet totals; --domain registry spawns no scaffold probe", () => {
    const scoped = status(cliAt(mainRoot, [...STATUS_ARGS, "--agent", "match-pm"]));
    const probes = scoped.probes.filter((probe) => probe.kind === "scaffold");
    assert.equal(probes.length, 2, `the selected role directory and the source, nothing else: ${JSON.stringify(probes.map((p) => p.target))}`);
    assert.ok(probes.some((probe) => probe.target.endsWith("/repos/match/agents/hermes/pm")), "the selected agent's role directory was read");
    assert.ok(probes.every((probe) => !probe.target.includes("/repos/stale/")), "no other agent's role directory was read");
    assert.deepEqual(scoped.scaffold.agents, {
      total_registered: SLUGS.length, selected: 1, applicable: 1,
      passing: 1, drifted: 0, incomplete: 0, exception_authorized: 0, unobserved: SLUGS.length - 1,
    });

    const registry = status(cliAt(mainRoot, ["review", "--domain", "registry", "--json"]));
    assert.deepEqual(registry.probes.filter((probe) => probe.kind === "scaffold"), [], "zero scaffold probes");
    assert.equal(registry.scaffold, null);
    for (const agent of registry.agents) {
      assert.ok("scaffold" in agent, "the key is present");
      assert.equal(agent.scaffold, null);
    }
  });

  check("--domain profile carries data.scaffold: null and every agents[].scaffold: null, key present", () => {
    const data = status(cliAt(mainRoot, ["review", "--domain", "profile", "--json"]));
    assert.equal(data.scaffold, null);
    assert.equal(data.agents.length, SLUGS.length);
    for (const agent of data.agents) assert.equal(agent.scaffold, null);
    assert.equal(data.probes.some((probe) => probe.kind === "scaffold"), false);
  });

  // -- caps, payloads, deadlines ------------------------------------------------

  check("three hundred missing scripts cap the items at 100, note the clip, and leave the counts whole", () => {
    const root = makePackageRoot("pkg-bulk", YAML.stringify(policyContract(), { lineWidth: 0 }), { commit: COMMIT.bulk });
    // Through a REAL pipe, past the 64 KiB buffer.
    const before = snapshotIsolated();
    const piped = spawnSync("sh", ["-c", `"$0" "$@" | cat`, process.execPath, join(root, "dist", "index.js"), ...STATUS_ARGS], {
      cwd: workdir, env: { ...process.env, ...isolation }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000,
    });
    assertUnchanged(before, snapshotIsolated(), "the bulk run");
    assert.ok(piped.stdout.length > 65_536, `payload is only ${piped.stdout.length} bytes; below the pipe buffer the defect cannot fire`);
    const data = status(piped);
    for (const agent of data.agents) {
      const scripts = groupOf(agent, "scaffold.scripts");
      assert.equal(scripts.state, "fail");
      assert.equal(itemsOf(scripts).length, MAX_ITEMS, `${agent.agent_id}: items are capped`);
      assert.ok(itemsOf(scripts).every((item) => item.kind === "missing" || item.kind === "stale-content" || item.kind === "wrong-mode" || item.kind === "unexpected-owned"));
      assert.ok(agent.scaffold.assets.drifted >= BULK_SCRIPTS, `${agent.agent_id}: the counts are computed over every item, got ${agent.scaffold.assets.drifted}`);
      assert.equal(agent.scaffold.assets.owned, OWNED_ASSETS + BULK_SCRIPTS);
    }
    assert.equal(agentNamed(data, "match-pm").scaffold.assets.drifted, BULK_SCRIPTS);
    const note = data.truncated.find((item) => item.startsWith("agents.match-pm.observations[scaffold.scripts].items:"));
    assert.ok(note, `the clip must be recorded, got ${JSON.stringify(data.truncated)}`);
    assert.match(note, new RegExp(`${BULK_SCRIPTS - MAX_ITEMS} of ${BULK_SCRIPTS} items dropped`, "u"));
    assert.equal(data.health.truncated, true);
  });

  check("a blown --deadline-ms is TIMEOUT at exit 7 with no partial result", () => {
    const result = cliAt(mainRoot, [...STATUS_ARGS, "--deadline-ms", "1"]);
    assert.equal(result.status, 7, `expected exit 7, got ${result.status}`);
    const parsed = envelope(result);
    assert.equal(errorCode(parsed), "TIMEOUT");
  });

  // -- AC6: determinism, both adapters, no secret, no body ---------------------

  check("two consecutive runs produce byte-identical data, and no secret or file body reaches either surface", () => {
    const first = cliAt(mainRoot, STATUS_ARGS);
    const second = cliAt(mainRoot, STATUS_ARGS);
    assert.equal(first.stdout, second.stdout, "data is not byte-stable across two runs");
    const human = cliAt(mainRoot, ["review", "--domain", "template_scaffold"]);
    for (const [name, text] of [["--json", first.stdout], ["the human report", human.stdout]]) {
      assert.ok(text.length > 0, `${name} is empty`);
      assert.equal(text.includes(SECRET_SENTINEL), false, `the planted secret reached ${name}`);
      assert.equal(text.includes("echo launcher v3"), false, `a file body reached ${name}`);
      assert.equal(text.includes("lib_version"), false, `a file body reached ${name}`);
      assert.equal(text.includes(join(reposRoot, "edited", "agents", "hermes", "pm", "hermes")), false, `an absolute asset path reached ${name}`);
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u, `a timestamp reached ${name}`);
    }
    // The human report prints the items and the parity summary.
    assert.match(human.stdout, /stale-content \.scripts\/_lib\.sh/u, "the report prints typed items");
    assert.match(human.stdout, /scaffold parity over \d+ of \d+ selected/u, "the report prints the domain summary");
    assert.match(human.stdout, /scaffold \d+\/\d+/u, "the report prints the per-agent scaffold cell");
    assert.match(human.stdout, /scaffold\.source/u, "the report prints the source integrity host finding");
  });

  await checkAsync("the MCP tool returns the same data as the CLI, scaffold summaries included", async () => {
    const cli = status(cliAt(mainRoot, STATUS_ARGS));
    const env = { ...process.env, ...isolation };
    const before = snapshotIsolated();
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(mainRoot, "dist", "mcp-server.js")], cwd: workdir, env });
    const client = new Client({ name: "fleet-scaffold-suite", version: "1.0.0" });
    await client.connect(transport);
    let result;
    try {
      result = await client.callTool({ name: "flume_review", arguments: { domain: "template_scaffold" } });
    } finally {
      await client.close();
    }
    assertUnchanged(before, snapshotIsolated(), "the MCP run");
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
    const parsed = JSON.parse(text);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data, cli, "MCP data must deep-equal the CLI's");
    assert.ok(parsed.data.scaffold, "data.scaffold is present over MCP");
    assert.ok(parsed.data.agents.every((agent) => agent.scaffold !== null), "every agents[].scaffold is present over MCP");
  });

  // -- a contract with no manifest, and contracts that must not load -----------

  check("a contract with no scaffold_manifest loads and reports the domain unsupported under scaffold.manifest", () => {
    const bare = policyContract((document) => {
      delete document.scaffold_manifest;
      document.schema_version = 2;
      document.compatibility.max_schema_version = 2;
    });
    const root = makePackageRoot("pkg-no-manifest", YAML.stringify(bare, { lineWidth: 0 }));
    const data = status(cliAt(root, [...STATUS_ARGS, "--agent", "match-pm"]));
    const agent = agentNamed(data, "match-pm");
    const gap = agent.observations.filter((item) => item.source === "fleet-scaffold");
    assert.equal(gap.length, 1);
    assert.equal(gap[0].state, "unsupported");
    assert.match(gap[0].summary, /scaffold_manifest/u);
    assert.equal(gap[0].justification, null, "unjustified: the tracked policy declares no such deferral");
    assert.equal(agent.scaffold, null);
    assert.equal(data.scaffold.source.integrity, "manifest-undeclared");
    assert.equal(data.scaffold.agents.applicable, 0);
    assert.deepEqual(data.probes.filter((probe) => probe.kind === "scaffold"), [], "nothing is read without a manifest");
  });

  check("fleet status refuses a manifest that matches nothing and a duplicate agent ruling, before any probe", () => {
    const badGroup = writeContract("bad-group", policyContract((document) => { document.scaffold_manifest.groups["scaffold.invented"] = "invented/"; }));
    const dupe = writeContract("dupe-ruling", policyContract((document) => {
      document.health_policy.agent_exceptions = [
        { domain: "template_scaffold", agent_id: "stale-pm", reason: "once", owner: "suite" },
        { domain: "template_scaffold", agent_id: "stale-pm", reason: "twice", owner: "suite" },
      ];
    }));
    for (const [path, hint] of [[badGroup, /scaffold_manifest\.groups\.scaffold\.invented/u], [dupe, /agent_exceptions\[1\]/u]]) {
      const result = cliAt(mainRoot, [...STATUS_ARGS, "--contract", path]);
      assert.equal(result.status, 2, `a contract that lies must exit 2, got ${result.status}`);
      const parsed = envelope(result);
      assert.equal(errorCode(parsed), "INVALID_INPUT");
      assert.match(parsed.error.message, hint);
    }
  });

  // -- the gates that make this reachable on a fresh clone --------------------

  check("the runner knows about scaffold parity", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.match(runner, /tests\/fleet-scaffold-regressions\.mjs/u, "a suite not listed in SUITES never runs");
  });

  check("no invocation in this suite wrote to this repository", () => {
    assertUnchanged(sharedAtStart, snapshotShared(), "this suite");
  });

  // -- AC8: the live fleet, sampled independently -----------------------------

  check("on the real fleet the pjangler agent's _lib.sh item agrees with an independent git blob-id comparison", () => {
    const label = "on the real fleet the pjangler agent's _lib.sh item agrees with an independent git blob-id comparison";
    if (!existsSync(REAL_AGENT_REGISTRY) || !existsSync(REAL_PROJECT_REGISTRY)) skipCase(label, "the operator's live registries are not on this host");
    const registered = YAML.parse(readFileSync(REAL_AGENT_REGISTRY, "utf8"))?.agents ?? {};
    const row = registered["pjangler-pm"];
    if (!row || typeof row.role_dir !== "string") skipCase(label, "the live registry has no pjangler-pm row with a role_dir");
    const gitlink = /([0-9a-f]{40})/u.exec(git(ROOT, ["ls-tree", "HEAD", "--", "templates/hermes-agent"]).stdout)?.[1];
    if (!gitlink) skipCase(label, "this checkout commits no gitlink for templates/hermes-agent");
    const desired = git(join(ROOT, "templates", "hermes-agent"), ["rev-parse", `${gitlink}:template/.scripts/_lib.sh`]).stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(desired)) skipCase(label, "the pinned template renders no .scripts/_lib.sh");
    const deployed = join(row.role_dir, ".scripts", "_lib.sh");
    if (!existsSync(deployed)) skipCase(label, "the live role carries no .scripts/_lib.sh");
    const observed = git(ROOT, ["hash-object", deployed]).stdout.trim();

    const result = spawnSync(process.execPath, [CLI, ...STATUS_ARGS, "--agent", "pjangler-pm"], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000, env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, `the live fleet must report at exit 0: ${result.stderr}`);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.scaffold.source.gitlink, gitlink, "the observer's source is the committed gitlink");
    assert.equal(data.scaffold.agents.total_registered, Object.keys(registered).length);
    const agent = agentNamed(data, "pjangler-pm");
    assert.equal(agent.scaffold.source_gitlink, gitlink);
    const item = itemsOf(groupOf(agent, "scaffold.scripts")).find((candidate) => candidate.path === ".scripts/_lib.sh");
    if (desired === observed) {
      assert.equal(item, undefined, "an identical blob must carry no item");
    } else {
      assert.ok(item, "a differing blob must carry an item");
      assert.ok(item.kind === "stale-content" || item.kind === "locally-modified", `got ${item.kind}`);
      assert.equal(item.desired, desired.slice(0, 12));
      assert.equal(item.observed, observed.slice(0, 12));
      // Lineage, independently: in the template's object database means stale.
      const inHistory = git(join(ROOT, "templates", "hermes-agent"), ["cat-file", "-e", observed]).status === 0;
      assert.equal(item.kind, inHistory ? "stale-content" : "locally-modified", "stale versus modified must agree with object-database membership");
    }
    console.log(`       live: gitlink ${gitlink.slice(0, 12)}, _lib.sh desired ${desired.slice(0, 12)} observed ${observed.slice(0, 12)} -> ${item ? item.kind : "match"}; ${JSON.stringify(agent.scaffold.assets)}`);
  });
} catch (error) {
  if (!(error instanceof SkipCase)) throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(shimRoot, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} fleet scaffold check(s) failed`);
  process.exit(1);
}
console.log(`fleet scaffold regressions passed${skipped ? ` (${skipped} skipped)` : ""}`);
