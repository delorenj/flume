import { homedir, platform } from "node:os";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, dirname } from "node:path";
import { Command, type InvokeResult } from "../engine/Command";
import type { HermesAgentContext } from "./types";

const HERMES_GIT_URL = "https://github.com/delorenj/hermes-agent.git";
const HERMES_GIT_REF = "main";
const HERMES_GIT_SHA = "0408fec7a153e6c32c064acd2b8053917f1525f1";

type ConfigSchema = ReadonlyArray<{
  section: string;
  values: ReadonlyArray<readonly [key: string, value: string]>;
}>;

/** Resolve the one host-global config consumed by the pinned Copier template. */
export function resolveTemplateConfigPath(): string {
  const fromEnv = process.env.HERMES_TEMPLATE_CONFIG;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length ? xdg : join(homedir(), ".config");
  return join(base, "hermes-agent-template", "config.toml");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function detectHermesInstall(home: string): { bin: string; repo: string } {
  const releaseRoot = join(home, ".local", "share", "hermes-agent", "releases", HERMES_GIT_SHA);
  const devRoot = join(home, "code", "hermes-agent");
  const candidates = [
    join(releaseRoot, ".venv", "bin", "hermes"),
    join(home, ".local", "bin", "hermes"),
    join(devRoot, "venv", "bin", "hermes"),
    join(devRoot, ".venv", "bin", "hermes"),
  ];
  const bin = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  try {
    const resolved = realpathSync(bin);
    const environment = dirname(dirname(resolved));
    if (["venv", ".venv"].includes(environment.split("/").at(-1) ?? "")) {
      return { bin, repo: dirname(environment) };
    }
  } catch {
    // A not-yet-installed pinned release is still the canonical bootstrap guess.
  }
  return { bin, repo: bin.startsWith(devRoot) ? devRoot : releaseRoot };
}

function hostSchema(): ConfigSchema {
  const home = homedir();
  const hermes = detectHermesInstall(home);
  return [
    {
      section: "fleet",
      values: [
        ["hermes_bin", quote(hermes.bin)],
        ["hermes_repo", quote(hermes.repo)],
        ["pjangler_bin", quote("pj")],
        ["hermes_git_url", quote(HERMES_GIT_URL)],
        ["hermes_git_ref", quote(HERMES_GIT_REF)],
        ["hermes_git_sha", quote(HERMES_GIT_SHA)],
        ["runtime_scaffold_dir", quote(join(home, "code", "hermes-agent-template", "runtime-scaffold"))],
        ["fleet_env", quote("~/.hermes/fleet.env")],
        ["registry_file", quote("~/.hermes/agents-registry.yaml")],
        ["oauth_file", quote("~/.hermes/auth.json")],
        ["codex_home", quote("~/.codex")],
        ["canonical_skills_dir", quote(join(home, ".agents", "skills"))],
        ["vox_plugin_name", quote("vox")],
        ["vox_plugin_dir", quote(join(home, "code", "voxxy", "plugins", "tts", "vox"))],
        ["vox_voice", quote("carlin")],
        ["vox_url", quote("https://vox.delo.sh")],
        ["onepassword_vault", quote("DeLoSecrets")],
        ["onepassword_item_prefix", quote("hermes-agent")],
        [
          "symlinked_runtime_skills",
          `[${[
            "delonet-conventions",
            "delonet-dotenv",
            "hermes-pm-template-maintenance",
            "hindsight",
            "33god-projects",
            "subagent-driven-development",
          ].map(quote).join(", ")}]`,
        ],
      ],
    },
    { section: "github", values: [["runtime_repo_owner", quote("")]] },
    {
      section: "plane",
      values: [
        ["base", quote("https://plane.delo.sh")],
        ["workspace", quote("33god")],
      ],
    },
  ];
}

/** Render the current, pinned template schema with host-derived path values. */
export function renderHostConfig(): string {
  const sections = hostSchema()
    .map(({ section, values }) => `[${section}]\n${values.map(([key, value]) => `${key} = ${value}`).join("\n")}`)
    .join("\n\n");
  return `# hermes-agent-template — host configuration\n# Bootstrapped by \`flume handbook bootstrap\` for $HOME=${homedir()} (platform=${platform()}).\n# Existing values and additional keys are preserved by \`--force\`; it only adds\n# fields missing from the schema pinned in this flume release.\n# Resolution precedence: env var > ~/.hermes/fleet.env > this file > fallback.\n\n${sections}\n`;
}

export interface TomlTableHeader {
  kind: "table" | "array-table";
  path: string[];
  headerStart: number;
  bodyStart: number;
  bodyEnd: number;
}

type MultilineString = "basic" | "literal" | undefined;

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Track TOML multiline strings so header-looking payload lines stay payload. */
function scanMultilineState(line: string, initial: MultilineString): MultilineString {
  let state = initial;
  let string: "basic" | "literal" | undefined;
  for (let index = 0; index < line.length;) {
    if (state) {
      const marker = state === "basic" ? '\"\"\"' : "'''";
      const close = line.indexOf(marker, index);
      if (close === -1) return state;
      if (state === "basic" && isEscaped(line, close)) {
        index = close + marker.length;
        continue;
      }
      state = undefined;
      index = close + marker.length;
      continue;
    }
    if (string === "basic") {
      if (line[index] === '\"' && !isEscaped(line, index)) string = undefined;
      index += 1;
      continue;
    }
    if (string === "literal") {
      if (line[index] === "'") string = undefined;
      index += 1;
      continue;
    }
    if (line[index] === "#") break;
    if (line.startsWith('\"\"\"', index)) {
      state = "basic";
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      state = "literal";
      index += 3;
      continue;
    }
    if (line[index] === '\"') string = "basic";
    else if (line[index] === "'") string = "literal";
    index += 1;
  }
  return state;
}

function parseBasicKey(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a TOML dotted key, including quoted segments, without losing spelling. */
function parseDottedKey(raw: string): string[] | undefined {
  const path: string[] = [];
  let cursor = 0;
  const whitespace = () => {
    while (cursor < raw.length && /[ \t]/.test(raw[cursor]!)) cursor += 1;
  };
  whitespace();
  while (cursor < raw.length) {
    let key: string | undefined;
    if (raw[cursor] === '\"') {
      const start = cursor;
      cursor += 1;
      while (cursor < raw.length) {
        if (raw[cursor] === '\"' && !isEscaped(raw, cursor)) {
          cursor += 1;
          key = parseBasicKey(raw.slice(start, cursor));
          break;
        }
        cursor += 1;
      }
    } else if (raw[cursor] === "'") {
      const end = raw.indexOf("'", cursor + 1);
      if (end !== -1) {
        key = raw.slice(cursor + 1, end);
        cursor = end + 1;
      }
    } else {
      const match = raw.slice(cursor).match(/^[A-Za-z0-9_-]+/);
      if (match) {
        key = match[0];
        cursor += match[0].length;
      }
    }
    if (key === undefined) return undefined;
    path.push(key);
    whitespace();
    if (cursor === raw.length) return path;
    if (raw[cursor] !== ".") return undefined;
    cursor += 1;
    whitespace();
    if (cursor === raw.length) return undefined;
  }
  return path.length ? path : undefined;
}

function parseHeaderLine(line: string): Pick<TomlTableHeader, "kind" | "path"> | undefined {
  const text = line.trimStart();
  if (!text.startsWith("[")) return undefined;
  const kind: TomlTableHeader["kind"] = text.startsWith("[[") ? "array-table" : "table";
  const openLength = kind === "array-table" ? 2 : 1;
  const close = kind === "array-table" ? "]]" : "]";
  let string: "basic" | "literal" | undefined;
  let closeAt = -1;
  for (let cursor = openLength; cursor < text.length; cursor += 1) {
    if (string === "basic") {
      if (text[cursor] === '\"' && !isEscaped(text, cursor)) string = undefined;
      continue;
    }
    if (string === "literal") {
      if (text[cursor] === "'") string = undefined;
      continue;
    }
    if (text[cursor] === '\"') {
      string = "basic";
      continue;
    }
    if (text[cursor] === "'") {
      string = "literal";
      continue;
    }
    if (text.startsWith(close, cursor)) {
      closeAt = cursor;
      break;
    }
  }
  if (closeAt === -1) return undefined;
  const tail = text.slice(closeAt + close.length);
  if (!/^[ \t]*(?:#.*)?$/.test(tail)) return undefined;
  const path = parseDottedKey(text.slice(openLength, closeAt));
  return path ? { kind, path } : undefined;
}

/**
 * Parse table spans while preserving the original document byte-for-byte.
 * Every table owns content only until the next normal OR array-table header.
 */
export function parseTomlTableHeaders(source: string): TomlTableHeader[] {
  const parsed: Array<Omit<TomlTableHeader, "bodyEnd">> = [];
  let offset = 0;
  let multiline: MultilineString;
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const segment = match[0];
    if (!segment) break;
    const line = segment.replace(/(?:\r\n|\n|\r)$/, "");
    if (!multiline) {
      const header = parseHeaderLine(line);
      if (header) {
        parsed.push({
          ...header,
          headerStart: offset,
          bodyStart: offset + segment.length,
        });
      }
    }
    multiline = scanMultilineState(line, multiline);
    offset += segment.length;
  }
  return parsed.map((header, index) => ({
    ...header,
    bodyEnd: parsed[index + 1]?.headerStart ?? source.length,
  }));
}

function ownedBareKeys(source: string, table: TomlTableHeader): Set<string> {
  const keys = new Set<string>();
  let multiline: MultilineString;
  const body = source.slice(table.bodyStart, table.bodyEnd);
  for (const match of body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const segment = match[0];
    if (!segment) break;
    const line = segment.replace(/(?:\r\n|\n|\r)$/, "");
    if (!multiline) {
      const assignment = line.match(/^\s*((?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+))\s*=/);
      if (assignment) {
        const path = parseDottedKey(assignment[1]!);
        if (path?.length === 1) keys.add(path[0]!);
      }
    }
    multiline = scanMultilineState(line, multiline);
  }
  return keys;
}

const TOMLLIB_VALIDATE = String.raw`
import sys

try:
    import tomllib
except Exception as exc:
    sys.stderr.write("TOMLLIB_UNAVAILABLE:" + repr(exc))
    raise SystemExit(2)

try:
    source = sys.stdin.buffer.read().decode("utf-8", errors="strict")
    tomllib.loads(source)
except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
    sys.stderr.write("TOML_INVALID:" + exc.__class__.__name__ + ": " + str(exc))
    raise SystemExit(1)
`;

const TOMLLIB_VALIDATION_TIMEOUT_MS = 5_000;

/**
 * Python's isolated mode ignores PYTHON* settings itself. Removing them from
 * the child environment as well keeps project/operator configuration from even
 * reaching the validator process and makes that boundary independently
 * auditable.
 */
function isolatedPythonEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("PYTHON")),
  );
}


