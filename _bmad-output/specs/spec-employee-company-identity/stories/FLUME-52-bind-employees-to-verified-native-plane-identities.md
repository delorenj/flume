---
title: 'FLUME-52: Bind employees to verified native Plane identities'
type: 'feature'
created: '2026-10-14'
status: 'done'
baseline_revision: '2e2b1b8de7ae86da51a78beae66723112bd91dd8'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/epics.md'
  - '{project-root}/docs/employee-access.md'
  - '/home/delorenj/code/33GOD/pilot/docs/identity-receipt-2026-10-14.md'
warnings: [oversized]
deferred:
  - summary: >-
      specialist-hire-regressions fails on a test-side non-recursive rmSync of a desk skill directory (ERR_FS_EISDIR), unrelated to this diff.
    evidence: |-
      The FLUME-52 diff touches no hire, onboard or skill code. The dev session reported the identical EISDIR failure in the untouched main checkout; a baseline (2e2b1b8) worktree run failed earlier at line 32 because no dist was built there, so that cross-check was inconclusive. Settle by running `node scripts/run-tests.mjs specialist-hire` on a built main checkout.
    location: >-
      tests/specialist-hire-regressions.mjs:49
    severity: medium
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

### 2026-10-14 — Review pass
- verdicts: 49 findings — high 0, medium 10, low 31, false 7, maybe-false 1
- findings:
  - `[medium]` `[patch]` (blind) `staleCandidate` fails open on a missing/unparseable inventory — now returns `candidate-inventory-unavailable` before any px call; tested with a missing file and garbage YAML.
  - `[medium]` `[patch]` (blind) `identity show` reports `verified:true` from a receipt for an older binding — `planeCredentialReport` now requires the receipt's `credential_ref`, `principal` and `instance` to equal the current binding; rebind test added. Fixture receipts showing as verified is low and rejected: `evidence` is carried in the output.
  - `[medium]` `[patch]` (blind) px `credential.expiry.observable` not validated — a non-false value is now `provider-result-mismatch`, added to the lie loop. The "other lifetime key names" part is low and rejected: Pilot emits no such keys.
  - `[low]` `[reject]` (blind) px calls run while holding the registry lock — mirrors the GitHub adopt path; the fix needs a verify-then-relock restructure, and contention only occurs on concurrent identity writes.
  - `[low]` `[reject]` (blind) `--board` dedupe is case-sensitive — the only effect is an extra read-only px call; normalising needs a board-identity policy.
  - `[low]` `[patch]` (blind) duplicate-actor test comment says "different instance string" when both use one INSTANCE — comment corrected. The instance-blind duplicate check and the missing bind-time principal check are low and rejected: adopt still refuses the second holder.
  - `[low]` `[reject]` (blind) circular import plane↔company, unused `isPlaneUuid`, duplicate blocker shapes — works because the imports are used at call time; no named harm. Its "GitHub wording" sub-claim is false: the message is provider-neutral.
  - `[low]` `[reject]` (blind) `native_actor_id` shape checked in four places, and unknown providers accept either shape — no current provider is affected; moving it into schema `if/then` is a refactor.
  - `[low]` `[reject]` (blind) px stderr discarded and px error text echoed — Pilot's error strings carry refs and codes, not values; the planted-PAT scan passes.
  - `[low]` `[reject]` (blind) verify-plane: duplicate `--comment`s, possible comment pagination, board not cross-checked, null board_id — each fails closed (exit 1) or is cosmetic; authorship by `actor_id` is board-independent.
  - `[false]` `[reject]` (blind) CLAUDE.md not updated — `CLAUDE.md` is a symlink to `AGENTS.md`, which the diff updates.
  - `[false]` `[reject]` (blind) facade `service: plane` match is case-sensitive — `contracts/employee-access.schema.json` pins `service` to `^[a-z0-9][a-z0-9._-]{0,62}$`, so `Plane` never reaches `decide`.
  - `[low]` `[reject]` (blind) nothing guards the deploy-first hazard — documented in docs and the live-proof procedure; the supervisor restarts the facade before any live adopt (Spec Change Log 2026-10-14).
  - `[low]` `[patch]` (blind) live-proof step 2 says "preview, then apply" but shows only `--apply` — a note was added saying the preview is the same command without `--apply`. The other sub-claims (file name, status vs AC5) follow the supervisor-owned ruling and are rejected.
  - `[low]` `[reject]` (blind) remaining test gaps (`board_archived`, case-variant boards, timing-based hang test) — the paths are low-impact; the hang test has a 20s bound against a 500ms timeout.
  - `[medium]` `[patch]` (edge) stale-candidate fail-open — same root cause and fix as the first row.
  - `[low]` `[patch]` (edge) uppercase inventory principal never matches — both sides are now lowercased.
  - `[medium]` `[patch]` (edge) credential report ignores rebind — same fix as the second row.
  - `[low]` `[reject]` (edge) an unreadable receipt file throws in `show` — needs a non-default permissions or directory state; adding a guard is new complexity.
  - `[low]` `[reject]` (edge) receipt append failing after `writeDefinition` — needs a disk-full or permissions fault; fixing it needs reordering or rollback logic.
  - `[low]` `[reject]` (edge) registry lock held during px — same as the lock row above.
  - `[medium]` `[patch]` (edge) px `expiry.observable: true` copied — same fix as the third row.
  - `[low]` `[reject]` (edge) `withoutLifetime` misses other key names — Pilot `CREDENTIAL_SEMANTICS` has no such keys.
  - `[false]` `[reject]` (edge) `px show` may omit `comments` — pilot `src/commands/show.js` always emits a `comments` array (`.slice().sort().map(...)`).
  - `[low]` `[reject]` (edge) `--apply` with no adopted employee writes no receipt silently — the verdict is already `not-native-distinct` with exit 1.
  - `[low]` `[reject]` (edge) a receipt write throwing in verify-plane — needs an I/O fault; the fix adds a branch.
  - `[low]` `[reject]` (edge) `--comment` employee regex rejects person names with uppercase or spaces — handles are lowercase by contract.
  - `[low]` `[reject]` (edge) a corrupt definition reports `employee-not-enrolled` — still a refusal with exit 1; distinguishing it adds a branch.
  - `[false]` `[reject]` (edge) mixed-instance check counts only adopted employees — unadopted employees are never compared against the ticket (they fail `native-actor-not-adopted`).
  - `[low]` `[reject]` (edge) two employees bound to one unadopted principal both preview clean — the second adopt is refused as `native-actor-duplicate`.
  - `[low]` `[reject]` (edge) `ACTOR_SHAPES` has no rule for unknown providers — no such provider writes `native_actor_id` today.
  - `[false]` `[reject]` (edge) facade case variant `Plane` — the schema pattern rejects uppercase services (see above).
  - `[low]` `[reject]` (edge) `--board` is silently ignored for github — the help text scopes it to plane; rejecting it adds a branch.
  - `[false]` `[reject]` (edge) the reused credential-ref message names the GitHub App — the text is `credential_ref must be op://<vault>/<item-uuid>/<field>…`, which is provider-neutral.
  - `[low]` `[reject]` (edge, claim) `types.ts` not touched — the per-provider check lives in `validator.ts`, which is what the task requires.
  - `[medium]` `[patch]` (edge, claim) show uses the latest receipt by subject — same fix as the second row.
  - `[low]` `[reject]` (edge, claim) partial state on a receipt I/O failure — same as the receipt-append row.
  - `[medium]` `[patch]` (verification-gap) `mixed-instances` refusal untested — test added: two adopted employees on different instances get `mixed-instances`, exit 1, 0 px calls.
  - `[low]` `[patch]` (verification-gap) `evidence:"provider"` branch untested — test added: with `FLUME_PX_BIN` unset and the fake px on `PATH`, the result and the receipt both say `provider`.
  - `[medium]` `[patch]` (verification-gap) credential report ignores rebind — same fix as the second row.
  - `[medium]` `[patch]` (verification-gap) stale-candidate fail-open — same fix as the first row.
  - `[low]` `[reject]` (verification-gap) the github digit check in `githubBindingProblems` is unreachable behind the validator — harmless defence in depth.
  - `[false]` `[reject]` (intent) live outcome (R2) not delivered — AC5 explicitly allows a live-proof file that records the run as blocked or not run, and the Spec Change Log assigns the live run to the supervisor after merge. The file says NOT RUN and readiness stays `unproven`.
  - `[low]` `[patch]` (intent) real `px show` not-found has no `code`, so Flume said `provider-unavailable` — `runPx` now maps `{ok:false,error}` without a code to `provider-refused`/`unspecified`, and the fake px now mirrors real px.
  - `[low]` `[reject]` (intent) the CLI path `flume access request --service plane` is untested — the facade `decide` path is tested in-process, and the CLI is a thin client.
  - `[maybe-false]` `[reject]` (intent) live rererere is a specialist, so it gets no `legacy-registry-principal` warning — settled by checking whether a specialist's registry row has `plane.member_id`. If true it is low: the warning is informational.
  - `[low]` `[reject]` (intent) the receipt from a failed `verify-plane --apply` is untested — it is an observation line, and the verdict path is tested.
  - `[low]` `[reject]` (intent) verify-plane returns `code`/`reasons` rather than `blockers[]` — the matrix specifies verdict codes for verify-plane, and the GitHub verifier uses the same shape.
  - `[low]` `[reject]` (intent) credential semantics are rebuilt rather than passed through verbatim — the adopt path forwards px's `expiry` and `revocation`. The facade makes no px call, so it uses the mirrored constant.

