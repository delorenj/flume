# FLUME-32 worker handoff — 2026-10-05

Status: DONE_WITH_CONCERNS

The worker implementation and targeted verification are complete. Independent review, integration and combined verification against parent main remain with the parent. No push, merge or rebase was performed.

## Scope and commits

- Worktree: `/home/delorenj/code/33GOD/flume/.worktrees/flume-32-hire`
- Branch: `feat/flume-32-hire-proof`
- Baseline: `2034f78322b89af2b74db69bb182085a6966c20f`
- Tested template: `97f9ff82e087dad3273c5cc596feac6b39f2c370`; neither its checkout nor the gitlink was changed.
- Parent main reported by the user: `73c4906`, template pin `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`. This worker did not update to it.

Commits, in order:

1. `ab2190a0b65a4834efd1cdff1093d45f22872534` — FLUME-32: exercise real CLI and Copier hire in scratch fixtures
2. `9f3d831ce332738bc07fcb9b216345010f61a964` — FLUME-32: complete declared role hire and preserve local state
3. `aa5663f5831d9ac73b138e4685a59801fc92b64c` — FLUME-32: record actual hire proof and scoped verification
4. `f60771cf6d9fce5a7672b1dec71bced6570732cd` — FLUME-32: cite recovered live fallback receipt with exact scope
5. `3aed8a3d1ffa92d8dc686c092d8e0f7d4b3c466b` — FLUME-32: fix reviewed registry and role projection defects

The review fixes are saved in the single final checkpoint above. Its eight changed paths are `packages/flume-hr/src/hire/PreserveRegistryComments.ts`, `packages/flume-hr/src/hire/RunCopierTemplate.ts`, `packages/flume-hr/src/hire/ProjectRoleDeclaration.ts`, `packages/flume-hr/src/workforce/role.ts`, `tests/role-hire-regressions.mjs`, `tests/registry-comments-regressions.mjs`, `scripts/run-tests.mjs`, and `_bmad-output/implementation-artifacts/FLUME-32/evidence.md`.

Final worker checkpoint: clean tracked/untracked status; all scoped edits committed. `git unpushed` reports unrelated repository work plus the worker's intentionally local branch; no global-clean claim is made and that other work was left untouched.

## Changed paths

All tracked paths below are relative to the worker worktree:

| Path | Change |
| --- | --- |
| `tests/role-hire-regressions.mjs` | Built CLI and real Copier regression, now 19 groups covering hire, onboarding, preflight refusal, parser consumption, symlink safety, base growth and operator overrides. |
| `tests/registry-comments-regressions.mjs` | New focused suite: 25 groups covering canonical parser semantics, aliases/list comments, concurrent writers, atomic publication, permissions and failure safety. |
| `scripts/run-tests.mjs` | Registers the regression without changing typecheck/build gate order or quarantine behavior. |
| `packages/flume-hr/src/hire/ValidateHermesOptions.ts` | Uses existing declaration and Skillex validation before provisioning. |
| `packages/flume-hr/src/hire/PreserveRegistryComments.ts` | Uses the canonical template fleet parser, transfers comments into the authoritative latest YAML AST, and publishes atomically under the existing registry lock. |
| `packages/flume-hr/src/hire/RunCopierTemplate.ts` | Awaits locked snapshot/restoration around Copier; refuses invalid fleet data before render directories or Copier. |
| `packages/flume-hr/src/hire/ProjectRoleDeclaration.ts` | Exclusively creates temporary deltas; records complete inherited Bloodbank restrictions while preserving authored overrides under the existing profile lock. |
| `packages/flume-hr/src/workforce/role.ts` | Exports the existing registry lock helper for reuse. |
| `packages/flume-hr/src/hire/HireRecipe.ts` | Explicitly defers the host automatic Skillex resync postcondition for local deployment. |
| `_bmad-output/implementation-artifacts/FLUME-32/evidence.md` | Corrects stale AC status, preserves historical evidence, and documents actual hire execution and remaining parent work. |

Supplemental artifacts outside Git:

- `/tmp/flume-orch/flume32-report.md` — this handoff.
- `/tmp/flume-orch/flume32-after.log` — final checkpoint and exact post-review three-suite output; explicitly scoped to affected tests.
- `/tmp/flume-orch/flume32-review-targeted.log` — exact final focused test output.
- `/tmp/flume-orch/flume32-after-initial.log` — preserved initial seven-suite and deployment outputs.
- `/tmp/flume-orch/flume32-review.diff` — the complete worker diff from the baseline, for independent review.
- `/tmp/flume-orch/flume32-unpushed.log` — read-only global checkpoint audit; unrelated repositories/worktrees were not changed.

## What the hire run actually executed

Each successful fixture creates a scratch Git project named `demo`, an isolated HOME/fleet/XDG state, a scratch template config and a real Skillex catalog. The child environment is allowlisted. Credential, network and service commands have failing sentinels; none was invoked. No chain is declared, so no authenticated gateway catalog check or inference occurs.

