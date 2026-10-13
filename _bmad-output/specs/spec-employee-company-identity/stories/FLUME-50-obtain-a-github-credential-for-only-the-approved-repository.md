---
title: 'FLUME-50 — Obtain a GitHub credential for only the approved repository'
type: 'feature'
created: '2026-10-13'
status: 'done'
baseline_revision: '34bc2a353d0398950d1a81945f8af303cf776a1c'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/architecture.md'
  - '{project-root}/_bmad-output/specs/spec-employee-company-identity/stories/FLUME-48-authenticate-employee-access-requests-independently-of-the-harness.md'
  - '{project-root}/docs/employee-access.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** The FLUME-48 access facade authenticates the employee and run, but it only issues fixture grants. An employee still has no way to get a real, repository-scoped GitHub credential of its own, so code-host work falls back to Jarad's personal token.

**Approach:** Add a GitHub App credential adapter behind the existing facade for `service: "github"`. It reads the authenticated employee's own `github` binding (`principal` = App ID, `instance` = installation ID, `credential_ref` = op:// reference to the App private key). The private key is resolved only inside the facade process. Using `@octokit/auth-app`, it mints an installation token restricted to exactly one repository and the requested permissions, and it reports the provider's real expiry. The token reaches only the `--exec` child of `flume access request`. It never reaches stdout, logs, files or receipts. Add an explicit `flume identity bind` enrollment step and a read-only `flume access github-inspect` discovery command.

## Boundaries & Constraints

**Always:**
- Keep the FLUME-48 order: authenticate → map → run → body → employee/status → idempotency. For `github`, the request shape check (below) comes next, then policy, then the binding check, then the provider. Every other service keeps the existing policy → fixture issue unchanged.
- The adapter uses only the authenticated subject's `bindings.github`. Missing binding → 403 denied `no-provider-binding`. Non-digit `principal`/`instance` or a missing `credential_ref` → `provider-binding-invalid`. Both are refused before any vault read or provider call. There is no PAT, `GITHUB_TOKEN`/`GH_TOKEN`, other-employee or shared-app fallback anywhere.
- `resource` must be exactly `owner/repo` (no wildcard, no bare owner). Each permission must be `<name>:<read|write>`. Violations are denied as `invalid-resource`/`invalid-permission` before the provider. A `lifetime_seconds` on a github request is denied `lifetime-not-supported`, because GitHub fixes the lifetime. Shape refusals are denials: they are not persisted and they make no provider call. Operator grants stay the authority, and a request outside them returns `approval_required` before any binding read.
- Provider sequence: (1) an app-JWT `GET /app/installations/{instance}` call. A 404 means `installation-mismatch`; a suspended installation is denied; an account login ≠ repo owner is `repository-not-installed`; requested permissions beyond the installation's are `excessive-permissions`. (2) One `POST /app/installations/{instance}/access_tokens` call through `createAppAuth(...)({ type: "installation", repositoryNames: [repo], permissions, refresh: true })`, with a request built from `@octokit/request` `defaults({ baseUrl })`. A fresh auth instance is used per issuance, and `repositories` is always present with length 1. (3) Verify the response. If the returned repositories ≠ [repo], or repository_selection is not `selected`, or permissions are not a subset → `provider-scope-mismatch`. If provider `expires_at` exceeds approved lifetime + 60s → `provider-lifetime-exceeds-grant`. Either case revokes via `DELETE /installation/token`.
- Bounded retries: the installation GET gets ≤2 attempts on network/5xx. The POST gets exactly 1 attempt. A revoke gets ≤2 attempts. Each call is aborted after `FLUME_GITHUB_TIMEOUT_MS` (default 15000). A definitive provider 4xx on the POST is denied `provider-refused` with the provider message's first line. It is not persisted. A POST timeout, network error or 5xx is ambiguous: 502 `status: "unverified"`, `code: "issuance-ambiguous"`. That result IS persisted under the request_id, so a replay never re-mints. A failed revoke is 502 `unverified` with `residual_expires_at`.
- A granted result carries `provider: "github"`, `evidence` (`"provider"` only when the API base is `https://api.github.com`, otherwise `"fixture"`), `app_id`, `installation_id`, `repository`, the provider-returned `permissions`/`repository_selection`, the provider `expires_at`, and `lifetime_seconds` derived from it. The credential is `{ kind: "github-installation-token", value }`. The first response is its only channel. Token length or prefix is never validated.
- `provider-ledger.jsonl` records attempt/issued/refused/ambiguous/revoked/revoke-failed lines. Each line holds IDs, scopes, expiry, HTTP status and `x-github-request-id`, and nothing else. No token, private key, app JWT, or a prefix or hash of any of them is written to audit, ledger, idempotency, stdout, stderr or definitions.
- `flume access request`: only a `fixture-bearer` credential may be printed. `--exec -- <cmd>` runs the consumer with the parent env minus `CF_ACCESS_CLIENT_SECRET`/`FLUME_RUN_ASSERTION`, plus `GH_TOKEN`, `GITHUB_TOKEN`, `FLUME_GRANT_ID` and `FLUME_GRANT_EXPIRES_AT`. It prints the redacted result to stderr and exits with the child's code. `--service github` without `--exec` is refused before any request.
- `flume identity bind <employee> <provider> --principal --instance --credential-ref [--attribution-mode] [--apply]` is a preview unless `--apply`. It reuses `bindEmployeeProvider` with its blockers. For provider `github` it also requires a digit principal and instance. The `credential_ref` must have exactly three segments, `op://<vault>/<item>/<field>`, where `<item>` is a 26-character 1Password item UUID (`^[a-z0-9]{26}$`), not a title. A section-label path is refused. The docs require `<field>` to be the field ID.
- `flume access github-inspect (--employee <e> | --app-id <id> --key-ref <op://…>)` runs app-JWT GETs only: `/app` and `/app/installations`. It prints app id/slug/client_id/owner, `bot_login` `<slug>[bot]`, and each installation's id/account/selection/permissions/suspended state, plus `observed_at` and `evidence`. It never mints, writes or adopts.
- Readiness gains `github_sandbox_installation`, which is always `unproven`.

