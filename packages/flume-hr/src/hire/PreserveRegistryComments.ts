import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import YAML, { type Node } from "yaml";
import { readShellAssignments } from "../kernel/paths";
import { resolveTemplateConfigPath } from "./EnsureTemplateConfig";

/** Resolve the registry used by template tasks, then pin it in their environment. */
export function copierRegistryPath(env: NodeJS.ProcessEnv): string {
  const home = homedir();
  const expand = (path: string) => path.startsWith("~/") ? join(home, path.slice(2)) : path;
  const config = resolveTemplateConfigPath();
  const fleet = (existsSync(config) ? parse(readFileSync(config, "utf8")).fleet : {}) as Record<string, string>;
  const fleetEnv = expand(env.HERMES_FLEET_ENV || fleet?.fleet_env || join(home, ".hermes", "fleet.env"));
  const assignments = readShellAssignments(fleetEnv, ["HERMES_FLEET_REGISTRY_FILE"]);
  return expand(env.REGISTRY_FILE || env.HERMES_AGENTS_REGISTRY || env.HERMES_FLEET_REGISTRY_FILE
    || assignments.HERMES_FLEET_REGISTRY_FILE || fleet?.registry_file || join(home, ".hermes", "agents-registry.yaml"));
}

function document(path: string) {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing registry symlink ${path}`);
  const doc = YAML.parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (doc.errors.length) throw doc.errors[0];
  if (!YAML.isMap(doc.contents)) throw new Error(`Registry must be a mapping: ${path}`);
  return doc;
}

/** Keep the original AST's comments while accepting every value the template wrote. */
function reconcile(previous: Node | null, current: Node | null, before: ReturnType<typeof YAML.parseDocument>, after: ReturnType<typeof YAML.parseDocument>): Node | null {
  if (YAML.isMap(previous) && YAML.isMap(current)) {
    for (const pair of [...previous.items]) {
      const key = YAML.isScalar(pair.key) ? pair.key.value : pair.key;
      if (!current.has(key)) previous.delete(key);
    }
    for (const pair of current.items) {
      const key = YAML.isScalar(pair.key) ? pair.key.value : pair.key;
      if (previous.has(key)) previous.set(key, reconcile(previous.get(key, true) as Node | null, pair.value as Node | null, before, after));
      else previous.items.push(pair);
    }
    return previous;
  }
  if (previous && current && isDeepStrictEqual(previous.toJS(before), current.toJS(after))) return previous;
  if (previous && current) {
    current.commentBefore = previous.commentBefore ?? current.commentBefore;
    current.comment = previous.comment ?? current.comment;
    current.spaceBefore = previous.spaceBefore ?? current.spaceBefore;
  }
  return current;
}

/** Copier's pinned registry writer uses PyYAML, which otherwise deletes all comments. */
export function preserveCopierRegistryComments(path: string): () => void {
  if (!existsSync(path)) return () => {};
  const before = document(path);
  return () => {
    if (!existsSync(path)) return;
    const current = document(path);
    before.contents = reconcile(before.contents, current.contents, before, current) as typeof before.contents;
    const rendered = String(before);
    if (rendered !== String(current)) writeFileSync(path, rendered, "utf8");
  };
}
