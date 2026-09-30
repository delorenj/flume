---
name: agent-fleet-operations
description: |
  Operate and maintain the Hermes workforce with `flume`: hire/onboard an employee into a repo, the org chart in `~/.hermes/agents-registry.yaml`, the handbook (`contracts/handbook.yaml`), real named profiles with generated base-plus-delta config, ignored local runtime, the one gateway unit per agent, compliance audits and remediations, credential migration, transactional config recovery, and TTS defaults. Use for `flume hire|onboard|roster|org|record|review|audit|remediate|handbook`, `~/.hermes/*`, `hermes-agent-template`, PM deployment verification, generated profiles, gateway state, MCP drift, template propagation, or voice changes. Do NOT use for project bootstrap/identity requests (→ 33god-projects), Plane ticket operations (→ project-lifecycle), Bloodbank event schemas (→ bloodbank-integration), or generic config fan-out (→ agent-config-fanout).
---

# Hermes Workforce Operations

Route here for anything that touches a deployed Hermes agent, the agent template,
or the runtime provisioning contract — not the project that happens to employ one.

`flume` is the CLI. It hires, onboards and reviews employees; pjangler bootstraps
repos and keeps the project registry. The vocabulary is deliberate and the
mechanical mapping is exact:

| corporate | mechanical |
|---|---|
| employee | a deployed Hermes agent (`33god-pm`) |
| name | a NAMED employee's identity (`grolf`), role.yaml `identity:`; see "Named agents" |
| title | role (`pm`) |
| desk | `~/.hermes/profiles/<name>` |
| record | that agent's row in `~/.hermes/agents-registry.yaml` |
| org chart | the whole registry |
| job description | `agents/hermes/<title>/role.yaml` |
| handbook | `flume/contracts/handbook.yaml` |

```
flume hire <title>                 bring on a new employee for this repo (title defaults to pm)
flume onboard [title]              re-run the onboarding checklist (refuses a provisioned role dir; see below)
flume roster  (alias: flume org)   the org chart, and every disagreement between the two registries
flume record                       which build each employee actually runs, against the configured pin
flume review [--agent <id>]        performance review across all nine observation domains
flume handbook validate            authorities, classes, service model, retired modes
flume audit [repo] [--rules ids]   the eight employee invariants a repository is subject to
flume remediate <finding> [repo]   correct one finding
```

`roster`, `record`, `review` and `handbook validate` are strictly read-only, take
the same option surface (`--agent`, `--contract`, `--project-registry`,
`--agent-registry`, `--deadline-ms`, `--json`), and exit 0 even when the
workforce is in bad shape. Only a command failure, a blown `--deadline-ms`, or a
cancellation is nonzero — `flume review --exit-code` opts into projecting the
verdict onto the process exit (10 on notice, 11 unable to assess).

`flume onboard` is `runHire(force: false)`, and hire refuses any non-empty role
dir, so on an employee that is already deployed it stops at "Hermes target
directory is not empty" (every PM does this, 2026-09-23). To converge a deployed
employee, run its own marker-guarded steps from the role dir instead, then
`flume audit` + `flume review`:

```bash
cd <repo>/agents/hermes/pm
SKIP_TELEGRAM=1 bash .scripts/30-telegram.sh   # record the channel as deferred (or omit SKIP_* to wire a token; it prompts)
# a bot token already in 1Password is ADOPTED, not pasted (no second vault item):
#   TELEGRAM_BOT_TOKEN_REF=op://DeLoSecrets/<item-uuid>/<field> TELEGRAM_ALLOWED_USERS=<id> bash .scripts/30-telegram.sh
bash .scripts/70-systemd.sh                     # unit, heartbeat retired, gateway active|deferred from provisioning_status
bash .scripts/80-registry.sh                    # project the row
```

`80-registry.sh` re-dumps the WHOLE registry through `yaml.safe_dump`, which
requotes and re-indents every other row. When you need a one-row change,
simulate it first (`REGISTRY_FILE=<scratch copy> bash .scripts/80-registry.sh`),
back up `~/.hermes/agents-registry.yaml`, take `flock <registry>.lock` (other
agents write the same file), edit only that row, and re-parse to prove every
other row is unchanged.

The simulation is what the provisioner WOULD write, not what the contract
allows. Carry over only fields the handbook declares writable
(`contracts/handbook.yaml` `writable_fields`), then run `flume review --agent
<id>` and confirm the row raises no `registry-retired-key`. A role dir's
deployed scripts can lag the template: before template 5ee1909, 80-registry.sh
projected role.yaml `service_state` into `systemd.gateway_state` and
`systemd.heartbeat_state`, keys the handbook's `systemd_lifecycle` seam does
not declare (tonnybox-pm picked both up by a verbatim copy on 2026-09-23). Run
`flume remediate hermes.pm-scaffold <repo> --scripts-only` before you trust a
simulation or rerun the steps. Gateway and heartbeat state live in role.yaml
`service_state`; the registry row names the units only.

