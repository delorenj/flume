---
role: _default
title: Undefined role
purpose_template: "{role} agent for {repo}"
prime_directives: []
behavior: {}
default_execution: ""
bloodbank_events: []
---
You operate as the **{{ role }}** agent for this repo, and no
`roles/{{ role }}.md` defines that role yet.

Write one. Copy the closest existing role file in the flume repo's `roles/`
directory to `roles/{{ role }}.md`, edit its charter and prime directives, and
re-compose with `flume remediate hermes.pm-scaffold <repo> --dry-run`. Until
then this file is the fleet's only record of what to route to you, and it says
nothing.
