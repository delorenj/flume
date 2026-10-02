#!/usr/bin/env node
/**
 * FLUME-32: prove that a role's skills loadout reaches a REAL strict desk as a Skillex selection.
 *
 * The live fleet is read, never written: the desk is rebuilt in a scratch Hermes root the same way
 * the template's step 10 builds a PM desk (`skillex profile sync NAME --project REPO --skillex-only`
 * against the real flume repo and the real Skillex catalog), then the role is onboarded through the
 * real `flume onboard` caller. Run it once with the flume build under test and once with an older
 * build to see the before/after:
 *
 *   node scripts/flume32-selection-proof.mjs [--new DIST] [--old DIST] [--set NAME] [--out FILE]
 *
 * Secret-free by construction: it records exit codes, skill names, paths and rule verdicts only.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const HOME = homedir();
const live = { hermes: join(HOME, ".hermes"), repo: join(HOME, "code", "33GOD", "flume"), skillex: process.env.PJ_SKILLS_REGISTRY_ROOT || join(HOME, "code", "skillex") };
const newDist = resolve(option("--new", join(root, "packages", "flume-hr", "dist", "index.js")));
const oldDist = option("--old") ? resolve(option("--old")) : null;
const loadoutSet = option("--set", "product-manager");
const out = option("--out");
const skillexCli = join(root, "node_modules", "@delorenj", "skillex", "dist", "cli.js");
const profile = "flume-pm";

const sha = (path) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16) : null);
const deskTree = (path) => {
  if (!existsSync(path)) return null;
  return readdirSync(path).sort().map((name) => { const p = join(path, name); const l = lstatSync(p); return `${name}${l.isSymbolicLink() ? ` -> ${readlinkSync(p)}` : ""}`; });
};

function liveFingerprint() {
  return {
    registry: sha(join(live.hermes, "agents-registry.yaml")),
    org: sha(join(live.hermes, "org.yaml")),
    base: sha(join(live.hermes, "config.yaml")),
    deskDelta: sha(join(live.hermes, "profiles", profile, "config.delta.yaml")),
    deskConfig: sha(join(live.hermes, "profiles", profile, "config.yaml")),
    deskSkills: deskTree(join(live.hermes, "profiles", profile, "skills")),
    deskRoot: readdirSync(join(live.hermes, "profiles", profile)).sort(),
    repoManifest: sha(join(live.repo, ".agents", "skills.json")),
    rolePm: sha(join(live.repo, "roles", "pm.md")),
  };
}

function build(label) {
  const dir = mkdtempSync(join("/tmp", `flume32-proof-${label}-`));
  const hermes = join(dir, "hermes"), repo = join(dir, "flume"), roles = join(dir, "declarations"), state = join(dir, "state");
  mkdirSync(join(hermes, "profiles", profile), { recursive: true });
  for (const file of ["config.yaml", "agents-registry.yaml", "org.yaml"]) cpSync(join(live.hermes, file), join(hermes, file));
  writeFileSync(join(hermes, ".env"), ""); writeFileSync(join(hermes, "auth.json"), "{}\n");
  cpSync(join(live.hermes, "profiles", profile, "config.delta.yaml"), join(hermes, "profiles", profile, "config.delta.yaml"));
  // the repo's tracked role directory, as the PM was hired into it
  const tracked = spawnSync("git", ["-C", live.repo, "ls-files", "agents/hermes/pm", ".project.json"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const file of tracked) { mkdirSync(dirname(join(repo, file)), { recursive: true }); cpSync(join(live.repo, file), join(repo, file)); }
  // the real pm.md charter plus a deployment declaration (department from the live org chart)
  const pm = readFileSync(join(live.repo, "roles", "pm.md"), "utf8");
  mkdirSync(join(roles, "roles"), { recursive: true });
  writeFileSync(join(roles, "roles", "pm.md"), pm.replace(/^---\n/, `---\nskills:\n  set: ${loadoutSet}\ndepartment: tooling\n`));
  const env = { ...process.env, TMPDIR: "/tmp", XDG_STATE_HOME: state, HERMES_FLEET_HOME: hermes, HERMES_AGENTS_REGISTRY: join(hermes, "agents-registry.yaml"), HERMES_ORG_PATH: join(hermes, "org.yaml"), PJ_SKILLS_REGISTRY_ROOT: live.skillex, FLUME_ROLES_ROOT: roles, HERMES_FLEET_ENV: join(dir, "no-fleet.env") };
  return { dir, hermes, repo, roles, env, desk: join(hermes, "profiles", profile) };
}

const run = (cmd, argv, opts) => spawnSync(cmd, argv, { encoding: "utf8", timeout: 120000, ...opts });
const skillex = (s, ...argv) => {
  const r = run(process.execPath, [skillexCli, ...argv, "--hermes-root", s.hermes, "--registry-root", live.skillex, "--json"], { env: s.env });
  let report = null; try { report = JSON.parse(r.stdout); } catch { /* keep null */ }
  return { exit: r.status, report };
};
const flume = (s, dist, ...argv) => run(process.execPath, [dist, ...argv], { cwd: s.repo, env: s.env });
const auditRule = (s, dist, rule) => {
  const r = flume(s, dist, "audit", s.repo, "--rules", rule, "--json");
  try { const f = JSON.parse(r.stdout).rules.find((x) => x.id === rule); return { status: f.status, details: f.details }; } catch { return { status: "error", details: [String(r.stderr).slice(0, 300)] }; }
};

