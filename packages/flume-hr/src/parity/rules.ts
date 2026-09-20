import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, copyFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { bold, dim, green, red, yellow, gray, glyph, statusStyle, joinDot } from "../utils/style";
import { blobId as scaffoldBlobId, compareAssets as compareScaffoldAssets, renderTemplate as renderScaffoldTemplate, type ScaffoldDesiredAsset, type ScaffoldObservedAsset } from "../scaffold/compare";
import { skillDiagnostics, skillCoreOptions } from "./skills";
import { showProfile, syncProfile } from "@delorenj/skillex";


/**
 * BMAD is NOT a Skillex pack.
 *
 * pjangler used to pin a frozen `packs/bmad/<version>` in the Skillex registry
 * and project it into `.agents/skills/bmad-*` as symlinks. That was a mirror of
 * something `bmad-method` already does natively: `bmad-method install` writes
 * its skills into `.agents/skills/bmad-*` and into each `--tools` root itself,
 * per repo, versioned by `_bmad/_config/manifest.yaml`.
 *
 * Two sources of truth for the same files is a bug waiting for one of them to
 * move, and on 2026-08-18 one did: the registry dropped `packs/bmad`, and every
 * machine without a warm cache lost `pjangler project create`.
 *
 * BMAD is now owned end to end by the external `bmad-method` npm package, and
 * pjangler's BMAD rules are a wrapper around it: install it, keep it current,
 * keep its CLI projections configured. `packs[]` still exists for real Skillex
 * packs; `bmad` is no longer special to it in any way.
 */

export type RuleStatus = "pass" | "fail" | "warn" | "skip";


export interface AuditFinding {
  id: string;
  title: string;
  status: RuleStatus;
  summary: string;
  details: string[];
  fixable: boolean;
  /**
   * PJAN-84: "project" (the repo can fix it, and a failure gates the repo) or
   * "host" (this machine's shared state — reported, never gating). Absent means
   * "project".
   */
  scope?: "project" | "host";
}


export interface AuditReport {
  repo: string;
  /** Is the audited PROJECT in parity? Host findings never affect this. */
  ok: boolean;
  /** Is this machine's shared state healthy? Reported separately, never gating. */
  hostOk?: boolean;
  auditedAt: string;
  rules: AuditFinding[];
}


export interface MigrationRuleResult {
  id: string;
  title: string;
  status: "applied" | "noop" | "blocked" | "skipped" | "partial";
  summary: string;
  changedFiles: string[];
  details: string[];
}


export interface MigrationReport {
  repo: string;
  dryRun: boolean;
  ok: boolean;
  selectedRules: string[];
  results: MigrationRuleResult[];
  changedFiles: string[];
}


interface RoleMeta {
  role: string;
  roleDir: string;
  roleYamlPath: string;
  repo: string;
  agentId: string;
  profileName: string;
  displayName: string;
  purpose: string;
  botHandle: string;
  runtimeRepo: string;
  runtimeOwner: string;
  planeWorkspace: string;
  ticketProviderName: string;
  ticketProviderBoardId: string;
  ticketProviderIdentifier: string;
  bloodbankEnabled: string;
  deploymentSystemd: string;
  serviceStateGateway: string;
  serviceStateHeartbeat: string;
  legacyReconcileEnabled: string;
  legacyReconcileGraceHours: string;
  legacyReconcileAutoReview: string;
  legacyScrumGraceHours: string;
  legacyScrumAutoReview: string;
}


export interface Context {
  repoRoot: string;
  dryRun: boolean;
  pjanglerRoot: string;
  homeDir: string;
  /** Exact BMAD package version used by an in-flight fresh-project transaction. */
  bmadVersionPin?: string;
  // PJAN-28: opt-in gate for mapping legacy committed skills into
  // .agents/skills.json. Absent/false => migrate only REPORTS the proposal.
  acceptRegistryMatches?: boolean;
}


export interface RecipeOwnedCheck {
  id: string;
  title: string;
  /**
   * PJAN-84: "host" for a rule about this MACHINE's shared state, which the
   * audited repository cannot change. Absent means "project". See
   * LifecycleScope in src/recipes/types.ts.
   */
  scope?: "project" | "host";
  audit: (ctx: Context) => AuditFinding | Promise<AuditFinding>;
  migrate: (ctx: Context, finding: AuditFinding) => MigrationRuleResult | Promise<MigrationRuleResult>;
}


function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}


function readText(path: string): string {
  return normalizeNewlines(readFileSync(path, "utf8"));
}


function safeReadText(path: string): string | null {
  return existsSync(path) ? readText(path) : null;
}


function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}


function writeText(path: string, content: string): void {
  ensureParent(path);
  writeFileSync(path, content);
}


function tryParseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}


function yamlGet(text: string, keyPath: string): string {
  const parts = keyPath.split(".");
  const lines = text.split("\n");
  let start = 0;
  let indent = 0;
  for (let idx = 0; idx < parts.length; idx += 1) {
    const key = parts[idx]!;
    let found = false;
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = line.match(/^(\s*)([^:#]+):\s*(.*)$/);
      if (!match) continue;
      const currentIndent = match[1]!.length;
      const currentKey = match[2]!.trim();
      const rest = match[3]!.trim();
      if (idx > 0 && currentIndent < indent) break;
      if (currentIndent !== indent || currentKey !== key) continue;
      found = true;
      if (idx === parts.length - 1) {
        return rest.replace(/^['"]|['"]$/g, "").trim();
      }
      start = i + 1;
      indent = currentIndent + 2;
      break;
    }
    if (!found) return "";
  }
  return "";
}


function discoverRoles(repoRoot: string): RoleMeta[] {
  const rolesDir = join(repoRoot, "agents", "hermes");
  if (!existsSync(rolesDir)) return [];
  return readdirSync(rolesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const roleDir = join(rolesDir, entry.name);
      const roleYamlPath = join(roleDir, "role.yaml");
      if (!existsSync(roleYamlPath)) return null;
      const text = readText(roleYamlPath);
      const runtimeRepoRaw = yamlGet(text, "runtime.github_repo");
      return {
        role: yamlGet(text, "role") || entry.name,
        roleDir,
        roleYamlPath,
        repo: yamlGet(text, "repo"),
        agentId: yamlGet(text, "agent_id"),
        profileName: yamlGet(text, "profile") || yamlGet(text, "agent_id"),
        displayName: yamlGet(text, "display_name"),
        purpose: yamlGet(text, "purpose"),
        botHandle: yamlGet(text, "telegram.bot_username"),
        runtimeRepo: runtimeRepoRaw.includes("/") ? runtimeRepoRaw.split("/").slice(-1)[0] ?? runtimeRepoRaw : runtimeRepoRaw,
        runtimeOwner: yamlGet(text, "runtime.github_owner"),
        planeWorkspace: yamlGet(text, "ticket_provider.workspace") || yamlGet(text, "plane.workspace"),
        ticketProviderName: yamlGet(text, "ticket_provider.name"),
        ticketProviderBoardId: yamlGet(text, "ticket_provider.board_id"),
        ticketProviderIdentifier: yamlGet(text, "plane.identifier"),
        bloodbankEnabled: yamlGet(text, "bloodbank.enabled"),
        deploymentSystemd: yamlGet(text, "deployment.systemd"),
        serviceStateGateway: yamlGet(text, "service_state.gateway"),
        serviceStateHeartbeat: yamlGet(text, "service_state.heartbeat"),
        legacyReconcileEnabled: yamlGet(text, "reconcile.enabled"),
        legacyReconcileGraceHours: yamlGet(text, "reconcile.grace_hours"),
        legacyReconcileAutoReview: yamlGet(text, "reconcile.auto_review"),
        legacyScrumGraceHours: yamlGet(text, "scrum_master.grace_hours"),
        legacyScrumAutoReview: yamlGet(text, "scrum_master.auto_review"),
      } satisfies RoleMeta;
    })
    .filter((value): value is RoleMeta => Boolean(value));
}


function registryPath(homeDir: string): string {
  return join(homeDir, ".hermes", "agents-registry.yaml");
}


// Retired per-agent command-ingress contract. The fleet-shared Bloodbank
// gateway owns command routing (registry `gateways.bloodbank`, routed by
// data.target_agent_id); per-agent consumer units and checkpoint timers are
// legacy. This constant is the ONLY place the legacy key names may appear —
// tests/fleet-shared-bloodbank-regressions.mjs enforces that scoping so the
// legacy contract can be detected and cleaned but never provisioned again.
const LEGACY_SYSTEMD_KEYS = ["consumer_unit", "checkpoint_timer"] as const;


function legacyConsumerUnitPath(homeDir: string, agentId: string): string {
  return join(homeDir, ".config", "systemd", "user", `hermes-${agentId}-consumer.service`);
}


function systemctlUser(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}


function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}



function isContainedBy(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
}



function atomicWriteBuffer(path: string, content: Buffer, mode: number, temporary: string): void {
  writeFileSync(temporary, content, { flag: "wx" });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}


function readProjectJson(ctx: Context): Record<string, unknown> | null {
  return tryParseJson(safeReadText(join(ctx.repoRoot, ".project.json")));
}


interface DeclaredAgentEntry {
  agentId: string;
  role?: string;
  roleDir?: string;
  extras: Record<string, unknown>;
}


function readDeclaredAgents(ctx: Context): DeclaredAgentEntry[] {
  const project = readProjectJson(ctx);
  const agents = project?.agents as Record<string, unknown> | undefined;
  if (!agents || typeof agents !== "object") return [];
  return Object.entries(agents).map(([agentId, value]) => {
    const entry = (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}) as Record<string, unknown>;
    return {
      agentId,
      role: typeof entry.role === "string" ? entry.role : undefined,
      roleDir: typeof entry.role_dir === "string" ? entry.role_dir : undefined,
      extras: Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "role" && key !== "role_dir")),
    };
  });
}


/**
 * True when a declared/registered agent has no `role.yaml` behind it -- i.e.
 * the role is unprovisioned or half-provisioned rather than merely drifted.
 *
 * PJAN-75: this predicate is deliberately SHARED between `sot.project-json`
 * and `hermes.registry-parity`. Those two rules used to test the same
 * condition independently and reach opposite conclusions: registry-parity
 * called it a non-fixable blocker ("provision or restore the role, do not
 * delete its registry/declaration") while project-json quietly deleted the
 * declaration as invalid. A single `migrate --all` therefore destroyed the
 * only repo-local record of an agent's identity AND still left the audit
 * failing, because the fleet registry entry it could not see survived.
 *
 * An empty/missing role_dir counts as unprovisioned for the same reason: there
 * is nothing on disk to recover the identity from, so the declaration is all
 * that is left of it.
 */
function declaredRoleIsUnprovisioned(repoRoot: string, roleDir: string | undefined): boolean {
  if (!roleDir) return true;
  return !existsSync(join(resolve(repoRoot, roleDir), "role.yaml"));
}


function renderSoul(role: RoleMeta): string {
  const telegram = role.botHandle ? `@${role.botHandle}` : "(unwired)";
  const tone = role.role === "pm"
    ? "Direct and brief. Decision-forward. No throat-clearing, no apologies, no \"I'll help you with that\" preambles."
    : "Direct and brief.";
  const roleSpecific = role.role === "pm"
    ? `You are the project manager. You triage incoming work, create or refine tickets, and delegate implementation. You do not ship product code. A systemd heartbeat checks runtime health. Board work reaches you as a command on the Bloodbank gateway, not on a timer.`
    : `You operate as the ${role.role} agent for this repo.`;
  return `# ${role.displayName || role.agentId}\n\nYou are **${role.displayName || role.agentId}** — a Hermes agent provisioned to work inside the\n\`${role.repo}\` repository.\n\n## Identity\n\n| | |\n| --- | --- |\n| Agent ID | \`${role.agentId}\` |\n| Profile | \`${role.profileName || role.agentId}\` |\n| Repo | \`${role.repo}\` |\n| Role | \`${role.role}\` |\n| Telegram | \`${telegram}\` |\n| Purpose | ${role.purpose || `${role.role} agent for ${role.repo}`} |\n\n## Scope\n\nYou operate only within the working directory of \`${role.repo}\`. HERMES_HOME is the real named profile at \`~/.hermes/profiles/${role.profileName || role.agentId}\`; shared config/auth/skills remain linked to fleet truth while owned state lives in ignored \`./runtime/\`. The launcher supplies the project root through process-local \`TERMINAL_CWD\` and never persists it into shared config.\n\n## Tone\n\n${tone}\n\n## Role-specific behavior\n\n${roleSpecific}\n\n## Memory hygiene\n\nYour memory is stored locally at \`./runtime/memories/\`. Use durable memory deliberately and keep \`memories/MEMORY.md\` current.\n`;
}


/**
 * The one renderer, shared with the fleet scaffold observer.
 *
 * Simple `{{ name }}` substitution only. A template that has grown control
 * flow in a rendered asset is refused here rather than written half-rendered
 * into a deployed role, which is what the regex replacement it replaces would
 * have done.
 */
function renderScaffoldAsset(templateRoleDir: string, jinjaRel: string, inputs: Record<string, string | null>): string {
  const result = renderScaffoldTemplate(readText(join(templateRoleDir, jinjaRel)), inputs);
  if (!result.ok) throw new Error(`${jinjaRel}: ${result.detail}`);
  return result.text;
}


function renderHermesWrapper(role: RoleMeta, templateRoleDir: string): string {
  return renderScaffoldAsset(templateRoleDir, "hermes.jinja", { agent_id: role.agentId });
}


/** The render inputs the sentinel prompt takes, with the rule's historical fallbacks. */
function sentinelPromptInputs(role: RoleMeta): Record<string, string | null> {
  return {
    agent_id: role.agentId,
    role: role.role,
    target_repo: role.repo,
    display_name: role.displayName || role.agentId,
    ticket_provider: role.ticketProviderName || "plane",
  };
}


/**
 * Whether the hermes-agent template ever shipped exactly these bytes.
 *
 * `blobId` is git's own digest — sha1 over `blob <len>\0` — so one
 * `cat-file -e` against the template's object database decides
 * stale-versus-modified without the async lineage probe the fleet observer
 * uses. Answers `true` (the historical "stale" reading, and the behaviour of
 * every release before this) whenever that database is unavailable: an
 * npm-installed pjangler ships `templates/` as plain files with no git dir, so
 * a packaged install is unchanged. Failing closed matters — calling an
 * undecidable file "locally-modified" would make `migrate` skip a genuinely
 * stale script and quietly stop repairing it.
 */
