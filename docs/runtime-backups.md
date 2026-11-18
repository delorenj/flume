# Employee runtime backups (PJAN-14)

Flume owns coverage; Candybar owns **when**; forever-ago owns archive creation,
checksums and retention. There is no per-employee schedule, timer, daemon or Git
checkpoint. The manifest ships **disabled**. This document is not evidence of
registration, activation or a successful scheduled backup.

## Prerequisites and contract

- Linux, Python 3.11+ with PyYAML (`python3 -c 'import yaml, sqlite3'`),
  `~/.cargo/bin/forever-ago` (tested 0.3.0), and the Flume checkout on the executor.
- Registry resolution matches `kernel/fleet-paths.ts`: `--registry`, then
  `HERMES_AGENTS_REGISTRY`, `HERMES_FLEET_REGISTRY_FILE`, then
  `$HERMES_FLEET_HOME/agents-registry.yaml` (default `~/.hermes`). These paths are
  fleet-wide, **not** the launching agent's `HERMES_HOME`.
- Every registry row participates, including retired rows. Posts supply
  `profile_name` and absolute `role_dir`; portable specialists supply
  `profile_name`, `employment: portable-specialist` and absolute `desk_path`.
  Missing profiles/runtime/desks/sessions/memories, malformed or duplicate
  registry keys/profiles, and cross-employee shared source roots fail visibly.
- Source roots are canonical physical directories. Each post covers its **whole
  profile and role/runtime**; a portable employee covers its **whole profile and
  owning desk**, including learned skills. Profile links alone are not coverage:
  forever-ago never follows symlinks. Nested roots are staged once and linked.
- A new hire has the same contract as a migrated employee: use Flume's existing
  `hermes.untracked-runtimes` and `hermes.runtime-singleton` setup, then publish the
  registry row through Flume. Repeating setup/inventory adds no schedule or
  duplicate inclusion. Do not manually add employees to this runner.

Read-only inventory (exit 1 if any employee is missing):

```bash
cd /home/delorenj/code/33GOD/flume
python3 scripts/hermes-runtime-backup.py inventory
```

As observed during implementation, 48 rows were enumerated; the absent
`delonet-company-reporter` profile blocked fleet success by name. Repair or retire
that topology through its owner before live proof; do not filter it out here.
A read-only Git audit found zero tracked runtime entries in 38 inspected post
roots; `dumply` had no inspectable parent repository, and the reporter root did
not prove an ignore rule. These are observations, not completed live migrations.
Portable desks require their owner's separate scaffold/learned-state policy.

## Private storage and content policy

Default destination: `~/backups/flume-runtime`, mode **0700**, owned by the executor
user, outside all source trees and Git checkouts, with no symlink components.
Default names: `flume-runtime-YYYY-MM-DD.tar.gz` and
`flume-runtime-YYYY-MM-DD.tar.gz.sha256`. Retain the **newest seven snapshots**,
with the newly verified daily snapshot protected by forever-ago. The manifest
pins `TZ=America/New_York` as well as the schedule timezone.

The runner sets umask 077. Staging, verification, receipts, archives and checksums
stay local and private. **Never commit, upload, attach or publish these files**:
sessions, memory, config and databases can contain private text or credentials.
No encryption/offsite durability is claimed. Losing this disk loses these backups;
separately approved encrypted/offsite replication is not implemented here.

Every tree excludes these path components/patterns, case-insensitively:

```text
.git .env .env.* auth.json credentials* op_cache.json *.pem *.key
cache logs audio_cache image_cache lsp node_modules .venv __pycache__ *.pyc
*-wal *-shm *-journal *.lock checkpoints backups .curator_backups
```

- Sessions, memories, workspace, plans, hooks, pairing, cron definitions, SOUL,
  learned skills and ordinary configuration/owned state are included.
- `state.db` remains physically **in the profile**, with runtime/state.db linking
  back. Other SQLite files (header detected or `.db/.sqlite/.sqlite3`) are staged
  using Python's SQLite **backup API**, with a 30-second deadline and integrity
  check. WAL commits are included, uncommitted transactions are not; sidecars are
  not copied. Invalid database files fail the run. Independent databases are not
  one cross-database transaction.
- Ordinary regular files must be stable during their individual read; directory
  traversal uses pinned no-follow descriptors and fails if an owned directory is
  replaced. Owner read/write/execute bits are retained where present; group/world
  bits are removed. A change, disappearance or non-socket special file fails
  staging; sockets are recorded as ephemeral dependencies. There is no fleet-wide
  atomic snapshot guarantee.
