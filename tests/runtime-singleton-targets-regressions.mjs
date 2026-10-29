// Regression guard for the re-hire runtime-links bug.
//
// A Hermes desk (profiles/<agent>) links its per-agent state into the
// repo-local, git-ignored runtime dir <role>/runtime/. When a desk ALREADY has
// correct links but the runtime dir is fresh (a re-hire after the runtime was
// lost, or `flume hire` into a repo whose runtime was moved aside), the links
// dangle. Hermes refuses to create the target of a link, so the profile fails to
// initialize on every gateway start -- while hermes.runtime-singleton audited
// "pass" (a link that points at the right place was healthy whether or not the
// place existed) and migrate skipped every already-correct link, so the target
// mkdir never ran. pilot-pm hit it twice; template step 20 logged "singleton
// profile verified" both times.
//
// Every case drives the REAL built dist/index.js in a real subprocess against a
// constructed fleet home. HOME is a scratch directory, so nothing here reads or
// writes the operator's real ~/.hermes.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const RULE = "hermes.runtime-singleton";
const DIRS = ["memories", "sessions", "workspace", "logs", "cron", "plans", "hooks", "pairing", "audio_cache", "image_cache"];
const FILES = ["SOUL.md", "state.db", "kanban.db"];
const tmpRoots = [];

// /tmp when it exists: Skillex refuses to write activation receipts under a
// source repository, and a TMPDIR inside one is how a harness can end up here.
function scratch() {
  const base = existsSync("/tmp") ? "/tmp" : tmpdir();
  const dir = mkdtempSync(join(base, "singleton-targets-"));
  tmpRoots.push(dir);
  return dir;
}

/**
 * A fleet home, a project repo with one PM role, and a named profile whose
 * thirteen runtime links are all correct. The runtime holds what template step
 * 20 leaves behind on a fresh hire -- the scaffold's memories/ and logs/ and a
 * seeded SOUL.md -- and nothing else.
 */
