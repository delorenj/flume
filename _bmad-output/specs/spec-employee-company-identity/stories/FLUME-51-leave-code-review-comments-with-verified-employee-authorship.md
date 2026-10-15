---
title: 'FLUME-51 — Leave code-review comments with verified employee authorship'
type: 'feature'
created: '2026-10-14'
status: 'done'
baseline_revision: 'feee85c5050a4fcc48f1af75b33accd789c09914'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/architecture.md'
  - '{project-root}/_bmad-output/specs/spec-employee-company-identity/stories/FLUME-50-obtain-a-github-credential-for-only-the-approved-repository.md'
  - '{project-root}/_bmad-output/implementation-artifacts/FLUME-50/live-proof-2026-10-14.md'
  - '{project-root}/docs/employee-access.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** FLUME-50 lets an employee get a one-repository installation token for its own GitHub App. Nothing yet posts a comment with that token, checks GitHub's record of who wrote it, or tells "two employees" apart from "one shared bot". So nobody can prove which employee left a piece of review feedback.

**Approach:** Use the token through three steps.
1. **Adopt the actor.** An operator command records each employee's native bot user ID on their `github` binding.
2. **Post.** An `--exec` consumer command posts a marked PR/issue conversation comment or a single-line inline review comment. It finds an earlier copy before any retry, and reads the comment back from GitHub.
3. **Verify.** A read-only consumer command compares GitHub's comment authors with the employees' adopted actors. It reports `native-distinct-verified` only for distinct native Apps, and never accepts body text, email or git metadata as proof.

## Boundaries & Constraints

**Always:**
- Authorship is decided only by GitHub's readback of the comment: `user.id` (as a string) must equal the binding's adopted `native_actor_id`, and `user.type` must be `Bot`. Body text, the marker, display names, logins, email and git commit author/committer/signature are never authorship evidence. The marker is used only to find an earlier copy, and that copy must also pass the `user.id` check.
- The binding contract gains an optional `native_actor_id` (`^\d+$`) in `contracts/company-identity.schema.json` `$defs.binding` and in `CompanyIdentityBinding`. This is an additive optional field, the block stays `version: 1`, and existing definitions stay valid. Only `flume identity adopt-actor` writes it.
- `flume identity adopt-actor <employee> github [--apply]` is a preview unless `--apply`. It requires a valid github binding (`githubBindingOf`). Then:
  - It reads `GET /app` with the App's JWT to get the slug, then `GET /users/<slug>[bot]` with no auth. The user must be `type: Bot` with exactly that login.
  - With `--apply`, under `withRegistryLock`, it writes `native_actor_id` to only that binding. Re-adopting the same ID is a no-op (`changed: false`). A different stored ID is blocked as `native-actor-conflict`.
  - The same ID on another employee's github binding is blocked as `native-actor-duplicate`, unless both bindings are `shared_bot_attributed`.
  - It is refused for an unenrolled, retired or unbound employee.
  - It never mints a token and never writes anywhere else.
