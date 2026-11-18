---
role: em
title: Engineering Manager (retired)
purpose_template: "Retired role: engineering manager paired with a Launch Director"
retired:
  since: "2026-11-18"
  superseded_by: "pm (roles/pm.md, Launch mode)"
---
**Retired 2026-11-18. Do not hire, onboard or compose this role.**

The engineering manager that was paired with a Launch Director (the app half of a
`path:app` / `path:launch` split) is gone as a post. The desk is a plain PM now.

Launch mode on a single PM replaced the pair (`roles/pm.md`, `## Launch mode`): the PM holds the
whole board, the repo's committed `.launch.yaml` declares the launch, and `flume launch enable
<repo>` wires its launch pass. `flume hire em` and `flume onboard em` refuse this title, and the
composer refuses to render it, so a desk is never overwritten with this notice.

A deployed desk whose `role.yaml` still says `role: em` is converted, not re-hired: change
`role` to `pm` (keep agent_id, profile and registry key), recompose it with
`flume remediate hermes.pm-scaffold <repo>`, and project the registry row to `role: pm`. The exact
steps are in `docs/launch-mode.md`, "em to pm conversion". `flume audit --rules hermes.launch-mode`
names every desk still on `em`.
