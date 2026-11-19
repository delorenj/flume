# FLUME-53 scoped repair verification — 2026-11-19

Branch `fix/FLUME-53-lifecycle-integrity-20261119` (base repair `2a8dd011be54d9982bb416295060470c8f063086`). Only isolated built-CLI fixtures were executed; tests use fake providers and scratch `TMPDIR`. No production retirement/revocation, provider install/token mint, board write, runtime restart or main merge.

## Executed local checks

Raw per-command stdout/stderr and actual exits/durations are in active-profile scratch `flume53-repair-20261119-checks/results.json` and its sibling `*.log` files. All seven commands exited **0** on the final run:

- `npm run typecheck` (7.42 s), `npm run build` (0.68 s).
- `node tests/company-identity-regressions.mjs` (33.08 s); `node tests/company-identity-registry-plane-regressions.mjs` (7.87 s); `node tests/company-identity-plane-regressions.mjs` (86.04 s, 20 groups).
- `node tests/company-identity-lifecycle-regressions.mjs` (180.07 s, **54 scenarios**). Built CLI failpoints exit **88 before** real role-status rename and **87 after** real role-status rename; permanent retirement reservation already exists in both cases. The tests reject offboard/re-enroll of `ada@agents.delo.sh`, retired binding reuse, reactivation and restore; same-subject retry converges; unrelated definition/registry bytes and provider mutations are checked.
- `node tests/employee-access-lifecycle-regressions.mjs` (29.68 s, **9** facade/mail/receipts scenarios). It uses actual CLI-launched Hermes/plain fixture runs: unrelated gateway usage with the same consumer, second and caller-spoofed run UUID stays `unverified: trusted-run-mapping-missing`; malformed/foreign/shared/out-of-window negatives and field whitelisting still run. Fixture tests are not live provider evidence.

## External acceptance still HOLD

- **AC5 selected-run gateway proof:** The actual gateway `automaticai.go:203-207` assigns `session_id` from caller headers (`session-id`, `thread-id`, `X-Claude-Code-Session-Id`). Its proof producer validates usage shape/consumer, not a Flume launcher-signed assertion. A same-consumer same-second unrelated request can spoof that header. The CLI can check negative consumer/session/time cases but cannot positively attribute a request to a Flume run; the gateway/launcher owner must supply and validate a trusted upstream request-to-run anchor. No protocol, signature or mapping was invented. Existing `FLUME-39/evidence.md` is ordinary owner evidence, not that anchor; its normal Hermes loader inference returned HTTP 401 even though isolated direct-key inference succeeded. Do not treat linked evidence or a producer's `verified` boolean as AC5 completion.
- **AC6 live canary:** Read-only independent audit in active-profile scratch (`flume53-ac6-independent-audit-2026-11-19.md`) reconciles historical October access/mail denial/restore receipts and distinct native Plane authorship; neither establishes a fresh full selected run. Its GET-only GitHub inspection (`flume53-github-inspect-current.json`) observed App `5296560` (`colrerererebot`) at `2026-11-19T04:52:27.176Z` with `installations: []`. FLUME-51 requires operator installation of the **existing** App on the designated sandbox repository before the two-employee GitHub path can be verified. FLUME-39 normal-loader HTTP 401 remains an additional prerequisite. No new live read was performed for this repair and historical provider state must be rechecked before live acceptance.

The owner can re-review the scoped code/CLI regressions now; **do not claim full ticket acceptance**. Further external provider execution requires separate operator authorization and a trusted gateway mapping.
