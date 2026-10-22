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
flume hire <title>            # bring on a new employee for this repo
flume onboard                 # run the onboarding checklist (idempotent)
flume offboard <employee>     # retire an employee

flume identity enroll <employee>           # company subject + <handle>@agents.delo.sh (preview unless --apply)
flume identity provision <employee>        # live accounts: Access token, mailbox rule + allowlist, vault item (preview unless --apply)
flume identity show <employee>             # read an employee's company identity
flume identity status <employee> <status>  # local active|suspended|retired; never revokes provider access (use suspend|retire below)
flume identity suspend|retire <employee> [--revoke cloudflare_access|github|gateway ...]  # FLUME-53: status first, then the mailbox allowlist (captured, deleted, verified), then only the adapters named; retire adds the routing rule, a tombstone and --revoke all. Preview unless --apply; reports every credential honestly (complete_revocation, `revocation INCOMPLETE`)
flume identity restore <employee>          # FLUME-53: a suspended employee back: re-puts the captured allowlist record, un-suspends only what the lifecycle suspended, status active LAST (preview unless --apply)
flume identity credentials <employee>      # FLUME-53: read-only inventory of every credential and what each provider says about it
flume identity rotate <employee> <provider> --credential-ref <op://...>  # FLUME-53: change credential_ref only (cloudflare_access|github|plane); the old key is manual-action-required (preview unless --apply)
flume identity continuity <employee> [--record] [--comment e:<id>]  # FLUME-53: is history still the same person? baseline vs now; rotation/post move reported, drift is broken
flume identity bind <employee> <provider> --principal --instance --credential-ref  # bind a provider by reference only (preview unless --apply); github: App ID, installation ID, op://<vault>/<item-uuid>/<field-id>; plane: native user UUID, https://<host>/<workspace>, op:// ref to the employee's own PAT
flume identity adopt-actor <employee> github  # record the bot user ID GitHub reports for the employee's own App as native_actor_id (preview unless --apply; never mints)
flume identity adopt-actor <employee> plane --board <b...>  # plane: Pilot (`px identity verify`) verifies the bound native user on every board, then native_actor_id = that UUID (preview unless --apply; Flume has no Plane client)
flume identity readiness                   # unproven account facts; --probe cloudflare is GET-only
flume identity recent <employee> [--touch p] # the recall compass: last 5 projects, MRU-first (preview unless --apply)
flume identity recall <employee> [--narrow]  # write bank + declared banks most-recently-interacted first

flume access serve                         # employee access facade: Cloudflare Access assertion + launcher-signed run; fixture grants, and a real single-repository GitHub App token for service github
flume access run <employee> -- <cmd>       # trusted launcher for any plain command: only that employee's access in its env
flume access request --service s --resource r --permission p   # plain client; identity comes from the launcher, never a flag
flume access request --service github --resource owner/repo --permission issues:write --exec -- <cmd>   # the GitHub token reaches only <cmd>'s env (GH_TOKEN/GITHUB_TOKEN), never output
flume access github-inspect (--employee e | --app-id id --key-ref op://...)   # read-only: the App and its installations (app-JWT GETs only)
flume access receipts (--employee e | --run id) [--gateway-proof f]   # FLUME-53: read-only join of request, mail, denial and lifecycle records by subject, run_id and operation_id
flume mail list | read <id>                 # FLUME-53: plain client for the launched employee's own mailbox (no identity flag, no send); run as `flume access run <e> -- flume mail list`
flume comment post <owner/repo> <n> --body <text> [--marker k] [--review --commit sha --path f --line n]   # --exec consumer: one marked comment, reconciled before and after, read back from GitHub
flume comment verify <owner/repo> --comment <employee>:<issue|review>:<id> ...   # --exec consumer, read-only: native-distinct-verified only for distinct native Apps, by GitHub's author ID alone
flume comment verify-plane <REF> --comment <employee>:<comment-id> ... [--apply]   # reads the ticket via `px show`; native-distinct-verified only for distinct adopted Plane users, by actor_id alone (docs/employee-access.md)
flume launch <employee> -- <args>          # the Hermes launcher uses the same contract (see docs/employee-access.md)

flume channel list [--employee e] [--all]   # every employee x platform: registry status, delta enabled, reference names present, live gateway state, and how many Telegram bots are active
flume channel offline <employee> [--platform telegram|slack] [--reason "..."] [--apply] [--no-reload]   # PARK a channel on purpose (token rotated out, Telegram's active-bot cap, revoked): reference kept, delta pinned enabled: false, registry says offline + offline_since/offline_reason; one profile is cycled through the gateway control socket (preview unless --apply)
flume channel online <employee> [--platform telegram|slack] [--credential-ref op://<vault>/<item-uuid>/<field>] [--app-token-ref op://...] [--apply] [--no-reload]   # bring it back; with a NEW ref this is the rotation path: op-resolved at apply time only, verified with the platform (Telegram getMe / Slack auth.test), refused on rejection or a bot another profile already owns, identity recorded (preview unless --apply)

flume org                     # the org chart
flume roster                  # who works here
flume review [employee]       # performance review
flume record <employee>       # employment record

flume handbook validate       # check the handbook is well-formed
flume handbook bootstrap      # seed host configuration

flume audit                   # compliance audit
flume remediate <finding>     # correct a finding
```

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
