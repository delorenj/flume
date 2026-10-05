import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { isDeepStrictEqual } from "node:util";
import { showProfile } from "@delorenj/skillex";
import { resolveFlumeRoot } from "../kernel/paths";
import { copierFleetPaths, updateRegistryDocumentUnlocked } from "../hire/PreserveRegistryComments";
import { provisionDesk, resolveDeskPath } from "./desk";
import { readRoleIdentity } from "./identity";
import { withRegistryLock } from "./role";
import { applyRoleSelection, auditRoleSelection, planRoleSelection, previewRoleSelection, type SelectionContext } from "./selection";
import { validateNamedAgent } from "./validator";

const EMPLOYMENT = "portable-specialist";
const MARKER = ".flume-specialist.json";
export interface SpecialistOptions { dryRun?: boolean }

function stat(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Check every ancestor too: a regular leaf behind a source symlink is unsafe. */
function safe(path: string, directory = false): void {
  const full = resolve(path);
  let cursor = full;
  while (true) {
    const info = stat(cursor);
    if (info?.isSymbolicLink()) throw new Error(`Unsafe symlink: ${cursor}`);
    if (cursor !== full && info && !info.isDirectory()) throw new Error(`Unsafe parent: ${cursor}`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const info = stat(full);
  if (info && !(directory ? info.isDirectory() : info.isFile())) throw new Error(`Unsafe ${directory ? "directory" : "file"}: ${full}`);
}
function registry(path: string) {
  safe(path);
  const doc = YAML.parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "schema_version: 1\nagents: {}\n", { uniqueKeys: true });
  if (doc.errors.length || !YAML.isMap(doc.contents) || !YAML.isMap(doc.get("agents", true))) throw new Error("Registry must contain a valid agents mapping");
  return doc.toJS().agents as Record<string, any>;
}
function write(path: string, bytes: string) {
  safe(path);
  if (existsSync(path) && readFileSync(path, "utf8") === bytes) return false;
  const temporary = join(dirname(path), `.specialist-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
  return true;
}
function environment() {
  const home = process.env.HOME || homedir();
  const hermesRoot = resolve(process.env.HERMES_FLEET_HOME || join(home, ".hermes"));
  const { registryPath, fleetBin } = copierFleetPaths({ ...process.env, HOME: home });
  const selection: SelectionContext = { home, hermesRoot, skillexRoot: process.env.PJ_SKILLS_REGISTRY_ROOT || join(home, "code/skillex"), stateHome: process.env.XDG_STATE_HOME || join(home, ".local/state") };
  return { home, hermesRoot, registryPath, fleetBin, selection };
}
async function prepare(definitionPath: string) {
  const p = environment();
  const source = resolve(definitionPath);
  safe(source);
  const bytes = readFileSync(source, "utf8");
  const definition = await validateNamedAgent(bytes, { home: p.home, skillexRoot: p.selection.skillexRoot });
  const desk = resolveDeskPath(definition, { home: p.home });
  const expected = join(p.home, ".agents/workforce", definition.id);
  if (resolve(desk) !== resolve(expected)) throw new Error(`Portable specialist desk must be ${expected}`);
  // The owning desk exposes canonical links; profile configuration owns the
  // persistent global inheritance policy used by normal-home Skillex callers.
  safe(join(desk, ".agents/skills.json"));
  if (existsSync(join(desk, ".agents/skills.json"))) throw new Error("Specialist desk cannot carry a global activation manifest");
  const profile = join(p.hermesRoot, "profiles", definition.id);
  for (const path of [desk, profile, join(desk, ".agents"), join(desk, ".agents/skills"), join(profile, ".skillex-selection"), join(profile, ".skillex-selection/.agents")]) safe(path, true);
  for (const path of [p.registryPath, join(desk, MARKER), join(desk, "agent.yaml"), join(desk, "contract.yaml"), join(profile, ".skillex-selection/.agents/skills.json")]) safe(path);
  if (stat(join(profile, ".agents"))) throw new Error("Strict specialist profile cannot have a .agents discovery root");
  const plan = await planRoleSelection(profile, definition.skills, p.selection);
  const identity = readRoleIdentity(YAML.stringify({ identity: { name: definition.id, ...definition.memory } }), "", "");
  if (identity.state !== "named") throw new Error("Invalid specialist memory identity");
  if (definition.identity) {
    const other = readRoleIdentity(YAML.stringify({ identity: definition.identity }), "", "");
    if (other.state !== "named" || !isDeepStrictEqual(other, identity)) throw new Error("identity and memory disagree");
  }
  return { ...p, definition, bytes, source, desk, profile, plan, identity };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
function projection(p: Prepared, check: boolean) {
  const adapter = join(resolveFlumeRoot(), "templates/hermes-agent/scripts/hermes-specialist-profile.py");
  const run = spawnSync("python3", [adapter, ...(check ? ["--check"] : [])], {
    input: JSON.stringify({ ...p.definition, definition: join(p.desk, "agent.yaml") }), encoding: "utf8", timeout: 35_000,
    env: { ...process.env, HERMES_FLEET_HOME: p.hermesRoot, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (run.error || run.status !== 0) throw new Error(run.error?.message || run.stderr.trim() || "Specialist profile projection failed");
  return JSON.parse(run.stdout) as { changed: string[]; write_bank: string; recall_banks: string[] };
}
function row(p: Prepared) {
  return { employment: EMPLOYMENT, definition_path: join(p.desk, "agent.yaml"), desk_path: p.desk,
    identity: p.definition.id, profile_name: p.definition.id, display_name: p.definition.display_name,
    role: p.definition.role, type: "hermes", hindsight: { write_bank: p.identity.writeBank, recall_banks: p.identity.recallBanks } };
}
function ownership(p: Prepared, hire: boolean) {
  const rows = registry(p.registryPath);
  const existing = rows[p.definition.id];
  const markerPath = join(p.desk, MARKER);
  const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : undefined;
  if (hire) {
    if (stat(p.desk) || stat(p.profile) || existing || Object.values(rows).some((r: any) => r?.identity === p.definition.id || r?.profile_name === p.definition.id)) throw new Error(`Occupied employee identity: ${p.definition.id}`);
    return;
  }
  if (!marker || marker.id !== p.definition.id || marker.definition !== join(p.desk, "agent.yaml")) throw new Error("Desk ownership conflict: hire the definition first");
  if (existing && (existing.employment !== EMPLOYMENT || existing.definition_path !== marker.definition || existing.profile_name !== p.definition.id || existing.identity !== p.definition.id || existing.repo || existing.project_path)) throw new Error("Registry ownership conflict");
  if (!existing && marker.status !== "pending") throw new Error("Owned employee record is missing");
  for (const name of existsSync(join(p.desk, ".agents/skills")) ? readdirSync(join(p.desk, ".agents/skills")) : []) {
    if (name.startsWith(".")) continue;
    const path = join(p.desk, ".agents/skills", name);
    if (!stat(path)?.isSymbolicLink() || readlinkSync(path) !== marker.skills?.[name]) throw new Error(`Desk skill ownership conflict: ${name}`);
  }
}

async function profileOwnership(p: Prepared): Promise<void> {
  if (!existsSync(p.profile) || !existsSync(join(p.profile, "skills"))) return;
  const shown = await showProfile(p.definition.id, { ...p.selection, project: p.plan.project, skillexOnly: true });
  if (!shown.ok) throw new Error(`Profile skill ownership refused: ${shown.findings.map(f => `${f.code}: ${f.message}`).join("; ")}`);
}

/** Hire is exclusive; onboard reconciles the same owned definition. */
export async function hireSpecialist(definitionPath: string, onboard = false, options: SpecialistOptions = {}) {
  const initial = await prepare(definitionPath); // Invalid catalog/paths refuse before lock creation or publication.
  const apply = async () => {
    const p = await prepare(definitionPath);
    ownership(p, !onboard);
    const preview = projection(p, true);
    await profileOwnership(p);
    if (options.dryRun) return { ok: true, dryRun: true, id: p.definition.id, desk: p.desk, profile: p.profile, projection: preview, selection: await previewRoleSelection(p.definition.id, p.plan, p.selection) };
    let started = false;
    try {
      mkdirSync(p.desk, { recursive: true });
      started = true;
      const markerPath = join(p.desk, MARKER);
      const oldMarker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : {};
      const desiredSkills = Object.fromEntries(p.plan.skills.map(s => [s.name, s.path]));
      const marker = { id: p.definition.id, definition: join(p.desk, "agent.yaml"), skills: desiredSkills, status: "pending" };
      // A reservation makes interrupted projection explicitly recoverable through onboard.
      const deskPreview = await provisionDesk(p.definition, { home: p.home, resolvedSkills: p.plan.skills, dryRun: true, quiet: true });
      const changedDefinition = !existsSync(join(p.desk, "agent.yaml")) || readFileSync(join(p.desk, "agent.yaml"), "utf8") !== p.bytes;
      if (!existsSync(markerPath) || changedDefinition || preview.changed.length || deskPreview.created + deskPreview.updated + deskPreview.removed) {
        write(markerPath, JSON.stringify({ ...marker, skills: { ...oldMarker.skills, ...desiredSkills } }, null, 2) + "\n");
      }
      const definitionChanged = write(join(p.desk, "agent.yaml"), p.bytes);
      const desk = await provisionDesk(p.definition, { home: p.home, resolvedSkills: p.plan.skills, quiet: true });
      const profile = projection(p, false);
      const selection = await applyRoleSelection(p.definition.id, p.plan, p.selection);
      const record = row(p);
      const recordChanged = updateRegistryDocumentUnlocked(p.registryPath, doc => {
        const current = doc.toJS().agents[p.definition.id] ?? {};
        for (const [key, value] of Object.entries(record)) {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            for (const [leaf, wanted] of Object.entries(value)) {
              if (!isDeepStrictEqual(current[key]?.[leaf], wanted)) doc.setIn(["agents", p.definition.id, key, leaf], wanted);
            }
          } else if (!isDeepStrictEqual(current[key], value)) doc.setIn(["agents", p.definition.id, key], value);
        }
        if (current.bloodbank?.enabled !== false) doc.setIn(["agents", p.definition.id, "bloodbank", "enabled"], false);
      });
      write(markerPath, JSON.stringify({ ...marker, status: "complete" }, null, 2) + "\n");
      return { ok: true, id: p.definition.id, desk: p.desk, profile: p.profile, write_bank: p.identity.writeBank, recall_banks: p.identity.recallBanks,
        skills: p.plan.skills.map(s => s.name), changed: definitionChanged || recordChanged || profile.changed.length > 0 || desk.created + desk.updated + desk.removed > 0 || selection.manifestChanged || selection.applied.length > 0, projection: profile, selection };
    } catch (error) {
      throw new Error(`${started ? "Partial specialist projection; inspect owned state and retry onboard" : "Specialist refused before projection"}: ${(error as Error).message}`);
    }
  };
  return options.dryRun ? apply() : withRegistryLock(initial.registryPath, apply);
}

export async function auditSpecialist(employee: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,57}$/u.test(employee)) throw new Error("Unsafe employee identity");
  const { home } = environment();
  const p = await prepare(join(home, ".agents/workforce", employee, "agent.yaml"));
  ownership(p, false);
  const config = projection(p, true);
  const problems = [...config.changed.map(file => `Profile projection differs: ${file}`), ...await auditRoleSelection(employee, p.profile, p.definition.skills, p.selection)];
  for (const skill of p.plan.skills) {
    const link = join(p.desk, ".agents/skills", skill.name);
    if (!stat(link)?.isSymbolicLink() || readlinkSync(link) !== skill.path) problems.push(`Desk skill differs: ${skill.name}`);
  }
  const current = registry(p.registryPath)[employee];
  for (const [key, value] of Object.entries(row(p))) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [leaf, wanted] of Object.entries(value)) if (!isDeepStrictEqual(current?.[key]?.[leaf], wanted)) problems.push(`Record differs: ${key}.${leaf}`);
    } else if (!isDeepStrictEqual(current?.[key], value)) problems.push(`Record differs: ${key}`);
  }
  if (current?.bloodbank?.enabled !== false) problems.push("Portable specialist must have Bloodbank disabled");
  return { ok: problems.length === 0, id: employee, standing: problems.length ? "on notice" : "in good standing", problems, desk: p.desk, profile: p.profile, write_bank: p.identity.writeBank, recall_banks: p.identity.recallBanks, skills: p.plan.skills.map(s => s.name) };
}

/** No chdir, no sticky profile switch, no inherited/global inference credential. */
export async function launchSpecialist(employee: string, args: string[], cwd = process.cwd()): Promise<number> {
  const audited = await auditSpecialist(employee);
  if (!audited.ok) throw new Error(`Specialist launch refused: ${audited.problems.join("; ")}`);
  if (args.some(arg => /^(?:--(?:profile|api-key|base-url|provider)(?:=|$)|-p)/u.test(arg))) throw new Error("Specialist launcher refuses profile or inference overrides");
  const runtime = environment().fleetBin || "hermes";
  if (runtime !== "hermes") {
    try {
      if (!isAbsolute(runtime) || !lstatSync(runtime).isFile()) throw new Error("invalid pin");
      accessSync(runtime, constants.X_OK);
    } catch { throw new Error(`Deployment dependency: declared Hermes runtime unavailable: ${runtime}`); }
  }
  const reference = `op://DeLoSecrets/hermes-${employee}/credential`;
  const access = spawnSync("op", ["read", reference], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  if (access.error || access.status !== 0 || !access.stdout.trim()) throw new Error(`Deployment dependency: employee member token unavailable at ${reference} (FLUME-39)`);
  const env = { ...process.env, HERMES_HOME: audited.profile, AUTOMATICAI_GATEWAY_KEY: access.stdout.trim() };
  // Explicit profile config owns provider routing; inherited fallback keys cannot answer for it.
  for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "HERMES_API_KEY", "HERMES_BASE_URL", "HERMES_MODEL", "LLM_MODEL", "HERMES_PROVIDER"]) delete (env as NodeJS.ProcessEnv)[key];
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(runtime, ["--profile", employee, ...args], { cwd: resolve(cwd), env, stdio: "inherit" });
    child.once("error", () => reject(new Error("Deployment dependency: Hermes CLI runtime unavailable")));
    child.once("close", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}
