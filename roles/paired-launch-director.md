---
role: paired-launch-director
title: Paired Launch Director (retired)
purpose_template: "Retired role: product and launch path director paired with an EM"
retired:
  since: "2026-11-18"
  superseded_by: "pm (roles/pm.md, Launch mode)"
---
**Retired 2026-11-18. Do not hire, onboard or compose this role.**

The Launch Director that was paired with an engineering manager (a `path:launch` / `path:app` split of one board) is gone as a post, and so is the split.

Launch mode on a single PM replaced it (`roles/pm.md`, `## Launch mode`): the repo's
committed `.launch.yaml` declares the launch, `flume launch enable <repo>` wires the PM's
launch pass, and the PM holds the cut line, records review verdicts, keeps gate receipts
current, applies the copy gate and records go. `flume hire paired-launch-director` and `flume onboard paired-launch-director`
refuse this title, and the composer refuses to render it, so a desk is never overwritten with
this notice. A desk already deployed with this role keeps its SOUL until it is retired (`flume retire <id> --apply`).
Why the file stays: history, and a deployed desk must still be recognisable by its role.
