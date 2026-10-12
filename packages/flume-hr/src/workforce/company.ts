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
// revokes nothing at any provider; FLUME-53 owns revocation, and every status
// answer says so.
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { resolveFlumeRoot } from "../kernel/paths";
import { copierFleetPaths } from "../hire/PreserveRegistryComments";
import { renderDeskContract } from "./desk";
import { readRoleIdentity } from "./identity";
import { withRegistryLock } from "./role";
import { COMPANY_MAIL_DOMAIN, RESERVED_HANDLES, parseNamedAgentYaml, validateCompanyIdentity, validateNamedAgent, validateNamedAgentSchema } from "./validator";
import type { CompanyIdentity, CompanyIdentityStatus } from "./types";

const HANDLE = /^[a-z0-9][a-z0-9_-]{0,57}$/u;
const EMPLOYEE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const STATUSES: readonly CompanyIdentityStatus[] = ["active", "suspended", "retired"];
export const PROVIDER_REVOCATION_NOTE = "Local employment state only: provider access was not revoked (FLUME-53 owns provider revocation).";

export interface IdentityBlocker { code: string; detail: string; path?: string }
export interface ReconcileCandidate { provider: string; principal: string; person?: string; post?: string; description?: string; state: "unadopted" | "bound"; bound_at?: string }

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

export interface IdentityOptions { apply?: boolean; handle?: string }

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

/** Every reason this definition may not hold this handle. Pure: reads the census only. */
function conflicts(census: IdentityCensus, target: IdentityDefinition, handle: string): IdentityBlocker[] {
  const blockers: IdentityBlocker[] = [];
  if (!HANDLE.test(handle)) blockers.push({ code: "invalid-handle", detail: `handle "${handle}" must match ${HANDLE.source}` });
  if (RESERVED_HANDLES.has(handle)) blockers.push({ code: "handle-reserved", detail: `"${handle}" is an RFC 2142 role mailbox` });
  const ownPost = target.kind === "specialist" && target.person === handle;
  if (census.postIds.includes(handle) && !ownPost) blockers.push({ code: "handle-reserved", detail: `"${handle}" is a registry post id; a person's handle never names a post` });
  const bindings = bindingKeys(target.block);
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

function candidates(target: IdentityDefinition, census: IdentityCensus): { reconcile: ReconcileCandidate[]; warnings: string[] } {
  const path = process.env.FLUME_IDENTITY_CANDIDATES || join(resolveFlumeRoot(), "contracts", "company-identity-candidates.yaml");
  if (!existsSync(path)) return { reconcile: [], warnings: [`candidate inventory not found: ${path}`] };
  const inventory = YAML.parse(readFileSync(path, "utf8")) as { candidates?: Array<Omit<ReconcileCandidate, "state">> } | null;
  const reconcile: ReconcileCandidate[] = [];
  for (const candidate of inventory?.candidates ?? []) {
    if (!(target.person && candidate.person === target.person) && !(candidate.post && target.posts.includes(candidate.post))) continue;
    const holder = census.definitions.find(d => Object.entries(d.block?.bindings ?? {}).some(([provider, b]) => provider === candidate.provider && b.principal === candidate.principal));
    reconcile.push({ ...candidate, ...(holder ? { state: "bound", bound_at: holder.path } : { state: "unadopted" }) });
  }
  return { reconcile, warnings: [] };
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
    if (target.problem) blockers.push({ code: "invalid-definition", detail: target.problem, path: target.path });
    else if (stat(target.path)?.isSymbolicLink()) blockers.push({ code: "invalid-definition", detail: `refusing symlinked definition ${target.path}`, path: target.path });
    else if (!target.block) blockers.push({ code: "not-enrolled", detail: `${employee} has no company identity; enroll first` });
    else if (target.block.status === "retired" && status !== "retired") blockers.push({ code: "retired-terminal", detail: "a retired identity is a tombstone and never returns to service" });
    const base = { employee, ...summary(target), apply: Boolean(options.apply), provider_revocation: "not_performed" as const, note: PROVIDER_REVOCATION_NOTE };
    if (blockers.length || !target.block) return { ok: false, changed: false, from: target.block?.status ?? null, to: status, identity: target.block, blockers, writes: [] as string[], ...base };
    if (target.block.status === status) return { ok: true, changed: false, from: status, to: status, identity: target.block, blockers, writes: [] as string[], ...base };
    const identity: CompanyIdentity = { ...target.block, status: status as CompanyIdentityStatus, status_changed_at: new Date().toISOString() };
    const writes = options.apply ? await writeDefinition(target, identity) : [];
    return { ok: true, changed: true, from: target.block.status, to: status, identity, blockers, writes, ...base };
  };
  return options.apply ? withRegistryLock(environment().registryPath, run) : run();
}

/** Read-only: legacy (unenrolled) definitions stay readable. */
export function showEmployeeIdentity(employee: string) {
  const target = resolveEmployee(identityCensus(), employee);
  const blockers: IdentityBlocker[] = target.missing ? [{ code: "invalid-definition", detail: `definition not found: ${target.path}`, path: target.path }]
    : target.problem ? [{ code: "invalid-definition", detail: target.problem, path: target.path }] : [];
  return { ok: blockers.length === 0, employee, ...summary(target), enrolled: Boolean(target.block), identity: target.block, fields: target.fields, blockers };
}
