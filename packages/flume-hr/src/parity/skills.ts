import { resolve } from "node:path";
import {
  initScope,
  inspectStatus,
  readSelectionManifest,
  sync,
  type Diagnostic,
  type SyncOptions,
} from "@delorenj/skillex";
import type { AuditFinding, Context } from "./rules";

/** Every caller supplies its subject; nested cwd never changes project selection. */
export function skillCoreOptions(ctx: Context): SyncOptions & { scope: "project"; project: string } {
  return {
    cwd: resolve(ctx.repoRoot),
    project: resolve(ctx.repoRoot),
    scope: "project",
    home: ctx.homeDir,
    env: process.env,
    // Preserve the documented PJangler override while using one core resolver.
    ...(process.env.PJ_SKILLS_REGISTRY_ROOT?.trim()
      ? { registryRoot: resolve(process.env.PJ_SKILLS_REGISTRY_ROOT.trim()) }
      : {}),
  };
}

export function skillDiagnostics(findings: readonly Diagnostic[]): string[] {
  return findings.map((finding) =>
    `${finding.code}: ${finding.message}${finding.path ? ` (${finding.path})` : ""}${finding.fix ? ` — ${finding.fix}` : ""}`,
  );
}

function migrationGuidance(ctx: Context): string {
  return `Legacy selections or skill-root directories need explicit review: skillex migrate --project ${JSON.stringify(resolve(ctx.repoRoot))}. Supply a mapping for ambiguous content, then apply the reviewed migration. PJangler does not adopt foreign or installer-owned skills.`;
}

export async function auditProjectSkills(ctx: Context): Promise<AuditFinding> {
  const result = await inspectStatus(skillCoreOptions(ctx));
  const details = skillDiagnostics(result.findings);
  details.push(...(result.data?.changes ?? []).map((change) => `${change.action}: ${change.path}`));
  if (result.exit === 2 || result.exit === 3) details.push(migrationGuidance(ctx));
  return {
    id: "skills.project-manifest",
    title: "Skillex project skills",
    status: result.exit === 0 ? "pass" : result.exit === 4 ? "warn" : "fail",
    summary: result.exit === 0 ? "Skillex declaration and activation are in parity" : `Skillex inspection returned exit ${result.exit}`,
    details,
    fixable: result.exit === 0 || result.exit === 6 || result.findings.some((finding) => finding.code === "E_NO_PROJECT_MANIFEST"),
  };
}

export interface SkillSynchronization {
  ok: boolean;
  changedFiles: string[];
  details: string[];
}

/** Only the public core owns manifests, receipts, alias publication and pruning. */
export async function synchronizeProjectSkills(ctx: Context): Promise<SkillSynchronization> {
  const options = skillCoreOptions(ctx);
  const changedFiles: string[] = [];
  if (ctx.acceptRegistryMatches) return { ok: false, changedFiles,
    details: ["--accept-registry-matches is retired. " + migrationGuidance(ctx)] };
  const details: string[] = [];
  try {
    const declaration = await readSelectionManifest(options.project);
    if (!declaration.exists) {
      const initialized = await initScope({ ...options, dryRun: Boolean(ctx.dryRun) });
      details.push(...skillDiagnostics(initialized.findings));
      changedFiles.push(...(ctx.dryRun ? initialized.data?.changes ?? [] : initialized.data?.applied ?? []).map((change) => change.path));
      if (!initialized.ok) return { ok: false, changedFiles, details };
      // init is deliberately manifest-only. A preview cannot fabricate a saved
      // manifest for sync; show this boundary explicitly and never write it.
      if (ctx.dryRun) {
        details.push("Create the initial project manifest, then reconcile its global inheritance with the public core.");
        return { ok: true, changedFiles: [...new Set(changedFiles)], details };
      }
    }
    const result = await sync({ ...options, dryRun: Boolean(ctx.dryRun) });
    const changes = ctx.dryRun ? result.data?.changes : result.data?.applied;
    changedFiles.push(...(changes ?? []).map((change) => change.path));
    details.push(...skillDiagnostics(result.findings));
    if (!result.ok) details.push(migrationGuidance(ctx));
    return { ok: result.ok, changedFiles: [...new Set(changedFiles)], details };
  } catch (error) {
    const findings = error && typeof error === "object" && "findings" in error
      ? (error as { findings: readonly Diagnostic[] }).findings
      : [];
    details.push(...skillDiagnostics(findings));
    if (!findings.length) details.push(error instanceof Error ? error.message : String(error));
    details.push(migrationGuidance(ctx));
    return { ok: false, changedFiles, details };
  }
}
