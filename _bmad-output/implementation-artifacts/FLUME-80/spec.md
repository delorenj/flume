---
title: 'FLUME-80: fresh vault verification and safe provisioning retry'
type: 'bugfix'
created: '2026-11-19'
status: 'in-review'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="user-authorized isolated implementation; parent owns independent review and merge">

## Intent

Fix stale read-after-write verification for every employee using the existing identity provisioner. Scope cache bypass to identity-item reads, verify the Access section and field-ID reference, and distinguish confirmed absence from uncertain persistence. Preserve tokens when persistence or binding is uncertain; clean up only a confirmed unpersisted orphan. Block stranded credential retries before minting; provide secret-free reconciliation evidence and bounded owner-approved recovery guidance. Preview stays read-only, partial capabilities stay honest, and unrelated credentials and employees remain unchanged.

No live provider/vault access, employee provisioning, rotation, policy changes, lifecycle implementation, board changes or main merge. Exercise isolated fixtures, preserve collision/lifecycle regressions, document all six ticket ACs and live limitations, commit only ticket files and push the branch for independent review.

</frozen-after-approval>

## Implementation Notes

- Base: f85a126835ce3f4a4b5f30198b949d865a9b54b6. Shared main was dirty; isolated worktree created with wt from origin/main. No existing FLUME-80 worktree.
- Initial production scope was provision.ts alone. Independent HOLD remediation now also owns the shared secret-free access-issuance.ts reader, company.ts Access bind/ownership guards and the narrow lifecycle-adapters.ts retained-token handoff. Tests remain real-CLI identity-provision-regressions.mjs; docs and evidence stay ticket-scoped.
- Existing catch-all deletes a minted token on every vault verification or binding error; current fake op never returns stale data. Installed op help confirms --cache=false is supported. No provider credentials were read.
- g33 preflight PASS with legacy-enrollment and missing-resolver WARNs. Routing is advisory; existing workforce provisioner owns this employee account repair, not PJangler project provisioning.
- No intent gaps or irreversible operations in this isolated patch. Independent review is explicitly assigned to the parent; write a runnable review handoff rather than claiming self-review is independent.
- Implemented fresh ID-addressed item reads/lists, paired Access field edit and value/unique-ID verification, guarded cleanup with provider absence readback, pre-mint stranded conflict and secret-free receipt comparison. Uncertain writes/signals, binding and receipt failures retain tokens. Provider messages withheld only in provisioning; cfError lifecycle contract retained.
- Current real-CLI fixture proves 49 groups, including independent HOLD Q1/Q2/Q3 closure. The original 22-group evidence predates both HOLD remediation passes. The baseline reproduction still asserts the original unsafe stale-read/delete/retry sequence rather than skipping current assertions.
- Typecheck/build, company identity and registry/Plane suites pass. Direct lifecycle without preload passes 54 scenarios. Two preload/overlay gateway fixtures fail at the same locations with current and baseline provisioners; controls replace provision.ts only, not current lifecycle/company/issuance source. Full suite is not green or claimed as run.
- Handed independent review to parent with complete review-request.md; no independent review verdict or merge claim.
