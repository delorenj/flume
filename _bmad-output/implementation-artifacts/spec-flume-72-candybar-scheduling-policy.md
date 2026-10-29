---
title: 'FLUME-72: Universal Candybar recurring-schedule policy'
type: 'chore'
created: '2026-10-29'
status: 'implemented-with-deployment-gaps'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The operator requires Candybar to own recurring schedules, but Flume's universal role frame has no scheduling mandate. A PM-only rule would leave contributor, reviewer, reporter and fallback roles unconstrained. Re-composing whole deployed scaffolds would also rewrite unrelated state.

**Approach:** Encode a bounded, identical scheduling-policy section in `roles/_base.md`, the existing `composeSoul()` source for every repository role. Require Candybar as the single clock, distinguish service/execution runners from schedules, prohibit bypass clocks, retain only the named AD-22 self-watchdog exception, and require explicit owner/rationale records for any infrastructure exemption. Add regression coverage for every declared role and an unknown fallback role. Add a read-only registry-wide policy drift check that compares actual profile SOUL policy bytes, fails on missing or changed coverage, and reports unsupported portable specialist paths honestly. Do not hand-edit deployed SOULs or apply broad scaffold remediation. The separate cross-CLI `~/.agents/AGENTS.md` belongs to the agents repository; report its owner boundary to the parent rather than mutate it. Candybar's parallel worker owns runtime schedule lint, not this change.

</frozen-after-approval>

## Implementation Notes

- Investigation: `composeSoul()` in `packages/flume-hr/src/parity/rules.ts` renders `_base.md` for pm/dev/review/reporter and `_default.md` roles; `hermes.pm-scaffold` remediation selects orchestrators and also writes wrappers, scripts, runtime metadata and registry. No policy-only live deployment command exists; this task will not invent or simulate one as deployed.
- Portable specialists use `workforce/specialist.ts` and the template's independent `hermes-specialist-profile.py` projection. The Flume adapter now adds the same canonical policy to its projection input without editing the owning definition or template; tests exercise both the real adapter and public hire/onboard path.
- Given any declared or unknown role, when the canonical composer renders, then exactly one byte-identical Candybar policy section is present. Given a missing, stale, duplicated or absent profile policy, when the read-only guard runs, then it exits nonzero and identifies the gap without writing employee state.
- Verification: focused source-bundled composer regressions, CLI audit fixtures, typecheck/build, related existing regressions, real registry audit, narrow full-remediation preview only. All scratch files remain under the session scratch root.
- CodeGraph status found mostly fake vectors; no semantic claim or index mutation was made. Fleet skill quarantined by scanner; inspected source as permitted, without changing trust policy.
