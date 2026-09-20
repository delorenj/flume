# Flume

**The workforce.** Flume is the corporate layer of the 33GOD pipeline: it hires,
onboards, and reviews the agents that do the work, and it owns the org chart they
appear in.

The name evokes a water channel that directs flow — tasks flow *down* the hierarchy
from Director to Manager to Contributor, results flow back *up*, and Bloodbank events
flow *out* to observability.

## Anthropomorphism as protocol

Flume rejects standard AI terminology — chains, nodes, tools, *fleets* — in favour of
strictly anthropomorphic roles. This is not cosmetic. It is a mental model that scales
with complexity, and it is the pillar every name in this repo is held to.

- **Employee** — the base unit. A deployed agent. Has a title, a desk, and a record.
- **Contributor** — a leaf node. Executes work.
- **Manager** — delegates *and* executes.
- **Director** — a pure orchestrator. Only delegates.

| corporate | mechanical |
|---|---|
| employee | a deployed Hermes agent (`33god-pm`) |
| title | role (`pm`) |
| desk | `~/.hermes/profiles/<name>` |
| record | that agent's row in `~/.hermes/agents-registry.yaml` |
| org chart | the whole registry |
| job description | `role.yaml` |
| handbook | `contracts/handbook.yaml` |

## Commands

```
flume hire <title>            # bring on a new employee for this repo (title defaults to pm)
flume onboard [title]         # re-run the onboarding checklist; convergent, no --force
flume offboard <employee>     # remove the org-chart row; dry run unless --apply

flume roster                  # the org chart, and where the two registries disagree
flume review [--agent <id>]   # performance review across nine observation domains
flume record [--agent <id>]   # employment records: the build each employee runs

flume handbook validate       # check the handbook is well-formed
flume handbook bootstrap      # seed host configuration

flume audit [repo]            # compliance audit
flume remediate <finding>     # correct a finding
```

`flume org` is an alias for `flume roster`. `review` and `record` scope with `--agent <id>`,
not a positional — the totals still describe the whole workforce either way.

`flume review` returns one of three verdicts, and the third one matters most:

- **in good standing** — every observation passed
- **on notice** — an observation failed
- **unable to assess** — the observation itself could not be trusted

A review that cannot see clearly says so rather than guessing. That honesty is the
whole point of the handbook.

## Packages

| package | what |
|---|---|
| `@delorenj/flume-core` | the HR domain — Employee, Title, Desk, Record, OrgChart, standing |
| `@delorenj/flume-hr` | the `flume` CLI and its MCP server |

## Position

Flume owns the workforce. It does not own projects — that is
[pjangler](https://github.com/delorenj/pjangler), which bootstraps a repo and keeps the
project registry. It does not own tickets — that is Krebs and Pilot. It does not own the
runtime — that is Hermes, and the job descriptions it renders from come from
[hermes-agent-template](https://github.com/delorenj/hermes-agent-template).

The boundary is written down in `contracts/handbook.yaml`, which names an owner for
every field either side may write.
