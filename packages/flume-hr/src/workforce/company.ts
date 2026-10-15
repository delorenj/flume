// Company identity: who an employee is to the company, recorded on the
// employee's EXISTING owning definition and nowhere else.
//
// A named post-holder's definition is its post's role.yaml (the template's
// Copier refresh skips that file, and its `identity:` already names the
// person); a portable specialist's is its desk agent.yaml, which carries the
// block from schema_version 2. There is no second employee registry: every
// question about uniqueness is answered by a census of every known definition,
// recomputed under the registry lock before any write.
//
// Status here is LOCAL employment state. Recording a suspension or retirement
// revokes nothing at any provider; `flume identity suspend|retire` (lifecycle.ts,
// FLUME-53) is what closes or reports provider access, and every status answer
// says so.
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { resolveFlumeRoot } from "../kernel/paths";
import { copierFleetPaths } from "../hire/PreserveRegistryComments";
import { renderDeskContract } from "./desk";
import { appendLifecycleLedger, readTombstones, tombstoneFor, type Tombstone } from "./lifecycle-state";
import { githubBindingOf, githubBindingProblems, githubCredentialRefProblem, githubEvidence, resolveGithubBotActor } from "./github";
import { readRoleIdentity } from "./identity";
import { appendPlaneReceipt, isBoardArgument, planeBindingOf, planeBindingProblems, planeCredentialReport, planeEnrollmentPrerequisites, planeEvidence, verifyBoardViaPx, type PlaneBoardProof } from "./plane";
import { withRegistryLock } from "./role";
import { COMPANY_MAIL_DOMAIN, RESERVED_HANDLES, parseNamedAgentYaml, validateCompanyIdentity, validateNamedAgent, validateNamedAgentSchema } from "./validator";
import type { CompanyIdentity, CompanyIdentityBinding, CompanyIdentityStatus } from "./types";

const HANDLE = /^[a-z0-9][a-z0-9_-]{0,57}$/u;
const EMPLOYEE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const STATUSES: readonly CompanyIdentityStatus[] = ["active", "suspended", "retired"];
export const PROVIDER_REVOCATION_NOTE = "Local employment state only: provider access was not revoked. `flume identity suspend|retire <employee> --apply` (FLUME-53) closes the mailbox and revokes or reports each provider credential.";

export interface IdentityBlocker { code: string; detail: string; path?: string; provider_code?: string; board?: string }
export interface ReconcileCandidate { provider: string; principal: string; person?: string; post?: string; description?: string; adoptable?: boolean; disposition?: string; source?: string; state: "unadopted" | "bound"; bound_at?: string }

/** One known definition, as the census read it. */
export interface IdentityDefinition {
  path: string;
  kind: "post" | "specialist";
  /** Registry ids whose row points at this definition. */
  posts: string[];
  /** The person: role.yaml `identity.name`, or a specialist's id. Null for an unnamed post. */
  person: string | null;
  block: CompanyIdentity | null;
  text: string;
  missing: boolean;
  /** Why this definition cannot be trusted; null when it was read cleanly. */
  problem: string | null;
  /** Legacy fields a reader still sees, enrolled or not. */
  fields: Record<string, unknown>;
}

export interface IdentityCensus { home: string; registryPath: string; postIds: string[]; definitions: IdentityDefinition[] }

export interface IdentityOptions { apply?: boolean; handle?: string; /** adopt-actor plane: the boards to verify; every one must pass. */ boards?: string[] }

function stat(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function environment() {
  const home = process.env.HOME || homedir();
  return { home, registryPath: copierFleetPaths({ ...process.env, HOME: home }).registryPath };
}

function registryRows(path: string): Record<string, Record<string, unknown>> {
  const info = stat(path);
  if (!info) return {};
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing non-regular registry ${path}`);
  const doc = YAML.parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Registry is not valid YAML: ${doc.errors[0]!.message}`);
  const agents = (doc.toJS() as { agents?: unknown } | null)?.agents ?? {};
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) throw new Error("Registry agents must be a mapping");
  return agents as Record<string, Record<string, unknown>>;
}

/**
 * The Hermes profile (the employee's desk) a definition runs under: a post's registry `profile_name`, falling back to the
 * post id; a portable specialist's desk directory name. Null for a post-less definition that is not a specialist.
 */
export function deskProfileOf(census: IdentityCensus, target: IdentityDefinition): string | null {
  if (target.kind === "specialist") return target.posts.length ? (profileOfPost(census, target.posts[0]!) ?? target.posts[0]!) : basename(dirname(target.path));
  const post = target.posts[0];
  return post ? (profileOfPost(census, post) ?? post) : null;
}

function profileOfPost(census: IdentityCensus, post: string): string | undefined {
  let rows: Record<string, Record<string, unknown>>;
  try { rows = registryRows(census.registryPath); } catch { return undefined; }
  const name = rows[post]?.profile_name;
  return typeof name === "string" && name ? name : undefined;
}

function readDefinition(path: string, kind: IdentityDefinition["kind"], posts: string[], profile: string): IdentityDefinition {
  const entry: IdentityDefinition = { path, kind, posts, person: null, block: null, text: "", missing: false, problem: null, fields: {} };
  const info = stat(path);
  if (!info) { entry.missing = true; return entry; }
  if (!info.isFile() && !info.isSymbolicLink()) { entry.problem = "definition is not a regular file"; return entry; }
  try {
    entry.text = readFileSync(path, "utf8");
    if (kind === "post") {
      const identity = readRoleIdentity(entry.text, posts[0] ?? "", profile);
      if (identity.state === "invalid") { entry.problem = identity.reason; return entry; }
      if (identity.state === "named") entry.person = identity.name;
      const root = (parseNamedAgentYaml(entry.text) ?? {}) as Record<string, unknown>;
      entry.fields = Object.fromEntries(["role", "agent_id", "profile", "repo"].filter(key => root[key] !== undefined).map(key => [key, root[key]]));
      if (identity.state === "named") entry.fields.identity = identity.name;
      if (root.company_identity !== undefined) entry.block = validateCompanyIdentity(root.company_identity);
    } else {
      const contract = validateNamedAgentSchema(entry.text);
      entry.person = contract.id;
      entry.fields = { schema_version: contract.schema_version, id: contract.id, display_name: contract.display_name, role: contract.role };
      entry.block = contract.company_identity ?? null;
    }
  } catch (error) {
    entry.problem = (error as Error).message;
  }
  return entry;
}

