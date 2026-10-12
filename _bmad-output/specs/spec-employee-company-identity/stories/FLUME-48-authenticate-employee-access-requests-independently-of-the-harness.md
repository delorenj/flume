---
title: 'FLUME-48 — Authenticate employee access requests independently of the harness'
type: 'feature'
created: '2026-10-12'
status: 'done'
baseline_revision: cf0442509c76fcb4bad8a78e953c5ba6b5d214f2
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/architecture.md'
  - '{project-root}/_bmad-output/specs/spec-employee-company-identity/stories/FLUME-47-enroll-an-existing-employee-without-changing-who-they-are.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** FLUME-47 gave each employee a stable subject, but nothing proves who is calling. Any harness could name any employee in a prompt, env var or flag, and there is no request/grant contract, run binding or replay-safe receipt.

**Approach:** Add a small, versioned access facade (`flume access serve`) that authenticates each request from a Cloudflare Access service-token JWT (jose, pinned issuer/audience/RS256, rotating JWKS at `<issuer>/cdn-cgi/access/certs`). It maps the signed `(iss, common_name)` to exactly one enrolled employee through their `cloudflare_access` binding. A launcher-signed run assertion binds the actual run. An operator-authored grant list is evaluated, and only a **fixture** grant is issued. The trusted launcher (`flume launch` for Hermes, `flume access run` for any plain command) derives the employee from enrolled configuration, scrubs the vault credential and foreign bootstrap secrets from the child, and hands over only that employee's access. `flume access request` is the plain CLI client.

## Boundaries & Constraints

**Always:**
- Identity comes only from a verified `Cf-Access-Jwt-Assertion` header. `sub` is ignored, and so are email/display headers, `X-*` employee headers and body/CLI employee names. A body `employee` (handle or subject) may only be absent or equal to the authenticated employee; otherwise the request is `denied` with `employee-mismatch`.
- Order: authenticate assertion → map client → verify run → validate body → status/employee checks → idempotency → policy → fixture issue. Every refusal before policy writes no grant and no provider-ledger line.
- Mapping uses enrolled `company_identity.bindings.cloudflare_access` with `instance` = issuer and `principal` = client id (`common_name`). It needs exactly one match. A suspended or retired employee is `denied` with `employee-<status>`.
- The run assertion is an EdDSA JWT signed by the launcher (`iss: flume-launcher`, `aud: flume-access`, `sub` = subject, `jti` = run id, `harness`, 12h exp). The facade verifies it with the configured public key, and its `sub` must equal the Access-mapped subject.
- Grants are pre-approved by the operator in the config, keyed by subject+service+resource. Permissions must be a subset and lifetime is capped at `max_lifetime_seconds`. Anything else returns `approval_required`. The facade never writes the config and has no approve endpoint. Unknown body keys return 400 `invalid-request`.
- Idempotency is keyed by (subject, request_id). An identical body returns the original grant (same `grant_id`/`expires_at`, `replayed: true`, no re-issue). A changed body returns 409 `conflict`. Granted and approval_required results persist; denials are re-evaluated each time.
- The audit trail (`audit.jsonl`), idempotency records and fixture-provider ledger hold IDs, scopes, lifetime, run and outcome only. They never hold the credential value, client secret, Access JWT, run assertion or vault token. The fixture credential appears only in the first granted response.
- Every result says `evidence: "fixture"`, `provider: "fixture"`. Readiness gains an `access_assertion_policy` check that stays `unproven`.
- The child env drops `OP_*`, `CF_ACCESS_*`, `FLUME_ACCESS_*`, `FLUME_RUN_*`, `AUTOMATICAI_GATEWAY_KEY` and the existing inference keys. It then sets only this employee's `FLUME_ACCESS_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `FLUME_RUN_ID` and `FLUME_RUN_ASSERTION`, and for Hermes its own `AUTOMATICAI_GATEWAY_KEY`. Secrets are resolved with `op read` in the launcher only.
- Docs state the trust model: the evidence is possession of a scoped credential, and a shared UID is not a hostile-process boundary.

