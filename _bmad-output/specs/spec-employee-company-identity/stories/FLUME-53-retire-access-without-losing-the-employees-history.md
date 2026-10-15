---
title: 'FLUME-53 — Retire access without losing the employee''s history'
type: 'feature'
created: '2026-10-14'
status: 'done'
baseline_revision: '3169190f91400be100a83b81e9042e1b6975db85'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/epics.md'
  - '{project-root}/docs/employee-access.md'
  - '{project-root}/docs/identity-provisioning.md'
  - '/home/delorenj/code/33GOD/agents-facade/src/index.ts'
  - '/home/delorenj/docker/stacks/ai/newapi/ops/gateway-tokens.py'
warnings: [oversized]
deferred:
  - summary: >-
      `flume identity status <employee> retired` writes no tombstone, so after `flume offboard` the handle, email, subject and bindings can be reissued.
    evidence: |-
      Only `flume identity retire` (lifecycle.ts suspendOrRetire) records a tombstone. The status command is the pre-existing FLUME-47 path,
      and FLUME-53's intent forbids changing `flume identity status`. Fix in a follow-up: have the status transition to `retired`
      record the tombstone, or refuse it and point at `flume identity retire`.
    location: >-
      packages/flume-hr/src/workforce/company.ts setEmployeeStatus
    severity: medium
  - summary: >-
      The AGENTS.md and README command lines say "retire adds … --revoke all", which can read as if retire revokes provider access by default.
    evidence: |-
      Retire revokes only the adapters named with `--revoke` (or all three with `--revoke all`); without them Access, GitHub and the
      gateway stay usable and are reported `manual-action-required`. The fix edits an agent-context file (AGENTS.md), so it is deferred.
    location: >-
      AGENTS.md, README.md (identity suspend|retire line)
    severity: low
---

<intent-contract>

## Intent

**Problem:** An employee can be marked `suspended` or `retired` only as a local status (`flume identity status`, FLUME-47). Nothing closes their mailbox, revokes or reports their live provider credentials, rotates a key while keeping who they are, or proves afterwards that history still points at the same person. There is also no mail-read authorization at the facade: the agents-facade Worker's `POST /v1/mail/messages` (`agents-facade/src/index.ts:85-167`, already deployed by the supervisor) calls the origin's `POST /v1/mail/authorize`, which today answers 404.

**Approach:** Add a lifecycle coordinator, `workforce/lifecycle.ts`, with injectable provider adapters for mail, cloudflare_access, github, plane and gateway. It is exposed as `flume identity suspend|restore|retire|credentials|rotate|continuity`. Its operations are previewed by default, converge on retry, and say honestly what is still usable. Add the facade's `/v1/mail/authorize` route, a plain `flume mail list|read` client, and a read-only `flume access receipts` that joins request, mail, denial and lifecycle rows by correlation fields.

## Boundaries & Constraints

**Always:**

Previews, flags and order:
- Every command is a preview unless `--apply`. A preview writes nothing anywhere: no definition, no state or ledger file, and no provider mutation. Reads are allowed: Cloudflare and GitHub GETs, `px identity verify`, and `gateway-tokens status`.
- A blocker exits 1 with `blockers[]` before any provider call.
- Suspend runs these steps in order:
  1. Local status, first, through `setEmployeeStatus`.
  2. The mail allowlist step: the KV key `allowlist/<address>` is read, its record is captured into the lifecycle state, then the key is DELETEd and verified absent by a GET that returns 404.
  3. Only the adapters named with `--revoke <cloudflare_access|github|gateway>`, in that order.
- Retire is the same, with three differences: the status becomes `retired`; the employee's own literal routing rule is also disabled (PUT `enabled:false`, verified by GET); and `--revoke all` expands to all three revocable adapters.
- `--revoke plane`, `--revoke mail`, an unknown adapter name, or `all` on suspend is `invalid-request`.
- Restore runs only from `suspended` to `active`:
  - It re-PUTs the exact captured KV record and verifies it by GET.
  - It un-suspends a GitHub installation only if this lifecycle suspended it (DELETE `…/suspended`, then a GET showing `suspended_at: null`).
  - It sets local status `active` **last**.
  - A `retired` employee gets `retired-terminal`. An `active` employee gets `not-suspended`.

Convergence state:
- Every `--apply` of suspend, restore or retire has an `operation_id` (UUID).
- State lives in `<identityStateDir()>/lifecycle-state.json` and `lifecycle-ledger.jsonl`. The directory is mode 0700 and the files are 0600. Both are secret-free.
- Each provider-mutating step has a resource-scoped key, for example `cloudflare_access:token-delete:<client_id>`.
- A key recorded `done` or `converged` is never executed again, even by a later operation in the same suspension episode. It reports `already-done` with its original `operation_id`. Restore clears the keys of the steps it reverses.
- An `unresolved` step is re-attempted by the next run of the command.
- A 404 on DELETE, an already-suspended installation, or `revoked 0 tokens` counts as `converged`.
- An apply holds `withRegistryLock(<state dir>/lifecycle-state.json, …)`. It must never nest the registry lock: `flock` is not re-entrant, and `setEmployeeStatus` takes the registry lock itself.

Credential rows:
- Every row has these fields:
  - `provider`
  - `kind`
  - `ref` or `id` (never a value)
  - `static` (a bool)
  - `status`, one of `revoked`, `suspended-reversible`, `residual-expiry`, `static-usable`, `manual-action-required`, `unverified`, `unresolved` or `not-issued`
  - `expires_at`, when the provider states one
  - `provider_code`, on `unresolved` or `unverified` rows
  - `evidence`, which is `provider` or `fixture`
  - `next_action`, the exact command or route
- `complete_revocation` is true only when every row is `revoked` or `not-issued`. Otherwise the result lists `incomplete[]`, and the text output says `revocation INCOMPLETE`.
- A static credential becomes `revoked` only when the provider has read back its rejection:
  - a GitHub app-JWT `GET /app` answering 401;
  - px `credential_rejected`;
  - `gateway-tokens status` returning `tokens: []`.
- On retire, a row that would be `static-usable` is reported as `manual-action-required` instead.

What each adapter reads and reports (see the matrix for statuses):
- **mail:** the KV key, and the employee's own literal rule that points at `mailbox.worker`. It never touches a foreign rule. Stored mail is kept: `history.mailbox_prefix` is `mail/<handle>/`. Flume has no R2 client.
- **cloudflare_access:** pages through `GET /accounts/{acct}/access/service_tokens` and matches the token on `client_id === binding.principal`. Without `--revoke` it reports `static-usable` with the token's `expires_at`. `--revoke` sends DELETE `…/service_tokens/{id}` and verifies by listing again.
- **github:** reports three kinds of row:
  - the App private key: static, probed with app-JWT `GET /app`;
  - the installation: `GET /app/installations/{id}`;
  - the unexpired issued tokens: `issued` lines in `provider-ledger.jsonl` for this subject and installation, reported `residual-expiry` with `expires_at`. Lines for `revoke-failed`, and `ambiguous` lines from the last hour, are reported `unverified` with a residual of at + 3600s.

  `--revoke` sends PUT `/app/installations/{id}/suspended` and verifies by GET `suspended_at`. Issued tokens under a suspended installation are `suspended-reversible`. With no binding, the row is `not-issued`.