/** Every definition Flume knows about: registry rows, plus specialist desks not (yet) in the registry. */
export function identityCensus(): IdentityCensus {
  const { home, registryPath } = environment();
  const rows = registryRows(registryPath);
  const found = new Map<string, { kind: IdentityDefinition["kind"]; posts: string[]; profile: string }>();
  for (const [post, row] of Object.entries(rows)) {
    if (!row || typeof row !== "object") continue;
    let path: string | undefined, kind: IdentityDefinition["kind"];
    if (row.employment === "portable-specialist") { path = typeof row.definition_path === "string" ? row.definition_path : undefined; kind = "specialist"; }
    else { path = typeof row.role_dir === "string" ? join(row.role_dir, "role.yaml") : undefined; kind = "post"; }
    if (!path) continue;
    const key = resolve(path);
    const seen = found.get(key);
    if (seen) seen.posts.push(post);
    else found.set(key, { kind, posts: [post], profile: typeof row.profile_name === "string" ? row.profile_name : post });
  }
  const workforce = join(home, ".agents", "workforce");
  if (stat(workforce)?.isDirectory()) {
    for (const name of readdirSync(workforce).sort()) {
      const key = resolve(join(workforce, name, "agent.yaml"));
      if (!found.has(key) && stat(key)) found.set(key, { kind: "specialist", posts: [], profile: name });
    }
  }
  const definitions = [...found].map(([path, { kind, posts, profile }]) => readDefinition(path, kind, posts, profile));
  return { home, registryPath, postIds: Object.keys(rows), definitions };
}

/** A registry id, an unhired specialist's desk name, or a person's name, in that order. */
export function resolveEmployee(census: IdentityCensus, employee: string): IdentityDefinition {
  if (!EMPLOYEE.test(employee)) throw new Error(`Unsafe employee identity: ${employee}`);
  const byPost = census.definitions.filter(d => d.posts.includes(employee));
  if (byPost.length === 1) return byPost[0]!;
  const byDesk = census.definitions.filter(d => d.kind === "specialist" && !d.posts.length && basename(dirname(d.path)) === employee);
  if (byDesk.length === 1) return byDesk[0]!;
  const byPerson = census.definitions.filter(d => d.person === employee);
  if (byPerson.length === 1) return byPerson[0]!;
  if (byPerson.length > 1) throw new Error(`Person ${employee} is declared at ${byPerson.length} definitions: ${byPerson.map(d => d.path).join(", ")}`);
  throw new Error(`Employee not found: ${employee}`);
}

function bindingKeys(block: CompanyIdentity | null): string[] {
  return Object.entries(block?.bindings ?? {}).map(([provider, b]) => `${provider}\u0000${b.instance ?? ""}\u0000${b.principal}`);
}

const tombstoneBindingKeys = (tombstone: Tombstone): string[] => tombstone.bindings.map(b => `${b.provider}\u0000${b.instance ?? ""}\u0000${b.principal}`);

/** Every reason this definition may not hold this handle. Reads the census and the retirement tombstones only. */
function conflicts(census: IdentityCensus, target: IdentityDefinition, handle: string): IdentityBlocker[] {
  const blockers: IdentityBlocker[] = [];
  if (!HANDLE.test(handle)) blockers.push({ code: "invalid-handle", detail: `handle "${handle}" must match ${HANDLE.source}` });
  if (RESERVED_HANDLES.has(handle)) blockers.push({ code: "handle-reserved", detail: `"${handle}" is an RFC 2142 role mailbox` });
  const ownPost = target.kind === "specialist" && target.posts.includes(handle);
  if (census.postIds.includes(handle) && !ownPost) blockers.push({ code: "handle-reserved", detail: `"${handle}" is a registry post id; a person's handle never names a post` });
  const bindings = bindingKeys(target.block);
  // FLUME-53: a retired identity's handle, subject and bindings outlive its registry row (`flume offboard`).
  const tombstones = readTombstones();
  for (const tombstone of tombstones) {
    if (tombstone.subject === target.block?.subject) continue;
    if (tombstone.handle === handle) blockers.push({ code: "handle-tombstoned", detail: `"${handle}" belonged to a retired employee (subject ${tombstone.subject}, retired ${tombstone.retired_at}); a retired handle is never reissued` });
    for (const key of tombstoneBindingKeys(tombstone).filter(key => bindings.includes(key))) blockers.push({ code: "binding-tombstoned", detail: `binding ${key.split("\u0000").filter(Boolean).join("/")} belonged to a retired employee (subject ${tombstone.subject})` });
  }
  const own = target.block ? tombstones.find(tombstone => tombstone.subject === target.block!.subject) : undefined;
  if (own && target.block!.status !== "retired") blockers.push({ code: "subject-tombstoned", detail: `subject ${own.subject} was retired ${own.retired_at}; a definition carrying it is not a new employee` });
  for (const other of census.definitions) {
    if (other === target || other.missing) continue;
    if (other.problem) { blockers.push({ code: "invalid-definition", detail: `census cannot read ${other.path}: ${other.problem}`, path: other.path }); continue; }
    if (other.block?.handle === handle) blockers.push({ code: "handle-taken", detail: `handle "${handle}" is held (${other.block.status}) by ${other.posts.join(", ") || other.path}`, path: other.path });
    else if (other.person === handle && other.person !== target.person) blockers.push({ code: "handle-taken", detail: `"${handle}" is the name of the person at ${other.path}`, path: other.path });
    if (target.block && other.block?.subject === target.block.subject) blockers.push({ code: "subject-duplicate", detail: `subject ${target.block.subject} is also recorded at ${other.path}`, path: other.path });
    const shared = bindingKeys(other.block).filter(key => bindings.includes(key));
    for (const key of shared) blockers.push({ code: "binding-duplicate", detail: `binding ${key.split("\u0000").filter(Boolean).join("/")} is also recorded at ${other.path}`, path: other.path });
    if (target.person && other.person === target.person) blockers.push({ code: "person-elsewhere", detail: `person "${target.person}" is also declared at ${other.path}`, path: other.path });
  }
  return blockers;
}