1. Execute the built `packages/flume-hr/dist/index.js hire dev --yes --skip-telegram --skip-plane --local` from the scratch project.
2. Resolve identity/defaults, validate the role declaration and loadout, and read the scratch template configuration.
3. Invoke the actual installed Copier with `copy <original vendored template> <scratch project>/agents/hermes/dev --trust --vcs-ref=HEAD --defaults` and the normal data arguments. The wrapper only records argv and forwards the real exit status.
4. Copier launches all 13 configured tasks: chmod, banner, config, fleet env, profile, runtime, Telegram, Slack, ticket provider, Bloodbank, systemd, registry and summary. Host/channel setup follows the flags' explicit skip/defer paths. The config/fleet/profile/runtime/registry tasks execute, with completion markers asserted.
5. Profile provisioning starts from project skills `deploy, lint`. Only the external Hermes profile-create command is simulated; actual Skillex sync and canonical renderer calls execute. The runtime task calls the built Flume CLI for real runtime-singleton preview and apply.
6. After Copier, project the declared role selection and organization, apply the scoped contributor Bloodbank list patch, and complete the real final hire audit. The fleet base is unchanged.
7. Assert the strict desk has exactly global `global` plus declared `build, review`, symlinks resolving into the scratch catalog, strict markers, `skills.external_dirs: []`, no desk `.agents`, and a receipt recording the role-owned selection project. Registry/org retain every fixture comment, unrelated employees, department and reporting information.
8. Run actual built `onboard dev --target-repo demo --skip-telegram --skip-plane --local` twice. Snapshot comparisons require identical regular-file bytes and identical symlink targets/inodes, covering registry, org, template config, the desk, the project and the Skillex receipt. Unrelated usage/runtime notes survive. Copier is not rerun.
9. Attempt another unforced noninteractive hire; it exits nonzero before Copier and preserves the complete snapshot.

The sequence runs once with `skills: {set: dev-set}` and once with `skills: {pack: dev@1.0.0}`. Additional fixtures prove an unresolved set and incompatible packs fail by name before config/profile/receipt writes. A missing owning-project selection triggers an actual Copier step-10 failure; the CLI exits nonzero, reports its cause, and never claims successful completion.

The initial suite had nine assertion groups; the reviewed suite now has 19. It exercises real hire, not a helper substitute. The Hermes process itself, service activation and inference are outside this fixture's proof.

## Defects found and fixed

- Loadout errors were discovered after provisioning began. Validation now precedes config and Copier writes, using the existing declaration/selection APIs.
- The original template's PyYAML registry rewrite removed comments. Flume preserves the original document's comments while retaining the values the template wrote.
- New declared contributors inherited PM delegation/terminal/file permissions from the fleet base, so the final audit failed. A scoped renderer list patch removes inherited permissions, preserves explicit desk configuration and leaves the fleet base unchanged.
- Local hire required the host Skillex resync service/record despite explicitly local deployment. Only the local hire postcondition is now deferred and named in the summary; ordinary audits retain it.
- The initial new test incorrectly required unchanged regular-file inodes. The renderer atomically replaces generated config with identical bytes, which meets the spec; the snapshot now compares file bytes and still checks strict skill-link identities.

## Verification actually executed

Final review checkpoint: `node scripts/run-tests.mjs role-hire registry-comments role-projection` — typecheck/build PASS, 3/3 suites PASS, zero failures or quarantines (27.1 seconds). Exact output is saved in `/tmp/flume-orch/flume32-review-targeted.log` and `/tmp/flume-orch/flume32-after.log`. No full suite or live gateway proof was repeated after the review fixes.

The following results are initial verification before review corrections:

- Full pristine baseline: `node scripts/run-tests.mjs`, captured in `/tmp/flume-orch/flume32-baseline.log`; typecheck/build PASS, 21 suites attempted, 20 PASS / 1 FAIL (701.6 seconds).
- Real-hire target: `node scripts/run-tests.mjs role-hire`, captured in `/tmp/flume-orch/flume32-hire-green.log`; typecheck/build PASS and real-hire suite PASS (21.3 seconds).
- Required targets: `node scripts/run-tests.mjs role-hire role-projection role-selection role-contract named-agent hermes-profile-inheritance`, captured in `/tmp/flume-orch/flume32-selected.log`; typecheck/build PASS, 7/7 suites PASS (100.4 seconds).
- Existing deployment guards: `node scripts/run-tests.mjs pjan-86`, captured in `/tmp/flume-orch/flume32-deploy-check.log`; typecheck/build PASS, 1/1 suite PASS (12.6 seconds).
- `/tmp/flume-orch/flume32-after-initial.log` preserves the exact seven-suite and deployment outputs above. The current `/tmp/flume-orch/flume32-after.log` instead records the final focused review check.
- `git diff --check`: PASS. The worker template is clean; comparison against baseline shows no template/gitlink change.

No full after run was repeated, following the user's direction to leave combined verification against the new canonical template pin to the parent. No failing suite was quarantined or hidden. Initial verification covered eight targeted suites; final post-review verification covered only the three affected suites. The table records initial results except role-hire and role-projection, which also passed at the final checkpoint.

