# FLUME-72 current instruction coverage and candidate verification

Observed 2026-11-19 UTC against Flume base
`af3bf9d31ba20b6e513fd2254a4094312456cd5d`, pinned template
`19ded0acc35c8e14ddcb94dd4ebde2b4421b5384`.
This supersedes the status claims in `verification.md`, not its historical
receipts. This phase produced no instruction deployment or schedule cutover.
Independent adversarial review of candidate `c0b8f8fb04496b55e0eeacb3a0c153a5c61ad6ce` found two AC5 gaps (R1/R2); narrow corrections and focused regressions are in reviewed candidate `3107b656b1be64c8694ecfaa918fa9cf9b4aad7d`. Independent re-review returned SPEC PASS, QUALITY PASS, zero findings; see [`final-independent-review.md`](./final-independent-review.md). Integration and live deployment remain separate from this on-disk evidence.

## Current coverage, not universal deployment

The real read-only CLI exited **1**, correctly incomplete:
[`instruction-audit-2026-11-19.json`](./instruction-audit-2026-11-19.json).
49 registered employees / 16 declared registry roles: **46 current, 2 drift,
1 unproven**. All ten portable specialists have canonical on-disk policy.
Policy SHA-256:
`d86f8b56dabb62ce062df6a5217374d2c63c3c45522a41223f96d2a81626246c`.
The paired [observation](./instruction-observation-2026-11-19.json) records the
command, time, registry hash and unchanged bytes/modes/mtimes/links across 101
paths: registry, canonical frame, global instructions, all registered SOULs and
profile configs. This bounds the observation; it is not a host-wide write trace.

| Gap | Attributable owner / next action |
| --- | --- |
| `dumply` (`tutor`, TikTokTrivia): no bounded policy | Jarad / TikTokTrivia's authored-persona owner; add policy through that authored instruction source while preserving teaching persona. Registered role_dir is the profile and has no role.yaml: do not force composer ownership. |
| `james-brennan-pm`: no bounded policy | Jarad / james-brennan authored SOUL maintainer, `agents/hermes/pm`; preserve voice and draft-for-human-approval/refusal rules. Do not use broad scaffold replacement to clear drift. |
| `delonet-company-reporter`: missing SOUL/profile | **FLUME-67** / reporter provisioning owner. Restore/provision through that owner; FLUME-72 does not create a profile. |
| Already-running sessions | Hermes instruction-loading owner; not assessed. No restart/reload performed. |
| Competing live clocks / actual terminal effects | Candybar runtime doctor/cutover owner; separate work. No schedule lint/migration or runtime compliance claim here. |

The old 0/37/1 and 27/10/1 snapshots, seven missing portable definitions and
broad scaffold preview are historical. Current policy bytes do not prove
current definition ownership, complete role config (FLUME-32), skill repair
(FLUME-71), or runtime loadability (FLUME-36). Those were not repaired here.

## What changed versus what was already landed

The universal contract, `composeSoul()` and `specialistSchedulingRequest()`
already implement ACs 1–4. Keep the one authored `roles/_base.md` section and
the existing owning specialist adapter rather than add per-role copies.
The genuine audit gap was a malformed registry row with a valid profile_name
being certified current. Missing/invalid role or employment and duplicate
profile identities now remain unproven. Independent review additionally found
that YAML numeric/string (and boolean/string) employee keys could collide when
converted to a JavaScript object and silently drop a missing employee, and
that the audit's role regex diverged from `contracts/role.schema.json`. Raw
employee keys now must be string scalars before conversion, with row-count
preservation checked; the role check reads its pattern from that schema. The
public validators and audit agree on `3d-artist`, `dev_`, and `dev--oops`.
Canonical policy cannot be replaced by an optional caller argument; empty
marker-only source fails. Missing, unreadable, nonregular, oversized and
invalid UTF-8 inputs fail closed through bounded, nonblocking descriptor reads.
Runtime SOUL links remain valid.

Tests now exercise the real CLI over those cases, descriptor growth/short reads/
rename/FIFO races, and preserve fixture bytes/mtimes. The public portable
hire/onboard scheduling test now provides private gateway/vault doubles rather
than falling into a missing real authority dependency. This proves the
instruction projection path only, not production credential issuance.

Choice: reuse Flume and Candybar's existing seams, not another clock or broad
live scaffold rewrite. Basis: canonical `momo/PILLARS.md` #2 Dogfood the Platform
and #3 Build LEGO, Not Statues.

## Acceptance mapping

