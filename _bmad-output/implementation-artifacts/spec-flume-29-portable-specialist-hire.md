---
title: 'FLUME-29: hire and carry a named specialist between working directories'
type: feature
created: '2026-10-05'
status: done
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
- [x] `_bmad-output/implementation-artifacts/FLUME-29/` — capture separate source, installed-profile, launch and memory evidence; review, integrate, push and verify vault copies.

**Acceptance Criteria:**
- Given either approved definition with no project fields, when actual hire runs, then its owning desk, named strict profile and employee record agree on identity, charter, resolved skills and bank.
- Given a changed owned definition, when onboarding runs twice, then the intended projections update once while unrelated state survives and the second pass is unchanged.
- Given an unrelated directory, when its launcher invokes Hermes CLI, then actual runtime discovery sees the employee charter and exact loadout, and attributable memory proof concerns only its own write bank and declared recall scope.
- Given unavailable employee inference access, when launch is requested, then deployment dependency is recorded distinctly from fixture or profile acceptance.

## Implementation Notes

Source implementation is assigned through BMAD; the parent owns operator deployment and live acceptance. Use the clean nested template checkout or an isolated checkout for additive template code, preserving the unrelated project-skills WIP in the canonical working directory. Operator approval already covers the confirmed specialist design and this implementation run.

Source implementation and parent integration are reviewed and verified. The dashboard deployment blocker is covered by an owned disabled/empty profile projection; the shared base is unchanged. Launch honors the trusted declared Hermes runtime and refuses unavailable pins. Parent owns the reference-only Skillex catalog commit `db98edb`, installation, runtime inspection and live acceptance. Both employees currently lack their own AutomaticAI member token, so FLUME-39 remains an explicit deployment dependency outside this implementation. Source verification is recorded in `FLUME-29/source-verification.md`; the combined operational evidence task is complete, with inference acceptance explicitly dependent on FLUME-39.

Integration follow-up owns profile `skills.inherit_global: false` and uses normal Skillex home/state context, replacing the temporary desk-home override. A standalone normal-home CLI regression verifies unchanged exact loadouts after both hire and refresh. Parent owns the additive Skillex policy implementation, installation and reviewed dependency pin in `packages/flume-hr/package.json` plus `package-lock.json`. Specialist Hindsight recall defaults to world/experience/observation through `setdefault`, preserving explicit operator recall-type overrides. Parent owns the resulting operational proof reruns.

## Spec Change Log

## Review Triage Log

All three independent layers completed before triage. Each finding received its own verdict before grouping. All accepted corrections stay inside the approved intent and add no CLI surface. B1/E2, B2/E4, B4/E5 and B6/E6 share root causes; the other accepted findings remain separate. The parent owns B9 in Skillex; the original implementation agent owns the Flume/template patches and targeted tests.

| Finding | Verdict | Route | Verified evidence |
| --- | --- | --- | --- |
| B1 | high | patch | index.ts:108 and specialist.prepare use the definition ID to choose the owning desk; the requested --employee ID is never bound, so A can route into existing B before ownership checks. |
| B2 | medium | patch | Adapter publication writes SOUL.md before its new receipt; the next pass compares the new charter with the old receipt digest and refuses its own interrupted write. Recoverable owned publication needs an internal pending receipt. |
| B3 | medium | patch | The launcher checks complete long option spellings, while the pinned Hermes argparse parser accepts long-option abbreviations. --prov reaches provider selection unless the existing override guard recognizes prefixes. |
| B4 | medium | patch | The owned provider projection sets route and key fields but leaves inherited providers.automaticai.enabled=false untouched; the native resolver can ignore the required provider despite a clean audit. |
| B5 | medium | patch | ownership accepts a pending desk marker when the record exists, and audit does not check its status. Pending completion must fail audit/launch; onboarding must retain its recovery path and account for completion writes. |
| B6 | medium | patch | provisionDesk writes contract.yaml separately from its skill counters. Specialist changed and audit omit this projection, so deleting or changing only that contract is silently repaired with changed=false. |
| B7 | medium | patch | Supported role_dir, plane binding and systemd binding fields are absent from portable ownership/audit checks even though the profile has no project posting or expected units. Contradictory portable bindings need an explicit refusal/diagnostic while unrelated extensions remain preserved. |
| B8 | medium | patch | refuse_credentials only traverses merged YAML; the separately loaded Hindsight object is preserved and serialized without that check. A raw memory api_key can therefore be republished before any refusal. |
| B9 | medium | patch | Skillex profileInheritsGlobal now checks config regularity for every profile. Before this change, non-strict profiles did not inspect that file; a valid linked legacy config now exits REFUSED. Keep strict generated profiles regular while allowing ordinary linked regular-file configuration. |
| B10 | false | reject | The native recall tool is intentionally pinned to the personal bank, and declared additional banks remain available through the established Hindsight CLI within the charter scope. The frozen spec requires the provider write pin plus declared recall metadata, and acceptance explicitly disclaims automatic native fan-out. The claim that this change promises native multi-bank fan-out is disproved by the approved projection contract and documented evidence boundary. |
| E1 | high | patch | Skillex locateProfile(default) aliases the fleet root, whereas specialist.prepare chooses profiles/default. A valid default identity can pass occupation checks and route skill publication into the built-in profile. Refuse this reserved identity before effects. |
| E2 | high | patch | The requested employee path is chosen in index.ts but prepare selects ownership from the YAML ID; this is the same verified cross-employee routing defect as B1. |
| E3 | medium | patch | profileOwnership passes SelectionContext.skillexRoot directly to showProfile, whose option is registryRoot. Other selection helpers translate this property; this preflight can therefore rediscover a foreign CWD catalog without the environment override. |
| E4 | medium | patch | The adapter publishes managed files before its receipt; the old SOUL hash rejects the partially published charter on retry, confirming the same interruption root cause as B2. |
| E5 | medium | patch | The adapter has no owned enabled field for AutomaticAI, leaving an inherited false value effective. This confirms the same disabled-provider root cause as B4. |
| E6 | medium | patch | The contract writer changes bytes outside the counted skill operations, while audit does not inspect contract.yaml. This confirms the same missing-contract-accounting root cause as B6. |
| E7 | medium | patch | classifyPath checks directories only when directory=true; directory=false permits a directory or FIFO as an ok definition. The portable roster must mark non-regular definitions unusable without opening them. |
| V1 | medium | patch | Pre-verified mutation control removed the registry-memory comparison while all 28 specialist groups still passed. Add wrong write_bank and recall_banks cases that require mismatch diagnostics and launch refusal. |
| V2 | medium | patch | Pre-verified mutation control removed specialist-employment-invalid while all 28 groups still passed. The host inventory suite is gated/skipped, so isolated malformed portable provenance cases must exercise this diagnostic. |
| V3 | medium | patch | Pre-verified mutation control changed key_env to a stripped foreign key while all specialist and adapter tests passed. Assert AUTOMATICAI_GATEWAY_KEY and its matching employee-owned vault reference in generated provider configuration. |

