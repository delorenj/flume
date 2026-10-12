---
title: 'FLUME-47 — Enroll an existing employee without changing who they are'
type: 'feature'
created: '2026-10-11'
status: 'in-review'
baseline_revision: 1dd81676dcf018b366a97c1c85a9dd51aebdfdbc
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/architecture.md'
  - '{project-root}/_bmad-output/planning-artifacts/employee-company-identity/epics.md'
warnings: [oversized]
deferred: []
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