function templateLineageProbe(templateRoot: string): (blobId: string) => boolean {
  const seen = new Map<string, boolean>();
  let usable: boolean | null = null;
  return (id) => {
    if (!id) return true;
    const memo = seen.get(id);
    if (memo !== undefined) return memo;
    if (usable === null) {
      // `rev-parse` answers for the nearest enclosing repository, so a plain
      // copy of the template nested inside some other checkout would silently
      // probe THAT repository's objects and find none of the template's --
      // reporting every file as locally-modified. Require the checkout found
      // to be the template itself.
      let root: string | null = null;
      try { root = realpathSync(templateRoot); } catch { root = null; }
      const top = spawnSync("git", ["-C", templateRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      let found: string | null = null;
      if (top.status === 0) { try { found = realpathSync(top.stdout.trim()); } catch { found = null; } }
      usable = root !== null && found !== null && root === found;
    }
    if (!usable) return true;
    const hit = spawnSync("git", ["-C", templateRoot, "cat-file", "-e", id], { encoding: "utf8" }).status === 0;
    seen.set(id, hit);
    return hit;
  };
}


/** Whether the file at `path` holds bytes the template never shipped — somebody's edit, not staleness. */
function scaffoldLocallyModified(path: string, inLineage: (blobId: string) => boolean): boolean {
  const seen = observeScaffoldAsset(path);
  return seen.present && seen.blobId !== null && !inLineage(seen.blobId);
}


/** What is on disk at one owned path, by `lstat`. Filesystem only; lineage is decided separately. */
function observeScaffoldAsset(path: string): ScaffoldObservedAsset {
  const seen: ScaffoldObservedAsset = { present: false, type: null, executable: false, blobId: null, unsafeSymlink: false, unreadable: null, wip: false };
  try {
    const stat = lstatSync(path);
    seen.present = true;
    if (stat.isSymbolicLink()) {
      seen.type = "symlink";
      seen.blobId = scaffoldBlobId(Buffer.from(readlinkSync(path), "utf8"));
    } else if (stat.isDirectory()) {
      seen.type = "directory";
    } else if (stat.isFile()) {
      seen.type = "file";
      seen.executable = (stat.mode & 0o111) !== 0;
      try { seen.blobId = scaffoldBlobId(readFileSync(path)); } catch { seen.unreadable = "unreadable"; }
    } else {
      seen.type = "other";
    }
  } catch {
    // absent
  }
  return seen;
}


/**
 * The desired asset set the audit compares, read from the template WORKTREE
 * through the filesystem -- this rule stays filesystem-only (`mcp-server.ts`
 * relies on it) and the fleet observer is the one that reads git objects.
 *
 * The asset set is the rule's historical one: verbatim `.scripts/**` minus the
 * rendered prompt, rendered `hermes`, `.gitignore` and `.scripts/sentinel.prompt.md`,
 * and presence of `role.yaml`, `SOUL.md` and `.runtime-scaffold/README.md`.
 * Bytes, not normalised text: the comparison is the shared core's.
 */
function scaffoldDesiredForRule(role: RoleMeta, templateRoleDir: string, managedScripts: readonly string[]): ScaffoldDesiredAsset[] {
  const desired: ScaffoldDesiredAsset[] = [];
  const asset = (path: string, blob: string | null, incomplete: ScaffoldDesiredAsset["incomplete"] = null, presenceOnly = false): void => {
    desired.push({ path, type: "file", executable: false, blobId: blob, presenceOnly, incomplete });
  };
  for (const rel of ["role.yaml", "SOUL.md", ".runtime-scaffold/README.md"]) asset(rel, null, null, true);
  const rendered = (path: string, jinjaRel: string, inputs: Record<string, string | null>): void => {
    const source = join(templateRoleDir, jinjaRel);
    if (!existsSync(source)) { asset(path, null, { reason: "render-unsupported", detail: `render-unsupported: ${jinjaRel} is absent from the template` }); return; }
    const result = renderScaffoldTemplate(readFileSync(source).toString("utf8"), inputs);
    if (!result.ok) { asset(path, null, { reason: result.reason, detail: result.detail }); return; }
    asset(path, scaffoldBlobId(Buffer.from(result.text, "utf8")));
  };
  rendered("hermes", "hermes.jinja", { agent_id: role.agentId });
  rendered(".gitignore", ".gitignore.jinja", { role: role.role });
  for (const rel of managedScripts) asset(`.scripts/${rel}`, scaffoldBlobId(readFileSync(join(templateRoleDir, ".scripts", rel))));
  rendered(".scripts/sentinel.prompt.md", ".scripts/sentinel.prompt.md.jinja", sentinelPromptInputs(role));
  return desired;
}


function templateFiles(sourceDir: string, current = sourceDir): string[] {
  if (!existsSync(current)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) continue;
    const sourcePath = join(current, entry.name);
    if (entry.isDirectory()) files.push(...templateFiles(sourceDir, sourcePath));
    else if (entry.isFile()) files.push(relative(sourceDir, sourcePath));
  }
  return files.sort();
}


function managedHermesScaffoldRoles(ctx: Context): { roles: RoleMeta[]; blockers: string[] } {
  const discovered = discoverRoles(ctx.repoRoot);
  const declared = readDeclaredAgents(ctx)
    .filter((entry) => entry.role === "pm" || entry.role === "director");
  if (declared.length === 0) {
    const orchestrators = discovered.filter((role) => role.role === "pm" || role.role === "director");
    const blockers = orchestrators
      .filter((role) => roleBloodbankEnabled(role) === null)
      .map((role) => `${relative(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`);
    return {
      roles: orchestrators.filter((role) => roleBloodbankEnabled(role) !== null),
      blockers,
    };
  }

  const roles: RoleMeta[] = [];
  const blockers: string[] = [];
  for (const entry of declared) {
    if (!entry.roleDir) {
      blockers.push(`agents.${entry.agentId}.role_dir missing`);
      continue;
    }
    const roleDir = resolve(ctx.repoRoot, entry.roleDir);
    if (!isContainedBy(ctx.repoRoot, roleDir)) {
      blockers.push(`agents.${entry.agentId}.role_dir resolves outside the project`);
      continue;
    }
    const role = discovered.find((candidate) => resolve(candidate.roleDir) === roleDir);
    if (!role) {
      blockers.push(`agents.${entry.agentId}.role_dir ${entry.roleDir} missing role.yaml`);
      continue;
    }
    if (role.agentId !== entry.agentId || role.role !== entry.role) {
      blockers.push(`agents.${entry.agentId} identity does not match ${entry.roleDir}/role.yaml`);
      continue;
    }
    if (roleBloodbankEnabled(role) === null) {
      blockers.push(`${entry.roleDir}/role.yaml bloodbank.enabled must be the strict YAML boolean true or false`);
      continue;
    }
    roles.push(role);
  }
  return { roles, blockers };
}


function renderSentinelPrompt(role: RoleMeta, templateRoleDir: string): string {
  return renderScaffoldAsset(templateRoleDir, join(".scripts", "sentinel.prompt.md.jinja"), sentinelPromptInputs(role));
}


function copyMissingRecursive(sourceDir: string, targetDir: string, changedFiles: string[], dryRun: boolean, skip?: (source: string) => boolean): void {
  if (!existsSync(sourceDir)) return;
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    if (skip?.(sourcePath)) continue;
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingRecursive(sourcePath, targetPath, changedFiles, dryRun, skip);
      continue;
    }
    if (existsSync(targetPath)) continue;
    changedFiles.push(targetPath);
    if (!dryRun) {
      ensureParent(targetPath);
      copyFileSync(sourcePath, targetPath);
    }
  }
}


function runtimeSubmodulePath(repoRoot: string, role: RoleMeta): string | null {
  const rolePath = relative(repoRoot, role.roleDir).replace(/\\/g, "/");
  if (!/^agents\/hermes\/[^/]+$/.test(rolePath)) return null;
  return `${rolePath}/runtime`;
}


function submoduleSectionHasPath(section: string, targetPath: string): boolean {
  return section
    .split(/\r?\n/)
    .some((line) => /^\s*path\s*=/.test(line) && line.replace(/^\s*path\s*=\s*/, "").trim() === targetPath);
}


function hasRuntimeSubmoduleMapping(repoRoot: string, role: RoleMeta): boolean {
  const gitmodulesPath = join(repoRoot, ".gitmodules");
  const current = safeReadText(gitmodulesPath) ?? "";
  const sections = current.match(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm) ?? [];
  const targetPath = runtimeSubmodulePath(repoRoot, role);
  return Boolean(targetPath && sections.some((section) => submoduleSectionHasPath(section, targetPath)));
}


function removeRuntimeSubmoduleMapping(repoRoot: string, role: RoleMeta, changedFiles: string[], dryRun: boolean): string[] {
  const gitmodulesPath = join(repoRoot, ".gitmodules");
  const current = safeReadText(gitmodulesPath) ?? "";
  if (!hasRuntimeSubmoduleMapping(repoRoot, role)) return [];
  const targetPath = runtimeSubmodulePath(repoRoot, role);
  if (!targetPath) return [];
  const next = current
    .replace(/^\[submodule "[^"\n]+"\][\s\S]*?(?=^\[submodule "|(?![\s\S]))/gm, (section) =>
      submoduleSectionHasPath(section, targetPath) ? "" : section)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  changedFiles.push(gitmodulesPath);
  if (!dryRun) writeText(gitmodulesPath, next ? `${next}\n` : "");
  return [gitmodulesPath];
}


interface RuntimeRetirementResult {
  ok: boolean;
  details: string[];
  error?: string;
}


