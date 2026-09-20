import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";

export interface LifecycleEligibilityResult {
  ok: boolean;
  error?: string;
}

export interface TrustedCopierResult extends LifecycleEligibilityResult {
  executable?: string;
  realExecutable?: string;
  layout?: string;
  identity?: TrustedCopierIdentity;
}

export interface TrustedCopierFileIdentity {
  path: string;
  realPath: string;
  sha256: string;
  size: number;
  device: number;
  inode: number;
  mode: number;
  uid: number;
  gid: number;
}

/**
 * Read-only provenance captured before an MCP apply.
 *
 * `executable` is the canonical launcher, not the PATH entry. Callers must
 * revalidate the full identity immediately before their first write and then
 * invoke this exact path. This makes a PATH swap irrelevant and detects a
 * package/launcher replacement between the handler preflight and execution.
 */
export interface TrustedCopierIdentity {
  executable: string;
  resolvedFrom: string;
  layout: "uv-tool";
  version: string;
  toolRoot: string;
  interpreter: TrustedCopierFileIdentity;
  files: readonly TrustedCopierFileIdentity[];
}

export interface TrustedCopierOptions {
  targetDir: string;
  env?: NodeJS.ProcessEnv;
  /** Test-only dependency injection. MCP callers always use the OS account home. */
  homeDir?: string;
  temporaryDir?: string;
  /** Kept for API compatibility; mutable layout allowlists are no longer trusted. */
  systemRoots?: readonly string[];
}

export interface RenderedHermesEligibilityOptions {
  pjanglerRoot: string;
  targetDir: string;
  roleDir: string;
  targetRepo: string;
  role: string;
  agentId: string;
}

function containedBy(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function firstExecutableOnPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const rawEntry of (env.PATH ?? "").split(delimiter)) {
    const entry = rawEntry || process.cwd();
    const candidate = resolve(entry, process.platform === "win32" ? "copier.exe" : "copier");
    try {
      accessSync(candidate, constants.X_OK);
      const stat = lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return candidate;
    } catch {
      // Continue to the next PATH entry. Resolution itself must never execute a
      // candidate, because a shadowed program is exactly what this gate rejects.
    }
  }
  return undefined;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("base64url");
}