- `execWithGithubToken` also exports `FLUME_EMPLOYEE_SUBJECT`, `FLUME_GITHUB_REPOSITORY`, `FLUME_GITHUB_APP_ID` and `FLUME_GITHUB_INSTALLATION_ID`, taken from the granted body. Nothing else about the FLUME-50 exec contract changes.
- `flume comment post <owner/repo> <number> (--body <text> | --body-file <path>) [--marker <key>] [--review --commit <sha> --path <file> --line <n> [--side RIGHT|LEFT]] [--json]` is an `--exec` consumer.
  - **Required env:** it needs `GH_TOKEN` and the four variables above. The target repository must equal `FLUME_GITHUB_REPOSITORY` (case-insensitive), or it fails `repository-not-granted`. The subject's binding is resolved from the census: its `principal` must equal `FLUME_GITHUB_APP_ID`, or it fails `binding-mismatch`, and `native_actor_id` must be adopted, or it fails `native-actor-not-adopted`. All of these checks run before any network call.
  - **Marker:** the marker matches `^[A-Za-z0-9._-]{8,128}$` and defaults to a fresh UUID. It is appended as `\n\n<!-- flume-comment:<marker> -->`.
  - **Reconcile first:** every invocation lists the target's comments (issue comments or PR review comments, `per_page=100`, at most 10 pages) and keeps only those that carry the marker and pass the `user.id` check.
    - One match: it is returned with `reconciled: true` and nothing is posted.
    - More than one: `duplicate-comments`, listing their IDs, and nothing is posted.
    - More than 10 pages: `reconcile-incomplete`, and nothing is posted.
    - None: exactly one POST.
  - **POST outcomes:**
    - A 201 is followed by a `GET` of the comment by its ID.
    - 403 is `insufficient-permissions`. 404 is `target-not-found`.
    - A 422 on a review comment is `invalid-position`. Any other 4xx is `provider-refused`, with the first line of the message.
    - A timeout, network error or 5xx triggers one more reconcile. If it finds the comment, the result is `reconciled: true`. If not, the result is `unverified` with code `comment-ambiguous` and the marker, so the caller can re-run with the same `--marker`. There is never a second POST in the same invocation.
  - **Review mode:**
    - Before posting, it `GET`s the PR. A head SHA other than `--commit` is `stale-commit`, with no POST.
    - `--start-line`, `--position`, `--subject-type` and review events (`--event`) are accepted only so they can be refused as `unsupported-review-mode` before any call. `--review` without all of `--commit`/`--path`/`--line` is also refused this way.
    - The readback must match the PR number, path, line, side and `commit_id`, or the result is `unverified` `location-mismatch`.
  - **Authorship result:**
    - `native-verified`: the `user.id` check passes and the binding is `attribution_mode: native`.
    - `shared-bot-attributed`: the check passes and the binding is `shared_bot_attributed`.
    - Anything else is `not-native-verified` with a reason, such as `author-mismatch` or `attribution-mode-unset`.
- `flume comment verify <owner/repo> --comment <employee>:<issue|review>:<id> ... [--json]` is a read-only `--exec` consumer. It `GET`s each comment by ID with `GH_TOKEN` and applies the per-comment authorship rule above to the named employee's binding.
  - A `commit` kind, or any other kind, is refused as `unsupported-evidence`, because commit metadata is not API authorship.
  - The verdict is `native-distinct-verified` only when all of the following hold. Otherwise it is `not-native-distinct`, with reasons that include `shared-actor` whenever two employees resolve to one `user.id`. A shared bot is never reported as two native actors.
    - There are at least two distinct subjects.
    - Every comment is `native-verified`.
    - The subjects' `native_actor_id`s are pairwise distinct.
    - Their App `principal`s are pairwise distinct.
  - The report lists the comment classes covered for each employee.
- Every `post`/`verify` result has an `evidence` field. It is `provider` only for `https://api.github.com` (`githubEvidence()`), and `fixture` otherwise.
- Network rules for every call: no redirects (`redirect: "error"`), and each call is aborted after `FLUME_GITHUB_TIMEOUT_MS`.
- The token never appears in stdout, stderr, files or receipts. A receipt carries only IDs, the marker, the URL, the author ID, login and type, `performed_via_github_app.id` when GitHub returns it, the location, and HTTP status codes.
- Readiness gains `github_native_authorship` (always `unproven`).

