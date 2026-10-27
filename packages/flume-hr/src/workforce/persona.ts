// FLUME-69: continuity-safe employee persona update.
//
// `flume identity update <employee> --name Christopher [--tone ...]
// [--directives-file ...]` renames the PERSON and re-voices their charter on
// the definition the employee already owns (an enrolled portable specialist's
// `~/.agents/workforce/<id>/agent.yaml`). It is a preview unless `--apply`.
//
// What it deliberately is NOT:
// - It never invents personality from the name. `--name` touches
//   `display_name` only; tone and directives change only when the operator
//   passes them.
// - It never touches the identity: id, role, skills, memory banks,
//   company_identity (subject/handle/email/bindings), schema_version and the
//   desk are proven semantically preserved, and the read-back proof runs
//   before the change is committed.
// - It never edits the original hire definition or hand-writes the profile.
//   The write path is: (1) splice the owned agent.yaml under the registry
//   lock, verified with an exact rollback; (2) converge the desk, profile and
//   registry row through the SAME onboarding refresh (`flume onboard
//   --employee <id>`) that already owns projection, locks and crash recovery.
//   Preflight refuses before publication; a later interruption retains the
//   candidate definition for forward recovery through onboard --employee.
// - It does not pretend the world synced. Provider display names, the vault
//   item label, the mailbox, avatars and external Slack names are NOT changed
//   here; they are reported `unmanaged` with their owner.
//
// Repo employees (posts, role.yaml) are refused until the named-post flow
// grows the same guarantees; see the `unsupported-post-definition` blocker.
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { identityCensus, resolveEmployee } from "./company";
import { hireSpecialist, withSpecialistUpdate } from "./specialist";
import { parseNamedAgentYaml, validateNamedAgentSchema } from "./validator";
import type { NamedAgentContract } from "./types";

const EMPLOYEE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const NAME_MAX = 80;
const TONE_MAX = 400;
const DIRECTIVE_MAX = 4000;
const DIRECTIVES_MAX = 64;

/** Surfaces this command does not own. Reported, never silently "synced". */
const UNMANAGED_SURFACES: Array<{ surface: string; detail: string }> = [
  { surface: "provider_display_names", detail: "GitHub App name and Plane user display name are provider-side profile settings; change them at the provider and re-verify with flume identity adopt-actor where applicable" },
  { surface: "vault_item_label", detail: "1Password item titles (hermes-<id>, member tokens) name the credential, not the person; rename them in the vault if wanted" },
  { surface: "mailbox", detail: `${"the"} @agents.delo.sh address follows the immutable company handle; persona never readdresses mail` },
  { surface: "avatar", detail: "chat avatars are per-platform uploads; flume holds none" },
  { surface: "external_slack", detail: "external Slack workspace display names are per-workspace profiles flume does not manage" },
];

/** Every immutable leaf the update must prove preserved, by deep equality. */
const IMMUTABLE_KEYS = ["id", "role", "skills", "memory", "desk", "schema_version", "identity", "company_identity"] as const;

export interface PersonaUpdateOptions { apply?: boolean; name?: string; tone?: string; directivesFile?: string }
export interface PersonaBlocker { code: string; detail: string }

interface Persona {
  display_name: string;
  tone: string | null;
  directives: string[];
}

function personaOf(contract: NamedAgentContract): Persona {
  return { display_name: contract.display_name, tone: contract.charter?.tone ?? null, directives: contract.charter?.directives ?? [] };
}