/** Rebuild the live PM desk as a strict desk, exactly the way the template's step 10 does. */
function seedStrictDesk(s) {
  const render = run("python3", [join(root, "templates", "hermes-agent", "scripts", "hermes-profile-config.py"), "render", "--profile", profile], { env: s.env });
  if (render.status !== 0) throw new Error(`render failed: ${render.stderr}`);
  const sync = skillex(s, "profile", "sync", profile, "--project", live.repo, "--skillex-only");
  if (sync.exit !== 0) throw new Error(`strict seed refused (exit ${sync.exit}): ${JSON.stringify(sync.report?.findings)}`);
  const shown = skillex(s, "profile", "show", profile, "--project", live.repo);
  if (shown.exit !== 0) throw new Error(`strict seed not converged (exit ${shown.exit})`);
  return shown.report.data.managed.length;
}

function observe(s, dist, label) {
  const selection = join(s.desk, ".skillex-selection");
  const named = existsSync(selection) ? skillex(s, "profile", "show", profile, "--project", selection) : { exit: null, report: null };
  const recorded = skillex(s, "profile", "show", profile);
  const cfg = YAML.parse(readFileSync(join(s.desk, "config.yaml"), "utf8")) ?? {};
  const names = (named.report?.data?.managed ?? recorded.report?.data?.managed ?? []).map((m) => m.name);
  const manifestPath = join(selection, ".agents", "skills.json");
  return {
    label,
    selectionManifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null,
    profileShowExplicitProject: { exit: named.exit, findings: (named.report?.findings ?? []).map((f) => `${f.code}: ${f.message}`).slice(0, 3) },
    profileShowRecordedProject: { exit: recorded.exit, project: recorded.report?.data?.project ?? null, findings: (recorded.report?.findings ?? []).map((f) => `${f.code}: ${f.message}`).slice(0, 3), pendingChanges: (recorded.report?.data?.changes ?? []).length },
    deskSkillCount: names.length,
    loadoutPresent: readdirSync(join(live.skillex, "sets", loadoutSet)).filter((n) => !n.startsWith(".")).sort().every((n) => names.includes(n)),
    externalDirs: cfg.skills?.external_dirs ?? null,
    deskHasDotAgents: existsSync(join(s.desk, ".agents")),
    strictMarkers: [".skillex-only", ".no-bundled-skills"].map((m) => existsSync(join(s.desk, m))),
    audit: {
      "hermes.role-declaration": auditRule(s, dist, "hermes.role-declaration"),
      "hermes.delta-list-override": auditRule(s, dist, "hermes.delta-list-override"),
      "hermes.runtime-singleton": auditRule(s, dist, "hermes.runtime-singleton"),
    },
  };
}