- **plane:** `verifyBoardViaPx`, using the first board from the subject's latest `plane.adopt` receipt for the current binding. With no such board the row is `unverified` with `no-verified-board`. Revocation is manual: `PLANE_CREDENTIAL_SEMANTICS.revocation`.
- **gateway:**
  - The consumer is the last segment of the desk's `secrets.onepassword.env.AUTOMATICAI_GATEWAY_KEY`, and only for the FLUME-39 shape `op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/<consumer>` (`scripts/gateway-member-tokens.py:42`). Any other shape is `unverified` with `gateway-ref-shape`. A consumer is never inferred from a name.
  - The desk is `<HERMES_FLEET_HOME||$HOME/.hermes>/profiles/<profile>/config.delta.yaml`. For a post, the profile is the registry `profile_name`, falling back to the post id. For a specialist, it is the desk directory name.
  - Run `${FLUME_GATEWAY_TOKENS_BIN:-$HOME/docker/stacks/ai/newapi/ops/gateway-tokens.py} status|revoke <consumer>` with spawnSync, no shell and a timeout.
  - Copy only these fields from status: `id`, `name`, `status` and `expired_time`.
  - A consumer that is shared fails `--revoke gateway` as the blocker `shared-consumer`. Shared means the desk ref equals the fleet base `config.yaml` ref, or another census definition's desk maps the same consumer.
  - Every gateway row and result carries this link:
    - `owner_ticket: "FLUME-39"`
    - `evidence_path`, from `FLUME_GATEWAY_EVIDENCE`, defaulting to `<flume root>/_bmad-output/implementation-artifacts/FLUME-39`
    - `evidence_status`: `present` only if that path exists, otherwise `unverified`. It is `unverified` today.

Endpoints, evidence and gates:
- Base URLs are taken from `FLUME_CLOUDFLARE_API_BASE`, `FLUME_GITHUB_API_BASE`, `FLUME_PX_BIN` and `FLUME_GATEWAY_TOKENS_BIN`.
- `evidence` is `fixture` whenever an override points away from the official endpoint, or names a stand-in binary.
- Reuse the Cloudflare and vault helpers in `provision.ts` by exporting them. Do not copy them.
- An unenrolled employee, or an unreadable or symlinked definition, is refused before any provider call.

Mail authorize, the mail client, rotation, tombstones and receipts:
- `POST /v1/mail/authorize` uses the same assertion, client mapping, run, body and fresh-status pipeline as `/v1/access/requests`. It reads the census on every request.
  - Its body is closed: `{operation: list|read, message_id?: 64-hex}`. `read` requires an id, and `list` forbids one.
  - A 200 returns `{ok:true, status:"authorized", handle, subject, run_id, harness, mailbox_prefix:"mail/<handle>/", operation}`.
  - The handle comes only from the verified machine identity.
  - Each request writes one audit line: `event:"mail.authorize"` with outcome, IDs, operation and message_id. It never holds mail content or codes.
- `flume mail list|read <id>` POSTs to `${FLUME_ACCESS_URL}/v1/mail/messages` with the launcher env, like `requestAccess`. It has no identity flag and no send path.
- Rotate changes `credential_ref` only:
  - It is for `cloudflare_access`, `github` and `plane`.
  - Principal, instance, `native_actor_id` and attribution are unchanged.
  - It appends a ledger line `identity.rotate` with the old and new refs.
  - It reports the previous ref as `manual-action-required`: revoke the old key at the provider.
- Retire records a tombstone in the state (`subject`, `handle`, `email` and binding keys). Enroll, bind, status and restore consult it, so the retired identity survives `flume offboard` removing the registry row.
- `flume access receipts` emits a field whitelist only. It never echoes a raw line.

**Never:**
- No live lifecycle `--apply`, rotate, retire or revoke against real employees (grolf, rererere), real Cloudflare, GitHub, Plane, the gateway or the vault. Production offboarding or revocation is not authorized here.
- Fixtures never inherit a real HOME, `op` session or binary.
- Do not restart `flume-access.service`, edit agents-facade, deploy the Worker, or write live definitions. The supervisor runs the live canary after landing.
- No gateway minting or rotation: that is FLUME-39 / `gateway-tokens.py rotate`. Rotate for `gateway` is the blocker `rotation-owned-elsewhere`.
- No Plane client and no px write verb.
- No deletion of stored mail, bindings or definitions.
- No change to `flume offboard`, `flume identity status`, the FLUME-50/51/52 semantics, or `launchSpecialist`'s gateway reference.
- Never mark a static key `revoked` because a local status or grant TTL changed.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Suspend preview | active canary with mail, Access, github, plane and a FLUME-39 desk ref; `identity suspend e` | Planned steps plus inventory rows. Nothing is written and no provider is mutated. | — |
| Suspend apply | `--apply` | Status `suspended` is written first. The KV key is deleted and the GET readback is 404 (`done`). The record is captured. Rows: mail `suspended-reversible`; Access `static-usable` with `expires_at`; App key `static-usable`; installation `static-usable`; issued tokens `residual-expiry`; plane `static-usable`; gateway `static-usable` (`expired_time` -1) or `residual-expiry`. `complete_revocation:false`, plus `operation_id` and ledger lines. | — |
| Facade after suspend | the same run assertion as before the suspend | The access request is 403 `employee-suspended`, and so is mail authorize. `flume access run` refuses a new run. | An audit line each; no grant. |
| Restore | suspended; `restore --apply` | The KV record is re-PUT (identical by GET). The installation is un-suspended only if this lifecycle suspended it. Status `active` is written last. Grants and mail authorize succeed again. | `not-suspended` or `retired-terminal`; 0 provider calls. |
| Named revoke | `suspend --revoke github --revoke cloudflare_access --revoke gateway --apply` | PUT suspended, then GET shows `suspended_at`. DELETE the token, and the list readback shows it absent. Gateway revoke, then status shows `tokens:[]`. Rows: installation and tokens `suspended-reversible`; Access `revoked`; gateway `revoked`. | A 404, an already-suspended installation, or `revoked 0` counts as `converged`. |
| Bad revoke | `--revoke plane`, `mail`, `bogus`, or `all` on suspend; shared consumer with `--revoke gateway` | `invalid-request` / `shared-consumer`. | 0 calls; nothing written. |
| Outage | `retire --revoke all --apply` while the Cloudflare DELETE answers 500 | `succeeded`: local-status, mail allowlist, routing disable, github, gateway. `unresolved`: `cloudflare_access` with `provider_code` `http-500`. | Exit 1; `complete_revocation:false`. |
| Retry | the same command after the fake heals | Only the Cloudflare DELETE runs. Across both runs the fake counts exactly one each of: KV DELETE, routing PUT, GitHub PUT, gateway revoke. A delete committed behind a 500 then answers 404 on retry: `converged`. | — |
| Static honesty | App key, plane PAT, gateway `expired_time` -1 | Never `revoked` unless the provider reads back the rejection. With GET /app 401, px `credential_rejected`, or `tokens:[]` the row is `revoked`. On retire, the rest are `manual-action-required` with the provider's route. | — |
| Degraded rows | no github binding; no provisioning config; px missing; bad gateway ref shape; ambiguous ledger line | `not-issued`; `unverified` with `provisioning-config-unavailable` (and the mail step `unresolved`); `unresolved` with `provider-unavailable`; `unverified` with `gateway-ref-shape`; `unverified` with a residual `expires_at`. | Exit 1 only when an apply step stays unresolved. |
| Credentials | `identity credentials e` | Read-only rows plus `complete_revocation`; zero writes. | `not-enrolled` |
| Tombstone | retire, then `flume offboard <post> --apply`, then enroll another post with `--handle <retired>`; a hand-copied block carrying the retired subject; status or restore back to active; another employee binding the retired principal | `handle-tombstoned` / `subject-tombstoned` / `retired-terminal` / `binding-tombstoned`. | Nothing written; other definitions are byte-identical. |
| Rotate | `rotate e github --credential-ref <new> --apply` | Only `credential_ref` changes. Ledger `identity.rotate`. The previous ref is `manual-action-required`. `verification.next_action`: github `access github-inspect`; plane `adopt-actor … --board`. | A differing `--principal`/`--instance` is `rotation-changes-principal`. The same ref is a no-op. A ref held elsewhere is `credential-ref-duplicate`. Also `rotation-owned-elsewhere`, `retired-terminal` and `invalid-credential-ref`. |
| Continuity | `continuity e --record`, then a rotation, then a post move | `stable`: the same subject, handle, email, principal and `native_actor_id`, and the same `mailbox_prefix`. Diffs are reported as `rotated` / `moved`. `--comment e:<uuid>` reports `stable` from the `plane.verify-comments` receipts, or `not-recorded`. | Handle, email, principal or actor drift is `broken`, exit 1. |
| Mail authorize | valid run, active; `{operation:"list"}` or `{operation:"read", message_id}` | 200 with the authorized body, and an audit line `mail.authorize`. | 400 `invalid-request` for an extra field, list with an id, read without an id, or a non-hex id. 403 `employee-<status>`. 401/403 on the same assertion failures as access. |
| Mail client | `access run ada -- flume mail list`, then `mail read <id>`, through an in-test Worker double | Only ada's messages. A process that was not launched gets an error naming the missing env. | No identity flag; `mail send` does not exist. |
| Receipts | a Hermes run and a plain run of ada, then a suspend; `access receipts --employee ada` / `--run <id>` / `--gateway-proof f` | One subject, two run_ids (hermes and plain). Request, mail, denial and lifecycle rows joined by subject, run_id and operation_id. `--run` adds that subject's lifecycle operations inside the run window. Gateway link: FLUME-39 evidence `unverified`. The proof is `verified` only if `verified:true` and every `token_name` starts with `aai:<consumer>:`. | Whitelisted fields only. |

