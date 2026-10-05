# Flume recovery delivery — October 5, 2026

The approved recovery source is reviewed, integrated and pushed on main. FLUME-32 now proves actual CLI/Copier hiring and repeat onboarding; FLUME-15 retires heartbeat requirements; Momo contains the Board Cranker ready-ticket adapter. FLUME-29's named-specialist spec is finalized with the confirmed Hermes CLI and identity choices. Live named-specialist hiring and Board Cranker activation are separate pending runtime work.

## Integrated source

| Component | Revision | Delivery |
| --- | --- | --- |
| Flume hire | `3630ca8f3f9b81712ca013a616159a41bd742cdb` | Reviewed FLUME-32 merge on main |
| Flume combined source | `c48ee0242007880c397917266b4107d2b669f938` | Reviewed FLUME-15 merge, including hire source |
| Hermes template | `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74` | Canonical pushed template consumed by Flume |
| Momo | `4029c3471a738bd4dfcdca3038abdbebcc6971ae` | Reviewed Board Cranker merge on main |
| Momo review fixes | `c32901220716c5b3a1f09332c3ff37a15b6edafd` | Readiness, durable execution and production-boundary corrections |

The three implementation specs are marked done and their execution tasks are checked. Individual findings from every independent review layer retain verdict rows. All patch verdicts are resolved; pre-existing observer debt remains in [deferred-work.md](deferred-work.md).

Completed worktrees `.worktrees/flume-32-hire`, `.worktrees/flume-15` and `/tmp/momo-board-crank-20261005`, plus their feature branches, were removed after integration. Before removing the Flume worktrees, their submodules were verified clean with no unpublished submodule commits. Unrelated checkpoint branches and canonical template WIP were preserved.

## Verification

Flume typecheck and build passed. The combined main run attempted 23 suites and passed 22, with no quarantined failures. Every previously passing suite remains passing. The remaining fleet-status suite contains the pre-existing assertion that classification policy has exactly three domains; the October 2 shared-board exceptions already include `project-registry`.

The combined fleet-status run also caught the parent's concurrent documentation commit through its repository snapshot check. That was a verification sequencing error. The affected suite was rerun with the Flume checkout untouched: the no-write assertion passed, and only the pre-existing policy-domain assertion failed. The contract and assertion were preserved. No full-suite success is claimed.

```sh
cd /home/delorenj/code/33GOD/flume
node scripts/run-tests.mjs
node scripts/run-tests.mjs --no-typecheck --no-build fleet-status
```

Logs: `/tmp/flume-orch/main-combined-verification.log` and `/tmp/flume-orch/main-fleet-status-isolated.log`.

Momo's final combined library and public CLI run passed **62/62**, including production receipt traversal, hydrated readiness, read-only public modes and real subprocess supervision. The earlier unchanged Python hardening harness passed **79/79**.

```sh
cd /home/delorenj/code/33GOD/momo
BLOODBANK_SOURCE_ROOT=/home/delorenj/code/33GOD/bloodbank \
PILOT_SOURCE_ROOT=/home/delorenj/code/33GOD/pilot \
node --test skill/scripts/tests/test_board_crank.mjs \
  skill/scripts/tests/test_board_crank_cli.mjs
```

Log: `/tmp/flume-orch/momo-main-verification.log`. The updated [Board Cranker report](Board-Cranker/implementation-report.md) preserves the worker fixes and final parent verification.

## Installed Flume proof

`/home/delorenj/.local/bin/flume` resolves to the built main checkout. The installed handbook validates as **1.5.0**. A read-only live systemd review with the actual user bus selected **28 employees**, emitted **56 current systemd observations**, and found **zero required-heartbeat observations** and **zero employees failing heartbeat requirements**.

```sh
env XDG_RUNTIME_DIR=/run/user/1000 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  /home/delorenj/.local/bin/flume handbook validate --json

env XDG_RUNTIME_DIR=/run/user/1000 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  /home/delorenj/.local/bin/flume review --domain systemd --live --json
```

The workforce remains unhealthy for unrelated gateway/topology findings: 22 unhealthy employees and six healthy. The user manager was available/degraded. No service, profile or registry remediation was performed. [Installed review](FLUME-15/installed-review.md) and [bounded summary](FLUME-15/installed-review-summary.json) retain the proof; worker before/after snapshots remain historical evidence.

FLUME-32's recovered AC-6 receipt remains **PASS_SEAM_ONLY**. It proves the recorded matching fallback/member-ledger request and does not supply multiplexed Bloodbank ingress acceptance. The retained [hire evidence](FLUME-32/evidence.md) states that scope.

## Board Cranker runtime boundary

Canonical Momo source CLI refusal checks for missing and disabled configuration both returned exit **78**, `status: refused`, and `live_execution_proof: false`. Watched operator registry, global cron and driver-lease files remained byte-identical. [Source refusal evidence](Board-Cranker/source-refusal.json) records the cases.

At `2026-10-05T12:39:32Z`, the installed skill resolved to `/home/delorenj/code/skillex/all-skills/momo` and lacked `scripts/momo-board-crank.mjs`. No installed invocation or cron delivery is claimed. A subsequent read-only schema inspection confirmed the global cron store has an empty `jobs` array; that observation does not establish schedule absence across all profiles. Earlier evidence of disabled cron `aec0b33a1d07` remains historical.

The board snapshot at `2026-10-05T10:51:00Z` had 33GOD-56/79/81 In Progress and contractor/runtime prerequisites 33GOD-44/46/50 in Backlog. A stale lease TTL does not establish free capacity. Activation still requires accepted installed/executing bundle identity, contractor/profile/memory policy, independent reviewers, one driver and reconciliation owner, fresh worker truth and matching retained started/completed receipts. See the [runtime gate](board-crank-runtime-gate.md) and [timestamped observation](Board-Cranker/runtime-gate.json).

No cron activation, live work dispatch, Plane write or fabricated runtime acceptance occurred during this recovery.

## Named-specialist spec

[FLUME-29](../specs/spec-flume-29-named-specialists/SPEC.md), its brownfield companion and specialist charters retain all six capabilities. Confirmed choices are Hermes CLI first, definitions at `~/.agents/workforce/<id>`, generated profiles at `~/.hermes/profiles/<id>`, and `infra-specialist` with display name **Big Chungus** and own bank `agent-infra-specialist`. This deliverable finalizes the spec; it does not claim either specialist has been hired.

## Closeout records

Final documents and bounded evidence are copied with SHA-256 verification to `/home/delorenj/code/DeLoDocs/Projects/AutomaticAI/Flume/2026-10-05-recovery/`, including refreshed historical heartbeat aliases. Verification logs are retained in that vault's `verification/` directory; its `copy-manifest.json` records source, destination and digest.

Only owned `flume` and `momo` gitlinks are advanced in the 33GOD parent. Unrelated staged `.gitmodules`/`pilot` changes and other WIP are preserved. Final `git unpushed` output and owned-repository checks are saved outside source in `/tmp/flume-orch/`; existing unrelated global WIP is reported separately and is not a claim that the whole workspace is clean.