`flume remediate` keeps `migrate` as a frozen hidden alias. 74 copies of
`20-runtime-repo.sh` on this machine run
`<bin> migrate hermes.runtime-singleton <path> [--dry-run] --json`, so that argv
must keep working; write `remediate` in anything new.

`flume remediate hermes.pm-scaffold <repo>` does more than refresh scripts: it
also composes SOUL.md (tracked and runtime), rewrites the `hermes` wrapper and
`.gitignore`, seeds the runtime and adds missing registry rows. To land a
template change that only touched `.scripts/`, pass `--scripts-only`. It refreshes
the verbatim `.scripts/**` and the rendered `.scripts/sentinel.prompt.md` and
writes nothing else. Either mode still preserves a *locally-modified* script,
meaning bytes the template never shipped. Diff each one against its nearest
template version before you overwrite it by hand, and fold real behaviour into
the template as configuration (e.g. the extended ticket states are role.yaml
`ticket_provider:` keys) rather than keeping a per-repo fork. When you copy a
template file over one, copy its mode too: a 0644 `credential-launch.sh` kills
its gateway with `status=203/EXEC` on the next restart. A hand-written SOUL.md
(no composer marker, none of the rendered headings) is preserved and audits as
`soul-authored`; that is the intended steady state, not drift to clear. The
composed SOUL's `{{ project_bank }}` is the bank the Claude hooks actually write,
resolved like `~/.claude/hooks/lib/hindsight-bank.sh`: the main checkout's
`.hindsight/bank` override, then the origin remote's repo name, then the checkout
basename (33god-pm → `33GOD`, delocontainers-pm → `DeLoContainers`).

The scaffold reads role.yaml scalars through ONE block-scoped walker,
`.scripts/lib/role-yaml.py` (used by `_lib.sh yaml_get`, `credential-launch.sh`
and `heartbeat.sh`); it refuses duplicate keys instead of guessing, so never add
an awk/grep role.yaml reader beside it. Extended ticket states (Awaiting
Decision, E2E Testing & QA, Ready for Documentation, Needs Re-evaluation) are
role.yaml `ticket_provider:` config: a role enables one by naming its lane, and
`tp resolve_state <state>` validates it read-only; without it `tp transition`
refuses that state.

`pj audit` still exists and owns the PROJECT rules (`mise.*`, `bmad.*`, `sot.*`,
`secrets.env-op`, `provenance.copier`, `skills.project-manifest`, `notebook.*`,
`momo-lifecycle-plane`, `board.schema`). It gained `--rules <comma,ids>` too.
`flume hire` uses it as a postcondition probe
(`pj audit --rules mise.config-root,sot.project-json --json`); a probe that
cannot reach `pj` reports **unable to assess** and does **not** fail the hire.
Flume never hard-depends on pjangler being installed.

## The canonical deployment standard (enforced)

One PM per repo, and exactly **one** per-agent systemd user unit:

- `hermes-<agent>-gateway.service` — chat-platform ingress (Telegram/Slack).

**Per-agent heartbeat timers are retired.** `hermes-<agent>-heartbeat.timer` and
its `.service` do not exist; `systemctl --user list-unit-files | grep -c heartbeat`
returns 0. Every agent used to get a one-minute oneshot whose reconciliation pass
was gated on a `role.yaml` flag that was true in exactly one repo, so ~20,000
no-op invocations a day is all it did. What took over its three apparent jobs:

- **liveness** — the gateway unit itself (`Restart=on-failure`);
- **scheduling** — Bloodbank;
- **persistence** — krebs leases.

`70-systemd.sh` now actively *removes* any heartbeat units it finds and records
`service_state.heartbeat: retired` in `role.yaml`, so re-running provisioning
converges a legacy host. `flume audit --rules systemd.sentinel` requires only the
gateway unit; demanding a timer failed every freshly provisioned agent.

Bloodbank command ingress is **fleet-shared**: `hermes-fleet-bloodbank-gateway.service`
(profile `fleet-bloodbank-gateway`, adapter `bloodbank/services/hermes-gateway`)
subscribes once to `bloodbank.cmd.agent.invocation.start` and routes
`data.target_agent_id` → Hermes profile via the registry's `profile_name`. There
is **no per-agent consumer unit, no checkpoint timer, no filesystem inbox** — any
of those is drift, not an alternative deployment style. Every registry row
advertises `bloodbank: {enabled, gateway_scope: fleet, target_agent_id: <id>}`,
and the registry's top-level `gateways.bloodbank` block records the shared
contract. Canonical command envelopes need an `actor` object and
`schemaref: bloodbank.agent.invocation.start.v1` or the gateway terminally
rejects them. Enforcement: `flume audit` / `flume remediate hermes.registry-parity`
detects and converges violations. Canon: `hermes-agent-template/docs/architecture.md`
§ "Bloodbank wiring". The retired scrum-master title's duties folded into the PM.

### Full command journey