</intent-contract>

## Code Map

- `packages/flume-hr/src/workforce/company.ts`:
  - `:151` `conflicts`, `:286` `enrollEmployee`, `:315` `setEmployeeStatus` (`retired-terminal` at :325) and `:341` `bindEmployeeProvider`. Add the tombstone blockers here.
  - `:254` `writeDefinition` is internal, so rotate lives in this file.
  - `:68` `registryRows` is internal. Export a desk-profile helper for the gateway adapter.
  - `:33` `PROVIDER_REVOCATION_NOTE`: point it at `identity suspend|retire`.
- `packages/flume-hr/src/workforce/access.ts`:
  - `:90-115` `AccessState`. `audit` hard-codes `event:"access.request"`, but a spread can override it.
  - `:169` `finish`, `:175` `authenticate`, `:188` `verifyRun`.
  - `:281-323` `handle`: the census is read per request (:287), the status check is at :308. Factor this pipeline out for mail.
  - `:341-365` the server rejects any path except :352.
  - `:374` `requestAccess` is the client pattern to copy for `flume mail`.
  - `:59` `accessStateDir` holds `audit.jsonl`, `fixture-ledger.jsonl` and `provider-ledger.jsonl` (:104).
- `packages/flume-hr/src/workforce/provision.ts`. Export these and reuse them:
  - `:72` `op`, `:78` `opRead`, `:139` `cfRequest`, `:153` `cfOk`, `:157` `cfError`, `:162` `CfServiceToken`, `CfRoutingRule`.
  - `:173`/`:204` the token list and delete paths. `:216-243` the rules list and KV key and put; the KV record is `{handle, subject, provisioned_at}`.
  - `:41` `provisioningConfigPath`, `:50` `loadProvisioningConfig`.
- `packages/flume-hr/src/workforce/github.ts`:
  - Use `:33` `githubApiBase`, `:42` `githubEvidence`, `:95` `githubBindingOf` and `:115` `transport`, plus the error helpers `:130` `statusOf` and `:136` `firstLine`.
  - The app JWT is built through `createAppAuth` (:187).
  - Add the installation read, suspend and unsuspend calls, and the key probe (`GET /app`), here.
- `packages/flume-hr/src/workforce/plane.ts`:
  - `:40` `PLANE_CREDENTIAL_SEMANTICS`, `:94` `planeBindingOf`, `:109` `planeEvidence`, `:130` `runPx`.
  - `:177` `verifyBoardViaPx`: `credential_rejected` comes back as the blocker `provider-refused` with that `provider_code`.
  - `:222` `identityStateDir`, `:236` `readPlaneReceipts`. The receipt shapes are `plane.adopt` at `company.ts:539-542` and `plane.verify-comments` at `plane.ts:368-371`.
- `packages/flume-hr/src/workforce/launcher.ts:48-66`: `employeeAccessEnv` refuses a non-active employee (:53). Harness `plain` is at :71. `specialist.ts:222-249` `launchSpecialist` is harness `hermes`.
  - It reads the gateway key from a hard-coded `op://DeLoSecrets/hermes-<e>/credential` (:237). That is read-only here; do not change it, and report the mismatch as a residual risk.
- `packages/flume-hr/src/workforce/role.ts:87` `withRegistryLock(path)`: a flock on `path + ".lock"`. It is generic and not re-entrant.
- `packages/flume-hr/src/workforce/readiness.ts:18` `UNPROVEN`. Its key list is asserted at `tests/company-identity-regressions.mjs:474`.
- `packages/flume-hr/src/workforce/validator.ts:21-30` and `contracts/employee-access.schema.json` `$defs`: add `mail_request` (closed) and `mailRequestProblems`.
- `packages/flume-hr/src/index.ts`:
  - `:215` `identityResult`, `:224` `formatIdentityResult`.
  - The identity commands are at `:251-353`, the access group at `:364-450`, `serve` at :370 (its description) and `request` at :400.
  - Use the `guardBrokenPipe`/`writeStdout`/`exitAfterFlush` pattern.
