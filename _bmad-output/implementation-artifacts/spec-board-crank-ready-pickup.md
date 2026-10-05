---
title: 'Board Cranker: pick up triaged Todo tickets under the existing Momo lease'
type: feature
created: '2026-10-05'
status: done
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

- [x] `skill/scripts/momo-board-crank.*` and small supporting module(s) — bounded control-pass adapter with inspect/dry-run and execute modes, injection seams for fixture tests, durable journal/replay, shared lease, exact-lane readiness, deterministic ranking, command/receipt handling and guarded ticket transition.
- [x] `skill/contracts/board.crank.v1.*` — versioned input/runtime/receipt contract; invocation carries contractor/version, project, ticket, workdir and explicit memory policy. Validate prerequisites before execution.
- [x] `skill/references/board-clearing-loop.md` — document hourly adapter, normal pipeline delegation, independence, busy/refusal/uncertainty behavior, and deployment gate.
- [x] `skill/scripts/tests/test_board_crank.*` — meaningful hermetic idle/busy/two-ready/unfortified/dependency/dispatch-failure/ack/replay/partial-write/mode/independence regressions. A fake transport must not count as live proof.
- [x] `/tmp/flume-orch/board-crank-report.md` — full commit SHA, changed paths, exact tests and results, runtime deployment requirements, any acceptance gaps and concerns.

**Acceptance:** Given direct-in-Todo triaged ready work and a free valid runtime, an execution selects and durably dispatches one existing Momo per-ticket pipeline and changes its state/date only after matching started acknowledgement. Given busy/uncertain execution, reruns never start a second worker or mutate another ticket. Given mode/route/runtime/readiness uncertainty, the pass exits with a truthful reason. Source tests and fixture receipts are explicitly distinguished from installed cron and live runtime proof.

## Implementation Notes

The parent board currently has active implementation tickets and a shared lease owned by `hermes:33god-pm:bmad-bridge`; inspect fresh live state only through read-only commands. The legacy five-minute cron remains disabled; it must not be re-enabled as a shortcut. The orchestrator will integrate source, review independently, assess runtime prerequisites, and perform safe live busy/idle proof before considering activation.

## Spec Change Log

## Review Triage Log

All three layers completed before classification. The source at `1e0d6641f610906ef02018a32cbf300f4cbb3b8e`, canonical receipt-search helper, and Pilot credential resolver were inspected. Individual findings precede grouping.

