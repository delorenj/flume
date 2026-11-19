# FLUME-51 — current verification and operator prerequisite

Observed 2026-11-19 UTC (2026-11-18 local). Recorded by `flume-pm`.

## Result

The existing implementation is present and the current isolated regression checks pass. **Full acceptance is not met:** Rererere's GitHub App has no installations, and its employee definition has no GitHub binding or adopted GitHub actor. There is no Rererere GitHub sandbox grant in the configured access policy. No new comments were posted, credentials minted, bindings/grants changed, Apps installed, services restarted, or production actions performed by this pass.

This is a current prerequisite check, not a fresh readback of the October comments. The [historical sandbox receipt](live-proof-2026-10-14.md) remains partial Grolf-only evidence. The story document's `done` status is not two-employee provider acceptance.

## Current read-only observations

Commands used:

```sh
flume access github-inspect --employee grolf --json
flume access github-inspect --app-id 5296560 \
  --key-ref op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/sxskdgqeniqpfjftucu6rz7u2i --json
flume identity show grolf --json
flume identity show rererere --json
```

All four commands exited 0. App inspections report `evidence: provider`.

| Prerequisite | Grolf | Rererere |
| --- | --- | --- |
| Employee status | active | active |
| Subject | `1dcd3567-3b5e-46b0-a6c3-a2753d6c763b` | `1dca27f5-06e8-47a3-86c9-49bc3ed5331c` |
| App | `5296475`, `gr0lfbot` | `5296560`, `colrerererebot` |
| App inspection time | `2026-11-19T03:01:44.217Z` | `2026-11-19T03:01:43.368Z` |
| Provider installation | `170872985`, selected repositories, not suspended | `installations: []` |
| Employee GitHub binding | App and installation above, attribution `native` | absent |
| Adopted GitHub actor | `341820121` | absent |
| Local sandbox grant | existing grant for `delorenj/flume-identity-sandbox` | absent |

The local access policy at `~/.config/flume/employee-access.yaml` contains only Grolf's sandbox grant, for `issues:write`, `pull_requests:write`, and `contents:read`. Inspection of Grolf's installation reports wider App permissions; that is not evidence of a newly minted repository-scoped token or current repository membership. This pass did not request a token. Effective repository scope must still be established through the existing FLUME-50 path before posting.

## Current isolated verification

Delegated verification used an isolated worktree at revision `7df4c325950c62a48d85746776013d0d7e47ad55`. Its first attempt stopped because the pinned template submodule was absent; after initializing that pinned submodule, both complete verification commands exited 0. The worktree was removed without leaving code changes. Unrelated shared-checkout work was preserved.

```sh
node scripts/run-tests.mjs employee-access-github-comments
node scripts/run-tests.mjs named-agent role-contract registry-comments company-identity employee-access identity-provision specialist-hire
git diff --check
```

- Focused run: typecheck and build passed; the GitHub comments suite passed.
- Story regressions: typecheck and build passed; all 15 selected suites passed, none failed or quarantined-failing.
- Diff check: exit 0.
- Source coverage is in `tests/employee-access-github-comments-regressions.mjs`, using isolated fake providers, not live authorship proof.

The orchestrator read the actual saved verification logs and confirmed the gates and complete summaries. Local diagnostic logs are profile scratch only; the commands and outcomes above are the durable result, not a reliance on those expiring files.

## Acceptance reconciliation

1. **Prerequisite reconciliation: complete, delivery gated.** Existing source, review history and receipts were reused; the fresh read-only observations above identify the missing installation, binding, grant and actor. No second adapter was built.
2. **Two-employee provider proof: not met.** Only the historical Grolf receipt exists here. No combined provider result for both classes and both employees was obtained.
3. **Inline location and refusal regressions: pass in isolation.** The existing suite exercises PR/path/line/side/commit mismatches and explicit permission, stale-head, invalid-position and unsupported-mode failures. Live evidence remains the historical Grolf receipt, not a new two-employee run.
4. **Retry and reconciliation regressions: pass in isolation.** Existing tests cover same-marker sequential reruns, timed-out committed and absent POSTs, duplicates, and at most one POST per invocation. The historical live timeout exercise was not repeated.
5. **Authorship and shared-bot regressions: pass in isolation.** Existing tests exercise spoofed text/markers, unsupported commit evidence, distinct native actors/Apps, and explicitly configured shared attribution that cannot satisfy native-distinct proof.
6. **Evidence: partial.** Current regression results and prerequisite observations are recorded here; the required two-employee provider receipt is missing. Full acceptance must wait, regardless of local test success.

## Owner action and safe resume

**Jarad:** complete the GitHub installation/confirmation for `colrerererebot` (App `5296560`) on **only** `delorenj/flume-identity-sandbox`, then confirm it is installed. Do not widen to other repositories or create another App. The earlier receipt reported a passkey step; this pass verified missing installation, not the current browser prompt.

After that confirmation, the next authorized execution pass must:

1. Read back the installation and selected sandbox access using `github-inspect`; do not guess an installation ID.
2. Have the authorized operator path bind Rererere to that existing App/installation and vaulted key, add only the sandbox comment grant, and adopt GitHub's reported Bot actor. Preserve subject and unrelated configuration. Respect the documented deploy-before-adopt compatibility gate; this receipt does not authorize a restart.
3. Confirm the targeted build passes the documented regression gates before posting. Re-read the designated PR head/location and existing marked comments. Reuse valid Grolf evidence/comments rather than duplicate them; stale location proof needs explicit reconciliation, not a fabricated match.
4. Through each employee's launcher and FLUME-50 scoped `--exec` path, obtain or reconcile one conversation and one inline comment per employee; verify all four with provider readbacks, distinct subjects/Apps/actors, Bot types and matching inline locations. Use stable markers and retain secret-free receipts.
5. Only close FLUME-51 after the combined result is `native-distinct-verified` and every acceptance check is met. No production comments or merge/push/approval/admin permission is needed for that proof.