- `packages/flume-hr/src/hire/offboard.ts`: removes the registry row only. Read-only here; it is why tombstones need the state copy.
- Read-only consumers of these contracts:
  - `agents-facade/src/index.ts:71,106-123`: needs 200 `status:"authorized"` and `handle` matching `^[a-z0-9][a-z0-9_-]{0,57}$`. It passes any other answer through.
  - `gateway-tokens.py:86` status JSON `{consumer, tokens:[{id,name,status,group,expired_time,model_limits}]}`. Its `revoke` at :92-96 DELETEs, verifies, prints `<c>: revoked N tokens` and exits 0. Errors exit 1 with `token operation failed: …` on stderr. There is no `--json`.
  - `gateway-proof.py check` returns `{status, verified, receipts:[{token_name, request_id, session_id, created_at,…}]}` and writes no file.
- Tests to copy patterns from:
  - `tests/employee-access-regressions.mjs`: `:56-94` fakeEdge, `:96` runJwt, `:110-123` fake op and hermes, `:135-144` baseEnv (`FLUME_ACCESS_CONFIG`/`STATE`), `:147` runAsync (use it for every edge or launcher call), `:207-220` startFacade, `:234` viaEdge, `:413-430` the suspend denial, `:582-603` the secret scan.
  - `tests/employee-access-github-regressions.mjs:71-190`: the fake GitHub. It verifies the JWT at :107-126, and `match()` at :128 handles only GET, POST and DELETE, so add PUT plus the `/suspended` routes.
  - `tests/identity-provision-regressions.mjs`: `:39-93` the stateful fake op, `:95-139` the fake Cloudflare (no KV DELETE or rule PUT yet), `:148-153` the env.
  - `tests/company-identity-plane-regressions.mjs:36-121`: the fake px through `FLUME_PX_BIN` (it has a `credential_rejected` mode).
  - `tests/company-identity-regressions.mjs`: `:29-62` `fixture()`, `:64` `specialistFixture()`, `:258` `blocked()`.
  - `scripts/run-tests.mjs:51-84` `SUITES`, matched by substring.
- Dependencies, checked 2026-10-14:
  - PX-13 is **Done**.
  - FLUME-39 is **Backlog**, and no FLUME-39 evidence file exists anywhere. So the gateway link is `unverified`. That blocks full live AC4, not this fixture build.
  - FLUME-47..52 and 56 are landed.

## Tasks & Acceptance

**Execution:**
- `packages/flume-hr/src/workforce/provision.ts`: export the Cloudflare and vault helpers listed in the Code Map, with no behavior change. One helper owner.
- `packages/flume-hr/src/workforce/github.ts`: the installation read, suspend and unsuspend calls and the app-key probe, through `transport` and the app JWT. One GitHub transport.
- `packages/flume-hr/src/workforce/lifecycle.ts` (new) is the coordinator:
  - The step and operation model, the state and ledger files and the state lock.
  - suspend, restore, retire, credentials and continuity, and the tombstone read and write.
  - `complete_revocation` and `incomplete[]`.
  - The adapter interface, injectable as `options.adapters`, and `formatLifecycleResult`.
- `packages/flume-hr/src/workforce/lifecycle-adapters.ts` (new): the mail, cloudflare_access, github, plane and gateway adapters, following the Always rules. These are the providers' honest semantics in one place.
- `packages/flume-hr/src/workforce/company.ts`:
  - `rotateEmployeeCredential`;
  - the tombstone blockers in enroll, bind and status;
  - an exported desk-profile helper;
  - the updated note.
- `packages/flume-hr/src/workforce/access.ts`, `contracts/employee-access.schema.json`, `validator.ts`:
  - `MAIL_AUTHORIZE_PATH` through the shared pipeline;
  - `mail_request` validation;
  - the `mail.authorize` audit line;
  - the `requestMail` client;
  - the `serve` description.
- `packages/flume-hr/src/workforce/receipts.ts` (new):
  - `accessReceipts({run|employee, since, gatewayProof})` reads `audit`, `fixture-ledger`, `provider-ledger`, `lifecycle-ledger` and `plane-verifications`, and emits whitelisted rows.
  - It also builds `runs[]`, `operations[]` and the gateway link.
- `packages/flume-hr/src/workforce/readiness.ts` and `tests/company-identity-regressions.mjs:474`: add `employee_lifecycle_canary`. It stays unproven until the supervisor's live canary.
- `packages/flume-hr/src/workforce/index.ts`, `packages/flume-hr/src/index.ts`:
  - exports;
  - `identity suspend|restore|retire|credentials|rotate|continuity` (`--revoke` is repeatable; `--comment` is repeatable; `--record`, `--principal`, `--instance`);
  - `access receipts`;
  - `mail list|read`;
  - help text.
- `tests/company-identity-lifecycle-regressions.mjs` (new): a built-CLI suite with stateful fakes and argv call logs:
  - The fakes are Cloudflare (tokens, KV with DELETE, rules with PUT, fault modes `500`, `500-after-delete`), GitHub (JWT verify, `GET /app` with a 401 mode, installation GET/PUT/DELETE `suspended`), px, a gateway-tokens bin (status, revoke, an exit-1 mode) and op.
  - Cover every matrix row except Mail, Receipts and Facade, with exact call counts.
  - Cover preview purity (a tree snapshot, plus 0 mutating calls) and unrelated definitions staying byte-identical.
- `tests/employee-access-lifecycle-regressions.mjs` (new): the fake edge, the facade, and an in-test Worker double mirroring `agents-facade/src/index.ts:85-167` over an in-memory mailbox. It also uses fake hermes, op and Cloudflare.
  - Cover the Facade, Restore, Mail and Receipts rows.
  - For the denial, the same run assertion is used before and after the suspend.
  - Each `access receipts` mode runs, including the gateway-proof match and mismatch.
- Both suites, plus `scripts/run-tests.mjs`:
  - Register both suites.
  - Secret-scan every state file, ledger, receipt, definition, stdout and stderr for the planted values (Cloudflare token, client secrets, PEMs, PATs, `sk-` gateway keys, JWTs, run assertions).
  - Mutation-check three guards: remove the done-step guard, the facade mail status check, and the static-key `revoked` rule. Confirm the suite fails each time, then restore the guard.
- Docs:
  - `docs/employee-access.md`: a new section "Suspension, rotation and retirement (FLUME-53)". It covers what each provider can and cannot revoke, the residual windows (the Access token until its `expires_at`; installation tokens ≤1h; Plane PAT expiry not observable; gateway `-1` meaning no expiry; run assertions 12h but status-gated), the mail authorize contract and its deploy-first order, receipts, and the FLUME-39 link.
  - `docs/identity-provisioning.md:58`: point it at that section.
  - `AGENTS.md` and `README.md`: add the commands.
- `_bmad-output/implementation-artifacts/FLUME-53/live-canary-procedure.md`: **SUPERVISOR-OWNED**. Write the Rererere sandbox canary steps and its gates only. Execute nothing live.

**Acceptance Criteria:**
- **AC1, suspension.** Given a fixture canary with mail, Access, GitHub and Plane bindings and a FLUME-39-shaped desk gateway ref, when `flume identity suspend <e> --apply --json` runs:
  - the facade denies the next access request and the next mail authorize carrying the same run assertion, both with `employee-suspended`;
  - `flume access run` refuses a new run;
  - every credential row reports its provider status, residual `expires_at` or manual route;
  - `complete_revocation` is false.
