import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync(join(tmpdir(), "p14-provision-"));
const template = join(root, "templates/hermes-agent");
const gitlink = spawnSync("git", ["ls-tree", "HEAD", "templates/hermes-agent"], { cwd: root, encoding: "utf8" }).stdout.match(/160000 commit ([a-f0-9]{40})/)[1];
const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CEILING_DIRECTORIES: work,
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, HERMES_HOME: undefined, HERMES_AGENTS_REGISTRY: undefined, HERMES_FLEET_REGISTRY_FILE: undefined };
function execute(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...baseEnv, ...env }, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function git(repo, ...args) { return execute("git", args, repo).trim(); }
try {
  for (const mode of ["fresh", "existing-files", "existing-gitlink"]) {
    const repo = join(work, mode);
    const role = join(repo, "agents/hermes/dev");
    const home = join(work, `${mode}-home`);
    const runtime = join(role, "runtime");
    mkdirSync(role, { recursive: true });
    mkdirSync(home, { recursive: true });
    git(repo, "init", "-q", "--template=");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "fixture@example.invalid");
    cpSync(join(template, "template/.scripts"), join(role, ".scripts"), { recursive: true });
    cpSync(join(template, "template/.runtime-scaffold"), join(role, ".runtime-scaffold"), { recursive: true });
    const runtimeScript = execute("git", ["show", `${gitlink}:template/.scripts/20-runtime-repo.sh`], template);
    assert.equal(readFileSync(join(role, ".scripts/20-runtime-repo.sh"), "utf8"), runtimeScript, "run the committed provisioner, not dirty template code");
    writeFileSync(join(role, "role.yaml"), `repo: fixture\nrole: dev\nagent_id: ${mode}\nprofile: ${mode}\ndisplay_name: Fixture\n`);
    writeFileSync(join(role, "SOUL.md"), "tracked scaffold identity\n");
    writeFileSync(join(role, ".gitignore"), ".scripts/.done-*\n.scripts/.provision.log\n");
    writeFileSync(join(repo, ".gitmodules"), `[submodule "unrelated"]\n path = vendor/keep\n url = https://example.invalid/keep.git\n` +
      (mode === "fresh" ? "" : `[submodule "stale-runtime"]\n path = agents/hermes/dev/runtime\n url = https://example.invalid/runtime.git\n`));
    if (mode !== "fresh") {
      mkdirSync(join(runtime, "memories"), { recursive: true });
      writeFileSync(join(runtime, "memories/MEMORY.md"), "precious existing memory\n");
    }
    git(repo, "add", "--", "agents", ".gitmodules");
    git(repo, "commit", "-qm", "fixture scaffold");
    const commit = git(repo, "rev-parse", "HEAD");
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${commit},vendor/keep`);
    if (mode === "existing-gitlink") {
      git(repo, "rm", "-rq", "--cached", "--", "agents/hermes/dev/runtime");
      git(repo, "update-index", "--add", "--cacheinfo", `160000,${commit},agents/hermes/dev/runtime`);
    }
    const env = { HOME: home, HERMES_FLEET_HOME: join(home, ".hermes"), XDG_CONFIG_HOME: join(home, ".config") };
    for (let repeat = 0; repeat < 2; repeat++) execute(process.execPath, [cli, "remediate", "hermes.untracked-runtimes", repo, "--json"], repo, env);
    assert.equal(git(repo, "ls-files", "--", "agents/hermes/dev/runtime"), "");
    assert.match(readFileSync(join(repo, ".gitmodules"), "utf8"), /vendor\/keep/);
    assert.doesNotMatch(readFileSync(join(repo, ".gitmodules"), "utf8"), /stale-runtime/);
    assert.match(git(repo, "ls-files", "--stage", "--", "vendor/keep"), /^160000 /);
    assert.equal(git(repo, "ls-files", "--", "agents/hermes/dev/SOUL.md"), "agents/hermes/dev/SOUL.md");

    // The template's Flume topology dependency is a fixture adapter, never a live CLI write.
    const fakeFlume = join(home, "fixture-flume");
    writeFileSync(fakeFlume, `#!${process.execPath}\nimport('node:fs').then(fs => {
if (process.argv.includes('--dry-run')) process.exit(0);
const role=${JSON.stringify(role)}, profile=${JSON.stringify(join(home, ".hermes/profiles", mode))};
fs.mkdirSync(profile,{recursive:true});
for(const name of ['sessions','memories','workspace','plans','hooks','pairing','cron']) {
 fs.mkdirSync(role+'/runtime/'+name,{recursive:true});
 if(!fs.existsSync(profile+'/'+name)) fs.symlinkSync(role+'/runtime/'+name,profile+'/'+name);
}
});\n`);
    chmodSync(fakeFlume, 0o700);
    const before = git(repo, "rev-parse", "HEAD");
    for (let repeat = 0; repeat < 2; repeat++) execute("bash", [join(role, ".scripts/20-runtime-repo.sh")], repo,
      { ...env, FLUME_BIN: fakeFlume, HERMES_TEMPLATE_CONFIG: join(home, "absent.toml") });
    assert.equal(git(repo, "rev-parse", "HEAD"), before, "provisioner made no Git checkpoint commit");
    assert.equal(existsSync(join(runtime, ".git")), false, "fresh/migrated state is not initialized as a repo");
    assert.equal(existsSync(join(role, ".scripts/checkpoint.sh")), false, "pinned scaffold has no runtime Git checkpoint hook");
    assert.equal(git(repo, "check-ignore", "--", "agents/hermes/dev/runtime/memories/MEMORY.md"), "agents/hermes/dev/runtime/memories/MEMORY.md");
    if (mode !== "fresh") assert.equal(readFileSync(join(runtime, "memories/MEMORY.md"), "utf8"), "precious existing memory\n");
    const registry = join(home, ".hermes/agents-registry.yaml");
    writeFileSync(registry, JSON.stringify({ agents: { [mode]: { profile_name: mode, role_dir: role } } }));
    const backupArgs = [join(root, "scripts/hermes-runtime-backup.py"), "--fleet-home", join(home, ".hermes"), "--registry", registry,
      "--dest", join(home, "archives"), "inventory"];
    const first = JSON.parse(execute("python3", backupArgs, repo, env));
    const second = JSON.parse(execute("python3", backupArgs, repo, env));
    assert.deepEqual(first, second, "repeated setup has exactly one deterministic inclusion");
    assert.equal(first.employees.length, 1);
    assert.equal(first.employees[0].sources.length, 2);
    assert.equal(first.policy.engine, "forever-ago --once");
    console.log(`PASS ${mode}: real untracking + pinned runtime provisioner repeated; scaffold/submodule preserved; one backup inclusion, no checkpoint/clock`);
  }
  console.log("PJAN-14 provisioning regressions: 3 passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