**Never:**
- Custom crypto/JWT parsing, an HTTP or other bypass mode without an assertion, or trusting `Cf-Access-Authenticated-User-Email`.
- Provision Cloudflare, Access apps/tokens, 1Password items or providers, or claim live Access proof.
- Change enrollment semantics, add a second registry, touch `templates/hermes-agent`, or weaken the existing launch refusals.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|---|---|---|---|
| Valid A | edge-minted JWT (sub "") for A + A run | 200 granted, subject A, fixture grant | — |
| Forged / wrong iss / wrong aud / expired / nbf future / HS256 | crafted JWT | 401 `invalid-assertion` | no audit grant, no ledger line |
| No assertion (direct origin) | only client-id/email headers | 401 `missing-assertion` | same |
| No `common_name` (human token) | sub+email set | 401 `missing-machine-identity` | same |
| Unknown client | valid JWT, unbound common_name | 403 `unknown-client` | same |
| Run missing / forged / A's run with B's token | — | 401 `missing-run` / `invalid-run` / `run-subject-mismatch` | same |
| Substitution | A auth + body/`--employee` B | 403 denied `employee-mismatch` | headers naming B ignored (granted as A) |
| Unapproved | resource/permission/lifetime beyond grant | 200 `approval_required` | no ledger line |
| Self-approval field | body `approved: true` | 400 `invalid-request` | — |
| Suspended | A status suspended | 403 denied `employee-suspended` | — |
| Replay / changed body | same request_id | original grant, `replayed: true` / 409 `conflict` | one ledger line |
| Launch (Hermes / plain) | parent env has OP token + B's CF secret | child has A's access only; distinct run ids, same subject | unenrolled/inactive/no binding: launcher refuses |

</intent-contract>

## Code Map

