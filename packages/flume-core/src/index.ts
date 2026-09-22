/**
 * The HR domain.
 *
 * Flume models the agent workforce as a company, and this module is where that
 * vocabulary is defined once so the rest of the codebase can stop saying "fleet".
 * Every name here has exactly one mechanical counterpart; the mapping is in the
 * README and is enforced by `contracts/handbook.yaml`.
 */

/**
 * A job title -- i.e. a FUNCTION, not a class. See `EmploymentClass` below for
 * the other axis.
 *
 * This said `"pm"` and nothing else, while the live registry held five values
 * (pm, director, reporter, legal-assistant, tutor). A single-member union that
 * the data has already outgrown is not a constraint, it is a wrong comment the
 * compiler agrees with. Kept as an alias of `FunctionId` so the shape is open
 * to the functions the registry actually contains.
 */
export type Title = FunctionId;

/**
 * Where an employee works from: a real directory under the shared Hermes profile
 * root. Never a symlink into repo-local runtime state -- Hermes derives profile
 * identity from the UNRESOLVED path, so a symlinked desk reports as "default"
 * and silently loses shared fleet auth.
 */
export interface Desk {
  /** Profile name, conventionally `<repo>-<title>`. */
  readonly name: string;
  /** Absolute path to `~/.hermes/profiles/<name>`. */
  readonly path: string;
}

/**
 * One employee's row in the org chart -- the operational record in
 * `~/.hermes/agents-registry.yaml`. Flume is the only writer.
 */
export interface EmploymentRecord {
  readonly employeeId: string;
  /** What work they do. Composed from `roles/<title>.md`. */
  readonly title: Title;
  /**
   * What they may do, and whether they outlive a task. Absent on every row
   * written before the class model existed; treat a missing value as `"ic"` for
   * a function that writes code and `"pm"` otherwise, and BACKFILL rather than
   * inferring forever.
   */
  readonly employmentClass?: EmploymentClass;
  readonly displayName?: string;
  /** The project this employee is assigned to. */
  readonly repo: string;
  readonly projectPath: string;
  /** The tracked role scaffold inside that project. */
  readonly roleDir: string;
  readonly profileName: string;
  readonly provisionedAt?: string;
}

/** A deployed agent, as the company sees it. */
export interface Employee {
  readonly id: string;
  readonly title: Title;
  readonly employmentClass?: EmploymentClass;
  readonly desk: Desk;
  readonly record: EmploymentRecord;
}

/** The whole registry: every employee, plus the fleet-shared gateways. */
export interface OrgChart {
  readonly schemaVersion: number;
  readonly employees: readonly Employee[];
}

/**
 * The outcome of a performance review.
 *
 * `unableToAssess` is the load-bearing one. An observation that could not be
 * trusted -- a probe that timed out, a unit that never stabilised, a file that
 * could not be read -- is NOT a pass and is NOT a failure. Collapsing it into
 * either direction is how a fleet report starts lying, so it gets its own state.
 */
export type Standing = "inGoodStanding" | "onNotice" | "unableToAssess";

export const STANDINGS: readonly Standing[] = ["inGoodStanding", "onNotice", "unableToAssess"];

/** Human-facing label for a standing. */
export function describeStanding(standing: Standing): string {
  switch (standing) {
    case "inGoodStanding":
      return "in good standing";
    case "onNotice":
      return "on notice";
    case "unableToAssess":
      return "unable to assess";
  }
}

/**
 * Roll up many observations into one verdict.
 *
 * Order matters and is deliberate: a single failure outranks any number of
 * passes, and an unassessable observation outranks a clean sweep. Only an
 * all-pass review is in good standing.
 */
export function rollUpStanding(observations: readonly Standing[]): Standing {
  if (observations.some((o) => o === "onNotice")) return "onNotice";
  if (observations.some((o) => o === "unableToAssess")) return "unableToAssess";
  return "inGoodStanding";
}

