// FLUME-52: bind an employee to its OWN native Plane user, verified by Pilot.
//
// This module is a Pilot CONSUMER and nothing else. Pilot (`px`) owns every Plane
// read and write; Flume runs `px identity verify` and `px show` as a subprocess and
// records what it says. There is no HTTP client to Plane here, no SQL, no bot or
// OAuth endpoint, no PAT minting, and no `px` write verb (`px identity comment`,
// `px comment`, ...) is ever invoked. Posting stays with the operator or the
// employee, through Pilot.
//
// A Plane personal access token is STATIC: Plane shows its expiry and revocation
// only to its owner's browser session, never to the key. So every result reports
// `type: plane_personal_access_token`, `static: true` and px's own `expiry`
// (`observable: false`) and `revocation`, and never an `expires_at` or a lifetime.
// A local session TTL (Flume, Cloudflare Access, the 1Password cache) is not it.
//
// `evidence` is "fixture" whenever FLUME_PX_BIN names a stand-in for px and
// "provider" otherwise; the code path is the same.
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { identityCensus, resolveEmployee } from "./company";
import { firstLine, githubCredentialRefProblem } from "./github";
import type { CompanyIdentityBinding } from "./types";

export const PLANE_PROVIDER = "plane";
export const PLANE_RECEIPT_FILE = "plane-verifications.jsonl";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_VERIFY_COMMENTS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BOARD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const TICKET_REF = /^[A-Za-z][A-Za-z0-9_]{0,31}-\d{1,9}$/u;
const EMPLOYEE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const INSTANCE = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?)\/([a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)$/u;

/** A lowercase native Plane user (or comment) UUID. */
export const isPlaneUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** What Plane lets anyone say about a PAT, mirrored from Pilot's CREDENTIAL_SEMANTICS for callers that make no px call. */
export const PLANE_CREDENTIAL_SEMANTICS = Object.freeze({
  type: "plane_personal_access_token",
  header: "X-API-Key",
  static: true,
  expiry: {
    observable: false,
    reason: "Plane exposes a token's expiry only to its owner's browser session; a key cannot read its own. The expiry is whatever was chosen when the token was created. A Flume, Cloudflare Access or 1Password session TTL is not it.",
  },
  revocation: {
    native: "the owner deletes the token under Profile > Personal Access Tokens (session-authenticated; no API-key route)",
    board_access: "an admin removes the user's project membership; board reads then answer 403 and verification reports not_project_member",
    px_verb: null,
  },
});

/** Everything an operator does by hand before `bind`; Flume never mints a Plane user or token. */
export function planeEnrollmentPrerequisites(handle = "<handle>"): string[] {
  return [
    `invite ${handle}@agents.delo.sh to the Plane workspace, or let it self-sign-up`,
    "sign in once as that user",
    "the employee creates its OWN personal access token in the browser (Profile > Personal Access Tokens) and records the expiry it chose",
    "vault the token and reference it by 1Password item UUID and field ID (op://<vault>/<26-char item uuid>/<field-id>)",
    "a workspace admin adds the employee to each board it works on",
    `then: flume identity bind ${handle} plane --principal <native-user-uuid> --instance https://<host>/<workspace> --credential-ref <op://...> --apply, and: flume identity adopt-actor ${handle} plane --board <board> --apply`,
  ];
}

// ---------------------------------------------------------------------------
// Binding (pure; no vault, no network, no px)
// ---------------------------------------------------------------------------

export interface PlaneInstance { origin: string; workspace: string }

/** `https://<host>/<workspace-slug>` exactly: no trailing slash, no extra path, query or fragment. */
export function parsePlaneInstance(instance: string): PlaneInstance | undefined {
  const match = INSTANCE.exec(instance);
  return match ? { origin: `https://${match[1]}`, workspace: match[2]! } : undefined;
}

export interface PlaneBindingFields { principal?: string; instance?: string; credential_ref?: string; attribution_mode?: string; native_actor_id?: string }

/** Problems with a plane binding's principal, instance, attribution and actor shape, or an empty list (the credential reference is checked separately). */
export function planeBindingProblems(binding: PlaneBindingFields): string[] {
  const problems: string[] = [];
  if (!binding.principal || !UUID.test(binding.principal)) problems.push("principal must be the lowercase native Plane user UUID");
  if (!binding.instance || !parsePlaneInstance(binding.instance)) problems.push("instance must be https://<host>/<workspace-slug> exactly (no trailing slash or extra path)");
  if (binding.attribution_mode !== undefined && binding.attribution_mode !== "native") problems.push("a plane binding is native-attributed only; shared_bot_attributed is refused");
  if (binding.native_actor_id !== undefined && !UUID.test(binding.native_actor_id)) problems.push("native_actor_id must be a lowercase Plane user UUID");
  return problems;
}

export interface PlaneBindingFacts { userId: string; origin: string; workspace: string; instance: string; keyRef: string }

/** The employee's OWN plane binding, or why it cannot be used. No fallback of any kind. */
export function planeBindingOf(binding: CompanyIdentityBinding | undefined): { facts: PlaneBindingFacts } | { code: "no-provider-binding" | "provider-binding-invalid"; detail: string } {
  if (!binding) return { code: "no-provider-binding", detail: "the employee has no plane binding; an operator binds one with `flume identity bind <employee> plane`" };
  const problems = planeBindingProblems(binding);
  if (!binding.credential_ref) problems.push("credential_ref must be an op:// reference to the employee's personal access token");
  else { const refProblem = githubCredentialRefProblem(binding.credential_ref); if (refProblem) problems.push(refProblem); }
  if (problems.length) return { code: "provider-binding-invalid", detail: problems.join("; ") };
  const instance = parsePlaneInstance(binding.instance!)!;
  return { facts: { userId: binding.principal, origin: instance.origin, workspace: instance.workspace, instance: binding.instance!, keyRef: binding.credential_ref! } };
}

// ---------------------------------------------------------------------------
// The px subprocess
// ---------------------------------------------------------------------------

/** "fixture" whenever FLUME_PX_BIN names a stand-in for Pilot, otherwise "provider". */
export function planeEvidence(env: NodeJS.ProcessEnv = process.env): "fixture" | "provider" {
  return env.FLUME_PX_BIN ? "fixture" : "provider";
}

function pxTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.FLUME_PX_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

export type PxOutcome =
  | { ok: true; data: Record<string, any> }
  | { ok: false; kind: "unavailable"; detail: string }
  | { ok: false; kind: "refused"; code: string; detail: string };

const clip = (text: string): string => firstLine(text).slice(0, 300);

/**
 * Run px once. No shell, no retry, and the parent environment passes through unchanged because px needs its own
 * op/shared-key environment to detect a fallback. A missing binary, a timeout or non-JSON stdout is `unavailable`;
 * an exit-1 `{ok:false, code}` is a `refused` carrying px's own code.
 */
export function runPx(args: string[], env: NodeJS.ProcessEnv = process.env): PxOutcome {
  const bin = env.FLUME_PX_BIN || "px", timeout = pxTimeoutMs(env);
  const result = spawnSync(bin, args, { encoding: "utf8", timeout, shell: false, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, kind: "unavailable", detail: "the px binary was not found (set FLUME_PX_BIN, or install Pilot)" };
    if (code === "ETIMEDOUT") return { ok: false, kind: "unavailable", detail: `px did not answer within ${timeout}ms` };
    return { ok: false, kind: "unavailable", detail: `px could not run${code ? ` (${code})` : ""}` };
  }
  if (result.status === null) return { ok: false, kind: "unavailable", detail: `px was killed by ${result.signal ?? "a signal"}` };
  let data: unknown;
  try { data = JSON.parse(result.stdout); } catch { return { ok: false, kind: "unavailable", detail: `px exited ${result.status} without a JSON answer on stdout` }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, kind: "unavailable", detail: `px exited ${result.status} with a JSON answer that is not an object` };
  const body = data as Record<string, any>;
  if (result.status === 0) return { ok: true, data: body };
  if (body.ok === false && typeof body.code === "string") return { ok: false, kind: "refused", code: body.code, detail: clip(String(body.error ?? body.code)) };
  // Real px fails some reads (a missing ticket) with {ok:false, error} and no code.
  if (body.ok === false && typeof body.error === "string") return { ok: false, kind: "refused", code: "unspecified", detail: clip(body.error) };
  return { ok: false, kind: "unavailable", detail: `px exited ${result.status} without a refusal` };
}

export interface PlaneBlocker { code: string; detail: string; provider_code?: string; board?: string }

/** Drop any lifetime a provider might report: a Plane PAT has no Flume-side or observable expiry. */
function withoutLifetime(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLifetime);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "expires_at" && key !== "lifetime_seconds").map(([key, inner]) => [key, withoutLifetime(inner)]));
  return value;
}