**Never:**
- Register, install or expand GitHub Apps; sign up for accounts; request merge/admin grants; post comments (FLUME-51); store native actor IDs (FLUME-51 adopts them).
- Mint against a real installation unless an operator-designated sandbox repository and installation is verified. Without that designation, record the exact gate and stop at fixtures and optional read-only `github-inspect` of the Grolf (33god-pm) and Rererere Apps.
- Print `op item` JSON or any key or token material; scan the vault globally; edit vault items; touch Cloudflare, Plane, mail or `templates/hermes-agent`; change the unrelated main-branch WIP.
- Hand-roll JWT signing or the OAuth/installation-token protocol.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|---|---|---|---|
| Approved | A bound + grant `github` `o/sandbox` `issues:write` | 200 granted, provider expiry, exec child authenticates | — |
| Replay / changed | same request_id | `replayed: true`, no POST / 409 | — |
| Unbound / malformed | A has no or bad `github` binding | 403 `no-provider-binding` / `provider-binding-invalid` | 0 provider calls, no `op read` |
| Foreign / mismatch | body `employee: B`; A's app vs B's installation | `employee-mismatch` / `installation-mismatch` | only A's app iss seen |
| Not installed | repo owner ≠ install account; POST 422 | `repository-not-installed` / `provider-refused` | no token |
| Excess | perms beyond grant / installation | `approval_required` / `excessive-permissions` | no POST |
| Bad shape | `o/*`, `o`, `issues:admin`, lifetime set | `invalid-resource` / `invalid-permission` / `lifetime-not-supported` | 0 calls |
| Scope / lifetime drift | provider returns all repos, extra perm, or expiry > grant | revoked, `provider-scope-mismatch` / `provider-lifetime-exceeds-grant` | revoke 500 → 502 `unverified` + residual |
| Ambiguous | POST 500 / hang | 502 `issuance-ambiguous`, replay same, exactly 1 POST | fresh id mints once |
| Rotation / expiry | new key ref; new request after expiry | same subject/app/installation in receipt | — |
| Token shapes | 40-char `ghs_` and 520-char other-prefix | both granted and usable | — |

</intent-contract>

## Code Map

- `packages/flume-hr/src/workforce/access.ts:201-228` `decide` -- sync fixture issue; make it async inside the existing `serialized` (:152), dispatch `github` to the adapter, persist `unverified`; `ledger` :96, `FIXTURE` :119, `refusal` :129, idempotency :97-106; `requestAccess` :324-344 gains exec/redaction.
- `packages/flume-hr/src/workforce/launcher.ts:40-44` `readVaultSecret` -- move to new `vault.ts` and re-export, so `github.ts`→`access.ts` does not cycle through the launcher.
- `packages/flume-hr/src/workforce/company.ts:322-353` `bindEmployeeProvider` -- reuse for `identity bind`; `identityCensus`/`resolveEmployee` :105/:132.
- `packages/flume-hr/src/workforce/provision.ts:116-131` -- precedent: identity items hold duplicate labels across sections; reference fields by ID.
- `packages/flume-hr/src/workforce/readiness.ts:18-24` `UNPROVEN` -- add the check.
- `packages/flume-hr/src/index.ts:206-308` identity group, `:326-380` access group -- `guardBrokenPipe`/`writeStdout`/`exitAfterFlush` pattern; the `serve` description says "fixture grants only".
- `contracts/company-identity.schema.json` `$defs.binding` -- closed `principal`/`instance`/`credential_ref`/`attribution_mode`; the GitHub binding fits as-is, so there is no schema change.
- `tests/employee-access-regressions.mjs:55-239` -- fake edge, fake `op` (:110), fixture homes, `startFacade`, `viaEdge`, `runAsync`; copy these patterns into the new suite.
- `tests/company-identity-regressions.mjs:474` -- the readiness key list to extend.
- `scripts/run-tests.mjs:77-79` -- SUITES registration.

## Tasks & Acceptance

