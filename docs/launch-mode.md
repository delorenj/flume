# Launch mode on a single PM

Launch mode is how a repo drives a launch: one PM, one board, one committed declaration. It replaced
launch directors (`launch-director`, `paired-launch-director`), the paired engineering manager (`em`)
and the portfolio director desk that ran a launch (2026-11-18). The `director` **role** stays for
repos that use it.

| piece | where | owner |
| --- | --- | --- |
| charter | `roles/pm.md`, `## Launch mode` (inert without the declaration) | flume |
| declaration | `<repo>/.launch.yaml` (`mode: launch \| steady`, `finish_line`, `contract`, `epic`, optional `cut_line`, optional `scopes: [child dirs]` for a monorepo parent) | **Jarad only**; the PM proposes `mode: steady` in a ticket |
| driver | `<desk>/.scripts/launch-pass.py` (`--monitor`, `--brief`, `--apply plan.json`) | hermes-agent template |
| wrappers | `~/.hermes/profiles/<profile>/scripts/launch-{monitor,brief}.sh` (real files exec'ing the driver) | `flume launch enable` |
| Hermes job | profile cron job, `scheduler: external`, lean (terminal,file,no_mcp; no skills; 10 iterations) | `flume launch enable` |
| clock | `<repo>/.candybars/<repo>-pm-launch-pass.candybar.toml`, registered and enabled | `flume launch enable` |

Candybar is the only clock. The job never schedules itself; `hermes cron run` is the only trigger.

## Commands

```bash
flume launch status  [repo] [--json]
flume launch enable  [repo] [--dry-run] [--schedule "<cron>"] [--timezone <iana>] [--json]
flume launch disable [repo] [--dry-run] [--json]
```

`[repo]` defaults to the current directory. `flume launch <employee>` (the older portable-specialist
launcher) is unchanged and is the default when the first word is not `status|enable|disable`.

- **status** reads, never writes: declaration, the repo's PM desk, driver and wrapper presence, the
  Hermes launch job, the Candybar manifest and its registration state, last Candybar run, and any
  retired-role desk still live. Exit 1 when it lists problems.
- **enable** requires `.launch.yaml` `mode: launch`, exactly one live `pm` desk in the registry for
  the repo (an unconverted `em` desk is named, see below) and `.scripts/launch-pass.py` on that desk
  (else: `flume remediate hermes.pm-scaffold <repo> --scripts-only`). It then makes true, in order:
  the two wrappers; one Hermes launch job (adopts the profile's job whose script is
  `launch-brief.sh` and monitor is `launch-monitor.sh`, else creates one at `--schedule`, default
  hourly 08-22 at a per-repo minute, America/New_York) pinned `scheduler: external` and lean; the
  Candybar manifest; `candybar register --name <repo>-pm-launch-pass`; `candybar resume`; and, for a
  pjangler project (a `.project.json`), crank on via `pj crank enable --interval <resolved interval>`
  so the repo's interactive agent sessions keep moving too (pj writes `.project.json`; commit it).
  An unreadable `pj` skips crank with a note rather than failing the enable. Idempotent:
  a wired repo reports `nothing to change`. An adopted job keeps its own schedule unless `--schedule`
  is given. It writes the wrappers, the job and the manifest, and commits nothing: commit the
  manifest to the repo.
- **disable** pauses the Candybar job and keeps the manifest and the Hermes job, so going steady is
  reversible. Use it when `.launch.yaml` goes `steady`. It leaves crank alone: crank also serves
  steady repos (`pj crank disable` turns it off).

## Audit rule `hermes.launch-mode` (project scope)

`flume audit [repo] --rules hermes.launch-mode`

- `mode: launch` fails unless there is a live `pm` desk, the driver, both wrappers, a Hermes launch
  job that is enabled and `scheduler: external`, the manifest, and an **enabled** Candybar
  `<repo>-pm-launch-pass`, and, in a pjangler project, crank on (`pj crank status --json`
  `policy.enabled`). An unreadable Candybar or `pj` is a `warn` (unverified), not a pass.
- `mode: steady` or no `.launch.yaml` fails if the `<repo>-pm-launch-pass` Candybar is enabled
  (`flume launch disable`).
- Any non-retired registry row (`bloodbank.enabled` not false) for the repo with role
  `launch-director`, `paired-launch-director` or `em` fails, naming `flume retire <id> --apply` for a
  director or the em-to-pm conversion for an `em`.
- Skips a repo with no declaration, no desk and no `.candybars/`.
- `flume remediate hermes.launch-mode [repo]` is fixable only when the sole problems are pass
  mismatches: it runs `enable` or `disable`. Retired roles and a missing driver are blocked with the
  per-employee command.

## Retired titles

`flume hire|onboard launch-director|paired-launch-director|em` refuse with a pointer to PM launch mode.
The composer refuses to render those roles too (`RetiredRoleError`), so a deployed desk's SOUL is never
overwritten with the notice; `hermes.pm-scaffold` reports such a desk as preserved. The role files stay
as notices (`roles/README.md`, "Retired roles").

## Retiring a director desk

For each of `tolt-launch-director`, `tolt-director`, `gruvato-launch-director`,
`green-in-between-launch-director` (never other directors):

1. `flume retire <id>` (preview), then `flume retire <id> --apply`: bloodbank off, board claim removed,
   channels parked, row kept. Nothing is deleted: desks, Telegram vault items and Hindsight banks stay.
2. Pause the director's Candybar jobs (`candybar pause <name>`; `tolt-launch-director-pass`,
   `tolt-director-pass`, `gruvato-launch-director-pass`, `green-in-between-launch-groom`,
   `green-in-between-launch-weekly`) and set their manifests `enabled = false`; their Hermes jobs stay
   pinned external. `hermes.retired-routing` and `hermes.launch-mode` then pass for the row.
3. Move any receipts, gate docs and policy the director kept into the PM's contract
   (`.launch.yaml` `contract:`); the PM reads them directly.

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
