# FLUME-29 — landed source and current live acceptance

Recorded November 18, 2026. This is a fresh result, not a replacement for dated October evidence. Ticket state remains owned by [the board](https://plane.delo.sh/33god/browse/FLUME-29/); this worker made no board writes and claims no lifecycle transition.

**Outcome: reviewed source landed and verified; actual specialist refresh and two-session memory acceptance remain blocked.**

## Published source

Integration used the operator's standing authority, not PM or pull-request approval. Both repositories first ran `git pull --no-rebase origin main`; no shared branch was switched, stashed, reset or rebased.

| Repository | Published result |
| --- | --- |
| [Template main](https://github.com/delorenj/hermes-agent-template/tree/main) | Fast-forwarded from `2380184c0da7ed853bc20ea5db05050271ca8aa4` to reviewed `96e7e288026782358584b9b85c764659d240ee0d`; pushed and checked with `git ls-remote origin refs/heads/main`. |
| [Flume main](https://github.com/delorenj/flume/tree/main) | Reviewed `0a7e0a173f8037dbd8e82bbdf9f623daaf08b7e4` merged over `196d47d1b7ab078478856eef5f309b2a45a5cc0b` as [`a117a618e92cfe3fabaad655fe34196292b36536`](https://github.com/delorenj/flume/commit/a117a618e92cfe3fabaad655fe34196292b36536); pushed and remotely verified. |
| Flume template gitlink | `git rev-parse a117a618:templates/hermes-agent` returns `96e7e288026782358584b9b85c764659d240ee0d`, exactly the landed template main. Both reviewed tips pass `merge-base --is-ancestor … origin/main`. |

This lands explicit safe `HERMES_DESK_ROOT` step-10 inputs, identity validation before profile effects, narrow owned old-API-to-current-direct provider receipt convergence, the strict no-bundled marker, tests and documentation. Existing global guidance inheritance remains `true`; arbitrary external/project discovery remains disabled. Existing Skillex/runtime advertised-name collision R2 is disclosed in [the repair evidence](r1-desk-input-repair.md), not repaired or absorbed into this slice.

## Fresh verification on landed source

- `npm run build` and `npm run typecheck`: passed. Public `flume` resolves to this checkout's built `packages/flume-hr/dist/index.js`.
- `node tests/named-agent-contract-regressions.ts`: all assertions passed.
- `node tests/specialist-hire-regressions.mjs`: **42 check groups passed**. Tests ran with provider credentials blanked, isolated fleet environment/overlay and scratch-local `TMPDIR`; no board operations were enabled.
- Template: `SKILLEX_TEST_NODE_BIN=/home/delorenj/.local/share/mise/installs/node/24.6.0/bin/node PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m pytest -q --tb=short -p no:cacheprovider tests/test_desk_root_profile.py tests/test_specialist_profile.py tests/test_specialist_provider_migration.py tests/test_named_agent_identity.py tests/test_profile_env_detach_contract.py tests/test_ticket_provider_skip_contract.py`: **198 passed in 86.83s**.
- Installed Skillex **0.4.8**, packed unchanged from Flume's `node_modules` into scratch, exercised all 51 actual desk cases and three actual project entrypoints (fresh create, strict no-op, persisted selection): **54 passed in 51.94s**. Only the test module's in-memory `VERSION` was set to match the installed package; no tracked test changed. These 54 checks overlap the earlier desk coverage and are not 54 distinct additional behaviors.
- `bash -n template/.scripts/10-hermes-profile.sh template/.scripts/_lib.sh` and both repositories' `git diff --check`: passed.

Full workforce/global regression suites were not rerun. Fixture success establishes source behavior, not current deployed acceptance.

## Actual specialist attempts and exact blocker

All live attempts ran from the unrelated directory:

`/home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume29-live-proof`

Authoritative Hermes CLI documentation and installed `hermes chat --help` were read before selecting `chat --oneshot --format stream-json --max-turns 8 --run-budget 120`. Each employee was attempted only through the public `flume launch <employee> --cwd <scratch> -- …` path. The inspection-only prompt requested charter/loadout/bank identification and native retention of a harmless employee-attributed inspection-checklist preference; it prohibited infrastructure changes, workflow deployments, local file writes, credentials, service control and scheduling.

For **both** `infra-specialist` and `n8n-specialist`:

1. `flume onboard --employee <id> --dry-run --json`: exit **1**, `standing: unable to assess`.
2. `flume audit --employee <id> --json`: exit **1**, same refusal.
3. Actual first-session public launcher attempt: exit **1**, before Hermes starts.

Exact refusal:

> specialist projection refused: ownership conflict: handwritten config.yaml; retain changes in config.delta.yaml

The word “handwritten” is the renderer's diagnostic, not a proven attribution of the changes. Read-only comparison through the landed owning renderer identified:

| Employee | Differences from current base + existing delta + renderer pins |
| --- | --- |
| infra-specialist | `gateway.platforms.bloodbank.extra.queued_capacity` is absent in generated `config.yaml`; expected value is `64`, inherited from the current fleet base. |
| n8n-specialist | The same absent queue-capacity field, plus ordering of `plugins.enabled`: installed config places `voice-persona` before `vox`, while current rendering places it last. The sets of plugin names are equal. |

Both receipt provider routes still record `https://api.automaticai.io/v1`. The reviewed narrow provider repair does not authorize adopting the unrelated differences above. No forced render, absorb, profile/config edit, broader migration or ownership bypass was performed. The failed dry-runs were **not** followed by mutating onboarding. Consequently, no second-refresh `changed: false` or passing deployed audit is claimed.

The stored definitions have active company identities and Cloudflare bindings. Current policy authorization and inference availability were not reached. Launch failed before member-token resolution, so this is **not evidence of a missing token** or failed Cloudflare access. The parent's current secret-safe token-read evidence remains distinct from this run. No credentials were printed, persisted, minted or borrowed.

## Acceptance result by criterion

| Criterion | Current proof and limit |
| --- | --- |
| Identity validation and mutation boundaries | **Source verified** by named-agent, specialist and template tests; no second identity contract introduced. |
| Explicit desk step 10 | **Source verified** with real entrypoint tests, including unsafe authored inputs, effective persisted selection precedence, invalid identity before effects, canonical links and no-op behavior. |
| Arbitrary-CWD charter, curated role skills plus current shared guidance, personal bank | **Source/fixture verified; current runtime unproven.** The real launcher was attempted from unrelated scratch but never started Hermes. Read-only profiles declare the correct `agent-<id>` bank, `.skillex-only`, `.no-bundled-skills`, `inherit_global: true`, empty external roots and disabled project discovery. Declarations are not live tool/charter discovery. No obsolete four/fourteen-total-skill expectation is imposed. |
| Deterministic refresh | **Source verified; deployed blocked.** Dry-run refuses ownership; no apply or second no-op pass. |
| infra-specialist actual first chat/native retain, then fresh-session native recall | **Blocked, not passed.** Zero actual chat sessions or native memory operations in this run. |
| n8n-specialist actual first chat/native retain, then fresh-session native recall | **Blocked, not passed.** Zero actual chat sessions or native memory operations in this run. |

No synthetic API, native-provider shortcut or historical memory receipt substitutes for the missing two-session live proof.

## Remaining owner/action

The blocker belongs to **Flume/template generated-profile ownership reconciliation and the fleet-base configuration owner**. Preserve operator intent and supply an authorized maintained reconciliation path for the known base drift/plugin ordering; then repeat only these two employees' dry-run, refresh, second no-op refresh, audits, and actual two-session native Hindsight proof. This worker did not expand the reviewed ownership policy or alter runtime state to make acceptance green. Parent PM owns lifecycle blocking/dependency routing and any needed operator decision.

## Preservation and cleanup

- **Profiles changed: none.** No employee definition, registry row, profile config, skills, local memory or Hindsight bank was changed by this run. `~/.agents` was inspected read-only; its unrelated tool and marge-simpson skill work remains untouched.
- No board writes, gateway/service restarts, identity/account provisioning, credential minting, provider-policy edits or schedule changes occurred.
- Flume's existing `bloodbank-events.jsonl` modification and untracked `spec-one-command-employee-provisioning/` remain outside the commits and were not overwritten.
- Both reviewed worktrees were checked clean/merged, removed, and their local repair branches deleted. Ignored Flume `node_modules`/`dist` and template pytest/Python caches were **moved, not discarded**, beneath `<scratch>/preserved-worktree-artifacts/`. Git required `worktree remove --force` for the Flume tree solely because it contained an initialized submodule; its nested HEAD matched the gitlink and nested tracked/untracked/ignored state was first verified clean. No unmerged or dirty artifacts were deleted. Remote feature branches were retained.
- `git unpushed` was run: global exit **1**, reporting unrelated local-only work in 328 repositories. Before the evidence commit, both touched mains were **0 ahead / 0 behind** their remotes. This is not a global-clean claim. Final evidence publication is identified by its Git commit.

[Structured current-source/live receipt](source-live-receipt-20261118.json) contains the actual scrubbed commands, CWD, child exits, refusal outputs, read-only diagnosis and cleanup result. Local command receipts and preserved caches remain in scratch; no credential-bearing config snapshots were copied into source.
