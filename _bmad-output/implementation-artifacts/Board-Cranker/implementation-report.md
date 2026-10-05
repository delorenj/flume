# Board Cranker source delivery — October 5, 2026

Reviewed corrections `c32901220716c5b3a1f09332c3ff37a15b6edafd` are merged and pushed in Momo main `4029c3471a738bd4dfcdca3038abdbebcc6971ae`. All independent review patches are resolved. The completed worktree and feature branch are removed.

The parent ran the final combined library and public CLI suites on main: **62 passed, zero failed/skipped**. The earlier unchanged Python hardening harness passed 79 tests. The source CLI also refused missing and disabled runtime configuration with exit 78; watched operator files remained byte-identical. See `source-refusal.json` and `/tmp/flume-orch/momo-main-verification.log`.

```sh
cd /home/delorenj/code/33GOD/momo
BLOODBANK_SOURCE_ROOT=/home/delorenj/code/33GOD/bloodbank \
PILOT_SOURCE_ROOT=/home/delorenj/code/33GOD/pilot \
node --test skill/scripts/tests/test_board_crank.mjs \
  skill/scripts/tests/test_board_crank_cli.mjs
```

Source delivery is complete. Installed catalog delivery and live activation remain gated: the installed skill lacks the adapter; the recorded board/runtime prerequisites remain unresolved. No cron activation, live dispatch, Plane write, installed invocation or started/completed runtime acceptance is claimed. See `../board-crank-runtime-gate.md` and `runtime-gate.json`.

The worker handoff below is retained as historical evidence. Its pending-parent, local-branch and no-push statements describe the worker checkpoint; the parent obligations above have since completed.

---

# Board Cranker review-fix handoff

Source and tests are frozen for parent review at commit
`c32901220716c5b3a1f09332c3ff37a15b6edafd`.
Recorded October 5, 2026, 12:29 UTC. This supersedes the original source freeze
at `1e0d6641f610906ef02018a32cbf300f4cbb3b8e`.

- Worktree: `/tmp/momo-board-crank-20261005`
- Branch: `feat/board-crank-ready-pickup`
- Correction commit: `c32901220716c5b3a1f09332c3ff37a15b6edafd`
- Correction baseline: `1e0d6641f610906ef02018a32cbf300f4cbb3b8e`
- Spec: `/home/delorenj/code/33GOD/flume/_bmad-output/implementation-artifacts/spec-board-crank-ready-pickup.md`
- The spec was read fully, including the recorded review verdicts; frontmatter
  context is empty. Existing work was continued.
- Seven scoped files committed; commit hooks and whitespace checks passed.
  Worktree status is clean. No push, merge, live dispatch, live provider mutation,
  runtime installation, prerequisite enabling or cron activation occurred.
  The local branch's missing-upstream warning is expected for this handoff.
  The required read-only `git unpushed` audit reported work across 307 other
  repositories; log: `/tmp/flume-orch/board-crank-fixes-unpushed.log`. No work
  outside this scoped handoff was changed or landed.

## Changes

`skill/scripts/lib/board_crank.mjs`:

- Only a worker with BOTH the saved ticket and exact journal command is exempt
  during recovery. Foreign/missing/null command identities fence pending replay
  and post-start provider writes.
- Every written prerequisite must match completed native predecessor truth.
  Completed TEST-9 cannot satisfy unresolved written TEST-10 or an unmatched
  operator obligation. Explicit no-dependency prose remains supported.
- Cycle configuration must be boolean; enabled dates/membership must be known.
  Downstream scoring awards credit only when observed native and written
  predecessors show this item would resolve all remaining blockers.
- Nonstring descriptions are thin input. Acceptance is bounded to its section;
  criteria after interleaved prose are all checked, and numbered Notes cannot
  fortify an empty AC section.
- Journal ticket/project/route identities are bound to saved envelope context
  and target. Configuration hashes canonically sort object keys recursively;
  saved command bytes and IDs remain unchanged.
- Intent persists the prompted ticket-content revision, checked before
  publish/replay and post-start claim. Changed content preserves the exact
  original fence; it never automatically creates a replacement command.