function fixture({ roleSoul = "I am demo-pm.\n", runtimeSoul = "seeded soul\n", links = true } = {}) {
  const home = scratch();
  const fleet = join(home, ".hermes");
  const repo = join(home, "repo");
  const roleDir = join(repo, "agents", "hermes", "pm");
  const runtime = join(roleDir, "runtime");
  const profile = join(fleet, "profiles", "demo-pm");
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: repo, encoding: "utf8" }).status, 0, `git ${args.join(" ")}`);

  mkdirSync(roleDir, { recursive: true });
  git("init", "-q");
  writeFileSync(join(roleDir, "role.yaml"), "repo: demo\nrole: pm\nagent_id: demo-pm\nprofile: demo-pm\n");
  if (roleSoul !== null) writeFileSync(join(roleDir, "SOUL.md"), roleSoul);
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(join(repo, ".agents", "skills.json"), "{}\n");
  // A catalog with nothing in it: the skills half of the rule has nothing to project.
  mkdirSync(join(home, "registry", "all-skills"), { recursive: true });

  // The profile as `hermes profile create` + the renderer leave it.
  mkdirSync(join(profile, "hindsight"), { recursive: true });
  writeFileSync(join(fleet, ".env"), "");
  writeFileSync(join(fleet, "config.yaml"), "{}\n");
  symlinkSync(join(fleet, ".env"), join(profile, ".env"));
  writeFileSync(join(profile, "config.yaml"), "# GENERATED FILE -- DO NOT EDIT.\n{}\n");
  writeFileSync(join(profile, "config.delta.yaml"), "{}\n");
  writeFileSync(join(profile, "hindsight", "config.json"), JSON.stringify({ bank_id: "agent-demo-pm" }));
  writeFileSync(join(profile, ".skillex-only"), "Skillex owns this PM skill projection.\n");

  // The fresh runtime.
  mkdirSync(join(runtime, "memories"), { recursive: true });
  mkdirSync(join(runtime, "logs"), { recursive: true });
  writeFileSync(join(runtime, "memories", "MEMORY.md"), "scaffold memory\n");
  if (runtimeSoul !== null) writeFileSync(join(runtime, "SOUL.md"), runtimeSoul);

  // Correct links, every one of them.
  if (links) for (const entry of [...DIRS, ...FILES]) symlinkSync(join(runtime, entry), join(profile, entry));

  const env = { ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, PJ_SKILLS_REGISTRY_ROOT: join(home, "registry") };
  const run = (...args) => {
    const r = spawnSync("node", [cli, ...args, "--json"], { cwd: repo, env, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.ok(r.stdout, `no stdout from flume ${args.join(" ")}: ${r.stderr}`);
    return { status: r.status, report: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const audit = () => {
    const r = run("audit", "--rules", RULE);
    const finding = r.report.rules.find((f) => f.id === RULE);
    assert.ok(finding, `${RULE} must be reported`);
    return { status: r.status, finding };
  };
  const remediate = (...extra) => {
    const r = run("remediate", RULE, ...extra);
    return { status: r.status, result: r.report.results.find((x) => x.id === RULE), report: r.report };
  };
  return { home, runtime, profile, roleDir, audit, remediate };
}

// The rule also reports the Skillex projection (a fresh profile has none yet, until a
// migrate writes it). The runtime links are what this suite is about.
const linkLines = (finding) => finding.details.filter((d) => /^(missing|missing-target|wrong-target|not-a-symlink): /u.test(d));
const targetsOf = (finding) => finding.details.filter((d) => d.startsWith("missing-target: ")).map((d) => d.split(" -> ")[0].split("/").pop());
const snapshot = (dir) => readdirSync(dir).sort().join(",");
const linksOf = (profile) => Object.fromEntries([...DIRS, ...FILES].map((e) => [e, lstatSync(join(profile, e)).isSymbolicLink() ? readlinkSync(join(profile, e)) : null]));

try {
  // 1. The exact re-hire case: correct links over a fresh runtime. Audit names every missing target.
  {
    const f = fixture();
    const { status, finding } = f.audit();
    assert.equal(finding.status, "fail", `correct links over a fresh runtime must not audit as verified:\n${finding.details.join("\n")}`);
    assert.equal(status, 1);
    assert.equal(finding.fixable, true);
    assert.deepEqual(
      targetsOf(finding).sort(),
      ["audio_cache", "cron", "hooks", "image_cache", "pairing", "plans", "sessions", "workspace"],
      "exactly the owned directories the fresh runtime lacks",
    );
    for (const present of ["memories", "logs", "SOUL.md"]) assert.ok(!targetsOf(finding).includes(present), `${present} exists and is not a finding`);
    // The finding names link AND target, and keeps the old states' shape.
    assert.match(finding.details.find((d) => d.startsWith("missing-target: ") && d.includes("/pairing ")), /missing-target: .*\/profiles\/demo-pm\/pairing -> .*\/runtime\/pairing$/u);
    assert.ok(!finding.details.some((d) => /^(missing|wrong-target|not-a-symlink): /u.test(d)), "the links themselves are correct; only their targets are missing");
    assert.equal(linkLines(finding).length, 8, "and nothing else about the links is reported");
  }

  // 2. state.db / kanban.db are created lazily by sqlite through the link: dangling alone is NOT a finding.
  {
    const f = fixture();
    for (const dir of DIRS) mkdirSync(join(f.runtime, dir), { recursive: true });
    assert.ok(!existsSync(join(f.runtime, "state.db")) && !existsSync(join(f.runtime, "kanban.db")));
    assert.ok(lstatSync(join(f.profile, "state.db")).isSymbolicLink() && !existsSync(join(f.profile, "state.db")), "state.db dangles");
    const { finding } = f.audit();
    assert.deepEqual(linkLines(finding), [], `dangling state.db/kanban.db alone must not be a finding:\n${finding.details.join("\n")}`);
    // And once the rest of the profile is wired, the rule as a whole passes with them still dangling.
    assert.equal(f.remediate().status, 0);
    assert.ok(!existsSync(join(f.runtime, "state.db")));
    const settled = f.audit();
    assert.equal(settled.finding.status, "pass", settled.finding.details.join("\n"));
    assert.equal(settled.status, 0);
  }

  // 3. A missing SOUL.md is a finding: the desk has no soul.
  {
    const f = fixture({ runtimeSoul: null });
    for (const dir of DIRS) mkdirSync(join(f.runtime, dir), { recursive: true });
    const { finding } = f.audit();
    assert.equal(finding.status, "fail");
    assert.deepEqual(targetsOf(finding), ["SOUL.md"]);
  }

  // 4. Dry run reports "would create" and creates NOTHING.
  {
    const f = fixture();
    const before = snapshot(f.runtime);
    const links = linksOf(f.profile);
    const { status, result } = f.remediate("--dry-run");
    assert.equal(status, 0, JSON.stringify(result));
    assert.equal(result.status, "skipped");
    assert.equal(snapshot(f.runtime), before, "a dry run creates nothing");
    assert.deepEqual(linksOf(f.profile), links, "a dry run touches no link");
    for (const dir of ["sessions", "workspace", "cron", "plans", "hooks", "pairing", "audio_cache", "image_cache"]) {
      assert.ok(result.details.some((d) => d.startsWith("would create runtime dir ") && d.includes(`/runtime/${dir}`)), `would create ${dir}: ${result.details.join("\n")}`);
    }
    assert.ok(!result.details.some((d) => /^create runtime dir /u.test(d)), "a preview never claims it created anything");
  }

  // 5. Migrate materializes every missing owned directory, leaves links and data alone, and the second audit passes.
  {
    const f = fixture();
    const links = linksOf(f.profile);
    const memory = readFileSync(join(f.runtime, "memories", "MEMORY.md"), "utf8");
    const soulStat = statSync(join(f.runtime, "SOUL.md"));
    const { status, result } = f.remediate();
    assert.equal(status, 0, `${result.status}: ${result.summary}\n${result.details.join("\n")}`);
    assert.equal(result.status, "applied");
    for (const dir of DIRS) assert.ok(statSync(join(f.runtime, dir)).isDirectory(), `${dir} exists`);
    assert.equal(statSync(join(f.runtime, "pairing")).mode & 0o777, 0o700, "pairing is credential-adjacent: owner-only");
    assert.deepEqual(linksOf(f.profile), links, "correct links are never rewritten");
    assert.equal(readFileSync(join(f.runtime, "memories", "MEMORY.md"), "utf8"), memory, "existing runtime data is never touched");
    assert.equal(readFileSync(join(f.runtime, "SOUL.md"), "utf8"), "seeded soul\n", "an existing runtime SOUL.md is never overwritten");
    assert.equal(statSync(join(f.runtime, "SOUL.md")).mtimeMs, soulStat.mtimeMs);
    assert.ok(!existsSync(join(f.runtime, "state.db")) && !existsSync(join(f.runtime, "kanban.db")), "sqlite owns the databases; migrate does not invent them");
    for (const dir of DIRS) assert.ok(!existsSync(join(f.profile, `${dir}.pre-singleton`)), "nothing was parked: no link was rewritten");

    const second = f.audit();
    assert.equal(second.finding.status, "pass", `second audit must pass:\n${second.finding.details.join("\n")}`);
    assert.equal(second.status, 0);
    const again = f.remediate();
    assert.equal(again.result.status, "noop", "migrate is idempotent");
  }

  // 6. SOUL.md: never invented. Seeded from the role's own tracked SOUL.md (the file template step 20 copies), else blocked.
  {
    const f = fixture({ runtimeSoul: null });
    const { status, result } = f.remediate();
    assert.equal(status, 0, result.details.join("\n"));
    assert.equal(readFileSync(join(f.runtime, "SOUL.md"), "utf8"), "I am demo-pm.\n", "seeded from the role's SOUL.md");
    assert.equal(f.audit().finding.status, "pass");
  }
  {
    const f = fixture({ runtimeSoul: null, roleSoul: null });
    const { status, result } = f.remediate();
    assert.equal(status, 1, "no soul anywhere is a failure, not a quiet success");
    assert.equal(result.status, "blocked");
    assert.ok(result.details.some((d) => d.startsWith("blocked: ") && /no SOUL\.md to link/u.test(d) && /flume remediate hermes\.pm-scaffold/u.test(d)), result.details.join("\n"));
    assert.ok(!existsSync(join(f.runtime, "SOUL.md")), "no soul is invented");
    assert.equal(f.audit().finding.status, "fail", "and the audit keeps saying so");
  }
  {
    // An empty role SOUL.md is not a soul either.
    const f = fixture({ runtimeSoul: null, roleSoul: "" });
    assert.equal(f.remediate().result.status, "blocked");
    assert.ok(!existsSync(join(f.runtime, "SOUL.md")));
  }

  // 7. Something that is not a directory sits where an owned directory must be: blocked, untouched, never replaced.
  {
    const f = fixture();
    writeFileSync(join(f.runtime, "sessions"), "i am a file\n");
    const { status, result } = f.remediate();
    assert.equal(status, 1);
    assert.equal(result.status, "blocked");
    assert.ok(result.details.some((d) => d.startsWith("blocked: ") && d.includes("/runtime/sessions exists but is not a directory")), result.details.join("\n"));
    assert.equal(readFileSync(join(f.runtime, "sessions"), "utf8"), "i am a file\n", "the occupant is never deleted or replaced");
    assert.ok(statSync(join(f.runtime, "workspace")).isDirectory(), "the other directories are still materialized");
  }
  {
    // And the AUDIT says so too. A correct link onto a file where a directory
    // belongs is as unusable to Hermes as a dangling one ("Directory link is
    // unavailable"), and migrate refuses it -- an audit that passed it would let
    // remediate fail on a rule the audit calls clean.
    const f = fixture();
    for (const dir of DIRS) if (dir !== "sessions") mkdirSync(join(f.runtime, dir), { recursive: true });
    writeFileSync(join(f.runtime, "sessions"), "i am a file\n");
    const { finding } = f.audit();
    assert.equal(finding.status, "fail");
    assert.deepEqual(targetsOf(finding), ["sessions"], finding.details.join("\n"));
  }
  {
    // SOUL.md's target must be a file: a directory there is no soul, and migrate says blocked rather than noop.
    const f = fixture({ runtimeSoul: null });
    for (const dir of DIRS) mkdirSync(join(f.runtime, dir), { recursive: true });
    mkdirSync(join(f.runtime, "SOUL.md"));
    assert.deepEqual(targetsOf(f.audit().finding), ["SOUL.md"]);
    const { status, result } = f.remediate();
    assert.equal(status, 1);
    assert.ok(result.details.some((d) => d.startsWith("blocked: ") && d.includes("/runtime/SOUL.md is not a regular file")), result.details.join("\n"));
    assert.ok(statSync(join(f.runtime, "SOUL.md")).isDirectory(), "the occupant is never replaced");
  }

  // 8. A link to somewhere ELSE is still reported as wrong-target, and no directory is created through it.
  {
    const f = fixture();
    const elsewhere = join(f.home, "elsewhere");
    mkdirSync(elsewhere);
    unlinkSync(join(f.profile, "plans"));
    symlinkSync(elsewhere, join(f.profile, "plans"));
    const { finding } = f.audit();
    assert.ok(finding.details.some((d) => d.startsWith("wrong-target: ") && d.includes("/profiles/demo-pm/plans")), finding.details.join("\n"));
    assert.ok(!targetsOf(finding).includes("plans"), "a wrong-target link is not also called missing-target");
    assert.deepEqual(readdirSync(elsewhere), [], "audit writes nothing");
  }

  // 9. A real directory where a link belongs is still parked, not deleted (the .pre-singleton semantics are unchanged).
  {
    const f = fixture();
    unlinkSync(join(f.profile, "hooks"));
    mkdirSync(join(f.profile, "hooks"));
    writeFileSync(join(f.profile, "hooks", "mine.sh"), "echo precious\n");
    assert.match(f.audit().finding.details.join("\n"), /not-a-symlink: .*\/profiles\/demo-pm\/hooks/u);
    const { result } = f.remediate();
    assert.equal(result.status, "applied", result.details.join("\n"));
    assert.equal(readFileSync(join(f.profile, "hooks.pre-singleton", "mine.sh"), "utf8"), "echo precious\n");
    assert.ok(lstatSync(join(f.profile, "hooks")).isSymbolicLink());
    assert.ok(statSync(join(f.runtime, "hooks")).isDirectory());
    assert.equal(f.audit().finding.status, "pass");
  }

  // 10. Links that do not exist at all (a first hire) still get targets and links, in one pass.
  {
    const f = fixture({ links: false });
    const { result } = f.remediate();
    assert.equal(result.status, "applied", result.details.join("\n"));
    for (const dir of DIRS) assert.ok(statSync(join(f.profile, dir)).isDirectory(), `${dir} resolves through its link`);
    assert.equal(f.audit().finding.status, "pass");
  }

  // 11. The shape template step 20 depends on: after migrate the rule is clean, so
  //     `flume remediate` exits 0; if it were not, the exit code would be 1.
  {
    const f = fixture();
    chmodSync(join(f.runtime, "memories"), 0o755);
    const { status } = f.remediate();
    assert.equal(status, 0);
    assert.equal(f.audit().status, 0);
  }
} finally {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
}

console.log("runtime singleton target regressions passed");
