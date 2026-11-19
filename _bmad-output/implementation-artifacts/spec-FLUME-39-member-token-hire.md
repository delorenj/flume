---
title: 'FLUME-39 Hire-time member gateway credentials'
type: bugfix
created: '2026-11-18'
status: in-progress
route: dispatch
baseline_commit: 7df4c325950c62a48d85746776013d0d7e47ad55
context: []
---

<frozen-after-approval reason="delegated FLUME-39 implementation scope">
## Intent
Normal hire must give the resolved employee profile its deterministic scoped gateway consumer credential, with only the vault reference projected into the delta and generated config. Reuse gateway token and profile-config authorities. Completion must distinguish token, delta and render, and actual runtime attribution must be checked independently of configuration.

## Boundaries & Constraints
Always preserve unrelated content/comments and explicit conflicting references. Hold the canonical profile mutation lock before reading or writing the delta/config pair. Use the gateway-owned `owner-no-anthropic` preset and an explicit owner group, not a local route list. Resolve credentials only in memory with cache disabled. Preserve occupied hire refusal and convergent onboarding. Do not change route catalog, chains, accounts, shared base, channels, board state or activation. Retirement documentation identifies maintained revocation authority; no automatic revocation.

## I/O & Edge-Case Matrix
| Scenario | Input / state | Expected behavior | Error handling |
|---|---|---|---|
| New hire | New resolved profile | Mint/confirm, read back vault, add ref, render | No success before all three stages succeed |
| Repeat provisioning | Matching ref, converged config | Confirm existing token, no duplicate field/token, bytes stable | Existing different scope refuses |
| Conflicting reference | Explicit different mapping | Preserve delta/comments/settings, no mint | Unresolved failure |
| Vault unavailable | Mint or vault read-back fails | No delta/render mutation | Sanitized failed token stage |
| Render failure | Token verified, render cannot complete | Never claim completion | Separate failed render stage |
| Occupied hire | Existing role directory, noninteractive | Refuse before credential/config effects | Existing guard, no force |
| Lock/topology failure | Held lock or symlink | Bounded refusal, no credential/config effects | Sanitized lock failure |
</frozen-after-approval>

## Code Map
- `scripts/gateway-member-tokens.py`: deterministic shortening and comment-preserving insertion authority; replace stale models/retry/output paths.
- `packages/flume-hr/src/hire/HireRecipe.ts`: ingredient after profile creation and role projection; existing validation precedes effects.
- `packages/flume-hr/src/workforce/specialist.ts`: portable hire publication, registry-before-profile lock order; token step only for initial hire, not ordinary refresh.
- `templates/hermes-agent/scripts/hermes-profile-config.py`: expected_config/write_generated and canonical ProfileConfigLock. Import, never recursively lock the CLI renderer.
- Gateway `ops/gateway-tokens.py`: current `--preset owner-no-anthropic --group`, existing token exact scope confirmation and revocation; no gateway policy edits needed.
- `packages/flume-hr/src/parity/rules.ts`: current routing audit hides counts on failure; expose actual coverage even with pre-existing defects.

## Tasks & Acceptance
- [ ] Helper uses maintained token preset/group, strict delta preflight, canonical lock, bounded sanitized phases and repeat convergence.
- [ ] Hire integration invokes the authority only for resolved target, after refusal guard, and propagates failure.
- [ ] Specialist default uses real deterministic shared-item reference through its owning template; safely land/pin template change.
- [ ] Regression coverage exercises matrix, reference-only output and comment/settings preservation.
- [ ] Existing lifecycle/offboarding guidance names revocation authority.
- [ ] Sanitized acceptance includes normal hire, repeat step, occupied refusal, actual audit counts and installed Hermes request-to-ledger consumer proof, or precise blockers.

Acceptance: Given a new employee, when normal hire runs, then the three provisioning stages and generated reference are verified. Given a correctly wired desk, when provisioning repeats, then token/field counts and config bytes remain stable. Given conflicting/unreadable/locked state, when provisioning runs, then completion fails honestly without overwriting operator state. Given post-hire audit and runtime, when inspected, then the new consumer is attributable separately from pre-existing exceptions.

## Implementation Notes
- Scope was delegated for implementation and safe landing; no additional policy decision is being requested.
- Baseline live audit fails on two pre-existing base-policy mismatches (api-direct endpoint and auto aliases absent from audit's curated list), inherited by 48 desks. Do not remediate those under this ticket.

## Verification
`npm run typecheck`, `npm run build`, focused real-Copier and helper regressions; actual `flume audit --rules hermes.gateway-routing --json`; bounded installed Hermes runtime with request-ID/marker ledger join. Runtime evidence remains in profile scratch, never includes credentials.