### 2026-10-14 — Review pass (follow-up)
- verdicts: 42 findings — high 0, medium 0, low 38, false 4, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) fixture-evidence receipts make `show` say verified, and a fake px can stamp a live definition — carried: `evidence` is carried in the output, and FLUME_PX_BIN is an explicit operator choice.
  - `[low]` `[patch]` (blind) enroll's text reconcile prints a refused candidate as `(unadopted)`, which looks like an open option — the text line now says `(not adoptable)` and appends the disposition; the JSON already carried `adoptable`/`disposition`. Asserted in the bind-candidates block.
  - `[low]` `[reject]` (blind) registry lock held across serial px calls — carried.
  - `[low]` `[reject]` (blind) the receipt append is not atomic with the definition write, and an unreadable receipts file breaks `show` — carried (I/O-fault-only; the fix needs reordering or guards).
  - `[low]` `[reject]` (blind) duplicate principals are caught only at adopt, and the scan ignores instance — carried.
  - `[low]` `[patch]` (blind) text-mode blockers drop `provider_code` and `board`, so a multi-board refusal does not say which board refused — the blocker line now appends `[px <code> on <board>]`, with a text-mode test on TEST+WORKF. The "warnings are not rendered" sub-claim is false (`! ${warning}` prints them, and they are strings). The stderr sub-claim is carried.
  - `[low]` `[reject]` (blind) circular plane↔company imports and the reused `githubCredentialRefProblem` — carried.
  - `[low]` `[reject]` (blind) `bindProvider` suppresses duplicate blockers by `startsWith` on the message — this is the same pattern as the pre-existing github branch (`company.ts:390`). A reword would only duplicate or drop a second blocker for an input that already has one. Structured codes are a refactor.
  - `[low]` `[patch]` (blind) `PLANE_CREDENTIAL_SEMANTICS` is a hand mirror, and `withoutLifetime` is never exercised — the mirror part is carried. The stripping is now tested (same root cause as the first verification-gap row).
  - `[low]` `[reject]` (blind) the deploy-order hazard is documented but not guarded — carried.
  - `[low]` `[reject]` (blind) the live-proof doc lacks rollback, a FLUME_PX_BIN-unset pre-check, a Pilot version check and a rererere facade check — the procedure is supervisor-owned and run once by hand, a stale export would show `evidence:"fixture"` in the very receipt the procedure inspects, and the status-versus-AC5 sub-claim is carried.
  - `[low]` `[reject]` (blind) test gaps: bind-time duplicates, github `--board`, case-sensitive dedupe and hang timing are carried. `finally` deleting the work dir and the real production IDs in fixtures are test ergonomics: the IDs are public UUIDs and item IDs, not secrets.
  - `[low]` `[defer]` (blind) DW-1 rests on an inconclusive cross-check — carried. It is already deferred, and the orchestrator owns the ledger entry, which was left untouched.
  - `[low]` `[reject]` (edge) an inventory whose `candidates` is not an array, or holds a null entry, makes `staleCandidate` throw outside its try — the inventory is a repo-owned contract. The throw exits non-zero before any px call or write, so it still fails closed, only less tidily.
  - `[low]` `[reject]` (edge) `adoptable: "false"` as a string, or a typo, disables the blocker — repo-owned file. Treating every non-`true` as blocking would also block the github candidates, which carry no flag.
  - `[low]` `[reject]` (edge) an unreadable receipts file throws in `show` — carried.
  - `[low]` `[patch]` (edge) `show` reports `verified:true` after `native_actor_id` is removed by hand (the documented rotation step) while the principal, ref and instance are unchanged — `planeCredentialReport` now requires `native_actor_id === principal`. Tested with a mutation check.
  - `[low]` `[reject]` (edge) receipt append after `writeDefinition` — carried.
  - `[low]` `[reject]` (edge) `--apply` with no judged employee writes no receipt — carried.
  - `[low]` `[reject]` (edge) case-sensitive `--board` dedupe — carried.
  - `[low]` `[reject]` (edge) `--board` ignored for github — carried.
  - `[low]` `[reject]` (edge) `ACTOR_SHAPES` has no rule for unknown providers — carried.
  - `[low]` `[reject]` (edge) the duplicate scan skips unreadable or invalid definitions — it mirrors the github scan (`company.ts:451`). An invalid definition is refused by every command, so it cannot act on the actor. A warning branch is new complexity.
  - `[low]` `[reject]` (edge) the receipt persists free-form px `enrollment`/`revocation` content — Pilot's `CREDENTIAL_SEMANTICS` are fixed strings, and the planted-PAT scan covers receipts. A field whitelist adds complexity for a trusted local binary.
  - `[low]` `[reject]` (edge, claim) the facade uses a hard-coded constant, not px's answer — carried.
  - `[low]` `[patch]` (verification-gap) `withoutLifetime` is never exercised — a new adopt-lifetime block has px report `expires_at`/`lifetime_seconds` inside expiry, revocation and enrollment, and asserts their absence from the adopt result, the receipt and `show`. Mutation-checked (identity `withoutLifetime` fails the block).
  - `[low]` `[patch]` (verification-gap) receipt matching is tested only for `credential_ref` — instance-only and principal-only edits now assert `verified:false`. Mutation-checked (dropping the instance clause fails).
  - `[low]` `[patch]` (verification-gap) the `credential.type` check is untested — a non-PAT `oauth_token` lie was added to the mismatch loop. Mutation-checked (deleting the check fails).
  - `[low]` `[patch]` (verification-gap) the text formatters are never run — non-JSON smoke runs were added for `adopt-actor` (refusal), `identity show`, `comment verify-plane` and `enroll` reconcile. Filed as defer, but it is caused by this change and cheap.
  - `[low]` `[reject]` (verification-gap, other) `githubBindingProblems`' digit check is shadowed by the validator — carried.
  - `[low]` `[defer]` (verification-gap, other) specialist-hire red in the run — carried as DW-1.
  - `[false]` `[reject]` (verification-gap, other) live proof NOT RUN — carried: AC5 allows the recorded not-run state, and the live run is supervisor-owned.
  - `[low]` `[reject]` (intent) the full plane-binding shape is re-validated only in adopt and verify-plane, not at definition load — those are the only consumers that act on it. Load-time validation would make a bad plane field break the employee's github access too.
  - `[low]` `[reject]` (intent) receipts never carry px refusal codes — the matrix's "nothing written, even if other boards passed" governs. Results carry the code, and receipts are success observations.
  - `[false]` `[reject]` (intent) a preview still runs px — `px identity verify` is read-only on Plane, and "every write is a preview" governs writes. A preview that skipped verification could not report what adoption would write.
  - `[low]` `[reject]` (intent) credential semantics are rebuilt rather than verbatim — carried.
  - `[false]` `[reject]` (intent) GitHub code and schema were edited — the Code Map directs the widened pattern plus a per-provider runtime check. The effective github rule (digits only) is unchanged and tested.
  - `[low]` `[reject]` (intent) `legacy-registry-principal` appears only on adopt, and ignores the dead `key_ref` — informational only. The registry belongs to another authority, and the supervisor owns its correction (Spec Change Log).
  - `[false]` `[reject]` (intent) every proof uses Flume's fake px, and the `provider` label is tested via PATH — carried as the AC5/live-proof row. The label follows the spec's literal rule.
  - `[low]` `[reject]` (intent) the facade denial carries `evidence:"none"` — the facade makes no px observation, so neither `fixture` nor `provider` would be true.
  - `[low]` `[reject]` (intent) `show`'s verified status depends on which host holds the receipts file — this is spec-mandated (show reads the latest receipt), so the fix would edit the spec.
  - `[false]` `[reject]` (intent) unspecified extra checks (fail-closed gate, type/expiry checks, board-level refusals, mixed-instances) — not a defect. Each one fails closed, and the gate was a logged patch.

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

