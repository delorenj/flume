# FLUME-13 candidate evidence

The observer reads numeric `/proc` entries with bounded `comm`, `cmdline` and `environ` reads (16 KiB each); it selects Hermes executable/comm processes only. It emits only recognized profile flags and a recognized `HERMES_HOME` profile name, never arbitrary arguments or environment values. It checks the shared root and resolves employees from the complete registered profile map. One host gateway is expected; worker and interactive processes can coexist. No service/process control is invoked. `/proc` on non-Linux hosts is unavailable, reported as uncertainty.

Actual commands in the isolated worktree:
- `node tests/live-process-regressions.mjs`: exit 0; selection, unique/conflicting/unregistered/missing identities, empty/denied/exited, cancellation/deadline, secret and read-only fixture assertions passed.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `node tests/fleet-status-regressions.mjs`: exit 1 before its assertions; fixture requires initialized template submodule at committed gitlink, missing in this worktree.
- `node tests/fleet-health-regressions.mjs`: exit 1 at same fixture setup precondition. Existing expectations of an unsupported process capability also require updating after submodule initialization.
- `git diff --check`: exit 0.

Read-only live invocation: `node packages/flume-hr/dist/index.js review --domain live_process --json --deadline-ms 5000`, exit 0; first sample selected PIDs 5339 (interactive, no registered profile), 697075 (host gateway), 1897468 (interactive, identity metadata unreadable); after the per-PID host finding refinement, the repeated invocation emitted one finding for each of those selected PIDs and seven additional `comm`-unreadable PIDs (3481816, 3482247, 3482248, 3482249, 3482279, 3482286, 3482292), each explicitly uncertain rather than selected as Hermes. Zero PIDs were attributed to employees. The report had host `error`, 48 employee visibility `error` observations, `complete:false`, `proven:false`. This is bounded live *uncertainty*, not proof of healthy runtime. PID 1897468's environ was denied; no process was signalled or changed. The process set can change between samples. Full command output was captured by terminal tooling outside the worktree; this file records only the reconciled sample, not unredacted process metadata.

Known limits: a failed `comm` read cannot identify whether its PID is Hermes; it is recorded as an observation error. A process with no recognized profile identity is not arbitrarily attributed. The inherited status envelope has no typed process summary; each selected PID is in an employee observation or a distinct host finding. The host summary carries totals and errors. No main integration or cleanup was performed.
