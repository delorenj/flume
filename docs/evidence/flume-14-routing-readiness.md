# FLUME-14: addressability evidence, unresolved Bloodbank routing

## Claim and remaining gap

This repair follows AC1's allowed-gap branch. The existing read-only gateway `identify` exchange observes **session-profile addressability**, not Bloodbank target resolution. A positive auxiliary observation never sets `capability_readiness: ready`, advances observed lifecycle to `routing_ready`, or claims observed activation. Declared desired state and the strict activation flag remain independent.

The separate observation `bloodbank-target-resolution-unsupported` names what is missing: the current Bloodbank `ProfileResolver` association, including `target_profiles` overrides and the adapter's independently selected registry. No safe existing inspection surface was found for that association. The handbook retains `bloodbank/routing_liveness`, narrowed to this undelivered capability. A contract-authorized deferral can preserve aggregate health proof; it does **not** prove routing readiness. Unread or failed auxiliary addressability still blocks complete/proven health. The legacy no-known-drift `health.healthy` boolean is unchanged.

No gateway changes, invented endpoint, dispatch probe, activation, publication, replay, consumption/acknowledgement, profile attachment or service control were used. Tests passing does not establish that target resolution is implemented or that FLUME-14 is complete. Independent SPEC and QUALITY review remain required; no main merge or deployment is asserted.

## Actual producer/consumer boundary

Source inspected read-only on 2026-11-18:

- Hermes checkout `/home/delorenj/.hermes/hermes-agent`, HEAD `d6100d8bda1af8c7f1ca121a7f99a29112c62045`:
  - `gateway/control_socket.py:177–192,330–367`: existing argument-free protocol-1 `identify` handler.
  - `gateway/run_bootstrap.py:292–309`: identify overlays the session runtime descriptor, including drain state; it never queries Bloodbank's resolver.
  - `gateway/run_runtime.py:177–207,231–234`: descriptor served set comes from session authorities.
  - `gateway/session_authorities.py:129–139`: non-retiring built authorities become `{profile_id, home}`; not employee target mappings.
- Bloodbank checkout `/home/delorenj/code/33GOD/bloodbank`, HEAD `b42ce0aa859553c0977fdc236a2a4b8f70ed5690`:
  - `services/hermes-gateway/bloodbank_hermes_gateway/adapter.py:416–438`: chooses `extra.target_profiles` and `extra.fleet_registry` independently.
  - `contract.py:246–345`: `ProfileResolver.resolve()` prioritizes explicit overrides, then its selected registry; checks profile existence separately.
  - Adapter broker connection/binding is another condition, not a session-runtime capability.

Relevant actual file SHA-256s (checkout HEAD alone is not an assertion that external worktrees are clean):

| File | SHA-256 |
|---|---|
| Hermes `gateway/session_authorities.py` | `7ff52e18a7c40b16c2551888b3d65f8cb2e932f10f029e06156fa5ac8266202b` |
| Bloodbank `adapter.py` | `9fe405b0b7f30443c59b302af5b6662209f4917f74186873f1151333118b851a` |
| Bloodbank `contract.py` | `1d4240e168afa69593a601ff9af82d6334ae1a394f2abe9f2ad865db71e5350d` |

A read-only import of the **actual** `ProfileResolver` against private inputs returned `beta-pm` for employee `alpha-pm` with that override, and `gamma-pm` without the override using the independently selected registry, while the declared review profile was `alpha-pm`. Exit 0; no adapter started. Receipt: `actual-resolver-boundary.json` in the scratch evidence directory below. The durable CLI conflict fixture uses the real `platforms.bloodbank.extra` configuration shape, disabled adapter, conflicting override and separate registry; positive session addressability remains routing-unproven.

## Observation and safety contract

Each selected employee's auxiliary read requires fleet scope, target equal to employee ID, a valid uniquely claimed/resolved real profile directory, same-owner socket (or private, at-most-256-byte absolute pointer), protocol/runtime protocol 1, matching request ID and Hermes home, ready session state, `session-authority-v1`, and exactly one canonical matching `{profile_id, home}`. Blank/unresolved/conflicting profile, wrong scope/target and empty/conflicting served evidence are explicit negative results.

Freshness is a **new bounded identify exchange in this run**. No saved timestamp, prior successful report, historical dispatch, process presence or registry declaration substitutes for it. Draining/inconclusive/denied/unavailable observations remain unobserved; malformed/oversized/identity-mismatched observations remain errors. The response is capped at 512 KiB. Per-probe timeout and shared deadline/cancellation apply. Command deadline/cancellation return TIMEOUT/exit 7 and CANCELLED/exit 8 with `data: null`, never a partial report. Untrusted reply/configuration values are replaced by bounded stable reasons, not echoed.