**Never:**
- Post to any repository other than the operator-designated sandbox `delorenj/flume-identity-sandbox`. Never post production smoke comments. Never request or use merge, push, approve or admin permissions.
- Infer native authorship from text, marker, login, email or commit metadata. Never claim a shared bot, or two bindings that resolve to one actor, as two native actors.
- Use a PAT, the operator's `gh`, or another employee's token for posting or verifying. Never register or install Apps. Never edit vault items. Never touch Cloudflare, Plane, mail or `templates/hermes-agent`.
- Hand-roll JWT signing or the GitHub token protocol.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|---|---|---|---|
| Adopt | A bound, fake `/app` slug + `/users/<slug>[bot]` Bot | preview shows id; `--apply` writes `native_actor_id`; again → `changed: false` | not Bot / login mismatch / dup native / conflict → blocker, nothing written |
| Two natives | A, B adopted, distinct Apps; each posts conversation comment | both `native-verified`; `verify` → `native-distinct-verified`, two distinct `user.id` | — |
| Spoof | a User-type comment with A's marker and "grolf" text; email/commit given as evidence | reconcile ignores it; `verify` → `author-mismatch`; `commit` → `unsupported-evidence` | no POST skipped because of it |
| Inline review | PR head = `--commit`, line in diff | readback matches author, PR, path, line, commit | — |
| Review failures | stale head; line outside diff (422); token lacks `pull_requests:write` (403); `--start-line`/`--position`/`--event` | `stale-commit` / `invalid-position` / `insufficient-permissions` / `unsupported-review-mode` | 0 POSTs for stale and unsupported |
| Timeout created | POST hangs after the fake stores it | reconcile finds it → `reconciled: true` | exactly 1 POST |
| Timeout lost | POST 500, nothing stored | `unverified` `comment-ambiguous`; re-run same marker → reconcile 0 → 1 POST | never 2 POSTs per invocation |
| Duplicates | two marked comments by A pre-seeded | `duplicate-comments` with both ids | 0 POSTs |
| Shared bot | C `shared_bot_attributed`; C and D hand-bound to one actor id | C post → `shared-bot-attributed`; `verify` C+D → `not-native-distinct`, `shared-actor` | — |
| Not adopted / wrong repo / app mismatch | — | `native-actor-not-adopted` / `repository-not-granted` / `binding-mismatch` | 0 network calls |

</intent-contract>

## Code Map

- `packages/flume-hr/src/workforce/github.ts` — reuse `githubApiBase` :33, `githubTimeoutMs` :37, `githubEvidence` :42 and `githubBindingOf` :93. Export `transport` :112 (it sends `redirect: "error"`, sets a timeout and records `x-github-request-id`), `statusOf` :127, `requestIdOf` :128, `firstLine` :133 and `isTimeout` :135 for the comment adapter. `inspectGithubApp` :270 shows the app-JWT `GET /app` and the slug that gives `bot_login` (:292).
- `packages/flume-hr/src/workforce/access.ts:402-413` `execWithGithubToken` — the child env is built at :407. The granted body (:268) already carries `subject`, `repository`, `app_id` and `installation_id`.
- `packages/flume-hr/src/workforce/company.ts` — `bindEmployeeProvider` (:323-354) is the pattern to follow: lock, census, blockers, `writeDefinition`, preview/apply. Also reuse `resolveEmployee` :133, `identityCensus` :106 and `bindProvider` :363.
- `packages/flume-hr/src/workforce/types.ts:43-48` `CompanyIdentityBinding`, and `contracts/company-identity.schema.json:26-35` `$defs.binding` (closed) — add `native_actor_id` to both.
- `packages/flume-hr/src/workforce/readiness.ts:18-25` `UNPROVEN`. Its key list is asserted at `tests/company-identity-regressions.mjs:474`.
- `packages/flume-hr/src/index.ts` — `identity bind` at :283-296 is the pattern for `adopt-actor`. The `access` group is at :343 and `github-inspect` at :412-429. Use the `guardBrokenPipe`/`writeStdout`/`exitAfterFlush` pattern and the `identityResult` helper.
- `tests/employee-access-github-regressions.mjs` — copy these from it: the fake GitHub (:58-185, which mints and verifies RS256 JWTs per App and records calls), the fake edge (:187), fake `op` and fixture homes (:221-327), `startFacade` (:331), `flumeRequest` (:369) and the consumer pattern (:235-240).
- `scripts/run-tests.mjs` — add the new suite to the `SUITES` list (about line 80).
- `docs/employee-access.md` — extend the "GitHub credentials (FLUME-50)" section (:69) and the "Live deployment" section (:255).
- Live read-only facts, observed 2026-10-14:
  - Grolf: App 5296475, installation 170872985. The bot is `gr0lfbot[bot]`, user ID 341820121. Its sandbox grant is `issues:write`, `pull_requests:write`, `contents:read`. The binding is on `33GOD/agents/hermes/pm/role.yaml`, in the parent repo.
  - Rererere: App 5296560. The bot is `colrerererebot[bot]`, ID 341824055. It had `installations: []` at 23:50:37Z, so its install is still waiting on the operator's passkey.
  - Sandbox `delorenj/flume-identity-sandbox`: private. PR #1 "Identity proof: inline review target" is open, head `8dfa472c6906d295fbf1b11e81217029ab1c51d8`, and adds `proof.txt` lines 1-3 on the RIGHT side. It has 0 comments.