| AC | Evidence / boundary |
| --- | --- |
| 1 — all-role canonical composition and portable adapter | `scheduling-policy-regressions`: all five nonretired declared roles plus two distinct fallbacks, each named/unnamed; byte-identical policy, purpose/idempotence; real portable adapter plus built public hire/onboard and charter/persona preservation. `named-agent`, `soul-project-bank`, `role-contract` protect adjacent identity/role behavior. |
| 2 — Candybar WHEN, execution-only services/Hermes | `roles/_base.md` bounded section and policy contract assertions cover systemd, cron, Hermes, n8n and embedded recurring loops, bounded retries and event-driven consumers. No schedule created. |
| 3 — installation/cutover proof | Same section requires committed manifest, API registered-schedule readback, terminal invocation plus intended effect, native clocks disabled; tests assert terms. No tests/dispatch/registration presented as installed scheduling proof. |
| 4 — exact AD-22 exception | Same source explicitly limits exception to existing page-only `candybar-watchdog.timer`, excludes crank-watchdog, requires exact schedule/owner/scope/rationale for further exceptions and reports unfamiliar timers rather than disabling. |
| 5 — read-only fail-closed deployed guard | `scheduling-policy-audit-regressions` (seven groups, including numeric/string and boolean/string YAML key collisions and contract-valid/invalid roles) and existing scheduling audit cases; corrected current CLI exit 1 with 49 audited, 46 pass, 2 drift, 1 unproven. Previous paired read-only observation remains historical for the initial candidate; the repair's read-only rerun is bounded to the current CLI output, not a new host-wide write trace. |
| 6 — attributable deployment evidence and persona safety | Coverage/gap table above; `policy-refresh-regressions` exercises private fixtures only, preserving refusals, persona/config/link/receipt ownership and idempotence. Positive audit fields explicitly say on-disk bytes only, sessions/runtime false. No live refresh performed. |
| 7 — separate agents ownership and honest gates | Global boundary below; exact command exits/logs and wider limitations recorded in current checks. Candybar linter/cutover remains separately owned. |

## Separate agents-repository boundary

`~/.agents/AGENTS.md` belongs to `git@github.com:delorenj/agents`, not Flume.
Its narrow scheduling rule originated in agents commit
`04327e9d5debc293c74ac7f039feba839459d206`. Read-only verification found agents
HEAD and remote main both
`813605f9a5ad78a76d2a3695417fccedfd99ba77`, with no local diff for AGENTS.md.
The committed and on-disk scheduling section hashes both equal
`7eeecbd068afbd9b050b84839003992cc9104a4593c845e0d9b5ed45e4b329a1`.
This is a separate published instruction surface, not proof any CLI session
loaded it. This task did not modify that repository or global file.

## Executed checks and limits

Current exact commands, exits and output hashes are retained in
`checks-2026-11-19.json`; base comparisons in `base-checks-2026-11-19.json`.
Raw stdout logs remain in active-profile scratch at the recorded paths, not
committed. Commands used Node 26.5.0, `/usr/bin/python3` with PyYAML and the
active profile's scratch TMPDIR; no live apply. Test results are attributable
to the candidate worktree, not the dirty shared main checkout.

- `npm run typecheck` and `npm run build`: exit 0.
- Focused `node tests/scheduling-policy-regressions.mjs`: exit 0, 13 groups,
  seven distinct role variants × named/unnamed.
- `node tests/scheduling-policy-audit-regressions.mjs`: exit 0, seven groups
  after repair; original six-group output belongs to the initial candidate.
  The initial candidate's `checks-2026-11-19.json` has not been rewritten.
- `node tests/policy-refresh-regressions.mjs`: exit 0, six groups.
- Adjacent `soul-project-bank`, `named-agent`, `pjan-48`, `role-contract`,
  `specialist-hire`, `fleet-inventory`: exit 0.
- `specialist-placement` and `role-projection`: exit 1 on missing private
  member-gateway authority fixtures. Same failures reproduced on isolated base;
  not repaired as FLUME-72 production defects.
- `fleet-status`: incomplete at the 150-second outer process-group deadline,
  killed with -9 after 23 checks. No completed gate claimed; base result is
  recorded separately.
- Full `npm test` was not run: its runner forces `/tmp`, and multiple unrelated
  suites hardcode `/tmp`, conflicting with this session's scratch-only rule.
  Applicable suites were invoked directly instead; this is not a clean full
  suite claim.

Initial setup attempts are not acceptance evidence: `npm ci --ignore-scripts`
left the Git skillex dependency unbuilt; normal `npm ci` produced the real
exports. The old docs' `/usr/bin`-first PATH selected unsupported Node 20;
keep the Node directory first, then `/usr/bin` for PyYAML. A first `heavy` run
inherited the systemd manager's unrelated TMPDIR; it was stopped and rerun with
TMPDIR explicitly set inside the proof runner. None of these attempts is
represented as a passing test or current deployment result.