function fingerprint(path: string): TrustedCopierFileIdentity {
  const absolute = resolve(path);
  const realPath = realpathSync(absolute);
  const stat = statSync(realPath);
  if (!stat.isFile()) throw new Error(`${absolute} is not a regular file`);
  return {
    path: absolute,
    realPath,
    sha256: sha256(realPath),
    size: stat.size,
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function sameFingerprint(expected: TrustedCopierFileIdentity): LifecycleEligibilityResult {
  try {
    const actual = fingerprint(expected.path);
    for (const key of ["realPath", "sha256", "size", "device", "inode", "mode", "uid", "gid"] as const) {
      if (actual[key] !== expected[key]) {
        return { ok: false, error: `trusted Copier identity changed at ${expected.path} (${key})` };
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `trusted Copier identity is unavailable at ${expected.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function consoleScriptContract(path: string): LifecycleEligibilityResult & { interpreter?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8").slice(0, 32 * 1024);
  } catch (error) {
    return { ok: false, error: `cannot read Copier launcher: ${error instanceof Error ? error.message : String(error)}` };
  }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return { ok: false, error: "Copier launcher has no executable shebang" };
  const shebang = firstLine.slice(2).trim().split(/\s+/);
  if (shebang.length !== 1 || !isAbsolute(shebang[0] ?? "")) {
    return { ok: false, error: "Copier launcher must use one absolute Python interpreter" };
  }
  const interpreterPath = resolve(shebang[0]!);
  const interpreter = basename(interpreterPath);
  if (!/^python(?:\d+(?:\.\d+)*)?$/.test(interpreter)) {
    return { ok: false, error: "Copier launcher is not an absolute Python console script" };
  }
  if (!/from\s+copier\.__main__\s+import\s+CopierApp/.test(text) || !/CopierApp\.run\s*\(/.test(text)) {
    return { ok: false, error: "Copier launcher does not match the Copier 9 console-script contract" };
  }
  return { ok: true, interpreter: interpreterPath };
}

function defaultUvToolRoots(home: string): string[] {
  return [
    join(home, ".local", "share", "uv", "tools", "copier"),
    join(home, "Library", "Application Support", "uv", "tools", "copier"),
  ].map((path) => resolve(path));
}

function locateUvSitePackages(toolRoot: string): string {
  const lib = join(toolRoot, "lib");
  const candidates: string[] = [];
  for (const entry of readdirSync(lib, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^python\d+(?:\.\d+)*$/.test(entry.name)) continue;
    const sitePackages = join(lib, entry.name, "site-packages");
    if (existsSync(sitePackages)) candidates.push(sitePackages);
  }
  if (candidates.length !== 1) throw new Error(`expected one UV Copier site-packages directory, found ${candidates.length}`);
  return realpathSync(candidates[0]!);
}

function parseRecordLine(line: string): { relativePath: string; digest: string; size: number } | undefined {
  // Copier's wheel paths contain no CSV quoting. Reject rather than attempting
  // a permissive parse if a future/unexpected distribution does.
  if (!line || line.includes('"')) return undefined;
  const parts = line.split(",");
  if (parts.length !== 3 || !parts[1]?.startsWith("sha256=") || !/^\d+$/.test(parts[2] ?? "")) return undefined;
  return {
    relativePath: parts[0]!,
    digest: parts[1]!.slice("sha256=".length),
    size: Number(parts[2]),
  };
}

function attestUvCopier(candidate: string, realCandidate: string, home: string): TrustedCopierResult {
  const toolRoot = defaultUvToolRoots(home).find((root) => realCandidate === join(root, "bin", "copier"));
  if (!toolRoot) {
    return { ok: false, error: `refusing untrusted PATH-shadowed Copier executable: ${candidate}` };
  }

  const supportedEntries = new Set([
    join(home, ".local", "bin", "copier"),
    join(toolRoot, "bin", "copier"),
  ].map((path) => resolve(path)));
  if (!supportedEntries.has(resolve(candidate))) {
    return { ok: false, error: `refusing non-canonical UV Copier entry point: ${candidate}` };
  }

  try {
    const launcher = consoleScriptContract(realCandidate);
    if (!launcher.ok || !launcher.interpreter) {
      return { ...launcher, executable: realCandidate, realExecutable: realCandidate };
    }
    const expectedInterpreter = join(toolRoot, "bin", basename(launcher.interpreter));
    if (resolve(launcher.interpreter) !== resolve(expectedInterpreter)) {
      return { ok: false, error: "UV Copier launcher interpreter is outside the attested tool environment" };
    }

    const interpreterReal = realpathSync(launcher.interpreter);
    const uvPythonRoots = [
      join(home, ".local", "share", "uv", "python"),
      join(home, "Library", "Application Support", "uv", "python"),
    ];
    if (!uvPythonRoots.some((root) => containedBy(root, interpreterReal))) {
      return { ok: false, error: "UV Copier interpreter is not managed by the canonical UV Python installation" };
    }

    const receiptPath = join(toolRoot, "uv-receipt.toml");
    const receipt = readFileSync(receiptPath, "utf8");
    if (!/requirements\s*=\s*\[[\s\S]*?name\s*=\s*["']copier["']/.test(receipt)
      || !/entrypoints\s*=\s*\[[\s\S]*?name\s*=\s*["']copier["'][\s\S]*?from\s*=\s*["']copier["']/.test(receipt)) {
      return { ok: false, error: "UV tool receipt does not bind the copier entry point to the Copier package" };
    }

    const sitePackages = locateUvSitePackages(toolRoot);
    const distInfos = readdirSync(sitePackages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^copier-[^-]+\.dist-info$/i.test(entry.name))
      .map((entry) => join(sitePackages, entry.name));
    if (distInfos.length !== 1) {
      return { ok: false, error: `expected one installed Copier distribution, found ${distInfos.length}` };
    }
    const distInfo = realpathSync(distInfos[0]!);
    const metadataPath = join(distInfo, "METADATA");
    const entryPointsPath = join(distInfo, "entry_points.txt");
    const recordPath = join(distInfo, "RECORD");
    const metadata = readFileSync(metadataPath, "utf8");
    const name = metadata.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
    const version = metadata.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    if (name?.toLowerCase() !== "copier" || !version || !/^9(?:\.|$)/.test(version)) {
      return { ok: false, error: "installed distribution is not a Copier 9 package" };
    }
    const entryPoints = readFileSync(entryPointsPath, "utf8");
    if (!/^copier\s*=\s*copier\.__main__:CopierApp\.run\s*$/m.test(entryPoints)) {
      return { ok: false, error: "installed Copier distribution has an unexpected console entry point" };
    }

    const recordEntries = readFileSync(recordPath, "utf8")
      .split(/\r?\n/)
      .map(parseRecordLine)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const selected = recordEntries.filter((entry) => {
      const normalized = entry.relativePath.replaceAll("\\", "/");
      return normalized.startsWith("copier/")
        || normalized === `${basename(distInfo)}/METADATA`
        || normalized === `${basename(distInfo)}/entry_points.txt`
        || normalized === "../../../bin/copier";
    });
    if (!selected.some((entry) => entry.relativePath === "../../../bin/copier")
      || !selected.some((entry) => entry.relativePath.replaceAll("\\", "/") === "copier/__main__.py")) {
      return { ok: false, error: "Copier RECORD does not bind its launcher and package entry point" };
    }

    const attestedFiles = new Map<string, TrustedCopierFileIdentity>();
    for (const entry of selected) {
      const path = resolve(sitePackages, entry.relativePath);
      const allowed = path === realCandidate || containedBy(sitePackages, path);
      if (!allowed) return { ok: false, error: `Copier RECORD path escapes the tool environment: ${entry.relativePath}` };
      const actualDigest = sha256(path);
      const actualSize = statSync(path).size;
      if (actualDigest !== entry.digest || actualSize !== entry.size) {
        return { ok: false, error: `Copier RECORD integrity mismatch: ${entry.relativePath}` };
      }
      attestedFiles.set(resolve(path), fingerprint(path));
    }
    for (const path of [realCandidate, join(toolRoot, "pyvenv.cfg"), receiptPath, metadataPath, entryPointsPath, recordPath]) {
      attestedFiles.set(resolve(path), fingerprint(path));
    }

    const identity: TrustedCopierIdentity = {
      executable: realCandidate,
      resolvedFrom: resolve(candidate),
      layout: "uv-tool",
      version,
      toolRoot,
      interpreter: fingerprint(launcher.interpreter),
      files: [...attestedFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
    return {
      ok: true,
      executable: identity.executable,
      realExecutable: identity.executable,
      layout: identity.layout,
      identity,
    };
  } catch (error) {
    return { ok: false, error: `cannot attest UV Copier installation: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function verifyTrustedCopierIdentity(identity: TrustedCopierIdentity): LifecycleEligibilityResult {
  if (!isAbsolute(identity.executable) || resolve(identity.executable) !== resolve(identity.files.find((file) => file.path === identity.executable)?.path ?? "")) {
    return { ok: false, error: "trusted Copier identity has no canonical absolute launcher" };
  }
  const interpreter = sameFingerprint(identity.interpreter);
  if (!interpreter.ok) return interpreter;
  for (const file of identity.files) {
    const verified = sameFingerprint(file);
    if (!verified.ok) return verified;
  }
  return { ok: true };
}

/**
 * Resolve and attest Copier without executing it.
 *
 * MCP apply paths accept the first PATH match only when it resolves to the
 * canonical Copier UV tool for the operating-system account. Layout or
 * launcher text alone is not provenance: the UV receipt, absolute interpreter,
 * Copier 9 distribution metadata, entry point, PEP-376 RECORD hashes, package
 * files, venv metadata, and interpreter are bound into an identity. pip-user,
 * pipx, pyenv, Homebrew, and arbitrary system locations remain usable by the
 * interactive CLI but fail closed for MCP apply unless a future implementation
 * can establish an equally strong package identity. An earlier shadow is never
 * skipped in favor of a later executable.
 */
export function preflightTrustedCopier(options: TrustedCopierOptions): TrustedCopierResult {
  const env = options.env ?? process.env;
  // Do not let an ambient HOME redirect the trust root. Tests can inject a
  // synthetic account home explicitly; production MCP callers cannot.
  const home = resolve(options.homeDir ?? userInfo().homedir);
  const temporary = resolve(options.temporaryDir ?? tmpdir());
  const target = resolve(options.targetDir);
  const candidate = firstExecutableOnPath(env);
  if (!candidate) return { ok: false, error: "copier not found on PATH" };

  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch (error) {
    return { ok: false, error: `cannot resolve Copier launcher: ${error instanceof Error ? error.message : String(error)}` };
  }

  for (const [label, root] of [["target", target], ["temporary", temporary]] as const) {
    if (containedBy(root, candidate) || containedBy(root, realCandidate)) {
      return { ok: false, error: `refusing ${label}-local Copier executable: ${candidate}` };
    }
  }

  return attestUvCopier(candidate, realCandidate, home);
}

function regularContainedFile(root: string, path: string, label: string): LifecycleEligibilityResult {
  try {
    const rootReal = realpathSync(root);
    const fileReal = realpathSync(path);
    if (!containedBy(rootReal, fileReal)) return { ok: false, error: `${label} escapes its vendored template root` };
    if (!lstatSync(path).isFile()) return { ok: false, error: `${label} is not a regular file` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseCopierConfig(templateRoot: string, label: string): { result: LifecycleEligibilityResult; config?: Record<string, unknown> } {
  const configPath = join(templateRoot, "copier.yml");
  const file = regularContainedFile(templateRoot, configPath, `${label} copier.yml`);
  if (!file.ok) return { result: file };
  try {
    const parsed = YAML.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { result: { ok: false, error: `${label} copier.yml must contain a mapping` } };
    }
    const config = parsed as Record<string, unknown>;
    if (config._subdirectory !== "template") {
      return { result: { ok: false, error: `${label} copier.yml must render the template subdirectory` } };
    }
    if (!/^9(?:\.|$)/.test(String(config._min_copier_version ?? ""))) {
      return { result: { ok: false, error: `${label} requires an unsupported Copier contract` } };
    }
    return { result: { ok: true }, config };
  } catch (error) {
    return { result: { ok: false, error: `${label} copier.yml is invalid: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

function requireFiles(templateRoot: string, files: readonly string[], label: string): LifecycleEligibilityResult {
  for (const rel of files) {
    const result = regularContainedFile(templateRoot, join(templateRoot, rel), `${label} ${rel}`);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function preflightCommonProjectTemplate(pjanglerRoot: string): LifecycleEligibilityResult {
  const templateRoot = join(resolve(pjanglerRoot), "templates", "commonproject");
  const parsed = parseCopierConfig(templateRoot, "CommonProject template");
  if (!parsed.result.ok) return parsed.result;
  const files = requireFiles(templateRoot, [
    "template/.project.json.jinja",
    "template/.copier-answers.yml.jinja",
    "template/.env.op",
    "template/AGENTS.md.jinja",
    "template/mise.toml.jinja",
  ], "CommonProject template");
  if (!files.ok) return files;
  const projectJson = readFileSync(join(templateRoot, "template", ".project.json.jinja"), "utf8");
  for (const key of ["project_name", "repo_path", "ticket_provider", "agents"]) {
    if (!projectJson.includes(`\"${key}\"`)) return { ok: false, error: `CommonProject projection is missing ${key}` };
  }
  if (!projectJson.includes('"project_id"') && !projectJson.includes('"project_slug"')) {
    return { ok: false, error: "CommonProject manifest is missing project_id" };
  }
  return { ok: true };
}

export function preflightHermesTemplate(pjanglerRoot: string, env: NodeJS.ProcessEnv = process.env): LifecycleEligibilityResult {
  const templateRoot = join(resolve(pjanglerRoot), "templates", "hermes-agent");
  const explicit = env.PJANGLER_HERMES_TEMPLATE?.trim();
  if (explicit) {
    try {
      if (realpathSync(resolve(explicit)) !== realpathSync(templateRoot)) {
        return { ok: false, error: "MCP Hermes apply requires the version-locked vendored template" };
      }
    } catch (error) {
      return { ok: false, error: `Hermes template override is unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const parsed = parseCopierConfig(templateRoot, "Hermes template");
  if (!parsed.result.ok) return parsed.result;
  const required = requireFiles(templateRoot, [
    "template/role.yaml.jinja",
    "template/SOUL.md.jinja",
    "template/hermes.jinja",
    "template/.scripts/_lib.sh",
    "template/.scripts/01-config.sh",
    "template/.scripts/05-fleet-env.sh",
    "template/.scripts/10-hermes-profile.sh",
    "template/.scripts/20-runtime-repo.sh",
    "template/.scripts/30-telegram.sh",
    "template/.scripts/31-slack.sh",
    "template/.scripts/42-ticket-provider.sh",
    "template/.scripts/70-systemd.sh",
    "template/.scripts/80-registry.sh",
  ], "Hermes template");
  if (!required.ok) return required;

  const role = readFileSync(join(templateRoot, "template", "role.yaml.jinja"), "utf8");
  if (!/^bloodbank:\s*$[\s\S]*?^\s+enabled:\s+(?:true|false)\s*$/m.test(role)) {
    return { ok: false, error: "Hermes role projection must declare bloodbank.enabled as a strict boolean" };
  }
  const library = readFileSync(join(templateRoot, "template", ".scripts", "_lib.sh"), "utf8");
  if (!library.includes("PJANGLER_PROJECT_ROOT") || !library.includes('"$explicit"/agents/hermes/*')) {
    return { ok: false, error: "Hermes project-root resolver must honor the explicitly contained MCP target" };
  }
  const skipPlane = readFileSync(join(templateRoot, "template", ".scripts", "42-ticket-provider.sh"), "utf8");
  const guard = skipPlane.indexOf('if [[ "${SKIP_PLANE:-0}" == "1" ]]');
  const firstSource = skipPlane.search(/^source\s/m);
  if (guard < 0 || firstSource < 0 || guard > firstSource) {
    return { ok: false, error: "Hermes ticket-provider skip guard must precede all sourced provider/config logic" };
  }
  // 30/31 write into the profile root 10-hermes-profile.sh creates, so they
  // must defer with it. Without the guard both died on "required profile root
  // is unavailable" and took every deferred MCP render down with them.
  for (const script of ["01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "30-telegram.sh", "31-slack.sh", "80-registry.sh"]) {
    const text = readFileSync(join(templateRoot, "template", ".scripts", script), "utf8");
    const hostGuard = text.indexOf('if [[ "${SKIP_HOST_STATE:-0}" == "1" ]]');
    const source = text.search(/^source\s/m);
    if (hostGuard < 0 || source < 0 || hostGuard > source) {
      return { ok: false, error: `Hermes ${script} host-state guard must precede all sourced config/fleet logic` };
    }
  }
  const tasks = Array.isArray(parsed.config?._tasks) ? parsed.config._tasks.map(String) : [];
  for (const script of ["20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    if (!tasks.some((task) => task.includes(script))) return { ok: false, error: `Hermes copier task list is missing ${script}` };
  }
  return { ok: true };
}

/**
 * Validate the trusted Copier projection before any host-global script runs.
 *
 * The executable and version-locked template were attested before Copier was
 * launched. This second, read-only gate proves that the rendered identity,
 * strict lifecycle metadata, local project registration, and every script we
 * may execute in the host/external tails are exactly the expected projection.
 */
export function preflightRenderedHermes(options: RenderedHermesEligibilityOptions): LifecycleEligibilityResult {
  const target = resolve(options.targetDir);
  const roleDir = resolve(options.roleDir);
  if (!containedBy(target, roleDir)) return { ok: false, error: "rendered Hermes role escapes its project target" };
  try {
    const stat = lstatSync(roleDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, error: "rendered Hermes role must be a real directory" };
    }
  } catch (error) {
    return { ok: false, error: `rendered Hermes role is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }

  const templateScripts = join(resolve(options.pjanglerRoot), "templates", "hermes-agent", "template", ".scripts");
  const renderedScripts = join(roleDir, ".scripts");
  const requiredFiles = [
    "role.yaml",
    "SOUL.md",
    "hermes",
    ".gitignore",
    ".runtime-scaffold/README.md",
    ...["_lib.sh", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]
      .map((script) => `.scripts/${script}`),
  ];
  const required = requireFiles(roleDir, requiredFiles, "rendered Hermes role");
  if (!required.ok) return required;

  for (const script of ["_lib.sh", "01-config.sh", "05-fleet-env.sh", "10-hermes-profile.sh", "20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    try {
      if (readFileSync(join(renderedScripts, script), "utf8") !== readFileSync(join(templateScripts, script), "utf8")) {
        return { ok: false, error: `rendered Hermes script differs from the attested template: ${script}` };
      }
    } catch (error) {
      return { ok: false, error: `cannot attest rendered Hermes script ${script}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  let role: Record<string, unknown>;
  try {
    const parsed = YAML.parse(readFileSync(join(roleDir, "role.yaml"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "rendered Hermes role.yaml must contain a mapping" };
    }
    role = parsed as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: `rendered Hermes role.yaml is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (role.repo !== options.targetRepo || role.role !== options.role || role.agent_id !== options.agentId) {
    return { ok: false, error: "rendered Hermes role identity does not match the requested repo/role/agent" };
  }
  const bloodbank = role.bloodbank as Record<string, unknown> | undefined;
  if (!bloodbank || typeof bloodbank.enabled !== "boolean") {
    return { ok: false, error: "rendered Hermes bloodbank.enabled must be a strict boolean" };
  }
  const deployment = role.deployment as Record<string, unknown> | undefined;
  if (!deployment || deployment.local_only !== true || deployment.systemd !== "deferred") {
    return { ok: false, error: "rendered Hermes deployment must remain local-only/deferred until external grants run" };
  }

  const manifestPath = join(target, ".project.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const agents = manifest.agents as Record<string, Record<string, unknown>> | undefined;
      const declared = agents?.[options.agentId];
      if (!declared
        || declared.role !== options.role
        || declared.role_dir !== relative(target, roleDir)
        || declared.provisioning_state !== "provisioned") {
        return { ok: false, error: "rendered Hermes role is not canonically registered in .project.json" };
      }
    } catch (error) {
      return { ok: false, error: `cannot validate rendered Hermes project registration: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true };
}

export function preflightMcpLifecycle(options: {
  pjanglerRoot: string;
  targetDir: string;
  commonProject: boolean;
  hermes: boolean;
  env?: NodeJS.ProcessEnv;
}): TrustedCopierResult {
  const copier = preflightTrustedCopier({ targetDir: options.targetDir, env: options.env });
  if (!copier.ok) return copier;
  if (options.commonProject) {
    const common = preflightCommonProjectTemplate(options.pjanglerRoot);
    if (!common.ok) return { ...common, executable: copier.executable, realExecutable: copier.realExecutable };
  }
  if (options.hermes) {
    const hermes = preflightHermesTemplate(options.pjanglerRoot, options.env);
    if (!hermes.ok) return { ...hermes, executable: copier.executable, realExecutable: copier.realExecutable };
  }
  return copier;
}