```text
producer → bloodbank.cmd.agent.invocation.start
  → BLOODBANK_COMMANDS work-queue stream
  → fleet-shared durable pull consumer
  → validate envelope + prompt + actor + schema
  → authorize data.target_agent_id against the org chart
  → journal command state in mode-0600 SQLite
  → dispatch selected Hermes profile
  → emit conversation/invocation started + completed|failed events
    (invocation events echo the command's data.context; the n8n
     Ticket Pickup Chip keys agent:working off that echo)
  → BLOODBANK_EVENTS → Candystore → Holocene/toaster
```

Commands are short-lived intent and do not become Candystore rows directly.
The gateway's lifecycle **events** are the durable audit trail. A running gateway
does not prove a target is routable: eligibility requires `bloodbank.enabled`
absent or `true` (**no key means enabled**; only an explicit `false`
quarantines, and a present non-boolean is invalid, treated as disabled and
logged at ERROR), `gateway_scope: fleet`, matching `target_agent_id`, and a
nonblank `profile_name` in the current registry. The same rule holds in
`role.yaml`: `80-registry.sh` projects an absent key as `true`, and both it and
flume read the key with a YAML parser, so `enabled: "false"`, `enabled: ""`,
a bare `enabled:` and `True`/`yes` are all invalid (a blocked remediation), never
a quarantine or an enable. A past `completed` row in
the execution journal proves historical execution only.

## Reading a review verdict

`flume review` returns one of three verdicts. The JSON envelope and the ANSI
report both spell them mechanically; read them as the standing they mean:

| envelope `health.verdict` | standing | means |
|---|---|---|
| `healthy` | in good standing | every observation passed |
| `unhealthy` | on notice | an observation was read and it failed |
| `unproven` | unable to assess | the observation itself could not be trusted |

The third state is load-bearing. It fires when the run was incomplete, stale, or
carried an unjustified skip, and collapsing it into either of the other two is
how an aggregate report starts lying. `health.proven` is
`verdict === healthy && fleet_complete` — that, not the verdict alone, is what
lets you claim the whole workforce is clean. The nine observation domains are
`registry`, `project_binding`, `template_scaffold`, `profile`, `runtime`,
`systemd`, `live_process`, `bloodbank`, `release_provenance`; `--domain` scopes
to one. `--live` is an authorization, not a mode: it permits bounded read-only
host and network observation (the recipe-owned audit rules), never mutation,
process control, service changes, board changes, or Bloodbank activation.

## Operating Principles

- **Workforce truth lives in `~/.hermes/`.** `fleet.env`, `config.yaml`, and
  `agents-registry.yaml` are the shared sources; repo-local
  `agents/hermes/<title>/runtime/` contains only overrides and local state.
- **Profiles inherit the fleet base by GENERATION, not by a Hermes feature.**
  Hermes has **no** native profile config inheritance: `load_config()` merges only
  `DEFAULT_CONFIG` + `$HERMES_HOME/config.yaml` (plus a `/etc/hermes` managed
  overlay that *wins* at the leaf, so it cannot serve as an overridable base).
  `config.inherit_from: default` / `save_mode: delta` is read by **zero lines** of
  Hermes code — `profile.yaml` is metadata ABOUT a desk (description, role), never
  config. Inheritance is real only because `hermes-profile-config.py` renders it.
  Change the fleet default once, then `render --all`.
- **Template changes affect future employees; backfills affect current ones.** Do
  not backfill for a simple shared default or core update.
- **One board owns the shared workforce/template contract.** Fleet-wide fixes
  route to the Hermes Agent PM board, not the repo board.
- **Project identity is owned by `33god-projects` / pjangler.** This skill
  provisions against that identity; it does not create or rename projects.

## Triage Table

| You want to… | Read first | Then |
|---|---|---|
| Add an MCP server / hook / skill so **every** agent client gets it (incl. project-scoped) | [references/extension-points.md](references/extension-points.md) | the matching plane; MCP has no SSOT yet |
| Update Hermes core, shared config, or future-employee provisioning | [references/hermes-fleet-updates.md](references/hermes-fleet-updates.md) | the matching lane inside it |
| Change, backfill, validate, or recover profile config writers | [references/config-mutation-safety.md](references/config-mutation-safety.md) | inventory every writer and prove the real caller interleavings |
| Migrate a fleet credential or eradicate leaked history | [references/secret-migration.md](references/secret-migration.md) | separate containment from any approval-gated history rewrite |
| Run a workforce self-check or debug MCP failures that differ across repo-backed daemons | [references/fleet-self-check.md](references/fleet-self-check.md) | hermes-fleet-updates for remediation lanes |
| Trace or debug a Bloodbank command from producer through Hermes lifecycle events | this skill's full command journey | `bloodbank-integration` → `references/event-journey.md` for the transport contract |
| Capture a governance rule/workflow in the PM template and propagate to existing PMs | [references/pm-template-maintenance.md](references/pm-template-maintenance.md) | hermes-fleet-updates for backfill vs shared-config classification |
| Provision a new PM into a repo | → **33god-projects** `references/project-creation.md` | this skill only for runtime/template details |
| Assess, deploy, or rerun a PM without corrupting repo/fleet state | [references/pm-deployment.md](references/pm-deployment.md) | seal before-state, run `flume hire pm --yes`, then prove postconditions |