**Execution:**
- `packages/flume-hr/package.json`, `package-lock.json` -- add `@octokit/auth-app` ^8 and `@octokit/request` ^10 -- provider libraries, not hand-rolled protocol.
- `packages/flume-hr/src/workforce/vault.ts` (new), `launcher.ts` -- move `readVaultSecret` here and re-export it -- shared trusted-process secret read.
- `packages/flume-hr/src/workforce/github.ts` (new) -- binding/resource/permission validation, `FLUME_GITHUB_API_BASE`/timeout, pre-check, mint, verify, revoke, ledger lines, `inspectGithubApp` -- the adapter.
- `packages/flume-hr/src/workforce/access.ts` -- service dispatch, async decide, `unverified` persistence, the github result shape, and client `--exec`/redaction -- one facade.
- `packages/flume-hr/src/workforce/readiness.ts`, `workforce/index.ts` -- add the unproven check and the exports.
- `packages/flume-hr/src/index.ts` -- `identity bind`, `access github-inspect`, `access request --exec`, honest `serve` description -- public surface.
- `tests/employee-access-github-regressions.mjs` (new), `scripts/run-tests.mjs`, `tests/company-identity-regressions.mjs:474` -- built-CLI suite with fake edge + fake GitHub API (verifies RS256 app JWT per app, records calls and fault modes) + fake `op`. It covers every matrix row, the bind/inspect commands, and a secret scan of minted tokens, PEMs and app JWTs across state, stdout/stderr and definitions. Register it -- the loop gate runs it under `employee-access`.
- `docs/employee-access.md`, `AGENTS.md`, `README.md` -- binding/grant example, permission vocabulary, exec delivery, lifetime/ambiguity semantics, metadata-only vault discovery, and the sandbox live-proof procedure and gate.

**Acceptance Criteria:**
- Given A's bound App and an operator grant, when A requests via `flume access run A -- flume access request --service github … --exec -- <consumer>`, then the provider POST names exactly one repository and the requested permissions, the result reports provider expiry, and the consumer authenticates while no token appears in any output or state file.
- Given any refusal row, when issuance is attempted, then the fake provider saw no call made with another employee's App or a PAT, and ambiguous or unrevoked outcomes stay `unverified` across replays.
- Given a key rotation or a post-expiry re-request, when the token is replaced, then subject, app_id and installation_id are unchanged, and the provider saw at most the bounded attempts.
- Given no operator-designated sandbox installation, when the story completes, then no real token was minted, and the Auto Run Result names the exact gate: sandbox repo, installation and rights for the Grolf and Rererere Apps, plus the live bind.

## Spec Change Log

## Review Triage Log

