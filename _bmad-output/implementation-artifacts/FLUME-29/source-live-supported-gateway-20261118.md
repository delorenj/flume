# FLUME-29 — supported gateway live acceptance

Recorded November 18, 2026. **PASS: infra-specialist and n8n-specialist each completed native Hindsight retain, then native recall in a separate fresh session. Both final scoped audits remain in good standing.** No application code or runtime policy changed; no board writes were made.

This is an additive continuation of [landed-source verification](source-live-acceptance-20261118.md) and [projection convergence](source-live-continuation-20261118.md). Their earlier failures remain historical evidence, not current blockers.

## Corrected bounded invocation

Read the installed `hermes_cli/gateway_chat.py` before retrying. It supports one-shot operation, stream JSON and `max_turns`, but explicitly refuses `run_budget`. The previous `--run-budget` failure was an invocation error, not an external dependency.

With the parent's explicit authorization, every run used the maintained public path:

```text
flume launch <employee> --cwd /home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume29-live-proof -- chat --oneshot --format stream-json --max-turns 8 -q <inspection-only prompt>
```

A Python subprocess supervisor imposed a **300-second external wall timeout** per invocation. No timeout fired. No `--resume`, continuation name, local/safe-mode fallback, provider/model override, persistent run-budget edit, account change or service restart was used. Both target configs kept `agent.run_budget_seconds` unset/null; gateway defaults were not changed. Initial remote main matched Flume `fe21461e7acbc59a190eb0d0bf5aee7c006d4ca9` and template `96e7e288026782358584b9b85c764659d240ee0d`.

## Actual native proof

The first prompt requested a harmless **employee-attributed** inspection-checklist preference with an employee-specific historical marker. It authorized only own-bank native memory retention plus inspection. It prohibited infrastructure/system changes, deployment, workflow mutation/execution, file/credential writes, service control and scheduling.

The second public invocation created a different session. Its prompt supplied only the employee identity and historical search marker, **not the preference or checklist order**. Actual native `hindsight_recall` results returned the retained ordering: scope, dependencies, rollback, then verification before proposing infrastructure or workflow changes. The first two returned entries for each employee explicitly include its current marker. These are tool results, not assistant-only claims.

| Live check | infra-specialist | n8n-specialist |
| --- | --- | --- |
| Retain invocation | exit 0; 81.03 seconds | exit 0; 50.73 seconds |
| Native `hindsight_retain` result | `Memory stored successfully.` | `Memory stored successfully.` |
| Fresh recall invocation | exit 0; 30.67 seconds | exit 0; 26.13 seconds |
| Native `hindsight_recall` result | matching preference + employee marker | matching preference + employee marker |
| Personal bank | `agent-infra-specialist` | `agent-n8n-specialist` |
| Runtime identity | employee profile; `source: oneshot`; no parent session | employee profile; `source: oneshot`; no parent session |
| Actual terminal CWD | expected unrelated scratch directory; exit 0 | expected unrelated scratch directory; exit 0 |
| Native role/shared skill loads | `systemd-agent-service-diagnostics` + `delonet-conventions`, successful | `n8n-mcp-tools-expert` + `delonet-conventions`, successful |
| Scoped audit before and after | exit 0, in good standing, no problems | exit 0, in good standing, no problems |

Read-only lookup of these four exact runtime session rows independently verified the profile, fresh distinct IDs, one-shot source, absent parent and frozen CWD. Their actual system prompts contain the correct employee charter, personal bank, every designated role skill and shared guidance. Only focused booleans/excerpts and prompt hashes are published, not private full prompts. The native provider source pins both retain and recall to its configured `_bank_id`; there is no per-call bank override. No additional-bank tool call was made.

**Machine evidence:** [structured receipt](source-live-supported-gateway-receipt-20261118.json) records the four real session IDs, tool-call IDs, scrubbed argv/results, token counts, timings, runtime rows, selected prompt checks, provider-routing source and before/after preservation hashes. These details were not posted to ticket comments. Broad unrelated recalled history is omitted from the public receipt; the first two matching native entries are preserved verbatim, with hashes of the capped raw outputs. Full scrubbed streams remain in active-profile scratch.

## Acceptance coverage

| Criterion | Current evidence and limit |
| --- | --- |
| Identity validation / mutation boundaries | Previously landed source tests remain verified; this run adds actual employee-profile session records. No second identity contract. |
| Explicit desk step 10 | Previously verified real entrypoint safety/no-op tests; unchanged in this live-only run. |
| Arbitrary-CWD charter, curated role skills plus shared guidance, own bank | **Live verified for both:** actual system-prompt checks, successful native skill loads, terminal `pwd`, frozen runtime CWD and own-bank native memory calls. Curated role lists coexist with inherited shared guidance; no obsolete four/fourteen-total-skill expectation. |
| Deterministic refresh | **Previously live verified:** second onboarding `changed: false`, empty projection changes and identical owned file/link/inode/mode/mtime manifests. [State proof](source-live-continuation-state-proof-20261118.json) retained; current before/after scoped audits still pass. |
| infra-specialist native retain then fresh-session recall | **Passed now**, actual streamed native results in two distinct sessions. |
| n8n-specialist native retain then fresh-session recall | **Passed now**, actual streamed native results in two distinct sessions. |

## Preservation and limits

- Exact before/after guard manifests match: shared base, every profile's config/delta pair, target employee definitions/company identities, registry, memory-routing configs and member credential references. **No generated config or existing delta changed in this retry.** Normal session/history/log and configured memory-provider automatic retention effects are not excluded by changing policy; they are expected runtime effects.
- Employee member credentials were resolved only in memory for output redaction; no value was logged, persisted or borrowed. No accounts/tokens, model routes, service state, schedules or other employees' policy were changed.
- Existing modified `bloodbank-events.jsonl` and untracked provisioning spec were preserved and excluded from publication. Earlier source/live evidence was not edited. Only new acceptance evidence is committed by explicit path.
- Native retain returns a success string without operation/document IDs. Native recall formats textual facts without source IDs; result positions are **not** source identifiers. No identifiers are invented, and their absence does not erase the actual fresh-session retrieval proof.
- The stream formatter caps individual tool output at 5,000 characters; the matching recall entries precede that cap. No HTTP/CLI memory substitute, synthesized result or historical receipt was used as fresh proof.
- No new implementation suite was rerun because no application code changed. Prior landed-source test results remain linked, not re-labelled as fresh runs. Existing advertised-name collision R2 and unrelated/global workforce coverage remain outside this acceptance slice.

**Current runtime blocker: none.** The parent owns the ticket lifecycle transition; this worker made no board change.
