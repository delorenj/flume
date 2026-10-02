import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SkillexError,
  parseManifest,
  readSelectionManifest,
  showProfile,
  syncProfile,
  withLock,
  writeSelectionManifest,
  type Diagnostic,
  type LockOptions,
  type ProfileOptions,
} from "@delorenj/skillex";
import { registryRootOption, skillDiagnostics } from "../parity/skills";
import { NamedAgentValidationError, resolveSkillLoadout } from "./validator";
import type { AgentSkillsBinding, ResolvedSkill } from "./types";

/**
 * A role's skills loadout is delivered as a Skillex SELECTION and nothing else.
 *
 * Skillex alone decides a strict desk's `skills/`: the desk is the union of the
 * global selection and one explicit project selection (`skillex profile sync
 * NAME --project PATH --skillex-only`). A role that declares a loadout therefore
 * owns a small project of its own: `<desk>/.skillex-selection/.agents/skills.json`,
 * generated from the role file and naming exactly the declared set or pack. The
 * desk never receives a second skill core: no `<desk>/.agents/skills` symlink farm
 * and no `skills.external_dirs` entry, both of which a Skillex-only desk refuses.
 *
 * The project is deliberately outside `<desk>/skills` (Skillex's overlap rule keeps
 * the projection target and its sources apart) and inside the desk, so it is
 * created, backed up and offboarded with the employee it describes. Skillex
 * records it as the desk's project in its profile receipt, which is how every
 * later `skillex profile show NAME` finds it without being told.
 */
export const ROLE_SELECTION_DIR = ".skillex-selection";

export interface RoleSelectionManifest {
  readonly inherit_global: false;
  readonly sets?: readonly string[];
  readonly packs?: readonly string[];
}

export interface SelectionContext {
  /** Hermes root whose `profiles/<name>` directories are the desks. */
  hermesRoot: string;
  /** Skillex catalog checkout. Defaults to PJ_SKILLS_REGISTRY_ROOT, then ~/code/skillex. */
  skillexRoot?: string;
  home?: string;
  /** XDG state home that holds Skillex's profile receipts and locks. */
  stateHome?: string;
}

export interface RoleSelectionPlan {
  /** The Skillex project that carries the role's selection. */
  readonly project: string;
  readonly manifestPath: string;
  readonly manifest: RoleSelectionManifest;
  /** The loadout as the Skillex catalog resolves it. */
  readonly skills: ResolvedSkill[];
}

export function roleSelectionProject(deskPath: string): string {
  return join(deskPath, ROLE_SELECTION_DIR);
}

function selectionError(message: string, field: string, code = "E_ROLE_SELECTION"): NamedAgentValidationError {
  return new NamedAgentValidationError(message, [{ field, message, code }]);
}

/**
 * One role loadout is exactly one Skillex selection. A pack is an exclusive
 * complete loadout (a manifest permits at most one, and it leaves every set
 * dormant), so a declaration Skillex cannot express as a single selection is
 * refused by name instead of being flattened or silently narrowed.
 */
export function roleSelectionManifest(binding: AgentSkillsBinding): RoleSelectionManifest {
  const packs = [...new Set([...(binding.pack ? [binding.pack] : []), ...(binding.packs ?? [])])];
  if (packs.length > 1) {
    throw selectionError(`skills declares ${packs.length} packs (${packs.join(", ")}): a Skillex pack is an exclusive complete loadout, so a role selects at most one; compose several with a set`, "skills.packs");
  }
  if (packs.length === 1 && binding.set) {
    throw selectionError(`skills declares pack ${packs[0]} and set ${binding.set}: a Skillex pack is an exclusive complete loadout and would leave the set dormant; declare one of them`, "skills.set");
  }
  const manifest: RoleSelectionManifest | undefined = packs.length
    ? { inherit_global: false, packs }
    : binding.set ? { inherit_global: false, sets: [binding.set] } : undefined;
  if (!manifest) throw selectionError("skills must declare a Skillex pack or set", "skills");
  try {
    parseManifest(manifest, "role skills declaration");
  } catch (error) {
    if (!(error instanceof SkillexError)) throw error;
    throw new NamedAgentValidationError(
      `skills is not a valid Skillex selection: ${error.findings.map(finding => finding.message).join("; ")}`,
      error.findings.map(finding => ({ field: "skills", message: finding.message, code: finding.code })),
    );
  }
  return manifest;
}

function context(ctx: SelectionContext) {
  const home = ctx.home ?? homedir();
  const registry = ctx.skillexRoot?.trim() ? { registryRoot: ctx.skillexRoot } : registryRootOption(home);
  const lock: LockOptions = { home, ...(ctx.stateHome ? { stateHome: ctx.stateHome } : {}) };
  const profile: ProfileOptions = { ...lock, hermesRoot: ctx.hermesRoot, ...registry };
  return { home, registry, lock, profile };
}

