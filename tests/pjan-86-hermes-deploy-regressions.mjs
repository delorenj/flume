import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const temp = mkdtempSync(join(tmpdir(), "pjan-86-hermes-deploy-"));

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

/**
 * Git answers about a scratch tree must come from a repo this suite owns.
 *
 * Repository discovery is ambient: with no ceiling, `git ls-files` run inside
 * a scratch tree walks up until it finds any `.git`, so whatever checkout
 * happens to contain TMPDIR silently answers for the fixture. That is exactly
 * how this suite became host-coupled -- on the developer box TMPDIR sits under
 * ~/.claude, itself a checkout, so UntrackHermesRuntimes' `git ls-files`
 * succeeded (empty, "not tracked") and the deploy chain went green. On a clean
 * runner with TMPDIR=/tmp there is no ancestor repo, the same call exits
 * non-zero, and the command fails closed with "Failed to inspect runtime index
 * ... fatal: not a git repository", taking `hermes-agent --dry-run` down with
 * it. Ceiling discovery at the scratch root so no ancestor can ever stand in,
 * and drop host git config so identity, hooksPath, and templateDir cannot
 * change the answer either.
 */
const gitIsolation = {
  GIT_CEILING_DIRECTORIES: realpathSync(temp),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

/**
 * Build a scratch project repo the way pjangler builds a real one.
 *
 * `pj` runs inside a Git project -- ProjectRecipe bootstraps every project
 * with `git init --initial-branch=main` -- and hermes steps shell out to Git
 * against the target dir. With discovery ceilinged above, supplying that repo
 * is the fixture's job, so each scratch tree gets its own empty one and every
 * host reaches the same verdict for the same reason.
 */
function makeRepo(path) {
  mkdirSync(path, { recursive: true });
  const init = spawnSync("git", ["init", "--quiet", "--initial-branch=main", "--template=", path], {
    encoding: "utf8",
    env: { ...process.env, ...gitIsolation },
  });
  assert.equal(init.status, 0, `scratch repo init failed for ${path}: ${init.stderr}`);
  return path;
}

/**
 * Read one file from the template commit the parent HEAD actually records.
 *
 * `git ls-tree HEAD` plus `git show <gitlink>:path` is what makes an advanced
 * or dirty templates/hermes-agent worktree structurally unreachable here -- the
 * bytes come from the Git object, never the checkout. This used to also assert
 * the gitlink equalled a hardcoded hash. That pin went ten commits stale and
 * then stale again the same day, turning every legitimate template advance into
 * a red suite while proving nothing the object lookup does not already prove.
 * The contract assertions on the returned content are the real gate: they hold
 * for whichever commit is pinned, and fail when the template stops behaving.
 */
function committedHermesTemplate(path) {
  const tree = spawnSync("git", ["ls-tree", "HEAD", "templates/hermes-agent"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(tree.status, 0, tree.stderr);
  const match = tree.stdout.match(/^160000 commit ([0-9a-f]{40})\ttemplates\/hermes-agent\s*$/);
  assert.ok(match, `HEAD must commit an exact Hermes template gitlink, got: ${tree.stdout}`);
  const gitlink = match[1];
  const show = spawnSync("git", ["-C", join(root, "templates", "hermes-agent"), "show", `${gitlink}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(show.status, 0, `committed Hermes gitlink ${gitlink} cannot provide ${path}: ${show.stderr}`);
  return { gitlink, content: show.stdout };
}

let openSocketServer;
try {
  const fakeBin = join(temp, "bin");
  const copierSentinel = join(temp, "copier-ran");
  mkdirSync(fakeBin, { recursive: true });
  const fakeCopier = join(fakeBin, "copier");
  writeFileSync(fakeCopier, `#!/usr/bin/env sh\n: > "${copierSentinel}"\nexit 91\n`);
  chmodSync(fakeCopier, 0o755);
  const commandEnv = {
    HOME: join(temp, "home"),
    XDG_CONFIG_HOME: join(temp, "xdg"),
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    COLUMNS: "0",
    PJANGLER_HERMES_TEMPLATE: "",
    ...gitIsolation,
  };

  // Command-level dry-run: a zero-width terminal must still get readable,
  // mode-aware output and absolutely no repo/host mutation.
  const previewRepo = makeRepo(join(temp, "preview-repo"));
  const preview = run(["hire", "--yes", "--dry-run"], previewRepo, commandEnv);
  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  const previewOutput = `${preview.stdout}\n${preview.stderr}`;
  assert.match(previewOutput, /Hermes deployment plan \(no changes applied\)/);
  assert.match(previewOutput, /runtime: local role runtime/);
  assert.match(previewOutput, /dry-run made no repository or host changes/);
  assert.doesNotMatch(previewOutput, /Provisioned|\bDone\.|runtime:\s*gh:/);
  assert.equal(existsSync(join(previewRepo, "agents")), false, "dry-run must not render a role");
  assert.equal(existsSync(join(temp, "xdg", "hermes-agent-template", "config.toml")), false, "dry-run must not create host config");
  assert.equal(existsSync(copierSentinel), false, "dry-run must not execute Copier");

  const hermesHelp = run(["hire", "--help"], previewRepo, commandEnv);
  assert.equal(hermesHelp.status, 0, hermesHelp.stderr);
  assert.doesNotMatch(hermesHelp.stdout, /create.*runtime.*(?:GitHub|GH)|runtime.*repo.*creation/i);

  // --email has no pinned template interface and must fail before even config
  // bootstrap or Copier discovery/execution.
  const emailRepo = makeRepo(join(temp, "email-repo"));
  const emailConfig = join(temp, "email-xdg");
  const email = run(["hire", "--yes", "--email"], emailRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: emailConfig,
  });
  assert.notEqual(email.status, 0);
  assert.match(`${email.stdout}\n${email.stderr}`, /pinned Hermes template has no supported email provisioner/);
  assert.equal(existsSync(join(emailRepo, "agents")), false, "unsupported email must fail before repo mutation");
  assert.equal(existsSync(emailConfig), false, "unsupported email must fail before host config mutation");
  assert.equal(existsSync(copierSentinel), false, "unsupported email must fail before Copier");

  // Any meaningful partial render is existing user state. --yes must refuse it
  // before config bootstrap or Copier, even when role.yaml does not exist yet.
  const partialRepo = makeRepo(join(temp, "partial-repo"));
  const partialRoleDir = join(partialRepo, "agents", "hermes", "pm");
  const partialSoul = join(partialRoleDir, "SOUL.md");
  mkdirSync(partialRoleDir, { recursive: true });
  writeFileSync(partialSoul, "precious partial soul\n");
  const partialConfig = join(temp, "partial-xdg");
  const partial = run(["hire", "--yes"], partialRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: partialConfig,
  });
  assert.notEqual(partial.status, 0);
  assert.match(`${partial.stdout}\n${partial.stderr}`, /target directory is not empty.*SOUL\.md.*--force/s);
  assert.equal(readFileSync(partialSoul, "utf8"), "precious partial soul\n");
  assert.equal(existsSync(partialConfig), false, "partial-role refusal must precede host config mutation");
  assert.equal(existsSync(copierSentinel), false, "partial-role refusal must precede Copier");

  // Empty directory structure and inert placeholder/OS metadata are the only
  // harmless existing entries. Ignored runtime state remains a blocker.
  const placeholderRepo = makeRepo(join(temp, "placeholder-repo"));
  const placeholderRole = join(placeholderRepo, "agents", "hermes", "pm");
  mkdirSync(join(placeholderRole, "empty-child"), { recursive: true });
  writeFileSync(join(placeholderRole, ".gitkeep"), "");
  writeFileSync(join(placeholderRole, ".DS_Store"), "metadata");
  const placeholder = run(["hire", "--yes", "--dry-run"], placeholderRepo, commandEnv);
  assert.equal(placeholder.status, 0, `${placeholder.stdout}\n${placeholder.stderr}`);

  // A placeholder name never makes a symlink harmless. Reject both dangling
  // and live links before even host-config bootstrap or Copier execution.
  for (const [label, placeholderName, target] of [
    ["dangling", ".gitkeep", "missing-placeholder-target"],
    ["live", ".DS_Store", join(temp, "live-placeholder-target")],
  ]) {
    const symlinkRepo = makeRepo(join(temp, `${label}-placeholder-symlink-repo`));
    const symlinkRole = join(symlinkRepo, "agents", "hermes", "pm");
    const symlinkPath = join(symlinkRole, placeholderName);
    const symlinkConfig = join(temp, `${label}-placeholder-symlink-xdg`);
    mkdirSync(symlinkRole, { recursive: true });
    if (label === "live") writeFileSync(target, "outside role\n");
    symlinkSync(target, symlinkPath);
    const blocked = run(["hire", "--yes"], symlinkRepo, {
      ...commandEnv,
      XDG_CONFIG_HOME: symlinkConfig,
    });
    assert.notEqual(blocked.status, 0, `${label} placeholder symlink must be rejected`);
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, new RegExp(placeholderName.replace(".", "\\.")));
    assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(symlinkPath), target);
    assert.equal(existsSync(symlinkConfig), false, `${label} placeholder symlink refusal must precede config mutation`);
    assert.equal(existsSync(copierSentinel), false, `${label} placeholder symlink refusal must precede Copier`);
  }

  // Placeholder names are harmless only for single-link regular files. A
  // FIFO, Unix socket, device node (where the host permits one), or hardlink
  // must be rejected without opening the entry or starting any later phase.
  const specialPlaceholders = [];

  const fifoRepo = makeRepo(join(temp, "fifo-placeholder-repo"));
  const fifoRole = join(fifoRepo, "agents", "hermes", "pm");
  const fifoPath = join(fifoRole, ".gitkeep");
  mkdirSync(fifoRole, { recursive: true });
  const madeFifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  assert.equal(madeFifo.status, 0, madeFifo.stderr);
  specialPlaceholders.push(["FIFO", fifoRepo, fifoPath, (stats) => stats.isFIFO()]);

  const socketRepo = makeRepo(join(temp, "socket-placeholder-repo"));
  const socketRole = join(socketRepo, "agents", "hermes", "pm");
  const socketPath = join(socketRole, ".DS_Store");
  mkdirSync(socketRole, { recursive: true });
  const socketServer = createServer();
  openSocketServer = socketServer;
  await new Promise((resolveListen, rejectListen) => {
    socketServer.once("error", rejectListen);
    socketServer.listen(socketPath, resolveListen);
  });
  specialPlaceholders.push(["socket", socketRepo, socketPath, (stats) => stats.isSocket()]);

  const hardlinkRepo = makeRepo(join(temp, "hardlink-placeholder-repo"));
  const hardlinkRole = join(hardlinkRepo, "agents", "hermes", "pm");
  const hardlinkSource = join(temp, "hardlink-placeholder-source");
  const hardlinkPath = join(hardlinkRole, "Thumbs.db");
  mkdirSync(hardlinkRole, { recursive: true });
  writeFileSync(hardlinkSource, "operator-owned hardlink bytes\n");
  linkSync(hardlinkSource, hardlinkPath);
  specialPlaceholders.push(["hardlink", hardlinkRepo, hardlinkPath, (stats) => stats.isFile() && stats.nlink > 1]);

  // Device nodes require CAP_MKNOD and are unavailable in ordinary CI/user
  // namespaces. Exercise one when permitted; the source-level isFile tripwire
  // below deterministically covers the same classifier everywhere else.
  const deviceRepo = makeRepo(join(temp, "device-placeholder-repo"));
  const deviceRole = join(deviceRepo, "agents", "hermes", "pm");
  const devicePath = join(deviceRole, ".gitkeep");
  mkdirSync(deviceRole, { recursive: true });
  const madeDevice = spawnSync("mknod", [devicePath, "c", "1", "3"], { encoding: "utf8" });
  if (madeDevice.status === 0) {
    specialPlaceholders.push(["device", deviceRepo, devicePath, (stats) => stats.isCharacterDevice()]);
  }

  for (const [label, repo, path, expectedType] of specialPlaceholders) {
    const before = lstatSync(path);
    assert.equal(expectedType(before), true, `${label} fixture must have the intended file type`);
    const specialConfig = join(temp, `${label}-placeholder-xdg`);
    const blocked = run(["hire", "--yes"], repo, {
      ...commandEnv,
      XDG_CONFIG_HOME: specialConfig,
    });
    assert.notEqual(blocked.status, 0, `${label} placeholder must be rejected`);
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, /\.gitkeep|\.DS_Store|Thumbs\.db/);
    const after = lstatSync(path);
    assert.equal(expectedType(after), true, `${label} placeholder type must remain unchanged`);
    assert.equal(after.ino, before.ino, `${label} placeholder inode must remain unchanged`);
    assert.equal(after.nlink, before.nlink, `${label} placeholder link count must remain unchanged`);
    assert.equal(existsSync(specialConfig), false, `${label} refusal must precede config mutation`);
    assert.equal(existsSync(copierSentinel), false, `${label} refusal must precede Copier`);
  }
  await new Promise((resolveClose, rejectClose) => {
    socketServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
  openSocketServer = undefined;
  assert.equal(readFileSync(hardlinkSource, "utf8"), "operator-owned hardlink bytes\n");

  const runtimeRepo = makeRepo(join(temp, "runtime-only-repo"));
  const runtimeState = join(runtimeRepo, "agents", "hermes", "pm", "runtime", "checkpoint.json");
  mkdirSync(join(runtimeRepo, "agents", "hermes", "pm", "runtime"), { recursive: true });
  writeFileSync(runtimeState, "{}\n");
  const runtimeOnly = run(["hire", "--yes", "--dry-run"], runtimeRepo, commandEnv);
  assert.notEqual(runtimeOnly.status, 0);
  assert.match(`${runtimeOnly.stdout}\n${runtimeOnly.stderr}`, /runtime\/checkpoint\.json/);

  // --yes means defaults, not implicit destructive overwrite consent.
  const existingRepo = makeRepo(join(temp, "existing-repo"));
  const existingRole = join(existingRepo, "agents", "hermes", "pm", "role.yaml");
  mkdirSync(join(existingRepo, "agents", "hermes", "pm"), { recursive: true });
  const preciousRole = "repo: existing-repo\nrole: pm\nagent_id: existing-repo-pm\n# precious\n";
  writeFileSync(existingRole, preciousRole);
  const existingConfig = join(temp, "existing-xdg");
  const overwrite = run(["hire", "--yes"], existingRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: existingConfig,
  });
  assert.notEqual(overwrite.status, 0);
  assert.match(`${overwrite.stdout}\n${overwrite.stderr}`, /non-interactive mode will not render into it.*--force/s);
  assert.equal(readFileSync(existingRole, "utf8"), preciousRole);
  assert.equal(existsSync(existingConfig), false, "overwrite refusal must precede host config mutation");
  assert.equal(existsSync(copierSentinel), false, "overwrite refusal must precede Copier");

  // Standalone bootstrap reports successful plans and changes to process
  // callers; silence here previously made a real write look like a no-op.
  const bootstrapRepo = makeRepo(join(temp, "bootstrap-repo"));
  const bootstrapHome = join(temp, "bootstrap-xdg");
  const bootstrapPath = join(bootstrapHome, "hermes-agent-template", "config.toml");
  const bootstrapPlan = run(["handbook", "bootstrap", "--dry-run"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: bootstrapHome,
  });
  assert.equal(bootstrapPlan.status, 0, bootstrapPlan.stderr);
  assert.match(bootstrapPlan.stdout, /\[DRY RUN\] Would create config:/);
  assert.equal(existsSync(bootstrapPath), false);
  const bootstrap = run(["handbook", "bootstrap"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: bootstrapHome,
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.match(bootstrap.stdout, /Bootstrapped config without replacing existing values:/);
  assert.equal(existsSync(bootstrapPath), true);

  // The config leaf is lstat'd before any force/exists/read branch. Live and
  // dangling symlinks plus every tested special-file form fail unchanged; in
  // particular, a FIFO must never be opened and hang the command.
  for (const [label, target, targetExists] of [
    ["live-config-symlink", join(temp, "live-config-target.toml"), true],
    ["dangling-config-symlink", join(temp, "missing-config-target.toml"), false],
  ]) {
    const unsafeHome = join(temp, `${label}-xdg`);
    const unsafePath = join(unsafeHome, "hermes-agent-template", "config.toml");
    mkdirSync(join(unsafeHome, "hermes-agent-template"), { recursive: true });
    if (targetExists) writeFileSync(target, "[fleet]\noperator = true\n");
    symlinkSync(target, unsafePath);
    const beforeTarget = targetExists ? readFileSync(target) : undefined;
    const rejected = run(["handbook", "bootstrap"], bootstrapRepo, {
      ...commandEnv,
      XDG_CONFIG_HOME: unsafeHome,
    });
    assert.notEqual(rejected.status, 0, `${label} must fail closed`);
    assert.match(rejected.stderr, /expected a regular file, found symbolic link/);
    assert.equal(lstatSync(unsafePath).isSymbolicLink(), true);
    assert.equal(readlinkSync(unsafePath), target);
    if (targetExists) assert.equal(readFileSync(target).equals(beforeTarget), true);
    else assert.equal(existsSync(target), false);
  }

  const directoryConfigHome = join(temp, "directory-config-xdg");
  const directoryConfigPath = join(directoryConfigHome, "hermes-agent-template", "config.toml");
  mkdirSync(directoryConfigPath, { recursive: true });
  writeFileSync(join(directoryConfigPath, "operator-sentinel"), "keep\n");
  const directoryConfig = run(["handbook", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: directoryConfigHome,
  });
  assert.notEqual(directoryConfig.status, 0);
  assert.match(directoryConfig.stderr, /expected a regular file, found directory/);
  assert.equal(readFileSync(join(directoryConfigPath, "operator-sentinel"), "utf8"), "keep\n");

  const fifoConfigHome = join(temp, "fifo-config-xdg");
  const fifoConfigPath = join(fifoConfigHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(fifoConfigHome, "hermes-agent-template"), { recursive: true });
  const madeConfigFifo = spawnSync("mkfifo", [fifoConfigPath], { encoding: "utf8" });
  assert.equal(madeConfigFifo.status, 0, madeConfigFifo.stderr);
  const fifoConfig = run(["handbook", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: fifoConfigHome,
  });
  assert.notEqual(fifoConfig.status, 0);
  assert.notEqual(fifoConfig.error?.code, "ETIMEDOUT", "config FIFO refusal must not hang on a read");
  assert.match(fifoConfig.stderr, /expected a regular file, found FIFO/);
  assert.equal(lstatSync(fifoConfigPath).isFIFO(), true);

  const socketConfigHome = join(temp, "socket-config-xdg");
  const socketConfigPath = join(socketConfigHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(socketConfigHome, "hermes-agent-template"), { recursive: true });
  const configSocketServer = createServer();
  openSocketServer = configSocketServer;
  await new Promise((resolveListen, rejectListen) => {
    configSocketServer.once("error", rejectListen);
    configSocketServer.listen(socketConfigPath, resolveListen);
  });
  const socketConfig = run(["handbook", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: socketConfigHome,
  });
  assert.notEqual(socketConfig.status, 0);
  assert.match(socketConfig.stderr, /expected a regular file, found socket/);
  assert.equal(lstatSync(socketConfigPath).isSocket(), true);
  await new Promise((resolveClose, rejectClose) => {
    configSocketServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
  openSocketServer = undefined;

  // Validation must exactly match the deployed Python tomllib consumer and
  // operate on bytes, not Node's replacement-character UTF-8 decoding.
  const invalidTomlCases = [
    [
      "toml-11-escape",
      Buffer.concat([Buffer.from("[fleet]\nvalue = \"", "utf8"), Buffer.from([0x5c, 0x65]), Buffer.from("\"\n", "utf8")]),
      /TOMLDecodeError/,
    ],
    ["invalid-calendar-date", Buffer.from("[fleet]\nvalue = 2023-02-30\n", "utf8"), /TOMLDecodeError|day is out of range/],
    [
      "invalid-utf8",
      Buffer.concat([Buffer.from("[fleet]\nvalue = \"", "utf8"), Buffer.from([0xc3, 0x28]), Buffer.from("\"\n", "utf8")]),
      /UnicodeDecodeError/,
    ],
  ];
  for (const [label, source, expectedError] of invalidTomlCases) {
    const invalidHome = join(temp, `${label}-xdg`);
    const invalidPath = join(invalidHome, "hermes-agent-template", "config.toml");
    mkdirSync(join(invalidHome, "hermes-agent-template"), { recursive: true });
    writeFileSync(invalidPath, source);
    const before = statSync(invalidPath);
    const invalid = run(["handbook", "bootstrap", "--force"], bootstrapRepo, {
      ...commandEnv,
      XDG_CONFIG_HOME: invalidHome,
    });
    assert.notEqual(invalid.status, 0, `${label} must fail tomllib validation`);
    assert.match(invalid.stderr, /not valid TOML 1\.0 for Python tomllib/);
    assert.match(invalid.stderr, expectedError);
    assert.doesNotMatch(invalid.stdout, /Updated|Bootstrapped/);
    assert.equal(readFileSync(invalidPath).equals(source), true, `${label} must preserve exact bytes`);
    const after = statSync(invalidPath);
    assert.equal(after.ino, before.ino, `${label} must not replace the file`);
    assert.equal(after.mtimeMs, before.mtimeMs, `${label} must not write the file`);
  }

  const noPythonHome = join(temp, "no-python-xdg");
  const noPythonPath = join(noPythonHome, "hermes-agent-template", "config.toml");
  const noPythonSource = Buffer.from("[fleet]\nhermes_bin = \"/operator/hermes\"\n", "utf8");
  mkdirSync(join(noPythonHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(noPythonPath, noPythonSource);
  const noPythonBefore = statSync(noPythonPath);
  const noPython = run(["handbook", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: fakeBin,
    XDG_CONFIG_HOME: noPythonHome,
  });
  assert.notEqual(noPython.status, 0);
  assert.match(noPython.stderr, /python3 with tomllib is required but was not found/);
  assert.equal(readFileSync(noPythonPath).equals(noPythonSource), true);
  assert.equal(statSync(noPythonPath).ino, noPythonBefore.ino);

  // Python validation is an isolated stdlib boundary. Neither a cwd-local
  // tomllib.py nor one injected through PYTHONPATH may execute, and no
  // PYTHON* environment entry may reach even the selected python3 executable.
  const systemPython = spawnSync("which", ["python3"], { encoding: "utf8" });
  assert.equal(systemPython.status, 0, systemPython.stderr);
  const isolatedPythonBin = join(temp, "isolated-python-bin");
  const localImportSentinel = join(temp, "local-tomllib-imported");
  const pathImportSentinel = join(temp, "pythonpath-tomllib-imported");
  const environmentLeakSentinel = join(temp, "python-environment-leaked");
  const flagLeakSentinel = join(temp, "python-isolation-flags-missing");
  mkdirSync(isolatedPythonBin, { recursive: true });
  const isolatedPythonWrapper = join(isolatedPythonBin, "python3");
  writeFileSync(isolatedPythonWrapper, `#!/bin/sh
if /usr/bin/env | /usr/bin/grep -q '^PYTHON'; then
  : > "$VALIDATOR_ENV_LEAK_SENTINEL"
fi
if [ "$1" != "-I" ] || [ "$2" != "-S" ] || [ "$3" != "-c" ]; then
  : > "$VALIDATOR_FLAG_LEAK_SENTINEL"
fi
exec "${systemPython.stdout.trim()}" "$@"
`);
  chmodSync(isolatedPythonWrapper, 0o755);
  writeFileSync(join(bootstrapRepo, "tomllib.py"), `
import os
open(os.environ["LOCAL_TOMLLIB_SENTINEL"], "w", encoding="utf-8").write("imported\\n")
class TOMLDecodeError(Exception):
    pass
def loads(_source):
    return {}
`);
  const poisonedPythonPath = join(temp, "poisoned-pythonpath");
  mkdirSync(poisonedPythonPath, { recursive: true });
  writeFileSync(join(poisonedPythonPath, "tomllib.py"), `
import os
open(os.environ["PATH_TOMLLIB_SENTINEL"], "w", encoding="utf-8").write("imported\\n")
class TOMLDecodeError(Exception):
    pass
def loads(_source):
    return {}
`);
  const isolatedHome = join(temp, "isolated-validator-xdg");
  const isolatedPath = join(isolatedHome, "hermes-agent-template", "config.toml");
  const isolatedInvalidSource = Buffer.concat([
    Buffer.from("[fleet]\nvalue = \"", "utf8"),
    Buffer.from([0x5c, 0x65]),
    Buffer.from("\"\n", "utf8"),
  ]);
  mkdirSync(join(isolatedHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(isolatedPath, isolatedInvalidSource);
  const isolatedBefore = statSync(isolatedPath);
  const isolatedValidation = run(["handbook", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: `${isolatedPythonBin}${delimiter}${commandEnv.PATH}`,
    PYTHONHOME: join(temp, "hostile-python-home"),
    PYTHONPATH: poisonedPythonPath,
    PYTHONSTARTUP: join(temp, "hostile-python-startup.py"),
    PYTHONWARNINGS: "error",
    LOCAL_TOMLLIB_SENTINEL: localImportSentinel,
    PATH_TOMLLIB_SENTINEL: pathImportSentinel,
    VALIDATOR_ENV_LEAK_SENTINEL: environmentLeakSentinel,
    VALIDATOR_FLAG_LEAK_SENTINEL: flagLeakSentinel,
    XDG_CONFIG_HOME: isolatedHome,
  });
  assert.notEqual(isolatedValidation.status, 0);
  assert.match(isolatedValidation.stderr, /not valid TOML 1\.0 for Python tomllib.*TOMLDecodeError/s);
  assert.doesNotMatch(isolatedValidation.stdout, /Updated|Bootstrapped/);
  assert.equal(existsSync(localImportSentinel), false, "cwd-local tomllib must not execute");
  assert.equal(existsSync(pathImportSentinel), false, "PYTHONPATH tomllib must not execute while the local poison is present");
  assert.equal(existsSync(environmentLeakSentinel), false, "PYTHON* entries must be removed from the validator child env");
  assert.equal(existsSync(flagLeakSentinel), false, "validator must invoke python3 with -I -S before -c");
  assert.equal(readFileSync(isolatedPath).equals(isolatedInvalidSource), true);
  const isolatedAfter = statSync(isolatedPath);
  assert.equal(isolatedAfter.ino, isolatedBefore.ino);
  assert.equal(isolatedAfter.mtimeMs, isolatedBefore.mtimeMs);

  // Repeat from a cwd without the local module so the PYTHONPATH poison is an
  // independently reachable import candidate under a non-isolated invocation.
  const pathPoisonRepo = makeRepo(join(temp, "pythonpath-poison-repo"));
  const pathPoisonHome = join(temp, "pythonpath-validator-xdg");
  const pathPoisonConfig = join(pathPoisonHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(pathPoisonHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(pathPoisonConfig, isolatedInvalidSource);
  const pathPoisonBefore = statSync(pathPoisonConfig);
  const pathPoisonValidation = run(["handbook", "bootstrap", "--force"], pathPoisonRepo, {
    ...commandEnv,
    PATH: `${isolatedPythonBin}${delimiter}${commandEnv.PATH}`,
    PYTHONPATH: poisonedPythonPath,
    PATH_TOMLLIB_SENTINEL: pathImportSentinel,
    VALIDATOR_ENV_LEAK_SENTINEL: environmentLeakSentinel,
    VALIDATOR_FLAG_LEAK_SENTINEL: flagLeakSentinel,
    XDG_CONFIG_HOME: pathPoisonHome,
  });
  assert.notEqual(pathPoisonValidation.status, 0);
  assert.match(pathPoisonValidation.stderr, /not valid TOML 1\.0 for Python tomllib.*TOMLDecodeError/s);
  assert.equal(existsSync(pathImportSentinel), false, "PYTHONPATH tomllib must not execute without a local poison module");
  assert.equal(existsSync(environmentLeakSentinel), false);
  assert.equal(existsSync(flagLeakSentinel), false);
  assert.equal(readFileSync(pathPoisonConfig).equals(isolatedInvalidSource), true);
  const pathPoisonAfter = statSync(pathPoisonConfig);
  assert.equal(pathPoisonAfter.ino, pathPoisonBefore.ino);
  assert.equal(pathPoisonAfter.mtimeMs, pathPoisonBefore.mtimeMs);

  // A stuck interpreter is bounded and reported as a validator timeout without
  // touching the operator's exact bytes or file identity.
  const timeoutPythonBin = join(temp, "timeout-python-bin");
  const timeoutPython = join(timeoutPythonBin, "python3");
  mkdirSync(timeoutPythonBin, { recursive: true });
  writeFileSync(timeoutPython, "#!/bin/sh\nexec /bin/sleep 30\n");
  chmodSync(timeoutPython, 0o755);
  const timeoutHome = join(temp, "timeout-validator-xdg");
  const timeoutPath = join(timeoutHome, "hermes-agent-template", "config.toml");
  const timeoutSource = Buffer.from("[fleet]\nhermes_bin = \"/operator/hermes\"\n", "utf8");
  mkdirSync(join(timeoutHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(timeoutPath, timeoutSource);
  const timeoutBefore = statSync(timeoutPath);
  const timedOut = run(["handbook", "bootstrap", "--force"], bootstrapRepo, {
    ...commandEnv,
    PATH: timeoutPythonBin,
    XDG_CONFIG_HOME: timeoutHome,
  });
  assert.notEqual(timedOut.status, 0);
  assert.notEqual(timedOut.error?.code, "ETIMEDOUT", "CLI must report its validator timeout before the outer process timeout");
  assert.match(timedOut.stderr, /no changes were applied: Existing Hermes template config validation timed out after 5000ms/);
  assert.doesNotMatch(timedOut.stdout, /Updated|Bootstrapped/);
  assert.equal(readFileSync(timeoutPath).equals(timeoutSource), true);
  const timeoutAfter = statSync(timeoutPath);
  assert.equal(timeoutAfter.ino, timeoutBefore.ino);
  assert.equal(timeoutAfter.mtimeMs, timeoutBefore.mtimeMs);

  // REMOVED: the config-install transaction suite (post-install rollback,
  // hardlink/alias refusal, RENAME_EXCHANGE races, CAS conflict phases, and
  // crash recovery from a .pjangler-config-txn-* marker).
  //
  // EnsureTemplateConfig no longer has any of that. It writes through a
  // same-directory temp file and one rename(2), which is atomic within a
  // directory, and that is the entire durability requirement: the command runs
  // once per `flume hire` / `flume handbook bootstrap`, sequentially, in a
  // single process. The 1,500 lines of lock/CAS/crash-recovery machinery these
  // ~615 lines exercised were deleted for inventing a concurrent writer that
  // does not exist, and could wedge the command behind a leftover transaction
  // directory. See the installConfig docblock, which says not to bring it back
  // without a failing test that demonstrates a real race first -- so if one
  // ever appears, that test belongs here, written against the race, not
  // restored from this history.

  // Forced config bootstrap is an additive schema upgrade. Operator values,
  // comments, unknown keys, and richer sections survive byte-for-byte.
  const configRepo = makeRepo(join(temp, "config-repo"));
  const configHome = join(temp, "config-xdg");
  const configPath = join(configHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(configHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(configPath, `# precious operator comment\n[fleet]\nhermes_bin = "/operator/hermes"\ncustom_key = "keep"\n\n[operator]\nmode = "richer"\n`);
  const config = run(["handbook", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: configHome,
  });
  assert.equal(config.status, 0, `${config.stdout}\n${config.stderr}`);
  assert.match(config.stdout, /Updated config without replacing existing values:/);
  assert.deepEqual(
    readdirSync(join(configHome, "hermes-agent-template")).filter((name) => name.startsWith(".pjangler-config-txn-")),
    [],
    "successful installation must remove every ephemeral transaction artifact",
  );
  const upgraded = readFileSync(configPath, "utf8");
  assert.match(upgraded, /# precious operator comment/);
  assert.match(upgraded, /hermes_bin = "\/operator\/hermes"/);
  assert.equal((upgraded.match(/^hermes_bin\s*=/gm) ?? []).length, 1, "existing schema values must not be duplicated");
  assert.match(upgraded, /custom_key = "keep"/);
  assert.match(upgraded, /\[operator\]\nmode = "richer"/);
  for (const key of ["flume_bin", "pjangler_bin", "hermes_git_url", "hermes_git_ref", "hermes_git_sha", "oauth_file", "codex_home", "vox_plugin_name", "vox_plugin_dir", "vox_voice", "vox_url", "onepassword_vault", "onepassword_item_prefix"]) {
    assert.match(upgraded, new RegExp(`^${key}\\s*=`, "m"), `config upgrade should add ${key}`);
  }

  // REMOVED: the whole-window config lock suite (a second writer blocked until
  // the first released a kernel lock, plus split-domain lock acquisition).
  //
  // Deleted with the same transaction machinery above. `flume handbook bootstrap`
  // has no concurrent writer to serialize against, so there is no lock to hold
  // and nothing for a second process to block on.

  const committedTemplate = committedHermesTemplate("template/.scripts/config.example.toml");
  assert.match(committedTemplate.gitlink, /^[0-9a-f]{40}$/);
  const templateConfig = committedTemplate.content;
  for (const [, key] of templateConfig.matchAll(/^([a-z][a-z0-9_]*)\s*=/gm)) {
    assert.match(upgraded, new RegExp(`^${key}\\s*=`, "m"), `parent bootstrap must cover pinned template key ${key}`);
  }
  assert.doesNotMatch(
    upgraded,
    /^pm_external_skill_dirs\s*=|^voxxy_plugin_dir\s*=|^\[bloodbank\]/m,
    "retired config schema must not be reintroduced",
  );

  // Final template lifecycle contracts are read from the parent commit's
  // gitlink object, never from templates/hermes-agent's mutable checkout.
  const copierContract = committedHermesTemplate("copier.yml").content;
  const roleContract = committedHermesTemplate("template/role.yaml.jinja").content;
  const telegramContract = committedHermesTemplate("template/.scripts/30-telegram.sh").content;
  const slackContract = committedHermesTemplate("template/.scripts/31-slack.sh").content;
  const libraryContract = committedHermesTemplate("template/.scripts/_lib.sh").content;
  const runtimeContract = committedHermesTemplate("template/.scripts/20-runtime-repo.sh").content;
  const channelTransactionContract = committedHermesTemplate("template/.scripts/channel-transaction.py").content;
  assert.match(copierContract, /reconcile_enabled:\n[\s\S]*?default: true/);
  assert.match(copierContract, /_skip_if_exists:[\s\S]*?\n\s+- role\.yaml/);
  assert.match(roleContract, /telegram:\n\s+provisioning_status: "deferred"/);
  assert.match(roleContract, /slack:\n\s+provisioning_status: "deferred"/);
  assert.match(roleContract, /reconcile:[\s\S]*?explicit_opt_out:/);
  // No key means enabled: the projection renders activation on by default.
  assert.match(roleContract, /bloodbank:\n[\s\S]*?\n\s+enabled: true/);
  assert.match(roleContract, /service_state:\n\s+gateway: "pending"\n\s+heartbeat: "pending"/);
  // A skipped channel still records explicit disabled state. The write moved
  // out of the shell (profile_channel_enabled_set / <channel>_yaml_update are
  // gone) and into channel-transaction.py --prepare-unconfigured, so check the
  // routing in each script and the single write in the helper they share.
  assert.match(
    telegramContract,
    /if \[\[ "\$\{SKIP_TELEGRAM:-0\}" == "1" \]\]; then[\s\S]*?telegram_defer_if_unconfigured/,
    "a skipped Telegram step must still route through the deferred-state transaction",
  );
  assert.match(
    slackContract,
    /if \[\[ "\$\{SKIP_SLACK:-0\}" == "1" \]\]; then[\s\S]*?slack_defer_if_unconfigured/,
    "a skipped Slack step must still route through the deferred-state transaction",
  );
  assert.match(
    channelTransactionContract,
    /def prepare_unconfigured\([\s\S]*?platform\["enabled"\] = False[\s\S]*?update_role_status\(\s*originals\["role"\]\.content, args\.channel, "deferred"\s*\)/,
    "a deferred channel must write platforms.<channel>.enabled=false and provisioning_status: deferred",
  );

  // Both channel scripts write into $HOME/.hermes/profiles/<profile>, the root
  // 10-hermes-profile.sh creates. Under SKIP_HOST_STATE=1 that step defers, so
  // these must defer with it -- and the guard has to land before _lib.sh, which
  // creates the role log and reads fleet state. Without it both scripts died on
  // `required profile root is unavailable`, failing every deferred MCP render
  // at copier task 7 of 13.
  for (const [label, contract] of [["Telegram", telegramContract], ["Slack", slackContract]]) {
    const guard = contract.indexOf('if [[ "${SKIP_HOST_STATE:-0}" == "1" ]]');
    const source = contract.search(/^source\s/m);
    assert.ok(guard >= 0, `${label} must defer when host state is deferred`);
    assert.ok(source >= 0 && guard < source, `${label} host-state guard must precede sourcing _lib.sh`);
  }
  assert.match(libraryContract, /elif mode == "channel-enabled":[\s\S]*?channel\["enabled"\] = value == "true"/);
  assert.match(runtimeContract, /pure-local Hermes runtime without creating a Git/);
  assert.match(runtimeContract, /RUNTIME_LOCAL="\$ROLE_DIR\/runtime"/);
  assert.doesNotMatch(runtimeContract, /gh\s+repo\s+create|git\s+init|git\s+push|git\s+submodule\s+add/);

  // Inline comments are part of a valid TOML table header. The merge must
  // recognize that exact owner instead of appending a duplicate [fleet].
  const inlineHome = join(temp, "inline-xdg");
  const inlinePath = join(inlineHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(inlineHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(inlinePath, `[fleet] # keep this operator comment\nhermes_bin = "/operator/hermes"\n\n[operator]\nmode = "richer"\n`);
  const inline = run(["handbook", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: inlineHome,
  });
  assert.equal(inline.status, 0, `${inline.stdout}\n${inline.stderr}`);
  const inlineMerged = readFileSync(inlinePath, "utf8");
  assert.equal((inlineMerged.match(/^\[fleet\](?:\s|#|$)/gm) ?? []).length, 1);
  assert.match(inlineMerged, /^\[fleet\] # keep this operator comment$/m);
  assert.equal((inlineMerged.match(/^hermes_bin\s*=/gm) ?? []).length, 1);

  // A normal table owns keys only until the next table header, including an
  // array-table header. Missing [fleet] keys must stay out of [[fleet.plugins]].
  const arrayHome = join(temp, "array-xdg");
  const arrayPath = join(arrayHome, "hermes-agent-template", "config.toml");
  mkdirSync(join(arrayHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(arrayPath, `[fleet] # owner\nhermes_bin = "/operator/hermes"\n\n[[fleet.plugins]] # child array\nname = "operator-plugin"\n\n[operator]\nmode = "richer"\n`);
  const array = run(["handbook", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: arrayHome,
  });
  assert.equal(array.status, 0, `${array.stdout}\n${array.stderr}`);
  const arrayMerged = readFileSync(arrayPath, "utf8");
  const fleetStart = arrayMerged.indexOf("[fleet] # owner");
  const pluginStart = arrayMerged.indexOf("[[fleet.plugins]] # child array");
  const operatorStart = arrayMerged.indexOf("[operator]");
  assert.ok(fleetStart !== -1 && fleetStart < pluginStart && pluginStart < operatorStart);
  assert.match(arrayMerged.slice(fleetStart, pluginStart), /^pjangler_bin\s*=/m);
  assert.doesNotMatch(arrayMerged.slice(pluginStart, operatorStart), /^pjangler_bin\s*=/m);
  assert.equal((arrayMerged.match(/^\[fleet\](?:\s|#|$)/gm) ?? []).length, 1);

  // An array table cannot be silently reinterpreted as the scalar [fleet]
  // owner. Fail closed and preserve the source exactly.
  const incompatibleHome = join(temp, "incompatible-xdg");
  const incompatiblePath = join(incompatibleHome, "hermes-agent-template", "config.toml");
  const incompatibleSource = `[[fleet]] # intentionally incompatible\nname = "entry"\n`;
  mkdirSync(join(incompatibleHome, "hermes-agent-template"), { recursive: true });
  writeFileSync(incompatiblePath, incompatibleSource);
  const incompatible = run(["handbook", "bootstrap", "--force"], configRepo, {
    ...commandEnv,
    XDG_CONFIG_HOME: incompatibleHome,
  });
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /Cannot merge \[fleet\].*array table/);
  assert.equal(readFileSync(incompatiblePath, "utf8"), incompatibleSource);

  // Valid TOML can express fleet ownership through root dotted keys, dotted
  // keys inside [fleet], or an inline table. A preservation-safe additive
  // upgrade cannot turn any of these into a scalar without redefining a table,
  // so fail unchanged instead of writing invalid TOML and claiming success.
  for (const [label, source] of [
    ["root-dotted", `fleet.hermes_bin = "/operator/hermes" # keep dotted form\n`],
    ["table-dotted", `[fleet] # keep owner\nhermes_bin.path = "/operator/hermes"\n`],
    ["inline-table", `fleet = { hermes_bin = "/operator/hermes", custom = "keep" } # immutable inline table\n`],
  ]) {
    const unsafeHome = join(temp, `${label}-xdg`);
    const unsafePath = join(unsafeHome, "hermes-agent-template", "config.toml");
    mkdirSync(join(unsafeHome, "hermes-agent-template"), { recursive: true });
    writeFileSync(unsafePath, source);
    const before = statSync(unsafePath);
    const unsafe = run(["handbook", "bootstrap", "--force"], configRepo, {
      ...commandEnv,
      XDG_CONFIG_HOME: unsafeHome,
    });
    assert.notEqual(unsafe.status, 0, `${label} must fail closed`);
    assert.match(unsafe.stderr, /Merged Hermes template config is not valid TOML/);
    assert.doesNotMatch(unsafe.stdout, /Updated|Bootstrapped/);
    assert.equal(readFileSync(unsafePath, "utf8"), source, `${label} failure must preserve exact bytes`);
    const after = statSync(unsafePath);
    assert.equal(after.ino, before.ino, `${label} failure must not replace the file`);
    assert.equal(after.mtimeMs, before.mtimeMs, `${label} failure must not write the file`);
  }

  // Stateful systemctl fixture: action exit 0 is not enough; parity must probe
  // the resulting enabled/active leaves before recording durable state.
  const fakeSystemctl = join(fakeBin, "systemctl");
  writeFileSync(fakeSystemctl, `#!/usr/bin/env sh
state_dir="\${PJAN86_SYSTEMD_STATE:?}"
mkdir -p "$state_dir"
command_name="\${2:-}"
case "$command_name" in
  is-system-running|daemon-reload) exit 0 ;;
  enable)
    unit="\${4:-}"
    if [ "\${PJAN86_HEARTBEAT_VERIFY_FAIL:-}" = "1" ] && printf '%s' "$unit" | grep -q heartbeat; then
      exit 0
    fi
    : > "$state_dir/$unit.enabled"
    : > "$state_dir/$unit.active"
    exit 0
    ;;
  disable)
    unit="\${4:-}"
    if [ "\${PJAN86_GATEWAY_STUCK_ACTIVE:-}" != "1" ]; then
      rm -f -- "$state_dir/$unit.enabled" "$state_dir/$unit.active"
    fi
    exit 0
    ;;
  is-enabled)
    unit="\${3:-}"
    if [ "\${PJAN86_GATEWAY_STUCK_ACTIVE:-}" = "1" ] && printf '%s' "$unit" | grep -q gateway; then exit 0; fi
    [ -f "$state_dir/$unit.enabled" ] && exit 0 || exit 1
    ;;
  is-active)
    unit="\${3:-}"
    if [ "\${PJAN86_GATEWAY_STUCK_ACTIVE:-}" = "1" ] && printf '%s' "$unit" | grep -q gateway; then exit 0; fi
    [ -f "$state_dir/$unit.active" ] && exit 0 || exit 1
    ;;
esac
exit 1
`);
  chmodSync(fakeSystemctl, 0o755);

  // systemd parity evaluates heartbeat and gateway independently: an active
  // heartbeat plus deferred gateway is healthy only while the gateway is
  // disabled and inactive.
  const parityRepo = makeRepo(join(temp, "parity-repo"));
  const parityHome = join(temp, "parity-home");
  const parityRole = join(parityRepo, "agents", "hermes", "pm");
  const systemdDir = join(parityHome, ".config", "systemd", "user");
  const parityState = join(temp, "parity-systemd-state");
  mkdirSync(parityRole, { recursive: true });
  mkdirSync(systemdDir, { recursive: true });
  mkdirSync(parityState, { recursive: true });
  writeFileSync(join(parityRole, "role.yaml"), `repo: parity-repo\nrole: pm\nagent_id: parity-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: active\n`);
  const parityGateway = "hermes-parity-repo-pm-gateway.service";
  const parityHeartbeat = "hermes-parity-repo-pm-heartbeat.timer";
  for (const unit of [parityGateway, parityHeartbeat]) {
    writeFileSync(join(systemdDir, unit), "[Unit]\nDescription=fixture\n");
  }
  writeFileSync(join(parityState, `${parityHeartbeat}.enabled`), "");
  writeFileSync(join(parityState, `${parityHeartbeat}.active`), "");
  for (const probe of ["is-enabled", "is-active"]) {
    const fixtureProbe = spawnSync(fakeSystemctl, ["--user", probe, parityHeartbeat], {
      encoding: "utf8",
      env: { ...process.env, PJAN86_SYSTEMD_STATE: parityState },
    });
    assert.equal(fixtureProbe.status, 0, `systemctl fixture ${probe} failed: ${fixtureProbe.stderr}`);
  }
  const deferredAudit = run(["audit", parityRepo, "--json"], parityRepo, {
    ...commandEnv,
    HOME: parityHome,
    PJAN86_SYSTEMD_STATE: parityState,
  });
  const deferredFinding = JSON.parse(deferredAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(deferredFinding.status, "pass", JSON.stringify(deferredFinding));
  const unsafeAudit = run(["audit", parityRepo, "--json"], parityRepo, {
    ...commandEnv,
    HOME: parityHome,
    PJAN86_SYSTEMD_STATE: parityState,
    PJAN86_GATEWAY_STUCK_ACTIVE: "1",
  });
  const unsafeFinding = JSON.parse(unsafeAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(unsafeFinding.status, "fail");
  assert.match(unsafeFinding.details.join("\n"), /deferred and should be disabled\+inactive/);

  // installed -> active becomes durable only after enable + active probes.
  // The deferred gateway remains deferred, and the immediate post-audit passes.
  const migrateRepo = makeRepo(join(temp, "migrate-repo"));
  const migrateHome = join(temp, "migrate-home");
  const migrateRole = join(migrateRepo, "agents", "hermes", "pm");
  const migrateSystemd = join(migrateHome, ".config", "systemd", "user");
  const migrateState = join(temp, "migrate-systemd-state");
  const migrateRolePath = join(migrateRole, "role.yaml");
  mkdirSync(migrateRole, { recursive: true });
  mkdirSync(migrateSystemd, { recursive: true });
  mkdirSync(migrateState, { recursive: true });
  const migrateRoleSource = `# preserve role comment\nrepo: migrate-repo\nrole: pm\nagent_id: migrate-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: installed\n`;
  writeFileSync(migrateRolePath, migrateRoleSource);
  for (const unit of ["hermes-migrate-repo-pm-gateway.service", "hermes-migrate-repo-pm-heartbeat.timer"]) {
    writeFileSync(join(migrateSystemd, unit), "[Unit]\nDescription=fixture\n");
  }
  const migrated = run(["migrate", "systemd.sentinel", migrateRepo, "--json"], migrateRepo, {
    ...commandEnv,
    HOME: migrateHome,
    PJAN86_SYSTEMD_STATE: migrateState,
  });
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
  const migratedReport = JSON.parse(migrated.stdout);
  const migratedResult = migratedReport.results.find((result) => result.id === "systemd.sentinel");
  assert.equal(migratedResult.status, "applied", JSON.stringify(migratedResult));
  assert.ok(migratedResult.changedFiles.includes(migrateRolePath));
  const migratedRole = readFileSync(migrateRolePath, "utf8");
  assert.match(migratedRole, /^# preserve role comment$/m);
  assert.match(migratedRole, /service_state:\n\s+gateway: deferred\n\s+heartbeat: active/);
  const migratedAudit = run(["audit", migrateRepo, "--json"], migrateRepo, {
    ...commandEnv,
    HOME: migrateHome,
    PJAN86_SYSTEMD_STATE: migrateState,
  });
  const migratedFinding = JSON.parse(migratedAudit.stdout).rules.find((rule) => rule.id === "systemd.sentinel");
  assert.equal(migratedFinding.status, "pass", JSON.stringify(migratedFinding));

  // A successful disable command followed by a still-active deferred gateway
  // is a failed postcondition. role.yaml must remain byte-identical.
  const failureRepo = makeRepo(join(temp, "failure-repo"));
  const failureHome = join(temp, "failure-home");
  const failureRole = join(failureRepo, "agents", "hermes", "pm");
  const failureSystemd = join(failureHome, ".config", "systemd", "user");
  const failureState = join(temp, "failure-systemd-state");
  const failureRolePath = join(failureRole, "role.yaml");
  mkdirSync(failureRole, { recursive: true });
  mkdirSync(failureSystemd, { recursive: true });
  mkdirSync(failureState, { recursive: true });
  const failureRoleSource = `repo: failure-repo\nrole: pm\nagent_id: failure-repo-pm\ndeployment:\n  systemd: required\nservice_state:\n  gateway: deferred\n  heartbeat: installed\n`;
  writeFileSync(failureRolePath, failureRoleSource);
  for (const unit of ["hermes-failure-repo-pm-gateway.service", "hermes-failure-repo-pm-heartbeat.timer"]) {
    writeFileSync(join(failureSystemd, unit), "[Unit]\nDescription=fixture\n");
  }
  const failedMigration = run(["migrate", "systemd.sentinel", failureRepo, "--json"], failureRepo, {
    ...commandEnv,
    HOME: failureHome,
    PJAN86_SYSTEMD_STATE: failureState,
    PJAN86_GATEWAY_STUCK_ACTIVE: "1",
  });
  assert.notEqual(failedMigration.status, 0);
  const failedReport = JSON.parse(failedMigration.stdout);
  const failedResult = failedReport.results.find((result) => result.id === "systemd.sentinel");
  assert.equal(failedResult.status, "blocked", JSON.stringify(failedResult));
  assert.match(failedResult.details.join("\n"), /did not become disabled\+inactive/);
  assert.equal(readFileSync(failureRolePath, "utf8"), failureRoleSource);

  // Source-level orchestration tripwires complement the process tests: summary
  // is final-only and explicit --force is the sole overwrite path.
  const recipe = readFileSync(join(root, "packages", "flume-hr", "src", "hire", "HireRecipe.ts"), "utf8");
  const copier = readFileSync(join(root, "packages", "flume-hr", "src", "hire", "RunCopierTemplate.ts"), "utf8");
  const configBootstrap = readFileSync(join(root, "packages", "flume-hr", "src", "hire", "EnsureTemplateConfig.ts"), "utf8");
  const optionValidation = readFileSync(join(root, "packages", "flume-hr", "src", "hire", "ValidateHermesOptions.ts"), "utf8");
  const externalEffects = readFileSync(join(root, "packages", "flume-hr", "src", "hire", "ApplyDeferredExternalEffects.ts"), "utf8");
  const summary = readFileSync(join(root, "packages", "flume-hr", "src", "hire", "PrintHermesSummary.ts"), "utf8");
  const ingredients = recipe.match(/const ingredients = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  assert.doesNotMatch(ingredients, /PrintHermesSummary/, "summary must not run before lifecycle postconditions");
  assert.ok(recipe.indexOf("ValidateHermesOptions") < recipe.indexOf("EnsureTemplateConfig", recipe.indexOf("const ingredients")));
  assert.match(copier, /if \(ctx\.force\) args\.push\("--overwrite"\)/);
  assert.match(copier, /if \(ctx\.yes \|\| ctx\.quiet\) args\.push\("--defaults"\)/);
  assert.doesNotMatch(copier, /ctx\.yes\)\s*\{\s*ctx\.force\s*=\s*true/);
  assert.match(configBootstrap, /spawnSync\("python3", \["-I", "-S", "-c", TOMLLIB_VALIDATE\]/);
  assert.match(configBootstrap, /!name\.toUpperCase\(\)\.startsWith\("PYTHON"\)/);
  assert.match(configBootstrap, /timeout: TOMLLIB_VALIDATION_TIMEOUT_MS/);
  assert.match(configBootstrap, /killSignal: "SIGKILL"/);
  assert.match(configBootstrap, /tomllib\.loads\(source\)/);
  assert.doesNotMatch(configBootstrap, /smol-toml|parse as parseToml/);
  // The merge boundary takes bytes. A "utf8" read here decodes an invalid
  // sequence to U+FFFD, which is valid TOML, so an undecodable config would
  // validate clean and then be rewritten with replacement characters.
  assert.match(configBootstrap, /export function mergeHostConfig\(existingBytes: Buffer\)/);
  assert.match(configBootstrap, /validateTomlBytes\(existingBytes, "Existing Hermes template config"\)/);
  // Code only -- the docblock naming the mistake must not count as making it.
  assert.doesNotMatch(configBootstrap, /^(?!\s*\*).*readFileSync\(path, "utf8"\)/m);
  // Validation is required, not best effort: the consumer (_lib.sh config_get)
  // swallows parse errors and silently returns defaults, so an unvalidated
  // config fails quietly rather than loudly.
  assert.match(configBootstrap, /python3 with tomllib is required but was not found/);
  assert.match(configBootstrap, /TOMLLIB_UNAVAILABLE:/);
  // Durability is one same-directory temp file and one rename(2). The lock,
  // renameat2 helper, protected-inode hardlinks, transaction journal and crash
  // recovery are gone; asserting their absence keeps them gone.
  assert.match(configBootstrap, /renameSync\(tmp, path\)/);
  assert.doesNotMatch(configBootstrap, /O_NOFOLLOW|\/usr\/bin\/flock|PJANGLER_RENAMEAT2_HELPER|atomicRenameAt2|pjangler-config-txn/);
  assert.doesNotMatch(configBootstrap, /processIsAlive|process\.kill\(pid, 0\)/);
  assert.ok(configBootstrap.indexOf("stats = inspectConfigPath(path)") < configBootstrap.indexOf("if (exists && !force)"));
  assert.match(optionValidation, /const stats = lstatSync\(path\)/);
  assert.match(optionValidation, /!stats\.isFile\(\)/);
  assert.match(optionValidation, /stats\.nlink !== 1/);
  assert.doesNotMatch(externalEffects, /20-runtime-repo\.sh|selected\.runtimeRepo/);
  assert.doesNotMatch(summary, /@clack\/prompts|Provisioned|\bDone\.|runtime\s+gh:/);
} finally {
  if (openSocketServer) {
    await new Promise((resolveClose) => openSocketServer.close(() => resolveClose()));
  }
  rmSync(temp, { recursive: true, force: true });
}

console.log("PJAN-86 Hermes deploy regressions: PASS");
