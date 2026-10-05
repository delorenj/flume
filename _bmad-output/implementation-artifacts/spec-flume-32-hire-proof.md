---
title: 'FLUME-32: prove the real hire path for a declared role'
type: bugfix
created: '2026-10-05'
status: done
route: dispatch
baseline_commit: 2034f78322b89af2b74db69bb182085a6966c20f
review_loop_iteration: 0
context:
  - /tmp/flume-orch/flume32-brief.md
---

<frozen-after-approval reason="User approved resuming the recovered Flume implementation plan on 2026-10-05">

## Intent

**Problem:** FLUME-32 has helper and onboarding coverage, but no regression proves a new employee reaches the real Copier hire path with the declared skills, department, and manager. A successful helper call cannot establish that provisioning order or the final hire audit works.

**Approach:** Exercise the built `flume hire` command against the actual vendored template in an isolated repository, home, and Skillex catalog. Fix Flume-owned defects revealed by that run and prove subsequent onboarding converges.

## Boundaries & Constraints

**Always:** Resume `/home/delorenj/code/33GOD/flume/.worktrees/flume-32-hire`. Use scratch HOME, registry, org, config, state, and project paths for fixtures. Preserve strict Skillex selection ownership, comment-preserving organization projection, all unrelated data, and refusal of occupied desks. Keep credentials out of files and output. Reuse the existing fixture-backed renderer and selection APIs.

**Never:** Modify the operator's employee profiles, running services, gateway, Plane, vault items, the template submodule, or its gitlink. Never replace actual hire with a helper invocation or fake a successful Copier run. Do not restart a gateway for the already-recorded AC-6 proof. If the template cannot support hermetic paths, report its precise boundary rather than writing through to the real host.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| New role | Scratch Git project, actual Copier template, valid role set or pack, department and manager | Built CLI completes provisioning and declaration; strict desk contains exactly the resolved role selection; registry and org preserve comments | A failed phase exits nonzero and identifies its cause |
| Repeat onboarding | Previously hired role and unchanged declaration | Built `onboard --target-repo` preserves registry, org, config, selection, and receipt bytes | An unsupported host effect is deferred explicitly |
| Occupied role | Existing rendered role directory | Unforced noninteractive hire refuses replacement and preserves contents | No destructive render |
| Invalid loadout | Unresolvable declared set or incompatible pack selection | A named validation failure; no unintended profile or host writes | No fabricated skill directory or discovery root |

</frozen-after-approval>

## Code Map

- `packages/flume-hr/src/hire/HireRecipe.ts`: actual ingredient order, deferred host effects, existing onboarding, and final audit.
- `packages/flume-hr/src/hire/RunCopierTemplate.ts`: trusted template invocation and child environment.
- `packages/flume-hr/src/hire/ProjectRoleDeclaration.ts`: declaration projection after the template creates the desk.
- `packages/flume-hr/src/workforce/role.ts` and `selection.ts`: reuse declaration and Skillex APIs.
- `tests/role-selection-regressions.mjs`: existing hermetic catalog, renderer, and convergence fixtures.
- `templates/hermes-agent/template/.scripts/10-hermes-profile.sh`: actual strict profile setup, read-only in this work unit.
- `scripts/run-tests.mjs`: suite registration, typecheck, build, and test isolation.

## Tasks & Acceptance

**Execution:**
- [x] `tests/role-hire-regressions.mjs` — add the real CLI/Copier hire regression, strict loadout checks, and repeat-onboarding proof.
- [x] `scripts/run-tests.mjs` — register the new suite; preserve the existing gate order.
- [x] `packages/flume-hr/src/hire/` — fix only the Flume-owned behavior demonstrated to be wrong by the regression.
- [x] `_bmad-output/implementation-artifacts/FLUME-32/evidence.md` — correct stale acceptance status and add reproducible hire evidence; preserve recorded member-attributed AC-6 evidence.
- [x] `/tmp/flume-orch/flume32-report.md` — record changes, actual execution, test results, and unresolved boundaries.

**Acceptance Criteria:**
- Given a fresh scratch repository and valid declared role, when the built CLI runs `hire dev --yes --skip-telegram --skip-plane --local`, then actual Copier tasks and declaration projection complete and the expected employee profile is verifiably strict.
- Given that hired employee, when onboarding runs twice, then the role-owned state converges without deleting comments, unrelated state, or prior manager/department information.
- Given the isolated fixture, when hire and onboarding execute, then no production state, credential, service, or network inference is used by the test.
- Given the baseline's two known live-observation failures, when the appropriate role suites and final full suite execute, then no previously passing suite regresses.

