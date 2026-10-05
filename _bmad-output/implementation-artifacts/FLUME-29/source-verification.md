# FLUME-29 final source verification

Verified October 5, 2026 against reviewed Flume source `f2e06fd0723689c06fc666ed162883651c08293c`, canonical template `adfccce324e22a93d446cedfb2df50b31850611f` and Skillex `d0e03253029328c4004bd832472ee7bff947e182`. Both Flume dependency files pin the full Skillex revision. A clean npm install proves its installed CLI/API bundles match the reviewed build and public CLI byte for byte.

## Source and review result

The final stable `npm test` run passes typecheck/build and 23 of 24 suites. Only the unchanged pre-implementation fleet-status assertion fails: `the nine status domains are not the contract's three policy_domains: the contract's axis is the three-value one`. Audit no-write checks pass. Source/index and real employee state remained steady throughout the run. Log: `/tmp/flume29-final-parent-tests.log`; 866.9 seconds for the suite set.

All affected specialist, named-agent contract, role hire/selection/contract, registry comments, inventory/provenance, profile, service and Skillex configuration/resync suites pass. Host inventory checks can skip by their established gate; the isolated specialist suite directly exercises malformed portable provenance and non-regular definitions.

The canonical nested template command `PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider tests/test_specialist_profile.py tests/test_profile_config_locking.py tests/test_named_agent_identity.py tests/test_skillex_profile.py` passes all 67 tests. Log: `/tmp/flume29-final-parent-template.log`.

The reviewed Skillex gate passes lint/typecheck and 905 Node tests with one existing skip. Focused profile-sync coverage passes 27 tests. Required Python push checks pass 928 tests with five skips. Its two existing lint warnings are unrelated. Logs: `/tmp/flume29-skillex-legacy-check.log`, `/tmp/flume29-skillex-legacy-tests.log` and `/tmp/flume29-skillex-legacy-push.log`.

Three independent review layers returned twenty individually triaged findings. Nineteen accepted findings are corrected, including shared root causes; the automatic native multi-bank fan-out claim was refuted against the approved contract. No accepted review finding is deferred. The spec records each original finding and the final correction evidence.

## Implementation coverage

Flume supports `hire --definition`, `onboard --definition|--employee`, `audit --employee` and `launch <employee> --cwd <directory> -- <Hermes arguments>`. Definitions, canonical catalog selection, paths and ownership are validated before employee publication. Portable records contain explicit identity/desk/definition provenance without fabricated project, board, role directory or service bindings. Unrelated handwritten content, settings, record extensions and registry comments remain preserved.

Profile/config/memory rendering runs under the existing profile lock. Interrupted publication uses an internal recoverable receipt; pending state refuses audit/launch. Contract drift is audited and counted. Strict generated profiles disable project/external/global skill discovery. Ordinary legacy Skillex profiles retain global inheritance and linked regular-file configuration.

Provider configuration explicitly enables AutomaticAI, pins AUTOMATICAI_GATEWAY_KEY to the corresponding own-token vault reference and strips inherited inference keys during launch. Raw credentials in generated config, profile metadata and Hindsight objects refuse publication. Both full and abbreviated profile/provider/access overrides refuse. Missing owned tokens or declared runtime pins are explicit deployment dependencies.

## Independent installed acceptance

Both real inaugural employees are hired and pass scoped audits. After the post-review provider update, a second refresh returns changed=false while managed file bytes/mtimes, links, registry and real Skillex receipts remain identical. Normal-home public Skillex inspection exits 0 with no planned changes. Published owning definitions in ~/.agents match their canonical examples.

The pinned installed Hermes release `0408fec7a153e6c32c064acd2b8053917f1525f1` loads the actual charters, exactly four infrastructure skills and fourteen n8n skills, and the correct own-bank configuration from `/tmp/flume29-travel-proof`. Both native providers recall their earlier employee-attributable retained facts after the final fixes. Additional declared banks are charter/configuration scope; automatic native fan-out was not demonstrated or promised.

Both installed public launchers stop before chat inference with the explicit missing-own-token FLUME-39 dependency. No token was minted or borrowed. Operator acceptance and structured receipts are in the companion `operator-acceptance.md` and `operator-evidence.json`. The first n8n marker-only retain produced no facts; the successful subsequent retain used actual workforce/charter facts, and that history remains explicit.

## Integration history and preservation

Earlier integration exposed an isolated-home Skillex gap: standalone normal-home callers planned global skills despite clean Flume-only inspection. The durable skills.inherit_global=false policy and public CLI/API installation correct that behavior. Earlier concurrent source publication made one broad status run unsuitable as a comparison; the final stable run reproduces only the preserved baseline assertion. Historical logs remain in /tmp, while final structured evidence is retained in the source workspace.

The nested template is clean, committed and pushed. The canonical working template checkout fast-forwards to the same revision while preserving its eleven unrelated project-skills WIP files. Fifteen unrelated parent files, Skillex's unrelated .lastagent and eight unrelated ~/.agents files retain their original hashes. Parent integration advances only the owned component gitlinks, preserving other staged work. No temporary implementation branch or worktree was created. Final publication and the broader unrelated Git inventory are recorded in closeout.md. Readable artifacts are copied to the AutomaticAI vault; vault-copy.sha256 records verified document-body hashes while preserving curator frontmatter.
