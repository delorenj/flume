# FLUME-14 integration receipt

Integrated candidate `eeeefb34b85c5b6e67d66ef99bfdef79396172ec` with `origin/main` at `e694fbbead66ae0021bb2aa3da7bb21547234919` using `git pull --no-rebase origin main` in the dedicated feature worktree. Merge commit `76dead4a00860862758dc0640ca7376acdcd6b0e`; automatic merge of `scripts/run-tests.mjs` preserved concurrent launch-mode suite replacement and additions plus the FLUME-14 routing registration. The merged tree's ticket delta against that main is 11 files; no other main-owned path was resolved or edited. `git diff --check origin/main HEAD`: exit 0. Prior independent SPEC pass at `ea44f90bb14a2cde8dd5bbe7eb0c397a5b008d20` and final QUALITY Q1 pass at `eeeefb34b85c5b6e67d66ef99bfdef79396172ec` predate this merge.

## Merged verification

Direct execution under active-profile scratch `TMPDIR`, never the runner that forces `/tmp`; `FLUME_HOST_OVERLAY=none`, blank ticket credentials, absent host-live registry selectors, and a scratch `python3` shim to the installed Hermes interpreter with PyYAML. This shim is for narrow renderer child PATH only; it is not a deployed configuration change. Real built CLI and pinned template gitlink `c738f69db40a19b9f6c316b03b1c17edef9d0948` used. Log/summary directory: `/home/delorenj/.hermes/profiles/flume-pm/cache/scratch/f14-integration/`.

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | both workspaces |
| `npm run build` | 0 | rebuilt merged CLI/MCP |
| `node tests/flume-14-routing-regressions.mjs` | 0 | 16 passed; 0 failed/skipped |
| `node tests/fleet-contract-regressions.mjs` | 0 | 128 passed; 0 failed/skipped |
| `node tests/fleet-status-regressions.mjs` | 0 | 54 passed; 2 host-live cases intentionally skipped; 0 failed (270 s bounded rerun) |
| `node tests/fleet-health-regressions.mjs` | 0 | 32 passed; 0 failed/skipped |
| `node tests/fleet-shared-bloodbank-regressions.mjs` | 0 | `ok` |

The first status attempt used a 240 s outer ceiling and reached 49 checks without a failure before that ceiling; rerun with a 580 s ceiling completed in 270 s. The rerun, not the timed-out partial run, is the status gate. Full test matrix and host-live fleet audit were not run. This receipt is scoped to the affected contract boundary and does not assert unrelated launch-mode behavior was retested.

## Read-only live observation

At `2026-11-18T17:49:48.645379+00:00`, the newly rebuilt merged artifact `packages/flume-hr/dist/index.js` ran `review --agent flume-pm --domain bloodbank --deadline-ms 8000 --json` with a 12-second outer ceiling. Exit 0. Auxiliary `gateway-control-identify`: `pass`, `gateway-serves-declared-profile`, direct session-profile addressability. Separate `bloodbank-target-resolution-unsupported`: `unsupported`. Capability readiness: `unproven`; observed lifecycle: `out_of_scope`; declared activation: `granted` (not proof of activation). Scoped health `complete: true`, `proven: false`, verdict `healthy` under the explicit capability deferral. Only a whitelisted non-secret summary was retained (`live-whitelist.json` in scratch); no raw identity payload/profile config was saved. This is **not** Bloodbank target resolver, broker delivery, dispatch, execution, activation or routing-ready proof. No service, board, profile, registry, activation or clock writes were made.

The older `docs/evidence/flume-14-routing-readiness.md` records its pre-integration candidate execution and therefore correctly says main integration was not yet exercised **at that time**. This receipt supersedes that historical limit for this merged tree only. Remote main publication and branch cleanup require separate post-commit verification; this receipt does not assert them in advance.