## Cross-Cutting Rules

- `~/.hermes/profiles/<repo>-<title>` must be a real named directory. Repo-local
  `agents/hermes/<title>/runtime/` is ignored local state, not the desk and not a
  nested Git repository; only explicit owned-state links may connect them. Reject
  a legacy profile symlink before any mutation rather than silently replacing or
  following it.
- **Never hand-edit `~/.hermes/profiles/<p>/config.yaml` — it is GENERATED.** Edit
  `config.delta.yaml` (override-only, usually 0–10 lines) then
  `hermes-profile-config.py render`. `check` is the drift gate. If Hermes itself
  wrote to a generated config (`/model`, onboarding), `absorb` folds it back
  before the next render, so an in-agent change is never silently lost. The
  generated file carries a render marker in its header; a `config.yaml` without
  one is a hand-forked copy and `hermes.runtime-singleton` fails it.
- Every initial seed, channel, voice, render, absorb, recovery, and backfill path
  that can rewrite `config.delta.yaml` or generated `config.yaml` uses the same
  symlink-safe, crash-releasing per-profile lock. Registry transactions acquire
  registry then profile, and acquire both before snapshotting any durable
  reference or identity they may later write. See
  [references/config-mutation-safety.md](references/config-mutation-safety.md).
- A `profile.yaml` `config:` block is inert — Hermes reads `profile.yaml` only for
  `description` / `role`. Do not add config there and do not trust one you find.
- Never duplicate fleet `mcp_servers` into a delta; the base owns them. A delta
  that redeclares a base LIST replaces it rather than extending it, which is what
  `hermes.delta-list-override` exists to catch.
- **`flume audit` enforces all of this.** The ten employee rules and what each
  one actually reads:

  | rule | scope | reads |
  |---|---|---|
  | `hermes.pm-scaffold` | project | `agents/hermes/<title>/` scripts and launcher match the pinned template |
  | `hermes.untracked-runtimes` | project | runtime is untracked + gitignored, no gitlink, no stale `.gitmodules` |
  | `systemd.sentinel` | host | gateway unit installed and matching each role's declared `service_state` |
  | `hermes.runtime-singleton` | project | real desk dir, shared links, Skillex projection, generated `config.yaml` + present `config.delta.yaml` + pinned memory bank |
  | `hermes.fleet-config` | host | fleet base: `tts.provider: vox`, a `hooks:` block with all four events calling the canonical publisher, `memory.provider` set, `memory` absent from `agent.disabled_toolsets` |
  | `hermes.bloodbank-toolsets` | host | base `platform_toolsets.bloodbank` carries delegation, terminal, file, skills and `timeouts.tools.{sequential_call,concurrent_batch}` is ≥ 900 s (or 0); every routable PM's generated config does too; no routable non-PM employee has delegation, terminal or file |
  | `hermes.gateway-routing` | host | delegated workers route through the AutomaticAI gateway: `providers.automaticai` with `key_env` and an explicit `extra_body.reasoning_effort`, `delegation.provider: automaticai` with a canonical route, no `delegation.base_url`/`api_key`, the key variable mapped to an `op://` reference in the base and in every member's generated config |
  | `hermes.delta-list-override` | host | no delta replaces a fleet-base list |
  | `hermes.profile-wiring` | host | launcher and unit `HERMES_HOME` point at the named desk; no dead `HERMES_OAUTH_FILE` |
  | `hermes.registry-parity` | host | registry ↔ `role.yaml` ↔ `.project.json` agree; `bloodbank` block present; no legacy `consumer_unit`/`checkpoint_timer` |

  `hermes.fleet-config` is deliberately **not** auto-fixable: those are fleet-wide
  operator decisions and a wrong guess changes every agent at once. When you
  change a fleet invariant, add it to a rule in the same pass, or the next drift
  is silent again.
- Identity-memory bank is pinned per desk in `<profile>/hindsight/config.json`.
  Do NOT rely on `bank_id_template: agent-{profile}` alone — `{profile}` resolves
  through `Path.resolve()` + a lowercase id regex, and silently yields the literal
  `custom` for symlinked profile dirs or uppercase names, merging agents' private
  memory. Re-run `memory-pin` after any profile rename.
- systemd units set `HERMES_HOME` to the named desk path, not the raw runtime path.
- Gateway health is per-agent and conditional. Without a per-agent channel
  credential, the gateway must be explicitly deferred, disabled, and inactive —
  never an enabled crash loop. The profile delta must set
  `platforms.telegram.enabled: false` and `platforms.slack.enabled: false` so a
  fleet-base enable cannot leak through; only verified credential ownership may
  flip one true.
