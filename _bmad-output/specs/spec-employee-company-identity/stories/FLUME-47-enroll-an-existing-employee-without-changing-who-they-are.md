---
title: 'FLUME-47 — Enroll an existing employee without changing who they are'
type: 'feature'
created: '2026-10-11'
status: 'done'
baseline_revision: 1dd81676dcf018b366a97c1c85a9dd51aebdfdbc
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/architecture.md'
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/epics.md'
warnings: [oversized]
deferred:
  - summary: >-
      Write failure paths of identity apply have no regression test: concurrent same-handle enroll, read-back rollback, and the drifted contract.yaml skip.
    evidence: |-
      tests/company-identity-regressions.mjs runs every apply sequentially and never injects a mismatch, a mid-flight edit or a drifted contract.yaml.
      If the census were hoisted outside withRegistryLock, or the rollback or drift guard were dropped, every test would still pass.
      Two parallel `enroll --apply` runs with the same --handle (expect one success and one handle-taken) is the cheapest first test.
    location: >-
      packages/flume-hr/src/workforce/company.ts writeDefinition / enrollEmployee
    severity: medium
  - summary: >-
      No test runs flume review, audit, roster or parity readers against a post whose role.yaml carries company_identity.
    evidence: |-
      The post-holder test only runs the template's role-identity.py and role-yaml.py on the enrolled file.
      role.schema.json is open at the top level and handbook.yaml treats role.yaml as presence_only, which suggests tolerance, but no TS reader is exercised.
      A smoke `flume review --agent <post> --json` after enrollment that shows no new observation would settle it.
    location: >-
      packages/flume-hr/src/parity/rules.ts, packages/flume-hr/src/workforce/audit.ts
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** Named employees have a person name, post, desk and memory bank but no durable company subject or `@agents.delo.sh` address, so later access/mail/code/ticket identities (FLUME-48..53) have nothing stable to bind to and could mint duplicate people.

**Approach:** Add a self-versioned `company_identity` block (immutable UUID subject, non-recycled handle, derived address, local status, reference-only provider bindings) to the employee's EXISTING owning definition — `role.yaml` for a named post-holder, the desk `agent.yaml` (named-agent `schema_version: 2`) for a portable specialist — and a `flume identity` CLI (`enroll` preview/apply, `show`, `status`, `readiness`) that censuses every known definition so conflicts block before any write.

## Boundaries & Constraints

**Always:**
- The subject lives on the owning definition; no new employee registry, ledger or registry-row field. Registry rows, profiles, desks, banks, post ids and every other definition key stay byte-for-byte or semantically unchanged.
- `enroll` and `status` are previews unless `--apply`; apply runs under `withRegistryLock`, recomputes the census inside the lock, writes atomically (temp+rename), refuses symlinked definitions, and reads the result back.
- Any blocker writes nothing and exits 1 with explicit `blockers[]` codes. A second apply is a no-op (`changed: false`).
- Handle defaults to the person name, is immutable once enrolled, is unique across every block in any status (retired included), never equals a registry post id other than the specialist's own id, and is never an RFC 2142 role name. Address is always `<handle>@agents.delo.sh`.
- Status is local employment state only; output always says provider access was not revoked (FLUME-53 owns revocation). `retired` is terminal; retired blocks remain as tombstones that keep blocking handle/subject reuse.
- Bindings carry only `principal`, optional `instance`, optional `credential_ref` (must start `op://`), optional `attribution_mode` (`native`|`shared_bot_attributed`); any other key is refused.
- Readiness reports every external fact as `unproven` with `ready: false` and never a zero cost. Network probes run only with `--probe cloudflare`, use GET only, read the token from `CLOUDFLARE_API_TOKEN`, and record `observed_at`, path, HTTP status and exact measured values without the token.