function candidateInventory(): { list: Array<Omit<ReconcileCandidate, "state">>; warnings: string[] } {
  const path = process.env.FLUME_IDENTITY_CANDIDATES || join(resolveFlumeRoot(), "contracts", "company-identity-candidates.yaml");
  if (!existsSync(path)) return { list: [], warnings: [`candidate inventory not found: ${path}`] };
  const inventory = YAML.parse(readFileSync(path, "utf8")) as { candidates?: Array<Omit<ReconcileCandidate, "state">> } | null;
  return { list: inventory?.candidates ?? [], warnings: [] };
}

function candidates(target: IdentityDefinition, census: IdentityCensus): { reconcile: ReconcileCandidate[]; warnings: string[] } {
  const { list, warnings } = candidateInventory();
  const reconcile: ReconcileCandidate[] = [];
  for (const candidate of list) {
    if (!(target.person && candidate.person === target.person) && !(candidate.post && target.posts.includes(candidate.post))) continue;
    const holder = census.definitions.find(d => Object.entries(d.block?.bindings ?? {}).some(([provider, b]) => provider === candidate.provider && b.principal === candidate.principal));
    reconcile.push({ ...candidate, ...(holder ? { state: "bound", bound_at: holder.path } : { state: "unadopted" }) });
  }
  return { reconcile, warnings };
}

/** A principal the inventory marks `adoptable: false` is a machine-blocker for ANY employee, whoever it was listed under. */
function staleCandidate(provider: string, principal: string | undefined): IdentityBlocker | undefined {
  if (!principal) return undefined;
  // Fail closed: a gate that cannot read its inventory must refuse, never pass.
  let inventory: ReturnType<typeof candidateInventory>;
  try { inventory = candidateInventory(); } catch (error) { return { code: "candidate-inventory-unavailable", detail: `the candidate inventory is unreadable: ${(error as Error).message.split("\n")[0]}` }; }
  if (inventory.warnings.length) return { code: "candidate-inventory-unavailable", detail: inventory.warnings[0]! };
  const hit = inventory.list.find(candidate => candidate.provider === provider && String(candidate.principal).toLowerCase() === principal.toLowerCase() && candidate.adoptable === false);
  if (!hit) return undefined;
  return { code: "stale-candidate", detail: `${principal} is a refused ${provider} candidate: ${hit.disposition ?? "not adoptable"}${hit.source ? ` (source: ${hit.source})` : ""}` };
}

function renderBlock(block: CompanyIdentity): string {
  // Every string double-quoted: PyYAML readers of role.yaml would otherwise turn
  // an ISO timestamp into a datetime.
  return YAML.stringify({ company_identity: block }, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" });
}

/** Replace the top-level company_identity block in place, or append it. Every other byte is kept. */
function spliceBlock(text: string, block: CompanyIdentity): string {
  const rendered = renderBlock(block);
  const lines = text.split("\n");
  const start = lines.findIndex(line => /^company_identity\s*:/u.test(line));
  if (start < 0) return `${text}${text.length && !text.endsWith("\n") ? "\n" : ""}${rendered}`;
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^[ \t]/u.test(lines[end]!))) end++;
  while (end > start + 1 && lines[end - 1] === "") end--;
  return [...lines.slice(0, start), ...rendered.replace(/\n$/u, "").split("\n"), ...lines.slice(end)].join("\n");
}

function publish(path: string, text: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing non-regular definition ${path}`);
  const temporary = join(dirname(path), `.${basename(path)}.identity-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", info.mode & 0o777);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function withoutIdentity(text: string): Record<string, unknown> {
  const { company_identity: _block, schema_version: _version, ...rest } = (parseNamedAgentYaml(text) ?? {}) as Record<string, unknown>;
  return rest;
}

/** The definition text that carries `block`, with nothing else about the employee changed. */
function edited(target: IdentityDefinition, block: CompanyIdentity): string {
  let text = target.text;
  if (target.kind === "specialist" && !target.block) {
    // The block exists only from schema_version 2; the version is the one other key enrollment touches.
    if (!/^schema_version:[ \t]*1[ \t]*$/mu.test(text)) throw new Error(`${target.path}: cannot raise schema_version to 2 in place`);
    text = text.replace(/^schema_version:[ \t]*1[ \t]*$/mu, "schema_version: 2");
  }
  return spliceBlock(text, block);
}

/** Write, then read back and prove only the block (and a specialist's schema_version) changed. */
async function writeDefinition(target: IdentityDefinition, block: CompanyIdentity): Promise<string[]> {
  if (stat(target.path)?.isSymbolicLink()) throw new Error(`Refusing symlinked definition ${target.path}`);
  if (readFileSync(target.path, "utf8") !== target.text) throw new Error(`${target.path} changed during enrollment; retry`);
  const next = edited(target, block);
  const written = [target.path];
  let contract: { path: string; render: string } | undefined;
  if (target.kind === "specialist") {
    validateNamedAgentSchema(next);
    const path = join(dirname(target.path), "contract.yaml");
    const before = renderDeskContract(await validateNamedAgent(target.text, { resolveSkills: false }));
    // Only a contract.yaml that matched the pre-enrollment definition is ours to refresh; drift stays for audit.
    if (stat(path)?.isFile() && readFileSync(path, "utf8") === before) contract = { path, render: renderDeskContract(await validateNamedAgent(next, { resolveSkills: false })) };
  }
  publish(target.path, next);
  try {
    const readBack = readFileSync(target.path, "utf8");
    const stored = target.kind === "post" ? validateCompanyIdentity((parseNamedAgentYaml(readBack) as Record<string, unknown>).company_identity) : validateNamedAgentSchema(readBack).company_identity;
    if (!isDeepStrictEqual(stored, block) || !isDeepStrictEqual(withoutIdentity(readBack), withoutIdentity(target.text))) throw new Error(`Read-back of ${target.path} does not match the intended identity`);
    if (target.kind === "post" && !target.block && !readBack.startsWith(target.text)) throw new Error(`Read-back of ${target.path} changed bytes before the appended block`);
  } catch (error) {
    publish(target.path, target.text);
    throw error;
  }
  if (contract) { publish(contract.path, contract.render); written.push(contract.path); }
  return written;
}

