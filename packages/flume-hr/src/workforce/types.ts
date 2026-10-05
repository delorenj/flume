/**
 * TypeScript declarations for portable named agent contracts, charters, and desks.
 */

export interface AgentCharter {
  purpose: string;
  directives?: string[];
  tone?: string;
}

export interface AgentSkillsBinding {
  pack?: string;
  packs?: string[];
  set?: string;
}

export interface AgentMemoryBinding {
  write_bank: string;
  recall_banks?: string[];
}

export interface AgentDeskManifest {
  path: string;
}

export interface NamedAgentContract {
  identity?: { name: string; write_bank?: string; recall_banks?: string[] };
  schema_version: number;
  id: string;
  display_name: string;
  role: string;
  charter: AgentCharter;
  skills: AgentSkillsBinding;
  memory: AgentMemoryBinding;
  desk?: AgentDeskManifest;
}

export interface ResolvedSkill {
  name: string;
  path: string;
}

export interface ResolvedNamedAgentContract extends NamedAgentContract {
  desk: AgentDeskManifest;
  resolvedSkills: ResolvedSkill[];
}

export interface DeskProvisionOptions {
  /** Suppress human progress for callers returning structured results. */
  quiet?: boolean;
  /** Override the desk root directory (e.g. for testing) */
  deskRoot?: string;
  /** Override the skillex registry root (e.g. for testing) */
  skillexRoot?: string;
  /** Home directory to resolve ~ against */
  home?: string;
  /** Dry run mode without modifying filesystem */
  dryRun?: boolean;
  /** Pre-resolved skills list */
  resolvedSkills?: ResolvedSkill[];
}

export interface DeskProvisionResult {
  deskPath: string;
  skillsDir: string;
  created: number;
  updated: number;
  preserved: number;
  removed: number;
  skills: Array<{ name: string; target: string }>;
}

export interface ValidationDiagnostic {
  field?: string;
  message: string;
  code?: string;
  path?: string;
}

export interface ValidationOptions {
  /** Whether to verify canonical skills in Skillex registry (default: true) */
  resolveSkills?: boolean;
  /** Override the skillex registry root (e.g. for testing) */
  skillexRoot?: string;
  /** Override the desk root directory (e.g. for testing) */
  deskRoot?: string;
  /** Home directory to resolve ~ against */
  home?: string;
}
