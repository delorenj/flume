// Registry-wide, strictly read-only fleet STATUS.
//
// Story 1.2 answers "what is the fleet". Story 1.3 answers "which build does
// each agent run". Neither answers the question an operator actually asks:
// **is the fleet correct?** Nine observation domains existed as scattered
// per-repository audits, and nothing traversed the registry once and reported
// all of them together.
//
// This module is that traversal. One core, two thin adapters
// (`flume review`, MCP `flume_review`), one aggregate plus one
// stable per-agent record covering ALL NINE domains -- each either observed or
// carrying an explicit `unobserved`/`unsupported` observation with a reason.
//
// Five disciplines make the answer trustworthy rather than merely printable:
//
//   * NO DOMAIN MAY DISAPPEAR. Every one of the nine appears on every agent
//     record and in `data.domains`, always. Silently dropping a domain is the
//     one outcome this module exists to prevent, so absence is expressed as a
//     state with a reason, never as a missing key.
//   * HOST IS NOT PROJECT. A rule whose `scope` is `host` (systemd, $HOME, the
//     fleet registry, the global skill projection) is reported ONCE, deduped by
//     rule id, in `data.host`. It never reaches a per-agent record, never makes
//     an agent or the fleet unhealthy, and is never promoted into a
//     registry-wide claim. That promotion is the exact category error PJAN-84
//     fixed; re-creating it here would undo it fleet-wide.
//   * THE RECIPE AUDIT RUNS AS A BOUNDED CHILD, NEVER IN PROCESS. `runAudit` is
//     synchronous and shells out with `spawnSync` and NO timeout --
//     `systemctl --user is-system-running` twice, `git ls-files --stage`, and
//     `npm view bmad-method`. In process, one hung `systemctl` blocks the event
//     loop, so neither the whole-run deadline nor SIGINT can be honoured and a
//     per-repository timeout is unimplementable. As a child it is killable,
//     isolated and concurrency-capped -- at the cost of depending on
//     `pjangler audit --json` being parse-safe, which is why this story fixes
//     the flush.
//   * `--live` MEANS "MAY REACH THE HOST AND THE NETWORK, READ-ONLY", AND
//     NOTHING ELSE. The bmad rule's `npm view` is a real network call, so the
//     audit is gated. `--live` does not conjure a process or Bloodbank-liveness
//     observer -- those stay `unsupported`/`unobserved`, by name, with the story
//     that owns them. The systemd observer is NOT gated on it: sampling the user
//     manager is a bounded, read-only local read that every scope performs, and
//     what `--live` adds there is only the two recipe rules its readings are
//     then checked for agreement against.
//   * `data` IS DETERMINISTIC. No timestamp, duration, pid, hostname, or
//     ordering by completion: the child's `auditedAt` is dropped at the boundary
//     and every path goes through `redactHome`. Two runs over unchanged state
//     produce byte-identical `data`, which is what turns the CLI/MCP parity
//     assertion into an equality rather than a resemblance.
//
// What this module deliberately does NOT do: observe live processes or
// Bloodbank liveness (stories 1.9/1.10); mutate anything, anywhere; or run
// the credentialed `momo-lifecycle-plane` profile.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadFleetContract, resolveFleetContractPath, validateFleetContract } from "./contract";
import {
  boundTransitions,
  classifyMember,
  classifyObservation,
  compareStatusFindings,
  detectContradictions,
  diffFindings,
  emptyMembers,
  evaluateDomainFreshness,
  evaluateFleetHealth,
  parseBaselineDocument,
  readHealthPolicy,
  snapshotCurrent,
  snapshotStatusDocument,
  type FleetHealthPolicyView,
  type FleetStatusSortable,
} from "./health";
import {
  buildAuthorityIndex,
  collectFleetInventory,
  matchException,
  readAgentRegistryRaw,
  readProjectRegistryRaw,
  resolveFleetHome,
  resolveInventoryStores,
  resolveProfileLayout,
  ruleIdForFindingCode,
  type FleetAuthorityIndex,
  type FleetInventoryOptions,
} from "./inventory";
import { bounded, redactHome } from "./output";
import { collectProfileHealth, resolveConfigHome, type FleetProfileAgentResult, type FleetProfileHealth } from "./profile";
import { collectFleetProvenance } from "./provenance";
import { captureSelf, mapBounded, remainingMs, throwIfCancelled, type FleetRunContext } from "./runtime";
import { collectScaffoldParity, type FleetScaffoldAgentResult, type FleetScaffoldParity } from "./scaffold";
import { collectSystemdHealth, type FleetSystemdAgentResult, type FleetSystemdHealth } from "./systemd";
import {
  FLEET_PROFILE_EXTRA_CLASSES,
  FLEET_SYSTEMD_CAPABILITY_STATES,
  FLEET_SYSTEMD_UNREGISTERED_CLASSES,
  FLEET_STATUS_AUDIT_CONCURRENCY,
  FLEET_STATUS_DOMAINS,
  FLEET_STATUS_MAX_AGENTS,
  FLEET_STATUS_MAX_DETAILS,
  FLEET_STATUS_MAX_FINDINGS,
  FLEET_STATUS_MAX_ITEMS,
  FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT,
  FLEET_STATUS_MAX_WIP_OVERLAP,
  FLEET_STATUS_STATE_PRECEDENCE,
  FLEET_STATUS_STATES,
  FleetError,
  type FleetActivationState,
  type FleetClassificationId,
  type FleetContract,
  type FleetFindingSeverity,
  type FleetInventoryRow,
  type FleetProbeRecord,
  type FleetProfileExtraClass,
  type FleetProfileManifest,
  type FleetProfileSummary,
  type FleetProvenanceFact,
  type FleetScaffoldManifest,
  type FleetScaffoldSummary,
  type FleetServiceManifest,
  type FleetStatus,
  type FleetStatusAgent,
  type FleetStatusAgentProfile,
  type FleetStatusAgentScaffold,
  type FleetStatusAgentSystemd,
  type FleetStatusObservationItem,
  type FleetStatusProfileExtraItem,
  type FleetStatusSystemdUnregisteredItem,
  type FleetSystemdCapabilityState,
  type FleetSystemdSummary,
  type FleetSystemdUnregisteredClass,
  type FleetStatusDomain,
  type FleetStatusDomainRollup,
  type FleetStatusEvidence,
  type FleetStatusFinding,
  type FleetStatusHostFinding,
  type FleetStatusLifecycle,
  type FleetStatusLifecycleState,
  type FleetStatusReadiness,
  type FleetStatusMemberClass,
  type FleetStatusMembers,
  type FleetStatusObservation,
  type FleetStatusScope,
  type FleetStatusSeverity,
  type FleetStatusState,
  type FleetStatusTotals,
  type FleetStatusTransition,
} from "./types";
import { resolveTemplateConfigPath } from "../kernel/host-config";
import { resolveFlumeRoot, resolveFlumePackageRoot } from "../kernel/paths";
import { recipeRegistry } from "../parity/catalog";
import { ORG_REMEDIABLE_RULES } from "../parity/reconcile";

/**
 * Rule id -> observation domain.
 *
 * STATIC, and a table rather than a heuristic on the id's prefix: `hermes.*`
 * spans three different domains and `notebook.*` spans two, so a prefix rule
 * would file findings under a domain nobody chose. Every rule the default recipe
 * registry declares is listed; an unlisted one lands in
 * `UNMAPPED_RULE_DOMAIN` **and** raises a finding, so a rule added by a later
 * story cannot silently vanish from the fleet's status.
 */
const RULE_DOMAIN: Readonly<Record<string, FleetStatusDomain>> = Object.freeze({
  // Tracked assets the CommonProject / Hermes template owns in a repository.
  "secrets.env-op": "template_scaffold",
  "mise.config-root": "template_scaffold",
  "mise.versioning": "template_scaffold",
  "skills.project-manifest": "template_scaffold",
  "sot.agent-symlinks": "template_scaffold",
  "bmad.scaffold": "template_scaffold",
  "bmad.cli-roots": "template_scaffold",
  "hermes.pm-scaffold": "template_scaffold",
  "provenance.copier": "template_scaffold",
  "notebook.skill-installed": "template_scaffold",
  "notebook.hooks-projected": "template_scaffold",
  // Version currency of a scaffolded dependency. DELIBERATELY NOT
  // `release_provenance`: that domain is the HERMES release each agent runs, and
  // it is fed by the provenance core alone -- filing a BMAD version check there
  // would make `--live` change a domain whose whole definition is that it does
  // not.
  "bmad.version": "template_scaffold",
  // The project's identity and its binding to a board / manifest.
  "sot.project-json": "project_binding",
  "notebook.configuration": "project_binding",
  "notebook.binding": "project_binding",
  "notebook.remote-notebook": "project_binding",
  "notebook.overview-note": "project_binding",
  "notebook.capture-receipts": "project_binding",
  // Generated profile tree.
  "hermes.runtime-singleton": "profile",
  "hermes.profile-wiring": "profile",
  "hermes.delta-list-override": "profile",
  // Ignored role-local runtime bytes.
  "hermes.untracked-runtimes": "runtime",
  // Shared-host service topology.
  "systemd.sentinel": "systemd",
  // The fleet-shared Bloodbank gateway's own configuration.
  "hermes.fleet-config": "bloodbank",
  // Registry parity between the two canonical stores.
  "hermes.registry-parity": "registry",
  // The org-wide rules (`src/parity/reconcile.ts`), which answer for the
  // findings the INVENTORY raises rather than for anything in a repository.
  // Every one is host-scoped, so none of them spawns a per-agent audit child --
  // the mapping exists so an observation the inventory already produced can name
  // the rule that repairs it, and so the id is never filed under
  // `UNMAPPED_RULE_DOMAIN`.
  "org.board-projection": "project_binding",
  "org.profile-path": "profile",
  "org.runtime-path": "runtime",
  "org.project-records": "registry",
  "org.identity-conflict": "registry",
});

/**
 * Where a rule nobody has classified lands.
 *
 * `template_scaffold` is the catch-all for two reasons. Most recipe rules are
 * about tracked assets in a repository, so it is the likeliest right answer.
 * And it is a domain the audit already feeds per agent, so an unmapped rule
 * reaches the report on any run that selects it rather than landing in a domain
 * that spawns no child (see `AUDIT_PER_AGENT_DOMAINS`) and therefore never
 * showing up at all.
 *
 * The choice matters less than the finding that accompanies it: an unmapped rule
 * is REPORTED as unclassified, so the gap is visible in the same run rather than
 * discovered when someone notices a domain has gone quiet.
 */
const UNMAPPED_RULE_DOMAIN: FleetStatusDomain = "template_scaffold";

/**
 * Rules this command deliberately does not consume, and why.
 *
 * `momo-lifecycle-plane` is a `skip` stub in the default registry: its real
 * checks live behind `pj audit --profile momo-lifecycle-plane --live` and are
 * CREDENTIALED (they call a Plane API with the operator's key). A read-only
 * fleet status has no business reaching a board, so the stub is dropped rather
 * than reported as a permanently-skipped domain member.
 *
 * Held apart from "unmapped" on purpose: an excluded rule is a decision, an
 * unmapped one is an omission, and collapsing the two would let the next
 * omission hide behind this decision.
 */
const EXCLUDED_RULES: ReadonlySet<string> = new Set(["momo-lifecycle-plane"]);

/**
 * Domains whose PER-AGENT record the recipe audit can change.
 *
 * Narrower than "every domain the rule table mentions", and the difference is
 * load-bearing. `registry`, `systemd` and `bloodbank` are each fed by exactly
 * one rule and that rule is HOST-scoped, so an audit run adds nothing to any
 * agent's record in those domains -- it only fills `data.host`. Spawning 28 node
 * children to answer `--domain systemd` would be collection a filter explicitly
 * forbids, so this set is what decides whether a child runs at all.
 *
 * Cross-checked at runtime rather than trusted: a project-scoped rule that maps
 * to a domain outside this set raises `audit-domain-unexpected`, so the day a
 * host-scoped rule becomes project-scoped is the day this set is told about it.
 */
const AUDIT_PER_AGENT_DOMAINS: ReadonlySet<FleetStatusDomain> = new Set<FleetStatusDomain>([
  "template_scaffold", "project_binding", "profile", "runtime",
]);

/**
 * Domains whose default observation comes from the provenance core.
 *
 * Only these two make `collectFleetProvenance` run, and that is the point:
 * `--domain registry` must spawn zero provenance probes, not spawn them and then
 * hide the results.
 */
const PROVENANCE_FED_DOMAINS: ReadonlySet<FleetStatusDomain> = new Set<FleetStatusDomain>([
  "template_scaffold",
  "release_provenance",
]);

/**
 * The contract field path each domain is ABOUT.
 *
 * A rule finding has no field path of its own -- `rule_id` identifies it -- so
 * its observation is attributed to the path its domain covers. Filing every one
 * of them under `scaffold` (the first draft) told a reader that a notebook
 * binding rule was about the role scaffold, which is worse than saying nothing.
 *
 * `processes.{agent_id}` resolves to no owner on purpose: nothing writes a
 * process table, and nothing here invents someone who can. The authority that
 * used to say so was deleted in the 2026-09-22 trim -- it declared read_only
 * with zero writable fields, which is the same statement with a block around
 * it.
 */
const DOMAIN_FIELD: Readonly<Record<FleetStatusDomain, string>> = Object.freeze({
  registry: "agents.{agent_id}",
  project_binding: "agents.{agent_id}.plane.identifier",
  template_scaffold: "scaffold",
  // `agents.{agent_id}.profile_name`, not `profiles.{profile_name}`. Both are
  // defensible and having BOTH was not: `observeFromInventory` emitted one and
  // this table the other for the same domain, so the two observations resolved
  // their fallback owner from different contract paths -- the only domain where
  // that happened.
  profile: "agents.{agent_id}.profile_name",
  runtime: "agents.{agent_id}.role_dir",
  systemd: "agents.{agent_id}.systemd.gateway_unit",
  live_process: "processes.{agent_id}",
  bloodbank: "agents.{agent_id}.bloodbank.gateway_scope",
  release_provenance: "agents.{agent_id}.hermes.bin",
});

/**
 * What each domain looks like when it is RIGHT.
 *
 * The `desired` half of every observation that does not carry a recorded value
 * of its own -- a store read has one live side and no pinned one, so without
 * this an operator reading `observed: "symlink"` is told what is there and
 * never what should be. Copied from `FleetProvenanceFact.desired`/`.observed`
 * rather than invented: one shape for both halves, everywhere.
 */
const DOMAIN_DESIRED: Readonly<Record<FleetStatusDomain, string>> = Object.freeze({
  registry: "a well-formed row, in no identity conflict, correlated to exactly one project record",
  project_binding: "a stored board binding the repository manifest agrees with",
  template_scaffold: "every tracked asset at the committed template's pinned gitlink",
  profile: "a real directory under the declared profile root; the contract declares symlink_allowed: false",
  runtime: "a real role-local runtime directory derived from role_dir, ignored by git",
  systemd: "the canonical per-agent unit set, observed on this machine",
  live_process: "every running Hermes process attributed to a registry row",
  bloodbank: "a fleet-scoped routing record with a target id and an explicit boolean activation flag",
  release_provenance: "the recorded pin and the live build agreeing",
});

/**
 * The authority BLOCK that answers for a domain when no field path does.
 *
 * `ownerOf` indexes `writable_fields`, so a read-only authority -- the process
 * table declares `writable_fields: []` by design -- resolves to nobody, and
 * `live_process` observations shipped `owner: null`. A finding nobody owns is a
 * finding nobody acts on, and AC7 requires every non-pass to name an owner.
 *
 * The block KEYS are contract-declared and the owner is read out of the
 * contract, so this table adds a lookup and never a literal owner name.
 */
const DOMAIN_AUTHORITY_BLOCK: Readonly<Record<FleetStatusDomain, string>> = Object.freeze({
  registry: "agent_operational_records",
  project_binding: "project_identity",
  template_scaffold: "tracked_role_scaffold",
  profile: "agent_profile_state",
  runtime: "agent_operational_records",
  systemd: "systemd_lifecycle",
  // `live_process_observations` was deleted in the 2026-09-22 trim: it declared
  // read_only with zero writable fields, so `ownerOf` resolved it to nobody and
  // this table existed largely to paper over that. A live-process finding about
  // an agent is ultimately a claim about that agent's record, which has a real
  // owner that can actually be asked to act.
  live_process: "agent_operational_records",
  bloodbank: "agent_operational_records",
  release_provenance: "agent_operational_records",
});

/**
 * The capability name each declared gap answers for.
 *
 * These are the keys `health_policy.deferred_capabilities[].capability` joins
 * on, and they are what turns the three literals story 1.4 shipped -- an
 * `unsupported` observation that authorized itself -- into a gap the CONTRACT
 * authorizes. Remove the policy entry and the same observation is still
 * reported, still `unsupported`, and now unjustified: DW-63's three domains
 * stop authorizing themselves.
 */
const CAPABILITY_LIVE_PROCESS = "process_attribution";
const CAPABILITY_BLOODBANK_LIVENESS = "routing_liveness";
/**
 * The scaffold observer's own gap: a contract with no `scaffold_manifest` gives
 * it nothing to compare against, so every selected agent's `template_scaffold`
 * is `unsupported` under this capability -- unjustified unless the policy says
 * otherwise, exactly like the three above.
 */
const CAPABILITY_SCAFFOLD_MANIFEST = "scaffold.manifest";
/**
 * The profile observer's own gap (story 1.7): a contract with no
 * `profile_manifest` gives it nothing to prove against, so every selected
 * agent's five profile fields are `unsupported` under this capability --
 * unjustified unless the policy says otherwise, exactly like the four above.
 */
const CAPABILITY_PROFILE_MANIFEST = "profile.manifest";
/**
 * The systemd observer's own gap (story 1.8): a contract with no
 * `service_manifest` declares no canonical service state, so every selected
 * agent's five systemd leaves are `unsupported` under this capability --
 * unjustified unless the policy says otherwise, exactly like the five above.
 */
const CAPABILITY_SYSTEMD_MANIFEST = "systemd.manifest";

/** The inventory finding severity, mapped onto the status priority axis. */
const FINDING_SEVERITY: Readonly<Record<FleetFindingSeverity, FleetStatusSeverity>> = Object.freeze({
  error: "critical",
  warn: "medium",
  info: "info",
});

/**
 * Provenance fact-id prefix -> observation domain.
 *
 * The same discipline `RULE_DOMAIN` gets, and for the same reason: a fact id
 * that matches nothing lands in `UNMAPPED_FACT_DOMAIN` **and** raises
 * `provenance-fact-unmapped`, so a fact a later story adds to the provenance
 * core cannot be silently dropped or silently misfiled. Before this, the
 * fleet-scoped branch was a bare `startsWith("template.") ? ... : ...`, which
 * filed every unrecognized fact under `release_provenance` and said nothing.
 */
const FACT_PREFIX_DOMAIN: ReadonlyArray<readonly [string, FleetStatusDomain]> = Object.freeze([
  ["scaffold.", "template_scaffold"],
  ["template.", "template_scaffold"],
  ["hermes.", "release_provenance"],
  ["profile.", "release_provenance"],
  // The host pin: `fleet.hermes_bin`, `fleet.hermes_repo`, `fleet.registry_file`.
  ["fleet.", "release_provenance"],
] as const);

const UNMAPPED_FACT_DOMAIN: FleetStatusDomain = "release_provenance";

/** Which domain a provenance fact belongs to, and whether anything declared it. */
function factDomain(factId: string): { domain: FleetStatusDomain; mapped: boolean } {
  for (const [prefix, domain] of FACT_PREFIX_DOMAIN) {
    if (factId.startsWith(prefix)) return { domain, mapped: true };
  }
  return { domain: UNMAPPED_FACT_DOMAIN, mapped: false };
}

/** Source ids, used as the `source` on an observation. */
const SOURCE_REGISTRY = "fleet-inventory";
const SOURCE_PROVENANCE = "fleet-provenance";
const SOURCE_AUDIT = "recipe-audit";
const SOURCE_DECLARED_GAP = "declared-gap";
/** The scaffold observer (story 1.6): role directories against the template at the committed gitlink. */
const SOURCE_SCAFFOLD = "fleet-scaffold";

/** The host-scoped rule id the source-integrity finding is filed under. */
const SCAFFOLD_SOURCE_RULE_ID = "scaffold.source";

/** The profile observer (story 1.7): the profile tree gated, read, and proven through the canonical renderer's check. */
const SOURCE_PROFILE = "fleet-profile";
/** The three host-scoped rule ids the profile observer files its fleet-wide findings under. */
const PROFILE_ROOT_RULE_ID = "profile.root";
const PROFILE_RENDERER_RULE_ID = "profile.renderer";
const PROFILE_EXTRAS_RULE_ID = "profile.extras";
const PROFILE_SKILL_CORE_RULE_ID = "profile.skill-core";

/**
 * The five fields the profile observer reports on, as `profiles.{profile_name}`
 * leaves. NEVER `agents.{agent_id}.profile_name`: that is the inventory's own
 * field for this domain, `detectContradictions` joins on `(agent, domain,
 * field)`, and a path `fail` here beside the inventory's `lstat` would be
 * reported as two sources disagreeing about one thing when they are two true
 * readings of two things.
 */
const PROFILE_FIELD_PATH = "profiles.{profile_name}";
const PROFILE_FIELD_IDENTITY = "profiles.{profile_name}.profile.yaml";
const PROFILE_FIELD_CONFIG = "profiles.{profile_name}.config.yaml";
const PROFILE_FIELD_BANK = "profiles.{profile_name}.hindsight.config.json";
const PROFILE_FIELD_SKILLS = "profiles.{profile_name}.skills";

/**
 * The subset of the profile the `hermes.runtime-singleton` recipe rule ALSO
 * reads, so the two can be checked for agreement under `--live`.
 *
 * The rule checks the profile directory exists and is not a symlink, each
 * singleton link points at its runtime target, `config.yaml` is a real
 * rendered file, `config.delta.yaml` is a real file, and the bank pin is
 * present and exact. It parses no config, reads no identity file and no
 * skill, so semantic drift, identity and skill findings are coverage it
 * never had -- an observer finding there is not a disagreement. The patterns
 * are anchored on the rule's OWN literal detail prefixes (`src/parity/rules.ts`,
 * the `hermes.runtime-singleton` audit and `profileConfigFindings`), and the
 * suite pins each against that source so a reworded detail goes red.
 */
const PROFILE_RULE_DETAIL_PATTERNS: readonly RegExp[] = [
  /^profile dir missing: /u,
  /^wrong-target: /u,
  /^not-a-symlink: /u,
  /^profile config missing /u,
  /^config\.yaml is a symlink /u,
  /^config\.yaml is not a rendered artifact /u,
  /^config\.delta\.yaml missing /u,
  /^config\.delta\.yaml must be a real file/u,
  /^identity-memory /u,
];
/** The byte-policy observer may reject a profile alias the core supports. */
const PROFILE_RULE_COVERED_GATE_KINDS: ReadonlySet<string> = new Set(["missing", "not-a-directory"]);
const PROFILE_RULE_COVERED_KINDS: ReadonlySet<string> = new Set([
  "misowned-link", "generated-symlink", "generated-missing", "marker-missing", "delta-missing", "delta-symlink",
  "pin-missing", "pin-symlink", "pin-malformed", "bank-missing", "bank-custom", "bank-alias", "bank-mismatch",
]);

/** The systemd observer (story 1.8): the user manager sampled directly over a declared stabilization window. */
const SOURCE_SYSTEMD = "fleet-systemd";
/** The three host-scoped rule ids the systemd observer files its fleet-wide findings under. */
const SYSTEMD_MANAGER_RULE_ID = "systemd.manager";
const SYSTEMD_SHARED_RULE_ID = "systemd.shared-gateway";
const SYSTEMD_UNREGISTERED_RULE_ID = "systemd.unregistered";

/**
 * The five leaves the systemd observer reports on.
 *
 * Two registry fields and three unit names, and every one of them is declared
 * writable under the contract's `systemd_lifecycle` authority -- so `ownerOf`
 * answers `runtime-template` for each and no finding ships without an
 * owner. Never `agents.{agent_id}.systemd.gateway_unit` ALONE for all five: the
 * three unit leaves are about units on this manager and the two registry leaves
 * are about the row, and `by_state` counts agents per aspect only when the
 * aspects have separate fields.
 */
const SYSTEMD_FIELD_TOPOLOGY = "agents.{agent_id}.systemd.gateway_unit";
const SYSTEMD_FIELD_HEARTBEAT_TIMER_ROW = "agents.{agent_id}.systemd.heartbeat_timer";
const SYSTEMD_FIELD_GATEWAY = "units.hermes-{agent_id}-gateway.service";
const SYSTEMD_FIELD_TIMER = "units.hermes-{agent_id}-heartbeat.timer";
const SYSTEMD_FIELD_SERVICE = "units.hermes-{agent_id}-heartbeat.service";
const SYSTEMD_FIELDS = [
  SYSTEMD_FIELD_TOPOLOGY, SYSTEMD_FIELD_HEARTBEAT_TIMER_ROW,
  SYSTEMD_FIELD_GATEWAY, SYSTEMD_FIELD_TIMER, SYSTEMD_FIELD_SERVICE,
] as const;

