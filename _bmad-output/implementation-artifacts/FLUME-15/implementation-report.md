# Parent integration complete — October 5, 2026

Reviewed retirement source landed and was pushed through `c48ee0242007880c397917266b4107d2b669f938`, consuming template `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`. Combined typecheck/build passed with 22/23 suites; the isolated fleet-status run confirms the remaining baseline policy-domain assertion and passes the no-write check. All patch verdicts are resolved; existing observer debt is retained in `../deferred-work.md`. The completed worktree and branch are removed.

The installed main CLI validates handbook 1.5.0 and observes all 28 employees with zero required-heartbeat observations. Overall health still contains unrelated gateway/topology failures. See `installed-review.md`, `installed-review-summary.json` and `../recovery-delivery.md`.

The following review-fix handoff is historical; its pending parent obligations have completed as stated above.

---

FLUME-15 review-fix closeout — October 5, 2026

**Status: DONE_WITH_CONCERNS.** All nine assigned review fixes are implemented and committed in the existing worker. Four affected suites pass. Typecheck and build pass. No full verification, fresh live review, template change, push, merge, or rebase was performed for this review pass. Parent handles merge overlap with FLUME-32, the new template pin, independent acceptance and combined verification.

**Review commits**

- `2d4c1ad82da2ea5fd522857630fdf728a121810d` — historical handbook compatibility, effective retirement detection, stale heartbeat ownership, alias identity and consistent candidate substitutions.
- `6cfeea5fdc69ff3ae64929bbc11a50dad177669e` — exclude heartbeat profile wiring and add missing-row registry remediation and successful built-CLI hire coverage.

**Changes addressing the review**

1. `org/contract.ts` and `types.ts` gate heartbeat retirement completeness to contract 1.5 or newer. Historical heartbeat manifest fields retain their original validation. Exact original v1.4/schema-5 bytes load, as does its supported schema-4 form with service_manifest omitted. The untouched original v1.3/schema-4 document still returns its established `RETIRED_MODE` quarantine-by-omission diagnostic; execution-authority defaults were not relaxed.
2. `org/systemd.ts` keeps `misnamed-gateway` for a stored heartbeat name while excluding it from owned and duplicate-gateway attribution. Both heartbeat service and timer remain visible with retired/retirement cleanup guidance.
3. `parity/rules.ts` removes heartbeat service/timer from profile wiring audit and remediation. PJAN-48 proves stale heartbeat homes and dead OAuth settings do not fail current employee wiring, that remediation leaves them untouched, and that stale current gateway wiring still fails.
4. Current handbooks require effective detection of both canonical heartbeat unit types through declared detectors or swept candidates. Contract tests cover removed detection, each missing unit type, custom regex detectors, candidate-only and mixed policies.
5. Unregistered classification requests `Names` and correlates a requested alias to a canonical `Id`. Missing correlation and overlapping alias claims retain `show-malformed` uncertainty.
6. Candidate matching uses a single named capture and repeated backreferences, consistent with derive's replaceAll substitution. Matching and inconsistent repeated-ID fixtures use distinct suffixes to avoid accidental overlap with the single-placeholder fixture.
7. PJAN-86 runs a successful real built-CLI `hire dev --yes` lifecycle using scratch Copier and systemd fixtures. The gateway is enabled and active; historical heartbeat metadata remains installed. The outcome is verified, without deferral or a heartbeat summary line. The final sentinel audit passes.
8. PJAN-48 remedies a missing registry row and asserts its systemd mapping is exactly `{ gateway_unit: canonicalGateway }`. It has no heartbeat fields, and the subsequent registry audit passes.
9. Systemd tests exercise the custom candidate `hermes-stray-pm-old-poll.timer`, prove no retired detector matches it, and assert `retired`, `retirement`, `retired:candidate`.

**Executed focused verification**

All commands ran in `/home/delorenj/code/33GOD/flume/.worktrees/flume-15`.

```sh
node scripts/run-tests.mjs fleet-contract fleet-systemd > /tmp/flume-orch/flume15-review-checkpoint.log 2>&1
node scripts/run-tests.mjs fleet-contract fleet-systemd > /tmp/flume-orch/flume15-review-checkpoint-final.log 2>&1
node scripts/run-tests.mjs --no-build --no-typecheck fleet-contract > /tmp/flume-orch/flume15-review-contract-final.log 2>&1
node scripts/run-tests.mjs --no-build --no-typecheck pjan-48 pjan-86 > /tmp/flume-orch/flume15-review-parity-hire.log 2>&1
node scripts/run-tests.mjs --no-build --no-typecheck pjan-86 > /tmp/flume-orch/flume15-review-hire-final.log 2>&1
git diff --check
git diff 827ac7b HEAD --check
git status --short
git ls-tree HEAD templates/hermes-agent
git unpushed > /tmp/flume-orch/flume15-review-unpushed.log 2>&1
```