function summary(target: IdentityDefinition) {
  return { kind: target.kind, definition: target.path, person: target.person, posts: target.posts };
}

/** Preview (default) or apply one enrollment. A blocker writes nothing. */
export async function enrollEmployee(employee: string, options: IdentityOptions = {}) {
  const plan = (census: IdentityCensus) => {
    const target = resolveEmployee(census, employee);
    const blockers: IdentityBlocker[] = [];
    if (target.missing) blockers.push({ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path });
    else if (target.problem) blockers.push({ code: "invalid-definition", detail: target.problem, path: target.path });
    else if (stat(target.path)?.isSymbolicLink()) blockers.push({ code: "invalid-definition", detail: `refusing symlinked definition ${target.path}`, path: target.path });
    else if (!target.person) blockers.push({ code: "unnamed-post", detail: `${target.path} declares no identity.name; a post is not a person, so name one before enrolling`, path: target.path });
    const handle = target.block?.handle ?? options.handle ?? target.person ?? "";
    if (target.block && options.handle && options.handle !== target.block.handle) blockers.push({ code: "handle-immutable", detail: `enrolled handle "${target.block.handle}" never changes` });
    if (!blockers.length) blockers.push(...conflicts(census, target, handle));
    const identity: CompanyIdentity | null = target.block ?? (blockers.length ? null
      : { version: 1, subject: randomUUID(), handle, email: `${handle}@${COMPANY_MAIL_DOMAIN}`, status: "active", enrolled_at: new Date().toISOString() });
    return { target, blockers, identity, ...candidates(target, census) };
  };
  const run = async () => {
    const { target, blockers, identity, reconcile, warnings } = plan(identityCensus());
    const enrolled = Boolean(target.block);
    const base = { employee, ...summary(target), apply: Boolean(options.apply), enrolled, blockers, reconcile, warnings };
    if (blockers.length || !identity) return { ok: false, changed: false, identity: null, writes: [] as string[], ...base };
    if (enrolled) return { ok: true, changed: false, identity, writes: [] as string[], ...base };
    const preview = { appended: renderBlock(identity), ...(target.kind === "specialist" ? { schema_version: "1 -> 2" } : {}) };
    if (!options.apply) return { ok: true, changed: true, identity, writes: [] as string[], preview, note: "Preview only. --apply mints a fresh subject; once written it never changes.", ...base };
    return { ok: true, changed: true, identity, writes: await writeDefinition(target, identity), preview, ...base };
  };
  return options.apply ? withRegistryLock(environment().registryPath, run) : run();
}

/** Record local employment status. Never touches a provider. */
export async function setEmployeeStatus(employee: string, status: string, options: IdentityOptions = {}) {
  const run = async () => {
    const census = identityCensus();
    const target = resolveEmployee(census, employee);
    const blockers: IdentityBlocker[] = [];
    if (!STATUSES.includes(status as CompanyIdentityStatus)) blockers.push({ code: "invalid-status", detail: `status must be one of ${STATUSES.join(", ")}` });
    if (target.missing) blockers.push({ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path });
    else if (target.problem) blockers.push({ code: "invalid-definition", detail: target.problem, path: target.path });
    else if (stat(target.path)?.isSymbolicLink()) blockers.push({ code: "invalid-definition", detail: `refusing symlinked definition ${target.path}`, path: target.path });
    else if (!target.block) blockers.push({ code: "not-enrolled", detail: `${employee} has no company identity; enroll first` });
    else if (target.block.status === "retired" && status !== "retired") blockers.push({ code: "retired-terminal", detail: "a retired identity is a tombstone and never returns to service" });
    if (target.block && target.block.status !== "retired" && status !== "retired") {
      // The registry row may be gone and the block hand-edited back to active (or hand-written around a retired handle): the tombstone still answers.
      const retired = tombstoneFor(readTombstones(), target.block);
      if (retired) blockers.push(retired.by === "subject"
        ? { code: "retired-terminal", detail: `subject ${retired.tombstone.subject} was retired ${retired.tombstone.retired_at}; it never returns to service` }
        : { code: "handle-tombstoned", detail: `handle "${target.block.handle}" belonged to a retired employee (subject ${retired.tombstone.subject}, retired ${retired.tombstone.retired_at}); a retired handle never returns to service` });
    }
    const base = { employee, ...summary(target), apply: Boolean(options.apply), provider_revocation: "not_performed" as const, note: PROVIDER_REVOCATION_NOTE };
    if (blockers.length || !target.block) return { ok: false, changed: false, from: target.block?.status ?? null, to: status, identity: target.block, blockers, writes: [] as string[], ...base };
    if (target.block.status === status) return { ok: true, changed: false, from: status, to: status, identity: target.block, blockers, writes: [] as string[], ...base };
    const identity: CompanyIdentity = { ...target.block, status: status as CompanyIdentityStatus, status_changed_at: new Date().toISOString() };
    const writes = options.apply ? await writeDefinition(target, identity) : [];
    return { ok: true, changed: true, from: target.block.status, to: status, identity, blockers, writes, ...base };
  };
  return options.apply ? withRegistryLock(environment().registryPath, run) : run();
}

/**
 * Bind one provider principal to an enrolled employee (FLUME-56 provisioning).
 * Same-provider rebinding to a DIFFERENT principal is refused: rotation is a
 * deliberate lifecycle act (FLUME-53), never a side effect of provisioning.
 */