- **AC2, convergence.** Given `retire --revoke all` with one provider failing, when it is run and then re-run after the provider heals:
  - the succeeded steps are recorded apart from the unresolved ones;
  - the fakes count no duplicate mutation;
  - the result never says complete while a static key is usable or unverified.
- **AC3, continuity.** Given a rotation and a post move, when `flume identity continuity` runs:
  - the subject, handle, email, principal, `native_actor_id`, mailbox prefix and Plane comment provenance are stable;
  - the retired handle, email and subject are refused to any other employee, even after `flume offboard`;
  - no unrelated definition changes.
- **AC4, cross-harness receipts.** Given a fixture Hermes run and a plain run of the same employee that request access and list mail before a suspend, when `flume access receipts --employee <e> --json` runs:
  - it shows one subject, two run_ids and harnesses, the grants, the mail authorizations, the denials and the lifecycle operation, joined by correlation fields;
  - gateway attribution links the FLUME-39 evidence (`unverified` while absent), never a generated config;
  - no output or state file contains a secret.
- **AC5, live canary.** Given the build is on Flume main, when the supervisor runs the live canary procedure, then either its receipts carry `evidence:"provider"`, or the file records the exact blocker and the story is not reported fully accepted.

## Spec Change Log

## Review Triage Log

### 2026-10-15 — Review pass
- verdicts: 62 findings — high 0, medium 20, low 32, false 10, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) Restore never clears done keys for Access/gateway deletions, so after a FLUME-39 re-mint a later `suspend --revoke gateway` reports already-done — fixed: a suspend/retire of an `active` employee starts a new episode and drops the subject's step records and captures (lifecycle.ts assess); test re-revokes a re-minted token.
  - `[low]` `[reject]` (blind) `continuity` exits 0 when a comment is `not-recorded` — the matrix defines `not-recorded` as a reported status, not a failure; changing it changes the specified semantics.
  - `[low]` `[reject]` (blind) No way to re-baseline an intentional identity change — the intent defines principal/handle drift as `broken`; an accept path is new public surface.
  - `[medium]` `[patch]` (blind) Most fault modes in the fixtures are unused (restore KV PUT failure, routing PUT, GitHub put, concurrency) — fixed with the restore fail-closed, read-back no-op and concurrent-apply tests (same root as the verification-gap rows).
  - `[low]` `[reject]` (blind) Mail path tested against a hand-written Worker double — the intent mandates the in-test double and forbids editing agents-facade; the real Worker is gate G0 of the live canary.
  - `[false]` `[reject]` (blind) `handleMail` validates the body before status — the spec requires the same pipeline order as `/v1/access/requests` (body, then status); a 400 still counts as a denial in receipts (kind by `http_status >= 400`), and the Worker validates the body before forwarding.
  - `[low]` `[reject]` (blind) Tombstones live in one runtime file — the intent places them in the lifecycle state; a corrupt file throws by design (fail closed); a durable mirror would change the design.
  - `[low]` `[reject]` (blind) `rotate --apply` never probes the new ref — the intent says rotate changes `credential_ref` only and names verification as `next_action`.
  - `[low]` `[defer]` (blind) AGENTS.md/README wording "retire adds … --revoke all" can read as implicit revocation — fix edits an agent-context file; deferred.
  - `[medium]` `[patch]` (blind) Live canary procedure cannot prove G1 (same run assertion), G2 (no pre-suspend capture), and its retire step uses an unprovisioned employee — fixed: FIFO-held launched child, KV GET before/after with JSON compare, rotate `--apply` note, disposable provisioned and bound first.
  - `[low]` `[reject]` (blind) `evidence_status: present` flips on an empty directory — the intent defines `present` as "that path exists".
  - `[false]` `[reject]` (blind) Ambiguous token rows collapse without `grant_id` — every provider-ledger line carries `grant_id` from the issuer context (access.ts:268, github.ts:178).
  - `[low]` `[patch]` (blind) The App key is read from the vault on every lifecycle GitHub call — fixed: per-keyRef in-memory cache in `appSession` (github.ts).
  - `[low]` `[reject]` (blind) Inventory internal-error rows say `evidence: fixture` — only on rows already `unresolved`; per-adapter evidence plumbing is more than a direct correction and rarely met.
  - `[false]` `[reject]` (blind) audit/review/handbook/Bloodbank not wired — results already list `incomplete[]` with next actions, and rotate writes `credential_ref` through the same `writeDefinition` path as bind, which the handbook already projects (contracts/handbook.yaml:142); no named harm.
  - `[medium]` `[patch]` (edge) Done keys survive restore or out-of-band reactivation, so a re-minted/re-provisioned resource is skipped — same fix as the first blind row (new episode on `active`).
  - `[medium]` `[patch]` (edge) Restore with nothing captured (key already absent at suspend) is `unresolved no-captured-record` forever — fixed: 404 with a non-`done` suspend step converges; test restores an employee with no mailbox with zero KV PUTs.
  - `[medium]` `[patch]` (edge) Routing rules listed with one unpaged GET; a rule on page 2 reads as absent and the mail row as `revoked` — fixed: `listRules` pages (per_page 50); test puts ada's rule on page 2.
  - `[low]` `[patch]` (edge) `literalRule` takes the first literal match, so a foreign rule listed first hides the own one — fixed: prefer the match pointing at the mailbox worker.
  - `[low]` `[reject]` (edge) 40-page service-token cap — needs over 2000 tokens; the fix adds a branch.
  - `[medium]` `[patch]` (edge) `retire --revoke all` is refused outright for any desk without a FLUME-39 ref — fixed: only `shared-consumer` blocks (as specified); no-ref/bad-shape desks plan no gateway step and report the row; tests updated.
  - `[low]` `[reject]` (edge) A named `--revoke` for an adapter with no binding produces no step — the credential row reports `not-issued` with its next action; nothing exists to revoke.
  - `[low]` `[reject]` (edge) A 401 from clock skew marks the App key revoked — the intent defines app-JWT `GET /app` 401 as the rejection read-back.
  - `[low]` `[reject]` (edge) Continuity comment prefix is ignored — matching is by subject, so another employee's comment reports `not-recorded`; only a mislabelled prefix on this employee's own comment slips through; unlikely, fix adds a branch.
  - `[false]` `[reject]` (edge) A missing adopted actor reports `broken` instead of not-adopted — a `native-verified` receipt requires the adopted actor; losing it afterwards is drift, and `broken` is correct.
  - `[low]` `[patch]` (edge) A consumer starting with `-` would reach gateway-tokens.py as an option — fixed: `GATEWAY_REF` requires an alphanumeric first character.
  - `[low]` `[patch]` (edge) `gatewayBin` with `HOME` unset resolves relative to cwd — fixed: falls back to `os.homedir()`.
  - `[low]` `[reject]` (edge) `options.env` vs `process.env` for the Cloudflare base — the CLI always passes `process.env`; threading env through `cfRequest` is more than a direct correction.
  - `[low]` `[reject]` (edge) Null maps in a hand-corrupted state file throw a TypeError — needs a hand-edited state; validation adds branches.
  - `[medium]` `[defer]` (edge) `flume identity status <e> retired` writes no tombstone, so the identity is reissuable after `flume offboard` — pre-existing FLUME-47 path, and the intent forbids changing `flume identity status`; deferred.
  - `[low]` `[reject]` (edge) A crash between status `retired` and the tombstone write leaves no tombstone — millisecond window; re-running retire writes it; reordering adds failure modes.
  - `[low]` `[reject]` (edge) An installation un-suspended out of band inside the episode is reported `already-done` — the intent mandates done keys never re-run inside an episode, and the inventory row honestly shows the installation `static-usable`.
  - `[medium]` `[patch]` (edge, claim) `retire --revoke all` does not cover every employee — same fix as the gateway-blocker row.
  - `[medium]` `[defer]` (edge, claim) The tombstone covers only `identity retire`, not `identity status retired` — same root as the deferred status row.
  - `[low]` `[reject]` (edge, claim) Comment spec prefix not compared — same as the comment-prefix row.
  - `[medium]` `[patch]` (verification-gap) Restore's fail-closed rule is tested only on success — added: KV PUT 500 on restore keeps status `suspended` (`local-status:active` skipped), then heals.
  - `[medium]` `[patch]` (verification-gap) Read-back guards for KV delete, routing disable and GitHub suspend never fail — added `kvDelete`, `rulePut` and GitHub `put` no-op cases.
  - `[medium]` `[patch]` (verification-gap) Service-token pagination untested — added 60 tokens with ada's on page 2 (inventory and revoke).
  - `[medium]` `[patch]` (verification-gap) Plane comment `broken` branch and `--record` over a broken identity unasserted — added both.
  - `[medium]` `[patch]` (verification-gap) Rotation keeps the Plane `native_actor_id` and cloudflare_access rotation untested — added before/after compare, an applied cloudflare_access rotation and a non-`op://` refusal.
  - `[medium]` `[patch]` (verification-gap) The lifecycle lock is never exercised concurrently — added two concurrent applies: one KV DELETE and one token DELETE.
  - `[low]` `[patch]` (verification-gap) rotate/adopt-actor/provision ignore tombstones — fixed rotate (`subject-tombstoned`) with a test; adopt-actor and provision are pre-existing commands outside the intent's consult list (residual risk).
  - `[low]` `[patch]` (verification-gap) The `present` evidence branch never runs — added receipts with an existing `FLUME_GATEWAY_EVIDENCE` (present, linked).
  - `[low]` `[reject]` (verification-gap, other) Worker double vs real Worker — same as the blind Worker-double row.
  - `[false]` `[reject]` (intent) `continuity --record` needs `--apply` — the Always rule makes every command a preview unless `--apply`; the matrix input abbreviates.
  - `[medium]` `[patch]` (intent) Gateway no-ref/bad-shape blockers refuse `--revoke all` — same fix as the gateway-blocker row.
  - `[medium]` `[patch]` (intent) Convergence keys outlive the episode — same fix as the new-episode row.
  - `[low]` `[patch]` (intent) Restore results lack `gateway_link` — added to restore preview and apply results.
  - `[false]` `[reject]` (intent) Tombstone reads add a failure mode and change the status note — the Code Map directs the note change; a corrupt state failing closed is intended.
  - `[false]` `[reject]` (intent) `revoke-failed` residual uses the line's `expires_at`, not at + 3600s — the line records the token's own residual (github.ts:245), so the reported window is correct.
  - `[low]` `[reject]` (intent) `not-issued` rows carry no `ref`/`id` — nothing exists to reference.
  - `[medium]` `[patch]` (intent) Restore with nothing captured fails closed — same fix as the no-capture row.
  - `[false]` `[reject]` (intent) rotate appends the lifecycle ledger outside the lifecycle lock — one append-only line, no state-file write, no lost update.
  - `[false]` `[reject]` (intent) Specialist desk profile prefers the post's `profile_name` — a specialist's post is its own registry row whose `profile_name` is its definition id, which is also the desk directory name (specialist.ts:76,101).
  - `[false]` `[reject]` (intent) A `lifecycle.operation started` ledger line precedes the status write — the ledger is a local log; status is still the first mutation.
  - `[low]` `[patch]` (intent) Suspend of a hand-copied tombstoned subject previews ok and writes ledger lines before refusing — fixed: `retired-terminal` blocker in assess; test asserts no ledger growth.
  - `[low]` `[reject]` (intent) No in-process adapter-injection test — the spec calls for built-CLI suites; injection is an interface for later providers.
  - `[low]` `[reject]` (intent) Partial env injection — same as the `options.env` row.
  - `[medium]` `[patch]` (intent) Canary procedure gaps (G1, rotation preview, retire blocker) — same fix as the canary row.
  - `[low]` `[reject]` (intent) Worker double omits `entry.handle` check and 501 — the double only drives the origin contract; the real Worker is G0.
  - `[low]` `[patch]` (intent) Suspension makes the Worker bounce inbound mail, undocumented — one sentence added to docs/employee-access.md.
  - `[low]` `[patch]` (intent) Test precision: receipts asserted inclusion, Plane tombstone bind accepted `binding-conflict` — receipts now assert exactly the hermes and plain run_ids via `--since`; the Plane bind asserts exactly `binding-tombstoned`.

