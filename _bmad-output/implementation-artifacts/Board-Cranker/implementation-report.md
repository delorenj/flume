# Board Cranker source handoff

Source and tests are frozen for the parent's three independent reviews.
Recorded October 5, 2026, 11:30 UTC. No independent-review or live acceptance is
claimed by this implementation worker.

- Worktree: `/tmp/momo-board-crank-20261005`
- Branch: `feat/board-crank-ready-pickup`
- Commit: `1e0d6641f610906ef02018a32cbf300f4cbb3b8e`
- Baseline: `8d110b043b8908fc5196e7e0d84cfd57cfec70d6`
- Spec: `/home/delorenj/code/33GOD/flume/_bmad-output/implementation-artifacts/spec-board-crank-ready-pickup.md`, read fully; its frontmatter context is empty.
- Scoped commit: seven files; worktree clean after commit. Commit hooks passed.
  No push, merge, live dispatch, Plane mutation, prerequisite enabling or cron
  installation occurred. The missing-upstream warning is expected for this
  local parent-integration handoff.

## Changed paths

- `skill/scripts/momo-board-crank.mjs`: bounded inspect/dry-run, execute/replay
  and explicit reconcile entry points; sanitized output and 45-second budget.
- `skill/scripts/lib/board_crank.mjs`: exact Todo readiness and deterministic
  ranking, fresh eligibility, shared lease, fsynced intent/receipts, guarded
  provider mutation, durable uncertainty and completion reconciliation.
- `skill/scripts/lib/board_crank_ports.mjs`: current Pilot and Bloodbank
  integration, canonical routing/envelope/schema/publisher/direct-get helpers,
  deployment and supervision gates, canonical journal-path enforcement.
- `skill/contracts/board.crank.v1.json`: versioned input, runtime acceptance,
  worker observation and result schemas.
- `skill/contracts/board.crank.v1.md`: invocation, deployment, selection,
  uncertainty, lease handoff and reconciliation ownership contract.
- `skill/references/board-clearing-loop.md`: hourly adapter integration with
  the normal delegated implementation and independent spec/quality pipeline.
- `skill/scripts/tests/test_board_crank.mjs`: hermetic safety and recovery
  regressions using the existing lease script and canonical dependencies.

## Verification

Final Board Cranker suite:

```sh
cd /tmp/momo-board-crank-20261005
BLOODBANK_SOURCE_ROOT=/home/delorenj/code/33GOD/bloodbank \
PILOT_SOURCE_ROOT=/home/delorenj/code/33GOD/pilot \
node --test skill/scripts/tests/test_board_crank.mjs
```

Result: **41 passed, 0 failed, 0 skipped**. Full captured output:
`/tmp/flume-orch/board-crank-tests.log`. This includes idle/inspect, stale driver
with active board WIP, runtime WIP, ranking/dependencies/cycles, exact receipt
matching, replay/restarts, uncertain/partial writes, preservation of human
changes, managed/shadow refusal, independent roles, and production API seams.

The controlled journal interleaving pauses a second contender after it reads
null, lets the first persist/publish an uncertain command and release the actual
lease, then resumes the contender. The journal remains byte-identical; exactly
one command and zero ticket writes occur. The contender reloads the journal
immediately under its acquired lease and acts on that fresh fence.

The state-identity regression reuses one accepted fixture receipt and driver
lease with a second configuration naming another journal directory. Execution
refuses before creating any second journal or dispatch. Production ports also
refuse journal-directory symlink aliases. Pending journals bind all runtime
configuration, including observation paths and broker.

Completion tests require the exact completed receipt, fresh no-worker supervision
at or after completion, final Done state and no board WIP. Explicit reconciliation
and ordinary execute can retire/archive a proven active fence and advance one
later ticket. Missing/mismatched evidence, worker activity, stale observations,
mutation conflicts and a fabricated completed marker preserve the fence.
An archive-failure/restart regression prevents later dispatch until the original
command/start/completion evidence is archived successfully.

The existing supported Python hardening runner
`skill/scripts/tests/test_momo_hardening.py` passed **79/79** in an isolated
temporary monorepo harness earlier in this same task. Its log is
`/tmp/flume-orch/board-crank-hardening.log`; no existing Python source changed
after that run. Isolation protects the parent findings/runtime paths which that
runner otherwise writes.

