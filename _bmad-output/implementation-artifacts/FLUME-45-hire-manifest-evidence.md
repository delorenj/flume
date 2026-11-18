# FLUME-45 — repo-bound PM manifest regression evidence

## Current-path investigation

`flume hire pm --yes --skip-telegram --skip-plane --local` enters `packages/flume-hr/src/index.ts` → `HireRecipe` → `PromptForAgentConfig` → `RunCopierTemplate`. The latter already owns `registerRenderedAgent`, which reads and updates the existing `.project.json`; there is no need for another registry writer. The current checkout includes the earlier `ctx.targetRepo == null` guard repair (commit `4821157`), rather than the older truthiness check. The installed `flume` command resolves to the shared checkout's bundled CLI, not this isolated worktree; tests explicitly invoke this worktree's rebuilt `packages/flume-hr/dist/index.js`.

The incident's reported missing binding is not reproducible on current `main`: before changing application code, `node tests/flume-45-hire-manifest.mjs` ran the built public CLI with real pinned Copier tasks and passed the `agents`-absent and `agents: {}` cases. It also exposed a separate fixture-only failure for a declared but unprovisioned sibling (`hermes.registry-parity` removes stale declarations). The preservation case therefore provisions a real sibling role first. This is not evidence that the historic incident did not occur; the previous guard change plausibly fixed its skip path.

## Changes and observations

The existing writer now verifies that the rendered `role.yaml` `agent_id` matches the requested identity before binding the project. Registration errors explicitly name the project registration step and remain fatal; this is not a new rollback of Copier/host state. No change to dry-run semantics. The new regression is registered in the standard test runner and checks both agentless manifest shapes; identity, role, relative role path and provisioned state; exact preservation of all non-agent fields plus an existing provisioned agent and unknown fields; dry-run byte identity; and a controlled final manifest-write error. Every fixture uses a private repository, home, fleet registry, Skillex catalog and executable stubs for credential/network/service tools. Copier and its pinned template tasks run for real; the only simulated provisioning interfaces are the Hermes profile-create command and unavailable external tools. The fault is injected at `fs.writeFileSync` for precisely the fixture `.project.json`, after Copier has finished.

## Gates (commands in isolated worktree)

- `npm ci --ignore-scripts && npm run build`: build passed; the ignored lifecycle scripts left Skillex without `dist`, so the first typecheck failed on missing `@delorenj/skillex` declarations. Repeated `npm ci` with lifecycle scripts enabled, then `node scripts/run-tests.mjs role-hire`: typecheck/build passed, 1/1 suite passed.
- Pre-change `node tests/flume-45-hire-manifest.mjs`: after controlled fixture setup, 5/5 groups passed; confirms current public path registers both shapes and exposes write failure before this patch.
- `node scripts/run-tests.mjs flume-45 role-hire`: typecheck/build passed, 2/2 suites passed.
- `node scripts/run-tests.mjs registry-comments telegram-hire fleet-contract`: typecheck/build passed, 3/3 suites passed.
- `node scripts/run-tests.mjs flume-45`: typecheck/build passed, 1/1 suite passed after tightening PATH allowlist and sibling preservation assertion.
- `npm test`: typecheck/build passed; 1–4 and 6–10/51 suites passed, but `runtime-singleton-targets-regressions` failed at line 143 (its remediation returned exit 1). `fleet-status-regressions` took 242.3 s; the full run was stopped during suite 11 after ~7 minutes, so no full-suite PASS is claimed. This failure exercises a runtime singleton remediation outside the manifest path; no fix to that unrelated rule was attempted.

## Independent verification of candidate `f3990c497b264e44c4e4b0a05b3a97b79476debf`

- SPEC: **PASS**, five public-CLI hire groups against the rebuilt candidate, including both absent `agents` and `agents: {}`, preservation of a provisioned sibling and non-agent fields, dry-run byte identity, and fatal controlled manifest-write failure. This is current behavior, not proof of the historic incident's root cause.
- QUALITY: **PASS**, nine isolated ingredient guard probes (matching derived/explicit IDs, rejection of missing/empty/non-string/mismatched IDs without manifest mutation, malformed YAML, no-manifest compatibility, dry-run). These negative cases are independent review probes, not committed regression cases; adding them to the committed suite is advisory, not a landing blocker. The complete review is preserved at [`FLUME-45-independent-quality-review.md`](./FLUME-45-independent-quality-review.md).
- Independent base **and** candidate `npm run typecheck` and `npm run build`: exit 0 on both. The unchanged runtime singleton suite fails on both revisions at line 143 because its strict-profile fixture has `.skillex-only` but lacks `.no-bundled-skills`. Diagnostic copies seeded only that missing marker and passed all original assertions on both revisions. This attributes the pre-existing failure; it does **not** claim the unmodified suite or full suite passed.

No production provisioning, ticket-board mutation, or cross-system rollback was attempted.
