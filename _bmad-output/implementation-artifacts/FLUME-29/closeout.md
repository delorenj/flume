# FLUME-29 delivery and operator acceptance

Verified October 5, 2026. Portable named specialists are implemented, reviewed and installed. Big Chungus (`infra-specialist`) and the n8n Workflow Specialist (`n8n-specialist`) are hired with published owning definitions. Conversational inference remains dependent on the separate FLUME-39 employee member tokens.

## Delivered behavior

An employee owns `~/.agents/workforce/<id>/agent.yaml`. Flume validates that definition and its canonical Skillex selection, hires a real profile at `~/.hermes/profiles/<id>`, publishes an explicitly portable employment record, and refreshes owned projections idempotently. `flume launch <id> --cwd <directory> -- <Hermes arguments>` preserves the caller's requested directory and pins the employee's identity, charter, exact skills and personal write bank.

Big Chungus carries four canonical infrastructure skills and writes only to `agent-infra-specialist`; its declared additional recall banks are `infra` and `docker`. The n8n specialist carries the fourteen canonical skills in the existing `n8n` set and writes only to `agent-n8n-specialist`; its declared additional recall bank is `n8n`. Native Hindsight tools use the personal bank. Additional declared banks remain available through the established Hindsight CLI and charter scope; automatic native fan-out was neither promised nor demonstrated.

## Review corrections

Three independent reviewers returned twenty individually triaged findings. Nineteen accepted findings were corrected, including shared root causes. The claim requiring automatic native multi-bank fan-out was refuted against the approved contract. Final source inspection and executable coverage verify:

- Requested employee identity remains bound even when its definition is changed to another hired identity; the reserved Hermes `default` identity refuses before effects.
- Profile ownership checks use the prepared catalog even from a foreign catalog working directory. Missing managed skill links and same-set catalog membership changes are repairable, while handwritten payloads remain protected.
- Interrupted initial hire or refresh is recoverable under the existing profile lock. Read-only previews preserve interrupted state; conflicting handwritten changes refuse adoption. Pending publication blocks audit and launch until onboarding completes it.
- Contract drift is visible to audit/launch and its repair contributes to the changed result. Contradictory portable project, role, board and service bindings refuse; unrelated record extensions survive.
- AutomaticAI is explicitly enabled; the provider uses `AUTOMATICAI_GATEWAY_KEY` and only the corresponding employee-owned vault reference. Raw credentials in generated config, profile metadata and Hindsight objects refuse before writes. Abbreviated and full profile/provider/access overrides refuse before launch.
- Non-regular definitions are reported unusable without opening a FIFO. Isolated negative tests require registry memory and provenance diagnostics and launch refusal.
- Strict Skillex profiles preserve exact selection without inheriting global skills; ordinary linked legacy configuration continues to work.

## Final verification

Final stable Flume typecheck/build pass. All 24 suites were attempted: 23 passed, and only the unchanged pre-implementation fleet-status assertion failed: `the nine status domains are not the contract's three policy_domains: the contract's axis is the three-value one`. The audit no-write checks pass; no assertion was weakened. The run took 866.9 seconds. Log: `/tmp/flume29-final-parent-tests.log`.

Canonical template adapter/locking/identity/Skillex coverage passes all 67 tests. Skillex lint/typecheck and 905 Node tests pass with one existing skip; focused profile-sync coverage passes 27 tests and required Python push checks pass 928 tests with five skips.

The installed public Skillex CLI, Flume's installed API dependency and the reviewed build have byte-identical `dist/index.js` and `dist/cli.js`. Both Flume dependency files pin the full reviewed Skillex revision. The installed public Flume launcher points to the freshly built source bundle.

## Real employee acceptance

Both public scoped audits pass. Each profile updated its provider projection once after review; a second refresh returned `changed: false`. Managed file bytes/mtimes, canonical links, registry and actual Skillex receipt state remained identical across normal-home standalone inspection and the second refresh. Standalone `skillex profile show` exits 0 with no planned changes.

The pinned installed Hermes release `0408fec7a153e6c32c064acd2b8053917f1525f1` loaded the actual employee charter, exactly four/fourteen skills, and the employee's own bank from `/tmp/flume29-travel-proof`. Project discovery is disabled, external directories are empty and neither profile has a `.agents` discovery root.

The native provider retained employee-attributable facts earlier in this run. Final native recall retrieved both existing markers after the review fixes, without duplicating retains: `FLUME29-infra-specialist-95dea7ce8fcc` and `FLUME29-n8n-specialist-7e0e94fe22e8`. The first n8n marker-only retain produced no extracted facts; real deployed identity/charter facts subsequently produced the passing recall. That earlier limitation remains in the acceptance record.

## Inference dependency

Each installed public launch exited 1 with the explicit FLUME-39 dependency before chat inference. Neither employee currently has its own existing member token:

- `op://DeLoSecrets/hermes-infra-specialist/credential`
- `op://DeLoSecrets/hermes-n8n-specialist/credential`

No member token was minted, stored in a file or borrowed. Fixture launch receipts prove child routing/CWD/token isolation/exit propagation separately. After FLUME-39 supplies the employee-owned credentials, the same launch commands can perform conversational acceptance.

## Publication and preservation

Published implementation checkpoints:

| Component | Full main revision |
| --- | --- |
| Flume reviewed implementation | `f2e06fd0723689c06fc666ed162883651c08293c` |
| Flume dependency/spec/operator integration | `b8eca727aa28f9f22cdd6b75ac08d3d2cb604cde` |
| Canonical nested and working template | `adfccce324e22a93d446cedfb2df50b31850611f` |
| Skillex reviewed policy/catalog | `d0e03253029328c4004bd832472ee7bff947e182` |
| Owning ~/.agents definitions | `e151db7d6a08cac665d48a1f50c0ffd957bdc3c0` |
| 33GOD implementation integration | `7179bcd18fc9d890f8a26de6d62ac3ec78fdb62b` |

These checkpoints are committed and pushed on main. The final documentation checkpoint follows them and includes this report; the parent then advances its Flume gitlink to that documentation checkpoint. Current final publication is verified from Git rather than embedding the report's own commit hash.

The approved frozen spec block still hashes to `acad000ec782f0ad2e8dd57748f1a73d4b59e86bd5c1cf18a63132caae278c9b`. Eleven unrelated template files, fifteen unrelated parent files, Skillex's unrelated `.lastagent`, and eight unrelated `~/.agents` files retain their original hashes. Parent publication advances only the owned Flume/template gitlinks and preserves unrelated staged work. No temporary implementation worktree or branch was created.

Readable source artifacts are retained and copied to `/home/delorenj/code/DeLoDocs/Projects/AutomaticAI/Flume/FLUME-29/`. Copy verification compares document bodies while preserving vault-curator metadata. The sibling `vault-copy.sha256` records the verified hashes. The required `git unpushed` sweep is recorded in `/tmp/flume29-final-git-unpushed.log`. The checkpoint sweep lists 309 existing repo/worktree records with unrelated changes, missing upstreams, detached vendor checkouts or unpublished work. The relevant preserved WIP is the canonical template's eleven files, Skillex's unrelated file, and the parent's remaining unrelated changes. The separate ~/.agents repository has its eight protected unrelated files. This delivery does not claim the whole machine is clean. Owned source commits and gitlinks are published; final closeout repeats the sweep and verifies local/remote main parity and protected WIP separately.
