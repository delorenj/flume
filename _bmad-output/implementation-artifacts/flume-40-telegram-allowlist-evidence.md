# FLUME-40 — interactive Telegram allow-list evidence

Decision: resolve the one operator ID at the interactive `WireTelegram` seam, rather than teaching the shared channel template to read a hire-only vault reference. The existing bot-token reference and template transaction stay unchanged. Basis: Momo pillars `build-lego-not-statues` / `gang-of-four-by-default` (reuse the existing command and provisioning boundaries), bounded by `chase-the-check` and `belsky-doctrine` (every subsequent interactive hire gets the same behavior).

- With no valid explicit override, `op read op://DeLoSecrets/Telegram/id` supplies one trimmed numeric user ID. The ID read has a 15-second ceiling; timeout, failed, absent, empty, or nonnumeric reads warn and offer the validated manual answer or cancellation. A valid comma-separated explicit override skips the lookup. The bot-token flow remains separate; skip, quiet and dry-run return before any ID lookup. No real 1Password read or hire occurred.
- Controlled test uses a stubbed child process and prompt boundary with a synthetic ID, asserts the timeout option and ETIMEDOUT fallback. A second fixture runs the real ingredient against a fake `op` sleeping 30 seconds; it returns in approximately 15 seconds via warning, validated manual ID and script handoff. The separate pinned-template fixture runs the real `30-telegram.sh` with fake `op`, fake `curl`/getMe and isolated home/registry; its effective runtime `.env` is `TELEGRAM_ALLOWED_USERS="987654321,900001"` (fixture operator ID appended), with neither the `op://` reference nor fake bot ID `424242` in the allow-list.

Reproduce from repository root (with initialized `templates/hermes-agent` submodule and installed npm dependencies):

| Command | Exit / observed result |
| --- | --- |
| `node tests/telegram-hire-regressions.mjs` | 0; 17 controlled cases passed (exact reference and 15-second timeout option, no user-ID prompt on success, handoff, numeric and comma override, missing/timeout/failed/empty/nonnumeric/multi-ID vault answer, invalid override, manual validation, cancellation including after timeout, skip, quiet, dry-run). |
| `python3 tests/telegram-op-timeout-fixture.py` | 0; real ingredient with fake 30-second sleeping `op` returned via bounded timeout, warning, validated manual ID and script handoff. |
| `python3 tests/telegram-handoff-fixture.py` | 0; real rendered script wrote the synthetic operator allow-list, not bot ID or literal vault ref. |
| `MISE_TRUSTED_CONFIG_PATHS="$PWD" uv run --no-project --with pytest --with pyyaml python -m pytest -q templates/hermes-agent/tests/test_telegram_provisioning.py templates/hermes-agent/tests/test_named_agent_identity.py` | 0; 27 passed, one upstream AnyIO `PytestRemovedIn10Warning`. |
| `node scripts/run-tests.mjs telegram-hire channel-offline named-agent role-hire` | 0; typecheck and build passed; 6 suites passed, 0 failed, 0 quarantined. |
| `git diff --check` | 0; no whitespace errors. |

Environment note: isolated worktree `mise.toml` is untrusted by default; `MISE_TRUSTED_CONFIG_PATHS="$PWD"` is needed for uv/pytest here. The installed Hermes Python lacks pytest, so the uv invocation supplies it. All fixture values are synthetic; production provisioning and host state are untested by design.
