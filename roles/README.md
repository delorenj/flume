# `roles/` — what a role IS, as a file you can branch

Repo-scoped Hermes agents load `<repo>/agents/hermes/<role>/runtime/SOUL.md`;
portable specialists load their profile's SOUL (see below).
Until now nothing owned that file's *role* half. It was an
`{% if role == "pm" %}` branch inside a copier template, stamped once at hire
and never re-read — so "where is the PM role codified?" had no answer, and three
separate renderers had each stamped a different generation onto the live fleet.

This directory is the answer. One file per role, composed into every SOUL.

```
roles/
  _base.md      the frame every SOUL shares (identity, scope, envelope contract,
                conventions, memory doctrine, pillars pointer)
  _tones.yaml   the personality paragraphs, and how to RECOGNISE one already
                deployed
  _default.md   what a role with no file of its own gets
  pm.md         the role charters themselves — branch these
  dev.md
  review.md
  reporter.md
  em.md, launch-director.md, paired-launch-director.md   RETIRED: notices only (see below)
```

## Branching a role is `cp`

```bash
cp roles/pm.md roles/staff-pm.md      # edit the charter, keep the frontmatter keys
flume hire staff-pm                    # a new agent carrying the new role
```

The composer resolves `roles/<role>.md` by the role name in `role.yaml`. A role
with no file falls back to `_default.md`, which says so out loud rather than
pretending to be configured.

## File format

YAML frontmatter, then a markdown body. The body becomes the SOUL's
`## Role-specific behavior` section; the frontmatter supplies blocks the body
drops in by name:

| placeholder | comes from | renders as |
| --- | --- | --- |
| `{{ prime_directives }}` | `prime_directives:` list | `- ` bullets |
| `{{ bloodbank_events }}` | `bloodbank_events:` list | `` - `type` `` bullets |
| `{{ default_execution }}` | `default_execution:` scalar | verbatim |
| `{{ repo }}` `{{ role }}` `{{ agent_id }}` `{{ display_name }}` `{{ profile }}` `{{ telegram }}` `{{ purpose }}` | the agent's `role.yaml` | verbatim |
| `{{ project_bank }}` | basename of the role dir's git toplevel (`33GOD`, `bloodbank`); falls back to `repo` | verbatim — the Hindsight project bank, which is case-sensitive |
| `{{ named_intro }}` `{{ identity_rows }}` `{{ identity_bank }}` `{{ identity_wiring }}` `{{ identity_keyed_to }}` `{{ recall_note }}` | role.yaml `identity:` (named agents) | `_base.md` only. For an unnamed post they reproduce the historical prose exactly (empty inserts, `agent-<agent_id>`, `bank_id_template` wording), so naming one agent drifts no other soul |

`purpose_template` supplies the agent's one-line purpose when hire was not given
one; `{repo}` and `{role}` interpolate. `behavior:` is structured data for
downstream consumers (it drives nothing in the SOUL text itself yet) — keep it
honest so a later reader can diff two roles without reading prose.

Substitution is `{{ name }}` and nothing else. No conditionals, no filters, no
loops: a role that needs a branch is a second role file, which is the whole
point. An undeclared placeholder is a hard error, never a half-rendered SOUL.

## A mode read from repo data is not a role branch

A second role file is for a different charter. A PM in launch or polish mode is the same
PM reading different data, so it is a section, not a file: `pm.md` puts one
`## Launch mode` and one `## Polish mode` section in every PM soul, and the repo's committed
`.launch.yaml` decides which applies (`mode: develop | launch | polish | live` — `steady` is a
legacy alias that reads as develop — declared
date, source, finish line, target date, contract paths, epic, optional cut-line
hint, optional `polish:` block; never status). No file, `develop` or `live` leaves both sections inert. Turning
a mode on or off is a commit to that repo, never a new role, a re-hire or a
re-compose. The template ships `.scripts/launch-pass.py` to every PM desk, and
Candybar fires it (`<repo>-pm-launch-pass`) only for a repo in launch or polish mode.

The modes are wired by `flume launch status|enable|disable [repo]` (also `flume mode ...`) and audited by
`flume audit --rules hermes.launch-mode` (the modes: `docs/project-modes.md`; the wiring: `docs/launch-mode.md`).

## Retired roles

A retired role keeps its file, with `retired: {since, superseded_by}` in the frontmatter and a short
notice for a body. Three titles are retired (2026-11-18), replaced by launch mode on a single PM:
`launch-director`, `paired-launch-director` and `em`. The `director` role is **not** retired.

- `flume hire <title>` and `flume onboard <title>` refuse a retired title, pointing at PM launch mode
  (`ValidateHermesOptions`, via `retiredRole()` in `workforce/role.ts`).