export interface PlaneCredentialReport {
  ref: string; type: string; static: true; header?: string;
  expiry: unknown; revocation: unknown; enrollment?: unknown;
}

export interface PlaneBoardProof {
  board: { id: string; identifier: string; name: string | null; member: true };
  workspace: { slug: string; role: unknown };
  plane: { version: string | null; edition: string | null };
  credential: PlaneCredentialReport;
  native_user_id: string;
  email: string;
  shared_key_fallback: false;
  verified_at: string | null;
}

/** One board, verified by Pilot as the employee's own key. A disagreement between px and the binding is never trusted. */
export function verifyBoardViaPx(facts: PlaneBindingFacts, handle: string, email: string, board: string, env: NodeJS.ProcessEnv = process.env): { proof: PlaneBoardProof } | { blocker: PlaneBlocker; fatal: boolean } {
  const outcome = runPx(["identity", "verify", "--json", "--employee", handle, "--key-ref", facts.keyRef, "--user-id", facts.userId, "--email", email, "--workspace", facts.workspace, "--base", facts.origin, "--board", board], env);
  if (!outcome.ok) {
    if (outcome.kind === "unavailable") return { blocker: { code: "provider-unavailable", detail: outcome.detail, board }, fatal: true };
    // A refused board is a fact about that board; any other refusal is about the credential and ends the run.
    return { blocker: { code: "provider-refused", provider_code: outcome.code, detail: outcome.detail, board }, fatal: !["not_project_member", "unknown_board", "board_archived"].includes(outcome.code) };
  }
  const data = outcome.data;
  const wrong = (detail: string) => ({ blocker: { code: "provider-result-mismatch", detail, board } as PlaneBlocker, fatal: false });
  if (data.ok !== true || data.verified !== true) return wrong("px answered exit 0 without ok:true and verified:true");
  if (data.native_user_id !== facts.userId) return wrong("px verified a different native user than the binding names");
  if (String(data.email ?? "").toLowerCase() !== email) return wrong("px verified a different mailbox than the employee's company address");
  if (data.workspace?.slug !== facts.workspace) return wrong("px verified a different workspace than the binding names");
  if (data.board?.member !== true || typeof data.board?.id !== "string") return wrong("px did not report the employee as a member of the requested board");
  const wanted = board.toLowerCase();
  if (String(data.board.id).toLowerCase() !== wanted && String(data.board.identifier ?? "").toLowerCase() !== wanted) return wrong("px verified a different board than the one requested");
  if (data.shared_key_fallback !== false) return wrong("px did not state that no shared key was used (shared_key_fallback must be false)");
  const credential = data.credential;
  if (!credential || credential.ref !== facts.keyRef) return wrong("px verified a different credential reference than the binding names");
  if (credential.type !== PLANE_CREDENTIAL_SEMANTICS.type) return wrong("px did not report a Plane personal access token");
  if (credential.expiry?.observable !== false) return wrong("px reported an observable token expiry; a Plane PAT is static and its expiry is not observable");
  return {
    proof: {
      board: { id: data.board.id, identifier: String(data.board.identifier ?? ""), name: data.board.name ?? null, member: true },
      workspace: { slug: facts.workspace, role: data.workspace?.role ?? null },
      plane: { version: data.plane?.version ?? null, edition: data.plane?.edition ?? null },
      credential: {
        ref: facts.keyRef, type: credential.type, static: true,
        ...(typeof credential.header === "string" ? { header: credential.header } : {}),
        expiry: withoutLifetime(credential.expiry ?? { observable: false }), revocation: withoutLifetime(credential.revocation ?? PLANE_CREDENTIAL_SEMANTICS.revocation),
        ...(credential.enrollment !== undefined ? { enrollment: withoutLifetime(credential.enrollment) } : {}),
      },
      native_user_id: data.native_user_id, email, shared_key_fallback: false, verified_at: typeof data.verified_at === "string" ? data.verified_at : null,
    },
  };
}