| Suite | Worker full baseline | Worker after |
| --- | --- | --- |
| engagement-regressions | PASS | Not rerun; parent combined run |
| fleet-shared-bloodbank-regressions | PASS | Not rerun; parent combined run |
| hermes-profile-inheritance-regressions | PASS | PASS |
| pjan-48-regressions | PASS | Not rerun; parent combined run |
| fleet-contract-regressions | PASS | Not rerun; parent combined run |
| fleet-inventory-regressions | PASS | Not rerun; parent combined run |
| fleet-provenance-regressions | PASS | Not rerun; parent combined run |
| fleet-status-regressions | FAIL | Not rerun; parent combined run |
| fleet-health-regressions | PASS | Not rerun; parent combined run |
| fleet-scaffold-regressions | PASS | Not rerun; parent combined run |
| soul-project-bank-regressions | PASS | Not rerun; parent combined run |
| named-agent-regressions | PASS | PASS |
| role-projection-regressions | PASS | PASS |
| role-selection-regressions | PASS | PASS |
| role-hire-regressions | New suite | PASS |
| role-contract-regressions | PASS | PASS |
| named-agent-contract-regressions | PASS | PASS |
| fleet-profile-regressions | PASS | Not rerun; parent combined run |
| fleet-systemd-regressions | PASS | Not rerun; parent combined run |
| pjan-86-hermes-deploy-regressions | PASS | PASS |
| skillex-only-config-regressions | PASS | Not rerun; parent combined run |
| skillex-resync-regressions | PASS | Not rerun; parent combined run |

The baseline's sole failure is `fleet-status-regressions`: "the nine status domains are not the contract's three policy_domains". The supplied historical `/tmp/flume-orch/flume15-baseline.log` had 19/21 PASS and also a live `fleet-profile` observation failure. `fleet-profile` passed in this worker's pristine run. These existing findings were not repaired in this unit.

## Review corrections

- Registry path resolution invokes the canonical template fleet parser, retaining supported expansion, quoting, inline-comment and precedence semantics, and refusing invalid data.
- The immutable before AST supplies comments; the latest after AST retains its values, anchors and alias identities. Surviving reordered list items and concurrent comment blocks retain their comments.
- Registry restoration holds the existing lock across latest read and exclusive temporary-file flush/atomic rename/directory flush. The lock is released before Copier's own locked writer. Concurrent employee values and comments survive; a pre-publication flush failure preserves the current registry.
- Contributor deltas use `tempfile.mkstemp` in the profile directory and atomic replacement. A pre-existing fixed-name symlink and its unrelated target remain unchanged.
- Generated removals always include `delegation`, `terminal`, and `file`; later fleet-base growth cannot restore them. Operator-authored direct lists and list patches remain byte-identical through onboarding.
- Actual hire/onboard cases prove reporting/routing preflight refusal before provisioning, explicit Bloodbank overrides, fleet parser consumption, symlink safety and later base growth. The new registry suite proves aliases/list comments, concurrent writers, reader-visible atomic publication, permission preservation under restrictive umask and failure safety.

## Concerns and remaining work

- Independent review is pending with the parent. No independent reviewer result is claimed; the review diff is ready.
- Parent must integrate and run combined suites against template `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`, including assessing whether its registry preservation supersedes the compatibility wrapper for the original pin. This worker's results establish only the original-pin unit.
- The new hire regression is hermetic; pre-existing selected `role-projection` coverage still reads the host base configuration/routes as fixtures. That distinction is preserved rather than claiming all existing suites are hermetic.
- The focused registry suite now covers concurrent writers, retained concurrent comments and atomic publication. Real Hermes profile creation is simulated in hire fixtures; the actual runtime/gateway is not started.
- AC-6 already passed for scope `PASS_SEAM_ONLY`; its parent-owned artifact is `/home/delorenj/code/33GOD/flume/_bmad-output/implementation-artifacts/FLUME-32/live-fallback-20261005.json`, read and verified without editing. Recovered from rollout `01a0fd4b-f4df-7851-91ec-9b467ef27325` at `2026-10-05T03:50:24.398Z`, marker `AAI_ROUTE_PROOF_5dfa0cf0a9e5b690369021babc832429`, ledger `69879`, request `202610050350196487012018268d9d6Yv0xCfMk`, token name `aai:hermes-flume-pm:1790777406434714921`. The completed chain is sol-6.1 → glm-5.3 → kimi-2.8, with injected primary HTTP 503 at isolated Hermes transport and live fallback glm-5.3 on account `zai-personal`; requested/effective ledger effort is `max` (defaulted). It establishes authenticated live fallback/member attribution at the isolated seam, with multiplexed Bloodbank ingress outside its scope. No gateway call or fresh receipt was generated by this worker.
- No live profiles/services/Plane/vault/gateway, canonical dirty template checkout, main checkout or FLUME-15 worktree were modified. Worker commits intentionally remain unpushed for parent integration.
