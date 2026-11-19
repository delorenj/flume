# FLUME-80 implementation evidence

## Delivery and boundaries

- Branch: `fix/FLUME-80-fresh-vault-verification`.
- Worktree: `/home/delorenj/code/33GOD/flume/.worktrees/fix-FLUME-80-fresh-vault-verification`.
- Base: `f85a126835ce3f4a4b5f30198b949d865a9b54b6` (origin/main at isolation).
- Production ownership: `packages/flume-hr/src/workforce/provision.ts`, `access-issuance.ts`, the narrow pending-issuance/binding revocation guards in `lifecycle-adapters.ts`, and the Access ownership/binding guard in `company.ts`. Tests: `tests/identity-provision-regressions.mjs`. Contract: `docs/identity-provisioning.md`. All other additions are in this evidence directory.
- Integrated `origin/main` at `d7f99d1ced63f1e562bb9968cfde28a89256eec2` via merge `3088bf4b5699128fd165c7b0483934100081261f`, then `32f4894ac01ffd523852fc4fd8f4f90036f64df4` and `0cfbf5dd1d19369fb0cc5e59b8104cffe280384f` (FLUME-85) via `git pull --no-rebase origin main`. Final pre-check pull merged `3a035d3a33fe67df49016d5f0e44f7ae044f6266` (FLUME-87 evidence) as `f75ef67aa0728a2dd083f78affed977d77750161`. No conflict was resolved; the final checks ran on that merged tree.
- No main checkout edits, branch switch/reset/rebase/stash, board changes, merge **to main**, deployment, live provider/vault reads or mutations, employee provisioning, credential rotation, or policy expansion.
- Fixture evidence is not proof of installed behavior, Cloudflare policy admission (FLUME-57), or live incident recovery. Live recovery remains **pending explicit owner approval**. Parent owns independent review and merge judgment.

## Acceptance mapping

| AC | Implemented and exercised evidence | Limit |
| --- | --- | --- |
| 1 | `baseline-reproduction.txt`: compile the exact baseline provision.ts into a separate CLI bundle, retaining other current code. The fake op persists an edit but returns pre-edit data to ordinary reads. Baseline apply exits 1, leaves Client ID persisted, deletes its token; retry mints/deletes again. Independent probe confirms a fresh read sees the field. | The cache mechanism is confirmed in an isolated double, not against the live 1Password cache. Historical incident remains author-reported. |
| 2 | `provision.txt`: identity item list/get uses invocation-scoped `--cache=false` with inherited `OP_CACHE=on`. Writes/reads by immutable item ID; one edit writes the section-qualified pair, fresh verification compares both values and unique field IDs. Iris fixture preserves GitHub Client ID/secret and all other items; binding references Access secret field ID. Duplicate field/ID responses block. | Installed op help confirms flag support; no live write was attempted. |
| 3 | Stale-read fixture completes without deletion; repeat apply makes zero provider/vault writes and no duplicate item/rule/KV/token. Nonzero-but-persisted edit completes. Normal failed edit plus fresh absence cleans up only after DELETE + GET/404. Failed or falsely successful DELETE is `cleanup-unconfirmed`. Missing/wrong/partial/duplicate/signal verification and binding refusal retain token, report blocked and prevent repeat mint/delete. **Remediation:** `minted` records subject/account/token/client IDs. Real CLI provision-failure → credentials → retire confirms an unbound live token is `pending-access-issuance`, not `not-issued`; failed DELETE remains incomplete, verified retry deletes once, repeated retire performs no DELETE. Owner/name/client-ID mismatch and unscoped receipt branches fail closed. | Timeout/signal cannot prove rejection, so token is retained. No automatic vault repair from ambiguous persistence. |
| 4 | Finch fixture seeds stranded Access field, absent provider token and old deletion receipt. Preview reports field presence/IDs, provider absence and receipt deletion; preview/apply/repeat never mint/delete/overwrite. Explicit fixture-only reconciliation clears the known stale field; retry creates/binds once, final apply is no-op. **Remediation:** clamped `per_page:1` without `total_pages`, metadata-less pages through empty, repeat, inconsistent metadata and 100-page cap have real CLI assertions; later-page stranded receipt reports actual provider token. Documented `--json` preview exposes safe refs via the CLI. | No current live metadata/provider/receipt comparison or live repair was authorized/executed. Do not clear the reported employee's fields based on fixture evidence. |
| 5 | Preview asserts provider GETs only, no vault create/edit, binding or receipt. All captured human/JSON stdout/stderr, every definition and receipts are scanned for planted API/session/Access/GitHub secrets. Fake edit/read/delete errors deliberately contain secrets. Separate completed vault/mailbox results survive blocked Access. | Secret-bearing fake vault files are necessary fixture state, never evidence output. Secret arguments still pass to op as the existing custody contract documents. |
| 6 | `provision.txt`: 49 check groups on integrated main. Typecheck/build exit 0. Direct `node tests/company-identity-lifecycle-regressions.mjs` also passed 54 scenarios after integration. Runner records registry lifecycle, registry/Plane, Plane and company identity suites exiting 0. Runner's two gateway-dependent suites exit 1 at the same assertion sites under current and baseline provisioners. | Full suite not run; two gateway-fixture suites are **not green** under the isolated runner environment. Independent re-review pending. |

