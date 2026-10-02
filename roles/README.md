# `roles/` — what a role IS, as a file you can branch

Every Hermes agent loads one file: `<repo>/agents/hermes/<role>/runtime/SOUL.md`.
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

## The one composer

`composeSoul()` in `packages/flume-hr/src/parity/rules.ts` is the only thing that
turns these files into a SOUL, and every path goes through it:

- **hire / onboard** — `RunCopierTemplate` composes and writes the SOUL after
  copier returns. `templates/hermes-agent/template/SOUL.md.jinja` no longer
  renders a soul; it renders an unmistakable placeholder that flume overwrites.
- **existing agents** — `flume remediate hermes.pm-scaffold <repo>` re-composes
  a deployed agent, and writes the **runtime** copy, which is the one Hermes
  actually loads. `--dry-run` first; it is not on by default.
- **drift** — `flume audit --rules hermes.pm-scaffold` compares SOUL *content*
  against what these files compose, so a two-generation-stale SOUL is a finding
  instead of a pass.

`templates/hermes-agent/scripts/momo-unify-agent.py` was the third renderer. It
had no caller and it has been deleted; `~/code/33GOD/momo/spec/momo-agent.spec.yaml`
is the ancestor of the file format here.

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
| `reports_to` | an employee id in the registry; omitted means the department's manager | `agents.<id>.reports_to` (subordinates are derived, never listed) |

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
honoured only where it is read: a desk's own Telegram/Slack gateway reads the desk's
fallback chain, while multiplexed Bloodbank turns refresh fallbacks from the shared
`fleet-bloodbank-gateway` process's own config (the target desk's primary `model:` is
read per target). Do not claim a desk-level fallback chain for Bloodbank turns. The
fallback entries do not carry the provider's `extra_body` effort either, so record the
ledger's actual effort rather than the configured one.

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
