# Independent FLUME-97 review

Candidate: `98a8baad8b5c2097f6f04d2eabc8866ed904fa4e`; base: `3a035d3a33fe67df49016d5f0e44f7ae044f6266`.

## Verdicts

- Specification: HOLD. Registration/metadata retirement and static canonical refresh behavior are verified. Preservation during raced deletion fails. Deployed-PM rollout remains parent-owned and unperformed; fixtures do not satisfy deployed acceptance.
- Quality/security: FAIL, one P2 correctness/data-loss finding. No merge or rollout authorization is given.

## Finding

**P2 — Revalidate deletion ownership instead of unlinking a stale classification.** `packages/flume-hr/src/parity/rules.ts:3278-3286`; ownership classifier `packages/flume-hr/src/scaffold/obsolete.ts:64-74`.

`obsoleteScaffoldScripts()` hashes the pathname and returns only path/removable/detail. The migration later calls `unlinkSync(target)` without preserving or rechecking the classified file identity/content. If an editor, checkout, or another refresh replaces an allowlisted helper after its read, the replacement is deleted even when it contains new local content. This violates the explicit local-content-preservation boundary.

Reproduction uses the actual built CLI and an already-converged scratch desk. A child-local filesystem preload replaces `managed-execution.py` immediately after migration reads its allowlisted bytes (audit reads first, migration second), keeping the original under `.old`. Actual outcome: `status: applied`, replacement absent, original retained, detail claims `removed obsolete template-owned .scripts/managed-execution.py`. Static negative tests cannot catch this. Use an identity-checked, recoverable deletion operation with parent revalidation/locking, preserve and report mismatches, and add this deterministic regression.

Command: `node --import "$TMPDIR/flume97-scratch-preload.mjs" "$TMPDIR/flume97-review-deletion-edges.mjs"` (240-second outer bound, provider keys blank, private fleet). Exit 0 means successful defect reproduction, NOT safe product behavior. Receipt: `flume97-review-deletion-edges.log`.

Additional static checks passed: in-repository scripts-parent link, role ancestor link, FIFO, >64-KiB modified helper, and older allowlisted template version. Allowlisted hashes cover all historical helper versions in template Git history. Existing regression suite passes modified content, symlink, directory, linked parent, preview/apply convergence, scripts-only boundaries, runtime/registry/persona preservation.

## Registration evidence

`node tests/flume-97-registration-regressions.mjs`: exit 0, four groups. Same production writer is tested for absent/shadow/managed, unrelated fields/prior employees, exact metadata, identity mismatch, repeat byte-no-op and missing manifest.

Additional scratch harness reuses the committed public-suite fixture factory without altering production code or bypassing credential checks: `node --import "$TMPDIR/flume97-scratch-preload.mjs" "$TMPDIR/flume97-review-public-path.mjs"`, exit 0. Actual public CLI dry-runs for absent/shadow/managed exit 0 and preserve manifest bytes/no role creation. Actual hires reach registration and read-back verifies exact intended employee fields, no engine metadata/pins, execution configuration preserved. Prior employee survives; occupied repeat refuses without manifest changes; injected manifest-write failure exits 1, reports failure, preserves bytes and never claims completion.

All public apply hires still exit 1 later at `Member gateway credential not verified: ... gateway-mint-or-confirm-failed`. The unmodified FLUME-45 suite exits 1 on both base and candidate, short-circuiting at its first scenario. This is NOT successful end-to-end hiring. It is enough evidence for the narrow changed registration boundary, not all FLUME-45 lifecycle behavior.

`evidence.md:10,20` incorrectly describes this as necessarily before registration; fresh direct public execution reaches `Rendered Hermes role ... lifecycle postconditions are pending` and the scratch read-back confirms registration. Preserve historical run context but correct the current description.

The new `registerRenderedAgent` source-module export is test-accessible but is not re-exported by workforce/index or either built CLI/MCP artifact. No public command/transport API was added.

## Commands and gates

- `npm run typecheck && npm run build`: exit 0.
- `node tests/flume-97-scaffold-regressions.mjs`: exit 0, four groups.
- `node tests/fleet-scaffold-regressions.mjs`: exit 0, one explicitly skipped live-fleet case. Deleted tracked obsolete paths disappear; a real unexpected-owned provisioning extra remains.
- `node tests/policy-refresh-regressions.mjs`: exit 0, six groups.
- `node tests/scheduling-policy-audit-regressions.mjs`: exit 0, seven groups.
- `git diff --check 3a035d3..98a8baa`: exit 0.
- Tracked-source Git search for `KREBS_LIFECYCLE_SPEC|krebs/spec/lifecycle[.]v1[.]yaml`, excluding agents/worktrees/Markdown: exit 1, no matches.
- Template removal commit c738f69 is an ancestor of pinned 3b9b7e8: exit 0; helper hashes match historical blob inventory.

Fresh five-suite base/candidate comparison used profile scratch, provider keys blank, no inherited NODE_OPTIONS, and only harness-local `--import` redirection. Scheduling suite was adapted outside the repo solely for root/cache/module-resolution paths so its cache writes stay scratch-local; assertions and production code unchanged. Initial adapter failed module resolution; corrected adapter was rerun on both trees. Final exits (base/candidate): runtime-singleton-targets 1/1; scheduling-policy 0/0; policy-refresh 0/0; specialist-hire 0/0 (43 groups each); persona-update 1/1. Failures agree on their assertion/dependency. Specialist success with harness-only preload shows the previous inherited-preload failure is configuration-specific.

Full suites were not rerun by this reviewer. Parsed existing raw receipts independently: baseline 55/38 pass/17 fail/exit 1; first candidate 57/40/17/exit 1; all 55 shared verdicts identical, two new suites pass. Later 57/39/18 run differs only in fleet-status, whose output records a concurrent staged-index hash change. Both separately retained clean fleet-status runs fail the same eight cases. These are retained evidence with their original limitations, not a new full-tip all-green certification. Only evidence.md differs between implementation commit 5213d55 and reviewed tip 98a8baa.

No tracked code/evidence edits, commits, service/provider/board mutations or live desk changes were made. Worktree and staged diff remain clean at the reviewed tip. Scratch-only scripts and logs were created. Active-profile review skill was updated with the deletion-race and partial-public-path methods.
