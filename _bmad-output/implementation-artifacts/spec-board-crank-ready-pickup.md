---
title: 'Board Cranker: pick up triaged Todo tickets under the existing Momo lease'
type: feature
created: '2026-10-05'
status: in-progress
route: dispatch
baseline_commit: 8d110b043b8908fc5196e7e0d84cfd57cfec70d6
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="User approved implementing the recovered unattended-pickup plan">

## Intent

**Problem:** Tickets created directly in Todo and subsequently marked `lifecycle:triaged` never emit the Todo transition expected by the current delegation workflow. Ready work sits idle. The existing Board Cranker contract (33GOD-47) calls for a bounded unattended Momo pass that reads current board truth and starts at most one ready item.

**Approach:** Add the deterministic control-pass adapter to canonical Momo, sharing its existing driver lease and delegating through the current Bloodbank Hermes command route. Persist dispatch intent and receipts outside source, wait only for started acknowledgement, and preserve the existing per-ticket implementation and independent review pipeline.

## Boundaries & Constraints

**Always:** Implement in `/tmp/momo-board-crank-20261005`, branch `feat/board-crank-ready-pickup`. Use current project manifest/Plane/runtime/registry truth. Reuse `skill/scripts/momo-wip-lock.py` and the current Momo lifecycle. Read/write Plane through Pilot's provider boundary, reusing its exported config and Plane APIs rather than implementing another credential or HTTP client. Use Bloodbank's canonical envelope builder, schema validation, and durable publisher from its existing source/built library; no copied envelope grammar or new subjects. Reload route eligibility before dispatch. Source roots may be supplied explicitly for Pilot/Bloodbank dependencies. All runtime journals, leases, receipts, and prompts containing execution state belong outside source or in the existing ignored runtime directory. Preserve raw credentials only in process memory. Commit scoped code for parent review; do not push until parent integration.

**Never:** Edit another repository, enable or replace live cron, modify operator tickets/services/profiles, steal a fresh lease, create a second PM/board driver, bypass managed or shadow Krebs ownership, write product code inside cron, or self-review. Do not call transport acknowledgement execution acceptance. Do not claim stateless contractor support is deployed: 33GOD-44/46/50 have unresolved prerequisites. Keep live activation gated on an explicit valid runtime/contractor configuration and fail closed when it is missing.

## I/O & Edge-Case Matrix

| Scenario | Expected behavior |
|---|---|
| Fresh shared driver lease or implementation WIP | busy; zero dispatch/ticket mutation |
| No ready candidate | idle; zero dispatch/ticket mutation |
| Two triaged Todo candidates | rank native priority, eligible cycle, dependency/critical-path readiness, age, stable ID; persist score; select at most one |
| Thin, untriaged, blocked/refining, unresolved dependency, parent epic | excluded with rationale; no invented readiness |
| Ready ticket created directly in Todo | eligible without historical transition event |
| Dispatch failure/timeout or unmatched receipt | leave ticket ready; retain durable uncertain intent; replay same command body rather than minting a second worker |
| Matching started acknowledgement | then enter exact In Progress and set missing start date, preserving assignees, existing date, labels, and unrelated content |
| Partial/ambiguous ticket mutation | read back before retry/compensation; persist truthful receipt; never overwrite later human changes blindly |
| Replay/next tick while execution pending or active | zero second worker, including after driver TTL expires or process restarts |
| Managed/shadow mode, ambiguous/ineligible route, missing runtime prerequisite | explicit refusal with zero publication/mutation |

</frozen-after-approval>

## Code Map

- `skill/scripts/momo-wip-lock.py`: authoritative shared per-board driver lease, short flock-protected acquisition and owner-safe release.
- `skill/scripts/momo-board.sh`: existing normalized board adapter; Plane writes go through Pilot.
- `skill/references/board-clearing-loop.md` and `delegation.md`: current single-worker lifecycle and distinct implementer/spec-reviewer/quality-reviewer contract.
- Pilot `src/config.js`, `src/plane.js`: current binding, vault resolution, pagination, and non-retrying mutation boundary. Read via CodeGraph before integrating exported APIs.
- Bloodbank `services/agent-hooks/core/envelope.py` and `integrations/n8n-nodes-bloodbank/src/nats.ts`: canonical builders and durable publish path; `src/fleet.ts` route rules and current prompts.
- Bloodbank gateway `adapter.py`: started lifecycle facts precede Hermes execution; journal dedup keys on command ID and exact envelope digest. Match command causation and target for receipts.

## Tasks & Acceptance

- [ ] `skill/scripts/momo-board-crank.*` and small supporting module(s) — bounded control-pass adapter with inspect/dry-run and execute modes, injection seams for fixture tests, durable journal/replay, shared lease, exact-lane readiness, deterministic ranking, command/receipt handling and guarded ticket transition.
- [ ] `skill/contracts/board.crank.v1.*` — versioned input/runtime/receipt contract; invocation carries contractor/version, project, ticket, workdir and explicit memory policy. Validate prerequisites before execution.
- [ ] `skill/references/board-clearing-loop.md` — document hourly adapter, normal pipeline delegation, independence, busy/refusal/uncertainty behavior, and deployment gate.
- [ ] `skill/scripts/tests/test_board_crank.*` — meaningful hermetic idle/busy/two-ready/unfortified/dependency/dispatch-failure/ack/replay/partial-write/mode/independence regressions. A fake transport must not count as live proof.
- [ ] `/tmp/flume-orch/board-crank-report.md` — full commit SHA, changed paths, exact tests and results, runtime deployment requirements, any acceptance gaps and concerns.

**Acceptance:** Given direct-in-Todo triaged ready work and a free valid runtime, an execution selects and durably dispatches one existing Momo per-ticket pipeline and changes its state/date only after matching started acknowledgement. Given busy/uncertain execution, reruns never start a second worker or mutate another ticket. Given mode/route/runtime/readiness uncertainty, the pass exits with a truthful reason. Source tests and fixture receipts are explicitly distinguished from installed cron and live runtime proof.

## Implementation Notes

The parent board currently has active implementation tickets and a shared lease owned by `hermes:33god-pm:bmad-bridge`; inspect fresh live state only through read-only commands. The legacy five-minute cron remains disabled; it must not be re-enabled as a shortcut. The orchestrator will integrate source, review independently, assess runtime prerequisites, and perform safe live busy/idle proof before considering activation.

## Spec Change Log

## Review Triage Log

## Verification

- Run the new fixture suite and existing Momo hardening suites with their actual supported runner.
- Run syntax/import checks for authored scripts and `git diff --check`.
- Report all unresolved dependencies; no claim of live activation without installed/triggered cron and durable receipt proof.