- `packages/flume-hr/src/workforce/company.ts` -- reuse `identityCensus`, `resolveEmployee`, `IdentityDefinition.block.bindings`; read-only here.
- `packages/flume-hr/src/workforce/specialist.ts:221-247` `launchSpecialist` -- spreads `process.env` (leaks `OP_SERVICE_ACCOUNT_TOKEN`); refactor to the shared scrub + access env; keep audit/override/runtime-pin refusals.
- `packages/flume-hr/src/workforce/validator.ts:8-23` -- ajv instance and `addSchema` pattern for the new contract.
- `packages/flume-hr/src/workforce/readiness.ts` `UNPROVEN` -- add `access_assertion_policy`.
- `packages/flume-hr/src/index.ts:196-275` -- `identity` group pattern (`guardBrokenPipe`/`writeStdout`/`exitAfterFlush`); `launch` at :133.
- `contracts/company-identity.schema.json` -- binding shape (`principal`, `instance`, `credential_ref` op://) reused for `cloudflare_access`.
- `node_modules/jose` 6.2.12 (transitive via MCP SDK) -- add as a direct `flume-hr` dependency; `jwtVerify`, `createRemoteJWKSet`, `SignJWT`, `importPKCS8`, `importSPKI`.
- `tests/company-identity-regressions.mjs:31-80` -- `fixture()`/`specialistFixture()` isolated-HOME patterns; `:454` asserts the readiness check list (update).
- `tests/specialist-hire-regressions.mjs:22-23` -- fake `op`/`hermes` bin pattern.

## Tasks & Acceptance

**Execution:**
- `contracts/employee-access.schema.json` (new) -- `$defs` `request` (version 1, request_id, service, resource, permissions, lifetime_seconds?, employee?; closed) and `config` (url, cloudflare_access issuer/audience, launcher signing_key_ref/public_key, grants[]) -- versioned contracts.
- `packages/flume-hr/src/workforce/access.ts` (new) -- config load, Access verifier, run assertion sign/verify, client mapping, policy, idempotency store, audit/ledger, HTTP server, request client -- facade.
- `packages/flume-hr/src/workforce/launcher.ts` (new) -- `employeeChildEnv` scrub, `employeeAccessEnv` (op read, run mint), `runEmployeeCommand` -- trusted launcher.
- `packages/flume-hr/src/workforce/specialist.ts` -- `launchSpecialist` uses launcher scrub + access env (harness `hermes`) -- one contract for both harnesses.
- `packages/flume-hr/src/workforce/readiness.ts`, `index.ts` (workforce) -- pending live check; exports.
- `packages/flume-hr/src/index.ts` -- `flume access serve|run|request` -- public surface.
- `packages/flume-hr/package.json`, `package-lock.json` -- `jose` dependency.
- `tests/employee-access-regressions.mjs` (new), `scripts/run-tests.mjs`, `tests/company-identity-regressions.mjs:454` -- built-CLI suite with fake Access edge/JWKS, fake `op`/`hermes`, every matrix row and secret scan; register.
- `docs/employee-access.md` (new), `AGENTS.md`, `README.md` -- trust model, config example, pending live proof, commands.

**Acceptance Criteria:**
- Given two enrolled employees and a configured issuer/audience, when edge-minted JWT fixtures are verified, then common_name maps to exactly one subject despite empty sub, and every forged/foreign/expired/unknown/direct-origin case is refused before grants.
- Given the same enrollment launched via `flume launch` (fake Hermes) and `flume access run` + `flume access request`, when each requests access, then receipts carry the same subject and distinct run ids/harnesses, and neither child env contains the vault token or another employee's secret.
- Given any run of this suite, when audit, idempotency, ledger and facade output are scanned, then no credential, client secret, JWT or run assertion appears.

## Spec Change Log

## Review Triage Log

### 2026-10-12 — Review pass
- verdicts: 51 findings — high 3, medium 8, low 33, false 7, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) A lost granted response cannot be recovered, and a replay after `expires_at` still says granted — this is the spec's no-credential-at-rest design. A replay carries no credential and is marked `replayed: true`. Fixing it needs a re-issue path design.
  - `[medium]` `[patch]` (blind) Config reload swallows errors and keeps revoked grants live; non-grant fields are not reloaded and that is undocumented — patched (G2). A reload failure now sets `grants = []` (fail closed) with one stderr line. The docs note that only grants reload and add an Ed25519 keygen line. Test: an invalid config turns a grantable request into `approval_required` with no ledger line.
  - `[low]` `[reject]` (blind) `http://` is allowed for issuer and url — both are operator-authored, and Cloudflare Access issuers are https. The fix adds a pattern with a loopback exception and a fixture opt-in.
  - `[low]` `[reject]` (blind) An unreadable duplicate binding hides ambiguity, and the census is re-read on every request. The unreadable definition cannot authenticate anyway. The re-read is intended, so suspension takes effect immediately.
  - `[low]` `[patch]` (blind) A JWKS outage is reported as 401, and the 500 path is unlogged — the logging part is patched (G3): the outer catch writes the first line of the error to stderr. The JWKS→503 part is rejected: diagnosability only, and it adds an error-class branch.
  - `[low]` `[reject]` (blind) An oversize body gets no response and the limit is untested. A body over 64 KiB is not produced by our own client on a loopback facade; the fix needs a 413 path plus a test.
  - `[low]` `[reject]` (blind) Idempotency store fragility:
    - unbounded growth;
    - a corrupt file;
    - ledger written before the idempotency record;
    - multi-instance races;
    - no concurrency test;
    - permission-order hash.

    The writes are atomic renames on a single facade process. A retry sends an identical body. The rest require a disk failure.
  - `[low]` `[reject]` (blind) `flume launch` now requires the whole access stack, and the gateway `op read` runs first. Verified live: both real specialists (infra-specialist, n8n-specialist) already fail launch at the FLUME-39 member-token step, so no working path broke. The refusal is loud and says how to fix it. The strict reading matches "do not weaken launcher isolation".
  - `[low]` `[reject]` (blind) Run-assertion lifecycle: no refresh after 12h, no up-front key-pair check, rotation, SIGTERM forwarding, signal exit codes. The 12h TTL is spec-fixed. A key mismatch fails loudly as `invalid-run`. The signal handling copies the pre-existing `launchSpecialist` pattern.
  - `[high]` `[patch]` (blind) The env scrub is a denylist, so other credentials reach the child — patched (G1). Verified live: the operator shell exports about 90 credentials, including `GITHUB_PERSONAL_ACCESS_TOKEN`, `PLANE_33GOD_API_KEY` and `VAULT_TOKEN`. `employeeChildEnv` now also drops `VAULT_*` and any name ending in TOKEN/SECRET(S)/PASSWORD/PASSWD/API_KEY/_KEY[_n]. The test plants ten operator credentials and asserts they are absent from both children, and that `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `XAUTHORITY` survive.
  - `[low]` `[reject]` (blind) Schema and config validation inconsistencies: the grant permission pattern, PEM validity, unknown grant subjects, duplicate grants, NaN `--port`/`--lifetime`. Each either fails loudly or makes a grant never match. NaN lifetime serialises to null and gets a 400.
  - `[low]` `[patch]` (blind) Thin coverage, a no-op ternary and a mid-file import — the hygiene is patched (G6): `token ? 401 : 401` is now `401`, and the import moved up. The Hermes-side refusal variants share `employeeAccessEnv` with the tested plain path; rejected.
  - `[low]` `[patch]` (blind) Spec and doc bookkeeping — the docs part is patched under G2 (keygen line and reload note). The parts that would edit this build's spec (`deferred`, empty logs, verification list) are rejected per rule.
  - `[medium]` `[patch]` (edge) `new URL("//")` throws outside try/catch, so an unhandled rejection crashes the facade — patched (G4). The handler body is wrapped: an unparseable target gets 400, anything else gets 500 plus a stderr line. Test: a raw `//` request gets 400, then a normal request still works.
  - `[medium]` `[patch]` (edge) Duplicate of the row above with the corrected path — G4.
  - `[low]` `[reject]` (edge) An audit write failure after a grant returns 500 "nothing was issued". Needs a disk failure inside a request; the fix needs restructured error handling.
  - `[low]` `[reject]` (edge) Ledger written before the idempotency record, so a failure between them allows a re-issue. Needs ENOSPC/EACCES mid-request; reordering alone just moves the window.
  - `[low]` `[reject]` (edge) A corrupt `idempotency.json` gives a permanent 500. The writes are temp+rename; the 500 is now logged (G3).
  - `[low]` `[patch]` (edge) The 500 path is unaudited and unlogged — G3 (stderr line).
  - `[medium]` `[patch]` (edge) Config reload fails open — G2.
  - `[low]` `[reject]` (edge) A replay after expiry or revocation says granted — same as blind row 1. No credential is returned.
  - `[low]` `[reject]` (edge) A retired employee's reused client id locks out an active one. Fail-closed `ambiguous-client`; the client id belongs to one service token.
  - `[low]` `[patch]` (edge) fetch follows a cross-origin redirect and re-sends the client secret and run assertion — patched (G5): `redirect: "manual"`. Test: a client pointed at a 302 never reaches the target.
  - `[low]` `[reject]` (edge) Plain http url — same as blind row 3.
  - `[low]` `[reject]` (edge) A JWKS outage gives 401 — same as the JWKS part of blind row 5.
  - `[low]` `[reject]` (edge) Unauthenticated refusals can flood `audit.jsonl`. The facade binds to loopback with Access in front; rate limiting is new machinery.
  - `[false]` `[reject]` (edge) A binding without a principal leaves `CF_ACCESS_CLIENT_ID` unset — `company-identity.schema.json` requires `principal` (minLength 1), and the census validates every block.
  - `[low]` `[reject]` (edge) A signing-key and public-key mismatch is not caught at launch — fails loudly as `invalid-run`.
  - `[low]` `[reject]` (edge) No SIGTERM forwarding in `runEmployeeCommand` — same pattern as the existing `launchSpecialist`. Ctrl-C reaches the process group.
  - `[low]` `[reject]` (edge) Requests start failing after 12h — the spec fixes the 12h TTL.
  - `[high]` `[patch]` (edge) The scrub list misses operator credentials — G1.
  - `[low]` `[reject]` (edge) Hermes reads the gateway secret before the enrollment refusal. The secret stays in trusted launcher memory and is never exposed. The "before any secret is read" docstring is on `employeeAccessEnv` and is accurate there.
  - `[low]` `[reject]` (edge) `--employee bob-pm` (a registry id) is denied — the spec defines body `employee` as handle or subject, and the denial fails closed.
  - `[low]` `[reject]` (verification-gap) The oversize-body limit is unpinned — same as blind row 6.
  - `[medium]` `[patch]` (verification-gap) `exp`/`jti`/`sub` requiredClaims are untested — patched (G7). `edge.mint`/`runJwt` gained `noExp`/`noJti`. A no-exp Access assertion is 401 `invalid-assertion`; a no-exp or no-jti run is 401 `invalid-run`. A mutation that removed them failed the suite.
  - `[medium]` `[patch]` (verification-gap) Idempotency is never tested across a facade restart — patched (G8). The suite SIGKILLs and restarts `flume access serve`, then replays `replay-0001`: `replayed: true`, same `grant_id`, no new ledger line.
  - `[medium]` `[patch]` (verification-gap, other) Config reload keeps revoked grants — G2.
  - `[low]` `[reject]` (verification-gap, other) Launcher ordering claim — same as the gateway-read edge row.
  - `[false]` `[reject]` (verification-gap, other) `--lifetime` NaN is unguarded — NaN serialises to null and the request schema returns 400 `invalid-request`, as the finding itself concedes.
  - `[false]` `[reject]` (intent) The Hermes harness is a stub that calls `flume access request` — the intent is fixture-proven only. A real Hermes tool is recorded as pending in the docs and Design Notes.
  - `[high]` `[patch]` (intent) The env denylist cannot tell itself apart from an allowlist for unplanted names — G1.
  - `[false]` `[reject]` (intent) The run assertion adds a second trust anchor and vault item — this is what keeps the run id from being a caller-supplied string claim, as the intent forbids.
  - `[low]` `[reject]` (intent) A replay from a different run returns the original `run_id`, untested. That is the spec's idempotency semantics, keyed by (subject, request_id).
  - `[low]` `[reject]` (intent) The launcher does not check duplicate bindings; the facade does. The facade refuses `ambiguous-client` before any grant.
  - `[low]` `[reject]` (intent) The facade writes its own provider ledger, which then proves "no mutation". In this story the fixture provider is the facade; FLUME-50 adds a real provider double.
  - `[medium]` `[patch]` (intent) AC4: audit lines lack scopes and lifetime — patched (G9). Every post-validation audit line now carries service, resource and permissions, plus the requested lifetime. Granted lines also carry `lifetime_seconds` and `expires_at`. Tests cover the granted, denied, approval_required, conflict and replay lines.
  - `[false]` `[reject]` (intent) Only the verifier is proven at the edge, and http is accepted — this matches "report live Access proof as pending", stated in the docs and readiness.
  - `[low]` `[reject]` (intent) `flume launch` preconditions changed; the specialist suite is outside the loop gate filter — same as blind row 8. The suite runs in the spec's verification and passes.
  - `[low]` `[reject]` (intent) The story's AC bullets omit ticket ACs 2 and 4 — the fix would edit this build's spec. Both are covered by the matrix and tests.
  - `[false]` `[reject]` (intent) A replay omits the credential — the intent-contract Always rule defines replay as the original grant with no re-issue, and the Design Notes record the no-token-at-rest reason.
  - `[false]` `[reject]` (intent) The pending live proof is not on the Plane ticket — `execution.md` assigns board and handback updates to the supervising session.