## Design Notes

- **Why step keys are scoped to the resource, not to the operation.** A retry, and a later retire after a suspend, must never send a second DELETE for a resource already done. The KV delete, the token delete and the installation suspend are keyed by subject, adapter, action and resource ID, and restore clears only what it reversed.
- **Why the order.** Suspend writes status first and restore writes it last, so a crash or outage fails closed: the facade denies, because it reads status per request.
- **Why a suspended installation is `suspended-reversible`, not `revoked`.** Un-suspending makes any unexpired token usable again, and anyone holding the App key can un-suspend. That is why the key row stays `manual-action-required` until GitHub answers 401 to `GET /app`.
- **Why the tombstone is in the lifecycle state.** `flume offboard` deletes the registry row, so a retired post's `role.yaml` leaves the census.
- **Example row:**
  ```json
  {"provider":"cloudflare_access","kind":"access-service-token","id":"<client_id>","static":true,"status":"static-usable","expires_at":"2027-10-12T00:00:00Z","evidence":"fixture","next_action":"flume identity retire <e> --revoke cloudflare_access --apply deletes it; otherwise Access authenticates it until expires_at (the facade still denies by status)"}
  ```
- **Continuity `--comment`.** It accepts `<employee>:<uuid>` for Plane (looked up in the `plane.verify-comments` receipts) and `<employee>:<issue|review>:<id>` for GitHub. A GitHub comment has no Flume receipt, so it reports `not-recorded`, with next action `flume comment verify …`. Rotation keeps `native_actor_id`, so that live check is unaffected.

## Verification

**Commands:**
- `git diff --check`: expect no output.
- `node scripts/run-tests.mjs employee-access-lifecycle company-identity-lifecycle`: expect typecheck, build and both new suites to pass.
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access identity-provision specialist-hire`: expect all to pass. `specialist-hire` may fail with the pre-existing ERR_FS_EISDIR (DW-1, FLUME-52). Record that; do not fix it.
- `node packages/flume-hr/dist/index.js identity readiness --json | jq -r .checks.employee_lifecycle_canary.status`: expect `unproven`.

**Manual checks:**
- No live command was run: `flume-access.service`, `role.yaml`/`agent.yaml` and agents-facade are untouched.
- The procedure file contains IDs, `op://` refs and commands only.

