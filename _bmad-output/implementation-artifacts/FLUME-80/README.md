# FLUME-80 implementation evidence

## Delivery and boundaries

- Branch: `fix/FLUME-80-fresh-vault-verification`.
- Worktree: `/home/delorenj/code/33GOD/flume/.worktrees/fix-FLUME-80-fresh-vault-verification`.
- Base: `f85a126835ce3f4a4b5f30198b949d865a9b54b6` (origin/main at isolation).
- Production ownership: `packages/flume-hr/src/workforce/provision.ts` only. Tests: `tests/identity-provision-regressions.mjs`. Contract: `docs/identity-provisioning.md`. All other additions are in this evidence directory.
- No main code edits, branch switch/reset/rebase/stash, board changes, merge, deployment, live provider/vault reads or mutations, employee provisioning, credential rotation, policy expansion or lifecycle implementation.
- Fixture evidence is not proof of installed behavior, Cloudflare policy admission (FLUME-57), or live incident recovery. Live recovery remains **pending explicit owner approval**. Parent owns independent review and merge judgment.

## Acceptance mapping

| AC | Implemented and exercised evidence | Limit |
| --- | --- | --- |
| 1 | `baseline-reproduction.txt`: compile the exact baseline provision.ts into a separate CLI bundle, retaining other current code. The fake op persists an edit but returns pre-edit data to ordinary reads. Baseline apply exits 1, leaves Client ID persisted, deletes its token; retry mints/deletes again. Independent probe confirms a fresh read sees the field. | The cache mechanism is confirmed in an isolated double, not against the live 1Password cache. Historical incident remains author-reported. |
| 2 | `provision.txt`: identity item list/get uses invocation-scoped `--cache=false` with inherited `OP_CACHE=on`. Writes/reads by immutable item ID; one edit writes the section-qualified pair, fresh verification compares both values and unique field IDs. Iris fixture preserves GitHub Client ID/secret and all other items; binding references Access secret field ID. Duplicate field/ID responses block. | Installed op help confirms flag support; no live write was attempted. |
| 3 | Stale-read fixture completes without deletion; repeat apply makes zero provider/vault writes and no duplicate item/rule/KV/token. Nonzero-but-persisted edit completes. Normal failed edit plus fresh absence cleans up only after DELETE + GET/404. Failed or falsely successful DELETE is `cleanup-unconfirmed`. Missing/wrong/partial/duplicate/signal verification and binding refusal retain token, report blocked and prevent repeat mint/delete. | Timeout/signal cannot prove rejection, so token is retained. No automatic recovery from ambiguous persistence. |
| 4 | Finch fixture seeds stranded Access field, absent provider token and old deletion receipt. Preview reports field presence/IDs, provider absence and receipt deletion; preview/apply/repeat never mint/delete/overwrite. Explicit fixture-only reconciliation clears the known stale field; retry creates/binds once, final apply is no-op. `docs/identity-provisioning.md` describes separate approval to bind an existing matching pair or remove precisely proven stale fields. | No current live metadata/provider/receipt comparison or live repair was authorized/executed. Do not clear the reported employee's fields based on fixture evidence. |
| 5 | Preview asserts provider GETs only, no vault create/edit, binding or receipt. All captured human/JSON stdout/stderr, every definition and receipts are scanned for planted API/session/Access/GitHub secrets. Fake edit/read/delete errors deliberately contain secrets. Separate completed vault/mailbox results survive blocked Access. | Secret-bearing fake vault files are necessary fixture state, never evidence output. Secret arguments still pass to op as the existing custody contract documents. |
| 6 | `provision.txt`: 22 check groups. Typecheck/build exit 0. Existing registry lifecycle, registry/Plane and Plane suites exit 0. Existing identity/lifecycle suites were attempted; three gateway fixture failures reproduce with baseline provisioner. Docs updated, raw results retained. | Full suite not run; three relevant suites are **not green**. Independent review pending. |

## Reproduce

