# FLUME-46 loop execution contract

## Source and schedule

- Approved epic: FLUME-46; planning companions retain every original AC. Fetch the current story with `px show <FLUME-N> --json` before implementing; grooming additions are context, not permission to weaken the accepted plan.
- Run with bmad-loop 0.12.0 **stories mode**, this folder's SPEC.md/stories.yaml, and the canonical Skillex `bmad-build-auto` skill. The dev primitive writes each `stories/<ticket>-<slug>.md`; never pre-label all stories done or ready-for-dev.
- Queue FLUME-47 through FLUME-53, in order. First run is capped at two stories; FLUME-48 also carries a done checkpoint. FLUME-49 onwards carry spec checkpoints before implementation. No unattended external provisioning, paid-plan activation, native account adoption or PX-13 dependency bypass.
- `operator.enabled=false`: unmet external ACs block instead of letting the loop advance past an awaiting-operator story and consume an unverified dependency. Do not rewrite ACs to make local-only evidence full completion.

## Workspace and authority

The supervisor creates `repo/.worktrees/FLUME-46-company-identity-loop` through `wt`. BMAD loop uses `scm.isolation=none` **inside this already isolated worktree**, with dev and review sessions sequential. Do not create nested raw-git worktrees or switch branches under the running loop. Main's existing FLUME-45 source edit and tracked event-log WIP belong to another unit and must not be included, reverted or stashed.

This run changes Flume only. No runtime/template submodule or other component edits unless the scoped story actually requires them and its owner is coordinated. Pilot PX-13 remains an owner dependency; FLUME-39 remains the gateway provisioning implementation. No managed board enrollment/cutover.

Claim a story only once implementation starts; use existing `px` verbs, no direct Plane writes. Leave Plane in QA/Needs Attention with exact evidence when appropriate. A local spec `done` is not authorization to close a ticket lacking its required external receipts or unpublished source. The supervising session owns final main publication/readback and task status correction.

## Runtime setup (machine-local, not tracked)

1. Initialize pinned template: `git submodule update --init templates/hermes-agent`.
2. `npm ci` (not `--ignore-scripts`: the pinned git Skillex dependency builds its dist in prepare).
3. `skillex sync --scope project --project <worktree> --dry-run --json`, inspect, apply directly, then prove a no-change preview. Never run a skill-operation mise task. The older installed 0.2.0 CLI lacks retire-mise; this setup used the current source CLI `node ~/code/skillex/dist/cli.js integrations retire-mise` to preview/apply only this repo's obsolete task. No global rollout or repinning.
4. Install the existing BMAD helper scripts under ignored `_bmad/scripts/` in the worktree; canonical skill payloads remain symlinked via Skillex.
5. `bmad-loop init --cli claude --no-skills` merges only this isolated worktree's hooks. Keep `.bmad-loop/` and `.claude/` generated state ignored; global ignore owns them. `_bmad/render/` is reproducible workflow output, not source.
6. Machine-local Claude profile wraps the existing reference-only `~/.agents/providers/automaticai/claude-code.env.op` through `op run`, unsets direct auth overrides and uses the existing gateway harness settings. No raw credential in profile, no direct-provider fallback. Main/subagent model routing inherits the user's configured gateway defaults.

## Gate configuration

- Review enabled, trigger always; max 3 review cycles, 2 dev attempts, 1 follow-up recommendation pass, 90-minute session timeout.
- Deterministic verification: `git diff --check`; `node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access`.
- New regression suites must be registered in scripts/run-tests.mjs and use names including `company-identity` or `employee-access`, so the configured loop gate executes them. Run each new suite explicitly too; a filter with no matching new suite is not proof of new behavior.
- Add story-specific integration tests necessary for each AC; the four old suites do not certify new identity/access behavior. Fixtures must not inherit production employee homes/credentials.
- Sweep disabled; no automatic cleanup/rollback of failed edits. Preserve blocked work and its evidence.
- File and desktop notifications enabled. Run state/journal/hooks/session IDs are durable under the ignored run directory; use bmad-loop status/diagnose rather than guessing from a wrapper exit code.

## Publication and supervision

The loop owns the per-story commit boundary and may squash its dev/review commits. Implementing sessions must not merge/remove the active execution worktree or change the loop's policy. A machine-local post-commit hook pushes the active branch; it never declares main delivery or closes a board ticket.

The launching session delegates a supervising worker that runs bmad-loop synchronously to the two-story checkpoint or a real stop, inspects its native state/evidence, then integrates verified work into Flume main with `wt` and pushes. It advances only the Flume pin in parent 33GOD and preserves all unrelated parent pins/WIP. Failed/unreviewed work stays on a published branch with an explicit blocker, never merged just to clean up. After landing, pause before the next stretch; do not auto-resume external-provider checkpoints. Remove the worktree only when no active/paused run needs it, or preserve it with an explicit continuation path.

## Setup baseline

Executed 2026-10-10: `node scripts/run-tests.mjs named-agent role-contract registry-comments` passed typecheck, build and 4/4 suites after normal `npm ci`. Initial ignore-scripts install failed due to missing dependency dist; no code defect was inferred. npm audit reports one moderate and one high existing dependency advisory; no unrelated upgrade performed. Full suite was not run and is not claimed green. Source planning branch began at Flume 53aa032cafc3dd34e67db361f6bcee6e251475e5.
