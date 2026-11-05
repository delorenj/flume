// Registry projection for the ticket lifecycle.
//
// The n8n Fleet node (n8n-nodes-bloodbank) attributes lane failures and dispatches, and stamps
// `workflow.task.failed` with a company identity, by reading ONLY ~/.hermes/agents-registry.yaml: it never runs
// flume. So every registry row carries, projected by `flume remediate hermes.registry-parity`:
//
//   agents.<agent_id>.company_identity      ENROLLED employees only, from the owning definition (the SSOT: a
//     subject: <uuid>                       post's role.yaml, a portable specialist's agent.yaml)
//     handle: grolf
//     email: grolf@agents.delo.sh
//     status: active|suspended|retired
//     plane:                                only for a VERIFIED native Plane binding (native_actor_id == principal)
//       attribution_mode: native
//       native_actor_id: <uuid>
//   agents.<agent_id>.gateway_consumer      the AutomaticAI gateway consumer the row's desk RUNS on, by the same
//                                           resolution the FLUME-53 gateway adapter uses (generated config.yaml, else
//                                           config.delta.yaml, else the fleet base -> `hermes`, the shared base consumer)
//
// Absent means "not enrolled" / "unknown". A row whose definition is not enrolled loses a stale `company_identity`; a
// desk whose key is not the FLUME-39 shape, or a row with no desk directory, has no `gateway_consumer`. Nothing beyond
// these fields is projected: no credential reference, no binding principal other than the verified Plane actor
// (plane.key_ref stays where FLUME-52 put it). Only a definition or desk config that cannot be READ holds its key as it
// is: guessing either way would be a lie the lifecycle machinery then repeats.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { deskGatewayConsumer } from "./gateway-desk";
import type { CompanyIdentityStatus } from "./types";
import { parseNamedAgentYaml, validateCompanyIdentity } from "./validator";

export interface RegistryCompanyIdentity {
  subject: string;
  handle: string;
  email: string;
  status: CompanyIdentityStatus;
  plane?: { attribution_mode: "native"; native_actor_id: string };
}

/** One projected key: `decided` (value undefined = must be absent) or `held` (unreadable source: the row keeps what it has). */
export type Projected<T> = { state: "decided"; value?: T } | { state: "held"; reason: string };

export interface RowLifecycle {
  agentId: string;
  /** The owning definition this row points at, or null when it points at none. */
  definition: string | null;
  company: Projected<RegistryCompanyIdentity>;
  gateway: Projected<string>;
}

const PLANE_ACTOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const mapping = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** The owning definition a registry row points at: a specialist's `definition_path`, a post's `<role_dir>/role.yaml`. */
export function rowDefinitionPath(row: Record<string, unknown>): string | null {
  if (row.employment === "portable-specialist") return text(row.definition_path) ?? null;
  const roleDir = text(row.role_dir);
  return roleDir ? join(roleDir, "role.yaml") : null;
}

/**
 * The company identity a definition's text projects, or undefined when it is not enrolled. Throws when the definition
 * or its `company_identity` block is malformed: that is a held key, never "not enrolled".
 */
export function registryCompanyIdentity(definitionText: string): RegistryCompanyIdentity | undefined {
  const root = parseNamedAgentYaml(definitionText);
  if (root === null || root === undefined) return undefined;
  const doc = mapping(root);
  if (!doc) throw new Error("definition root must be a mapping");
  if (!("company_identity" in doc)) return undefined;
  const block = validateCompanyIdentity(doc.company_identity);
  const projected: RegistryCompanyIdentity = { subject: block.subject, handle: block.handle, email: block.email, status: block.status };
  const plane = block.bindings?.plane;
  if (plane && PLANE_ACTOR.test(plane.principal) && plane.native_actor_id === plane.principal
    && (plane.attribution_mode === undefined || plane.attribution_mode === "native")) {
    projected.plane = { attribution_mode: "native", native_actor_id: plane.principal };
  }
  return projected;
}

