// FLUME-51: leave a code-review comment as an employee, and prove WHO left it.
//
// `flume comment post` and `flume comment verify` are `--exec` consumers of the
// FLUME-50 GitHub installation token. They never mint one, never read a vault,
// never fall back to a PAT or the operator's `gh`.
//
// Authorship is decided by exactly one thing: what GitHub reports when the
// comment is read back. `user.id` (as a string) must equal the `native_actor_id`
// the operator adopted on the employee's github binding, and `user.type` must
// be `Bot`. Body text, the marker, display names, logins, email and git commit
// metadata are never evidence. The marker only finds an earlier copy of OUR
// comment, and that copy must pass the same `user.id` check, so a stranger who
// copies a marker cannot make a comment ours or stop us posting.
//
// GitHub comment creation has no idempotency key. So every invocation reconciles
// first (list, keep marker + author matches), POSTs at most once, and after an
// ambiguous POST reconciles once more and reports `comment-ambiguous` rather than
// POSTing again. The caller re-runs with the same `--marker`.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { identityCensus, resolveEmployee } from "./company";
import { firstLine, githubApiBase, githubBindingOf, githubEvidence, githubRequestShape, githubTimeoutMs, isTimeout, statusOf, transport, type Transport } from "./github";
import type { CompanyIdentityBinding } from "./types";

const MARKER = /^[A-Za-z0-9._-]{8,128}$/u;
const COMMIT = /^[0-9a-fA-F]{40}$/u;
const PER_PAGE = 100;
const MAX_PAGES = 10;
const MAX_BODY_CHARS = 60_000;
const MAX_VERIFY_COMMENTS = 50;
export const COMMENT_MARKER_PREFIX = "flume-comment:";
export const markerLine = (marker: string): string => `<!-- ${COMMENT_MARKER_PREFIX}${marker} -->`;

export type CommentKind = "issue" | "review";
export type Authorship = "native-verified" | "shared-bot-attributed" | "not-native-verified";
export interface CommentResult { ok: boolean; status: "verified" | "unverified" | "denied" | "error"; evidence: "provider" | "fixture"; code?: string; [key: string]: unknown }

export interface PostCommentInput {
  repository: string;
  number: string;
  body?: string;
  bodyFile?: string;
  marker?: string;
  review?: boolean;
  commit?: string;
  path?: string;
  line?: string;
  side?: string;
  /** Flags that exist only to be refused: --start-line, --position, --subject-type, --event. */
  unsupported?: string[];
}

interface Comment {
  id?: unknown; body?: unknown; html_url?: unknown; user?: { id?: unknown; login?: unknown; type?: unknown } | null;
  performed_via_github_app?: { id?: unknown } | null;
  issue_url?: unknown; pull_request_url?: unknown; path?: unknown; line?: unknown; side?: unknown; commit_id?: unknown;
}

// ---------------------------------------------------------------------------
// The one authorship rule
// ---------------------------------------------------------------------------

export interface AuthorshipVerdict { authorship: Authorship; reason?: string; author: { id: string | null; login: string | null; type: string | null } }

function authorOf(comment: Comment): AuthorshipVerdict["author"] {
  const id = comment.user?.id;
  return {
    id: typeof id === "number" && Number.isSafeInteger(id) ? String(id) : typeof id === "string" && /^\d+$/u.test(id) ? id : null,
    login: typeof comment.user?.login === "string" ? comment.user.login : null,
    type: typeof comment.user?.type === "string" ? comment.user.type : null,
  };
}

/** `user.id` equals the adopted actor and `user.type` is Bot. Nothing else about a comment is consulted. */
function authorIsAdoptedActor(comment: Comment, binding: CompanyIdentityBinding | undefined): { pass: true } | { pass: false; reason: string } {
  const adopted = binding?.native_actor_id;
  if (!adopted) return { pass: false, reason: "native-actor-not-adopted" };
  const author = authorOf(comment);
  if (author.id === null) return { pass: false, reason: "author-missing" };
  if (author.id !== adopted) return { pass: false, reason: "author-mismatch" };
  if (author.type !== "Bot") return { pass: false, reason: "author-not-bot" };
  return { pass: true };
}