## Verification

Parent review correction B9 is committed and pushed in Skillex at `d0e03253029328c4004bd832472ee7bff947e182`. The 27 profile-sync tests pass; the full gate passes lint/typecheck and 905 Node tests with one existing skip. Required push checks also pass 928 Python tests with five skips. The installed public CLI/API bundle is byte-identical to this reviewed build. Flume now pins this full revision in both dependency files. A clean install produces CLI/API bundles byte-identical to the reviewed build and installed public Skillex command.

- Run typecheck/build and the new specialist suite plus affected named-agent, role-selection, registry and inventory/contract regressions. Compare broader results to the preserved fleet-status baseline; do not weaken that assertion.
- Run canonical template adapter tests, including locked caller contention and no-op refresh.
- Inspect real profiles and Skillex receipts; perform bounded employee-owned Hermes CLI/memory proof when its token exists. Never substitute a global token or fixture receipt.
- Verify owned Git state, pushed main revisions, removed temporary branches/worktrees and source/vault document content hashes.

## Final review and integration result

All nineteen accepted findings are corrected in reviewed Flume source `f2e06fd0723689c06fc666ed162883651c08293c`, canonical template `adfccce324e22a93d446cedfb2df50b31850611f` and Skillex `d0e03253029328c4004bd832472ee7bff947e182`. B10 remains refuted on the documented native-tool recall boundary. No accepted review finding is deferred. Original individual triage rows above preserve the verified pre-fix defects.

| Corrected findings | Executed verification |
| --- | --- |
| B1, E2 | Requested employee remains bound after a definition is edited into a second hired identity; audit/onboard refuse without changing either employee. |
| E1 | Reserved default refuses before workforce or fleet effects. |
| E3 | Onboarding from a foreign catalog CWD uses the prepared home catalog without an environment override. |
| B2, E4 | Interrupted initial hire and refresh recover; dry-run preserves state. Template tests interrupt after each of seven managed files and refuse conflicting handwriting. |
| B3 | Full and abbreviated profile/provider/key/base-url overrides refuse before child launch. |
| B4, E5, V3 | Generated and installed profiles explicitly enable AutomaticAI, pin AUTOMATICAI_GATEWAY_KEY and contain only the matching employee-owned op reference. |
| B5 | Pending publication blocks audit/launch; marker-only completion counts a change and the next pass is unchanged. |
| B6, E6 | Contract drift fails audit/launch, is repaired with changed=true, and the second pass preserves bytes/mtimes. |
| B7 | Contradictory role/board/service bindings refuse while unrelated extensions survive. |
| B8 | Raw credentials in delta, profile and Hindsight objects refuse preview/publication without writes. |
| B9 | Ordinary linked configuration pointing to a regular file remains accepted; strict generated configuration still requires a regular file. |
| E7 | Directory/FIFO definitions are unusable in the public roster without opening the FIFO. |
| V1 | Wrong registry write_bank and recall_banks independently fail audit and launch. |
| V2 | Isolated public roster cases require malformed identity/profile/desk/definition provenance diagnostics. |

Final stable Flume typecheck/build pass; all 24 suites were attempted, 23 passed, and only the unchanged pre-implementation fleet-status policy-domains assertion failed. The suite's audit no-write checks pass. Canonical template adapter/locking/identity/Skillex coverage passes 67 tests. Skillex lint/typecheck and 905 Node tests pass with one existing skip; the required Python gate passes 928 tests with five skips.

Both installed employees pass scoped audits, unchanged second refresh, normal-home standalone Skillex inspection, pinned native charter/exact-loadout/own-bank discovery and native recall of the previously retained employee facts. Their public launchers refuse missing own tokens before chat inference. Definitions are published in the owning ~/.agents repository at `e151db7d6a08cac665d48a1f50c0ffd957bdc3c0`. No token was minted or borrowed. Final source/installed evidence is retained under FLUME-29 and copied to the AutomaticAI vault with document-body hash checks. Unrelated source files and staged parent work are preserved; final Git inventory distinguishes this delivery from other ongoing work.
