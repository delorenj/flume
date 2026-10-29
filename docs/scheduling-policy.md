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
repository (`git@github.com:delorenj/agents`): `~/.agents/AGENTS.md`. The operator
explicitly authorized its narrow Candybar addition for this rollout; it is now
published in agents commit `04327e9`. Unrelated existing edits were preserved.
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

## Supported policy-only refresh

```sh
flume refresh-scheduling-policy --json           # preview, no instruction writes
flume refresh-scheduling-policy --apply --json   # safe owned employees only
# Explicit isolated installations:
flume refresh-scheduling-policy --registry <registry.yaml> --fleet-home <root> --json
```

The built CLI is `node packages/flume-hr/dist/index.js`. Exit 0 means complete
owned coverage, 1 means refusals/missing coverage (safe employees can still be
applied), and 2 means invalid input or a command-level failure. Receipts identify
owner source, tracked/runtime/profile paths and links, policy hash, changed
paths and before/expected/readback hashes. The read-only audit remains separate.

Repository employees require registry/role identity agreement and exactly one
explicit Flume composer marker on **every** target. The writer changes only the
bounded policy or inserts it at the legacy composer's unique role-behavior seam.
All other bytes, file modes and declared profile links survive. Handwritten
SOULs, placeholders, duplicate ownership, partial/duplicate markers, hard links,
lossy UTF-8, missing files and symlink ancestors/escaping profile links refuse.
A refusal on one surface refuses that whole employee. No scripts, wrappers,
config, registry, role, auth, skills or systemd state are refreshed.

The existing specialist preparation/ownership API supplies the canonical policy
request. `scripts/specialist-policy-refresh.py` reuses the owning template
adapter's path checks, profile lock, atomic writer and receipt fingerprint. It
changes only SOUL policy and the SOUL hash in `specialist-projection.json`, never
the definition or a whole profile projection. Missing owning definitions and
foreign SOUL bytes refuse. Registry-before-profile locking serializes apply
with onboarding. Caught file publication failures roll back; abrupt termination
between multiple file renames requires owner inspection before retry (there is
no claim of a crash-atomic multi-file transaction).

## Verified coverage and rollout boundary

The original read-only audit and broad scaffold preview are historical evidence:
`registry-policy-audit.json` and `scaffold-preview.json` under
`_bmad-output/implementation-artifacts/FLUME-72/`. The broad 19-file remediation
was **not** applied. Policy-only rollout receipts live in that same directory.

Current rollout results are recorded in `policy-refresh-verification.md`.
Missing `delonet-company-reporter` remains with **FLUME-67**; this command does
not provision a mystery employee. Refused authored SOULs require their role
owner to reconcile the authored instruction source without deleting persona
content. Seven portable definitions were already deleted in the agents working
tree: their owner must restore/relocate the declared definition and ownership
before this refresh can safely project them. Do not restore those unrelated
deletions just to make an audit green.

On-disk policy is not evidence that any already-running session reloaded it.
Next-turn/startup instruction loading is runtime-owned. No gateway restart,
new clock or schedule migration is part of instruction propagation.

Tests exercise all declared roles plus fallback named/unnamed composition,
public portable hire/onboard and narrow refresh, receipt continuity, unchanged
personas/config, readback and idempotence, malformed/duplicate ownership and
unsafe paths. Run focused suites with the session scratch `TMPDIR` and a Python
interpreter with PyYAML (`PATH=/usr/bin:$PATH` on this host).

Candybar's runtime policy lint is callable from its checkout:
`uv run candybar doctor --repo . --live --json`. Its machine findings are separate
from instruction coverage; report them, never auto-disable unfamiliar timers.