/**
 * The loadout as the live Skillex catalog resolves it. This is the resolver the
 * named-agent contract uses: a pack or set naming a skill the catalog does not
 * own fails here, by name, instead of being dropped.
 */
export async function resolveRoleLoadout(binding: AgentSkillsBinding, ctx: SelectionContext): Promise<ResolvedSkill[]> {
  const { home, registry } = context(ctx);
  return resolveSkillLoadout(binding, { skillexRoot: registry.registryRoot, home });
}

/** Validate the declaration against the live Skillex catalog and name the selection that carries it. */
export async function planRoleSelection(deskPath: string, binding: AgentSkillsBinding, ctx: SelectionContext): Promise<RoleSelectionPlan> {
  const manifest = roleSelectionManifest(binding);
  const skills = await resolveRoleLoadout(binding, ctx);
  const project = roleSelectionProject(deskPath);
  return { project, manifestPath: join(project, ".agents", "skills.json"), manifest, skills };
}

function describe(findings: readonly Diagnostic[]): string {
  return skillDiagnostics(findings).join("; ");
}

function realDirectory(path: string, label: string): void {
  const info = lstatOrNull(path);
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`${label} must be a real directory: ${path}`);
}

function lstatOrNull(path: string) {
  try { return lstatSync(path); } catch { return null; }
}

/** Publish the selection through Skillex's own manifest writer. Returns whether the declaration changed. */
async function writeSelection(plan: RoleSelectionPlan, ctx: SelectionContext): Promise<boolean> {
  const { lock } = context(ctx);
  realDirectory(plan.project, "role selection project");
  mkdirSync(plan.project, { recursive: true });
  return withLock("skillex:activation:v2", async () => {
    const snapshot = await readSelectionManifest(plan.project);
    const wanted = parseManifest(plan.manifest, snapshot.path);
    if (snapshot.exists && isDeepStrictEqual(snapshot.manifest, wanted)) return false;
    await writeSelectionManifest(snapshot, plan.manifest as unknown as Record<string, unknown>);
    return true;
  }, lock);
}

// Hermes' own bookkeeping inside a strict skills root (mirrors Skillex's strict policy): never a skill.
const BOOKKEEPING_FILES = new Set([".usage.json", ".usage.json.lock", ".curator_state", ".curator_suppressed", ".sync_state"]);
const BOOKKEEPING_DIRS = new Set([".curator_backups"]);

/**
 * Refuse, before anything changes, a desk that is not Skillex-only yet holds local skills. The discovery
 * pin that precedes the strict sync would otherwise cut such a desk's skill roots and then fail, leaving it
 * half converted. A legacy desk converts through Skillex's preservation-first cutover, never here.
 */
export async function preflightRoleSelection(profile: string, deskPath: string, ctx: SelectionContext): Promise<void> {
  if (!existsSync(join(deskPath, "skills")) || regularFile(join(deskPath, ".skillex-only"))) return;
  const { profile: options } = context(ctx);
  const observed = await showProfile(profile, options);
  if (observed.exit === 3 || !observed.data) {
    throw new Error(`Skillex cannot take over ${profile}'s skills (exit ${observed.exit}): ${describe(observed.findings)}; nothing was changed`);
  }
  const foreign = observed.data.preserved.filter(item => !(item.kind === "file" && BOOKKEEPING_FILES.has(item.name)) && !(item.kind === "directory" && BOOKKEEPING_DIRS.has(item.name)));
  if (foreign.length) {
    throw new Error(`${profile} is not Skillex-only and holds local skills (${foreign.map(item => item.name).join(", ")}); convert it with ~/code/skillex/scripts/hermes-skillex-cutover.py against its owning project (preview, then --apply) before it can take a role loadout; nothing was changed`);
  }
}

export interface RoleSelectionResult {
  project: string;
  manifestChanged: boolean;
  /** Profile entries Skillex created, updated or pruned to converge the desk. */
  applied: string[];
}

/**
 * Write the selection and let Skillex project it into the strict desk. Foreign
 * content in the desk's `skills/` is refused, never adopted or deleted (the
 * desk must already be, or be created as, Skillex-only).
 */
export async function applyRoleSelection(profile: string, plan: RoleSelectionPlan, ctx: SelectionContext): Promise<RoleSelectionResult> {
  const { profile: options } = context(ctx);
  let manifestChanged: boolean;
  try {
    manifestChanged = await writeSelection(plan, ctx);
  } catch (error) {
    // A held activation lock or an unsafe .agents path surfaces as Skillex findings, not a message.
    if (error instanceof SkillexError) throw new Error(`Skillex could not save the role selection for ${profile} (exit ${error.exit}): ${describe(error.findings)}`);
    throw error;
  }
  const synced = await syncProfile(profile, { ...options, project: plan.project, skillexOnly: true });
  if (!synced.ok) throw new Error(`Skillex refused the role selection for ${profile} (exit ${synced.exit}): ${describe(synced.findings)}`);
  // Convergence proof: a second observation must plan nothing.
  const shown = await showProfile(profile, { ...options, project: plan.project });
  const pending = shown.data?.changes ?? [];
  if (!shown.ok || pending.length) {
    throw new Error(`Skillex did not converge ${profile} on its role selection (exit ${shown.exit}): ${describe(shown.findings)} ${pending.map(change => `${change.action} ${change.path}`).join("; ")}`.trim());
  }
  return { project: plan.project, manifestChanged, applied: (synced.data?.applied ?? []).map(change => `${change.action}${change.name ? ` ${change.name}` : ""}`) };
}

