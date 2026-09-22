// Fleet authority and managed-state contract: types, error taxonomy, and the
// `as const` owned-key allowlists that decide which keys are policy.
//
// The contract is DECLARATION ONLY. Nothing here models a runtime observation,
// a credential, or a health result -- those belong to the later observation
// stories and would make this file a moving target for every one of them.

/**
 * The contract schema version this build WRITES.
 *
 * Bumped to 2 by story 1.5: `health_policy` is a new ROOT key, and a new root
 * key is a grammar change rather than a content one. Bumped to 3 by story 1.6
 * for the same reason: `scaffold_manifest` is a new root key. Bumped to 4 by
 * story 1.7, again for a new root key: `profile_manifest`. Bumped to 5 by
 * story 1.8 for `service_manifest`. The build still READS schema 1 through 4
 * -- see `FLEET_SUPPORTED_SCHEMA_VERSIONS` -- because a contract without the
 * newer blocks is simply one that authorizes no gap and declares no manifest.
 */
export const FLEET_CONTRACT_SCHEMA_VERSION = 5 as const;

/** Inclusive range of contract schema versions this build accepts. */
export const FLEET_SUPPORTED_SCHEMA_VERSIONS = { min: 1, max: 5 } as const;

/** Envelope version for the read-only org commands' machine output. */
export const FLEET_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Owned-key allowlists
//
// `authorities`, `projections`, `classifications` and `retired` are CLOSED: an
// unknown key there is a typo that would silently drop policy, so it fails.
//
// `service_model` and `activation` are OPEN: an unknown key there is a declared
// healthy mode, and the retired-mode scan is what must judge it. Rejecting it
// as "unknown" would hide exactly the drift this contract exists to name -- a
// contract re-introducing `consumer_unit` has to fail as RETIRED_MODE, not as a
// spelling complaint.
// ---------------------------------------------------------------------------

export const FLEET_CONTRACT_ROOT_KEYS = [
  "schema_version", "contract_version", "compatibility", "authorities",
  "projections", "classifications", "service_model", "activation", "retired",
  "health_policy", "scaffold_manifest", "profile_manifest", "service_manifest",
] as const;

/**
 * Root keys a contract may omit and still validate.
 *
 * `health_policy` is real policy, not an `x-` extension, so it belongs in the
 * allowlist above -- but a schema-1 contract predates it and must still load.
 * A contract without it authorizes nothing, which is why an absent block makes
 * every non-pass unjustified rather than making the run fail. `scaffold_manifest`
 * (schema 3) is optional on the same terms: without it the scaffold observer
 * reports every agent's `template_scaffold` as `unsupported` with capability
 * `scaffold.manifest`, unjustified unless the policy says otherwise. And
 * `profile_manifest` (schema 4) likewise: without it the profile observer
 * reports every selected agent's five profile fields `unsupported` under
 * capability `profile.manifest`. And `service_manifest` (schema 5): without it
 * the systemd observer reports every selected agent's five systemd leaves
 * `unsupported` under capability `systemd.manifest`.
 */
export const FLEET_CONTRACT_OPTIONAL_ROOT_KEYS = ["health_policy", "scaffold_manifest", "profile_manifest", "service_manifest"] as const;

/** Closed key set for `health_policy` and each of its five entry lists. */
export const FLEET_HEALTH_POLICY_KEYS = [
  "required_domains", "deferred_capabilities", "allowed_warnings", "allowed_skips", "freshness", "agent_exceptions",
] as const;
export const FLEET_HEALTH_POLICY_DEFERRED_KEYS = ["domain", "capability", "reason", "owner_story"] as const;
export const FLEET_HEALTH_POLICY_WARNING_KEYS = ["rule_id", "reason", "owner"] as const;
export const FLEET_HEALTH_POLICY_SKIP_KEYS = ["domain", "rule_id", "reason"] as const;
export const FLEET_HEALTH_POLICY_FRESHNESS_KEYS = ["field", "max_age_days", "applies_to"] as const;
/** Closed key set for one `health_policy.agent_exceptions[]` entry. `(domain, agent_id)` is unique. */
export const FLEET_HEALTH_POLICY_AGENT_EXCEPTION_KEYS = ["domain", "agent_id", "reason", "owner"] as const;

/**
 * Closed key set for the `scaffold_manifest` root block (schema 3).
 *
 * The manifest is POLICY about the tracked template, not a copy of it: which
 * submodule and subdirectory the assets live in, how a rendered file is named,
 * which registry fields feed each render input, which contract leaf owns each
 * role-relative path, which assets are compared for presence only and why, and
 * what may never appear in a template tree. The bytes themselves come from git
 * at the committed gitlink and are never declared here.
 */
export const FLEET_SCAFFOLD_MANIFEST_KEYS = [
  "template_submodule", "template_subdirectory", "render_suffix", "render_inputs",
  "groups", "presence_only", "excluded_patterns", "runtime_dir",
] as const;
export const FLEET_SCAFFOLD_PRESENCE_ONLY_KEYS = ["path", "reason"] as const;

/**
 * Closed key sets for the `profile_manifest` root block (schema 4) and each of
 * its six sub-blocks.
 *
 * POLICY about a generated profile, never a copy of one: which renderer proves
 * a generated config (and where its bytes are pinned), what an identity file
 * may say, how the Hindsight bank pin is spelled, which skills are the
 * immutable core and where the canonical copies live, which profile-root
 * entries are the observer's own footprint or a backup, and the caps every
 * read is bounded by. Nothing here carries a profile value.
 */
export const FLEET_PROFILE_MANIFEST_KEYS = ["renderer", "identity", "memory", "skill_core", "extras", "limits"] as const;
export const FLEET_PROFILE_MANIFEST_RENDERER_KEYS = ["submodule", "script", "lock_helper", "check_argv", "lock_timeout_seconds", "lock_pattern"] as const;
export const FLEET_PROFILE_MANIFEST_IDENTITY_KEYS = ["file", "allowed_keys", "inert_keys"] as const;
export const FLEET_PROFILE_MANIFEST_MEMORY_KEYS = ["pin_file", "bank_id_template", "reserved_bank_ids"] as const;
export const FLEET_PROFILE_MANIFEST_SKILL_CORE_KEYS = ["canonical_dir", "canonical_dir_env", "required", "source"] as const;
export const FLEET_PROFILE_MANIFEST_EXTRAS_KEYS = ["ignored_patterns", "backup_patterns"] as const;
export const FLEET_PROFILE_MANIFEST_LIMITS_KEYS = ["max_file_bytes", "max_root_entries", "max_unit_files", "max_extra_skills"] as const;

/**
 * Closed key sets for the `service_manifest` root block (schema 5) and each of
 * its seven sub-blocks.
 *
 * POLICY about the user manager's canonical service state, never a copy of a
 * unit file: how many samples make a stability window and how far apart, how
 * the manager is probed and what a child may inherit, which entrypoint counts
 * as pinned and which environment key names the profile home, how a registry
 * row DECLARES its messaging capability (the desired gateway state is derived
 * from that declaration, never read back from the unit), what the heartbeat
 * schedule and its reconcile evidence are, which unit names are retired
 * shapes, and the caps every read is bounded by.
 */
export const FLEET_SERVICE_MANIFEST_KEYS = ["stabilization", "probe", "entrypoint", "messaging", "heartbeat", "unregistered", "limits"] as const;
export const FLEET_SERVICE_MANIFEST_STABILIZATION_KEYS = ["samples", "interval_ms"] as const;
export const FLEET_SERVICE_MANIFEST_PROBE_KEYS = ["timeout_ms", "env_allowlist", "manager_available_states"] as const;
export const FLEET_SERVICE_MANIFEST_ENTRYPOINT_KEYS = ["launcher", "pinned_bin_field", "home_env"] as const;
export const FLEET_SERVICE_MANIFEST_MESSAGING_KEYS = [
  "platforms", "status_field", "verified_status", "deferred_statuses", "enabled_path", "secret_env", "identity_fields",
] as const;
export const FLEET_SERVICE_MANIFEST_HEARTBEAT_KEYS = [
  "on_boot_sec", "on_unit_inactive_sec", "overdue_multiplier", "max_tick_seconds", "reconcile_policy_file", "reconcile_state_file",
] as const;
export const FLEET_SERVICE_MANIFEST_UNREGISTERED_KEYS = ["unit_glob", "retired_candidates"] as const;
export const FLEET_SERVICE_MANIFEST_LIMITS_KEYS = ["max_units", "max_unregistered_units", "max_file_bytes", "max_show_bytes"] as const;

export const FLEET_COMPATIBILITY_KEYS = ["min_schema_version", "max_schema_version"] as const;

export const FLEET_AUTHORITY_KEYS = ["owner", "store", "store_env", "writable_fields", "read_only", "notes"] as const;

export const FLEET_PROJECTION_KEYS = ["field", "source", "target", "direction", "writable_by"] as const;

export const FLEET_CLASSIFICATION_KEYS = ["required_fields", "entries", "notes"] as const;

export const FLEET_RETIRED_KEYS = ["id", "reason", "superseded_by", "detect"] as const;

/** Lifecycle classes every observation must land in. */
export const FLEET_CLASSIFICATION_IDS = [
  "managed_agent", "managed_shared_service", "intentionally_unmanaged", "retired", "unclassified",
] as const;
export type FleetClassificationId = (typeof FLEET_CLASSIFICATION_IDS)[number];

/**
 * Fields every entry of a managed class other than `managed_agent` must carry.
 *
 * A registered agent is a registry row and needs no rationale to exist. Every
 * other managed thing is an exception someone decided to keep, so it has to say
 * who owns it, where it came from, why it stays, and which policy domains apply
 * -- otherwise "managed" degrades into "we saw it once".
 */
export const FLEET_CLASSIFICATION_REQUIRED_FIELDS = [
  "id", "kind", "owner", "source", "lifecycle_state", "rationale", "policy_domains",
] as const;

/** The five states discovery must not be allowed to collapse. */
export const FLEET_ACTIVATION_STATES = [
  "discovered", "installed", "healthy", "routing_ready", "activated",
] as const;
export type FleetActivationState = (typeof FLEET_ACTIVATION_STATES)[number];

/** Retired modes the contract must name so they can be detected, never provisioned. */
export const FLEET_RETIRED_IDS = [
  "per-agent-bloodbank-consumer",
  "per-agent-checkpoint-timer",
  "n8n-owned-truth",
  "activation-by-discovery",
  "hard-coded-hermes-checkout-path",
] as const;

/**
 * Contract subtrees the retired-mode scan reads as "declared healthy".
 *
 * All of them, minus two deliberate exclusions. `retired` is the detection
 * vocabulary itself. And `classifications` is scanned selectively (see
 * FLEET_HEALTHY_CLASSIFICATIONS) because the `retired` and
 * `intentionally_unmanaged` classes exist precisely to RECORD a sighting of a
 * retired unit -- scanning them would make the two classes unusable for the one
 * job they have.
 */
export const FLEET_HEALTHY_SECTIONS = ["authorities", "projections", "service_model", "activation"] as const;

/** Lifecycle classes whose entries assert something is healthy and managed. */
export const FLEET_HEALTHY_CLASSIFICATIONS = ["managed_agent", "managed_shared_service"] as const;

/** Key names that must never appear in a contract at any depth. */
export const FLEET_FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"] as const;

/** Prefix marking a namespaced extension: preserved verbatim, never policy. */
export const FLEET_EXTENSION_PREFIX = "x-";

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

export interface FleetAuthority {
  owner: string;
  store: string;
  store_env: string[];
  writable_fields: string[];
  read_only?: boolean;
  notes?: string[];
}

export interface FleetProjection {
  field: string;
  source: string;
  target: string;
  direction: string;
  writable_by: string;
}

export interface FleetClassification {
  required_fields: string[];
  entries: Array<Record<string, unknown>>;
  notes?: string[];
}