function retireRuntimeSubmodule(
  repoRoot: string,
  role: RoleMeta,
  changedFiles: string[],
  dryRun: boolean,
): RuntimeRetirementResult {
  const runtimePath = runtimeSubmodulePath(repoRoot, role);
  if (!runtimePath) {
    return { ok: false, details: [], error: `refusing unsafe runtime path for ${role.roleDir}` };
  }
  const probe = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    return { ok: false, details: [], error: `failed to inspect runtime index at ${runtimePath}: ${probe.stderr.trim() || `exit ${probe.status}`}` };
  }

  const details: string[] = [];
  if (probe.stdout.trim()) {
    details.push(`untrack ${runtimePath}`);
    if (dryRun) {
      changedFiles.push(runtimePath);
    } else {
      const removal = spawnSync("git", ["rm", "--cached", "-r", "-f", "--", runtimePath], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (removal.status !== 0) {
        return { ok: false, details, error: `failed to untrack ${runtimePath}: ${removal.stderr.trim() || `exit ${removal.status}`}` };
      }
      const verification = spawnSync("git", ["ls-files", "--stage", "--", runtimePath], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (verification.status !== 0 || verification.stdout.trim()) {
        return {
          ok: false,
          details,
          error: verification.status !== 0
            ? `failed to verify untracked runtime ${runtimePath}: ${verification.stderr.trim() || `exit ${verification.status}`}`
            : `runtime remains tracked after index-only removal: ${runtimePath}`,
        };
      }
      changedFiles.push(runtimePath);
    }
  }

  if (hasRuntimeSubmoduleMapping(repoRoot, role)) {
    details.push(`remove stale .gitmodules mapping for ${runtimePath}`);
    removeRuntimeSubmoduleMapping(repoRoot, role, changedFiles, dryRun);
  }
  return { ok: true, details };
}


function upsertRegistryEntry(role: RoleMeta, homeDir: string, changedFiles: string[], dryRun: boolean): string | null {
  const path = registryPath(homeDir);
  const current = safeReadText(path) ?? "# Hermes agent fleet registry.\n# One entry per provisioned agent. Managed by hermes-agent-template/.scripts/80-registry.sh.\nschema_version: 1\nagents: {}\n";
  if (current.includes(`${role.agentId}:`)) return null;
  const enabled = roleBloodbankEnabled(role);
  if (enabled === null) return null;
  const block = `  ${role.agentId}:\n    repo: ${role.repo}\n    role: ${role.role}\n    type: hermes\n    display_name: ${JSON.stringify(role.displayName || role.agentId)}\n    project_path: ${ctxEscape(role.roleDir ? dirname(dirname(dirname(role.roleDir))) : "")}\n    role_dir: ${ctxEscape(role.roleDir)}\n    profile_name: ${role.profileName || role.agentId}\n    telegram:\n      bot_username: ${ctxEscape(role.botHandle)}\n    plane:\n      workspace: ${ctxEscape(role.planeWorkspace)}\n      project_id: ${ctxEscape(role.ticketProviderBoardId)}\n      identifier: ${ctxEscape(role.ticketProviderIdentifier)}\n    runtime_repo: ${ctxEscape(role.runtimeRepo)}\n    bloodbank:\n      enabled: ${enabled ? "true" : "false"}\n      gateway_scope: fleet\n      target_agent_id: ${role.agentId}\n    systemd:\n      gateway_unit: hermes-${role.agentId}-gateway.service\n      heartbeat_timer: hermes-${role.agentId}-heartbeat.timer\n`;
  const next = current.includes("agents: {}") ? current.replace("agents: {}", `agents:\n${block}`) : `${current.replace(/\s*$/, "\n")}${block}`;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}


function roleBloodbankEnabled(role: RoleMeta): boolean | null {
  if (role.bloodbankEnabled === "" || role.bloodbankEnabled === "false") return false;
  if (role.bloodbankEnabled === "true") return true;
  return null;
}


function profileMetaInheritsDefault(path: string): boolean {
  const text = safeReadText(path);
  return Boolean(
    text &&
      /^config:\s*$/m.test(text) &&
      /^\s+inherit_from:\s*default\s*$/m.test(text) &&
      /^\s+save_mode:\s*delta\s*$/m.test(text)
  );
}


function upsertInheritedProfileMeta(path: string, changedFiles: string[], dryRun: boolean): string | null {
  const current = safeReadText(path) ?? "";
  const lines = current.split("\n");
  let next: string;
  const start = lines.findIndex((line) => /^config:\s*$/.test(line));

  if (!current.trim()) {
    next = "config:\n  inherit_from: default\n  save_mode: delta\n";
  } else if (start === -1) {
    next = `${current.replace(/\s*$/, "\n")}config:\n  inherit_from: default\n  save_mode: delta\n`;
  } else {
    let end = start + 1;
    while (end < lines.length && !/^[^#\s][^:]*:\s*/.test(lines[end] ?? "")) end++;

    let hasInherit = false;
    let hasSave = false;
    for (let idx = start + 1; idx < end; idx++) {
      if (/^\s+inherit_from:\s*/.test(lines[idx] ?? "")) {
        lines[idx] = "  inherit_from: default";
        hasInherit = true;
      } else if (/^\s+save_mode:\s*/.test(lines[idx] ?? "")) {
        lines[idx] = "  save_mode: delta";
        hasSave = true;
      }
    }

    const inserts: string[] = [];
    if (!hasInherit) inserts.push("  inherit_from: default");
    if (!hasSave) inserts.push("  save_mode: delta");
    if (inserts.length) lines.splice(end, 0, ...inserts);
    next = lines.join("\n");
    if (!next.endsWith("\n")) next += "\n";
  }

  if (next === current) return null;
  changedFiles.push(path);
  if (!dryRun) writeText(path, next);
  return path;
}


function ctxEscape(value: string): string {
  return JSON.stringify(value || "");
}


function checkUnit(unit: string): { enabled: boolean; active: boolean } {
  const enabled = systemctlUser(["is-enabled", unit]).ok;
  const active = systemctlUser(["is-active", unit]).ok;
  return { enabled, active };
}


function persistRoleServiceState(
  role: RoleMeta,
  updates: Partial<Record<"gateway" | "heartbeat", "active" | "deferred">>,
): { changed: boolean; error?: string } {
  try {
    const stat = lstatSync(role.roleYamlPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { changed: false, error: `refusing unsafe role manifest ${role.roleYamlPath}` };
    }
    const current = readFileSync(role.roleYamlPath, "utf8");
    const document = YAML.parseDocument(current);
    if (document.errors.length) throw document.errors[0];
    const serviceState = document.get("service_state", true);
    if (serviceState !== undefined && serviceState !== null && !YAML.isMap(serviceState)) {
      return { changed: false, error: `${role.roleYamlPath} service_state must be a YAML mapping` };
    }
    for (const [leaf, value] of Object.entries(updates)) {
      document.setIn(["service_state", leaf], value);
    }
    const next = String(document);
    if (next === current) return { changed: false };

    // The declaration becomes durable only after every unit action and probe
    // succeeds. A same-directory rename atomically replaces role.yaml without
    // following a symlink or exposing a partially serialized manifest.
    const transaction = mkdtempSync(join(dirname(role.roleYamlPath), ".pjangler-role-state-"));
    try {
      atomicWriteBuffer(
        role.roleYamlPath,
        Buffer.from(next),
        Number(stat.mode) & 0o777,
        join(transaction, "role.yaml"),
      );
    } finally {
      rmSync(transaction, { recursive: true, force: true });
    }
    return { changed: true };
  } catch (error) {
    return { changed: false, error: error instanceof Error ? error.message : String(error) };
  }
}


function reconcileHermesRoleUnits(
  ctx: Context,
  role: RoleMeta,
  changedFiles: string[],
  details: string[],
): boolean {
  const gatewayUnit = `hermes-${role.agentId}-gateway.service`;
  const heartbeatUnit = `hermes-${role.agentId}-heartbeat.timer`;
  const gatewayDeferred = role.serviceStateGateway === "deferred";
  const stateUpdates: Partial<Record<"gateway" | "heartbeat", "active" | "deferred">> = {};
  if (role.serviceStateHeartbeat !== "active") stateUpdates.heartbeat = "active";
  if (!gatewayDeferred && role.serviceStateGateway !== "active") stateUpdates.gateway = "active";

  if (ctx.dryRun) {
    details.push("would run: systemctl --user daemon-reload");
    details.push(`would run: systemctl --user enable --now ${heartbeatUnit}`);
    details.push(`would run: systemctl --user ${gatewayDeferred ? "disable" : "enable"} --now ${gatewayUnit}`);
    if (Object.keys(stateUpdates).length) {
      if (!changedFiles.includes(role.roleYamlPath)) changedFiles.push(role.roleYamlPath);
      details.push(`would atomically record verified service_state in ${relative(ctx.repoRoot, role.roleYamlPath)}`);
    }
    return true;
  }

  const reload = systemctlUser(["daemon-reload"]);
  if (!reload.ok) {
    details.push(`script failed: systemctl --user daemon-reload: ${reload.stderr || reload.stdout || "unknown error"}`);
    return false;
  }
  const heartbeat = systemctlUser(["enable", "--now", heartbeatUnit]);
  const gateway = systemctlUser([gatewayDeferred ? "disable" : "enable", "--now", gatewayUnit]);
  if (!heartbeat.ok) {
    details.push(`script failed: could not enable ${heartbeatUnit}: ${heartbeat.stderr || heartbeat.stdout || "unknown error"}`);
  }
  if (!gateway.ok) {
    details.push(`script failed: could not ${gatewayDeferred ? "disable" : "enable"} ${gatewayUnit}: ${gateway.stderr || gateway.stdout || "unknown error"}`);
  }
  if (!heartbeat.ok || !gateway.ok) return false;

  const heartbeatState = checkUnit(heartbeatUnit);
  const gatewayState = checkUnit(gatewayUnit);
  const heartbeatHealthy = heartbeatState.enabled && heartbeatState.active;
  const gatewayHealthy = gatewayDeferred
    ? !gatewayState.enabled && !gatewayState.active
    : gatewayState.enabled && gatewayState.active;
  if (!heartbeatHealthy) {
    details.push(`script failed: ${heartbeatUnit} did not become enabled+active after systemctl reported success`);
  }
  if (!gatewayHealthy) {
    details.push(`script failed: ${gatewayUnit} did not become ${gatewayDeferred ? "disabled+inactive" : "enabled+active"} after systemctl reported success`);
  }
  if (!heartbeatHealthy || !gatewayHealthy) return false;

  const persisted = persistRoleServiceState(role, stateUpdates);
  if (persisted.error) {
    details.push(`script failed: could not update ${relative(ctx.repoRoot, role.roleYamlPath)}: ${persisted.error}`);
    return false;
  }
  if (persisted.changed) {
    if (!changedFiles.includes(role.roleYamlPath)) changedFiles.push(role.roleYamlPath);
    details.push(`atomically recorded verified service_state in ${relative(ctx.repoRoot, role.roleYamlPath)}`);
  }
  details.push(`verified ${heartbeatUnit} enabled+active and ${gatewayUnit} ${gatewayDeferred ? "disabled+inactive" : "enabled+active"}`);
  return true;
}


// ── Hermes singleton-runtime contract ────────────────────────────────────────
// One fleet root holds the shared truth (config.yaml, auth.json, .env, skills/).
// Each agent gets ~/.hermes/profiles/<name>/ as a REAL directory: shared entries
// symlink up to the root, person-owned entries symlink back into the repo
// runtime. That split is load-bearing — Hermes resolves the profile NAME from
// the unresolved HERMES_HOME path (so the profile dir must not itself be a
// symlink) and only offers ~/.hermes/auth.json as a shared fallback when
// HERMES_HOME differs from the fleet root.
// Fleet-shared, symlinked up to ~/.hermes/<entry>.
//
// config.yaml is deliberately NOT here. It used to be, and the symlink was
// actively harmful: Hermes' atomic_yaml_write does os.replace, which REPLACES a
// symlink with a regular file, so the first in-agent config write (/model,
// onboarding, a config migration) silently detached the profile and froze it on
// a stale copy of the base forever. Symlinking also gave a profile no way to
// override anything, which is why several profiles were hand-forked into
// 700-line copies instead.
//
// config.yaml is now GENERATED: deep_merge(~/.hermes/config.yaml, <profile>/
// config.delta.yaml), rendered by hermes-agent-template/scripts/
// hermes-profile-config.py. The delta is the hand-edited SSOT and is usually
// empty (identical to base). See PROFILE_RENDER_MARKER below.
const SHARED_PROFILE_ENTRIES = [".env"] as const;


// Header stamped into every generated profile config.yaml. Its presence is how
// we tell "rendered from base+delta" apart from "hand-forked copy that has
// silently drifted", which look identical on disk otherwise.
const PROFILE_RENDER_MARKER = "GENERATED FILE -- DO NOT EDIT";

// Person-owned. SOUL.md is load-bearing: Hermes reads it from HERMES_HOME and
// seeds the stock "You are Hermes Agent, created by Nous Research" default into
// any fresh profile dir, which would silently shadow each agent's real identity.
const OWNED_PROFILE_ENTRIES = [
  "memories",
  "sessions",
  "workspace",
  "logs",
  "cron",
  "plans",
  "hooks",
  "pairing",
  "audio_cache",
  "image_cache",
] as const;

const OWNED_PROFILE_FILES = ["SOUL.md", "state.db", "kanban.db"] as const;


interface SingletonLink {
  path: string;
  target: string;
  ensureTargetDir: boolean;
}


interface SingletonPlan {
  fleetRoot: string;
  profileDir: string;
  runtimeDir: string;
  links: SingletonLink[];
  sharedSeeds: { rootPath: string; runtimePath: string }[];
}


function fleetHome(ctx: Context): string {
  return process.env.HERMES_FLEET_HOME || join(ctx.homeDir, ".hermes");
}


function fleetBinPath(ctx: Context): string {
  const candidates = [
    process.env.HERMES_FLEET_BIN,
    join(fleetHome(ctx), "hermes-agent", ".venv", "bin", "hermes"),
    join(fleetHome(ctx), "hermes-agent", "venv", "bin", "hermes"),
    join(ctx.homeDir, ".local", "bin", "hermes"),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}


function singletonPlan(ctx: Context, role: RoleMeta): SingletonPlan {
  const fleetRoot = fleetHome(ctx);
  const profileName = role.profileName || role.agentId;
  const profileDir = join(fleetRoot, "profiles", profileName);
  const runtimeDir = join(role.roleDir, "runtime");
  const links: SingletonLink[] = [];
  for (const entry of SHARED_PROFILE_ENTRIES) {
    links.push({ path: join(profileDir, entry), target: join(fleetRoot, entry), ensureTargetDir: false });
  }
  for (const entry of OWNED_PROFILE_ENTRIES) {
    links.push({ path: join(profileDir, entry), target: join(runtimeDir, entry), ensureTargetDir: true });
  }
  for (const entry of OWNED_PROFILE_FILES) {
    links.push({ path: join(profileDir, entry), target: join(runtimeDir, entry), ensureTargetDir: false });
  }
  const sharedSeeds = ["config.yaml", "auth.json", ".env"].map((entry) => ({
    rootPath: join(fleetRoot, entry),
    runtimePath: join(runtimeDir, entry),
  }));
  return { fleetRoot, profileDir, runtimeDir, links, sharedSeeds };
}


function profileNameOf(role: RoleMeta): string {
  return role.profileName || role.agentId;
}


// The base+delta renderer ships in hermes-agent-template, which is a sibling
// component rather than a pjangler dependency — so locate it rather than
// vendoring a second implementation of Hermes' merge semantics.
function profileRendererPath(ctx: Context): string | null {
  const candidates = [
    join(ctx.repoRoot, "hermes-agent-template", "scripts", "hermes-profile-config.py"),
    join(ctx.repoRoot, "..", "hermes-agent-template", "scripts", "hermes-profile-config.py"),
    join(homedir(), "code", "33GOD", "hermes-agent-template", "scripts", "hermes-profile-config.py"),
    join(ctx.pjanglerRoot, "templates", "hermes-agent", "scripts", "hermes-profile-config.py"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}


// Per-profile config + memory invariants that replaced the old
// "config.yaml is a symlink to the fleet base" contract.
//
// Returns human-readable findings; empty means in parity.
function profileConfigFindings(profileDir: string, profileName: string): string[] {
  const out: string[] = [];
  const cfg = join(profileDir, "config.yaml");
  const delta = join(profileDir, "config.delta.yaml");

  // 1. config.yaml must be a real, generated file — never a symlink (see
  //    SHARED_PROFILE_ENTRIES) and never a hand-forked copy.
  if (!existsSync(cfg)) {
    out.push(`profile config missing (run hermes-profile-config.py render): ${cfg}`);
  } else if (lstatSync(cfg).isSymbolicLink()) {
    out.push(`config.yaml is a symlink — it detaches on the first Hermes write; render it instead: ${cfg}`);
  } else {
    let head = "";
    try {
      head = readFileSync(cfg, "utf8").slice(0, 800);
    } catch {
      /* unreadable is reported below via the marker check */
    }
    if (!head.includes(PROFILE_RENDER_MARKER)) {
      out.push(`config.yaml is not a rendered artifact (missing generated header) — likely a hand-forked copy that will drift: ${cfg}`);
    }
  }

  // 2. The delta is the hand-edited source of truth. Absent means "no overrides",
  //    which is valid — but the FILE must exist so the profile is demonstrably
  //    under inheritance rather than merely un-migrated.
  if (!existsSync(delta)) {
    out.push(`config.delta.yaml missing — profile is not under base+delta inheritance: ${delta}`);
  } else if (lstatSync(delta).isSymbolicLink()) {
    out.push(`config.delta.yaml must be a real file, not a symlink: ${delta}`);
  }

  // 3. Identity-memory bank must be pinned explicitly. Relying on
  //    bank_id_template: agent-{profile} is unsafe: {profile} resolves through
  //    get_active_profile_name(), which calls Path.resolve() on HERMES_HOME and
  //    requires a lowercase id directly under profiles/. A symlinked profile dir
  //    or an uppercase name silently yields the literal "custom", merging several
  //    agents' PRIVATE memory into one shared bank.
  const memCfg = join(profileDir, "hindsight", "config.json");
  const wantBank = `agent-${profileName}`;
  if (!existsSync(memCfg)) {
    out.push(`identity-memory bank not pinned (expected bank_id "${wantBank}"): ${memCfg}`);
  } else {
    try {
      const parsed = JSON.parse(readFileSync(memCfg, "utf8")) as Record<string, unknown>;
      const got = typeof parsed.bank_id === "string" ? parsed.bank_id : "";
      if (got !== wantBank) {
        out.push(`identity-memory bank_id is ${got ? `"${got}"` : "unset"}, expected "${wantBank}": ${memCfg}`);
      }
    } catch {
      out.push(`identity-memory pin is unparseable JSON: ${memCfg}`);
    }
  }
  return out;
}


function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
}


function linkState(path: string, target: string): "ok" | "missing" | "not-a-symlink" | "wrong-target" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }
  if (!stat.isSymbolicLink()) return "not-a-symlink";
  try {
    return readlinkSync(path) === target ? "ok" : "wrong-target";
  } catch {
    return "wrong-target";
  }
}


function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}


// heartbeat.SERVICE (not just the .timer) also carries Environment= lines, so
// omitting it leaves a stale HERMES_HOME and the dead HERMES_OAUTH_FILE behind.
function profileUnits(role: RoleMeta): string[] {
  return [
    `hermes-${role.agentId}-gateway.service`,
    `hermes-${role.agentId}-heartbeat.service`,
    `hermes-${role.agentId}-heartbeat.timer`,
    `hermes-${role.agentId}-checkpoint.service`,
  ];
}


function readRegistry(registryPath: string): Record<string, unknown> | null {
  const raw = safeReadText(registryPath);
  if (raw === null) return null;
  try {
    const doc = YAML.parse(raw) as Record<string, unknown>;
    return (doc?.agents ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}


function declaredAgentIds(repoRoot: string): string[] {
  return declaredAgentEntries(repoRoot).map(([agentId]) => agentId);
}


function declaredAgentEntries(repoRoot: string): [string, Record<string, unknown>][] {
  const raw = safeReadText(join(repoRoot, ".project.json"));
  if (raw === null) return [];
  try {
    const doc = JSON.parse(raw) as { agents?: Record<string, unknown> };
    return Object.entries(doc.agents ?? {}).map(([agentId, entry]) => [agentId, (entry ?? {}) as Record<string, unknown>]);
  } catch {
    return [];
  }
}


// Registry entries this repo actually owns. role_dir is
// <project>/agents/hermes/<role>, so the project root is three levels up. A
// prefix match on repoRoot would wrongly claim nested submodule agents
// (33GOD contains bloodbank, candystore, candybar, holocene...).
function ownedRegistryEntries(
  registry: Record<string, unknown>,
  repoRoot: string,
): [string, Record<string, unknown>][] {
  const want = realOrSelf(repoRoot);
  const owned: [string, Record<string, unknown>][] = [];
  for (const [agentId, raw] of Object.entries(registry)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const roleDir = String(entry.role_dir ?? "");
    if (!roleDir) continue;
    if (realOrSelf(dirname(dirname(dirname(roleDir)))) !== want) continue;
    owned.push([agentId, entry]);
  }
  return owned;
}


interface UnprovisionedRoleAgent {
  agentId: string;
  roleDir: string;
  sources: ("registry" | ".project.json")[];
}


function unprovisionedRoleAgents(
  registry: Record<string, unknown>,
  repoRoot: string,
  canonical: Set<string>,
): UnprovisionedRoleAgent[] {
  const blockers = new Map<string, { roleDir: string; sources: Set<"registry" | ".project.json"> }>();
  const record = (agentId: string, roleDir: string, source: "registry" | ".project.json") => {
    const current = blockers.get(agentId) ?? { roleDir, sources: new Set<"registry" | ".project.json">() };
    if (!current.roleDir && roleDir) current.roleDir = roleDir;
    current.sources.add(source);
    blockers.set(agentId, current);
  };

  for (const [agentId, entry] of ownedRegistryEntries(registry, repoRoot)) {
    if (canonical.has(agentId)) continue;
    // The registry stores role_dir absolute; `resolve` leaves those untouched,
    // so the same repo-relative-aware predicate serves both sources.
    const roleDir = String(entry.role_dir ?? "");
    if (declaredRoleIsUnprovisioned(repoRoot, roleDir)) record(agentId, roleDir, "registry");
  }
  for (const [agentId, entry] of declaredAgentEntries(repoRoot)) {
    if (canonical.has(agentId)) continue;
    const configured = String(entry.role_dir ?? "");
    const roleDir = configured ? resolve(repoRoot, configured) : "";
    if (declaredRoleIsUnprovisioned(repoRoot, configured)) record(agentId, roleDir, ".project.json");
  }

  return [...blockers.entries()].map(([agentId, value]) => ({
    agentId,
    roleDir: value.roleDir,
    sources: [...value.sources],
  }));
}


// Drop a duplicate agent id from .project.json so the next provisioning run
// does not resurrect the registry entry we just removed.
function dropDeclaredAgent(ctx: Context, agentId: string, changedFiles: string[], details: string[]): void {
  const path = join(ctx.repoRoot, ".project.json");
  const raw = safeReadText(path);
  if (raw === null) return;
  let doc: { agents?: Record<string, unknown> };
  try {
    doc = JSON.parse(raw) as { agents?: Record<string, unknown> };
  } catch {
    return;
  }
  if (!doc.agents || !(agentId in doc.agents)) return;
  delete doc.agents[agentId];
  details.push(`drop agent "${agentId}" from .project.json`);
  changedFiles.push(path);
  if (!ctx.dryRun) writeText(path, `${JSON.stringify(doc, null, 2)}\n`);
}


// The one correct right-hand side for HERMES_HOME: the named profile dir,
// either as the canonical expression or already expanded to a literal path.
function isProfileHomeExpr(assigned: string): boolean {
  const bare = assigned.replace(/^["']|["']$/g, "");
  return bare === "$FLEET_HOME/profiles/$PROFILE_NAME"
    || /^\$\{?HERMES_FLEET_HOME.*\}?\/profiles\//.test(bare)
    || /\/\.hermes\/profiles\/[^/]+$/.test(bare);
}


function rewriteLauncher(text: string, profileName?: string): string {
  let next = text;
  const assigned = /^HERMES_HOME=(.*)$/m.exec(next)?.[1]?.trim();
  if (assigned !== undefined && !isProfileHomeExpr(assigned)) {
    // A bare substitution would leave $FLEET_HOME/$PROFILE_NAME undefined, and
    // these launchers run under `set -u`. Emit the definitions with it, and
    // keep the old value as RUNTIME_HOME — the provisioning guard still needs
    // the repo runtime path.
    const name = profileName ? `\${HERMES_PROFILE_NAME:-${profileName}}` : "${HERMES_PROFILE_NAME:-$(basename \"$ROLE_DIR\")}";
    next = next.replace(
      /^HERMES_HOME=(.*)$/m,
      [
        `RUNTIME_HOME=$1`,
        `FLEET_HOME="\${HERMES_FLEET_HOME:-$HOME/.hermes}"`,
        `PROFILE_NAME="${name}"`,
        `# Singleton-runtime contract: HERMES_HOME MUST be the named profile dir.`,
        `HERMES_HOME="$FLEET_HOME/profiles/$PROFILE_NAME"`,
      ].join("\n"),
    );
    // The provisioning guard referenced HERMES_HOME when it meant the runtime.
    next = next.replace(
      /if \[\[ ! -d "\$HERMES_HOME" \]\]; then\n(\s*)echo "hermes: local runtime not provisioned at \$HERMES_HOME"/,
      'if [[ ! -d "$RUNTIME_HOME" ]]; then\n$1echo "hermes: local runtime not provisioned at $RUNTIME_HOME"',
    );
  }
  next = next.replace(/^HERMES_OAUTH_FILE=.*\n/m, "");
  next = next.replace(/\s*HERMES_OAUTH_FILE="\$HERMES_OAUTH_FILE"/g, "");
  next = next.replace(/^.*\/home\/delorenj\/code\/hermes-agent\/\.venv\/bin\/hermes.*$/m, (line) =>
    line.replace("/home/delorenj/code/hermes-agent/.venv/bin/hermes", "$HOME/.hermes/hermes-agent/.venv/bin/hermes"),
  );
  return next;
}


/** One list-valued key whose delta value replaces, rather than extends, the base. */
interface ListOverride {
  path: string;
  lost: string[];
  adds: string[];
}


function renderListEntry(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}


/**
 * Identity of one list entry, independent of object key ORDER.
 *
 * Plain JSON.stringify would call `{provider, model}` and `{model, provider}`
 * two different entries, so re-listing a base entry with its keys typed in a
 * different order would be reported as dropping it. Real deltas carry
 * object-valued lists (`fallback_providers`), so that false positive is
 * reachable in exactly the place the rule is most likely to be believed.
 */
function listEntryKey(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, inner]) => [k, normalize(inner)]),
    );
  };
  return JSON.stringify(normalize(value));
}


/**
 * Every list-valued key where the delta DROPS entries the fleet base provides.
 *
 * YAML deep-merge has no union semantics for arrays: a delta list replaces the
 * base list wholesale. Keys are compared by path, and only where BOTH sides are
 * arrays -- a delta that introduces a key the base never had takes nothing away
 * and is not an override.
 */
function listOverrides(base: unknown, delta: unknown, path: string[] = []): ListOverride[] {
  const found: ListOverride[] = [];
  const isPlain = (v: unknown) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (!isPlain(base) || !isPlain(delta)) return found;
  for (const [key, deltaValue] of Object.entries(delta as Record<string, unknown>)) {
    const baseValue = (base as Record<string, unknown>)[key];
    const here = [...path, key];
    if (Array.isArray(deltaValue) && Array.isArray(baseValue)) {
      const kept = new Set(deltaValue.map(listEntryKey));
      const inBase = new Set(baseValue.map(listEntryKey));
      const lost = baseValue.filter((v) => !kept.has(listEntryKey(v)));
      if (lost.length) {
        found.push({
          path: here.join("."),
          lost: lost.map(renderListEntry),
          adds: deltaValue.filter((v) => !inBase.has(listEntryKey(v))).map(renderListEntry),
        });
      }
      continue;
    }
    if (isPlain(deltaValue)) found.push(...listOverrides(baseValue, deltaValue, here));
  }
  return found;
}



export function createHermesChecks(): RecipeOwnedCheck[] {
return [
  {
    id: "hermes.pm-scaffold",
    title: "Hermes orchestrator scaffold parity",
    audit: (ctx) => {
      const selection = managedHermesScaffoldRoles(ctx);
      if (selection.roles.length === 0 && selection.blockers.length === 0) {
        return { id: "hermes.pm-scaffold", title: "Hermes orchestrator scaffold parity", status: "skip", summary: "No provisioned pm or director role present", details: [], fixable: false };
      }
      const details: string[] = [...selection.blockers];
      const templateRoleDir = join(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
      const managedScripts = templateFiles(join(templateRoleDir, ".scripts"))
        .filter((rel) => rel !== "sentinel.prompt.md.jinja");
      // Lineage is decidable only for the assets the template ships verbatim.
      // `hermes`, `.gitignore` and `sentinel.prompt.md` are rendered per role,
      // so their bytes never appear in the object database at all and a blob
      // probe would call every one of them locally-modified — which would stop
      // migrate ever repairing them. Those keep the historical "stale" reading.
      const probe = templateLineageProbe(join(ctx.pjanglerRoot, "templates", "hermes-agent"));
      const verbatim = new Set(managedScripts.map((rel) => `.scripts/${rel}`));
      const inLineage = (blobId: string, path: string): boolean => (verbatim.has(path) ? probe(blobId) : true);
      for (const role of selection.roles) {
        const prefix = role.agentId || role.role;
        // The runtime memory file is the one presence check outside the shared
        // core: it lives under the ignored runtime, which the core never reads.
        const memory = join(role.roleDir, "runtime", "memories", "MEMORY.md");
        if (!existsSync(memory)) details.push(`${prefix}: missing ${relative(ctx.repoRoot, memory)}`);
        // ONE comparison for the rule and the fleet observer (story 1.6):
        // `compareAssets` from the shared core, over the rule's historical
        // asset set. Lineage comes from `templateLineageProbe`, so a file
        // carrying bytes the template never shipped reports as
        // "locally-modified" rather than "stale" — the two need different
        // answers, because `migrate` overwrites without a backup and only
        // staleness is safe to overwrite. Modes are deliberately not compared,
        // because `migrate` writes bytes and never lowers a mode, and a rule
        // that cannot pass after its own repair is a lie.
        const desired = scaffoldDesiredForRule(role, templateRoleDir, managedScripts);
        const findings = compareScaffoldAssets(
          desired,
          (asset) => observeScaffoldAsset(join(role.roleDir, ...asset.path.split("/"))),
          { inLineage, modes: false },
        );
        for (const finding of findings) {
          const word = finding.kind === "stale-content" ? "stale" : finding.kind;
          const shown = relative(ctx.repoRoot, join(role.roleDir, ...finding.path.split("/")));
          details.push(`${prefix}: ${word} ${shown}${finding.detail ? ` (${finding.detail})` : ""}`);
        }
        if (hasRuntimeSubmoduleMapping(ctx.repoRoot, role)) details.push(`${prefix}: .gitmodules contains retired ${role.role} runtime submodule mapping`);
        if (!profileMetaInheritsDefault(join(role.roleDir, "runtime", "profile.yaml"))) details.push(`${prefix}: runtime/profile.yaml missing inherited default config metadata`);
        const registry = safeReadText(registryPath(ctx.homeDir));
        if (!registry?.includes(`${role.agentId}:`)) details.push(`fleet registry missing ${role.agentId}`);
      }
      return {
        id: "hermes.pm-scaffold",
        title: "Hermes orchestrator scaffold parity",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? `${selection.roles.length} orchestrator scaffold(s) verified` : `${details.length} orchestrator scaffold issue(s) detected`,
        details,
        fixable: selection.blockers.length === 0,
      };
    },
    migrate: (ctx, finding) => {
      const selection = managedHermesScaffoldRoles(ctx);
      const changedFiles: string[] = [];
      const details: string[] = [];
      if (selection.blockers.length > 0) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "Provisioned orchestrator manifest is invalid", changedFiles, details: selection.blockers };
      }
      if (selection.roles.length === 0) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "No provisioned pm or director role present", changedFiles, details: [] };
      }
      const templateRoleDir = join(ctx.pjanglerRoot, "templates", "hermes-agent", "template");
      // Only consulted for the verbatim managed scripts below; the rendered
      // assets are rewritten unconditionally, exactly as before.
      const inLineage = templateLineageProbe(join(ctx.pjanglerRoot, "templates", "hermes-agent"));
      const preserved: string[] = [];
      const managedScripts = templateFiles(join(templateRoleDir, ".scripts"))
        .filter((rel) => rel !== "sentinel.prompt.md.jinja");
      for (const role of selection.roles) {
        const prefix = role.agentId || role.role;
        const retirement = retireRuntimeSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
        details.push(...retirement.details);
        if (!retirement.ok) {
          return { id: finding.id, title: finding.title, status: "blocked", summary: `Failed to retire ${role.role} runtime submodule metadata safely`, changedFiles, details: [retirement.error ?? "unknown runtime retirement failure"] };
        }
        if (!existsSync(join(role.roleDir, "SOUL.md"))) writeIfDifferent(join(role.roleDir, "SOUL.md"), renderSoul(role), ctx.dryRun, changedFiles);
        writeIfDifferent(join(role.roleDir, "hermes"), renderHermesWrapper(role, templateRoleDir), ctx.dryRun, changedFiles, 0o755);
        writeIfDifferent(join(role.roleDir, ".gitignore"), readText(join(templateRoleDir, ".gitignore.jinja")).replace(/\{\{\s*role\s*\}\}/g, role.role), ctx.dryRun, changedFiles);
        copyMissingRecursive(join(templateRoleDir, ".runtime-scaffold"), join(role.roleDir, ".runtime-scaffold"), changedFiles, ctx.dryRun);
        copyMissingRecursive(join(templateRoleDir, ".runtime-scaffold"), join(role.roleDir, "runtime"), changedFiles, ctx.dryRun);
        for (const rel of managedScripts) {
          const source = join(templateRoleDir, ".scripts", rel);
          const executable = (lstatSync(source).mode & 0o111) !== 0;
          const target = join(role.roleDir, ".scripts", rel);
          // Never overwrite bytes the template never shipped. `writeIfDifferent`
          // keeps no backup, so clobbering a local edit destroys the only copy;
          // a stale-but-shipped script is still repaired as before.
          if (scaffoldLocallyModified(target, inLineage)) {
            preserved.push(`${prefix}: preserved locally-modified .scripts/${rel}`);
            continue;
          }
          writeIfDifferent(target, readText(source), ctx.dryRun, changedFiles, executable ? 0o755 : undefined);
        }
        writeIfDifferent(join(role.roleDir, ".scripts", "sentinel.prompt.md"), renderSentinelPrompt(role, templateRoleDir), ctx.dryRun, changedFiles);
        const profileMetaUpdated = upsertInheritedProfileMeta(join(role.roleDir, "runtime", "profile.yaml"), changedFiles, ctx.dryRun);
        if (profileMetaUpdated) details.push(`updated ${profileMetaUpdated}`);
        const registryUpdated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
        if (registryUpdated) details.push(`updated ${registryUpdated}`);
      }
      details.push(...preserved);
      // A preserved local edit means this rule cannot reach parity without
      // destroying work, so say so instead of reporting a clean pass the
      // postcondition would then contradict. Reconciling those bytes into the
      // template is a person's decision, not a migration's.
      if (preserved.length > 0) {
        return {
          id: finding.id,
          title: finding.title,
          status: "partial",
          summary: `${preserved.length} locally-modified script(s) preserved; reconcile them into the template before this rule can pass`,
          changedFiles,
          details,
        };
      }
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? `${selection.roles.length} orchestrator scaffold(s) normalized` : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    id: "hermes.untracked-runtimes",
    title: "Hermes agent runtimes untracked + gitignored",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (roles.length === 0) {
        return {
          id: "hermes.untracked-runtimes",
          title: "Hermes agent runtimes untracked + gitignored",
          status: "skip",
          summary: "No Hermes roles present",
          details: [],
          fixable: false,
        };
      }
      const details: string[] = [];
      for (const role of roles) {
        const roleRelDir = relative(ctx.repoRoot, role.roleDir);
        const runtimeRelPath = join(roleRelDir, "runtime");

        // 1. Check if tracked in git
        const lsResult = spawnSync("git", ["ls-files", "--stage", runtimeRelPath], {
          cwd: ctx.repoRoot,
          encoding: "utf8",
        });
        if (lsResult.status === 0 && lsResult.stdout.trim().length > 0) {
          details.push(`submodule runtime is tracked in Git index at ${runtimeRelPath}`);
        }

        if (hasRuntimeSubmoduleMapping(ctx.repoRoot, role)) {
          details.push(`stale .gitmodules mapping exists for ${runtimeRelPath}`);
        }

        // 2. Check if .gitignore ignores runtime/
        const gitignorePath = join(role.roleDir, ".gitignore");
        if (existsSync(gitignorePath)) {
          const content = safeReadText(gitignorePath) ?? "";
          const lines = content.split(/\r?\n/).map((line) => line.trim());
          if (!lines.includes("runtime/") && !lines.includes("runtime")) {
            details.push(`.gitignore missing runtime/ ignore entry in ${relative(ctx.repoRoot, gitignorePath)}`);
          }
        } else {
          details.push(`.gitignore is missing in ${relative(ctx.repoRoot, gitignorePath)}`);
        }
      }

      return {
        id: "hermes.untracked-runtimes",
        title: "Hermes agent runtimes untracked + gitignored",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "All Hermes agent runtimes are untracked and gitignored" : `${details.length} issue(s) with untracked/ignored runtimes detected`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot);
      const changedFiles: string[] = [];
      const details: string[] = [];

      for (const role of roles) {
        const retirement = retireRuntimeSubmodule(ctx.repoRoot, role, changedFiles, ctx.dryRun);
        details.push(...retirement.details);
        if (!retirement.ok) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Failed to retire Hermes runtime submodule metadata safely",
            changedFiles,
            details: [retirement.error ?? "unknown runtime retirement failure"],
          };
        }

        // Update .gitignore only after index removal is verified and the stale
        // mapping has been retired.
        const gitignorePath = join(role.roleDir, ".gitignore");
        let content = "";
        let isIgnored = false;
        if (existsSync(gitignorePath)) {
          content = safeReadText(gitignorePath) ?? "";
          const lines = content.split(/\r?\n/).map((line) => line.trim());
          isIgnored = lines.includes("runtime/") || lines.includes("runtime");
        }

        if (!isIgnored) {
          details.push(`ignore runtime/ in ${relative(ctx.repoRoot, gitignorePath)}`);
          changedFiles.push(gitignorePath);
          if (!ctx.dryRun) {
            if (content && !content.endsWith("\n")) {
              content += "\n";
            }
            content += "runtime/\n";
            writeText(gitignorePath, content);
          }
        }
      }

      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? "applied" : "noop",
        summary: changedFiles.length ? "Hermes agent runtimes made untracked and ignored" : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    id: "systemd.sentinel",
    title: "Hermes systemd/sentinel units enabled + active",
    // PJAN-84: host-scoped — systemd --user units on this machine.
    scope: "host",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const requiredRoles = roles.filter((role) => role.deploymentSystemd !== "deferred");
      if (!requiredRoles.length) {
        return { id: "systemd.sentinel", title: "Hermes systemd/sentinel units enabled + active", status: "pass", summary: "systemd is intentionally deferred for every local-only Hermes role", details: [], fixable: false };
      }
      const probe = systemctlUser(["is-system-running"]);
      if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
        const sysDir = join(ctx.homeDir, ".config", "systemd", "user");
        const details: string[] = [];
        // The per-agent heartbeat timer is NOT required. hermes-agent-template
        // 63466a8 retired it — every agent got a 1-minute oneshot whose
        // reconciliation pass was gated on a role.yaml flag that was true in one
        // repo fleet-wide, so ~20,000 no-op invocations a day is all it did. The
        // template stopped writing the unit; requiring it here made every freshly
        // provisioned agent fail its own systemd parity immediately. Liveness is
        // the gateway unit's job (Restart=on-failure) and scheduling is
        // Bloodbank's. Retired units still SHOW UP in fleet status as topology —
        // observing one is not the same as demanding it.
        for (const role of requiredRoles) {
          const gateway = role.serviceStateGateway || "active";
          if (!existsSync(join(sysDir, `hermes-${role.agentId}-gateway.service`))) {
            details.push(`hermes-${role.agentId}-gateway.service should be installed`);
          }
          if (gateway !== "installed" && gateway !== "deferred") details.push(`${role.agentId} gateway should record installed or deferred while systemd --user is unavailable (got ${gateway})`);
        }
        return {
          id: "systemd.sentinel",
          title: "Hermes systemd/sentinel units enabled + active",
          status: details.length ? "warn" : "pass",
          summary: details.length ? "systemd --user unavailable and installed-state metadata is incomplete" : "Hermes units are installed; activation is deferred because systemd --user is unavailable",
          details,
          fixable: false,
        };
      }
      const details: string[] = [];
      const sysDir = join(ctx.homeDir, ".config", "systemd", "user");
      for (const role of requiredRoles) {
        // Gateway only — see the note above: the heartbeat timer was retired in
        // the template, so requiring it here fails every agent provisioned from
        // the current pin.
        const gatewayUnit = `hermes-${role.agentId}-gateway.service`;
        const gatewayState = role.serviceStateGateway || "active";
        if (!existsSync(join(sysDir, gatewayUnit))) details.push(`${gatewayUnit} should be installed`);
        const gateway = checkUnit(gatewayUnit);
        if (gatewayState === "deferred") {
          if (gateway.enabled || gateway.active) details.push(`${gatewayUnit} is deferred and should be disabled+inactive`);
        } else if (gatewayState !== "active" || !gateway.enabled || !gateway.active) {
          details.push(`${gatewayUnit} should be enabled+active (manifest: ${gatewayState || "missing"})`);
        }
      }
      return {
        id: "systemd.sentinel",
        title: "Hermes systemd/sentinel units enabled + active",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Hermes user units match each role's declared service state" : `${details.length} systemd parity issue(s) detected`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot).filter((role) => role.deploymentSystemd !== "deferred");
      const changedFiles: string[] = [];
      const details: string[] = [];
      if (!roles.length) {
        return { id: finding.id, title: finding.title, status: "skipped", summary: "systemd is intentionally deferred for local-only Hermes roles", changedFiles, details };
      }
      const probe = systemctlUser(["is-system-running"]);
      if (!probe.ok && !/running|degraded|starting|maintenance/.test(`${probe.stdout} ${probe.stderr}`)) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "systemd --user unavailable on this host", changedFiles, details };
      }
      for (const role of roles) {
        const sysDir = join(ctx.homeDir, ".config", "systemd", "user");
        const units = [`hermes-${role.agentId}-gateway.service`, `hermes-${role.agentId}-heartbeat.timer`];
        const allUnitsPresent = units.every((unit) => existsSync(join(sysDir, unit)));
        // Existing units can still point at the checkout's former location.
        // In that case enabling them again preserves the stale ExecStart path,
        // so regenerate them from the role's current provisioning script.
        const unitsStale = units.some((unit) => {
          const text = safeReadText(join(sysDir, unit));
          if (text === null) return true;
          return text.includes("/agents/hermes/") && !text.includes(role.roleDir);
        });
        const manifestNeedsReconcile = [role.serviceStateGateway, role.serviceStateHeartbeat]
          .some((state) => state === "pending" || state === "error");
        if (allUnitsPresent && !unitsStale && !manifestNeedsReconcile) {
          reconcileHermesRoleUnits(ctx, role, changedFiles, details);
          continue;
        }
        let regenerated = false;
        for (const script of [join(role.roleDir, ".scripts", "70-systemd.sh")]) {
          if (!existsSync(script)) {
            details.push(`script failed: missing ${script}`);
            continue;
          }
          if (ctx.dryRun) {
            details.push(`would run: FORCE_SYSTEMD=1 bash ${script}`);
          } else {
            const result = spawnSync("bash", [script], {
              cwd: role.roleDir,
              encoding: "utf8",
              env: { ...process.env, FORCE_SYSTEMD: "1" },
            });
            if (result.status !== 0) {
              details.push(`script failed: ${script}: ${result.stderr.trim() || result.stdout.trim()}`);
            } else {
              regenerated = true;
              details.push(`regenerated systemd units for ${role.agentId} from ${role.roleDir}`);
            }
          }
        }
        if (ctx.dryRun) continue;
        if (regenerated) {
          const refreshed = discoverRoles(ctx.repoRoot).find((candidate) => candidate.agentId === role.agentId);
          if (!refreshed) {
            details.push(`script failed: regenerated role ${role.agentId} could not be rediscovered`);
          } else {
            reconcileHermesRoleUnits(ctx, refreshed, changedFiles, details);
          }
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: details.some((detail) => detail.includes("failed:")) ? "blocked" : details.length ? (ctx.dryRun ? "skipped" : "applied") : "noop",
        summary: details.length ? (ctx.dryRun ? "Planned systemd remediation commands" : "Reconciled and verified systemd service state") : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    id: "hermes.runtime-singleton",
    title: "Hermes singleton runtime (shared config/auth, per-agent memory)",
    audit: async (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "hermes.runtime-singleton", title: "Hermes singleton runtime (shared config/auth, per-agent memory)", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const details: string[] = [];
      for (const role of roles) {
        const plan = singletonPlan(ctx, role);
        if (!existsSync(plan.fleetRoot)) {
          details.push(`fleet root missing at ${plan.fleetRoot}`);
          continue;
        }
        if (!existsSync(plan.profileDir)) {
          details.push(`profile dir missing: ${plan.profileDir}`);
        }
        for (const link of plan.links) {
          const state = linkState(link.path, link.target);
          if (state !== "ok") details.push(`${state}: ${link.path} -> ${link.target}`);
        }
        const projection = await showProfile(profileNameOf(role), {
          ...skillCoreOptions(ctx), hermesRoot: plan.fleetRoot,
        });
        details.push(...skillDiagnostics(projection.findings));
        details.push(...(projection.data?.changes ?? []).map((change) => `profile skills ${change.action}: ${change.path}`));
        details.push(...profileConfigFindings(plan.profileDir, profileNameOf(role)));
      }
      return {
        id: "hermes.runtime-singleton",
        title: "Hermes singleton runtime (shared config/auth, per-agent memory)",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Singleton runtime contract satisfied" : `${details.length} singleton-runtime issue(s) detected`,
        details,
        fixable: true,
      };
    },
    migrate: async (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot);
      const changedFiles: string[] = [];
      const details: string[] = [];
      for (const role of roles) {
        const plan = singletonPlan(ctx, role);
        if (!existsSync(plan.fleetRoot)) {
          details.push(`blocked: fleet root missing at ${plan.fleetRoot}`);
          continue;
        }
        // Seed the shared singletons from the richest existing runtime copy so a
        // first migration never lands agents on an empty config.
        for (const shared of plan.sharedSeeds) {
          if (existsSync(shared.rootPath)) continue;
          const donor = existsSync(shared.runtimePath) ? shared.runtimePath : null;
          if (!donor) continue;
          details.push(`seed fleet ${basename(shared.rootPath)} from ${donor}`);
          changedFiles.push(shared.rootPath);
          if (!ctx.dryRun) copyFileSync(donor, shared.rootPath);
        }
        const skillsRoot = join(plan.profileDir, "skills");
        const skillsStat = lstatIfPresent(skillsRoot);
        if (skillsStat && !skillsStat.isDirectory()) {
          details.push(`blocked: ${skillsRoot} needs an explicit Skillex profile migration before projection; preserve its current target and run skillex migrate --profile ${profileNameOf(role)} --project ${JSON.stringify(ctx.repoRoot)}`);
          continue;
        }
        if (!existsSync(plan.profileDir)) {
          details.push(`create profile dir: ${plan.profileDir}`);
          changedFiles.push(plan.profileDir);
          if (!ctx.dryRun) mkdirSync(plan.profileDir, { recursive: true });
        }
        for (const link of plan.links) {
          const state = linkState(link.path, link.target);
          if (state === "ok") continue;
          // Person-owned targets must exist before linking or the agent starts
          // against a dangling path and silently recreates empty state.
          if (link.ensureTargetDir && !existsSync(link.target) && !ctx.dryRun) {
            mkdirSync(link.target, { recursive: true });
          }
          details.push(`link ${link.path} -> ${link.target}`);
          changedFiles.push(link.path);
          if (ctx.dryRun) continue;
          if (existsSync(link.path) || isDanglingLink(link.path)) {
            const lst = lstatSync(link.path);
            if (lst.isSymbolicLink()) {
              unlinkSync(link.path);
            } else {
              // Never discard real user data: park it beside the profile.
              const parked = `${link.path}.pre-singleton`;
              renameSync(link.path, parked);
              details.push(`parked pre-existing ${link.path} at ${parked}`);
            }
          }
          ensureParent(link.path);
          symlinkSync(link.target, link.path);
        }
        if (ctx.dryRun && !existsSync(plan.profileDir)) {
          details.push(`would project global + explicit project skills into ${plan.profileDir}/skills after creating the profile`);
          changedFiles.push(join(plan.profileDir, "skills"));
        } else {
          const projection = await syncProfile(profileNameOf(role), {
            ...skillCoreOptions(ctx), hermesRoot: plan.fleetRoot, dryRun: Boolean(ctx.dryRun),
          });
          details.push(...skillDiagnostics(projection.findings).map((detail) => projection.ok ? detail : `blocked: ${detail}`));
          changedFiles.push(...(ctx.dryRun ? projection.data?.changes ?? [] : projection.data?.applied ?? []).map((change) => change.path));
          if (!projection.ok) details.push(`blocked: profile skill projection returned exit ${projection.exit}`);
        }
        // Render config.yaml from base+delta and pin the identity-memory bank.
        // This deliberately does NOT symlink config.yaml (see
        // SHARED_PROFILE_ENTRIES): the renderer owns that file now.
        const profileName = profileNameOf(role);
        if (profileConfigFindings(plan.profileDir, profileName).length) {
          const renderer = profileRendererPath(ctx);
          if (!renderer) {
            details.push(`blocked: profile renderer not found (expected hermes-agent-template/scripts/hermes-profile-config.py); cannot render ${plan.profileDir}/config.yaml`);
          } else {
            details.push(`render config.yaml + pin memory bank for ${profileName}`);
            changedFiles.push(join(plan.profileDir, "config.yaml"), join(plan.profileDir, "config.delta.yaml"));
            if (!ctx.dryRun) {
              for (const args of [["init", "--profile", profileName], ["memory-pin", "--profile", profileName]]) {
                const res = spawnSync("python3", [renderer, ...args], { encoding: "utf8" });
                if (res.status !== 0) {
                  details.push(`blocked: ${basename(renderer)} ${args[0]} failed for ${profileName}: ${(res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
                }
              }
            }
          }
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: details.some((d) => d.startsWith("blocked:")) ? "blocked" : changedFiles.length ? (ctx.dryRun ? "skipped" : "applied") : "noop",
        // PJAN-75: the summary has to follow the status. The blocked branch was
        // missing here, so a run that stopped on a missing profile renderer
        // still reported "Singleton runtime wired" -- and that string is what
        // surfaced as the recipe's ERROR message, telling the operator the
        // exact opposite of what happened.
        summary: details.some((d) => d.startsWith("blocked:"))
          ? "Singleton-runtime wiring blocked"
          : changedFiles.length ? (ctx.dryRun ? "Planned singleton-runtime wiring" : "Singleton runtime wired") : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    // Fleet-base invariants. Every profile inherits ~/.hermes/config.yaml by
    // generation, so a defect here is a defect in EVERY agent at once — and each
    // of these has already shipped silently: no error, no log, just an agent
    // quietly missing a capability.
    id: "hermes.fleet-config",
    title: "Fleet base config carries the capabilities every agent inherits",
    // PJAN-84: host-scoped — $HOME/.hermes/fleet.env, shared by every agent.
    scope: "host",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "hermes.fleet-config", title: "Fleet base config carries the capabilities every agent inherits", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const base = join(fleetHome(ctx), "config.yaml");
      const details: string[] = [];
      let cfg: any = null;
      if (!existsSync(base)) {
        details.push(`fleet base config missing: ${base}`);
      } else {
        try {
          cfg = YAML.parse(readFileSync(base, "utf8")) ?? {};
        } catch (err) {
          details.push(`fleet base config is unparseable YAML: ${base} (${(err as Error).message})`);
        }
      }

      if (cfg) {
        // TTS provider must be the REGISTRY KEY, not the product name. "voxxy"
        // is the service (swappable engines: voxcpm/vibevoice/elevenlabs); the
        // Hermes plugin registers as "vox". An unknown provider does not error —
        // Hermes falls back to a built-in (ElevenLabs when the key is set, else
        // Edge) and you simply hear the wrong voice. Regressed twice.
        const ttsProvider = cfg?.tts?.provider;
        if (ttsProvider && ttsProvider !== "vox") {
          details.push(`tts.provider is "${ttsProvider}" — must be "vox" (registry key). "voxxy" is the service name and matches no registered provider, so TTS silently falls back to a built-in.`);
        }

        // Bloodbank lifecycle hooks. These lived on 3 of 36 profiles once, so 33
        // agents emitted no events at all while appearing healthy.
        const hooks = cfg?.hooks;
        const REQUIRED_HOOKS = ["on_session_start", "on_session_end", "pre_tool_call", "post_tool_call"];
        if (!hooks || typeof hooks !== "object") {
          details.push(`no hooks: block in the fleet base — every agent publishes zero Bloodbank lifecycle events: ${base}`);
        } else {
          const missing = REQUIRED_HOOKS.filter((h) => !hooks[h]);
          if (missing.length) details.push(`fleet base hooks missing event(s): ${missing.join(", ")}`);
          const serialized = JSON.stringify(hooks);
          if (!serialized.includes("hooks/bloodbank/publish.py")) {
            details.push(`fleet base hooks do not call the canonical publisher (~/.agents/hooks/bloodbank/publish.py --client hermes)`);
          }
        }

        // Memory: the provider can be configured and still be muzzled. Tool
        // injection is gated by agent.disabled_toolsets while auto recall/retain
        // keeps running underneath, so "memory works" and "the agent can use
        // memory" are different questions.
        const provider = cfg?.memory?.provider;
        if (!provider) {
          details.push(`memory.provider is unset in the fleet base — agents get no external memory`);
        }
        const disabled: unknown = cfg?.agent?.disabled_toolsets;
        if (Array.isArray(disabled) && disabled.includes("memory")) {
          details.push(`agent.disabled_toolsets contains "memory" — memory tools are suppressed fleet-wide even though memory.provider is set (auto recall/retain still runs, which masks it)`);
        }

        // Named profiles load their real skills/ overlay. Skill reachability
        // is checked by hermes.runtime-singleton through the public core;
        // external_dirs may intentionally be empty.
      }

      return {
        id: "hermes.fleet-config",
        title: "Fleet base config carries the capabilities every agent inherits",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Fleet base config invariants satisfied" : `${details.length} fleet-base config issue(s) detected`,
        details,
        // Deliberately not auto-fixable: these are fleet-wide values whose
        // correct setting is an operator decision, and a wrong guess would
        // change behavior for every agent simultaneously.
        fixable: false,
      };
    },
    // The audit above is `fixable: false`, so `migrate --all` never selects
    // this rule -- but naming it explicitly must still produce an answer. It
    // shipped with no migrate at all, which the registry surfaced as
    // "migrate threw: check.migrate is not a function": true, but useless.
    migrate: (ctx, finding) => ({
      id: finding.id,
      title: finding.title,
      status: "blocked",
      summary: "Fleet base config is operator-owned; pjangler will not guess fleet-wide values",
      changedFiles: [],
      details: finding.details.length
        ? [...finding.details, `Edit ${join(ctx.homeDir, ".hermes", "config.yaml")} directly, then re-run audit`]
        : [`Edit ${join(ctx.homeDir, ".hermes", "config.yaml")} directly, then re-run audit`],
    }),
  },
  {
    // A delta that sets a LIST-valued key REPLACES the base list. YAML
    // deep-merge has no union semantics for arrays, so one redundant line in a
    // delta silently strips every base entry it did not repeat -- and the
    // redundant line is the common case, because the obvious way to "add a
    // plugin" is to write the one you want.
    //
    // Observed 2026-09-16: a profile delta carrying `plugins.enabled:
    // [tts/vox]` -- an entry the fleet base ALREADY had -- dropped the other 16
    // fleet plugins, including telegram-platform (the agent's own chat channel)
    // and openai-codex (the live provider). The agent had been half-provisioned
    // for two months with no error anywhere; its gateway simply never
    // connected. Six profiles carried the same shape.
    //
    // Same failure mode as hermes.fleet-config: no error, no log, just a
    // capability quietly missing.
    id: "hermes.delta-list-override",
    title: "Profile deltas extend fleet base lists instead of replacing them",
    // PJAN-84: host-scoped -- $HOME/.hermes/profiles, shared across every repo.
    scope: "host",
    audit: (ctx) => {
      const title = "Profile deltas extend fleet base lists instead of replacing them";
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "hermes.delta-list-override", title, status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const fleetRoot = fleetHome(ctx);
      const basePath = join(fleetRoot, "config.yaml");
      if (!existsSync(basePath)) {
        return { id: "hermes.delta-list-override", title, status: "skip", summary: `fleet base config missing: ${basePath}`, details: [], fixable: false };
      }
      let base: unknown;
      try {
        base = YAML.parse(readFileSync(basePath, "utf8")) ?? {};
      } catch (err) {
        return { id: "hermes.delta-list-override", title, status: "warn", summary: `fleet base config is unparseable YAML: ${basePath} (${(err as Error).message})`, details: [], fixable: false };
      }

      const profilesRoot = join(fleetRoot, "profiles");
      if (!existsSync(profilesRoot)) {
        return { id: "hermes.delta-list-override", title, status: "skip", summary: "No Hermes profiles present", details: [], fixable: false };
      }

      const details: string[] = [];
      let profileDirs: string[] = [];
      try {
        profileDirs = readdirSync(profilesRoot, { withFileTypes: true })
          // withFileTypes uses lstat semantics, so isDirectory() is FALSE for a
          // symlinked profile dir. Filtering on it alone silently skipped three
          // legacy profiles that symlink into repo-local runtime -- each one
          // carrying exactly the defect this rule exists to find. The symlink
          // topology is hermes.runtime-singleton's business; the capability loss
          // inside it is still real, so it must be reported here too. The
          // existsSync below (which does follow links) is what confirms a real
          // profile, so a plain file named like one is still excluded.
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => entry.name)
          .sort();
      } catch {
        return { id: "hermes.delta-list-override", title, status: "warn", summary: `profiles directory unreadable: ${profilesRoot}`, details: [], fixable: false };
      }

      for (const name of profileDirs) {
        // No delta means the profile is not under base+delta inheritance at
        // all; hermes.runtime-singleton owns that, and flagging it here would
        // report the same defect twice under two rule ids.
        const deltaPath = join(profilesRoot, name, "config.delta.yaml");
        if (!existsSync(deltaPath)) continue;
        let delta: unknown;
        try {
          delta = YAML.parse(readFileSync(deltaPath, "utf8")) ?? {};
        } catch (err) {
          details.push(`${name}: config.delta.yaml is unparseable YAML (${(err as Error).message})`);
          continue;
        }
        // Both lists are elided the same way: an entry can be an object, so an
        // uncapped join puts a whole provider record inline and buries the
        // sentence that says what to do about it.
        const elide = (entries: string[], keep: number) =>
          entries.slice(0, keep).join(", ") + (entries.length > keep ? `, +${entries.length - keep} more` : "");
        for (const override of listOverrides(base, delta)) {
          const shown = elide(override.lost, 4);
          // A delta that adds nothing is pure redundancy: deleting the key
          // restores inheritance outright. One that adds entries states a real
          // intent, so the base entries have to be merged back by hand -- the
          // operator may have meant to drop some of them.
          const remedy = override.adds.length
            ? `delta also adds ${elide(override.adds, 3)} -- merge the base entries back in, or confirm you meant to drop them`
            : `delta adds nothing new, so removing "${override.path}" from the delta restores inheritance`;
          details.push(`${name}: ${override.path} drops ${override.lost.length} fleet entr${override.lost.length === 1 ? "y" : "ies"} (${shown}) -- ${remedy}`);
        }
      }

      return {
        id: "hermes.delta-list-override",
        title,
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0
          ? "No profile delta replaces a fleet base list"
          : `${details.length} profile delta list override(s) detected`,
        details,
        // Not auto-fixable. Even a pure-subset delta may be a deliberate
        // restriction, and the alternative reading -- that the operator wanted
        // to ADD one entry -- produces the opposite edit. Both change what a
        // running agent can do, so pjangler reports and lets the operator pick.
        fixable: false,
      };
    },
    migrate: (ctx, finding) => ({
      id: finding.id,
      title: finding.title,
      status: "blocked",
      summary: "Profile deltas are operator-owned; pjangler will not guess which entries were meant to be dropped",
      changedFiles: [],
      details: [
        ...finding.details,
        `Edit the named config.delta.yaml under ${join(fleetHome(ctx), "profiles")}, then re-render with hermes-profile-config.py render --profile <name>`,
      ],
    }),
  },
  {
    id: "hermes.profile-wiring",
    title: "Launcher + systemd HERMES_HOME points at the named profile",
    // PJAN-84: host-scoped — $HOME/.hermes/profiles and the launcher's HERMES_HOME.
    scope: "host",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      if (!roles.length) {
        return { id: "hermes.profile-wiring", title: "Launcher + systemd HERMES_HOME points at the named profile", status: "skip", summary: "No Hermes roles present", details: [], fixable: false };
      }
      const details: string[] = [];
      for (const role of roles) {
        const plan = singletonPlan(ctx, role);
        const launcher = join(role.roleDir, "hermes");
        const text = safeReadText(launcher);
        if (text === null) {
          details.push(`launcher missing: ${relative(ctx.repoRoot, launcher)}`);
        } else {
          // Match the ASSIGNMENT, not one known-bad spelling of it. Earlier
          // revisions only tested for `HERMES_HOME="$RUNTIME_HOME"`, so every
          // launcher still carrying the older `HERMES_HOME="$ROLE_DIR/runtime"`
          // form — which is what the fleet template emitted — passed this audit
          // while running split-brain against its own systemd unit.
          const assigned = /^HERMES_HOME=(.*)$/m.exec(text)?.[1]?.trim();
          if (assigned !== undefined && !isProfileHomeExpr(assigned)) {
            details.push(`launcher sets HERMES_HOME=${assigned} instead of the named profile dir (disables shared auth + profile identity): ${relative(ctx.repoRoot, launcher)}`);
          }
          if (/HERMES_OAUTH_FILE/.test(text)) {
            details.push(`launcher exports HERMES_OAUTH_FILE, which Hermes does not implement (dead config): ${relative(ctx.repoRoot, launcher)}`);
          }
        }
        for (const unit of profileUnits(role)) {
          const unitPath = join(ctx.homeDir, ".config", "systemd", "user", unit);
          const unitText = safeReadText(unitPath);
          if (unitText === null) continue;
          const current = /^Environment=HERMES_HOME=(.*)$/m.exec(unitText)?.[1]?.trim();
          if (current && current !== plan.profileDir) {
            details.push(`${unit} HERMES_HOME=${current} (expected ${plan.profileDir})`);
          }
          if (/^Environment=HERMES_OAUTH_FILE=/m.test(unitText)) {
            details.push(`${unit} sets HERMES_OAUTH_FILE (dead config)`);
          }
        }
      }
      return {
        id: "hermes.profile-wiring",
        title: "Launcher + systemd HERMES_HOME points at the named profile",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "HERMES_HOME wiring is in parity" : `${details.length} HERMES_HOME wiring issue(s) detected`,
        details,
        fixable: true,
      };
    },
    migrate: (ctx, finding) => {
      const roles = discoverRoles(ctx.repoRoot);
      const changedFiles: string[] = [];
      const details: string[] = [];
      let unitsTouched = false;
      for (const role of roles) {
        const plan = singletonPlan(ctx, role);
        const launcher = join(role.roleDir, "hermes");
        const text = safeReadText(launcher);
        if (text !== null) {
          const before = /^HERMES_HOME=(.*)$/m.exec(text)?.[1]?.trim();
          const rewritten = rewriteLauncher(text, role.profileName || role.agentId);
          if (rewritten !== text) {
            // Say which change actually happened — the previous single message
            // claimed a HERMES_HOME rewrite even when only the dead
            // HERMES_OAUTH_FILE export was stripped.
            const rel = relative(ctx.repoRoot, launcher);
            if (before !== undefined && !isProfileHomeExpr(before)) {
              details.push(`rewrite launcher HERMES_HOME ${before} -> ${plan.profileDir}: ${rel}`);
            }
            if (/HERMES_OAUTH_FILE/.test(text)) {
              details.push(`strip dead HERMES_OAUTH_FILE export: ${rel}`);
            }
            writeIfDifferent(launcher, rewritten, ctx.dryRun, changedFiles, 0o755);
          }
        }
        for (const unit of profileUnits(role)) {
          const unitPath = join(ctx.homeDir, ".config", "systemd", "user", unit);
          const unitText = safeReadText(unitPath);
          if (unitText === null) continue;
          let next = unitText.replace(/^Environment=HERMES_HOME=.*$/m, `Environment=HERMES_HOME=${plan.profileDir}`);
          next = next.replace(/^Environment=HERMES_OAUTH_FILE=.*\n/m, "");
          if (next !== unitText) {
            details.push(`repoint ${unit} HERMES_HOME -> ${plan.profileDir}`);
            writeIfDifferent(unitPath, next, ctx.dryRun, changedFiles);
            unitsTouched = true;
          }
        }
      }
      if (unitsTouched && !ctx.dryRun) {
        systemctlUser(["daemon-reload"]);
        details.push("systemctl --user daemon-reload (restart units to pick up the new HERMES_HOME)");
      }
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? (ctx.dryRun ? "skipped" : "applied") : "noop",
        summary: changedFiles.length ? (ctx.dryRun ? "Planned HERMES_HOME rewiring" : "HERMES_HOME rewired to named profiles") : "No changes required",
        changedFiles,
        details,
      };
    },
  },
  {
    id: "hermes.registry-parity",
    title: "Fleet registry matches .project.json (no duplicate or stale agents)",
    // PJAN-84: host-scoped — $HOME/.hermes/agents-registry.yaml.
    scope: "host",
    audit: (ctx) => {
      const roles = discoverRoles(ctx.repoRoot);
      const details: string[] = [];
      let malformedRoleGate = false;
      const registryPath = join(ctx.homeDir, ".hermes", "agents-registry.yaml");
      const registry = readRegistry(registryPath);
      if (!registry) {
        if (!roles.length && declaredAgentIds(ctx.repoRoot).length === 0) {
          return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "skip", summary: "No Hermes roles or declared agents present", details: [], fixable: false };
        }
        return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "warn", summary: `registry unreadable at ${registryPath}`, details: [], fixable: false };
      }
      // role.yaml is the identity SSOT. discoverRoles() only walks this repo's
      // own agents/hermes/*, so nested submodule agents are correctly excluded --
      // a naive role_dir.startsWith(repoRoot) would swallow them and propose
      // deleting perfectly good sibling agents.
      const canonical = new Set(roles.map((role) => role.agentId).filter(Boolean));
      const owned = ownedRegistryEntries(registry, ctx.repoRoot);
      const unprovisioned = unprovisionedRoleAgents(registry, ctx.repoRoot, canonical);
      if (unprovisioned.length) {
        return {
          id: "hermes.registry-parity",
          title: "Fleet registry matches .project.json (no duplicate or stale agents)",
          status: "fail",
          summary: `${unprovisioned.length} unprovisioned Hermes role blocker(s) detected`,
          details: unprovisioned.map(({ agentId, roleDir, sources }) =>
            `agent "${agentId}" (${sources.join(" + ")}) has no role.yaml${roleDir ? ` at ${roleDir}` : ""}; provision or restore the role, do not delete its registry/declaration`
          ),
          fixable: false,
        };
      }
      if (canonical.size === 0) {
        return { id: "hermes.registry-parity", title: "Fleet registry matches .project.json (no duplicate or stale agents)", status: "skip", summary: "No Hermes roles, declarations, or registry entries present", details: [], fixable: false };
      }
      // With at least one provisioned role, stale sibling identities can be
      // compared safely against role.yaml. The empty-role case returned above
      // as a truthful non-fixable blocker and never enters destructive repair.
      for (const [agentId, entry] of owned) {
        const roleDir = String((entry as Record<string, unknown>)?.role_dir ?? "");
        if (!canonical.has(agentId)) {
          details.push(`stale/duplicate registry agent "${agentId}" for ${roleDir} (role.yaml declares ${[...canonical].join(", ")})`);
        }
      }
      for (const extra of declaredAgentIds(ctx.repoRoot).filter((id) => !canonical.has(id))) {
        details.push(`.project.json declares agent "${extra}" that no role.yaml claims`);
      }
      for (const role of roles) {
        const expectedBloodbankEnabled = roleBloodbankEnabled(role);
        if (expectedBloodbankEnabled === null) {
          details.push(`${relative(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`);
          malformedRoleGate = true;
        }
        const entry = registry[role.agentId] as Record<string, unknown> | undefined;
        if (!entry) {
          details.push(`registry is missing an entry for ${role.agentId}`);
          continue;
        }
        const entryRoleDir = String(entry.role_dir ?? "");
        if (entryRoleDir && realOrSelf(entryRoleDir) !== realOrSelf(role.roleDir)) {
          details.push(`registry role_dir for ${role.agentId} is ${entryRoleDir} (expected ${role.roleDir})`);
        }
        const bin = String((entry.hermes as Record<string, unknown> | undefined)?.bin ?? "");
        if (bin && !existsSync(bin)) {
          details.push(`registry hermes.bin for ${role.agentId} does not exist: ${bin}`);
        }
        // Fleet-bloodbank standard: one shared gateway owns command ingress.
        // Every agent entry advertises fleet routing; none carries the retired
        // per-agent consumer/checkpoint contract in the registry or on disk.
        const bloodbank = (entry.bloodbank ?? {}) as Record<string, unknown>;
        if (typeof bloodbank.enabled !== "boolean") {
          details.push(`registry entry for ${role.agentId} bloodbank.enabled must be a strict boolean`);
        } else if (expectedBloodbankEnabled !== null && bloodbank.enabled !== expectedBloodbankEnabled) {
          details.push(`registry entry for ${role.agentId} bloodbank.enabled must match explicit role value ${expectedBloodbankEnabled}`);
        }
        if (bloodbank.gateway_scope !== "fleet" || bloodbank.target_agent_id !== role.agentId) {
          details.push(`registry entry for ${role.agentId} must advertise bloodbank { gateway_scope: fleet, target_agent_id: ${role.agentId} }`);
        }
        const systemd = (entry.systemd ?? {}) as Record<string, unknown>;
        for (const key of LEGACY_SYSTEMD_KEYS) {
          if (systemd[key] !== undefined) {
            details.push(`registry entry for ${role.agentId} carries retired systemd.${key}; the fleet-shared Bloodbank gateway owns command ingress`);
          }
        }
        const legacyUnit = legacyConsumerUnitPath(ctx.homeDir, role.agentId);
        if (existsSync(legacyUnit)) {
          details.push(`retired per-agent consumer unit still on disk: ${legacyUnit}`);
        }
      }
      return {
        id: "hermes.registry-parity",
        title: "Fleet registry matches .project.json (no duplicate or stale agents)",
        status: details.length === 0 ? "pass" : "fail",
        summary: details.length === 0 ? "Fleet registry is in parity" : `${details.length} registry parity issue(s) detected`,
        details,
        fixable: !malformedRoleGate,
      };
    },
    migrate: (ctx, finding) => {
      const changedFiles: string[] = [];
      const details: string[] = [];
      const registryPath = join(ctx.homeDir, ".hermes", "agents-registry.yaml");
      let raw = safeReadText(registryPath);
      if (raw === null) {
        return { id: finding.id, title: finding.title, status: "blocked", summary: `registry unreadable at ${registryPath}`, changedFiles, details };
      }
      const roles = discoverRoles(ctx.repoRoot);
      const malformedRoleGates = roles.filter((role) => roleBloodbankEnabled(role) === null);
      if (malformedRoleGates.length > 0) {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: "Registry parity is blocked by malformed role Bloodbank gates",
          changedFiles,
          details: malformedRoleGates.map((role) =>
            `${relative(ctx.repoRoot, role.roleYamlPath)} bloodbank.enabled must be the strict YAML boolean true or false`
          ),
        };
      }
      const missingRoles = roles.filter((role) => !raw!.includes(`${role.agentId}:`));
      for (const role of missingRoles) {
        const updated = upsertRegistryEntry(role, ctx.homeDir, changedFiles, ctx.dryRun);
        if (updated) details.push(`add missing fleet registry entry for ${role.agentId}`);
        if (!ctx.dryRun) raw = safeReadText(registryPath) ?? raw;
      }
      if (ctx.dryRun && missingRoles.length) {
        return { id: finding.id, title: finding.title, status: "skipped", summary: "Planned missing fleet registry entries", changedFiles: [...new Set(changedFiles)], details };
      }
      let doc: Record<string, unknown>;
      try {
        doc = YAML.parse(raw) as Record<string, unknown>;
      } catch {
        return { id: finding.id, title: finding.title, status: "blocked", summary: "registry is not valid YAML", changedFiles, details };
      }
      const agents = (doc?.agents ?? {}) as Record<string, Record<string, unknown>>;
      const canonical = new Set(roles.map((role) => role.agentId).filter(Boolean));
      const unprovisioned = unprovisionedRoleAgents(agents, ctx.repoRoot, canonical);
      if (unprovisioned.length) {
        return {
          id: finding.id,
          title: finding.title,
          status: "blocked",
          summary: "Registry parity is blocked by an unprovisioned Hermes role",
          changedFiles,
          details: unprovisioned.map(({ agentId, roleDir, sources }) =>
            `blocked: "${agentId}" (${sources.join(" + ")}) has no role.yaml${roleDir ? ` at ${roleDir}` : ""}; provision or restore the role without pruning registry/declaration state`
          ),
        };
      }
      const fleetBin = fleetBinPath(ctx);
      let dirty = false;

      if (canonical.size === 0) {
        // Unprovisioned repo: report, never delete. Losing these entries costs
        // the Plane binding and unit names that provisioning cannot rebuild.
        for (const [agentId] of ownedRegistryEntries(agents, ctx.repoRoot)) {
          details.push(`blocked: "${agentId}" has no role.yaml; provision the role instead of pruning the registry`);
        }
        for (const agentId of declaredAgentIds(ctx.repoRoot)) {
          if (!details.some((detail) => detail.includes(`"${agentId}"`))) {
            details.push(`blocked: "${agentId}" is declared but has no role.yaml; provision or restore the role`);
          }
        }
        if (details.length) {
          return {
            id: finding.id,
            title: finding.title,
            status: "blocked",
            summary: "Registry parity is blocked by an unprovisioned Hermes role",
            changedFiles,
            details,
          };
        }
      }
      // A moved checkout is deliberately invisible to ownedRegistryEntries(),
      // because that helper scopes ownership using the registry's role_dir.
      // role.yaml gives us a safer canonical identity: repair the matching
      // agent by id first, then let normal ownership-scoped cleanup proceed.
      for (const role of roles) {
        const entry = agents[role.agentId] as Record<string, unknown> | undefined;
        if (!entry) continue;
        const entryRoleDir = String(entry.role_dir ?? "");
        if (entryRoleDir && realOrSelf(entryRoleDir) !== realOrSelf(role.roleDir)) {
          details.push(`repoint ${role.agentId} role_dir -> ${role.roleDir}`);
          entry.role_dir = role.roleDir;
          entry.project_path = ctx.repoRoot;
          dirty = true;
        }
        // Converge on the fleet-bloodbank standard: advertise fleet routing,
        // drop the retired per-agent consumer/checkpoint contract, and remove
        // any leftover consumer unit file from disk.
        const bloodbank = (entry.bloodbank ?? {}) as Record<string, unknown>;
        const expectedBloodbankEnabled = roleBloodbankEnabled(role) ?? false;
        if (bloodbank.enabled !== expectedBloodbankEnabled || bloodbank.gateway_scope !== "fleet" || bloodbank.target_agent_id !== role.agentId) {
          details.push(`normalize fleet bloodbank routing for ${role.agentId} with enabled=${expectedBloodbankEnabled}`);
          entry.bloodbank = { ...bloodbank, enabled: expectedBloodbankEnabled, gateway_scope: "fleet", target_agent_id: role.agentId };
          dirty = true;
        }
        const systemd = entry.systemd as Record<string, unknown> | undefined;
        if (systemd) {
          for (const key of LEGACY_SYSTEMD_KEYS) {
            if (systemd[key] !== undefined) {
              details.push(`drop retired systemd.${key} from ${role.agentId}`);
              delete systemd[key];
              dirty = true;
            }
          }
        }
        const legacyUnit = legacyConsumerUnitPath(ctx.homeDir, role.agentId);
        if (existsSync(legacyUnit)) {
          if (ctx.dryRun) {
            details.push(`would remove retired consumer unit ${legacyUnit}`);
          } else {
            systemctlUser(["disable", "--now", basename(legacyUnit)]);
            rmSync(legacyUnit, { force: true });
            systemctlUser(["daemon-reload"]);
            systemctlUser(["reset-failed"]);
            details.push(`removed retired consumer unit ${legacyUnit}`);
          }
          changedFiles.push(legacyUnit);
        }
      }
      for (const [agentId, entry] of ownedRegistryEntries(agents, ctx.repoRoot)) {
        // Only ids this repo's own role.yaml files claim survive. Scoping is by
        // derived project root, so nested submodule agents are never touched.
        if (canonical.size > 0 && !canonical.has(agentId)) {
          details.push(`drop stale/duplicate registry agent "${agentId}"`);
          delete agents[agentId];
          dropDeclaredAgent(ctx, agentId, changedFiles, details);
          dirty = true;
          continue;
        }
        const hermes = (entry.hermes ?? {}) as Record<string, unknown>;
        if (fleetBin && String(hermes.bin ?? "") !== fleetBin && !existsSync(String(hermes.bin ?? ""))) {
          details.push(`repoint ${agentId} hermes.bin -> ${fleetBin}`);
          hermes.bin = fleetBin;
          entry.hermes = hermes;
          dirty = true;
        }
        // HERMES_OAUTH_FILE is documented but unimplemented; drop the pointer so
        // the registry stops advertising a sharing mechanism that does nothing.
        if (hermes.oauth_file) {
          details.push(`drop dead hermes.oauth_file from ${agentId}`);
          delete hermes.oauth_file;
          dirty = true;
        }
      }

      // Once role.yaml establishes the canonical identity, stale declarations
      // can be retired alongside duplicate registry entries.
      if (canonical.size > 0) {
        for (const extra of declaredAgentIds(ctx.repoRoot).filter((id) => !canonical.has(id))) {
          dropDeclaredAgent(ctx, extra, changedFiles, details);
        }
      }

      if (dirty) {
        changedFiles.push(registryPath);
        if (!ctx.dryRun) {
          doc.agents = agents;
          writeText(registryPath, YAML.stringify(doc));
        }
      }
      return {
        id: finding.id,
        title: finding.title,
        status: changedFiles.length ? (ctx.dryRun ? "skipped" : "applied") : "noop",
        summary: changedFiles.length ? (ctx.dryRun ? "Planned registry repair" : "Fleet registry repaired") : "No changes required",
        changedFiles,
        details,
      };
    },
  },
];
}