### 2026-10-12 — Review pass
Follow-up pass on the `done` spec.
- verdicts: 34 findings — high 0, medium 4, low 21, false 6, maybe-false 3
- findings:
  - `[low]` `[reject]` (blind) A credential is lost when the audit write fails, or the process crashes, after the idempotency record is saved. A retry with the same id is then a credential-less replay. carried: same as the first-pass edge row "audit write failure after a grant returns 500", which needs a disk failure inside a request.
  - `[low]` `[reject]` (blind) `approval_required` is permanent for a `request_id`, even after the operator edits the grants. The intent says "granted and approval_required results persist", and the CLI defaults to a fresh id on every call. The only fix is a re-evaluation state, which needs new design.
  - `[low]` `[reject]` (blind) An oversize body gets a 500 on a destroyed socket instead of a 413, and is untested. carried: same as first-pass blind row 6.
  - `[low]` `[reject]` (blind) Unbounded audit and idempotency growth; a corrupt `idempotency.json` gives a permanent 500. carried: same as the first-pass idempotency-fragility and audit-flood rows.
  - `[low]` `[reject]` (blind) Two facade instances on one state dir can both issue. carried: same as the first-pass multi-instance row.
  - `[low]` `[reject]` (blind) The Hermes gateway `op read` runs before `employeeAccessEnv`'s refusal. carried: same as the first-pass edge row; `specialist.ts` still reads the gateway first.
  - `[medium]` `[patch]` (blind) The name-suffix scrub misses credential-bearing names. Verified live in `zsh -ic env`: `NOTION_API_KEY_RR` and `POSTGRES_URL` (with an embedded password) passed the old patterns into every employee child. Patched (P1). `launcher.ts` now matches `PASSPHRASE`, `_PASS`, `APIKEY`, `CREDENTIAL(S)`, `_PAT`, `_DSN` and one trailing `_<suffix>`. It also drops `SSH_AUTH_SOCK` and any value of the form `scheme://user:pass@`. The test plants those six operator names and asserts that `KEYTIMEOUT`, and a URL with no userinfo, survive. Removing the value check fails the suite.
  - `[maybe-false]` `[reject]` (blind) The Hermes child silently loses its `*_TOKEN`/`*_API_KEY` tool credentials. The launcher sets `HERMES_HOME` to the specialist profile, where Hermes's own `.env` lives, and the scrub does not touch that file. Settling it would need the Hermes dotenv loading confirmed. Even if true, it is low: both real specialists already fail launch at the FLUME-39 member-token step.
  - `[low]` `[reject]` (blind) The client sends secrets over cleartext `http://`. carried: same as first-pass blind row 3.
  - `[low]` `[reject]` (blind) Inactive employees take part in mapping, so the result is `ambiguous-client`. carried: same as the first-pass edge row.
  - `[low]` `[reject]` (blind) The run assertion has a fixed 12h TTL, with no refresh, revocation or `jti` reuse check. carried: same as the first-pass run-lifecycle row.
  - `[low]` `[reject]` (blind) The keygen doc puts the private key on the terminal through `tee /dev/stderr`. It is a one-time operator step on the operator's own terminal. The correct alternative needs a vault-import command designed, not just a deletion.
  - `[low]` `[reject]` (blind) An omitted lifetime defaults to the grant maximum, and the `employee` field counts toward the idempotency hash. The intent caps lifetime at `max_lifetime_seconds` and does not ask for a lower default. A body that differs in `employee` is a changed body, which the intent says is `409`.
  - `[low]` `[patch]` (blind) The `startFacade` 20s timeout is never cleared; there is a hard-coded `/tmp` prefix and NaN flags. Patched (P2): the timer is `.unref()`'d, so it no longer holds the suite open. The prefix and NaN parts are carried from the first-pass rows (NaN gives 400; the prefix is `mkdtemp`-unique).
  - `[medium]` `[patch]` (edge) Inherited credential names that escape the suffix patterns: APIKEY, `*_PASS`, `*_CREDENTIALS`, `*_PAT`, a `DATABASE_URL` with a password, `SSH_AUTH_SOCK`. Same root cause as the blind scrub row; P1.
  - `[low]` `[reject]` (edge) A failed config reload persists a fail-closed `approval_required` for that `request_id`. It needs a request to land while the file is half-saved. It still fails closed, and the fix adds a branch to `decide`.
  - `[low]` `[reject]` (edge) A replay of a revoked or expired grant still says `granted`. carried: same as first-pass blind row 1.
  - `[low]` `[reject]` (edge) An issuer with a trailing slash makes every assertion `invalid-assertion`. The issuer is operator-authored, and Cloudflare's `iss` has no trailing slash. The misconfiguration fails loudly on the first request.
  - `[maybe-false]` `[reject]` (edge) `readLimited` never settles when the client aborts before its listeners attach. Settling it needs a check of whether Node emits `error` or `end` on an already-destroyed `IncomingMessage`. Even if true, it is low: one closure leaks per aborted request on a loopback facade.
  - `[low]` `[reject]` (edge) The printed URL is malformed for IPv6 or wildcard hosts. That is cosmetic, and the default host is `127.0.0.1`.
  - `[low]` `[reject]` (edge) A client timeout loses the default `request_id`, and a credential-less replay exits 0. A timeout to a loopback facade is unlikely, and `--request-id` exists for callers that retry. A replay is the original grant by the intent's definition.
  - `[maybe-false]` `[reject]` (edge) Hermes tools lose their env credentials after the switch to `employeeChildEnv`. Same as the blind Hermes row: `HERMES_HOME` is the profile with its own `.env`, and even if true it is low.
  - `[medium]` `[patch]` (edge) `docs/employee-access.md` claims "every inherited variable whose name looks like a credential" is dropped, which overstated the scrub. Patched under P1: the doc now lists the patterns and the URL-userinfo value rule. It states that this is a name and value heuristic, not an allowlist, so a credential under a name that matches none of the patterns still reaches the child.
  - `[low]` `[reject]` (verification-gap) The 64 KiB body cap has no test. carried: same as the first-pass verification-gap row (oversize body).
  - `[low]` `[reject]` (verification-gap, other) `request.destroy()` makes the over-limit 500 undeliverable. carried with the oversize-body rows.
  - `[false]` `[reject]` (verification-gap, other) `serialized` is redundant and concurrency is untested. No bad outcome: `decide` is synchronous, so identical concurrent requests cannot interleave, as the finding itself concedes. `serialized` only guards a future `await`.
  - `[false]` `[reject]` (intent) The Access edge is simulated, and the issuer is http in tests. carried: same as the first-pass intent row (only the verifier is proven at the edge).
  - `[false]` `[reject]` (intent) Only the specialist Hermes path changed. `flume launch` is the specialist launcher (`index.ts` → `launchSpecialist`), and the Code Map names exactly that function. Deployed post-holders run under systemd units, not `flume launch`.
  - `[medium]` `[patch]` (intent) The scrub is a heuristic checked against chosen names: `AWS_ACCESS_KEY_ID`, `DB_PASS`, `*_CREDENTIALS`, `GITHUB_PAT` and `SSH_AUTH_SOCK` pass. Same root cause as the blind scrub row; P1. `AWS_ACCESS_KEY_ID` is an identifier, not a secret; its paired `AWS_SECRET_ACCESS_KEY` was already dropped.
  - `[false]` `[reject]` (intent) A child of A can run `flume access run B`. The child's env has no `OP_*`, so the launcher's `op read` of B's credential fails and it refuses. A desktop `op` session under the same UID is the shared-UID limit that the docs state.
  - `[low]` `[reject]` (intent) The facade accepts handle or subject, while the launcher accepts a registry id. carried: same as the first-pass `--employee bob-pm` row.
  - `[false]` `[reject]` (intent) The secret scan does not cover launcher or child output. AC3 scopes the scan to audit, idempotency, ledger and facade output, and all four are scanned. The child env is checked separately, by name and by value, in the launch groups.
  - `[false]` `[reject]` (intent) Behaviour goes beyond the intent's literal text: grants reload, `ambiguous-client`, manual redirects, the body cap. This is descriptive only and names no harm. Each item was already triaged in the first pass.
  - `[low]` `[reject]` (intent) A member-token-only `flume launch` is no longer exercised, and the gateway read comes first. carried: same as first-pass blind row 8 and the gateway-read edge row.