export interface FleetServiceModel {
  per_agent: Record<string, unknown>;
  fleet_shared: Record<string, unknown>;
  profile_layout: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FleetActivation {
  states: string[];
  execution_authority: {
    field: string;
    owner: string;
    strict: boolean;
    default: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface FleetRetiredMode {
  id: string;
  reason: string;
  superseded_by: string;
  detect: string[];
}

/**
 * One capability no observer in this release can answer, and who owns it.
 *
 * `capability` is optional because a whole DOMAIN can be deferred (nothing in
 * this build reads the process table) while elsewhere only one named half is
 * (the Bloodbank routing RECORD is observed; its liveness is not). `reason` and
 * `owner_story` are both required: a deferral with no owner is an excuse.
 */
export interface FleetHealthPolicyDeferredCapability {
  domain: string;
  capability?: string;
  reason: string;
  owner_story: string;
}

/** One rule whose `warn` is somebody else's cadence rather than fleet drift. */
export interface FleetHealthPolicyAllowedWarning {
  rule_id: string;
  reason: string;
  owner: string;
}

/** One rule or domain whose `skip` is a declared property, not an omission. */
export interface FleetHealthPolicyAllowedSkip {
  domain?: string;
  rule_id?: string;
  reason: string;
}

/**
 * How long one recorded timestamp counts as current evidence.
 *
 * `field` must be a path some authority declares, so a policy entry cannot
 * silently be about a field nobody owns. `applies_to` is the status domain the
 * bucket lands on.
 */
export interface FleetHealthPolicyFreshness {
  field: string;
  max_age_days: number;
  applies_to: string;
}

/**
 * One agent whose drift in one domain an operator has ruled on.
 *
 * `(domain, agent_id)` is the key and is unique. The ruling rides the existing
 * justification axis as `kind: "exception"` with THIS entry's own contract path
 * as its `policy`: the drifted observation is still reported, still `fail`, and
 * still keeps `health.healthy` false -- what changes is that the agent lands in
 * the `exception` member bucket rather than `unhealthy`, exactly as a permitted
 * identity conflict does. `owner` is who made the ruling.
 */
export interface FleetHealthPolicyAgentException {
  domain: string;
  agent_id: string;
  reason: string;
  owner: string;
}

/**
 * The only thing that can JUSTIFY a gap.
 *
 * Nothing here grants a capability, relaxes the activation gate, or turns an
 * observation into a pass. An authorized gap is still reported with its own
 * state; what changes is whether the aggregate may claim it was PROVEN.
 */
export interface FleetHealthPolicy {
  required_domains: string[];
  deferred_capabilities: FleetHealthPolicyDeferredCapability[];
  allowed_warnings: FleetHealthPolicyAllowedWarning[];
  allowed_skips: FleetHealthPolicyAllowedSkip[];
  freshness: FleetHealthPolicyFreshness[];
  /** Optional. Absent on a schema-2 contract, which then rules on no agent at all. */
  agent_exceptions?: FleetHealthPolicyAgentException[];
}

/** One asset compared for type and mode only, and the reason it is not compared for content. */
export interface FleetScaffoldPresenceOnly {
  path: string;
  reason: string;
}

/**
 * Policy about the tracked template, so the scaffold observer knows what a
 * role directory SHOULD contain without reading a worktree.
 *
 * `render_inputs` maps a template placeholder name to the contract field path
 * that feeds it -- `agents.{agent_id}` for the row's own id, a declared
 * `agents.{agent_id}.*` field, or a declared `projects.{slug}.*` field on the
 * correlated project record. `groups` maps each declared `scaffold.*` writable
 * leaf to the role-relative path it owns; a value ending in `/` owns a
 * directory. Every path the template renders must resolve to exactly one
 * group, or the source is `manifest-uncovered` and nothing is compared.
 */
export interface FleetScaffoldManifest {
  template_submodule: string;
  template_subdirectory: string;
  render_suffix: string;
  render_inputs: Record<string, string>;
  groups: Record<string, string>;
  presence_only: FleetScaffoldPresenceOnly[];
  excluded_patterns: string[];
  runtime_dir: string;
}

/**
 * Policy about a GENERATED profile, so the profile observer knows what to
 * prove and with what, without reading anything a profile contains.
 *
 * `renderer` names the canonical base-plus-delta renderer inside the tracked
 * template submodule and the lock helper it insists on; the observer runs it
 * only after both files' blob ids equal the committed gitlink's. `identity`
 * says which keys a `profile.yaml` may carry and which it may carry INERTLY
 * (a `config:` block Hermes reads nowhere). `memory` spells the Hindsight bank
 * pin and the two ids that are never an identity. `skill_core` names the six
 * immutable skills and the canonical directory their bytes are compared
 * against. `extras` names the observer's own lock-file footprint (skipped and
 * never counted) and the backup shapes a retired-candidate wears. `limits`
 * bounds every read.
 */
export interface FleetProfileManifest {
  renderer: {
    submodule: string;
    script: string;
    lock_helper: string;
    check_argv: string[];
    lock_timeout_seconds: number;
    lock_pattern: string;
  };
  identity: {
    file: string;
    allowed_keys: string[];
    inert_keys: string[];
  };
  memory: {
    pin_file: string;
    /** Compatibility default for post/profile rows; named agents use their registry declaration. */
    bank_id_template: string;
    reserved_bank_ids: string[];
  };
  skill_core: {
    canonical_dir: string;
    canonical_dir_env: string;
    required: string[];
    source: string;
  };
  extras: {
    ignored_patterns: string[];
    backup_patterns: string[];
  };
  limits: {
    max_file_bytes: number;
    max_root_entries: number;
    max_unit_files: number;
    max_extra_skills: number;
  };
}

/**
 * Policy about the canonical SERVICE STATE of a deployed agent, so the systemd
 * observer knows what to prove against the user manager and how, without a
 * unit file's contents ever being declared here.
 *
 * `stabilization` is the observation window: every unit of interest is shown
 * `samples` times, `interval_ms` apart, in ONE child per sample. `probe` bounds
 * each child and names the manager states that count as available and the
 * environment keys a child may inherit. `entrypoint` says which `ExecStart`
 * counts as pinned (the role's launcher, or the executable the row's own
 * `hermes.bin` records) and which environment key names the profile home.
 * `messaging` is how a registry row DECLARES its gateway capability: a
 * platform whose `status_field` reads `verified_status` makes the gateway
 * `active`; only `deferred_statuses` make it `deferred`; anything else is
 * `undeclared`. `heartbeat` is the timer schedule the template writes, the
 * overdue multiplier that turns a last trigger into a bucket, and where the
 * reconcile policy and its evidence live in the role directory.
 * `unregistered` names the unit glob the sweep lists and the retired shapes.
 * `limits` bounds every read.
 */
export interface FleetServiceManifest {
  stabilization: {
    samples: number;
    interval_ms: number;
  };
  probe: {
    timeout_ms: number;
    env_allowlist: string[];
    manager_available_states: string[];
  };
  entrypoint: {
    launcher: string;
    pinned_bin_field: string;
    home_env: string;
  };
  messaging: {
    platforms: string[];
    status_field: string;
    verified_status: string;
    deferred_statuses: string[];
    enabled_path: string;
    secret_env: Record<string, string[]>;
    identity_fields: Record<string, string[]>;
  };
  heartbeat: {
    on_boot_sec: number;
    on_unit_inactive_sec: number;
    overdue_multiplier: number;
    max_tick_seconds: number;
    reconcile_policy_file: string;
    reconcile_state_file: string;
  };
  unregistered: {
    unit_glob: string;
    retired_candidates: string[];
  };
  limits: {
    max_units: number;
    max_unregistered_units: number;
    max_file_bytes: number;
    max_show_bytes: number;
  };
}

export interface FleetContract {
  schema_version: number;
  contract_version: string;
  compatibility: { min_schema_version: number; max_schema_version: number };
  authorities: Record<string, FleetAuthority>;
  projections: FleetProjection[];
  classifications: Record<string, FleetClassification>;
  service_model: FleetServiceModel;
  activation: FleetActivation;
  retired: FleetRetiredMode[];
  /** Optional. Absent on a schema-1 contract, which then authorizes no gap at all. */
  health_policy?: FleetHealthPolicy;
  /** Optional. Absent on a schema-1/2 contract, which then declares no scaffold to compare against. */
  scaffold_manifest?: FleetScaffoldManifest;
  /** Optional. Absent on a schema-1..3 contract, which then declares no generated-profile policy to prove. */
  profile_manifest?: FleetProfileManifest;
  /** Optional. Absent on a schema-1..4 contract, which then declares no canonical service state to prove. */
  service_manifest?: FleetServiceManifest;
}

/** One namespaced extension, kept out of policy and reported separately. */
export interface FleetExtension {
  path: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Diagnostics and errors
// ---------------------------------------------------------------------------

export type FleetErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "AUTHORITY_CONFLICT"
  | "INVALID_CLASSIFICATION"
  | "RETIRED_MODE"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INTERNAL_ERROR"
  | "TIMEOUT"
  | "CANCELLED";

export const FLEET_ERROR_CODES = [
  "INVALID_INPUT", "NOT_FOUND", "AUTHORITY_CONFLICT", "INVALID_CLASSIFICATION",
  "RETIRED_MODE", "UNSUPPORTED_SCHEMA_VERSION", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED",
] as const;

/**
 * One finding, always addressed by a dotted field path.
 *
 * `path` is where in the contract the problem is, never where on the host --
 * an operator has to be able to open the file at that key without the
 * diagnostic having leaked anything about the machine that produced it.
 */
export interface FleetDiagnostic {
  code: FleetErrorCode;
  path: string;
  message: string;
}

export class FleetError extends Error {
  override readonly name = "FleetError";

  constructor(
    readonly code: FleetErrorCode,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Deterministic, categorized exit codes.
 *
 * Banded the way `notebookExitCode` bands its taxonomy: 2 is malformed input,
 * 3 is "the thing is not there", 4 is a contract the file states but must not,
 * 5 is a version this build cannot speak, 6 is us, 7 is "we ran out of the time
 * you gave us", 8 is "you asked us to stop".
 *
 * The switch is exhaustive with no `default` on purpose: a new code that forgets
 * an exit band is a compile error rather than an `undefined` exit status.
 */
export function fleetExitCode(code: FleetErrorCode): number {
  switch (code) {
    case "INVALID_INPUT": return 2;
    case "NOT_FOUND": return 3;
    case "AUTHORITY_CONFLICT":
    case "INVALID_CLASSIFICATION":
    case "RETIRED_MODE": return 4;
    case "UNSUPPORTED_SCHEMA_VERSION": return 5;
    case "INTERNAL_ERROR": return 6;
    case "TIMEOUT": return 7;
    case "CANCELLED": return 8;
  }
}

// ---------------------------------------------------------------------------
// Fleet inventory (story 1.2)
//
// The contract above says who OWNS a field. Everything below says what the
// stores actually CONTAIN and where they disagree. The two vocabularies live in
// one file on purpose: an inventory row exists to carry a value together with
// the contract-declared authority that owns it, and splitting them would make
// it possible to add a reported field with no declared owner.
// ---------------------------------------------------------------------------

/**
 * Hard cap on rows carried in one inventory envelope.
 *
 * Deliberately not `MAX_ITEMS` (100) from the envelope's generic list bound:
 * running the rows array through `boundedValue` would silently drop agent 101
 * of a growing fleet, which is the exact failure an inventory exists to
 * prevent. Rows are capped here, at a fleet-shaped number, and every clip is
 * recorded in `truncated` and flips `health.truncated`.
 */
export const FLEET_INVENTORY_MAX_ROWS = 1000;

/**
 * What is known about one reported value.
 *
 * `resolved`   the owning store gave a usable value and everything this command
 *              can check about it checks out.
 * `unresolved` absent, blank, unusable, or a referent this command could not
 *              correlate or classify as ok. Never a guess.
 * `conflicted` the value is claimed by more than one agent.
 * `unobserved` this command deliberately does not look. Expected unit names are
 *              expectations, not observations -- probing systemd is story 1.8.
 */
export const FLEET_FIELD_STATES = ["resolved", "unresolved", "conflicted", "unobserved"] as const;
export type FleetFieldState = (typeof FLEET_FIELD_STATES)[number];

/** One reported value, its contract-declared authority owner, and what is known about it. */
export interface FleetFieldValue<T = string> {
  value: T | null;
  /** The `owner` the contract declares for this field path, or null if it declares none. */
  source: string | null;
  state: FleetFieldState;
}

/**
 * What a declared path IS, established by `lstat` and never by following it.
 *
 * A symlink is reported as a symlink with its target recorded beside it; the
 * target is evidence, never a substitute for the declared value.
 */
export const FLEET_PATH_CLASSIFICATIONS = [
  "ok", "absent", "relative", "symlink", "outside-root", "not-a-directory", "unreadable", "undeclared",
] as const;
export type FleetPathClassification = (typeof FLEET_PATH_CLASSIFICATIONS)[number];

export interface FleetPathView {
  /** The value as declared, bounded and home-redacted. Never a realpath. */
  declared: string | null;
  classification: FleetPathClassification;
  /** Bounded link target when `classification` is `symlink`, else null. */
  link_target: string | null;
}

/** The board binding an agent row stores. Projected from the project registry. */
export interface FleetBoardBinding {
  workspace: string | null;
  project_id: string | null;
  identifier: string | null;
}

/**
 * A repository `.project.json`, read as a third opinion and nothing more.
 *
 * It is never the `source` of a field and never a tiebreaker between the two
 * registries: a manifest that disagrees produces a finding, not a value.
 */
export interface FleetManifestEvidence {
  path: FleetPathView;
  present: boolean;
  /** null when there is no manifest to agree or disagree with. */
  agrees: boolean | null;
  notes: string[];
}

/** One row per raw `agents:` entry, whatever shape that entry turned out to be. */
export interface FleetInventoryRow {
  agent_id: FleetFieldValue<string>;
  /**
   * The lifecycle class the CONTRACT declares for this row.
   *
   * Typed against `FLEET_CLASSIFICATION_IDS` rather than `string` (DW-30): the
   * bare literals it used to carry were checked by nothing, so a typo compiled
   * and shipped and the `intentionally_unmanaged` value was unreachable even
   * though the contract declares the class and story 1.5 counts agents into it.
   */
  classification: FleetFieldValue<FleetClassificationId>;
  correlation: FleetFieldValue<string>;
  project_id: FleetFieldValue<string>;
  repo: FleetFieldValue<string>;
  repo_path: FleetFieldValue<string>;
  role: FleetFieldValue<string>;
  /** Stable person/agent identity. Unlike profile_name, this survives a change of post. */
  identity: FleetFieldValue<string>;
  /**
   * The agent's RUNTIME, as data rather than assumption. The registry encoded
   * hermes implicitly in ~6 places per row (profile_name, hermes.*,
   * systemd.gateway_unit) but never named it, while Redis ASM has always keyed
   * agents by runtime type — hermes | claude | codex. This is that key.
   */
  type: FleetFieldValue<string>;
  role_dir: FleetFieldValue<string>;
  profile_name: FleetFieldValue<string>;
  /** Explicit personal-bank declaration for a named agent, when present. */
  hindsight_write_bank: FleetFieldValue<string>;
  profile_path: FleetFieldValue<string>;
  runtime_path: FleetFieldValue<string>;
  expected_units: FleetFieldValue<string[]>;
  /** The unit name the registry STORES, as opposed to the ones the contract derives. */
  gateway_unit: FleetFieldValue<string>;
  board: FleetFieldValue<FleetBoardBinding>;
  bloodbank_scope: FleetFieldValue<string>;
  bloodbank_target: FleetFieldValue<string>;
  activation: FleetFieldValue<boolean>;
  /** The contract's declared execution-authority field path, reported not evaluated. */
  activation_field: FleetFieldValue<string>;
  manifest: FleetManifestEvidence;
  paths: Record<string, FleetPathView>;
  /** Ids of every conflict group this row participates in. */
  conflicts: string[];
  /** Codes of every finding raised against this row. */
  findings: string[];
  malformed: boolean;
}

/**
 * Two or more claimants on one value of one field path.
 *
 * `participants` are the claimants (agent ids, or project-registry record keys
 * for a registry-internal duplicate). `owners` are the authority owners the
 * contract declares for the field path. AC5 wants the group to name both.
 */
export interface FleetConflictGroup {
  id: string;
  field: string;
  dimension: string;
  value: string;
  participants: string[];
  participant_kind: "agent" | "project";
  owners: string[];
  permitted: boolean;
  exception_id: string | null;
}

export const FLEET_FINDING_SEVERITIES = ["error", "warn", "info"] as const;
export type FleetFindingSeverity = (typeof FLEET_FINDING_SEVERITIES)[number];

export interface FleetInventoryFinding {
  code: string;
  field: string;
  agent_id: string | null;
  source: string | null;
  severity: FleetFindingSeverity;
  detail: string;
}

/**
 * Counted independently of row building.
 *
 * `source_rows` is counted from the raw `agents:` mapping keys in its own pass
 * BEFORE any row is built, so a row-builder bug surfaces as
 * `source_rows != emitted_rows` instead of as an inventory that quietly lost an
 * agent.
 */
export interface FleetInventoryTotals {
  source_rows: number;
  emitted_rows: number;
  /** Rows matching the current scope, before the row cap. */
  selected: number;
  /** Rows actually carried in `rows`, after the row cap. */
  observed: number;
  malformed_rows: number;
  registered_agents: number;
  project_records: number;
  correlated: number;
  uncorrelated: number;
  conflict_groups: number;
  permitted_conflict_groups: number;
  findings: number;
}

export interface FleetInventoryHealth {
  healthy: boolean;
  conflicts: number;
  permitted_conflicts: number;
  contract_violations: number;
  malformed_rows: number;
  unresolved_rows: number;
  collection_errors: number;
  truncated: boolean;
}

export interface FleetStoreView {
  id: string;
  owner: string | null;
  store: string | null;
  env_keys: string[];
  /** The canonical path, whatever `--*-registry` said. Bounded and home-redacted. */
  configured_path: string;
  /** The path actually opened. Equals `configured_path` unless overridden. */
  inspected_path: string;
  overridden: boolean;
  exists: boolean;
  source_rows: number;
  parse: "ok" | "salvaged" | "unreadable";
}

export interface FleetInventoryScope {
  kind: "fleet" | "agent";
  agent_id: string | null;
  label: string;
}

export interface FleetInventory {
  contract_path: string;
  contract_version: string | null;
  scope: FleetInventoryScope;
  stores: FleetStoreView[];
  totals: FleetInventoryTotals;
  health: FleetInventoryHealth;
  rows: FleetInventoryRow[];
  conflicts: FleetConflictGroup[];
  findings: FleetInventoryFinding[];
  /** Dotted paths where a bound clipped the reported value. */
  truncated: string[];
}

// ---------------------------------------------------------------------------
// Fleet provenance (story 1.3)
//
// The inventory above says what the stores CONTAIN. Everything below says which
// build each thing actually is, by pairing every recorded/pinned value with its
// live counterpart. Same file, same reason: a reported provenance field cannot
// exist without a declared owner beside it.
//
// ONE GLOBAL RULE: `desired` is the recorded/pinned/declared side; `observed` is
// the live side. That is what makes the template gitlink structural rather than
// defensive -- the recorded gitlink is read from the PARENT's index and lands in
// `desired`, so no worktree movement can ever make it report the worktree's SHA.
// ---------------------------------------------------------------------------

/**
 * What one fact concluded. Absence is never a match.
 *
 * `match`       both sides are present and equal.
 * `mismatch`    both sides are present and differ.
 * `dirty`       a cleanliness fact whose observed side is not clean. Its own
 *               status, never a modifier on a value comparison, so it can never
 *               shadow a `mismatch` on the value beside it.
 * `missing`     a side that should carry a value carries none.
 * `unsupported` no comparable value can be obtained without inventing one --
 *               nothing on this host RECORDS the desired value (a deployed role
 *               scaffold carries no template ref), or the recorded value is a
 *               form this command must not resolve (an unexpanded `$VAR`).
 *               Observed evidence is still reported; nothing is guessed.
 * `unobserved`  the probe did not run, or ran and failed. Nothing may be claimed.
 */
export const FLEET_PROVENANCE_STATUSES = [
  "match", "mismatch", "dirty", "missing", "unsupported", "unobserved",
] as const;
export type FleetProvenanceStatus = (typeof FLEET_PROVENANCE_STATUSES)[number];

/**
 * Status precedence WITHIN one fact, strongest first.
 *
 * `unobserved` outranks everything: if the probe did not run, nothing may be
 * claimed. This is the concrete form of "the aggregate does not turn absence
 * into a match".
 */
export const FLEET_PROVENANCE_STATUS_PRECEDENCE = [
  "unobserved", "unsupported", "missing", "dirty", "mismatch", "match",
] as const satisfies readonly FleetProvenanceStatus[];

/** What is known about ONE side of a fact. */
export const FLEET_PROVENANCE_SIDE_STATES = ["present", "missing", "unsupported", "unobserved"] as const;
export type FleetProvenanceSideState = (typeof FLEET_PROVENANCE_SIDE_STATES)[number];

/** How a probe ended. `skipped` is a decision not to run, never a silent absence. */
export const FLEET_PROBE_OUTCOMES = ["ok", "failed", "timeout", "cancelled", "skipped"] as const;
export type FleetProbeOutcome = (typeof FLEET_PROBE_OUTCOMES)[number];

/**
 * Hard caps on what one provenance envelope carries.
 *
 * Deliberately not `MAX_ITEMS` (100) from the envelope's generic list bound, for
 * the same reason `FLEET_INVENTORY_MAX_ROWS` is not: running the facts array
 * through `boundedValue` would silently drop agent 101's facts, which is the
 * exact failure a provenance report exists to prevent. Both caps record every
 * clip in `truncated`.
 */
export const FLEET_PROVENANCE_MAX_FACTS = 5000;
export const FLEET_PROVENANCE_MAX_PROBES = 500;

/**
 * One side of one fact.
 *
 * `source` names WHERE the value came from -- a store id, a config file, a live
 * probe -- not who is allowed to write it; the fact's `owner` carries that.
 * `family` is set only where a value belongs to a named executable/checkout
 * family (the contract's `retired[].detect` classes, or the configured release
 * root); everywhere else it is null.
 *
 * `classification` is set only where the value is a path this run `lstat`ed. It
 * is what the path IS, established without following it -- never a realpath
 * substituted for the declared value.
 */
export interface FleetProvenanceSide {
  value: string | null;
  source: string | null;
  state: FleetProvenanceSideState;
  family: string | null;
  classification: FleetPathClassification | null;
}

/**
 * One recorded-versus-live comparison.
 *
 * `id` is the fact KIND, not a unique key: `hermes.git_sha` appears once per
 * agent. The array key is `(scope, agent_id, id)` and that tuple is also the
 * sort order.
 */
export interface FleetProvenanceFact {
  id: string;
  scope: "fleet" | "agent";
  agent_id: string | null;
  /** The contract field path this fact is about, or a `{placeholder}` path for a host artifact. */
  field: string;
  /** The authority owner the CONTRACT declares for `field`, or null if it declares none. */
  owner: string | null;
  desired: FleetProvenanceSide;
  observed: FleetProvenanceSide;
  status: FleetProvenanceStatus;
  detail: string;
}

/**
 * One bounded child probe, recorded whether or not it produced a value.
 *
 * Never carries stderr, a raw command line, or a duration: `probe()` parses
 * stdout into a single value and discards the rest, and a duration would make
 * two runs over identical state produce different `data`.
 */
export interface FleetProbeRecord {
  /** Stable id: `{kind}:{redacted target}`. */
  id: string;
  kind: string;
  /** The directory or artifact probed, bounded and home-redacted. */
  target: string;
  outcome: FleetProbeOutcome;
  /** A stable category (`not-a-repository-root`, `absent`, ...), never a subprocess message. */
  reason: string | null;
}

/** One source this run read, with the same configured/inspected split the stores use. */
export interface FleetProvenanceSourceView {
  id: string;
  kind: string;
  configured_path: string;
  inspected_path: string;
  exists: boolean;
  parse: "ok" | "salvaged" | "unreadable" | "unread";
}

export interface FleetProvenanceTotals {
  /** Registered agents in the whole fleet, scope-independent. Equals the inventory's `registered_agents`. */
  agents: number;
  /** Facts built, before the scope filter and the fact cap. `classified_facts + dropped_facts`. */
  facts: number;
  /**
   * Facts that reached a status bucket -- what `by_status` sums to, always.
   *
   * Held apart from `facts` because a fact dropped at the cap has no status:
   * summing `by_status` against `facts` was an invariant that held only while
   * the cap did not engage.
   */
  classified_facts: number;
  /** Facts refused at `FLEET_PROVENANCE_MAX_FACTS`. Counted in `facts`, absent from `by_status`. */
  dropped_facts: number;
  /** Facts actually carried in `facts`. */
  emitted_facts: number;
  probes: number;
  by_status: Record<FleetProvenanceStatus, number>;
  findings: number;
}

export interface FleetProvenanceHealth {
  /**
   * Drift-free: no mismatch, no dirty, no missing.
   *
   * Clipping is deliberately NOT part of this. A truncated but drift-free run is
   * `healthy: true, complete: false` -- which is the whole reason there are two
   * verdicts rather than one.
   */
  healthy: boolean;
  /** Everything that could be observed was: no `unobserved` fact and no failed probe. */
  complete: boolean;
  mismatched: number;
  dirty: number;
  missing: number;
  unsupported: number;
  unobserved: number;
  probe_failures: number;
  truncated: boolean;
}

export interface FleetProvenance {
  contract_path: string;
  contract_version: string | null;
  scope: FleetInventoryScope;
  sources: FleetProvenanceSourceView[];
  totals: FleetProvenanceTotals;
  health: FleetProvenanceHealth;
  facts: FleetProvenanceFact[];
  probes: FleetProbeRecord[];
  findings: FleetInventoryFinding[];
  /** Dotted paths where a bound clipped the reported value. */
  truncated: string[];
}

// ---------------------------------------------------------------------------
// Fleet status (story 1.4)
//
// The inventory says what the stores CONTAIN; provenance says which BUILD each
// agent runs. Neither answers "is the fleet correct?" in one invocation. That is
// this block's vocabulary: nine observation domains, seven states under one
// precedence, and two verdicts.
//
// Same file, same reason as the two blocks above: a reported status field cannot
// exist without a declared owner beside it. The `FleetStatus*` prefix keeps every
// name clear of the ones inventory and provenance already took.
// ---------------------------------------------------------------------------

/**
 * The nine observation domains. Every one appears in every result.
 *
 * A domain may never disappear silently -- it is either observed or carries an
 * explicit `unobserved`/`unsupported` observation with a reason. That is the one
 * outcome this vocabulary exists to prevent.
 *
 * DELIBERATELY NOT the contract's `policy_domains`. That is a different,
 * three-value axis (`systemd`, `bloodbank`, `profile`) declared per managed
 * exception at `contracts/handbook.yaml:274-285`; conflating the two would
 * quietly widen a contract field that means something else. Widening the
 * contract is story 1.1's authority.
 */
export const FLEET_STATUS_DOMAINS = [
  "registry",
  "project_binding",
  "template_scaffold",
  "profile",
  "runtime",
  "systemd",
  "live_process",
  "bloodbank",
  "release_provenance",
] as const;
export type FleetStatusDomain = (typeof FLEET_STATUS_DOMAINS)[number];

/**
 * What one observation concluded.
 *
 * `pass`        observed, and in the state it should be in.
 * `warn`        observed, imperfect, and NOT a gate -- matching `gatesProject`
 *               in `src/recipes/types.ts`, where a warn has never gated a repo.
 * `skip`        DECLARED NOT APPLICABLE. Does not reduce completeness.
 * `fail`        observed, and wrong.
 * `unsupported` no adapter exists in this release. Counted and visible, but it
 *               cannot reduce `complete` -- a flag that is permanently false
 *               says nothing.
 * `unobserved`  applicable, and not read. Reduces `complete`.
 * `error`       collection itself failed. Never silently a `pass`, never a
 *               dropped agent.
 */
export const FLEET_STATUS_STATES = ["pass", "warn", "skip", "fail", "unsupported", "unobserved", "error"] as const;
export type FleetStatusState = (typeof FLEET_STATUS_STATES)[number];

/**
 * Precedence, strongest first, applied WITHIN one domain and then ACROSS domains.
 *
 * `error` outranks everything: a domain whose collection failed may not report
 * the state of the half that did work. `unobserved` outranks the observed states
 * for the same reason provenance's does -- if it was not read, nothing may be
 * claimed.
 *
 * ONE EXCEPTION, AND IT IS PART OF THE RULE, NOT A DEVIATION FROM IT:
 * `unsupported` sits above `fail` here and YIELDS whenever the domain produced
 * any other state. `unsupported` says "no adapter exists in this release" -- a
 * statement about this BUILD, not about the fleet -- so for a domain with
 * nothing else (`live_process`) it is correctly the strongest answer, and for a
 * MIXED domain it is the weakest thing to report: `template_scaffold` carries a
 * permanent "a deployed role scaffold records no template ref" beside its real
 * findings, and the raw order rolled that domain up to `unsupported` while 135
 * assets were failing. `rollUp` therefore drops `unsupported` from the candidate
 * set when anything else is present, and then walks THIS array. Read the two
 * together or the constant will mislead you; DW-67 records the history.
 *
 * Iterated by `rollUp`, not merely declared: a precedence constant nothing reads
 * is decoration (the exact defect story 1.3's review found in
 * `FLEET_PROVENANCE_STATUS_PRECEDENCE`).
 */
export const FLEET_STATUS_STATE_PRECEDENCE = [
  "error", "unobserved", "unsupported", "fail", "warn", "skip", "pass",
] as const satisfies readonly FleetStatusState[];

/**
 * Hard cap on agent records carried in one status envelope.
 *
 * DELIBERATELY BELOW `FLEET_INVENTORY_MAX_ROWS` (1000). A status record is an
 * order of magnitude larger than an inventory row -- nine domains, each with one
 * or more observations carrying bounded details -- so the fleet-shaped number is
 * smaller here. It also has to be the cap that actually fires: at 1000 the
 * inventory would clip first and this one could never be reached, which is a cap
 * no test can prove and therefore a cap nobody should trust.
 */
export const FLEET_STATUS_MAX_AGENTS = 500;

/** Cap on observations carried on ONE agent record. Every clip is recorded and retrievable. */
export const FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT = 200;

/** Cap on findings carried in one envelope, so a broken fleet stays one document. */
export const FLEET_STATUS_MAX_FINDINGS = 2000;

/** Cap on detail lines carried on one observation. Matches the envelope's own detail bound. */
export const FLEET_STATUS_MAX_DETAILS = 20;

/**
 * How many recipe-audit children run at once.
 *
 * Measured: 18 real repositories audit in ~1.3 s in-process (35-410 ms each), so
 * ~28 repositories as children is ~28 node startups. Four in flight keeps that
 * near the in-process cost without turning an observation command into a load
 * spike on the operator's own machine.
 */
export const FLEET_STATUS_AUDIT_CONCURRENCY = 4;

/**
 * How many role directories the scaffold observer reads at once.
 *
 * Each agent costs a handful of local `git` reads plus one `lstat`/read per
 * owned asset (51 on the current template). Four in flight is the audit's
 * number and for the same reason: it keeps an observation command from
 * becoming a load spike on the operator's own machine.
 */
export const FLEET_STATUS_SCAFFOLD_CONCURRENCY = 4;

/**
 * Cap on typed `items` carried on ONE observation.
 *
 * Its own cap, recorded per observation in `truncated`, never `boundedValue`
 * (which slices at 100 with no clip record). The counts on the observation and
 * on `agents[].scaffold` are computed over EVERY item before this cap applies,
 * so a bound on what the envelope carries never moves what it concludes.
 */
export const FLEET_STATUS_MAX_ITEMS = 100;

/** Cap on `agents[].scaffold.wip_overlap` paths carried. The count beside it is uncapped. */
export const FLEET_STATUS_MAX_WIP_OVERLAP = 20;

/**
 * How many profiles the profile observer inspects at once.
 *
 * Each agent costs a handful of `lstat`s, four bounded reads and ONE child --
 * the canonical renderer's `check`, which takes that profile's own lock. Four
 * in flight is the audit's number, and for the same reason: an observation
 * command must not become a load spike on the operator's machine.
 */
export const FLEET_STATUS_PROFILE_CONCURRENCY = 4;

/**
 * CEILINGS on the profile observer's bounds. The tracked contract's
 * `profile_manifest.limits` may lower any of them and may not exceed them: a
 * policy that asked this observer to read a gigabyte would be validating a
 * memory problem, not declaring one.
 */
/** Bytes of one profile file (`profile.yaml`, the delta, the generated config, the pin, a `SKILL.md`) this observer will read. */
export const PROFILE_MAX_FILE_BYTES = 1024 * 1024;
/** Entries of the profile root enumerated in one sweep. */
export const PROFILE_MAX_ROOT_ENTRIES = 5000;
/** Unit files scanned for `HERMES_HOME=` references when classifying an extra entry. */
export const PROFILE_MAX_UNIT_FILES = 500;
/** Optional (non-core) skills named on one agent's record. */
export const PROFILE_MAX_EXTRA_SKILLS = 20;

/**
 * How many agents the systemd observer evaluates at once.
 *
 * The user manager is sampled ONCE for the whole fleet (one `show` per sample,
 * every unit of interest in its argv), so per-agent work is pure evaluation
 * plus two bounded role-directory reads -- the reconcile policy and its state
 * file. Four in flight is the same number every other observer uses, and for
 * the same reason.
 */
export const FLEET_STATUS_SYSTEMD_CONCURRENCY = 4;

/**
 * CEILINGS on the systemd observer's bounds. The tracked contract's
 * `service_manifest` may lower any of them and may not exceed them.
 */
/** Samples in one stability window. Ten one-second samples is already a long observation command. */
export const SYSTEMD_MAX_SAMPLES = 10;
/** Millis between two samples. */
export const SYSTEMD_MAX_INTERVAL_MS = 10_000;
/** Wall-clock budget for one `systemctl` child. */
export const SYSTEMD_MAX_PROBE_TIMEOUT_MS = 60_000;
/** Units one listing may carry before the sweep stops and says so. */
export const SYSTEMD_MAX_UNITS = 1000;
/** Unregistered units classified in one sweep. */
export const SYSTEMD_MAX_UNREGISTERED_UNITS = 200;
/** Bytes of one role-directory file (the reconcile policy, its state) the observer will read. */
export const SYSTEMD_MAX_FILE_BYTES = 64 * 1024;
/** Bytes one `show` child may produce. Equals the runtime's own probe cap. */
export const SYSTEMD_MAX_SHOW_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Fleet health (story 1.5)
//
// Story 1.4 reports WHAT every domain observed. It cannot say whether the
// answer is TRUSTWORTHY or ACTIONABLE: `health.healthy` is `fail === 0 &&
// error === 0`, so a default run over a fleet where three domains have no
// observer at all and every audit-fed domain is `unobserved` still reads
// `healthy: true`.
//
// The vocabulary below is what makes that impossible. Four SEPARATE axes --
// applicability, evidence, freshness and state -- because one word cannot carry
// four questions; a severity, a repair class and one exact next action derived
// from real fields rather than from prose; and a three-way verdict beside
// `healthy` rather than instead of it, so 1.4's meaning is preserved and the
// aggregate still cannot claim health over an unread fleet.
// ---------------------------------------------------------------------------

/**
 * Whether an observation was REQUIRED, and if not, on whose authority.
 *
 * `required`       the contract's `health_policy.required_domains` names its
 *                  domain (and with no policy at all, everything is required --
 *                  the conservative reading, never the flattering one).
 * `optional`       a domain the policy does not require.
 * `not_applicable` the observation itself says so: a `skip`.
 * `deferred`       a capability `health_policy.deferred_capabilities` declares
 *                  no observer exists for in this release, with the story that
 *                  owns it.
 * `exception`      a managed exception the contract records under
 *                  `classifications.intentionally_unmanaged`.
 *
 * DW-67 left open "whether a domain with no adapter deserves an axis separate
 * from a domain with an unread half". This is that axis: `deferred` beside
 * `evidence: "absent"` says exactly that, which is why `unsupported` needs no
 * different rank in `FLEET_STATUS_STATE_PRECEDENCE`.
 */
export const FLEET_STATUS_APPLICABILITIES = [
  "required", "optional", "not_applicable", "deferred", "exception",
] as const;
export type FleetStatusApplicability = (typeof FLEET_STATUS_APPLICABILITIES)[number];

/**
 * How strongly the observation is supported.
 *
 * `direct`   this run read the thing itself.
 * `declared` a registry field asserts it and nothing verified it. "A timer is
 *            active, a gateway process exists, a deploy exited zero, a board
 *            says complete" all reduce to this. A `declared` observation may be
 *            `pass` on its own record, but it may never set
 *            `capability_readiness: "ready"` and never contribute to `proven`.
 * `derived`  computed from other observations rather than read (an identity
 *            conflict is a fact about the whole registry, not about one row).
 * `absent`   nothing was read at all: `unobserved`, `unsupported`, `error`.
 */
export const FLEET_STATUS_EVIDENCE = ["direct", "declared", "derived", "absent"] as const;
export type FleetStatusEvidence = (typeof FLEET_STATUS_EVIDENCE)[number];

/**
 * Whether the evidence is still current, as a BUCKET and never as an age.
 *
 * `data` must be byte-identical across two consecutive runs. An age in seconds
 * is not, so the reference instant is captured once per run, each policy entry
 * declares `max_age_days`, and only the bucket is emitted.
 *
 * `not_applicable` is the honest default: most observations have no timestamp
 * behind them and no policy entry claiming one. `unknown` means a policy entry
 * DOES apply and the timestamp is absent or unparseable -- which is a different
 * problem from "no policy applies" and must not collapse into it.
 */
export const FLEET_STATUS_FRESHNESS = ["current", "stale", "unknown", "not_applicable"] as const;
export type FleetStatusFreshness = (typeof FLEET_STATUS_FRESHNESS)[number];

/**
 * Freshness precedence, worst first, when several policy entries apply to one
 * observation.
 *
 * `unknown` sits above `current` because a policy entry that DOES apply to a
 * field nothing populates is a question this run could not answer, and the
 * better of two readings must not be the one that survives -- the same
 * worst-wins rule the host block already has to follow.
 *
 * Declared here rather than in `health.ts` because every new vocabulary belongs
 * in one file: an ordering that lives beside its only consumer is one the
 * suite's "every declared vocabulary is spelled the same" check cannot see.
 */
export const FLEET_STATUS_FRESHNESS_PRECEDENCE = [
  "stale", "unknown", "current", "not_applicable",
] as const satisfies readonly FleetStatusFreshness[];

/** What one finding is ABOUT: the whole fleet, this machine, or one row. */
export const FLEET_STATUS_SCOPES = ["fleet", "host", "agent"] as const;
export type FleetStatusScopeKind = (typeof FLEET_STATUS_SCOPES)[number];

/**
 * Scope precedence for the finding sort, broadest blast radius first.
 *
 * A fleet-scoped finding is true of everything, a host one of this machine, an
 * agent one of a single row -- so an operator reading a capped list sees the
 * widest statement before the narrowest.
 */
export const FLEET_STATUS_SCOPE_PRECEDENCE = [
  "fleet", "host", "agent",
] as const satisfies readonly FleetStatusScopeKind[];

/**
 * How badly this needs a decision. Derived from `state` x `applicability`.
 *
 * Deliberately NOT `FLEET_FINDING_SEVERITIES` (`error`/`warn`/`info`). That
 * three-value axis is the inventory's finding severity and means something
 * else; overloading it would make "an error-severity finding" and "a critical
 * observation" the same word for two different questions.
 */
export const FLEET_STATUS_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FleetStatusSeverity = (typeof FLEET_STATUS_SEVERITIES)[number];

/**
 * Severity precedence, strongest first.
 *
 * Iterated by `compareStatusFindings`, not merely declared: a precedence
 * constant nothing reads is decoration, which is the exact defect story 1.3's
 * review found in `FLEET_PROVENANCE_STATUS_PRECEDENCE`.
 */
export const FLEET_STATUS_SEVERITY_PRECEDENCE = [
  "critical", "high", "medium", "low", "info",
] as const satisfies readonly FleetStatusSeverity[];

/**
 * WHO can repair this, and therefore what the next action can possibly be.
 *
 * `automatic`       an audit rule that reports `fixable` on a project scope --
 *                   `flume remediate` has a recipe for it.
 * `approval-gated`  it touches `activation.execution_authority`, which the
 *                   contract declares `strict: true, default: deny`. No
 *                   repository change grants it.
 * `blocked`         a contract-declared deferred capability. Nothing to run in
 *                   this release; the action names the owning story.
 * `other-owner`     a host-scoped rule. No amount of work in any repository
 *                   changes a condition about this machine.
 * `manual`          everything else that needs a decision.
 * `none`            nothing to repair: the observation passes, or its skip is
 *                   declared not applicable.
 */
export const FLEET_STATUS_REPAIRS = [
  "automatic", "approval-gated", "blocked", "other-owner", "manual", "none",
] as const;
export type FleetStatusRepair = (typeof FLEET_STATUS_REPAIRS)[number];

/**
 * Whether the recommended command is safe to run unread.
 *
 * A recommended command is read-only unless it is LABELLED, and a
 * `requires-authorization` action must name the authorization in the string
 * itself -- otherwise the label is the only thing standing between an operator
 * and a command that changes the fleet.
 */
export const FLEET_STATUS_NEXT_ACTION_CLASSES = ["read-only", "requires-authorization"] as const;
export type FleetStatusNextActionClass = (typeof FLEET_STATUS_NEXT_ACTION_CLASSES)[number];

/** On whose authority a non-pass observation is allowed to stand. */
export const FLEET_STATUS_JUSTIFICATION_KINDS = [
  "deferred_capability", "allowed_warning", "allowed_skip", "exception",
] as const;
export type FleetStatusJustificationKind = (typeof FLEET_STATUS_JUSTIFICATION_KINDS)[number];

/**
 * The contract entry that authorizes one gap.
 *
 * `policy` is the dotted path to the entry, so an operator can open the
 * contract at it. A justification is never inferred: with no `health_policy`
 * block, every non-pass carries `null` here and the fleet cannot claim proof.
 */
export interface FleetStatusJustification {
  kind: FleetStatusJustificationKind;
  policy: string;
  reason: string;
  owner: string | null;
}

/**
 * The three-way aggregate. What the report headline and `exit_category` lead with.
 *
 * `healthy`   nothing failed AND everything that had to be observed was, with
 *             every non-pass justified.
 * `unhealthy` drift is PROVEN.
 * `unproven`  nothing is proven either way -- an unread half, a stale reading,
 *             or an unjustified gap.
 *
 * Held BESIDE `health.healthy` rather than replacing it. `healthy` keeps story
 * 1.4's drift-only meaning, `complete` keeps its coverage meaning, and this is
 * the aggregate a machine client reads.
 */
export const FLEET_STATUS_VERDICTS = ["healthy", "unhealthy", "unproven"] as const;
export type FleetStatusVerdict = (typeof FLEET_STATUS_VERDICTS)[number];

/**
 * The machine discriminant, carried in `data` on BOTH adapters.
 *
 * `unhealthy` and `incomplete` are `ok: true` states -- the command succeeded,
 * the fleet did not -- so they cannot be `FleetErrorCode` members without
 * nulling `data` on exactly the runs that matter.
 */
export const FLEET_STATUS_EXIT_CATEGORIES = ["ok", "unhealthy", "incomplete"] as const;
export type FleetStatusExitCategory = (typeof FLEET_STATUS_EXIT_CATEGORIES)[number];

/**
 * The process exits `--exit-code` projects each category onto.
 *
 * Above the `FleetErrorCode` bands (2-8) on purpose: a caller must be able to
 * tell "the fleet is unhealthy" from "the command failed" by exit status alone.
 * Applied ONLY under `--exit-code`; the default stays 0 because `fleet status`
 * is an observation command, gating CI is story 1.21's job, and a
 * `mise run fleet:status` that is permanently red teaches an operator to ignore
 * it.
 */
export const FLEET_STATUS_EXIT_CODES = {
  ok: 0,
  unhealthy: 10,
  incomplete: 11,
} as const satisfies Record<FleetStatusExitCategory, number>;

/** Which bucket one agent lands in. Exactly one, over every SELECTED agent. */
export const FLEET_STATUS_MEMBER_CLASSES = [
  "healthy", "unhealthy", "incomplete", "deferred", "exception", "unclassified",
] as const;
export type FleetStatusMemberClass = (typeof FLEET_STATUS_MEMBER_CLASSES)[number];

/**
 * Which class wins when an agent qualifies for more than one.
 *
 * ONE RULE, applied consistently: what the CONTRACT or the FLEET determines
 * about the ROW outranks what happened to be true of THIS RUN. A row's
 * classification and its proven failures are the same on every invocation; its
 * completeness depends on which flags the caller passed, and on a default run
 * nearly every row is incomplete -- so letting `incomplete` win would collapse
 * five of the six buckets into one on the command's most common invocation.
 *
 * Within the durable half: `unclassified` first, because a row this command
 * could not classify supports no other claim; then `unhealthy`, so an operator
 * ruling can never absorb an unrelated proven failure; then `exception`, an
 * operator's standing decision about the row; then `deferred`, an authorized
 * gap in the build rather than in the fleet.
 *
 * The previous order put `incomplete` above `deferred` on the reasoning that an
 * unread half is a bigger statement than an authorized one. That reasoning was
 * right about the two of them and inconsistent with `exception` sitting above
 * `incomplete` for the opposite reason; the rule above is what makes all four
 * agree.
 *
 * Iterated by `classifyMember`, never re-spelled there.
 */
export const FLEET_STATUS_MEMBER_PRECEDENCE = [
  "unclassified", "unhealthy", "exception", "deferred", "incomplete", "healthy",
] as const satisfies readonly FleetStatusMemberClass[];

/** How one finding moved between the baseline run and this one. */
export const FLEET_STATUS_TRANSITION_KINDS = [
  "appeared", "resolved", "state_changed", "severity_changed", "evidence_changed",
] as const;
export type FleetStatusTransitionKind = (typeof FLEET_STATUS_TRANSITION_KINDS)[number];

/**
 * Cap on transitions carried in one envelope.
 *
 * Deliberately not `MAX_ITEMS` (100) from the envelope's generic list bound, for
 * the same reason `FLEET_INVENTORY_MAX_ROWS` is not: 28 agents x 9 domains
 * crosses 100 trivially, and `boundedValue` would slice the array with no
 * per-item identity and no record of the clip.
 */
export const FLEET_STATUS_MAX_TRANSITIONS = 2000;

/**
 * What `observed_state` may report, and why it needs a value the contract's own
 * activation ladder does not have.
 *
 * A `--domain registry` run never reads the profile tree, so it cannot say
 * whether the agent is `installed` -- and reporting `discovered` there would let
 * a COLLECTION FILTER move a conclusion about the agent, which is the one thing
 * a scope is not allowed to do. `out_of_scope` says "this run did not select
 * the domain that answers this", which is a statement about the run rather than
 * about the fleet.
 */
export const FLEET_STATUS_LIFECYCLE_STATES = [
  "discovered", "installed", "healthy", "routing_ready", "activated", "out_of_scope",
] as const;
export type FleetStatusLifecycleState = (typeof FLEET_STATUS_LIFECYCLE_STATES)[number];

/**
 * Whether routing readiness was proven, could not be, or was not looked at.
 *
 * `ready` is unreachable in this release by construction -- it would require a
 * direct observation of the shared gateway and none exists. `blocked` is
 * unreachable until that observer arrives too. Both are declared so the axis
 * has somewhere to grow that is not a boolean.
 */
export const FLEET_STATUS_READINESS = [
  "ready", "unproven", "blocked", "not_applicable", "out_of_scope",
] as const;
export type FleetStatusReadiness = (typeof FLEET_STATUS_READINESS)[number];

/**
 * The four activation states, kept apart, for one agent.
 *
 * FOUR FIELDS, NEVER ONE BOOLEAN. Discovery, installation, health, routing
 * readiness and execution activation are distinct states, and collapsing any
 * two of them is how "we can resolve a target" becomes "we may dispatch to it".
 *
 * `desired_state` is what the REGISTRY declares as the target for this row -- a
 * statement of intent, never a claim about the agent. `observed_state` is the
 * furthest state this run actually PROVED, and it can never read
 * `routing_ready` or `activated` in this release because no observer for either
 * exists.
 */
export interface FleetStatusLifecycle {
  desired_state: FleetActivationState;
  observed_state: FleetStatusLifecycleState;
  /**
   * Whether Bloodbank routing readiness was PROVEN for this agent.
   *
   * Never `ready` in this release: `ready` would require a direct observation of
   * the shared gateway, and a `declared` registry field is not one.
   */
  capability_readiness: FleetStatusReadiness;
  /** The strict execution-authority flag, read verbatim. The contract's default is deny. */
  activation: "granted" | "denied" | "undeclared";
}

/** One agent per bucket, counted over every SELECTED agent -- never over the emitted ones. */
export interface FleetStatusMembers {
  healthy: number;
  unhealthy: number;
  incomplete: number;
  deferred: number;
  exception: number;
  unclassified: number;
}

/**
 * One finding that moved between two runs, joined on a stable `finding_id`.
 *
 * `from` and `to` are null on `resolved` and `appeared` respectively. Nothing
 * here is persisted: the baseline is a document the operator supplies, and this
 * command never writes state to disk to compute a transition.
 */
export interface FleetStatusTransition {
  finding_id: string;
  kind: FleetStatusTransitionKind;
  scope: "fleet" | "agent" | "host";
  agent_id: string | null;
  domain: FleetStatusDomain;
  from: { state: FleetStatusState; severity: FleetStatusSeverity; evidence: FleetStatusEvidence } | null;
  to: { state: FleetStatusState; severity: FleetStatusSeverity; evidence: FleetStatusEvidence } | null;
  detail: string;
}

/**
 * One observation: one thing this run learned about one domain.
 *
 * `agent_id` is null for a FLEET-SCOPED observation -- something true of the
 * fleet rather than of an agent (the tracked template's gitlink, the host pin).
 * Those live on the domain rollup, never copied onto every agent record.
 *
 * `rule_scope` is `LifecycleScope` (`"project" | "host"`) when the observation
 * came from a recipe rule, null otherwise. A `host` observation never reaches a
 * per-agent record: that promotion is the exact category error PJAN-84 fixed.
 *
 * `finding_id` is a sha256 prefix over `(scope, agent_id, domain, rule_id, field,
 * source)` -- the `conflictGroupId` idiom -- so an id is stable across runs and
 * identical on the CLI and MCP paths. That is what turns the parity check into a
 * deep equality rather than a resemblance. `source` is in the tuple because two
 * sources routinely answer for the same `(agent, domain, field)` with no rule id
 * between them, and without it they collided into one id.
 *
 * `retrieval` is the command that returns this observation on its own, so a
 * clipped envelope always names the way to get the part it dropped.
 */
export interface FleetStatusObservation {
  domain: FleetStatusDomain;
  agent_id: string | null;
  state: FleetStatusState;
  /**
   * What this observation is ABOUT: a recipe rule id, or a provenance fact id.
   * Null only when it came from a plain store read.
   *
   * It carries the fact id as well as the rule id because `field` alone does not
   * identify an observation: `hermes.git_sha` and `hermes.checkout_head` both
   * compare `agents.{agent_id}.hermes.git_sha`, so without this the two would
   * hash to one `finding_id` and any consumer joining on that id would silently
   * merge them. MEASURED -- the suite's uniqueness case caught exactly that.
   */
  rule_id: string | null;
  /** The recipe that owns `rule_id`, or the contract-declared authority for `field`. */
  owner: string | null;
  rule_scope: "project" | "host" | null;
  /** The dotted field path or provenance fact id this observation is about. */
  field: string;
  summary: string;
  details: string[];
  finding_id: string;
  /** Where the observation came from: a store read, a provenance fact, a recipe audit, or a declared gap. */
  source: string;
  retrieval: string;
  /** Whether it was REQUIRED, and if not, on whose authority. Story 1.5. */
  applicability: FleetStatusApplicability;
  /** How strongly it is supported. `declared` never proves a capability ready. */
  evidence: FleetStatusEvidence;
  /** A bucket, never an age -- `data` has to be byte-identical across two runs. */
  freshness: FleetStatusFreshness;
  /** `state` x `applicability`, so a fail on a required domain outranks one on an optional. */
  severity: FleetStatusSeverity;
  /** Who can repair it, and therefore what `next_action` can possibly be. */
  repair: FleetStatusRepair;
  /**
   * The live side and the recorded side, in the shape `FleetProvenanceFact`
   * already uses.
   *
   * ALWAYS POPULATED, and the two halves are not always a value comparison.
   * Where one is -- a provenance fact, a profile path, a routing record -- both
   * carry real values from opposite sides. Where it is not, `observed` is what
   * this run CONCLUDED and `desired` is what the domain declares it should
   * conclude: an audit rule reports `observed: "18 scaffold issue(s)
   * detected"` against `desired: "the recipe rule hermes.pm-scaffold reporting
   * pass"`. That second shape is close to a restatement of the summary, and it
   * is kept anyway because AC7 requires every non-pass to carry the pair and a
   * consumer that has to branch on which shape it got has no pair at all.
   *
   * Typed nullable because the ENVELOPE has carried nulls here since 1.5's
   * first cut and a consumer must keep handling them; nothing produces one
   * today.
   */
  observed: string | null;
  desired: string | null;
  /** One exact thing to do next. Read-only unless `next_action_class` says otherwise. */
  next_action: string;
  next_action_class: FleetStatusNextActionClass;
  /** The contract entry authorizing this gap, or null. Null on a non-pass blocks `proven`. */
  justification: FleetStatusJustification | null;
  /**
   * Typed per-asset items, where the observation is a scaffold group. Story 1.6.
   *
   * ABSENT (not empty) on a group with nothing to report, and capped at
   * `FLEET_STATUS_MAX_ITEMS` with the clip recorded in `truncated`. Each item's
   * `path` is role-relative and its `desired`/`observed` are 12-hex blob-id
   * prefixes or type/mode words -- never a body, never an absolute path.
   */
  items?: FleetStatusObservationItem[];
}

// ---------------------------------------------------------------------------
// Fleet scaffold parity (story 1.6)
//
// `template_scaffold` used to read `unsupported`/`unobserved` for every agent on
// a default run. The vocabulary below is what a read-only observer reports when
// it compares each managed role directory, asset by asset, against the template
// at the COMMITTED gitlink -- git objects, never a worktree.
// ---------------------------------------------------------------------------

/**
 * What one asset item says. Mirrors `SCAFFOLD_ASSET_FINDING_KINDS` in
 * `src/scaffold/compare.ts`, which is the pure core both the observer and the
 * recipe rule share; declared here too so the envelope vocabulary lives beside
 * every other `FLEET_STATUS_*` tuple.
 */
export const FLEET_SCAFFOLD_ITEM_KINDS = [
  "missing", "stale-content", "locally-modified", "wrong-mode",
  "wrong-type", "unsafe-symlink", "unexpected-owned", "incomplete",
] as const;
export type FleetScaffoldItemKind = (typeof FLEET_SCAFFOLD_ITEM_KINDS)[number];

/**
 * Why the template SOURCE could not be trusted, when it could not.
 *
 * `ok`                    the committed gitlink is stable, its object exists, the
 *                         worktree is at it and carries no tracked change, and
 *                         every rendered path resolves to one declared group.
 * `gitlink-missing`       the parent's HEAD records no gitlink for the submodule.
 * `gitlink-unstable`      the index gitlink differs from HEAD's -- a staged, uncommitted pin.
 * `source-uninitialized`  the submodule directory is not a repository root.
 * `source-missing-object` the gitlink names a commit the object database does not hold.
 * `source-mismatched`     the worktree HEAD is not the committed gitlink.
 * `source-dirty`          a TRACKED template file is modified (untracked files are not dirt here).
 * `source-contaminated`   the tree at the gitlink carries an excluded pattern (`__pycache__`, `*.pyc`).
 * `source-empty`          the tree at the gitlink renders nothing.
 * `source-unobserved`     a probe failed or timed out before the source could be read.
 * `manifest-uncovered`    a rendered path matches no declared group; the code is suffixed `:<path>`.
 *
 * Any code but `ok` is a HOST finding (`scaffold.source`) and marks every
 * selected agent's eight groups `error`. Desired bytes are never taken from the
 * worktree as a fallback.
 */
export const FLEET_SCAFFOLD_SOURCE_CODES = [
  "ok", "gitlink-missing", "gitlink-unstable", "source-uninitialized", "source-missing-object",
  "source-mismatched", "source-dirty", "source-contaminated", "source-empty", "source-unobserved",
  "manifest-uncovered",
] as const;
export type FleetScaffoldSourceCode = (typeof FLEET_SCAFFOLD_SOURCE_CODES)[number];

/** One asset item on a scaffold group observation, one typed item on a profile observation (story 1.7), or one on a systemd leaf (story 1.8). */
export interface FleetStatusObservationItem {
  /** Role-relative or profile-relative, forward slashes; or a unit name or registry key on a systemd leaf. Never absolute. */
  path: string;
  kind: FleetScaffoldItemKind | FleetProfileItemKind | FleetSystemdItemKind;
  /** A 12-hex blob-id prefix or a type/mode word. Never a body. */
  desired: string | null;
  observed: string | null;
  /** A stable category (`input-missing: display_name`), never a subprocess message. */
  detail: string | null;
  /** The working tree carries an uncommitted change to this path. Orthogonal to the kind. */
  wip: boolean;
}

/** The per-agent scaffold summary. `null` when `template_scaffold` was not selected or no manifest is declared. */
export interface FleetStatusAgentScaffold {
  /** The committed gitlink the comparison ran against, 40-hex. Null when the source was unreadable. */
  source_gitlink: string | null;
  /** The role directory compared, bounded and home-redacted. Null when none could be resolved. */
  role_dir: string | null;
  /** Whether `role_dir` came from the registry row or from the `<project_path>/agents/hermes/<role>` default. */
  role_dir_source: "registry" | "default";
  assets: {
    /** Assets the template renders at the gitlink. */
    owned: number;
    /** Owned assets a comparison completed for. `owned - incomplete`. */
    compared: number;
    matching: number;
    /** Distinct owned paths with at least one drift item. */
    drifted: number;
    /** Owned paths this build could not decide. */
    incomplete: number;
    /** Tracked files inside an owned group the template did not render. */
    unexpected_owned: number;
  };
  /** Owned, drifted paths that ALSO carry an uncommitted change. Capped at `FLEET_STATUS_MAX_WIP_OVERLAP`. */
  wip_overlap: string[];
  /** Modified or untracked entries under the role directory, counted and never named. */
  wip_preserved: number;
  /** Tracked files outside every owned group. Counted, never named. */
  foreign_tracked: number;
  /** Git-ignored entries under the role directory, the runtime directory included. Counted, never named. */
  ignored_entries: number;
}

/** The fleet-level scaffold summary under `data.scaffold`. `null` when `template_scaffold` was not selected. */
export interface FleetScaffoldSummary {
  source: {
    gitlink: string | null;
    integrity: string;
    detail: string;
  };
  /** Counted over EVERY selected agent, before any envelope cap. */
  agents: {
    total_registered: number;
    selected: number;
    /** Selected agents the observer produced a result for. */
    applicable: number;
    passing: number;
    drifted: number;
    incomplete: number;
    /** Drifted agents whose every drifted group a `health_policy.agent_exceptions` entry covers. */
    exception_authorized: number;
    /** `total_registered - selected`, plus selected agents the observer never reached. */
    unobserved: number;
  };
  /** Under `--live`, how the observer and the `hermes.pm-scaffold` rule agreed over the rule-covered subset. */
  rule_agreement: {
    compared: number;
    agree: number;
    disagree: number;
    not_compared: number;
  };
}

/** One agent, every domain, with the per-domain rollup beside the raw observations. */
export interface FleetStatusAgent {
  agent_id: string;
  observations: FleetStatusObservation[];
  /** Every selected domain, rolled up under `FLEET_STATUS_STATE_PRECEDENCE`. */
  domains: Partial<Record<FleetStatusDomain, FleetStatusState>>;
  /** The worst domain state on this record. */
  state: FleetStatusState;
  healthy: boolean;
  complete: boolean;
  /** True when this record's observations were clipped; `retrieval` then names how to get them all. */
  truncated: boolean;
  retrieval: string;
  /** The four activation states, kept apart. Story 1.5. */
  lifecycle: FleetStatusLifecycle;
  /** Exactly one bucket, resolved under `FLEET_STATUS_MEMBER_PRECEDENCE`. */
  member_class: FleetStatusMemberClass;
  /** The scaffold parity summary. Story 1.6. Always present; `null` when the domain was not selected. */
  scaffold: FleetStatusAgentScaffold | null;
  /** The generated-profile health summary. Story 1.7. Always present; `null` when the domain was not selected. */
  profile: FleetStatusAgentProfile | null;
  /** The systemd topology and service-health summary. Story 1.8. Always present; `null` when the domain was not selected. */
  systemd: FleetStatusAgentSystemd | null;
}

/**
 * One domain across the whole selection.
 *
 * `observations` carries the FLEET-SCOPED ones (`agent_id: null`) -- emitted
 * exactly once, never copied onto 28 agent records.
 */
export interface FleetStatusDomainRollup {
  domain: FleetStatusDomain;
  state: FleetStatusState;
  counts: Record<FleetStatusState, number>;
  /** Agents carrying at least one observation in this domain. */
  agents: number;
  observations: FleetStatusObservation[];
}

/**
 * One host-scoped rule result, reported ONCE for the machine.
 *
 * Deduped by rule id. It never reaches a per-agent record, never makes an agent
 * or the fleet `healthy: false`, and is never promoted into a registry-wide
 * claim: no amount of work in a repository can change a condition about $HOME,
 * systemd, or the fleet registry.
 */
export interface FleetStatusHostFinding {
  rule_id: string;
  /** Never null on a non-pass: a finding nobody owns is a finding nobody acts on. */
  owner: string | null;
  domain: FleetStatusDomain;
  state: FleetStatusState;
  summary: string;
  details: string[];
  finding_id: string;
  retrieval: string;
  /** The same four axes and derivations an observation carries. Story 1.5. */
  applicability: FleetStatusApplicability;
  evidence: FleetStatusEvidence;
  freshness: FleetStatusFreshness;
  severity: FleetStatusSeverity;
  /** Always `other-owner` for a host rule that needs repair: no repository change reaches it. */
  repair: FleetStatusRepair;
  observed: string | null;
  desired: string | null;
  next_action: string;
  next_action_class: FleetStatusNextActionClass;
  justification: FleetStatusJustification | null;
  /**
   * Typed extra-entry items, where the finding is `profile.extras` (story 1.7),
   * or typed unregistered-unit items where it is `systemd.unregistered`
   * (story 1.8).
   *
   * ABSENT on every other host finding and on an empty sweep, capped at
   * `FLEET_STATUS_MAX_ITEMS` with the clip recorded in `truncated`. Each item's
   * `path`/`unit` is a NAME, never an absolute path.
   */
  items?: FleetStatusProfileExtraItem[] | FleetStatusSystemdUnregisteredItem[];
}

/**
 * A status finding, carrying what the AC7 sort needs and the inventory's does not.
 *
 * `FleetInventoryFinding`'s three-value `severity` stays exactly where it is --
 * it is the inventory's axis and other commands read it. The four fields added
 * here are what let `compareStatusFindings` rank a gating finding above 200
 * low-severity ones BEFORE any cap, which is the failure AC7 names.
 */
export interface FleetStatusFinding extends FleetInventoryFinding {
  domain: FleetStatusDomain;
  scope: "fleet" | "agent" | "host";
  /** Stable across runs and across both adapters, like an observation's. */
  finding_id: string;
  status_severity: FleetStatusSeverity;
  /** Whether this finding is one of the reasons the fleet cannot claim proof. */
  gating: boolean;
}

export interface FleetStatusScope {
  kind: "fleet" | "agent";
  agent_id: string | null;
  /** The single selected domain, or null for all nine. */
  domain: FleetStatusDomain | null;
  live: boolean;
  label: string;
  /** Registered agents in the whole fleet, scope-independent. */
  total_registered_agents: number;
  selected_agents: number;
  selected_domains: FleetStatusDomain[];
  /**
   * Whether this run was correlated against a `--baseline` document.
   *
   * Carried so an empty `transitions[]` can be told apart from no baseline
   * having been read at all -- on the human path those are the same absence and
   * mean opposite things ("nothing moved" versus "nothing was compared").
   */
  baseline: boolean;
}

export interface FleetStatusTotals {
  /** Registered agents in the whole fleet. Equals the inventory's `registered_agents`. */
  agents: number;
  /** Agent records actually carried in `agents`, after the cap. */
  emitted_agents: number;
  /** Observations built, before the per-agent cap. */
  observations: number;
  /** Observations actually carried. */
  emitted_observations: number;
  host_findings: number;
  findings: number;
  /** Recipe-audit children this run intended to start. */
  audits_attempted: number;
  /** Recipe-audit children that returned a parseable report. */
  audits_observed: number;
  by_state: Record<FleetStatusState, number>;
}

export interface FleetStatusHealth {
  /**
   * No `fail` and no `error`, over every observation.
   *
   * Provenance's split, not the inventory's: clipping is deliberately NOT part
   * of this. A truncated but drift-free run is `healthy: true, complete: false`,
   * which is the whole reason there are two verdicts.
   */
  healthy: boolean;
  /** No `unobserved`, no collection error, no truncation. `unsupported` does not reduce it. */
  complete: boolean;
  /** `complete`, AND unfiltered: every registered row and every applicable domain was observed. */
  fleet_complete: boolean;
  failed: number;
  warned: number;
  skipped: number;
  unsupported: number;
  unobserved: number;
  errors: number;
  /** Sources this run could not read at all -- a missing audit CLI, an unparseable child report. */
  collection_errors: number;
  truncated: boolean;
  /**
   * The three-way aggregate, and the one a machine client should read.
   *
   * BESIDE `healthy`, never instead of it:
   *   !healthy                                  -> "unhealthy"  (drift PROVEN)
   *   !complete || stale > 0 || unjustified > 0 -> "unproven"   (nothing proven)
   *   otherwise                                 -> "healthy"
   */
  verdict: FleetStatusVerdict;
  /** `verdict === "healthy"` AND `fleet_complete`. The only thing that means "we read it all and it was right". */
  proven: boolean;
  /** The machine discriminant both adapters carry. `--exit-code` projects it onto a process exit. */
  exit_category: FleetStatusExitCategory;
  /** Observations whose evidence is past its declared `max_age_days`. Blocks `proven`. */
  stale: number;
  /**
   * Observations a freshness policy applies to whose timestamp could not be read.
   *
   * Held apart from `stale` and blocking `proven` just as hard. A policy entry
   * naming a field no row populates buckets every reading `unknown`, and if
   * that did not gate anything the entry would validate, change nothing, and
   * read as though the fleet had been checked -- "we did not look" wearing the
   * freshness axis, which is the exact failure this story exists to prevent.
   */
  freshness_unknown: number;
  /** Non-pass observations no `health_policy` entry authorizes. Blocks `proven`. */
  unjustified: number;
  /** Two sources answering for the same field and disagreeing. Blocks `complete`. */
  contradictions: number;
  /** Every SELECTED agent, in exactly one bucket. Sums to `scope.selected_agents`. */
  members: FleetStatusMembers;
}

export interface FleetStatus {
  contract_path: string;
  contract_version: string | null;
  scope: FleetStatusScope;
  totals: FleetStatusTotals;
  health: FleetStatusHealth;
  agents: FleetStatusAgent[];
  domains: FleetStatusDomainRollup[];
  host: FleetStatusHostFinding[];
  findings: FleetStatusFinding[];
  probes: FleetProbeRecord[];
  /**
   * How every finding moved since the `--baseline` document, or `[]`.
   *
   * Empty when no baseline was supplied AND when the baseline is byte-identical
   * to this run: an unchanged finding emits nothing.
   */
  transitions: FleetStatusTransition[];
  /** The fleet-level scaffold parity summary. Story 1.6. Always present; `null` when the domain was not selected. */
  scaffold: FleetScaffoldSummary | null;
  /** The fleet-level generated-profile summary. Story 1.7. Always present; `null` when the domain was not selected. */
  profile: FleetProfileSummary | null;
  /** The fleet-level systemd summary. Story 1.8. Always present; `null` when the domain was not selected. */
  systemd: FleetSystemdSummary | null;
  /** Dotted paths where a bound clipped the reported value. */
  truncated: string[];
}

// ---------------------------------------------------------------------------
// Fleet profile health (story 1.7)
//
// `profile` used to observe one `lstat` of the profile directory and declare
// generated-config health a deferral. The vocabulary below is what a read-only
// observer reports when it gates the profile path, reads the identity file,
// proves the generated config through the canonical renderer's own `check`
// (run at bytes proven identical to the committed gitlink), reads the Hindsight
// bank pin, proves the skill core by bytes, and -- in fleet scope -- classifies
// every unregistered entry of the profile root.
// ---------------------------------------------------------------------------

/**
 * What one profile item says. Each is a stable identifier word; the item's
 * `path` names the profile-relative file or entry it is about and `detail`
 * carries the subject (`unknown-key:foo`, `case-collision:Alpha-pm`) where the
 * kind alone does not identify it. Never a file body, a config value, a delta
 * value, a memory, or an absolute path.
 */
export const FLEET_PROFILE_ITEM_KINDS = [
  // The path gate: the profile directory itself. `ambiguous` is a duplicate
  // profile name across registry rows; `unverifiable` is a singleton link the
  // observer could not judge because the row records neither a role directory
  // nor a project path to derive one from.
  "unnamed", "symlink", "missing", "not-a-directory", "name-unsafe", "case-collision", "ambiguous", "unreadable",
  "misowned-link", "unverifiable",
  // The identity file.
  "malformed", "unknown-key", "inert-config-block", "identity-mismatch",
  // The generated config and its inputs. `delta-not-override-only` is a delta
  // that carries the generated marker or equals the base or generated mapping.
  "base-missing", "generated-missing", "generated-symlink", "marker-missing", "delta-missing", "delta-symlink",
  "delta-not-override-only", "semantic-drift", "renderer-failed", "renderer-timeout", "renderer-unavailable", "too-large",
  // The Hindsight bank pin.
  "pin-missing", "pin-symlink", "pin-malformed", "bank-missing", "bank-custom", "bank-alias", "bank-mismatch",
  // The skill core.
  "canonical-missing", "core-missing", "core-replaced", "core-dangling", "core-foreign", "extra-skill", "source-unresolvable",
] as const;
export type FleetProfileItemKind = (typeof FLEET_PROFILE_ITEM_KINDS)[number];

/**
 * The five classes an unregistered profile-root entry lands in. Exactly one.
 *
 * `approved-managed-exception`  a `managed_shared_service` entry with `profile`
 *                               in its policy domains claims it (the fleet
 *                               Bloodbank gateway's profile).
 * `intentionally-unmanaged`     an `intentionally_unmanaged` entry with
 *                               `source: profiles.<name>` claims it.
 * `retired-candidate`           a `retired` entry claims it, OR it wears a
 *                               backup shape, OR it is an alias of a registered
 *                               name (case, `_`/`-`, backup suffix), OR its
 *                               `config.yaml` is a symlink (the retired topology).
 * `debris-candidate`            a stray file, an empty directory, a dangling link.
 * `unclassified`                everything else -- a finding for an operator,
 *                               never a licence to delete.
 *
 * Only the first two are `pass`; the rest are `warn`, unjustified by design
 * until the operator classifies the entry in the contract.
 */
export const FLEET_PROFILE_EXTRA_CLASSES = [
  "approved-managed-exception", "intentionally-unmanaged", "retired-candidate", "unclassified", "debris-candidate",
] as const;
export type FleetProfileExtraClass = (typeof FLEET_PROFILE_EXTRA_CLASSES)[number];

/**
 * What the profile PATH gate concluded. `ok` and `misowned-link` are post-gate
 * (the directory is real, contained and unambiguous; `misowned-link` says one
 * of its singleton links points into another agent's runtime). Every other
 * code blocks: nothing beneath the directory is read and the four dependent
 * fields are `unobserved` naming the code. `root:<code>` is the root gate's
 * failure carried onto every agent.
 */
export const FLEET_PROFILE_PATH_CODES = [
  "ok", "misowned-link", "unverifiable", "unnamed", "symlink", "missing", "not-a-directory", "name-unsafe", "case-collision", "ambiguous", "unreadable",
] as const;
/** A path code, or the root gate's failure carried onto the agent as `root:<root code>`. */
export type FleetProfilePathCode = (typeof FLEET_PROFILE_PATH_CODES)[number] | `root:${FleetProfileRootCode}`;

/**
 * What the ROOT gate concluded.
 *
 * `ok`                         the root is `<fleet home>/profiles`, reached through real directories.
 * `layout-undeclared`          the contract declares no `service_model.profile_layout.root`.
 * `renderer-layout-mismatch`   the contract's root is not the directory the renderer reads.
 * `root-missing`               a component of the root does not exist.
 * `root-unreadable`            a component could not be lstat'ed, or the root could not be enumerated.
 * `root-symlink`               the root itself is a symlink.
 * `root-ancestor-symlink`      a component above the root is a symlink (DW-28).
 * `root-not-a-directory`       a component is not a directory.
 *
 * Any code but `ok` is a HOST finding (`profile.root`) and marks every selected
 * agent's five fields `error` naming `root:<code>`.
 */
export const FLEET_PROFILE_ROOT_CODES = [
  "ok", "layout-undeclared", "renderer-layout-mismatch", "root-missing", "root-unreadable", "root-symlink",
  "root-ancestor-symlink", "root-not-a-directory",
] as const;
export type FleetProfileRootCode = (typeof FLEET_PROFILE_ROOT_CODES)[number];

/**
 * Why the canonical renderer's SOURCE could not be trusted, when it could not.
 *
 * `ok`                          the worktree copies of the script and its lock
 *                               helper are regular files whose blob ids equal
 *                               the blobs at the COMMITTED gitlink.
 * `renderer-gitlink-missing`    the parent's HEAD records no gitlink for the submodule.
 * `renderer-gitlink-unstable`   the index gitlink differs from HEAD's.
 * `renderer-source-missing`     the submodule is not a repository root of its
 *                               own, or the pinned tree or the worktree lacks a file.
 * `renderer-source-mismatched`  a worktree copy's bytes differ from the gitlink's.
 * `renderer-source-unobserved`  no verdict: a git probe failed, timed out or
 *                               was cancelled, the package root is not a git
 *                               checkout root of its own, or a worktree copy
 *                               could not be read under the file cap; the
 *                               renderer can only be proven inside a git
 *                               checkout of pjangler.
 *
 * Any code but `ok` is a HOST finding (`profile.renderer`), marks every
 * selected agent's `config.yaml` field `error`, and spawns NO renderer.
 */
export const FLEET_PROFILE_RENDERER_CODES = [
  "ok", "renderer-gitlink-missing", "renderer-gitlink-unstable", "renderer-source-missing", "renderer-source-mismatched",
  "renderer-source-unobserved",
] as const;
export type FleetProfileRendererCode = (typeof FLEET_PROFILE_RENDERER_CODES)[number];

/**
 * Whether an interpreter that can run the renderer answered.
 *
 * `not-probed` when the source was not `ok` (nothing would run anyway). The
 * probe script exits with codes it controls -- 3 for a python older than 3.11,
 * 4 for a failed `import yaml` -- and every other nonzero or absent status is
 * `renderer-python-unavailable`.
 */
export const FLEET_PROFILE_PYTHON_CODES = [
  "ok", "not-probed", "renderer-python-unavailable", "renderer-python-too-old", "renderer-pyyaml-missing",
] as const;
export type FleetProfilePythonCode = (typeof FLEET_PROFILE_PYTHON_CODES)[number];

/**
 * What the renderer's `check` concluded for one profile: `fail` when the two
 * files were not both regular so no check was spawned, `error` when the check
 * could not run or answer, `unobserved` behind a failed gate.
 */
export const FLEET_PROFILE_RENDERER_STATES = ["in-sync", "drifted", "fail", "error", "unobserved"] as const;
export type FleetProfileRendererState = (typeof FLEET_PROFILE_RENDERER_STATES)[number];

/** The action an extra entry's class implies for an operator. Guidance, never an effect. */
export const FLEET_PROFILE_EXTRA_GUIDANCE = ["adoption", "exception", "retirement", "manual-review"] as const;
export type FleetProfileExtraGuidance = (typeof FLEET_PROFILE_EXTRA_GUIDANCE)[number];

/**
 * One unregistered profile-root entry, classified, with bounded safe evidence.
 *
 * `path` is the entry's NAME. `link_target` is bounded and home-redacted,
 * present only for a symlink. `standalone` says whether a directory carries
 * the three files a standalone profile needs; null for anything that is not a
 * real directory (a symlink is classified, never followed). `alias_of` names
 * the registered profile this entry is an alias of, if any.
 * `unit_file_references` counts user unit files whose `HERMES_HOME=` names
 * this entry. `process_reference` is `unobserved` in this release: live
 * attribution is story 1.9.
 */
export interface FleetStatusProfileExtraItem {
  path: string;
  class: FleetProfileExtraClass;
  kind: "directory" | "symlink" | "dangling-symlink" | "file" | "empty-directory" | "other";
  link_target: string | null;
  standalone: "complete" | "incomplete" | null;
  alias_of: string | null;
  unit_file_references: number;
  process_reference: "unobserved";
  guidance: FleetProfileExtraGuidance;
  /** A stable category naming what classified it (`backup-pattern:*.bak`, `classifications.retired.entries[0]`), never a body. */
  detail: string | null;
}

/** The per-agent profile summary. `null` when `profile` was not selected or no manifest is declared. */
export interface FleetStatusAgentProfile {
  profile_name: string | null;
  path: { state: FleetStatusState; code: FleetProfilePathCode };
  identity: {
    state: FleetStatusState;
    /** The identity file's top-level key NAMES, sorted. Names only, never values. */
    keys: string[];
  };
  renderer: {
    state: FleetProfileRendererState;
    /** Top-level sections the renderer reported drifted, sorted. At most six; an unparseable name is `unparsed`. */
    sections: string[];
  };
  /** 12-hex sha256 prefixes of the base, delta and generated bytes. Null where a file was not read. */
  digests: { base: string | null; delta: string | null; generated: string | null };
  bank: {
    /** The pinned bank id as read, an identifier word, or null. Never a memory. */
    observed: string | null;
    expected: string | null;
    state: FleetStatusState;
    /** The item kind that decided a non-pass (`bank-alias`, `pin-malformed`, ...), or null on a pass or an unread field. */
    code: string | null;
  };
  skills: {
    state: FleetStatusState;
    core_present: number;
    core_missing: string[];
    /** Optional skills present beside the core, capped at `profile_manifest.limits.max_extra_skills`. */
    extra: string[];
    /** `skills.external_dirs` entries that are not absolute and so could not be resolved. */
    sources_unresolvable: number;
  };
}

/** The fleet-level profile summary under `data.profile`. `null` when `profile` was not selected. */
export interface FleetProfileSummary {
  source: string;
  root: { state: FleetStatusState; code: string };
  renderer: {
    source: string;
    python: string;
    gitlink: string | null;
    /** Profiles the renderer's `check` was actually run for. */
    checked: number;
    in_sync: number;
    drifted: number;
    failed: number;
    timeout: number;
  };
  /** Counted over EVERY selected agent, before any envelope cap. */
  agents: {
    total_registered: number;
    selected: number;
    /** Selected agents whose profile passed the path gate. */
    real: number;
    blocked_at_path: number;
    /** Real profiles whose five fields all pass. */
    structurally_healthy: number;
    drifted: number;
    incomplete: number;
    exception_authorized: number;
    /** `total_registered - selected`, plus selected agents the observer never reached. */
    unobserved: number;
  };
  /** One bucket per REAL profile: the six sum to `agents.real`. `bank_invalid` is a pin that is a symlink, unparseable or over the cap. */
  identity: { bank_ok: number; bank_alias: number; bank_custom: number; bank_missing: number; bank_mismatch: number; bank_invalid: number };
  skills: { core_complete: number; core_missing: number; core_replaced: number; extras_seen: number };
  extras: {
    coverage: "swept" | "not-swept";
    reason: string | null;
    entries_total: number;
    by_class: Record<FleetProfileExtraClass, number>;
    listed: number;
    truncated: boolean;
  };
  /** Under `--live`, how the observer and the `hermes.runtime-singleton` rule agreed over the subset both read. */
  rule_agreement: { compared: number; agree: number; disagree: number; not_compared: number };
}

// ---------------------------------------------------------------------------
// Fleet systemd topology and service health (story 1.8)
//
// `systemd` used to report every agent `unsupported`: unit names were derived
// expectations, never observations of the user manager. The vocabulary below is
// what a read-only observer reports when it derives each agent's canonical unit
// set, samples the manager over a declared stabilization window, derives the
// DESIRED gateway state from the registry's messaging declaration, proves
// gateway and heartbeat health by the template's own stability semantics,
// correlates the fleet-shared Bloodbank gateway, and classifies every
// unregistered `hermes-*` unit for an operator.
// ---------------------------------------------------------------------------

/**
 * What one systemd item says. Each is a stable identifier word; the item's
 * `path` names the unit or registry key it is about and `detail` carries the
 * subject (`registry-retired-key:checkpoint_timer`, `property-malformed:NRestarts`,
 * `platform-enablement-inherited:telegram`) where the kind alone does not
 * identify it. Never a timestamp, an age, a pid, an environment value or an
 * absolute path.
 */
export const FLEET_SYSTEMD_ITEM_KINDS = [
  // Collection: the manager or a child could not answer, or answered in a
  // shape this build does not read.
  "manager-unavailable", "manager-timeout", "show-failed", "show-timeout", "show-too-large", "property-malformed", "agent-id-unsafe",
  // Topology (agents.{agent_id}.systemd.gateway_unit): the canonical triple
  // against what the manager loads and what the registry row records.
  "gateway-missing", "heartbeat-timer-missing", "heartbeat-service-missing", "misnamed-gateway", "duplicate-gateway",
  "retired-unit", "registry-retired-key",
  // The registry's heartbeat_timer field (agents.{agent_id}.systemd.heartbeat_timer).
  "registry-undeclared", "unit-missing", "misnamed-heartbeat-timer",
  // Any unit leaf.
  "absent", "load-error", "fragment-unsafe", "unit-file-state-unclassified",
  // The gateway (units.hermes-{agent_id}-gateway.service).
  "deferred-but-enabled", "deferred-but-active", "verified-channel-gateway-disabled", "verified-channel-gateway-inactive",
  "channel-undeclared", "channel-identity-incomplete", "channel-secret-unreferenced", "platform-enablement-inherited",
  "unstable", "crash-looping", "result-not-success", "entrypoint-unpinned", "home-mismatch", "home-absent", "home-unsafe",
  // The heartbeat timer (units.hermes-{agent_id}-heartbeat.timer).
  // Whether the tick is HAPPENING -- including a oneshot that is mid-tick
  // (`in-progress`) or wedged past its own start timeout (`stuck`), which is
  // the same question one step further along.
  "timer-disabled", "timer-inactive", "timer-substate", "timer-unpaired", "schedule-off-policy", "schedule-unknown",
  "tick-overdue", "tick-never", "tick-unknown", "in-progress", "stuck",
  // The heartbeat oneshot (units.hermes-{agent_id}-heartbeat.service): whether
  // the last COMPLETED run succeeded.
  "type-not-oneshot", "latest-result-failed", "latest-result-unknown", "never-completed",
  "reconcile-undeclared", "reconcile-opt-out-undeclared", "reconcile-unverifiable", "checkpoint-only", "policy-unreadable", "state-unreadable",
] as const;
export type FleetSystemdItemKind = (typeof FLEET_SYSTEMD_ITEM_KINDS)[number];

/**
 * The five classes an unregistered `hermes-*` unit lands in. Exactly one.
 *
 * `retired`             the name wears a retired shape (`-consumer.service`,
 *                       `-checkpoint.timer`) or a `retired` classification entry
 *                       names it.
 * `transient`           `UnitFileState=transient` -- a `systemd-run` scope; its
 *                       `Description` may name a registered profile, recorded as
 *                       `correlated_profile`.
 * `profile-correlated`  `HERMES_HOME=` names a directory under the profile root.
 * `managed-exception`   a `managed_shared_service` or `intentionally_unmanaged`
 *                       entry with `systemd` in its policy domains claims it.
 * `unclassified`        everything else -- a finding for an operator, never a
 *                       licence to stop, disable or delete.
 *
 * Only `managed-exception` is `pass`; the rest are `warn`, unjustified by
 * design until the operator classifies the unit in the contract. Every item
 * carries `process_reference: "unobserved"`: attributing the process behind a
 * unit is story 1.9.
 */
export const FLEET_SYSTEMD_UNREGISTERED_CLASSES = ["retired", "transient", "profile-correlated", "managed-exception", "unclassified"] as const;
export type FleetSystemdUnregisteredClass = (typeof FLEET_SYSTEMD_UNREGISTERED_CLASSES)[number];

/** How the manager probe ended. `available` is any state the manifest lists (`degraded` included). */
export const FLEET_SYSTEMD_MANAGER_CODES = ["available", "manager-unavailable", "manager-timeout"] as const;
export type FleetSystemdManagerCode = (typeof FLEET_SYSTEMD_MANAGER_CODES)[number];

/**
 * The desired gateway state, DERIVED from the registry's messaging declaration
 * and never from the unit.
 *
 * `active`      a platform's `provisioning_status` is `verified`: the gateway
 *               must be enabled, active, running and stable.
 * `deferred`    every declared platform is `disabled` or `deferred`: the
 *               gateway must be disabled (or masked) and inactive, and no
 *               platform may inherit enablement from the fleet base.
 * `undeclared`  no platform declares a `provisioning_status` this build reads:
 *               an active gateway here is liveness theatre, never health.
 */
export const FLEET_SYSTEMD_CAPABILITY_STATES = ["active", "deferred", "undeclared"] as const;
export type FleetSystemdCapabilityState = (typeof FLEET_SYSTEMD_CAPABILITY_STATES)[number];

/** How recently the heartbeat timer fired, as a BUCKET against the declared schedule. Never an age. */
export const FLEET_SYSTEMD_TICKS = ["current", "overdue", "never", "unknown"] as const;
export type FleetSystemdTick = (typeof FLEET_SYSTEMD_TICKS)[number];

/**
 * What the heartbeat oneshot's latest invocation concluded.
 *
 * `success` a completed run: inactive/dead, `Result=success`, exit 0, exit
 * after start. `in-progress` an activation younger than its start timeout;
 * `stuck` one older. `never` no invocation since boot (after the boot delay).
 * systemd pre-initialises `Result=success` before the first exit, so an
 * activating oneshot is never read as a success -- the template's own rule.
 */
export const FLEET_SYSTEMD_LATEST_RESULTS = ["success", "failed", "in-progress", "stuck", "never", "unknown"] as const;
export type FleetSystemdLatestResult = (typeof FLEET_SYSTEMD_LATEST_RESULTS)[number];

/** Whether the timer's monotonic schedule equals the policy exactly. */
export const FLEET_SYSTEMD_SCHEDULES = ["within-policy", "off-policy", "unknown"] as const;
export type FleetSystemdSchedule = (typeof FLEET_SYSTEMD_SCHEDULES)[number];

/** Whether the unit's `HERMES_HOME` is this agent's named profile directory. `unsafe` is a home outside the fleet home. */
export const FLEET_SYSTEMD_HOME_STATES = ["matches", "mismatch", "absent", "unsafe", "unknown"] as const;
export type FleetSystemdHomeState = (typeof FLEET_SYSTEMD_HOME_STATES)[number];

/** Which executable family a unit's `ExecStart` path belongs to. `launcher` is the role's `credential-launch.sh`. */
export const FLEET_SYSTEMD_ENTRYPOINT_FAMILIES = ["launcher", "hermes-bin", "other", "unknown"] as const;
export type FleetSystemdEntrypointFamily = (typeof FLEET_SYSTEMD_ENTRYPOINT_FAMILIES)[number];

/** What the role's reconcile policy declares. `opted-out` is `enabled: false` WITH `explicit_opt_out: true`. */
export const FLEET_SYSTEMD_RECONCILE_DECLARATIONS = ["enabled", "opted-out", "disabled", "undeclared", "unverifiable", "unreadable"] as const;
export type FleetSystemdReconcileDeclaration = (typeof FLEET_SYSTEMD_RECONCILE_DECLARATIONS)[number];

/** What the heartbeat state file evidences, by the PRESENCE of keys and nothing else. */
export const FLEET_SYSTEMD_RECONCILE_EVIDENCE = ["full-run", "checkpoint-only", "state-missing", "state-unreadable", "not-applicable", "not-read"] as const;
export type FleetSystemdReconcileEvidence = (typeof FLEET_SYSTEMD_RECONCILE_EVIDENCE)[number];

/** What the fleet-shared Bloodbank gateway reads as. `unobserved` under `--agent`, which never probes it. */
export const FLEET_SYSTEMD_SHARED_STATES = ["healthy", "drifted", "absent", "identity-mismatch", "registry-undeclared", "error", "unobserved"] as const;
export type FleetSystemdSharedState = (typeof FLEET_SYSTEMD_SHARED_STATES)[number];

/**
 * How an extra unit attributed to an agent is classed on its topology leaf.
 *
 * Two classes, because two are emitted. A third (`unexpected`) shipped with no
 * emit site, which asks every consumer to handle a case this build cannot
 * produce -- and would have let a real one be added later without anyone
 * noticing the vocabulary already claimed it.
 */
export const FLEET_SYSTEMD_EXTRA_CLASSES = ["retired", "duplicate-gateway"] as const;
export type FleetSystemdExtraClass = (typeof FLEET_SYSTEMD_EXTRA_CLASSES)[number];

/** One unit as the manager last showed it. Words only: no pid, no timestamp, no path. */
export interface FleetStatusSystemdUnitView {
  unit: string;
  load: string | null;
  unit_file: string | null;
  active: string | null;
  sub: string | null;
}

/**
 * One unregistered `hermes-*` unit, classified, with bounded safe evidence.
 *
 * `unit` is the unit NAME. `correlated_profile` is the registered profile a
 * transient scope's `Description` names by an exact `--profile <name>` token,
 * or the profile-root directory a unit's `HERMES_HOME` names; never a
 * substring guess. `process_reference` is `unobserved` in this release: live
 * attribution is story 1.9.
 */
export interface FleetStatusSystemdUnregisteredItem extends FleetStatusSystemdUnitView {
  class: FleetSystemdUnregisteredClass;
  correlated_profile: string | null;
  process_reference: "unobserved";
  guidance: FleetProfileExtraGuidance;
  /** A stable category naming what classified it (`retired:<retired mode id>`, `unit-file-state:transient`, `hermes-home-under-profile-root`, `classifications.managed_shared_service.entries[0]`), never a body. */
  detail: string | null;
}

/** The per-agent systemd summary. `null` when `systemd` was not selected or no manifest is declared. */
export interface FleetStatusAgentSystemd {
  topology: {
    /** The canonical triple the contract derives for this agent, sorted. */
    expected: string[];
    /** Expected units the manager loads. */
    installed: string[];
    /** Expected units the manager does not know (`LoadState=not-found`). */
    missing: string[];
    /** Loaded units attributed to this agent beyond the triple, each classed. */
    extra: Array<{ unit: string; class: FleetSystemdExtraClass }>;
    state: FleetStatusState;
  };
  capability: {
    declared: FleetSystemdCapabilityState;
    /** Per platform, the normalized declaration: `verified`, `deferred` or `undeclared`. */
    platforms: Record<string, "verified" | "deferred" | "undeclared">;
    /** Per platform, whether the delta pins `platforms.<p>.enabled` false (true), true (false), or leaves it inherited (null). */
    delta_disabled: Record<string, boolean | null>;
  };
  gateway: FleetStatusSystemdUnitView & {
    state: FleetStatusState;
    /** The item detail that decided a non-pass, or null. */
    code: string | null;
    result: string | null;
    exec_status: number | null;
    restarts: number | null;
    entrypoint: { family: FleetSystemdEntrypointFamily; pinned: boolean };
    home: FleetSystemdHomeState;
    stability: {
      samples: number;
      stable: boolean;
      /** Bounded transition summaries (`active/running -> activating/auto-restart`, `restarts 3 -> 5`). Never a timestamp. */
      transitions: string[];
    };
  };
  heartbeat: {
    state: FleetStatusState;
    code: string | null;
    timer: FleetStatusSystemdUnitView & { paired: boolean };
    service: FleetStatusSystemdUnitView & {
      result: string | null;
      exec_status: number | null;
      entrypoint: { family: FleetSystemdEntrypointFamily; pinned: boolean };
    };
    schedule: FleetSystemdSchedule;
    latest_result: FleetSystemdLatestResult;
    tick: FleetSystemdTick;
    reconcile: { declared: FleetSystemdReconcileDeclaration; evidence: FleetSystemdReconcileEvidence };
  };
}

/** The fleet-level systemd summary under `data.systemd`. `null` when `systemd` was not selected. */
export interface FleetSystemdSummary {
  source: string;
  manager: { state: string; code: string };
  window: { samples: number; interval_ms: number };
  /** Fleet scope only; zeros under `--agent`, which lists nothing. */
  units: { listed: number; unit_files: number; transient: number };
  /** Counted over EVERY selected agent, before any envelope cap. */
  agents: {
    total_registered: number;
    selected: number;
    /** Selected agents whose five leaves carry no `error` and no `unobserved`. */
    complete: number;
    topology_ok: number;
    /** Gateway leaf `pass` with capability `active`. */
    gateway_healthy: number;
    /** Gateway leaf `pass` with capability `deferred`. */
    gateway_deferred: number;
    /** Both heartbeat leaves `pass`. */
    heartbeat_healthy: number;
    /** Gateway stability windows that were not unanimous, crash loops included. */
    unstable: number;
    crash_looping: number;
    /** At least one leaf `fail` with no exception ruling. */
    drifted: number;
    /** At least one leaf `error` or `unobserved`. */
    incomplete: number;
    /** Drifted agents whose every failing leaf a `health_policy.agent_exceptions` entry covers. */
    exception_authorized: number;
    /** `total_registered - selected`, plus selected agents the observer never reached. */
    unobserved: number;
  };
  capability: Record<FleetSystemdCapabilityState, number>;
  shared: {
    coverage: "observed" | "unobserved";
    unit: string | null;
    profile: string | null;
    state: FleetSystemdSharedState;
    code: string | null;
  };
  unregistered: {
    coverage: "swept" | "not-swept";
    reason: string | null;
    total: number;
    by_class: Record<FleetSystemdUnregisteredClass, number>;
    listed: number;
    truncated: boolean;
  };
  /** Under `--live`, how the observer and the `systemd.sentinel` / `hermes.registry-parity` rules agreed over the subset both read. */
  rule_agreement: { compared: number; agree: number; disagree: number; not_compared: number };
}
