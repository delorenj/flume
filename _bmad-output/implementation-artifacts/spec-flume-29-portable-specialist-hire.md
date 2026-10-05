---
title: 'FLUME-29: hire and carry a named specialist between working directories'
type: feature
created: '2026-10-05'
status: in-review
route: dispatch
baseline_commit: 259c3db7edb7cc03f5b3090f91fabc26d2ad9bc5
review_loop_iteration: 0
context:
  - /home/delorenj/code/33GOD/flume/_bmad-output/specs/spec-flume-29-named-specialists/SPEC.md
  - /home/delorenj/code/33GOD/flume/_bmad-output/specs/spec-flume-29-named-specialists/specialist-charters.md
---

<frozen-after-approval reason="The operator approved the FLUME-29 capabilities and projection choices, then explicitly requested implementation on October 5, 2026">

## Intent

**Problem:** Portable employee definitions validate, but hiring and Hermes projection still require an owning repository. Big Chungus and the n8n specialist cannot carry their declared charter, skills and personal memory into an arbitrary working directory.

**Approach:** Connect the existing definition and Skillex APIs to hire, convergent onboarding and a Hermes CLI launcher. Keep one authored definition in the workforce desk, generate the named Hermes profile, and prove the inaugural employees through the same path.

## Boundaries & Constraints

**Always:** Preserve all six capabilities in the approved companion spec. Definitions live at `~/.agents/workforce/<id>/agent.yaml`; real generated profiles live at `~/.hermes/profiles/<id>`. Reuse the named-agent schema, shared identity validator, desk provisioner and strict role-selection APIs. Canonical template code owns profile/config/memory rendering and uses the existing profile lock before reading mutable state. Registry changes reuse the existing locked, comment-preserving atomic writer. Separate portable employment from project binding explicitly. Preserve unrelated rows, comments, settings and handwritten content. Validate definition, catalog selection, ownership and paths before effects; report partial failure honestly. Hermes CLI retains the caller's requested directory. Big Chungus is `infra-specialist`, with own bank `agent-infra-specialist`; the other employee is `n8n-specialist`. The provider writes only the own bank; charter and configuration list only declared recall banks plus that implicit own bank.

**Never:** Fabricate repo/project identity, copy skill payloads, create a profile `.agents` discovery root, or enable external/bundled skill discovery. Never overwrite an occupied identity or silently adopt an unrelated profile. Do not migrate repository PMs, enable Bloodbank dispatch or cron, mint AutomaticAI member tokens, or resolve/store credentials in files. Inference must use the employee's own existing vaulted member token; missing access is an explicit deployment dependency. Preserve the canonical template's unrelated project-skills WIP. Commit/push reviewed components and parent pointers; remove completed worktrees/branches.

## I/O & Edge-Case Matrix

| Scenario | Expected behavior |
| --- | --- |
| Valid definition, no repo | Hire creates owning desk, strict profile and record, without a project binding |
| Invalid identity/catalog/unsafe path or occupied employee | Refuse before replacing existing state |
| Changed charter/loadout/recall banks | Onboard updates owned projections; a second pass changes no managed bytes or receipts |
| Unrelated handwritten files/settings/registry rows | Preserve them or refuse an ownership conflict |
| Arbitrary working directory | Launcher selects the named profile and charter, preserves CWD and uses the same bank/loadout |
| Missing token/runtime or failed projection | Truthful refusal/dependency/partial result; no fabricated live success |

</frozen-after-approval>

## Code Map

- `packages/flume-hr/src/index.ts`: current repository hire/onboard command registration; add definition routing, employee launch and scoped audit without changing existing defaults.
- `packages/flume-hr/src/workforce/{validator,identity,desk,selection,types}.ts`: existing contract, stable banks, canonical links and strict selection; reuse rather than fork.
- `packages/flume-hr/src/hire/PreserveRegistryComments.ts`: existing registry serialization and atomic publication primitives.
- `packages/flume-hr/src/org/inventory.ts` and `contracts/handbook.yaml`: declare specialist employment provenance and avoid inventing project correlation.
- `templates/hermes-agent/scripts/hermes-profile-config.py` and `template/.scripts/lib/profile-config-lock.py`: existing renderer and lock; add an additive specialist projection adapter in the canonical template.
- `tests/named-agent-contract-regressions.*` and `tests/role-hire-regressions.mjs`: established isolated catalog/home fixtures and actual CLI execution patterns.

## Tasks & Acceptance

**Execution:**
- [x] `packages/flume-hr/src/workforce/specialist.ts` and `index.ts` — validate, hire, refresh, audit and launch a portable definition using existing domain APIs.
- [x] `templates/hermes-agent/scripts/hermes-specialist-profile.py` and template tests — render owned charter/config/memory/profile metadata safely and deterministically; keep unrelated template WIP untouched.
- [x] `contracts/handbook.yaml` and `org/inventory.ts` — project explicit specialist records with no fake repository or board.
- [x] `examples/employees/` and `docs/named-specialists.md` — supply both inaugural definitions and documented commands; select existing canonical infrastructure/n8n skills through reference-only Skillex composition.
- [x] `tests/specialist-hire-regressions.mjs` and `scripts/run-tests.mjs` — exercise actual built CLI, refusal, refresh, comments, concurrency/ownership, strict skills and arbitrary-CWD launch.
- [ ] `_bmad-output/implementation-artifacts/FLUME-29/` — capture separate source, installed-profile, launch and memory evidence; review, integrate, push and verify vault copies.

**Acceptance Criteria:**
- Given either approved definition with no project fields, when actual hire runs, then its owning desk, named strict profile and employee record agree on identity, charter, resolved skills and bank.
- Given a changed owned definition, when onboarding runs twice, then the intended projections update once while unrelated state survives and the second pass is unchanged.
- Given an unrelated directory, when its launcher invokes Hermes CLI, then actual runtime discovery sees the employee charter and exact loadout, and attributable memory proof concerns only its own write bank and declared recall scope.
- Given unavailable employee inference access, when launch is requested, then deployment dependency is recorded distinctly from fixture or profile acceptance.

## Implementation Notes

Source implementation is assigned through BMAD; the parent owns operator deployment and live acceptance. Use the clean nested template checkout or an isolated checkout for additive template code, preserving the unrelated project-skills WIP in the canonical working directory. Operator approval already covers the confirmed specialist design and this implementation run.

Source is ready for parent integration and independent review. The dashboard deployment blocker is covered by an owned disabled/empty profile projection; the shared base is unchanged. Launch honors the trusted declared Hermes runtime and refuses unavailable pins. Parent owns the reference-only Skillex catalog commit `db98edb`, installation, runtime inspection and live acceptance. Both employees currently lack their own AutomaticAI member token, so FLUME-39 remains an explicit deployment dependency. Source verification is recorded in `FLUME-29/source-verification.md`; the combined operational evidence task remains open.

## Spec Change Log

## Review Triage Log

## Verification

- Run typecheck/build and the new specialist suite plus affected named-agent, role-selection, registry and inventory/contract regressions. Compare broader results to the preserved fleet-status baseline; do not weaken that assertion.
- Run canonical template adapter tests, including locked caller contention and no-op refresh.
- Inspect real profiles and Skillex receipts; perform bounded employee-owned Hermes CLI/memory proof when its token exists. Never substitute a global token or fixture receipt.
- Verify owned Git state, pushed main revisions, removed temporary branches/worktrees and source/vault document content hashes.