- The deferred state has four parts, and `flume review` passes it:
  `telegram.provisioning_status: deferred` in role.yaml AND in the registry row,
  `platforms.telegram.enabled: false` in the delta, and the unit disabled +
  inactive. A gateway left running without a `verified` platform is a finding,
  not health: `undeclared` when the row names no status (voxxy-pm), and a
  contract violation when it says `disabled`/`deferred` (deckard-pm). Give the
  role's `telegram:` block all three keys (`provisioning_status`, `bot_username`,
  `bot_id`). Before template 7c3b6b5 the channel writer appended any key the
  block lacked to the LAST block in role.yaml (tonnybox-pm got
  `service_state.provisioning_status`). `_lib.sh yaml_upsert_block_value` had
  the same DOTALL bug until template 0208c9e: `70-systemd.sh`'s reconcile
  migration appended `  explicit_opt_out: false` after the file's last line and
  left 33god-pm's role.yaml invalid YAML. After running 70 from a role dir whose
  scripts predate 0208c9e, re-parse role.yaml. The same migration flips an
  unmarked legacy `reconcile.enabled: false` to the operational default `true`
  (inert since the heartbeat retired, but it is a role.yaml diff you own).
- A disabled PM gateway is usually a dead bot, not a dead project. Test the
  vaulted token with getMe, feeding the URL on stdin
  (`printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$tok" | curl -s --config -`),
  and open `https://t.me/<handle>`. A 401, plus a t.me page with no bot title,
  means the bot was deleted. Only the operator can mint a new one (BotFather
  `/newbot`). Then run `bash .scripts/30-telegram.sh` (it prompts for the token
  and stages it in 1Password), followed by `70-systemd.sh` and `80-registry.sh`.
  When the operator already vaulted the new token, adopt it by reference instead
  of pasting it: `TELEGRAM_BOT_TOKEN_REF=op://DeLoSecrets/<item-uuid>/<field>
  TELEGRAM_ALLOWED_USERS=<operator id> bash .scripts/30-telegram.sh` (template
  65753ef+). It getMe-verifies and ownership-scans exactly like a pasted token and
  maps the operator's own reference; nothing new is staged. The fleet's PM
  allow-list is the operator's Telegram user id in `runtime/.env`
  `TELEGRAM_ALLOWED_USERS`. Retire a superseded vault item by renaming it
  `RETIRED <date> - <title> (bot <id> @<handle>, <why>)`, never by deleting it.
  Never re-enable the unit against the dead token. tonnybox-pm was parked this way
  on 2026-08-27, and pjangler also listed it in `DEAD_AGENT_IDS` because its role
  pointed at a hard-deleted board while `.project.json` still named the live
  one (PJAN-136). Check the Plane DB before you call a project dead.
- Service proof uses a bounded stabilization window over `Result`,
  `ExecMainStatus`, and `NRestarts`; one `is-active` sample is not success.
- The runtime skill core is pinned by `[fleet] symlinked_runtime_skills` in
  `~/.config/hermes-agent-template/config.toml` — that file, not this one, is the
  authority. Read it, then prove every member resolves to a real
  `~/.agents/skills/<name>/SKILL.md`. Configuration may add skills; it may never
  drop a pinned member, and a missing member is a hard failure, not a warning
  followed by a completion marker. Note that a pinned name is a *directory* under
  `~/.agents/skills/`, which is not always the skill's frontmatter `name:` —
  `33god-projects` ships in the `projects/` directory.
- `flume roster` / `record` / `review` / `audit` are aggregate claims. Verify their
  result against `.project.json`, the registry row, real profile files, and exact
  systemd enabled/active/restart state before declaring success.
- Never store literal credentials in `~/.hermes/.env`. Keep nonsecret toggles
  there if needed; store credentials in DeLoSecrets and map them with
  `secrets.onepassword.env` `op://` references. See
  [references/pm-deployment.md](references/pm-deployment.md) for the migration
  and process-verification boundary. Every `op` on this host is the
  `~/.local/bin/op` wrapper (generated by zshyzsh `op-token-sync`): it caches
  `read`, `item get`, `inject` and `run` in Redis (fresh 24h, stale value served
  when 1Password errors or rate-limits, falls through to the real op when Redis
  is down). `op-cache stats|flush <ref>|disable`; `OP_CACHE=off op ...` bypasses
  one call, which is the only honest way to test that 1Password itself answers.
- A clean working tree or rewritten branch tip does not prove a leaked secret is
  gone. Eradication must cover live text/database/cache state, the Git index and
  reachable refs, local reflogs/unreachable objects, and fetched remote-reachable
  history without printing the value. Rotation, retirement, and private-remote
  history rewriting each require explicit authorization; see
  [references/secret-migration.md](references/secret-migration.md).
- Bloodbank lifecycle events emitted by hooks are 4-token types
  (`bloodbank.<domain>.<entity>.<action>`, e.g. `bloodbank.agent.invocation.started`)
  published on 5-token subjects (`bloodbank.evt.agent.invocation.started`). There is
  no version token in the name — the only version left is the schema revision in
  `dataschema` / `schemaref` (§13 of `bloodbank/docs/event-naming.md`).