/** Derive the conventional employee id for a repo and title. */
export function employeeId(repo: string, title: Title): string {
  return `${repo}-${title}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Employment class, and what it means to be bound
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An employment CLASS -- authority and durability, not job function.
 *
 * These are two different axes and the codebase had them conflated in four
 * places: `roles/` holds job functions (pm, dev, review, reporter), the registry
 * holds a mix (pm, director, reporter, legal-assistant, tutor), `Title` above
 * held only "pm", and the org diagram holds classes. `legal-assistant` is a
 * FUNCTION; the agent doing it is an `ic`. `director` is a CLASS that the
 * registry happens to store in the function column.
 *
 * Class answers "what may you do and how long do you live".
 * Function answers "what work do you do", and is what `roles/<fn>.md` composes.
 */
export type EmploymentClass = "director" | "pm" | "ic" | "contractor";

/** What work an employee does. Composed from `roles/<id>.md` at hire. */
export type FunctionId = "pm" | "dev" | "review" | "reporter" | string;

/**
 * What a class may do. Transcribed from the org diagram, with one revision:
 * the contractor DOES bind (see `Engagement`).
 *
 * | class      | code | memory | delegate       | binding            |
 * |------------|------|--------|----------------|--------------------|
 * | director   |  no  |  yes   | unrestricted   | domain/department  |
 * | pm         |  no  |  yes   | restricted     | repo/project       |
 * | ic         | yes  |  yes   | none           | repo/project       |
 * | contractor | yes  |  NO    | none           | engagement         |
 *
 * The two orchestrator classes cannot write code and the two worker classes
 * cannot delegate. That is not a coincidence -- it is the WIP=1 discipline
 * expressed as a type: an agent that can both delegate and implement will
 * eventually do both at once and stop being reviewable.
 */
export interface ClassCapabilities {
  readonly writesCode: boolean;
  readonly hasMemory: boolean;
  readonly delegates: "none" | "restricted" | "unrestricted";
  readonly bindsTo: "department" | "project" | "engagement";
  /** Whether an instance outlives the task that created it. */
  readonly durable: boolean;
}

const CAPABILITIES: Readonly<Record<EmploymentClass, ClassCapabilities>> = Object.freeze({
  director:   { writesCode: false, hasMemory: true,  delegates: "unrestricted", bindsTo: "department", durable: true  },
  pm:         { writesCode: false, hasMemory: true,  delegates: "restricted",   bindsTo: "project",    durable: true  },
  ic:         { writesCode: true,  hasMemory: true,  delegates: "none",         bindsTo: "project",    durable: true  },
  contractor: { writesCode: true,  hasMemory: false, delegates: "none",         bindsTo: "engagement", durable: false },
});

export function capabilitiesOf(employmentClass: EmploymentClass): ClassCapabilities {
  return CAPABILITIES[employmentClass];
}

/**
 * The statement of work. Written BEFORE the contractor exists, which is the
 * whole point: an ephemeral agent with no contract is just an unbounded spawn,
 * and unbounded spawns are how a workforce turns into a swarm. `hire` refuses a
 * contractor without one.
 */
export interface Contract {
  readonly id: string;
  /** What the contractor may touch. Anything outside is out of scope, not a judgement call. */
  readonly scope: readonly string[];
  /** How completion is decided -- by evidence, not by the contractor's own say-so. */
  readonly acceptance: readonly string[];
  /** After this, the engagement lapses and the contract must be rewritten. */
  readonly expiresAt?: string;
  /** Token or wall-clock ceiling for the whole engagement. */
  readonly budget?: { readonly tokens?: number; readonly minutes?: number };
}

/**
 * What accumulates across contractor instances -- and the honest answer to
 * "what does binding MEAN for something stateless".
 *
 * None of this is new storage. It is a VIEW over stores that already exist:
 * hindsight banks (company- and project-scoped), the repo's open-notebook, the
 * skillex manifests at both scopes, and the artifacts the work left in the repo.
 * The engagement is what gives those a single name and a lifetime.
 */
export interface EngagementSubstrate {
  /** What the work produced and left behind, in the project. */
  readonly artifacts: readonly string[];
  /** The project's open-notebook -- the long-form record a future contractor reads first. */
  readonly notebook?: string;
  /**
   * Hindsight banks this engagement reads and writes. Two scopes, deliberately:
   * `client` survives the project, `project` does not.
   */
  readonly banks: { readonly client?: string; readonly project: string };
  /**
   * The compounding part. A long client relationship produces skills that no
   * single engagement justifies writing -- client conventions, house style, the
   * shape of their stack. Those live at `client` scope and make every later
   * engagement with that client cheaper.
   */
  readonly skills: { readonly client: readonly string[]; readonly project: readonly string[] };
}

/**
 * The durable thing a contractor binds to.
 *
 * THE MODELLING MOVE: the contractor is not bound -- the ENGAGEMENT is bound,
 * and the contractor is bound to the engagement. That is what lets the agent be
 * genuinely stateless while the relationship is not. A consulting firm works the
 * same way: consultants rotate through, the engagement file does not.
 *
 * So the three bindings a real contractor has all hang here rather than on the
 * agent: the manager who hired them, the client work they were hired for, and
 * the contract that preceded the work.
 */
export interface Engagement {
  readonly id: string;
  /** Company scope. Survives any single project -- this is what makes skills compound. */
  readonly client: string;
  /** The project/repo this engagement delivers into. */
  readonly project: string;
  /** The agent who hired, reviews the work, and holds the WIP lease. The delegation edge. */
  readonly manager: string;
  readonly contract: Contract;
  readonly substrate: EngagementSubstrate;
  readonly openedAt: string;
  readonly closedAt?: string;
  /**
   * Every contractor instance that has worked this engagement. Contractors do
   * NOT get registry rows -- they are not on the org chart, any more than a
   * contractor appears on a company's org chart. The engagement's ledger is
   * where they are accounted for.
   */
  readonly ledger: readonly ContractorRun[];
}

/** One spawn. Stateless, scoped to a task, accounted to the engagement. */
export interface ContractorRun {
  readonly runId: string;
  readonly task: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome?: "delivered" | "rejected" | "abandoned";
  /** What this run added to the substrate. The reason the next run is cheaper. */
  readonly contributed?: readonly string[];
}

/**
 * Who may open an engagement: a PM, and only a PM.
 *
 * A director delegates unrestricted and could plausibly open engagements across
 * departments -- which is exactly why it may not. Contractor spend is governed
 * by the PM who owns the project the work lands in, so a director who wants a
 * contractor goes through that PM. The delegation edge and the budget edge are
 * then the same edge, and there is one person to ask why the money went.
 *
 * An IC cannot delegate at all, and a contractor opening engagements would be
 * the unbounded fan-out this whole model exists to prevent.
 */
export function mayOpenEngagement(openerClass: EmploymentClass, contract: Contract): true | string {
  if (openerClass !== "pm") {
    return `${openerClass} may not open an engagement; contractor spend is governed by the project's PM`;
  }
  if (contract.acceptance.length === 0) {
    return `contract ${contract.id} declares no acceptance criteria; completion would be self-reported`;
  }
  if (contract.scope.length === 0) {
    return `contract ${contract.id} declares no scope; an unscoped contractor is an unbounded one`;
  }
  return true;
}

