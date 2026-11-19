# Independent review request: FLUME-72 phase 1

Review the candidate task branch `feat/FLUME-72-policy-proof` against base
`af3bf9d31ba20b6e513fd2254a4094312456cd5d` in the isolated worktree
`/home/delorenj/code/33GOD/flume/.worktrees/feat-FLUME-72-policy-proof`.
The implementer must not count self-inspection as this independent review.

Inspect the actual diff and surrounding consumers. Look for missing behavior as
well as regressions, especially any way malformed registry/policy or unreadable
inputs can falsely certify current instructions; bounded descriptor reads and
valid runtime symlinks; preservation of local personas and refusal content;
all-role and portable propagation; explicit distinction between composed,
on-disk, running-session and runtime-clock evidence. Verify the current
coverage report is attributable and docs do not imply universal deployment or
live cutover. The canonical policy source is roles/_base.md; do not fork it.

Run focused tests with Node >=24 and /usr/bin/python3 (PyYAML), session scratch
TMPDIR, private HOME/registry fixtures for mutation paths, and no real credentials.
Do not apply live refreshes or alter deployed instructions, schedules, registry,
configuration, services, global agents files, unrelated work, or Plane lifecycle.
Report actionable findings with file/line, real trigger, consequence and narrow
correction. Separate pre-existing wider failures from candidate regressions.
Return findings to the parent; do not merge or declare runtime compliance.
