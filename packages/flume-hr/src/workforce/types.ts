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
  /** Requires schema_version 2; see contracts/company-identity.schema.json. */
  company_identity?: CompanyIdentity;
}

export type CompanyIdentityStatus = "active" | "suspended" | "retired";

/** A provider principal held by reference only; never a resolved credential. */
export interface CompanyIdentityBinding {
  principal: string;
  instance?: string;
  credential_ref?: string;
  attribution_mode?: "native" | "shared_bot_attributed";
  /** FLUME-51: the provider-issued actor ID (github: the bot user's numeric ID), adopted by `flume identity adopt-actor`. */
  native_actor_id?: string;
}

/** Who an employee is to the company. The subject never changes once enrolled. */
export interface CompanyIdentity {
  version: 1;
  subject: string;
  handle: string;
  email: string;
  status: CompanyIdentityStatus;
  enrolled_at: string;
  status_changed_at?: string;
  bindings?: Record<string, CompanyIdentityBinding>;
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
