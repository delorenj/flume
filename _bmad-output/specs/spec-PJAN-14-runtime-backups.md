---
title: 'PJAN-14: nightly employee runtime recovery without Git'
type: 'feature'
created: '2026-11-18'
status: 'in-review'
review_loop_iteration: 0
context: ['AGENTS.md', 'contracts/handbook.yaml']
baseline_commit: '9b639baf18d6d411f464d02f3fadfee0692fd0f5'
---

<frozen-after-approval reason="approved PJAN-14 intent; autonomous implementation authorized">

## Intent

**Problem:** Ignored employee state has no proven nightly recovery path. Profile links do not cover physical runtime bytes, and copying live SQLite files is unsafe.

**Approach:** Flume owns a registry-driven staging adapter for forever-ago and one disabled nightly Candybar manifest. Discover coverage on every invocation, snapshot physical state consistently, verify recovery before retention, and keep runtime data private and outside Git.

## Boundaries & Constraints

**Always:** Cover every registry row, including portable specialists and retired rows. Preserve scaffold and unrelated submodules. Use forever-ago `--once`, Candybar alone for WHEN, SQLite backup API for databases. Keep archive/staging/result files owner-only outside source trees. Follow `../momo/PILLARS.md` (Adapter pattern; reuse existing engine). Work only in this isolated Flume worktree; scratch is `/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch`, never `/tmp`. Parent owns independent spec/quality review, landing and live proof.

**Ask First:** Live runtime migration, missing employee repair, service changes, registration/enablement or new credential treatment.

**Never:** Plane writes; main merge; edit shared checkouts; stash/reset/rebase; daemon/timer/cron; upload runtime; replace the backup engine; change roles; repair old Git history. Do not read credentials into output. Commit only owned paths with PJAN-14; push the feature branch before handback.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Complete inventory | Post runtime + profile; portable profile + desk | One deterministic entry per registered employee, physical sources and backup policy | No filtering by status |
| Missing or malformed source | Missing profile/runtime/desk, duplicate profile, invalid registry | Named failure, nonzero fleet result | No archive/pruning or last-success replacement |
| Database/link | WAL SQLite; profile links to runtime; reverse state.db link | SQLite backup snapshot; internal links map to staged counterparts | Unknown required state links fail; external dependencies recorded for reconstruction |
| Backup | Complete private stage, writable external destination | Verified archive + matching SHA-256 and last-success receipt | Failure never prunes previous good archives |
| Retention/retry | Old disposable archives; same-day archive exists | Engine retains newest seven only after recovery verification; same-day mismatch refused | Preserve existing good daily snapshot; no fake freshness |
| Restore | Archive and absent isolated destination | Verify hashes/SQLite; recover sessions/memory; internal links point within drill | Reject traversal, devices, unsafe links, existing destination |

</frozen-after-approval>

## Safety hold — unsafe, not landable

The implementation at `84996fb526d2c6cc620b3292cf318ae6cb7597ae` still fails
QUALITY. Final remediation did not establish a bounded supported way to bind the
stdlib SQLite connection's actual held inode to the pinned source while preserving
live WAL/journal consistency. The authorized fallback is documentation only:
no executable, tests, package wiring or Candybar manifest changed. Do not merge,
register, enable or use this revision on live state.

Real subprocess/strace-delay replays on `/usr/bin/python3` 3.13.7 (SQLite 3.46.1)
and developer Python 3.14.9 (SQLite 3.53.1), with real forever-ago 0.3.0, confirmed:

- SQLite ABA: backup and restore exit 0; restored database contains the synthetic
  outside marker after the original pathname was restored before connect returned.
- Restore parent swap: four payload creations reach a synthetic active runtime
  before restore fails; absence of final publication is not safe rejection.
- Required state.db removal after inventory: backup and restore exit 0 with the
  session authority absent, and last-success is written.

See `docs/runtime-backups.md` **Safety hold** for the supported-API/hardlink
limitations and reopening gates. Evidence remains private under the active
profile scratch root: `pjan14-quality-rereview-final-blocker-{system,developer}-probes.json`
and their matching traces. The harness exits 0 on completed observation, not on
safe behavior. The original independent report remains FAIL. Parent-owned final
independent review has not been performed for this documentation-only handoff.

## Code Map

