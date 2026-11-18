# FLUME-45 independent QUALITY review

- Verdict: **PASS** (narrow code/test quality gate; not merge, deployment, or full-suite approval).
- Candidate: `f3990c497b264e44c4e4b0a05b3a97b79476debf`.
- Base: `da95702de37d1c3d42d2d8501784bb27c3655521`.
- Reviewed four-file exact commit diff, registration caller/preconditions, recipe short-circuit, template identity rendering, runner registration, and fixture isolation.
- No actionable introduced correctness, regression, or security defect found. The removed targetRepo null guard remains covered by RunCopierTemplate.invoke's precondition (lines 134–139); render identity validation precedes manifest parsing/mutation (lines 48–81). Dry-run returns before Copier/registration (lines 282–289). Registration errors remain fatal (lines 339–354).

## Fresh verification

All commands ran against separate `git archive` snapshots; no shared dist or checkout was changed. Pinned template gitlink `c738f69db40a19b9f6c316b03b1c17edef9d0948` was verified clean in the candidate worktree. Existing dependencies were copied into each snapshot; workspace symlinks remained snapshot-relative. Bubblewrap used a private tmpfs root, read-only system/tool mounts, no external network, no host service sockets, cleared environment, and scratch-backed `/tmp`. Production home, credentials, board, and provider services were not available. Full argv/environment policy/stdout/stderr/exit are in `logs/*.json`.

| Check | Base | Candidate |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run build` | exit 0 | exit 0 |
| `node tests/runtime-singleton-targets-regressions.mjs` unchanged | exit 1, line 143, `1 !== 0` | exit 1, line 143, `1 !== 0` |
| Diagnostic copy printing remediation result, unchanged assertions | exit 1, `E_PROFILE_SKILLEX_ONLY` missing `.no-bundled-skills` | same |
| Fixture-only copy adding `.no-bundled-skills`, all original assertions preserved | exit 0, `runtime singleton target regressions passed` | exit 0, same |

Candidate-focused checks:

- `git diff --check da95702 f3990c4`: exit 0.
- `node scripts/run-tests.mjs --list flume-45`: exit 0; exactly `flume-45-hire-manifest`, `1 step(s)`.
- Actual exported `RunCopierTemplate` ingredient, bundled unmodified from candidate source, with only Copier's subprocess interface simulated in private fixtures: **9/9 groups passed**, exit 0. Covered matching derived ID, matching explicit ID, missing/empty/non-string/mismatched ID (fatal, manifest byte-identical), malformed YAML, no project manifest compatibility, and dry-run (manifest byte-identical; no agents directory).
- Did not duplicate the independent SPEC reviewer's public-hire suite or rerun the full suite. These nine ingredient probes are not claimed as public-hire evidence.

## Full-suite failure attribution

`tests/runtime-singleton-targets-regressions.mjs:75` creates `.skillex-only` but no `.no-bundled-skills`. At line 143 it expects remediation exit 0. Unchanged `packages/flume-hr/src/parity/rules.ts:3705–3710` calls Skillex `syncProfile`, propagating its refusal as blocked/exit 1. The pinned Skillex implementation (`node_modules/@delorenj/skillex/dist/index.js:12812–12820`) explicitly rejects this incomplete strict-profile fixture. Diagnostic output on both revisions:

    blocked: E_PROFILE_SKILLEX_ONLY: Strict profile is missing its bundled opt-out marker. (.../profiles/demo-pm/.no-bundled-skills)
    blocked: profile skill projection returned exit 3

Narrow follow-up correction: seed `.no-bundled-skills` beside `.skillex-only` in the legacy fixture, retaining all runtime-link assertions. This was done only in diagnostic copies, not the application/test checkout. The complete diagnostic-copy pass on both revisions confirms the attribution; it does not turn the unchanged suite or the interrupted full run into a pass.

Byte identity across base and candidate:

- Runtime suite SHA-256: `84134d36ba0fd3dee593dd6d361bd64e3f679f13200e880960bb9e66e7116db1`.
- Parity rules SHA-256: `90df46aa78f577183a31bf245f9ce2dd8dfd7a154c4ee6cc54b587c5fecd8a16`.
- Lockfile SHA-256: `52e359473b3e26a8ed9f7ca983495f59520e9df536c000782e30ef0015ac2027`.

## Limits and nonblocking improvement

The committed five-group public fixture exercises acceptance behavior but not the new identity guard's rejection branches (`tests/flume-45-hire-manifest.mjs:81–131`). The separate nine-group review probe covers those now; preserving mismatch/non-string/absent-ID cases in the committed regression suite would keep that defense from becoming untested later. This is advisory, not a demonstrated product defect.

No historic root cause is invented: the implementer's pre-change public-path pass remains compatible with the earlier guard fix already present on base. No production parity/provisioning, installation, deployment, or rollback was tested or authorized.

## Review artifacts and preservation

Only active-profile scratch artifacts were created. Exported source/dependency/build copies were removed after verification; no new Git worktree or unpushed application change remains. Main's existing unrelated bloodbank-events/spec WIP was preserved, and the candidate worktree remained clean.

An initial whole-host read-only Bubblewrap root remapped host uid 0 ancestors to uid 65534, causing a review-harness-only receipt ownership refusal. The corrected private tmpfs root removed that artifact without weakening product checks. An initial esbuild invocation mistakenly passed its native executable to Node; the corrected direct executable invocation produced the passing nine-group probe. Neither harness error is counted as a product failure or passing check.