/** The per-comment verdict: the author check, then what the binding says the employee's attribution is. */
export function authorshipOf(comment: Comment, binding: CompanyIdentityBinding | undefined): AuthorshipVerdict {
  const author = authorOf(comment);
  const check = authorIsAdoptedActor(comment, binding);
  if (!check.pass) return { authorship: "not-native-verified", reason: check.reason, author };
  if (binding?.attribution_mode === "native") return { authorship: "native-verified", author };
  if (binding?.attribution_mode === "shared_bot_attributed") return { authorship: "shared-bot-attributed", author };
  return { authorship: "not-native-verified", reason: "attribution-mode-unset", author };
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

const REQUIRED_ENV = ["GH_TOKEN", "FLUME_EMPLOYEE_SUBJECT", "FLUME_GITHUB_REPOSITORY", "FLUME_GITHUB_APP_ID", "FLUME_GITHUB_INSTALLATION_ID"] as const;

type ProviderCall = { ok: true; data: unknown; status: number; link: string } | { ok: false; status?: number; ambiguous: boolean; message: string; timeout: boolean };
type Requester = (route: string, params: Record<string, unknown>) => Promise<{ data: unknown; status: number; headers: Record<string, string | number | undefined> }>;

function provider(token: string, api: Transport) {
  const request = api.request as unknown as Requester;
  return async (route: string, params: Record<string, unknown>): Promise<ProviderCall> => {
    try {
      const response = await request(route, { headers: { authorization: `token ${token}` }, ...params });
      return { ok: true, data: response.data, status: response.status, link: String(response.headers.link ?? "") };
    } catch (error) {
      const status = statusOf(error);
      // octokit reports a timeout or network error as a 500 without a response: statusOf is then undefined.
      return { ok: false, status, ambiguous: status === undefined || status >= 500, message: firstLine(error), timeout: isTimeout(error) };
    }
  };
}

/** Never let the token reach any output, whatever a provider message or a body said. */
function scrubbed(value: unknown, token: string | undefined): string {
  const text = JSON.stringify(value);
  return token && token.length >= 8 ? text.split(token).join("[redacted]") : text;
}

function finish<T extends CommentResult>(result: T, token?: string): T {
  return JSON.parse(scrubbed(result, token)) as T;
}

function bindingForSubject(subject: string): { binding: CompanyIdentityBinding | undefined; handle: string; person: string | null } | { code: string; detail: string } {
  try {
    const matches = identityCensus().definitions.filter(definition => definition.block?.subject === subject);
    if (matches.length === 0) return { code: "employee-not-found", detail: "no enrolled employee has the granted subject" };
    if (matches.length > 1) return { code: "employee-ambiguous", detail: "more than one definition records the granted subject" };
    const block = matches[0]!.block!;
    return { binding: block.bindings?.github, handle: block.handle, person: matches[0]!.person };
  } catch (error) {
    return { code: "census-unreadable", detail: firstLine(error) };
  }
}

function numberOf(value: unknown, suffix: "issues" | "pulls"): string | undefined {
  const match = typeof value === "string" ? new RegExp(`/${suffix}/(\\d+)$`, "u").exec(value) : null;
  return match?.[1];
}

function locationOf(kind: CommentKind, comment: Comment) {
  return kind === "issue"
    ? { number: numberOf(comment.issue_url, "issues") ?? null }
    : { pull_number: numberOf(comment.pull_request_url, "pulls") ?? null, path: comment.path ?? null, line: comment.line ?? null, side: comment.side ?? null, commit_id: comment.commit_id ?? null };
}

function receiptOf(kind: CommentKind, comment: Comment, httpStatus?: number) {
  const author = authorOf(comment);
  const via = comment.performed_via_github_app?.id;
  return {
    kind, id: String(comment.id), url: typeof comment.html_url === "string" ? comment.html_url : null,
    author,
    ...(via !== undefined && via !== null ? { performed_via_github_app_id: String(via) } : {}),
    location: locationOf(kind, comment),
    ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
  };
}

interface Expected { kind: CommentKind; number: string; review?: { commit: string; path: string; line: number; side: string } }

/** The comment is where we said we put it. Anything else is `location-mismatch`. */
function locationProblem(comment: Comment, want: Expected): string | undefined {
  if (want.kind === "issue") return numberOf(comment.issue_url, "issues") === want.number ? undefined : "the comment is not on the requested issue or pull request";
  const have = locationOf("review", comment);
  if (have.pull_number !== want.number) return "the comment is not on the requested pull request";
  const review = want.review!;
  if (have.path !== review.path) return "the comment is not on the requested path";
  if (have.line !== review.line) return "the comment is not on the requested line";
  if (have.side !== review.side) return "the comment is not on the requested side";
  if (typeof have.commit_id !== "string" || have.commit_id.toLowerCase() !== review.commit.toLowerCase()) return "the comment is not on the requested commit";
  return undefined;
}

const listRoute = (kind: CommentKind) => (kind === "issue" ? "GET /repos/{owner}/{repo}/issues/{number}/comments" : "GET /repos/{owner}/{repo}/pulls/{number}/comments");
const readRoute = (kind: CommentKind) => (kind === "issue" ? "GET /repos/{owner}/{repo}/issues/comments/{comment_id}" : "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}");

// ---------------------------------------------------------------------------
// post
// ---------------------------------------------------------------------------

type Reconciled = { found: Comment[] } | { incomplete: true } | { failure: Extract<ProviderCall, { ok: false }> };

/** List the target's comments (bounded) and keep those that carry the marker AND were written by the adopted actor. */
async function reconcile(call: ReturnType<typeof provider>, kind: CommentKind, owner: string, repo: string, number: string, marker: string, binding: CompanyIdentityBinding): Promise<Reconciled> {
  const found: Comment[] = [];
  const line = markerLine(marker);
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await call(listRoute(kind), { owner, repo, number: Number(number), per_page: PER_PAGE, page });
    if (!response.ok) return { failure: response };
    const items = Array.isArray(response.data) ? (response.data as Comment[]) : [];
    for (const item of items) if (typeof item.body === "string" && item.body.includes(line) && authorIsAdoptedActor(item, binding).pass) found.push(item);
    const more = /rel="next"/u.test(response.link) || (!response.link && items.length >= PER_PAGE);
    if (!more) return { found };
    if (page === MAX_PAGES) return { incomplete: true };
  }
  return { incomplete: true };
}

