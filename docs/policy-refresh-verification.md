# FLUME-72 policy refresh verification

This is the publication and coverage result for the policy-only refresh described
in [scheduling-policy.md](scheduling-policy.md). The earlier apply receipts in
`_bmad-output/implementation-artifacts/FLUME-72/` and independent comparison
were kept outside tracked source because they include local runtime paths. This
record intentionally contains only counts and ownership decisions.

## Verified instruction coverage

- The owner CLI changed 27 registered employees, each with a tracked SOUL and a
  runtime SOUL. Independent readback matched all **54** files to their apply
  receipts. Removing just the bounded scheduling-policy section reconstructed
  the captured before-hash of **all 54**, preserving non-policy content,
  including personas. **2,100** separately watched non-policy files matched
  their captured hashes at independent verification.
- A subsequent read-only preview found **27 current**, **0 would-change**,
  **10 refused**, **1 missing**. The independent audit found **27 pass**,
  **10 drift**, **1 unproven**. Both remain nonzero-exit partial-coverage results,
  not an overall clean bill. The existing Flume PM projection and owning source
  were published independently; this verification page makes no claim about
  running-session reload.
- The shared cross-CLI rule is authored in the agents repository's `AGENTS.md`.
  Native Claude `~/.claude/CLAUDE.md` and Codex `~/.codex/AGENTS.md` carry a
  bounded projection of only its Candybar section. Codex's offline native prompt
  renderer includes the exact AD-22 exception. Claude's native file was read
  and projected, but a fresh model-backed smoke test could not prove model use:
  its configured model route returned HTTP 404. That provider problem was not
  changed. No runtime-clock cutover or service restart is claimed here.

## Owner queue (not changes made by this rollout)

| Owner boundary | Registered agents | Next owner action |
| --- | --- | --- |
| Profile/source identity | `dumply` | Reconcile the missing profile role source before refresh. |
| Authored SOUL ownership | `james-brennan-pm`, `monitoring-pm` | Reconcile the handwritten/conflicting composer ownership while preserving persona text. |
| Portable definition ownership | `infra-specialist`, `n8n-specialist`, `rererere`, `marge-simpson`, `peter-griffin`, `context-director`, `bennett` | Definition owners restore or relocate their *own* declared definitions and receipts before projection; this rollout did not resurrect deletions. |
| Missing employee | `delonet-company-reporter` | **FLUME-67** owns provisioning; refresh cannot create a profile. |

Do not force the ten refused SOULs through a generic scaffold remediation. No
exception above excuses another scheduling clock. The AD-22 page-only external
Candybar self-watchdog is the sole specific exception described in the authored
rule; machine policy lint findings and active schedules need separate treatment.