- Bloodbank hook install is owned by Bloodbank's fan-out
  (`~/code/33GOD/bloodbank/services/agent-hooks/sync.py --install`). Generated
  Hermes configs should call
  `~/.agents/hooks/bloodbank/publish.py --client hermes --hook <event>`, not a
  Hermes-local publisher.
- Before a live command proof, audit the current target's Bloodbank registry
  eligibility. Never enable a target merely to make a smoke test pass; command
  dispatch invokes a real agent and requires explicit operational authority.

## What a PM can do on an unattended Bloodbank turn

Every command sent to a PM over Bloodbank (grooming, delegation, anything) runs
as a turn on the `bloodbank` platform. The toolsets that turn gets come from
`platform_toolsets.bloodbank` in the **target desk's generated `config.yaml`**
(the gateway scopes each turn to the target profile, not to
`fleet-bloodbank-gateway`).

- **No list means no native tools, and nothing errors.** The bloodbank plugin
  registers no toolset and PM desks do not enable it, so Hermes falls back to a
  nonexistent `hermes-bloodbank` composite: MCP tools only. Grooming still works
  (Plane MCP), so the fleet looked healthy while no PM could `delegate_task`,
  read a file or run a command. Found on FLUME-25 (2026-09-29), fixed under
  FLUME-26. Verify with Hermes' own resolver, not by reading YAML: run
  `hermes_cli.tools_config._get_platform_tools(cfg, "bloodbank")` under the
  target `HERMES_HOME`.
- **Canonical list (fleet base, `~/.hermes/config.yaml`):** `delegation, skills,
  todo, session_search, terminal, file, web`. Deliberately absent: `clarify` (no
  human is present), `cronjob`, `kanban`, `code_execution`, `browser`.
  `hermes.bloodbank-toolsets` asserts it.
- **The tool deadline must outlast a delegation.** Hermes cuts every tool call at
  `timeouts.tools.sequential_call` / `concurrent_batch` (stock **420 s**, `0`
  disables, no per-tool key). A PM blocks inside `delegate_task` until its worker
  returns, so a real worker outlasts 420 s: the call errors with `timed out after
  420.0s`, **the worker keeps running detached**, and the PM, finding it still
  alive, claims the ticket In Progress and ends its turn. `invocation.completed`
  then fires while the work continues and nothing is left holding the lease. The
  fleet base sets both to `1800` (= `agent.gateway_timeout`). It is generic, not
  per tool, so it applies to every platform. A trivial worker finishes under 420 s
  and hides the bug: prove dispatch with a worker that takes longer than seven
  minutes.
- **Delegation is synchronous here.** The adapter declares
  `supports_async_delivery = False`, so `delegate_task` runs inline: the PM's
  turn blocks until the worker returns and `invocation.completed` fires when the
  work is done. A worker gets the PM turn's toolsets minus `delegation`,
  `clarify`, `memory`, `send_message`, `cronjob` and `kanban`, so `terminal` and
  `file` are on the PM's list **for its workers**. A worker can never exceed the
  PM turn's own power.
- **Routable non-PM employees stay restricted.** A reporter, legal assistant or
  director that is routable over Bloodbank has always had no native tools. Pin
  that in its `config.delta.yaml` with
  `x-pjangler-merge: list_patches: platform_toolsets.bloodbank: remove: [...]`.
  Do **not** write `platform_toolsets.bloodbank: []` in a delta: it works, but it
  is exactly the list override `hermes.delta-list-override` reports.
- **Rolling it out.** Edit the base, then `hermes-profile-config.py render
  --profile <name>` per desk. Never `render --all` while legacy desks without a
  `config.delta.yaml` exist (`check` lists them). If you script the loop in zsh,
  iterate with `while IFS= read -r p`, not `for p in $VAR`: zsh does not
  word-split, the whole list becomes one argument, and a `grep` on the error text
  can look like success. Verify with `hermes-profile-config.py check`, not with
  the renderer's own output line.
- **Sessions are per ticket, so a config change reaches a ticket only when its
  session rotates.** A ticket's grooming and delegation turns share one session
  (`agent:<pm>:bloodbank:dm:bloodbank:<thread>`), and it keeps the tool schema it
  was created with until `session_reset` (04:00 local or 24 h idle). A ticket
  groomed before the fix cannot delegate after it, and looks exactly like the
  bug. Prove a fix on a **fresh ticket**.
- **Proving dispatch end to end.** File a ticket whose worker task has an answer
  you compute yourself (e.g. `sha256sum` of a file and `wc -l` of another, read
  only), move it to Todo, and read the PM's session from
  `~/.hermes/profiles/fleet-bloodbank-gateway/state.db` (`sessions.title`,
  `messages.tool_name`): expect a `delegate_task` call, a worker result matching
  your numbers, a clean checkout, and a comment on the ticket. An `invocation.completed`
  event alone proves nothing about the work.