### 2026-10-13 — Review pass
- verdicts: 45 findings — high 0, medium 3, low 30, false 12, maybe-false 0
- findings:
  - `[medium]` `[patch]` Blind: the runtime `githubBindingOf` accepted a hand-edited title-based or section-qualified `credential_ref` that `identity bind` refuses. — `githubBindingOf` now runs `githubCredentialRefProblem`, so such a ref is `provider-binding-invalid` before any vault read. A test covers a title ref and a section path, each with 0 calls and 0 key reads.
  - `[false]` `[reject]` Blind: `attribution_mode: shared_bot_attributed` is ignored at issuance. — Issuance must use the employee's own App whatever the mode (Always clause). Attribution belongs to FLUME-51 comment attribution, so ignoring the mode here is correct.
  - `[low]` `[reject]` Blind: `readVaultSecret` uses `spawnSync` and blocks the facade event loop for up to 30s. — It is a normal `op read` of about 1s in a single-operator facade. A hang is rare, and an async rewrite adds complexity.
  - `[low]` `[reject]` Blind: the `serialized` lock is held across provider calls. — The Code Map directs this. The worst case is bounded (each call ≤15s, ≤5 calls). A per-key in-flight guard is new concurrency machinery.
  - `[low]` `[reject]` Blind: there is no in-flight idempotency record before the POST, so a crash between mint and persist can re-mint on replay. — It needs a facade crash in a millisecond window. The fix adds a new pending state and restart reconciliation.
  - `[low]` `[reject]` Blind: a grant with `max_lifetime_seconds` < 3600 mints and then revokes every time. — The outcome is safe and explicit: revoked, `provider-lifetime-exceeds-grant`. The docs require ≥3600. A pre-POST denial would be a new code not in the spec's sequence.
  - `[low]` `[reject]` Blind: transient 4xx responses (401 skew, 403/429 rate limit, 408) are treated as `provider-refused`. — The spec defines a POST 4xx as `provider-refused`, not persisted. The same request_id is re-evaluated on retry, so nothing is stuck.
  - `[low]` `[patch]` Blind: the docs' live-proof step claims `github-inspect` shows the installation is on only the sandbox repo, but it cannot list repositories. — The docs now confirm the account, `repository_selection: selected` and permissions with `github-inspect`, and check the repository list out of band in the App installation settings.
  - `[low]` `[reject]` Blind: the token outlives the `--exec` consumer, signals are not forwarded, and a signal exit maps to 1. — None of this is in the spec. The token never leaves the client process, and revoke-on-exit and signal relay add new behaviour.
  - `[low]` `[patch]` Blind: under `--exec`, a reused `--request-id` replay gives the misleading error "No GitHub installation token was granted". — `execWithGithubToken` now says the token is delivered only on the first response and asks for a fresh `--request-id`. A test asserts the message and that no consumer starts.
  - `[low]` `[patch]` Blind: the `github-inspect` CLI catch block hard-codes `evidence: "fixture"`. — It now uses `githubEvidence()`.
  - `[false]` `[reject]` Blind: `github-inspect` flags truncation only in text output. — The JSON report includes `truncated: true` when it is set.
  - `[low]` `[reject]` Blind: `bindProvider` filters blockers with a `startsWith("principal")` string match. — The only harm is a duplicate blocker message if the wording changes. The behaviour is unaffected.
  - `[low]` `[reject]` Blind: the list of untested paths (concurrency, short grant, 401/429, crash window, shared_bot, signals, runtime title ref). — The runtime title ref is now tested (patched above). The rest map to rejected findings in this log.
  - `[low]` `[reject]` Edge: a grant under 3600 mints and then revokes. — Same root cause and reason as the Blind short-grant row.
  - `[low]` `[reject]` Edge: if the persist write throws after a mint (disk full), the token is neither returned nor revoked. — Same root cause as the in-flight-record row. It needs a disk failure at that instant.
  - `[low]` `[reject]` Edge: a crash between the POST and persist allows a replay to re-mint. — Same root cause as the in-flight-record row.
  - `[low]` `[reject]` Edge: the block and binding are read before `serialized`, so a suspension made while a request is queued is not seen. — The FLUME-48 fixture path already had this read-before-lock ordering. The window is the lock wait. Re-reading the census inside the lock is new, unrequested behaviour.
  - `[low]` `[reject]` Edge: synchronous `op read` stalls the facade. — Same root cause and reason as the Blind `spawnSync` row.
  - `[medium]` `[patch]` Edge: the UUID/field-ID ref rule is enforced only at bind, not at runtime. — Same fix as the first Blind row.
  - `[low]` `[reject]` Edge: an App or installation ID longer than 15 digits loses precision in `Number()`. — Real GitHub IDs are 6–9 digits. A guard would protect state never shown to occur.
  - `[low]` `[reject]` Edge: 429/403/408 responses are classified as `provider-refused`. — Same root cause and reason as the Blind transient-4xx row.
  - `[false]` `[reject]` Edge: the installation GET could return a different installation id. — GitHub's `GET /app/installations/{id}` returns the addressed installation. Only a lying double could do otherwise, and that is not a reachable production state.
  - `[low]` `[reject]` Edge: if the consumer fails to spawn after a grant, the token is left live. — The token exists only in the exiting client process's memory and expires on its own. Revoke-on-spawn-failure is new behaviour.
  - `[low]` `[patch]` Edge: the `--exec` replay of a granted request gives a misleading error. — Same fix as the Blind replay row.
  - `[false]` `[reject]` Edge: `identity bind` with provider `GitHub` skips github validation. — `bindEmployeeProvider` refuses any provider outside `^[a-z][a-z0-9_]{0,31}$` with `invalid-provider`, and the schema's `propertyNames` is lowercase too.
  - `[false]` `[reject]` Edge: a `GET /app` without a slug yields `undefined[bot]`. — GitHub's `/app` always returns `slug`. No reachable input produces this.
  - `[false]` `[reject]` Edge: the `listening` line dropped `evidence`. — The only consumer (`tests/employee-access-regressions.mjs:215`) reads `url`. The old `evidence: "fixture"` claim is no longer true for github.
  - `[low]` `[reject]` Edge claim: "a replay never re-mints" does not hold across a crash before persist. — Same root cause and reason as the in-flight-record row.
  - `[false]` `[reject]` Edge claim: `FLUME_GITHUB_TIMEOUT_MS` does not bound the `op read` or the retry sleeps. — The spec bounds "each call" to the provider. That is implemented per fetch, and `op read` is not a provider call.
  - `[low]` `[patch]` Gap: the `covers()` / `withinRequest()` level comparisons were never exercised. — Added an ada `contents:write` grant, which is `excessive-permissions` with 0 POSTs, and a fake `level-up` mode returning `issues:write` for `issues:read`, which is revoked as `provider-scope-mismatch`.
  - `[medium]` `[patch]` Gap: the `redirect: "error"` credential guard was untested. — Added a 307-to-canary fake mode: the canary sees no request and no grant is made. The implementer confirmed that `"follow"` fails the test.
  - `[low]` `[patch]` Gap: `credential-unavailable` and `app-key-invalid` were never exercised. — Added a missing-ref binding (502 `credential-unavailable`) and a non-PEM binding (`app-key-invalid`), each with 0 provider calls.
  - `[low]` `[patch]` Gap: the rotation test's `?? first.body[field]` was vacuous, and `receipt` was unused. — It now asserts `app_id`, `installation_id` and `repository` directly, and the unused variable is removed.
  - `[low]` `[patch]` Gap: `evidence: "provider"` against the real base was never asserted (filed as defer). — Patched cheaply: `github-inspect --app-id 1` with an absent ref asserts `provider` for `https://api.github.com` with and without a trailing slash, and `fixture` for the fake. The vault read fails before any network call.
  - `[low]` `[patch]` Gap: the non-github `bind` `op://` branch and the "command after -- needs --exec" guard were untested. — One assertion added for each.
  - `[low]` `[reject]` Gap: no test for a grant under 3600. — Same root cause as the short-grant row, which is rejected.
  - `[false]` `[reject]` Intent: there is no code-level gate, and the default base is the real API. — A real mint needs an operator `identity bind --apply` and an operator grant. Neither exists for any real employee, and this run made no real mint. That is the operator designation the Never clause asks for.
  - `[false]` `[reject]` Intent: the ledger carries `reason` and `attempt` beyond "IDs, scopes, expiry, status, request-id". — No harm is named. Both are non-secret enumerations or counters, and the secret scan's allow-list covers them.
  - `[false]` `[reject]` Intent: pre-POST refusals write no provider-ledger line. — The spec's ledger events cover issuance. Every denial is recorded in `audit.jsonl`.
  - `[low]` `[patch]` Intent: `@octokit/request` wraps network errors as status 500 with no response, so the ledger recorded a fabricated `http_status: 500` / `http-5xx`. — Verified in `node_modules/@octokit/request/dist-bundle/index.js:78`. `statusOf` now returns a status only when `error.response` exists, so network errors log `reason: "network"` (or `timeout`) and the retry/ambiguity behaviour is unchanged.
  - `[low]` `[patch]` Intent: the Excess block's vault-read assertion `>=` was vacuous and captured too late. — `reads` is now captured before the approval_required requests and asserted `===`.
  - `[false]` `[reject]` Intent: the facade returns `credential.value` in its HTTP body. — The spec says the first response is the credential's only channel. The exec-only rule applies to the `flume access request` client, as specified.
  - `[low]` `[reject]` Intent: the installation GET network-error retry, the POST network error and the 15000ms default are untested. — The network error shares the 500 path in octokit, which is tested via 500 and a hang. A default-timeout test would take 15s or more per run.
  - `[false]` `[reject]` Intent: "record the exact gate" is generic. — The Auto Run Result below names the exact gate.