/**
 * The literal detail prefixes `systemd.sentinel` and `hermes.registry-parity`
 * write, so the two can be checked for agreement with the observer under
 * `--live`.
 *
 * Anchored on the rules' OWN strings (`src/parity/rules.ts`, the
 * `systemd.sentinel` audit and the registry-parity retired-key block), and the
 * suite pins each against that source so a reworded detail goes red rather than
 * silently stopping the comparison.
 *
 * The subset is narrow on purpose. The sentinel reads enablement, activity and
 * unit-file presence and NOTHING else -- no stability window, no channel
 * declaration, no schedule, no heartbeat result -- so an observer finding on
 * `unstable`, `crash-looping`, `channel-*`, `schedule-*`, `tick-*` or any
 * heartbeat-result code is coverage the rule never had, and is `not_compared`.
 */
const SYSTEMD_RULE_DETAIL_PATTERNS: readonly RegExp[] = [
  /should be enabled\+active/u,
  /is deferred and should be disabled\+inactive/u,
  /should be installed/u,
];
const SYSTEMD_PARITY_DETAIL_PATTERNS: readonly RegExp[] = [
  /carries retired systemd\./u,
  /^retired per-agent consumer unit still on disk: /u,
];
/** Observer item kinds the two rules also see. Everything else is coverage they never had. */
const SYSTEMD_RULE_COVERED_KINDS: ReadonlySet<string> = new Set([
  "deferred-but-enabled", "deferred-but-active",
  "verified-channel-gateway-disabled", "verified-channel-gateway-inactive",
  "timer-disabled", "timer-inactive",
  "gateway-missing", "heartbeat-timer-missing", "heartbeat-service-missing",
  "retired-unit", "registry-retired-key",
]);

/**
 * The subset of the scaffold the `hermes.pm-scaffold` recipe rule ALSO compares,
 * so the two can be checked for agreement under `--live`.
 *
 * The rule reads `hermes`, `.gitignore` and `.scripts/**` for content, and
 * `role.yaml`, `SOUL.md` and `.runtime-scaffold/README.md` for presence. It
 * ignores `momo`, modes, types, symlinks and extra tracked files, so those are
 * not in the subset: an observer finding there is not a disagreement, it is
 * coverage the rule never had.
 */
const RULE_COVERED_CONTENT_GROUPS: ReadonlySet<string> = new Set([
  "scaffold.hermes", "scaffold.gitignore", "scaffold.scripts", "scaffold.sentinel.prompt.md",
]);
const RULE_COVERED_PRESENCE_PATHS: ReadonlySet<string> = new Set(["role.yaml", "SOUL.md", ".runtime-scaffold/README.md"]);
const RULE_COVERED_KINDS: ReadonlySet<string> = new Set(["missing", "stale-content", "locally-modified"]);

/**
 * Wall-clock budget for ONE audit child, still floored by the whole-run deadline.
 *
 * Its own number, not the per-probe one. `FLEET_DEFAULT_PROBE_TIMEOUT_MS` is
 * 5 000 ms and is sized for a local `git` read; the audit child is a node
 * startup plus 25 rules, one of which (`bmad.version`) gives `npm view` an 8 000
 * ms timeout of its OWN (`src/parity/rules.ts`, 1 h disk cache). Inheriting the
 * probe budget therefore timed out every repository on a cold cache -- reported
 * as `unobserved` for a reason no operator could see. 20 s leaves the child's own
 * 8 s call room to finish and still bounds a hung `systemctl`.
 */
export const FLEET_STATUS_AUDIT_TIMEOUT_MS = 20_000;

/** The env key that redirects the audit child at a different entry point. */
const CLI_ENTRY_ENV = "PJ_FLEET_CLI_ENTRY";

/**
 * The ONLY environment keys a recipe-audit child receives.
 *
 * An allowlist, not a filter. `~/.hermes/fleet.env` and this process's own
 * environment carry live Plane API keys on the operator's host, and "no literal
 * credential in any child environment" is a guarantee that has to be structural:
 * a denylist is one new key name away from being wrong, and a redaction pass is
 * one forgotten call away from the same.
 *
 * Everything here is something `pjangler audit` genuinely needs: where HOME and
 * the XDG roots are, which registries to read, a PATH to find `git` and `npm`
 * on, a TMPDIR, and the session bus `systemctl --user` talks over.
 */
const AUDIT_CHILD_ENV_KEYS = [
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM",
  "TMPDIR", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "HERMES_FLEET_HOME", "HERMES_AGENTS_REGISTRY", "HERMES_FLEET_REGISTRY_FILE",
  "HERMES_FLEET_ENV", "HERMES_TEMPLATE_CONFIG",
  "HERMES_TEMPLATE_RUNTIME_SCAFFOLD", "RUNTIME_SCAFFOLD_DIR",
  "PJ_PROJECT_REGISTRY",
  "NO_COLOR",
] as const;

