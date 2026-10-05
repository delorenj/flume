import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import YAML, { type Node } from "yaml";
import { resolveFlumeRoot } from "../kernel/paths";
import { withRegistryLock } from "../workforce/role";
import { resolveTemplateConfigPath } from "./EnsureTemplateConfig";

// Delegate grammar, validation and existing-variable precedence to the same
// trusted loader/parser the template runs. Only registry paths leave the child.
const FLEET_REGISTRY_ENV = String.raw`
builtin source "$1"
load_fleet_environment "$2" "$3" || exit 1
python3 -I -c 'import json, os; print(json.dumps({k: os.environ.get(k) for k in ("REGISTRY_FILE", "HERMES_FLEET_REGISTRY_FILE")}))'
`;

/** Resolve the registry used by template tasks, then pin it in their environment. */
export function copierRegistryPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir();
  const expand = (path: string) => path.startsWith("~/") ? join(home, path.slice(2)) : path;
  const config = env.HERMES_TEMPLATE_CONFIG || resolveTemplateConfigPath();
  const fleet = (existsSync(config) ? parse(readFileSync(config, "utf8")).fleet : {}) as Record<string, unknown> | undefined;
  const configPath = (key: string): string | undefined => {
    const value = fleet?.[key];
    if (value !== undefined && typeof value !== "string") throw new Error(`fleet.${key} must be a path string`);
    return value as string | undefined;
  };
  const fleetEnv = expand(env.HERMES_FLEET_ENV || configPath("fleet_env") || join(home, ".hermes", "fleet.env"));
  const library = join(resolveFlumeRoot(), "templates/hermes-agent/template/.scripts/lib");
  const parsed = spawnSync("bash", ["--noprofile", "--norc", "-p", "-c", FLEET_REGISTRY_ENV,
    "flume-registry-env", join(library, "fleet-env.sh"), fleetEnv, join(library, "parse-fleet-env.py")],
    { encoding: "utf8", env, timeout: 5_000, maxBuffer: 1024 * 1024 });
  if (parsed.error || parsed.status !== 0) throw new Error(`Fleet environment: ${parsed.error?.message || parsed.stderr.trim() || `loader exited ${parsed.status}`}`);
  const effective = JSON.parse(parsed.stdout) as Record<string, string | undefined>;
  return expand(effective.REGISTRY_FILE || env.HERMES_AGENTS_REGISTRY || effective.HERMES_FLEET_REGISTRY_FILE
    || configPath("registry_file") || join(home, ".hermes", "agents-registry.yaml"));
}

function document(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular registry ${path}`);
  const source = readFileSync(path, "utf8");
  const doc = YAML.parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw doc.errors[0];
  if (!YAML.isMap(doc.contents)) throw new Error(`Registry must be a mapping: ${path}`);
  doc.toJS(); // Refuse unresolved aliases before any publication.
  return { doc, source, mode: stat.mode & 0o777 };
}

function comments(previous: string | null | undefined, current: string | null | undefined): string | null {
  if (!previous || previous === current) return current || previous || null;
  if (!current) return previous;
  // Keep the latest block verbatim, including repeated lines. Append the old
  // block only when it is not already present as complete comment lines.
  return `\n${current}\n`.includes(`\n${previous}\n`) ? current : `${current}\n${previous}`;
}

/** Transfer metadata only. Never move nodes or anchors between documents. */
function transfer(previous: Node | null, current: Node | null, before: ReturnType<typeof YAML.parseDocument>, after: ReturnType<typeof YAML.parseDocument>): void {
  if (!previous || !current) return;
  current.commentBefore = comments(previous.commentBefore, current.commentBefore);
  current.comment = comments(previous.comment, current.comment);
  current.spaceBefore = current.spaceBefore || previous.spaceBefore;
  if (YAML.isMap(previous) && YAML.isMap(current)) {
    for (const pair of current.items) {
      const old = previous.items.find(candidate => isDeepStrictEqual(
        (candidate.key as Node | null)?.toJS(before), (pair.key as Node | null)?.toJS(after)));
      if (!old) continue;
      transfer(old.key as Node | null, pair.key as Node | null, before, after);
      transfer(old.value as Node | null, pair.value as Node | null, before, after);
    }
  } else if (YAML.isSeq(previous) && YAML.isSeq(current)) {
    const remaining = [...previous.items] as Array<Node | null>;
    for (const item of current.items as Array<Node | null>) {
      const index = remaining.findIndex(candidate => isDeepStrictEqual(candidate?.toJS(before), item?.toJS(after)));
      if (index < 0) continue;
      transfer(remaining.splice(index, 1)[0]!, item, before, after);
    }
  }
}

function publish(path: string, rendered: string, mode: number): void {
  const temporary = join(dirname(path), `.${basename(path)}.comments-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, rendered, "utf8");
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

/** Copier releases its lock before restoration acquires the same lock. */
export async function preserveCopierRegistryComments(path: string): Promise<() => Promise<void>> {
  const before = await withRegistryLock(path, async () => existsSync(path) ? document(path).doc : undefined);
  return async () => {
    if (!before) return;
    await withRegistryLock(path, async () => {
      if (!existsSync(path)) return;
      const latest = document(path);
      latest.doc.commentBefore = comments(before.commentBefore, latest.doc.commentBefore);
      latest.doc.comment = comments(before.comment, latest.doc.comment);
      transfer(before.contents, latest.doc.contents, before, latest.doc);
      const rendered = String(latest.doc);
      if (rendered !== latest.source) publish(path, rendered, latest.mode);
    });
  };
}
