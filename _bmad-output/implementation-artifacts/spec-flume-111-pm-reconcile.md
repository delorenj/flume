---
title: 'FLUME-111: owning-PM intake and resolved-hold reconciliation'
type: feature
created: '2026-11-22'
status: draft
route: dispatch
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — approve before implementation">

## Intent

**Problem:** Active owning PMs have no maintained, bounded intake/reconciliation pass outside launch mode. Authorized requests remain in Backlog, answered questions and resolved dependencies remain held, and failed handbacks can remain parked indefinitely.

**Approach:** Ship one reusable PM interval driver in the canonical shared template and supported Flume inspection/installation wiring. The PM supplies bounded decisions in a JSON plan; a deterministic applier enforces ownership, freshness, leases, evidence, and lifecycle boundaries. Candybar is the only clock and Krebs remains the only implementation dispatcher.

## Boundaries & Constraints

**Always:** Work only in the two isolated FLUME-111 worktrees. Preserve five stock lanes, exact lease owner/path provided by a launcher, fresh scoped routing, all product restrictions and reserved decisions, granted ordinary-source authority, and independent review. Treat unavailable authority, liveness, scope, or ticket sources as unknown and refuse writes. Leave retired desks and explicit reconciliation opt-outs inactive. Report implementation, installation, and execution separately. Dogfood FLUME-106/107 first when the parent authorizes live work.

**Never:** Write anything to `lifecycle:human` tickets, including comments. Never set/remove `agent:working`, dispatch workers, clear holds from age alone, invent tickets, approve product publication/spend/legal decisions, or repeatedly request already-granted source approval. Never create heartbeat timers, native schedules, credentials, permissions, or mass restarts. Do not publish, land, roll out, or mutate boards/profiles/registrations during this source-only task. Do not change Krebs, Candybar, Hermes runtime, the parent 33GOD repo, or unrelated files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Authorized intake | Owned Backlog request with explicit authority and fresh expected snapshot | PM may accept to Todo or reject with an attributable reason; no implementation dispatch | Missing authority or conflicting restrictions leaves it parked |
| Resolved blocker | Owned held ticket, current dependency completion or an explicit answer and disposition evidence | Recheck the original hold; clear only the specifically justified automation hold | Unknown dependencies, unanswered questions, or reserved decisions retain holds |
| Failed handback | `agent:failed` with last-turn diagnosis and a justified recovery disposition | Record diagnosis; allow only the named recovery after fresh liveness checks | No diagnosis or uncertain/live worker means no recovery mutation |
| Human / busy / foreign | Human hold, live/queued/detached work, wrong owner, or wrong scope | No writes, including comments on human tickets; no duplicate work | Return explicit refusal |
| Racing passes | Held/lost lease, stale plan, owner change, or ticket changed after planning | Serialize and revalidate immediately before each operation | Preserve unexecuted work and receipt; do not steal a fresh foreign lease |
| Quiet / unavailable | Unchanged actionable facts, own comment echo, or unreadable source | Stable monitor; no board churn or LLM loop; stable unavailable marker | Never interpret an unavailable source as an empty board |
| Coverage / disabled | Active registry scopes, shared-board scope labels, retired desks, explicit opt-out | Inspect coverage and supply a per-desk bounded installation plan; inactive rows remain inactive | Ambiguous ownership or malformed policy is visible, never silently adopted |

</frozen-after-approval>

## Code Map

- Canonical `template/.scripts/launch-pass.py`: interval shape, not its broad mutation allowlist or scope fallback.
- Canonical `template/.scripts/board-lease.py`: exact-owner reentrancy; never `--steal`.
- `packages/flume-hr/src/workforce/launch.ts`: external-pinned lean job and wrapper/manifest helpers; avoid launch gating and automatic resume.
- `packages/flume-hr/src/workforce/board-routing.ts`: authoritative routing/eligibility.
- `scripts/launch-hermes-job.py`: supported jobs API adapter.
- `packages/flume-hr/src/index.ts`: Commander entrypoint.
- `roles/pm.md`: policy SSOT; preserve opt-outs.
- `scripts/run-tests.mjs`, `tests/launch-mode-regressions.mjs`: built-CLI conventions; fixtures use scratch and no production credentials.
- Read-only contracts: `krebs/docs/lifecycle.md`, `krebs/tick/README.md`, Candybar registration/migration docs.

## Tasks & Acceptance

**Execution:**
- [ ] Canonical template `template/.scripts/pm-reconcile.py` and `pm-reconcile.prompt.md` — implement stable monitor, bounded brief, strict decision-plan validation, guarded apply, durable receipts, and local context.
- [ ] Canonical template `tests/test_pm_reconcile.py` — exercise real driver subprocesses against isolated executable provider/liveness fixtures and the real lease helper; cover every matrix row, partial failure, retry, and contention.
- [ ] `packages/flume-hr/src/workforce/reconcile.ts`, `packages/flume-hr/src/index.ts`, and any narrowly reused job helper — add supported read-only coverage/status and preview-first installation wiring; explicit apply required, no mass registration/resume.
- [ ] `tests/pm-reconcile-regressions.mjs` and `scripts/run-tests.mjs` — verify the built CLI, inactive preservation, safe wrappers, external pin, duplicate/conflict handling, and repeated no-op installation.
- [ ] `roles/pm.md` and `docs/pm-reconciliation.md` — document decisions, authority evidence, restriction handling, supported rollout/rollback, live dogfood, and acceptance evidence boundaries.
- [ ] Flume canonical template gitlink — point only to the ticket-specific template commit after isolated tests pass; do not alter the shared template checkout.

**Acceptance Criteria:**
- Given authorized owned Backlog and resolved-hold fixtures, when a valid plan applies, then only supported intake/reconciliation operations occur through Pilot and resulting work stays for Krebs.
- Given any matrix refusal or race, when the driver executes, then protected tickets remain unchanged and the receipt explains the refusal or uncertainty.
- Given unchanged actionable facts or only this pass's own comment, when monitor runs twice, then stdout is stable and no new board writes occur.
- Given active and inactive desks, when Flume inspects or previews installation, then every eligible owned scope is accounted for and retired/disabled policy is preserved.
- Given both source candidates, when checks run in isolation, then the exact commits, commands, outputs, files, limitations, and executable rollout instructions are handed to independent reviewers. Parent acceptance still requires actual authorized Backlog disposition, resolved-hold recheck, and ensuing Krebs invocation.

## Implementation Notes

Awaiting specification approval. Shared dirty files untouched. g33 passed (legacy enrollment WARN). No live mutation.

## Spec Change Log

- Parent PM incorporated Jarad/Grolf's 2026-11-23T00:16:17Z instruction as
  approved acceptance: after every real hold, preserve it and continuously
  replenish by accepting **and triaging** next eligible independent Backlog in
  priority order. Held tickets occupy zero Krebs slots; Krebs alone dispatches
  at scope cap. Require concrete exclusions (human, dependencies, file collisions,
  declared launch cut, busy work, restrictions, opt-outs) and exact reason when
  none qualifies. Add the two-held intake/triage + real injected Krebs tick
  regression. Source only; no live board or clock mutation.

## Review Triage Log

## Verification

- Run canonical Python driver tests using scratch-local fixtures; prohibit real provider/network side effects.
- Run Flume typecheck/build and the new built-CLI regressions, plus launch/scaffold/role regressions relevant to changed seams.
- Run `git diff --check` in both isolated lanes, review staged ticket-only diffs, and commit only explicit ticket paths.
- Parent performs independent reviews before landing, then controlled Flume dogfood, execution readback, and active-scope rollout. No installation or live execution is claimed by this source task.
