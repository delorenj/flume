# Candybar recurring-schedule policy (FLUME-72)

## Authority and propagation

The authored instruction source is the bounded `flume:scheduling-policy`
section in [`roles/_base.md`](../roles/_base.md). It applies to **every role**,
not just PMs:

- Repository employees: `composeSoul()` renders the shared frame for every
  declared role and the `_default.md` fallback. Hire/onboard uses that composer.
- Portable specialists: `specialistSchedulingRequest()` adds the same section
  to the adapter's projection input. The owning `agent.yaml`, role, identity,
  directives and tone remain unchanged; the existing template renderer retains
  its ownership receipts and conflict handling. No template fork or copied
  policy text is introduced. Existing specialist audit/launch detects expected
  projection drift through that same adapter.
- Already-running sessions are not retroactively proven to have loaded a changed
  instruction. No gateway restart, service control, authentication or registry
  mutation is part of this change.

The universal cross-CLI instruction file is separately owned by the **agents**
repository (`git@github.com:delorenj/agents`): `~/.agents/AGENTS.md`. It currently
has no Candybar rule. This worker owns Flume only and did not modify that file.
The parent must route that narrow global instruction addition to its owner;
Flume's universal role frame alone is not proof of global cross-CLI deployment.
CommonProject repository instructions are another surface, not an authority for
Flume employee personas.

## What the rule says

Candybar owns **when** recurring work runs. Hermes, systemd services and other
workers may **execute** it. No new ad hoc systemd timer, cron job, Hermes
recurring job, n8n Schedule Trigger or embedded recurring sleep/poll loop may
become a second clock. A new systemd timer is **not a Candybar**.

Installation/migration needs a committed Candybar manifest, API readback,
terminal invocation plus intended-effect proof and evidence that competing
native clocks are disabled. Registration or dispatch is not execution proof.
Candybar's current component docs own registration and runtime policy lint;
this document does not invent a CLI or claim the parallel linter is deployed.

### Exceptions

1. **Existing `candybar-watchdog.timer`, AD-22 only.** The page-only external
   self-watchdog must observe scheduler failure from outside Candybar; see
   `candybar/deploy/watchdog/README.md`. It must not be registered as a Candybar
   or disabled just to clear bypass lint. This is not an exemption for
   crank-watchdog or other agent schedules.
2. **No blanket OS/vendor/infrastructure exemption.** Any further exception
   requires an owner-approved record naming the exact schedule, owner, scope
   and explicit rationale in the owning component. Missing records are
   findings, not approval. Report unfamiliar infrastructure timers for
   classification; never disable them automatically.

## Working instruction-drift guard

From the Flume checkout:

```sh
node scripts/audit-scheduling-policy.mjs
node scripts/audit-scheduling-policy.mjs --registry <registry.yaml> --fleet-home <fleet-root>
```

The guard reads the org chart and each actual
`profiles/<profile_name>/SOUL.md` (including a valid runtime link), compares the
bounded policy bytes to the authored frame, and emits JSON. It has no apply mode
and performs no writes. Exit 0 means every registered employee has current
instruction bytes; 1 means drift/unproven coverage; 2 means invalid input or
command failure. Missing profiles, absent/duplicate/reversed policy markers,
stale bytes, malformed rows, duplicate YAML keys and empty registries cannot
produce a clean claim. This **does not scan running schedules** and cannot
replace Candybar's runtime bypass-schedule linter.

## Verified coverage and rollout boundary

Read-only audit receipt:
[`registry-policy-audit.json`](../_bmad-output/implementation-artifacts/FLUME-72/registry-policy-audit.json)

- 38 registered employees across 11 roles, including 7 portable specialists.
- 0 current, 37 drifted instruction files, 1 unproven missing SOUL:
  `delonet-company-reporter` (already tracked by FLUME-67).
- No deployed SOUL, config, registry, unit or schedule was modified here.

[`scaffold-preview.json`](../_bmad-output/implementation-artifacts/FLUME-72/scaffold-preview.json)
records the actual dry run for Flume's own PM. The full remediation proposes
19 files (two SOULs plus 17 unrelated scaffold files) and preserves five
locally-modified scripts. It is **not a policy-only update** and was not
applied. There is no supported policy-section-only live writer yet; do not
route around that by hand-editing deployed SOULs. A future narrow backfill must
preserve persona/role-local bytes, refuse missing or conflicting ownership,
read back actual profile policy and prove a no-op second pass. Existing
portable specialists can use their owning Flume onboarding preview/apply,
which also checks their full managed projection; inspect that preview first.

Tests exercise all four declared role files plus director, specialist and
unknown fallback composition in named/unnamed variants, real specialist adapter
projection, and the built public hire/onboard path on a disposable fixture.
The guard tests current/stale/absent/duplicate policy, missing/unsafe profile,
portable specialist, valid runtime symlink, malformed/empty registry, duplicate
keys, CLI exits, and byte/mtime preservation. The suite is part of `npm test`.
Run the focused suite with the session scratch `TMPDIR` and a Python interpreter
that has PyYAML; this host's `/usr/bin/python3` satisfies that requirement.