| ID | Layer | Verdict | Route | Evidence |
|---|---|---|---|---|
| B1 | Blind | high | patch | `boardWip` exempts all workers with the saved ticket ID, ignoring command identity. A foreign execution on that ticket can coexist with replay. |
| B2 | Blind | high | patch | Both written-dependency checks require zero native predecessors. A completed native predecessor allows an additional unresolved written prerequisite through. |
| B3 | Blind | medium | patch | `if (board.cycle_view)` treats an absent or malformed cycle flag as disabled. A local probe admitted work with unknown cycle configuration. |
| B4 | Blind | medium | patch | The critical-path score counts every unfinished blocking target without checking its other prerequisites, overstating what completing this work would unblock. |
| B5 | Blind | high | patch | Journal loading checks envelope bytes but does not bind ticket/project/route identities to context. A changed journal.ticket_id can drive recovery PATCHes for a different ticket using the original receipts. |
| B6 | Blind | medium | patch | Configuration digests use insertion-order-sensitive JSON.stringify. Reordering equivalent keys changes pending digests and prevents ordinary recovery. |
| B7 | Blind | high | patch | Before publication, eligibility is rechecked but the saved prompt's title/acceptance revision is not. Changed yet eligible criteria can receive the old command. |
| B8 | Blind | high | patch | Runtime facts are checked before board hydration; publication occurs afterward without a freshness/expiry check. Hydration can outlive the sixty-second worker observation. |
| B9 | Blind | high | patch | skillDigest hashes only three Markdown files. Executable/schema changes leave accepted deployment fingerprints unchanged. |
| B10 | Blind | medium | patch | Production relations are fetched serially on each full scan. Three 100-item scans at 150 ms each consume the entire forty-five-second pass before dispatch/readback. |
| B11 | Blind | medium | patch | Canonical findLatestMatching starts 4096 sequences back and scans forward under the new 100-request cap; a second-newest retained match can remain unreachable on every identical retry. |
| E1 | Edge | medium | patch | descriptionText calls replace on null, and rankCandidates computes acceptance before untriaged exclusion. A local mixed-board probe throws TypeError and aborts all selection. |
| E2 | Edge | high | patch | The criteria parser does not stop at the next section and stops at interleaved prose. A local empty-AC/numbered-notes probe qualified unrelated notes; required later criteria can also be omitted. |
| E3 | Edge | high | patch | Same demonstrated written/native prerequisite bypass as B2. |
| E4 | Edge | high | patch | Same demonstrated foreign same-ticket worker exemption as B1. |
| E5 | Edge | high | patch | Same validated-then-hydrate freshness window as B8. |
| E6 | Edge | high | patch | Same saved-prompt/current-criteria mismatch as B7. |
| E7 | Edge | high | patch | A renewed acceptance document can bind a new journal directory while the old uncertain intent remains elsewhere. Bind the canonical journal location persistently under the existing shared driver lease so receipt renewal cannot erase the fence. |
| E8 | Edge | medium | patch | Pilot resolveKey uses execFileSync(op read) without a timeout. The CLI event-loop timer cannot interrupt it; supervise the pass externally to bound synchronous calls and their child processes. |
| E9 | Edge claim | medium | patch | The claimed bounded-pass failure follows the same synchronous resolver and ineffective timer as E8. |
| E10 | Edge claim | high | patch | The claimed single-worker failure follows the same same-ticket exemption as B1/E4. |
| G1 | Verification gap | medium | patch | Filed mutation evidence: removing start_after and finish_after leaves 41 tests green. Cover each sequencing-only predecessor in incomplete and completed states. |
| G2 | Verification gap | medium | patch | Filed mutation evidence: discarding nonempty production relations leaves 41 tests green. Exercise readiness on boards hydrated by the real Pilot adapter. |
| G3 | Verification gap | medium | patch | Filed mutation evidence: breaking production cycle membership mapping leaves 41 tests green. Cover enabled cycles and both string/object issue references through adapter hydration. |
| G4 | Verification gap | medium | patch | Filed mutation evidence: production started/completed ports can return no evidence while all tests pass. Exercise canonical direct-get traversal and its dispatch/reconciliation consumers. |
| G5 | Verification gap | high | patch | Filed mutation evidence: forcing CLI execute=true preserves 41 green library tests. Invoke inspect and both dry-run modes in subprocesses and prove zero writes/publication. |
| G6 | Verification gap, other | high | patch | The reported additional written prerequisite bypass is confirmed by the zero-native-predecessor guard, matching B2/E3. |

All survivors route to bounded corrections of demonstrated states without a new public command or runtime activation. Group only shared defects: same-ticket worker identity; written prerequisites; saved ticket revision; runtime freshness; bounded supervision. The five verification gaps retain their separate obligations.

## Verification

- Run the new fixture suite and existing Momo hardening suites with their actual supported runner.
- Run syntax/import checks for authored scripts and `git diff --check`.
- Report all unresolved dependencies; no claim of live activation without installed/triggered cron and durable receipt proof.

## Resolution and integration — October 5, 2026

All three independent review layers completed, and every patch verdict above was resolved. Exact command/ticket worker fences, journal context and persistent storage identity, complete prerequisites and acceptance sections, explicit cycle truth, canonical configuration hashes, saved ticket revision, fresh runtime/lease checks, bundle fingerprints, bounded hydration and canonical receipt traversal, subprocess supervision and real public CLI coverage are implemented.

Reviewed corrections `c32901220716c5b3a1f09332c3ff37a15b6edafd` landed and were pushed in Momo main `4029c3471a738bd4dfcdca3038abdbebcc6971ae`. The final combined library and CLI run passed all 62 tests; earlier unchanged Python hardening passed 79 tests. The canonical source CLI refused both missing and disabled configuration with exit 78, while watched operator registry, cron and driver-lease files remained byte-identical. Evidence is in `Board-Cranker/source-refusal.json` and the updated implementation report.

This spec's source delivery is complete. Live activation remains gated: the installed catalog at `/home/delorenj/code/skillex/all-skills/momo` does not contain the new adapter, and the earlier read-only board snapshot retains implementation WIP and unresolved contractor/runtime prerequisites. No installed busy/idle invocation, live started/completed receipt, cron activation or Plane write is claimed. See `board-crank-runtime-gate.md`. The completed implementation worktree and feature branch were removed.