export async function bindEmployeeProvider(employee: string, provider: string, binding: CompanyIdentityBinding, options: IdentityOptions = {}) {
  const run = async () => {
    const census = identityCensus();
    const target = resolveEmployee(census, employee);
    const blockers: IdentityBlocker[] = [];
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(provider)) blockers.push({ code: "invalid-provider", detail: `provider "${provider}" must be a short snake_case key` });
    if (target.missing) blockers.push({ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path });
    else if (target.problem) blockers.push({ code: "invalid-definition", detail: target.problem, path: target.path });
    else if (!target.block) blockers.push({ code: "not-enrolled", detail: `${employee} has no company identity; enroll first` });
    else if (target.block.status === "retired") blockers.push({ code: "retired-terminal", detail: "a retired identity never gains bindings" });
    const tombstones = readTombstones();
    const ownTombstone = target.block ? tombstones.find(t => t.subject === target.block!.subject) : undefined;
    if (ownTombstone && target.block && target.block.status !== "retired") blockers.push({ code: "subject-tombstoned", detail: `subject ${ownTombstone.subject} was retired ${ownTombstone.retired_at}; it never gains bindings` });
    // A fresh subject hand-written around a retired handle would let the facade authorize reads of the retired mailbox.
    const handleTombstone = target.block && !ownTombstone ? tombstones.find(t => t.handle === target.block!.handle) : undefined;
    if (handleTombstone) blockers.push({ code: "handle-tombstoned", detail: `handle "${handleTombstone.handle}" belonged to a retired employee (subject ${handleTombstone.subject}, retired ${handleTombstone.retired_at}); it never gains bindings` });
    const requestedKey = `${provider}\u0000${binding.instance ?? ""}\u0000${binding.principal}`;
    for (const tombstone of tombstones) {
      if (tombstone.subject === target.block?.subject) continue;
      if (tombstoneBindingKeys(tombstone).includes(requestedKey)) blockers.push({ code: "binding-tombstoned", detail: `${provider} principal ${binding.principal} belonged to a retired employee (subject ${tombstone.subject}); it is never rebound` });
    }
    const base = { employee, ...summary(target), apply: Boolean(options.apply), provider };
    if (blockers.length || !target.block) return { ok: false, changed: false, binding: null, blockers, writes: [] as string[], ...base };
    const block = target.block;
    const existing = block.bindings?.[provider];
    if (existing) {
      // `native_actor_id` is adopted afterwards (FLUME-51), so an identical rebind must still be a no-op.
      const { native_actor_id: _adopted, ...requested } = existing;
      if (isDeepStrictEqual(requested, binding)) return { ok: true, changed: false, binding: existing, blockers, writes: [] as string[], ...base };
      return { ok: false, changed: false, binding: existing, blockers: [...blockers, { code: "binding-conflict", detail: `${provider} is already bound to principal ${existing.principal}; rotation is deliberate — unbind by hand first` }], writes: [] as string[], ...base };
    }
    const next: CompanyIdentity = { ...block, bindings: { ...(block.bindings ?? {}), [provider]: binding } };
    // Duplicate-binding check against every OTHER definition (conflicts() skips by
    // reference, so it cannot see a modified copy of the target — do it directly).
    const key = `${provider}\u0000${binding.instance ?? ""}\u0000${binding.principal}`;
    for (const other of census.definitions) {
      if (other.path === target.path || other.missing || other.problem) continue;
      if (bindingKeys(other.block).includes(key)) blockers.push({ code: "binding-duplicate", detail: `${provider} principal ${binding.principal} is also recorded at ${other.path}`, path: other.path });
    }
    if (blockers.length) return { ok: false, changed: false, binding: null, blockers, writes: [] as string[], ...base };
    const writes = options.apply ? await writeDefinition(target, next) : [];
    return { ok: true, changed: true, binding, blockers, writes, ...base };
  };
  return options.apply ? withRegistryLock(environment().registryPath, run) : run();
}

export interface BindInput { principal?: string; instance?: string; credentialRef?: string; attributionMode?: string }

/**
 * `flume identity bind`: validate the operator's input, then reuse bindEmployeeProvider and its blockers. For `github`
 * the principal is the App ID and the instance the installation ID (both digits), and the credential_ref is the
 * App private key by item UUID and field ID. Preview unless `--apply`.
 */
export async function bindProvider(employee: string, provider: string, input: BindInput, options: IdentityOptions = {}) {
  const blockers: IdentityBlocker[] = [];
  const problem = (code: string, detail: string) => blockers.push({ code, detail });
  if (!input.principal) problem("invalid-binding", "--principal is required");
  if (input.attributionMode !== undefined && !["native", "shared_bot_attributed"].includes(input.attributionMode)) problem("invalid-binding", "--attribution-mode must be native or shared_bot_attributed");
  let enrollment: { prerequisites: string[] } | undefined;
  if (provider === "github") {
    for (const detail of githubBindingProblems({ principal: input.principal, instance: input.instance, credential_ref: input.credentialRef })) if (!(detail.startsWith("principal") && !input.principal)) problem("invalid-binding", detail);
    if (input.credentialRef) { const detail = githubCredentialRefProblem(input.credentialRef); if (detail) problem("invalid-credential-ref", detail); }
  } else if (provider === "plane") {
    // FLUME-52: principal = the native Plane user UUID, instance = https://<host>/<workspace>, credential_ref = the employee's own PAT by item UUID and field ID.
    for (const detail of planeBindingProblems({ principal: input.principal, instance: input.instance, attribution_mode: input.attributionMode })) {
      if (detail.startsWith("principal") && !input.principal) continue;
      if (detail.startsWith("a plane binding is native-attributed") && !["native", "shared_bot_attributed"].includes(input.attributionMode ?? "native")) continue;
      problem("invalid-binding", detail);
    }
    if (!input.credentialRef) {
      problem("manual-enrollment-required", "no --credential-ref: Flume cannot create a Plane user or mint its token. The employee enrolls by hand (see enrollment.prerequisites), then binds by reference");
      let handle: string | undefined;
      try { handle = resolveEmployee(identityCensus(), employee).block?.handle; } catch { /* the bind itself reports an unknown employee */ }
      enrollment = { prerequisites: planeEnrollmentPrerequisites(handle) };
    } else { const detail = githubCredentialRefProblem(input.credentialRef); if (detail) problem("invalid-credential-ref", detail); }
    const stale = staleCandidate("plane", input.principal);
    if (stale) blockers.push(stale);
  } else if (input.credentialRef !== undefined && !input.credentialRef.startsWith("op://")) problem("invalid-credential-ref", "credential_ref must be an op:// reference");
  if (blockers.length) return { ok: false, changed: false, binding: null, blockers, writes: [] as string[], employee, provider, apply: Boolean(options.apply), ...(enrollment ? { enrollment } : {}) };
  const binding: CompanyIdentityBinding = {
    principal: input.principal!,
    ...(input.instance ? { instance: input.instance } : {}),
    ...(input.credentialRef ? { credential_ref: input.credentialRef } : {}),
    ...(input.attributionMode ? { attribution_mode: input.attributionMode as CompanyIdentityBinding["attribution_mode"] } : {}),
  };
  return bindEmployeeProvider(employee, provider, binding, options);
}