### 2026-10-14 — Follow-up review (bmad-build-auto)

Status: done (code accepted on fixture evidence; AC5 live proof stays supervisor-owned and NOT RUN)
Blocking condition: none.

**Summary.** This was a follow-up review of the FLUME-52 Plane identity binding: bind, adopt through `px identity verify`, `verify-plane` through `px show`, the facade denial and the static-PAT reporting. Four review layers ran against the diff from baseline `2e2b1b8`. Nothing high or medium surfaced. Seven low entries were patched: one correctness gap, two text-output gaps and four test gaps.

**Files changed (this pass)**
- `packages/flume-hr/src/workforce/plane.ts`: `planeCredentialReport` trusts a receipt only while the binding is still adopted (`native_actor_id === principal`).
- `packages/flume-hr/src/index.ts`: text-mode blockers name `[px <code> on <board>]`, and text reconcile marks refused candidates `(not adoptable)` with their disposition.
- `tests/company-identity-plane-regressions.mjs`: tests for lifetime-key stripping across adopt, receipt and show; instance-only, principal-only and actor-removed receipt matching; the non-PAT credential type; and non-JSON smoke runs for adopt, show, verify-plane and reconcile.

**Review.** 42 findings: high 0, medium 0, low 38, false 4.
- **Patched:** 7 entries, all low.
- **Deferred:** none new. DW-1 (specialist-hire EISDIR) was carried; its ledger entry is untouched and owned by the orchestrator.
- **Rejected:** the rest, with reasons in the Review Triage Log. Most were carried from the first pass. The new rejects are the malformed-inventory crash (still fails closed), the string `adoptable`, the duplicate scan skipping invalid definitions, free-form receipt fields, load-time plane validation, refusal receipts, the preview px call, the GitHub schema edit, the legacy-warning scope, facade `evidence:"none"`, the receipt-host dependence, the prefix-filtered validator messages and the live-proof guardrails.

**Follow-up review: not recommended (false).** This is a follow-up pass and no high finding was patched. Patched counts by verdict: high 0, medium 0, low 7.

**Verification.**
- `git diff --check`: clean.
- `node scripts/run-tests.mjs company-identity-plane named-agent role-contract registry-comments company-identity employee-access identity-provision specialist-hire`: typecheck and build ok, 11 of 12 suites pass. `specialist-hire-regressions` fails with the pre-existing ERR_FS_EISDIR (DW-1).
- `identity readiness --json | jq .checks.plane_native_identity.status`: `"unproven"`.
- Mutation checks: each new test fails when its guard is removed. Checked: identity `withoutLifetime`, no PAT type check, no adopted clause, no instance clause, no reconcile marker.

**Residual risks.**
- AC5 (live grolf/rererere receipt with `evidence:"provider"`) is unproven until the supervisor merges to main, restarts `flume-access.service` and runs `_bmad-output/implementation-artifacts/FLUME-52/live-proof-2026-10-14.md`.
- An older facade answers `unknown-client` for a definition holding a Plane UUID actor, so deploy first.
- px calls still run under the registry lock (up to 60s per board).