const evidence = { generatedAt: new Date().toISOString(), loadoutSet, newBuild: newDist, oldBuild: oldDist };
const before = liveFingerprint();
const scratches = [];
try {
  // ---------------------------------------------------------------- the build under test
  const s = build("new"); scratches.push(s.dir);
  evidence.seedManagedSkills = seedStrictDesk(s);
  evidence.seedDeskMarkers = { skillexOnly: existsSync(join(s.desk, ".skillex-only")), noBundled: existsSync(join(s.desk, ".no-bundled-skills")) };
  const onboard = () => flume(s, newDist, "onboard", "pm", "--skip-telegram", "--skip-plane", "--local");
  const first = onboard();
  const fingerprint = () => ({ registry: sha(join(s.hermes, "agents-registry.yaml")), org: sha(join(s.hermes, "org.yaml")), config: sha(join(s.desk, "config.yaml")), delta: sha(join(s.desk, "config.delta.yaml")), manifest: sha(join(s.desk, ".skillex-selection", ".agents", "skills.json")), skills: deskTree(join(s.desk, "skills")) });
  const afterFirst = fingerprint();
  const second = onboard();
  evidence.new = {
    onboard: { first: first.status, second: second.status, secondRunChangedNothing: JSON.stringify(afterFirst) === JSON.stringify(fingerprint()), message: (first.stdout.match(/Role declaration projected:.*/) ?? [""])[0].replace(/"path":"[^"]*"/g, '"path":"…"').slice(0, 300) },
    ...observe(s, newDist, "new flume"),
  };
  // the remediation caller: projects the same role, then the singleton links make the rule fully observable
  const remediate = flume(s, newDist, "remediate", "hermes.runtime-singleton", s.repo, "--json");
  evidence.new.remediate = { exit: remediate.status };
  evidence.new.afterRemediate = observe(s, newDist, "new flume after remediate");
  // Skillex's own desk auto-resync must follow the RECORDED project (the role selection), never the repo:
  // move the selection, let the resync converge the desk, then let flume put the declaration back.
  const resync = join(live.skillex, "scripts", "hermes-skillex-resync.py");
  if (existsSync(resync)) {
    const manifest = join(s.desk, ".skillex-selection", ".agents", "skills.json");
    const original = readFileSync(manifest, "utf8");
    const alternate = "automaticai-provider";
    const deskLine = (r) => { try { return JSON.parse(r.stdout).results.find((d) => d.desk === profile) ?? null; } catch { return null; } };
    const resyncArgs = ["--json", "--hermes-root", s.hermes, "--registry-root", live.skillex, "--state-dir", join(s.dir, "resync-state"), "--lock-file", join(s.dir, "resync.lock")];
    const converged = run("python3", [resync, "--dry-run", ...resyncArgs], { env: s.env });
    writeFileSync(manifest, JSON.stringify({ inherit_global: false, sets: [alternate] }, null, 2) + "\n");
    const planned = run("python3", [resync, "--dry-run", ...resyncArgs], { env: s.env });
    const applied = run("python3", [resync, ...resyncArgs], { env: s.env });
    const moved = skillex(s, "profile", "show", profile);
    const names = readdirSync(join(s.desk, "skills")).filter((n) => !n.startsWith("."));
    evidence.new.autoResync = {
      onConvergedDesk: deskLine(converged)?.status ?? "no desk line",
      afterSelectionMoved: { dryRun: deskLine(planned)?.status ?? "no desk line", applied: deskLine(applied)?.status ?? "no desk line", project: deskLine(applied)?.project ?? null },
      followedRecordedProject: names.includes("automaticai-provider-gateway") && !names.includes("product-manager-hub"),
      showExitAfter: moved.exit,
    };
    writeFileSync(manifest, original);
    const restored = onboard();
    evidence.new.autoResync.flumeRestoredDeclaration = restored.status === 0 && readdirSync(join(s.desk, "skills")).includes("product-manager-hub") && skillex(s, "profile", "show", profile).exit === 0;
  }
  const row = (YAML.parse(readFileSync(join(s.hermes, "agents-registry.yaml"), "utf8")).agents ?? {})[profile] ?? {};
  const tooling = (YAML.parse(readFileSync(join(s.hermes, "org.yaml"), "utf8")).departments ?? []).find((d) => d.id === "tooling") ?? {};
  evidence.new.orgPlacement = { registryDepartment: row.department, registryReportsTo: row.reports_to, departmentManager: tooling.manager, listedUnderDepartment: (tooling.members ?? []).includes(profile) };

  // ---------------------------------------------------------------- the older build, same scratch recipe
  if (oldDist) {
    const o = build("old"); scratches.push(o.dir);
    seedStrictDesk(o);
    const oldFirst = flume(o, oldDist, "onboard", "pm", "--skip-telegram", "--skip-plane", "--local");
    evidence.old = { onboard: { first: oldFirst.status }, ...observe(o, oldDist, "old flume") };
  }
} finally {
  const after = liveFingerprint();
  evidence.liveFleetUntouched = JSON.stringify(before) === JSON.stringify(after);
  if (!evidence.liveFleetUntouched) evidence.liveFleetDiff = { before, after };
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
}
const text = JSON.stringify(evidence, null, 2) + "\n";
if (out) writeFileSync(resolve(out), text);
console.log(text);
process.exit(evidence.liveFleetUntouched ? 0 : 2);