/**
 * `flume identity adopt-actor <employee> github` (FLUME-51): record the numeric user ID of the employee's own App bot on
 * their github binding. The ID comes from GitHub (`GET /app` with the App's JWT for the slug, then the public
 * `GET /users/<slug>[bot]`), never from the operator's typing. It never mints a token and writes nothing but
 * `native_actor_id` on that one binding. Preview unless `--apply`.
 */
export async function adoptNativeActor(employee: string, provider: string, options: IdentityOptions = {}) {
  if (provider === "plane") return adoptPlaneActor(employee, options);
  const run = async () => {
    const census = identityCensus();
    const target = resolveEmployee(census, employee);
    const blockers: IdentityBlocker[] = [];
    if (provider !== "github") blockers.push({ code: "unsupported-provider", detail: `adopt-actor supports github and plane, not "${provider}"` });
    if (target.missing) blockers.push({ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path });
    else if (target.problem) blockers.push({ code: "invalid-definition", detail: target.problem, path: target.path });
    else if (stat(target.path)?.isSymbolicLink()) blockers.push({ code: "invalid-definition", detail: `refusing symlinked definition ${target.path}`, path: target.path });
    else if (!target.block) blockers.push({ code: "not-enrolled", detail: `${employee} has no company identity; enroll first` });
    else if (target.block.status === "retired") blockers.push({ code: "retired-terminal", detail: "a retired identity never adopts an actor" });
    const base = { employee, ...summary(target), apply: Boolean(options.apply), provider };
    const none = { ok: false, changed: false, actor: null, binding: null, writes: [] as string[], ...base };
    if (blockers.length || !target.block) return { ...none, blockers };
    const block = target.block, existing = block.bindings?.github;
    const bound = githubBindingOf(existing);
    if ("code" in bound || !existing) return { ...none, blockers: [{ code: "code" in bound ? bound.code : "no-provider-binding", detail: "code" in bound ? bound.detail : "no github binding" }] };
    const actor = await resolveGithubBotActor({ appId: bound.facts.appId, keyRef: bound.facts.keyRef });
    if (!actor.ok) return { ...none, evidence: actor.evidence, blockers: [{ code: actor.code, detail: actor.detail }] };
    const facts = { id: actor.id, login: actor.login, type: actor.type, app_id: actor.app_id };
    const common = { actor: facts, evidence: actor.evidence, ...base };
    if (existing.native_actor_id !== undefined && existing.native_actor_id !== actor.id) {
      return { ok: false, changed: false, binding: existing, blockers: [{ code: "native-actor-conflict", detail: `${employee} already adopted actor ${existing.native_actor_id}; GitHub says ${actor.login} is ${actor.id}. Rotation is deliberate — remove native_actor_id by hand first` }], writes: [] as string[], ...common };
    }
    if (existing.native_actor_id === actor.id) return { ok: true, changed: false, binding: existing, blockers, writes: [] as string[], ...common };
    for (const other of census.definitions) {
      if (other.path === target.path || other.missing || other.problem) continue;
      const theirs = other.block?.bindings?.github;
      if (theirs?.native_actor_id !== actor.id) continue;
      if (existing.attribution_mode === "shared_bot_attributed" && theirs.attribution_mode === "shared_bot_attributed") continue;
      blockers.push({ code: "native-actor-duplicate", detail: `actor ${actor.id} (${actor.login}) is already adopted at ${other.path}; two employees are never one native actor unless both bindings are shared_bot_attributed`, path: other.path });
    }
    if (blockers.length) return { ok: false, changed: false, binding: existing, blockers, writes: [] as string[], ...common };
    const binding: CompanyIdentityBinding = { ...existing, native_actor_id: actor.id };
    const next: CompanyIdentity = { ...block, bindings: { ...(block.bindings ?? {}), github: binding } };
    const writes = options.apply ? await writeDefinition(target, next) : [];
    return { ok: true, changed: true, binding, blockers, writes, ...common };
  };
  return options.apply ? withRegistryLock(environment().registryPath, run) : run();
}

/** The registry's own `plane.member_id` for this employee's posts, when it names someone else. Reported, never written. */
function legacyRegistryWarnings(target: IdentityDefinition, census: IdentityCensus, principal: string): string[] {
  let rows: Record<string, Record<string, unknown>>;
  try { rows = registryRows(census.registryPath); } catch { return []; }
  const warnings: string[] = [];
  for (const post of target.posts) {
    const plane = rows[post]?.plane as { member_id?: unknown } | undefined;
    if (typeof plane?.member_id === "string" && plane.member_id !== principal) {
      warnings.push(`legacy-registry-principal: registry agents.${post}.plane.member_id is ${plane.member_id}, not the native Plane user ${principal}; the registry belongs to another authority and is not written here`);
    }
  }
  return warnings;
}

