// Registry-wide, strictly read-only fleet PROVENANCE.
//
// Story 1.2 answers "what is the fleet"; this answers "which build is each
// agent actually running?" -- the question the live fleet fails today. 21 of 28
// agents point `hermes.bin` at a legacy `~/.hermes/hermes-agent` checkout whose
// origin is NousResearch/hermes-agent, while the configured pin is
// delorenj/hermes-agent at a different SHA; 13 declare a `hermes.repo` that does
// not exist; 21 carry no `hermes.git_sha` at all.
//
// ONE GLOBAL RULE, and everything else follows from it:
//
//   `desired` is the RECORDED / PINNED / DECLARED side.
//   `observed` is the LIVE side.
//
// That is what makes the template-gitlink fact structural rather than
// defensive. The recorded gitlink is read from `git ls-files --stage` on the
// PARENT repository and lands in `desired`, so no amount of worktree movement,
// local rendering, or test activity can move it; `observed` is the submodule's
// own HEAD. A reader never has to ask which side is authoritative.
//
// Four disciplines make the answer trustworthy rather than merely printable:
//
//   * ABSENCE IS NEVER A MATCH. `missing`, `unsupported` and `unobserved` are
//     distinct from `match` in the fact, in `totals.by_status`, and in `health`.
//     A failed probe downgrades its own fact and leaves every other agent and
//     domain intact.
//   * NOTHING IS EXECUTED THAT IS BEING OBSERVED. The observed `hermes` binary
//     is classified by PATH against the contract's retired `detect` patterns and
//     the configured release root. It is never run, and nothing here fetches,
//     pulls, clones, or touches the network.
//   * NOTHING IS WRITTEN. Every git probe passes `--no-optional-locks` (a plain
//     `git status` refreshes `.git/index`, which the suite's content+mtime
//     snapshot catches as a write) and the only subcommands used are
//     `ls-files`, `rev-parse`, `remote get-url` and `status --porcelain`.
//   * CREDENTIALS ARE EXCLUDED BY CONSTRUCTION. `~/.hermes/fleet.env` carries
//     two live Plane API keys. It is read only through `readShellAssignments`
//     with a key allowlist, so an unlisted key never enters memory -- there is
//     no redaction pass here that can be forgotten. Probes parse stdout into one
//     value and discard the rest; stderr is never read at all.
//
// `data` is DETERMINISTIC: no timestamp, duration, hostname, or ordering by
// completion. Two runs over identical state produce byte-identical `data`, which
// is what turns the CLI/MCP parity assertion into an equality rather than a
// resemblance.
//
// What this module deliberately does NOT do: probe systemd, live processes, or
// Bloodbank (the systemd observer is story 1.8's own module, and the other two
// are stories 1.9/1.10); compare scaffold or profile CONTENT against the
// template (stories 1.6/1.7); or repair, adopt, retire, or plan anything.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadFleetContract, resolveFleetContractPath, validateFleetContract } from "./contract";
import {
  buildAuthorityIndex,
  classifyPath,
  collectFleetInventory,
  readAgentRegistryRaw,
  resolveInventoryStores,
  type FleetAuthorityIndex,
  type FleetInventoryOptions,
} from "./inventory";
import { bounded, redactHome } from "./output";
import { mapBounded, probe, remainingMs, throwIfCancelled, type FleetRunContext } from "./runtime";
import {
  FLEET_PROVENANCE_MAX_FACTS,
  FLEET_PROVENANCE_MAX_PROBES,
  FLEET_PROVENANCE_SIDE_STATES,
  FLEET_PROVENANCE_STATUS_PRECEDENCE,
  FLEET_PROVENANCE_STATUSES,
  FleetError,
  type FleetContract,
  type FleetInventoryFinding,
  type FleetInventoryScope,
  type FleetPathClassification,
  type FleetProbeOutcome,
  type FleetProbeRecord,
  type FleetProvenance,
  type FleetProvenanceFact,
  type FleetProvenanceHealth,
  type FleetProvenanceSide,
  type FleetProvenanceSideState,
  type FleetProvenanceSourceView,
  type FleetProvenanceStatus,
  type FleetProvenanceTotals,
} from "./types";
import { readShellAssignments } from "../kernel/paths";
import { readTomlScalar, resolveTemplateConfigPath } from "../kernel/host-config";
import { resolveFlumeRoot } from "../kernel/paths";
import { ticketProviderFleetEnvPath } from "../kernel/paths";

/** Cap on findings carried in one envelope, so a drifted fleet stays one document. */
const MAX_FINDINGS = 2000;

/** How many checkout probes run at once. A fleet of 28 must not become 28 cold `git status` runs. */
const PROBE_CONCURRENCY = 4;

/** The host config file is a small generated TOML, not a data store. */
const CONFIG_MAX_BYTES = 1024 * 1024;

/** The tracked template submodule, as `.gitmodules` declares it. */
const TEMPLATE_SUBMODULE_PATH = "templates/hermes-agent";

/**
 * The `[fleet]` keys the configured pin is read from.
 *
 * Named here rather than inline so the pin's shape is one list: every key this
 * command reads out of the operator's template config, and nothing else.
 */
const PIN_KEYS = ["hermes_bin", "hermes_repo", "hermes_git_url", "hermes_git_ref", "hermes_git_sha", "fleet_env", "registry_file"] as const;

/**
 * The ONLY keys ever read out of `~/.hermes/fleet.env`.
 *
 * This is the credential guarantee. The live file carries `PLANE_33GOD_API_KEY`
 * and `PLANE_AUTOMATICAI_API_KEY`; `readShellAssignments` materialises exactly
 * the keys in this list, so neither name nor value ever exists in this process
 * to be leaked into an envelope, a report, or a finding.
 */
const FLEET_ENV_KEYS = ["HERMES_FLEET_HOME", "HERMES_FLEET_REPO", "HERMES_FLEET_BIN", "HERMES_FLEET_REGISTRY_FILE"] as const;

/** Source ids, used as stable `source` values on a fact side and as `sources[].id`. */
const SOURCE_TEMPLATE_CONFIG = "hermes-template-config";
const SOURCE_FLEET_ENV = "hermes-fleet-env";
const SOURCE_PJANGLER_REPO = "pjangler-repository";
const SOURCE_TEMPLATE_SUBMODULE = "hermes-agent-template-submodule";
const SOURCE_AGENT_REGISTRY = "hermes-agent-registry";
/**
 * A LIVE read of the checkout an agent row declares -- not the row itself.
 *
 * Held apart from `hermes-agent-registry` deliberately. The registry says which
 * directory to look at; everything read out of that directory is an observation
 * of the filesystem, and labelling it with the registry's id would make a probed
 * remote URL look like a recorded one.
 */
