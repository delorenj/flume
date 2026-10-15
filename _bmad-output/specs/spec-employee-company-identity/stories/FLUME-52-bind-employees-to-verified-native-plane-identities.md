---
title: 'FLUME-52: Bind employees to verified native Plane identities'
type: 'feature'
created: '2026-10-14'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/epics.md'
  - '{project-root}/docs/employee-access.md'
  - '/home/delorenj/code/33GOD/pilot/docs/identity-receipt-2026-10-14.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** An employee's Flume record has no verified link to its own native Plane user, so nothing stops a stale candidate, a foreign member or Jarad's shared key from standing in for it, and a Plane PAT's static lifetime is not reported honestly. PX-13 is **Done**: Pilot shipped `px identity verify|comment` (pilot `225cf94`, receipt `d92f654`). Its live proof showed grolf `292ac356-…` and rererere `ba82e3bd-…` as two distinct native authors on sandbox TEST-14.

**Approach:** Add a `plane` provider binding that mirrors the GitHub binding. `flume identity bind <e> plane` records the requested user, instance and PAT reference. `flume identity adopt-actor <e> plane --board …` gets that binding verified by **calling Pilot's `px identity verify`**, then stamps `native_actor_id`. `flume comment verify-plane <REF>` reads comment authors back through `px show` and records secret-free receipts. Flume never opens a Plane connection or writes to Plane.

## Boundaries & Constraints

**Always:**
- Pilot owns every Plane read and write. Flume runs `px` as a subprocess: `FLUME_PX_BIN`, default `px`. Use `spawnSync` with no shell and a timeout from `FLUME_PX_TIMEOUT_MS` (default 60000). The parent env passes through unchanged, because px needs its own op/shared-key env to detect fallback. Pass `--json --workspace <slug> --base <origin>` derived from the binding's `instance`.
- Plane binding shape: `principal` = lowercase native user UUID. `instance` = `https://<host>/<workspace-slug>` exactly. `credential_ref` = `op://<vault>/<26-char item uuid>/<field-id>`, the same rule as `githubCredentialRefProblem`. `attribution_mode` is absent or `native`. Validate this at bind time AND at runtime.
- Plane `native_actor_id` is written only by `adopt-actor`. Its value is px's `native_user_id`, and it must equal `principal`. Identical rebinds after adoption remain no-ops, as `bindEmployeeProvider` already does.
- Every write is a preview unless `--apply`. Apply holds `withRegistryLock`, re-reads, and writes only through `writeDefinition`. A blocker writes nothing and exits 1 with `blockers[]`.
- Only an enrolled employee with status `active` is adopted. Any other status, or a missing enrollment, is refused **before any px call**. `verify-plane` still verifies the historical comments of a retired or suspended employee.
- Results and receipts carry IDs, `op://` refs, board IDs, px refusal codes, the Plane version/edition, px's `credential` semantics verbatim, and `evidence`. `evidence` is `"fixture"` whenever `FLUME_PX_BIN` is set, otherwise `"provider"`.
- Receipts are appended only under `--apply`, as JSONL at `${FLUME_IDENTITY_STATE:-$XDG_STATE_HOME/flume/identity}/plane-verifications.jsonl`. Each one is an observation log line and changes no definition.
- Static PAT honesty: report `type: plane_personal_access_token`, `static: true` and px's `expiry` (`observable: false`) plus its `revocation`. Never emit `expires_at`/`lifetime_seconds` for a Plane credential.