### 2026-10-13 — Review pass (follow-up)
- verdicts: 43 findings — high 0, medium 1, low 27, false 15, maybe-false 0
- findings:
  - `[low]` `[reject]` Blind: a grant under 3600s mints a real token and then revokes it. — carried: same claim as the earlier short-grant row; `issueGithubToken` lifetime check is unchanged.
  - `[low]` `[reject]` Blind: the synchronous `op read` and the `serialized` lock held across provider calls stall the whole facade. — carried: same claims as the earlier `spawnSync` and lock rows; `vault.ts` and `serialized` are unchanged.
  - `[low]` `[reject]` Blind: a crash during the mint POST breaks "a replay never re-mints" because no in-flight record exists. — carried: same as the earlier in-flight-record row.
  - `[low]` `[reject]` Blind: 429, rate-limit 403 and clock-skew 401 are definitive `provider-refused` on the GET and the POST. — carried: same as the earlier transient-4xx rows; the spec retries the GET only on network/5xx.
  - `[low]` `[reject]` Blind: `bindProvider` filters blockers by `startsWith("principal")`, has no provider allow-list, and re-binds without a diff. — carried for the prefix filter. The allow-list part: `bindEmployeeProvider` already refuses provider names outside `^[a-z][a-z0-9_]{0,31}$`, and a generic non-github bind is the specified behaviour. Re-bind is an explicit `--apply` operator act after a preview.
  - `[false]` `[reject]` Blind: the token is checked by repository name only (no owner), and a narrower token is reported as granted. — The POST names the installation already matched to the owner, so an installation token cannot cover another account's repository. The spec's check is "permissions are a subset", and the result reports the permissions GitHub actually returned, so a narrower token is never misreported.
  - `[false]` `[reject]` Blind: `evidence` comes from the base URL alone, so GitHub Enterprise would be labelled `fixture`. — The intent defines exactly this rule ("`provider` only when the API base is `https://api.github.com`, otherwise `fixture`"). The `listening`-line part is carried false from the earlier row.
  - `[low]` `[reject]` Blind: `--exec` does not forward signals, maps a signal exit to 1, and passes `OP_SERVICE_ACCOUNT_TOKEN` through. — carried for signals and exit code. The env part is false: the client runs under `flume access run`, whose launcher strips every `*TOKEN`/`*_KEY`/`VAULT_*` variable (`launcher.ts:24`), and the intent names exactly the two removed variables.
  - `[low]` `[reject]` Blind: a lost first response or a consumer that fails to spawn loses the token, and the receipt prints before spawn is known. — carried: same as the earlier spawn-failure row; the replay message was patched in the earlier pass.
  - `[low]` `[reject]` Blind: `github-inspect` caps at 5 pages, does not cross-check bot login or key App ID, uses `any` casts, and the README shows only `--employee`. — 500 installations is far above two Apps' real counts. A key for a different App fails JWT verification with 401, which is reported. `docs/employee-access.md:96` documents both forms. None of this is met in everyday use, and each fix adds a branch.
  - `[low]` `[reject]` Blind: the fake lacks clock skew, 429 and revoke-fails-once-then-succeeds; the docs paragraph is long; AGENTS/README omit the env vars. — `docs/employee-access.md:141` documents `FLUME_GITHUB_TIMEOUT_MS` and `FLUME_GITHUB_API_BASE`. The revoke retry loop is the same code that the tested always-500 path runs twice. The rest is cosmetic or carried (429).
  - `[low]` `[reject]` Edge: a ledger or idempotency write that throws after a mint leaves the token live and unrevoked. — carried: same as the earlier disk-full persist row.
  - `[false]` `[reject]` Edge: a 201 without `permissions` makes `withinRequest` throw after minting. — `@octokit/auth-app` defaults the field: `const permissions = permissionsOptional || {}` (`node_modules/@octokit/auth-app/dist-node/index.js:251`), so `minted.permissions` is never undefined.
  - `[low]` `[reject]` Edge: the client's 30s fetch abort is shorter than the facade's worst-case github budget, so a slow mint is granted but never delivered. — Reaching it needs over 30s of combined GitHub latency on a successful mint. The undelivered token value never leaves the facade process, so nobody holds it, and it expires on its own. A real fix is an overall issuance deadline, which is new machinery.
  - `[low]` `[reject]` Edge: the global `serialized` lock and `spawnSync` block all employees behind one slow call. — carried: same as the earlier lock and `spawnSync` rows.
  - `[low]` `[reject]` Edge: no pending idempotency marker before the POST. — carried: same as the earlier in-flight-record row.
  - `[low]` `[patch]` Edge: `covers()` ranks an installation's `admin` level as 0, so a write request against an installation holding `repository_projects:admin` is falsely `excessive-permissions`. — Verified: `RANK` had only read/write, and GitHub's App permission schema allows `admin` for `repository_projects`/`organization_projects`. Fixed with `admin: 3` in `RANK` (`github.ts:30`). `withinRequest` still treats a returned `admin` as broader than a requested write. A test grants `repository_projects:write` against an `admin` installation, and removing `admin: 3` fails the suite.
  - `[low]` `[reject]` Edge: IDs over 15 digits lose precision in `Number()`. — carried: same as the earlier long-ID row.
  - `[low]` `[reject]` Edge: a revoke 401 for an already-invalid token is reported as `revoke-failed`. — The revoke runs seconds after the mint, so a freshly minted token being already invalid is not met in practice. The fix adds a status branch.
  - `[low]` `[reject]` Edge: a sub-3600 `max_lifetime_seconds` grant can never succeed. — carried: same as the earlier short-grant row.
  - `[low]` `[reject]` Edge: a signal-killed consumer exits 1 and a SIGTERM to the parent orphans the child. — carried: same as the earlier signal-relay row.
  - `[low]` `[reject]` Edge: the 429/403 secondary rate limit on the installation GET is not retried. — carried: same as the earlier transient-4xx rows.
  - `[false]` `[reject]` Edge claim: `FLUME_GITHUB_TIMEOUT_MS` does not bound the vault read. — carried: same as the earlier row; `op read` is not a provider call.
  - `[low]` `[reject]` Edge claim: "exits with the child's code" fails for signals, and a replayed grant prints a receipt before failing. — The signal part is carried from the earlier signal row. The replay receipt is accurate (`replayed: true`), the error explains the fresh `--request-id`, and the fix would add a branch for an explicit `--request-id` reuse only.
  - `[false]` `[reject]` Edge: the `listening` line dropped `evidence`. — carried: same as the earlier row; its only consumer reads `url`.
  - `[low]` `[patch]` Gap: owner/repository case-insensitivity in the installation and returned-token checks was untested. — The fake now matches repository names case-insensitively and answers with GitHub's canonical name. A new `O/Sandbox` grant and request assert `granted`, POST `repositories: ["Sandbox"]`, and no revoke. Dropping the repo `.toLowerCase()` comparison fails the suite.
  - `[medium]` `[patch]` Gap: malformed 201 bodies (no token, unparseable `expires_at`) were never exercised, so the guard that revokes rather than crashing with an orphaned token was unprotected. — Added fake modes `no-token` (asserts 502 `issuance-ambiguous`, persisted, an `ambiguous` ledger line with `reason: "no-token"`, one POST) and `bad-expiry` (asserts `provider-lifetime-exceeds-grant`, one DELETE, the token revoked, not persisted). Removing `!Number.isFinite(expiresMs) ||` fails the suite.
  - `[low]` `[reject]` Gap (other): network-level failures on the installation GET and the revoke DELETE are untested. — carried: same as the earlier network-error row. In addition, this pass probed the installed `@octokit/request` directly: a refused port, a reset socket and a timeout each reject with `status: 500` and no `response` (timeout `cause.name === "TimeoutError"`), so `statusOf` returns `undefined` and the code logs `network`/`timeout`, retries the GET and stays ambiguous on the POST.
  - `[false]` `[reject]` Intent fork a: GitHub's automatic `metadata:read` is tolerated in the subset check. — GitHub adds it to every installation token, and it is read-only. Refusing it would revoke every real token.
  - `[false]` `[reject]` Intent fork b: request time also enforces the bind-time UUID/field-ID rule. — This is the earlier pass's medium patch. It is stricter only and refuses before any vault read.
  - `[false]` `[reject]` Intent fork c: the UUID rule applies to github only. — The intent places the rule under "For provider github it also requires…".
  - `[false]` `[reject]` Intent fork d: the ledger carries `reason`/`attempt`, and installation-check refusals write no ledger line. — carried: same as the earlier two ledger rows.
  - `[low]` `[reject]` Intent fork e: under `--exec`, a refused or unverified result goes to stdout, not stderr. — No consumer runs in that case, so stdout carries nothing else, and exit 1 signals failure. Rerouting adds a branch for a cosmetic difference.
  - `[false]` `[reject]` Intent fork f: a drift whose revoke succeeded is not persisted, so a replay re-mints. — Every re-mint is verified and revoked again, so no token outlives the check. The intent persists only ambiguous and unrevoked outcomes.
  - `[false]` `[reject]` Intent fork g: one App ID bound to two employees with different installations is not blocked at bind. — The intent says to reuse `bindEmployeeProvider` with its existing blockers, and issuance never falls back: each request uses only its own subject's binding.
  - `[false]` `[reject]` Intent fork h: the installation GET and the revoke DELETE set their `Authorization` header by hand. — The JWT is signed by `@octokit/auth-app` and the token mint goes through `createAppAuth`. Putting a JWT or token into a header is not hand-rolled signing or a hand-rolled token protocol.
  - `[false]` `[reject]` Intent: no grant is checked against the real API or 1Password, and Grolf/Rererere are not bound. — The Never clause forbids a real mint without an operator-designated sandbox, and the exact gate is recorded in `docs/employee-access.md` and in the Auto Run Result below.
  - `[false]` `[reject]` Intent: the fake assumes a scoped token reports `repository_selection: "selected"` and does not model an all-repositories installation. — The documented live-proof procedure requires a `selected` installation. Even if GitHub reported otherwise, the result is a revoke (fail-safe), not a broader grant.
  - `[low]` `[reject]` Intent: an installation GET timeout and a POST connection failure are not tested. — carried: same as the earlier network-error row. The octokit error shape was probed directly this pass (see the Gap-other row).
  - `[low]` `[reject]` Intent: a revoke 4xx and inspect truncation are not tested. — A revoke 4xx takes the same `catch` as the tested 500. Truncation needs more than 500 fake installations. Neither is met in everyday use.
  - `[low]` `[reject]` Intent: the single-flight lock is held across provider calls, up to about 75s. — carried: same as the earlier lock row.
  - `[false]` `[reject]` Intent: removing `CF_ACCESS_CLIENT_SECRET`/`FLUME_RUN_ASSERTION` relies on the launcher for other tokens. — The intent names exactly those two variables, `execWithGithubToken` removes them itself (tested), and `GH_TOKEN`/`GITHUB_TOKEN` are overwritten with the minted token.
  - `[low]` `[reject]` Intent: an uncommitted working-tree change deleted the spec's earlier Auto Run Result, including the gate text. — The fix would edit this build's spec. The Auto Run Result written by this pass restates the exact gate, and the earlier result is preserved at commit `b06f4f8`.

