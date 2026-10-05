# FLUME-32 worker evidence

Status: IMPLEMENTED; targeted verification PASS; independent review and parent integration pending
Worker: flume-32-hire-proof
Worktree: /home/delorenj/code/33GOD/flume/.worktrees/flume-32-hire
Branch: feat/flume-32-hire-proof
Base: 2034f78322b89af2b74db69bb182085a6966c20f
Template tested: 97f9ff82e087dad3273c5cc596feac6b39f2c370 (original pin, unchanged)

- AC-1: PASS — `role-projection` proves exact skills/chain/org; `role-hire` adds actual built CLI and Copier provisioning with a set and versioned pack.
- AC-2: PASS — `role-projection` exercises the onboarding caller; `role-hire` onboards each newly hired role twice and compares registry, org, config, selection, receipt, unrelated state and skill links.
- AC-3: PASS — `role-projection` covers named audit failures; `role-hire` refuses unresolved sets and incompatible packs before provisioning, and proves occupied-role refusal and real Copier failure.
- AC-4: PASS — `role-projection` covers inherited chain, department manager default and preserved/reported explicit model overrides; `roles/README.md` documents the declaration and gateway surfaces.
- AC-5: PASS — `role-contract`, `named-agent` and `named-agent-contract` pass with the same shared identity/skills definitions; `hermes-profile-inheritance` also passes.
- AC-6: PASS (scope: `PASS_SEAM_ONLY`) — the orchestrator's authenticated live fallback/member-ledger proof is recorded in [live-fallback-20261005.json](/home/delorenj/code/33GOD/flume/_bmad-output/implementation-artifacts/FLUME-32/live-fallback-20261005.json). It proves the isolated Hermes AIAgent fallback seam, with multiplexed Bloodbank ingress outside its scope. This worker made no gateway calls and did not edit or regenerate that receipt.

The historical entries below retain the observations and outstanding gates at the time they were written. Current acceptance and remaining integration work are recorded above and in the Real hire path section.

## Real hire path (2026-10-05)

`tests/role-hire-regressions.mjs`, registered in `scripts/run-tests.mjs`, runs the built CLI:

```sh
node scripts/run-tests.mjs role-hire
node scripts/run-tests.mjs role-hire role-projection role-selection role-contract named-agent hermes-profile-inheritance
```

Within each fixture, the commands are:

```sh
# cwd is a scratch Git project named demo
node <worker>/packages/flume-hr/dist/index.js hire dev --yes --skip-telegram --skip-plane --local
node <worker>/packages/flume-hr/dist/index.js onboard dev --target-repo demo --skip-telegram --skip-plane --local
# Repeat the identical onboard command once more.
```

`--target-repo` takes the project name; the current directory supplies the project path.
The fixture uses scratch HOME, fleet, registry, org, template config, XDG state, project and Skillex catalog.
Child environment variables are allowlisted, with forbidden-tool sentinels for credential, network and service commands.
It invokes the real installed Copier against the worktree's original clean vendored template and uses real Skillex and the canonical config renderer. Only the external `hermes profile create ... --no-alias --no-skills` command is simulated with scratch profile creation.

Actual Copier launches all 13 configured tasks. Config/fleet environment/profile/runtime/registry tasks execute;
Telegram, Slack, ticket-board, Bloodbank setup and systemd activation follow their explicit deferred/skipped paths.
The runtime task invokes the built Flume CLI's real `migrate hermes.runtime-singleton` preview and apply.
After Copier, Flume projects the declared loadout and organization and completes the final hire audit.
The initial project selection is deliberately `deploy, lint`; the final desk is exactly global `global` plus declared `build, review`, with resolving catalog symlinks, strict markers, `skills.external_dirs: []`, no desk `.agents`, and a receipt owned by the role selection.