- `packages/flume-hr/src/kernel/fleet-paths.ts:14` — fleet root and registry precedence; mirror HERMES_AGENTS_REGISTRY, HERMES_FLEET_REGISTRY_FILE, HERMES_FLEET_HOME.
- `packages/flume-hr/src/parity/singleton-links.ts:24` — owned directories/files; state.db is profile-homed, runtime links back. Keep this direction on restore.
- `packages/flume-hr/src/workforce/specialist.ts:103` — portable-specialist row uses desk_path and profile_name; no role_dir/runtime assumption.
- `packages/flume-hr/src/hire/UntrackHermesRuntimes.ts:20` and `HireRecipe.ts:149` — existing fresh-hire index/ignore transition; reuse in fixtures, do not duplicate provisioning machinery.
- `templates/hermes-agent/template/.scripts/20-runtime-repo.sh:26` — pinned cbc0d6a9957cdaedf4667dc104872d442afdc406 rejects gitlinks, preserves existing nested repo, creates no runtime Git checkpoints. Read-only submodule.
- `tests/pjan-86-hermes-deploy-regressions.mjs`, `tests/runtime-singleton-targets-regressions.mjs` — local hire/repair fixture patterns.
- `/home/delorenj/code/forever-ago/README.md`, `src/main.rs:392` — archives links without following, immutable verified same-day archive, checksum before pruning. Never use daemon advice.
- `/home/delorenj/code/33GOD/candybar/README.md:99` and `deploy/migration/README.md` — project manifest resolution, paused creation, readback/doctor rules. No Candybar repo edits.
- Shared main has unrelated dirty index/role/rules/launch/test-runner work. Avoid those paths. Only implementation repo touched is Flume; pjangler board/checkout unchanged.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/hermes-runtime-backup.py` — inventory/run/verify/restore CLI is present, but safety acceptance remains blocked. Default destination `~/backups/flume-runtime`; prefix `flume-runtime`; retain seven. Preserve existing pinned no-follow traversal, complete restore link graph, owner execute metadata, static overlap rejection and active state.db preflight. SQLite held-inode identity, descriptor-safe restore-parent handling and required-store coverage across inventory/staging/verification remain unresolved; pathname checks and early lstat are not sufficient.
- [x] `.candybars/flume-runtime-backup.candybar.toml` — disabled exec runner at 03:17 America/New_York, bounded invocation, no second clock.
- [ ] `tests/runtime-backup-regressions.py` and `tests/runtime-backup-provisioning.mjs` — existing disposable-root suites pass with real installed forever-ago, open WAL writer, isolated restore, retention/failure cases and repeated fresh/existing untracking. `package.json` still runs both in ordinary `npm test` regardless of baseline failure. Coverage remains incomplete: deterministic subprocess ABA, restore-parent replacement and required-store disappearance regressions must be committed with a safe fix before this task can be accepted.
- [x] `docs/runtime-backups.md` — sources/exclusions/private storage, credential/shared dependency reconstruction, commands for last-success/failure/restore, enrollment idempotency, live cutover and evidence checklist. Do not claim installation or scheduled proof.

**Acceptance Criteria:**
- Given every registry row, when inventory runs, then each appears exactly once with canonical physical sources and engine policy, or a named failure prevents fleet success (AC1).
- Given fresh and existing fixtures, when setup repeats, then runtime is ignored/untracked, stale runtime declarations gone, scaffold/unrelated submodule intact and no checkpoint writes occur (AC2/7).
- Given WAL databases and links, when run/restore executes, then sessions/memory and SQLite integrity/readable rows survive without raw live database copy; shared dependencies have reconstruction rules (AC3/6).
- Given verified staged state, when forever-ago runs, then archive/SHA match; verification precedes retention; failed source/destination leaves last-good intact (AC5/6).
- Given manifest/docs, when validated locally, then nightly zone/exec/paused state is correct; parent subsequently proves API parity, sole clock and scheduled terminal effect (AC4/5, live gates outstanding).

## Spec Change Log

- First correction added traversal/link-graph/execute-mode/static-overlap/missing-state checks and ordinary npm test wiring. Subsequent real syscall-delay review disproved its SQLite identity, restore-parent and required-store completeness claims. The safety hold above supersedes completion claims; successful fixtures are not safety or live acceptance.
- Final safety remediation took the authorized docs-only blocker path: no supported held-inode/WAL guarantee was established, so no partial executable fix was published. Preserve the existing fixes and frozen intent, leave code/test acceptance unchecked, and require safe deterministic race regressions plus independent re-review before landing.
- FLUME-67 still requires an owner repair-or-retire decision for the missing `delonet-company-reporter` profile; it does not resolve the separate code hold. AC4 API/sole-clock and AC5 scheduled terminal proof remain outstanding. The Candybar manifest remains disabled; no registration, fleet writes or merge are authorized.

## Design Notes

Stage all employees into one fleet snapshot so a missing source cannot prune another employee's last good backup. First invoke forever-ago with retention large enough to preserve every existing archive; validate archive payload hashes and SQLite, then invoke again with seven to let the same engine prune. Do not hand-roll retention. Same-day snapshots are immutable: refuse changed inventory/payload rather than report stale coverage as a fresh success. Restore remaps only links between included roots; external shared links are recorded, never blindly restored to active homes. Ordinary files are individually stable reads, not a fleet-wide transactional snapshot.

## Verification

- `python3 tests/runtime-backup-regressions.py` — real forever-ago success, SQLite restore, retention and negative cases; no skips.
- `npm run typecheck && npm run build` and `node tests/runtime-backup-provisioning.mjs` — existing lifecycle contract and fresh/existing idempotency.
- Candybar project loader validates manifest without registration. Parent retains exact `uv run candybar doctor --repo . --live --json` output from Candybar checkout, readback and first scheduled archives/checksums.
