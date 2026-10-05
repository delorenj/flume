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

Both definitions reference canonical Skillex sets. The existing `n8n` set supplies its workflow, node, expression, error, subworkflow and MCP skills. The `infra-specialist` set in the Skillex catalog references `delonet-conventions`, `delonet-dotenv`, `stacks-deploy` and `systemd-agent-service-diagnostics`. Catalog selection must resolve before hire can change employee state; Flume does not copy skill payloads or enable global selections.

The owning desk exposes canonical skill links. The generated profile receives a Skillex selection with an isolated empty global scope, `.skillex-only`, empty `skills.external_dirs`, and `skills.project_discovery: false`. It has no `.agents` discovery root. Therefore an unrelated working directory cannot add skills to the declared loadout. The profile's `SOUL.md` supplies the charter; `hindsight/config.json` pins the provider to `agent-<id>`. The charter and profile metadata list the own bank plus declared recall banks; the provider writes only the own bank.

Refresh preserves unrelated notes and config delta settings. Flume refuses an unrelated desk/profile/record, unsafe paths, and handwritten changes to owned projections. Put unrelated configuration in `config.delta.yaml`; direct edits of generated `config.yaml` that disagree with it are refused. Registry writes retain YAML comments and other employees under the established lock. The canonical template adapter reads mutable profile state only under the existing profile lock. A second unchanged refresh preserves managed bytes and Skillex receipts.

Portable CLI profiles disable the dashboard and its basic authentication, and clear the inherited dashboard secret in their owned delta. The shared fleet base and unrelated dashboard settings remain unchanged. Other inherited raw credentials refuse projection before employee state is created.

Launch resolves only the employee's existing member-token reference `op://DeLoSecrets/hermes-<id>/credential` into the child process environment. It uses the declared `HERMES_FLEET_BIN` from the trusted fleet environment, or the template configuration's `hermes_bin`, and refuses an unavailable pin. Without a declared runtime it uses `hermes` on PATH. Tests pin their fixture executable explicitly. Launch pins the profile, preserves the requested CWD and propagates the Hermes exit code. A missing vault token or Hermes executable is a deployment dependency; a fixture is not a live acceptance receipt. FLUME-39 owns minting the missing member token. Hire neither mints it nor starts Bloodbank, cron or systemd. Partial projection failures report the owned state; inspect it and retry `onboard` after correcting the cause.
