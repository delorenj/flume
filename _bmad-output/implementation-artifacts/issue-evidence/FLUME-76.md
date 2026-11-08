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
- `_bmad-output/implementation-artifacts/FLUME-76/agent-message-coordination.json`: machine-readable coordination receipt, gate matrix and blocked owner brief.
- `scripts/check-flume-76-handoff.py`: read-only selected journal/source check, no native endpoint or broker consume. Schema v2 now enforces explicit policy enums, ownership/source prerequisites, field shapes and evidence dates.
- `scripts/test-flume-76-handoff.py`: reproducible baseline and temporary mutations of the real manifest, not protocol fixtures.
- No Flume runtime/identity/registry/config, Hermes install, Fleet code, parent catalog, BB-32/33, PJAN-202 or Crank changes.

## Verification
- `python3 -I scripts/check-flume-76-handoff.py _bmad-output/implementation-artifacts/FLUME-76/agent-message-coordination.json` → VALID for selected receipt/sources and blocked gate states; **not a native gate PASS**.
- First local head `a8cbaba82fc3862f7d4c5869bbd398a74d0fb9dc` passed independent SPEC but failed QUALITY Q1–Q3: finite cases/blocked future plan, Fleet ownership/source prerequisites, and dated original observation policies could be removed or contradicted while the checker returned VALID. That original self-check was insufficient.
- Repair run: `python3 -I scripts/test-flume-76-handoff.py` → real authored baseline VALID plus **56** deliberate real-artifact-copy mutations rejected with actionable exit 1 and no tracebacks. Includes every Q1–Q3 counterexample, root/list/null/gate shape errors, erased source references and policy promotion. Temporary copies removed, authored artifact unchanged. This is structure/evidence validation, never native support certification.
- Exact executed argv/stdout/stderr and tested revision/hash: `.flume76-handback/quality-fix-validation.txt` (untracked spool). Parent HEAD during repair run `a8cbaba82fc3862f7d4c5869bbd398a74d0fb9dc`; checker SHA256 `1460a6105d639be2566edad5ac903c3c0490b700990350642f568bbdea0612ba`, manifest SHA256 `5193162c5affebe3a2787a94d2948254e9a8eafd541b524dc58b76b498acfedc`. Final repair HEAD is in the worker report/handback.
- Structured v2 invariants explicitly forbid resend/replay/cross-route, native submit and terminal fallback, preserve the unknown fence, require Fleet contract/mutation ownership, and block next work on source/enrollment/authority/original-reply proof. Prose case semantics still require independent human/agent review; no NLP classifier is claimed.
- Stored time/subject/stream and snapshot checked_at must correspond to hashed original evidence; observer expiry must be chronologically valid and present in hashed resume evidence. Local selected journal remains read-only and must still have no execution row, otherwise reconciliation stops with exit 1.
- Exact read-only query: SQLite URI `file:/home/delorenj/.hermes/bloodbank-hermes-gateway-state.sqlite3?mode=ro`, `SELECT state, profile, outcome, rejection_reason, failure_code, terminal_events FROM executions WHERE command_id = ?` with only original command ID → zero rows at this run. No journal write.
- Original stored receipt SHA256 `e5b1ce26762831bb005fd8584d5fcc60a3e792a8c89f0a0565279b74beeaffae`, observer-expiry evidence SHA256 `906478a2d18e5bfb0ecee46653370bd7db6d9f67a41e51865309c3752cfc4035`. The expiry snapshot at 10:14:20Z reports stored sequence 160790 beyond durable delivered 160027, no selected execution or correlated events. Snapshot is historical; future delivery remains possible.
- Installed candidate executable `/home/delorenj/.local/share/claude/versions/2.1.319` SHA256 `dabafec82ca1319fa43d8be36a10fc61b1d11821cb98ad5df04ad95e199b8eed`; byte-offset investigation in parent `delivery-feasibility.md` is not an external API commitment.

## Ledger Update
- No board/event mutation authorized after initial `px show FLUME-76` readback. No decision event or status transition made.
- This issue-evidence record links the immutable parent SPEC and scoped local observations; it does not certify native delivery.

## Known Gaps
- Owner planning response **PENDING** after fixed observer expiry; no resend. Gateway journal has no selected execution row; observation timeout is not rejection/adoption.
- `33god-platform/components/hermes-fleet.yaml` identifies `hermes-agent-template` as shared source card (revision `5715dbc4228a0aa8c8f91424ade092b9e448f26b`), not a selected native Adapter writer. `~/.hermes/hermes-agent` is installed runtime; no enrolled Fleet PM/board or implementation ticket verified. FLUME coordinator designation does not transfer ownership.
- G1 external schema/version capability, G2 final asynchronous native-session fence, G3 independent receiver input-acceptance observable: all **BLOCKED / NOT RUN**. No owner-supported runnable native argv, independent observer or Fleet source revision exists to fill the future manifest. **Unsupported for submission, zero native frames, no terminal fallback.**
- BB-32 isolation before BB-33 ASM identity repair; PJAN-202 is provisional read-only discovery. ASM owns identity/freshness, terminal-driver topology/actions, Crank final admission/attempt/unknown fencing and separate C3 integrated cases. Hub/workflow, scoped FR-6 and full I-8 remain separate verdicts.

## Close Recommendation
- Close recommendation: blocked; **not close-ready**. Await exact original owner response and verified Fleet source/board binding before creating one actual Fleet-owner ticket/worker. Do not mark FLUME-76 Done or promote G1–G3 on this coordination artifact.
