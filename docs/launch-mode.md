# Launch mode on a single PM

Launch mode is how a repo drives a launch: one PM, one board, one committed declaration. It replaced
launch directors (`launch-director`, `paired-launch-director`), the paired engineering manager (`em`)
and the portfolio director desk that ran a launch (2026-11-18). The `director` **role** stays for
repos that use it.

> The declaration's `mode:` key now spans the whole project lifecycle — `develop` (the default;
> `steady` is a legacy alias), `launch`, `polish` and `live`. Polish reuses every piece of machinery
> on this page (same driver, wrappers, job, Candybar entry, audit rule) at a faster cadence. See
> [project-modes.md](project-modes.md) for the modes themselves; this page stays the wiring reference.

| piece | where | owner |
| --- | --- | --- |
| charter | `roles/pm.md`, `## Launch mode` and `## Polish mode` (inert without the declaration) | flume |
| declaration | `<repo>/.launch.yaml` (`mode: develop \| launch \| polish \| live` — `steady` reads as develop — plus `finish_line`, `contract`, `epic`, optional `cut_line`, optional `scopes: [child dirs]` for a monorepo parent, optional `polish:` block) | **Jarad only**; the PM proposes `mode: live` (in production, people can buy it and are using it) or `mode: develop` (not) in a ticket |
| driver | `<desk>/.scripts/launch-pass.py` (`--monitor`, `--brief`, `--apply plan.json`) | hermes-agent template |
| wrappers | `~/.hermes/profiles/<profile>/scripts/launch-{monitor,brief}.sh` (real files exec'ing the driver) | `flume launch enable` |
| Hermes job | profile cron job, `scheduler: external`, lean (terminal,file,no_mcp; no skills; 10 iterations, 30 in polish) | `flume launch enable` |
| clock | `<repo>/.candybars/<repo>-pm-launch-pass.candybar.toml`, registered and enabled | `flume launch enable` |

Candybar is the only clock. The job never schedules itself; `hermes cron run` is the only trigger.

## Commands

```bash
flume launch status  [repo] [--json]
flume launch enable  [repo] [--dry-run] [--schedule "<cron>"] [--timezone <iana>] [--json]
flume launch disable [repo] [--dry-run] [--json]
flume mode status|enable|disable [repo]   # the same machinery, mode-first name
```

`[repo]` defaults to the current directory. `flume launch <employee>` (the older portable-specialist
launcher) is unchanged and is the default when the first word is not `status|enable|disable`.

- **status** reads, never writes: declaration (and mode), the repo's PM desk, driver and wrapper
  presence, the Hermes launch job, the Candybar manifest and its registration state, last Candybar
  run, the polish metrics ledger in polish mode, and any retired-role desk still live. Exit 1 when
  it lists problems.
- **enable** requires `.launch.yaml` `mode: launch` or `mode: polish`, exactly one live `pm` desk in
  the registry for
  the repo (an unconverted `em` desk is named, see below) and `.scripts/launch-pass.py` on that desk
  (else: `flume remediate hermes.pm-scaffold <repo> --scripts-only`). It then makes true, in order:
  the two wrappers; one Hermes launch job (adopts the profile's job whose script is
  `launch-brief.sh` and monitor is `launch-monitor.sh`, else creates one at `--schedule`, default
  the declaration's `polish.cadence` in polish, else hourly 08-22 at a per-repo minute for launch /
  every 15 minutes for polish, America/New_York) pinned `scheduler: external` and lean; the
  Candybar manifest; `candybar register --name <repo>-pm-launch-pass`; `candybar resume`; and, for a
  pjangler project (a `.project.json`), crank on via `pj crank enable --interval <resolved interval>`
  so the repo's interactive agent sessions keep moving too (pj writes `.project.json`; commit it).
  An unreadable `pj` skips crank with a note rather than failing the enable. Idempotent:
  a wired repo reports `nothing to change`. An adopted job keeps a hand-tuned schedule; one still on
  the other mode's factory default is retuned to this mode's default (and renamed). It writes the
  wrappers, the job and the manifest, and commits nothing: commit the manifest to the repo.
- **disable** pauses the Candybar job and keeps the manifest and the Hermes job, so leaving a mode is
  reversible. Use it when `.launch.yaml` goes `develop` or `live`. It leaves crank alone: crank also
  serves develop repos (`pj crank disable` turns it off).

## Audit rule `hermes.launch-mode` (project scope)

`flume audit [repo] --rules hermes.launch-mode`

- `mode: launch` or `mode: polish` fails unless there is a live `pm` desk, the driver, both
  wrappers, a Hermes launch
  job that is enabled and `scheduler: external`, the manifest, and an **enabled** Candybar
  `<repo>-pm-launch-pass`, and, in a pjangler project, crank on (`pj crank status --json`
  `policy.enabled`). An unreadable Candybar or `pj` is a `warn` (unverified), not a pass.
- `mode: develop` (or the legacy `steady`), `mode: live` or no `.launch.yaml` fails if the
  `<repo>-pm-launch-pass` Candybar is enabled
  (`flume launch disable`).
- Any registry row for the repo with role `launch-director`, `paired-launch-director` or `em` fails,
  retired or not, naming `flume offboard <id> --apply`, or the em-to-pm conversion for a live `em`. A
  retired row is out of service but still in the org chart (status line, Telegram, roster), so it stays a
  finding until it is offboarded.
- Skips a repo with no declaration, no desk and no `.candybars/`.
- `flume remediate hermes.launch-mode [repo]` is fixable only when the sole problems are pass
  mismatches: it runs `enable` or `disable`. Retired roles and a missing driver are blocked with the
  per-employee command.

## Retired titles

`flume hire|onboard launch-director|paired-launch-director|em` refuse with a pointer to PM launch mode.
The composer refuses to render those roles too (`RetiredRoleError`), so a deployed desk's SOUL is never
overwritten with the notice; `hermes.pm-scaffold` reports such a desk as preserved. The role files stay
as notices (`roles/README.md`, "Retired roles").

## Offboarding a director desk

`flume offboard <id>` (preview), then `flume offboard <id> --apply`. One command does the whole exit:

1. **Out of service** (`flume retire` under the hood): bloodbank off, Plane board claim removed, channels parked.
2. **Identity**: if enrolled, retired with every adapter revoked (mailbox allowlist and routing rule, its own
   gateway token); the lifecycle tombstone outlives the row. A shared consumer is never revoked.
3. **Schedules**: every Candybar whose runner runs the profile is archived.
4. **Desk**: unserved live through the gateway control socket (other profiles untouched), then moved to
   `~/.hermes/profiles-retired/<profile>-<stamp>`. No gateway restart.
5. **Role dir**: `agents/hermes/<role>/` in the repo is copied to `~/.hermes/agents-retired/` and removed
   with a path-scoped commit that is pushed (`--keep-role-dir` skips this).
6. **Record**: the row is archived to `~/.hermes/agents-retired/<id>-<stamp>.yaml`, then removed from the
   registry. It no longer appears in `flume roster`, the status line or Telegram.

The report lists what it cannot do: a Telegram bot only its owner can delete (`@BotFather /deletebot`),
the Hindsight bank and native Plane user (kept for history). Any failed step stops before the row is
removed, so a re-run picks up where it stopped.

All four retired directors (`tolt-launch-director`, `tolt-director`, `gruvato-launch-director`,
`green-in-between-launch-director`) were offboarded on 2026-11-24. `tolt-director` is the exception that
came back the same day: it is the TOLT portfolio director (plain `director` title, `board_scope: advisory`),
not a launch-mode role, so it was never covered by the retirement. `flume rehire tolt-director --apply`
undid its offboard from the archives (see "Undo an offboard" in the agent-fleet-operations skill).

## em to pm conversion

Converts a deployed `em` desk (`tolt-pm`, `gruvato-pm`) into a plain PM, keeping `agent_id`, `profile`
and the registry key. The repo's `agents/hermes/pm/` directory name does not change.

```bash
cd <repo>
# 1. role identity: role.yaml and the repo declaration both say pm
sed -i 's/^role: "em"/role: "pm"/' agents/hermes/pm/role.yaml     # also refresh `purpose:` if it names the EM/Launch Director pair
python3 - <<'PY'                                                  # .project.json agents.<id>.role: "em" -> "pm"
import json; p=".project.json"; d=json.load(open(p))
for a in d["agents"].values():
    if a.get("role") == "em": a["role"] = "pm"
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
# 2. recompose the SOUL (and refresh the desk scripts) from roles/pm.md
flume remediate hermes.pm-scaffold <repo> --dry-run     # review the diff, then without --dry-run
# 3. project the registry row (role: pm); merges, keeps plane.scope_label and the rest
flume onboard pm --target-repo <repo> --yes             # run from <repo>
# 4. the old em pass stops; the launch pass (if the repo launches) takes over
candybar pause <repo>-em-pass                           # then flume launch enable <repo> once .launch.yaml says mode: launch
flume audit <repo> --rules hermes.launch-mode,hermes.pm-scaffold,hermes.registry-parity
```

Gotchas: step 1 needs **both** files, because `hermes.pm-scaffold` blocks with "identity does not match
role.yaml" when `.project.json` still says `em`; before step 1 the scaffold rule leaves the desk's SOUL
alone ("role em is retired; SOUL left as is"). `em-pass.py` / `em-pass.prompt.md` are not template
managed: delete them in the repo once the launch pass runs. Commit and push the repo (role.yaml,
`.project.json`, SOUL, scripts, manifest) straight to main. Verified by dry run against a scratch copy of
`~/code/tolt` (em: scaffold preserved, audit named it; pm: SOUL composed from `roles/pm.md`).