/**
 * What a closed engagement leaves behind.
 *
 * The ledger is archived -- who worked, when, and how it went is an accounting
 * record, and accounting records are closed, not deleted.
 */
export interface EngagementArchive {
  readonly engagementId: string;
  readonly client: string;
  readonly project: string;
  readonly closedAt: string;
  readonly runs: readonly ContractorRun[];
  readonly delivered: number;
  readonly rejected: number;
  readonly abandoned: number;
}

/**
 * Close an engagement: archive the ledger, KEEP the substrate.
 *
 * This asymmetry is the whole point. The ledger is about the contractors and
 * they are gone; the substrate is about the client and the client is not. A
 * firm that deleted its client file every time an engagement ended would
 * re-learn the same codebase at full price forever -- which is precisely the
 * cost that binding an ephemeral agent exists to avoid.
 *
 * Returns the closed engagement and the archive separately so a caller can
 * store them apart: the archive is append-only history, the engagement is a
 * live record that `reopenEngagement` can build on.
 */
export function closeEngagement(
  engagement: Engagement,
  closedAt: string,
): { readonly engagement: Engagement; readonly archive: EngagementArchive } {
  const runs = engagement.ledger;
  const count = (outcome: ContractorRun["outcome"]) => runs.filter((run) => run.outcome === outcome).length;
  return {
    engagement: {
      ...engagement,
      closedAt,
      // Emptied here, preserved in the archive. Substrate is passed through
      // untouched by construction -- spreading `engagement` carries it.
      ledger: [],
    },
    archive: {
      engagementId: engagement.id,
      client: engagement.client,
      project: engagement.project,
      closedAt,
      runs,
      delivered: count("delivered"),
      rejected: count("rejected"),
      abandoned: count("abandoned"),
    },
  };
}

/**
 * Re-engage a client on work you have done before, carrying the substrate.
 *
 * Without this, keeping the substrate on close is inert -- nothing would ever
 * read it again. This is where the compounding actually lands: the new
 * engagement starts with the banks, the notebook and both skill scopes the
 * previous one accumulated, so the first contractor of the second engagement
 * ramps like the last contractor of the first.
 *
 * A fresh contract is mandatory. Prior work does not license future work, and
 * the scope that was right last quarter is not automatically right now.
 */
export function reopenEngagement(
  prior: Engagement,
  contract: Contract,
  openedAt: string,
  openerClass: EmploymentClass,
): Engagement | string {
  const permitted = mayOpenEngagement(openerClass, contract);
  if (permitted !== true) return permitted;
  if (!prior.closedAt) return `engagement ${prior.id} is still open; close it before re-engaging`;
  return {
    ...prior,
    id: `${prior.id}+${openedAt}`,
    contract,
    openedAt,
    closedAt: undefined,
    ledger: [],
    // The reason any of this exists.
    substrate: prior.substrate,
  };
}

/**
 * The guard. A contractor may only be spawned into an open engagement whose
 * contract has not lapsed.
 *
 * This is the type-level version of "a contract is written prior to commencing
 * work" -- and it is the thing that stops a contractor pool from becoming an
 * unbounded fan-out.
 */
export function mayEngage(engagement: Engagement, now: string): true | string {
  if (engagement.closedAt) return `engagement ${engagement.id} closed ${engagement.closedAt}`;
  const { expiresAt } = engagement.contract;
  if (expiresAt && expiresAt <= now) return `contract ${engagement.contract.id} expired ${expiresAt}`;
  if (engagement.contract.acceptance.length === 0) {
    return `contract ${engagement.contract.id} declares no acceptance criteria; completion would be self-reported`;
  }
  return true;
}