- `composeSoul()` throws `RetiredRoleError` for it, so a deployed desk's SOUL is never overwritten
  with the notice. `flume remediate hermes.pm-scaffold` reports such a desk as preserved and moves on.
- `hermes.launch-mode` names every registry row still carrying one of the three roles, retired or not:
  offboard it with `flume offboard <id> --apply`, or convert an `em` desk to `pm`
  (`docs/launch-mode.md`, "em to pm conversion"). Retiring a role is a one-line `retired:` block in its
  file; nothing else lists retired roles.

## The one composer

`composeSoul()` in `packages/flume-hr/src/parity/rules.ts` turns these files into
repo-scoped SOULs. Named agents holding a repo post use the same composer:

- **hire / onboard** — `RunCopierTemplate` composes and writes the SOUL after
  copier returns. `templates/hermes-agent/template/SOUL.md.jinja` no longer
  renders a soul; it renders an unmistakable placeholder that flume overwrites.
- **existing agents** — `flume remediate hermes.pm-scaffold <repo>` re-composes
  a deployed agent, and writes the **runtime** copy, which is the one Hermes
  actually loads. `--dry-run` first; it is not on by default.
- **drift** — `flume audit --rules hermes.pm-scaffold` compares SOUL *content*
  against what these files compose, so a two-generation-stale SOUL is a finding
  instead of a pass.

- **portable specialists** — these do not hold a repo post and do not use the
  composer. `specialistPolicyRequest()` in `workforce/scheduling.ts` appends
  the canonical bounded scheduling and handback sections to an adapter request;
  `templates/hermes-agent/scripts/hermes-specialist-profile.py` renders that
  request during public hire/onboard. The owning `agent.yaml`, authored charter,
  directives and tone stay intact. Generated section markers in an authored
  charter are refused. Repeat onboarding updates an owned projection and
  converges; handwritten profile changes remain protected by its ownership receipt.

`templates/hermes-agent/scripts/momo-unify-agent.py` was the third renderer. It
had no caller and it has been deleted; `~/code/33GOD/momo/spec/momo-agent.spec.yaml`
is the ancestor of the file format here.

## Shared clean-or-checkpoint handback

`_base.md` owns the single `flume:handback-policy` section. Repo posts receive it
in the composed frame; portable specialists receive the exact section through the
shared bounded-section extractor in `scripts/lib/`. There is no handback policy
copy in role charters, specialist definitions or PM execution templates. Every
supported non-retired role and the `_default.md` fallback receive it, for named
and unnamed posts and headless work.
Retired role composition still refuses rather than overwriting a desk.

This is an instruction contract, not a new cleanup command or scheduler. Owned
paths alone define cleanliness in a shared checkout. Unfinished or unverified
work needs a permitted durable checkpoint with changed paths, remaining work,
actual checks, blocker/owner and an executable next step. No-commit can use a
permitted durable note; local-only and no-publication restrictions outrank general
artifact-sharing instructions. Nothing grants authority over another agent's work.

Verify privately after `npm run typecheck` and `npm run build` with
`node tests/handback-policy-regressions.mjs`. It enumerates roles, exercises the
real Python adapter and public specialist hire/repeated onboard in disposable
fixtures, and checks the safety scenarios. Fixture evidence is not a live rollout:
use the existing owner-approved projection path for deployed desks, preview first;
never hand-edit a deployed SOUL. PM template writer/retention changes remain with
their own owners, and no new clock is required.

## Deployment declaration

Besides the charter, the frontmatter can declare how an employee in this role is
deployed. `flume hire` and `flume onboard` project each key; `flume audit`
(`hermes.role-declaration`, `hermes.runtime-singleton`) re-reads the same file and
fails by name when the desk, the registry or the org chart disagree with it. A role
with none of these keys is charter-only and provisions exactly as it always has.

| key | declares | projected into |
| --- | --- | --- |
| `skills` | one Skillex `set` or `pack` (see below) | the desk's Skillex selection, then `<desk>/skills/` |
| `chain` | ordered `automaticai/<account>/<model>` routes; the first is the primary `model:`, the rest are `fallback_providers` | the desk's `config.delta.yaml`, rendered into `config.yaml`; omitted means the desk inherits the fleet base at run time |
| `department` | a department id from `~/.hermes/org.yaml` | `agents.<id>.department` and the department's `members` |
| `reports_to` | an employee id in the registry, or `org.ceo.id` (the CEO is not a registry employee); omitted means the department's manager | `agents.<id>.reports_to` (subordinates are derived, never listed) |
| `board_scope` | `advisory` for a board reader/filer that must never claim tickets; omitted means the historical owner behavior | `role.yaml.board_scope: advisory`, registry `board_scope: advisory`; `plane.project_id` and `plane.board_id` are absent, while `ticket_provider.board_id` and read-only `plane.workspace`/`identifier` remain |