function companyFor(definition: string | null): Projected<RegistryCompanyIdentity> {
  // A row that points at no definition, or at one that does not exist, is not an enrolled employee.
  if (!definition || !existsSync(definition)) return { state: "decided" };
  let body: string;
  try {
    if (!statSync(definition).isFile()) return { state: "held", reason: `${definition} is not a regular file` };
    body = readFileSync(definition, "utf8");
  } catch (error) {
    return { state: "held", reason: `${definition} is unreadable: ${(error as Error).message.split("\n")[0]}` };
  }
  try {
    const value = registryCompanyIdentity(body);
    return value ? { state: "decided", value } : { state: "decided" };
  } catch (error) {
    return { state: "held", reason: `${definition} company_identity is malformed: ${(error as Error).message.split("\n")[0]}` };
  }
}

function gatewayFor(fleet: string, profile: string): Projected<string> {
  // No desk directory, no desk config: nothing maps a key for this row.
  const desk = join(fleet, "profiles", profile);
  let isDesk = false;
  try { isDesk = statSync(desk).isDirectory(); } catch { isDesk = false; }
  if (!isDesk) return { state: "decided" };
  const resolved = deskGatewayConsumer(fleet, profile);
  if (resolved.unreadable) return { state: "held", reason: `${join(desk, "config.yaml")} cannot be read, so the gateway key the desk runs is unknown` };
  return resolved.consumer ? { state: "decided", value: resolved.consumer } : { state: "decided" };
}

/** What one registry row should carry for the lifecycle. `fleet` is the Hermes fleet home (`~/.hermes`). */
export function rowLifecycle(agentId: string, row: Record<string, unknown>, fleet: string): RowLifecycle {
  const definition = rowDefinitionPath(row);
  return { agentId, definition, company: companyFor(definition), gateway: gatewayFor(fleet, text(row.profile_name)?.trim() ?? agentId) };
}

const show = (value: unknown): string => (value === undefined ? "absent" : JSON.stringify(value));

/** How a row disagrees with its projection; one line per key. A held key is reported once, as held. */
export function lifecycleDrift(row: Record<string, unknown>, expected: RowLifecycle): string[] {
  const out: string[] = [];
  const id = expected.agentId;
  if (expected.company.state === "held") out.push(`registry company_identity for ${id} cannot be projected (left as is): ${expected.company.reason}`);
  else if (!isDeepStrictEqual(row.company_identity, expected.company.value)) {
    out.push(expected.company.value
      ? `registry company_identity for ${id} is ${show(row.company_identity)} (${expected.definition} projects ${show(expected.company.value)})`
      : `registry company_identity for ${id} is ${show(row.company_identity)} but ${expected.definition ?? "the row's definition"} is not enrolled; a stale projection is removed`);
  }
  if (expected.gateway.state === "held") out.push(`registry gateway_consumer for ${id} cannot be projected (left as is): ${expected.gateway.reason}`);
  else if (row.gateway_consumer !== expected.gateway.value) {
    out.push(`registry gateway_consumer for ${id} is ${show(row.gateway_consumer)} (its desk runs ${expected.gateway.value ? `consumer "${expected.gateway.value}"` : "no FLUME-39 gateway consumer"})`);
  }
  return out;
}

/** Bring one row to its projection in place; returns what changed. Held keys are never touched. */
export function applyLifecycle(row: Record<string, unknown>, expected: RowLifecycle): string[] {
  const changed: string[] = [];
  const id = expected.agentId;
  if (expected.company.state === "decided" && !isDeepStrictEqual(row.company_identity, expected.company.value)) {
    if (expected.company.value) {
      row.company_identity = structuredClone(expected.company.value);
      changed.push(`project company_identity ${expected.company.value.handle} (${expected.company.value.status}${expected.company.value.plane ? ", native Plane actor" : ""}) onto ${id}`);
    } else {
      delete row.company_identity;
      changed.push(`drop stale company_identity from ${id} (its definition is not enrolled)`);
    }
  }
  if (expected.gateway.state === "decided" && row.gateway_consumer !== expected.gateway.value) {
    if (expected.gateway.value) {
      row.gateway_consumer = expected.gateway.value;
      changed.push(`project gateway_consumer "${expected.gateway.value}" onto ${id}`);
    } else {
      delete row.gateway_consumer;
      changed.push(`drop gateway_consumer from ${id} (its desk maps no FLUME-39 gateway consumer)`);
    }
  }
  return changed;
}