function readBody(input: PostCommentInput): { body: string } | { detail: string } {
  if ((input.body === undefined) === (input.bodyFile === undefined)) return { detail: "pass exactly one of --body or --body-file" };
  let body = input.body;
  if (input.bodyFile !== undefined) {
    try { body = readFileSync(input.bodyFile, "utf8"); } catch (error) { return { detail: `cannot read --body-file: ${(error as Error).message}` }; }
  }
  body = body!.replace(/\s+$/u, "");
  if (!body) return { detail: "the comment body is empty" };
  if (body.length > MAX_BODY_CHARS) return { detail: `the comment body exceeds ${MAX_BODY_CHARS} characters` };
  return { body };
}

/** Post one marked comment as the launched employee, reading it back from GitHub to decide who wrote it. */
export async function postComment(input: PostCommentInput, env: NodeJS.ProcessEnv = process.env): Promise<CommentResult> {
  const apiBase = githubApiBase(env), evidence = githubEvidence(apiBase), token = env.GH_TOKEN;
  const refuse = (status: CommentResult["status"], code: string, detail: string, extra: Record<string, unknown> = {}): CommentResult =>
    finish({ ok: false, status, code, detail, evidence, ...extra }, token);

  // -- everything below this line up to the first provider call is pure: zero network ---------------------
  if (input.unsupported?.length) return refuse("denied", "unsupported-review-mode", `${input.unsupported.join(", ")} is not supported: only a single-line inline review comment on the PR head is posted (no ranges, diff positions, subject types or review events)`);
  const reviewFlags = [input.commit, input.path, input.line, input.side].some(value => value !== undefined);
  if (reviewFlags && !input.review) return refuse("denied", "invalid-arguments", "--commit, --path, --line and --side need --review");
  if (input.review && (!input.commit || !input.path || !input.line)) return refuse("denied", "unsupported-review-mode", "--review needs all of --commit, --path and --line");
  if (!/^[1-9]\d{0,9}$/u.test(input.number)) return refuse("denied", "invalid-arguments", "the number must be a positive integer");
  const marker = input.marker ?? randomUUID();
  if (!MARKER.test(marker)) return refuse("denied", "invalid-arguments", `--marker must match ${MARKER.source}`);
  const body = readBody(input);
  if ("detail" in body) return refuse("denied", "invalid-arguments", body.detail);
  let review: Expected["review"];
  if (input.review) {
    const line = Number(input.line), side = (input.side ?? "RIGHT").toUpperCase();
    if (!COMMIT.test(input.commit!)) return refuse("denied", "invalid-arguments", "--commit must be the full 40-character head SHA");
    if (!Number.isSafeInteger(line) || line < 1 || String(line) !== input.line) return refuse("denied", "invalid-arguments", "--line must be a positive integer");
    if (side !== "RIGHT" && side !== "LEFT") return refuse("denied", "invalid-arguments", "--side must be RIGHT or LEFT");
    if (!input.path!.trim()) return refuse("denied", "invalid-arguments", "--path must not be empty");
    review = { commit: input.commit!, path: input.path!, line, side };
  }
  const shaped = githubRequestShape(input.repository, []);
  if ("problem" in shaped) return refuse("denied", "invalid-arguments", "the target must be exactly owner/repo");
  const missing = REQUIRED_ENV.filter(name => !env[name]);
  if (missing.length) return refuse("denied", "missing-environment", `not started by \`flume access request --exec\`: missing ${missing.join(", ")}`);
  const { owner, repo } = shaped.shape;
  if (`${owner}/${repo}`.toLowerCase() !== env.FLUME_GITHUB_REPOSITORY!.toLowerCase()) return refuse("denied", "repository-not-granted", "the token was granted for a different repository than the target");
  const employee = bindingForSubject(env.FLUME_EMPLOYEE_SUBJECT!);
  if ("code" in employee) return refuse("denied", employee.code, employee.detail);
  const binding = employee.binding;
  const bound = githubBindingOf(binding);
  if ("code" in bound || !binding) return refuse("denied", "code" in bound ? bound.code : "no-provider-binding", "code" in bound ? bound.detail : "the employee has no github binding");
  if (binding.principal !== env.FLUME_GITHUB_APP_ID) return refuse("denied", "binding-mismatch", "the employee's github binding is for a different App than the one that minted this token");
  if (!binding.native_actor_id) return refuse("denied", "native-actor-not-adopted", "the employee's native actor is not adopted; an operator runs `flume identity adopt-actor`");
  // -- first provider call -------------------------------------------------------------------------------
  const kind: CommentKind = input.review ? "review" : "issue";
  const call = provider(token!, transport(apiBase, githubTimeoutMs(env)));
  const want: Expected = { kind, number: input.number, ...(review ? { review } : {}) };
  const who = { subject: env.FLUME_EMPLOYEE_SUBJECT, handle: employee.handle, marker, repository: `${owner}/${repo}`, number: input.number };

  const providerFailure = (stage: string, failure: Extract<ProviderCall, { ok: false }>): CommentResult => {
    const extra = { ...who, stage, ...(failure.status !== undefined ? { http_status: failure.status } : {}) };
    if (failure.status === 404) return refuse("error", "target-not-found", `${stage}: the repository, issue or pull request was not found or is not visible to this token`, extra);
    if (failure.status === 403 && !/rate limit/iu.test(failure.message)) return refuse("error", "insufficient-permissions", `${stage}: the token's permissions do not allow this`, extra);
    if (failure.ambiguous) return refuse("error", "provider-unavailable", `${stage}: GitHub did not give a definite answer${failure.timeout ? " (timed out)" : ""}`, extra);
    return refuse("error", "provider-refused", `${stage}: ${failure.message}`, extra);
  };

  /** Turn one comment GitHub holds into the final answer: location, then authorship. */
  const settle = (comment: Comment, reconciled: boolean, httpStatus?: number): CommentResult => {
    const verdict = authorshipOf(comment, binding);
    const common = { ...who, reconciled, authorship: verdict.authorship, ...(verdict.reason ? { reason: verdict.reason } : {}), attribution_mode: binding.attribution_mode ?? null, native_actor_id: binding.native_actor_id, app_id: binding.principal, comment: receiptOf(kind, comment, httpStatus) };
    const misplaced = locationProblem(comment, want);
    if (misplaced) return finish({ ok: false, status: "unverified", code: "location-mismatch", detail: misplaced, evidence, ...common }, token);
    if (verdict.authorship === "not-native-verified") return finish({ ok: false, status: "unverified", code: "not-native-verified", detail: `GitHub does not report the adopted actor as the author (${verdict.reason})`, evidence, ...common }, token);
    return finish({ ok: true, status: "verified", evidence, ...common }, token);
  };

  /** A refusal, the one earlier copy, or `undefined` when GitHub holds none. */
  const earlierCopy = (outcome: Reconciled, stage: string): { stop: CommentResult } | { copy?: Comment } => {
    if ("failure" in outcome) return { stop: providerFailure(stage, outcome.failure) };
    if ("incomplete" in outcome) return { stop: refuse("denied", "reconcile-incomplete", `the target has more than ${MAX_PAGES * PER_PAGE} comments; an earlier copy cannot be ruled out, so nothing is posted`, who) };
    if (outcome.found.length > 1) return { stop: refuse("denied", "duplicate-comments", "more than one comment by the adopted actor carries this marker; nothing is posted", { ...who, comment_ids: outcome.found.map(comment => String(comment.id)) }) };
    return { copy: outcome.found[0] };
  };

  // 1. reconcile first: an earlier copy of this exact comment means nothing is posted
  const first = earlierCopy(await reconcile(call, kind, owner, repo, input.number, marker, binding), "reconcile");
  if ("stop" in first) return first.stop;
  if (first.copy) return settle(first.copy, true);

  // 2. review mode: the PR head must still be the commit the caller reviewed
  if (review) {
    const pull = await call("GET /repos/{owner}/{repo}/pulls/{number}", { owner, repo, number: Number(input.number) });
    if (!pull.ok) return providerFailure("pull request preflight", pull);
    const head = (pull.data as { head?: { sha?: unknown } } | null)?.head?.sha;
    if (typeof head !== "string" || head.toLowerCase() !== review.commit.toLowerCase()) return refuse("denied", "stale-commit", "the pull request head is not the commit being reviewed; nothing is posted", { ...who, head_sha: typeof head === "string" ? head : null, commit: review.commit });
  }

  // 3. exactly one POST
  const text = `${body.body}\n\n${markerLine(marker)}`;
  const created = await call(kind === "issue" ? "POST /repos/{owner}/{repo}/issues/{number}/comments" : "POST /repos/{owner}/{repo}/pulls/{number}/comments", {
    owner, repo, number: Number(input.number), body: text,
    ...(review ? { commit_id: review.commit, path: review.path, line: review.line, side: review.side } : {}),
  });
  let createdId: string | undefined;
  if (created.ok) {
    const id = (created.data as Comment | null)?.id;
    if (typeof id === "number" || (typeof id === "string" && /^\d+$/u.test(id))) createdId = String(id);
  } else if (!created.ambiguous) {
    if (created.status === 422 && kind === "review") return refuse("error", "invalid-position", `the line is not part of the diff on this commit: ${created.message}`, { ...who, http_status: 422 });
    return providerFailure("post", created);
  }

  // 3a. a definite 201: read the comment back from GitHub by its ID
  if (createdId !== undefined) {
    const readback = await call(readRoute(kind), { owner, repo, comment_id: Number(createdId) });
    if (readback.ok) return settle(readback.data as Comment, false, readback.status);
    return refuse("error", "readback-failed", `the comment was created (id ${createdId}) but could not be read back; re-run with the same --marker to reconcile`, { ...who, comment_id: createdId, ...(readback.status !== undefined ? { http_status: readback.status } : {}) });
  }

  // 3b. ambiguous: reconcile once more; never a second POST
  const again = await reconcile(call, kind, owner, repo, input.number, marker, binding);
  if ("found" in again && again.found.length === 1) return settle(again.found[0]!, true);
  if ("found" in again && again.found.length > 1) return refuse("denied", "duplicate-comments", "more than one comment by the adopted actor carries this marker", { ...who, comment_ids: again.found.map(comment => String(comment.id)) });
  return refuse("unverified", "comment-ambiguous", "GitHub did not give a definite answer to the POST and no marked comment is visible yet; re-run with the same --marker to reconcile", { ...who, ...(created.ok ? {} : { reason: created.timeout ? "timeout" : created.status === undefined ? "network" : "http-5xx", ...(created.status !== undefined ? { http_status: created.status } : {}) }) });
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export interface VerifyCommentsInput { repository: string; comments: string[] }

/** `<employee>:<issue|review>:<id>`; every other evidence kind (commit, email, ...) is not API authorship. */
function parseEvidence(spec: string): { employee: string; kind: CommentKind; id: string } | { code: string; detail: string } {
  const parts = spec.split(":");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return { code: "invalid-arguments", detail: `--comment must be <employee>:<issue|review>:<id>, not "${spec.slice(0, 80)}"` };
  const [employee, kind, id] = parts as [string, string, string];
  if (kind !== "issue" && kind !== "review") return { code: "unsupported-evidence", detail: `"${kind}" is not API authorship evidence: only issue and review comments GitHub reports an author for count (commit author, committer, signature and email are mutable metadata)` };
  if (!/^[1-9]\d{0,17}$/u.test(id)) return { code: "invalid-arguments", detail: `the comment id "${id.slice(0, 40)}" must be a positive integer` };
  return { employee, kind, id };
}

/** Read each named comment from GitHub and decide, per employee, whether GitHub says that employee's bot wrote it. */
export async function verifyComments(input: VerifyCommentsInput, env: NodeJS.ProcessEnv = process.env): Promise<CommentResult> {
  const apiBase = githubApiBase(env), evidence = githubEvidence(apiBase), token = env.GH_TOKEN;
  const refuse = (code: string, detail: string, extra: Record<string, unknown> = {}): CommentResult => finish({ ok: false, status: "denied", code, detail, evidence, ...extra }, token);

  if (!input.comments.length) return refuse("invalid-arguments", "pass at least one --comment <employee>:<issue|review>:<id>");
  if (input.comments.length > MAX_VERIFY_COMMENTS) return refuse("invalid-arguments", `at most ${MAX_VERIFY_COMMENTS} comments are verified at once`);
  const parsed = [];
  for (const spec of input.comments) {
    const entry = parseEvidence(spec);
    if ("code" in entry) return refuse(entry.code, entry.detail);
    parsed.push(entry);
  }
  const shaped = githubRequestShape(input.repository, []);
  if ("problem" in shaped) return refuse("invalid-arguments", "the target must be exactly owner/repo");
  const missing = ["GH_TOKEN", "FLUME_GITHUB_REPOSITORY"].filter(name => !env[name]);
  if (missing.length) return refuse("missing-environment", `not started by \`flume access request --exec\`: missing ${missing.join(", ")}`);
  const { owner, repo } = shaped.shape;
  if (`${owner}/${repo}`.toLowerCase() !== env.FLUME_GITHUB_REPOSITORY!.toLowerCase()) return refuse("repository-not-granted", "the token was granted for a different repository than the target");

  // Resolve every named employee BEFORE any network call.
  let census: ReturnType<typeof identityCensus>;
  try { census = identityCensus(); } catch (error) { return refuse("census-unreadable", firstLine(error)); }
  const employees = new Map<string, { subject: string; handle: string; binding: CompanyIdentityBinding | undefined }>();
  for (const name of new Set(parsed.map(entry => entry.employee))) {
    try {
      const definition = resolveEmployee(census, name);
      if (!definition.block) return refuse("employee-not-enrolled", `${name} has no company identity`);
      employees.set(name, { subject: definition.block.subject, handle: definition.block.handle, binding: definition.block.bindings?.github });
    } catch (error) {
      return refuse("employee-not-found", firstLine(error));
    }
  }

  const call = provider(token!, transport(apiBase, githubTimeoutMs(env)));
  const comments: Array<Record<string, unknown>> = [];
  const verdicts: Array<{ employee: string; subject: string; kind: CommentKind; id: string; authorship: Authorship; authorId: string | null }> = [];
  for (const entry of parsed) {
    const who = employees.get(entry.employee)!;
    const base = { employee: entry.employee, subject: who.subject, handle: who.handle, kind: entry.kind, id: entry.id };
    const note = (authorship: Authorship, reason: string | undefined, extra: Record<string, unknown> = {}, authorId: string | null = null) => {
      verdicts.push({ employee: entry.employee, subject: who.subject, kind: entry.kind, id: entry.id, authorship, authorId });
      comments.push({ ...base, authorship, ...(reason ? { reason } : {}), ...extra });
    };
    const bound = githubBindingOf(who.binding);
    if ("code" in bound || !who.binding) { note("not-native-verified", "code" in bound ? bound.code : "no-provider-binding"); continue; }
    if (!who.binding.native_actor_id) { note("not-native-verified", "native-actor-not-adopted"); continue; }
    const response = await call(readRoute(entry.kind), { owner, repo, comment_id: Number(entry.id) });
    if (!response.ok) { note("not-native-verified", "comment-unreadable", { http_status: response.status ?? null }); continue; }
    const comment = response.data as Comment;
    if (String(comment.id) !== entry.id) { note("not-native-verified", "comment-id-mismatch"); continue; }
    const verdict = authorshipOf(comment, who.binding);
    note(verdict.authorship, verdict.reason, { attribution_mode: who.binding.attribution_mode ?? null, native_actor_id: who.binding.native_actor_id, app_id: who.binding.principal, comment: receiptOf(entry.kind, comment, response.status) }, verdict.author.id);
  }

  // -- per employee ---------------------------------------------------------------------------------
  const bySubject = new Map<string, Record<string, any>>();
  for (const [name, who] of employees) {
    const mine = verdicts.filter(verdict => verdict.employee === name);
    const row = bySubject.get(who.subject) ?? { subject: who.subject, handle: who.handle, employee: name, app_id: who.binding?.principal ?? null, native_actor_id: who.binding?.native_actor_id ?? null, attribution_mode: who.binding?.attribution_mode ?? null, classes: [] as string[], comment_ids: [] as string[] };
    row.classes = [...new Set([...row.classes, ...mine.map(verdict => verdict.kind)])].sort();
    row.comment_ids = [...row.comment_ids, ...mine.map(verdict => `${verdict.kind}:${verdict.id}`)];
    bySubject.set(who.subject, row);
  }
  const rows = [...bySubject.values()];

  // -- verdict: only distinct native Apps, each comment written by its own adopted bot ---------------------
  const reasons: string[] = [];
  if (rows.length < 2) reasons.push("fewer-than-two-employees");
  for (const verdict of verdicts) {
    if (verdict.authorship !== "native-verified") reasons.push(`not-native-verified:${verdict.employee}:${verdict.kind}:${verdict.id}${verdict.authorship === "shared-bot-attributed" ? ":shared-bot-attributed" : ""}`);
  }
  const group = (pick: (row: Record<string, any>) => string | null) => {
    const seen = new Map<string, Set<string>>();
    for (const row of rows) { const key = pick(row); if (key) seen.set(key, (seen.get(key) ?? new Set()).add(row.subject)); }
    return [...seen.values()].some(subjects => subjects.size > 1);
  };
  if (group(row => row.native_actor_id)) reasons.push("shared-actor");
  else {
    // Two employees whose comments GitHub says one account wrote are one actor, whatever the bindings claim.
    const authors = new Map<string, Set<string>>();
    for (const verdict of verdicts) if (verdict.authorId) authors.set(verdict.authorId, (authors.get(verdict.authorId) ?? new Set()).add(verdict.subject));
    if ([...authors.values()].some(subjects => subjects.size > 1)) reasons.push("shared-actor");
  }
  if (group(row => row.app_id)) reasons.push("shared-app");
  if (rows.some(row => row.attribution_mode === "shared_bot_attributed")) reasons.push("shared-bot-attributed");
  const unique = [...new Set(reasons)];
  const distinct = unique.length === 0;
  return finish({
    ok: distinct, status: distinct ? "verified" : "unverified",
    verdict: distinct ? "native-distinct-verified" : "not-native-distinct",
    ...(distinct ? {} : { reasons: unique }),
    evidence, repository: `${owner}/${repo}`, employees: rows, comments,
  }, token);
}

/** One screenful for a person; `--json` is the full record. */
export function formatCommentResult(result: CommentResult): string {
  if (result.verdict) {
    const lines = [`${result.verdict}${Array.isArray(result.reasons) ? ` (${(result.reasons as string[]).join(", ")})` : ""}`];
    for (const row of (result.employees as Array<Record<string, any>> | undefined) ?? []) lines.push(`  ${row.handle}: actor ${row.native_actor_id ?? "-"} app ${row.app_id ?? "-"} classes ${row.classes.join(",") || "-"}`);
    lines.push(`evidence ${result.evidence}`);
    return lines.join("\n");
  }
  if (!result.ok) return `${result.status}${result.code ? ` ${result.code}` : ""}: ${String(result.detail ?? "")}${result.marker ? ` (marker ${String(result.marker)})` : ""}`;
  const comment = result.comment as { kind: string; id: string; url: string | null; author: { id: string; login: string } };
  return `${result.authorship}${result.reconciled ? " (reconciled)" : ""}: ${comment.kind} comment ${comment.id} by ${comment.author.login} (${comment.author.id})${comment.url ? ` ${comment.url}` : ""} marker ${String(result.marker)} evidence ${result.evidence}`;
}
