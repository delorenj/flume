---
title: 'FLUME-72: Narrow deployed scheduling-policy refresh'
type: 'chore'
created: '2026-10-29'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="operator-authorized rollout continuation">

## Intent

Ship and apply a supported Flume-owned policy-only refresh, using the bounded
`roles/_base.md` section, without replacing personas or unrelated scaffolds.
Preview actual tracked/runtime targets and ownership; apply only safe owned
files; read back hashes and prove a no-op second apply. Refuse handwritten,
missing, ambiguous and unsafe ownership rather than adopt it. Portable employees
must retain adapter ownership receipts. Update the explicitly authorized global
`~/.agents/AGENTS.md` rule separately, preserving its unrelated dirty edits.
No services, schedules, credentials, registry, role declarations or provisioning.
Missing reporter coverage stays unproven under FLUME-67. On-disk instruction
updates do not prove already-running sessions reloaded them.

</frozen-after-approval>

## Implementation Notes

- Pillars 1/2/3: ship the small executable owner backfill; dogfood Flume; keep it reusable rather than a one-off fleet rewrite.
- Sources: `parity/rules.ts` composeSoul/SOUL_COMPOSED_MARKER; `workforce/scheduling.ts` specialistSchedulingRequest; template specialist adapter safe/atomic/digest and profile lock.
- Read-only inventory found 38 employees, 7 deleted portable definitions, handwritten dumply/james-brennan, and a monitoring placeholder. Refuse unsafe cases; do not restore deleted definitions or provision the reporter.
- CodeGraph contains predominantly fake vectors; no semantic result claimed. Fleet skill quarantined; inspected source without changing trust.
- Scope is reversible instruction files plus specialist receipt only. Existing unrelated forge directory and global dirty work are preserved. Operator explicitly authorizes global shared instruction and fleet policy rollout.
- Verify targeted fixtures, typecheck/build, real preview/apply/readback/second pass, and current audit. Runtime Candybar doctor is callable and currently reports 9 violations; do not auto-disable them.
