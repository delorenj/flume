# FLUME-29 — live acceptance continuation

Recorded November 18, 2026. **The two stale generated configs are repaired and both specialists converge; live memory acceptance remains blocked by the installed Hermes gateway CLI's rejection of `--run-budget`.**

This adds to, rather than replaces, the [earlier acceptance report](source-live-acceptance-20261118.md) and [earlier receipt](source-live-receipt-20261118.json). Those accurately record the previous ownership refusal before the parent PM explicitly authorized this reversible, maintained correction. No board state was changed.

## Scoped correction and convergence

Verified checkout and remote main: Flume `d13a29b49ec520700b717b1801d4e0f822065117`, template `96e7e288026782358584b9b85c764659d240ee0d`. Public `flume` still resolves to this checkout's built CLI. This continuation changed no repository implementation or runtime policy.

Before applying anything, inspected the renderer's actual `render --help`, profile-lock helper, backup and atomic-write implementation. Recomputed the expected config through that renderer while holding each target profile's config lock. The only differences were still:

- **infra-specialist:** generated `gateway.platforms.bloodbank.extra.queued_capacity` absent; current shared base requires `64`.
- **n8n-specialist:** the same absent queue capacity plus `plugins.enabled` ordering; membership was identical.

Ran, separately for each employee:

```text
python3 templates/hermes-agent/scripts/hermes-profile-config.py render --profile <id> --dry-run
python3 templates/hermes-agent/scripts/hermes-profile-config.py render --profile <id>
python3 templates/hermes-agent/scripts/hermes-profile-config.py check --profile <id>
```

All exited **0**. Both normal renders used the maintained profile config lock and created backups under the private `~/.hermes/.profile-config-backups/20261118T182658-render/` tree. Each private backup's hash matches its pre-render config. No backup contents or config snapshots are published. No `absorb`, forced ownership, shared-base edit or manual config mutation was used.

Then, from unrelated scratch CWD `/home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume29-live-proof`:

| Real command | infra-specialist | n8n-specialist |
| --- | --- | --- |
| `flume onboard --employee <id> --dry-run --json` | exit 0 | exit 0 |
| `flume onboard --employee <id> --json` | exit 0, `changed: true` | exit 0, `changed: true` |
| Scoped `flume audit --employee <id> --json` | exit 0, `in good standing`, no problems | exit 0, `in good standing`, no problems |
| Second `flume onboard --employee <id> --json` | exit 0, `changed: false`, projection `changed: []` | exit 0, `changed: false`, projection `changed: []` |
| Second-pass owned-state comparison | 228 entries; bytes/link targets, inode, mode and mtime identical | 451 entries; bytes/link targets, inode, mode and mtime identical |
| Final scoped audit, after launch attempts | exit 0, `in good standing`, no problems | exit 0, `in good standing`, no problems |

Onboarding reported only `.no-bundled-skills` and `specialist-projection.json` in each projection's changed list. The role-selection manifest and applied selections were unchanged. The owned-state check excludes runtime logs, cache, sessions, Python caches and `state.db*`; it is not a claim that a daemon's runtime logs never move. [State-proof receipt](source-live-continuation-state-proof-20261118.json) records the checked tree digests and result.

The complete before/after hash comparison confirms **all existing deltas byte-preserved**, only the two target generated configs changed, and the shared base, other profiles' config pairs, registry, employee definitions, company identity, own-bank routing configs and credential references remained unchanged. Preservation hashes are in the structured evidence, not credential-bearing snapshots.

## Actual public launches: precise next blocker

Installed `hermes chat --help` advertises `--run-budget SECONDS`. Each specialist was attempted through the required public path, with correct spacing:

```text
flume launch <id> --cwd /home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume29-live-proof -- chat --oneshot --format stream-json --max-turns 8 --run-budget 120 -q <inspection-only prompt>
```

The prompt requested charter and current curated/shared skill discovery, a bounded read-only CWD check and **native Hindsight retain into the employee's own bank** of a benign, employee-attributed inspection-checklist preference. It prohibited infrastructure/workflow changes, deployments, file or credential writes, service control and scheduling; CLI/HTTP substitutes for absent native tools were forbidden.

**Both real launch commands exited 2**, after about four seconds, returning:

```text
Unsupported gateway CLI options: --run-budget. No local fallback or policy changes were made.
  --run-budget: use `agent.run_budget_seconds` in config.yaml
```

Each stream emitted an empty `session_id`, zero input/output tokens and the same error. No real chat session was created. The member reference was successfully read in memory and never output; both launches progressed beyond Flume's previous profile refusal and reached Hermes. This is not evidence of a missing token, a rejected company Access binding, successful inference, or native memory availability.

Read-only inspection of the installed runtime supplies the cause: `hermes_cli/gateway_chat.py:17–30` explicitly lists `run_budget` as unsupported, and `validate_options` at lines 91–101 rejects it before session creation. Its error relocates the setting to persistent config, while the help still advertises the flag. No persistent config policy was changed to satisfy that suggestion.

**Runtime acceptance still unproven for both employees:** actual charter/role-plus-shared-guidance discovery, terminal CWD tool output, native own-bank retain, and fresh-session recall. Declared bank IDs (`agent-infra-specialist`, `agent-n8n-specialist`), strict markers, managed skills and `inherit_global: true` remain declarations, not successful runtime discovery. Existing advertised-name collision R2 remains outside this correction.

A second recall session was not attempted because the first session was never created and no fact was retained. Zero native retain or recall success is claimed. No historical or synthetic memory result substitutes for these missing sessions.

### Next owner/action

**Hermes canonical gateway CLI / acceptance launch-contract owner:** resolve a supported bounded per-run launch, or obtain explicit authorization for an alternative bounded public invocation. Then repeat the retain and separate fresh-session recall for each employee and inspect the actual native tool outputs. This worker did not remove the budget flag, bypass the gateway, select safe mode, change runtime/profile policy, provision accounts, or restart services to make acceptance pass. Parent PM owns board routing.

## Preservation and evidence

- Changed live profiles: **infra-specialist and n8n-specialist only**. Normal renderer wrote their generated config; scoped onboarding refreshed their managed projection state. Existing deltas, identities, bank routing and reference values were preserved.
- No credentials minted or persisted, no new accounts, board writes, shared-base edits, schedules or service restarts. Existing member secrets were resolved only in memory and added to output scrubbing before launch receipts were recorded.
- Unrelated modified `bloodbank-events.jsonl` and untracked `spec-one-command-employee-provisioning/` were preserved and excluded from the evidence commit. No shared branch switch, stash, reset or rebase.
- [Structured continuation receipt](source-live-continuation-receipt-20261118.json) contains actual scrubbed argv, CWD, timings, child exit codes and outputs, preservation hashes and exact blocker. The preceding source evidence remains unchanged.
- No implementation test suite was rerun: this was a scoped maintained live correction followed by real command verification, not a new source change.