The last gated run passed typecheck in 2.6s and build in 202ms. All final TypeScript source was present for those gates; subsequent changes were test fixtures/assertions only, so focused reruns reused that built output. Earlier failures are retained honestly: the first checkpoint exposed original v1.3 default-deny rejection and an overlapping candidate fixture; the second passed systemd but the contract test had an incorrect expected exit code (5 instead of 4); the first hire fixture omitted required gateway model routes and effort. Those fixture/expectation issues were corrected without relaxing source semantics or assertions.

| Affected suite | Final result | Duration | Evidence |
| --- | --- | --- | --- |
| fleet-contract | PASS | 24.7s | flume15-review-contract-final.log |
| fleet-systemd | PASS | 239.8s | flume15-review-checkpoint-final.log |
| pjan-48 | PASS | 15.9s | flume15-review-parity-hire.log |
| pjan-86 | PASS | 11.9s | flume15-review-hire-final.log |

These are four passing selected suites across the listed runs, not a new full-suite result. Machine-readable receipts, SHA-256 log digests and source digests are in `/tmp/flume-orch/flume15-review-fixes-verification.json`.

**Boundaries and remaining work**

The worker tree is clean. Its template gitlink remains `97f9ff82e087dad3273c5cc596feac6b39f2c370`. Canonical template retirement is already landed separately as `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`; parent reports FLUME-32 landed on main `3630ca8` and will integrate overlap and the new pin. Those parent results are parent-provided evidence, not newly executed worker verification.

No live state was changed or freshly sampled. `/tmp/flume-orch/flume15-live-review.json` and its standalone human-readable companion `/tmp/flume-orch/flume15-live-review.md` retain the saved before/after evidence for `827ac7b842f3eea342eb288f986de9033102c1df`. Their 28→0 required-heartbeat employee failures and 112→0 required observations, as well as the original full 20/21 result, belong to that original implementation commit. They do not claim live or full verification of the review-fix commits.

The machine-wide `git unpushed` audit returned exit 1, reporting 309 repositories with local work. Unrelated repositories were left unchanged; the worker's two review commits intentionally remain local for the parent, per the task-specific landing boundary. The pending risks are parent integration, new-pin combined verification, and the previously recorded unrelated fleet-status failure.

---

Original implementation closeout below; all full-suite and live evidence in that section is for `827ac7b842f3eea342eb288f986de9033102c1df`.

FLUME-15 implementation report — October 5, 2026

**Status: DONE_WITH_CONCERNS.** Implementation and worker verification are complete.
All 19 baseline-passing suites still pass. The full result improved from 19/21 to
20/21; the sole remaining failure is the unchanged fleet-status policy-domain
assertion. The read-only live review has zero required heartbeat observations.
Parent review, main integration and combined verification with the new template
pin remain the parent's responsibility.

**Commit:** `827ac7b842f3eea342eb288f986de9033102c1df` — `FLUME-15: retire heartbeat requirements and preserve cleanup observations`.

Worktree: `/home/delorenj/code/33GOD/flume/.worktrees/flume-15`.
Branch: `feat/flume-15-retire-heartbeat`.
Baseline: `2034f78322b89af2b74db69bb182085a6966c20f`.
The worktree is clean. No push, merge or rebase was performed, following the
spec's worker landing boundary. No template source or gitlink was changed.

The complete spec and its sole frontmatter context file,
`/tmp/flume-orch/flume15-brief.md`, were loaded before implementation. Work resumed
from the existing WIP; no baseline capture or canonical template patch was redone.

**Changes made**

- Advanced the handbook to 1.5.0. Per-employee service requirements and lifecycle
  ownership now cover the gateway only. Removed the obsolete heartbeat schedule
  and reconcile policy. Declared both heartbeat unit patterns as retired
  candidates and made `per-agent-heartbeat` a required retired-mode declaration.
  Checkpoint supersession now resolves to the gateway.
- Removed employee heartbeat registry, timer, service, schedule, tick and
  reconcile observations, associated result types, counters and human output.
  Removed timer-only property reads and parsing helpers. Existing gateway
  stability, channel, ownership and uncertainty checks remain.
- Historical `systemd.heartbeat_timer` values are inert. Other retired registry
  keys and consumer/checkpoint topology defects retain their existing handling.
  Heartbeat units for registered or unknown employee IDs remain visible in the
  fleet unregistered sweep, including units found only in unit-file listings.
- Failed, timed-out, missing or malformed classification reads emit a host
  collection error while retaining candidate names and independently observed
  state. Missing properties remain null rather than invented states.