## Auto Run Result

### 2026-10-14 — Planning (bmad-build-auto, folder+id dispatch)

Status: ready-for-dev (the run stopped after planning, as the invocation asked)
Blocking condition: none.

**Dependencies checked.**
- PX-13 is Done.
- FLUME-39 is Backlog, and no FLUME-39 evidence file exists. So the gateway attribution link is specified as `unverified` until that evidence exists. This blocks full live AC4, not the fixture build.
- The agents-facade Worker already calls `POST /v1/mail/authorize` (`agents-facade/src/index.ts:85-167`). The Flume origin still answers 404 there, and this story adds that route.

**Not done in this session.** No source code was written, nothing was committed, and nothing ran against a live provider or live definition. The worktree baseline is `3169190f91400be100a83b81e9042e1b6975db85`.

### 2026-10-14 — Implementation (build session)

Status: implemented against fixtures; AC5 (live canary) is the supervisor's and is not done.
- New: `workforce/lifecycle.ts`, `lifecycle-adapters.ts`, `lifecycle-state.ts`, `receipts.ts`; `identity suspend|restore|retire|credentials|rotate|continuity`, `access receipts`, `mail list|read`, `POST /v1/mail/authorize`.
- Verified: `employee-access-lifecycle` and `company-identity-lifecycle` suites pass; `named-agent role-contract registry-comments company-identity employee-access identity-provision` pass; `specialist-hire` fails with the pre-existing ERR_FS_EISDIR (DW-1). Mutation checks (done-step guard, facade mail status check, static-key `revoked` rule) each failed the suite and were restored.
- Not done: no live command was run; `flume-access.service` was not restarted and agents-facade was not touched. Deploy the Flume origin before exercising mail through the Worker. `employee_lifecycle_canary` stays `unproven`.

### 2026-10-15 — Build, review and finalize (bmad-build-auto, folder+id dispatch)

Status: done (fixture build). AC5, the live Rererere canary, belongs to the supervisor and has not been run.
Blocking condition: none.

**Summary.** The lifecycle coordinator and its five adapters are built and reviewed. They cover:
- `flume identity suspend|restore|retire|credentials|rotate|continuity`;
- the facade's `POST /v1/mail/authorize`;
- the plain `flume mail list|read` client;
- the read-only `flume access receipts`.

Previews write nothing. Applies converge through resource-scoped step keys under a lifecycle lock. Every credential row says honestly what is still usable. A static key is `revoked` only on a provider read-back.

**Files changed** (against baseline `3169190f91400be100a83b81e9042e1b6975db85`; commits `9e36b2f`, `d7afef0` and this finalize commit):
- `packages/flume-hr/src/workforce/lifecycle.ts` (new): the coordinator. It holds the episodes, ordering, convergence keys, tombstones, continuity and the text formatter.
- `packages/flume-hr/src/workforce/lifecycle-adapters.ts` (new): the mail, cloudflare_access, github, plane and gateway adapters. Each one inventories, plans and runs read-back-verified steps.
- `packages/flume-hr/src/workforce/lifecycle-state.ts` (new): the state, ledger, lock and tombstones (directory 0700, files 0600).
- `packages/flume-hr/src/workforce/receipts.ts` (new): the `access receipts` join, emitting whitelisted fields only, plus the FLUME-39 gateway link and the proof check.
- `packages/flume-hr/src/workforce/access.ts`: the shared `identify()` pipeline, the `handleMail` and `/v1/mail/authorize` route, and the `requestMail` client.
- `packages/flume-hr/src/workforce/company.ts`: tombstone blockers in enroll, bind and status, plus `rotateEmployeeCredential`, `deskProfileOf` and the updated revocation note.
- `packages/flume-hr/src/workforce/github.ts`: the app-key probe and the installation read, suspend and un-suspend calls, with a per-process key cache.
- `packages/flume-hr/src/workforce/provision.ts`: the Cloudflare and vault helpers are now exported, with no behavior change.
- `packages/flume-hr/src/workforce/validator.ts` and `contracts/employee-access.schema.json`: the closed `mail_request` body.
- `packages/flume-hr/src/workforce/readiness.ts` and `tests/company-identity-regressions.mjs`: `employee_lifecycle_canary`, which stays unproven.
- `packages/flume-hr/src/index.ts` and `packages/flume-hr/src/workforce/index.ts`: the CLI commands and exports.
- `tests/company-identity-lifecycle-regressions.mjs`, `tests/employee-access-lifecycle-regressions.mjs` and `tests/lifecycle-fixtures.mjs` (new): two suites and their shared stateful doubles. Both suites are registered in `scripts/run-tests.mjs`.
- `docs/employee-access.md`, `docs/identity-provisioning.md`, `AGENTS.md` and `README.md`: the FLUME-53 section and the command lines.
- `_bmad-output/implementation-artifacts/FLUME-53/live-canary-procedure.md`: the supervisor-owned canary steps and gates. Nothing in it has been executed.

**Review findings.** 62 findings: 20 medium, 32 low and 10 false.

Patched: 19 entries (9 medium, 10 low).
- Medium:
  - A new episode starts on an `active` employee.
  - Restore works when nothing was captured.
  - Routing-rule listing is paged.
  - Only `shared-consumer` blocks the gateway, so `retire --revoke all` works for desks with no ref.
  - The canary procedure covers G1 and G2, the rotation `--apply` and a provisioned disposable employee.
  - Five test gaps are closed: restore fail-closed, the read-back no-op guards, token pagination, the continuity broken branches and rotation coverage, plus the concurrent-apply test.
- Low:
  - `literalRule` prefers the employee's own rule.
  - The `GATEWAY_REF` first character must be alphanumeric.
  - `gatewayBin` falls back to the home directory.
  - The App key is cached per process.
  - Restore results carry `gateway_link`.
  - Suspend and rotate refuse a tombstoned hand-copy.
  - The docs say inbound mail bounces while suspended.
  - The `present` evidence branch is tested, and receipts and the Plane tombstone are asserted exactly.

Deferred: 2.
- `flume identity status retired` writes no tombstone. This is medium, pre-existing, and the intent forbids changing `identity status`.
- The AGENTS.md and README retire wording. This is low and is an agent-context file.

Rejected: 21 low and 10 false. The reason for each is in the Review Triage Log. In short:
- The intent or spec mandates the current behavior:
  - the same pipeline order as access requests;
  - the Worker double;
  - `present` meaning the path exists;
  - a GET /app 401 counting as rejection;
  - `not-recorded` being a status rather than a failure;
  - rotate changing the ref only;
  - done keys staying done within an episode.
- The defect is unlikely and the fix would add branches:
  - the 40-page cap;
  - null maps in the state file;
  - the crash window between status and tombstone;
  - the comment prefix;
  - env threading;
  - evidence on internal-error rows.