From this worktree, with Node >=24 and npm:

1. `npm ci` (do not use `--ignore-scripts`: the git Skillex dependency needs prepare/build).
2. `git submodule update --init --recursive` (initializes the pinned Hermes template; does not change its gitlink).
3. `node _bmad-output/implementation-artifacts/FLUME-80/run-checks.mjs`.

The runner records the exact command, exit, environment overrides, duration and output filename in `checks.json`, and exits 1 if any non-baseline check fails. It blanks ticket-provider credentials and disables host overlays. `scratch-temp.mjs` redirects unchanged legacy `/tmp` mkdtemp prefixes into the inherited profile TMPDIR; it changes no production semantics. Its optional `FLUME80_BASELINE_CLI` redirects spawned CLI paths solely for baseline comparison. Do not use the main test runner for this bounded run: it hardcodes TMPDIR=/tmp.

`build-baseline.mjs` loads provision.ts with `git show f85a126835ce3f4a4b5f30198b949d865a9b54b6:...` through an esbuild loader; no tracked source is replaced. `FLUME_PROVISION_EXPECT_OLD_FAILURE=1` is an assertion mode for that old CLI, not a passing-current-suite override. The normal suite asserts success and safety against current dist.

## Actual check results

See `checks.json` and sibling `.txt` outputs for fresh machine-produced results. The provision log ends `identity-provision-regressions: 22 passed`.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | both workspaces compile |
| `npm run build` | 0 | CLI and MCP bundles built |
| baseline builder + baseline reproduction mode | 0 | asserted the historical unsafe sequence (CLI apply/retry themselves exit 1) |
| `node tests/identity-provision-regressions.mjs` | 0 | 22 groups |
| `node tests/registry-lifecycle-projection-regressions.mjs` | 0 | all assertions passed |
| `node tests/company-identity-registry-plane-regressions.mjs` | 0 | all assertions passed |
| `node tests/company-identity-plane-regressions.mjs` | 0 | 20 groups |
| `node tests/company-identity-lifecycle-regressions.mjs` | 1 | gateway inventory `unresolved`, expected `static-usable`, line 242; first preview group passed |
| `node tests/employee-access-lifecycle-regressions.mjs` | 1 | specialist fixture onboarding: `gateway-mint-or-confirm-failed`, line 210 |
| `node tests/company-identity-regressions.mjs` | 1 | same gateway fixture onboarding failure, line 162, after five groups |
| those three failing suites with baseline provisioner | 1 each | same failure sites/messages, demonstrating failures independent of this provisioner change |
| `git diff --check` | 0 | no whitespace errors |

No quarantine, skipped assertion or unrelated repair was introduced. Baseline controls replace only provision.ts, because it is the only modified production module.

## Setup findings

Initial `npm ci --ignore-scripts` installed Skillex without dist and could not run the CLI. Running its build script directly failed because published package excludes scripts. Normal `npm ci` ran the dependency preparation and fixed setup. An initially uninitialized template submodule also blocked CLI startup; initialized its existing pinned revision `19ded0acc35c8e14ddcb94dd4ebde2b4421b5384`. No package/lock/gitlink changes. npm reports 9 dependency audit findings (6 moderate, 3 high), not addressed in this ticket.

BMAD renderer was invoked once at the supplied root and read successfully; g33 preflight PASS with legacy-enrollment and missing-resolver WARNs. Review tooling cannot launch another subagent here, and the parent explicitly owns independent review; `review-request.md` contains the complete separate-session prompt. This is implementation delivery, not review PASS.

## Remaining approval/verification gates

- Independent source/spec/security review of the pushed branch.
- Investigate/repair baseline gateway fixtures with their owner; do not infer complete lifecycle coverage from early failure.
- Owner-approved read-only live comparison, then separately approved bounded reconciliation/retry for the reported employee. No live credential mutation is authorized by this patch.
- Main merge, installed/deployed verification and all board transitions remain with the parent/operator.