/**
 * `flume identity adopt-actor <employee> plane --board <b...>` (FLUME-52): have PILOT verify the employee's plane binding
 * (`px identity verify`, as the employee's own key, once per board) and stamp `native_actor_id` = the verified native user
 * ID. Every board must pass or nothing is written. Only an enrolled, active employee is adopted, and every gate fires before
 * any px call. Flume opens no Plane connection of its own. Preview unless `--apply`; the receipt is appended only on apply.
 */
async function adoptPlaneActor(employee: string, options: IdentityOptions) {
  const run = async () => {
    const census = identityCensus();
    const target = resolveEmployee(census, employee);
    const blockers: IdentityBlocker[] = [];
    if (target.missing) blockers.push({ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path });
    else if (target.problem) blockers.push({ code: "invalid-definition", detail: target.problem, path: target.path });
    else if (stat(target.path)?.isSymbolicLink()) blockers.push({ code: "invalid-definition", detail: `refusing symlinked definition ${target.path}`, path: target.path });
    else if (!target.block) blockers.push({ code: "not-enrolled", detail: `${employee} has no company identity; enroll first` });
    else if (target.block.status !== "active") blockers.push({ code: `employee-${target.block.status}`, detail: `${employee} is ${target.block.status}; only an active employee is adopted` });
    const evidence = planeEvidence();
    const base = { employee, ...summary(target), apply: Boolean(options.apply), provider: "plane", evidence };
    const none = { ok: false, changed: false, actor: null, binding: null, writes: [] as string[], ...base };
    if (blockers.length || !target.block) return { ...none, blockers };
    const block = target.block, existing = block.bindings?.plane;
    const boards = [...new Set(options.boards ?? [])];
    if (!boards.length) blockers.push({ code: "invalid-request", detail: "pass at least one --board <identifier|uuid>; board membership is verified per board and is not stored on the binding" });
    for (const board of boards) if (!isBoardArgument(board)) blockers.push({ code: "invalid-request", detail: `--board "${board}" must be a board identifier or UUID` });
    const bound = planeBindingOf(existing);
    if ("code" in bound || !existing) {
      const code = "code" in bound ? bound.code : "no-provider-binding";
      blockers.push({ code, detail: "code" in bound ? bound.detail : "no plane binding" });
      return { ...none, blockers, ...(code === "no-provider-binding" ? { enrollment: { prerequisites: planeEnrollmentPrerequisites(block.handle) } } : {}) };
    }
    const facts = bound.facts;
    const stale = staleCandidate("plane", existing.principal);
    if (stale) blockers.push(stale);
    if (existing.native_actor_id !== undefined && existing.native_actor_id !== existing.principal) {
      blockers.push({ code: "native-actor-conflict", detail: `${employee} already adopted actor ${existing.native_actor_id} but is bound to ${existing.principal}. Rotation is deliberate — remove native_actor_id by hand first` });
    }
    for (const other of census.definitions) {
      if (other.path === target.path || other.missing || other.problem) continue;
      if (other.block?.bindings?.plane?.native_actor_id === existing.principal) {
        blockers.push({ code: "native-actor-duplicate", detail: `actor ${existing.principal} is already adopted at ${other.path}; two employees are never one native actor`, path: other.path });
      }
    }
    if (blockers.length) return { ...none, binding: existing, blockers };

    // Every gate above fired without a px call. From here Pilot decides, board by board.
    const proofs: PlaneBoardProof[] = [];
    for (const board of boards) {
      const checked = verifyBoardViaPx(facts, block.handle, block.email, board);
      if ("proof" in checked) { proofs.push(checked.proof); continue; }
      blockers.push(checked.blocker);
      if (checked.fatal) break;
    }
    if (blockers.length) return { ...none, binding: existing, blockers, boards: proofs.map(proof => proof.board) };
    const first = proofs[0]!;
    const verified = { ...base, actor: { id: first.native_user_id, email: first.email, workspace: first.workspace.slug }, boards: proofs.map(proof => proof.board), workspace: first.workspace, plane: first.plane, credential: first.credential, shared_key_fallback: false as const, warnings: legacyRegistryWarnings(target, census, existing.principal) };
    const changed = existing.native_actor_id !== existing.principal;
    const binding: CompanyIdentityBinding = { ...existing, native_actor_id: existing.principal };
    const next: CompanyIdentity = { ...block, bindings: { ...(block.bindings ?? {}), plane: binding } };
    const writes = options.apply && changed ? await writeDefinition(target, next) : [];
    const receipt = options.apply ? appendPlaneReceipt({
      kind: "plane.adopt", evidence, employee, handle: block.handle, subject: block.subject, instance: facts.instance, principal: existing.principal, native_actor_id: existing.principal, changed,
      credential_ref: facts.keyRef, boards: proofs.map(proof => ({ id: proof.board.id, identifier: proof.board.identifier, name: proof.board.name })), workspace: first.workspace, plane: first.plane, credential: first.credential, shared_key_fallback: false,
    }) : undefined;
    return { ok: true, changed, binding, blockers, writes, ...(receipt ? { receipt } : {}), ...verified };
  };
  return options.apply ? withRegistryLock(environment().registryPath, run) : run();
}

/** Read-only: legacy (unenrolled) definitions stay readable. */
export function showEmployeeIdentity(employee: string) {
  const target = resolveEmployee(identityCensus(), employee);
  const blockers: IdentityBlocker[] = target.missing ? [{ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path }]
    : target.problem ? [{ code: "invalid-definition", detail: target.problem, path: target.path }] : [];
  const plane = target.block?.bindings?.plane;
  // A static Plane PAT: what Pilot last verified, else the honest "not verified, expiry not observable".
  const credentials = plane && target.block ? { plane: planeCredentialReport(target.block.subject, plane) } : undefined;
  return { ok: blockers.length === 0, employee, ...summary(target), enrolled: Boolean(target.block), identity: target.block, fields: target.fields, ...(credentials ? { credentials } : {}), blockers };
}

