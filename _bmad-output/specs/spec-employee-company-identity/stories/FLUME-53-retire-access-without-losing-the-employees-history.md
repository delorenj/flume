---
title: 'FLUME-53 — Retire access without losing the employee''s history'
type: 'feature'
created: '2026-10-14'
status: 'in-progress'
baseline_revision: '3169190f91400be100a83b81e9042e1b6975db85'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/epics.md'
  - '{project-root}/docs/employee-access.md'
  - '{project-root}/docs/identity-provisioning.md'
  - '/home/delorenj/code/33GOD/agents-facade/src/index.ts'
  - '/home/delorenj/docker/stacks/ai/newapi/ops/gateway-tokens.py'
warnings: [oversized]
deferred: []
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