export interface FleetStatusOptions extends FleetInventoryOptions {
  /** The run's deadline and cancellation budget. Required: every child is bounded by it. */
  runContext: FleetRunContext;
  /** Report only this domain. Validated against `FLEET_STATUS_DOMAINS`. */
  domain?: string;
  /**
   * Authorize bounded, read-only host and network observation.
   *
   * It authorizes the recipe-audit child and nothing else. Never mutation,
   * process control, service changes, board changes, or Bloodbank activation.
   */
  live?: boolean;
  /**
   * A prior status document to correlate this run against.
   *
   * Opened for READING and nothing else, before any probe or child spawns. No
   * state is ever persisted to compute a transition: the baseline is the
   * operator's document, and an unreadable or unparseable one is INVALID_INPUT
   * naming the path rather than an empty `transitions[]` that reads exactly
   * like "nothing changed".
   */
  baseline?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Mirrors the unexported `expandHome` in `src/project/index.ts`. */
function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** A path as an operator may see it: bounded, with their home collapsed to `~`. */
function shownPath(path: string): string {
  return bounded(redactHome(path));
}

/**
 * A stable id for one observation, identical on every run and on both adapters.
 *
 * The `conflictGroupId` idiom (`inventory.ts`): a sha256 prefix over the tuple
 * that identifies the observation, NUL-joined so two components cannot run
 * together into a third spelling. Every input is a field the observation itself
 * carries, so the id is reproducible from the payload rather than from state
 * only this process had.
 *
 * `source` is one of those inputs, and it is not decoration. Two DIFFERENT
 * sources routinely answer for the same `(agent, domain, field)` -- the registry
 * row's own reading of `agents.{agent_id}.plane.identifier` and the
 * recipe-audit's "this half was not read" marker for the same path, neither
 * carrying a rule id. MEASURED: without `source` those two hashed to one id, and
 * any consumer joining on it would have silently merged an observation with the
 * statement that the observation is missing.
 */
function statusFindingId(
  scope: "fleet" | "agent" | "host",
  agentId: string | null,
  domain: FleetStatusDomain,
  ruleId: string | null,
  field: string,
  source: string,
): string {
  const key = [scope, agentId ?? "", domain, ruleId ?? "", field, source].join("\u0000");
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
}

/**
 * The command that returns one record on its own. Always a real invocation.
 *
 * `domain` is omitted for a whole AGENT record: naming an arbitrary one there
 * would hand a caller whose envelope was clipped a command that returns a
 * different, smaller thing than the record they were reading.
 */
function retrievalFor(agentId: string | null, domain: FleetStatusDomain | null, live: boolean): string {
  const parts = ["flume review"];
  if (agentId) parts.push(`--agent ${agentId}`);
  if (domain) parts.push(`--domain ${domain}`);
  if (live) parts.push("--live");
  parts.push("--json");
  return bounded(parts.join(" "));
}

/**
 * The domain a clip hurt most, so a clipped record can name a narrowing that works.
 *
 * `own` minus `kept`, per domain. Ties keep the earlier domain in
 * `FLEET_STATUS_DOMAINS` order, which is fixed, so two runs over unchanged state
 * pick the same one. Falls back to the first selected domain when nothing was
 * actually dropped from any of them.
 */
function mostClippedDomain(
  own: readonly FleetStatusObservation[],
  kept: readonly FleetStatusObservation[],
  domains: readonly FleetStatusDomain[],
): FleetStatusDomain {
  const count = (list: readonly FleetStatusObservation[], domain: FleetStatusDomain): number =>
    list.reduce((total, item) => total + (item.domain === domain ? 1 : 0), 0);
  let best = domains[0]!;
  let bestDropped = -1;
  for (const domain of domains) {
    const dropped = count(own, domain) - count(kept, domain);
    if (dropped > bestDropped) { best = domain; bestDropped = dropped; }
  }
  return best;
}

/** Bound every detail line and record the clip in the line itself, never silently. */
function boundedDetails(details: readonly unknown[] | undefined): string[] {
  const all = (details ?? []).filter((item): item is string => typeof item === "string");
  const kept = all.slice(0, FLEET_STATUS_MAX_DETAILS).map((item) => bounded(redactHome(item)));
  if (all.length > FLEET_STATUS_MAX_DETAILS) {
    kept[kept.length - 1] = bounded(`... ${all.length - FLEET_STATUS_MAX_DETAILS} of ${all.length} detail line(s) dropped`);
  }
  return kept;
}

/** Where a state sits in the declared precedence. Lower is worse. */
function stateRank(state: FleetStatusState): number {
  const index = (FLEET_STATUS_STATE_PRECEDENCE as readonly FleetStatusState[]).indexOf(state);
  return index === -1 ? FLEET_STATUS_STATE_PRECEDENCE.length : index;
}

/**
 * The worst state in a set, under the declared precedence.
 *
 * Reads `FLEET_STATUS_STATE_PRECEDENCE` rather than re-spelling the order here:
 * a precedence constant that no code iterates is decoration, and reordering it
 * has to move behaviour or it is not the rule it claims to be.
 */
export function rollUp(observations: readonly { state: FleetStatusState }[]): FleetStatusState {
  // `unsupported` STEPS ASIDE when the domain produced anything else, and this
  // is the one deliberate refinement of the raw precedence.
  //
  // `unsupported` says "no adapter exists in this release" -- a statement about
  // this BUILD, not about the fleet. It outranks `fail` because for a domain
  // with nothing else (`live_process`) that is exactly right: no answer beats a
  // partial one. Applied to a MIXED domain it inverts into a lie:
  // `template_scaffold` carries one permanent "a deployed role scaffold records
  // no template ref" beside eighteen stale tracked assets, and an operator
  // reading `unsupported` there would conclude this release cannot see the
  // scaffold when it can see it and it is broken. It is also what the story's
  // own acceptance asks for -- a project-scoped `warn` must roll that agent's
  // domain up to `warn`.
  const decisive = observations.some((observation) => observation.state !== "unsupported")
    ? observations.filter((observation) => observation.state !== "unsupported")
    : observations;
  for (const state of FLEET_STATUS_STATE_PRECEDENCE) {
    if (decisive.some((observation) => observation.state === state)) return state;
  }
  // An empty set is not a pass. It is a domain nothing looked at, which is
  // exactly what `unobserved` means -- claiming `pass` here is how an aggregate
  // turns absence into agreement.
  return "unobserved";
}

/** The lifecycle status a recipe rule reports, as a status state. One-for-one. */
function ruleState(status: unknown): FleetStatusState {
  switch (status) {
    case "pass": return "pass";
    case "fail": return "fail";
    case "warn": return "warn";
    case "skip": return "skip";
    // A rule that reports something this build does not know about is a
    // collection error, not a pass: the audit contract changed under us.
    default: return "error";
  }
}

/**
 * A provenance fact's status, as a status state.
 *
 * `mismatch` and `dirty` are both proven drift, so both are `fail`. `missing` is
 * a gap rather than a proven conflict -- a registry row that records no
 * `git_sha` has not been shown to be running the wrong build, only shown to be
 * unable to confirm the right one -- so it warns. That distinction is what keeps
 * `healthy` meaningful on a fleet where 21 of 28 rows record no sha at all.
 */
function provenanceState(status: FleetProvenanceFact["status"]): FleetStatusState {
  switch (status) {
    case "match": return "pass";
    case "mismatch": return "fail";
    case "dirty": return "fail";
    case "missing": return "warn";
    case "unsupported": return "unsupported";
    case "unobserved": return "unobserved";
  }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface ResolvedStatusScope {
  scope: FleetStatusScope;
  agentIds: string[];
  domains: FleetStatusDomain[];
}

/**
 * Which agents and which domains this run will actually collect.
 *
 * Both filters are validated HERE, before anything spawns. DW-56 records story
 * 1.3 validating `--agent` only after the whole probe sweep had run, which made
 * a typo indistinguishable from a slow fleet (it could exit 7 rather than 3).
 * The scope also carries fleet-wide totals under a filter, so a scoped answer
 * can never read as a fleet-complete one.
 */
export function resolveStatusScope(
  options: Pick<FleetStatusOptions, "agentId" | "domain" | "live" | "baseline">,
  registeredIds: readonly string[],
  totalRegisteredAgents: number,
): ResolvedStatusScope {
  const live = options.live === true;

  let domains: FleetStatusDomain[] = [...FLEET_STATUS_DOMAINS];
  let selectedDomain: FleetStatusDomain | null = null;
  const wantedDomain = options.domain?.trim();
  if (wantedDomain !== undefined && wantedDomain !== "") {
    if (!(FLEET_STATUS_DOMAINS as readonly string[]).includes(wantedDomain)) {
      throw new FleetError(
        "INVALID_INPUT",
        `--domain must be one of ${FLEET_STATUS_DOMAINS.join(", ")}`,
        false,
        { domain: bounded(wantedDomain, 128) },
      );
    }
    selectedDomain = wantedDomain as FleetStatusDomain;
    domains = [selectedDomain];
  }

  let agentIds = [...registeredIds];
  let kind: FleetStatusScope["kind"] = "fleet";
  let agentId: string | null = null;
  const wantedAgent = options.agentId?.trim();
  if (wantedAgent !== undefined && wantedAgent !== "") {
    if (!registeredIds.includes(wantedAgent)) {
      throw new FleetError("NOT_FOUND", "No agent with that id is registered", false, { agent_id: bounded(wantedAgent, 128) });
    }
    agentIds = [wantedAgent];
    kind = "agent";
    agentId = bounded(wantedAgent, 128);
  }

  // The label has to say SCOPED, loudly. A one-agent, one-domain answer that
  // reads "fleet status" is the shape of an aggregate lying by omission.
  const parts: string[] = [];
  parts.push(agentId ? `scoped to agent ${agentId}` : "whole registered fleet");
  parts.push(selectedDomain ? `domain ${selectedDomain} only` : "all nine domains");
  parts.push(live ? "live host observation authorized" : "no live observation (--live not given)");

  return {
    scope: {
      kind,
      agent_id: agentId,
      domain: selectedDomain,
      live,
      label: bounded(parts.join(" · ")),
      total_registered_agents: totalRegisteredAgents,
      selected_agents: agentIds.length,
      selected_domains: domains,
      baseline: nonEmptyString(options.baseline) !== null,
    },
    agentIds,
    domains,
  };
}

// ---------------------------------------------------------------------------
// Observation builders
// ---------------------------------------------------------------------------

/**
 * What an observation builder needs, and nothing more.
 *
 * EXPORTED because `observeFromInventory` and `observeFromProvenance` are: a
 * function exported with an unexported parameter type is uncallable from typed
 * code, which is exactly the half-exported surface DW-24 records.
 */
export interface FleetStatusContext {
  authority: FleetAuthorityIndex;
  live: boolean;
  observations: FleetStatusObservation[];
  findings: FleetStatusFinding[];
  probes: FleetProbeRecord[];
  droppedFindings: number;
  /** Rule ids already reported as unmapped, so one gap is one finding, not one per agent. */
  unmappedRules: Set<string>;
  /** Rule ids already reported as mapping outside `AUDIT_PER_AGENT_DOMAINS`. Same discipline. */
  unexpectedDomainRules: Set<string>;
  /** Provenance fact ids already reported as carrying no declared domain. Same discipline. */
  unmappedFacts: Set<string>;
  /** Host rule ids already reported as collected-but-not-reported under a domain filter. Same discipline. */
  unreportedHostRules: Set<string>;
  /** The contract's `health_policy`, indexed. The only thing that can justify a gap. */
  policy: FleetHealthPolicyView;
  /**
   * The run's reference instant, captured ONCE and never serialized.
   *
   * Freshness is emitted as a bucket, so two runs milliseconds apart bucket
   * identically. Reading the clock per observation would make a day boundary
   * fall between two observations of the same run, which is worse than either
   * answer.
   */
  referenceMs: number;
  /** `activation.execution_authority.field`, read from the contract, not spelled here. */
  activationField: string;
  /** `activation.execution_authority.owner`, read from the contract. */
  activationOwner: string;
  /** The authority owner each domain falls back to when no field path resolves one. */
  domainOwner(domain: FleetStatusDomain): string | null;
  /** Every policy-declared timestamp this run resolved for one agent, by field path. */
  freshnessFor(agentId: string): ReadonlyMap<string, string | null>;
  /** The repository a `pjangler migrate` invocation would name for one agent, home-redacted. */
  repoFor(agentId: string): string | null;
  /** The `intentionally_unmanaged` entry covering an identity conflict group, by group id. */
  exceptionFor(groupId: string): { id: string; reason: string } | null;
}

interface StatusFindingInput {
  code: string;
  domain: FleetStatusDomain;
  field: string;
  agent_id: string | null;
  source: string | null;
  severity: FleetFindingSeverity;
  detail: string;
  /**
   * What this finding is ABOUT, when the code alone does not identify it.
   *
   * MEASURED: forty unmapped rules all raise `audit-rule-unmapped` on the same
   * domain, the same field and no agent, so without a subject all forty hashed
   * to ONE `finding_id` -- and any consumer joining on that id would have
   * silently merged forty different gaps into one. The same defect story 1.4's
   * review found when two sources answered for one `(agent, domain, field)`.
   */
  subject?: string;
  /** Defaults to `agent` when an agent id is present, else `fleet`. */
  scope?: "fleet" | "agent" | "host";
  /** Defaults to the `FINDING_SEVERITY` mapping of `severity`. */
  statusSeverity?: FleetStatusSeverity;
  /** Whether this finding is one of the reasons the fleet cannot claim proof. */
  gating?: boolean;
}

/**
 * Record one finding. UNBOUNDED here, capped at emit, and the order matters.
 *
 * It used to drop past `FLEET_STATUS_MAX_FINDINGS` in ARRIVAL order, with the
 * sort running afterwards over whatever survived -- so "sorted before every
 * cap", which this file, the README and `compareStatusFindings`' own doc
 * comment all promise, was false one cap up. Contradictions are appended last,
 * so a fleet raising 2000 `audit-rule-unmapped` warns would have discarded
 * every `status-contradiction`: precisely the "one high-volume domain hides a
 * higher-priority blocker" failure the sort exists to prevent, moved from the
 * report to the payload.
 */
function addFinding(ctx: FleetStatusContext, input: StatusFindingInput): void {
  const scope = input.scope ?? (input.agent_id === null ? "fleet" : "agent");
  ctx.findings.push({
    code: input.code,
    field: input.field,
    agent_id: input.agent_id,
    source: input.source,
    severity: input.severity,
    detail: bounded(redactHome(input.detail)),
    domain: input.domain,
    scope,
    // The same stable-id idiom every observation uses, so a finding can be
    // joined across runs and across adapters exactly as an observation can.
    // `code` plus `subject` take the rule-id slot: the code says what KIND of
    // finding it is and the subject says which one.
    finding_id: statusFindingId(
      scope,
      input.agent_id,
      input.domain,
      input.subject ? `${input.code}:${input.subject}` : input.code,
      input.field,
      "finding",
    ),
    status_severity: input.statusSeverity ?? FINDING_SEVERITY[input.severity],
    gating: input.gating ?? input.severity === "error",
  });
}

interface ObservationInput {
  domain: FleetStatusDomain;
  agentId: string | null;
  state: FleetStatusState;
  field: string;
  summary: string;
  details?: readonly unknown[];
  source: string;
  ruleId?: string | null;
  owner?: string | null;
  ruleScope?: "project" | "host" | null;
  /** The live side, where the observation is about a value. */
  observed?: string | null;
  /** The recorded or declared side. Defaults to the domain's declared shape. */
  desired?: string | null;
  /** The `health_policy.deferred_capabilities` capability this answers for. */
  capability?: string | null;
  /** Overrides the source-derived evidence where the site knows better. */
  evidence?: FleetStatusEvidence | null;
  /** The audit rule's own `fixable`, verbatim. */
  fixable?: boolean | null;
  /** The contract exception entry covering this observation. */
  exceptionId?: string | null;
  exceptionReason?: string | null;
  /** The exception entry's own contract path, when it is not an `intentionally_unmanaged` ruling. */
  exceptionPolicy?: string | null;
  /** Typed per-asset items, for a scaffold group observation. Omitted from the record when empty. */
  items?: readonly FleetStatusObservationItem[];
  /**
   * The rule that can REPAIR this observation, where the observation did not
   * come from a rule.
   *
   * Deliberately separate from `ruleId`, and the separation is load-bearing.
   * `ruleId` is part of an observation's IDENTITY: it is hashed into
   * `finding_id` and it is the second key of the declared sort order. An
   * inventory observation that grew a rule id the moment it started failing
   * would change its own finding id between two runs -- and `--baseline` joins
   * transitions on exactly that id, so one state change would be reported as an
   * unrelated finding appearing and another resolving. Measured: the transition
   * case lost its `state_changed` entirely and reported `appeared, resolved`.
   *
   * So the repair rule rides beside the identity instead of inside it. It
   * reaches `deriveRepair`, which is the only thing that needed it, and the
   * record, the id and the order are byte-identical to what they were.
   */
  repairRule?: { id: string; scope: "project" | "host"; fixable: boolean } | null;
}

/**
 * The SINGLE construction point for every observation, on every path.
 *
 * Every axis story 1.5 adds is derived here, so a field cannot exist on one
 * path and not another -- which is the whole reason 1.4 funnelled every
 * observation through one function in the first place. `classifyObservation`
 * owns the derivations; this function owns resolving the inputs they read.
 */
function observation(ctx: FleetStatusContext, input: ObservationInput): FleetStatusObservation {
  const scope = input.agentId === null ? "fleet" : "agent";
  const field = bounded(input.field);
  const summary = bounded(redactHome(input.summary));
  const retrieval = retrievalFor(input.agentId, input.domain, ctx.live);
  const declaredOwner = input.owner !== undefined ? input.owner : ctx.authority.ownerOf(input.field);
  // Freshness attaches to the STORE READ, and only to it. The audit half of the
  // same domain has no recorded timestamp of its own, so giving it the store
  // read's bucket would count one stale reading twice -- and `health.stale` is
  // a count of readings, not of agents.
  const freshness = input.source === SOURCE_REGISTRY && input.agentId !== null
    ? evaluateDomainFreshness(input.domain, ctx.freshnessFor(input.agentId), ctx.referenceMs, ctx.policy)
    : "not_applicable";
  const classification = classifyObservation({
    domain: input.domain,
    state: input.state,
    field,
    ruleId: input.ruleId ?? input.repairRule?.id ?? null,
    ruleScope: input.ruleScope ?? input.repairRule?.scope ?? null,
    source: input.source,
    capability: input.capability ?? null,
    evidence: input.evidence ?? null,
    fixable: input.fixable ?? input.repairRule?.fixable ?? null,
    exceptionId: input.exceptionId ?? null,
    exceptionReason: input.exceptionReason ?? null,
    exceptionPolicy: input.exceptionPolicy ?? null,
    freshness,
    repo: input.agentId === null ? null : ctx.repoFor(input.agentId),
    retrieval,
    activationField: ctx.activationField,
    activationOwner: ctx.activationOwner,
  }, ctx.policy);
  // ABSENT, not empty, when there is nothing to itemize: a `pass` group carries
  // no `items` key at all, so a consumer can tell "nothing to report" from
  // "reported nothing" without counting.
  const items = input.items && input.items.length > 0 ? { items: [...input.items] } : {};
  return {
    domain: input.domain,
    agent_id: input.agentId,
    state: input.state,
    rule_id: input.ruleId ?? null,
    owner: declaredOwner ?? ctx.domainOwner(input.domain),
    rule_scope: input.ruleScope ?? null,
    field,
    summary,
    details: boundedDetails(input.details),
    finding_id: statusFindingId(scope, input.agentId, input.domain, input.ruleId ?? null, input.field, input.source),
    source: input.source,
    retrieval,
    applicability: classification.applicability,
    evidence: classification.evidence,
    freshness: classification.freshness,
    severity: classification.severity,
    repair: classification.repair,
    // Where the site supplied neither side, the live half is what this run
    // CONCLUDED and the recorded half is what the domain declares it should
    // conclude. Both are real statements and neither is a value nobody stores,
    // but the fallback pair IS close to a restatement of the summary -- see
    // `FleetStatusObservation.observed`, which says so rather than claiming a
    // comparison that is not always there.
    observed: bounded(redactHome(input.observed ?? summary)),
    desired: bounded(redactHome(input.desired ?? DOMAIN_DESIRED[input.domain])),
    next_action: classification.next_action,
    next_action_class: classification.next_action_class,
    justification: classification.justification,
    ...items,
  };
}

/**
 * The org rule that answers for this row's findings in one domain, plus how it
 * has to be reported so `deriveRepair` can offer a command.
 *
 * WITHOUT THIS, every inventory observation reached `deriveRepair` with
 * `rule_id: null`, fell past every branch, and was classified `manual` with the
 * read-only retrieval as its "next action" -- thirty-six findings telling an
 * operator to go and look at them again. The codes were always there; the join
 * to a rule was the missing half, and `FINDING_RULE_IDS` in `./inventory` is
 * that join.
 *
 * `rule_scope: "host"` because that is what the checks in
 * `src/parity/reconcile.ts` declare, verbatim: the two registries are machine
 * state, so a host scope keeps these findings out of any repository's verdict.
 * `fixable` is the recipe's own answer -- `ORG_REMEDIABLE_RULES` -- never a
 * guess made here, so a rule that stops being able to repair itself stops
 * advertising a repair in the same commit.
 */
function inventoryRule(row: FleetInventoryRow, domain: FleetStatusDomain, state: FleetStatusState): {
  repairRule: { id: string; scope: "host"; fixable: boolean } | null;
} {
  // A pass names no repair. Anything else is looked up by the codes the row
  // actually carries, so an observation can never advertise a repair for a
  // finding this row did not raise.
  if (state === "pass") return { repairRule: null };
  // A CONFLICT FIRST. A contested row usually also fails to correlate to a
  // project record, and the two rules land in the same domain -- offering to
  // register a project for a row whose real problem is that two agents claim it
  // would be the wrong repair, confidently.
  const codes = row.conflicts.length > 0 ? ["identity-conflict", ...row.findings] : row.findings;
  for (const code of codes) {
    const candidate = ruleIdForFindingCode(code);
    if (candidate && RULE_DOMAIN[candidate] === domain) {
      return { repairRule: { id: candidate, scope: "host", fixable: ORG_REMEDIABLE_RULES.has(candidate) } };
    }
  }
  return { repairRule: null };
}

/**
 * The five domains the two canonical registries can answer on their own.
 *
 * `registry`, `project_binding`, `profile`, `runtime` and `bloodbank` all read
 * off story 1.2's row -- which already carries per-field authority attribution,
 * `lstat`-based path classification, and the conflict groups this row
 * participates in. Nothing is re-derived here; the row IS the observation, and
 * this function only decides which state that row implies.
 *
 * `systemd` and `live_process` are handled beside it because their honest answer
 * is a declared gap, not a read.
 */
export function observeFromInventory(
  ctx: FleetStatusContext,
  row: FleetInventoryRow,
  domains: ReadonlySet<FleetStatusDomain>,
): FleetStatusObservation[] {
  const agentId = row.agent_id.value ?? "";
  const out: FleetStatusObservation[] = [];

  if (domains.has("registry")) {
    const field = "agents.{agent_id}";
    const details: string[] = [];
    let state: FleetStatusState = "pass";
    let summary = "the registry row is well formed and correlated to a project record";
    let observed = "well formed, in no conflict, correlated";
    // A conflict is a fact about the WHOLE registry, not about this row on its
    // own -- it is computed by comparing every claimant of one value. That is
    // exactly what `derived` means, and it is the only reading in this domain
    // that is not a direct read of the row in front of us.
    let evidence: FleetStatusEvidence | null = null;
    let exceptionId: string | null = null;
    let exceptionReason: string | null = null;
    if (row.malformed) {
      state = "fail";
      summary = "the registry row is malformed; it was salvaged rather than read";
      observed = "a malformed entry, salvaged";
    } else if (row.conflicts.length > 0) {
      details.push(...row.conflicts);
      observed = `${row.conflicts.length} identity conflict group(s): ${row.conflicts.join(", ")}`;
      // A conflict is a fact about the WHOLE registry, not about this row on
      // its own -- it is computed by comparing every claimant of one value.
      evidence = "derived";
      // An operator ruling recorded under `classifications.intentionally_unmanaged`
      // is what turns a conflict into an authorized one. EVERY group this row
      // is in must be covered: a permitted conflict must never absorb an
      // unruled third claimant standing beside it.
      const rulings = row.conflicts.map((groupId) => ctx.exceptionFor(groupId));
      const allPermitted = rulings.length > 0 && rulings.every((ruling) => ruling !== null);
      if (allPermitted) {
        exceptionId = rulings.map((ruling) => ruling!.id).join(", ");
        exceptionReason = rulings[0]!.reason;
      }
      // PERMISSION DECIDES THE STATE, not just the severity. `fleet inventory`
      // counts only UNPERMITTED groups into its aggregate, so a fleet it calls
      // healthy read `verdict: "unhealthy"` here -- two commands over one
      // registry disagreeing about whether an operator's ruling counts, which
      // makes the ruling worthless in exactly the command that acts on it.
      //
      // A permitted conflict is still REPORTED and still visible: `warn`, with
      // the ruling attached as its justification, so it is authorized rather
      // than silent. It is not `pass`, because two agents sharing one value is
      // a thing an operator should keep seeing after they decide to allow it.
      state = allPermitted ? "warn" : "fail";
      summary = allPermitted
        ? `this row participates in ${row.conflicts.length} identity conflict group(s), all permitted by the contract`
        : `this row participates in ${row.conflicts.length} identity conflict group(s)`;
    } else if (row.correlation.state !== "resolved") {
      state = "warn";
      summary = "the row is not correlated to a project-registry record";
      details.push(`correlation is ${row.correlation.state}`);
      observed = `correlation is ${row.correlation.state}`;
    }
    if (row.findings.length) details.push(`row findings: ${row.findings.join(", ")}`);
    out.push(observation(ctx, {
      domain: "registry", agentId, state, field, summary, details, source: SOURCE_REGISTRY,
      observed, evidence, exceptionId, exceptionReason,
      ...inventoryRule(row, "registry", state),
    }));
  }

  if (domains.has("project_binding")) {
    const field = "agents.{agent_id}.plane.identifier";
    const details: string[] = [];
    let state: FleetStatusState = "pass";
    let summary = "the row carries a board binding the repository manifest agrees with";
    if (row.board.value === null) {
      state = "warn";
      summary = "the row stores no board binding";
    } else if (row.manifest.agrees === false) {
      state = "warn";
      summary = ".project.json contradicts the registries; it is evidence, never a tiebreaker";
      details.push(...row.manifest.notes);
    } else if (row.project_id.state !== "resolved") {
      state = "warn";
      summary = `the row's project identity is ${row.project_id.state}`;
    }
    const binding = row.board.value
      ? `workspace=${row.board.value.workspace ?? "-"} board=${row.board.value.project_id ?? "-"} identifier=${row.board.value.identifier ?? "-"}`
      : "no board binding recorded";
    if (row.board.value) details.push(binding);
    out.push(observation(ctx, {
      domain: "project_binding", agentId, state, field, summary, details, source: SOURCE_REGISTRY,
      observed: binding,
      ...inventoryRule(row, "project_binding", state),
      // The manifest comparison is DERIVED: it is a disagreement between two
      // readings rather than a reading of its own.
      evidence: row.manifest.agrees === false ? "derived" : null,
    }));
  }

  if (domains.has("profile")) {
    const field = DOMAIN_FIELD.profile;
    const view = row.paths.profile_path;
    const details: string[] = [];
    let state: FleetStatusState = "pass";
    let summary = `profile ${row.profile_name.value ?? "-"} resolves to a real directory`;
    if (row.profile_name.value === null) {
      state = "warn";
      summary = "the row names no profile";
    } else if (view?.classification === "symlink") {
      state = "fail";
      summary = `the profile directory is a symlink, and the contract declares service_model.profile_layout.symlink_allowed: false`;
      details.push(`-> ${view.link_target ?? "an unreadable target"}`);
    } else if (row.profile_path.state !== "resolved") {
      state = "warn";
      summary = `the profile directory is ${view?.classification ?? "undeclared"}`;
    }
    if (view?.declared) details.push(view.declared);
    out.push(observation(ctx, {
      domain: "profile", agentId, state, field, summary, details, source: SOURCE_REGISTRY,
      observed: `${row.profile_name.value ?? "no profile named"} at ${view?.declared ?? "an undeclared path"} (${view?.classification ?? "undeclared"})`,
      ...inventoryRule(row, "profile", state),
    }));
  }

  if (domains.has("runtime")) {
    // Attributed to `role_dir`, which is the field the runtime path is DERIVED
    // from -- the registry records no runtime path of its own, and attributing
    // it to a field nobody writes would name the wrong repair.
    const field = "agents.{agent_id}.role_dir";
    const view = row.paths.runtime_path;
    const details: string[] = [];
    let state: FleetStatusState = "pass";
    let summary = "the role-local runtime directory is present and is a real directory";
    if (row.role_dir.value === null) {
      state = "warn";
      summary = "the row declares no role_dir, so no runtime directory can be derived";
    } else if (row.runtime_path.state !== "resolved") {
      state = "warn";
      summary = `the expected runtime directory is ${view?.classification ?? "undeclared"}`;
    }
    if (view?.declared) details.push(view.declared);
    out.push(observation(ctx, {
      domain: "runtime", agentId, state, field, summary, details, source: SOURCE_REGISTRY,
      observed: `${view?.declared ?? "no runtime directory derived"} (${view?.classification ?? "undeclared"})`,
      ...inventoryRule(row, "runtime", state),
    }));
  }

  if (domains.has("bloodbank")) {
    const field = "agents.{agent_id}.bloodbank.gateway_scope";
    const details = [
      `gateway_scope=${row.bloodbank_scope.value ?? "-"}`,
      `target_agent_id=${row.bloodbank_target.value ?? "-"}`,
      `${row.activation_field.value ?? "activation"}=${row.activation.value === true ? "true" : row.activation.value === false ? "false" : "unresolved"}`,
    ];
    let state: FleetStatusState = "pass";
    let summary = "the row records a fleet-scoped Bloodbank routing target";
    if (row.bloodbank_scope.value === null || row.bloodbank_target.value === null) {
      state = "warn";
      summary = "the row records an incomplete Bloodbank routing record";
    }
    out.push(observation(ctx, {
      domain: "bloodbank", agentId, state, field, summary, details, source: SOURCE_REGISTRY,
      observed: `gateway_scope=${row.bloodbank_scope.value ?? "-"} target_agent_id=${row.bloodbank_target.value ?? "-"}`,
      desired: "a fleet-scoped routing record naming this agent as its target",
      // DECLARED, not direct. The row ASSERTS a routing target; nothing in this
      // run read the shared gateway to see whether it can reach one. That
      // distinction is what stops a registry field from ever setting
      // `capability_readiness: "ready"`.
      evidence: "declared",
    }));
    // The EXECUTION AUTHORITY, as its own observation on its own field.
    //
    // Held apart from the routing record above because the contract holds them
    // apart: `activation.execution_authority` is a separate authority block
    // with `strict: true, default: deny`, and folding the flag into the record
    // is how "we can resolve a target" becomes "we may dispatch to it". It is
    // also what makes the `approval-gated` repair class reachable -- the class
    // is derived from the FIELD matching the contract's gate, not from a
    // keyword in a summary.
    out.push(observation(ctx, {
      domain: "bloodbank", agentId,
      state: row.activation.value === null ? "warn" : "pass",
      field: ctx.activationField,
      summary: row.activation.value === null
        ? "the strict activation flag is absent or not a boolean; the contract's declared default is deny"
        : `execution authority is ${row.activation.value ? "granted" : "denied"} by the strict flag the contract declares`,
      details: [`${row.activation_field.value ?? ctx.activationField} owned by ${ctx.activationOwner}, strict, default deny`],
      source: SOURCE_REGISTRY,
      observed: row.activation.value === null ? "absent or not a boolean" : row.activation.value ? "true" : "false",
      desired: "an explicit boolean, written only by the declared execution-authority owner",
      evidence: "declared",
    }));
    // Liveness is a SECOND observation, not a modifier on the record above: the
    // record is observed and the liveness is not, and folding them would let a
    // read of the registry pass for a read of the bus. Story 1.10 owns it.
    //
    // `unsupported`, not `unobserved`: nothing in this build can observe routing
    // readiness at all, so it is a gap in the RELEASE rather than a gap in this
    // run. Calling it `unobserved` would hold `health.complete` false forever
    // and make the flag meaningless.
    out.push(observation(ctx, {
      domain: "bloodbank", agentId, state: "unsupported",
      field: "gateways.bloodbank.command_subject",
      summary: "no Bloodbank liveness observer exists in this release; routing readiness is story 1.10",
      details: ["the routing RECORD above is observed; whether the shared gateway can dispatch to it is not"],
      source: SOURCE_DECLARED_GAP,
      // The capability the CONTRACT authorizes, by name. Remove the
      // `health_policy.deferred_capabilities` entry and this observation is
      // unchanged, unjustified, and counted against `proven` -- which is the
      // difference between a gap somebody signed off and a gap that authorized
      // itself.
      capability: CAPABILITY_BLOODBANK_LIVENESS,
      observed: "not observed",
      desired: "the fleet-shared gateway proven able to dispatch to this target",
    }));
  }

  if (domains.has("live_process")) {
    out.push(observation(ctx, {
      domain: "live_process", agentId, state: "unsupported",
      field: "processes.{agent_id}",
      summary: "no live-process observer exists in this release",
      details: ["there is no ps, pgrep, or /proc read anywhere in this build; process attribution is story 1.9"],
      source: SOURCE_DECLARED_GAP,
      capability: CAPABILITY_LIVE_PROCESS,
      observed: "not observed",
      desired: "every running Hermes process attributed to a registry row",
    }));
  }

  return out;
}

/**
 * The domains the provenance core answers per agent.
 *
 * `release_provenance` is every per-agent provenance fact -- which executable,
 * which checkout, which remote, which HEAD, whether it is clean -- carried
 * across with its own status rather than recomputed. `template_scaffold` used
 * to receive one permanent per-agent `unsupported` here (`scaffold.template_ref`);
 * story 1.6's scaffold observer answers that domain with real observations, so
 * the provenance core now feeds it FLEET-scoped facts only (the gitlink, the
 * remote, the worktree's cleanliness) and no per-agent placeholder is emitted
 * for it -- one would sit as an `unobserved` beside eight real observations.
 */
export function observeFromProvenance(
  ctx: FleetStatusContext,
  facts: readonly FleetProvenanceFact[],
  agentId: string,
  domains: ReadonlySet<FleetStatusDomain>,
): FleetStatusObservation[] {
  const out: FleetStatusObservation[] = [];
  const byDomain = new Map<FleetStatusDomain, number>();

  for (const fact of facts) {
    if (fact.agent_id !== agentId) continue;
    const { domain } = classifyFact(ctx, fact);
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
    if (!domains.has(domain)) continue;
    out.push(factObservation(ctx, fact, domain, agentId));
  }

  // A domain the provenance core answered NOTHING for is `unobserved`, not
  // absent: the domain must appear on every record even when the source that
  // feeds it returned no fact at all. `template_scaffold` is deliberately not in
  // this list any more -- the scaffold observer owns that domain's per-agent
  // record, and a placeholder here would land beside its real observations.
  for (const domain of ["release_provenance"] as const) {
    if (!domains.has(domain) || (byDomain.get(domain) ?? 0) > 0) continue;
    out.push(observation(ctx, {
      domain, agentId, state: "unobserved",
      field: DOMAIN_FIELD[domain],
      summary: "the provenance core reported no release fact for this agent",
      source: SOURCE_PROVENANCE,
      observed: "no fact",
      desired: "at least one release provenance fact for this agent",
    }));
  }

  return out;
}

// ---------------------------------------------------------------------------
// The scaffold observer's observations (story 1.6)
// ---------------------------------------------------------------------------

/** What `observeFromScaffold` needs beyond the context. */
interface ScaffoldObservationInput {
  agentId: string;
  /** The observer's result for this agent, or undefined when it never ran. */
  result: FleetScaffoldAgentResult | undefined;
  /** Whether the contract declares a `scaffold_manifest` at all. */
  manifestDeclared: boolean;
  /** The committed gitlink the comparison ran against, 40-hex, or null. */
  gitlink: string | null;
  /** The `health_policy.agent_exceptions` ruling for this agent in this domain, if any. */
  exception: { path: string; reason: string } | null;
  /** Where item and overlap clips are recorded. The caller adds them to `truncated` if the record is emitted. */
  notes: string[];
}

/**
 * Eight observations per agent, one per declared `scaffold.*` leaf.
 *
 * ON THE LEAVES, not on `scaffold`. The twelve recipe rules in this domain all
 * sit on field `scaffold` (`DOMAIN_FIELD.template_scaffold`), and
 * `detectContradictions` joins on `(agent, domain, field)` -- so an observer
 * `fail` on `scaffold` beside a rule `pass` on `scaffold` would manufacture a
 * contradiction out of two true readings of different things (DW-75). Each
 * leaf is a contract-declared writable field, so `authority.ownerOf` resolves
 * `hermes-agent-template` directly rather than by namespace walk-up (DW-50),
 * and the eight leaves the contract invented in story 1.1 become real (DW-10).
 *
 * One observation per GROUP rather than per agent or per asset: per agent
 * would need a second "coverage" observation to keep `complete` honest when
 * drift and an incomplete asset coexist; per asset would make `by_state` count
 * files, not agents. Counts stay per group; the typed items ride on it.
 */
function observeFromScaffold(ctx: FleetStatusContext, input: ScaffoldObservationInput): {
  observations: FleetStatusObservation[];
  summary: FleetStatusAgentScaffold | null;
} {
  const { agentId, result } = input;
  if (!input.manifestDeclared) {
    return {
      observations: [observation(ctx, {
        domain: "template_scaffold", agentId, state: "unsupported",
        field: DOMAIN_FIELD.template_scaffold,
        summary: "the fleet contract declares no scaffold_manifest, so no role directory can be compared against the pinned template",
        details: ["declare scaffold_manifest in the fleet contract (schema 3) to make this domain observable"],
        source: SOURCE_SCAFFOLD,
        capability: CAPABILITY_SCAFFOLD_MANIFEST,
        observed: "not observed",
        desired: "every owned asset compared against the template at the committed gitlink",
      })],
      summary: null,
    };
  }
  if (result === undefined) {
    return {
      observations: [observation(ctx, {
        domain: "template_scaffold", agentId, state: "unobserved",
        field: DOMAIN_FIELD.template_scaffold,
        summary: "the scaffold observer produced no result for this agent",
        source: SOURCE_SCAFFOLD,
        observed: "no result",
        desired: "eight group observations for this agent",
      })],
      summary: null,
    };
  }

  const short = input.gitlink === null ? null : input.gitlink.slice(0, 12);
  const desiredSuffix = short === null ? "at the committed gitlink" : `at gitlink ${short}`;
  const observations: FleetStatusObservation[] = [];
  for (const group of result.groups) {
    const items: FleetStatusObservationItem[] = group.items.map((item) => ({
      path: bounded(item.path),
      kind: item.kind,
      desired: item.desired === null ? null : bounded(item.desired, 64),
      observed: item.observed === null ? null : bounded(item.observed, 64),
      detail: item.detail === null ? null : bounded(item.detail),
      wip: item.wip,
    }));
    const kept = items.slice(0, FLEET_STATUS_MAX_ITEMS);
    if (items.length > kept.length) {
      input.notes.push(
        `agents.${agentId}.observations[${group.group}].items: ${items.length - kept.length} of ${items.length} items dropped; `
        + "the counts on this observation and on agents[].scaffold.assets are computed over every item before the cap",
      );
    }
    const details = kept.map((item) => {
      const pair = item.desired !== null || item.observed !== null ? ` ${item.desired ?? "-"} -> ${item.observed ?? "-"}` : "";
      return `${item.kind} ${item.path}${pair}${item.detail ? ` (${item.detail})` : ""}${item.wip ? " [wip]" : ""}`;
    });
    const summary = group.state === "pass"
      ? `${group.owned} owned asset(s) in ${group.role_path} match the template ${desiredSuffix}`
      : group.state === "fail"
        ? `${group.drifted} drifted, ${group.unexpected} unexpected and ${group.incomplete} undecided asset(s) in ${group.role_path}`
        : `${group.incomplete} asset(s) in ${group.role_path} could not be compared`;
    // An operator ruling covers DRIFT, never a collection error: an exception
    // is a decision about the fleet, and an `error` is this run failing to read
    // it, which no ruling can excuse.
    const excepted = group.state === "fail" && input.exception !== null;
    observations.push(observation(ctx, {
      domain: "template_scaffold", agentId, state: group.state,
      field: group.group,
      ruleId: null,
      ruleScope: "project",
      fixable: false,
      source: SOURCE_SCAFFOLD,
      summary,
      details,
      observed: `${group.matching}/${group.owned} assets match`,
      desired: `every asset in ${group.group} ${desiredSuffix}`,
      items: kept,
      exceptionId: excepted ? agentId : null,
      exceptionReason: excepted ? input.exception!.reason : null,
      exceptionPolicy: excepted ? input.exception!.path : null,
    }));
  }

  const overlap = result.wipOverlap.slice(0, FLEET_STATUS_MAX_WIP_OVERLAP).map((path) => bounded(path));
  if (result.wipOverlap.length > overlap.length) {
    input.notes.push(`agents.${agentId}.scaffold.wip_overlap: ${result.wipOverlap.length - overlap.length} of ${result.wipOverlap.length} paths dropped`);
  }
  return {
    observations,
    summary: {
      source_gitlink: input.gitlink,
      role_dir: result.roleDir === null ? null : shownPath(result.roleDir),
      role_dir_source: result.roleDirSource,
      assets: { ...result.assets },
      wip_overlap: overlap,
      wip_preserved: result.wipPreserved,
      foreign_tracked: result.foreignTracked,
      ignored_entries: result.ignoredEntries,
    },
  };
}

/**
 * The `hermes.pm-scaffold` rule's verdict over the subset it and the observer
 * both cover, or null when it cannot be compared.
 *
 * A `fail` counts only when one of its detail lines is a missing/stale asset
 * outside the ignored runtime: the rule also fails for its own non-core checks
 * (a retired `.gitmodules` mapping, a profile inheriting nothing, a registry
 * entry missing), none of which the observer reads, and comparing those would
 * report a disagreement about a thing only one side looked at.
 */
function scaffoldRuleVerdict(rule: Record<string, unknown> | undefined): "pass" | "fail" | null {
  if (rule === undefined) return null;
  if (rule.status === "pass") return "pass";
  if (rule.status !== "fail") return null;
  const details = Array.isArray(rule.details) ? rule.details.filter((line): line is string => typeof line === "string") : [];
  return details.some((line) => /: (?:missing|stale) (?!.*\/runtime\/)/u.test(line)) ? "fail" : null;
}

// ---------------------------------------------------------------------------
// The profile observer's observations (story 1.7)
// ---------------------------------------------------------------------------

/** What `observeFromProfile` needs beyond the context. */
interface ProfileObservationInput {
  agentId: string;
  /** The observer's result for this agent, or undefined when it never ran. */
  result: FleetProfileAgentResult | undefined;
  /** Whether the contract declares a `profile_manifest` at all. */
  manifestDeclared: boolean;
  /** The `health_policy.agent_exceptions` ruling for this agent in this domain, if any. */
  exception: { path: string; reason: string } | null;
  /** Where item clips are recorded. The caller adds them to `truncated` if the record is emitted. */
  notes: string[];
}

/**
 * Five observations per agent, on five `profiles.{profile_name}` leaves.
 *
 * Five fields, not one, and none shared with the inventory: the inventory's
 * profile observation sits on `agents.{agent_id}.profile_name`, so a path
 * `fail` here is never reported as a contradiction of its `lstat`;
 * `authority.ownerOf` answers for every leaf (the renderer for the generated
 * config, the template for the three provisioned leaves, the renderer by
 * namespace majority for the directory itself); and `by_state` counts agents
 * per aspect rather than files.
 */
function observeFromProfile(ctx: FleetStatusContext, input: ProfileObservationInput): {
  observations: FleetStatusObservation[];
  summary: FleetStatusAgentProfile | null;
} {
  const { agentId, result } = input;
  if (!input.manifestDeclared) {
    return {
      observations: [PROFILE_FIELD_PATH, PROFILE_FIELD_IDENTITY, PROFILE_FIELD_CONFIG, PROFILE_FIELD_BANK, PROFILE_FIELD_SKILLS].map((field) => observation(ctx, {
        domain: "profile", agentId, state: "unsupported",
        field,
        summary: "the fleet contract declares no profile_manifest, so no generated profile can be proven against the canonical renderer",
        details: ["declare profile_manifest in the fleet contract (schema 4) to make this domain observable"],
        source: SOURCE_PROFILE,
        capability: CAPABILITY_PROFILE_MANIFEST,
        observed: "not observed",
        desired: "the profile gated, read, and proven through the canonical renderer's check",
      })),
      summary: null,
    };
  }
  if (result === undefined) {
    // Unreachable when the observer ran over the selected agents, and kept
    // honest anyway: five `unobserved` leaves, never one, so a consumer that
    // counts agents per aspect still sees the five declared fields.
    return {
      observations: [PROFILE_FIELD_PATH, PROFILE_FIELD_IDENTITY, PROFILE_FIELD_CONFIG, PROFILE_FIELD_BANK, PROFILE_FIELD_SKILLS].map((field) => observation(ctx, {
        domain: "profile", agentId, state: "unobserved",
        field,
        summary: "the profile observer produced no result for this agent",
        source: SOURCE_PROFILE,
        observed: "no result",
        desired: "five profile observations for this agent",
      })),
      summary: null,
    };
  }

  const observations: FleetStatusObservation[] = [];
  const emit = (field: string, aspect: { state: FleetStatusState; items: ReadonlyArray<{ path: string; kind: FleetStatusObservationItem["kind"]; desired: string | null; observed: string | null; detail: string | null }>; observed: string; desired: string; summary: string }): void => {
    const items: FleetStatusObservationItem[] = aspect.items.map((item) => ({
      path: bounded(item.path),
      kind: item.kind,
      desired: item.desired === null ? null : bounded(item.desired, 64),
      observed: item.observed === null ? null : bounded(item.observed, 64),
      detail: item.detail === null ? null : bounded(item.detail),
      wip: false,
    }));
    const kept = items.slice(0, FLEET_STATUS_MAX_ITEMS);
    if (items.length > kept.length) {
      input.notes.push(
        `agents.${agentId}.observations[${field}].items: ${items.length - kept.length} of ${items.length} items dropped; `
        + "the counts on this observation and on agents[].profile are computed over every item before the cap",
      );
    }
    const details = kept.map((item) => {
      const pair = item.desired !== null || item.observed !== null ? ` ${item.desired ?? "-"} -> ${item.observed ?? "-"}` : "";
      return `${item.kind} ${item.path}${pair}${item.detail ? ` (${item.detail})` : ""}`;
    });
    // An operator ruling covers DRIFT, never a collection error and never an
    // unread field: an exception is a decision about the fleet, and an error
    // is this run failing to read it, which no ruling can excuse.
    const excepted = aspect.state === "fail" && input.exception !== null;
    observations.push(observation(ctx, {
      domain: "profile", agentId, state: aspect.state,
      field,
      ruleId: null,
      ruleScope: "project",
      fixable: false,
      source: SOURCE_PROFILE,
      summary: aspect.summary,
      details,
      observed: aspect.observed,
      desired: aspect.desired,
      items: kept,
      exceptionId: excepted ? agentId : null,
      exceptionReason: excepted ? input.exception!.reason : null,
      exceptionPolicy: excepted ? input.exception!.path : null,
    }));
  };
  emit(PROFILE_FIELD_PATH, result.path);
  emit(PROFILE_FIELD_IDENTITY, result.identity);
  emit(PROFILE_FIELD_CONFIG, result.config);
  emit(PROFILE_FIELD_BANK, result.bank);
  emit(PROFILE_FIELD_SKILLS, result.skills);

  return {
    observations,
    summary: {
      profile_name: result.profileName,
      path: { state: result.path.state, code: result.path.code },
      identity: { state: result.identity.state, keys: result.identity.keys.map((key) => bounded(key, 64)) },
      renderer: { state: result.config.renderer.state, sections: result.config.renderer.sections.map((section) => bounded(section, 64)) },
      digests: { ...result.config.digests },
      bank: {
        observed: result.bank.bankId === null ? null : bounded(result.bank.bankId, 64),
        expected: result.bank.expectedBank === null ? null : bounded(result.bank.expectedBank, 64),
        state: result.bank.state,
        code: result.bank.code === null ? null : bounded(result.bank.code, 64),
      },
      skills: {
        state: result.skills.state,
        core_present: result.skills.corePresent,
        core_missing: result.skills.coreMissing.map((skill) => bounded(skill, 64)),
        extra: result.skills.extra.map((skill) => bounded(skill, 64)),
        sources_unresolvable: result.skills.sourcesUnresolvable,
      },
    },
  };
}


// ---------------------------------------------------------------------------
// The systemd observer's five leaves (story 1.8)
// ---------------------------------------------------------------------------

interface SystemdObservationInput {
  agentId: string;
  result: FleetSystemdAgentResult | undefined;
  /** False when the contract declares no `service_manifest`. */
  manifestDeclared: boolean;
  exception: { path: string; reason: string } | null;
  /** Where item clips are recorded. The caller adds them to `truncated` if the record is emitted. */
  notes: string[];
}

/**
 * Five observations per agent: two registry leaves and three unit leaves.
 *
 * Five fields, not one, and all five declared writable under the contract's
 * `systemd_lifecycle` authority -- so `ownerOf` answers for each, a topology
 * `fail` never contradicts the inventory (which sits on `profile_name` and
 * `expected_units`), and `by_state` counts agents per aspect rather than units.
 */
function observeFromSystemd(ctx: FleetStatusContext, input: SystemdObservationInput): {
  observations: FleetStatusObservation[];
  summary: FleetStatusAgentSystemd | null;
} {
  const { agentId, result } = input;
  if (!input.manifestDeclared) {
    return {
      observations: SYSTEMD_FIELDS.map((field) => observation(ctx, {
        domain: "systemd", agentId, state: "unsupported",
        field,
        summary: "the fleet contract declares no service_manifest, so no canonical service state can be proven against the user manager",
        details: ["declare service_manifest in the fleet contract (schema 5) to make this domain observable"],
        source: SOURCE_SYSTEMD,
        capability: CAPABILITY_SYSTEMD_MANIFEST,
        observed: "not observed",
        desired: "the canonical unit set sampled from the user manager and proven against the row's own declaration",
      })),
      summary: null,
    };
  }
  if (result === undefined) {
    // Unreachable when the observer ran over the selected agents, and kept
    // honest anyway: five `unobserved` leaves, never one, so a consumer that
    // counts agents per aspect still sees the five declared fields.
    return {
      observations: SYSTEMD_FIELDS.map((field) => observation(ctx, {
        domain: "systemd", agentId, state: "unobserved",
        field,
        summary: "the systemd observer produced no result for this agent",
        source: SOURCE_SYSTEMD,
        observed: "no result",
        desired: "five systemd observations for this agent",
      })),
      summary: null,
    };
  }

  const observations: FleetStatusObservation[] = [];
  const emit = (field: string, aspect: { state: FleetStatusState; items: ReadonlyArray<{ path: string; kind: FleetStatusObservationItem["kind"]; desired: string | null; observed: string | null; detail: string | null }>; observed: string; desired: string; summary: string }): void => {
    const items: FleetStatusObservationItem[] = aspect.items.map((item) => ({
      path: bounded(item.path),
      kind: item.kind,
      desired: item.desired === null ? null : bounded(item.desired, 64),
      observed: item.observed === null ? null : bounded(item.observed, 64),
      detail: item.detail === null ? null : bounded(item.detail),
      wip: false,
    }));
    const kept = items.slice(0, FLEET_STATUS_MAX_ITEMS);
    if (items.length > kept.length) {
      input.notes.push(
        `agents.${agentId}.observations[${field}].items: ${items.length - kept.length} of ${items.length} items dropped; `
        + "the counts on this observation and on agents[].systemd are computed over every item before the cap",
      );
    }
    const details = kept.map((item) => {
      const pair = item.desired !== null || item.observed !== null ? ` ${item.desired ?? "-"} -> ${item.observed ?? "-"}` : "";
      return `${item.kind} ${item.path}${pair}${item.detail ? ` (${item.detail})` : ""}`;
    });
    // An operator ruling covers DRIFT, never a collection error and never an
    // unread leaf: an exception is a decision about the fleet, and an error is
    // this run failing to read it, which no ruling can excuse.
    const excepted = aspect.state === "fail" && input.exception !== null;
    observations.push(observation(ctx, {
      domain: "systemd", agentId, state: aspect.state,
      field,
      ruleId: null,
      ruleScope: "project",
      fixable: false,
      source: SOURCE_SYSTEMD,
      summary: aspect.summary,
      details,
      observed: aspect.observed,
      desired: aspect.desired,
      items: kept,
      exceptionId: excepted ? agentId : null,
      exceptionReason: excepted ? input.exception!.reason : null,
      exceptionPolicy: excepted ? input.exception!.path : null,
    }));
  };
  emit(SYSTEMD_FIELD_TOPOLOGY, result.topology);
  emit(SYSTEMD_FIELD_HEARTBEAT_TIMER_ROW, result.heartbeatTimerRow);
  emit(SYSTEMD_FIELD_GATEWAY, result.gateway);
  emit(SYSTEMD_FIELD_TIMER, result.timer);
  emit(SYSTEMD_FIELD_SERVICE, result.service);

  // The two heartbeat leaves roll into ONE `heartbeat` reading on the summary:
  // the timer and the oneshot are two halves of one tick, and an operator
  // reading "the heartbeat is fine" over a timer that fires into a failing
  // service would have been told the opposite of the truth.
  // The WORSE leaf decides both the state and the code. Reading the oneshot's
  // code beside the timer's state would name the wrong half: a heartbeat that
  // is `fail` because its timer is disabled must not be summarised by the
  // oneshot's warning.
  const heartbeatLeaves = [result.service, result.timer];
  const worseHeartbeat = heartbeatLeaves
    .reduce((worst, leaf) => (stateRank(leaf.state) < stateRank(worst.state) ? leaf : worst), heartbeatLeaves[0]!);
  const heartbeatState = worseHeartbeat.state;
  // The code comes from the leaf's OWN `code`, which names the item whose rank
  // equals that leaf's state -- the item that caused the verdict, not whichever
  // one happened to be pushed first.
  const codeSource = worseHeartbeat.items.length > 0 ? worseHeartbeat : heartbeatLeaves.find((leaf) => leaf.items.length > 0);
  const heartbeatCode = codeSource === undefined ? null : codeSource.code;

  return {
    observations,
    summary: {
      topology: {
        expected: result.topology.expected.map((unit) => bounded(unit, 128)),
        installed: result.topology.installed.map((unit) => bounded(unit, 128)),
        missing: result.topology.missing.map((unit) => bounded(unit, 128)),
        extra: result.topology.extra.map((item) => ({ unit: bounded(item.unit, 128), class: item.class })),
        state: result.topology.state,
      },
      capability: {
        declared: result.capability.declared,
        platforms: { ...result.capability.platforms },
        delta_disabled: Object.fromEntries(
          Object.entries(result.capability.deltaDisabled).map(([platform, value]) => [platform, value === null ? null : !value]),
        ),
      },
      gateway: {
        ...result.gateway.view,
        state: result.gateway.state,
        code: result.gateway.code === null ? null : bounded(result.gateway.code, 64),
        result: result.gateway.result,
        exec_status: result.gateway.execStatus,
        restarts: result.gateway.restarts,
        entrypoint: { ...result.gateway.entrypoint },
        home: result.gateway.home,
        stability: {
          samples: result.gateway.stability.samples,
          stable: result.gateway.stability.stable,
          transitions: result.gateway.stability.transitions.map((line) => bounded(line, 128)),
        },
      },
      heartbeat: {
        state: heartbeatState,
        code: heartbeatCode === null ? null : bounded(heartbeatCode, 64),
        timer: { ...result.timer.view, paired: result.timer.paired },
        service: {
          ...result.service.view,
          result: result.service.result,
          exec_status: result.service.execStatus,
          entrypoint: { ...result.service.entrypoint },
        },
        schedule: result.timer.schedule,
        latest_result: result.service.latestResult,
        tick: result.timer.tick,
        reconcile: { ...result.service.reconcile },
      },
    },
  };
}

/**
 * The `systemd.sentinel` rule's verdict over the subset it and the systemd
 * observer both read, or null when it cannot be compared.
 *
 * A `fail` counts only when one of its detail lines is one of the three
 * enablement / activity / presence checks: the rule reads nothing else, so a
 * failure for another reason is not a reading to hold against an observer that
 * never looked there.
 */
function systemdRuleVerdict(rule: Record<string, unknown> | undefined): "pass" | "fail" | null {
  if (rule === undefined) return null;
  if (rule.status === "pass") return "pass";
  if (rule.status !== "fail") return null;
  const details = Array.isArray(rule.details) ? rule.details.filter((line): line is string => typeof line === "string") : [];
  return details.some((line) => SYSTEMD_RULE_DETAIL_PATTERNS.some((pattern) => pattern.test(line))) ? "fail" : null;
}

/** The `hermes.registry-parity` rule's verdict over the retired-unit / retired-key subset it shares with the observer. */
function systemdParityVerdict(rule: Record<string, unknown> | undefined): "pass" | "fail" | null {
  if (rule === undefined) return null;
  if (rule.status === "pass") return "pass";
  if (rule.status !== "fail") return null;
  const details = Array.isArray(rule.details) ? rule.details.filter((line): line is string => typeof line === "string") : [];
  return details.some((line) => SYSTEMD_PARITY_DETAIL_PATTERNS.some((pattern) => pattern.test(line))) ? "fail" : null;
}

/**
 * Whether the systemd observer found drift the two rules would also have seen.
 * Null when the shared subset was not fully read.
 *
 * A leaf the observer could not collect is a partial reading and is never held
 * against a rule. Drift outside the shared subset -- an unstable window, a
 * crash loop, an undeclared channel, an off-policy schedule, an overdue or
 * failed tick, an unpinned entrypoint -- is coverage neither rule ever had, so
 * it is `not_compared` rather than a disagreement in either direction.
 */
function systemdObserverDrift(result: FleetSystemdAgentResult | undefined): boolean | null {
  if (result === undefined) return null;
  const leaves = [result.topology, result.heartbeatTimerRow, result.gateway, result.timer, result.service];
  if (leaves.some((leaf) => leaf.state === "error")) return null;
  const covered = leaves.some((leaf) => leaf.items.some((item) => SYSTEMD_RULE_COVERED_KINDS.has(item.kind)));
  if (covered) return true;
  const uncovered = leaves.some((leaf) => leaf.state === "fail" || leaf.state === "warn");
  return uncovered ? null : false;
}

/**
 * The `hermes.runtime-singleton` rule's verdict over the subset it and the
 * profile observer both read, or null when it cannot be compared.
 *
 * A `fail` counts only when one of its detail lines is one of the profile
 * checks: the rule also fails for its singleton-link and shared-seed checks,
 * which the observer does not read the same way, and comparing those would
 * report a disagreement about a thing only one side looked at.
 */
function profileRuleVerdict(rule: Record<string, unknown> | undefined): "pass" | "fail" | null {
  if (rule === undefined) return null;
  if (rule.status === "pass") return "pass";
  if (rule.status !== "fail") return null;
  const details = Array.isArray(rule.details) ? rule.details.filter((line): line is string => typeof line === "string") : [];
  return details.some((line) => PROFILE_RULE_DETAIL_PATTERNS.some((pattern) => pattern.test(line))) ? "fail" : null;
}

/**
 * Whether the profile observer found drift the rule would also have seen.
 * Null when the shared subset was not fully read.
 *
 * The PATH aspect is compared on its own, even when the four dependents are
 * `unobserved`: a missing profile directory is shared evidence. A lexical
 * profile alias may be accepted by the core while the explicit fleet policy
 * requires a real directory, so that gate is not compared. Other gates the
 * rule never checks (`name-unsafe`,
 * `case-collision`, `ambiguous`, `unnamed`, `unreadable`, a root error) is a
 * partial reading and is not compared.
 */
function profileObserverDrift(result: FleetProfileAgentResult | undefined): boolean | null {
  if (result === undefined) return null;
  if (result.path.state === "error") return null;
  const gateKinds = result.path.items.map((item) => item.kind);
  if (gateKinds.some((kind) => PROFILE_RULE_COVERED_GATE_KINDS.has(kind))) return true;
  if (result.path.items.some((item) => item.kind === "misowned-link")) return true;
  // The rule reads the two config files and the pin. An `error` or an
  // `unobserved` on either is a partial reading, and a verdict over a partial
  // reading is not one to hold the rule against.
  const shared = [result.config, result.bank];
  if (shared.some((aspect) => aspect.state === "error" || aspect.state === "unobserved")) return null;
  const subsetDrift = shared.some((aspect) => aspect.items.some((item) => PROFILE_RULE_COVERED_KINDS.has(item.kind)));
  if (subsetDrift) return true;
  // Drift the rule never reads -- semantic drift the renderer found, a
  // non-override-only delta, an identity-file defect, a skill-core defect, an
  // unverifiable link -- is not "no drift" either: a rule `pass` beside it is
  // coverage the rule never had, and holding the two against each other would
  // report agreement about a thing one side never looked at. Not compared.
  const otherDrift = result.identity.state === "fail" || result.skills.state === "fail" || result.path.state === "warn"
    || result.config.items.some((item) => item.kind === "semantic-drift" || item.kind === "delta-not-override-only");
  return otherDrift ? null : false;
}

/** Whether the observer found drift the rule would also have seen. Null when the comparison was incomplete. */
function scaffoldObserverDrift(result: FleetScaffoldAgentResult | undefined): boolean | null {
  if (result === undefined || result.error !== null) return null;
  // An `error` on a covered group means the observer could not decide there,
  // and a verdict over a partial reading is not one to hold the rule against.
  if (result.groups.some((group) => group.state === "error" && (RULE_COVERED_CONTENT_GROUPS.has(group.group) || group.owned > 0))) return null;
  for (const group of result.groups) {
    for (const item of group.items) {
      if (item.kind === "missing" && RULE_COVERED_PRESENCE_PATHS.has(item.path)) return true;
      if (RULE_COVERED_CONTENT_GROUPS.has(group.group) && RULE_COVERED_KINDS.has(item.kind)) return true;
    }
  }
  return false;
}

/** One provenance fact as one observation. Shared by the per-agent and fleet paths. */
function factObservation(
  ctx: FleetStatusContext,
  fact: FleetProvenanceFact,
  domain: FleetStatusDomain,
  agentId: string | null,
): FleetStatusObservation {
  return observation(ctx, {
    domain, agentId, state: provenanceState(fact.status),
    field: fact.field, owner: fact.owner,
    ruleId: fact.id,
    summary: fact.detail,
    details: [
      `desired ${fact.desired.value ?? "-"} (${fact.desired.source ?? "no source"}/${fact.desired.state})`,
      `observed ${fact.observed.value ?? "-"} (${fact.observed.source ?? "no source"}/${fact.observed.state})`,
    ],
    source: SOURCE_PROVENANCE,
    // The pair the provenance core already computed, carried across rather than
    // re-derived: one global rule, `desired` is the recorded/pinned side and
    // `observed` is the live one, and inventing a second shape for it here is
    // how the two halves start disagreeing about which is which.
    observed: fact.observed.value ?? `${fact.observed.state} (${fact.observed.source ?? "no source"})`,
    desired: fact.desired.value ?? `${fact.desired.state} (${fact.desired.source ?? "no source"})`,
    // A provenance `unsupported` is the SAME kind of statement the three
    // declared gaps make -- nothing on this host records a comparable value --
    // so it joins the policy on the fact id, and an undeclared one is
    // unjustified exactly as an undeclared declared-gap is.
    capability: fact.status === "unsupported" ? fact.id : null,
  });
}

/**
 * Which domain a fact belongs to, raising a finding the first time none does.
 *
 * The mirror of the `audit-rule-unmapped` guard. Without it a fact id a later
 * story adds -- `systemd.unit_state`, say -- would land under
 * `release_provenance` (or be dropped by a prefix filter) with nothing said, and
 * the suite's per-domain presence assertion would stay green because the
 * fallback `unobserved` observation fills the hole.
 */
function classifyFact(ctx: FleetStatusContext, fact: FleetProvenanceFact): { domain: FleetStatusDomain; mapped: boolean } {
  const resolved = factDomain(fact.id);
  if (!resolved.mapped && !ctx.unmappedFacts.has(fact.id)) {
    ctx.unmappedFacts.add(fact.id);
    addFinding(ctx, {
      code: "provenance-fact-unmapped",
      domain: resolved.domain,
      subject: fact.id,
      field: fact.field,
      agent_id: null,
      source: fact.owner,
      severity: "warn",
      detail: `the provenance fact ${fact.id} matches no prefix in FACT_PREFIX_DOMAIN; it is reported under ${UNMAPPED_FACT_DOMAIN} so it cannot disappear, and src/fleet/status.ts is where it should be classified`,
    });
  }
  return resolved;
}

/**
 * The four activation states, kept apart, for one agent.
 *
 * Discovery, installation, health, routing readiness and execution activation
 * are DISTINCT states, and every one of them is derived from a different fact:
 *
 *   desired_state        what the REGISTRY declares as the target for this row.
 *                        A statement of intent, never a claim about the agent.
 *   observed_state       the furthest state this run actually PROVED. It cannot
 *                        reach `routing_ready` or `activated` in this release,
 *                        because no observer for either exists -- which is the
 *                        whole of "success text, process presence, ticket state
 *                        or historical evidence never overrides current direct
 *                        observations", expressed as code rather than as prose.
 *   capability_readiness whether routing readiness was proven. Never `ready`
 *                        here: a `declared` registry field is not a direct
 *                        observation of the shared gateway.
 *   activation           the strict flag, read verbatim. The contract's
 *                        declared default is deny.
 */
export function agentLifecycle(
  row: FleetInventoryRow,
  own: readonly FleetStatusObservation[],
  /**
   * The domains this run SELECTED.
   *
   * Without it a `--domain registry` run reports every agent `discovered`,
   * because the profile tree that would prove `installed` was never read -- and
   * `capability_readiness` could never reach `blocked` because bloodbank was
   * not collected either. A collection filter would then be moving a conclusion
   * about the AGENT, which is the one thing a scope may not do.
   */
  domains: ReadonlySet<FleetStatusDomain>,
): FleetStatusLifecycle {
  const routingRecorded = row.bloodbank_scope.value !== null && row.bloodbank_target.value !== null;
  const profileNamed = row.profile_name.value !== null;

  const desired: FleetActivationState = row.activation.value === true
    ? "activated"
    : routingRecorded ? "routing_ready" : profileNamed ? "installed" : "discovered";

  // A DIRECT read is the only thing that can move `observed_state` past
  // `discovered`. The profile directory is `lstat`ed by the inventory, so
  // "installed" is proven by evidence rather than by the row saying so;
  // nothing beyond it is proven by anything in this release.
  const profileProven = own.some((item) => (
    item.domain === "profile" && item.source === SOURCE_REGISTRY && item.evidence === "direct" && item.state === "pass"
  ));
  const anyFailure = own.some((item) => item.state === "fail" || item.state === "error");
  const observed: FleetStatusLifecycleState = !domains.has("profile")
    ? "out_of_scope"
    : !profileProven ? "discovered" : anyFailure ? "installed" : "healthy";

  const readiness: FleetStatusReadiness = !domains.has("bloodbank")
    ? "out_of_scope"
    : !routingRecorded
      ? "not_applicable"
      : own.some((item) => item.domain === "bloodbank" && (item.state === "fail" || item.state === "error"))
        ? "blocked"
        : "unproven";

  return {
    desired_state: desired,
    observed_state: observed,
    capability_readiness: readiness,
    activation: row.activation.value === true ? "granted" : row.activation.value === false ? "denied" : "undeclared",
  };
}

// ---------------------------------------------------------------------------
// The recipe audit, as a bounded child
// ---------------------------------------------------------------------------

/**
 * Which built CLI the audit child runs.
 *
 * `PJ_FLEET_CLI_ENTRY` is the DOCUMENTED observation-injection seam, and it is
 * what makes this story's child-failure, child-timeout and cancellation cases
 * real subprocesses rather than mocks. Unset, the entry is this build's own
 * `dist/index.js`, resolved from the PACKAGE root (packages/flume-hr) rather
 * than the repo root -- both `dist/index.js` and `dist/mcp-server.js` live
 * there, so the CLI and MCP adapters resolve the same one regardless of cwd.
 *
 * A missing entry is a CATEGORIZED COLLECTION ERROR, never a crash and never a
 * silent skip: the caller gets `null` and reports every audit-fed domain
 * `unobserved` with reason `audit-cli-unavailable`.
 */
export function resolveAuditCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = nonEmptyString(env[CLI_ENTRY_ENV]);
  const entry = override ?? join(resolveFlumePackageRoot(), "dist", "index.js");
  if (!isAbsolute(entry)) return null;
  return existsSync(entry) ? entry : null;
}

/** The narrow environment one audit child gets. See `AUDIT_CHILD_ENV_KEYS`. */
export function auditChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AUDIT_CHILD_ENV_KEYS) {
    const value = base[key];
    if (typeof value === "string") env[key] = value;
  }
  // Bounded by construction: no pager to block on, no credential helper, no
  // terminal prompt a hung `git` could wait at forever.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.NO_COLOR = "1";
  return env;
}

