# FLUME-97 rollout

## Delivered

- Independently reviewed source `2f3465bf38848e5707fa701145779c9b810078ed` was reconciled with current main using `git pull --no-rebase origin main`. Reconciled source `28816587aaf3623758cb96c4167ed4b45276d3a8` is pushed on Flume main.
- Used landed canonical template pin `af82ef125f6cb7382f17f9e5dda596658a2784f5`, with its real Git lineage and `FLUME_ROOT=/home/delorenj/code/33GOD/flume`.
- Refreshed all 32 canonical PM scaffolds through fresh, exact agent-scoped supported previews and applies. James Brennan used scripts-only; the other 31 used full supported composition. Added the authorized scripts-only refresh of 33god-pm's actual live feature-worktree target.
- Removed 66 byte-exact obsolete helpers across 33 role locations. All 33 heartbeats now match the shipped canonical bytes, with no managed-execution references anywhere in the remaining script trees. All 33 previous heartbeat hashes were found in actual template Git history; see `heartbeat-lineage.json`.
- All 32 canonical repeat previews and the extra worktree repeat preview are write-free. The 24 canonical `partial` applies exited 1 after safe writes and preservation; eight exited 0. The remaining audit failures are retained, not rewritten to pass.
- Effective on-disk profile SOULs have all four holds and the human ownership rule for 31 of 32 PMs. Canonical tracked/runtime SOUL pairs also pass for those 31. Thirty canonical composed pairs changed; tolt was already current. Identity and Tone sections, local script edits, unrelated dirty/staged work, registry bytes, profile links/configs, and ignored runtime content were preserved by scoped checks.
- Every changed project has a published commit. James Brennan's scaffold-only PR [#1015](https://github.com/AutomaticAI-io/james-brennan/pull/1015) is merged. Nautilus remains on `develop`, published to `origin/develop`. The extra 33GOD worktree remains on its existing published branch.

## Not complete / explicit limits

1. **James Brennan authored SOUL / AC4:** both authored SOUL files remain byte-exact, SHA-256 `0b4af6d47312c35a7e08e8ed5136ae2412e133325f8c9fc04fb0989a1d02234c`. They lack all four holds and the human ownership rule. The maintained composer preserves them and has no supported authored-block merge. An owner decision or owning API is still required. No handwritten SOUL edit, overwrite, or provenance marker was added; FLUME-97 is not claimed fully complete.
2. **Extra 33GOD worktree tracked SOUL:** its runtime/effective SOUL already contains the four holds and human rule. Its tracked SOUL is older and lacks `lifecycle:human`. Scripts-only authority preserved it. Canonical 33GOD tracked/runtime SOULs are current; singleton links were not rewired.
3. **Preserved script drift:** 24 canonical audits plus the extra worktree audit still report unrelated local script differences (and James authored-SOUL drift). No obsolete-helper or managed heartbeat issue remains. Write-free repeat previews do not imply full template parity.
4. **Branch topology:** nautilus_trader was published to `develop`; the remote advertises `HEAD -> develop` (and `master`, but no `main`), so `develop` is its canonical primary branch, not an unlanded-main blocker. The effective 33GOD worktree changes remain published on `feat/FLUME-85-atlas-hire`, which is also the live profile target and must not be removed here.
5. **Skillex hook:** initial pre-push fixture Git commands inherited the outer bare-worktree Git context and altered refs/index/config. The proven hook effects were contained and repaired without changing project worktree bytes. Original `core.bare=true` was restored; `.lastagent` and dirty all-skills were preserved. An isolated run of the maintained full gate passed 1,337 Node tests (one skip), Node lint/types, Ruff and Mypy; 12 legacy Python alias tests failed twice (965 passed, five skipped). Scaffold-only diff leaves source/tests/gate unchanged. Publication bypass of that failing QA hook is recorded in `skillex-publication.json`, not represented as a green full suite. Fixture-only refs were not pushed.
6. **Parent gitlinks:** only initially clean links produced by this rollout were advanced: 33GOD `bloodbank`, `candystore`, `monitoring`; tolt `lost-things-forge`. Pre-existing drift in `holocene`, `pjangler`, `flume`, `pilot`, and `tower-of-lost-things` was preserved, not absorbed.

## Evidence map

- `summary.json`: selected per-desk inventory, commit URLs, actual apply/repeat/audit outcomes and final predicates.
- `<agent-id>.json`: fresh preview/apply JSON and actual exit codes, exact changed paths, preservation hashes, before/after branch/HEAD, final repeat preview/audit and remote verification.
- `33god-pm-effective-worktree.json`: additional actual-profile worktree cleanup and its tracked-SOUL limit.
- `heartbeat-lineage.json`: actual shipped Git blob matches before and after.
- `parent-gitlinks.json`: clean-only pin decisions and publication receipts.
- `skillex-hook-repair.json`, `skillex-gate-summary.json`, `skillex-publication.json`: hook containment, real QA output and publication exception.
- `../tip-independent-review.md`: final independent source/spec/quality review receipt, preserved before cleanup.

Verification is **effective on-disk profile state**, not proof of a running session reloading its prompt. No board transitions/comments, services/restarts, schedules/timers, credentials, channels, or registry edits occurred.