- Registry fallback writes only the gateway field. Parity migration enables,
  probes and persists only gateway state. Hire deferrals and summaries no longer
  require or present heartbeat health.
- Converted obsolete tests into gateway-only requirements, historical registry
  compatibility, retired candidate state and observation failure coverage.
  Preserved gateway activation durability and failed-postcondition tests.
  Exact retired-mode counts and retired-candidate lists include heartbeat.

**Files changed (20)**

- `contracts/handbook.yaml`
- `packages/flume-hr/src/hire/HireRecipe.ts`
- `packages/flume-hr/src/hire/PrintHermesSummary.ts`
- `packages/flume-hr/src/org/contract.ts`
- `packages/flume-hr/src/org/index.ts`
- `packages/flume-hr/src/org/inventory.ts`
- `packages/flume-hr/src/org/output.ts`
- `packages/flume-hr/src/org/profile.ts`
- `packages/flume-hr/src/org/status.ts`
- `packages/flume-hr/src/org/systemd.ts`
- `packages/flume-hr/src/org/types.ts`
- `packages/flume-hr/src/parity/rules.ts`
- `tests/fleet-contract-regressions.mjs`
- `tests/fleet-inventory-regressions.mjs`
- `tests/fleet-status-regressions.mjs`
- `tests/fleet-systemd-regressions.mjs`
- `tests/helpers/fake-systemctl-bin.mjs`
- `tests/helpers/fake-systemctl.mjs`
- `tests/pjan-48-regressions.mjs`
- `tests/pjan-86-hermes-deploy-regressions.mjs`

**Executed verification**

Commands ran from the worker worktree unless stated otherwise:

```sh
node scripts/run-tests.mjs fleet-systemd fleet-contract fleet-inventory pjan-48 pjan-86 > /tmp/flume-orch/flume15-targeted.log 2>&1
node scripts/run-tests.mjs fleet-systemd fleet-contract fleet-inventory pjan-48 pjan-86 > /tmp/flume-orch/flume15-targeted-final.log 2>&1
node scripts/run-tests.mjs > /tmp/flume-orch/flume15-verification.log 2>&1
git diff --check
git diff 2034f78322b89af2b74db69bb182085a6966c20f HEAD --check
git status --short --branch
git ls-tree HEAD templates/hermes-agent
```

The first two targeted logs are historical failed attempts. The first exposed
noncanonical YAML serialization. The second passed every systemd behavior case
but exposed two stale declaration assertions: five retired modes and the old
retired-candidate list. Both were corrected before committing and before the full
run. The full run is the final verification result; its fleet-contract and
fleet-systemd suites both PASS. No assertions were loosened, no suites were
quarantined, and the hard gates were not skipped.

Full-run typecheck PASS (3.3s), build PASS (290ms). Full run completed in 935.2s:
**21 attempted, 20 passed, 1 failed, zero quarantined failures; exit code 1**.
The exit code reflects the existing fleet-status failure. The baseline had
21 attempted, 19 passed and two failed. Machine-readable comparison, precise
failed check and log digests are in
`/tmp/flume-orch/flume15-verification-comparison.json`.

| Suite | Saved baseline | Worker result | Worker duration |
| --- | --- | --- | --- |
| engagement-regressions | PASS | PASS | 47ms |
| fleet-shared-bloodbank-regressions | PASS | PASS | 22ms |
| hermes-profile-inheritance-regressions | PASS | PASS | 48.5s |
| pjan-48-regressions | PASS | PASS | 12.0s |
| fleet-contract-regressions | PASS | PASS | 24.9s |
| fleet-inventory-regressions | PASS | PASS | 37ms |
| fleet-provenance-regressions | PASS | PASS | 37ms |
| fleet-status-regressions | FAIL | FAIL | 340.3s |
| fleet-health-regressions | PASS | PASS | 164.3s |
| fleet-scaffold-regressions | PASS | PASS | 20.9s |
| soul-project-bank-regressions | PASS | PASS | 198ms |
| named-agent-regressions | PASS | PASS | 1.9s |
| role-projection-regressions | PASS | PASS | 2.6s |
| role-selection-regressions | PASS | PASS | 8.0s |
| role-contract-regressions | PASS | PASS | 202ms |
| named-agent-contract-regressions | PASS | PASS | 215ms |
| fleet-profile-regressions | FAIL | PASS | 61.4s |
| fleet-systemd-regressions | PASS | PASS | 228.4s |
| pjan-86-hermes-deploy-regressions | PASS | PASS | 11.5s |
| skillex-only-config-regressions | PASS | PASS | 1.0s |
| skillex-resync-regressions | PASS | PASS | 8.6s |

