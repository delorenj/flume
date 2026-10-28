/**
 * The org chart: the hierarchical tree of the workforce, from the CEO down.
 *
 * `flume org` was an alias on `roster` -- a flat list of employees with no
 * notion of who reports to whom. This module is the missing half. It answers
 * "what is the shape of the company", which no other reader in the repo could.
 *
 * TWO SOURCES, ONE ANSWER
 *
 *   * `~/.hermes/agents-registry.yaml` decides WHO EXISTS. It is written by the
 *     provisioner on every hire and is the only store that can be trusted about
 *     headcount. Nothing that is absent from it is ever rendered as a live node.
 *   * `~/.hermes/org.yaml` decides WHO REPORTS TO WHOM. It is hand-edited, it
 *     has no writer keeping it honest, and it drifts. Until 2026-09-20 it named
 *     seven agents that no longer existed and left eleven real ones unplaced.
 *
 * The drift between them is not smoothed over; it is the output. An org.yaml id
 * with no registry row is `phantom` and is listed, never drawn. A registry agent
 * org.yaml does not place is `unplaced`, is drawn anyway under a documented
 * default, and its edge is marked `~` so a reader can tell an inferred reporting
 * line from a recorded one. A tidy tree that quietly invents structure would be
 * worse than no tree, because it would be believed.
 *
 * PRECEDENCE, highest first:
 *
 *   1. the registry row's own optional `reports_to` -- the provisioner writes
 *      it, so it outranks anything hand-edited;
 *   2. org.yaml's `departments[].manager` / `departments[].members`, with its
 *      `reports_to` map nesting a placed member under another placed agent
 *      inside its department;
 *   3. the inferred default (see `inferParent`).
 *
 * `reports_to` does not exist in the registry schema today. It is honoured here
 * in advance rather than added later, because the alternative is a second pass
 * over this file the first time somebody writes the field and wonders why the
 * chart ignores it.
 *
 * THE DEFAULT, in full (it is org.yaml's own documented contract, and Holocene's
 * @holocene/org-model merge does the same): placed agents win; an agent nothing
 * places nests into the department of the placed agent whose `project_path` is
 * its deepest ancestor (else one sharing its exact path); anything still
 * unplaced falls into the declared `Unassigned` department. There is no
 * "the only director" rule: whether the fleet has one director or five is not
 * evidence about who an unrelated agent reports to, and the roles that make an
 * agent a director (`director`, `hr-director`, `workflows-director`, ...) are
 * not a closed set this module can enumerate.
 *
 * A DESK is `<registry dir>/profiles/<profile_name>`. A Hermes employee whose
 * registry row has no desk is drawn with a `[no desk]` marker and counted in the
 * footer: a row with no profile is a record of somebody who cannot work.
 *
 * READ-ONLY, with no exceptions. This module opens two files for reading, stats
 * one profile directory per Hermes employee, and touches nothing else: no
 * registry write, no org.yaml write, no directory created, no network, no
 * process probe. `flume org` must be safe to run at any moment, including in
 * the middle of a hire.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import { bold, cyan, dim, gray, green, magenta, red, yellow } from "../utils/style";
import { redactHome } from "./output";
import { FleetError, parkedChannels } from "./types";
import { resolveFleetHomeDir } from "../kernel/fleet-paths";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Either registry is a small hand-scale file; larger than this is an accident. */
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

/**
 * Depth cap for the renderer.
 *
 * Cycles are already broken while the tree is built, so this can only fire on a
 * bug in that code. It is here so the failure is a truncated branch with a
 * visible marker rather than a stack overflow that prints nothing at all.
 */
const MAX_RENDER_DEPTH = 64;

/** Sort ranks that order siblings; see `rankOf`. Lower sorts first. */
const RANK_DEPARTMENT_BASE = 0;
const RANK_MANAGER = 0;
const RANK_MEMBER_BASE = 1_000;
const RANK_REGISTRY_EDGE = 10_000;
const RANK_INFERRED = 20_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What a node stands for. Only `agent` nodes are employees. */
export type OrgNodeKind = "root" | "department" | "agent";

/**
 * Where this node's reporting line came from.
 *
 * `inferred` is the honest one: nothing recorded this edge, Flume chose it.
 */
export type OrgEdgeSource = "root" | "registry" | "org" | "inferred";

export interface OrgNode {
  /** Agent id (the registry's top-level key), department id, or the ceo id. */
  id: string;
  display_name: string;
  /** From org.yaml `personas`, the ceo block, or derived from the role. */
  title: string;
  /** Registry `role`: pm, director, tutor, reporter, legal-assistant, ... */
  role: string;
  /** Registry `type` (e.g. `hermes`); `unknown` when the row does not say. */
  type: string;
  /** Parent node id; null only for the root. */
  reports_to: string | null;
  children: OrgNode[];
  kind: OrgNodeKind;
  repo: string | null;
  project_path: string | null;
  /** Id of the department this node sits in, when it sits in one. */
  department: string | null;
  edge: OrgEdgeSource;
  /** True when `edge === "inferred"`; the render marks these with `~`. */
  inferred: boolean;
  /** Why this edge was chosen, when it is worth saying out loud. */
  note: string | null;
  /**
   * Whether the employee's Hermes profile directory exists. `n/a` for the root,
   * departments and any row whose runtime is not Hermes.
   */
  desk: OrgDeskState;
  /** Platforms the operator parked on purpose (`flume channel offline`). Visible, never a defect. */
  channels_offline: string[];
}

export type OrgDeskState = "present" | "missing" | "n/a";

/** Which input chose a source path; the header quotes it so a path is never anonymous. */
export type OrgPathVia = "option" | `env ${string}` | "default";