Human output always shows auxiliary source, result and proof limitation, including the positive path. Failures name the actual handbook field and owner: registry scope/target/profile declaration, runtime-template generated profile, or runtime-template shared gateway. The unsupported resolver owner is explicitly unmapped rather than pretending agent-registry owns an inspection capability. Next actions are specific read-only investigation, never a service/activation operation.

The durable routing suite brackets every real CLI run with full fixture-tree content, mode, size, symlink and mtime snapshots: registries (including absent activation key), role/profile config and service sentinel files. Preloaded child-process, HTTP/fetch and non-fixture-network tripwires forbid invocation, command transports and service control; a separate tripwire self-test proves those spies are armed. All actual fixture socket requests must equal `{verb: identify, id: 1, protocol: 1}`. Human and JSON success/error paths contain planted registry/config/reply secrets without printing them.

## Executed verification

Repair worktree: `/home/delorenj/code/33GOD/flume/.worktrees/feat-FLUME-14-routing-readiness`, branch `feat/FLUME-14-routing-readiness`; repaired from frozen `27a980c2f9d02d2f1a67f1f6e0bc09c047034466`, base `c360fae7140dc6c6035f4b940a20304d0558603b`.

All suites were run directly, not through `scripts/run-tests.mjs` (that runner forces `/tmp`). `TMPDIR` stayed under `/home/delorenj/.hermes/profiles/flume-pm/cache/scratch`; credentials blanked, host overlay disabled, live registry selectors pointed at absent private paths for host-dependent status cases. A private `python3` shim pointed at the already-installed Hermes venv interpreter so the renderer's narrow child PATH could import PyYAML; no installation/profile changes. Base and repaired candidate used the same isolated environment.

| Check | Exit | Actual result |
|---|---:|---|
| `npm run typecheck` | 0 | Both workspaces |
| `npm run build` | 0 | CLI and MCP bundles built |
| `git diff --check` | 0 | No whitespace errors |
| `node tests/flume-14-routing-regressions.mjs` | 0 | 12 checks, zero failures/skips |
| `node tests/fleet-contract-regressions.mjs` | 0 | 128 checks, zero failures/skips |
| `node tests/fleet-status-regressions.mjs` | 0 | 54 checks, zero failures; 2 host-live cases deliberately skipped |
| `node tests/fleet-health-regressions.mjs` | 0 | Original 30 checks plus 2 new full-report checks, zero failures/skips |
| `node tests/fleet-shared-bloodbank-regressions.mjs` | 0 | Suite reports `ok` |
| Base `fleet-health-regressions` | 0 | 30 checks, zero failures/skips |
| Base `fleet-status-regressions` | 0 | 54 checks, same 2 host-live skips |

The independent frozen-candidate review controlled **base 30/30 versus candidate 26/30 health checks**. That integration regression was real, not dismissed as legacy assertions. The revised suite seeds a real AF_UNIX identify peer for every relevant employee (including the dynamically added scaffold-exception employee), retains the exact resolver deferral and does not weaken health classification. Complete, no-live, missing-audit, draining, stale and unknown-freshness full reports all assert no observed routing-ready/activated promotion.

During repair, an initial run without the interpreter shim had renderer-related failures; with the shim one newly exposed fixture omitted the dynamic employee's served authority and failed its exception test. Both were corrected in fixture/environment, not by relaxing observation. A contract run also failed canonical YAML round-trip formatting (114 pass/14 fail); the folded scalar was corrected, then all 128 passed. Final results above supersede those intermediate failures. Earlier 8/8 failure counts in the original evidence were environment-dependent historical receipts, not the controlled result.

Scratch execution logs and whitelisted receipts: `/home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume14-repair/` (`<suite>.log`, `base-<suite>.log`, `suite-exits.json`, `actual-resolver-boundary.json`, `live-bounded-summary.json`). Scratch is not the durable regression suite: acceptance coverage lives in the tracked tests.

## Bounded live read — addressability only

At `2026-11-18T16:01:01.609981+00:00`, actual invocation from this worktree:

`node packages/flume-hr/dist/index.js review --agent flume-pm --domain bloodbank --deadline-ms 8000 --json`

Outer subprocess timeout: 12 seconds. **Exit 0**. `flume-pm` auxiliary `gateway-control-identify` observation: `pass`, `gateway-serves-declared-profile`, `direct`. Separate resolver observation: `unsupported`, `bloodbank-target-resolution-unsupported`, justified only by the narrowed handbook deferral. Lifecycle: `capability_readiness: unproven`, independent registry `activation: granted`, observed state `out_of_scope`. Scoped health: `complete: true`, `proven: false`, verdict `healthy` (authorized gap/no observed drift, not routing proof). Only a non-secret whitelisted summary was saved; no raw identity payload/profile config was retained.

This proves current session-profile addressability, **not** current Bloodbank employee target resolution, broker subscription/delivery, execution or activation. The precise unsupported resolver gap remains. The full repository test matrix, host-live full-fleet audit, FLUME-13 process observer, main integration and deployment were not exercised or changed here.
