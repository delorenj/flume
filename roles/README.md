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