/** A `reports_to` that named something no node answers to. */
export interface OrgDanglingEdge {
  agent: string;
  reports_to: string;
  reason: string;
}

export interface OrgChartSources {
  registry_path: string;
  registry_present: boolean;
  /** Where `registry_path` resolves to when it is a symlink; equal to it otherwise. */
  registry_real_path: string;
  registry_via: OrgPathVia;
  org_path: string;
  org_present: boolean;
  org_real_path: string;
  org_via: OrgPathVia;
  org_version: number | null;
  /** The directory profiles (desks) are looked up under. */
  desk_root: string;
}

export interface OrgChartTotals {
  registry_rows: number;
  rendered_agents: number;
  placed: number;
  unplaced: number;
  /** Hermes employees with a registry row and no profile directory. */
  no_desk: number;
  phantom: number;
  hidden: number;
  departments: number;
}

export interface OrgChartResult {
  root: OrgNode;
  /** Every node in the tree, root first, in a stable pre-order walk. */
  nodes: OrgNode[];
  /** Agent ids whose reporting line was RECORDED (registry or org.yaml). */
  placed: string[];
  /** Agent ids org.yaml does not place; drawn under an inferred edge. */
  unplaced: string[];
  /** Hermes employees whose registry row has no profile directory (no desk). */
  no_desk: string[];
  /** Ids org.yaml names that the registry does not have. Never rendered. */
  phantom: string[];
  /** Ids org.yaml's `hidden:` list omits from the chart entirely. */
  hidden: string[];
  dangling: OrgDanglingEdge[];
  /** Reporting loops that had to be broken, as the ids that formed them. */
  cycles: string[][];
  warnings: string[];
  company: { name: string | null; handle: string | null };
  sources: OrgChartSources;
  totals: OrgChartTotals;
}

export interface BuildOrgChartOptions {
  /** Read this agent registry instead of the configured one. */
  registryPath?: string;
  /** Read this org.yaml instead of the configured one. */
  orgPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface FormatOrgChartOptions {
  /** Drop the header and footer, leaving only the tree. */
  bare?: boolean;
  /** Include the phantom / dangling / cycle detail blocks. Default true. */
  drift?: boolean;
}

// ---------------------------------------------------------------------------
// Tolerant readers
//
// Neither file is schema-validated anywhere, and org.yaml is hand-edited. A
// reader that throws on one malformed row turns "your org.yaml has a typo" into
// "flume org is broken", so every accessor below degrades to null and the
// problem surfaces as a warning on the rendered chart instead.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function readSource(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new FleetError("NOT_FOUND", `${label} could not be read at ${redactHome(path)}: ${(error as Error).message}`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
    throw new FleetError("INVALID_INPUT", `${label} at ${redactHome(path)} is larger than ${MAX_SOURCE_BYTES} bytes`);
  }
  try {
    return YAML.parse(text) as unknown;
  } catch (error) {
    throw new FleetError("INVALID_INPUT", `${label} at ${redactHome(path)} is not valid YAML: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Source resolution
//
// Deliberately local rather than borrowed from `resolveInventoryStores`, which
// also resolves the PROJECT registry and will reach the registry service to do
// it. The org chart needs two file paths and must not acquire a network
// dependency to get them. The agent-registry key order is kept identical to
// that function on purpose: two readers disagreeing about which file is the
// registry is precisely the class of bug this repo keeps paying for.
// ---------------------------------------------------------------------------

/** Which input chose the registry path; mirrors `resolveOrgRegistryPath` exactly. */
export function describeOrgRegistryVia(options: BuildOrgChartOptions = {}): OrgPathVia {
  const env = options.env ?? process.env;
  if (options.registryPath?.trim()) return "option";
  if (env.HERMES_AGENTS_REGISTRY?.trim()) return "env HERMES_AGENTS_REGISTRY";
  if (env.HERMES_FLEET_REGISTRY_FILE?.trim()) return "env HERMES_FLEET_REGISTRY_FILE";
  return "default";
}

/** Which input chose the hierarchy path; mirrors `resolveOrgHierarchyPath` exactly. */
export function describeOrgHierarchyVia(options: BuildOrgChartOptions = {}): OrgPathVia {
  const env = options.env ?? process.env;
  if (options.orgPath?.trim()) return "option";
  if (env.HERMES_ORG_PATH?.trim()) return "env HERMES_ORG_PATH";
  return "default";
}

function realPathOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Where the agent registry lives for this process. */
export function resolveOrgRegistryPath(options: BuildOrgChartOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const override = options.registryPath?.trim();
  if (options.registryPath !== undefined && !override) {
    throw new FleetError("INVALID_INPUT", "registryPath was given an empty value");
  }
  if (override) return resolve(expandHome(override, home));
  const configured = env.HERMES_AGENTS_REGISTRY?.trim() || env.HERMES_FLEET_REGISTRY_FILE?.trim();
  return resolve(expandHome(configured || join(resolveFleetHomeDir(env, home), "agents-registry.yaml"), home));
}

/** Where the hand-edited hierarchy lives; org.yaml documents HERMES_ORG_PATH itself. */
export function resolveOrgHierarchyPath(options: BuildOrgChartOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const override = options.orgPath?.trim();
  if (options.orgPath !== undefined && !override) {
    throw new FleetError("INVALID_INPUT", "orgPath was given an empty value");
  }
  if (override) return resolve(expandHome(override, home));
  const configured = env.HERMES_ORG_PATH?.trim();
  return resolve(expandHome(configured || join(home, ".hermes", "org.yaml"), home));
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface RegistryAgent {
  id: string;
  repo: string | null;
  role: string;
  type: string;
  display_name: string;
  project_path: string | null;
  /** The desk directory name under `profiles/`; the agent id when the row omits it. */
  profile_name: string;
  /** The optional per-row override. Absent from the schema today; honoured anyway. */
  reports_to: string | null;
  /** Platforms the operator parked on purpose; drawn as `[telegram offline]`. */
  channels_offline: string[];
}

interface RegistryRead {
  agents: Map<string, RegistryAgent>;
  warnings: string[];
}

function readRegistry(path: string): RegistryRead {
  const document = asRecord(readSource(path, "agent registry"));
  const warnings: string[] = [];
  const agents = new Map<string, RegistryAgent>();
  const block = asRecord(document?.agents);
  if (!block) {
    warnings.push(`agent registry at ${redactHome(path)} has no \`agents:\` mapping; the chart has no employees`);
    return { agents, warnings };
  }
  for (const [id, raw] of Object.entries(block)) {
    const key = id.trim();
    if (!key) continue;
    const row = asRecord(raw);
    if (!row) {
      warnings.push(`registry row \`${key}\` is not a mapping and was skipped`);
      continue;
    }
    agents.set(key, {
      id: key,
      repo: asString(row.repo),
      role: asString(row.role) ?? "unknown",
      // Not defaulted to "hermes": inventing a runtime for a row that does not
      // declare one is exactly the sort of tidy lie this module exists to avoid.
      type: asString(row.type) ?? "unknown",
      display_name: asString(row.display_name) ?? key,
      project_path: asString(row.project_path),
      profile_name: asString(row.profile_name) ?? key,
      reports_to: asString(row.reports_to),
      channels_offline: parkedChannels(row),
    });
  }
  return { agents, warnings };
}

