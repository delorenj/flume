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

flume identity enroll <employee>           # one subject + <handle>@agents.delo.sh on the employee's own definition; preview unless --apply
flume identity show <employee>             # read it back; legacy definitions stay readable
flume identity status <employee> <status>  # active | suspended | retired (local only; revokes nothing); preview unless --apply
flume identity suspend|retire <employee> [--revoke cloudflare_access|github|gateway ...]  # FLUME-53: status first, then the mailbox allowlist (captured, deleted, verified), then only the adapters named; retire adds the routing rule, a tombstone and --revoke all. Preview unless --apply; reports every credential honestly (complete_revocation, `revocation INCOMPLETE`)
flume identity restore <employee>          # FLUME-53: a suspended employee back: re-puts the captured allowlist record, un-suspends only what the lifecycle suspended, status active LAST (preview unless --apply)
flume identity credentials <employee>      # FLUME-53: read-only inventory of every credential and what each provider says about it
flume identity rotate <employee> <provider> --credential-ref <op://...>  # FLUME-53: change credential_ref only (cloudflare_access|github|plane); the old key is manual-action-required (preview unless --apply)
flume identity continuity <employee> [--record] [--comment e:<id>]  # FLUME-53: is history still the same person? baseline vs now; rotation/post move reported, drift is broken
flume identity bind <employee> <provider> ...  # bind a provider principal by reference only; github: App ID, installation ID, op:// key ref; plane: native user UUID, https://<host>/<workspace>, op:// PAT ref (preview unless --apply)
flume identity adopt-actor <employee> github  # record the employee's GitHub bot user ID as GitHub reports it (preview unless --apply)
flume identity adopt-actor <employee> plane --board <b>  # Pilot (px identity verify) verifies the employee's own Plane user on every board; static PAT, expiry not observable (docs/employee-access.md)
flume identity readiness                   # what is unproven about the accounts; --probe cloudflare measures with GETs only

flume access serve                         # employee access facade: Access assertion + launcher-signed run; fixture grants, plus GitHub App installation tokens for service github (docs/employee-access.md)
flume access run <employee> -- <cmd>       # trusted launcher for any command; `flume launch` is the Hermes equivalent
flume access request --service s --resource r --permission p   # plain client; the employee comes from the launcher, never a flag
flume access request --service github --resource owner/repo --permission issues:write --exec -- <cmd>   # a one-repository GitHub token, delivered only to <cmd>
flume access github-inspect --employee <e>  # read-only look at the employee's GitHub App and installations
flume access receipts --employee <e>       # read-only join of request, mail, denial and lifecycle records (docs/employee-access.md)
flume mail list | read <id>                # the launched employee's own mailbox; no identity flag, no send
flume comment verify-plane <REF> --comment <e>:<id>  # prove who wrote Plane comments from px show's actor ids (read-only; docs/employee-access.md)
flume comment post|verify ...              # --exec consumers: leave a marked PR/issue comment as the employee and prove its author from GitHub's readback (docs/employee-access.md)

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