/** What one audit child produced, categorized. Never an exception. */
export interface AuditObservationResult {
  /** Rule findings, or null when nothing parseable came back. */
  rules: Array<Record<string, unknown>> | null;
  /** `ok`, `timeout`, or `failed`. Mirrors the child's own outcome. */
  outcome: "ok" | "timeout" | "failed";
  /** A stable category, never a subprocess message. */
  reason: string | null;
  /** The child's exit status, null when it was killed or never ran. Reported in the finding. */
  code: number | null;
}

/**
 * Audit one repository as a bounded child of this build.
 *
 * `--live` is deliberately NEVER passed to the child. On the audit command that
 * flag only reaches the credentialed `--profile momo-lifecycle-plane` path; the
 * default audit it would decorate does not read it, and passing it would be a
 * standing invitation for a later change to make it mean something here.
 *
 * Three things are dropped at this boundary, and each for a reason `data` would
 * otherwise pay for: `auditedAt` (a timestamp makes two runs differ), the raw
 * `repo` path (home-redacted instead), and stderr (never read at all).
 */
export async function auditRepository(
  ctx: FleetRunContext,
  entry: string,
  repoPath: string,
  registryPath: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<AuditObservationResult> {
  const args = ["audit", repoPath, "--json"];
  if (registryPath) args.push("--registry", registryPath);

  const result = await captureSelf(ctx, entry, args, undefined, env, FLEET_STATUS_AUDIT_TIMEOUT_MS);
  if (result.outcome === "timeout") return { rules: null, outcome: "timeout", reason: "timeout", code: result.code };
  if (result.outcome === "cancelled") {
    // A cancellation is a COMMAND failure, not an observation outcome. It has to
    // escape rather than become one repository's downgraded domain.
    throw new FleetError("CANCELLED", "Fleet command was cancelled before it completed");
  }
  // The byte cap is its OWN category. A child killed for saying too much and a
  // child that said nothing are different problems with different repairs, and
  // the real audit report on this fleet is 3.7 MB against a 4 MiB cap -- one
  // growth spurt from making the distinction load-bearing.
  if (result.overflow) return { rules: null, outcome: "failed", reason: "audit-output-too-large", code: result.code };
  const text = result.value ?? "";
  if (text === "") {
    // `code` is what separates "ran and printed nothing" from "never ran": node
    // exits 1 for a module it cannot load and the child is killed with a null
    // code, and an operator chasing an empty report needs to know which.
    const reason = result.outcome === "ok"
      ? "audit-empty-output"
      : result.code === null ? "audit-child-killed" : "audit-no-output";
    return { rules: null, outcome: "failed", reason, code: result.code };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { rules: null, outcome: "failed", reason: "audit-unparseable-json", code: result.code }; }
  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) {
    return { rules: null, outcome: "failed", reason: "audit-report-shape-unknown", code: result.code };
  }
  // The child exiting 1 is NOT an error: `pjangler audit` exits 1 by design on a
  // drifted repository, with the complete report on stdout. Reporting that as a
  // collection failure would throw away exactly the findings this call exists
  // to collect.
  return { rules: parsed.rules.filter(isRecord), outcome: "ok", reason: null, code: result.code };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The value at a dotted path, when it is a timestamp and nothing else.
 *
 * `yaml` hands an ISO instant back as a string on the core schema and as a
 * `Date` on some documents, so both are accepted and everything else is
 * refused. A number here would be an epoch nobody declared the unit of.
 */
function timestampAt(root: unknown, segments: readonly string[]): string | null {
  let node: unknown = root;
  for (const segment of segments) {
    if (!isRecord(node)) return null;
    node = node[segment];
  }
  if (typeof node === "string") return nonEmptyString(node);
  if (node instanceof Date) return node.toISOString();
  return null;
}

/**
 * Resolve every policy-declared freshness field against the RAW stores.
 *
 * The raw stores rather than the inventory rows, for the same reason the audit
 * child gets raw paths: a row carries bounded, home-redacted projections built
 * for display, and `board_confirmed_at` is not one of the fields it projects.
 *
 * The path templates are the contract's own -- `projects.{slug}.…` resolves
 * against the project record this agent correlates to, `agents.{agent_id}.…`
 * against the agent's own raw row -- so a policy may name any declared field
 * and this reads it without a second table saying where each one lives. A field
 * under neither root resolves to null, which buckets `unknown` rather than
 * silently `current`.
 */
function resolveFreshnessValues(
  policy: FleetHealthPolicyView,
  agentRow: unknown,
  projectRecord: unknown,
): Map<string, string | null> {
  const values = new Map<string, string | null>();
  for (const { entry } of policy.freshness) {
    const [root, key, ...rest] = entry.field.split(".");
    if (root === "agents" && key === "{agent_id}") values.set(entry.field, timestampAt(agentRow, rest));
    else if (root === "projects" && key === "{slug}") values.set(entry.field, timestampAt(projectRecord, rest));
    else values.set(entry.field, null);
  }
  return values;
}

/**
 * The whole fleet's status, as the registries, the provenance core and the
 * recipe-owned audit rules state it.
 *
 * An unhealthy fleet is DATA, not a command failure: `validateFleetEnvelope`
 * nulls `data` on `ok:false`, so reporting drift as a failure would blank the
 * report on exactly the runs that matter. A drifted or incomplete fleet is
 * `ok:true`, exit 0, `health.healthy:false`. Only a COMMAND failure -- an
 * unreadable source, an unknown `--agent`/`--domain`, a bad flag, a blown
 * deadline, a cancellation -- throws.
 */
export async function collectFleetStatus(options: FleetStatusOptions): Promise<FleetStatus> {
  const runContext = options.runContext;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const live = options.live === true;
  throwIfCancelled(runContext);

  // THE REFERENCE INSTANT, CAPTURED ONCE, AND NEVER SERIALIZED. Freshness is a
  // bucket, so two runs milliseconds apart bucket identically; reading the
  // clock per observation would let a day boundary fall BETWEEN two
  // observations of the same run, which is a worse answer than either.
  const referenceMs = Date.now();

  // -- the baseline, READ before any probe or child, PARSED after the scope --
  //
  // Read-only, and it is the only file this flag opens. The bytes are taken
  // here because DW-56 is the recorded lesson about validating an input after
  // the sweep -- a typo indistinguishable from a slow fleet, exiting 7 where it
  // owed the caller a 2. Nothing has spawned at this point.
  //
  // The PARSE waits until the scope is resolved, a few lines below, because a
  // baseline has to be compared against the selection it is being diffed with:
  // a document taken over the whole fleet, diffed by a `--agent alpha` run,
  // would report `resolved` for every other agent -- "it got fixed" about
  // observations this run never collected.
  const baselinePath = nonEmptyString(options.baseline);
  let baselineText: string | null = null;
  let baselineShown = "";
  if (baselinePath !== null) {
    const resolved = resolve(expandHome(baselinePath, home));
    baselineShown = shownPath(resolved);
    try { baselineText = readFileSync(resolved, "utf8"); }
    catch {
      throw new FleetError(
        "INVALID_INPUT",
        "--baseline names a file that could not be read",
        false,
        { baseline: baselineShown },
      );
    }
  }

  const contractPath = resolveFleetContractPath(options.contract);
  const loaded = loadFleetContract(contractPath);
  const validation = validateFleetContract(loaded.document);
  const firstDiagnostic = validation.diagnostics[0];
  if (!validation.contract || firstDiagnostic) {
    throw new FleetError(
      firstDiagnostic?.code ?? "INVALID_INPUT",
      `fleet contract is not usable: ${firstDiagnostic ? `${firstDiagnostic.path}: ${firstDiagnostic.message}` : "validation produced no contract"}`,
      false,
      { contract_path: shownPath(contractPath) },
    );
  }
  const contract = validation.contract;

  // Story 1.2's core, called rather than reimplemented: it owns registry
  // reading, tolerant parsing, path classification, conflict detection and the
  // registered-agent count. Collected UNSCOPED so `total_registered_agents` and
  // the conflict groups stay fleet-wide under a filter -- provenance's
  // precedent, and the reason a scoped answer cannot claim a fleet verdict.
  // `rowCap: Infinity` for the same reason the agent cap counts every selected
  // agent: a bound on what the envelope CARRIES must never move what it
  // CONCLUDES. `collectFleetInventory` clips its own rows at
  // `FLEET_INVENTORY_MAX_ROWS` (1000), and status counts health, `by_state` and
  // the domain rollups out of the rows it is handed -- so past 1000 rows a
  // failing agent was never built, never counted, and not even retrievable:
  // measured on a 1021-row registry whose only malformed row sorted last,
  // `healthy: true, failed: 0, registry "pass"`, `totals.agents: 1021` beside
  // `totals.observations: 1000`, and `--agent zzzz-broken` -> NOT_FOUND exit 3.
  // Status still clips what it EMITS (`agents[]`, and each record's
  // observations); it no longer clips what it reasons over.
  const inventory = collectFleetInventory({ ...options, agentId: undefined, rowCap: Number.POSITIVE_INFINITY, runContext });
  const rowsById = new Map<string, FleetInventoryRow>();
  for (const row of inventory.rows) {
    const id = row.agent_id.value;
    if (id !== null && !rowsById.has(id)) rowsById.set(id, row);
  }
  const registeredIds = [...rowsById.keys()].sort();

  // Both filters are resolved and REJECTED here -- before a probe, before a
  // child, before any observation is built.
  const { scope, agentIds, domains } = resolveStatusScope(options, registeredIds, inventory.totals.registered_agents);
  const domainSet = new Set<FleetStatusDomain>(domains);
  const selectedAgents = new Set(agentIds);

  // The service manifest is resolved HERE rather than beside the other two,
  // because the raw-row loop below reads the platform names out of it: a
  // `--domain registry` run resolves it to null and then reads no messaging
  // declaration, spawns no `systemctl`, and samples no unit.
  const serviceManifest: FleetServiceManifest | null = domainSet.has("systemd") ? contract.service_manifest ?? null : null;

  // Parsed now, against the scope it will be diffed with, and still before a
  // single probe or audit child.
  const baselineSnapshots = baselineText === null
    ? []
    : parseBaselineDocument(baselineText, baselineShown, {
      agentId: scope.agent_id,
      domain: scope.domain,
      label: scope.label,
    }).snapshots;

  // -- the raw stores, for values a row does not project ---------------------
  // A ROW carries home-redacted, bounded projections for display: correct for an
  // inventory, unopenable for a child and stripped of the recorded timestamps a
  // freshness policy is about. Same split provenance documents.
  const stores = resolveInventoryStores(options);
  const agentRaw = readAgentRegistryRaw(stores.agents.inspectedPath);
  const agentRawById = new Map<string, unknown>();
  for (const entry of agentRaw.entries) if (!agentRawById.has(entry.key)) agentRawById.set(entry.key, entry.value);
  const repoByAgent = new Map<string, string>();
  // The scaffold observer's per-row inputs (story 1.6), from the RAW row for
  // the same reason `repoByAgent` is: a projected row is bounded and
  // home-redacted, and a role directory has to be opened, not shown.
  const roleDirByAgent = new Map<string, string | null>();
  const rawRowByAgent = new Map<string, Record<string, unknown>>();
  // The profile observer's per-row inputs (story 1.7), from the raw row for
  // the same reason. EVERY row's profile name is kept, not only the selected
  // ones: the root sweep skips exact registered names and detects aliases of
  // them, and a `--agent` run must still know the whole fleet's names to gate
  // one profile against a case-insensitive twin.
  const profileNameByAgent = new Map<string, string | null>();
  const displayNameByAgent = new Map<string, string | null>();
  const stableIdentityByAgent = new Map<string, string | null>();
  const declaredBankByAgent = new Map<string, string | null>();
  // The profile observer's role directory: the row's, else the canonical
  // default `<project_path>/agents/hermes/<role>` exactly as the scaffold
  // observer resolves it -- held apart from `roleDirByAgent`, which the
  // scaffold observer reads to report `role_dir_source`.
  const profileRoleDirByAgent = new Map<string, string | null>();
  // The systemd observer's per-row inputs (story 1.8), from the raw row for
  // the same reason. Every REGISTERED id is kept, not only the selected ones:
  // the fleet-scope sweep must not report another agent's canonical gateway as
  // an unregistered unit just because this run did not select that agent.
  const registeredAgentIds: string[] = [];
  const systemdRowByAgent = new Map<string, {
    storedGatewayUnit: string | null;
    storedHeartbeatTimer: string | null;
    storedSystemdKeys: string[];
    hermesBin: string | null;
    messaging: Record<string, { status: string | null; identity: Record<string, boolean> }>;
  }>();
  for (const entry of agentRaw.entries) {
    const raw = isRecord(entry.value) ? entry.value : {};
    if (!profileNameByAgent.has(entry.key)) {
      profileNameByAgent.set(entry.key, nonEmptyString(raw.profile_name));
      displayNameByAgent.set(entry.key, nonEmptyString(raw.display_name));
      stableIdentityByAgent.set(entry.key, nonEmptyString(raw.identity));
      const hindsight = isRecord(raw.hindsight) ? raw.hindsight : {};
      declaredBankByAgent.set(entry.key, nonEmptyString(hindsight.write_bank));
      registeredAgentIds.push(entry.key);
    }
    if (!selectedAgents.has(entry.key) || rawRowByAgent.has(entry.key)) continue;
    const declared = nonEmptyString(raw.project_path);
    if (declared !== null) repoByAgent.set(entry.key, resolve(expandHome(declared, home)));
    const declaredRoleDir = nonEmptyString(raw.role_dir);
    roleDirByAgent.set(entry.key, declaredRoleDir === null ? null : expandHome(declaredRoleDir, home));
    const role = nonEmptyString(raw.role);
    const projectPath = declared === null ? null : resolve(expandHome(declared, home));
    profileRoleDirByAgent.set(entry.key, declaredRoleDir !== null
      ? (isAbsolute(expandHome(declaredRoleDir, home)) ? resolve(expandHome(declaredRoleDir, home)) : projectPath === null ? null : resolve(projectPath, declaredRoleDir))
      : projectPath !== null && role !== null && role !== "." && role !== ".." && !role.includes("/") ? join(projectPath, "agents", "hermes", role) : null);
    rawRowByAgent.set(entry.key, raw);
    // The row's `systemd` block, its pinned executable, and how it DECLARES
    // each messaging platform. Names, words and booleans only: an identity
    // field is recorded as present-or-not and its value is never read out of
    // the store, so a bot token that somebody wrote into a row cannot reach the
    // observer, an item, or the envelope.
    const systemdBlock = isRecord(raw.systemd) ? raw.systemd : {};
    const hermes = isRecord(raw.hermes) ? raw.hermes : {};
    const messaging: Record<string, { status: string | null; identity: Record<string, boolean> }> = {};
    for (const platform of serviceManifest?.messaging.platforms ?? []) {
      const block = isRecord(raw[platform]) ? raw[platform] as Record<string, unknown> : {};
      const identity: Record<string, boolean> = {};
      for (const field of serviceManifest?.messaging.identity_fields[platform] ?? []) {
        const value = block[field];
        identity[field] = typeof value === "string" ? value.trim() !== "" : typeof value === "number" || typeof value === "boolean";
      }
      messaging[platform] = { status: nonEmptyString(block[serviceManifest!.messaging.status_field]), identity };
    }
    systemdRowByAgent.set(entry.key, {
      storedGatewayUnit: nonEmptyString(systemdBlock.gateway_unit),
      storedHeartbeatTimer: nonEmptyString(systemdBlock.heartbeat_timer),
      storedSystemdKeys: Object.keys(systemdBlock).sort(),
      hermesBin: nonEmptyString(hermes.bin) === null ? null : expandHome(nonEmptyString(hermes.bin)!, home),
      messaging,
    });
  }
  // A profile name more than one row claims is ambiguous for EVERY row that
  // claims it: which agent owns the directory cannot be decided, so none reads it.
  const profileNameClaims = new Map<string, number>();
  for (const name of profileNameByAgent.values()) if (name !== null) profileNameClaims.set(name, (profileNameClaims.get(name) ?? 0) + 1);
  const duplicateProfileNames = new Set([...profileNameClaims.entries()].filter(([, count]) => count > 1).map(([name]) => name));

  const policy = readHealthPolicy(contract);
  // The manifest is read only when the domain it feeds is selected: a
  // `--domain registry` run must not resolve render inputs it will never use.
  const manifest: FleetScaffoldManifest | null = domainSet.has("template_scaffold") ? contract.scaffold_manifest ?? null : null;
  // The same gate for the profile manifest (story 1.7): read only when the
  // profile domain is selected, so a `--domain registry` run spawns zero
  // renderer children and reads zero profile bytes.
  const profileManifest: FleetProfileManifest | null = domainSet.has("profile") ? contract.profile_manifest ?? null : null;
  // The systemd manifest is gated the same way and resolved earlier (see
  // `serviceManifest` above); a `--domain registry` run therefore spawns zero
  // `systemctl` children and reads zero unit properties.
  // The PROJECT raw store, read only when a freshness policy or a scaffold
  // render input actually needs it. Every populated, declared timestamp in
  // either store lives on one side or the other, and reading a file nothing
  // will consult would be work a `--domain registry` run explicitly must not do.
  const projectRawBySlug = new Map<string, unknown>();
  const manifestNeedsProjects = manifest !== null && Object.values(manifest.render_inputs).some((field) => field.startsWith("projects."));
  if (manifestNeedsProjects || policy.freshness.some(({ entry }) => entry.field.startsWith("projects."))) {
    const projectRaw = readProjectRegistryRaw(stores.projects.inspectedPath);
    for (const entry of projectRaw.entries) {
      // Indexed by BOTH the record key and the record's own `slug`, because the
      // inventory correlates on `slug` and the store is keyed by whatever the
      // writer chose. Keying on one of them only would silently resolve every
      // timestamp to null on a registry where they differ.
      if (!projectRawBySlug.has(entry.key)) projectRawBySlug.set(entry.key, entry.value);
      const slug = isRecord(entry.value) ? nonEmptyString(entry.value.slug) : null;
      if (slug !== null && !projectRawBySlug.has(slug)) projectRawBySlug.set(slug, entry.value);
    }
  }
  const freshnessByAgent = new Map<string, Map<string, string | null>>();

  const authority = buildAuthorityIndex(contract);
  const execution = contract.activation?.execution_authority;
  const activationField = nonEmptyString(execution?.field) ?? "agents.{agent_id}.bloodbank.enabled";
  const activationOwner = nonEmptyString(execution?.owner) ?? "the declared execution-authority owner";
  // The owner of a domain's authority BLOCK, read out of the contract rather
  // than spelled here. `ownerOf` indexes writable fields, and the process table
  // declares none by design -- so without this every `live_process` observation
  // shipped `owner: null` from a command whose whole point is that every value
  // names who owns it.
  const domainOwners = new Map<FleetStatusDomain, string | null>();
  for (const [domain, block] of Object.entries(DOMAIN_AUTHORITY_BLOCK) as Array<[FleetStatusDomain, string]>) {
    const declared = contract.authorities?.[block];
    domainOwners.set(domain, nonEmptyString(declared?.owner));
  }
  // Reuse of the ONE exception lookup in the codebase, on the groups the
  // inventory already built. Not a widened signature and not a second matcher:
  // an operator ruling recorded under `classifications.intentionally_unmanaged`
  // has exactly one definition and this reads it.
  const exceptionsByGroup = new Map<string, { id: string; reason: string }>();
  for (const group of inventory.conflicts) {
    const ruling = matchException(group, contract as FleetContract);
    if (!ruling) continue;
    const entry = (contract.classifications?.intentionally_unmanaged?.entries ?? [])
      .find((candidate) => isRecord(candidate) && nonEmptyString(candidate.id) === ruling.id);
    exceptionsByGroup.set(group.id, {
      id: ruling.id,
      reason: (isRecord(entry) ? nonEmptyString(entry.rationale) : null)
        ?? "a managed exception the contract records for exactly these participants",
    });
  }

  const ctx: FleetStatusContext = {
    authority,
    live,
    observations: [], findings: [], probes: [],
    droppedFindings: 0,
    unmappedRules: new Set<string>(),
    unexpectedDomainRules: new Set<string>(),
    unmappedFacts: new Set<string>(),
    unreportedHostRules: new Set<string>(),
    policy,
    referenceMs,
    activationField,
    activationOwner,
    domainOwner: (domain) => domainOwners.get(domain) ?? null,
    freshnessFor: (agentId) => {
      const cached = freshnessByAgent.get(agentId);
      if (cached) return cached;
      const row = rowsById.get(agentId);
      const slug = row?.project_id.value ?? null;
      const values = resolveFreshnessValues(
        policy,
        agentRawById.get(agentId),
        slug === null ? undefined : projectRawBySlug.get(slug),
      );
      freshnessByAgent.set(agentId, values);
      return values;
    },
    repoFor: (agentId) => {
      const repo = repoByAgent.get(agentId);
      return repo === undefined ? null : shownPath(repo);
    },
    exceptionFor: (groupId) => exceptionsByGroup.get(groupId) ?? null,
  };

  // A contract with NO policy block is not a contract that authorized
  // everything, and it is not a run failure either. It is a fleet nobody has
  // written the exceptions down for, and it says so once, by name.
  if (!policy.declared) {
    addFinding(ctx, {
      code: "health-policy-undeclared",
      domain: "registry",
      field: "agents.{agent_id}",
      agent_id: null,
      source: authority.ownerOf("agents.{agent_id}"),
      severity: "warn",
      statusSeverity: "high",
      gating: true,
      detail: `${shownPath(contractPath)} declares no health_policy block, so no skip, warning or deferred capability is authorized; every warn, skip and unsupported observation is reported unjustified and the fleet cannot claim proof`,
    });
  }

  // NOTHING OBSERVED IS NOT A CLEAN BILL. Measured on an `agents: {}` registry:
  // this command reported `{healthy: true, complete: true, fleet_complete: true}`
  // over zero agents -- the aggregate turning absence into agreement, which is
  // the one thing it exists not to do. `fleet_complete` now requires at least one
  // registered row (below), and the empty registry is a visible finding here.
  if (inventory.totals.registered_agents === 0) {
    addFinding(ctx, {
      code: "registry-declares-no-agents",
      domain: "registry",
      field: "agents.{agent_id}",
      agent_id: null,
      source: ctx.authority.ownerOf("agents.{agent_id}"),
      severity: "error",
      detail: "the agent registry declares no agents, so nothing was observed; an empty fleet is a source this run could not read, never a healthy one",
    });
  }

  // -- provenance, only when a provenance-fed domain is selected -------------
  // `--domain registry` must spawn ZERO provenance probes. A filter that
  // collects everything and then hides it is not a filter.
  let provenanceFacts: readonly FleetProvenanceFact[] = [];
  const needsProvenance = domains.some((domain) => PROVENANCE_FED_DOMAINS.has(domain));
  if (needsProvenance) {
    throwIfCancelled(runContext);
    const provenance = await collectFleetProvenance({
      ...options,
      agentId: undefined,
      // The same rule as the domain gate, one level down: under `--agent` no
      // checkout belonging to another agent may be probed.
      probeAgentIds: scope.kind === "agent" ? agentIds : undefined,
      // And the same rule one level ACROSS: the template probes feed only
      // `template_scaffold`, the checkout probes only `release_provenance`, so a
      // run scoped to one must not spawn the other's probes and discard the
      // facts. Measured before this: `--domain template_scaffold` and
      // `--domain release_provenance` ran the identical probe set,
      // `{checkout: 3, gitlink: 1, submodule: 1}`.
      probeFamilies: [
        ...(domainSet.has("template_scaffold") ? ["template" as const] : []),
        ...(domainSet.has("release_provenance") ? ["checkout" as const] : []),
      ],
      runContext,
    });
    provenanceFacts = provenance.facts;
    ctx.probes.push(...provenance.probes);
  }

  // -- scaffold parity, only when template_scaffold is selected --------------
  //
  // Story 1.6. Every managed role directory against the template at the
  // COMMITTED gitlink, asset by asset. Gated on the domain exactly as the
  // provenance families are: a `--domain registry` run spawns zero scaffold
  // probes, and `--agent <id>` reads only that agent's role directory.
  //
  // Render inputs resolve from the RAW stores by the contract's own paths --
  // `agents.{agent_id}` is the row's key, `agents.{agent_id}.<field>` reads the
  // raw row, `projects.{slug}.<field>` reads the correlated project record --
  // so the manifest may name any declared field and nothing here holds a second
  // table saying where each one lives.
  const scalarAt = (root: unknown, segments: readonly string[]): string | null => {
    let node: unknown = root;
    for (const segment of segments) {
      if (!isRecord(node)) return null;
      node = node[segment];
    }
    if (typeof node === "string") return nonEmptyString(node);
    if (typeof node === "number" || typeof node === "boolean") return String(node);
    return null;
  };
  const renderInputsFor = (agentId: string): Record<string, string | null> => {
    const inputs: Record<string, string | null> = {};
    if (manifest === null) return inputs;
    const rawRow = rawRowByAgent.get(agentId);
    const slug = rowsById.get(agentId)?.project_id.value ?? null;
    const project = slug === null ? undefined : projectRawBySlug.get(slug);
    for (const [name, field] of Object.entries(manifest.render_inputs)) {
      const [root, key, ...rest] = field.split(".");
      if (field === "agents.{agent_id}") inputs[name] = agentId;
      else if (root === "agents" && key === "{agent_id}") inputs[name] = scalarAt(rawRow, rest);
      else if (root === "projects" && key === "{slug}") inputs[name] = scalarAt(project, rest);
      else inputs[name] = null;
    }
    return inputs;
  };
  const scaffoldExceptionFor = (agentId: string): { path: string; reason: string } | null => {
    const ruling = policy.agentExceptions.find(({ entry }) => entry.domain === "template_scaffold" && entry.agent_id === agentId);
    return ruling ? { path: ruling.path, reason: ruling.entry.reason } : null;
  };
  let scaffoldParity: FleetScaffoldParity | null = null;
  const scaffoldByAgent = new Map<string, FleetScaffoldAgentResult>();
  if (manifest !== null) {
    throwIfCancelled(runContext);
    scaffoldParity = await collectScaffoldParity({
      run: runContext,
      pjanglerRoot: resolveFlumeRoot(),
      manifest,
      agents: agentIds.map((agentId) => ({
        agentId,
        projectPath: repoByAgent.get(agentId) ?? null,
        roleDir: roleDirByAgent.get(agentId) ?? null,
        role: nonEmptyString(rawRowByAgent.get(agentId)?.role),
        inputs: renderInputsFor(agentId),
      })),
      shown: shownPath,
    });
    ctx.probes.push(...scaffoldParity.probes);
    for (const result of scaffoldParity.agents) scaffoldByAgent.set(result.agentId, result);
  }
  // Counted over EVERY selected agent, before any cap, in the per-agent loop.
  const scaffoldCounts = {
    total_registered: inventory.totals.registered_agents,
    selected: agentIds.length,
    applicable: 0, passing: 0, drifted: 0, incomplete: 0, exception_authorized: 0, unobserved: 0,
  };
  const ruleAgreement = { compared: 0, agree: 0, disagree: 0, not_compared: 0 };

  // -- generated profile health, only when profile is selected ---------------
  //
  // Story 1.7. Every registered profile gated (real, contained, unambiguous),
  // read (identity file, generated config, delta, bank pin, skills) and proven
  // through the canonical renderer's own `check`, run at bytes proven identical
  // to the committed gitlink; in fleet scope, every unregistered root entry
  // classified. Gated on the domain exactly as the scaffold observer is.
  const profileExceptionFor = (agentId: string): { path: string; reason: string } | null => {
    const ruling = policy.agentExceptions.find(({ entry }) => entry.domain === "profile" && entry.agent_id === agentId);
    return ruling ? { path: ruling.path, reason: ruling.entry.reason } : null;
  };
  let profileHealth: FleetProfileHealth | null = null;
  if (profileManifest !== null) {
    throwIfCancelled(runContext);
    const layout = resolveProfileLayout(contract, env, home);
    const profileLayout = isRecord(contract.service_model?.profile_layout) ? contract.service_model.profile_layout : {};
    // The fleet-shared gateways block, from the SAME parse the agent rows came
    // from: never a second read of the registry.
    const gateways = isRecord(agentRaw.siblings.gateways) ? agentRaw.siblings.gateways : {};
    const bloodbank = isRecord(gateways.bloodbank) ? gateways.bloodbank : null;
    profileHealth = await collectProfileHealth({
      run: runContext,
      pjanglerRoot: resolveFlumeRoot(),
      home,
      env,
      fleetHome: resolveFleetHome(env, home),
      root: layout.root,
      generatedMarker: nonEmptyString(profileLayout.generated_marker) ?? "GENERATED FILE -- DO NOT EDIT",
      generatedFile: nonEmptyString(profileLayout.generated_file) ?? "config.yaml",
      overrideFile: nonEmptyString(profileLayout.override_file) ?? "config.delta.yaml",
      templateConfigPath: resolveTemplateConfigPath(env, home),
      manifest: profileManifest,
      classifications: contract.classifications,
      gatewayProfileName: bloodbank === null ? null : nonEmptyString(bloodbank.profile_name),
      registeredProfileNames: [...profileNameByAgent.values()].filter((name): name is string => name !== null),
      duplicateProfileNames,
      agents: agentIds.map((agentId) => ({
        agentId,
        profileName: profileNameByAgent.get(agentId) ?? null,
        stableIdentity: stableIdentityByAgent.get(agentId) ?? null,
        declaredBank: declaredBankByAgent.get(agentId) ?? null,
        displayName: displayNameByAgent.get(agentId) ?? null,
        roleDir: profileRoleDirByAgent.get(agentId) ?? null,
      })),
      // Fleet scope only: an `--agent` run inspects one registered profile and
      // never enumerates the root for extras.
      sweep: scope.kind === "fleet",
      shown: shownPath,
    });
    ctx.probes.push(...profileHealth.probes);
  }
  // Counted over EVERY selected agent, before any cap, in the per-agent loop.
  const profileCounts = {
    total_registered: inventory.totals.registered_agents,
    selected: agentIds.length,
    real: 0, blocked_at_path: 0, structurally_healthy: 0, drifted: 0, incomplete: 0, exception_authorized: 0, unobserved: 0,
  };
  const profileRenderer = { checked: 0, in_sync: 0, drifted: 0, failed: 0, timeout: 0 };
  const profileIdentity = { bank_ok: 0, bank_alias: 0, bank_custom: 0, bank_missing: 0, bank_mismatch: 0, bank_invalid: 0 };
  const profileSkills = { core_complete: 0, core_missing: 0, core_replaced: 0, extras_seen: 0 };
  const profileRuleAgreement = { compared: 0, agree: 0, disagree: 0, not_compared: 0 };

  // -- systemd topology and service health, only when systemd is selected ----
  //
  // Story 1.8. The user manager is sampled ONCE for the whole fleet over the
  // window `service_manifest.stabilization` declares, each selected agent's
  // canonical unit set is derived from `service_model.per_agent`, and the
  // DESIRED gateway state is derived from the row's own messaging declaration
  // rather than read back from the unit. Gated on the domain exactly as the
  // scaffold and profile observers are.
  const systemdExceptionFor = (agentId: string): { path: string; reason: string } | null => {
    const ruling = policy.agentExceptions.find(({ entry }) => entry.domain === "systemd" && entry.agent_id === agentId);
    return ruling ? { path: ruling.path, reason: ruling.entry.reason } : null;
  };
  let systemdHealth: FleetSystemdHealth | null = null;
  if (serviceManifest !== null) {
    throwIfCancelled(runContext);
    const layout = resolveProfileLayout(contract, env, home);
    const profileLayout = isRecord(contract.service_model?.profile_layout) ? contract.service_model.profile_layout : {};
    const fleetShared = isRecord(contract.service_model?.fleet_shared) ? contract.service_model.fleet_shared : {};
    // The fleet-shared gateways block, from the SAME parse the agent rows came
    // from: never a second read of the registry.
    const gateways = isRecord(agentRaw.siblings.gateways) ? agentRaw.siblings.gateways : {};
    const bloodbank = isRecord(gateways.bloodbank) ? gateways.bloodbank : null;
    systemdHealth = await collectSystemdHealth({
      run: runContext,
      home,
      env,
      fleetHome: resolveFleetHome(env, home),
      profileRoot: layout.root,
      overrideFile: nonEmptyString(profileLayout.override_file) ?? "config.delta.yaml",
      configHome: resolveConfigHome(env, home),
      manifest: serviceManifest,
      serviceModel: contract.service_model,
      retired: contract.retired,
      classifications: contract.classifications,
      sharedGateway: {
        unit: nonEmptyString(fleetShared.bloodbank_gateway_unit),
        profile: nonEmptyString(fleetShared.bloodbank_gateway_profile),
        registryUnit: bloodbank === null ? null : nonEmptyString(bloodbank.systemd_unit),
      },
      // The registry leaves the contract itself declares writable, unqualified.
      // A key on a row that is not one of them is a retired key -- read out of
      // the contract rather than spelled here, so retiring another one is a
      // contract edit and not a source edit.
      declaredSystemdKeys: [...new Set(
        Object.values(contract.authorities)
          .flatMap((authority) => authority.writable_fields ?? [])
          .map((field) => /^agents\.\{agent_id\}\.systemd\.([A-Za-z0-9_]+)$/u.exec(field)?.[1] ?? null)
          .filter((key): key is string => key !== null),
      )].sort(),
      registeredProfileNames: [...profileNameByAgent.values()].filter((name): name is string => name !== null),
      registeredAgentIds,
      agents: agentIds.map((agentId) => {
        const row = systemdRowByAgent.get(agentId);
        return {
          agentId,
          profileName: profileNameByAgent.get(agentId) ?? null,
          roleDir: profileRoleDirByAgent.get(agentId) ?? null,
          storedGatewayUnit: row?.storedGatewayUnit ?? null,
          storedHeartbeatTimer: row?.storedHeartbeatTimer ?? null,
          storedSystemdKeys: row?.storedSystemdKeys ?? [],
          hermesBin: row?.hermesBin ?? null,
          messaging: row?.messaging ?? {},
        };
      }),
      // Fleet scope only: an `--agent` run samples one agent's units and never
      // lists the manager, so it correlates no shared gateway and sweeps no
      // unregistered unit -- and says so rather than reading as an empty sweep.
      sweep: scope.kind === "fleet",
      shown: shownPath,
      // CLOCK_MONOTONIC, the same clock systemd's `*USecMonotonic` properties
      // use. Read once for the whole run so every agent's tick bucket is
      // computed against ONE instant.
      monotonicNowUs: process.hrtime.bigint() / 1_000n,
    });
    ctx.probes.push(...systemdHealth.probes);
  }
  // Counted over EVERY selected agent, before any cap, in the per-agent loop.
  const systemdCounts = {
    total_registered: inventory.totals.registered_agents,
    selected: agentIds.length,
    complete: 0, topology_ok: 0, gateway_healthy: 0, gateway_deferred: 0, heartbeat_healthy: 0,
    unstable: 0, crash_looping: 0, drifted: 0, incomplete: 0, exception_authorized: 0, unobserved: 0,
  };
  const systemdCapability = Object.fromEntries(FLEET_SYSTEMD_CAPABILITY_STATES.map((state) => [state, 0])) as Record<FleetSystemdCapabilityState, number>;
  const systemdRuleAgreement = { compared: 0, agree: 0, disagree: 0, not_compared: 0 };
  const systemdUnregisteredNotes: string[] = [];

  // -- the recipe audit, as bounded children ---------------------------------
  const auditFedSelected = domains.filter((domain) => AUDIT_PER_AGENT_DOMAINS.has(domain));
  const wantsAudit = live && auditFedSelected.length > 0;
  const auditByAgent = new Map<string, AuditObservationResult>();
  let auditsAttempted = 0;
  let auditsObserved = 0;
  let auditEntry: string | null = null;

  if (wantsAudit) {
    auditEntry = resolveAuditCli(env);
    if (auditEntry === null) {
      addFinding(ctx, {
        code: "audit-cli-unavailable",
        domain: "template_scaffold",
        field: DOMAIN_FIELD.template_scaffold,
        agent_id: null,
        // A real owner, resolved from the contract like every other finding this
        // namespace emits. `source: null` printed "owner undeclared" on the
        // human path for all four of these, from a command whose whole point is
        // that every value names who owns it.
        source: ctx.authority.ownerOf(DOMAIN_FIELD.template_scaffold),
        severity: "error",
        detail: `no built CLI to audit with (${CLI_ENTRY_ENV} names a file that is not there, or dist/index.js is not built); every audit-fed domain is unobserved rather than assumed`,
      });
    } else {
      // Deduplicated by canonical repository path BEFORE spawning: two agents
      // may share one repository, and auditing it twice would be two node
      // startups and two identical finding sets.
      const targets = [...new Set(repoByAgent.values())].sort();
      auditsAttempted = targets.length;
      remainingMs(runContext);
      const childCli = auditEntry;
      // The child must read the SAME stores this run did. `pjangler audit` takes
      // `--registry` for the project registry but has no flag for the Hermes
      // one, so the resolved path is handed over as the environment key its
      // reader honours -- otherwise `--agent-registry ./copy.yaml` would change
      // what status reads and leave the registry-reading audit rules answering
      // about the operator's live fleet.
      const childEnv = {
        ...auditChildEnv(env),
        HERMES_AGENTS_REGISTRY: stores.agents.inspectedPath,
        HERMES_FLEET_REGISTRY_FILE: stores.agents.inspectedPath,
      };
      const results = await mapBounded(targets, FLEET_STATUS_AUDIT_CONCURRENCY, async (repoPath) =>
        auditRepository(runContext, childCli, repoPath, options.projectRegistry, childEnv));
      const byRepo = new Map<string, AuditObservationResult>();
      targets.forEach((repoPath, index) => {
        const result = results[index]!;
        byRepo.set(repoPath, result);
        if (result.outcome === "ok") auditsObserved += 1;
        ctx.probes.push({
          id: `audit:${shownPath(repoPath)}`,
          kind: "audit",
          target: shownPath(repoPath),
          outcome: result.outcome === "ok" ? "ok" : result.outcome === "timeout" ? "timeout" : "failed",
          reason: result.reason,
        });
        if (result.outcome !== "ok") {
          addFinding(ctx, {
            code: `audit-${result.outcome}`,
            domain: "template_scaffold",
            subject: shownPath(repoPath),
            field: DOMAIN_FIELD.template_scaffold,
            agent_id: null,
            source: ctx.authority.ownerOf(DOMAIN_FIELD.template_scaffold),
            severity: "error",
            detail: `the recipe audit of ${shownPath(repoPath)} did not produce a report (${result.reason ?? result.outcome}${result.code === null ? ", killed" : `, exit ${result.code}`}); its audit-fed domains are ${result.outcome === "timeout" ? "unobserved" : "error"} rather than assumed`,
          });
        }
      });
      for (const [agentId, repoPath] of repoByAgent) {
        const result = byRepo.get(repoPath);
        if (result) auditByAgent.set(agentId, result);
      }
    }
  }

  // -- P9: a selected domain whose ONLY AUDIT observer is host-scoped -------
  // `--domain systemd --live` spawns no audit child, because no per-agent
  // recipe observation could come of it (AC6 forbids the spawn, and every
  // systemd RULE is host-scoped). The domain is no longer unobserved -- the
  // systemd observer samples the user manager directly in every scope (story
  // 1.8) -- but the two recipe rules that would have corroborated it do not
  // run, so `data.host` carries this observer's three findings and neither
  // rule's, and `data.systemd.rule_agreement` reads `not_compared`. Said out
  // loud rather than left for the operator to infer from an empty array.
  if (live && !wantsAudit) {
    for (const domain of domains) {
      const rules = Object.entries(RULE_DOMAIN).filter(([, mapped]) => mapped === domain).map(([ruleId]) => ruleId);
      if (rules.length === 0) continue;
      addFinding(ctx, {
        code: "audit-host-rules-not-collected",
        domain,
        subject: domain,
        field: DOMAIN_FIELD[domain],
        agent_id: null,
        source: ctx.authority.ownerOf(DOMAIN_FIELD[domain]),
        severity: "warn",
        detail: `domain ${domain} is observed live only by the host-scoped rule(s) ${rules.join(", ")}, and a --domain ${domain} run spawns no audit child, so data.host is empty; run without --domain to collect them`,
      });
    }
  }

  // -- per-agent records -----------------------------------------------------
  //
  // Every selected agent's observations are BUILT and counted. Only the first
  // `FLEET_STATUS_MAX_AGENTS` get a record, and each record carries at most
  // `FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT` of them -- but neither cap may
  // move a fleet-level number. Before this, agents past the agent cap were never
  // built at all and only the CLIPPED observations reached `ctx.observations`, so
  // a >500-agent registry whose single registry failure sorted past the cap
  // reported `health.healthy: true`, `failed: 0`, `domains[registry].state:
  // "pass"` -- while the same fleet at `--agent <that id>` reported the failure.
  // MEASURED. A bound on what the envelope CARRIES must never move what it
  // CONCLUDES.
  const hostByRule = new Map<string, { finding: FleetStatusHostFinding; states: Map<FleetStatusState, number> }>();

  // -- source integrity: ONE host finding, never an agent record -------------
  //
  // Whether the template source is canonical is a fact about THIS MACHINE's
  // checkout of pjangler, not about any repository in the fleet. It is filed
  // exactly as a host-scoped audit rule is -- once, under `data.host`, through
  // the same classifier -- and its consequence for the agents is carried on
  // their own records: every group `error`, every agent incomplete. A broken
  // source never becomes a fallback and never fails a repository.
  if (scaffoldParity !== null) {
    const state: FleetStatusState = scaffoldParity.source.integrity === "ok" ? "pass" : "error";
    const field = DOMAIN_FIELD.template_scaffold;
    const hostRetrieval = retrievalFor(null, "template_scaffold", live);
    const sourceClassification = classifyObservation({
      domain: "template_scaffold", state, field,
      ruleId: SCAFFOLD_SOURCE_RULE_ID, ruleScope: "host", source: SOURCE_SCAFFOLD,
      capability: null, evidence: null, fixable: false,
      exceptionId: null, exceptionReason: null,
      freshness: "not_applicable",
      repo: null,
      retrieval: hostRetrieval,
      activationField: ctx.activationField,
      activationOwner: ctx.activationOwner,
    }, ctx.policy);
    const sourceSummary = bounded(redactHome(scaffoldParity.source.detail));
    hostByRule.set(SCAFFOLD_SOURCE_RULE_ID, {
      finding: {
        rule_id: SCAFFOLD_SOURCE_RULE_ID,
        owner: ctx.domainOwner("template_scaffold"),
        domain: "template_scaffold",
        state,
        summary: sourceSummary,
        details: boundedDetails([
          `integrity ${scaffoldParity.source.integrity}`,
          `gitlink ${scaffoldParity.source.gitlink ?? "none recorded"}`,
          `${scaffoldParity.source.assets} asset(s) in the manifest`,
        ]),
        finding_id: statusFindingId("host", null, "template_scaffold", SCAFFOLD_SOURCE_RULE_ID, field, SOURCE_SCAFFOLD),
        retrieval: hostRetrieval,
        applicability: sourceClassification.applicability,
        evidence: sourceClassification.evidence,
        freshness: sourceClassification.freshness,
        severity: sourceClassification.severity,
        repair: sourceClassification.repair,
        observed: bounded(scaffoldParity.source.integrity),
        desired: "the committed gitlink stable, its object present, the worktree at it with no tracked change, and every rendered path owned by a declared group",
        next_action: sourceClassification.next_action,
        next_action_class: sourceClassification.next_action_class,
        justification: sourceClassification.justification,
      },
      states: new Map([[state, 1]]),
    });
  }

  // -- the profile observer's three host findings (story 1.7) ---------------
  //
  // The root gate and the renderer's integrity are facts about THIS MACHINE:
  // its fleet home and its checkout of pjangler. The extras sweep is a fact
  // about the shared profile root. All three are filed exactly as
  // `scaffold.source` is -- once, in `data.host`, through the same classifier
  // -- and their consequence for the agents rides on the agents' own records.
  const profileExtrasNotes: string[] = [];
  if (profileHealth !== null) {
    const hostRetrieval = retrievalFor(null, "profile", live);
    const hostFinding = (
      ruleId: string,
      state: FleetStatusState,
      field: string,
      summary: string,
      details: readonly string[],
      observed: string,
      desired: string,
      items?: FleetStatusProfileExtraItem[],
    ): void => {
      const classification = classifyObservation({
        domain: "profile", state, field,
        ruleId, ruleScope: "host", source: SOURCE_PROFILE,
        capability: null, evidence: null, fixable: false,
        exceptionId: null, exceptionReason: null,
        freshness: "not_applicable",
        repo: null,
        retrieval: hostRetrieval,
        activationField: ctx.activationField,
        activationOwner: ctx.activationOwner,
      }, ctx.policy);
      hostByRule.set(ruleId, {
        finding: {
          rule_id: ruleId,
          owner: ctx.authority.ownerOf(field) ?? ctx.domainOwner("profile"),
          domain: "profile",
          state,
          summary: bounded(redactHome(summary)),
          details: boundedDetails(details),
          finding_id: statusFindingId("host", null, "profile", ruleId, field, SOURCE_PROFILE),
          retrieval: hostRetrieval,
          applicability: classification.applicability,
          evidence: classification.evidence,
          freshness: classification.freshness,
          severity: classification.severity,
          repair: classification.repair,
          observed: bounded(redactHome(observed)),
          desired: bounded(desired),
          next_action: classification.next_action,
          next_action_class: classification.next_action_class,
          justification: classification.justification,
          ...(items && items.length > 0 ? { items } : {}),
        },
        states: new Map([[state, 1]]),
      });
    };
    hostFinding(
      PROFILE_ROOT_RULE_ID,
      profileHealth.root.state === "ok" ? "pass" : "error",
      PROFILE_FIELD_PATH,
      profileHealth.root.detail,
      [`root ${profileHealth.root.code}`],
      profileHealth.root.code,
      "the profile root is the directory the renderer reads, reached through real directories only",
    );
    const rendererOk = profileHealth.renderer.source === "ok" && profileHealth.renderer.python === "ok";
    hostFinding(
      PROFILE_RENDERER_RULE_ID,
      rendererOk ? "pass" : "error",
      PROFILE_FIELD_CONFIG,
      profileHealth.renderer.detail,
      [
        `source ${profileHealth.renderer.source}`,
        `python ${profileHealth.renderer.python}`,
        `gitlink ${profileHealth.renderer.gitlink ?? "none recorded"}`,
      ],
      rendererOk ? "ok" : profileHealth.renderer.source !== "ok" ? profileHealth.renderer.source : profileHealth.renderer.python,
      "the renderer and its lock helper in the submodule worktree equal the bytes at the committed gitlink, and a python3 with PyYAML can run them",
    );
    // The canonical projection as ONE named cause: twenty-six identical
    // per-agent `canonical-missing` items have one host fact behind them.
    hostFinding(
      PROFILE_SKILL_CORE_RULE_ID,
      profileHealth.skillCore.missing.length === 0 ? "pass" : "fail",
      PROFILE_FIELD_SKILLS,
      profileHealth.skillCore.missing.length === 0
        ? `the canonical skill projection at ${profileHealth.skillCore.canonicalDir} (${profileHealth.skillCore.source}) holds every core skill`
        : `the canonical skill projection at ${profileHealth.skillCore.canonicalDir} (${profileHealth.skillCore.source}) lacks ${profileHealth.skillCore.missing.length} core skill(s): ${profileHealth.skillCore.missing.join(", ")}; every real profile reads them missing`,
      [
        `canonical ${profileHealth.skillCore.canonicalDir}`,
        `resolved from ${profileHealth.skillCore.source}`,
        ...profileHealth.skillCore.missing.map((skill) => `canonical-missing:${skill}`),
      ],
      profileHealth.skillCore.missing.length === 0 ? "ok" : `missing ${profileHealth.skillCore.missing.join(", ")}`,
      "every core skill the contract requires present as a readable SKILL.md in the canonical projection",
    );
    if (profileHealth.extras !== null) {
      const all = profileHealth.extras.items;
      const kept = all.slice(0, FLEET_STATUS_MAX_ITEMS);
      if (all.length > kept.length) {
        profileExtrasNotes.push(`host[${PROFILE_EXTRAS_RULE_ID}].items: ${all.length - kept.length} of ${all.length} items dropped; data.profile.extras.by_class is counted over every entry before the cap`);
      }
      if (profileHealth.extras.truncated) {
        profileExtrasNotes.push(`host[${PROFILE_EXTRAS_RULE_ID}]: the profile root holds more than ${profileManifest!.limits.max_root_entries} entries; the sweep stopped at the cap and data.profile.extras.truncated says so`);
      }
      const unruled = all.filter((item) => item.class !== "approved-managed-exception" && item.class !== "intentionally-unmanaged");
      const byClass = Object.fromEntries(FLEET_PROFILE_EXTRA_CLASSES.map((klass) => [klass, all.filter((item) => item.class === klass).length])) as Record<FleetProfileExtraClass, number>;
      const spread = FLEET_PROFILE_EXTRA_CLASSES.filter((klass) => byClass[klass] > 0).map((klass) => `${byClass[klass]} ${klass}`).join(", ");
      hostFinding(
        PROFILE_EXTRAS_RULE_ID,
        unruled.length === 0 ? "pass" : "warn",
        PROFILE_FIELD_PATH,
        all.length === 0
          ? "the profile root holds no unregistered entry"
          : unruled.length === 0
            ? `${all.length} unregistered profile-root entr${all.length === 1 ? "y is" : "ies are"} classified by the contract (${spread})`
            : `${unruled.length} of ${all.length} unregistered profile-root entries carry no contract classification (${spread}); each is a finding for an operator, never a licence to delete`,
        kept.map((item) => `${item.class} ${item.path} (${item.kind}${item.alias_of ? `, alias of ${item.alias_of}` : ""}${item.standalone ? `, ${item.standalone}` : ""}, ${item.unit_file_references} unit ref(s), ${item.guidance})`),
        spread || "no unregistered entries",
        "every unregistered entry of the profile root claimed by a contract classification",
        kept.map((item) => ({
          path: bounded(item.path, 128),
          class: item.class,
          kind: item.kind,
          link_target: item.link_target === null ? null : bounded(item.link_target),
          standalone: item.standalone,
          alias_of: item.alias_of === null ? null : bounded(item.alias_of, 128),
          unit_file_references: item.unit_file_references,
          process_reference: item.process_reference,
          guidance: item.guidance,
          detail: item.detail === null ? null : bounded(item.detail),
        })),
      );
    }
  }

  // -- the systemd observer's three host findings (story 1.8) ---------------
  //
  // The user manager's own availability, the fleet-shared Bloodbank gateway,
  // and every unregistered `hermes-*` unit are facts about THIS MACHINE, not
  // about any repository or any one agent. All three are filed exactly as
  // `scaffold.source` and the profile observer's three are -- once, in
  // `data.host`, through the same classifier -- and their consequence for the
  // agents rides on the agents' own records: an unavailable manager makes every
  // selected agent's five leaves `error`, and never fails a repository.
  if (systemdHealth !== null) {
    const hostRetrieval = retrievalFor(null, "systemd", live);
    const hostFinding = (
      ruleId: string,
      state: FleetStatusState,
      field: string,
      summary: string,
      details: readonly string[],
      observed: string,
      desired: string,
      items?: FleetStatusSystemdUnregisteredItem[],
    ): void => {
      const classification = classifyObservation({
        domain: "systemd", state, field,
        ruleId, ruleScope: "host", source: SOURCE_SYSTEMD,
        capability: null, evidence: null, fixable: false,
        exceptionId: null, exceptionReason: null,
        freshness: "not_applicable",
        repo: null,
        retrieval: hostRetrieval,
        activationField: ctx.activationField,
        activationOwner: ctx.activationOwner,
      }, ctx.policy);
      hostByRule.set(ruleId, {
        finding: {
          rule_id: ruleId,
          owner: ctx.authority.ownerOf(field) ?? ctx.domainOwner("systemd"),
          domain: "systemd",
          state,
          summary: bounded(redactHome(summary)),
          details: boundedDetails(details),
          finding_id: statusFindingId("host", null, "systemd", ruleId, field, SOURCE_SYSTEMD),
          retrieval: hostRetrieval,
          applicability: classification.applicability,
          evidence: classification.evidence,
          freshness: classification.freshness,
          severity: classification.severity,
          repair: classification.repair,
          observed: bounded(redactHome(observed)),
          desired: bounded(desired),
          next_action: classification.next_action,
          next_action_class: classification.next_action_class,
          justification: classification.justification,
          ...(items && items.length > 0 ? { items } : {}),
        },
        states: new Map([[state, 1]]),
      });
    };
    // The manager, in EVERY scope: an `--agent` run that could not reach the
    // user manager has to say so as loudly as a fleet-wide one.
    hostFinding(
      SYSTEMD_MANAGER_RULE_ID,
      systemdHealth.manager.code === "available" ? "pass" : "error",
      SYSTEMD_FIELD_GATEWAY,
      systemdHealth.manager.detail,
      [
        `manager ${systemdHealth.manager.state}`,
        `code ${systemdHealth.manager.code}`,
        `window ${systemdHealth.window.samples} sample(s) ${systemdHealth.window.interval_ms} ms apart`,
      ],
      systemdHealth.manager.state,
      "a user manager in a state service_manifest.probe.manager_available_states lists, answering within the declared budget",
    );
    // The shared gateway and the sweep are FLEET-SCOPE facts. Under `--agent`
    // neither is probed, and neither is reported: a finding whose coverage was
    // never collected would read as a clean sweep.
    if (scope.kind === "fleet") {
      const shared = systemdHealth.shared;
      hostFinding(
        SYSTEMD_SHARED_RULE_ID,
        shared.state === "healthy" ? "pass" : shared.state === "error" || shared.state === "unobserved" ? "error" : "fail",
        SYSTEMD_FIELD_GATEWAY,
        shared.detail,
        [
          `unit ${shared.unit ?? "none declared"}`,
          `profile ${shared.profile ?? "none declared"}`,
          `state ${shared.state}`,
          ...(shared.code === null ? [] : [`code ${shared.code}`]),
        ],
        shared.state,
        "one fleet-shared Bloodbank gateway, named identically by the contract and the registry, enabled, active and stable at the declared shared profile",
      );
      // A sweep the manager was AVAILABLE for and this run still could not read
      // -- a failed, timed-out or malformed listing -- has to be a finding.
      // Before this it emitted nothing at all: `systemd.manager` read `pass`,
      // no `systemd.unregistered` finding existed, and the only trace was
      // `data.systemd.unregistered.reason` several levels down a JSON payload.
      // An operator reading the host findings saw a clean sweep of a manager
      // nobody swept. A manager failure keeps its own finding and is not
      // repeated here.
      if (systemdHealth.unregistered === null && systemdHealth.manager.code === "available") {
        hostFinding(
          SYSTEMD_UNREGISTERED_RULE_ID,
          "error",
          SYSTEMD_FIELD_TOPOLOGY,
          `the user manager answered but its ${serviceManifest!.unregistered.unit_glob} listing could not be read (${systemdHealth.unregisteredReason ?? "unknown"}), so no unregistered unit was classified on this run`,
          [
            `reason ${systemdHealth.unregisteredReason ?? "unknown"}`,
            `manager ${systemdHealth.manager.state}`,
            "coverage not-swept",
          ],
          systemdHealth.unregisteredReason ?? "unknown",
          "every unregistered hermes unit on this manager claimed by a contract classification",
        );
      }
      if (systemdHealth.unregistered !== null) {
        const all = systemdHealth.unregistered.items;
        const kept = all.slice(0, FLEET_STATUS_MAX_ITEMS);
        if (all.length > kept.length) {
          systemdUnregisteredNotes.push(`host[${SYSTEMD_UNREGISTERED_RULE_ID}].items: ${all.length - kept.length} of ${all.length} items dropped; data.systemd.unregistered.by_class is counted over every unit before the cap`);
        }
        if (systemdHealth.listingTruncated) {
          systemdUnregisteredNotes.push(`host[${SYSTEMD_UNREGISTERED_RULE_ID}]: the manager listed more than ${serviceManifest!.limits.max_units} ${serviceManifest!.unregistered.unit_glob} unit(s); every listing this run read is a prefix of what the manager holds, so an over-cap unit is neither swept nor correlated`);
        }
        if (systemdHealth.unregistered.truncated) {
          systemdUnregisteredNotes.push(`host[${SYSTEMD_UNREGISTERED_RULE_ID}]: the manager listed more than ${serviceManifest!.limits.max_unregistered_units} unregistered ${serviceManifest!.unregistered.unit_glob} unit(s); the sweep stopped at the cap and data.systemd.unregistered.truncated says so`);
        }
        const unruled = all.filter((item) => item.class !== "managed-exception");
        const byClass = Object.fromEntries(FLEET_SYSTEMD_UNREGISTERED_CLASSES.map((klass) => [klass, all.filter((item) => item.class === klass).length])) as Record<FleetSystemdUnregisteredClass, number>;
        const spread = FLEET_SYSTEMD_UNREGISTERED_CLASSES.filter((klass) => byClass[klass] > 0).map((klass) => `${byClass[klass]} ${klass}`).join(", ");
        hostFinding(
          SYSTEMD_UNREGISTERED_RULE_ID,
          unruled.length === 0 ? "pass" : "warn",
          SYSTEMD_FIELD_TOPOLOGY,
          all.length === 0
            ? `the user manager carries no unregistered ${serviceManifest!.unregistered.unit_glob} unit`
            : unruled.length === 0
              ? `${all.length} unregistered unit(s) are classified by the contract (${spread})`
              : `${unruled.length} of ${all.length} unregistered ${serviceManifest!.unregistered.unit_glob} unit(s) carry no contract classification (${spread}); each is a finding for an operator, never a licence to stop, disable or delete`,
          kept.map((item) => `${item.class} ${item.unit} (${item.load ?? "-"}/${item.active ?? "-"}/${item.sub ?? "-"}${item.correlated_profile ? `, profile ${item.correlated_profile}` : ""}, ${item.guidance})`),
          spread || "no unregistered units",
          "every unregistered hermes unit on this manager claimed by a contract classification",
          kept.map((item) => ({
            unit: bounded(item.unit, 128),
            load: item.load,
            unit_file: item.unit_file,
            active: item.active,
            sub: item.sub,
            class: item.class,
            correlated_profile: item.correlated_profile === null ? null : bounded(item.correlated_profile, 64),
            process_reference: item.process_reference,
            guidance: item.guidance,
            detail: item.detail === null ? null : bounded(item.detail),
          })),
        );
      }
    }
  }

  const agentRecords: FleetStatusAgent[] = [];
  let totalObservations = 0;
  let emittedObservations = 0;
  const truncated: string[] = [];
  // Counted over every SELECTED agent, including the ones the agent cap will
  // drop -- the same rule `by_state` and `health` already follow, and the exact
  // defect story 1.4's review found twice. A fleet clipped past
  // `FLEET_STATUS_MAX_AGENTS` produces the identical six counts.
  const members: FleetStatusMembers = emptyMembers();

  if (agentIds.length > FLEET_STATUS_MAX_AGENTS) {
    truncated.push(
      `agents: ${agentIds.length - FLEET_STATUS_MAX_AGENTS} of ${agentIds.length} agent records dropped; `
      + "every one of them is still counted in totals, by_state and health; "
      + "retrieve a dropped record with `flume review --agent <id> --json`",
    );
  }

  for (const agentId of agentIds) {
    throwIfCancelled(runContext);
    const row = rowsById.get(agentId)!;
    const own: FleetStatusObservation[] = [];
    own.push(...observeFromInventory(ctx, row, domainSet));
    if (needsProvenance) own.push(...observeFromProvenance(ctx, provenanceFacts, agentId, domainSet));

    // Story 1.6: the scaffold observer's group observations and per-agent
    // summary. The bucket counts are taken HERE, over every selected agent,
    // before the record cap decides what the envelope carries.
    const agentNotes: string[] = [];
    let scaffoldSummary: FleetStatusAgentScaffold | null = null;
    const scaffoldResult = scaffoldByAgent.get(agentId);
    const scaffoldObserved = manifest !== null && scaffoldResult !== undefined;
    if (domainSet.has("template_scaffold")) {
      const scaffold = observeFromScaffold(ctx, {
        agentId,
        result: scaffoldResult,
        manifestDeclared: manifest !== null,
        gitlink: scaffoldParity?.source.gitlink ?? null,
        exception: scaffoldExceptionFor(agentId),
        notes: agentNotes,
      });
      own.push(...scaffold.observations);
      scaffoldSummary = scaffold.summary;
      if (!scaffoldObserved) scaffoldCounts.unobserved += 1;
      else {
        scaffoldCounts.applicable += 1;
        if (scaffoldResult.groups.some((group) => group.state === "error")) scaffoldCounts.incomplete += 1;
        else if (scaffoldResult.groups.some((group) => group.state === "fail")) {
          if (scaffoldExceptionFor(agentId) !== null) scaffoldCounts.exception_authorized += 1;
          else scaffoldCounts.drifted += 1;
        } else scaffoldCounts.passing += 1;
      }
    }

    // Story 1.7: the profile observer's five observations and per-agent
    // summary. The same rule as the scaffold's: counted HERE, over every
    // selected agent, before the record cap.
    let profileSummary: FleetStatusAgentProfile | null = null;
    const profileResult = profileHealth?.agents.get(agentId);
    const profileObserved = profileManifest !== null && profileResult !== undefined;
    const profileException = domainSet.has("profile") ? profileExceptionFor(agentId) : null;
    if (domainSet.has("profile")) {
      const profile = observeFromProfile(ctx, {
        agentId,
        result: profileResult,
        manifestDeclared: profileManifest !== null,
        exception: profileException,
        notes: agentNotes,
      });
      own.push(...profile.observations);
      profileSummary = profile.summary;
      if (!profileObserved) profileCounts.unobserved += 1;
      else {
        const aspects = [profileResult.path, profileResult.identity, profileResult.config, profileResult.bank, profileResult.skills];
        const gateFailed = profileResult.path.state !== "pass" && profileResult.path.code !== "misowned-link" && profileResult.path.code !== "unverifiable";
        if (gateFailed) {
          if (profileResult.path.state === "fail") profileCounts.blocked_at_path += 1;
          else profileCounts.incomplete += 1;
        } else {
          profileCounts.real += 1;
          if (aspects.some((aspect) => aspect.state === "error" || aspect.state === "unobserved")) profileCounts.incomplete += 1;
          else if (aspects.some((aspect) => aspect.state === "fail")) {
            if (profileException !== null) profileCounts.exception_authorized += 1;
            else profileCounts.drifted += 1;
          } else profileCounts.structurally_healthy += 1;
        }
        switch (profileResult.config.renderer.state) {
          case "in-sync": profileRenderer.checked += 1; profileRenderer.in_sync += 1; break;
          case "drifted": profileRenderer.checked += 1; profileRenderer.drifted += 1; break;
          default: break;
        }
        if (profileResult.config.items.some((item) => item.kind === "renderer-failed")) { profileRenderer.checked += 1; profileRenderer.failed += 1; }
        if (profileResult.config.items.some((item) => item.kind === "renderer-timeout")) { profileRenderer.checked += 1; profileRenderer.timeout += 1; }
        // ONE bucket per real profile, so the six sum to `real`: the bank
        // field is either a pass or exactly one item, and the gate above
        // decided the profile was read at all.
        if (!gateFailed) {
          const bankCode = profileResult.bank.code;
          if (profileResult.bank.state === "pass") profileIdentity.bank_ok += 1;
          else if (bankCode === "bank-alias") profileIdentity.bank_alias += 1;
          else if (bankCode === "bank-custom") profileIdentity.bank_custom += 1;
          else if (bankCode === "bank-missing" || bankCode === "pin-missing") profileIdentity.bank_missing += 1;
          else if (bankCode === "bank-mismatch") profileIdentity.bank_mismatch += 1;
          else profileIdentity.bank_invalid += 1;
        }
        if (profileResult.skills.state === "pass" && profileResult.skills.coreMissing.length === 0 && !gateFailed) profileSkills.core_complete += 1;
        // Every way a core skill can be absent for this profile: not there,
        // dangling, foreign, or absent from the canonical projection itself
        // (nothing holds what it would resolve). Replaced is its own count.
        profileSkills.core_missing += profileResult.skills.items.filter((item) => (
          item.path.startsWith("skills/")
          && (item.kind === "core-missing" || item.kind === "core-dangling" || item.kind === "core-foreign" || item.kind === "canonical-missing")
        )).length;
        profileSkills.core_replaced += profileResult.skills.items.filter((item) => item.kind === "core-replaced").length;
        profileSkills.extras_seen += profileResult.skills.extraTotal;
      }
    }

    // Story 1.8: the systemd observer's five observations and per-agent
    // summary. The same rule as the scaffold's and the profile's: counted
    // HERE, over every selected agent, before the record cap.
    let systemdSummary: FleetStatusAgentSystemd | null = null;
    const systemdResult = systemdHealth?.agents.get(agentId);
    const systemdObserved = serviceManifest !== null && systemdResult !== undefined;
    const systemdException = domainSet.has("systemd") ? systemdExceptionFor(agentId) : null;
    if (domainSet.has("systemd")) {
      const systemd = observeFromSystemd(ctx, {
        agentId,
        result: systemdResult,
        manifestDeclared: serviceManifest !== null,
        exception: systemdException,
        notes: agentNotes,
      });
      own.push(...systemd.observations);
      systemdSummary = systemd.summary;
      if (!systemdObserved) systemdCounts.unobserved += 1;
      else {
        const leaves = [systemdResult.topology, systemdResult.heartbeatTimerRow, systemdResult.gateway, systemdResult.timer, systemdResult.service];
        systemdCapability[systemdResult.capability.declared] += 1;
        if (leaves.every((leaf) => leaf.state !== "error" && leaf.state !== "unobserved")) systemdCounts.complete += 1;
        if (systemdResult.topology.state === "pass") systemdCounts.topology_ok += 1;
        if (systemdResult.gateway.state === "pass") {
          if (systemdResult.capability.declared === "deferred") systemdCounts.gateway_deferred += 1;
          else systemdCounts.gateway_healthy += 1;
        }
        if (systemdResult.timer.state === "pass" && systemdResult.service.state === "pass") systemdCounts.heartbeat_healthy += 1;
        // A crash loop is counted as its own cause AND as an instability: the
        // window was not unanimous either way, and an operator scanning for
        // "how many gateways moved under the observation" must see both.
        if (!systemdResult.gateway.stability.stable && systemdResult.gateway.state !== "error") systemdCounts.unstable += 1;
        if (systemdResult.gateway.items.some((item) => item.kind === "crash-looping")) systemdCounts.crash_looping += 1;
        if (leaves.some((leaf) => leaf.state === "error" || leaf.state === "unobserved")) systemdCounts.incomplete += 1;
        else if (leaves.some((leaf) => leaf.state === "fail")) {
          if (systemdException !== null) systemdCounts.exception_authorized += 1;
          else systemdCounts.drifted += 1;
        }
      }
    }

    const audit = auditByAgent.get(agentId);
    if (!live) {
      if (scaffoldObserved) ruleAgreement.not_compared += 1;
      if (profileObserved) profileRuleAgreement.not_compared += 1;
      if (systemdObserved) systemdRuleAgreement.not_compared += 1;
      // Matrix row 1. Without `--live` the audit half was not read, so every
      // domain it feeds says so -- rather than reporting the store half as if
      // it were the whole answer.
      for (const domain of auditFedSelected) {
        own.push(observation(ctx, {
          domain, agentId, state: "unobserved",
          field: DOMAIN_FIELD[domain],
          summary: "the recipe-owned audit rules were not run; pass --live to authorize bounded read-only host observation",
          details: ["a default run makes no network call, and the bmad version rule's `npm view` is a real one"],
          source: SOURCE_AUDIT,
          observed: "not read",
          desired: "the recipe-owned audit rules run for this agent's repository",
        }));
      }
    } else if (auditEntry === null || audit === undefined || audit.outcome !== "ok") {
      if (scaffoldObserved) ruleAgreement.not_compared += 1;
      if (profileObserved) profileRuleAgreement.not_compared += 1;
      if (systemdObserved) systemdRuleAgreement.not_compared += 1;
      const failed = audit !== undefined && audit.outcome === "failed";
      const state: FleetStatusState = failed ? "error" : "unobserved";
      const reason = auditEntry === null
        ? "audit-cli-unavailable"
        : audit === undefined
          ? "no-project-path-recorded"
          : audit.reason ?? audit.outcome;
      for (const domain of auditFedSelected) {
        own.push(observation(ctx, {
          domain, agentId, state,
          field: DOMAIN_FIELD[domain],
          summary: `the recipe audit for this agent's repository could not be read (${reason})`,
          details: ["every other agent's record is unaffected; a collection error is never a pass and never a dropped agent"],
          source: SOURCE_AUDIT,
          observed: reason,
          desired: "a parseable report from the recipe audit of this agent's repository",
        }));
      }
    } else {
      for (const rule of audit.rules ?? []) {
        const ruleId = nonEmptyString(rule.id);
        if (ruleId === null || EXCLUDED_RULES.has(ruleId)) continue;
        let domain = RULE_DOMAIN[ruleId];
        if (domain === undefined) {
          domain = UNMAPPED_RULE_DOMAIN;
          if (!ctx.unmappedRules.has(ruleId)) {
            ctx.unmappedRules.add(ruleId);
            addFinding(ctx, {
              code: "audit-rule-unmapped",
              domain,
              subject: ruleId,
              field: DOMAIN_FIELD[domain],
              agent_id: null,
              source: recipeRegistry.ownerOf(ruleId)?.recipe.metadata.id ?? ctx.authority.ownerOf(DOMAIN_FIELD[domain]),
              severity: "warn",
              detail: `the recipe rule ${ruleId} has no declared status domain; it is reported under ${UNMAPPED_RULE_DOMAIN} so it cannot disappear, and RULE_DOMAIN in src/fleet/status.ts is where it should be classified`,
            });
          }
        }
        const scopeOfRule = rule.scope === "host" ? "host" : "project";
        if (scopeOfRule === "project" && !AUDIT_PER_AGENT_DOMAINS.has(domain) && !ctx.unexpectedDomainRules.has(ruleId)) {
          // The set above decides whether a child spawns for a `--domain` run.
          // A project-scoped rule outside it would be reported on an unfiltered
          // run and silently absent on the filtered one -- so say so, once,
          // rather than let the two answers quietly disagree.
          ctx.unexpectedDomainRules.add(ruleId);
          addFinding(ctx, {
            code: "audit-domain-unexpected",
            domain,
            subject: ruleId,
            field: DOMAIN_FIELD[domain],
            agent_id: null,
            source: recipeRegistry.ownerOf(ruleId)?.recipe.metadata.id ?? ctx.authority.ownerOf(DOMAIN_FIELD[domain]),
            severity: "warn",
            detail: `the project-scoped rule ${ruleId} maps to domain ${domain}, which AUDIT_PER_AGENT_DOMAINS in src/fleet/status.ts does not list; a --domain ${domain} run spawns no audit child and would not report it`,
          });
        }
        if (!domainSet.has(domain)) {
          // COLLECTED, THEN DROPPED -- the asymmetry that made the filtered run
          // the silent one. When no child spawns, the P9 block above says
          // `audit-host-rules-not-collected` and points at an unfiltered run.
          // When a child DOES spawn (the selected domain is audit-fed), every
          // host rule for an unselected domain arrived and was thrown away with
          // no finding and no truncation note. Measured on the live fleet:
          // `--domain template_scaffold --live` spawned 28 children, reported
          // the 2 notebook rules, and discarded `systemd.sentinel` (fail),
          // `hermes.registry-parity` (fail), `hermes.profile-wiring` (fail) and
          // `hermes.fleet-config` -- `findings: []`, `truncated: []`. An empty
          // `data.host` then reads as "this machine is clean", which is the one
          // thing it must never be able to mean.
          if (scopeOfRule === "host" && !ctx.unreportedHostRules.has(ruleId)) {
            ctx.unreportedHostRules.add(ruleId);
            addFinding(ctx, {
              code: "audit-host-rules-not-reported",
              domain,
              subject: ruleId,
              scope: "host",
              field: DOMAIN_FIELD[domain],
              agent_id: null,
              source: recipeRegistry.ownerOf(ruleId)?.recipe.metadata.id ?? ctx.authority.ownerOf(DOMAIN_FIELD[domain]),
              severity: "warn",
              // NO STATE IS CLAIMED HERE, deliberately. This fires on the first
              // repository that reports the rule, and `hostByRule` resolves the
              // fleet's reading of a host rule WORST-WINS across repositories --
              // so the state visible at this point may be the best reading, not
              // the one that matters. Naming it would re-introduce exactly the
              // first-wins mask that let a `pass` from one repo hide a `fail`
              // from another.
              detail: `the host-scoped rule ${ruleId} ran, but its domain ${domain} is not selected, so data.host does not carry its result; run without --domain to see every host finding`,
            });
          }
          continue;
        }
        const owner = recipeRegistry.ownerOf(ruleId)?.recipe.metadata.id ?? null;
        const state = ruleState(rule.status);
        if (scopeOfRule === "host") {
          // ONCE, deduped by rule id -- a host condition repeated 28 times is
          // not 28 problems, and folding it into an agent record would fail a
          // repository for something no work in that repository can change.
          //
          // WORST WINS, not first wins. The loop runs in alphabetical agent
          // order, so `if (!has(ruleId))` kept whichever repository came first
          // and a `pass` from `alpha` masked a `fail` for the same rule from
          // `zeta`. Repositories CAN disagree about a host rule (a rule that
          // reads both $HOME and the repo, or one that skips where the repo has
          // no notebook), so the reading that must survive is the worst one, and
          // the disagreement is recorded rather than resolved silently.
          const accumulated = hostByRule.get(ruleId);
          // A retrieval that returns nothing is worse than none. `--domain
          // registry|systemd|bloodbank --live` spawns no AUDIT child (they are
          // not in `AUDIT_PER_AGENT_DOMAINS`), so a narrowed run comes back
          // without this rule's result -- measured on the live fleet for 4 of 6
          // host findings, each of which named exactly that command. Those
          // domains get the unfiltered invocation, which is the one that
          // collects them. (A `--domain systemd` run is no longer empty: the
          // systemd observer's own three host findings are collected in every
          // scope. It is the RULE's reading that the narrowed command loses.)
          const hostRetrieval = retrievalFor(null, AUDIT_PER_AGENT_DOMAINS.has(domain) ? domain : null, true);
          const hostSummary = bounded(redactHome(nonEmptyString(rule.summary) ?? nonEmptyString(rule.title) ?? ruleId));
          // The SAME classifier every observation goes through, so a host
          // finding cannot end up carrying a different set of axes from an
          // agent one. `ruleScope: "host"` is what makes its repair class
          // `other-owner`: no amount of work in any repository changes a
          // condition about this machine, which is the category error PJAN-84
          // fixed and this block exists to keep fixed.
          const hostClassification = classifyObservation({
            domain, state, field: DOMAIN_FIELD[domain],
            ruleId, ruleScope: "host", source: SOURCE_AUDIT,
            capability: null, evidence: null,
            fixable: typeof rule.fixable === "boolean" ? rule.fixable : null,
            exceptionId: null, exceptionReason: null,
            freshness: "not_applicable",
            repo: null,
            retrieval: hostRetrieval,
            activationField: ctx.activationField,
            activationOwner: ctx.activationOwner,
          }, ctx.policy);
          const candidate: FleetStatusHostFinding = {
            rule_id: ruleId,
            // Never null on a non-pass: `recipeRegistry` answers for every rule
            // it declares, and the contract's own authority for the domain
            // answers for one it does not.
            owner: owner ?? ctx.domainOwner(domain),
            domain,
            state,
            summary: hostSummary,
            details: boundedDetails(Array.isArray(rule.details) ? rule.details : []),
            finding_id: statusFindingId("host", null, domain, ruleId, DOMAIN_FIELD[domain], SOURCE_AUDIT),
            retrieval: hostRetrieval,
            applicability: hostClassification.applicability,
            evidence: hostClassification.evidence,
            freshness: hostClassification.freshness,
            severity: hostClassification.severity,
            repair: hostClassification.repair,
            observed: hostSummary,
            desired: bounded(`the host-scoped rule ${ruleId} reporting pass on this machine`),
            next_action: hostClassification.next_action,
            next_action_class: hostClassification.next_action_class,
            justification: hostClassification.justification,
          };
          if (accumulated === undefined) {
            hostByRule.set(ruleId, { finding: candidate, states: new Map([[state, 1]]) });
          } else {
            accumulated.states.set(state, (accumulated.states.get(state) ?? 0) + 1);
            if (stateRank(state) < stateRank(accumulated.finding.state)) accumulated.finding = candidate;
          }
          continue;
        }
        const ruleSummary = nonEmptyString(rule.summary) ?? nonEmptyString(rule.title) ?? ruleId;
        own.push(observation(ctx, {
          domain, agentId, state,
          field: DOMAIN_FIELD[domain],
          owner,
          ruleId,
          ruleScope: "project",
          summary: ruleSummary,
          details: Array.isArray(rule.details) ? rule.details : [],
          source: SOURCE_AUDIT,
          observed: ruleSummary,
          desired: `the recipe rule ${ruleId} reporting pass for this repository`,
          // The rule's OWN `fixable`, verbatim. It is what decides whether the
          // repair class is `automatic` and whether the next action can be a
          // real `pjangler migrate` invocation -- read from the report rather
          // than guessed from the rule id, so a rule that loses its recipe
          // stops claiming one in the same run.
          fixable: typeof rule.fixable === "boolean" ? rule.fixable : null,
        }));
      }

      // -- rule agreement: the observer against `hermes.pm-scaffold` ---------
      //
      // An EXPLICIT check, because the two deliberately do not share a field
      // path and so can never meet in `detectContradictions`. Compared over the
      // subset both read; a disagreement is a finding and both readings stand.
      // Never resolved silently in either direction.
      if (scaffoldObserved) {
        const ruleVerdict = scaffoldRuleVerdict((audit.rules ?? []).find((rule) => nonEmptyString(rule.id) === "hermes.pm-scaffold"));
        const observerDrift = scaffoldObserverDrift(scaffoldResult);
        if (ruleVerdict === null || observerDrift === null) ruleAgreement.not_compared += 1;
        else {
          ruleAgreement.compared += 1;
          if ((ruleVerdict === "fail") === observerDrift) ruleAgreement.agree += 1;
          else {
            ruleAgreement.disagree += 1;
            addFinding(ctx, {
              code: "scaffold-rule-disagreement",
              domain: "template_scaffold",
              field: DOMAIN_FIELD.template_scaffold,
              agent_id: agentId,
              source: ctx.domainOwner("template_scaffold"),
              severity: "error",
              statusSeverity: "high",
              gating: true,
              detail: `the recipe rule hermes.pm-scaffold reports ${ruleVerdict} while the scaffold observer finds ${observerDrift ? "drift" : "no drift"} over the assets both compare (hermes, .gitignore, .scripts/** for content; role.yaml, SOUL.md and .runtime-scaffold/README.md for presence); both readings are kept and neither is resolved silently`,
            });
          }
        }
      }

      // -- rule agreement: the profile observer against `hermes.runtime-singleton`
      //
      // The same explicit check, for the same reason: the observer's fields
      // are `profiles.{profile_name}.*` leaves and the rule's is
      // `agents.{agent_id}.profile_name`, so they never meet in
      // `detectContradictions`. Compared over the subset both read (the path,
      // the two config files, the pin); semantic drift, the identity file and
      // the skills are `not_compared` by construction.
      if (profileObserved) {
        const ruleVerdict = profileRuleVerdict((audit.rules ?? []).find((rule) => nonEmptyString(rule.id) === "hermes.runtime-singleton"));
        const observerDrift = profileObserverDrift(profileResult);
        if (ruleVerdict === null || observerDrift === null) profileRuleAgreement.not_compared += 1;
        else {
          profileRuleAgreement.compared += 1;
          if ((ruleVerdict === "fail") === observerDrift) profileRuleAgreement.agree += 1;
          else {
            profileRuleAgreement.disagree += 1;
            addFinding(ctx, {
              code: "profile-rule-disagreement",
              domain: "profile",
              field: PROFILE_FIELD_PATH,
              agent_id: agentId,
              source: ctx.domainOwner("profile"),
              severity: "error",
              statusSeverity: "high",
              gating: true,
              detail: `the recipe rule hermes.runtime-singleton reports ${ruleVerdict} while the profile observer finds ${observerDrift ? "drift" : "no drift"} over the profile state both read (the profile directory, config.yaml, config.delta.yaml and the Hindsight bank pin); both readings are kept and neither is resolved silently`,
            });
          }
        }
      }

      // -- rule agreement: the systemd observer against `systemd.sentinel`
      //    and `hermes.registry-parity`
      //
      // The same explicit check, for the same reason: both rules are HOST
      // scoped and file into `data.host`, so they never meet an agent's
      // observations in `detectContradictions` at all. Compared over the subset
      // all three read -- enablement, activity, unit presence, retired units and
      // retired registry keys. Stability, channel declaration, schedule, tick
      // and heartbeat result are `not_compared` by construction: neither rule
      // looks at any of them.
      if (systemdObserved) {
        const sentinel = systemdRuleVerdict((audit.rules ?? []).find((rule) => nonEmptyString(rule.id) === "systemd.sentinel"));
        const parity = systemdParityVerdict((audit.rules ?? []).find((rule) => nonEmptyString(rule.id) === "hermes.registry-parity"));
        // The two rules cover one subset between them: either failing over its
        // own half of it is the rules' reading of "there is drift here".
        const ruleVerdict = sentinel === null && parity === null
          ? null
          : sentinel === "fail" || parity === "fail" ? "fail" as const : "pass" as const;
        const observerDrift = systemdObserverDrift(systemdResult);
        if (ruleVerdict === null || observerDrift === null) systemdRuleAgreement.not_compared += 1;
        else {
          systemdRuleAgreement.compared += 1;
          if ((ruleVerdict === "fail") === observerDrift) systemdRuleAgreement.agree += 1;
          else {
            systemdRuleAgreement.disagree += 1;
            addFinding(ctx, {
              code: "systemd-rule-disagreement",
              domain: "systemd",
              field: SYSTEMD_FIELD_GATEWAY,
              agent_id: agentId,
              source: ctx.domainOwner("systemd"),
              severity: "error",
              statusSeverity: "high",
              gating: true,
              detail: `the recipe rules systemd.sentinel/hermes.registry-parity report ${ruleVerdict} while the systemd observer finds ${observerDrift ? "drift" : "no drift"} over the service state all three read (unit presence, enablement, activity, retired units and retired registry keys); both readings are kept and neither is resolved silently`,
            });
          }
        }
      }
    }

    // `(agent_id, domain, rule_id)` -- the declared sort key. Byte order, never
    // locale order, and never completion order: `data` has to be byte-identical
    // across two runs and across the CLI/MCP pair.
    own.sort((a, b) => (
      a.domain < b.domain ? -1 : a.domain > b.domain ? 1
        : (a.rule_id ?? "") < (b.rule_id ?? "") ? -1 : (a.rule_id ?? "") > (b.rule_id ?? "") ? 1
          : a.field < b.field ? -1 : a.field > b.field ? 1
            : a.finding_id < b.finding_id ? -1 : a.finding_id > b.finding_id ? 1 : 0
    ));

    // EVERY observation, from EVERY selected agent, counted -- including the
    // agents whose record the cap will drop.
    totalObservations += own.length;
    ctx.observations.push(...own);

    // Rolled up from the FULL set, not the clipped one.
    const byDomain: Partial<Record<FleetStatusDomain, FleetStatusState>> = {};
    for (const domain of domains) byDomain[domain] = rollUp(own.filter((item) => item.domain === domain));

    // Story 1.4's two per-agent verdicts, computed exactly as 1.4 defines them
    // and out of the FULL observation set. `clipped` is folded into `complete`
    // below, where 1.4 put it.
    const healthy = !own.some((item) => item.state === "fail" || item.state === "error");
    // The observation cap is a property of the FULL set, so it is knowable
    // before the record is built -- which matters because an agent the AGENT
    // cap will drop still has to land in exactly one member bucket, computed
    // the same way as one that survives.
    const clipped = own.length > FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT;
    const complete = !own.some((item) => item.state === "unobserved" || item.state === "error") && !clipped;
    const lifecycle = agentLifecycle(row, own, domainSet);
    const memberClass = classifyMember(
      { healthy, complete },
      row.classification.value ?? "unclassified",
      own,
    );
    members[memberClass] += 1;

    if (agentRecords.length >= FLEET_STATUS_MAX_AGENTS) continue;
    // Item and overlap clips belong to the RECORD, so they are noted only once
    // the record is known to be emitted -- the counts they clip were already
    // taken above, over the full lists.
    truncated.push(...agentNotes);

    let kept = own;
    let retrieval = retrievalFor(agentId, domains.length === 1 ? domains[0]! : null, live);
    if (clipped) {
      kept = own.slice(0, FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT);
      // A retrieval that RE-RUNS THE SAME CLIP is not a retrieval. On an
      // unfiltered run `--agent <id> --json` is exactly the invocation that just
      // clipped, so the narrowing has to be a `--domain`: the one whose
      // observations were dropped hardest. Running it returns that domain's
      // full set, because a single-domain record has no clip pressure from the
      // other eight.
      retrieval = retrievalFor(agentId, mostClippedDomain(own, kept, domains), live);
      truncated.push(
        `agents.${agentId}.observations: ${own.length - FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT} of ${own.length} `
        + `observations dropped; retrieve them with \`${retrieval}\``,
      );
    }
    emittedObservations += kept.length;

    agentRecords.push({
      agent_id: agentId,
      observations: kept,
      domains: byDomain,
      state: rollUp(own),
      healthy,
      complete,
      truncated: clipped,
      retrieval,
      lifecycle,
      member_class: memberClass,
      scaffold: scaffoldSummary,
      profile: profileSummary,
      systemd: systemdSummary,
    });
  }
  // The extras clip belongs to the HOST finding, which is always emitted.
  truncated.push(...profileExtrasNotes);
  // The same for the unregistered-unit clip (story 1.8).
  truncated.push(...systemdUnregisteredNotes);

  // -- fleet-scoped observations, emitted once, on the domain they belong to --
  const fleetObservations: FleetStatusObservation[] = [];
  if (needsProvenance) {
    for (const fact of provenanceFacts) {
      if (fact.scope !== "fleet") continue;
      const { domain } = classifyFact(ctx, fact);
      if (!domainSet.has(domain)) continue;
      fleetObservations.push(factObservation(ctx, fact, domain, null));
    }
    fleetObservations.sort((a, b) => (
      a.domain < b.domain ? -1 : a.domain > b.domain ? 1
        : a.field < b.field ? -1 : a.field > b.field ? 1
          : a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0
    ));
    ctx.observations.push(...fleetObservations);
    totalObservations += fleetObservations.length;
    emittedObservations += fleetObservations.length;
  }

  // -- domain rollups: every selected domain, always ------------------------
  const host = [...hostByRule.values()]
    .map(({ finding, states }) => {
      if (states.size <= 1) return finding;
      // The disagreement is DATA. An operator told only the worst reading would
      // have no way to know that 27 repositories reported something else.
      const spread = [...states.entries()]
        .sort((a, b) => stateRank(a[0]) - stateRank(b[0]))
        .map(([state, count]) => `${count} ${state}`)
        .join(", ");
      return {
        ...finding,
        details: boundedDetails([
          ...finding.details,
          `repositories disagreed on this host rule (${spread}); the worst reading is reported`,
        ]),
      };
    })
    .sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));
  const domainRollups: FleetStatusDomainRollup[] = domains.map((domain) => {
    const perDomain = ctx.observations.filter((item) => item.domain === domain);
    const counts = Object.fromEntries(FLEET_STATUS_STATES.map((state) => [state, 0])) as Record<FleetStatusState, number>;
    for (const item of perDomain) counts[item.state] += 1;
    return {
      domain,
      state: rollUp(perDomain),
      counts,
      agents: new Set(perDomain.map((item) => item.agent_id).filter((id): id is string => id !== null)).size,
      observations: fleetObservations.filter((item) => item.domain === domain),
    };
  });

  // -- contradictions: keep every reading, resolve none of them --------------
  //
  // A generalization of the host block's worst-wins accumulator, over every
  // `(agent_id, domain, field)` two SOURCES answered for and disagreed about.
  // Neither reading is dropped and neither is chosen for being the more
  // favourable one; the worse state has already won the rollup, and the
  // disagreement is recorded as its own finding so an operator can see that the
  // rollup was a decision rather than an observation.
  const contradictions = detectContradictions(ctx.observations);
  for (const contradiction of contradictions) {
    addFinding(ctx, {
      code: "status-contradiction",
      domain: contradiction.domain,
      field: contradiction.field,
      agent_id: contradiction.agent_id,
      source: ctx.authority.ownerOf(contradiction.field) ?? ctx.domainOwner(contradiction.domain),
      severity: "error",
      statusSeverity: "high",
      gating: true,
      detail: `${contradiction.detail}; joined observations ${contradiction.finding_ids.join(", ")}`,
    });
  }

  // GATING IMPACT, THEN SEVERITY, THEN SCOPE, THEN AGENT, THEN DOMAIN, THEN ID
  // -- and applied BEFORE any cap, on both output paths. The previous order was
  // `(field, code, agent, detail)`, which is stable but says nothing about
  // priority: a gating finding at position 26 of an unsorted list is silently
  // dropped by the human report's cap of 25, which is precisely the "one
  // high-volume domain hides a higher-priority blocker" failure this sort
  // exists to prevent.
  // SORTED, THEN CAPPED, and the truncation note is written from the result --
  // not before the contradiction loop above, which is where the cap is most
  // likely to be reached first. Written early, the note could be absent while
  // `totals.findings` counted the drops, so the envelope disagreed with itself
  // and `health.truncated` read false over a run that had discarded gating
  // findings.
  const ranked = [...ctx.findings].sort(compareStatusFindings);
  const findings = ranked.slice(0, FLEET_STATUS_MAX_FINDINGS);
  const droppedFindings = ranked.length - findings.length;
  if (droppedFindings > 0) {
    truncated.push(
      `findings: ${droppedFindings} of ${ranked.length} findings dropped; `
      + "the list is ranked by gating impact and severity before the cap, so the ones kept are the ones that matter",
    );
  }
  const probes = [...ctx.probes].sort((a, b) => (
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0
  ));

  // -- baseline correlation: read-only, and nothing is persisted -------------
  //
  // Diffed over EVERY observation this run built, not over the ones the record
  // caps let through: a transition is a conclusion, and a bound on what the
  // envelope carries must never move what it concludes. Computed before the
  // aggregate so a transitions clip reaches `health.truncated` like every other
  // clip does.
  const transitions: FleetStatusTransition[] = baselinePath === null
    ? []
    : boundTransitions(diffFindings(baselineSnapshots, snapshotCurrent(ctx.observations, host)), truncated);

  const byState = Object.fromEntries(FLEET_STATUS_STATES.map((state) => [state, 0])) as Record<FleetStatusState, number>;
  for (const item of ctx.observations) byState[item.state] += 1;

  // `collection_errors` is "sources this run could not read at all", and a
  // registry that declares no agents is one of them -- which is also what stops
  // `complete` from reading true over zero observations.
  const collectionErrors = probes.filter((record) => record.outcome !== "ok" && record.kind === "audit").length
    + (wantsAudit && auditEntry === null ? 1 : 0)
    + (inventory.totals.registered_agents === 0 ? 1 : 0);

  const totals: FleetStatusTotals = {
    agents: inventory.totals.registered_agents,
    emitted_agents: agentRecords.length,
    observations: totalObservations,
    emitted_observations: emittedObservations,
    host_findings: host.length,
    findings: ranked.length,
    audits_attempted: auditsAttempted,
    audits_observed: auditsObserved,
    by_state: byState,
  };

  // THREE verdicts now, and the first two are story 1.4's, unchanged.
  //
  // `healthy` is still `fail === 0 && error === 0` -- about the fleet being
  // wrong. `complete` is still about this run not having seen all of it, and
  // gains exactly ONE new conjunct, `contradictions === 0`, which can only ever
  // make it falser: two sources disagreeing means the run did not establish
  // what is true, whatever either of them said. `verdict` is the aggregate
  // built on top of both, and it is what the report headline and
  // `exit_category` lead with -- so "healthy" can no longer be claimed over an
  // unread fleet while `healthy` itself keeps the meaning 1.4 pinned.
  //
  // Host-scoped findings are in NONE of the three: a machine condition is not a
  // fleet failure, and reporting it as one is the category error PJAN-84 fixed.
  // They DO reach the justification gate (story 1.7): an unjustified host warn
  // -- an unclassified profile-root entry -- keeps the fleet from claiming
  // proof, without ever making it unhealthy.
  const health = evaluateFleetHealth({
    observations: ctx.observations,
    hostFindings: host,
    members,
    collectionErrors,
    contradictions: contradictions.length,
    truncated: truncated.length > 0,
    scope,
    totalAgents: totals.agents,
    emittedAgents: totals.emitted_agents,
    policy,
    domainStates: new Map(domainRollups.map((rollup) => [rollup.domain, rollup.state])),
  });

  // The fleet-level scaffold summary. `null` when the domain was not selected,
  // so a `--domain profile` consumer sees the key and knows nothing was read.
  // `unobserved` is every registered agent this run did not select plus every
  // selected one the observer never reached -- a scoped answer says so in its
  // own numbers rather than reading as fleet-wide parity.
  const scaffold: FleetScaffoldSummary | null = !domainSet.has("template_scaffold")
    ? null
    : {
      source: scaffoldParity === null
        ? { gitlink: null, integrity: "manifest-undeclared", detail: "the fleet contract declares no scaffold_manifest, so no role directory was compared" }
        : {
          gitlink: scaffoldParity.source.gitlink,
          integrity: bounded(scaffoldParity.source.integrity),
          detail: bounded(redactHome(scaffoldParity.source.detail)),
        },
      agents: {
        ...scaffoldCounts,
        unobserved: scaffoldCounts.unobserved + (scaffoldCounts.total_registered - scaffoldCounts.selected),
      },
      rule_agreement: { ...ruleAgreement },
    };

  // The fleet-level profile summary (story 1.7). `null` when the domain was
  // not selected. `extras.coverage` says whether the root was swept at all:
  // an `--agent` run inspects one registered profile and never enumerates the
  // root, and says so rather than reading as an empty sweep.
  const profile: FleetProfileSummary | null = !domainSet.has("profile")
    ? null
    : {
      source: SOURCE_PROFILE,
      root: profileHealth === null
        ? { state: "unsupported", code: "manifest-undeclared" }
        : { state: profileHealth.root.state === "ok" ? "pass" : "error", code: bounded(profileHealth.root.code, 64) },
      renderer: {
        source: profileHealth === null ? "manifest-undeclared" : bounded(profileHealth.renderer.source, 64),
        python: profileHealth === null ? "not-probed" : bounded(profileHealth.renderer.python, 64),
        gitlink: profileHealth?.renderer.gitlink ?? null,
        ...profileRenderer,
      },
      agents: {
        ...profileCounts,
        unobserved: profileCounts.unobserved + (profileCounts.total_registered - profileCounts.selected),
      },
      identity: { ...profileIdentity },
      skills: { ...profileSkills },
      extras: (() => {
        const items = profileHealth?.extras?.items ?? [];
        const byClass = Object.fromEntries(FLEET_PROFILE_EXTRA_CLASSES.map((klass) => [klass, items.filter((item) => item.class === klass).length])) as Record<FleetProfileExtraClass, number>;
        return {
          coverage: profileHealth?.extras ? "swept" as const : "not-swept" as const,
          reason: profileHealth === null ? "manifest-undeclared" : profileHealth.extras ? null : bounded(profileHealth.extrasReason ?? "not-swept", 64),
          entries_total: items.length,
          by_class: byClass,
          listed: Math.min(items.length, FLEET_STATUS_MAX_ITEMS),
          truncated: profileHealth?.extras?.truncated ?? false,
        };
      })(),
      rule_agreement: { ...profileRuleAgreement },
    };

  // The fleet-level systemd summary (story 1.8). `null` when the domain was
  // not selected. `shared.coverage` and `unregistered.coverage` say whether the
  // fleet-scope halves were probed at all: an `--agent` run samples one agent's
  // units and lists nothing, and says so rather than reading as a healthy
  // shared gateway beside an empty sweep.
  const systemd: FleetSystemdSummary | null = !domainSet.has("systemd")
    ? null
    : {
      source: SOURCE_SYSTEMD,
      manager: systemdHealth === null
        ? { state: "manifest-undeclared", code: "manifest-undeclared" }
        : { state: bounded(systemdHealth.manager.state, 64), code: systemdHealth.manager.code },
      window: systemdHealth === null
        ? { samples: 0, interval_ms: 0 }
        : { ...systemdHealth.window },
      units: systemdHealth === null ? { listed: 0, unit_files: 0, transient: 0 } : { ...systemdHealth.units },
      agents: {
        ...systemdCounts,
        unobserved: systemdCounts.unobserved + (systemdCounts.total_registered - systemdCounts.selected),
      },
      capability: { ...systemdCapability },
      shared: {
        coverage: systemdHealth === null || systemdHealth.shared.state === "unobserved" ? "unobserved" as const : "observed" as const,
        unit: systemdHealth?.shared.unit ?? null,
        profile: systemdHealth?.shared.profile ?? null,
        state: systemdHealth === null ? "unobserved" : systemdHealth.shared.state,
        code: systemdHealth === null ? "manifest-undeclared" : systemdHealth.shared.code === null ? null : bounded(systemdHealth.shared.code, 64),
      },
      unregistered: (() => {
        const items = systemdHealth?.unregistered?.items ?? [];
        const byClass = Object.fromEntries(FLEET_SYSTEMD_UNREGISTERED_CLASSES.map((klass) => [klass, items.filter((item) => item.class === klass).length])) as Record<FleetSystemdUnregisteredClass, number>;
        return {
          coverage: systemdHealth?.unregistered ? "swept" as const : "not-swept" as const,
          reason: systemdHealth === null ? "manifest-undeclared" : systemdHealth.unregistered ? null : bounded(systemdHealth.unregisteredReason ?? "not-swept", 64),
          total: items.length,
          by_class: byClass,
          listed: Math.min(items.length, FLEET_STATUS_MAX_ITEMS),
          truncated: systemdHealth?.unregistered?.truncated ?? false,
        };
      })(),
      rule_agreement: { ...systemdRuleAgreement },
    };

  return {
    contract_path: shownPath(contractPath),
    contract_version: contract.contract_version,
    scope,
    totals,
    health,
    agents: agentRecords,
    domains: domainRollups,
    host,
    findings,
    probes,
    transitions,
    scaffold,
    profile,
    systemd,
    truncated,
  };
}