// ---------------------------------------------------------------------------
// org.yaml
// ---------------------------------------------------------------------------

interface OrgDepartment {
  id: string;
  name: string;
  order: number;
  manager: string | null;
  members: string[];
}

interface OrgHierarchy {
  present: boolean;
  version: number | null;
  company: { name: string | null; handle: string | null };
  ceo: { id: string; display_name: string; title: string };
  personas: Map<string, string>;
  departments: OrgDepartment[];
  hidden: string[];
  /**
   * org.yaml's `reports_to` map: a reporting line INSIDE a department. The agent
   * keeps its department; only its parent node moves under the named manager.
   */
  reportsTo: Map<string, string>;
  /** org.yaml's own declared bucket for whatever stays unplaced. */
  unassigned: { id: string; name: string; order: number };
  warnings: string[];
}

const DEFAULT_CEO = { id: "ceo", display_name: "CEO", title: "Operator / CEO" } as const;
const DEFAULT_UNASSIGNED = { id: "unassigned", name: "Unassigned", order: 999 } as const;

function emptyHierarchy(): OrgHierarchy {
  return {
    present: false,
    version: null,
    company: { name: null, handle: null },
    ceo: { ...DEFAULT_CEO },
    personas: new Map(),
    departments: [],
    hidden: [],
    reportsTo: new Map(),
    unassigned: { ...DEFAULT_UNASSIGNED },
    warnings: [],
  };
}

