# Host overlay: what differs per machine

Two flume hosts run the same build. A fact about a *host* (which vault its `op://` references name, which Plane it
talks to, which gateway routes it may use, what its board's lanes are called) must not be a literal in flume's source
or in a tracked `role.yaml`: a literal is one host's value on every machine that pulls the code. Those facts live in
one file per host, outside every repo.

- **Location.** `$FLUME_HOST_OVERLAY` (explicit; a path that does not exist is an error), else
  `$XDG_CONFIG_HOME/flume/host-overlay.yaml`, else `~/.config/flume/host-overlay.yaml`.
  `FLUME_HOST_OVERLAY=none` forces "no overlay"; the test runner sets it so a developer's own overlay cannot change a
  suite's outcome.
- **Absent = today.** Every default is the value the code carried before the overlay existed (big-chungus's), so a host
  with no overlay renders and audits exactly as before.
- **Broken = refusal, never the defaults.** An overlay that exists but does not parse or validate stops the commands
  that need it (`handbook bootstrap`, `lanes`, vault readers) and fails `hermes.gateway-routing` with the reason.
  Falling back would run one host on another's vault or lane names, which is the failure this file exists to end.
- **No typos, no secrets.** An unknown key at any level is an error, not a no-op. A credential-shaped value is refused;
  an overlay holds names, URLs and `op://` references only.

## Format

```yaml
version: 1                      # required
host: damians-mac-studio        # a label, shown in provenance only

host_config:                    # values for ~/.config/hermes-agent-template/config.toml
  fleet:                        # any [section] key the pinned schema carries (see `flume overlay render-config`)
    runtime_scaffold_dir: ~/code/hermes-agent-template/runtime-scaffold   # `~/` and `$HOME/` mean THIS host's home
    vox_url: http://127.0.0.1:8700
  plane:
    base: http://plane.local
    workspace: damian

vault:                          # the 1Password vault every flume-composed op:// reference names
  name: SomeVault               # also feeds host_config.fleet.onepassword_vault (name it once)
  gateway_tokens_item: some-item   # the FLUME-39 item holding each gateway consumer's token as one field

gateway:                        # what `hermes.gateway-routing` holds the fleet config to
  provider: automaticai         # default
  host: api.automaticai.io      # default
  label: AutomaticAI            # default; how findings name the gateway
  models:                       # REQUIRED once a gateway section exists (the list is host-owned; no safe default)
    - automaticai/<account>/<model>

lanes:                          # per-host ticket lane names, over a tracked role.yaml's `ticket_provider:` map
  - match: { provider: plane, workspace: damian, board_id: <uuid> }   # every key optional; none = every board
    replace: false              # default: lay `states` over the tracked map band by band
    states:                     # bands: backlog unstarted started in_review completed cancelled awaiting_decision
      in_review: In Review      #        e2e_testing ready_for_documentation needs_re_evaluation
```

## Defaults (no overlay)

| Setting | Default |
| --- | --- |
| vault name | `DeLoSecrets` |
| gateway tokens item | `yeurk5dpqkaarspvsn3cjtmkki` |
| gateway | provider `automaticai`, host `api.automaticai.io`, label `AutomaticAI`, the twelve curated `automaticai/personal|intelliforia/*` routes |
| host config | the schema in `EnsureTemplateConfig.ts` (scaffold `~/code/33GOD/flume/templates/hermes-agent/runtime-scaffold`, `vox_url` `https://vox.delo.sh`, Plane `https://plane.delo.sh` / `33god`) |
| lanes | the role.yaml's own `ticket_provider:` map |

## Lanes

Plane has no `in_review` state group, so a lane name that does not exist on a board silently lands a transition in the
wrong place. A tracked `role.yaml` names its *owner's* lanes ("E2E Testing & QA"). For a board that lacks them, set a
rule with `replace: true`: the tracked names are ignored for matching boards and any band the rule does not name falls
to the adapter's own default, never to the owner's lane. Without `replace`, the rule's names are laid over the tracked
map and the rest is kept. Rules apply in file order; a later rule wins per band.

`flume lanes` reads `ticket_provider:` the way the shell adapter does (`providers/plane.sh` `tp_cfg`, a line regex, not
a YAML parse), so with no overlay the answer is exactly what the adapter reads today. That equivalence is a test.

```sh
flume lanes show [role.yaml ...]          # tracked vs effective map; default: ./agents/hermes/*/role.yaml
flume lanes get <role.yaml> <band>        # one effective lane name; empty = adapter default. Drop-in for `tp_cfg <band>`
flume overlay show [--file f] [--json]    # validate and summarize this host's overlay
flume overlay render-config [--file f]    # the host config this host would be bootstrapped with
```

`flume lanes get` exits 1 and prints nothing when the overlay is broken, so a caller cannot act on a stale lane.

> The legacy shell adapter lives in hermes-agent-template and still reads `role.yaml` directly; it does not call
> `flume lanes get` yet, so a lane overlay is not applied to adapter transitions until the template replaces its
> `tp_cfg <band>` read with `flume lanes get "$ROLE_YAML" <band>` (a follow-up in that repo, deliberately not made here:
> 74 deployed copies of the template scripts would drift).

## Example: a second host with its own board and vault

Tracked role.yaml files carry the repo owner's board (`workspace`, `board_id`) and lane names, so a second host that has
its own Plane matches by `provider` alone and replaces the tracked map:

```yaml
version: 1
host: damians-mac-studio
host_config:
  fleet:
    runtime_scaffold_dir: ~/code/hermes-agent-template/runtime-scaffold
    vox_url: http://127.0.0.1:8700
  plane: { base: http://plane.local, workspace: damian }
vault: { name: <the vault name in this host's refmap>, gateway_tokens_item: <its gateway-tokens item> }
gateway:
  models: [automaticai/<account>/<model>, automaticai/auto]    # the routes this host's token is allowed
lanes:
  - match: { provider: plane }
    replace: true
    states: { backlog: Backlog, unstarted: Todo, started: In Progress, completed: Done, cancelled: Cancelled }
```

Bands the rule leaves out (here `in_review`, `awaiting_decision`) resolve to the adapter's defaults (`In Review`,
`Needs Attention`), never to the owner's "E2E Testing & QA".

## What reads the overlay

| Reader | Uses |
| --- | --- |
| `flume handbook bootstrap` / `overlay render-config` | `host_config`, `vault.name` |
| `hermes.gateway-routing` (parity rule) | `gateway` |
| specialist launcher, lifecycle gateway adapter, Telegram wiring | `vault.name` |
| gateway desk / registry projection (`consumerOf`) | `vault.name`, `vault.gateway_tokens_item` |
| `flume lanes` | `lanes` |

Where it lives on the second host (macOS): `~/.config/flume/host-overlay.yaml`, mode 0644 is fine: it holds no secrets.
