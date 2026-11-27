# Project modes: develop, launch, polish (and live)

A repo's PM mode is **repo data**: the owner declares it in the repo's committed
`.launch.yaml` (`mode:` key) and agents never edit that file. One PM, one
machinery; the mode only changes what the pass is for, how often it fires and
how much board it may write. This page is the operator's view; the pass wiring
itself (driver, wrappers, Hermes job, Candybar, the audit rule) is in
[launch-mode.md](launch-mode.md), and the PM's rulebook per mode is
[roles/pm.md](../roles/pm.md) (`## Launch mode`, `## Polish mode`).

| mode | meaning | pass |
|---|---|---|
| `develop` | **The default.** Building, no finish line declared. No file, `mode: develop`, or the legacy alias `mode: steady` all read as develop. | none (the monitor prints `launch-mode: develop`; every fire costs 0 tokens) |
| `launch` | Racing a finish line: the declaration's `finish_line`, `contract`, `epic`. | hourly, 08:00-22:00 ET at a per-repo minute |
| `polish` | Around-the-clock exploratory QA: anything, however small, that improves the user experience gets a ticket. Hectic, busy mode. | every 15 minutes by default |
| `live` | In production: people can buy it and use it. A lifecycle stage, not a working mode. | none |

Every reader normalises: lowercase, `steady` reads as `develop`, an unknown or
broken mode reads as develop and is reported by the audit.

## Enabling a mode

The owner commits the declaration; flume wires the machinery. Never edit
`.launch.yaml` from an agent.

```yaml
# .launch.yaml — polish example (launch keeps its existing shape: finish_line, contract, epic)
mode: polish
declared: 2026-11-27
source: "<owner decision>"
epic: BOARD-n              # optional: polish tickets join it
polish:
  focus: [ux, physics]     # optional hint areas, never a limit: anything is ticketable
  qa: ["mise run qa:explore"]   # optional repo commands a QA cycle may run
  wip: 4                   # Krebs WIP slots ("lanes") while polishing; default 4
  cadence: "*/15 * * * *"  # Candybar schedule of the pass; default every 15 minutes
  todo_depth: 8            # Todo is topped up to this many polish tickets; default 2 x wip
```

```bash
flume launch enable [repo] --dry-run   # preview the plan first
flume launch enable [repo]             # wire it: wrappers, external Hermes job, manifest, Candybar on
flume launch status [repo]             # declaration, wiring, Candybar state, polish metrics
```

`flume mode status|enable|disable [repo]` is the same machinery under a
mode-first name. `enable` is idempotent and adopts what exists. Schedule
precedence: `--schedule` > the declaration's `polish.cadence` > the mode
default. A job still on the *other* mode's factory default was never
hand-tuned, so switching modes retunes it (launch hourly <-> polish every
15m) and renames it; a hand-tuned schedule survives the switch. The polish job
runs `max_iterations 30` (launch: 10) and is named `<label> polish pass (every
15m)`.

## Leaving a mode

The owner commits `mode: develop` (or `mode: live`), then:

```bash
flume launch disable [repo]            # pauses the Candybar pass; manifest and Hermes job stay
```

`flume remediate hermes.launch-mode [repo]` does the right side of either
transition automatically: enable for launch/polish, disable for develop/live.
The audit rule `hermes.launch-mode` fails a repo whose pass and declaration
disagree (a paused pass in polish, an enabled pass in develop).

## Polish mode specifics

- **One pass is one QA cycle.** The pass explores (running the declaration's
  `polish.qa` commands when present) and files every improvement it finds.
- **Tickets:** title prefix `[area:kind] ...`, free-form lowercase words inside
  the title — `[ux:improvement] The location of the X element sometimes blocks
  Y`, `[physics:tweak] It is possible to apply an unrealistically high force to
  the cue ball sending the balls at much too high a speed`. Never colon labels
  (board-taxonomy keeps those a closed axis); the driver adds the bare `polish`
  label to every create.
- **Board shape:** creates land in Backlog (at most 8 a pass); each pass tops
  Todo up to `todo_depth` with the highest-value polish tickets. Verdicts on
  reviewed tickets are the PM's, exactly as in launch.
- **Lanes:** Krebs runs `polish.wip` WIP slots while polishing (default 4;
  develop and launch default to 2). The Krebs side reads the same declaration.
- **Metrics:** the pass driver keeps the ledger at
  `<repo>/agents/hermes/pm/runtime/polish-metrics.json` —
  `{"declared", "cycles", "proposed": [{ref, title, at}], "implemented": [ref], "updated_at"}`.
  proposed = improvements proposed, implemented = proposed refs now completed,
  cycles = total QA cycles (each applied pass is one cycle, even with zero
  writes). `flume launch status` shows the counts ("no cycles yet" before the
  first one); the starship/claude status line reads the same file. A missing or
  broken ledger is no metrics, never an error.
- **Crank:** polish turns crank on for the repo exactly like launch, so
  interactive sessions keep moving between passes.

## One clock, one writer

Nothing here schedules anything: the Hermes job is pinned `scheduler=external`
and Candybar (`<repo>-pm-launch-pass`) is its only clock. The driver's
`--apply` is the pass's only board writer. The names never change with the
mode — driver, wrappers, job and Candybar entry are the same machinery driving
whichever mode is active.