## Tasks & Acceptance

**Execution:**
- `contracts/company-identity.schema.json`, `packages/flume-hr/src/workforce/types.ts` -- add the optional `native_actor_id` -- adopted actor on the binding.
- `packages/flume-hr/src/workforce/github.ts` -- export the transport and error helpers, and add `resolveGithubBotActor` (slug from `GET /app`, then `GET /users/<slug>[bot]`) -- one transport.
- `packages/flume-hr/src/workforce/company.ts` -- `adoptNativeActor` with the blockers from Always -- explicit adoption.
- `packages/flume-hr/src/workforce/comment.ts` (new) -- the marker, reconcile, post, readback, review preflight, the authorship rule and `verifyAuthorship` -- the comment adapter.
- `packages/flume-hr/src/workforce/access.ts` -- the four extra exec env vars.
- `packages/flume-hr/src/workforce/readiness.ts`, `workforce/index.ts` -- add `github_native_authorship` and the exports.
- `packages/flume-hr/src/index.ts` -- `identity adopt-actor`, and `comment post|verify` with the refused review-mode flags -- the public surface.
- `tests/employee-access-github-comments-regressions.mjs` (new), `scripts/run-tests.mjs`, `tests/company-identity-regressions.mjs:474` -- a built-CLI suite with fake edge, fake GitHub and fake `op`, extended with the comment endpoints from the matrix. It covers every matrix row, call counts and a secret scan of every output and state file, and is registered in `SUITES`.
- `docs/employee-access.md`, `AGENTS.md`, `README.md`, `CLAUDE.md` -- the adopt/post/verify flow, the authorship rule, the reconcile semantics, and the live-proof procedure and gate.
- `_bmad-output/implementation-artifacts/FLUME-51/live-proof-YYYY-MM-DD.md`, named for the run's date -- gated live proof, run only after the fixture suite passes. It must contain no secrets.
  1. Grolf: `adopt-actor --apply`. Then, through `flume access run grolf -- flume access request --service github --resource delorenj/flume-identity-sandbox --permission issues:write --permission pull_requests:write --exec -- flume comment post …`, post one PR #1 conversation comment and one inline comment on `proof.txt` line 2 at the head SHA.
  2. Rererere: run the same steps only once `github-inspect` shows its sandbox installation. That is followed by an operator bind, a grant and adoption.
  3. Run `verify` over all the comment IDs. Request the same granted permission strings (`issues:write`, `pull_requests:write`): the policy matches permissions as exact strings, so `*:read` is `approval_required` unless the operator grants it.
  4. Commit the `role.yaml`/`agent.yaml` changes in their owning repos.

**Acceptance Criteria:**
- Given two adopted employees with distinct Apps, when each posts through `flume access run … --exec -- flume comment post` and `flume comment verify` reads back both, then the result is `native-distinct-verified` with two distinct `user.id`s that equal their bindings. Changing body text, login display or email cannot change the verdict.
- Given an inline review comment on the PR head, when it is read back, then author, PR, path, line and commit all match. Insufficient permissions, a stale head, a position outside the diff and unsupported modes each fail with their explicit code.
- Given a timed-out POST, when the command reconciles, then it returns the existing marked comment or reports `comment-ambiguous`/`duplicate-comments`, and the fake records at most one POST per invocation.
- Given a shared-bot binding, or two bindings with one actor ID, or commit metadata offered as evidence, when native-distinct proof is requested, then it is not native-verified, and `shared-bot-attributed` appears only for an explicitly configured binding.
- Given Rererere has no sandbox installation when the story completes, when the Auto Run Result is written, then live AC1 is reported as blocked by the exact gate:
  - the operator passkey install of App 5296560 on the sandbox;
  - `identity bind rererere github … --apply`;
  - a sandbox grant for subject `1dca27f5-06e8-47a3-86c9-49bc3ed5331c`;
  - `adopt-actor`.

  Any Grolf-only live readbacks are recorded as partial evidence.

