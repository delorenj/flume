# FLUME-72 independent findings and narrow repair

Independent review of candidate `c0b8f8fb04496b55e0eeacb3a0c153a5c61ad6ce` against `af3bf9d31ba20b6e513fd2254a4094312456cd5d` found AC5 incomplete. Full independent assertions and review: `/home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume72-independent-review-20261119/review.json` and `confirmed-findings.mjs` in that directory. The independent reviewer classified AC1–4 and AC6–7 PASS; AC5 FAIL. These are historical findings, not independent signoff on this repair.

- **R1, typed YAML employee keys disappear during conversion.** `agents: {1: missing, "1": current}` yielded audit exit 0, one passing employee; the missing employee was overwritten before validation. Boolean/string collisions behave likewise. The audit now rejects nonstring raw keys before `toJS`, and rejects any mapping whose raw row count differs from the converted object count. Both collision shapes are CLI regressions expecting exit 2; ordinary string IDs retain row coverage.
- **R2, audit role grammar drifted from the owning contracts.** `3d-artist` was rejected by the audit but accepted by `validateRoleDeclaration` and `validateNamedAgentSchema`; `dev_` and `dev--oops` were accepted by the audit but rejected by those validators. The audit now compiles the role pattern from `contracts/role.schema.json`, with positive numeric-leading and negative trailing/repeated separator CLI cases. No schema or role source changed.

Repair check results (candidate worktree, Node 26.5.0, active-profile scratch TMPDIR; no live apply):

| Command | Exit / result |
| --- | --- |
| `node tests/scheduling-policy-audit-regressions.mjs` | 0, 7 groups |
| `node tests/scheduling-policy-regressions.mjs` | 0, 13 groups |
| `node tests/policy-refresh-regressions.mjs` | 0, 6 groups |
| `npm run typecheck` | 0 |
| `npm run build` | 0 |
| `node scripts/audit-scheduling-policy.mjs --registry /home/delorenj/.hermes/agents-registry.yaml --fleet-home /home/delorenj/.hermes` | 1, incomplete as expected: 49 audited, 46 pass, 2 drift (`dumply`, `james-brennan-pm`), 1 unproven (`delonet-company-reporter`). JSON output retained at `/home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume72-repair-audit-20261119.json`. |
| `git diff --check` | 0 |

The original six-group independent audit regression result and initial observation belong to the original candidate. No runtime sessions, schedules, live profiles, registry, service state, global instructions, or Plane lifecycle were changed. Full test suite and runtime compliance were not asserted. The implementer evidence was subsequently re-reviewed independently at `3107b656b1be64c8694ecfaa918fa9cf9b4aad7d`: SPEC PASS, QUALITY PASS, zero findings. See [`final-independent-review.md`](./final-independent-review.md) for the bounded verdict and limits; integration is tracked separately.
