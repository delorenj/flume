---
title: 'FLUME-72: Current propagation proof and fail-closed audit'
type: 'bugfix'
created: '2026-11-19'
status: 'in-review'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="delegated FLUME-72 implementation; live changes excluded">

## Intent

Diagnose the existing universal Candybar instruction implementation against the seven live FLUME-72 acceptance criteria. Reuse the shared role frame and specialist adapter; fix only demonstrated gaps in the read-only propagation guard, preserve personas and unrelated work, and refresh attributable current coverage evidence. Do not deploy instructions, migrate schedules, mutate services/configuration/registry/global agents instructions, or claim session reload/runtime compliance. Push an isolated candidate and return to the parent for independent review before integration.

</frozen-after-approval>

## Implementation Notes

- Existing canonical role frame, composer, specialist adapter and policy-only refresh already cover the scheduling contract. Preserve these rather than duplicate policy or broaden live mutation.
- The audit accepts malformed registry rows with a valid profile_name as current, and an empty canonical marker pair as policy. Harden input validation without changing the authored rule; remove the unused exported-function policy override so callers cannot bypass the authored source. Bound filesystem observations so unreadable/nonregular/invalid UTF-8 input cannot hang or false-clean; valid runtime SOUL links remain supported.
- Add focused CLI fixtures for malformed rows, missing/unreadable canonical source, unsafe filesystem input and read-only byte/mtime invariance. Refresh documentation and the missing policy-refresh-verification.md with current read-only deployed coverage and owners. Keep old rollout receipts explicitly historical.
- Decisions: retain the shared policy seam instead of role-specific copies (canonical momo/PILLARS.md #2 Dogfood the Platform, #3 Build LEGO, Not Statues). No intent gaps or irreversible live changes. Independent adversarial review is coordinated by the parent after this candidate push.