`identity`/`memory` share their definitions with the named-agent contract
(`contracts/named-agent.schema.json`), so a role and a named agent cannot disagree
about what a skills binding or a memory bank is.

### `skills`: a loadout is a Skillex selection

```yaml
skills:
  set: dev-tools           # a composable, reference-only set
# or
skills:
  pack: dev                # an exclusive complete loadout; NAME or NAME@VERSION
```

Skillex alone decides what a strict (Skillex-only) desk contains. A desk's
`skills/` is the union of the global selection and one explicit project selection,
projected as symlinks into `all-skills/` by `skillex profile sync NAME --project
PATH --skillex-only`. A role that declares `skills` owns that project selection:

- flume writes the declaration, through Skillex's own manifest writer, to
  `<desk>/.skillex-selection/.agents/skills.json` (`{"inherit_global": false,
  "sets": ["dev-tools"]}` or `"packs": ["dev"]`). The file is generated; edit the role
  file and run `flume onboard`, never the manifest.
- Skillex then projects it, and flume refuses to report done until a second `skillex
  profile show` plans nothing. The receipt records the selection as the desk's
  project, so `skillex profile show <profile>` needs no `--project`.
- The desk is therefore the global selection plus exactly the declared loadout. The
  owning repo's `.agents/skills.json` no longer feeds a desk whose role declares
  `skills`; do not `profile sync` such a desk against its repo (the audit reports it
  and `flume onboard` repairs it).
- A loadout that gains or loses a member in the catalog flows through the same
  selection; `skillex profile sync <profile> --project <desk>/.skillex-selection
  --skillex-only` applies it without re-onboarding.

What flume will not do, because a Skillex-only desk refuses it: write
`skills.external_dirs` (the projection pins it to `[]`, the same pin PM
provisioning writes), create `<desk>/.agents/skills`, or copy a skill payload. A
desk that is not Skillex-only and holds local skills is refused before anything is
changed; convert it with `~/code/skillex/scripts/hermes-skillex-cutover.py`
(preview, then `--apply`) first.

A pack is an exclusive complete loadout in Skillex: a manifest holds at most one
and it leaves every set dormant. So a role selects at most one pack and cannot
combine it with a set. `packs: [a, b]` and `pack: a` with `set: b` fail
`hermes.role-declaration` and `flume hire`/`onboard` by name; compose several
skills with a set instead. A set or pack that names a skill the catalog does not
own fails the same way instead of being dropped.

### `chain`: which surfaces honour a desk override

A desk's explicit override of the shared chain (a primary `model:` of its own, or its
own `fallback_providers`) survives hire/onboard and is reported as an override. It is
honoured only where it is read: a desk's own Telegram/Slack channel reads the desk's
fallback chain, while multiplexed Bloodbank turns refresh fallbacks from the shared
`fleet-bloodbank-gateway` profile's config on the one host gateway (`hermes-gateway.service`;
the separate `hermes-fleet-bloodbank-gateway.service` unit is retired 2026-10-11; the target
desk's primary `model:` is read per target). Do not claim a desk-level fallback chain for Bloodbank turns. The
fallback entries do not carry the provider's `extra_body` effort either, so record the
ledger's actual effort rather than the configured one.

| Runtime policy boundary | Source / verification |
| --- | --- |
| Recurring schedules, every role | `_base.md` bounded `flume:scheduling-policy` section: Candybar owns the single clock, runners only execute. Portable specialist projection receives the same section through `workforce/scheduling.ts`; no policy copy in a specialist definition or template. |
| Clean-or-checkpoint handback, every role | `_base.md` bounded `flume:handback-policy` section; repo composer and portable `specialistPolicyRequest()` share exact source bytes. `node tests/handback-policy-regressions.mjs` proves generated coverage, private projection and restrictions, not live compliance. |
| Instruction drift, current employees | `node scripts/audit-scheduling-policy.mjs` reads the registry and actual profile SOULs, exits nonzero for missing/stale coverage, and never changes employee state. This is not Candybar's runtime bypass-schedule linter. See `docs/scheduling-policy.md`. |

## Named agents

A role directory is a **post** (`agent_id` / `profile`). A post held by a
**named agent** carries an `identity:` block in `role.yaml` (`name`,
`write_bank: agent-<name>`, `recall_banks`). The composer then addresses the
agent by `display_name`, adds a `Name` row to the identity table, says the
agent id is only the post it holds, names the personal bank in the memory
table, and lists the history banks it should recall explicitly. The first one
is Grolf, holding the `33god-pm` post.

## Tone

`soul_tone` is now persisted in `role.yaml`. For agents hired before that, the
composer recovers the choice by recognising the tone paragraph already in the
deployed SOUL (`recognise:` in `_tones.yaml`) rather than normalising everyone
to `direct`.