Final syntax and formatting checks passed:

```sh
node --check skill/scripts/momo-board-crank.mjs
node --check skill/scripts/lib/board_crank.mjs
node --check skill/scripts/lib/board_crank_ports.mjs
node --check skill/scripts/tests/test_board_crank.mjs
node skill/scripts/momo-board-crank.mjs --help
git diff --cached --check
git diff HEAD --check
git status --porcelain
```

Node version was `v24.15.0`. Git status was empty after commit.

## Production boundary evidence

Current Pilot and Bloodbank were inspected read-only with the local CodeGraph
CLI; the CodeGraph MCP transport was closed. Pilot's exported `loadConfig`,
`requireBoard`, `Plane`, pagination and `editIssue` provide the Plane boundary.
Native relations use `work-items/<id>/relations/`. There is no second Plane
credential resolver or HTTP client.

Bloodbank's built library supplies route eligibility, delegation prompt,
envelope builder, schema validator, publisher and direct-get receipt search.
The publisher's existing connection seam wraps its installed official JetStream
client to await a `BLOODBANK_COMMANDS` PubAck. Envelope and transport grammar are
not copied. PubAck is storage evidence; matching gateway turn/invocation started
facts permit the initial state/date write. Gateway CodeGraph source confirms
started events precede Hermes handling and completed events echo context with
causation pointing to invocation.started.

The actual Pilot/Bloodbank adapter regression imports these sources/built
libraries with fixture-only HTTP, registry, profile and credentials. No fixture
transport, acceptance attestation or supervision observation is live proof.

## Reconciliation owner and deployment requirements

The existing Momo runtime owner owns reconciliation and the worker-status
producer. It invokes `reconcile`, or the next hourly `execute` does so, under
the same manifest-bound shared driver lease. An active fence retires only with
all three independent observations: matching completed lifecycle, fresh absence
of pending/implementation/review workers, and final Done/no-WIP board truth.
Driver TTL and an empty snapshot alone never retire a fence.

Before activation the parent must resolve 33GOD-44/46/50 and accept an explicit
installed contractor/version/profile/bundle, memory policy, distinct roles,
command-ID/exact-envelope gateway journal and single driver. The runtime receipt
binds `driver_lease`, `state_dir` and `worker_status_file`; keep that journal
identity stable while any execution is pending.

Acceptance must also prove `control_lease_handoff`: the gateway can deliver the
PM prompt while the adapter still owns its short lease. The invocation carries
the lease path and tells the PM to wait for release, then acquire that same path
with a unique owner before driving implementation/review. A prompt alone does
not prove installed runtime behavior. Retained started/completed receipts and a
real fresh worker-status producer are prerequisites. None is enabled here.

## Outstanding acceptance and risks

- The parent's three reviews, integration/push, installed-runtime busy/idle
  checks and any activation remain outstanding.
- The supplied read-only snapshot observed at `2026-10-05T10:51:00Z` lists
  33GOD-56/79/81 In Progress and 44/46/50 Backlog. The supplied driver lease was
  stale; it provides no free implementation capacity. No newer live board
  snapshot or runtime acceptance was fabricated by this worker.
- Plane's current boundary provides no atomic conditional PATCH. Immediate
  rereads detect many changes, but the final read/PATCH concurrency window
  remains. Only state and a missing start_date are patched; labels, assignees,
  existing dates and unrelated content are preserved.
- Uncertain dispatch, mutation conflicts, missing retained receipts and archive
  failures fail closed and may need runtime-owner investigation. There is no
  force-clear or TTL-based execution retirement.
- `git unpushed` was run read-only; its machine-wide audit reported unrelated
  existing WIP (309 repositories). Output is
  `/tmp/flume-orch/board-crank-unpushed.log`. No unrelated work was changed or
  landed. This commit remains intentionally local for parent integration.

Frozen source for the three reviews:
`1e0d6641f610906ef02018a32cbf300f4cbb3b8e`.

The parent owns installed refusal verification and retains the activation gate.
No further source changes or broad implementation work are planned during review.
