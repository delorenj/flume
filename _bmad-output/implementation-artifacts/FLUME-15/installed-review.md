# Installed Flume retirement proof — October 5, 2026

The installed `~/.local/bin/flume` resolves to the built main checkout at source revision `c48ee0242007880c397917266b4107d2b669f938`, consuming template `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`. Its handbook validates as 1.5.0.

The read-only live systemd review used `/run/user/1000/bus`, observed the available user manager, and selected all 28 registered employees. It emitted 56 current systemd observations and **zero required-heartbeat observations**; no employee failed a heartbeat requirement. Services, profiles and registry records were not remediated.

The overall review is still unhealthy: 22 members are unhealthy and 6 healthy, with unrelated gateway/topology findings. The manager is available but degraded. This proves retirement of heartbeat requirements, not fleet-wide health. The exact bounded summary is in `installed-review-summary.json`; full command output remains `/tmp/flume-orch/main-installed-review.json`.

Commands: `flume handbook validate --json` and `flume review --domain systemd --live --json`, with explicit user-bus environment.