## Reproduce

From this worktree, with Node >=24 and npm:

1. `npm ci` (do not use `--ignore-scripts`: the git Skillex dependency needs prepare/build).
2. `git submodule update --init --recursive` (initializes the pinned Hermes template; does not change its gitlink).
3. `node _bmad-output/implementation-artifacts/FLUME-80/run-checks.mjs`.

The runner records the exact command, exit, environment overrides, duration and output filename in `checks.json`, and exits 1 when any current non-baseline check fails (including pre-existing gateway fixture failures). It blanks ticket-provider credentials and disables host overlays. `scratch-temp.mjs` redirects unchanged legacy `/tmp` mkdtemp prefixes into the inherited profile TMPDIR; it changes no production semantics. Its optional `FLUME80_BASELINE_CLI` redirects spawned CLI paths solely for baseline comparison. Do not use the main test runner for this bounded run: it hardcodes TMPDIR=/tmp.

The runner also executes the direct company lifecycle suite without the preload/overlay and records it as `direct-company-identity-lifecycle.txt`. This is the 54-scenario direct result, separate from the two preload/overlay failures. Logs trim trailing blank EOF lines only; assertions and exit codes are unchanged. `source-hashes.json` records SHA-256 of the exercised production sources, test and guide.

`build-baseline.mjs` loads provision.ts with `git show f85a126835ce3f4a4b5f30198b949d865a9b54b6:...` through an esbuild loader; no tracked source is replaced. The baseline build adds only an inert compatibility export for the new lifecycle receipt reader, so the historical provisioning behavior remains the original source. `FLUME_PROVISION_EXPECT_OLD_FAILURE=1` is an assertion mode for that old CLI, not a passing-current-suite override. The normal suite asserts success and safety against current dist.

## Actual check results

See `checks.json` and sibling `.txt` outputs for fresh machine-produced results on integrated main. The provision log ends `identity-provision-regressions: 49 passed`. The bounded runner itself exits 1 because two baseline-reproducing gateway fixture suites are not green; direct unmodified-environment lifecycle execution passed 54 scenarios. Do not infer a full-suite pass.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | both workspaces compile |
| `npm run build` | 0 | CLI and MCP bundles built |
| baseline builder + baseline reproduction mode | 0 | asserted the historical unsafe sequence (CLI apply/retry themselves exit 1) |
| `node tests/identity-provision-regressions.mjs` | 0 | 49 groups, including cross-command pending-token lifecycle, missing pagination metadata, short clamped pages, repeated/inconsistent pages and page cap |
| `node tests/company-identity-lifecycle-regressions.mjs` (direct, no runner overlay) | 0 | 54 lifecycle scenarios (fresh separate direct invocation) |
| `node tests/registry-lifecycle-projection-regressions.mjs` | 0 | all assertions passed |
| `node tests/company-identity-registry-plane-regressions.mjs` | 0 | all assertions passed |
| `node tests/company-identity-plane-regressions.mjs` | 0 | 20 groups |
| `node tests/company-identity-lifecycle-regressions.mjs` (runner overlay) | 1 | gateway inventory `unresolved`, expected `static-usable`, line 243; same result with baseline provisioner |
| `node tests/employee-access-lifecycle-regressions.mjs` (runner overlay) | 1 | gateway inventory `unresolved`, expected `revoked`, line 378; same result with baseline provisioner |
| `node tests/company-identity-regressions.mjs` | 0 | 30 groups on integrated main; baseline provisioner also exits 0 |
| those two failing suites with baseline provisioner | 1 each | identical failure sites/messages; attribution does not make them green |
| `git diff --check` | 0 | no whitespace errors in uncommitted changes |

