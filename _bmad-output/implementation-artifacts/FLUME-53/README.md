# FLUME-53 repair evidence (2026-11-19)

This branch is a local repair for independent review, **not** full FLUME-53 acceptance. No provider mutation, board write, service restart, main merge or new live canary was performed. See `repair-verification.md` for executed CLI checks and external HOLDs.

- `packages/flume-hr/src/workforce/lifecycle.ts` reserves the permanent retirement tombstone in locked lifecycle state before terminal role status is published. Re-running retire for the same subject completes after interruption. Other subjects, offboard/re-enroll, binding reuse and reactivation remain blocked.
- `packages/flume-hr/src/workforce/receipts.ts` no longer calls caller-supplied gateway session headers authenticated. A same-consumer/time/session-header match ends `unverified: trusted-run-mapping-missing`; foreign consumer and out-of-window negatives remain active.
- `tests/company-identity-lifecycle-regressions.mjs` and `tests/fixtures/retire-status-crash.mjs` exercise the built CLI's actual atomic status rename (before/after failpoints), retry, offboard, handle/binding reuse and unrelated records. `tests/employee-access-lifecycle-regressions.mjs` exercises actual CLI-launched runs with an unrelated same-consumer same-second spoofed session header.

AC5 selected-run gateway attribution and AC6 live provider acceptance are **HOLD**. A trusted launcher-to-gateway request mapping does not exist in the current transport. The existing GitHub App installation and ordinary Hermes loader prerequisites also remain external; neither was changed here.