export interface RoleSelectionPreview {
  project: string;
  manifest: RoleSelectionManifest;
  manifestChange: "create" | "update" | "none";
  /** Skillex's planned profile changes; only known once the declaration is already saved. */
  changes: string[] | null;
}

/** Read-only: what applyRoleSelection would do. */
export async function previewRoleSelection(profile: string, plan: RoleSelectionPlan, ctx: SelectionContext): Promise<RoleSelectionPreview> {
  const { profile: options } = context(ctx);
  let manifestChange: RoleSelectionPreview["manifestChange"] = "create";
  try {
    const snapshot = await readSelectionManifest(plan.project);
    manifestChange = !snapshot.exists ? "create" : isDeepStrictEqual(snapshot.manifest, parseManifest(plan.manifest, snapshot.path)) ? "none" : "update";
  } catch (error) {
    if (!(error instanceof SkillexError)) throw error;
  }
  let changes: string[] | null = null;
  if (manifestChange === "none" && existsSync(join(ctx.hermesRoot, "profiles", profile))) {
    const planned = await syncProfile(profile, { ...options, project: plan.project, skillexOnly: true, dryRun: true });
    if (!planned.ok) throw new Error(`Skillex refused the role selection for ${profile} (exit ${planned.exit}): ${describe(planned.findings)}`);
    changes = (planned.data?.changes ?? []).map(change => `${change.action} ${change.path}`);
  }
  return { project: plan.project, manifest: plan.manifest, manifestChange, changes };
}

function regularFile(path: string): boolean {
  const info = lstatOrNull(path);
  return Boolean(info?.isFile());
}

/**
 * The audit half: every problem, by name, between a role's declaration and its
 * desk. Empty means the desk is exactly what Skillex resolves from the role.
 */
export async function auditRoleSelection(profile: string, deskPath: string, binding: AgentSkillsBinding, ctx: SelectionContext): Promise<string[]> {
  const problems: string[] = [];
  let plan: RoleSelectionPlan;
  try {
    plan = await planRoleSelection(deskPath, binding, ctx);
  } catch (error) {
    return [`${profile}: skills loadout does not resolve: ${(error as Error).message}`];
  }
  if (!existsSync(deskPath)) return [`${profile}: desk missing: ${deskPath}`];
  if (!regularFile(join(deskPath, ".skillex-only"))) {
    problems.push(`${profile}: declares a skills loadout but is not Skillex-only (no regular .skillex-only marker); flume onboard publishes it, or convert a legacy desk first with ~/code/skillex/scripts/hermes-skillex-cutover.py against its owning project (preview, then --apply)`);
  }
  if (lstatOrNull(join(deskPath, ".agents", "skills"))) {
    problems.push(`${profile}: ${join(deskPath, ".agents", "skills")} is a legacy role skill projection (a second skill core a Skillex-only desk refuses); remove it and re-run flume onboard`);
  }
  try {
    const snapshot = await readSelectionManifest(plan.project);
    if (!snapshot.exists) problems.push(`${profile}: role selection manifest missing at ${plan.manifestPath}; run flume onboard`);
    else if (!isDeepStrictEqual(snapshot.manifest, parseManifest(plan.manifest, snapshot.path))) {
      problems.push(`${profile}: role selection manifest ${plan.manifestPath} differs from the declaration (${JSON.stringify(plan.manifest)}); run flume onboard`);
    }
  } catch (error) {
    problems.push(`${profile}: role selection manifest unreadable at ${plan.manifestPath}: ${error instanceof SkillexError ? describe(error.findings) : (error as Error).message}`);
    return problems;
  }
  const { profile: options } = context(ctx);
  const shown = await showProfile(profile, { ...options, project: plan.project });
  problems.push(...skillDiagnostics(shown.findings).map(detail => `${profile}: ${detail}`));
  for (const change of shown.data?.changes ?? []) problems.push(`${profile}: profile skills ${change.action}: ${change.path}`);
  const managed = new Map((shown.data?.managed ?? []).map(candidate => [candidate.name, candidate]));
  for (const skill of plan.skills) {
    if (!managed.has(skill.name)) problems.push(`${profile}: loadout skill ${skill.name} is absent from the desk's Skillex projection`);
  }
  return problems;
}