**Never:**
- Create, select or adopt provider accounts; Grolf/Plane candidates are listed under `reconcile[]` only.
- Add keys to role.yaml `identity:` (mirrored by the template's closed `role-identity.py` ALLOWED_KEYS) or touch the `templates/hermes-agent` submodule.
- Edit Plane, DNS, Cloudflare, 1Password or any live account; no non-GET request.
- Silently invent a person for an unnamed post, or let `flume onboard`/`hire --definition` drop or change an enrolled block.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Enroll post-holder | row with role_dir; role.yaml `identity.name: grolf`, no block | preview proposes subject+`grolf@agents.delo.sh`; `--apply` appends block, role.yaml prefix unchanged | No error expected |
| Enroll specialist | row `employment: portable-specialist`, agent.yaml v1 | `schema_version: 2` + block; matching desk `contract.yaml` re-rendered; `flume audit --employee` stays in good standing | No error expected |
| Re-apply | already enrolled, same handle | `changed: false`, no bytes written | No error expected |
| Legacy read | v1 agent.yaml / role.yaml without block | `show` reports `enrolled: false` and readable fields | No error expected |
| Unnamed post | role.yaml without `identity` | blocker `unnamed-post` | exit 1, nothing written |
| Conflicts | handle/subject/binding duplicated elsewhere; person declared/enrolled at another definition; handle = post id or reserved; v1 file carrying a block; malformed block | blocker per case (`handle-taken`, `subject-duplicate`, `binding-duplicate`, `person-elsewhere`, `handle-reserved`, `invalid-definition`) | exit 1, nothing written |
| Grolf candidates | candidates inventory names person `grolf` / post `33god-pm` | listed in `reconcile[]` as `unadopted`; no binding written | No error expected |
| Rename / move / rotate | display_name changed; blocks moved to another post; binding `credential_ref` rotated | `show` returns the same subject | No error expected |
| Status | `status <e> suspended|active|retired --apply` | block status + `status_changed_at`; `provider_revocation: "not_performed"` | retired→other or unenrolled: exit 1, nothing written |
| Onboard drift | desk block exists; `onboard --definition` source lacks/differs | refused before any write | exit 1 |
| Readiness | no probe flag | all checks `unproven`, `ready: false`, zero network | No error expected |
| Readiness probe | `--probe cloudflare` + env | GET zone/plan, subdomain+apex MX DNS, email routing, service-token count; recorded with time | missing env → probe `not_run`; HTTP error → recorded, still unproven |

</intent-contract>

## Code Map

- `contracts/named-agent.schema.json` -- closed schema; add optional `company_identity` (`$ref` new schema) with `if required company_identity then schema_version minimum 2`.
- `contracts/company-identity.schema.json` (new) -- v1 block: `version: 1`, `subject` (uuid), `handle`, `email`, `status`, `enrolled_at`, optional `status_changed_at`, `bindings` map; `additionalProperties: false` everywhere.
- `contracts/company-identity-candidates.yaml` (new) -- secret-free reconciliation inventory from `../krebs/docs/activation.md:21-31`: Plane `db1ac9dc-6180-47d0-aa87-e1bf46d10707` (jaradd+grolf), `b29eaffc-cc8d-4de1-a10b-7425c67177ab` (post row 33god-pm), `62b4fef6-b0fe-4cd2-bcd7-53737a61feb4` (grolf@delo.sh, stale). Overridable via `FLUME_IDENTITY_CANDIDATES`.
- `packages/flume-hr/src/workforce/validator.ts:16-19,51` -- register the new schema with ajv before the named schema; `validateNamedAgentSchema` calls the block's semantic check (email = handle@domain, uuid).
- `packages/flume-hr/src/workforce/types.ts:27` -- add `CompanyIdentity`/binding types; `company_identity?` on `NamedAgentContract`.
- `packages/flume-hr/src/workforce/identity.ts:16` -- `readRoleIdentity` gives the post-holder's person; do NOT change `IDENTITY_KEYS` (mirrors `templates/hermes-agent/template/.scripts/lib/role-identity.py` ALLOWED_KEYS).
- `packages/flume-hr/src/workforce/company.ts` (new) -- block validation, census (registry rows via `copierFleetPaths`; specialist `definition_path`, post `role_dir/role.yaml`, plus `~/.agents/workforce/*/agent.yaml`), plan/enroll/status/show.
- `packages/flume-hr/src/workforce/readiness.ts` (new) -- readiness report and Cloudflare GET probes (`FLUME_CLOUDFLARE_API_BASE` override for tests).
- `packages/flume-hr/src/workforce/specialist.ts:149-156` -- before any write in `hireSpecialist`, refuse when the incoming definition's block differs from the desk agent.yaml's.
- `packages/flume-hr/src/workforce/desk.ts:52` -- `renderDeskContract` used to refresh `contract.yaml` only when it matched the pre-enrollment render.
- `packages/flume-hr/src/workforce/role.ts` `withRegistryLock` -- reuse for apply.
- `packages/flume-hr/src/index.ts` -- `identity` command group, modelled on `offboard` (dry-run default, `--apply`, `guardBrokenPipe`/`writeStdout`/`exitAfterFlush`).
- `templates/hermes-agent/copier.yml:194-199` -- read-only evidence: `_skip_if_exists: role.yaml`, so copier never rewrites the block.
- `tests/specialist-hire-regressions.mjs` `fixture()` and `tests/named-agent-regressions.mjs:86-108` -- isolated HOME/registry/role fixture patterns to reuse.

## Tasks & Acceptance

**Execution:**
- `contracts/company-identity.schema.json`, `contracts/named-agent.schema.json`, `contracts/company-identity-candidates.yaml` -- add schema, versioned extension and candidate inventory -- versioned contract, explicit reconciliation input.
- `packages/flume-hr/src/workforce/types.ts`, `validator.ts` -- types, ajv registration, semantic check -- legacy v1 stays valid, v1+block refused.
- `packages/flume-hr/src/workforce/company.ts`, `readiness.ts`, `index.ts` (workforce) -- implement and export -- domain logic.
- `packages/flume-hr/src/workforce/specialist.ts` -- block-continuity guard -- onboarding cannot erase a subject.
- `packages/flume-hr/src/index.ts` -- `flume identity enroll|show|status|readiness` with `--json` -- public surface.
- `tests/company-identity-regressions.mjs` (new), `scripts/run-tests.mjs` -- cover every matrix row through the built CLI with isolated HOME and a local fake Cloudflare server; register suite -- loop gate executes it.
- `CLAUDE.md`, `README.md` -- list the `flume identity` commands -- discoverability.

**Acceptance Criteria:**
- Given a named post-holder and a portable specialist fixture, when `flume identity enroll` previews then applies, then each gets one persistent subject and `@agents.delo.sh` address on its own definition, post id, desk, memory bank, registry rows and unrelated keys are unchanged, and a second apply is a no-op.
- Given legacy data, duplicates, unnamed posts or invalid input, when enrollment is requested, then legacy data remains readable, every conflict is an explicit blocker, nothing is written, and Grolf candidates are listed for reconciliation without being chosen.
- Given a renamed display name, moved post or rotated binding, when `flume identity show` reads it, then the subject is unchanged; retired handles/subjects are not reusable; suspend/retire are recorded locally while reporting provider revocation as not performed.
- Given no measured inventory, when `flume identity readiness` runs, then Cloudflare plan, mail/DNS conflicts, service-token capacity and provider rights are `unproven` and not ready, and an authorized `--probe cloudflare` records time and exact GET results without creating resources.

## Spec Change Log

## Review Triage Log

### 2026-10-12 — Review pass
- verdicts: 56 findings — high 0, medium 8, low 33, false 14, maybe-false 1
- findings:
  - `[medium]` `[patch]` (blind) Fresh `hire --definition` whose source carries a block bypasses the census because `identityContinuity` returned early without a desk — patched (G1): `specialist.ts` refuses any block hire/onboard would introduce; test "hire --definition carrying a company_identity block is refused before any write".
  - `[low]` `[reject]` (blind) `contract.yaml` publish failure after `agent.yaml` publish leaves a half-applied specialist — needs disk/permission failure after a stat-checked regular file; stale contract is reported by `flume audit`; fix adds two-file rollback machinery.
  - `[low]` `[patch]` (blind) Probe marks `cloudflare_plan` `measured` on a 200 with no zone; "`run` despite all-401" part is false (errors are recorded, checks stay unproven) — patched (G2): missing zone is recorded as an error; test "a 200 with no visible zone or no JSON body stays unproven"; reproduced live with the Cloudflare-EmailRouting token.
  - `[low]` `[patch]` (blind) Human readiness output hides `probes` (e.g. `not_run`) — patched (G3): `formatIdentityResult` prints `probe <name>: <state>`; test asserts the human `not_run` line.
  - `[false]` `[reject]` (blind) Service-token count truncated at `per_page=50` — `result_info.total_count` (the account total) is read first; `result.length` is only a fallback.
  - `[false]` `[reject]` (blind) No token verification, so wrong-scope 403s look like account findings — every 403 is recorded as an error and the check stays `unproven`; live run with scoped tokens shows exactly that.
  - `[false]` `[reject]` (blind) Absolute `$ref` URL to an unpublished schema — identical to the existing convention in `contracts/role.schema.json:9-11`; ajv registers the schema via `addSchema` before use.
  - `[low]` `[reject]` (blind) Post-holder test is coupled to the shipped candidate inventory — that inventory is the intent's Grolf matrix row under test; an independent override fixture was added (G7).
  - `[low]` `[reject]` (blind) Candidate inventory parsing is unvalidated — shipped file is valid and tracked; a malformed override fails loudly; fix adds schema machinery.
  - `[low]` `[patch]` (blind) Rotate/move tests hand-edit YAML; `reconcile[].bound` untested — hand-edit is the only binding path the intent defines (no bind command); bound branch covered by G7 test.
  - `[low]` `[patch]` (blind) `spliceBlock` only tested with the block at EOF — G6 test "status on a mid-file block keeps every byte before and after it".
  - `[medium]` `[defer]` (blind) No concurrency test for the lock / `changed during enrollment` / read-back rollback — grouped with verification-gap G9.
  - `[false]` `[reject]` (blind) Person "ada" at post "ada" is blocked `handle-reserved` — the intent requires a handle never equal a registry post id other than a specialist's own id.
  - `[low]` `[reject]` (blind) One unreadable definition blocks every enrollment — fail-closed census is the intended design; nothing is written; `--handle`/repair resolves it.
  - `[low]` `[reject]` (blind) Timestamp regex-only, `status_changed_at` not required, UUID version, hand-edited subject undetected — hand edits are outside the CLI contract; fixes add validation branches with no demonstrated reachable harm.
  - `[false]` `[reject]` (blind) Handbook/MCP/review not updated — handbook owns `role.yaml` as `presence_only` (`contracts/handbook.yaml:591`); MCP/review exposure is not in the intent.
  - `[low]` `[reject]` (blind) Story spec's prior Auto Run Result removed — fix would edit this build's spec.
  - `[low]` `[reject]` (blind) `publish` does not preserve uid/gid or fsync the directory; formatter crash after write; unvalidated status string — single-user host; status string is validated (`invalid-status` blocker, tested).
  - `[low]` `[reject]` (edge) v2 `agent.yaml` without a block, or `schema_version: 1 # note`, previews ok then apply throws — loud failure before any write; v2-without-block only arises from hand-authoring; fix adds a branch.
  - `[medium]` `[patch]` (edge) First hire with a block skips the census — G1 (see first row).
  - `[low]` `[patch]` (edge) Unenrolled desk + incoming block gets a misleading "carry the enrolled block forward" message; invalid desk YAML raw error — G1 now gives a distinct "never introduce" message; raw-YAML part is a loud failure, accepted.
  - `[low]` `[reject]` (edge) `contract.yaml` publish fails after `agent.yaml` — same as blind row 2.
  - `[low]` `[reject]` (edge) Rollback `publish` itself throwing masks the read-back error — requires a second filesystem failure inside a failure; fix adds error aggregation.
  - `[low]` `[reject]` (edge) Malformed candidate inventory throws out of `plan()` — same as blind inventory row.
  - `[low]` `[reject]` (edge) `resolve()` not `realpath` may census one file twice — hire writes `definition_path` with the same `join(desk, "agent.yaml")` the census builds; read-only previews on the live registry showed no self-conflict for both real specialists.
  - `[low]` `[reject]` (edge) Re-enroll no-op exits 1 when an unrelated definition is unreadable — writes nothing; fail-closed census is intended.
  - `[low]` `[patch]` (edge) `status` on a symlinked definition: preview `ok:true`, apply throws without `blockers[]` — patched (G4): `setEmployeeStatus` adds the `invalid-definition` symlink blocker; test covers preview and apply.
  - `[low]` `[patch]` (edge) Human readiness never prints `not_run` — G3.
  - `[low]` `[patch]` (edge) HTTP 200 with a non-JSON body is promoted to `measured` — G2: a missing JSON body is now a failure; test with an HTML body.
  - `[low]` `[reject]` (edge) `dns_records` non-array `result` throws — Cloudflare returns arrays on success (confirmed live); failure bodies with `null` are already handled by `?? []`.
  - `[low]` `[patch]` (edge) Empty zone result marked `measured`; multiple zones pick the first — G2 for empty; the multiple-zones part is false because `name=` is an exact-match filter.
  - `[low]` `[reject]` (edge) External tool edits the definition between the unchanged-text check and rename — microsecond window on a single-user host; no cross-tool lock exists to take.
  - `[false]` `[reject]` (edge) Retired/suspended desk can be re-onboarded — the continuity guard keeps the retired block byte-identical; the intent assigns access stop/revocation to FLUME-53.
  - `[low]` `[patch]` (edge) Claim: status path lacks the symlink blocker — G4.
  - `[medium]` `[patch]` (verification-gap) Specialist status change never exercised (contract refresh, no version bump) — G5 test: `agent.yaml` and `contract.yaml` both `suspended`, `schema_version` 2, audit in good standing.
  - `[low]` `[patch]` (verification-gap) `spliceBlock` replacement only tested at EOF — G6 test.
  - `[medium]` `[defer]` (verification-gap) Write failure paths untested: read-back rollback, concurrent same-handle apply, drifted `contract.yaml` skip — G9 deferred; parallel same-handle enroll is the cheapest first test.
  - `[medium]` `[patch]` (verification-gap) `reconcile[]` `bound` state and `FLUME_IDENTITY_CANDIDATES` override unasserted — G7 test: bound candidate reports its holder; missing inventory is a warning.
  - `[low]` `[patch]` (verification-gap) `invalid-handle`, unsupported probe, unknown employee unexercised — G8 test.
  - `[medium]` `[defer]` (verification-gap) TS readers (`flume review`/audit/parity) never run on an enrolled `role.yaml` — G10 deferred; `role.schema.json` is open at the top level, and onboard of an existing post skips Copier (`RunCopierTemplate.ts:145`).
  - `[low]` `[patch]` (verification-gap) Empty zone result promoted to `measured` — G2.
  - `[low]` `[reject]` (verification-gap) `schema_version: 1 # note` throws at apply — same as edge row 1.
  - `[false]` `[reject]` (intent) After enrollment, `onboard --definition` with the original v1 source is refused — the intent's Onboard-drift row requires exactly this.
  - `[low]` `[reject]` (intent) Tests build the "source with block" by YAML round-trip, losing comments — a test-construction detail with no product harm.
  - `[medium]` `[patch]` (intent) Hire path never consults the census — G1.
  - `[false]` `[reject]` (intent) Post `flume onboard` has no code or test protecting the block — `RunCopierTemplate.ts:145` returns before Copier or any `role.yaml` rewrite when onboarding an existing role.
  - `[low]` `[reject]` (intent) Census excludes unregistered `role.yaml` files and authored sources — unregistered files hold no employee; the tombstone limitation is recorded in Design Notes.
  - `[false]` `[reject]` (intent) New `measured` readiness status — the matrix ("HTTP error → recorded, still unproven") distinguishes clean evidence; `ready` stays false and `cost` stays null.
  - `[low]` `[patch]` (intent) Zone-not-found 200 becomes `measured` — G2.
  - `[false]` `[reject]` (intent) `plan_price: 0` passes through while `cost` is null — the intent requires exact measured values; the check's `cost` is still null.
  - `[maybe-false]` `[reject]` (intent) Cloudflare response shapes only checked against a fake — the live GET probe on 2026-10-12 confirmed the zone/plan and MX shapes; the `email/routing` and `service_tokens` shapes returned 403 with the available tokens; if wrong, the visible effect is null values in evidence (low), with `ready` still false.
  - `[low]` `[patch]` (intent) Error shapes: unknown employee and symlinked `status` return no `blockers[]` — G4 for symlink; unknown employee exits 1 with nothing written, accepted.
  - `[false]` `[reject]` (intent) Binding keys narrower than the illustrative AD-1 — the intent fixes the closed key set.
  - `[false]` `[reject]` (intent) Bindings never written by a command; rotate tested by hand edit — the intent defines no bind command.
  - `[false]` `[reject]` (intent) Live registry `identity: grolf` ignored; enrollment writes into another repo's tracked `role.yaml` — the census reads `role.yaml identity.name` (live preview proposes grolf); `role.yaml` is the intent's owning definition (recorded as residual risk).
  - `[false]` `[reject]` (intent) review/org/roster/MCP surfaces untouched — not requested by the intent.

## Design Notes

Why role.yaml/agent.yaml and not the registry row: the architecture (AD-1) and ticket require the subject on the existing owning definition; the registry row is keyed by post and is deleted by `flume offboard`, so it would lose tombstones and would not follow a person between posts. role.yaml is durable (Copier skips it) and already holds the person's `identity:`; the sibling top-level block keeps the template's closed identity reader untouched. Moving posts means moving `identity:` and `company_identity:` together, exactly as `identity:` moves today; the census refuses a person declared or enrolled at two definitions.

Example block appended to role.yaml:

```yaml
company_identity:
  version: 1
  subject: 6f1c0d7e-2b8a-4c55-9a51-0e3c2f4b7a19
  handle: grolf
  email: grolf@agents.delo.sh
  status: active
  enrolled_at: "2026-10-11T15:30:00.000Z"
```

Known limitation: deleting a retired definition file removes its tombstone; this story records retirement in place and does not delete definitions.

## Verification

**Commands:**
- `git diff --check` -- expected: no output.
- `node scripts/run-tests.mjs company-identity` -- expected: typecheck+build ok, suite PASS.
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access specialist-hire` -- expected: all selected suites PASS.

## Auto Run Result

Status: done (local spec only; Plane FLUME-47 stays In Progress for the supervising session; not merged to main, per execution.md)

**Summary.** CAP-1 adds a self-versioned `company_identity` block on each employee's existing owning definition: `role.yaml` for a named post-holder, and the desk `agent.yaml` at `schema_version: 2` for a portable specialist. It ships a `flume identity enroll|show|status|readiness` CLI that censuses every known definition under the registry lock before writing. Implementation landed in 0a65771a901595d6c46d074b26d55022a5dec055; this pass reviewed it and patched it.

**Files changed (baseline 1dd81676dcf018b366a97c1c85a9dd51aebdfdbc to here).**
- `contracts/company-identity.schema.json`: new closed v1 block schema.
- `contracts/named-agent.schema.json`: optional `company_identity`, which requires `schema_version` ≥ 2.
- `contracts/company-identity-candidates.yaml`: a secret-free Grolf/Plane reconciliation inventory.
- `packages/flume-hr/src/workforce/types.ts` and `validator.ts`: block types, ajv registration and semantic checks.
- `packages/flume-hr/src/workforce/company.ts`: census, conflicts, enroll, status and show, plus the atomic write with read-back. This pass added the symlink blocker for `status`.
- `packages/flume-hr/src/workforce/readiness.ts`: an unproven-by-default readiness report and GET-only Cloudflare probes. This pass made a no-JSON 200 or a missing zone count as unmeasured.
- `packages/flume-hr/src/workforce/specialist.ts`: the identity continuity guard. This pass made hire and onboard refuse to introduce a block at all.
- `packages/flume-hr/src/workforce/index.ts`: exports.
- `packages/flume-hr/src/index.ts`: the `flume identity` command group. This pass made human output print probe state.
- `tests/company-identity-regressions.mjs` and `scripts/run-tests.mjs`: the isolated-HOME CLI suite, registered with the runner. It had 22 check groups; this pass brought it to 28.
- `AGENTS.md` (which `CLAUDE.md` symlinks to) and `README.md`: the command listing.

**Review findings.**
- 56 findings from 4 layers: blind, edge-case, verification-gap and intent-alignment.
- Verdicts: high 0, medium 8, low 33, false 14, maybe-false 1.
- Patches applied: 8 root-cause groups (3 medium, 5 low).
  - G1 (medium): the hire/onboard path could introduce a block that bypassed the census.
  - G2 (low): a 200 with no zone or no JSON was reported as `measured`.
  - G3 (low): human readiness output did not print probe state.
  - G4 (low): `status` had no symlink blocker.
  - G5 (medium): no test for a specialist status change.
  - G6 (low): no test for a mid-file splice.
  - G7 (medium): no test for the reconcile `bound` state or the inventory override.
  - G8 (low): no tests for the invalid-handle, unknown-employee and unknown-probe errors.
- Deferred: 2, both listed in the frontmatter `deferred` field. G9 covers write-failure and concurrency tests. G10 covers TS reviewers reading an enrolled `role.yaml`.
- Rejected: every remaining finding, each with its recorded reason in the Review Triage Log above.

**Follow-up review recommended: true.** This first pass patched 3 medium entries and no high ones. The named unverified risk is G1. Hire and onboard now refuse any `company_identity` that the desk `agent.yaml` does not already carry. Offboard keeps workforce desks (`hire/offboard.ts:72-73`). However, if a desk `agent.yaml` is lost or hand-deleted, an enrolled specialist cannot be restored from its enrolled source; the only way through is to strip the block, which mints a new subject. No test or design note covers that restore path.

**Verification performed (2026-10-12).**
- `git diff --check` produced no output.
- `node scripts/run-tests.mjs company-identity`: typecheck ok, build ok, 1/1 PASS, with 28 check groups printed when the suite was run directly.
- `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access specialist-hire`: typecheck and build ok, 6/6 suites PASS. No `employee-access` suite exists yet; that is FLUME-48.
- An authorized live `flume identity readiness --probe cloudflare` was run against the real Cloudflare account. It made GET requests only, nothing was created or changed, and the token was confirmed absent from the output.
  - Vault `Cloudflare/globalAPIToken`: 400 `6003 Invalid request headers`. It is a 37-character Global API Key, not a Bearer token.
  - `Cloudflare-EmailRouting` token: 200 with no visible zone, now correctly `unproven`. This is the G2 case, seen live.
  - Legacy DNS token:
    - zone `delo.sh`, plan "Free Website", price 0 USD;
    - no MX on `agents.delo.sh`;
    - three Cloudflare route MX records on the apex;
    - `email/routing` 403;
    - `access/service_tokens` 403.
  - Every check stayed `ready: false`.

**Residual risks.**
- Enrolling a live post writes into that post's tracked `role.yaml`, which lives in another repo. For example, 33god-pm is at `33GOD/agents/hermes/pm/role.yaml`. That write needs its own commit there. Nothing was enrolled live in this run.
- No token in the vault is currently scoped to read Email Routing or Access service tokens, so those facts remain unproven.
- Deleting a retired definition deletes its tombstone. This was a known limitation before this pass.
