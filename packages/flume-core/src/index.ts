/**
 * The HR domain.
 *
 * Flume models the agent workforce as a company, and this module is where that
 * vocabulary is defined once so the rest of the codebase can stop saying "fleet".
 * Every name here has exactly one mechanical counterpart; the mapping is in the
 * README and is enforced by `contracts/handbook.yaml`.
 */

/** A job title. The fleet has had exactly one for a while now. */
export type Title = "pm";

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
  readonly title: Title;
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