- The claim was disproved:
  - `grant_id` is on every ledger line;
  - the revoke-failed residual is correct;
  - the specialist profile resolves to the same name;
  - the ledger `started` line is not a mutation;
  - the native-actor drift is real drift;
  - `--record` needs `--apply` by the Always rule;
  - the note change was directed by the Code Map;
  - the rotate ledger append needs no lock;
  - the audit/handbook wiring has no named harm.

**Follow-up review recommended: true.** Patched by verdict this pass: high 0, medium 9, low 10.

The unverified risk is the new-episode reset in `suspendOrRetire` assess. It drops a subject's step records and captures whenever the definition reads `active`, which changes the convergence semantics behind AC2. The gateway-blocker change also alters what `retire --revoke all` does. Both are verified only by fixture suites written in this same session. A follow-up pass should re-check AC2 convergence against the patched code:
- retry after an outage;
- retire after a suspend;
- an out-of-band reactivation through `flume identity status`;
- a suspend whose status write succeeds and whose provider steps fail.

**Verification performed** (after the patches):
- `git diff --check 3169190…`: no output.
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access identity-provision specialist-hire`: typecheck and build pass. 14 of 15 suites pass, including `company-identity-lifecycle` (30 scenarios) and `employee-access-lifecycle`.
  - `specialist-hire` fails with the pre-existing `ERR_FS_EISDIR` (DW-1), as the spec expects. It was not touched.
- `node packages/flume-hr/dist/index.js identity readiness --json | jq -r .checks.employee_lifecycle_canary.status`: `unproven`.
- Matrix test audit: every row has a covering test that ran and passed. This session added two of them:
  - Named revoke: `revoked 0 tokens` converges.
  - Continuity: handle and email drift is `broken`. The schema ties email to handle, so an email-only drift is `invalid-definition`.
- Manual checks:
  - `flume-access.service` was last started at 2026-10-14 22:05 EDT, before this run. It was not restarted.
  - agents-facade has no change from this run. Its last commit is the supervisor's.
  - No live `role.yaml` or `agent.yaml` was written.
  - The procedure file holds IDs, `op://` refs and commands only.

**Residual risks.**
- AC5 has not been run. The live canary is the supervisor's. Every row in this build is `evidence: fixture`.
- FLUME-39 has no evidence, so every gateway link is `unverified` and canary gate G6 cannot hold. That blocks full live AC4.
- Deploy order: rebuild and restart `flume-access.service` before exercising mail through the Worker. Until then the origin answers 404 on `/v1/mail/authorize`.
- `launchSpecialist` reads the gateway key from `op://DeLoSecrets/hermes-<employee>/credential`, which is not the FLUME-39 shape. It is unchanged, as the intent requires.
- Two pre-existing commands do not consult tombstones: `adopt-actor` and `provision`. Only a hand-edited definition would reach them.
- `provision.ts` `planMailbox` still lists routing rules unpaged. This is pre-existing and not in this story's diff.
- Suspension bounces inbound mail to the address until restore. This is documented.

### 2026-10-15 — Independent adversarial review fixes (verdict was BLOCKING)

Status: done (fixture build). AC5 is still the supervisor's live canary and has not been run. No live provider, `~/.hermes`,
`~/.config/flume`, `flume-access.service` or agents-facade was touched.

All eight findings fixed, each strengthening (never loosening) the AC it touches:
1. **Gateway inheritance (AC2).** The gateway row resolves the reference the desk runs with: delta, then generated `config.yaml`, then the fleet base. An inherited or shared key is `shared_consumer: true`, `static-usable` (retire: `manual-action-required`), never `not-issued`, and `--revoke gateway`/`--revoke all` stays the blocker `shared-consumer`. A specialist with no FLUME-39 desk reference reports the launcher's `hermes-<e>` reference `unverified` (`gateway-ref-shape`). A shared consumer's gateway proof is `unverified`.
2. **Rotated-away credentials (AC2).** Each `identity.rotate` previous ref is a `previous-credential-reference` row, `manual-action-required` until a probe of that exact ref reads back a rejection (px `credential_rejected`, `GET /app` 401, or the Access token absent from the complete listing).
3. **No episode reset (AC2).** Records and captures are dropped only by restore. Irreversible steps (Access delete, gateway revoke) are scoped to the live resources they acted on (`data.resources`, checked by `priorDone`): a re-minted token is revoked again, a done DELETE never repeats, an unreadable provider keeps the record.
4. **Tombstones at the facade and launcher.** `identify()`/`standing()` and `employeeAccessEnv` refuse `employee-retired` by subject OR handle, failing closed (503 `lifecycle-state-unavailable`, launch refused) when tombstones are unreadable. Bind, status, rotate, suspend and restore also check the handle (`handle-tombstoned`).
5. **GitHub ownership.** `github_suspend:<inst>` is captured before the PUT; a retry over a suspended installation with the capture is `done`; restore un-suspends on a `done` record or the capture.
6. **Deleted App key.** Documented. An apply that reads the installation 404 remembers it (`github_installation_absent:<id>`), so `revocation COMPLETE` is reachable when the App is uninstalled before the key is deleted.
7. **Paging.** One `listAll`: `total_pages` when stated, else until a page shorter than the served `per_page`, or empty. A repeated page or over 100 pages is `listing-incomplete`, never absence.
8. **Queue race.** The facade re-reads the employee's standing inside the single-flight queue before issuing.

Tests (`company-identity-lifecycle` 30 → 38 scenarios; `employee-access-lifecycle` 6 → 8):
- The vacuous assertions are now real: the state-dir tree is compared; app JWTs are scanned in every state and ledger file; the planted `CLIENT_SECRET` (Cloudflare listing), PAT (Pilot's answer) and gateway key are shown to reach the CLI's inputs; the run-count regex is exact; and the retry asserts exactly `already-done` with the first `operation_id`.
- New scenarios: out-of-band `status active` then suspend and restore; out-of-band `status suspended` after a re-mint, then `retire --revoke all`; a SIGKILL between the status write and the first persist; a PUT committed behind a 5xx; a read-back 500; rotated refs (`COMPLETE` only after the old PAT is rejected); a deleted App key with and without the remembered 404; clamped paging with and without `result_info`; a symlinked or unreadable definition; base, generated and specialist gateway refs; a reverted retired definition and a fresh subject around a retired handle at the facade, mail and launcher; unreadable tombstones; a queued request behind a held GitHub mint.
- Run against the pre-fix source in a throwaway worktree, every fix-targeted scenario failed for its finding's reason.
- Mutation checks, each restored byte-identical afterwards: removing the done-step guard fails `company-identity-lifecycle` (the tightened retry section fails on its own too); removing the facade mail status check fails `employee-access-lifecycle`; removing the static-key `revoked` rule fails `company-identity-lifecycle`.

Verification: `git diff --check` is clean; `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access employee-access-lifecycle company-identity-lifecycle identity-provision` passed 14/14 after typecheck and build; `employee_lifecycle_canary` is still `unproven`. The canary procedure now expects the rotated-away key's own row, and notes that `--revoke all` is refused on a desk that inherits the base key.

Behavior change to flag: `retire --revoke all` is now refused `shared-consumer` on every desk without its own FLUME-39 key (10 live desks inherit the base). Name `--revoke cloudflare_access --revoke github` there until FLUME-39 mints dedicated tokens.