- Runtime acceptance/worker freshness and lease ownership are refreshed after
  hydration and immediately before external effects.
- Before the first intent, under the authoritative shared lease, an atomic,
  fsynced `${driver_lease}.board-crank.json` binds one canonical per-board
  journal directory beside that lease. Renewed receipts cannot relocate it.
  Read-only passes never create it. Corrupt, mismatched and dangling-symlink
  bindings refuse without replacement. No public command or manifest field added.
- The prior under-lease fresh journal reload and explicit completion
  reconciliation remain intact. TTL and empty snapshots alone never clear WIP.

`skill/scripts/lib/board_crank_ports.mjs`:

- Installed acceptance fingerprints sorted relative file identities and content
  SHA256s for SKILL.md, references, scripts and contracts, excluding tests and
  __pycache__. Executable/schema edits invalidate acceptance; the executing
  source must match the accepted installed bundle.
- Native relation/downstream/cycle hydration runs at concurrency <= 8 under a
  shared five-second deadline, retaining publication and readback time.
- Started/completed receipt lookup reuses Bloodbank's canonical direct-get
  helper with a recent 16-sequence starting window and existing request/time
  bounds, reaching near-tip matches amid dense unrelated events.
- Current Pilot and Bloodbank configuration, credential, envelope, publisher
  and transport grammar remain canonical.

`skill/scripts/momo-board-crank.mjs`:

- A detached subprocess owns the pass, including Pilot's synchronous op reads.
  An external 45-second wall-clock limit kills its whole process group on
  timeout/error, emits sanitized output and preserves fsynced intent.
- Successful child JSON is parsed on `close`, after stdout has drained.
  Child stderr is discarded; output is limited to 256 KiB.
- Private fixture budget control only shortens the production limit.

`skill/scripts/tests/test_board_crank.mjs` adds focused core and production-port
regressions. New `skill/scripts/tests/test_board_crank_cli.mjs` covers public
read-only flags, large successful output and a genuine stalled op process group.

`skill/contracts/board.crank.v1.md` and
`skill/references/board-clearing-loop.md` describe these corrected contracts,
persistent storage identity, fingerprint and budgets while retaining the existing
activation gate and fixture/live distinction. The JSON schema is unchanged.

## Focused verification

Only Board Cranker tests covering edited files were run for these corrections.
No unrelated Python hardening or full-repository verification was run.

1. Expanded library/production-port suite: **56 passed, zero failed/skipped**.
   Log: `/tmp/flume-orch/board-crank-fixes-tests.log`.
2. After the final dangling-binding guard and raw string cycle-member fixture,
   only the three affected checks were rerun: **3 passed, zero failed/skipped**.
   Log: `/tmp/flume-orch/board-crank-fixes-final-focused-tests.log`.
3. Final authored child-process CLI suite: **5 passed, zero failed/skipped**.
   Log: `/tmp/flume-orch/board-crank-fixes-cli-tests.log`.

The three-check follow-up overlaps two library cases and adds one case.
There are 57 library cases and five CLI cases in source; a full final aggregate
rerun is intentionally left to the parent. The 56-case result precedes the last
small guard; the affected guard paths and final CLI were verified afterwards.

Commands (with explicit current dependency roots):

```sh
cd /tmp/momo-board-crank-20261005
BLOODBANK_SOURCE_ROOT=/home/delorenj/code/33GOD/bloodbank \
PILOT_SOURCE_ROOT=/home/delorenj/code/33GOD/pilot \
node --test skill/scripts/tests/test_board_crank.mjs

BLOODBANK_SOURCE_ROOT=/home/delorenj/code/33GOD/bloodbank \
PILOT_SOURCE_ROOT=/home/delorenj/code/33GOD/pilot \
node --test --test-name-pattern='persistent bindings|per-board journal binding|production hydration carries' \
  skill/scripts/tests/test_board_crank.mjs

BLOODBANK_SOURCE_ROOT=/home/delorenj/code/33GOD/bloodbank \
PILOT_SOURCE_ROOT=/home/delorenj/code/33GOD/pilot \
node --test skill/scripts/tests/test_board_crank_cli.mjs
```