- **Known gaps.** Nothing structural stops a delegation turn from claiming a
  ticket In Progress without a worker (the prompt's rule is prose only).
  `max_inflight: 4` is a fleet-wide cap and a worker holds a slot for its whole
  run. `agent.gateway_timeout: 1800` caps one turn at 30 minutes, so a delegation
  that needs longer is cut regardless of the tool deadline.
- **Workers go through the AutomaticAI gateway, not a direct provider.** Policy: all
  agent inference uses `api.automaticai.io` (skills `automaticai-provider-gateway`
  and `automaticai-provider-gateway-lazy-migration-strategy`). Workers used to run on
  `deepseek/deepseek-v4-flash` via paid OpenRouter (median 41 s per call, max 319 s:
  a reconcile-sized task took ~36 min and outlived its PM's turn). The fleet base now
  has a **named provider**, `providers.automaticai` (`api: https://api.automaticai.io/v1`,
  `key_env: AUTOMATICAI_GATEWAY_KEY`, `extra_body: {reasoning_effort: high}`), and
  `delegation.provider: automaticai`, `delegation.model: automaticai/personal/kimi-2.8`
  with `base_url` and `api_key` left EMPTY. The same task takes ~4 min.
  `hermes.gateway-routing` asserts all of it. Why it is built this way, and what each
  wrong turn does:
  - **Named provider + `key_env`, never `base_url` + `${VAR}`.** `key_env` resolves
    through Hermes' per-turn, per-profile secret scope, so under the multiplexed
    Bloodbank gateway each desk's OWN key is used. A `${VAR}` in a config value reads
    plain `os.environ`, which never holds a desk's own key there, and stays a literal
    `${...}` string when unset. And with `delegation.base_url` set and no `api_key`,
    Hermes has the child **inherit the PARENT's key**: a desk's direct Kimi key would
    be sent to the gateway.
  - **Effort must ride on the provider.** Hermes sends `reasoning_effort` only when
    the child's provider is literally `custom`, but a delegated child is handed the
    configured NAME, so `delegation.reasoning_effort` never reaches the gateway and the
    route default applies (`kimi-2.8` = `max`, which spent a whole 600-token budget
    thinking). `extra_body` on the provider entry is merged into every request and does
    arrive. It applies to any agent using that provider.
  - **One token per fleet member, with a fleet fallback.** The base maps
    `secrets.onepassword.env.AUTOMATICAI_GATEWAY_KEY` to the FLEET token
    (`hermes-fleet-workers`). A member overrides that one line in its
    `config.delta.yaml` with its own `op://.../hermes-<profile>` for per-member tracking;
    a desk without one inherits the fleet token. `scripts/gateway-member-tokens.py`
    mints the tokens and writes those lines (`--apply --render`; dry run by default; it
    verifies its own delta edits and never restarts anything).
  - **Restart to pick up a new key.** Secrets are applied at process start (`1Password:
    applied N secrets` in `logs/gateway.systemd.log`; `/proc/<pid>/environ` will not
    show it). The fleet Bloodbank gateway hydrates each target profile's secrets once
    per process, so a token changed in a delta needs that gateway restarted, as does
    the desk's own Telegram/Slack gateway.
  - **The gateway's login is rate-limited** (about 20 per 20 minutes; `gateway-tokens.py`
    logs in on every call). 26 mints span two windows. A 429, and a burst of 409s
    right after a success, are transient: wait, don't fail.
  - **Prove it from the gateway ledger, not the config:**
    `docker exec newapi-postgres psql -U newapi -d newapi`, table `logs`,
    `token_name like 'aai:hermes-<profile>:%'`; `other::json` carries
    `automaticai_account`, `upstream_model_name`, `automaticai_requested_effort` and
    `automaticai_effort_defaulted`. Expect `kimi-personal`, `kimi-for-coding`, `high`,
    `defaulted=false`, quota 0 (subscription), and the member's own consumer name.
  Still direct on every desk: the primary model, both fallbacks and about sixteen
  `auxiliary.*` selectors (mostly paid OpenRouter); see the plan for the decision.
  Measure worker speed as `assistant`-to-`assistant` gaps in the worker's session
  (`sessions.parent_session_id` = the PM's session) before promising a task will finish.

## Named agents (posts vs. people)

A role directory is a **post**: `agent_id`/`profile` (`33god-pm`) key the
gateway unit, the registry row, Bloodbank `target_agent_id`, gitlinks and the
desk. A **named agent** is a person-like identity holding a post; its name,
personal Hindsight bank and chat bot travel with it if it changes posts, while
the repo, board and project memory stay with the post. The first one is
**Grolf** (`grolf`, @Gr0lfBot), holding `33god-pm` since 2026-09-23.

- **Source:** role.yaml `identity: {name, write_bank, recall_banks}` plus the
  top-level `display_name` (`Grolf`). `write_bank` is always `agent-<name>`; the
  name may never equal the post id, because `agent-<post>` is the compatibility
  bank the NEXT unnamed holder of that post inherits (a personal bank named for
  a post would hand that holder this agent's private memory). The template's
  `.scripts/lib/role-identity.py` and flume's `readRoleIdentity()` enforce the
  same rules; `named-agent-regressions` cross-checks them.
- **Projection:** `80-registry.sh` and `flume remediate hermes.registry-parity`
  write `agents.<id>.identity` + `hindsight.{write_bank, recall_banks}`; a role
  that drops the block drops them. The audit flags either direction of drift,
  and an invalid block is a non-fixable blocker that writes nothing.
- **Memory pin:** `10-hermes-profile.sh` reads role.yaml first (it runs before
  step 80) and pins `hindsight/config.json` to the write bank. On a LIVE desk do
  not run step 10 (it deletes `gateway.pid`/`state.db` links); pin directly:
  `python3 ~/code/33GOD/hermes-agent-template/scripts/hermes-profile-config.py
  memory-pin --profile <post> --bank-id agent-<name>`.
- **History:** the provider auto-recalls ONE bank. Memory from before the name
  stays where it was written (`agent-33god-pm`, `workspace-grolf`); list those
  in `recall_banks` and the composed SOUL tells the agent to recall them
  explicitly. To carry the OLD bank's missions over, seed the new bank with
  `hindsight bank create` + `hindsight bank import-template <new> <export of
  the old>` BEFORE its first session; otherwise the identity template below
  lands first. A `memory
  retain` that answers 403 is Hindsight's extraction LLM (OpenRouter behind
  `hindsight-litellm`) over its key/budget limit, not a permission problem:
  `hindsight operation list <bank>` shows the real error, and a failed retain
  stores nothing. Always pass `--doc-id`: two CLI retains in the same second
  share one auto document id and the second replaces the first.
- **Identity bank template (automatic, 2026-09-26+).** Hire step 10 runs
  `hermes-profile-config.py memory-template --profile <p>`, which records
  config.toml `[hindsight] agent_bank_template`
  (`~/docker/stacks/ai/hindsight/templates/delonet-agent-identity.json`) as
  `bank_template` in `<desk>/hindsight/config.json`, leaving `bank_id` alone.
  The Hermes Hindsight provider (fork `adc4cd4059`+) GETs the bank's config
  overrides once per process and imports that manifest only when the bank has
  no retain/reflect/observations mission. It never overwrites a mission, so a
  hand-imported or ad-hoc mission wins. Look for `Hindsight bank <b> had no
  mission: imported bank template` in the agent log. Backfill a desk with the
  same command. Never use `memory-pin --all` for this: without `--bank-id` it
  rewrites every `bank_id` to `agent-<profile>` and breaks named or renamed
  pins (agent-grolf, agent-drumjangler-pm). Each import queues four
  mental-model refreshes plus a daily cron each, charged to the Hindsight
  OpenRouter key's $5/day cap. Customer-facing agents (dumply,
  intelliforia-voice-agent) do not carry it.
- **SOUL:** `flume remediate hermes.pm-scaffold <repo>` composes a named soul
  (addressed by name, Name row, personal bank, recall list). Unnamed posts
  compose byte-identically, so naming one agent drifts no other soul.
- **Never rename the post** to name an agent: units, routing, the profile dir
  and flume's correlation all hang off `agent_id`.

## Voice / TTS defaults

Hermes uses the self-hosted Voxxy service at `https://vox.delo.sh` for TTS. A
desk's voice is controlled by `tts.vox.voice` (and the fallback `tts.voice`).

> **`tts.provider` MUST be `vox`, never `voxxy`.** Voxxy is the *service* (with
> swappable server-side engines: voxcpm, vibevoice, elevenlabs); the Hermes
> plugin's registry key is `vox` (`provider.name == "vox"`, plugin key
> `tts/vox`). `voxxy` matches no registered provider, so Hermes silently falls
> back to a built-in — ElevenLabs when `ELEVENLABS_API_KEY` is set, otherwise
> Edge — and you hear a stranger's voice with no error. **This has regressed
> twice** (canon: `voxxy/docs/plans/hermes-voxxy-tts-plugin.md`);
> `flume audit --rules hermes.fleet-config` now fails a base that sets anything
> else. Diagnose by asking the service which engine answered, which isolates
> Hermes from Voxxy:
>
> ```bash
> curl -s -D- -o/dev/null -X POST https://vox.delo.sh/synthesize-url \
>   -H 'Content-Type: application/json' \
>   -d '{"text":"probe","voice":"carlin"}' | grep -i x-vox-engine
> ```
>
> `x-vox-engine: voxcpm` means Voxxy is healthy and the fault is Hermes-side
> (wrong provider key). Gateways cache config — `systemctl --user restart
> hermes-<agent>-gateway` after changing it.

To change the default voice instantly, run the bundled script with the voice slug:

```bash
scripts/set_voice.sh carlin
```

See [references/voice-management.md](references/voice-management.md) for the full
workflow, manual fallback, and common pitfalls.

## Out of Scope

- **Project bootstrap / repo-local agent requests** → `33god-projects`.
- **Plane ticket lifecycle** → `project-lifecycle`.
- **Bloodbank event schemas or naming contract** → `bloodbank-integration`.
- **Generic SSOT config fan-out engine mechanics** → `agent-config-fanout`.
