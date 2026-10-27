# Portable specialists

A specialist owns `~/.agents/workforce/<id>/agent.yaml`. Flume projects that definition into a real strict Hermes profile at `~/.hermes/profiles/<id>` and an explicitly portable employment record. The desk is independent of the caller's project. Repository hires and onboarding retain their existing defaults.

```sh
flume hire --definition examples/employees/infra-specialist.yaml --json
flume hire --definition examples/employees/n8n-specialist.yaml --json
flume audit --employee infra-specialist --json
flume roster --agent infra-specialist --json

# Edit the owning agent.yaml, then refresh it.
flume onboard --employee infra-specialist --json
# Or supply an updated definition for the same owned employee.
flume onboard --definition examples/employees/infra-specialist.yaml --json

# Run from the current directory or select a working directory explicitly.
flume launch infra-specialist -- chat
flume launch n8n-specialist --cwd /path/to/work -- chat -q 'Inspect this workflow'
```

Both definitions reference canonical Skillex sets. The existing `n8n` set supplies its workflow, node, expression, error, subworkflow and MCP skills. The `infra-specialist` set in the Skillex catalog references `delonet-conventions`, `delonet-dotenv`, `stacks-deploy` and `systemd-agent-service-diagnostics`. Catalog selection must resolve before hire can change employee state; Flume does not copy skill payloads or modify the shared global selection. Profiles inherit that selection alongside their role loadout.

The owning desk exposes canonical skill links. The generated profile receives a Skillex selection, `.skillex-only`, empty `skills.external_dirs`, `skills.project_discovery: false` and `skills.inherit_global: true`. It has no `.agents` discovery root. The inheritance pin composes the shared global selection (`~/.agents/skills.json` — canonical operating guidance such as ego-browser and kapture) with the role's own declared set or pack: Skillex profile sync resolves the global scope and the desk's role-selection project separately and unions them. Hermes itself never reads `skills.inherit_global` (`agent/skill_utils.py` discovers through `external_dirs` and `project_discovery` only), so the pin widens no Hermes discovery root; strict ownership still comes from `external_dirs: []` plus `.skillex-only`, which projection refuses to relax. `skills/` belongs to Skillex alone: what the employee learns through `skill_manage` lands in `learned-skills/` (`skills.create_dir`), the curator (which archives into `skills/.archive`) is off, and Hermes' bundled-skill sync is a no-op in a profile carrying `.skillex-only` (hermes-agent 0807046). Hermes bookkeeping inside `skills/` (`.usage.json`, `.curator_state`, `.curator_ledger.jsonl`, `.bundled_manifest`, `.locks/`, ...) is tolerated; anything else is refused. The persistent inheritance policy requires the Skillex profile implementation that reads this configuration. An unrelated working directory cannot add skills to it. The profile's `SOUL.md` supplies the charter; `hindsight/config.json` pins the provider to `agent-<id>`. The charter and profile metadata list the own bank plus declared recall banks; the provider writes only the own bank.

Desks projected under the pre-2026-10-20 policy carry `skills.inherit_global: false` in their managed delta and receipt. A refresh migrates them: the renderer's receipt ownership accepts the old managed value, pins `true`, and preserves unrelated operator configuration; the next refresh is a no-op. A handwritten flip of the pin (either direction, when it disagrees with the managed receipt) is still refused as an ownership conflict.

Hindsight recall defaults to `world`, `experience` and `observation` so newly retained personal facts are discoverable. Refresh preserves an explicitly configured `recall_types` value in `hindsight/config.json`.

Refresh preserves unrelated notes and config delta settings. Flume refuses an unrelated desk/profile/record, unsafe paths, and handwritten changes to owned projections. Put unrelated configuration in `config.delta.yaml`; direct edits of generated `config.yaml` that disagree with it are refused. Structured files compare by value, not bytes, so Hermes re-dumping its YAML after a run is not drift, and a Skillex receipt whose only change is a newer catalog revision is not a problem. Registry writes retain YAML comments and other employees under the established lock. The canonical template adapter reads mutable profile state only under the existing profile lock. A second unchanged refresh preserves managed bytes and Skillex receipts.