The nine assertion groups cover a set hire, a versioned pack hire, two onboard calls for each,
occupied-role refusal for each, an unresolved set, incompatible packs, and a real Copier task failure.
Onboarding preserves file bytes and symlink identities, including unrelated desk/runtime state, registry/org comments and manager information.
Regular file inode equality is deliberately not required: the canonical renderer may atomically replace an unchanged generated config.

Defects demonstrated and fixed:

- Invalid loadouts reached provisioning before their selection failed. `ValidateHermesOptions` now uses the existing declaration and Skillex validation APIs before config/Copier writes.
- The pinned template's registry writer removed YAML comments. `RunCopierTemplate` resolves/pins its registry path and reconciles the writer's values into the original YAML document through `PreserveRegistryComments`.
- A declared contributor inherited PM-only Bloodbank tool permissions, failing the final audit. `ProjectRoleDeclaration` removes inherited delegation/terminal/file permissions with a scoped renderer list patch under the existing profile lock; explicit desk overrides survive and the fleet base stays unchanged.
- Local hire required the host automatic Skillex resync service. `HireRecipe` skips only that local postcondition and names the host-service deferral; normal audits retain the original check.

Verification actually executed:

- `/tmp/flume-orch/flume32-baseline.log`: full pristine baseline, 21 attempted / 20 PASS / 1 FAIL; typecheck/build PASS. Only `fleet-status-regressions` fails on the existing nine-status-domains versus three-policy-domains assertion.
- `/tmp/flume-orch/flume32-hire-green.log`: typecheck/build and the real-hire suite PASS (21.3 seconds).
- `/tmp/flume-orch/flume32-selected.log`: typecheck/build and all seven selected suites PASS (100.4 seconds).
- `/tmp/flume-orch/flume32-deploy-check.log`: typecheck/build and `pjan-86-hermes-deploy-regressions` PASS (12.6 seconds), covering the existing deployment/recipe guards.
- `/tmp/flume-orch/flume32-after.log`: saved post-change verification, with commands and scope stated explicitly. The full after suite was not repeated at the user's direction; parent owns combined verification.
- `git diff --check`: PASS; the template checkout and its gitlink remain unchanged in this worker.

The supplied historical `/tmp/flume-orch/flume15-baseline.log` had 19/21 PASS with `fleet-status` and live `fleet-profile` failures. The latter passed in this worker's pristine baseline; neither baseline finding was hidden or quarantined.
Parent main now has template pin `4ae890a5f27c8f6ee914fa80a0a66b0e1ca63f74`; this worker intentionally retains the original pin. Independent review and combined suites against the new pin remain parent responsibilities, including checking whether its registry preservation supersedes this worker's compatibility wrapper.
No live profile, service, vault, gateway, Plane, canonical template WIP or other worktree was changed by this worker.

## Recovered live fallback receipt (parent-owned AC-6)

The parent recovered the completed request from rollout `01a0fd4b-f4df-7851-91ec-9b467ef27325`, recorded at `2026-10-05T03:50:24.398Z`, into [live-fallback-20261005.json](/home/delorenj/code/33GOD/flume/_bmad-output/implementation-artifacts/FLUME-32/live-fallback-20261005.json). The artifact was read to verify this attribution; no request was repeated.

- Marker: `AAI_ROUTE_PROOF_5dfa0cf0a9e5b690369021babc832429`.
- Completed effective chain: `automaticai/personal/sol-6.1` → `automaticai/personal/glm-5.3` → `automaticai/personal/kimi-2.8`.
- Primary HTTP 503 was injected at the isolated Hermes desk transport, without server mutation; authenticated model availability was verified and the response completed using `automaticai/personal/glm-5.3`.
- Ledger row `69879`, request `202610050350196487012018268d9d6Yv0xCfMk`, attributes the request to token name `aai:hermes-flume-pm:1790777406434714921`, account `zai-personal`, native model `glm-5.3`.
- Ledger requested/effective effort is `max`, with `effort_defaulted: true`. The isolated client's outgoing effort fields are null, so this receipt establishes the ledger's actual effort rather than proving propagation of a configured fallback effort.

