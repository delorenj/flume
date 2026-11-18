# FLUME-32 source reconciliation (2026-11-18)

Base: `origin/main` at `196d47d1b7ab078478856eef5f309b2a45a5cc0b`. This is a source/fixture reconciliation, not a new AC-6 live receipt. No fleet, board, registry, shared gateway or deployed desk was changed.

## Current acceptance evidence (AC-1 through AC-5)

Run in this branch after initializing the pinned `templates/hermes-agent` gitlink and installing the locked npm dependencies with scripts enabled:

```sh
node scripts/run-tests.mjs role-projection role-selection role-hire role-contract named-agent hermes-profile-inheritance
node tests/role-projection-regressions.mjs
node tests/role-hire-regressions.mjs
```

The first command typechecked and built, then passed 8/8 selected suites (`named-agent-recency` is also selected by the substring filter). The direct role-projection command printed the individual AC cases; the direct real-Copier hire command printed 22 passing check groups.

| Criterion | Current proof | Boundary |
| --- | --- | --- |
| AC-1 | `role-projection`: one role selects canonical `all-skills` symlinks, ordered primary/fallback config and declared department/superior; `role-hire`: real CLI/Copier set and versioned-pack hires, strict Skillex selection and final audit. | Scratch fleet/catalog and fixture catalog routes; the helper alone is not a real hire. |
| AC-2 | `role-projection`: two public `onboard` calls retain org comments, unrelated member, config and skill names; `role-hire`: real set/pack hires each followed by two onboards, checking byte-identical projected state. | No live desk mutation. |
| AC-3 | `role-projection`: four built `flume audit --rules hermes.role-declaration` failures name absent route, missing superior, cycle and missing department; `role-hire`: corresponding invalid declarations refuse before provisioning. | The named negative route is intentionally absent from the fixture catalog. |
| AC-4 | `role-projection`: no-chain desk inherits fixture fleet base; missing superior uses department manager; explicit non-gateway model override survives and is reported. `role-hire` preserves explicit direct-list/list-patch Bloodbank deltas. `roles/README.md` distinguishes desk-gateway versus shared-process fallback and effort limitations. | The fixture base is deliberately not a dated production default. |
| AC-5 | `role-contract`, `named-agent`, `named-agent-contract` and `hermes-profile-inheritance` pass. `contracts/role.schema.json` references named-agent `$defs`, and both validators call `workforce/identity.ts` identity validation. | FLUME-29 owns unrelated named-agent projection repairs. |

`tests/role-projection-regressions.mjs` previously read `/home/delorenj/.hermes/config.yaml` and the host route catalog, so an otherwise hermetic check could change with the host. It now declares a scratch fleet base and scratch route catalog; the mechanism under test still reads its supplied fleet base at runtime. No default route was added to production code.

## Specialist request and ownership

Marge's October 18 request is real and **not implemented on main**: `contracts/named-agent.schema.json` rejects placement and persona-title keys, `hireSpecialist` writes identity/skills/memory/Bloodbank but no org placement, and `auditSpecialist` does not compare org placement. The existing role writer (`workforce/role.ts`) is tied to role declarations, a department already present in org.yaml and a registry row; the specialist cannot simply call it without defining a specialist placement contract and safe preview/write behavior. `org/tree.ts` is a read-only observer with explicit inferred/unplaced edges, not a placement writer. No `flume org placement` verb exists.

The request needs an owning acceptance contract before a safe implementation: whether `department` is an existing id only or the command may create departments (Marge's example created one); how `reports_to` handles an absent/phantom manager versus an explicit null; whether persona title belongs in the agent definition, org `personas`, or registry; and whether an org placement verb edits the definition, the org document, or both. The role path defaults an omitted superior to an existing department manager and rejects one with no manager, while the example explicitly sets a null manager. Treating that example as a role default would reject or silently rewrite a valid intentional placement. Qualify the specialist extension as a separate product decision/owned slice, not evidence that FLUME-32's original role ACs are incomplete. Do not mutate the live hand-maintained org or introduce another validator to guess these choices.

AC-6 remains pending the separate worker's **new role-projected** bounded primary-fault/member-ledger receipt. The October 5 seam-only receipt does not prove that chain or multiplexed Bloodbank ingress.

## Verification failures before setup / out-of-scope gate

- Initial isolated-worktree run: 4/8 suites passed, four failed because the pinned template submodule had not been initialized.
- After template initialization, 6/8 passed; `role-selection` hit Node 26's assertion-message error after the first group, and `role-hire` could not resolve Skillex's CLI from the worktree's inherited node_modules. `npm ci --ignore-scripts` then removed Skillex's build output and caused 9/9 to fail; `npm ci` with scripts enabled restored the locked build, after which the scoped 8/8 passed.
- A separate expanded 9-suite run then passed the original eight but failed `specialist-hire`: its fixture writes a legacy global `{sets: ["global"]}` manifest which the installed Skillex rejects (`E_LEGACY_FIELD`, requires singular `set`). This is not used as FLUME-32 AC-1..5 proof; the specialist fixture needs its own owner before its suite can certify placement work.
