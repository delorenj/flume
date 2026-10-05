# Current installed evidence — October 5, 2026

This document preserves the worker's before/after snapshots. Subsequent independent review, combined main verification and integration have completed. The current installed CLI proof at reviewed main `c48ee0242007880c397917266b4107d2b669f938` and template `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74` is in `installed-review.md` and `installed-review-summary.json`. It selects 28 employees, produces 56 current systemd observations and zero required-heartbeat observations. The workforce remains unhealthy for unrelated findings. See `../recovery-delivery.md` for the final verification boundary.

Pending-parent statements in the historical snapshot below describe its recording time.

---

FLUME-15 consolidated live evidence — October 5, 2026

The read-only review now has **zero required heartbeat observations**, compared
with 112 before retirement. Employees failing any heartbeat requirement fell
from **28 to zero**. The workforce still has unrelated systemd findings.

Worker commit: `827ac7b842f3eea342eb288f986de9033102c1df`.
Baseline commit: `2034f78322b89af2b74db69bb182085a6966c20f`.
Handbook: `1.4.0` before, `1.5.0` after.
The final after capture was taken after the full worker verification.

| Metric | Before | After |
| --- | --- | --- |
| Selected employees | 28 | 28 |
| Required observations involving heartbeat, including topology | 112 | 0 |
| Failed required observations involving heartbeat | 98 | 0 |
| Heartbeat field observations | 84 | 0 |
| Failed heartbeat field observations | 70 | 0 |
| Employees failing any heartbeat requirement | 28 | 0 |
| Employees with systemd drift | 28 | 22 |
| Employees with passing topology | 0 | 23 |

Both review envelopes returned `ok: true`. Both user-manager readings were
`available` with state `degraded`, which the handbook permits. The shared
Bloodbank gateway was healthy in both snapshots.

The after review carries 28 passing, 2 warning and 26 failing employee
observations, with no collection errors and no heartbeat observations. The host
unregistered warning remains: four units, comprising one transient, one
profile-correlated and two unclassified units. These were reported and left
untouched.

| Employee example | State | Remaining gateway finding codes |
| --- | --- | --- |
| bloodbank-pm | fail | channel-undeclared, entrypoint-unpinned |
| candystore-pm | fail | channel-undeclared, entrypoint-unpinned |
| client-portal-pm | fail | channel-undeclared, entrypoint-unpinned |
| condaleeza | fail | channel-undeclared |
| deckard-pm | fail | deferred-but-enabled, deferred-but-active |

Counts of heartbeat observations include required topology observations whose
items name heartbeat units, as well as the retired registry/service/timer fields.
The count of heartbeat field observations is narrower and counts only fields
whose names contain `heartbeat`. Counts describe observations and employees,
respectively; multiple failing observations may concern one employee.

Both snapshots used this read-only command:

```sh
env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus node packages/flume-hr/dist/index.js review --domain systemd --json
```

Before CWD: `/home/delorenj/code/33GOD/flume`.
After CWD: `/home/delorenj/code/33GOD/flume/.worktrees/flume-15`.
No `--live` or remediation was used. No service, profile, Plane, gateway
configuration or vault write was invoked by these review commands.

Full worker verification: typecheck and build PASS; 21 suites attempted,
20 PASS and one FAIL. Every one of the 19 baseline-passing suites still passes.
Fleet-contract and fleet-systemd both PASS. The sole remaining failure is the
unchanged fleet-status `policy_domains` assertion. The baseline fleet-profile
snapshot failure did not recur. The run exited 1 because of that existing
fleet-status failure; no suites were quarantined.

The worker retains template pin `97f9ff82e087dad3273c5cc596feac6b39f2c370`.
The canonical registry follow-up is landed as
`4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`; parent Flume main `73c4906` consumes it.
Combined verification with the new pin remains with the parent. The source tree
is clean and held at the worker commit pending reviewer patches. Per the parent,
three independent review layers are running against
`/tmp/flume-orch/flume15-review.diff`. Their results are not asserted here.

Machine-readable consolidated evidence: `/tmp/flume-orch/flume15-live-review.json`.
Full implementation report: `/tmp/flume-orch/flume15-report.md`.
Per-suite baseline comparison: `/tmp/flume-orch/flume15-verification-comparison.json`.
Full test log: `/tmp/flume-orch/flume15-verification.log`.
Canonical template follow-up: `/tmp/flume-orch/flume15-template-followup.md`.

Raw snapshot evidence:

- `/tmp/flume-orch/flume15-live-before-bus.json` — SHA-256 `3f92918fa6074338ec19ea6d0d1979c33de824ddae4e267d115df6e395e8479c`
- `/tmp/flume-orch/flume15-live-after-bus.json` — SHA-256 `f8cf0f7501dd043a46f4bb9e9fbfc6063cb06d96ef2acebc1ffdba3703c78ab8`
- `/tmp/flume-orch/flume15-live-after-final-bus.json` — SHA-256 `f8cf0f7501dd043a46f4bb9e9fbfc6063cb06d96ef2acebc1ffdba3703c78ab8`

Initial snapshots without user-bus environment reported manager-unavailable and
are retained separately. They do not supply live acceptance. These successful
snapshots are sequential rather than a frozen host, so unrelated processes may
change between reads. No runtime deployment or cleanup is claimed.

This standalone Markdown document is ready for the parent's vault copy; no vault
copy was performed by this worker.