function writeIfDifferent(path: string, content: string, dryRun: boolean, changedFiles: string[], mode?: number): void {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  if (safeReadText(path) === normalized) return;
  changedFiles.push(path);
  if (!dryRun) {
    writeText(path, normalized);
    if (mode) chmodSync(path, mode);
  }
}


function prettyTimestamp(iso: string): string {
  // 2026-07-07T09:59:00.989Z -> 2026-07-07 09:59:00 UTC
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}


export function formatAuditReport(report: AuditReport): string {
  const counts: Record<string, number> = {};
  for (const rule of report.rules) counts[rule.status] = (counts[rule.status] ?? 0) + 1;
  const idWidth = report.rules.reduce((width, rule) => Math.max(width, rule.id.length), 0);

  const tally: string[] = [];
  if (counts.pass) tally.push(green(`${counts.pass} passed`));
  if (counts.fail) tally.push(red(`${counts.fail} failed`));
  if (counts.warn) tally.push(yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`));
  if (counts.skip) tally.push(gray(`${counts.skip} skipped`));

  const overall = report.ok
    ? `${green(glyph.pass)} ${bold("Parity audit passed")}`
    : `${red(glyph.fail)} ${bold("Parity audit failed")}`;

  const lines = [""];
  lines.push(`  ${overall}${tally.length ? `  ${dim(glyph.dot)}  ${joinDot(tally)}` : ""}`);
  lines.push(`  ${dim(report.repo)}  ${dim(glyph.dot)}  ${dim(prettyTimestamp(report.auditedAt))}`);
  // PJAN-84: a host finding no longer fails the repo, so it has to be visible on
  // its own line — otherwise "Parity audit passed" would be the only thing an
  // operator reads while their machine's shared state is broken.
  const hostTrouble = report.rules.filter((rule) => rule.scope === "host" && (rule.status === "fail" || rule.status === "warn"));
  if (hostTrouble.length) {
    lines.push("");
    lines.push(`  ${yellow(glyph.warn)} ${bold("This machine needs attention")}  ${dim(glyph.dot)}  ${dim("not this project — these cannot be fixed from here")}`);
    for (const rule of hostTrouble) lines.push(`     ${dim(glyph.arrow)} ${rule.id}: ${rule.summary}`);
  }
  lines.push("");
  for (const rule of report.rules) {
    const style = statusStyle(rule.status);
    lines.push(`  ${style.color(style.glyph)}  ${style.color(rule.id.padEnd(idWidth))}  ${rule.summary}`);
    for (const detail of rule.details) lines.push(`     ${dim(glyph.arrow)} ${dim(detail)}`);
  }
  lines.push("");
  return lines.join("\n");
}


export function formatMigrationReport(report: MigrationReport): string {
  const idWidth = report.results.reduce((width, result) => Math.max(width, result.id.length), 0);
  const blocked = report.results.filter((result) => result.status === "blocked").length;
  const partial = report.results.filter((result) => result.status === "partial").length;

  // PJAN-75: "Migration complete" is now a claim the run has verified, so the
  // not-ok case has to say WHICH kind of unfinished it is. A blocker means the
  // rule refused to act; a partial means it acted and still did not reach
  // parity, which is the state that used to be reported as success.
  const overall = report.ok
    ? `${green(glyph.pass)} ${bold(report.dryRun ? "Migration preview complete" : "Migration complete")}`
    : blocked
      ? `${red(glyph.fail)} ${bold("Migration finished with blockers")}`
      : `${yellow(glyph.warn)} ${bold(`Migration incomplete  ${glyph.dot}  ${partial} rule${partial === 1 ? "" : "s"} still failing`)}`;

  const lines = [""];
  lines.push(`  ${overall}${report.dryRun ? `  ${dim(glyph.dot)}  ${yellow("dry run")}` : ""}`);
  lines.push(`  ${dim(report.repo)}`);
  if (report.selectedRules.length) lines.push(`  ${dim(`rules: ${report.selectedRules.join(", ")}`)}`);
  lines.push("");
  for (const result of report.results) {
    const style = statusStyle(result.status);
    lines.push(`  ${style.color(style.glyph)}  ${style.color(result.id.padEnd(idWidth))}  ${result.summary}  ${dim(`[${style.label}]`)}`);
    for (const detail of result.details) lines.push(`     ${dim(glyph.arrow)} ${dim(detail)}`);
    for (const file of result.changedFiles) lines.push(`     ${green(glyph.add)} ${file}`);
  }
  if (report.changedFiles.length) {
    lines.push("");
    lines.push(`  ${bold(`Changed files (${report.changedFiles.length})`)}`);
    for (const file of report.changedFiles) lines.push(`     ${green(glyph.add)} ${file}`);
  }
  const unresolved = partial + blocked;
  if (unresolved) {
    lines.push("");
    lines.push(`  ${dim(`Run \`flume audit\` for the full detail on the ${unresolved} rule${unresolved === 1 ? "" : "s"} still failing.`)}`);
  }
  lines.push("");
  return lines.join("\n");
}


// ─────────────────────────────────────────────────────────────────────────────
// Interactive rule picker presentation
//
// Presentation only: this never decides *which* rules are offered or in what
// order — the caller owns that. It just turns an already-selected list of
// findings into the label/hint pairs @clack's multiselect renders.
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the interactive rule picker, in @clack `Option` shape. */
export interface RulePickerChoice {
  value: string;
  label: string;
  hint?: string;
}


export interface RulePicker {
  message: string;
  options: RulePickerChoice[];
}


/**
 * Widest hint the picker will emit before eliding, and the widest title column
 * it will pad to. Both are caps, not targets: rule titles run from ~20 to ~70
 * characters, and padding every row out to the longest one turns a short list
 * into a field of whitespace and pushes rows past any sane terminal width.
 * Titles longer than the cap are never truncated — that row just goes ragged.
 */
const RULE_HINT_WIDTH = 72;

const RULE_TITLE_COLUMN = 44;


/**
 * Row-width budget. @clack never wraps, so an over-long row is the terminal's
 * problem — we keep rows near a comfortable width instead. Fixed rather than
 * read from `process.stdout.columns`: the picker only ever runs on a TTY, but a
 * deterministic layout is worth more than a responsive one here (it keeps the
 * rendering reproducible in tests and identical across operators' terminals).
 */
const RULE_ROW_TARGET = 116;

const RULE_HINT_MIN = 28;

/** @clack's own gutter + checkbox prefix ("│  ◼ "), plus our " (...)" wrapper. */
const RULE_ROW_CHROME = 7;


function elide(value: string, width: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1)).trimEnd()}…`;
}


/**
 * Fold a finding's summary + details into ONE bounded line. @clack renders a
 * hint only for the focused row and for already-selected rows, so this is the
 * progressive-disclosure layer: enough context to decide, never enough to bury
 * the list. `flume audit` stays the full-detail surface, which is why the
 * header points at it.
 *
 * Detail policy: a lone detail IS the whole story, so it is shown inline; two
 * or more collapse to a count. Every failing rule is pre-selected, so inlining
 * detail text unconditionally would put a paragraph on nearly every row — the
 * exact wall of text this ticket removes.
 *
 * Deliberately un-colored: @clack wraps hints in its own dim(), and nesting our
 * SGR codes inside that renders inconsistently across terminals.
 */
function ruleHint(rule: AuditFinding, budget: number): string | undefined {
  const summary = rule.summary.replace(/\s+/g, " ").trim();
  const fragments: string[] = [];
  if (summary) fragments.push(summary);
  if (rule.details.length === 1) {
    fragments.push(`${glyph.arrow} ${rule.details[0]}`);
  } else if (rule.details.length > 1) {
    fragments.push(`${glyph.arrow} ${rule.details.length} details`);
  }
  const hint = elide(fragments.join(` ${glyph.dot} `), budget);
  return hint || undefined;
}


/**
 * Compose the interactive rule picker.
 *
 * Row anatomy — the human sentence leads so the list is scannable, the rule id
 * stays visible (dim, in a column) because the operator still needs it for
 * `flume remediate <rule-id>`, and status drives both icon and color so a
 * failing rule is obvious. The icon carries the distinction on its own, so a
 * NO_COLOR / non-TTY terminal (where `src/utils/style` degrades every color
 * helper to identity) loses no information:
 *
 *   ✖ Canonical .project.json         sot.project-json   (1 parity issue …)
 *   ✔ managed mise versioning block   mise.versioning
 */
export function formatRulePicker(rules: AuditFinding[]): RulePicker {
  const titleColumn = Math.min(
    RULE_TITLE_COLUMN,
    rules.reduce((width, rule) => Math.max(width, rule.title.length), 0),
  );

  const options = rules.map((rule) => {
    const style = statusStyle(rule.status);
    // Pad OUTSIDE the color run, so a row never carries styled trailing space.
    const pad = " ".repeat(Math.max(0, titleColumn - rule.title.length));
    const headline =
      rule.status === "fail"
        ? bold(style.color(rule.title))
        : rule.status === "warn"
          ? style.color(rule.title)
          : rule.status === "skip"
            ? dim(rule.title)
            : rule.title;

    // Give the hint whatever row budget the label did not spend, so a long
    // title costs detail rather than overflowing the terminal.
    const labelWidth = 2 + rule.title.length + pad.length + 2 + rule.id.length;
    const budget = Math.min(RULE_HINT_WIDTH, Math.max(RULE_HINT_MIN, RULE_ROW_TARGET - RULE_ROW_CHROME - labelWidth));

    return {
      value: rule.id,
      label: `${style.color(style.glyph)} ${headline}${pad}  ${dim(rule.id)}`,
      hint: ruleHint(rule, budget),
    };
  });

  return { message: formatRulePickerMessage(rules), options };
}


/**
 * Header line: a status tally so the operator knows what they're looking at
 * before scanning, plus a pointer to the full-detail surface. @clack already
 * prints its own "press space to select, enter to submit" instructions, so we
 * do not repeat them. Single line by construction — a newline here would break
 * @clack's frame.
 */
function formatRulePickerMessage(rules: AuditFinding[]): string {
  const counts: Record<string, number> = {};
  for (const rule of rules) counts[rule.status] = (counts[rule.status] ?? 0) + 1;

  const fragments: string[] = [];
  if (counts.fail) fragments.push(red(`${counts.fail} failing`));
  if (counts.warn) fragments.push(yellow(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`));
  if (counts.pass) fragments.push(green(`${counts.pass} passing`));
  if (counts.skip) fragments.push(gray(`${counts.skip} skipped`));
  fragments.push(dim("`flume audit` for full detail"));

  return `Select parity rules to apply  ${joinDot(fragments)}`;
}