function stat(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** The established definition-publish shape (company.ts): atomic, mode-preserving, same-directory. */
function publish(path: string, text: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing non-regular definition ${path}`);
  const temporary = join(dirname(path), `.${basename(path)}.persona-${randomUUID()}.tmp`);
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

/** A directives file is a YAML list of strings, or one directive per line. */
function parseDirectives(text: string): { directives?: string[]; problem?: string } {
  let parsed: unknown;
  try { parsed = YAML.parse(text); } catch { return { problem: "the directives file is not valid YAML or plain text" }; }
  if (parsed !== null && parsed !== undefined && !Array.isArray(parsed) && typeof parsed !== "string") {
    return { problem: "the directives file must be a YAML list of strings (or one directive per line)" };
  }
  if (Array.isArray(parsed) && !parsed.every(item => typeof item === "string")) {
    return { problem: "the directives file must be a YAML list of strings (or one directive per line)" };
  }
  // Plain multi-line text folds into one YAML scalar; treat a string as line-based.
  const candidates = Array.isArray(parsed) ? parsed : text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const directives = candidates.map(item => item.trim()).filter(Boolean);
  if (!directives.length) return { problem: "the directives file holds no directives" };
  if (directives.length > DIRECTIVES_MAX) return { problem: `at most ${DIRECTIVES_MAX} directives, found ${directives.length}` };
  const long = directives.find(item => item.length > DIRECTIVE_MAX);
  if (long) return { problem: `a directive exceeds ${DIRECTIVE_MAX} characters` };
  if (directives.some(item => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item))) return { problem: "directives may not contain control characters" };
  return { directives };
}

/** Edit persona nodes while retaining YAML comments and other semantic values. */
function editedPersona(text: string, next: { name?: string; tone?: string; directives?: string[] }): string {
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`definition is not valid YAML: ${doc.errors[0]!.message}`);
  if (next.name !== undefined) doc.setIn(["display_name"], next.name);
  if (next.tone !== undefined) doc.setIn(["charter", "tone"], next.tone);
  if (next.directives !== undefined) doc.setIn(["charter", "directives"], next.directives);
  return String(doc);
}

/** Prove the only semantic change is the persona: every immutable key deep-equals the original. */
function continuityProblems(before: unknown, after: unknown): string[] {
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of IMMUTABLE_KEYS) if (!isDeepStrictEqual(left[key], right[key])) problems.push(key);
  if (!isDeepStrictEqual((left as { charter?: { purpose?: unknown } }).charter?.purpose, (right as { charter?: { purpose?: unknown } }).charter?.purpose)) problems.push("charter.purpose");
  return problems;
}

/**
 * Preview (default) or apply one persona update. A blocker writes nothing and
 * exits nonzero. A partial apply retains its canonical candidate and reports
 * the supported forward-recovery command.
 */
export async function updateEmployeePersona(employee: string, options: PersonaUpdateOptions = {}) {
  if (!EMPLOYEE.test(employee)) throw new Error(`Unsafe employee identity: ${employee}`);
  const home = process.env.HOME || homedir();


  const blockers: PersonaBlocker[] = [];
  const problem = (code: string, detail: string) => blockers.push({ code, detail });

  let target: ReturnType<typeof resolveEmployee> | undefined;
  try { target = resolveEmployee(identityCensus(), employee); }
  catch (error) { problem("employee-not-found", (error as Error).message); }

  let contract: NamedAgentContract | undefined;
  let text: string | undefined;
  if (target) {
    if (target.missing) problem("invalid-definition", `definition not found: ${target.path}`);
    else if (target.problem) problem("invalid-definition", target.problem);
    else if (stat(target.path)?.isSymbolicLink()) problem("invalid-definition", `refusing symlinked definition ${target.path}`);
    else if (target.kind !== "specialist") {
      problem("unsupported-post-definition", `${employee} is a repo employee (post ${target.path}); persona update supports enrolled portable specialists (agent.yaml). A post holder's name is the named-agent identity contract, not this command`);
    } else {
      try {
        text = readFileSync(target.path, "utf8");
        contract = validateNamedAgentSchema(text);
        const desk = dirname(target.path);
        if (resolve(desk) !== resolve(join(home, ".agents", "workforce", contract.id))) problem("noncanonical-desk", `definition must live at ${join(home, ".agents", "workforce", contract.id, "agent.yaml")}, not ${target.path}`);
      } catch (error) { problem("invalid-definition", (error as Error).message); }
    }
  }

  // Operator input validation: hostile or empty values refuse before any read of downstream state.
  if (options.name !== undefined) {
    const name = options.name.trim();
    if (!name || name.length > NAME_MAX) problem("invalid-name", `--name must be 1-${NAME_MAX} non-space characters`);
    else if (CONTROL.test(options.name)) problem("invalid-name", "--name may not contain control characters or line breaks");
  }
  if (options.tone !== undefined) {
    const tone = options.tone.trim();
    if (!tone || tone.length > TONE_MAX) problem("invalid-tone", `--tone must be 1-${TONE_MAX} characters`);
    else if (CONTROL.test(options.tone)) problem("invalid-tone", "--tone may not contain control characters or line breaks");
  }
  let directives: string[] | undefined;
  if (options.directivesFile !== undefined) {
    const path = resolve(options.directivesFile);
    const info = stat(path);
    if (!info) problem("invalid-directives", `directives file not found: ${path}`);
    else if (info.isSymbolicLink() || !info.isFile()) problem("invalid-directives", `directives file must be a regular file: ${path}`);
    else {
      const parsed = parseDirectives(readFileSync(path, "utf8"));
      if (parsed.problem) problem("invalid-directives", parsed.problem);
      else directives = parsed.directives;
    }
  }
  if (!blockers.length && options.name === undefined && options.tone === undefined && options.directivesFile === undefined) {
    problem("invalid-request", "name a change: --name, --tone and/or --directives-file");
  }

  const base = { employee, kind: target?.kind ?? null, definition: target?.path ?? null, apply: Boolean(options.apply), unmanaged: UNMANAGED_SURFACES };
  if (blockers.length || !target || !contract || !text) return { ok: false, changed: false, blockers, ...base };

  const from = personaOf(contract);
  const to: Persona = { display_name: options.name?.trim() ?? from.display_name, tone: options.tone?.trim() ?? from.tone, directives: directives ?? from.directives };
  const immutable = { id: contract.id, role: contract.role, skills: contract.skills, memory: contract.memory, company_identity: contract.company_identity ?? null };
  const noChange = isDeepStrictEqual(from, to);

  // The candidate definition, proven persona-only before anything else happens.
  let updated: string;
  try {
    updated = editedPersona(text, { ...(options.name !== undefined ? { name: to.display_name } : {}), ...(options.tone !== undefined ? { tone: to.tone! } : {}), ...(directives ? { directives } : {}) });
    const candidate = validateNamedAgentSchema(updated);
    const drifted = continuityProblems(parseNamedAgentYaml(text), candidate);
    if (drifted.length) throw new Error(`the edit would change immutable key(s): ${drifted.join(", ")}`);
    if (candidate.display_name !== to.display_name || (to.tone !== null && candidate.charter.tone !== to.tone)) throw new Error("the edit did not land the requested persona");
  } catch (error) {
    return { ok: false, changed: false, blockers: [{ code: "edit-refused", detail: (error as Error).message }], from, to, immutable, ...base };
  }

  if (noChange && !options.apply) {
    return { ok: true, changed: false, from, to, immutable, note: "The definition already carries this persona; nothing to do.", writes: [] as string[], managed: { agent_yaml: "unchanged", projection: [], registry_row: "unchanged" }, blockers: [], ...base };
  }

  // PREVIEW: run the real onboarding pipeline dry against the candidate bytes. Zero writes.
  if (!options.apply) {
    const scratchRoot = process.env.TMPDIR || join(home, ".hermes/cache/scratch");
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, "flume-persona-"));
    try {
      const candidate = join(scratch, "agent.yaml");
      writeFileSync(candidate, updated, "utf8");
      const preview = await hireSpecialist(candidate, true, { expectedEmployee: contract.id, dryRun: true });
      return { ok: true, changed: true, from, to, immutable, preview: { projection: preview.projection, selection: preview.selection }, managed: { agent_yaml: "preview (pass --apply)", projection: preview.projection.changed, registry_row: "preview (pass --apply)" }, writes: [] as string[], blockers: [], ...base };
    } catch (error) {
      return { ok: false, changed: false, blockers: [{ code: "preview-failed", detail: `the onboarding pipeline refused the candidate definition: ${(error as Error).message}` }], from, to, immutable, ...base };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }

  // Keep the registry transaction through preflight, publication and refresh.
  // An interrupted projection recovers forwards via its existing journal.
  return withSpecialistUpdate(contract.id, async (refresh) => {
    const freshTarget = resolveEmployee(identityCensus(), employee);
    if (freshTarget.path !== target.path || freshTarget.problem || readFileSync(target.path, "utf8") !== text) {
      return { ok: false, changed: false, from, to, immutable, writes: [], blockers: [{ code: "definition-changed", detail: "Employee changed while waiting for the registry lock; retry" }], ...base };
    }
    const scratchRoot = process.env.TMPDIR || join(home, ".hermes/cache/scratch");
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, "flume-persona-"));
    try {
      const candidate = join(scratch, "agent.yaml");
      writeFileSync(candidate, updated, { mode: 0o600 });
      await refresh(true, candidate);
    } catch (error) {
      return { ok: false, changed: false, from, to, immutable, writes: [], blockers: [{ code: "preview-failed", detail: (error as Error).message }], ...base };
    } finally { rmSync(scratch, { recursive: true, force: true }); }

    const writes: string[] = [];
    if (!noChange) {
      const recovery = join(dirname(target.path), `.persona-recovery-${randomUUID()}`);
      linkSync(target.path, recovery);
      try {
        publish(target.path, updated);
        const verified = validateNamedAgentSchema(readFileSync(target.path, "utf8"));
        if (continuityProblems(parseNamedAgentYaml(text), verified).length || !isDeepStrictEqual(personaOf(verified), to)) throw new Error("Persona read-back failed");
      } catch (error) {
        renameSync(recovery, target.path);
        return { ok: false, changed: false, from, to, immutable, writes: [], blockers: [{ code: "definition-write-failed", detail: (error as Error).message }], ...base };
      } finally { rmSync(recovery, { force: true }); }
      writes.push(target.path);
    }
    try {
      const result = await refresh();
      return { ok: true, changed: !noChange || result.changed, from, to, immutable, writes,
        note: noChange ? "The definition already carries this persona; projection checked and converged." : undefined,
        managed: { agent_yaml: noChange ? "unchanged" : "written", projection: result.projection.changed, registry_row: "converged" },
        refresh: result, blockers: [], ...base };
    } catch (error) {
      return { ok: false, changed: !noChange, from, to, immutable, writes,
        blockers: [{ code: "projection-failed", detail: (error as Error).message }],
        recovery: { definition_retained: true, next_action: `flume onboard --employee ${contract.id}` },
        note: "Candidate definition retained for forward recovery; no stale rollback performed.", ...base };
    }
  });
}