## Implementation Notes

The saved brief confirms the onboarding flag fix and live AC-6 proof are already complete. The old worker stopped during startup; its clean worktree contains no additional implementation to recover. The user approved continuing the recovered plan, including normal review and integration.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route | Verified evidence |
|---|---|---|---|
| B1 | high | patch | Supported fleet-home expansion and quoted comments become literal paths; parent reproduced the variable path and checked the canonical parser tests. |
| B2 | medium | patch | Parent reproduced an unresolved old alias after a changed anchored list; reconciliation mutates the alias resolution document. |
| B3 | low | patch | Parent reproduced deletion of a comment on the surviving general sequence item; direct comment-transfer correction is appropriate. |
| B4 | high | patch | The restoration read and write have no registry lock after Copier releases its own lock; a concurrent registration can be overwritten. |
| B5 | high | patch | The live shared registry is written with truncating writeFileSync; interruption can replace valid YAML with a partial document. |
| B6 | medium | patch | The generated removal patch contains only tools present at creation; its later existence skips restriction after base tools grow, causing onboarding audit failure. |
| B7 | medium | patch | The reviewed test verifies inherited permissions only; explicit list and list-patch preservation are unprotected at the new onboarding consumer. |
| V1 | medium | patch | Pre-verified gap: invalid reporting or routing is covered at helpers/audit, not the new hire preflight before Copier effects. |
| V2 | medium | patch | Pre-verified gap: an unconditional restriction would strip operator-owned Bloodbank permissions while current hire fixtures remained green. |
| V3 | high | patch | Same verified literal fleet-home path as B1; pinning the wrong value propagates it into actual Copier registry writes. |
| V4 | high | patch | Same verified unlocked restoration window as B4; template concurrency tests do not execute this added writer. |
| E1 | high | patch | Same verified unlocked restoration window as B4; shared-writer serialization must cover read through publication. |
| E2 | high | patch | Same verified supported expansion/comment grammar divergence as B1; reuse the canonical parser. |
| E3 | high | patch | The new fixed temporary filename is neither exclusive nor checked; write_text follows an existing symlink and os.replace moves that symlink into the delta path. |
| E4 | high | patch | Same verified truncation issue as B5; atomic replacement is needed to preserve the complete prior registry on write failure. |
| E5 | medium | patch | Parent reproduced an unresolved incoming alias when an equal retained node kept the old anchor name; keep the after document authoritative. |
| E6 | medium | patch | Same verified incomplete generated restriction as B6; storing the complete forbidden-tool removal keeps later base growth restricted. |

## Verification

- `node scripts/run-tests.mjs role-hire role-projection role-selection role-contract named-agent hermes-profile-inheritance` — typecheck/build and every selected suite pass.
- `node scripts/run-tests.mjs` — compare final results to `/tmp/flume-orch/flume15-baseline.log`; investigate any new regression without hiding it.
- `git diff --check` — no whitespace errors; commits remain reviewable in the existing worker branch until parent integration.

## Resolution and integration — October 5, 2026

All three independent review layers completed; every patch verdict above was resolved. The parser, immutable YAML comment transfer, locked atomic registry publication, exclusive delta temporary files, inherited permission restrictions and operator override preservation are covered by the actual CLI/Copier and registry regressions. Reviewed hire source landed and was pushed on main through `3630ca8f3f9b81712ca013a616159a41bd742cdb`.

Combined Flume main at `c48ee0242007880c397917266b4107d2b669f938`, with canonical template `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`, passed typecheck/build and 22 of 23 suites. All previously passing suites remain passing. The full run's fleet-status repository snapshot assertion observed the parent's concurrent documentation commit; the isolated rerun passed that no-write assertion and retained only the pre-existing policy-domain assertion. No test was quarantined or authority contract weakened. Logs: `/tmp/flume-orch/main-combined-verification.log` and `/tmp/flume-orch/main-fleet-status-isolated.log`.

The completed hire worktree and feature branch were removed after integration. AC-6 remains `PASS_SEAM_ONLY`; its retained matching request does not prove multiplexed Bloodbank ingress. Current evidence and delivery limits are recorded in `FLUME-32/evidence.md` and `recovery-delivery.md`.
