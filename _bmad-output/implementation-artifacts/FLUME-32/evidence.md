# FLUME-32 worker evidence

Status: IN_PROGRESS
Worker: flume-32-implementation
Worktree: /home/delorenj/code/33GOD/.worktrees/flume-32
Branch: feat/flume-32-role-declaration
Base: c3561fb (rebased clean from 8577aded; 80948c3 preserved)

- AC-1: PENDING
- AC-2: PENDING
- AC-3: PENDING
- AC-4: PENDING
- AC-5: PASS (shared-contract.log; 3/3 suites, typecheck/build pass)
- AC-6: PENDING (requires new live ledger evidence)

## Worker #2 resume
Start Plane comment: dcb452cd-432f-47e5-884b-caf41ca62146.
First commit preserved worker #1 RED verbatim (rebased SHA 1d8b241).
Observed RED: `node tests/role-contract-regressions.mjs` exit 1: missing validateRoleDeclaration (red.log).
GREEN: `node scripts/run-tests.mjs role-contract named-agent` exit 0, 3/3 suites (shared-contract.log).
Established readRoleIdentity moved unchanged to workforce/identity.ts; parity re-exports it. Both consumers invoke that same path. Shared schema bundled from JSON, eliminating the old parallel FALLBACK_SCHEMA. Named-agent fixtures with mismatched banks corrected to agent-<id> so skill/desk tests still exercise their intended gate. Pack(s)/set use one resolver.

Rebased baseline: `/tmp/flume32-baseline-postrebase.log`: typecheck/build PASS, 11/16 suites PASS; fleet-status/health/systemd already fail in worker #1's old baseline; profile environment/mise trust and pjan-86 5s Python timeout also failed. Full output preserved, no failures hidden or quarantined. Retry `/tmp/flume32-baseline3.log`.
No fleet services/default config/main checkout mutations.

## Strict Skillex selection (2026-10-02, owner: "transition to all strict skillex skills")

Worker #2 / the Codex resume worker both stopped without finishing (the Codex session ended 2026-10-01 15:17 EDT with
a clean worktree). Picked up from origin/main b21ae9e in a throwaway worktree.

Problem found by the strict-desk acceptance: the loadout reached a desk through `<desk>/.agents/skills` and a
`skills.external_dirs` list patch; `skillex profile show` on a Skillex-only desk exits 3 (E_PROFILE_SKILLEX_ONLY).

Fix: `workforce/selection.ts`. A role's `skills {set|pack}` becomes `<desk>/.skillex-selection/.agents/skills.json`
(`inherit_global: false`, `sets`/`packs`), written with Skillex's manifest writer and projected with
`skillex profile sync --skillex-only`. Nothing in flume writes `skills.external_dirs` (it pins `[]`) or a second skill core.
A pack is exclusive in Skillex, so `packs: [a, b]` and pack + set are refused by name.

- `node scripts/run-tests.mjs role-selection` : 15 groups PASS (real skillex CLI, scratch fleet and catalog).
- `scripts/flume32-selection-proof.mjs` -> `selection-proof.json`: real strict flume-pm desk rebuilt in a scratch Hermes
  root, `flume onboard pm` twice (exit 0/0, second run no change), `skillex profile show` exit 0 (explicit and recorded
  project), 62 skills = 56 global + 6 `product-manager`, `external_dirs: []`, no `.agents`, audit rules pass after
  `flume remediate hermes.runtime-singleton`; the previous build on the same recipe: exit 3. Skillex's own desk
  auto-resync (`scripts/hermes-skillex-resync.py`) follows the recorded project: converged desk `ok`, selection moved
  `would-sync` then `synced` against `<desk>/.skillex-selection`, then flume restores the declaration. Live fleet
  fingerprints identical before and after.
- Live `flume audit` (read-only), untouched HEAD vs this build: the 13 hermes.*/systemd.* rules are identical.
- AC status after this change: AC-1 (skills half) and AC-2/AC-3 (skills cases) hold under the strict model;
  AC-4 docs added (roles/README.md); AC-5 unchanged and green. STILL OPEN: AC-6 (fresh member-attributed ledger
  evidence; only the earlier PASS_SEAM_ONLY probe exists), `flume onboard --repo` (the WIP test's flag; the only red
  line left in role-projection-regressions), the real `flume hire` path for a loadout role, and the independent
  spec/quality review gates.