The remaining failure is exactly:
`the nine status domains are not the contract's three policy_domains: the contract's axis is the three-value one`.
It appears in both baseline and worker logs. No heartbeat expectations remain in
this failure. The baseline fleet-profile failure concerned the live profile-root
snapshot changing during a read; it did not recur in this run. No unrelated test
was weakened or fixed to obtain these results.

**Read-only live proof**

Saved baseline data came from main's pre-change built CLI; it was preserved.
The worker's after snapshot was refreshed after the full verification at commit
`827ac7b842f3eea342eb288f986de9033102c1df`. Both used:

```sh
env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus node packages/flume-hr/dist/index.js review --domain systemd --json
```

Before CWD: `/home/delorenj/code/33GOD/flume`.
After CWD: `/home/delorenj/code/33GOD/flume/.worktrees/flume-15`.
No `--live` or remediation was used. No operator service, profile, Plane, gateway
configuration or vault mutation was invoked by these review commands.

| Metric | Before | After |
| --- | --- | --- |
| Selected employees | 28 | 28 |
| Required observations involving heartbeat (including topology) | 112 | 0 |
| Failed required observations involving heartbeat | 98 | 0 |
| Heartbeat field observations | 84 | 0 |
| Failed heartbeat field observations | 70 | 0 |
| Employees failing any heartbeat requirement | 28 | 0 |
| Systemd drifted employees | 28 | 22 |
| Topology OK employees | 0 | 23 |

Both envelopes are `ok: true`; the user manager is available in `degraded` state,
which the contract permits, and the shared Bloodbank gateway is healthy.
The final after snapshot has 28 passing, 2 warning and 26 failing employee
observations; none concerns heartbeat. The host unregistered warning remains:
four units, classified as one transient, one profile-correlated and two
unclassified. Remaining examples include undeclared messaging, unpinned gateway
entrypoints and deferred gateways still enabled/active. These were reported and
left untouched.

Consolidated counts, definitions, samples and raw snapshot hashes:
`/tmp/flume-orch/flume15-live-review.json`.
Standalone human-readable evidence for the parent's vault copy:
`/tmp/flume-orch/flume15-live-review.md`.
Raw successful snapshots:
`/tmp/flume-orch/flume15-live-before-bus.json`,
`/tmp/flume-orch/flume15-live-after-bus.json`,
`/tmp/flume-orch/flume15-live-after-final-bus.json`.
Initial captures without the user-bus environment are retained as
`flume15-live-before.json` and `flume15-live-after.json`; they reported
manager-unavailable and are not used to claim live acceptance. The suite's live
systemd branch also skipped under its default environment; the separate
bus-enabled CLI capture supplies the live evidence. Sequential snapshots are not
a frozen host, so unrelated processes may change between reads.

**Canonical template follow-up**

At original pin `97f9ff82e087dad3273c5cc596feac6b39f2c370`, the header and
no-systemd heartbeat status were already corrected. Only the canonical registry
writer still created `heartbeat_timer` and needed removal on reprovision.
The exact before/after proposal is retained in
`/tmp/flume-orch/flume15-template-followup.md`.

The parent/user landed and pushed that change as
`4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`, with independent PASS reported by the
user. Read-only remote inspection confirmed that commit. Main Flume commit
`73c49069011f05cc8e66b451b8732ceae54779b2` consumes it, confirmed with `git ls-tree`.
The worker intentionally retains `97f9ff82e087dad3273c5cc596feac6b39f2c370`.
This worker did not redo the canonical patch or its tests. Parent handles
combined verification and integration with the new pin.

**Remaining concerns and handoff**

- The unrelated fleet-status assertion remains red; overall verification is
  deliberately not reported as an all-green run.
- The live workforce still has 22 employees with unrelated systemd drift and
  the host unregistered-unit warning. No remediation or production deployment
  is part of this task.
- External consumers expecting removed heartbeat result fields, counters or
  exported timer parsing helpers must adapt to handbook 1.5.0. External consumer
  repositories were not tested by this worker.
- Independent parent review and integration with the new template pin remain
  outstanding. Source is fixed at the committed worker revision and ready for
  that review; nothing was pushed, merged or rebased.

`git unpushed` was executed and saved to
`/tmp/flume-orch/flume15-git-unpushed.log`; it exited 1 and reported this worker's
one intentionally unpushed commit plus unrelated existing work across other
repositories. Those repositories were not modified or landed by this worker.
The task-specific no-push boundary controls this handoff.

Source is held at `827ac7b842f3eea342eb288f986de9033102c1df` pending reviewer patches.
Per the parent, all three independent review layers are running against
`/tmp/flume-orch/flume15-review.diff`. No wider reruns were performed after
full verification. This statement records review progress, not review acceptance.
