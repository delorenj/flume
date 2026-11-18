# FLUME-13 repaired candidate evidence

## Observation contract

`flume review --domain live_process [--json]` observes Linux `/proc` numeric PIDs. Candidate comm names are `hermes` and Python interpreter names (`python`, `python3`, versioned Python). Selected entrypoints are Hermes comm/executable, Python console-script `hermes`, and `python -m hermes`, `hermes_cli`, or the installed `hermes_cli.main`, including attached/grouped `-m` (`-mhermes_cli.main`, `-um hermes_cli.main`, `-Bumhermes_cli.main`) and interpreter switches before the entrypoint (`-u`, `-I`, `-B`, `-W`, `-X`, `--check-hash-based-pycs`). Grouped `-W`/`-X` consume the rest of their argv element or the next element, not a subsequent module. Python `-c` source, stdin, and unrelated script arguments are not interpreted as entrypoints; unsupported switches before a possible Hermes entrypoint produce incomplete visibility rather than empty success. Readable unrelated Python commands and noncandidate comms are excluded. An unreadable candidate command is **incomplete visibility**, not an excluded process. Duplicate PID entries are deduplicated.

Each metadata read is capped at 16 KiB; enumeration is capped at 100,000 entries. Enumeration and parsing run in a child bounded by `org/runtime.ts`'s probe budget, whole-run deadline, cancellation and stdout cap. Only sanitized attribution facts cross stdout; raw argv/environment and exception messages do not. Timeout terminates only the spawned probe process group, never an observed process. There is no production fixture/environment bypass.

Attribution uses the complete registered profile map, even for `--agent`. Supported selectors include `--profile name`, `--profile=name`, `-p name`, and the compatibility `--profile-name` forms, including selectors after an action. Interior empty NUL-separated argv values are preserved so an empty model/query value does not swallow a later selector. Value-taking options, `--`, and `mcp add --args` prevent nested payloads/prompts becoming identity evidence. Multiple or invalid identities, foreign/invalid `HERMES_HOME`, and shared-root/profile contradictions remain host-scoped; no employee is guessed. Unknown values are redacted.

Topology permits at most one shared gateway and any number of consistently attributed worker/interactive processes. A passing shared gateway must prove `HERMES_HOME` equals the declared shared root, without foreign or employee-profile claims. The installed launcher's explicit `--profile default` at that root is supported. Foreign, unregistered, missing-identity and duplicate gateways are non-pass host findings. A successfully observed empty set is complete observation, not evidence that a required service is running; service availability remains the systemd observer's job.

## Persistent regressions

`tests/live-process-regressions.mjs` exercises the parser and **built CLI** with a test-only OS preload inherited by the real bounded probe child. It covers each repaired defect: interior empty model/query values with sole, repeated, and conflicting selectors; attached, separated and grouped Python `-m` and console entrypoints after boolean and value-taking switches; unknown interpreter options producing uncertainty; `-c`, stdin, `--` and unrelated script payload boundaries; and four real owned Python startup children (separated, attached, grouped and grouped-attached module) whose actual `/proc` comm/cmdline/environ are read before importing Hermes. It also invokes native `/usr/bin/python3` on four valid module-option spellings. Only task-owned startup children are terminated and reaped. It covers denied Python identity, equals/short/repeated/after-action selectors, foreign/invalid homes, unregistered and foreign gateways, legitimate multiprocess layouts, nested argv and prompt boundaries, duplicate registry claims/PIDs, empty/denied/exited/oversized metadata, aggregate domain/health rollups and remaining Bloodbank/release-provenance observations. Human/JSON/stderr planted-secret checks, recursive content/mode/mtime fixture snapshots, and side-effect guards run on success and failure. Only the observer's own spawned probe may be terminated.

The current attached/grouped-option focused run measured a real synchronous ten-second fixture read at 52 ms under a 50 ms probe budget; cancellation returned `CANCELLED` in 101 ms and an 80 ms whole-run deadline returned `TIMEOUT` in 82 ms. These are measured results, not mocked clock assertions. Probe-spawn failure remains incomplete rather than empty-success. The suite is registered in `scripts/run-tests.mjs`.

## Actual checks