/** Validate a `--board` value: a board identifier or UUID, never a flag. */
export const isBoardArgument = (value: string): boolean => BOARD.test(value);

// ---------------------------------------------------------------------------
// Receipts: observation log lines, never definitions
// ---------------------------------------------------------------------------

/** `$FLUME_IDENTITY_STATE`, default `$XDG_STATE_HOME/flume/identity`. */
export function identityStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir();
  return env.FLUME_IDENTITY_STATE || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "flume", "identity");
}

/** Append one secret-free receipt line (mode 0600). IDs, `op://` references, board IDs, px codes, versions and evidence only. */
export function appendPlaneReceipt(line: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string {
  const dir = identityStateDir(env), path = join(dir, PLANE_RECEIPT_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function readPlaneReceipts(env: NodeJS.ProcessEnv = process.env): Array<Record<string, any>> {
  const path = join(identityStateDir(env), PLANE_RECEIPT_FILE);
  if (!existsSync(path)) return [];
  const lines: Array<Record<string, any>> = [];
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try { lines.push(JSON.parse(text)); } catch { /* a torn line is not an observation */ }
  }
  return lines;
}

/** What an employee's PAT is, from the latest adoption receipt for the subject; else the honest unverified answer. */
export function planeCredentialReport(subject: string, binding: CompanyIdentityBinding, env: NodeJS.ProcessEnv = process.env) {
  const keyRef = binding.credential_ref;
  // Only a receipt for exactly the current, still-adopted binding counts; a rebind makes the old observation history.
  const latest = binding.native_actor_id !== binding.principal ? undefined : readPlaneReceipts(env).filter(receipt => receipt.kind === "plane.adopt" && receipt.subject === subject && receipt.credential
    && receipt.credential_ref === binding.credential_ref && receipt.principal === binding.principal && receipt.instance === binding.instance).pop();
  if (!latest) return { type: PLANE_CREDENTIAL_SEMANTICS.type, static: true, ...(keyRef ? { ref: keyRef } : {}), verified: false, expiry: { observable: false } };
  const { credential } = latest as { credential: Record<string, unknown> };
  return { ...(withoutLifetime(credential) as Record<string, unknown>), static: true, verified: true, verified_at: latest.at, evidence: latest.evidence, boards: (latest.boards ?? []).map((b: { identifier?: string }) => b.identifier) };
}

// ---------------------------------------------------------------------------
// Comment authorship, read back through `px show`
// ---------------------------------------------------------------------------

export interface VerifyPlaneCommentsInput { ref: string; comments: string[]; apply?: boolean }
export type PlaneCommentResult = Record<string, unknown> & { ok: boolean };

type Authorship = "native-verified" | "not-native-verified";

/**
 * Read a ticket's comments through `px show` (the operator-key, third-party read the PX-13 receipt used) and decide, per
 * named employee, whether Plane says that employee's adopted native user wrote the named comment. Only `actor_id`
 * counts: the body, a marker, `actor_name`, the email and the order are never evidence. Read-only on Plane. Verifies the
 * historical comments of a retired or suspended employee too.
 */
export function verifyPlaneComments(input: VerifyPlaneCommentsInput, env: NodeJS.ProcessEnv = process.env): PlaneCommentResult {
  const evidence = planeEvidence(env);
  const refuse = (code: string, detail: string, extra: Record<string, unknown> = {}): PlaneCommentResult => ({ ok: false, status: "denied", code, detail, evidence, ...extra });
  if (!TICKET_REF.test(input.ref)) return refuse("invalid-arguments", "the target must be a ticket ref such as TEST-14");
  if (!input.comments.length) return refuse("invalid-arguments", "pass at least one --comment <employee>:<comment-id>");
  if (input.comments.length > MAX_VERIFY_COMMENTS) return refuse("invalid-arguments", `at most ${MAX_VERIFY_COMMENTS} comments are verified at once`);
  const parsed: Array<{ employee: string; id: string }> = [];
  for (const spec of input.comments) {
    const match = /^([^:]+):([^:]+)$/u.exec(spec);
    if (!match || !EMPLOYEE.test(match[1]!) || !UUID.test(match[2]!)) return refuse("invalid-arguments", "each --comment must be <employee>:<comment-uuid> (lowercase)");
    parsed.push({ employee: match[1]!, id: match[2]! });
  }

  // Resolve every named employee BEFORE any px call.
  let census: ReturnType<typeof identityCensus>;
  try { census = identityCensus(); } catch (error) { return refuse("census-unreadable", firstLine(error)); }
  const employees = new Map<string, { subject: string; handle: string; status: string; binding: CompanyIdentityBinding | undefined }>();
  for (const name of new Set(parsed.map(entry => entry.employee))) {
    try {
      const definition = resolveEmployee(census, name);
      if (!definition.block) return refuse("employee-not-enrolled", `${name} has no company identity`);
      employees.set(name, { subject: definition.block.subject, handle: definition.block.handle, status: definition.block.status, binding: definition.block.bindings?.[PLANE_PROVIDER] });
    } catch (error) {
      return refuse("employee-not-found", firstLine(error));
    }
  }

  // Which employees can be judged at all, and against which Plane instance.
  const judged = [...employees.values()].map(who => ({ who, bound: planeBindingOf(who.binding) })).filter(entry => "facts" in entry.bound && entry.who.binding?.native_actor_id);
  const instances = new Set(judged.map(entry => ("facts" in entry.bound ? entry.bound.facts.instance : "")));
  if (instances.size > 1) return refuse("mixed-instances", "the named employees are bound to different Plane instances; verify them separately");
  const target = judged.length ? ("facts" in judged[0]!.bound ? judged[0]!.bound.facts : undefined) : undefined;

  let ticket: Record<string, any> | undefined;
  if (target) {
    const outcome = runPx(["show", input.ref, "--json", "--workspace", target.workspace, "--base", target.origin], env);
    if (!outcome.ok) {
      return outcome.kind === "unavailable" ? refuse("provider-unavailable", outcome.detail) : refuse("provider-refused", outcome.detail, { provider_code: outcome.code });
    }
    ticket = outcome.data.ticket;
    if (outcome.data.ok !== true || !ticket || typeof ticket !== "object" || !Array.isArray(ticket.comments)) return refuse("provider-result-mismatch", "px show returned no ticket with a comments list");
  }
  const boardId = typeof ticket?.project === "string" ? ticket.project : null;

  const comments: Array<Record<string, unknown>> = [];
  const verdicts: Array<{ employee: string; subject: string; id: string; authorship: Authorship; actorId: string | null }> = [];
  for (const entry of parsed) {
    const who = employees.get(entry.employee)!;
    const base = { employee: entry.employee, subject: who.subject, handle: who.handle, employee_status: who.status, id: entry.id };
    const note = (authorship: Authorship, reason: string | undefined, extra: Record<string, unknown> = {}, actorId: string | null = null) => {
      verdicts.push({ employee: entry.employee, subject: who.subject, id: entry.id, authorship, actorId });
      comments.push({ ...base, authorship, ...(reason ? { reason } : {}), ...extra });
    };
    const bound = planeBindingOf(who.binding);
    if ("code" in bound || !who.binding) { note("not-native-verified", "code" in bound ? bound.code : "no-provider-binding"); continue; }
    const adopted = who.binding.native_actor_id;
    if (!adopted) { note("not-native-verified", "native-actor-not-adopted"); continue; }
    if (adopted !== who.binding.principal) { note("not-native-verified", "native-actor-conflict", { native_actor_id: adopted }); continue; }
    const comment = (ticket?.comments as Array<Record<string, any>>).find(row => row?.id === entry.id);
    if (!comment) { note("not-native-verified", "comment-not-found", { native_actor_id: adopted }); continue; }
    const actorId = typeof comment.actor_id === "string" ? comment.actor_id.toLowerCase() : null;
    if (actorId !== adopted) { note("not-native-verified", "author-mismatch", { native_actor_id: adopted, actor_id: actorId, board_id: boardId }, actorId); continue; }
    note("native-verified", undefined, { native_actor_id: adopted, actor_id: actorId, board_id: boardId, created_at: comment.created_at ?? null }, actorId);
  }

  // -- per employee ---------------------------------------------------------------------------------
  const bySubject = new Map<string, Record<string, any>>();
  for (const [name, who] of employees) {
    const row = bySubject.get(who.subject) ?? { subject: who.subject, handle: who.handle, employee: name, native_actor_id: who.binding?.native_actor_id ?? null, comment_ids: [] as string[] };
    row.comment_ids = [...row.comment_ids, ...verdicts.filter(verdict => verdict.employee === name).map(verdict => verdict.id)];
    bySubject.set(who.subject, row);
  }
  const rows = [...bySubject.values()];

  // -- verdict: only distinct native users, each comment written by its own adopted actor ------------------
  const reasons: string[] = [];
  if (rows.length < 2) reasons.push("fewer-than-two-employees");
  for (const verdict of verdicts) if (verdict.authorship !== "native-verified") reasons.push(`not-native-verified:${verdict.employee}:${verdict.id}`);
  const shared = (pick: (verdict: (typeof verdicts)[number], row: Record<string, any>) => string | null) => {
    const seen = new Map<string, Set<string>>();
    for (const verdict of verdicts) { const key = pick(verdict, bySubject.get(verdict.subject)!); if (key) seen.set(key, (seen.get(key) ?? new Set()).add(verdict.subject)); }
    return [...seen.values()].some(subjects => subjects.size > 1);
  };
  // Two employees bound to one native actor, or whose comments Plane says one account wrote, are one actor.
  if (shared((_verdict, row) => row.native_actor_id) || shared(verdict => verdict.actorId)) reasons.push("shared-actor");
  const unique = [...new Set(reasons)];
  const distinct = unique.length === 0;
  const result: PlaneCommentResult = {
    ok: distinct, status: distinct ? "verified" : "unverified",
    verdict: distinct ? "native-distinct-verified" : "not-native-distinct",
    ...(distinct ? {} : { reasons: unique }),
    evidence, ref: input.ref, board_id: boardId, apply: Boolean(input.apply), employees: rows, comments,
    credential: { type: PLANE_CREDENTIAL_SEMANTICS.type, static: true, expiry: { observable: false } },
  };
  if (input.apply && target) {
    result.receipt = appendPlaneReceipt({
      kind: "plane.verify-comments", evidence, ref: input.ref, board_id: boardId, instance: target.instance, verdict: result.verdict, ...(distinct ? {} : { reasons: unique }),
      comments: comments.map(row => ({ employee: row.employee, subject: row.subject, comment_id: row.id, actor_id: row.actor_id ?? null, native_actor_id: row.native_actor_id ?? null, authorship: row.authorship, ...(row.reason ? { reason: row.reason } : {}) })),
    }, env);
  }
  return result;
}

/** One screenful for a person; `--json` is the full record. */
export function formatPlaneCommentResult(result: PlaneCommentResult): string {
  if (result.verdict) {
    const lines = [`${result.verdict}${Array.isArray(result.reasons) ? ` (${(result.reasons as string[]).join(", ")})` : ""}`];
    for (const row of (result.comments as Array<Record<string, any>> | undefined) ?? []) lines.push(`  ${row.handle} ${row.id}: ${row.authorship}${row.reason ? ` (${row.reason})` : ""} actor ${row.actor_id ?? "-"}`);
    lines.push(`ref ${String(result.ref)} board ${String(result.board_id ?? "-")} evidence ${String(result.evidence)}${result.receipt ? ` receipt ${String(result.receipt)}` : ""}`);
    return lines.join("\n");
  }
  return `${result.status}${result.code ? ` ${result.code}` : ""}: ${String(result.detail ?? "")}${result.provider_code ? ` (px ${String(result.provider_code)})` : ""}`;
}