Portable CLI profiles disable the dashboard and its basic authentication, and clear the inherited dashboard secret in their owned delta. The shared fleet base and unrelated dashboard settings remain unchanged. Other inherited raw credentials refuse projection before employee state is created.

Launch first audits; when the only problems are projection drift (profile files, desk contract, skill links or receipt), it converges through the same refresh as `flume onboard --employee <id>` and audits again. A record that disagrees with the definition, a pending publication, foreign skills or a handwritten `config.yaml` still refuse. An enrolled, active company identity with a `cloudflare_access` binding authorized on the `identity.delo.sh` Access policy is required. Launch then resolves only the employee's member-token reference, `secrets.onepassword.env.AUTOMATICAI_GATEWAY_KEY` in the profile delta (`op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/hermes-<id>`, minted with `gateway-tokens.py mint hermes-<id>`), falling back to `op://DeLoSecrets/hermes-<id>/credential`, into the child process environment. It uses the declared `HERMES_FLEET_BIN` from the trusted fleet environment, or the template configuration's `hermes_bin`, and refuses an unavailable pin. Without a declared runtime it uses `hermes` on PATH. Tests pin their fixture executable explicitly. Launch pins the profile, preserves the requested CWD and propagates the Hermes exit code. A missing vault token or Hermes executable is a deployment dependency; a fixture is not a live acceptance receipt. FLUME-39 owns minting the missing member token. Hire neither mints it nor starts Bloodbank, cron or systemd. Partial projection failures report the owned state; inspect it and retry `onboard` after correcting the cause.

## Persona update (FLUME-69)

`flume identity update <employee>` renames the person and re-voices their charter on the definition they already own — for a portable specialist, `~/.agents/workforce/<id>/agent.yaml`. It is a preview unless `--apply`:

```sh
flume identity update bennett --name Christopher --json                  # preview
flume identity update bennett --name Christopher --apply --json          # write + converge
flume identity update bennett --tone "Warm, direct and precise." --apply --json
flume identity update bennett --directives-file directives.yaml --apply --json
```

`--name` changes `display_name` only. **No personality is invented from the name**: tone and directives change only when the operator passes `--tone` or `--directives-file` (a YAML list of strings, or one directive per line; it replaces the list). Re-running with the same inputs is a no-op.

Every changed candidate is validated before publication and checked again on read-back: `id`, `role`, `skills`, `memory` (write and recall banks), `desk`, `schema_version`, `identity`, the whole `company_identity` block, and `charter.purpose` must remain semantically equal. YAML comments are retained; byte-identical formatting is not promised. Apply keeps the registry lock through a fresh-state check, real onboarding preflight, definition publication and the onboarding refresh. The profile adapter takes the canonical profile lock inside that transaction. A read-back failure restores the original definition inode before any refresh. Existing ownership conflicts refuse during preflight, without changing the definition.

If a later projection step fails or the process is interrupted, the candidate definition remains canonical. The command reports a partial result and `recovery.next_action: flume onboard --employee <id>`; the existing profile publication journal recovers forwards, never by restoring an old definition over a later identity change. Re-running the same persona apply also converges an unfinished projection instead of incorrectly reporting a no-op. No live gateway restart is performed; active conversations may retain their earlier system prompt until their next session.

Scope, honestly reported. Repo employees (post `role.yaml` holders) are refused with `unsupported-post-definition` until the named-post flow grows the same guarantees. These surfaces are **not** changed by this command and are listed `unmanaged` in every result: provider display names (GitHub App name, Plane user display name), the 1Password vault item label, the `<handle>@agents.delo.sh` mailbox (it follows the immutable company handle), chat avatars, and external Slack workspace display names. The profile's `SOUL.md`, `profile.yaml` metadata and the registry row's `display_name` ARE updated, because they project from the definition.

A name change is not a post rename: the employee id, desk, profile directory, gateway unit, Bloodbank routing and memory banks all stay. Rename the post, never — the same rule the named-agent contract already carries.