## Design Notes

Replay does not re-disclose the fixture credential: the idempotency record persists only the secret-free result, so the replay returns the original grant identity and expiry with `credential` omitted (`credential_redelivered: false`). Storing the value to replay it would violate the no-token-at-rest rule.

The test's fake edge stands in for Cloudflare. It validates `CF-Access-Client-Id/Secret`, mints the RS256 assertion (`sub: ""`, `common_name: <client id>`, `type: "app"`) and serves JWKS at `<issuer>/cdn-cgi/access/certs`. The product code is unchanged between fixture and live; only the issuer differs.

Bindings are hand-authored in this story, as in FLUME-47. For a specialist, `flume onboard --employee` refreshes `contract.yaml` afterwards. A `bind` command and the live canary (real Access app/policy, service tokens, launcher key item, a Hermes tool that consumes the env) remain pending.

## Verification

**Commands:**
- `git diff --check` -- expected: no output.
- `node scripts/run-tests.mjs employee-access` -- expected: typecheck+build ok, suite PASS.
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access specialist-hire` -- expected: all PASS.

## Auto Run Result

Status: done. This is the local spec only. Plane FLUME-48 stays with the supervising session, and nothing is merged to main (per `execution.md`). **Live Access proof is still pending:** every grant is `evidence: "fixture"`, and `flume identity readiness` reports `access_assertion_policy` as `unproven`.

**Summary.** This was a follow-up review pass on the `done` FLUME-48 implementation. The original change is commit f5c21c0, hardened in 230a29c2919ed2c1532b742620ce534a849e4c73. It adds:
- `flume access serve`: a Cloudflare Access assertion and a launcher-signed run, mapped through the `cloudflare_access` binding, with operator grants and fixture issue only;
- `flume access run`, and `flume launch` sharing the same trusted-launcher contract;
- the plain client `flume access request`.

This pass hardened the child-env scrub. Two operator credentials in the live shell, `NOTION_API_KEY_RR` and `POSTGRES_URL` (which embeds a password), were reaching employee children past the first pass's suffix patterns. They are now dropped. The docs no longer overclaim what the scrub does.

**Files changed in this pass.**
- `packages/flume-hr/src/workforce/launcher.ts`: the scrub patterns gain `PASSPHRASE`, `_PASS`, `APIKEY`, `CREDENTIAL(S)`, `_PAT`, `_DSN` and one trailing `_<suffix>`. It also drops `SSH_AUTH_SOCK` and any value that embeds a password in a URL.
- `tests/employee-access-regressions.mjs`: six more planted operator credentials and two more harmless names, asserted in both launched children. The facade start timer is now `.unref()`'d.
- `docs/employee-access.md`: the scrub paragraph lists the actual rules and says it is a heuristic, not an allowlist.

The full change since baseline cf0442509c76fcb4bad8a78e953c5ba6b5d214f2 is otherwise as recorded in the first pass: the contract schema, `access.ts`, `launcher.ts`, the `specialist.ts` launch path, validator, readiness, CLI, `jose` dependency, the suites, docs and `AGENTS.md`/`README.md`.

**Review findings (this pass).** 34 findings from 4 layers: high 0, medium 4, low 21, false 6, maybe-false 3.
- **Patches applied: 2 entries.**
  - P1, medium: the scrub gaps and the docs overclaim. This covers the blind, edge, edge-docs and intent rows.
  - P2, low: the unreleased facade start timer in the suite.
  - Patched counts by verdict: high 0, medium 1, low 1.
- **Deferred:** none. The `deferred` list is unchanged.
- **Rejected:** every other finding, with its reason in the 2026-10-12 follow-up rows of the Review Triage Log. In brief:
  - 16 rows were carried from the first pass with their original reject.
  - New lows were rejected as either spec-defined behaviour (persisted `approval_required`, max default lifetime, `employee` in the hash) or unlikely and needing new branches (reload mid-save, issuer trailing slash, IPv6 URL, client-timeout id, keygen tee).
  - The three maybe-false findings would be low even if true: Hermes tool credentials come from `HERMES_HOME/.env`, and `readLimited` on an aborted request.
  - The six false findings were refuted at their locations.

**Follow-up review recommended: false.** This is a follow-up pass and it patched no high, so the work has converged.

**Verification performed (2026-10-12).**
- `git diff --check`: no output for code. The only complaint was a blank line at EOF in this spec, which is removed in this rewrite.
- `node scripts/run-tests.mjs employee-access`: typecheck ok, build ok, suite PASS (7.2s).
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access specialist-hire`: typecheck ok, build ok, 7/7 suites PASS.
- Mutation check: removing the URL-userinfo value check from `employeeChildEnv` makes `employee-access-regressions` FAIL. The change was restored before the final run.
- Live read-only check: `zsh -ic env` names were run through the old and new patterns. Only `NOTION_API_KEY_RR` and `POSTGRES_URL` escaped the old ones; the new ones drop both. `XAUTHORITY` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` survive.

**Residual risks.**
- The scrub is still a name and value heuristic. A credential exported under a name that matches none of the patterns (a bare `GITHUB`, a vendor-specific name) still reaches the child. So does any non-env route under the same UID: a desktop `op` session, or `~/.config` files. An env allowlist, or a sandbox per employee, is a design decision for a later story.
- Pending live proof, unchanged:
  - a real Access application, policy and AUD;
  - a service token per employee;
  - the launcher Ed25519 key vault item;
  - a Hermes tool that consumes the env;
  - a `bind` command.
- `flume launch` still reads the FLUME-39 gateway member token before the enrollment refusal. Both real specialists already fail launch at that step today.