## Spec Change Log

## Review Triage Log

### 2026-10-14 — Review pass
- verdicts: 50 findings — high 0, medium 2, low 32, false 15, maybe-false 1
- findings:
  - `[false]` `[reject]` Blind: AC1 (two employees `native-distinct-verified`) is unproven live — AC5 requires exactly this outcome to be reported as blocked by the named gate, and the receipt and Auto Run Result do so.
  - `[low]` `[patch]` Blind: the deploy-order hazard (an old facade reads an adopted definition as invalid, `unknown-client`) is documented only in the receipt — added a "Deploy first" paragraph to the adopt section of `docs/employee-access.md`.
  - `[low]` `[reject]` Blind: a post read back with the wrong author cannot be safely re-run (reconcile ignores it, so the re-run posts again) — reachable only with a token that `--exec` did not deliver for that binding; the fix adds new branches.
  - `[low]` `[reject]` Blind: reconcile ignores the body, so reusing a marker with new text returns the old comment — the spec defines the marker as the idempotency key ("One match: returned, nothing posted"); changing it edits the spec.
  - `[low]` `[reject]` Blind: `comment` trusts `GH_TOKEN`/`FLUME_*` from the env, so "never from the caller" holds only under `--exec` — the readback author check still refuses a mismatched token; binding the env to the grant needs new signed surface.
  - `[low]` `[reject]` Blind: `FLUME_GITHUB_INSTALLATION_ID` is required but never compared to `binding.instance` — the facade mints from the binding's own instance, so under `--exec` they cannot differ; the fix adds a guard.
  - `[low]` `[reject]` Blind: `verify` needs a write grant — the spec mandates exact-string grants and says to request the granted write strings; changing that edits the spec/policy.
  - `[low]` `[reject]` Blind: `adopt-actor --apply` holds the registry lock across vault and network I/O — bounded by `FLUME_GITHUB_TIMEOUT_MS`, a rare operator action; restructuring the lock is more than a direct correction.
  - `[low]` `[reject]` Blind: the unauthenticated `/users/<bot>` lookup can be rate-limited and is reported as generic `provider-unavailable` — fail-closed with GitHub's HTTP status in the detail; rare operator action.
  - `[low]` `[reject]` Blind: test gaps (pagination, `census-unreadable`, `employee-ambiguous`, `readback-failed`, `--side LEFT`) — pagination claim is false (the fake sends `Link: rel="next"` and the suite asserts `page=2`); the rest are fail-closed branches, adding cases is beyond a direct correction.
  - `[false]` `[reject]` Blind: `shared-app` uses the binding principal, not `performed_via_github_app.id` — the spec defines distinctness on the binding principals, and a shared author is independently caught by the readback `user.id` `shared-actor` check.
  - `[low]` `[reject]` Blind: `--body-file` has no stdin form, trims trailing whitespace, caps at 60,000 chars — feature requests, not defects in specified behavior.
  - `[low]` `[reject]` Blind: plain output omits `comment_ids`/`head_sha`/`http_status`; success branch throws on null login — the throw is false (author object always exists; a null login prints `null`); `--json` carries every field and the plain gaps are rare-path only.
  - `[false]` `[reject]` Blind: the receipt commits machine-specific IDs and `op://` refs — receipts exist to record IDs; the secret scan holds and `op://` references are the sanctioned form.
  - `[medium]` `[patch]` Edge: re-running an identical `identity bind` after `adopt-actor` fails `binding-conflict` (grouped with the verification-gap finding) — `bindEmployeeProvider` now compares the stored binding without `native_actor_id`; tests added for the identical rebind (`changed: false`, ID kept) and a different principal (`binding-conflict`).
  - `[low]` `[reject]` Edge: a suspended/retired employee can still post — the facade refuses non-active employees (`access.ts:302`), so only a residual ≤1h token could; the fix adds a guard.
  - `[low]` `[reject]` Edge: `FLUME_GITHUB_INSTALLATION_ID` never compared to the binding instance — same as the Blind finding above.
  - `[false]` `[reject]` Edge: missing grant fields export the literal `undefined` — the granted github body always carries `subject`, `repository`, `app_id`, `installation_id` (`access.ts:269`).
  - `[low]` `[reject]` Edge: targets over 1000 comments always hit `reconcile-incomplete` — the spec mandates `per_page=100`, at most 10 pages, then `reconcile-incomplete`; changing it edits the spec.
  - `[low]` `[reject]` Edge: two concurrent same-marker invocations can both POST — needs cross-process locking; out of everyday use for one-shot agent runs.
  - `[low]` `[reject]` Edge: a re-run with a different body returns the earlier comment — same as the Blind marker-reuse finding.
  - `[low]` `[reject]` Edge: an outdated review comment (line null after the head moved) reconciles to `location-mismatch` — fail-closed and only on a re-run after the PR moved; the fix adds original-line branches.
  - `[false]` `[reject]` Edge: a 200 readback with a null body throws — GitHub never answers a comment GET 200 with null; not shown reachable.
  - `[low]` `[reject]` Edge: the post readback does not check the returned id equals the created id — the readback is a GET by that id; a mismatch is not a realistic outcome and the fix adds a guard.
  - `[false]` `[reject]` Edge: ids above 2^53 lose precision — GitHub comment ids are ~10^10; unreachable.
  - `[low]` `[reject]` Edge: a multibyte body under 60,000 chars can exceed GitHub's byte limit — fails closed as `provider-refused` with GitHub's message.
  - `[low]` `[reject]` Edge: a body that embeds another marker line can be reconciled for that marker — only if our own bot posted it; self-inflicted and rare; fix adds a guard.
  - `[maybe-false]` `[reject]` Edge: an unexpected throw prints a stack trace instead of JSON — no reachable throw path was shown (provider calls are wrapped, census errors are caught); if true it would be low; settle by fault-injecting the transport constructor.
  - `[false]` `[reject]` Edge: `verify` counts a retired employee's comments — historical authorship by that bot is still true; status does not change who wrote a comment.
  - `[low]` `[reject]` Edge: a retired holder's `native_actor_id` blocks re-adoption of that actor forever — actor uniqueness across employees is the intended invariant; reuse is a deliberate manual act.
  - `[low]` `[reject]` Edge: `^\d+$` admits leading zeros — the spec fixes the pattern, and only `adopt-actor` writes the value from GitHub's integer.
  - `[low]` `[reject]` Edge: a 201 without a numeric id falls into `comment-ambiguous` without a reason — unrealistic, and the follow-up reconcile still finds the comment.
  - `[low]` `[reject]` Edge: subject/repo/App facts come from a caller-settable env — same as the Blind env-trust finding.
  - `[medium]` `[patch]` Verification gap: no test re-binds an adopted binding, so the `binding-conflict` regression shipped — grouped with the Edge bind finding; same fix and tests.
  - `[low]` `[reject]` Verification gap: `adopt-actor` failure codes (`credential-unavailable`, `app-mismatch`, `app-slug-missing`, `actor-id-missing`, `provider-unavailable`) are untested — fail-closed branches; adding cases is beyond a direct correction.
  - `[low]` `[reject]` Verification gap: `post`/`verify` do not check employee status — same as the Edge retired-poster finding.
  - `[low]` `[reject]` Verification gap: installation id never compared — same as the Blind finding.
  - `[low]` `[reject]` Verification gap: `employee-ambiguous` and `census-unreadable` untested — fail-closed branches.
  - `[false]` `[reject]` Intent: the two-employee claim is proven only against the fake — AC5 expects live AC1 to be reported blocked; Grolf-only readbacks are recorded as partial evidence.
  - `[false]` `[reject]` Intent: failure modes run only against the fake — the matrix defines them as fake states; live failure injection would need production-like faults the spec forbids.
  - `[low]` `[reject]` Intent: `--exec`-only use is not enforced in code — same as the Blind env-trust finding.
  - `[low]` `[patch]` Intent: the "additive" field broke the deployed facade live — grouped with the Blind deploy-order finding; same doc fix.
  - `[false]` `[reject]` Intent: the shared-bot row's "hand-bound" state is reached via an adopt override — the suite also hand-binds two native bindings to one actor (ada/fay) and asserts `shared-actor`; every matrix expectation is asserted.
  - `[low]` `[reject]` Intent: a rate-limit 403 is `provider-refused`, not `insufficient-permissions` — the deviation gives a more accurate code; the only non-regressive fix edits the spec.
  - `[false]` `[reject]` Intent: the diff adds codes the intent does not name — additive, fail-closed codes; no harm.
  - `[false]` `[reject]` Intent: `verify` checks only `GH_TOKEN` and the repository — the intent does not ask more; employees are named explicitly and resolved from the census.
  - `[low]` `[reject]` Intent: re-adopting the same id returns before the duplicate scan — a pre-existing hand-bound duplicate would already be caught by `verify` (`shared-actor`).
  - `[false]` `[reject]` Intent: `CLAUDE.md` not updated; `verifyAuthorship` named `verifyComments` — `CLAUDE.md` symlinks to the updated `AGENTS.md`; the name is cosmetic.
  - `[false]` `[reject]` Intent: no sandbox pin in code — the Never clause constrains the run; the sole sandbox grant enforces it, and only the sandbox was posted to.
  - `[false]` `[reject]` Intent: the facade mints a token before a not-adopted refusal — "0 network calls" applies to `flume comment`; the suite asserts zero token-authenticated calls.

