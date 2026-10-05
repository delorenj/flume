- `kB = 189,698 / 1,000 = 189.698; N = min(floor(√189.698 + 1), 10) = min(14, 10) = 10.`

- [types.ts:168](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/types.ts:168): The unconditional `per-agent-heartbeat` requirement rejects previously valid contracts. The original schema-5 handbook and a schema-4 variant both fail despite the advertised compatibility range. Version the requirement and test historical documents.

- [systemd.ts:1490](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1490): A retired timer stored in `gateway_unit` enters `owned`, disappears from the retirement sweep, and becomes a duplicate gateway. Retired shapes should remain cleanup candidates regardless of stale registry references.

- [systemd.ts:1481](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1481): Additional non-heartbeat unit declarations are ignored. A validated `worker_service` appears in inventory expectations, while review reports passing gateway-only topology with the worker absent. Observe these declarations or explicitly report unsupported coverage.

- [rules.ts:2300](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/parity/rules.ts:2300): `profileUnits()` still audits heartbeat units as current profile wiring. An otherwise passing fixture fails after adding a retired timer with stale `HERMES_HOME`. Report that condition through retirement cleanup instead of employee profile parity.

- [fleet-contract-regressions.mjs:947](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/tests/fleet-contract-regressions.mjs:947): Retirement integrity is tested only by mode-ID presence. Replacing its detector with a nonmatching regex and removing heartbeat candidates still validates; leftover heartbeats then become unclassified. Verify effective detection of both retired unit types.

- [systemd.ts:1375](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1375): Classification output bypasses `max_show_bytes`. A 20,123-byte response succeeds with a 16,000-byte limit. Enforce the configured limit before parsing, as stabilization sampling already does.

- [systemd.ts:1376](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1376): Duplicate identities escape malformed-response validation. Conflicting blocks for one unit, or multiple `Id=` properties, are accepted with the first value reported as direct evidence. Reject ambiguous identities and cover both cases.

- [systemd.ts:1380](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1380): `WORD` checks spelling rather than state meaning. `ActiveState=not-a-real-state` produces no assessment error and is emitted as direct evidence. Unsupported state vocabulary should retain uncertainty.

- [handbook.yaml:815](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/contracts/handbook.yaml:815): The retirement rationale relies on gateway restart behavior, but an active gateway with `Restart=no` passes review. Validate and test the restart policy underpinning the replacement liveness model.

- [status.ts:4143](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/status.ts:4143): Capping observations loses the discovered denominator. Two retired units with a cap of one produce `total: 1` and “1 of 1.” Preserve discovered totals separately from classified and emitted counts.

- [status.ts:3311](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/status.ts:3311): Recognized retired units are described as carrying “no contract classification,” followed immediately by “1 retired.” Distinguish known retirement cleanup from genuinely unclassified units so the report points to the correct action.


