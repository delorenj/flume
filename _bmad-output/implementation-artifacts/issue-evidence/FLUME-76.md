# Evidence: FLUME-76 — I-9 agent.message coordination

## Issue
- Ticket: FLUME-76, In Progress; reservation `i9-flume-contract-worker`.
- Worker: `i9-flume-contract-worker` / Claude subagent.
- Scope: Flume coordination handoff; Hermes Fleet retains contract and mutation ownership.

## Acceptance Criteria
1. Reconcile only original command `149134bb-3c88-4ebf-8ecf-98610e054933`, correlation `f9126f02-14cf-4fae-8a5c-00026336cefa`, exact thread; never resend.
2. Evidence actual Fleet source/owner selection or exact missing enrollment/implementation binding.
3. Record a supported-target predicate and G1–G3 finite cases, future manifest fields and truthful unavailable entrypoint/observer, without native input.
4. One bounded next true-owner brief conditional on verified source, with dependencies and allowed/forbidden files.

## Repo Changes
- Branch: `feat/FLUME-76-agent-message-coordination`; base `df252be3e2b854abe3449276fa3ac06461d0f8d9`. Head is recorded in the final worker report.
- `_bmad-output/implementation-artifacts/FLUME-76/agent-message-coordination.json`: machine-readable coordination receipt, reconciled current state, gate matrix and blocked owner brief.
- `scripts/check-flume-76-handoff.py`: default = structural check (no journal, no parent-doc reads); `--currency` = separate fail-closed check against pinned digests and the exact live journal row (SQLite `mode=ro`, selected fields only).
- `scripts/test-flume-76-handoff.py`: structural baseline plus mutation probes on temporary copies of the real manifest; never touches the live journal or parent docs.
- `scripts/test-flume-76-currency.py`: currency baseline plus fail-closed negatives on temporary copies.
- No Flume runtime/identity/registry/config, Hermes install, Fleet code, parent catalog, BB-32/33, PJAN-202 or Crank changes.

## Verification
- Structural baseline: `python3 -B -I scripts/check-flume-76-handoff.py _bmad-output/implementation-artifacts/FLUME-76/agent-message-coordination.json` → exit 0, `VALID (structure-only)`. Runs independent of live journal and parent-doc state.
- Currency baseline: same argv plus `--currency` → exit 0, `VALID (structure+currency)`: live journal holds exactly the recorded reconciled row and all nine pinned source digests match.
- Structural regression: `python3 -B -I scripts/test-flume-76-handoff.py` → baseline + **73** rejected real-artifact-copy mutations, actionable exit 1, no tracebacks; temporary copies removed; authored artifact unchanged.
- Currency regression: `python3 -B -I scripts/test-flume-76-currency.py` → baseline + **6** fail-closed negatives (recorded state, `updated_at`, reply SHA, source digest drift, expiry-not-in-resume).
- Original independent SPEC session `1f12659d` on prior head `bb9f560`: structural checks passed, currency-equivalent journal probe correctly failed closed ("new selected journal evidence"), and the regression aborted before mutations — the journal coupling that this revision removes.
- No Redis, no bus, no native/pane input, no resend/replay/cross-route at any point.

## Ledger Update
- Reconciliation 2026-11-10T00:20:14Z (orchestrator, resume.md steps 1–3): journal now has exactly one `executions` row for the original command — profile `flume-pm`, state `completed`, outcome `success`, created `2026-11-08T13:48:40.160176Z`, updated `2026-11-08T13:56:46.047665Z`, rejection/failure/detached all null. Terminal events `3fe51b58-8ff9-5212-bdf9-e0988bd0d47c` (`bloodbank.agent.invocation.completed`) and `d16988b9-1a67-5656-a992-fba0aaa433bb` (`bloodbank.conversation.turn.completed`).
- Candystore: exactly 4 correlated lifecycle events, none carrying reply text. Owner reply: `flume-pm` session `20261108_084840_86474df2`, message 3949 (stop, 2026-11-08T13:56:45.783575Z), copy `/home/delorenj/.claude/tmp/i9-flume-pm-final-reply-2026-11-08.md` SHA256 `e779f054f306a7002e1cec6946eea49a10d762917ab63ac7745abcf7c25b5854`.
- Distinct facts: lifecycle completed/success is **execution evidence**; the reply is the **coordination disposition** (coordination receipt ACCEPTED, coordination-only; Fleet contract adoption BLOCKED). Neither is Fleet adoption, API readiness, input enablement or proof. No exactly-once claim.
- Historical evidence preserved and labelled historical: stored receipt (seq 160790, 09:59:07Z), 10:14:20Z PENDING snapshot, 10:13:53Z observer expiry. Policy unchanged: no resend, replay or cross-route.

## Known Gaps
- AC2 precise blocker stands, corroborated by the reply: no Fleet-authored contract, owner ticket, code home, enrolled board/PM or public API. `hermes-fleet.yaml` card and `~/.hermes/hermes-agent` install are evidence, not an implementation home.
- G1 external schema/version capability, G2 final asynchronous native-session fence, G3 independent receiver input-acceptance observable: **BLOCKED / NOT RUN**. Unsupported ⇒ zero native frames, no terminal fallback. Installed 2.1.319 (`dabafec82…`) is a capability-gated candidate only.
- AC4: `EXACT_ORIGINAL_OWNER_REPLY` satisfied by the coordination reply only; `FLEET_SOURCE_SELECTED`, `FLEET_BOARD_PM_ENROLLED`, `FLEET_AUTHORITY_EVIDENCED` remain MISSING, so the brief stays `BLOCKED_SOURCE_SELECTION` with no ticket/worker.
- Dependencies unchanged: BB-32 before BB-33; PJAN-202 provisional read-only; ASM identity, terminal-driver topology/actions, Crank admission/attempts/unknown fence and separate C3 cases. Hub/workflow, scoped FR-6, full I-8 stay independent.

## Close Recommendation
- Close recommendation: blocked; **not close-ready** pending fresh independent SPEC then QUALITY on this revision. Next bounded owner result belongs to Hermes Fleet through its own intake (not FLUME). Do not mark FLUME-76 Done or promote G1–G3.