No quarantine of tests, skipped assertion or unrelated repair was introduced. Credential history itself is deliberately quarantined when contradictory. Baseline controls replace only provision.ts (plus an inert compatibility export required by the lifecycle import); current company.ts, access-issuance.ts and lifecycle adapter changes are shared in both controls. These paired baseline exclusions diagnose the two unchanged gateway failure sites, not Q1/Q2/Q3 closure and not full-suite acceptance. Q1/Q2/Q3 are proved by current real-CLI negative regressions and still need independent re-review. The two runner gateway failures remain not green.

- Paired baseline exclusions: the original provision.ts control is shared with the new company/issuance/lifecycle guards, so it is not an independent full-source safety control. The final current checks and paired results are in `checks.json`; neither a paired baseline failure nor the direct lifecycle PASS establishes full-suite acceptance.

## Setup findings

Initial `npm ci --ignore-scripts` installed Skillex without dist and could not run the CLI. Running its build script directly failed because published package excludes scripts. Normal `npm ci` ran the dependency preparation and fixed setup. An initially uninitialized template submodule also blocked CLI startup; initialized its existing pinned revision `19ded0acc35c8e14ddcb94dd4ebde2b4421b5384`. No package/lock/gitlink changes. npm reports 9 dependency audit findings (6 moderate, 3 high), not addressed in this ticket.

- BMAD renderer was invoked successfully during initial implementation; this remediation's optional bootstrap was blocked by untrusted mise configuration before uv ran, and `_bmad/scripts/render_skill.py` is absent from this worktree. No live credentials were resolved to repair tooling. Independent review remains the parent's responsibility.

## Independent HOLD remediation recheck (not a review verdict)

- SPEC F1 / QUALITY P2 pagination: real CLI applies find a later-page existing token under served `per_page: 1` without `total_pages` and under no metadata; no duplicate POST. Repeated IDs, inconsistent metadata and the 100-page bound block. A stranded ID-only vault field with a stale deletion receipt reports the real later-page provider token, not `absent`.
- SPEC F2 diagnostic surface: docs now prescribe `flume identity provision <employee> --json`; the real CLI preview exposes safe `client_id_fields`, `provider_match` and `receipt_comparison`, verified with planted secret scan.
- QUALITY P1 lifecycle: fresh `minted` receipt carries subject/account/token/client IDs (no secret). Real CLI failure → credentials → retire preview/apply exercises retained live token, failed DELETE, retry/read-back and idempotent repeat, including a clamped provider listing during retirement; unscoped historical receipts, provider owner/name or client-ID mismatch and an unattributed live named token refuse a false `complete_revocation` and never authorize an unsafe DELETE. Both provision and lifecycle inventory read a short nonempty page through a declared end/empty page, and fail closed on repeated/inconsistent pages. No live reconciliation performed.
- `49` provision groups include the newest QUALITY HOLD Q1/Q2/Q3 regressions: same-page duplicate IDs cannot mint or prove absence, even on a bound-token retry with a remembered failed DELETE; another employee's active/suspended binding or permanent reservation blocks pending retirement; a binding introduced after status publication is seen before Access revocation; normal bind refuses another subject's pending principal; contradictory minted rows are quarantined (including later created/deleted rows, existing binding and a receipt appended during provider listing). Identical duplicate receipts still allow verified retirement.
- The shared secret-free reader `access-issuance.ts` preserves the first client ID and returns no actionable pending IDs for an uncertain scoped journal. Pending and bound retirement steps both stop on uncertainty, and repeat inventory cannot claim completion. No last-write-wins attribution.
- Final pre-check `git pull --no-rebase origin main` merged `3a035d3a33fe67df49016d5f0e44f7ae044f6266` as `f75ef67aa0728a2dd083f78affed977d77750161` in this worktree without conflicts. No main checkout operation or board touch.
- **Independent reviewers must re-run their oracles against this branch**; this evidence is implementer verification, not an independent PASS.

## Remaining approval/verification gates

- Independent source/spec/security review of the pushed branch.
- Investigate/repair the two baseline-reproducing gateway fixture failures under the isolated runner; direct lifecycle suite passed, but the runner is not green. Do not infer full lifecycle coverage.
- Owner-approved read-only live comparison, then separately approved bounded reconciliation/retry for the reported employee. No live credential mutation is authorized by this patch.
- Main merge, installed/deployed verification and all board transitions remain with the parent/operator.