/**
 * Validate the exact bytes with the Python tomllib consumer used by Hermes.
 *
 * Validation is REQUIRED, not best effort. This command exists only to write a
 * file whose sole consumer is `tomllib.load()` inside the template's shell
 * library, and that consumer swallows every parse failure and silently returns
 * the caller's default (_lib.sh `config_get`). A config we could not validate
 * is therefore not a small risk: it degrades every later lookup -- hermes_bin,
 * plane workspace, item prefixes -- to a default, with no error anywhere.
 *
 * Requiring python3 costs no portability either. Every provisioning script in
 * the template drives python3 heredocs, and the config is unreadable without
 * tomllib, so a host that cannot run the validator cannot run Hermes at all.
 */
function validateTomlBytes(source: Buffer, label: string): void {
  const validation = spawnSync("python3", ["-I", "-S", "-c", TOMLLIB_VALIDATE], {
    input: source,
    encoding: "utf8",
    env: isolatedPythonEnvironment(),
    maxBuffer: 1024 * 1024,
    timeout: TOMLLIB_VALIDATION_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (validation.error) {
    const code = (validation.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error(`${label} validation timed out after ${TOMLLIB_VALIDATION_TIMEOUT_MS}ms`);
    }
    throw new Error(
      code === "ENOENT"
        ? `${label} cannot be validated: python3 with tomllib is required but was not found`
        : `${label} validation failed to start: ${validation.error.message}`,
    );
  }
  if (validation.status === 2 || validation.stderr.startsWith("TOMLLIB_UNAVAILABLE:")) {
    throw new Error(
      `${label} cannot be validated: python3 with tomllib is required (${validation.stderr.replace(/^TOMLLIB_UNAVAILABLE:/, "")})`,
    );
  }
  if (validation.status !== 0) {
    const detail = validation.stderr.replace(/^TOML_INVALID:/, "").trim() || `python3 exited ${validation.status ?? "without a status"}`;
    throw new Error(`${label} is not valid TOML 1.0 for Python tomllib: ${detail}`);
  }
}

function assertValidToml(source: string, label: string): void {
  validateTomlBytes(Buffer.from(source, "utf8"), label);
}

/**
 * Add missing pinned-schema fields without replacing operator values, comments,
 * unknown keys, or richer sections. This is intentionally a small TOML-aware
 * merge rather than a parse/stringify round trip, which would erase comments.
 *
 * The input is BYTES, deliberately, and the parameter type is the enforcement.
 * `readFileSync(path, "utf8")` replaces an invalid UTF-8 sequence with U+FFFD,
 * which is a perfectly valid TOML string character -- so a config the deployed
 * Python `tomllib` consumer cannot even decode would validate here and then be
 * rewritten with those replacement characters, silently destroying operator
 * bytes that Hermes itself would have refused to read. Validation runs on the
 * exact bytes, and the decode that follows is proved lossless before merging.
 */
export function mergeHostConfig(existingBytes: Buffer): string {
  validateTomlBytes(existingBytes, "Existing Hermes template config");
  const existing = existingBytes.toString("utf8");
  if (!Buffer.from(existing, "utf8").equals(existingBytes)) {
    // Defense in depth. The validator above decodes with errors="strict", so
    // non-UTF-8 bytes never reach this line today; keeping the check makes the
    // lossless-decode invariant local and provable at the point that depends
    // on it, instead of an assumption about another function's Python.
    throw new Error("Existing Hermes template config is not valid UTF-8");
  }
  let merged = existing;
  for (const { section, values } of hostSchema()) {
    const tables = parseTomlTableHeaders(merged);
    const matching = tables.filter((table) => table.kind === "table" && table.path.length === 1 && table.path[0] === section);
    if (matching.length > 1) {
      throw new Error(`Cannot merge [${section}]: config contains duplicate table headers`);
    }
    const table = matching[0];
    if (!table) {
      const incompatible = tables.find((candidate) => candidate.path[0] === section);
      if (incompatible) {
        throw new Error(`Cannot merge [${section}]: config defines ${incompatible.kind === "array-table" ? "an array table" : "a child table"} at [${incompatible.path.join(".")}] without an owning [${section}] table`);
      }
      const prefix = merged.length === 0 ? "" : merged.endsWith("\n") ? "\n" : "\n\n";
      merged += `${prefix}[${section}]\n${values.map(([key, value]) => `${key} = ${value}`).join("\n")}\n`;
      continue;
    }
    const existingKeys = ownedBareKeys(merged, table);
    const missing = values.filter(([key]) => !existingKeys.has(key));
    if (!missing.length) continue;
    const body = merged.slice(table.bodyStart, table.bodyEnd);
    const addition = `${body.length === 0 || body.endsWith("\n") ? "" : "\n"}${missing.map(([key, value]) => `${key} = ${value}`).join("\n")}\n`;
    merged = `${merged.slice(0, table.bodyEnd)}${addition}${merged.slice(table.bodyEnd)}`;
  }
  // Text preservation is valuable only while the result remains real TOML.
  // Dotted-key and inline-table ownership forms cannot always be extended by
  // inserting a conventional table/key assignment. Fail before the caller
  // touches disk rather than accepting a corrupt but superficially merged file.
  assertValidToml(merged, "Merged Hermes template config");
  return merged;
}

/**
 * Snapshot of an operator-owned regular config. The identity and content hash
 * are checked again immediately before rename so a concurrent writer cannot be
 * silently overwritten by an additive bootstrap prepared from stale bytes.
 */

function describePathType(stats: Stats): string {
  if (stats.isSymbolicLink()) return "symbolic link";
  if (stats.isDirectory()) return "directory";
  if (stats.isFIFO()) return "FIFO";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character device";
  if (stats.isBlockDevice()) return "block device";
  return "non-regular file";
}

/** lstat is the first operation on the config leaf, including the no-force path. */
function inspectConfigPath(path: string): Stats | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Unsafe Hermes template config path ${path}: expected a regular file, found ${describePathType(stats)}`);
  }
  return stats;
}

/**
 * Write the config through a same-directory temp file and one rename.
 *
 * rename(2) within a directory is atomic, so a reader sees either the old file
 * or the complete new one -- never a half-written config. That is the whole of
 * the durability requirement here: this command runs once per `flume hire`
 * / `flume handbook bootstrap`, sequentially, in a single process. There is no
 * concurrent writer to defend against, and inventing one cost this file 1,500
 * lines of lock/CAS/crash-recovery machinery that could wedge the command with
 * a leftover transaction directory. Do not reintroduce it: if a genuine
 * multi-writer requirement ever appears, add it with a failing test that
 * demonstrates the race first.
 */
function installConfig(path: string, next: string, previous: Stats | undefined): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.pjangler-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, next, { mode: previous ? previous.mode & 0o777 : 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the rename already failed; a leftover temp file is not worth masking it */
    }
    throw error;
  }
}

export class EnsureTemplateConfig extends Command {
  async invoke(): Promise<InvokeResult> {
    const ctx = this.context as HermesAgentContext;
    if (ctx.deferredExternalEffects && !ctx.applyingDeferredHostEffects) {
      return {
        success: true,
        outcome: "unchanged",
        message: "Hermes host config deferred until rendered lifecycle eligibility passes",
      };
    }

    const force = ctx.forceConfig === true || process.env.PJANGLER_FORCE_CONFIG === "1";
    const path = resolveTemplateConfigPath();

    let stats: Stats | undefined;
    try {
      stats = inspectConfigPath(path);
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const exists = stats !== undefined;
    if (exists && !force) {
      if (!ctx.quiet) console.log(`✓ Config present: ${path}`);
      return { success: true, outcome: "unchanged", message: `Config present: ${path}` };
    }

    let next = renderHostConfig();
    let current = "";
    try {
      if (exists) {
        // Bytes, not a lossy "utf8" decode: mergeHostConfig validates the
        // exact file the Python consumer would read and proves the decode is
        // lossless before this command is allowed to rewrite anything.
        const bytes = readFileSync(path);
        next = mergeHostConfig(bytes);
        current = bytes.toString("utf8");
      } else {
        assertValidToml(next, "Rendered Hermes template config");
      }
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to prepare ${path}; no changes were applied: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (exists && next === current) {
      return { success: true, outcome: "unchanged", message: `Config schema already current: ${path}` };
    }

    if (ctx.dryRun) {
      if (!ctx.quiet) console.log(`[DRY RUN] Would ${exists ? "merge missing schema fields into" : "create"} config: ${path}`);
      return {
        success: true,
        outcome: "planned",
        filePath: path,
        message: `[DRY RUN] Would ${exists ? "merge missing schema fields into" : "create"} config: ${path}`,
      };
    }

    try {
      installConfig(path, next, stats);
    } catch (error) {
      return {
        success: false,
        outcome: "failed",
        message: `Failed to write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!ctx.quiet) {
      console.log(`✓ ${exists ? "Updated" : "Bootstrapped"} config: ${path}`);
      if (!exists) console.log("  Review [github].runtime_repo_owner + [plane] + [bloodbank] before a cloud provision.");
    }
    return {
      success: true,
      outcome: "changed",
      filePath: path,
      message: `${exists ? "Updated" : "Bootstrapped"} config without replacing existing values: ${path}`,
    };
  }
}