const SOURCE_AGENT_CHECKOUT = "hermes-agent-checkout";
/**
 * An invariant THIS COMMAND declares, named so it is never mistaken for a record.
 *
 * Exactly one thing is declared here: a checkout that something is pinned to
 * must be clean, because a dirty checkout is not a version anything can be
 * pinned to. No store, config file, or contract states that today, and
 * attributing it to one that does not would be inventing an authority.
 */
const SOURCE_PROVENANCE_POLICY = "pjangler-fleet-provenance";
const SOURCE_ROLE_SCAFFOLD = "hermes-agent-role-scaffold";

/** A value spelled with an unexpanded shell reference; comparing it would mean expanding it. */
const SHELL_REFERENCE = /\$\{?[A-Za-z_]/u;

export interface FleetProvenanceOptions extends FleetInventoryOptions {
  /** The run's deadline and cancellation budget. Required: every probe is bounded by it. */
  runContext: FleetRunContext;
  /**
   * Restrict live checkout probes to these agent ids. Omitted, every declared
   * checkout is probed.
   *
   * NOT a scope filter -- `agentId` is, and it filters EMISSION so totals stay
   * fleet-wide. This constrains COLLECTION, and exists for one caller: the
   * status core, whose contract is that a `--agent` scope must not spawn a probe
   * for an agent it will not report. `fleet provenance` itself never passes it,
   * so its own behaviour is unchanged; an agent outside the set simply reports
   * `unobserved` with a `skipped` probe record, which is the honest answer for a
   * checkout this run deliberately did not read.
   */
  probeAgentIds?: readonly string[];
  /**
   * Run only these probe families. Omitted, both run.
   *
   * The per-DOMAIN half of the same rule `probeAgentIds` enforces per agent. The
   * `template` family (the gitlink and submodule probes) produces only
   * `scaffold.*` facts, and the `checkout` family produces only `hermes.*` facts
   * -- so a status run scoped to one of those two domains was spawning the other
   * family's probes and discarding every fact they produced. Measured:
   * `--domain template_scaffold` and `--domain release_provenance` ran the
   * IDENTICAL probe set, `{checkout: 3, gitlink: 1, submodule: 1}`. Only the
   * status core passes this; `fleet provenance` runs both, unchanged.
   */
  probeFamilies?: readonly ("template" | "checkout")[];
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

// ---------------------------------------------------------------------------
// Fact sides and comparison
// ---------------------------------------------------------------------------

function present(value: string, source: string, extra: Partial<FleetProvenanceSide> = {}): FleetProvenanceSide {
  return { value: bounded(value), source, state: "present", family: null, classification: null, ...extra };
}

/** An absent value is explicitly null at an explicit state. Never a guess, never a blank string. */
function absent(source: string | null, state: FleetProvenanceSideState, extra: Partial<FleetProvenanceSide> = {}): FleetProvenanceSide {
  return { value: null, source, state, family: null, classification: null, ...extra };
}

/**
 * The status of one fact, from its two sides.
 *
 * Precedence, strongest first: `unobserved` > `unsupported` > `missing` >
 * `dirty` > `mismatch` > `match`. `unobserved` outranks everything because if
 * the probe did not run, nothing may be claimed -- that is the concrete form of
 * "the aggregate does not turn absence into a match".
 *
 * `dirty` reaches this function only through `mismatchStatus`, and only from a
 * CLEANLINESS fact. Cleanliness is always its own fact
 * (`template.worktree_clean`, `hermes.checkout_clean`) and never a modifier on a
 * value comparison, so `dirty` can never shadow a `mismatch` on the value beside
 * it.
 */
/**
 * Whether a status is also a state ONE SIDE can arrive in, rather than a verdict.
 *
 * The narrowed type is the INTERSECTION on purpose. `present` is a side state
 * and not a status; `match`, `mismatch` and `dirty` are statuses and not side
 * states. Only the three that are both may be read off a side.
 */
function isSideState(status: FleetProvenanceStatus): status is FleetProvenanceStatus & FleetProvenanceSideState {
  return (FLEET_PROVENANCE_SIDE_STATES as readonly string[]).includes(status);
}

export function compareFact(
  desired: FleetProvenanceSide,
  observed: FleetProvenanceSide,
  mismatchStatus: FleetProvenanceStatus = "mismatch",
): FleetProvenanceStatus {
  // Driven from the EXPORTED precedence constant, not from a second list spelled
  // out here. Both existed before this change and only this one was live, so
  // `FLEET_PROVENANCE_STATUS_PRECEDENCE` -- documented as the model's precedence
  // rule and re-exported from the barrel for consumers to reason with -- could be
  // reordered without moving any behaviour or failing any test. A constant that
  // constrains nothing is decoration; reading it here is what makes it the rule.
  //
  // Only the SIDE STATES participate: `dirty`, `mismatch` and `match` are
  // verdicts this function produces, never states a side can arrive in.
  for (const status of FLEET_PROVENANCE_STATUS_PRECEDENCE) {
    if (!isSideState(status)) continue;
    if (desired.state === status || observed.state === status) return status;
  }
  if (desired.value === null || observed.value === null) return "missing";
  return desired.value === observed.value ? "match" : mismatchStatus;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface ProvenanceSource {
  id: string;
  kind: string;
  configuredPath: string;
  inspectedPath: string;
  exists: boolean;
  parse: FleetProvenanceSourceView["parse"];
}

export interface ConfiguredPin {
  /** `[fleet]` scalars from the host template config, verbatim (a literal `~` is kept). */
  config: Partial<Record<(typeof PIN_KEYS)[number], string>>;
  /** Allowlisted `~/.hermes/fleet.env` assignments, UNEXPANDED. */
  env: Partial<Record<(typeof FLEET_ENV_KEYS)[number], string>>;
  /**
   * The directory every pinned release lives under, derived from `hermes_repo`.
   *
   * `~/.local/share/hermes-agent/releases/<sha>` -> `.../releases`. This is what
   * makes `classifyExecutableFamily` able to say "a pinned release, just not
   * THIS one" instead of falling through to the retired patterns, which match
   * every path with `hermes` in it under a home directory.
   */
  releaseRoot: string | null;
}

/**
 * Where every provenance source is, and whether this run could read it.
 *
 * Same configured/inspected split `data.stores` uses in the inventory: an
 * override says which bytes to read, never which file is canonical.
 */
export function resolveProvenanceSources(options: FleetProvenanceOptions): ProvenanceSource[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const stores = resolveInventoryStores(options);
  const root = resolveFlumeRoot();

  const file = (id: string, kind: string, configured: string, inspected = configured): ProvenanceSource => {
    let exists = false;
    let parse: ProvenanceSource["parse"] = "unread";
    try {
      const stat = lstatSync(inspected);
      exists = true;
      parse = stat.isFile() || stat.isDirectory() || stat.isSymbolicLink() ? "ok" : "unreadable";
    } catch {
      exists = false;
      parse = "unreadable";
    }
    return { id, kind, configuredPath: configured, inspectedPath: inspected, exists, parse };
  };

  return [
    file(SOURCE_TEMPLATE_CONFIG, "pin", resolveTemplateConfigPath(env, home)),
    file(SOURCE_FLEET_ENV, "shell-env", ticketProviderFleetEnvPath(env)),
    file(SOURCE_PJANGLER_REPO, "repository", root),
    file(SOURCE_TEMPLATE_SUBMODULE, "submodule", join(root, TEMPLATE_SUBMODULE_PATH)),
    file(SOURCE_AGENT_REGISTRY, "registry", stores.agents.configuredPath, stores.agents.inspectedPath),
  ];
}

/**
 * The configured pin: what this host says every agent SHOULD be running.
 *
 * `readTomlScalar` is deliberately minimal and returns undefined for anything it
 * cannot read confidently -- exactly the right `[fleet]` reader, because a pin
 * this command half-understood would be worse than no pin at all.
 * `readShellAssignments` is key-allowlisted, which is the credential guarantee.
 */
export function readConfiguredPin(sources: readonly ProvenanceSource[], home: string = homedir()): ConfiguredPin {
  const config: ConfiguredPin["config"] = {};
  const configSource = sources.find((source) => source.id === SOURCE_TEMPLATE_CONFIG);
  if (configSource?.exists) {
    let text = "";
    try {
      const stat = statSync(configSource.inspectedPath);
      if (stat.isFile() && stat.size <= CONFIG_MAX_BYTES) text = readFileSync(configSource.inspectedPath, "utf8");
    } catch { text = ""; }
    for (const key of PIN_KEYS) {
      const value = nonEmptyString(readTomlScalar(text, "fleet", key));
      if (value !== null) config[key] = value;
    }
  }

  const envSource = sources.find((source) => source.id === SOURCE_FLEET_ENV);
  const env: ConfiguredPin["env"] = {};
  if (envSource?.exists) {
    const found = readShellAssignments(envSource.inspectedPath, [...FLEET_ENV_KEYS]);
    for (const key of FLEET_ENV_KEYS) {
      const value = nonEmptyString(found[key]);
      if (value !== null) env[key] = value;
    }
  }

  const repo = config.hermes_repo ?? env.HERMES_FLEET_REPO ?? null;
  return { config, env, releaseRoot: deriveReleaseRoot(repo, home) };
}

/**
 * The directory a pinned release lives UNDER, or null when the pin does not
 * name one.
 *
 * Two bugs this replaces, both of which flipped the whole fleet's verdict:
 *
 *   * `~` WAS NOT EXPANDED. `readConfiguredPin` keeps config values verbatim by
 *     contract, and the live `config.toml` already spells `fleet_env` and
 *     `registry_file` with `~`. A `hermes_repo` written that way -- or the
 *     `HERMES_FLEET_REPO` fallback, which is unexpanded by definition -- failed
 *     `isAbsolute` and produced `releaseRoot: null`. `classifyExecutableFamily`
 *     then fell through to the contract's retired patterns, which match `~/...`
 *     paths, and reported every CORRECTLY PINNED agent as retired drift with an
 *     `error`-severity finding.
 *   * THE PARENT WAS TAKEN UNCONDITIONALLY. `dirname` of a pin is only a
 *     release root when the pin is a release. A pin of `/home/me/code/hermes-agent`
 *     yielded `/home/me/code`, and every binary under `~/code/**` was then
 *     classified `pinned-release` -- silently disarming the contract's own
 *     `(?:^|/)code/hermes-agent` retired pattern, which is the exact drift the
 *     command exists to find.
 *
 * The guard is deliberately shallow: a release root has to be a real directory
 * with a parent above the home directory itself. Nothing here parses a version
 * or a SHA out of the path -- inventing structure the pin does not promise is
 * how the second bug was written in the first place.
 */
function deriveReleaseRoot(repo: string | null, home: string): string | null {
  if (!repo) return null;
  const expanded = expandHome(repo, home);
  if (!isAbsolute(expanded)) return null;
  const parent = dirname(expanded);
  // `dirname("/")` is `/`, `dirname("/home")` is `/`. A root that shallow -- or
  // one equal to the home directory -- would classify most of the filesystem as
  // the pinned release, so it is refused rather than narrowed.
  if (parent === expanded || parent === "/" || parent === home) return null;
  return parent;
}

// ---------------------------------------------------------------------------
// Executable and checkout family classification
// ---------------------------------------------------------------------------

/**
 * Which family a declared `hermes` path belongs to. NOTHING is executed.
 *
 * Order matters and is not cosmetic. The configured release root is checked
 * FIRST, because the contract's `hard-coded-hermes-checkout-path` patterns
 * (`~/[^\s]*hermes`, `(?:^|/)code/hermes-agent`) match the pinned release path
 * too -- it also lives under a home directory and also has `hermes` in it. Ask
 * the retired patterns first and every agent on this fleet, correct or not, is
 * classified as retired drift.
 *
 * Patterns are compiled the way `contract.ts` already compiles them --
 * `new RegExp(pattern, "iu")` inside try/catch, skipping anything that will not
 * compile -- so one bad pattern in an operator's contract cannot take the run
 * down, and it cannot silently match everything either.
 */
export function classifyExecutableFamily(rawPath: string | null, pin: ConfiguredPin, contract: FleetContract): string | null {
  if (!rawPath) return null;
  const shown = shownPath(rawPath);
  if (pin.releaseRoot) {
    const root = shownPath(pin.releaseRoot);
    if (shown === root || shown.startsWith(`${root}/`)) return "pinned-release";
  }
  for (const mode of contract.retired ?? []) {
    for (const pattern of mode.detect ?? []) {
      let expression: RegExp;
      try { expression = new RegExp(pattern, "iu"); } catch { continue; }
      // Both spellings: the contract's patterns are written against `~/...` and
      // `$HOME/...` as an operator writes them, while a registry stores the
      // absolute path. Testing only one form silently classified nothing.
      if (expression.test(shown) || expression.test(rawPath)) return mode.id;
    }
  }
  return "unclassified";
}

// ---------------------------------------------------------------------------
// Checkout probing
// ---------------------------------------------------------------------------

interface CheckoutObservation {
  /** The declared path, bounded and home-redacted. */
  target: string;
  classification: FleetPathClassification;
  /**
   * Whether the top-level guard passed and this checkout was read AT ALL.
   *
   * Distinct from `outcome`, and the distinction is load-bearing. `outcome` is
   * the worst of every sub-probe, so a checkout with no `origin` remote -- a
   * real, common state -- reports `failed`. Gating the HEAD and cleanliness
   * facts on THAT downgraded two independently observed values to `unobserved`
   * because a third one was absent. Each fact is gated on its own value below;
   * `reached` only says the directory was a repository root this run could open.
   */
  reached: boolean;
  outcome: FleetProbeOutcome;
  reason: string | null;
  remote: string | null;
  head: string | null;
  clean: boolean | null;
}

/**
 * `git --no-optional-locks -C <path> ...`, in that order.
 *
 * The flag has to precede `-C` (verified on git 2.51.0), and it is not optional
 * here: a plain `git status` WRITES `.git/index` to refresh it, which the
 * suite's content+mtime snapshot would catch as a write from a command whose
 * whole contract is that it writes nothing.
 */
function gitArgv(path: string, args: readonly string[]): string[] {
  return ["git", "--no-optional-locks", "-C", path, ...args];
}

/**
 * Observe one checkout without following it anywhere it did not declare.
 *
 * The top-level equality guard is the load-bearing part. `git -C <path>` WALKS
 * UP: `git -C src rev-parse --show-toplevel` inside this repository answers the
 * repository root. Verified. Without the guard, an agent whose `hermes.repo`
 * points at a subdirectory -- or at any path that merely happens to sit inside
 * some unrelated repository -- inherits that repository's remote and HEAD and
 * reports them as its own provenance. So: `rev-parse --show-toplevel` must
 * realpath-equal the probed directory, or the checkout is `not-a-repository-root`
 * and NOTHING is read from it.
 */
async function probeCheckout(ctx: FleetRunContext, declared: string, home: string): Promise<CheckoutObservation> {
  const target = shownPath(declared);
  const base: CheckoutObservation = {
    target, classification: "undeclared", reached: false, outcome: "skipped", reason: null,
    remote: null, head: null, clean: null,
  };

  const expanded = expandHome(declared, home);
  if (!isAbsolute(expanded)) return { ...base, classification: "relative", reason: "relative-path" };
  const view = classifyPath(expanded, { directory: true });
  const classification = view.classification;
  if (classification !== "ok" && classification !== "symlink") {
    return { ...base, classification, reason: classification };
  }

  const toplevel = await probe(ctx, gitArgv(expanded, ["rev-parse", "--show-toplevel"]));
  if (toplevel.outcome !== "ok" || !toplevel.value) {
    return {
      ...base, classification,
      outcome: toplevel.outcome === "ok" ? "failed" : toplevel.outcome,
      reason: toplevel.outcome === "timeout" ? "probe-timeout" : toplevel.outcome === "cancelled" ? "probe-cancelled" : "probe-failed",
    };
  }
  const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
  if (canonical(toplevel.value) !== canonical(expanded)) {
    // Deliberately reported as SKIPPED rather than failed: the probe ran and
    // answered; this command declined the answer. An operator reading
    // `outcome: "failed"` would go looking for a broken git.
    return { ...base, classification, outcome: "skipped", reason: "not-a-repository-root" };
  }

  const [remote, head, status] = await Promise.all([
    probe(ctx, gitArgv(expanded, ["remote", "get-url", "origin"])),
    probe(ctx, gitArgv(expanded, ["rev-parse", "HEAD"])),
    probe(ctx, gitArgv(expanded, ["status", "--porcelain"])),
  ]);

  // A checkout with no `origin` remote is a real, reportable state, not a
  // failure of this command: `remote get-url` exits nonzero and the identity
  // fact goes `unobserved`. HEAD and cleanliness are independent and survive it.
  const worst = [remote.outcome, head.outcome, status.outcome].find((outcome) => outcome !== "ok") ?? "ok";
  return {
    target,
    classification,
    reached: true,
    outcome: worst,
    reason: worst === "ok" ? null : worst === "timeout" ? "probe-timeout" : worst === "cancelled" ? "probe-cancelled" : "probe-failed",
    remote: remote.outcome === "ok" ? remote.value : null,
    head: head.outcome === "ok" ? head.value : null,
    // `""` is the porcelain answer for a clean tree, so `status.value || null`
    // would report a clean checkout as unobserved -- the one reading this fact
    // exists to distinguish.
    clean: status.outcome === "ok" ? status.value === "" : null,
  };
}

// ---------------------------------------------------------------------------
// Fact assembly
// ---------------------------------------------------------------------------

interface ProvenanceContext {
  contract: FleetContract;
  authority: FleetAuthorityIndex;
  pin: ConfiguredPin;
  /** The run's budget, carried so every probe this context starts is bounded by the same one. */
  run: FleetRunContext;
  home: string;
  facts: FleetProvenanceFact[];
  probes: FleetProbeRecord[];
  findings: FleetInventoryFinding[];
  droppedFacts: number;
  droppedProbes: number;
  droppedFindings: number;
  /** Field paths already reported as carrying no declared owner, so one gap is one finding. */
  undeclaredFields: Set<string>;
}

function addFinding(ctx: ProvenanceContext, finding: FleetInventoryFinding): void {
  if (ctx.findings.length >= MAX_FINDINGS) { ctx.droppedFindings += 1; return; }
  ctx.findings.push({ ...finding, detail: bounded(finding.detail) });
}

function addProbe(ctx: ProvenanceContext, record: FleetProbeRecord): void {
  if (ctx.probes.length >= FLEET_PROVENANCE_MAX_PROBES) { ctx.droppedProbes += 1; return; }
  ctx.probes.push({ ...record, id: bounded(record.id), target: bounded(record.target) });
}

/**
 * Attribute a field path to the authority the CONTRACT declares for it.
 *
 * Walks up the dotted path only when the exact leaf is undeclared, and records
 * the gap once per path rather than once per agent. Nothing is invented: a path
 * with no declared ancestor reports `owner: null` and says so. Declaring the
 * host-config paths is story 1.1's surface, and this story's Block If forbids
 * inventing one -- see DW-49.
 */
function ownerFor(ctx: ProvenanceContext, fieldPath: string): string | null {
  const exact = ctx.authority.ownerOf(fieldPath);
  if (exact !== null) return exact;
  const segments = fieldPath.split(".");
  for (let end = segments.length - 1; end > 0; end -= 1) {
    const owner = ctx.authority.ownerOf(segments.slice(0, end).join("."));
    if (owner !== null) return owner;
  }
  if (!ctx.undeclaredFields.has(fieldPath)) {
    ctx.undeclaredFields.add(fieldPath);
    addFinding(ctx, {
      code: "authority-owner-undeclared",
      field: fieldPath,
      agent_id: null,
      source: null,
      severity: "warn",
      detail: "the contract declares no authority owner for this field path or any of its parents; provenance is reported with owner null and is never attributed to a guess",
    });
  }
  return null;
}

function addFact(
  ctx: ProvenanceContext,
  fact: Omit<FleetProvenanceFact, "owner" | "status"> & { status?: FleetProvenanceStatus; mismatchStatus?: FleetProvenanceStatus },
): void {
  if (ctx.facts.length >= FLEET_PROVENANCE_MAX_FACTS) { ctx.droppedFacts += 1; return; }
  const { mismatchStatus, status, ...rest } = fact;
  ctx.facts.push({
    ...rest,
    owner: ownerFor(ctx, fact.field),
    status: status ?? compareFact(fact.desired, fact.observed, mismatchStatus ?? "mismatch"),
    detail: bounded(fact.detail),
  });
}

/** A `{value, source, state}` side built from a raw registry scalar. */
function registrySide(raw: unknown, source: string, extra: Partial<FleetProvenanceSide> = {}): FleetProvenanceSide {
  const value = nonEmptyString(raw);
  return value === null ? absent(source, "missing", extra) : present(value, source, extra);
}

/** A `{value, source, state}` side built from a configured pin scalar. */
function pinSide(value: string | undefined, source: string, extra: Partial<FleetProvenanceSide> = {}): FleetProvenanceSide {
  return value === undefined ? absent(source, "missing", extra) : present(value, source, extra);
}

/** A path side: bounded, home-redacted, and carrying what the path IS. */
function pathSide(raw: unknown, source: string, home: string, extra: Partial<FleetProvenanceSide> = {}): FleetProvenanceSide {
  const value = nonEmptyString(raw);
  if (value === null) return absent(source, "missing", extra);
  const view = classifyPath(expandHome(value, home), { directory: true });
  return present(shownPath(value), source, { classification: view.classification, ...extra });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

interface AgentSubject {
  agentId: string;
  hermes: Record<string, unknown>;
  roleDir: string | null;
  profileName: string | null;
}

/** Every `agents:` entry that is usable as a provenance subject, in stable id order. */
function agentSubjects(entries: ReturnType<typeof readAgentRegistryRaw>["entries"]): AgentSubject[] {
  const subjects: AgentSubject[] = [];
  for (const entry of entries) {
    const raw = isRecord(entry.value) ? entry.value : {};
    subjects.push({
      agentId: entry.key,
      hermes: isRecord(raw.hermes) ? raw.hermes : {},
      roleDir: nonEmptyString(raw.role_dir),
      profileName: nonEmptyString(raw.profile_name),
    });
  }
  return subjects.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}

/**
 * The tracked template's recorded gitlink versus the worktree that is checked out.
 *
 * `desired` comes from `git ls-files --stage` on the PARENT: that is the SHA the
 * repository has committed, and it cannot move when the worktree does. `observed`
 * is the submodule's own HEAD. The only existing reader of this gitlink is
 * `scripts/check-submodule-contract.mjs` -- a non-importable `.mjs` using
 * `spawnSync` with no timeout at all -- so the read goes through the bounded
 * probe runner instead.
 */
async function addTemplateFacts(ctx: ProvenanceContext, root: string): Promise<void> {
  const submodule = join(root, TEMPLATE_SUBMODULE_PATH);
  const field = "scaffold";

  const staged = await probe(ctx.run, gitArgv(root, ["ls-files", "--stage", "--", TEMPLATE_SUBMODULE_PATH]));
  addProbe(ctx, {
    id: `gitlink:${shownPath(root)}`,
    kind: "gitlink",
    target: shownPath(root),
    outcome: staged.outcome,
    reason: staged.outcome === "ok" ? null : staged.outcome === "timeout" ? "probe-timeout" : staged.outcome === "cancelled" ? "probe-cancelled" : "probe-failed",
  });
  // `160000 <sha> 0\ttemplates/hermes-agent`. Anything else -- a blank answer, a
  // regular-file mode -- is not a gitlink and must not be reported as one.
  const parsed = /^160000\s+([0-9a-f]{40})\s/u.exec(staged.value ?? "");
  const desiredGitlink = parsed
    ? present(parsed[1]!, SOURCE_PJANGLER_REPO)
    : absent(SOURCE_PJANGLER_REPO, staged.outcome === "ok" ? "missing" : "unobserved");

  const checkout = await probeCheckout(ctx.run, submodule, ctx.home);
  addProbe(ctx, {
    id: `submodule:${checkout.target}`,
    kind: "submodule",
    target: checkout.target,
    outcome: checkout.outcome,
    reason: checkout.reason,
  });

  addFact(ctx, {
    id: "template.gitlink", scope: "fleet", agent_id: null, field,
    desired: desiredGitlink,
    observed: checkout.head ? present(checkout.head, SOURCE_TEMPLATE_SUBMODULE) : absent(SOURCE_TEMPLATE_SUBMODULE, "unobserved"),
    detail: `the committed gitlink for ${TEMPLATE_SUBMODULE_PATH} against the commit its worktree has checked out`,
  });

  const declaredUrl = readSubmoduleUrl(root, TEMPLATE_SUBMODULE_PATH);
  addFact(ctx, {
    id: "template.remote_url", scope: "fleet", agent_id: null, field,
    desired: declaredUrl ? present(declaredUrl, SOURCE_PJANGLER_REPO) : absent(SOURCE_PJANGLER_REPO, "missing"),
    observed: checkout.remote ? present(checkout.remote, SOURCE_TEMPLATE_SUBMODULE) : absent(SOURCE_TEMPLATE_SUBMODULE, "unobserved"),
    detail: `the remote .gitmodules declares for ${TEMPLATE_SUBMODULE_PATH} against the remote its worktree points at`,
  });

  addFact(ctx, {
    id: "template.worktree_clean", scope: "fleet", agent_id: null, field,
    desired: present("clean", SOURCE_PROVENANCE_POLICY),
    observed: checkout.clean === null
      ? absent(SOURCE_TEMPLATE_SUBMODULE, "unobserved")
      : present(checkout.clean ? "clean" : "dirty", SOURCE_TEMPLATE_SUBMODULE),
    mismatchStatus: "dirty",
    detail: "whether the tracked template worktree carries uncommitted changes; a dirty template is not a version anything can be pinned to",
  });
}

/** `.gitmodules` is a tracked ini file; only the `url` of one declared path is read. */
function readSubmoduleUrl(root: string, path: string): string | null {
  const file = join(root, ".gitmodules");
  if (!existsSync(file)) return null;
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  let inSection = false;
  let url: string | null = null;
  let sectionPath: string | null = null;
  let sectionUrl: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      if (sectionPath === path && sectionUrl) url = sectionUrl;
      inSection = line.startsWith("[submodule");
      sectionPath = null;
      sectionUrl = null;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "path") sectionPath = value;
    if (key === "url") sectionUrl = value;
  }
  if (sectionPath === path && sectionUrl) url = sectionUrl;
  return url;
}

/**
 * The host's two recorded pins, against each other.
 *
 * `~/.config/hermes-agent-template/config.toml` is what the provisioner reads;
 * `~/.hermes/fleet.env` is what every agent launcher sources. Both are recorded,
 * so the config is `desired` (the declaration) and the env is `observed` (what
 * the fleet actually sources). They agree on this host today for `hermes_bin`
 * and `hermes_repo`, and that is worth PROVING rather than assuming.
 */
function addHostPinFacts(ctx: ProvenanceContext): void {
  const pairs: Array<[string, (typeof PIN_KEYS)[number], (typeof FLEET_ENV_KEYS)[number], string]> = [
    ["fleet.hermes_bin", "hermes_bin", "HERMES_FLEET_BIN", "the shared hermes executable the template config pins against the one every agent launcher sources"],
    ["fleet.hermes_repo", "hermes_repo", "HERMES_FLEET_REPO", "the pinned release checkout the template config declares against the one the fleet env exports"],
    ["fleet.registry_file", "registry_file", "HERMES_FLEET_REGISTRY_FILE", "the agent registry the template config names against the one the fleet env exports"],
  ];
  for (const [id, configKey, envKey, detail] of pairs) {
    const rawConfig = ctx.pin.config[configKey];
    const rawEnv = ctx.pin.env[envKey];
    const desired = pinSide(rawConfig === undefined ? undefined : shownPath(expandHome(rawConfig, ctx.home)), SOURCE_TEMPLATE_CONFIG);
    // Reported UNEXPANDED, always. `HERMES_FLEET_REGISTRY_FILE` is written as
    // `$HERMES_FLEET_HOME/agents-registry.yaml` on this host, and expanding it
    // would be this command inventing a value the file does not contain. It is
    // classified instead: a comparison that needs an expansion is `unsupported`,
    // which keeps it out of the drift counters AND out of `match`.
    const unexpanded = rawEnv !== undefined && SHELL_REFERENCE.test(rawEnv);
    const observed = rawEnv === undefined
      ? absent(SOURCE_FLEET_ENV, "missing")
      : unexpanded
        ? present(rawEnv, SOURCE_FLEET_ENV, { state: "unsupported", family: "shell-variable-reference" })
        : present(shownPath(expandHome(rawEnv, ctx.home)), SOURCE_FLEET_ENV);
    addFact(ctx, {
      id, scope: "fleet", agent_id: null, field: id,
      desired,
      observed,
      detail: unexpanded
        ? `${detail}; the fleet env spells it with an unexpanded shell reference, reported verbatim and never expanded`
        : detail,
    });
  }
}

/** Every per-agent fact except the ones that need a live checkout. */
function addAgentRecordFacts(ctx: ProvenanceContext, subject: AgentSubject): void {
  const { agentId, hermes } = subject;
  const pin = ctx.pin.config;

  const executable = registrySide(hermes.bin, SOURCE_AGENT_REGISTRY);
  if (executable.value !== null) {
    executable.classification = classifyPath(expandHome(executable.value, ctx.home)).classification;
    executable.family = classifyExecutableFamily(nonEmptyString(hermes.bin), ctx.pin, ctx.contract);
    executable.value = shownPath(nonEmptyString(hermes.bin)!);
  }
  addFact(ctx, {
    id: "hermes.executable", scope: "agent", agent_id: agentId, field: "agents.{agent_id}.hermes.bin",
    desired: pinSide(pin.hermes_bin === undefined ? undefined : shownPath(pin.hermes_bin), SOURCE_TEMPLATE_CONFIG, { family: "pinned-release" }),
    observed: executable,
    detail: "the hermes executable this agent's launcher execs, against the one the host config pins; the binary is classified by path and never run",
  });
  if (executable.family && executable.family !== "pinned-release" && executable.family !== "unclassified") {
    addFinding(ctx, {
      code: "hermes-executable-retired-family",
      field: "agents.{agent_id}.hermes.bin",
      agent_id: agentId,
      source: ctx.authority.ownerOf("agents.{agent_id}.hermes.bin"),
      severity: "error",
      detail: `the declared executable matches the retired mode ${executable.family}; pinned releases are resolved from the registry, never from a path`,
    });
  }

  const repository = pathSide(hermes.repo, SOURCE_AGENT_REGISTRY, ctx.home);
  if (repository.value !== null) repository.family = classifyExecutableFamily(nonEmptyString(hermes.repo), ctx.pin, ctx.contract);
  addFact(ctx, {
    id: "hermes.repository", scope: "agent", agent_id: agentId, field: "agents.{agent_id}.hermes.repo",
    desired: pinSide(pin.hermes_repo === undefined ? undefined : shownPath(pin.hermes_repo), SOURCE_TEMPLATE_CONFIG, { family: "pinned-release" }),
    observed: repository,
    detail: "the hermes checkout this agent declares, against the pinned release the host config declares",
  });

  for (const [id, key, pinKey, detail] of [
    ["hermes.git_url", "git_url", "hermes_git_url", "the hermes remote this agent's row records, against the configured pin"],
    ["hermes.git_ref", "git_ref", "hermes_git_ref", "the hermes ref this agent's row records, against the configured pin"],
    ["hermes.git_sha", "git_sha", "hermes_git_sha", "the hermes commit this agent's row records, against the configured pin"],
  ] as const) {
    const observed = registrySide(hermes[key], SOURCE_AGENT_REGISTRY);
    addFact(ctx, {
      id, scope: "agent", agent_id: agentId, field: `agents.{agent_id}.hermes.${key}`,
      desired: pinSide(pin[pinKey], SOURCE_TEMPLATE_CONFIG),
      observed,
      detail: observed.state === "missing"
        ? `${detail}; the registry row records none, so the configured pin cannot be confirmed`
        : detail,
    });
  }

  addFact(ctx, {
    id: "hermes.fleet_env", scope: "agent", agent_id: agentId, field: "agents.{agent_id}.hermes.fleet_env",
    desired: pinSide(pin.fleet_env === undefined ? undefined : shownPath(expandHome(pin.fleet_env, ctx.home)), SOURCE_TEMPLATE_CONFIG),
    observed: pathSide(hermes.fleet_env, SOURCE_AGENT_REGISTRY, ctx.home),
    detail: "the fleet env file this agent's row records, against the one the host config declares",
  });
}


/** The three checkout facts, from one deduplicated probe of the declared repository. */
function addCheckoutFacts(ctx: ProvenanceContext, subject: AgentSubject, observation: CheckoutObservation | null): void {
  const { agentId } = subject;
  // The checkout's own field path -- the row key that named the DIRECTORY these
  // facts probe. Used for the path classification and the dirty finding.
  const field = "agents.{agent_id}.hermes.repo";
  // ...but each VALUE comparison is attributed to the field it actually compares.
  // All three facts used to carry `hermes.repo`, so `owner` and any consumer
  // grouping by `field` filed the origin-URL and HEAD comparisons under the
  // repo-path field -- a fact saying which URL it read, labelled with the key
  // that only ever held a directory.
  const identityField = "agents.{agent_id}.hermes.git_url";
  const headField = "agents.{agent_id}.hermes.git_sha";
  const pin = ctx.pin.config;

  const unobserved = (extra: Partial<FleetProvenanceSide> = {}): FleetProvenanceSide =>
    absent(SOURCE_AGENT_CHECKOUT, "unobserved", { classification: observation?.classification ?? null, ...extra });

  const reached = observation !== null && observation.reached;
  /** Present when THIS value was read; unobserved when it alone was not. */
  const observedValue = (value: string | null): FleetProvenanceSide =>
    reached && value !== null ? present(value, SOURCE_AGENT_CHECKOUT, { classification: observation.classification }) : unobserved();
  /** Why one value is absent, said about that value rather than about the checkout. */
  const why = (what: string, present_: boolean): string | null => {
    if (observation === null) return "the row declares no hermes checkout to probe";
    if (!reached) return `the declared checkout was not read (${observation.reason ?? "unreachable"})`;
    return present_ ? null : `the declared checkout was read, but ${what} could not be`;
  };

  addFact(ctx, {
    id: "hermes.checkout_identity", scope: "agent", agent_id: agentId, field: identityField,
    desired: pinSide(pin.hermes_git_url, SOURCE_TEMPLATE_CONFIG),
    observed: observedValue(reached ? observation.remote : null),
    detail: reached
      ? (why("its origin remote", observation.remote !== null) ?? "the remote the declared checkout actually points at, against the configured pin")
      : `${why("its origin remote", false)}; no other repository's identity is reported for this agent`,
  });

  addFact(ctx, {
    id: "hermes.checkout_head", scope: "agent", agent_id: agentId, field: headField,
    desired: pinSide(pin.hermes_git_sha, SOURCE_TEMPLATE_CONFIG),
    observed: observedValue(reached ? observation.head : null),
    detail: why("its HEAD", reached && observation.head !== null)
      ?? "the commit the declared checkout has checked out, against the configured pin",
  });

  addFact(ctx, {
    id: "hermes.checkout_clean", scope: "agent", agent_id: agentId, field,
    desired: present("clean", SOURCE_PROVENANCE_POLICY),
    observed: observedValue(reached && observation.clean !== null ? (observation.clean ? "clean" : "dirty") : null),
    mismatchStatus: "dirty",
    detail: why("its working tree state", reached && observation.clean !== null)
      ?? "whether the declared checkout carries uncommitted changes",
  });

  if (reached && observation.clean === false) {
    addFinding(ctx, {
      code: "hermes-checkout-dirty",
      field,
      agent_id: agentId,
      source: ctx.authority.ownerOf(field),
      severity: "warn",
      detail: `the declared checkout ${observation.target} carries uncommitted changes; a dirty checkout is not a version anything can be pinned to`,
    });
  }
  if (observation !== null && observation.outcome !== "ok") {
    addFinding(ctx, {
      code: "provenance-probe-incomplete",
      field,
      agent_id: agentId,
      source: ctx.authority.ownerOf(field),
      severity: "warn",
      detail: `the declared checkout ${observation.target} could not be observed (${observation.reason ?? observation.outcome}); its identity facts are unobserved rather than assumed`,
    });
  }
}

/**
 * The whole fleet's provenance, as the recorded sources and the live host state it.
 *
 * Drift is DATA, not a command failure: `validateFleetEnvelope` nulls `data` on
 * `ok:false`, so reporting a mismatched fleet as a failure would blank the
 * report on exactly the runs that matter. A drifted fleet is `ok:true`, exit 0,
 * `health.healthy:false`. Only a COMMAND failure -- an unreadable source, an
 * unknown `--agent`, a bad flag, a blown deadline, a cancellation -- throws.
 */
export async function collectFleetProvenance(options: FleetProvenanceOptions): Promise<FleetProvenance> {
  const runContext = options.runContext;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  throwIfCancelled(runContext);

  const contractPath = resolveFleetContractPath(options.contract);
  const loaded = loadFleetContract(contractPath);
  const validation = validateFleetContract(loaded.document);
  const first = validation.diagnostics[0];
  if (!validation.contract || first) {
    throw new FleetError(
      first?.code ?? "INVALID_INPUT",
      `fleet contract is not usable: ${first ? `${first.path}: ${first.message}` : "validation produced no contract"}`,
      false,
      { contract_path: shownPath(contractPath) },
    );
  }
  const contract = validation.contract;

  // Story 1.2's core, called rather than reimplemented: it owns registry
  // reading, tolerant parsing, path classification, and the registered-agent
  // count, and this story's Never list forbids rebuilding any of that here. The
  // raw store is read beside it because a ROW carries home-redacted, bounded
  // projections for display -- correct for an inventory, unopenable for a probe.
  const inventory = collectFleetInventory({ ...options, agentId: undefined, runContext });
  const stores = resolveInventoryStores(options);
  const agentRaw = readAgentRegistryRaw(stores.agents.inspectedPath);
  throwIfCancelled(runContext);

  const sources = resolveProvenanceSources(options);
  const pin = readConfiguredPin(sources, home);
  const authority = buildAuthorityIndex(contract);
  const root = resolveFlumeRoot();

  const ctx: ProvenanceContext = {
    contract, authority, pin, home, run: runContext,
    facts: [], probes: [], findings: [],
    droppedFacts: 0, droppedProbes: 0, droppedFindings: 0,
    undeclaredFields: new Set<string>(),
  };

  for (const source of sources) {
    if (source.exists) continue;
    addFinding(ctx, {
      code: "provenance-source-missing",
      field: source.id,
      agent_id: null,
      source: null,
      severity: source.id === SOURCE_TEMPLATE_CONFIG ? "error" : "warn",
      detail: `${source.id} is not present at ${shownPath(source.inspectedPath)}; every fact whose desired side comes from it reports missing rather than a guess`,
    });
  }
  for (const key of ["hermes_git_url", "hermes_git_ref", "hermes_git_sha"] as const) {
    if (pin.config[key] !== undefined) continue;
    addFinding(ctx, {
      code: "provenance-pin-missing",
      field: `fleet.${key}`,
      agent_id: null,
      source: null,
      severity: "error",
      detail: `the host template config declares no [fleet] ${key}; there is no pin to compare any agent against and none is invented`,
    });
  }

  const families = options.probeFamilies === undefined ? null : new Set(options.probeFamilies);
  const wantsTemplateProbes = families === null || families.has("template");
  const wantsCheckoutProbes = families === null || families.has("checkout");

  if (wantsTemplateProbes) await addTemplateFacts(ctx, root);
  addHostPinFacts(ctx);

  const subjects = agentSubjects(agentRaw.entries);

  // Deduplicated by canonical path BEFORE probing: 9 agents share
  // `~/.hermes/hermes-agent` on this fleet, and probing it 9 times would be 27
  // redundant child processes and 9 identical probe records.
  const byCanonical = new Map<string, string>();
  const probeScope = options.probeAgentIds === undefined ? null : new Set(options.probeAgentIds);
  for (const subject of subjects) {
    if (!wantsCheckoutProbes) break;
    if (probeScope !== null && !probeScope.has(subject.agentId)) continue;
    const declared = nonEmptyString(subject.hermes.repo);
    if (declared === null) continue;
    const expanded = expandHome(declared, home);
    let key: string;
    try { key = realpathSync(expanded); } catch { key = resolve(expanded); }
    if (!byCanonical.has(key)) byCanonical.set(key, declared);
  }
  const targets = [...byCanonical.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // `remainingMs` throws TIMEOUT/CANCELLED, which are command failures and must
  // escape this whole function rather than degrade a fact.
  remainingMs(runContext);
  const observations = await mapBounded(targets, PROBE_CONCURRENCY, async ([, declared]) => probeCheckout(runContext, declared, home));
  const byDeclared = new Map<string, CheckoutObservation>();
  targets.forEach(([canonical, declared], index) => {
    const observation = observations[index]!;
    byDeclared.set(canonical, observation);
    addProbe(ctx, {
      id: `checkout:${observation.target}`,
      kind: "checkout",
      target: observation.target,
      outcome: observation.outcome,
      reason: observation.reason,
    });
    void declared;
  });

  for (const subject of subjects) {
    throwIfCancelled(runContext);
    addAgentRecordFacts(ctx, subject);
    const declared = nonEmptyString(subject.hermes.repo);
    let observation: CheckoutObservation | null = null;
    if (declared !== null) {
      const expanded = expandHome(declared, home);
      let key: string;
      try { key = realpathSync(expanded); } catch { key = resolve(expanded); }
      observation = byDeclared.get(key) ?? null;
    }
    addCheckoutFacts(ctx, subject, observation);
  }

  // -- deterministic ordering ------------------------------------------------
  // `(scope, agent_id, id)` is both the array key and the sort order. Fleet
  // facts lead because they are the fleet-wide claims every agent fact is read
  // against; within a scope it is byte order, never locale order.
  ctx.facts.sort((a, b) => {
    const rank = (fact: FleetProvenanceFact): number => (fact.scope === "fleet" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const left = a.agent_id ?? "";
    const right = b.agent_id ?? "";
    if (left !== right) return left < right ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  ctx.probes.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  const findings = [...ctx.findings].sort((a, b) => (
    a.field < b.field ? -1 : a.field > b.field ? 1
      : a.code < b.code ? -1 : a.code > b.code ? 1
        : (a.agent_id ?? "") < (b.agent_id ?? "") ? -1 : (a.agent_id ?? "") > (b.agent_id ?? "") ? 1
          : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0
  ));

  // -- health, from EVERY fact, before any scope filter ----------------------
  // A slice that could report healthy while the fleet is drifted is the one
  // thing an aggregate must never do, so the verdict is fleet-wide even under
  // `--agent`. Carried unchanged from story 1.2.
  const byStatus = Object.fromEntries(FLEET_PROVENANCE_STATUSES.map((status) => [status, 0])) as Record<FleetProvenanceStatus, number>;
  for (const fact of ctx.facts) byStatus[fact.status] += 1;
  const probeFailures = ctx.probes.filter((record) => record.outcome === "failed" || record.outcome === "timeout" || record.outcome === "cancelled").length;

  // -- scope -----------------------------------------------------------------
  const wanted = options.agentId?.trim();
  let scope: FleetInventoryScope = { kind: "fleet", agent_id: null, label: "whole registered fleet" };
  let selected = ctx.facts;
  if (wanted) {
    if (!subjects.some((subject) => subject.agentId === wanted)) {
      throw new FleetError("NOT_FOUND", "No agent with that id is registered", false, { agent_id: bounded(wanted, 128) });
    }
    selected = ctx.facts.filter((fact) => fact.scope === "fleet" || fact.agent_id === wanted);
    scope = { kind: "agent", agent_id: bounded(wanted, 128), label: `scoped to agent ${bounded(wanted, 128)}` };
  }

  // `selected` is a FILTER of `ctx.facts`, and `addFact` already refuses to push
  // past the cap, so a post-filter `facts.length > FLEET_PROVENANCE_MAX_FACTS`
  // branch could never run -- it looked like the truncation path while the real
  // one is `droppedFacts` below. Removed rather than left as reassuring dead
  // code that would report a second, different message for the same clip.
  const truncated: string[] = [];
  const facts = selected;
  if (ctx.droppedFacts > 0) truncated.push(`facts: ${ctx.droppedFacts} of ${ctx.facts.length + ctx.droppedFacts} facts dropped`);
  if (ctx.droppedProbes > 0) truncated.push(`probes: ${ctx.droppedProbes} of ${ctx.probes.length + ctx.droppedProbes} probes dropped`);
  if (ctx.droppedFindings > 0) truncated.push(`findings: ${ctx.droppedFindings} of ${findings.length + ctx.droppedFindings} findings dropped`);

  const totals: FleetProvenanceTotals = {
    // `facts` counts every fact BUILT, `classified_facts` every fact that
    // reached a status bucket, and `dropped_facts` the difference. Before this
    // they were one number: `facts` added `droppedFacts` while `by_status`
    // counted only `ctx.facts`, so the suite's own stated invariant --
    // "every fact lands in exactly one status bucket", asserted as
    // `sum(by_status) === totals.facts` -- was true only while the 5000-fact cap
    // did not engage, and would have started failing on the first fleet large
    // enough to trip it. A dropped fact has no status; saying so is cheaper than
    // an invariant that quietly stops holding at scale.
    agents: inventory.totals.registered_agents,
    facts: ctx.facts.length + ctx.droppedFacts,
    classified_facts: ctx.facts.length,
    dropped_facts: ctx.droppedFacts,
    emitted_facts: facts.length,
    probes: ctx.probes.length + ctx.droppedProbes,
    by_status: byStatus,
    findings: findings.length + ctx.droppedFindings,
  };

  const health: FleetProvenanceHealth = {
    // DRIFT ONLY, and that now means only drift. `unsupported` is a declared,
    // permanent gap in what this host records, and `unobserved` is a gap in what
    // could be reached -- both are reported in their own counters and in
    // `complete`, and neither is drift.
    //
    // `truncated` used to be folded in here too, which made a clipped but
    // entirely drift-free run report `healthy: false` -- exactly the conflation
    // the two-verdict split exists to prevent, and a direct contradiction of
    // both the type's own doc comment and the README ("healthy (drift-free)").
    // Clipping is an incompleteness, so it belongs to `complete` alone.
    healthy: byStatus.mismatch === 0 && byStatus.dirty === 0 && byStatus.missing === 0,
    complete: byStatus.unobserved === 0 && probeFailures === 0 && truncated.length === 0,
    mismatched: byStatus.mismatch,
    dirty: byStatus.dirty,
    missing: byStatus.missing,
    unsupported: byStatus.unsupported,
    unobserved: byStatus.unobserved,
    probe_failures: probeFailures,
    truncated: truncated.length > 0,
  };

  return {
    contract_path: shownPath(contractPath),
    contract_version: contract.contract_version,
    scope,
    sources: sources.map((source): FleetProvenanceSourceView => ({
      id: source.id,
      kind: source.kind,
      configured_path: shownPath(source.configuredPath),
      inspected_path: shownPath(source.inspectedPath),
      exists: source.exists,
      parse: source.parse,
    })),
    totals,
    health,
    facts,
    probes: ctx.probes,
    findings,
    truncated,
  };
}
