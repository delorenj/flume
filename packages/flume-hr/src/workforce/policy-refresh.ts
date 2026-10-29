import { chmodSync, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { canonicalPolicy, policySection, START, END } from "../../../../scripts/lib/scheduling-policy.mjs";
import { SOUL_COMPOSED_MARKER } from "../parity/rules";
import { withRegistryLock } from "./role";
import { withFileLock } from "../kernel/file-lock";
import { resolveFlumeRoot } from "../kernel/paths";
import { refreshSpecialistSchedulingPolicy } from "./specialist";

export const policyDigest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
/** No descendant symlinks, even links that stay inside the declared owner. */
export function policySafe(path: string, directory = false): void {
  let cursor = resolve(path);
  while (true) {
    const info = lstatSync(cursor);
    if (cursor === resolve(path) && !directory && info.nlink !== 1) throw new Error(`Ambiguous hard-linked policy ownership: ${path}`);
    if (info.isSymbolicLink() || (cursor !== resolve(path) && !info.isDirectory())) throw new Error(`Unsafe policy path: ${cursor}`);
    if (cursor === resolve(path) && !(directory ? info.isDirectory() : info.isFile())) throw new Error(`Not a regular ${directory ? "directory" : "file"}: ${cursor}`);
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function policyRead(path: string): string {
  const bytes = readFileSync(path), text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text, "utf8"))) throw new Error(`Non-UTF8 policy surface: ${path}; refusing a lossy rewrite`);
  return text;
}
function document(path: string): any {
  policySafe(path);
  const doc = YAML.parseDocument(policyRead(path), { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message);
  const value = doc.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected mapping: ${path}`);
  return value;
}
/** Replace only the bounded section; old composer output has one stable insertion seam. */
export function repositoryPolicyBytes(bytes: string, role: string, policy: string): string {
  const marker = `<!-- ${SOUL_COMPOSED_MARKER}${role}.md. Edit the ROLE, not this file:`;
  if (bytes.split(SOUL_COMPOSED_MARKER).length !== 2 || !bytes.split("\n").includes(marker)) throw new Error("Handwritten or conflicting composer ownership; owner must reconcile the authored SOUL, not use scaffold remediation");
  if (bytes.includes(START) || bytes.includes(END)) {
    const old = policySection(bytes); return bytes.slice(0, bytes.indexOf(START)) + policy + bytes.slice(bytes.indexOf(START) + old.length);
  }
  const seam = "\n## Role-specific behavior\n";
  if (bytes.split(seam).length !== 2) throw new Error("Missing or ambiguous composer policy insertion seam");
  return bytes.replace(seam, policy + seam);
}
interface Change { path: string; before: string; after: string; mode: number }
/** Stage all bytes first, then publish with optimistic preconditions and rollback on caught failure. */
function publish(changes: Change[]): void {
  const staged = changes.map(c => ({ ...c, temp: join(dirname(c.path), `.flume-policy-${randomUUID()}.tmp`) }));
  const published: typeof staged = [];
  try {
    for (const c of staged) {
      policySafe(c.path);
      if (readFileSync(c.path, "utf8") !== c.before) throw new Error(`Concurrent edit: ${c.path}`);
      writeFileSync(c.temp, c.after, { flag: "wx", mode: c.mode }); chmodSync(c.temp, c.mode);
    }
    for (const c of staged) {
      policySafe(c.path);
      if (readFileSync(c.path, "utf8") !== c.before) throw new Error(`Concurrent edit: ${c.path}`);
      renameSync(c.temp, c.path); published.push(c);
    }
  } catch (error) {
    for (const c of published.reverse()) {
      policySafe(c.path);
      if (readFileSync(c.path, "utf8") !== c.after) throw new Error(`Rollback conflict: ${c.path}; ${String(error)}`);
      writeFileSync(c.temp, c.before, { flag: "wx", mode: c.mode }); chmodSync(c.temp, c.mode); renameSync(c.temp, c.path);
    }
    throw error;
  } finally { for (const c of staged) rmSync(c.temp, { force: true }); }
}
function repositoryPlan(id: string, row: any, fleetHome: string, policy: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(row.role || "")) throw new Error("Unsafe role identity");
  if (!isAbsolute(row.role_dir || "") || !isAbsolute(row.project_path || "")) throw new Error("Missing absolute role_dir/project_path; no owner inferred");
  const roleDir = resolve(row.role_dir), manifest = join(roleDir, "role.yaml");
  policySafe(roleDir, true);
  const role = document(manifest);
  if (role.agent_id !== id || role.profile !== row.profile_name || role.role !== row.role || role.repo !== row.repo) throw new Error("Registry and role.yaml ownership conflict");
  if (roleDir !== join(resolve(row.project_path), "agents/hermes", row.role)) throw new Error("Role directory outside declared project role");
  const profile = join(resolve(fleetHome), "profiles", row.profile_name);
  policySafe(profile, true);
  const tracked = join(roleDir, "SOUL.md"), runtime = join(roleDir, "runtime/SOUL.md"), loaded = join(profile, "SOUL.md");
  policySafe(tracked); policySafe(runtime);
  const link = lstatSync(loaded);
  for (const path of [tracked, runtime, ...(link.isSymbolicLink() ? [] : [loaded])]) {
    if (lstatSync(path).nlink !== 1) throw new Error(`Ambiguous hard-linked policy ownership: ${path}`);
  }
  if (link.isSymbolicLink()) {
    if (resolve(dirname(loaded), readlinkSync(loaded)) !== runtime) throw new Error("Profile SOUL link escapes its declared runtime owner");
  } else policySafe(loaded);
  const paths = [...new Set([tracked, runtime, ...(link.isSymbolicLink() ? [] : [loaded])])];
  const plans = paths.map(path => {
    const before = policyRead(path), after = repositoryPolicyBytes(before, row.role, policy);
    for (const [key, wanted] of [["Agent ID", id], ["Profile", row.profile_name], ["Role", row.role]]) {
      const prefix = `| ${key} | `, lines = before.split("\n").filter(line => line.startsWith(prefix));
      if (lines.length !== 1 || lines[0] !== `${prefix}\`${wanted}\` |`) throw new Error(`SOUL identity ownership conflict: ${key} at ${path}`);
    }
    return { path, before, after, mode: lstatSync(path).mode & 0o777 };
  });
  return { profile, manifest, plans, loaded, link: link.isSymbolicLink() ? readlinkSync(loaded) : null };
}
export interface PolicyRefreshOptions { apply?: boolean; registry?: string; fleetHome?: string; home?: string; flumeRoot?: string }
export async function refreshSchedulingPolicy(options: PolicyRefreshOptions = {}) {
  const home = options.home || process.env.HOME || homedir();
  const fleetHome = options.fleetHome || process.env.HERMES_FLEET_HOME || join(home, ".hermes");
  const registry = options.registry || process.env.HERMES_AGENTS_REGISTRY || process.env.HERMES_FLEET_REGISTRY_FILE || join(fleetHome, "agents-registry.yaml");
  const policy = canonicalPolicy(options.flumeRoot || resolveFlumeRoot());
  policySafe(registry);
  const run = async () => {
    const agents = document(registry).agents;
    if (!agents || typeof agents !== "object" || Array.isArray(agents) || !Object.keys(agents).length) throw new Error("Non-empty agents mapping required");
    const duplicates = new Set<string>();
    for (const key of ["profile_name", "role_dir", "definition_path"]) {
      const owners = new Map<string, string>();
      for (const [id, row] of Object.entries(agents) as [string, any][]) {
        const raw = row?.[key]; if (!raw) continue;
        const value = key === "profile_name" ? raw : (typeof raw === "string" ? resolve(raw) : raw);
        if (owners.has(value)) { duplicates.add(id); duplicates.add(owners.get(value)!); } else owners.set(value, id);
      }
    }
    const rows: any[] = [];
    for (const [id, row] of Object.entries(agents) as [string, any][]) {
      const result: any = { id, status: "refused", changed_files: [], files: [] }; rows.push(result);
      try {
        if (duplicates.has(id)) throw new Error("Duplicate registry ownership");
        if (!row || typeof row !== "object" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(row.profile_name || "")) throw new Error("Invalid profile identity");
        const loaded = join(resolve(fleetHome), "profiles", row.profile_name, "SOUL.md");
        if (!existsSync(loaded)) { result.status = "missing"; result.detail = id === "delonet-company-reporter" ? "Missing profile SOUL; existing FLUME-67 owns provisioning, not policy refresh" : "Missing profile SOUL; no provisioning attempted"; continue; }
        if (row.employment === "portable-specialist") {
          const portable = await refreshSpecialistSchedulingPolicy(id, row, !options.apply, { home, fleetHome, registry });
          Object.assign(result, portable, { status: portable.changed.length ? (options.apply ? "changed" : "would-change") : "current", changed_files: portable.changed });
          continue;
        }
        const execute = async () => {
          const plan = repositoryPlan(id, row, fleetHome, policy);
          Object.assign(result, { owner_source: plan.manifest, profile_soul: plan.loaded, profile_link: plan.link });
          const changes = plan.plans.filter(c => c.before !== c.after);
          if (options.apply) publish(changes);
          for (const c of plan.plans) {
            const seen = readFileSync(c.path, "utf8");
            if (options.apply && seen !== c.after) throw new Error(`Readback differs: ${c.path}`);
            result.files.push({ path: c.path, before_sha256: policyDigest(c.before), after_sha256: policyDigest(c.after), readback_sha256: policyDigest(seen), nonpolicy_bytes_preserved: true });
          }
          result.status = changes.length ? (options.apply ? "changed" : "would-change") : "current";
          result.changed_files = changes.map(c => c.path);
          result.owner_source = plan.manifest; result.profile_soul = plan.loaded; result.profile_link = plan.link;
          if (options.apply && policySection(readFileSync(plan.loaded, "utf8")) !== policy) throw new Error("Loaded profile policy readback differs");
        };
        if (options.apply) {
          const profile = join(resolve(fleetHome), "profiles", row.profile_name); policySafe(profile, true);
          const lock = join(dirname(profile), `.${row.profile_name}.config.lock`);
          if (existsSync(lock) || (() => { try { return lstatSync(lock).isSymbolicLink(); } catch { return false; } })()) policySafe(lock);
          await withFileLock(lock, execute);
        } else await execute();
      } catch (error) { result.status = "refused"; result.detail = (error as Error).message; }
    }
    const counts = Object.fromEntries(["changed", "would-change", "current", "refused", "missing"].map(s => [s, rows.filter(r => r.status === s).length]));
    return { ok: !counts.refused && !counts.missing, apply: Boolean(options.apply), policy_source: "roles/_base.md", policy_sha256: policyDigest(policy), audited: rows.length, counts, changed_file_count: rows.reduce((n, r) => n + r.changed_files.length, 0), running_sessions_reloaded: false, runtime_schedules_assessed: false, rows };
  };
  return options.apply ? withRegistryLock(registry, run) : run();
}