| Check | Exit | Result |
| --- | ---: | --- |
| `npm run typecheck` | 0 | Both workspaces |
| `npm run build` | 0 | CLI and MCP bundles |
| `node tests/live-process-regressions.mjs` | 0 | Empty-argv and Python grouped/attached/values adversarial parser/CLI cases; four owned real `/proc` startups; safety/budget checks |
| `node tests/fleet-contract-regressions.mjs` | 0 | Contract/authority suite |
| `node tests/fleet-status-regressions.mjs` in isolated initialized repaired candidate | 0 | 54 passes; two operator-live-registry cases skipped |
| `node tests/fleet-health-regressions.mjs` in isolated initialized repaired candidate | 0 | 30 passes, no skips; deterministic empty-process fixture, CLI/MCP and baseline assertions |
| Same status suite against pre-feature `c360fae` with identical fixture adjustments | 0 | No failures; same two live cases skipped |
| Same health suite against pre-feature `c360fae` with identical fixture adjustments | 0 | No failures/skips |
| Bounded live review with `--deadline-ms 5000` | 0 | 488 ms; incomplete visibility honestly reported |
| `git diff --check` | 0 | No whitespace errors |

The full repository `npm test` was not run; no claim is made about unrelated suites. The isolated status/health and paired baseline rows are earlier evidence from before the attached/grouped parser repair, not reruns; deterministic empty-process fixtures are unaffected by the interpreter selector change. The prior bounded host review was not rerun. No board writes, integration, service changes or observed-process cleanup occurred.

### Round-three isolated status/health run

`/home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume13-round3-evidence/` contains a fresh local shared-object candidate clone initialized at the pinned template gitlink, with the repaired parser copied in before building. `flume13-round3-suite.py` in profile scratch records the setup and commands; `fleet-status.log`, `fleet-health.log` and `*-result.json` record 54 status passes/two live-registry skips and 30 health passes/no skips. A scratch-only `/usr/bin/python3` symlink supplies PyYAML for the renderer. This is an isolated candidate verification, not a rerun of the pre-feature baseline. No prior reviewer artifacts were overwritten.

### Isolated baseline reconciliation

Evidence directory: `/home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume13-repair-evidence/`. Reviewer-owned artifacts were not overwritten. `base/` and `candidate/` are task-owned local shared-object clones; each template was cloned locally and checked out at **17b5217438cabd9cdfee12fa24d398c000a7455c**. No remote fetch/provider write was needed. The candidate source/tests were copied into the scratch candidate before building. Suites do not share their fixture trees. The same test-only empty process source and Bloodbank deferral assertions are used on both revisions, so concurrent host processes cannot alter byte-equality or adapter comparisons.

The initial initialized run reproduced **8 status failures on base and candidate**: no-live audit-fed state; host-only fail isolation; project-warn isolation; hung-child state; missing-CLI state; observation-cap health; audit-child budget; clean-slice health. Initial health also reproduced **8 on each**: fully authorized healthy fleet; one authorization removed; declared deferral; removed deferral; exit-category projection; failing/incomplete member classification; deferred member classification; agent-exception classification. Full paired assertion stacks remain in `base-fleet-status.log`, `candidate-fleet-status.log`, and `base-fleet-health.log`; `base-clean-health.json` / `candidate-clean-health.json` captured the root cause during diagnosis: `profiles.{profile_name}.config.yaml: renderer-pyyaml-missing` for both employees. These were not waived or masked.

Using a scratch-only `test-bin/python3 -> /usr/bin/python3` (3.13.7 with PyYAML 6.0.3) ahead of PATH resolved the renderer prerequisite without installing/changing any host runtime or production profile. Final results are in `base-fleet-status-final.log`, `candidate-fleet-status-final.log`, `base-fleet-health-final.log`, `candidate-fleet-health-final.log` and the corresponding `*-result.json`: **zero baseline failures, zero new failures**. The scratch scripts `flume13-repair-paired.py` and `flume13-repair-suite.py` beside the evidence directory record setup and commands. An earlier combined run exceeded the terminal's 600-second ceiling during the fourth suite; that partial log is superseded by separately completed suite runs. Background launch attempts were rejected by shell initialization/TMPDIR rewriting; final runs used explicit profile scratch TMPDIR and foreground execution.

## Live reconciliation

At `2026-11-18T15:33:55Z`, the bounded read-only review's selected PIDs were **5339, 697075, 1897468**, identical to sanitized independent samples immediately before and after. Every stable selected PID appeared once; `stable_selected_missing` was empty. PID 697075 proved the shared-root gateway; PID 5339 was an unattributed interactive process; PID 1897468's identity metadata was denied. Two transient comm reads (1174160, 1174161) failed and remained explicit host read errors. The host summary reported three selected processes, one shared gateway and three read errors (including the selected PID's environment error). No employee was guessed. `health.healthy`, `complete`, and `proven` were all false.

`live-review.json`, `live-review.stderr` and `live-reconciliation.json` retain the bounded result and sanitized sample. This is live **uncertainty**, not a claim that the host runtime is healthy. No observed process was signalled, drained, restarted or modified.
