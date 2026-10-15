# FLUME-51 live proof — 2026-10-14 (Grolf only; AC1 blocked on Rererere)

Secret-free: no token, PEM, JWT, API key or client secret appears here. Sandbox only:
`delorenj/flume-identity-sandbox`, PR #1 (head `8dfa472c6906d295fbf1b11e81217029ab1c51d8`, `proof.txt` lines 1-3 RIGHT).
Nothing was posted anywhere else. The client was this branch's build (`flume comment ...`); the running
`flume-access.service` was restarted on the merged build (see "One thing that broke").

## Verdict

- AC2 (inline review comment) met live for Grolf: author, PR, path, line, side and commit all match the readback.
- AC1 (two employees, `native-distinct-verified`) is NOT met live. It is blocked by the exact gate below.
  Grolf-only readbacks are partial evidence.

## Path used (real, end to end)

`flume access run grolf -- flume access request --service github --resource delorenj/flume-identity-sandbox
--permission issues:write --permission pull_requests:write --exec -- flume comment <post|verify> ...`

Facade grant: `granted`, `evidence: provider`, app 5296475, installation 170872985, permissions
`issues:write, metadata:read, pull_requests:write`, `repository_selection: selected`.

## Steps and results

| # | Step | Result |
|---|---|---|
| 1 | `flume identity adopt-actor grolf github` (preview) | actor `gr0lfbot[bot]`, id `341820121`, type `Bot`, `evidence: provider`; slug via App JWT `GET /app`, then credential-free `GET /users/gr0lfbot[bot]` |
| 2 | `flume identity adopt-actor grolf github --apply` | `native_actor_id: "341820121"` added to the `github` binding in `33GOD/agents/hermes/pm/role.yaml` (one line) |
| 3 | `comment post ... 1 --marker flume51-live-conv-grolf` (conversation) | comment id `6181426777`, `native-verified`, author `341820121` `gr0lfbot[bot]` `Bot`, `performed_via_github_app.id` 5296475 |
| 4 | `comment post ... 1 --review --commit 8dfa472c... --path proof.txt --line 2 --marker flume51-live-inline-grolf` | comment id `4277681258`, `native-verified`; readback location: PR 1, `proof.txt`, line 2, RIGHT, commit `8dfa472c6906d295fbf1b11e81217029ab1c51d8`; author `341820121`; no `performed_via_github_app` on the review comment (as designed: never required) |
| 5 | step 4 again, same marker | `reconciled: true`, same id `4277681258`; the sandbox still holds exactly 1 review comment and 1 conversation comment (no duplicate) |
| 6 | `comment verify ... --comment grolf:issue:6181426777 --comment grolf:review:4277681258` | `not-native-distinct`, reasons `[fewer-than-two-employees]`, Grolf's classes `[issue, review]`, `evidence: provider` (correct: one employee is not a distinct pair) |
| 7 | `comment verify ... --comment grolf:commit:<sha>` | `unsupported-evidence`, refused before any readback |

## One thing that broke, and the fix

Right after step 2 the live `flume-access.service` (running the main checkout's older build, whose closed
binding schema had no `native_actor_id`) read Grolf's definition as invalid and answered every Grolf request
`unknown-client`. The fix was to land this branch on `flume` main, rebuild, and restart the unit. Any machine
running the facade needs this build BEFORE an operator adopts an actor, or the facade drops that employee.

## AC1 gate (blocked, exact)

Rererere (`colrerererebot`, App 5296560, bot `colrerererebot[bot]`) still reports `installations: []` at
2026-10-15T00:20:38Z (`flume access github-inspect --app-id 5296560 --key-ref
op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/sxskdgqeniqpfjftucu6rz7u2i`). To finish AC1, in order:

1. Operator passkey install of App 5296560 on `delorenj/flume-identity-sandbox` (selected repository only).
2. `flume identity bind rererere github --principal 5296560 --instance <installation id> --credential-ref
   op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/sxskdgqeniqpfjftucu6rz7u2i --attribution-mode native --apply`.
3. A sandbox grant in `~/.config/flume/employee-access.yaml` for subject `1dca27f5-06e8-47a3-86c9-49bc3ed5331c`
   (`issues:write`, `pull_requests:write`; the grants match permission strings exactly).
4. `flume identity adopt-actor rererere github --apply` (expect id `341824055`), then post one conversation and one
   inline comment as Rererere, and
   `flume comment verify delorenj/flume-identity-sandbox --comment grolf:issue:6181426777 --comment grolf:review:4277681258
   --comment rererere:issue:<id> --comment rererere:review:<id>` run as either employee with
   `--permission issues:write --permission pull_requests:write`. Expected: `native-distinct-verified`,
   user IDs `341820121` and `341824055`.

## State left behind

- Two comments on sandbox PR #1 (ids above), by `gr0lfbot[bot]`.
- `native_actor_id` on Grolf's binding (`33GOD/agents/hermes/pm/role.yaml`, committed in the 33GOD repo).
- `flume-access.service` restarted on the merged build. Installation tokens (about 6 minted, 1 hour each, sandbox
  only) expire on their own.