## Design Notes

Binding mapping, without a schema change: `github: { principal: "<app id>", instance: "<installation id>", credential_ref: "op://DeLoSecrets/<item-uuid>/<field-id>", attribution_mode: "native" }`. The key lives in the identity item's `Github App` section. Find its field ID with `op item get <uuid> --format json | jq '[.fields[]|{id,label,section:.section.label,type}]'`. That filter keeps values out of the output. A Client ID field alone proves neither the App ID nor an installation; `github-inspect` reads both back.

GitHub does not let the caller shorten a token's lifetime, so the adapter reports the provider expiry. A token that outlives the grant is revoked rather than relabelled. Installation tokens cannot be listed, so an ambiguous POST cannot be reconciled. It stays `unverified`, and its residual window is unknown and bounded only by the provider's expiry.

## Verification

**Commands:**
- `git diff --check` -- expected: no output.
- `node scripts/run-tests.mjs employee-access-github` -- expected: typecheck+build ok, suite PASS.
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access identity-provision specialist-hire` -- expected: all PASS.

## Auto Run Result

### 2026-10-13 — Follow-up review pass

Status: done. All evidence is still fixture-only. The AC4 live proof is blocked by the external gate below. The implementation from the first run is at commit `b06f4f8`, and that commit also holds its full Auto Run Result.

**Summary.** `service: "github"` on the FLUME-48 access facade goes to a GitHub App adapter. For each request, the adapter:
1. Checks the request shape, then the operator grant, then the employee's own `github` binding.
2. Reads the App key with `op read` inside the facade process only.
3. Pre-checks the installation with an app JWT signed by `@octokit/auth-app`.
4. Mints with exactly one POST, for one repository and the requested permissions.
5. Verifies the scope and expiry GitHub returned, and revokes any token that drifts from them.

Ambiguous and unrevoked outcomes are persisted as `unverified`. The token reaches only the `flume access request --exec` child. Also added: `flume identity bind`, the read-only `flume access github-inspect`, and the always-unproven readiness check `github_sandbox_installation`.

This pass patched three findings:
- An installation permission at `admin` level now covers a requested `read` or `write`.
- New tests cover mixed-case `owner/repo` handling.
- New tests cover malformed 201 token responses: a missing token, and an expiry that does not parse.

**Files changed in this pass**
- `packages/flume-hr/src/workforce/github.ts`: `RANK` gains `admin: 3`, so an installation's `admin` covers a requested write (and a returned `admin` is still broader than a requested write).
- `tests/employee-access-github-regressions.mjs`: the fake GitHub matches repository names case-insensitively and answers with the canonical name. It gains the `no-token` and `bad-expiry` 201 modes, and ada's installation holds `repository_projects: admin`. New assertions cover the mixed-case grant, admin-covers-write, the malformed 201s, and the updated inspect output.

**Files changed overall since baseline `34bc2a353d0398950d1a81945f8af303cf776a1c`**
- `packages/flume-hr/src/workforce/github.ts` (new): the adapter, covering validation, transport, pre-check, mint, verify, revoke, the ledger and inspect.
- `packages/flume-hr/src/workforce/vault.ts` (new): the shared `readVaultSecret`.
- `packages/flume-hr/src/workforce/access.ts`: async `decide`, the github dispatch, `unverified` persistence, `printableResult`, `execWithGithubToken` and `githubInspect`.
- `packages/flume-hr/src/workforce/company.ts`: `bindProvider`.
- `packages/flume-hr/src/workforce/launcher.ts`: re-exports `readVaultSecret`.
- `packages/flume-hr/src/workforce/readiness.ts`: the new unproven check.
- `packages/flume-hr/src/workforce/index.ts`: the exports.
- `packages/flume-hr/src/index.ts`: `identity bind`, `access github-inspect`, `access request --exec`, and an accurate `serve` description.
- `packages/flume-hr/package.json` and `package-lock.json`: the octokit dependencies.
- `tests/employee-access-github-regressions.mjs` (new), `scripts/run-tests.mjs` and `tests/company-identity-regressions.mjs`: the suite and its registration.
- `docs/employee-access.md`, `AGENTS.md` and `README.md`: the documentation.

**Review findings, this pass.** 43 findings: high 0, medium 1, low 27, false 15, maybe-false 0.
- Patched (3 entries: 1 medium, 2 low):
  - medium: malformed-201 coverage
  - low: the admin permission rank
  - low: mixed-case coverage
- Deferred: none.
- Rejected, with the reason for each in the Review Triage Log:
  - 15 false.
  - 25 low. Most are carried from the first pass: the short grant, `spawnSync` and the lock, the crash window, the transient 4xx, the prefix filter, signals, spawn failure, the persist failure, long IDs, and network-error coverage.
  - The new low rejections:
    - the client's 30s timeout against the server budget
    - a revoke 401 on an already-invalid token
    - the `github-inspect` niceties
    - test and doc niceties
    - `--exec` refusals going to stdout
    - revoke 4xx and truncation coverage
    - the earlier Auto Run Result having been removed from the working tree
- Each of the three patches was mutation-checked. Reverting `admin: 3`, the `Number.isFinite` expiry guard, or the repository `.toLowerCase()` comparison makes the suite fail.

**Follow-up review recommended: false.** This follow-up pass patched no high finding (patched: high 0, medium 1, low 2), so the work has converged. The risk named by the previous pass was a network error being misclassified on the GET, POST or revoke paths. This pass checked it directly against the installed `@octokit/request`. A refused port, a reset socket and a timeout each reject with `status: 500` and no `response` (the timeout has `cause.name === "TimeoutError"`). So `statusOf` returns `undefined`, the ledger records `reason: "network"` or `"timeout"` with no `http_status`, the GET retries, and the POST stays ambiguous.

**Verification**
- `git diff --check`: no output after this write-back. Before it, the only hit was a trailing blank line at the end of the spec, left by the earlier removal of its Auto Run Result section.
- `node scripts/run-tests.mjs employee-access-github`: typecheck and build passed, and the suite passed both before and after the mutation checks.
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access identity-provision specialist-hire`: 10 of 10 suites passed.

