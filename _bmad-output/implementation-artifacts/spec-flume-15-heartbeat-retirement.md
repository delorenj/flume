---
title: 'FLUME-15: retire heartbeat requirements from employee reviews'
type: enhancement
created: '2026-10-05'
status: in-progress
route: dispatch
baseline_commit: 2034f78322b89af2b74db69bb182085a6966c20f
review_loop_iteration: 0
context:
  - /tmp/flume-orch/flume15-brief.md
---

<frozen-after-approval reason="User approved the recovered implementation sequence on 2026-10-05">

## Intent

**Problem:** The handbook requires per-employee heartbeat services and timers even though the current runtime retires them. Reviews therefore report absent retired machinery as employee drift. The handbook, validator, and observer must describe the settled runtime model truthfully.

**Approach:** Advance the handbook to 1.5.0 and make the gateway the required employee unit. Remove heartbeat scheduling, activation, overdue, and registry requirements. Continue observing leftover heartbeat units as retired candidates so operators can identify cleanup work.

## Boundaries & Constraints

**Always:** Work only in the existing `.worktrees/flume-15` branch. Reuse existing unit observation and retired-candidate machinery. Preserve all non-heartbeat observations and uncertainty handling. Accept historical registry heartbeat fields without requiring them. Convert old heartbeat tests into useful retirement and gateway coverage. Compare verification to the saved baseline instead of treating existing live-state failures as new regressions. Commit scoped changes for independent parent review.

**Never:** Mutate operator profiles, services, Plane, gateway configuration, or vault items. Do not remediate live reviews. Do not edit `templates/hermes-agent` or its gitlink. Inspect the canonical template's current origin/main and write a precise follow-up proposal for any remaining header/status/registry leftovers; the parent will land that separately. Do not hide unrelated baseline failures or weaken tests to match incorrect behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Current employee | Gateway exists; heartbeat units and registry field absent | Review evaluates the gateway and produces no heartbeat-required finding | Failed gateway observations retain their existing verdict |
| Historical record | Registry still carries `systemd.heartbeat_timer` | Record loads and is reviewed without a heartbeat requirement | Other invalid registry fields keep their existing validation |
| Retired unit | A leftover employee heartbeat service or timer exists | Unit is surfaced as an unregistered retired candidate, with trustworthy observed state | Observation failures remain unable-to-assess |
| Contract validation | Handbook 1.5.0 contains only current per-employee gateway shape | Contract validates; retired candidates remain declared | A malformed current shape still fails validation |
| Live review | Read-only built review before and after | After result contains zero required-heartbeat findings | Preserve and report unrelated findings and observation limits |

</frozen-after-approval>

## Code Map

- `contracts/handbook.yaml`: version, lifecycle writable fields, service model, old schedule block and supersession references.
- `packages/flume-hr/src/org/contract.ts` and `types.ts`: schema validation, allowed keys, and result shapes.
- `packages/flume-hr/src/org/systemd.ts`: derived required names, activation/schedule/overdue evaluation, registry requirements, and retired-unit sweep.
- `packages/flume-hr/src/org/`: inventory, profile, output, and status consumers if needed for the changed model.
- `packages/flume-hr/src/parity/rules.ts`: current runtime compliance rules.
- `tests/fleet-systemd-regressions.mjs` and affected contract/inventory/scaffold/status/health/profile and PJangler suites: convert expectations while preserving other coverage.
- `/tmp/flume-orch/flume15-baseline.log`: pristine baseline, 19 of 21 suites pass; fleet-status and fleet-profile fail.

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/handbook.yaml` — advance to 1.5.0; retire heartbeat units and fields; remove obsolete schedule and supersession requirements.
- [ ] `packages/flume-hr/src/org/` and related parity/hire consumers — remove heartbeat requirements and evaluations while preserving retired-unit detection and historical record compatibility.
- [ ] `tests/` — convert heartbeat coverage; prove gateway-only employee requirements, retired-unit reporting, and compatibility.
- [ ] `/tmp/flume-orch/flume15-template-followup.md` — describe any template leftovers after checking canonical origin/main.
- [ ] `/tmp/flume-orch/flume15-live-review.json` — save read-only before/after counts and concise samples.
- [ ] `/tmp/flume-orch/flume15-report.md` — record commits, paths, exact verification, baseline comparison, and remaining concerns.

**Acceptance Criteria:**
- Given a valid employee with only its gateway unit, when the handbook is validated and the employee reviewed, then no heartbeat service, timer, schedule, or tick is required.
- Given a historical heartbeat registry field, when inventory and review load the record, then that field does not cause failure.
- Given a leftover heartbeat unit, when the observer sweeps unregistered units, then the unit remains visible as retired machinery.
- Given the saved baseline, when typecheck, build, and all suites execute, then no previously passing suite regresses and all heartbeat-required expectations are replaced by retirement expectations.
- Given the live inventory, when the built review runs read-only, then zero required-heartbeat findings remain and unrelated findings are reported honestly.

## Implementation Notes

Retirement is already decided: gateway restart handles runtime liveness, Bloodbank scheduling and Krebs leases own their existing responsibilities. This change synchronizes the workforce contract and observer with that decision. The saved brief supplies exact locations and execution instructions; its parent-level push restriction applies only to the worker, while the orchestrator lands reviewed changes on main.

## Spec Change Log

## Review Triage Log

## Verification

- `node scripts/run-tests.mjs` — typecheck/build hard gates and baseline comparison.
- Read-only `node packages/flume-hr/dist/index.js review --domain systemd --json` before/after; never remediate.
- `git diff --check` — scoped, whitespace-clean commits for independent review.