function readHierarchy(path: string): OrgHierarchy {
  const result = emptyHierarchy();
  if (!existsSync(path)) {
    // Not an error. A fleet with no hand-edited hierarchy is a fleet whose whole
    // chart is inferred, and that is a legible, honestly-marked answer.
    result.warnings.push(`no hierarchy file at ${redactHome(path)}; every reporting line below is inferred`);
    return result;
  }
  const document = asRecord(readSource(path, "org hierarchy"));
  if (!document) {
    result.warnings.push(`hierarchy at ${redactHome(path)} is not a mapping; every reporting line below is inferred`);
    return result;
  }
  result.present = true;

  const version = document.version;
  result.version = typeof version === "number" && Number.isFinite(version) ? version : null;
  if (result.version !== null && result.version !== 1) {
    result.warnings.push(`hierarchy declares version ${result.version}; this build reads version 1`);
  }

  const company = asRecord(document.company);
  result.company = { name: asString(company?.name), handle: asString(company?.handle) };

  const ceo = asRecord(document.ceo);
  result.ceo = {
    id: asString(ceo?.id) ?? DEFAULT_CEO.id,
    display_name: asString(ceo?.display_name) ?? DEFAULT_CEO.display_name,
    title: asString(ceo?.title) ?? DEFAULT_CEO.title,
  };

  const personas = asRecord(document.personas);
  if (personas) {
    for (const [id, raw] of Object.entries(personas)) {
      const title = asString(asRecord(raw)?.title);
      if (title) result.personas.set(id.trim(), title);
    }
  }

  const seenDepartments = new Set<string>();
  asList(document.departments).forEach((raw, index) => {
    const entry = asRecord(raw);
    if (!entry) {
      result.warnings.push(`departments[${index}] is not a mapping and was skipped`);
      return;
    }
    const id = asString(entry.id);
    if (!id) {
      result.warnings.push(`departments[${index}] has no id and was skipped`);
      return;
    }
    if (seenDepartments.has(id)) {
      result.warnings.push(`department \`${id}\` is declared more than once; the first wins`);
      return;
    }
    seenDepartments.add(id);
    const order = entry.order;
    const members: string[] = [];
    for (const member of asList(entry.members)) {
      const memberId = asString(member);
      if (memberId) members.push(memberId);
    }
    result.departments.push({
      id,
      name: asString(entry.name) ?? id,
      order: typeof order === "number" && Number.isFinite(order) ? order : index + 1,
      manager: asString(entry.manager),
      members,
    });
  });
  result.departments.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

  for (const raw of asList(document.hidden)) {
    const id = asString(raw);
    if (id) result.hidden.push(id);
  }

  const reportsTo = asRecord(document.reports_to);
  if (reportsTo) {
    for (const [id, raw] of Object.entries(reportsTo)) {
      const manager = asString(raw);
      if (manager) result.reportsTo.set(id.trim(), manager);
      else result.warnings.push(`reports_to.${id} is not an agent id and was skipped`);
    }
  }

  const unassigned = asRecord(asRecord(document.defaults)?.unassigned_department);
  if (unassigned) {
    const order = unassigned.order;
    result.unassigned = {
      id: asString(unassigned.id) ?? DEFAULT_UNASSIGNED.id,
      name: asString(unassigned.name) ?? DEFAULT_UNASSIGNED.name,
      order: typeof order === "number" && Number.isFinite(order) ? order : DEFAULT_UNASSIGNED.order,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Where org.yaml puts an agent, and with what sibling rank. */
interface OrgPlacement {
  parent: string;
  department: string;
  rank: number;
}

/**
 * Index org.yaml's departments into one placement per agent id.
 *
 * A department with a manager nests its members UNDER the manager, which is what
 * makes this a tree rather than a two-level list. A department with no manager
 * (`finance`, `products`) keeps its members as direct children of the department
 * node, because inventing a boss for them would be a lie with a face on it.
 */
function indexPlacements(hierarchy: OrgHierarchy, warnings: string[]): Map<string, OrgPlacement> {
  const placements = new Map<string, OrgPlacement>();
  const claim = (id: string, placement: OrgPlacement): void => {
    const existing = placements.get(id);
    if (existing) {
      warnings.push(
        `\`${id}\` is placed twice in the hierarchy (${existing.department} and ${placement.department}); the first placement wins`,
      );
      return;
    }
    placements.set(id, placement);
  };

  for (const department of hierarchy.departments) {
    if (department.manager) {
      claim(department.manager, { parent: department.id, department: department.id, rank: RANK_MANAGER });
    }
    department.members.forEach((member, index) => {
      if (member === department.manager) {
        warnings.push(`\`${member}\` is both manager and member of \`${department.id}\`; kept as manager`);
        return;
      }
      claim(member, {
        parent: department.manager ?? department.id,
        department: department.id,
        rank: department.manager ? index : RANK_MEMBER_BASE + index,
      });
    });
  }

  // org.yaml's `reports_to` re-parents a placed agent under another placed agent and
  // keeps its department. Anything it cannot honour is a warning, never a guess.
  for (const [id, manager] of hierarchy.reportsTo) {
    const placement = placements.get(id);
    if (!placement) {
      warnings.push(`reports_to.${id}: \`${id}\` is not placed in any department; the line is ignored`);
      continue;
    }
    if (manager === id || !placements.has(manager)) {
      warnings.push(`reports_to.${id}: \`${manager}\` is not a placed agent; \`${id}\` stays where its department puts it`);
      continue;
    }
    let cursor: string | undefined = manager;
    const seen = new Set<string>([id]);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = hierarchy.reportsTo.get(cursor);
    }
    if (cursor) {
      warnings.push(`reports_to.${id}: following \`${manager}\` loops back; the line is ignored`);
      continue;
    }
    placement.parent = manager;
  }
  return placements;
}

/**
 * Is `ancestor` a directory prefix of `descendant`?
 *
 * Used only to make "nearest director" mean something. Plain string containment
 * would match `/home/x/code/foo` against `/home/x/code/foobar`, so the boundary
 * separator is part of the test.
 */
function isPathAncestor(ancestor: string | null, descendant: string | null): boolean {
  if (!ancestor || !descendant) return false;
  const base = resolve(ancestor);
  const target = resolve(descendant);
  return target !== base && target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

interface InferredEdge {
  parent: string;
  note: string;
}

/** A recorded placement that can vouch for where a neighbour belongs. */
interface PlacementEvidence {
  id: string;
  project_path: string | null;
  /** The declared department id the evidence agent sits in. */
  department: string;
}

/**
 * THE DOCUMENTED DEFAULT for an agent nothing places -- org.yaml's own contract,
 * and the same one Holocene's org-model merge applies. Kept in one function so
 * there is exactly one answer to "why is this agent here", and so the render can
 * quote the reason back on the node itself.
 *
 *   1. the agent nests into the department of the RECORDED placement whose
 *      `project_path` is the deepest directory containing theirs;
 *   2. failing that, into the department of a recorded placement at exactly the
 *      same path (a repo's PM and its scrum master share one directory);
 *   3. otherwise the declared `Unassigned` department. Not guessed.
 *
 * Only recorded placements are evidence. An inferred agent never vouches for
 * another, so one wrong guess cannot propagate down a chain of guesses.
 *
 * There is deliberately no "only director" rule and no "director reports to the
 * root" rule: a director is not evidence about who an unrelated employee
 * reports to, and a fleet with one `director` row can have four more directors
 * under other role names. Rule 3 is the important one: picking a boss to make
 * the tree look finished would produce a chart that reads as authoritative and
 * is not.
 *
 * `departmentParent` maps a declared department id to the node the member
 * hangs from (its manager when it has a live one, else the department node).
 */
function inferParent(
  agent: RegistryAgent,
  evidence: readonly PlacementEvidence[],
  departmentParent: (departmentId: string) => string | null,
  unassignedId: string,
): InferredEdge {
  const usable = evidence.filter((entry) => entry.id !== agent.id && entry.project_path && agent.project_path);
  const containing = usable
    .filter((entry) => isPathAncestor(entry.project_path, agent.project_path))
    .sort((left, right) => (right.project_path?.length ?? 0) - (left.project_path?.length ?? 0));
  for (const entry of containing) {
    const parent = departmentParent(entry.department);
    if (parent) {
      return { parent, note: `inferred: nested by project path under ${entry.id} (department ${entry.department})` };
    }
  }
  const sibling = usable.find(
    (entry) => entry.project_path && agent.project_path && resolve(entry.project_path) === resolve(agent.project_path),
  );
  if (sibling) {
    const parent = departmentParent(sibling.department);
    if (parent) {
      return { parent, note: `inferred: same project path as ${sibling.id} (department ${sibling.department})` };
    }
  }
  return {
    parent: unassignedId,
    note: agent.project_path
      ? "inferred: no recorded placement owns this project path; not guessed"
      : "inferred: no project path to nest by; not guessed",
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function titleFromRole(role: string): string {
  switch (role) {
    case "pm":
      return "Project Manager";
    case "director":
      return "Director";
    case "tutor":
      return "Tutor";
    case "reporter":
      return "Reporter";
    case "legal-assistant":
      return "Legal Assistant";
    default:
      return role === "unknown" ? "Employee" : role;
  }
}

function makeNode(partial: Partial<OrgNode> & Pick<OrgNode, "id" | "kind">): OrgNode {
  const edge: OrgEdgeSource = partial.edge ?? "inferred";
  return {
    display_name: partial.id,
    title: "",
    role: partial.kind,
    type: partial.kind,
    reports_to: null,
    children: [],
    repo: null,
    project_path: null,
    department: null,
    note: null,
    desk: "n/a",
    channels_offline: [],
    ...partial,
    edge,
    inferred: edge === "inferred",
  };
}

/**
 * Read both stores and reconcile them into one tree.
 *
 * Never throws for a drifted or malformed hierarchy -- that is the output, not a
 * failure. It throws only when the REGISTRY cannot be read, because without it
 * there is no authority on who exists and any tree would be fiction.
 */
export function buildOrgChart(options: BuildOrgChartOptions = {}): OrgChartResult {
  const registryPath = resolveOrgRegistryPath(options);
  const orgPath = resolveOrgHierarchyPath(options);

  const registry = readRegistry(registryPath);
  const hierarchy = readHierarchy(orgPath);
  const warnings = [...registry.warnings, ...hierarchy.warnings];

  const hiddenSet = new Set(hierarchy.hidden);
  const hidden = [...registry.agents.keys()].filter((id) => hiddenSet.has(id)).sort();
  for (const id of hierarchy.hidden) {
    if (!registry.agents.has(id)) {
      warnings.push(`hierarchy hides \`${id}\`, which the registry does not have anyway`);
    }
  }
  const visible = [...registry.agents.values()].filter((agent) => !hiddenSet.has(agent.id));

  // The root is a human; the registry has no row for the operator and should not.
  const root = makeNode({
    id: hierarchy.ceo.id,
    kind: "root",
    display_name: hierarchy.ceo.display_name,
    title: hierarchy.ceo.title,
    role: "ceo",
    type: "human",
    edge: "root",
  });

  // A desk is `<registry dir>/profiles/<profile_name>`. The registry's own
  // directory (after symlinks) is the fleet home, so the lookup follows the file
  // actually read.
  const deskRoot = join(dirname(realPathOrSelf(registryPath)), "profiles");
  const deskState = (agent: RegistryAgent): OrgDeskState => {
    if (agent.type !== "hermes") return "n/a";
    try {
      return statSync(join(deskRoot, agent.profile_name)).isDirectory() ? "present" : "missing";
    } catch {
      return "missing";
    }
  };

  const nodesById = new Map<string, OrgNode>([[root.id, root]]);
  const ranks = new Map<string, number>([[root.id, 0]]);

  // --- department nodes -----------------------------------------------------
  const departmentIds = new Set<string>();
  for (const department of hierarchy.departments) {
    let id = department.id;
    if (nodesById.has(id) || registry.agents.has(id)) {
      id = `dept:${department.id}`;
      warnings.push(`department \`${department.id}\` collides with an employee id; rendered as \`${id}\``);
    }
    departmentIds.add(id);
    const node = makeNode({
      id,
      kind: "department",
      display_name: department.name,
      title: "Department",
      role: "department",
      type: "department",
      reports_to: root.id,
      department: department.id,
      edge: "org",
    });
    nodesById.set(id, node);
    ranks.set(id, RANK_DEPARTMENT_BASE + department.order);
  }
  // org.yaml keys placements by its OWN department ids, so a collision-renamed
  // node needs a lookup from the declared id to the id actually in the tree.
  const departmentNodeId = new Map<string, string>();
  for (const department of hierarchy.departments) {
    const renamed = `dept:${department.id}`;
    departmentNodeId.set(department.id, nodesById.has(department.id) && departmentIds.has(department.id) ? department.id : renamed);
  }

  // The Unassigned bucket is created lazily: an empty "Unassigned" heading on a
  // fully-placed fleet is noise that reads like a finding.
  let unassignedNode: OrgNode | null = null;
  const unassignedId = departmentIds.has(hierarchy.unassigned.id)
    ? `dept:${hierarchy.unassigned.id}:default`
    : hierarchy.unassigned.id;
  const ensureUnassigned = (): OrgNode => {
    if (unassignedNode) return unassignedNode;
    unassignedNode = makeNode({
      id: unassignedId,
      kind: "department",
      display_name: hierarchy.unassigned.name,
      title: "Department",
      role: "department",
      type: "department",
      reports_to: root.id,
      department: hierarchy.unassigned.id,
      edge: "inferred",
      note: "inferred: org.yaml's declared bucket for whatever it does not place",
    });
    nodesById.set(unassignedId, unassignedNode);
    ranks.set(unassignedId, RANK_DEPARTMENT_BASE + hierarchy.unassigned.order);
    return unassignedNode;
  };

  // --- agent nodes ----------------------------------------------------------
  for (const agent of visible) {
    nodesById.set(
      agent.id,
      makeNode({
        id: agent.id,
        kind: "agent",
        display_name: agent.display_name,
        title: hierarchy.personas.get(agent.id) ?? titleFromRole(agent.role),
        role: agent.role,
        type: agent.type,
        repo: agent.repo,
        project_path: agent.project_path,
        desk: deskState(agent),
        channels_offline: agent.channels_offline,
      }),
    );
  }

  // --- phantoms -------------------------------------------------------------
  const phantomSet = new Set<string>();
  const notePhantom = (id: string | null): void => {
    if (id && !registry.agents.has(id)) phantomSet.add(id);
  };
  for (const department of hierarchy.departments) {
    notePhantom(department.manager);
    for (const member of department.members) notePhantom(member);
  }
  for (const id of hierarchy.personas.keys()) notePhantom(id);
  for (const [id, manager] of hierarchy.reportsTo) {
    notePhantom(id);
    notePhantom(manager);
  }
  const phantom = [...phantomSet].sort();

  // --- edges ----------------------------------------------------------------
  const placements = indexPlacements(hierarchy, warnings);
  const dangling: OrgDanglingEdge[] = [];
  const parentOf = new Map<string, string>();

  /** Resolve a `reports_to` value to a node id, or explain why it cannot be. */
  const resolveTarget = (agent: RegistryAgent, target: string): string | null => {
    if (target === agent.id) {
      dangling.push({ agent: agent.id, reports_to: target, reason: "an employee cannot report to themselves" });
      return null;
    }
    if (hiddenSet.has(target)) {
      dangling.push({ agent: agent.id, reports_to: target, reason: "target is hidden by org.yaml" });
      return null;
    }
    const direct = nodesById.get(target);
    if (direct) return direct.id;
    const asDepartment = departmentNodeId.get(target);
    if (asDepartment && nodesById.has(asDepartment)) return asDepartment;
    dangling.push({
      agent: agent.id,
      reports_to: target,
      reason: registry.agents.has(target) ? "target exists but is not in the chart" : "no employee, department or root has that id",
    });
    return null;
  };

  const deferred: RegistryAgent[] = [];
  for (const agent of visible) {
    const node = nodesById.get(agent.id);
    if (!node) continue;

    node.department = placements.get(agent.id)?.department ?? null;
    // 1. the registry's own field wins outright.
    if (agent.reports_to) {
      const target = resolveTarget(agent, agent.reports_to);
      if (target) {
        node.reports_to = target;
        node.edge = "registry";
        node.inferred = false;
        node.note = "reports_to recorded in the agent registry";
        node.department = placements.get(agent.id)?.department ?? nodesById.get(target)?.department ?? null;
        parentOf.set(agent.id, target);
        ranks.set(agent.id, RANK_REGISTRY_EDGE);
        continue;
      }
    }

    // 2. org.yaml's departments.
    const placement = placements.get(agent.id);
    if (placement) {
      const parentId = placement.parent === placement.department
        ? departmentNodeId.get(placement.department) ?? placement.parent
        : placement.parent;
      // A member whose manager is a phantom would otherwise vanish into a parent
      // that does not exist; fall through to the department node instead.
      const parentNode = nodesById.get(parentId);
      const resolvedParent = parentNode ? parentId : departmentNodeId.get(placement.department);
      if (resolvedParent && nodesById.has(resolvedParent)) {
        if (!parentNode) {
          warnings.push(
            `\`${agent.id}\` is a member under manager \`${placement.parent}\`, which the registry does not have; re-parented to department \`${placement.department}\``,
          );
        }
        node.reports_to = resolvedParent;
        node.edge = "org";
        node.inferred = false;
        node.department = placement.department;
        parentOf.set(agent.id, resolvedParent);
        ranks.set(agent.id, placement.rank);
        continue;
      }
    }

    // 3. the documented default -- decided after every recorded edge is known,
    //    because only recorded placements count as evidence.
    deferred.push(agent);
  }

  const evidence: PlacementEvidence[] = [];
  for (const agent of visible) {
    const node = nodesById.get(agent.id);
    if (node && !node.inferred && node.department && agent.project_path) {
      evidence.push({ id: agent.id, project_path: agent.project_path, department: node.department });
    }
  }
  const departmentParent = (departmentId: string): string | null => {
    const manager = hierarchy.departments.find((entry) => entry.id === departmentId)?.manager;
    if (manager && registry.agents.has(manager) && !hiddenSet.has(manager)) return manager;
    const nodeId = departmentNodeId.get(departmentId);
    return nodeId && nodesById.has(nodeId) ? nodeId : null;
  };
  for (const agent of deferred) {
    const node = nodesById.get(agent.id);
    if (!node) continue;
    const inferred = inferParent(agent, evidence, departmentParent, unassignedId);
    if (inferred.parent === unassignedId) ensureUnassigned();
    node.reports_to = inferred.parent;
    node.edge = "inferred";
    node.inferred = true;
    node.note = inferred.note;
    node.department = nodesById.get(inferred.parent)?.department ?? null;
    parentOf.set(agent.id, inferred.parent);
    ranks.set(agent.id, RANK_INFERRED);
  }

  // --- cycle break ----------------------------------------------------------
  //
  // Only `reports_to` can produce a loop: org.yaml placements always terminate
  // at a department, and inference always terminates at a director, the root or
  // the Unassigned bucket. A loop is still broken here rather than trusted,
  // because the renderer must not be the thing that discovers it.
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  for (const agent of visible) {
    const path: string[] = [];
    let cursor: string | undefined = agent.id;
    while (cursor && state.get(cursor) !== 2) {
      if (state.get(cursor) === 1) {
        const loop = path.slice(path.indexOf(cursor));
        cycles.push(loop);
        const node = nodesById.get(cursor);
        if (node) {
          const rescue = inferParent(
            registry.agents.get(cursor) ?? { ...(node as unknown as RegistryAgent), reports_to: null },
            evidence.filter((entry) => !loop.includes(entry.id)),
            departmentParent,
            unassignedId,
          );
          if (rescue.parent === unassignedId) ensureUnassigned();
          node.reports_to = rescue.parent;
          node.edge = "inferred";
          node.inferred = true;
          node.note = `inferred: reporting loop ${loop.join(" -> ")} broken here`;
          parentOf.set(cursor, rescue.parent);
          ranks.set(cursor, RANK_INFERRED);
          warnings.push(`reporting loop ${loop.join(" -> ")} was broken at \`${cursor}\``);
        }
        break;
      }
      state.set(cursor, 1);
      path.push(cursor);
      cursor = parentOf.get(cursor);
    }
    for (const id of path) state.set(id, 2);
  }

  // --- attach ---------------------------------------------------------------
  for (const [childId, parentId] of parentOf) {
    const child = nodesById.get(childId);
    const parent = nodesById.get(parentId);
    if (child && parent) parent.children.push(child);
  }
  for (const id of departmentIds) {
    const node = nodesById.get(id);
    if (node) root.children.push(node);
  }
  if (unassignedNode) root.children.push(unassignedNode);

  const byRank = (left: OrgNode, right: OrgNode): number =>
    (ranks.get(left.id) ?? RANK_INFERRED) - (ranks.get(right.id) ?? RANK_INFERRED) ||
    left.display_name.localeCompare(right.display_name) ||
    left.id.localeCompare(right.id);
  for (const node of nodesById.values()) node.children.sort(byRank);

  // --- totals ---------------------------------------------------------------
  const nodes = flattenOrgChart(root);
  const rendered = nodes.filter((node) => node.kind === "agent");
  const placed = rendered.filter((node) => !node.inferred).map((node) => node.id).sort();
  const unplaced = rendered.filter((node) => node.inferred).map((node) => node.id).sort();
  const noDesk = rendered.filter((node) => node.desk === "missing").map((node) => node.id).sort();

  // Independent recount, in the spirit of `inventory.ts`: if the tree ever drops
  // an employee, that must surface as a stated discrepancy rather than as an
  // agent who quietly stopped existing.
  if (rendered.length !== visible.length) {
    warnings.push(`${visible.length} employees were read from the registry but ${rendered.length} reached the tree`);
  }

  return {
    root,
    nodes,
    placed,
    unplaced,
    no_desk: noDesk,
    phantom,
    hidden,
    dangling,
    cycles,
    warnings,
    company: hierarchy.company,
    sources: {
      registry_path: registryPath,
      registry_present: existsSync(registryPath),
      registry_real_path: realPathOrSelf(registryPath),
      registry_via: describeOrgRegistryVia(options),
      org_path: orgPath,
      org_present: hierarchy.present,
      org_real_path: realPathOrSelf(orgPath),
      org_via: describeOrgHierarchyVia(options),
      org_version: hierarchy.version,
      desk_root: deskRoot,
    },
    totals: {
      registry_rows: registry.agents.size,
      rendered_agents: rendered.length,
      placed: placed.length,
      unplaced: unplaced.length,
      no_desk: noDesk.length,
      phantom: phantom.length,
      hidden: hidden.length,
      departments: nodes.filter((node) => node.kind === "department").length,
    },
  };
}

/** Pre-order walk. The order is stable, so two runs diff cleanly. */
export function flattenOrgChart(root: OrgNode): OrgNode[] {
  const out: OrgNode[] = [];
  const walk = (node: OrgNode, depth: number): void => {
    out.push(node);
    if (depth >= MAX_RENDER_DEPTH) return;
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Find one node by agent, department or root id. */
export function findOrgNode(root: OrgNode, id: string): OrgNode | null {
  return flattenOrgChart(root).find((node) => node.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const CONNECTOR_LAST = "└── ";
const CONNECTOR_MID = "├── ";
const SPINE = "│   ";
const GAP = "    ";

/** The marker that separates a recorded reporting line from an invented one. */
const INFERRED_MARK = "~ ";

function nodeLabel(node: OrgNode): string {
  if (node.kind === "root") {
    return `${bold(node.display_name)} ${dim(`(${node.id})`)} ${dim("·")} ${magenta(node.title)}`;
  }
  if (node.kind === "department") {
    const mark = node.inferred ? dim(INFERRED_MARK) : "";
    return `${mark}${bold(cyan(node.display_name))} ${dim("[department]")}`;
  }
  const mark = node.inferred ? yellow(INFERRED_MARK) : "";
  const name = node.inferred ? dim(node.display_name) : bold(node.display_name);
  const parts = [`${mark}${name}`, dim(`(${node.id})`), dim("·")];
  // A persona title from org.yaml is the operator's word for the job; the role
  // is the registry's. Show both when they differ, so "Director of Workflows"
  // is visible and `workflows-director` is still checkable. A title merely
  // derived from the role adds nothing and is left out.
  if (node.title && node.title !== titleFromRole(node.role)) parts.push(magenta(node.title), dim("·"));
  parts.push(green(node.role));
  if (node.repo) parts.push(dim("·"), gray(node.repo));
  if (node.desk === "missing") parts.push(red("[no desk]"));
  // A parked channel is the operator's own decision: shown, in the warning colour, never red.
  for (const platform of node.channels_offline) parts.push(yellow(`[${platform} offline]`));
  if (node.edge === "registry") parts.push(dim("[reports_to]"));
  if (node.note && node.inferred) parts.push(dim(`[${node.note}]`));
  return parts.join(" ");
}

/**
 * The path the header names. It is the path that was READ, never a default
 * restated: a symlink shows where it lands, and a path chosen by an env var or
 * flag says so, so a header cannot quietly describe a file other than the one
 * behind the tree.
 */
function sourceLabel(path: string, realPath: string, via: OrgPathVia): string {
  const shown = redactHome(path);
  const parts = [shown];
  if (realPath !== path) parts.push(`-> ${redactHome(realPath)}`);
  if (via !== "default") parts.push(`(via ${via === "option" ? "flag" : via})`);
  return parts.join(" ");
}

function renderBranch(node: OrgNode, prefix: string, lines: string[], depth: number): void {
  if (depth >= MAX_RENDER_DEPTH) {
    lines.push(`${prefix}${dim("… depth limit reached; branch truncated")}`);
    return;
  }
  node.children.forEach((child, index) => {
    const last = index === node.children.length - 1;
    lines.push(`${prefix}${dim(last ? CONNECTOR_LAST : CONNECTOR_MID)}${nodeLabel(child)}`);
    renderBranch(child, `${prefix}${dim(last ? GAP : SPINE)}`, lines, depth + 1);
  });
}

/**
 * The human render: a real tree, root at top, with every inferred edge marked.
 *
 * The footer is not decoration. A chart that shows 25 employees and says nothing
 * about the seven ids org.yaml still believes in would be the same lie the flat
 * roster told, drawn more attractively.
 */
export function formatOrgChart(chart: OrgChartResult, options: FormatOrgChartOptions = {}): string {
  const lines: string[] = [];
  const drift = options.drift !== false;

  if (!options.bare) {
    const company = chart.company.name
      ? `${chart.company.name}${chart.company.handle ? ` (${chart.company.handle})` : ""}`
      : "Org chart";
    lines.push(bold(company));
    lines.push(dim(`registry  ${sourceLabel(chart.sources.registry_path, chart.sources.registry_real_path, chart.sources.registry_via)}  ${chart.totals.registry_rows} employees`));
    lines.push(
      dim(
        chart.sources.org_present
          ? `hierarchy ${sourceLabel(chart.sources.org_path, chart.sources.org_real_path, chart.sources.org_via)}  v${chart.sources.org_version ?? "?"}`
          : `hierarchy ${sourceLabel(chart.sources.org_path, chart.sources.org_real_path, chart.sources.org_via)}  MISSING — every edge below is inferred`,
      ),
    );
    lines.push("");
  }

  lines.push(nodeLabel(chart.root));
  renderBranch(chart.root, "", lines, 0);

  if (options.bare) return lines.join("\n");

  lines.push("");
  const totals = chart.totals;
  lines.push(
    [
      `${bold(String(totals.registry_rows))} in the registry`,
      `${bold(String(totals.placed))} placed`,
      `${totals.unplaced > 0 ? yellow(String(totals.unplaced)) : bold("0")} inferred`,
      `${totals.no_desk > 0 ? red(String(totals.no_desk)) : bold("0")} no desk`,
      `${totals.phantom > 0 ? red(String(totals.phantom)) : bold("0")} phantom`,
      `${bold(String(totals.hidden))} hidden`,
      `${bold(String(totals.departments))} departments`,
    ].join(dim(" · ")),
  );
  if (totals.unplaced > 0) {
    lines.push(dim(`${INFERRED_MARK.trim()} marks an edge nothing recorded — Flume chose it; edit ${redactHome(chart.sources.org_path)} to make it real`));
  }

  if (drift) {
    if (chart.phantom.length > 0) {
      lines.push("");
      lines.push(`${red("phantom")} ${dim(`— named in ${redactHome(chart.sources.org_path)}, absent from the registry (not rendered)`)}`);
      for (const id of chart.phantom) lines.push(`  ${dim("·")} ${id}`);
    }
    if (chart.no_desk.length > 0) {
      lines.push("");
      lines.push(`${red("no desk")} ${dim(`— registry row, but no profile directory under ${redactHome(chart.sources.desk_root)}`)}`);
      for (const id of chart.no_desk) lines.push(`  ${dim("·")} ${id}`);
    }
    if (chart.unplaced.length > 0) {
      lines.push("");
      lines.push(`${yellow("unplaced")} ${dim("— no recorded reporting line; drawn under the documented default")}`);
      for (const id of chart.unplaced) {
        const node = findOrgNode(chart.root, id);
        lines.push(`  ${dim("·")} ${id}${node?.note ? dim(` — ${node.note}`) : ""}`);
      }
    }
    if (chart.hidden.length > 0) {
      lines.push("");
      lines.push(`${dim("hidden")} ${dim("— real employees org.yaml omits from the chart")}`);
      for (const id of chart.hidden) lines.push(`  ${dim("·")} ${id}`);
    }
    if (chart.dangling.length > 0) {
      lines.push("");
      lines.push(`${red("dangling reports_to")} ${dim("— the registry field named something unreachable")}`);
      for (const edge of chart.dangling) {
        lines.push(`  ${dim("·")} ${edge.agent} → ${edge.reports_to} ${dim(`(${edge.reason})`)}`);
      }
    }
    if (chart.cycles.length > 0) {
      lines.push("");
      lines.push(`${red("reporting loops")} ${dim("— broken so the tree could be drawn")}`);
      for (const cycle of chart.cycles) lines.push(`  ${dim("·")} ${cycle.join(" → ")}`);
    }
    if (chart.warnings.length > 0) {
      lines.push("");
      lines.push(`${yellow("warnings")}`);
      for (const warning of chart.warnings) lines.push(`  ${dim("·")} ${warning}`);
    }
  }

  return lines.join("\n");
}
