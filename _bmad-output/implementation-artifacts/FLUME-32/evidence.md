# FLUME-32 worker evidence

Status: IN_PROGRESS
Worker: flume-32-implementation
Worktree: /home/delorenj/code/33GOD/.worktrees/flume-32
Branch: feat/flume-32-role-declaration
Base: c3561fb (rebased clean from 8577aded; 80948c3 preserved)

- AC-1: PENDING
- AC-2: PENDING
- AC-3: PENDING
- AC-4: PENDING
- AC-5: PASS (shared-contract.log; 3/3 suites, typecheck/build pass)
- AC-6: PENDING (requires new live ledger evidence)

## Worker #2 resume
Start Plane comment: dcb452cd-432f-47e5-884b-caf41ca62146.
First commit preserved worker #1 RED verbatim (rebased SHA 1d8b241).
Observed RED: `node tests/role-contract-regressions.mjs` exit 1: missing validateRoleDeclaration (red.log).
GREEN: `node scripts/run-tests.mjs role-contract named-agent` exit 0, 3/3 suites (shared-contract.log).
Established readRoleIdentity moved unchanged to workforce/identity.ts; parity re-exports it. Both consumers invoke that same path. Shared schema bundled from JSON, eliminating the old parallel FALLBACK_SCHEMA. Named-agent fixtures with mismatched banks corrected to agent-<id> so skill/desk tests still exercise their intended gate. Pack(s)/set use one resolver.

Rebased baseline: `/tmp/flume32-baseline-postrebase.log`: typecheck/build PASS, 11/16 suites PASS; fleet-status/health/systemd already fail in worker #1's old baseline; profile environment/mise trust and pjan-86 5s Python timeout also failed. Full output preserved, no failures hidden or quarantined. Retry `/tmp/flume32-baseline3.log`.
No fleet services/default config/main checkout mutations.