**Never:**
- No HTTP client to Plane, no direct DB/SQL, no bot/OAuth endpoint and no PAT minting. Never call `px identity comment`, `px comment` or any px write verb. Posting stays with the operator or employee through Pilot.
- No fallback to a shared or operator key, and no choosing among candidates. A principal listed in `contracts/company-identity-candidates.yaml` with `adoptable: false` is a blocker.
- Do not write the agent registry. `agents.33god-pm.plane.member_id` (stale `b29eaffc-…`) and its `key_ref` (an item that no longer exists) are not claimed by any handbook authority, and `plane.workspace|project_id|identifier` belong to project-registry. Report the mismatch as a `legacy-registry-principal` warning only.
- Do not write Krebs/PJangler manifests or `execution.actors`, do not enroll or cut over a board, and do not change the GitHub binding rules. GitHub `native_actor_id` stays digits-only at runtime.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Bind happy | active grolf, valid UUID/instance/ref | preview `changed:true`; `--apply` writes `bindings.plane`; re-apply `changed:false` | — |
| Bind invalid | non-UUID principal, instance with no workspace or extra path, title-based ref, `--attribution-mode shared_bot_attributed` | `invalid-binding` / `invalid-credential-ref` | no write |
| Bind candidate | principal `62b4fef6-…`, `b29eaffc-…`, `fe4e8e5f-…` or `db1ac9dc-…` | `stale-candidate` naming the disposition | no write |
| Enrollment requested, unsupported | `bind … plane` with no `--credential-ref`, or `adopt-actor` with no plane binding | `manual-enrollment-required` / `no-provider-binding`, plus an `enrollment.prerequisites[]` list: invite `<handle>@agents.delo.sh` or self-signup; sign in once; employee creates own PAT in browser with a recorded expiry; vault it and reference it by item UUID/field ID; admin adds board membership; then bind and adopt | 0 px calls |
| Adopt happy | bound grolf, `--board TEST --board FLUME`, px verifies each | `native_actor_id` = principal; `boards[]`, `plane{version,edition}`, `credential{static:true,expiry.observable:false,revocation}`, `shared_key_fallback:false`; receipt on apply | — |
| Adopt gate | suspended, retired or unenrolled; or no `--board` | `employee-<status>` / `not-enrolled` / `invalid-request` | 0 px calls |
| px refuses | `wrong_employee` (Jarad's key), `not_employee_identity`, `shared_identity`, `shared_credential`, `not_project_member`, `credential_rejected`, `unknown_board` | blocker `provider-refused` with `provider_code` = the px code | nothing written, even if other boards passed |
| px result disagrees | exit 0 `verified:true` but `native_user_id`, `email`, `workspace.slug` or `board.member` ≠ binding/request, or `shared_key_fallback` ≠ false | `provider-result-mismatch` | no write |
| px unusable | missing binary, timeout, non-JSON stdout | `provider-unavailable` | no write, no retry loop |
| Actor collisions | another employee already adopted the same UUID; this binding holds a different `native_actor_id` | `native-actor-duplicate` / `native-actor-conflict` | no write |
| Verify comments happy | `verify-plane TEST-14 --comment grolf:<id> --comment rererere:<id>` | each row `native-verified` (actor == adopted id); distinct actors; `board_id` from px show `ticket.project`; receipt on apply | — |
| Verify comment failures | not adopted; actor ≠ adopted (including a marker/actor_name spoof by another user); id absent; two employees with one actor | `native-actor-not-adopted` / `author-mismatch` / `comment-not-found` / `not-native-distinct` | exit 1 |
| Facade plane request | employee requests service `plane`, even with a matching grant | `denied`, code `static-provider-credential`, semantics included, no `expires_at`/`grant_id` | audit line only |

</intent-contract>

## Code Map

- `packages/flume-hr/src/workforce/company.ts:323-382` -- `bindEmployeeProvider` (lock, census, duplicate key, `native_actor_id`-stripped rebind no-op) and `bindProvider` (github validation branch). Add the plane branch here.
- `company.ts:390-429` -- `adoptNativeActor`, currently github-only (`unsupported-provider`). Add a plane path that reuses its blocker/write skeleton. `:170-181` `candidates()` reads the inventory and passes through new fields. `:62` `environment()`.
- `packages/flume-hr/src/workforce/github.ts:74-79` -- `githubCredentialRefProblem`. Reuse it, or extract a neutral `opItemRefProblem` and keep the old name exported.
- `packages/flume-hr/src/workforce/types.ts:43-53` -- `CompanyIdentityBinding` / `CompanyIdentity`. `validator.ts:93` -- `validateCompanyIdentity` (schema-backed).
- `contracts/company-identity.schema.json` `$defs.binding.native_actor_id` pattern `^\d+$` -- widen to digits OR lowercase UUID. The block stays `version: 1`. A provider-specific runtime check keeps github digits-only.
- `contracts/company-identity-candidates.yaml` -- 3 plane candidates now. Add the fourth, rererere@delo.sh `fe4e8e5f-8936-4964-ad8a-ffeaacc99b88`. Give all four `adoptable: false` and a `disposition`, with the PX-13 receipt as the source (db1ac9dc = operator-mailbox alias, refused by the company-domain rule).
- `packages/flume-hr/src/workforce/comment.ts` -- the GitHub `verifyComments` pattern (verdict vocabulary, distinctness). Model the Plane verifier on it in a new module.
- `packages/flume-hr/src/workforce/access.ts:129,203-239` -- `tagFor` and the fixture grant path. Add the `plane` refusal before grant matching. `:60` is the state-dir convention to mirror.
- `packages/flume-hr/src/workforce/readiness.ts:18-26` -- `UNPROVEN`. Add `plane_native_identity`.
- `packages/flume-hr/src/workforce/company.ts` `showEmployeeIdentity` (`:432`) -- AC4 reporting surface.
- `packages/flume-hr/src/index.ts:212-232,285-308,~491` -- `identityResult`/`formatIdentityResult`, `bind`/`adopt-actor` wiring (add `--board <b...>`), the `comment verify` group (add `verify-plane`).
- `packages/flume-hr/src/kernel/executionBinding.ts:18` -- Krebs actor shape (`native_user_id`, `key_ref`). **Read-only.** Plane fields deliberately match it; do not write it.
- Pilot (read-only consumer): `pilot/src/commands/identity.js` -- `verifyEmployee` result shape and refusal codes, `CREDENTIAL_SEMANTICS`. `pilot/src/commands/show.js:76-84` -- `comments[].{id,actor_id,actor_name}`, `ticket.project`. `pilot/src/config.js` `loadReadConfig` honors `--base`/`--workspace`.
- Tests: `tests/company-identity-regressions.mjs:31-80` (`fixture()` with isolated HOME), `:474` (readiness key list). `tests/specialist-hire-regressions.mjs:22-23` (fake bin pattern). `tests/employee-access-github-comments-regressions.mjs` (verdict rows). `scripts/run-tests.mjs:77-80` (`SUITES`).
- Live state (read-only until the live-proof task): grolf post `/home/delorenj/code/33GOD/agents/hermes/pm/role.yaml` (parent 33GOD repo), rererere `~/.agents/workforce/rererere/agent.yaml` (`~/.agents` repo). The facade `flume-access.service` is **active**.

## Tasks & Acceptance

**Execution:**
- `contracts/company-identity.schema.json`, `contracts/company-identity-candidates.yaml` -- widen `native_actor_id`; record the four PX-13 dispositions with `adoptable:false` -- schema admits a Plane UUID actor, and stale principals become machine-blockers.
- `packages/flume-hr/src/workforce/plane.ts` (new) -- binding validation, instance parsing, the px runner (verify/show) with timeout/ENOENT/JSON handling, result cross-checks, credential-semantics projection, receipt append, and `verifyPlaneComments` -- one Pilot-consumer module, so no Plane client exists anywhere else.
- `packages/flume-hr/src/workforce/company.ts` -- plane branch in `bindProvider`, plane path in `adoptNativeActor` (active-only gate, candidate blocker, all boards pass or nothing is written, duplicate/conflict, `legacy-registry-principal` warning), plane credential semantics in `showEmployeeIdentity` from the latest receipt for the subject, else `{verified:false, expiry:{observable:false}}`; candidate fields passed through -- adoption stays on the owning definition.
- `packages/flume-hr/src/workforce/types.ts`, `validator.ts` -- per-provider `native_actor_id` runtime check (github digits, plane UUID) -- one schema, provider-correct values.
- `packages/flume-hr/src/workforce/access.ts` -- refuse `service: plane` with `static-provider-credential` -- a local grant TTL can never be read as PAT expiry.
- `packages/flume-hr/src/workforce/readiness.ts` + `tests/company-identity-regressions.mjs:474` -- add `plane_native_identity` (unproven; proven only by Pilot verification receipts; PAT expiry not observable).
- `packages/flume-hr/src/workforce/index.ts`, `packages/flume-hr/src/index.ts` -- exports; `adopt-actor … --board <b...>`; `comment verify-plane <REF> --comment <employee>:<comment-id> [--apply] [--json]`; help text.
- `tests/company-identity-plane-regressions.mjs` (new) + `scripts/run-tests.mjs` `SUITES` -- a stateful fake px via `FLUME_PX_BIN` (users/keys/boards/comments, refusal codes, lie/hang/non-JSON modes, argv call log). Tests cover every matrix row plus a secret scan of stdout, stderr, definitions and receipts for the planted PAT values. Assert exact px call counts (0 for gates). Mutation-check the candidate, mismatch and gate guards (remove the guard, confirm the suite fails, restore it).
- `docs/employee-access.md`, `AGENTS.md`, `README.md` -- Plane binding section: bind → adopt → verify-plane, the manual enrollment prerequisites, static PAT semantics, and a **Deploy first** note (the widened pattern is unreadable to an older facade, which answers `unknown-client`).
- `_bmad-output/implementation-artifacts/FLUME-52/live-proof-2026-10-14.md` (date of run) -- SUPERVISOR-OWNED (plan-checkpoint ruling 2026-10-14): the dev and review sessions write this file's procedure and the fixture-proven code but do NOT restart `flume-access.service`, edit the live role.yaml/agent.yaml definitions, or run `--apply` against live definitions; the supervising session runs the live proof after the verified build lands on Flume main (the running facade serves main's dist, so restarting from this worktree would test nothing and could strand live employees). Procedure: restart `flume-access.service` on the new build, then bind and adopt grolf (`292ac356-3640-474e-ac01-8b0611ed6a91`, ref `op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/5td5eddyyhjnbbsgfoovfi5x2y`, boards TEST, 33GOD, FLUME) and rererere (`ba82e3bd-9b21-4066-9737-bd6279cf00f7`, ref `op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/gwxsutraup26mm4h7vkqj64ivu`, boards TEST, WORKF) at instance `https://plane.delo.sh/33god`. Run `verify-plane TEST-14 --comment grolf:b405f5b4-3525-4980-b9b2-4ad40b145d73 --comment rererere:2d4fe4fa-c167-4aac-a25b-7cb5c18c72e8 --apply`, plus one refusal (grolf's binding checked on WORKF → `not_project_member`). This is read-only on Plane. Commit the two definition repos. If any step is blocked, record the exact blocker and leave the readiness key unproven.

**Acceptance Criteria:**
- Given two fixture employees bound and adopted through the fake px, when `flume comment verify-plane TEST-14 --comment grolf:<id> --comment rererere:<id> --apply --json` runs, then it exits 0 with two `native-verified` rows whose distinct `actor_id`s equal each adopted `native_actor_id`, and one receipt line holds the ref, board ID, comment IDs, actors and `evidence:"fixture"`.
- Given any plane bind, adopt or verify-plane run, when the fake px argv log and all outputs are inspected, then only `identity verify` and `show` were invoked (never a write verb), and no planted PAT value appears in stdout, stderr, definitions or receipts.
- Given a plane-bound adopted employee, when `flume identity show <e> --json` runs or the employee requests `service: plane` through `flume access request`, then the credential is reported as a static Plane PAT whose expiry is not observable, with px's revocation route, and no `expires_at` appears for it.
- Given the existing github bindings, when the github/company/access suites rerun, then they pass unchanged and a UUID `native_actor_id` on a github binding is refused at runtime.
- Given the live employees on the redeployed facade, when the live-proof task runs against real px, then the receipt records `evidence:"provider"` with grolf and rererere as distinct native actors on TEST-14, or the live-proof file states the exact blocker and the story is not reported fully accepted.

## Spec Change Log

- 2026-10-14 plan checkpoint (supervisor): approved with one clarification, no AC changed or weakened. The live-proof task is executed by the supervising session after merge to Flume main; the dev/review sessions must not restart the facade or write live definitions. The registry plane.member_id/key_ref correction is out of this story's scope and is handled by the supervisor as a separate hermes.registry-parity projection slice.

## Review Triage Log

## Design Notes

- **Why bind then adopt (not one verified bind):** this mirrors GitHub (FLUME-50/51), so `native_actor_id` present is the single "provider-verified" signal Pilot/Krebs consumers can gate on. `principal` is what the operator asked for. `native_actor_id` is what Plane confirmed through Pilot.
- **Board is not stored on the binding.** Board membership is project/PJangler/Krebs truth. Adoption verifies it per requested board and records the verified boards in the receipt only.
- **Readback uses `px show`** (the operator-key third-party read the PX-13 receipt used). It is read-only, so legacy/managed mode is obeyed by construction. Posting stays `px identity comment`, which refuses managed boards.
- Example: `flume identity bind grolf plane --principal 292ac356-… --instance https://plane.delo.sh/33god --credential-ref op://DeLoSecrets/mrtiq…/5td5… --apply`, then `flume identity adopt-actor grolf plane --board TEST --apply` → px `identity verify --json --employee grolf --key-ref <ref> --user-id <principal> --email grolf@agents.delo.sh --workspace 33god --base https://plane.delo.sh --board TEST`.

## Verification

**Commands:**
- `git diff --check` -- expected: no output.
- `node scripts/run-tests.mjs company-identity-plane` -- expected: typecheck, build, and the new suite all pass.
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access identity-provision specialist-hire` -- expected: all pass. The `employee-access` filter includes the github and github-comments suites.
- `flume identity readiness --json | jq .checks.plane_native_identity.status` -- expected: `"unproven"`.

**Manual checks:**
- The live-proof file holds IDs, `op://` refs and HTTP/px codes only. `flume identity show grolf --json` shows `bindings.plane.native_actor_id == principal` after the live run.

## Auto Run Result

Status: ready-for-dev
Blocking condition: none. The run halted after planning, as instructed.
- PX-13 dependency check: **resolved**. PX-13 is Done (2026-10-14T19:34). Pilot `225cf94` ships `px identity verify|comment`, and receipt `d92f654` records `pilot/docs/identity-receipt-2026-10-14.md` with Plane 1.3.1 Community, manual PAT enrollment, PAT expiry not observable, and TEST-14 comments `b405f5b4…`/`2d4fe4fa…` authored by distinct natives `292ac356…`/`ba82e3bd…`.
- Native principal reconciliation input: grolf and rererere are the PX-13 operator-chosen canaries. The four stale/foreign candidates (`62b4fef6`, `b29eaffc`, `fe4e8e5f`, `db1ac9dc`) become `adoptable:false` blockers. The stale registry `agents.33god-pm.plane.member_id`/`key_ref` is reported, not written, because no handbook authority owns it.
- Ownership kept: Pilot does every Plane read and write (subprocess `px` only). PJangler/Krebs manifests and `execution.actors` are read-only. There is no board cutover.
- Baseline HEAD at planning: 791aef60190ba956cd4a262bbb521778d4b9b611 on `FLUME-52-plane-identity`.