export interface RotateInput { credentialRef?: string; principal?: string; instance?: string }
const ROTATABLE = ["cloudflare_access", "github", "plane"] as const;
/** Where a rotate result's provider facts would come from: `provider` only against the official endpoint. */
const providerEvidence = (provider: string): "provider" | "fixture" =>
  provider === "github" ? githubEvidence() : provider === "plane" ? planeEvidence() : (process.env.FLUME_CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4").replace(/\/$/u, "") === "https://api.cloudflare.com/client/v4" ? "provider" : "fixture";

/**
 * `flume identity rotate <employee> <provider> --credential-ref <new>` (FLUME-53): change the binding's `credential_ref` and
 * nothing else. The principal, instance, `native_actor_id` and attribution are the person's identity at that provider and are
 * unchanged; a `--principal` or `--instance` that differs is refused. The old key is NOT revoked here (Flume never holds a
 * provider's revocation for a key it did not mint): it is reported `manual-action-required`. The new reference is checked
 * for shape and for being held nowhere else; it is not read. Gateway rotation is `gateway-tokens.py rotate` (FLUME-39).
 * Preview unless `--apply`; an apply appends one `identity.rotate` ledger line.
 */
export async function rotateEmployeeCredential(employee: string, provider: string, input: RotateInput, options: IdentityOptions = {}) {
  const run = async () => {
    const census = identityCensus();
    const target = resolveEmployee(census, employee);
    const blockers: IdentityBlocker[] = [];
    const problem = (code: string, detail: string) => blockers.push({ code, detail });
    if (provider === "gateway") problem("rotation-owned-elsewhere", "the gateway token is minted and rotated by gateway-tokens.py (FLUME-39), not here");
    else if (!(ROTATABLE as readonly string[]).includes(provider)) problem("invalid-request", `rotate supports ${ROTATABLE.join(", ")}, not "${provider}"`);
    if (target.missing) problem("invalid-definition", `definition not found: ${target.path}`);
    else if (target.problem) problem("invalid-definition", target.problem);
    else if (stat(target.path)?.isSymbolicLink()) problem("invalid-definition", `refusing symlinked definition ${target.path}`);
    else if (!target.block) problem("not-enrolled", `${employee} has no company identity; enroll first`);
    else if (target.block.status === "retired") problem("retired-terminal", "a retired identity never rotates a credential");
    else {
      const retired = tombstoneFor(readTombstones(), target.block);
      if (retired?.by === "subject") problem("subject-tombstoned", `subject ${retired.tombstone.subject} was retired ${retired.tombstone.retired_at}; it never rotates a credential`);
      else if (retired) problem("handle-tombstoned", `handle "${retired.tombstone.handle}" belonged to a retired employee (subject ${retired.tombstone.subject}); it never rotates a credential`);
    }
    const existing = target.block?.bindings?.[provider];
    if (target.block && target.block.status !== "retired" && !blockers.length && !existing) problem("no-provider-binding", `${employee} has no ${provider} binding to rotate`);
    const ref = input.credentialRef;
    if (!ref) problem("invalid-credential-ref", "--credential-ref is required");
    else {
      const detail = provider === "cloudflare_access" ? (ref.startsWith("op://") ? undefined : "credential_ref must be an op:// reference") : githubCredentialRefProblem(ref);
      if (detail) problem("invalid-credential-ref", detail);
    }
    if (existing && input.principal !== undefined && input.principal !== existing.principal) problem("rotation-changes-principal", `rotation keeps the principal (${existing.principal}); a different principal is a different identity at the provider`);
    if (existing && input.instance !== undefined && input.instance !== existing.instance) problem("rotation-changes-principal", `rotation keeps the instance${existing.instance ? ` (${existing.instance})` : ""}; a different instance is a different identity at the provider`);
    if (ref && target.block) {
      for (const other of census.definitions) {
        if (other.missing || other.problem) continue;
        for (const [name, held] of Object.entries(other.block?.bindings ?? {})) {
          if (held.credential_ref !== ref || (other.path === target.path && name === provider)) continue;
          problem("credential-ref-duplicate", `${ref} is already the ${name} credential_ref at ${other.path}`);
        }
      }
    }
    const base = { command: "rotate" as const, employee, ...summary(target), apply: Boolean(options.apply), provider };
    if (blockers.length || !target.block || !existing || !ref) return { ok: false, changed: false, binding: existing ?? null, blockers, writes: [] as string[], ...base };
    const previous = existing.credential_ref ?? null;
    const next = { ok: true, ...base, previous_ref: previous, credential_ref: ref, blockers };
    if (previous === ref) return { ...next, changed: false, binding: existing, writes: [] as string[], credentials: [] as unknown[], note: "The binding already holds this credential_ref; nothing changed." };
    const binding: CompanyIdentityBinding = { ...existing, credential_ref: ref };
    const identity: CompanyIdentity = { ...target.block, bindings: { ...(target.block.bindings ?? {}), [provider]: binding } };
    const writes = options.apply ? await writeDefinition(target, identity) : [];
    if (options.apply) writes.push(appendLifecycleLedger({ event: "identity.rotate", employee, handle: target.block.handle, subject: target.block.subject, provider, principal: existing.principal, ...(existing.instance ? { instance: existing.instance } : {}), previous_ref: previous, credential_ref: ref }));
    const nextAction = provider === "github" ? `flume access github-inspect --employee ${employee}`
      : provider === "plane" ? `flume identity adopt-actor ${employee} plane --board <board> --apply`
        : `flume access run ${employee} -- flume mail list`;
    return {
      ...next, changed: true, binding, writes,
      credentials: previous ? [{ provider, kind: "previous-credential-reference", ref: previous, static: true, status: "manual-action-required", evidence: providerEvidence(provider), next_action: `revoke the old ${provider} key at the provider; Flume never held its revocation (${provider === "plane" ? "Plane: the owner deletes the token under Profile > Personal Access Tokens" : provider === "github" ? "GitHub: delete the old private key in the App settings" : "Cloudflare: Access service tokens are not rotated in place; delete the old token in Zero Trust"})` }] : [],
      verification: { next_action: nextAction, identity_unchanged: { subject: target.block.subject, handle: target.block.handle, principal: existing.principal, native_actor_id: existing.native_actor_id ?? null } },
    };
  };
  return options.apply ? withRegistryLock(environment().registryPath, run) : run();
}