Syntax checks passed for both libraries, CLI and both test files. Staged diff
checks passed before commit; status was empty after commit.

The production hydration fixture observes 100 Todo relation reads with maximum
concurrency eight, completing in approximately two seconds. Nonempty start_after
and finish_after relations plus raw string, string-issue and object-issue cycle
memberships feed the real rankCandidates path.

Dense receipt histories contain 4,200 unrelated predecessors per subject and a
second-newest matching event. Actual canonical withDirectGet/directGetter/
findLatestMatching traversal feeds production started/completed ports, then
dispatch and reconcile. The canonical default large-window starvation is covered.

The public CLI tests execute real child processes for inspect, execute --dry-run
and reconcile --dry-run against fixture runtime acceptance, with and without
an existing active fence. Storage contents/mtimes remain identical; no lease,
binding, journal, broker or provider mutation is attempted. Network connections
are blocked and HTTP reads are fixture-only.

The external timeout test enters the current Pilot resolveKey/execFileSync path
with a fixture-only op:// reference and a temporary hanging op executable. Both
op and its descendant are terminated within the shortened 1.5-second budget;
the original fsynced uncertain journal and binding are byte-preserved.
No production secrets are inherited or used, and no Pilot source is changed.
A receipt larger than a pipe buffer also proves successful output drains before
JSON parsing.

## Production boundary and retained gate

Current Pilot and Bloodbank sources were inspected read-only through local
CodeGraph. The worktree itself has no index, so its source was read directly.
Pilot supplies loadConfig, requireBoard, Plane, pagination and editIssue.
Bloodbank supplies command/receipt schemas, fleet routing, prompts, publisher and
canonical direct-get traversal. No parallel credential or transport grammar added.

The existing Momo runtime owner owns reconciliation and the worker-status
producer. An active fence retires only under the SAME driver lease with an exact
completed receipt, fresh post-completion no-worker truth and final Done/no-WIP
board evidence. Original command/start/completion/readback evidence is archived
before a later pass can advance. Missing proof and ambiguous mutation remain
durable uncertainty; no TTL-clear or force-clear operation exists.

33GOD-44/46/50 remain unresolved. The supplied read-only snapshot at
2026-10-05T10:51:00Z lists 33GOD-56/79/81 In Progress and 44/46/50 Backlog.
The supplied driver TTL was stale and provides no free implementation capacity.
No newer live receipt, board snapshot or acceptance was fabricated.

Before activation the parent/runtime owner must verify the deployed contractor,
accepted installed/executing bundle fingerprint, profile, memory policy, distinct
reviewers, gateway command-ID/exact-envelope journal, one driver, post-completion
worker-status production, retained real receipts and control-lease handoff.
The persistent journal binding must remain stable even across acceptance renewal.
Source fixtures do not prove any of these live conditions.

## Remaining risks and ownership

- All requested source fixes, focused regressions and documentation are complete.
  Parent owns full verification, independent review, integration/push, installed
  refusal checks and any eventual activation.
- Plane still lacks an atomic conditional PATCH through the canonical boundary.
  Fresh reads reduce races; the final read/PATCH window remains. Only state and
  a missing start_date are written; other ticket fields are preserved.
- Bounded receipt searches can miss older matching facts. A miss preserves the
  execution fence and may require runtime-owner investigation.
- Changed bundle/context/digest contracts are not an automatic migration of
  legacy pending journals. Preserve any original uncertainty for owner
  investigation; renewing acceptance cannot rotate persistent journal storage.
- Corrupt/different bindings, changed prompted content, mutation conflicts and
  missing supervision/retained proof fail closed. Storage migration requires
  the runtime owner's explicit investigation; no new reset surface is provided.

Frozen source/tests: `c32901220716c5b3a1f09332c3ff37a15b6edafd`.
The parent retains the live activation gate. No push or live cron was performed.
