### Successful hire output does not verify heartbeat retirement

- **Changed surface:** [HireRecipe.ts:42](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/hire/HireRecipe.ts:42) stops treating heartbeat state as a deferral; [PrintHermesSummary.ts:37](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/hire/PrintHermesSummary.ts:37) removes the heartbeat line.
- **Impacted consumer or site:** The final hire result derives its deployment outcome at [HireRecipe.ts:302](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/hire/HireRecipe.ts:302).
- **Existing test evidence:** **Regression gap.** Repository-wide symbol/import searches found source assertions and the CLI tests examined. [pjan-86-hermes-deploy-regressions.mjs:128](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/tests/pjan-86-hermes-deploy-regressions.mjs:128) checks a dry run without a rendered role; its summary checks at line 980 inspect source text.
- **Missing verification:** A successful hire with an active gateway and historical non-active heartbeat metadata must have no heartbeat deferral or summary line.
- **Demonstration:** Restoring both the old heartbeat deferral and summary line left all four selected hire/registry suites passing.
- **Consequence:** A healthy hire can again report deferred capabilities solely because of retired heartbeat metadata.
- **Disposition:** `patch` — add a successful CLI hire fixture to `pjan-86-hermes-deploy-regressions.mjs` that asserts the final outcome and gateway-only summary.

### New registry rows lack verification of the gateway-only projection

- **Changed surface:** [rules.ts:1270](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/parity/rules.ts:1270) removes `heartbeat_timer` from newly written registry rows.
- **Impacted consumer or site:** Missing-row remediation invokes this writer at [rules.ts:4381](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/parity/rules.ts:4381).
- **Existing test evidence:** **Regression gap.** The examined registry-parity cases pre-create rows: [pjan-48-regressions.mjs:94](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/tests/pjan-48-regressions.mjs:94) checks Bloodbank repair, while [named-agent-regressions.mjs:111](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/tests/named-agent-regressions.mjs:111) checks identity repair. Symbol/import searches found no test directly exercising this writer’s new mapping.
- **Missing verification:** Remediation of an absent employee row must persist the canonical gateway name without creating heartbeat fields.
- **Demonstration:** Restoring the old `heartbeat_timer` write left the four selected hire/registry suites passing.
- **Consequence:** Newly repaired employment records can continue advertising a retired timer undetected.
- **Disposition:** `patch` — add an absent-row case to `pjan-48-regressions.mjs` and assert the persisted `systemd` mapping equals `{ gateway_unit: canonicalGateway }`.

### Manifest-only retired candidates are not verified

- **Changed surface:** [systemd.ts:1422](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1422) adds retirement classification through `retired_candidates` when no `retired[].detect` pattern matches.
- **Impacted consumer or site:** Fleet review exposes the resulting unregistered-unit class and cleanup guidance.
- **Existing test evidence:** **Regression gap.** Repository-wide searches found candidate validation and default-pattern assertions. The retirement cases at [fleet-systemd-regressions.mjs:920](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/tests/fleet-systemd-regressions.mjs:920) and line 982 use heartbeat names already matched by `retired[].detect`; the classification matrix uses a matching consumer name.
- **Missing verification:** A valid custom candidate unmatched by the detection expressions must receive `class: retired`, `guidance: retirement`, and `detail: retired:candidate`.
- **Demonstration:** Disabling this fallback left the three examined classification cases passing. An isolated CLI probe for `hermes-stray-pm-old-poll.timer` passed with the reviewed implementation and failed with the mutation, returning `unclassified` and `manual-review`.
- **Consequence:** Contract-declared cleanup candidates can lose their retirement classification.
- **Disposition:** `patch` — add that custom-pattern case to `fleet-systemd-regressions.mjs`.

## Other findings

- [types.ts:168](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/types.ts:168) makes `per-agent-heartbeat` mandatory through the unconditional completeness check at [contract.ts:670](/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/contract.ts:670), while the reader still advertises schemas 1–5. The previous v1.4.0 handbook and a schema-4 form without `service_manifest` both exit 2 with `INVALID_INPUT: retired must declare the superseded mode per-agent-heartbeat`. Older-contract tests downgrade the current handbook, retaining the new retirement entry, so they miss this compatibility regression.
