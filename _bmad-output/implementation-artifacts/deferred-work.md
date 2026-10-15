# Deferred work

- source_spec: `spec-flume-15-heartbeat-retirement.md`
  summary: Observe additional non-heartbeat per-agent unit declarations.
  evidence: B3; both baseline and reviewed observer sample only named canonical unit keys and ignore a validated worker_service declaration.
- source_spec: `spec-flume-15-heartbeat-retirement.md`
  summary: Apply the manifest show-output byte limit to unregistered classification.
  evidence: B6/E3; both baseline and reviewed classification use probeText without max_show_bytes before parsing.
- source_spec: `spec-flume-15-heartbeat-retirement.md`
  summary: Reject ambiguous duplicate identities in systemd show responses.
  evidence: B7; unchanged parseShowBlocks retains the first block for an Id and the first repeated Id value.
- source_spec: `spec-flume-15-heartbeat-retirement.md`
  summary: Preserve uncertainty for unsupported systemd state vocabulary.
  evidence: B8; baseline and reviewed unit views emit any syntactically safe word, including unknown states.
- source_spec: `spec-flume-15-heartbeat-retirement.md`
  summary: Assess the declared gateway restart policy in workforce reviews.
  evidence: B9; Restart is sampled but never evaluated by the baseline or reviewed gateway observer.
- source_spec: `spec-flume-15-heartbeat-retirement.md`
  summary: Preserve discovered unregistered-unit totals separately from capped classification totals.
  evidence: B10; baseline and reviewed totals use items.length after max_unregistered_units truncation.
- source_spec: `spec-flume-15-heartbeat-retirement.md`
  summary: Describe known retirement classifications distinctly from unclassified units.
  evidence: B11; the existing report describes every non-exception class as having no contract classification.
- source_spec: `spec-flume-32-hire-proof.md` and `spec-flume-15-heartbeat-retirement.md`
  summary: Update the stale fleet-status test that assumes three classification policy domains.
  evidence: Both saved pristine baselines fail the same assertion. The October 2 shared-board exceptions already declare project-registry, while fleet-status-regressions.mjs still expects only bloodbank, profile and systemd. No failure was quarantined and the production contract was preserved.

### DW-1: specialist-hire-regressions fails on a test-side non-recursive rmSync of a desk skill directory (ERR_FS_EISDIR), unrelated to this diff.
origin: spec-deferred c5abd1248305
location: tests/specialist-hire-regressions.mjs:49
source_spec: `FLUME-52-bind-employees-to-verified-native-plane-identities.md`
severity: medium
reason: The FLUME-52 diff touches no hire, onboard or skill code. The dev session reported the identical EISDIR failure in the untouched main checkout; a baseline (2e2b1b8) worktree run failed earlier at line 32 because no dist was built there, so that cross-check was inconclusive. Settle by running `node scripts/run-tests.mjs specialist-hire` on a built main checkout.
status: open
