# FLUME-29 source verification and integration handoff

Prepared October 5, 2026. Source implementation is ready for independent parent review and integration. Installed-runtime acceptance and live inference/memory proof remain with the parent; neither employee currently has its own AutomaticAI member token. Missing access is the explicit FLUME-39 dependency.

## Changes

Flume now supports `hire --definition`, `onboard --definition|--employee`, `audit --employee`, and `launch <employee> --cwd <directory> -- <Hermes arguments>`. It reuses definition validation, stable identity checks, desk provisioning and role-selection APIs. Portable specialists have explicit employment, desk and definition provenance. Their records and roster have no fabricated project, board, role directory or systemd units.

Hiring validates definition/catalog/path/ownership before employee publication. The existing registry lock serializes exclusive hires; the comment-preserving atomic writer retains unrelated rows and nested extensions. Partial projection reserves ownership and reports the incomplete state so onboarding can recover. Refresh preserves handwritten files and unrelated configuration, refuses conflicting edits to owned projections and converges without changing managed bytes, mtimes or Skillex receipts on its second pass.

The canonical template adapter renders charter, configuration, profile metadata, own-bank Hindsight pin and ownership receipt under the existing profile lock, before reading mutable profile state. Profiles are real directories with `.skillex-only`, empty external skill directories, `skills.project_discovery: false`, and no profile `.agents` discovery root. Specialist Skillex sync uses the owning desk as an isolated global selection home, keeping the declared loadout exact without changing the operator's activation or repository PM behavior.

The dashboard fix owns `dashboard.enabled: false`, `dashboard.basic_auth.enabled: false` and `dashboard.basic_auth.secret: ""` in the specialist delta. A raw dashboard secret in the shared base is excluded from generated files. The base itself and unrelated dashboard settings are preserved. Other raw inherited credentials still refuse projection.

Launch uses the trusted `HERMES_FLEET_BIN` (or template `hermes_bin`) and refuses missing, non-executable or invalid declared pins rather than substituting PATH. Without a runtime declaration it uses `hermes` on PATH. It resolves only `op://DeLoSecrets/hermes-<id>/credential` into the child environment, strips inherited inference overrides, preserves the requested working directory and propagates the child exit. Missing own access is a distinct FLUME-39 dependency; no member token is minted or written to disk.

Both inaugural examples are in `examples/employees/`. The n8n specialist selects the existing 14-skill `n8n` set. Big Chungus selects exactly four canonical infrastructure references: `delonet-conventions`, `delonet-dotenv`, `stacks-deploy`, and `systemd-agent-service-diagnostics`. The worker created those links before ownership clarified; the parent scoped/committed/pushed the catalog as `db98edb`. This handoff does not create another catalog commit or touch unrelated Skillex WIP.

## Source verification

- Typecheck and build passed on the current source through `node scripts/run-tests.mjs`.
- `node tests/specialist-hire-regressions.mjs` passes 24 check groups using the actual built public CLI, canonical template and real Skillex APIs in isolated fixtures. This includes dashboard-secret dry-run/hire, strict exact skill selection despite foreign global activation, scoped audit/roster, ownership/path refusals, serialized concurrent hires, refresh/no-op preservation, declared-runtime precedence, arbitrary CWD, missing own-token refusal, child exit propagation and recovery from actual Skillex lock contention. The `op` and Hermes executables are explicitly pinned fixtures; their receipts are not live acceptance evidence.
- `python3 -m pytest -q tests/test_specialist_profile.py tests/test_profile_config_locking.py tests/test_named_agent_identity.py tests/test_skillex_profile.py` passes 44 tests. The dashboard regression checks read-only preview, real application, empty/disabled owned auth, absence of its fixture secret in every generated regular file, preserved unrelated theme and byte-identical shared base. Locking tests cover concurrent writers and unchanged refresh.
- The previously completed affected Flume runner passed all eight selected suites: fleet contract, inventory, named agent, role selection, registry comments, role contract, named-agent contract and specialist hire. Log: `/tmp/flume29-affected.log`.
- The final broader Flume runner is being collected at `/tmp/flume29-final-source.log`. Before implementation, fleet-status had exactly one reproduced failure: `the nine status domains are not the contract's three policy_domains: the contract's axis is the three-value one`. Baseline log: `/tmp/flume29-baseline-status.log`. The assertion is unchanged.
- Current final isolated logs: `/tmp/flume29-final-specialist.log` and `/tmp/flume29-final-template.log`.

## Source revisions and ownership

Canonical nested template main is clean and pushed at `bd1757776aec0e44360678bed8208db5a72d0b5b` (dashboard isolation), following `5b687578717d1c7c42fabe28c43108247e077fa3` (portable specialist adapter). Flume advances its template gitlink to that revision. The separate canonical working checkout's unrelated project-skills WIP is preserved.

Flume source publication, final runner comparison, documentation copy hashes and repository checkpoint will be recorded below when collected. The spec stays `in-review`; this worker has not run independent reviewer agents, installed the public CLI or mutated real employee state.

## Parent-owned acceptance still required

Use the installed public path for both real definitions and repeat dry-run after rebuilding/installing the source. Inspect the actual profile charter, exact loadout, discovery policy, own-bank pin, registry provenance and Skillex receipts; refresh twice and inspect zero-change convergence. Confirm launch reaches the declared installed runtime `/home/delorenj/.local/share/hermes-agent/releases/0408fec7a153e6c32c064acd2b8053917f1525f1/.venv/bin/hermes` and refuses missing employee-owned credentials.

After FLUME-39 supplies each employee's own token, run bounded Hermes CLI acceptance from unrelated directories, demonstrate attributable writes only to its own bank and recall only of declared banks plus its own. A fixture, catalog resolution, profile inspection or global token cannot substitute for that proof. Parent owns independent review, real installation, catalog integration and the 33GOD parent pointer.
