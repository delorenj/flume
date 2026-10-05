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