**Residual risks** (unchanged from the first pass, all accepted in the triage log)
- A grant under about 3600s always mints a token and then revokes it.
- A facade crash between a mint and the persist step could let a replay mint again.
- The synchronous `op read`, and the lock held across GitHub calls, can stall other requests for as long as the timeouts allow.
- An `issuance-ambiguous` result leaves an unknown residual window of up to GitHub's expiry, about 1h.
- If the 30s client abort fires while a slow mint is still in progress, the result is a granted token that is never delivered. Nobody holds its value, and it expires on its own.

**AC4 external gate (exact).** No real token was minted. No real `github-inspect` call, vault metadata discovery, or binding write was made. The live proof needs all of the following:
- An operator-designated sandbox repository.
- For each of the existing Grolf (33god-pm, @Gr0lfBot) and Rererere GitHub Apps:
  - an installation on that repository with `repository_selection: selected`
  - its rights verified with `flume access github-inspect` and in the App's installation settings
  - the field ID of its private-key field, found in that App's identity item (`Github App` section)
- A live `flume identity bind <employee> github --principal <app id> --instance <installation id> --credential-ref op://DeLoSecrets/<item-uuid>/<field-id> --apply` for each employee.
- One operator grant per employee, with `max_lifetime_seconds` ≥ 3600.

Until all of these exist, `github_sandbox_installation` stays `unproven`.