## Design Notes

Why the native actor is stored. An installation token cannot read `GET /app`. PR review comments do not reliably carry `performed_via_github_app`. So the only stable, provider-issued author identity is the bot's user ID, which is adopted once by an operator who holds the App key, matching the architecture's `native_actor_id`. A login is mutable, so it is recorded but never compared.

Why each invocation POSTs at most once. GitHub comment creation has no idempotency key, so the marker and `user.id` stand in for one. A timed-out POST that GitHub committed but has not yet listed would duplicate if it were retried in the same process. The tool reports `comment-ambiguous` instead, and the caller's re-run reconciles first.

## Verification

**Commands:**
- `git diff --check` -- expected: no output.
- `node scripts/run-tests.mjs employee-access-github-comments` -- expected: typecheck+build ok, suite PASS.
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access identity-provision specialist-hire` -- expected: all PASS.

## Auto Run Result

Status: implemented; verification passed; live AC1 blocked on Rererere (the exact gate below); live AC2 and Grolf-only readbacks done.

What changed:
- `native_actor_id` (`^\d+$`, optional) on the binding schema and type; block stays `version: 1`.
- `flume identity adopt-actor <employee> github [--apply]` (`adoptNativeActor`, `resolveGithubBotActor`).
- `execWithGithubToken` also exports `FLUME_EMPLOYEE_SUBJECT`, `FLUME_GITHUB_REPOSITORY`, `FLUME_GITHUB_APP_ID`, `FLUME_GITHUB_INSTALLATION_ID`.
- `packages/flume-hr/src/workforce/comment.ts`: `flume comment post|verify`, the one authorship rule, reconcile-before-POST.
- Readiness `github_native_authorship` (unproven); `github.ts` exports `transport`, `statusOf`, `requestIdOf`, `firstLine`, `isTimeout`.
- `tests/employee-access-github-comments-regressions.mjs` (15 groups), registered in `SUITES`; `docs/employee-access.md`, `AGENTS.md` (CLAUDE.md and GEMINI.md link to it), `README.md`.

Verified: `git diff --check` clean; `node scripts/run-tests.mjs employee-access-github-comments` PASS; the seven-suite regression list PASS (11 suites, including company-identity with the extended readiness key list).

Live (sandbox `delorenj/flume-identity-sandbox` PR #1 only), receipt `_bmad-output/implementation-artifacts/FLUME-51/live-proof-2026-10-14.md`:
- Grolf adopted actor `341820121` (`gr0lfbot[bot]`), committed in the 33GOD repo.
- Conversation comment `6181426777` and inline comment `4277681258` (proof.txt line 2, PR head) read back `native-verified`; a re-run reconciled to the same comment; `verify` of Grolf alone is `not-native-distinct` (`fewer-than-two-employees`); commit evidence is `unsupported-evidence`.

Blocking condition for live AC1, still open: the Rererere App (5296560) has no installation on the sandbox (`installations: []`, 2026-10-15T00:20Z). Gate, in order: the operator passkey install of App 5296560 on the sandbox; `identity bind rererere github ... --apply`; a sandbox grant for subject `1dca27f5-06e8-47a3-86c9-49bc3ed5331c`; `adopt-actor`.

Risk: a facade running a build without `native_actor_id` reads an adopted definition as invalid and answers that employee `unknown-client`. This happened live after adopting Grolf and was fixed by landing, rebuilding and restarting `flume-access.service`. Deploy the new build before adopting on any other host.

### Review pass (2026-10-14)

Final status: done (implementation and review); live AC1 remains blocked by the Rererere gate above.

Files changed:
- `contracts/company-identity.schema.json`, `packages/flume-hr/src/workforce/types.ts` — optional `native_actor_id` on the binding.
- `packages/flume-hr/src/workforce/github.ts` — exported transport/error helpers; `resolveGithubBotActor`.
- `packages/flume-hr/src/workforce/company.ts` — `adoptNativeActor`; identical rebind of an adopted binding stays a no-op.
- `packages/flume-hr/src/workforce/comment.ts` (new) — `postComment`, `verifyComments`, the authorship rule, reconcile.
- `packages/flume-hr/src/workforce/access.ts` — four `FLUME_*` exec env vars from the granted body.
- `packages/flume-hr/src/workforce/readiness.ts`, `workforce/index.ts` — `github_native_authorship`; exports.
- `packages/flume-hr/src/index.ts` — `identity adopt-actor`, `comment post|verify`.
- `tests/employee-access-github-comments-regressions.mjs` (new), `scripts/run-tests.mjs`, `tests/company-identity-regressions.mjs` — suite and registration; readiness key list.
- `docs/employee-access.md`, `AGENTS.md`, `README.md` — flow, rule, reconcile semantics, live-proof gate, deploy-first warning.
- `_bmad-output/implementation-artifacts/FLUME-51/live-proof-2026-10-14.md` — Grolf live receipt and AC1 gate.

Review findings: 50 (high 0, medium 2, low 32, false 15, maybe-false 1).
- Patches applied (2 entries): medium — re-running an identical `identity bind` after `adopt-actor` failed `binding-conflict` (fixed in `bindEmployeeProvider`, tests added); low — deploy-order hazard documented in `docs/employee-access.md`.
- Deferred: none.
- Rejected: 46, each with its reason in the Review Triage Log (spec-mandated behavior, fail-closed rare paths, unreachable inputs, or claims refuted).

Follow-up review recommended: false (patched: high 0, medium 1, low 1).

Verification: `git diff --check` clean; `node scripts/run-tests.mjs employee-access-github-comments` PASS; `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access identity-provision specialist-hire` — 11/11 suites PASS after the patch. Matrix audit: every I/O matrix row has an asserting test in the comments suite that ran and passed.

Residual risks: live `native-distinct-verified` with `evidence: provider` is unproven until Rererere's gate clears; `comment` consumers trust the `--exec` environment and rely on the readback author check if run with a foreign token; concurrent same-marker invocations are not serialized.