The verdict remains `PASS_SEAM_ONLY`: actual authenticated live fallback with member attribution. It does not establish multiplexed Bloodbank ingress, live service activation, or this worker session's gateway routing.

## Worker #2 resume
Start Plane comment: dcb452cd-432f-47e5-884b-caf41ca62146.
First commit preserved worker #1 RED verbatim (rebased SHA 1d8b241).
Observed RED: `node tests/role-contract-regressions.mjs` exit 1: missing validateRoleDeclaration (red.log).
GREEN: `node scripts/run-tests.mjs role-contract named-agent` exit 0, 3/3 suites (shared-contract.log).
Established readRoleIdentity moved unchanged to workforce/identity.ts; parity re-exports it. Both consumers invoke that same path. Shared schema bundled from JSON, eliminating the old parallel FALLBACK_SCHEMA. Named-agent fixtures with mismatched banks corrected to agent-<id> so skill/desk tests still exercise their intended gate. Pack(s)/set use one resolver.

Rebased baseline: `/tmp/flume32-baseline-postrebase.log`: typecheck/build PASS, 11/16 suites PASS; fleet-status/health/systemd already fail in worker #1's old baseline; profile environment/mise trust and pjan-86 5s Python timeout also failed. Full output preserved, no failures hidden or quarantined. Retry `/tmp/flume32-baseline3.log`.
No fleet services/default config/main checkout mutations.

## Strict Skillex selection (2026-10-02, owner: "transition to all strict skillex skills")

Worker #2 / the Codex resume worker both stopped without finishing (the Codex session ended 2026-10-01 15:17 EDT with
a clean worktree). Picked up from origin/main b21ae9e in a throwaway worktree.

Problem found by the strict-desk acceptance: the loadout reached a desk through `<desk>/.agents/skills` and a
`skills.external_dirs` list patch; `skillex profile show` on a Skillex-only desk exits 3 (E_PROFILE_SKILLEX_ONLY).

Fix: `workforce/selection.ts`. A role's `skills {set|pack}` becomes `<desk>/.skillex-selection/.agents/skills.json`
(`inherit_global: false`, `sets`/`packs`), written with Skillex's manifest writer and projected with
`skillex profile sync --skillex-only`. Nothing in flume writes `skills.external_dirs` (it pins `[]`) or a second skill core.
A pack is exclusive in Skillex, so `packs: [a, b]` and pack + set are refused by name.

- `node scripts/run-tests.mjs role-selection` : 15 groups PASS (real skillex CLI, scratch fleet and catalog).
- `scripts/flume32-selection-proof.mjs` -> `selection-proof.json`: real strict flume-pm desk rebuilt in a scratch Hermes
  root, `flume onboard pm` twice (exit 0/0, second run no change), `skillex profile show` exit 0 (explicit and recorded
  project), 62 skills = 56 global + 6 `product-manager`, `external_dirs: []`, no `.agents`, audit rules pass after
  `flume remediate hermes.runtime-singleton`; the previous build on the same recipe: exit 3. Skillex's own desk
  auto-resync (`scripts/hermes-skillex-resync.py`) follows the recorded project: converged desk `ok`, selection moved
  `would-sync` then `synced` against `<desk>/.skillex-selection`, then flume restores the declaration. Live fleet
  fingerprints identical before and after.
- Live `flume audit` (read-only), untouched HEAD vs this build: the 13 hermes.*/systemd.* rules are identical.
- AC status after this change: AC-1 (skills half) and AC-2/AC-3 (skills cases) hold under the strict model;
  AC-4 docs added (roles/README.md); AC-5 unchanged and green. STILL OPEN: AC-6 (fresh member-attributed ledger
  evidence; only the earlier PASS_SEAM_ONLY probe exists), `flume onboard --repo` (the WIP test's flag; the only red
  line left in role-projection-regressions), the real `flume hire` path for a loadout role, and the independent
  spec/quality review gates.