- Links among included roots become **relative links inside the snapshot**.
  A post's real profile-homed `state.db` is required for active employees; a
  missing or dangling store fails by employee/path. Only the canonical profile
  `kanban.db` link into a not-yet-created runtime store may dangle, matching
  Flume's first-open lifecycle. Retired and portable rows still participate;
  missing required sources do not become optional. Required owned links outside
  coverage fail rather than claim coverage.
  Other external links are recorded in `manifest.json.dependencies`, not followed
  or restored automatically. Reconstruct shared skill/plugin/config dependencies
  using their original Flume/Skillex owners; never point a drill into live state.
- Recreate excluded credentials from the original vault/op references using
  Flume's normal provisioning/channel/access flows. Re-render generated shared
  config with Flume. This is **not a secret scrubber**: included config, sessions,
  workspace files or identity definitions may contain embedded secrets. Treat the
  entire archive as sensitive even when known credential filenames are excluded.
- `checkpoints` (Hermes code-checkpoint stores), logs/caches and old nested backups
  are excluded as regenerable/bulky history, not primary session/memory stores.
  Historical runtime Git recovery is PJAN-63/PJAN-64, not this backup.

## Run, inspect and diagnose

The nightly adapter does not modify active profiles or Git indexes. It discovers
all employees, stages state under the destination, invokes forever-ago with
`--once` and a no-prune retention count, **extracts and verifies all files, links
and SQLite**, then invokes the same engine with `--retain 7`. There is no bespoke
retention engine. A missing source or unwritable destination fails before pruning;
last-success is not replaced. A nonblocking destination lock prevents overlap.

Daily snapshots are immutable. A retry with identical payload reports
`reused_daily_snapshot: true` and retains its `snapshot_date`; it is not a newer
snapshot. Changed same-day state or coverage fails and preserves the prior daily
archive; wait for the next nightly date. Never delete a good snapshot to force
freshness. Future-dated or malformed backup names need operator diagnosis.

After explicit authorization for live side effects, the one-shot command is:

```bash
TZ=America/New_York python3 scripts/hermes-runtime-backup.py run
```

Operational checks (read JSON locally, do not post private manifests/content):

```bash
python3 -c 'import json,pathlib; p=pathlib.Path.home()/"backups/flume-runtime"; print(json.loads((p/"last-success.json").read_text())); print(json.loads((p/"last-run.json").read_text()))'
python3 scripts/hermes-runtime-backup.py verify "$HOME/backups/flume-runtime/flume-runtime-YYYY-MM-DD.tar.gz"
```

`last-success.json` records snapshot date, completion time, employee IDs, SHA-256,
archive and engine argv. `last-run.json` records the latest attempt, including
named failure; it may be unavailable when the destination itself is unwritable or
the registry is malformed. A nonzero exit plus Candybar terminal failure remains
visible then. Candybar receives a result file with success/fail and zero LLM spend;
engine output and runtime content are not echoed to scheduler logs. Source path
names may occur in errors; keep operational logs private too.

Diagnose missing registry sources with `inventory`; resolve them via the owning
Flume lifecycle, not ad-hoc deletion or rewiring. Check destination owner/mode,
free space, engine version/path, SQLite corruption/locks, and overlapping runs.
A hard-killed process may leave private `.stage-*`/`.verify-*` directories. Inspect
ownership and confirm no runner is active before manually removing only those
stale temporary directories; never remove archives/checksums to silence errors.

## Isolated restore drill

Only restore trusted, local archives. SHA-256 detects corruption, not malicious
replacement by someone who can rewrite both archive and checksum. The adapter
rejects traversal, absolute/escaping links, duplicate paths, hardlinks/devices,
manifest/payload mismatch and an existing restore target. It checks archive and
live source/Git overlap **before** creating even a parent of the requested drill;
unsafe destinations cannot be used as temporary extraction locations. It validates
the full symlink graph (including chains, `..` and cycles) before writing payload,
writes normal files first, verifies hashes/SQLite, then reconstructs internal
relative links with owner executable bits preserved. External dependencies remain
a recorded reconstruction checklist.

Use an owner-only parent **outside active sources/Git** and a nonexistent child:

```bash
install -d -m 700 "$HOME/restore-drills"
python3 scripts/hermes-runtime-backup.py restore \
  "$HOME/backups/flume-runtime/flume-runtime-YYYY-MM-DD.tar.gz" \
  "$HOME/restore-drills/pjan14-YYYY-MM-DD"
```

The archive has `snapshot/manifest.json` and `snapshot/employees/<id>/{profile,
runtime|desk}/`; restore strips the `snapshot/` wrapper. Verify locally that a
known session and memory file are readable and SQLite tables/rows are present.
`verify`/`restore` run SQLite `PRAGMA integrity_check` for every snapshotted database.
Read `manifest.json.dependencies` and reconstruct dependencies **inside the drill**
or through owners only after planning a deliberate recovery. Do not launch Hermes
or a gateway from the drill, enable restored cron definitions, replace a running
profile, or restore credential links into live homes. This does not activate a
recovered employee. Dispose of fixture/drill content privately after verification.

## Candybar cutover and remaining proof (parent-owned)

Definition: `.candybars/flume-runtime-backup.candybar.toml`, **03:17 nightly**,
`America/New_York`, exec `/usr/bin/python3 ./scripts/hermes-runtime-backup.py run`,
timeout 3600s, disabled. Interpreter and script run in the owning Flume repo.
Validate from the **landed canonical Flume checkout**; never register an isolated
feature worktree or its path/tag. No remote registration/enablement was performed
by the implementation worker. Candybar's current discovery labels a linked
**submodule worktree** by the worktree basename; validation here explicitly used
`Project(worktree, "flume")` to test canonical ownership. This is another reason
not to register from the isolated worktree; no Candybar source change is needed.

After independent spec and quality review and landing:

1. Resolve every inventory failure. Prove runtime untracking/ignore/checkpoint
   state read-only for each registered employee; coordinate any live repairs.
2. From Flume: `candybar register --dry-run`, then authorized
   `candybar register -n flume-runtime-backup` (disabled). Read API-backed
   `candybar show flume-runtime-backup -n 5`, `candybar next`, and `candybar ls --json`.
   Confirm `project:flume`, canonical checkout workdir, argv, schedule/timezone,
   timeout and paused state. Registration alone is not proof.
3. Inventory matching cron/timer/Hermes jobs and any forever-ago daemon. If a
   competing clock exists, use Candybar's migration ledger and explicit owner
   coordination. Do not disable unrelated infrastructure.
4. From `/home/delorenj/code/33GOD/candybar`, retain the exact output and exit of
   `uv run candybar doctor --repo . --live --json`. Implementation-time observation
   passed with zero violations/unknowns, not a post-activation certificate.
   Doctor covers local schedules, not other users/hosts or n8n without export.
5. Authorized `candybar resume flume-runtime-backup`; **wait for the first scheduled
   fire**. Do not substitute a manual side-effect run or dispatch receipt. Retain
   `candybar history flume-runtime-backup -n 5`, terminal result/invocation ID,
   snapshot date and complete employee coverage receipt, existing archive + SHA,
   verify and isolated-restore results. Keep runtime content private.
6. Rerun doctor/readback and prove no duplicate clock. Pause only this new job for
   rollback; preserve last good archives. Do not restart services or touch agents.

## Local gates

```bash
npm run typecheck && npm run build
npm run test:runtime-backups
# npm test also runs both backup suites, even if a pre-existing ordinary suite fails.
```

The focused gate requires real forever-ago (never skips it), exercises WAL restore,
symlink-chain rejection, directory/SQLite replacement, executable mode recovery,
pre-write restore containment, missing session authority, seven-snapshot retention,
failure preservation, corrupt/traversal archives, private modes, repeat setup for
fresh/tracked-file/gitlink cases, scaffold and unrelated submodule preservation.
Provisioning uses the real committed template and untracking CLI with a fixture-only
topology adapter, not a real fleet write. CI/ordinary `npm test` executes both
focused suites after the baseline runner and aggregates failures. A green focused
suite is not a green full suite: pre-existing baseline failures/timeouts still
require independent resolution. Fixture proofs are not evidence of a scheduled
live invocation. AC1–3/6/7 have fixture coverage only; AC4 API readback, sole-clock
and live doctor, and AC5 terminal scheduled archive/receipt remain unmet. The
`delonet-company-reporter` missing profile is tracked under FLUME-67 for an owner
repair-or-retire decision. Keep the Candybar definition disabled until the parent
completes live inventory repairs, independent re-review and authorization.
