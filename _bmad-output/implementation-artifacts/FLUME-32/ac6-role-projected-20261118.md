# FLUME-32 AC6 — role-projected live fallback

**Verdict: PASS (isolated desk ingress, not multiplexed Bloodbank).**

## Receipt

- Evidence: [`ac6-role-projected-20261118.json`](ac6-role-projected-20261118.json).
- Executed at `2026-11-18T23:26:49Z` from pushed source commit `d6601ebb43f6758dadf8c8e1b063ecf330053c37`.
- Installed Hermes: `d6100d8bda1af8c7f1ca121a7f99a29112c62045`; renderer template: `96e7e288026782358584b9b85c764659d240ee0d`.
- Gateway log **1006749**, request **202611182326544908510298268d9d6othtUQIR**.
- Unique prompt marker: `AAI_ROUTE_PROOF_169213cb3886f924478b5c50b9f04db2`.
- Consumer: **hermes-flume-pm**, using its existing mapped credential reference, not the shared employee token. No provisioning or rotation.
- Successful first fallback: **automaticai/personal/sol-6.1**, account **openai-personal**, native model **gpt-6.1-sol**, channel **8**.
- Actual wire and ledger reasoning effort: **medium**. `automaticai_effort_defaulted=false`. The configured provider `extra_body.reasoning_effort: xhigh` is **not** evidence that xhigh ran.
- HTTP **200**, streamed response completed, **761 prompt / 5 completion tokens**, quota **0**. Final answer is retained only as a SHA-256 digest.

## What makes this projection proof

The runner creates a fresh test desk under the assigned profile's scratch directory, using the existing member name only for credential attribution. It does not alter the real member desk.

1. A real `roles/ac6.md` declaration supplies the ordered chain:
   `automaticai/personal/kimi-k3` → `automaticai/personal/sol-6.1`.
   Routes are explicit invocation inputs, not embedded source defaults. Both exist in the deployment catalog and the member-authenticated `/v1/models` response. Only subscription routes are allowed by this runner.
2. `scripts/ac6-project-role.mjs` imports the checkout's real `readRoleDeclaration` and `projectRoleDeclaration`. The projection invokes the normal authenticated catalog checker; it does **not** pass the test-only `catalogModels` bypass. The normal locked renderer writes the scratch delta, generated config and managed projection state.
3. The scratch base intentionally contains a different chain (Sol primary, no fallbacks). This prevents inheritance alone from satisfying the role projection assertion. The projection reports no desk overrides.
4. A fresh process sets `HERMES_HOME` to the generated desk. Installed Hermes `load_config`, provider resolution, and `get_fallback_chain` consume that config. `AIAgent.run_conversation` is called using those resolved primary/fallback values. No fallback activation function is invoked manually and no successful response is mocked.
5. A process-local HTTP transport interceptor returns HTTP 503 only for the declared primary. Three primary attempts are observed and none reaches the gateway. Hermes activates fallback index **1** and sends exactly one real first-fallback request to **https://api.automaticai.io/v1/chat/completions**. Later fallbacks, other hosts, extra inference requests and output limits above 512 tokens are refused.
6. The completed gateway ledger row matches the unique prompt marker, actual response request ID, member consumer, canonical route, account and native model. Configuration-only output, an unrelated request, a missing ledger or the old seam-only receipt cannot pass the gate.

The exact generated config SHA-256 is
`a6433234986104f0b334d99ce57873ebd7aabdbf5545b69ffe775f434c8ea9e8`.
The receipt records the same hash when Hermes loads it and checks that runtime did not rewrite it. It includes the role source, generated config, delta and managed projection state, all reference-only and secret-free.

## Ingress boundary and effort

This acceptance uses the explicitly permitted **isolated installed Hermes agent reading a role-projected desk**. It proves that path, not Telegram, Slack or multiplexed Bloodbank dispatch. The projection labels its scope `desk-gateway`. Multiplexed Bloodbank refreshes fallbacks from the shared gateway process's config; this receipt does not claim that a desk override controls that ingress.

The historical `live-fallback-20261005.json` remains `PASS_SEAM_ONLY` and is not reused. Its GLM/max/defaulted observations are not current defaults: GLM was absent from this member's authenticated model catalog. The new receipt reports the actual medium/non-defaulted behavior of this installed Hermes version instead of inferring effort from provider extra_body.

## Validator-only revision (after the dated live run)

The runner now compares a non-null outbound `reasoning_effort` with the ledger's `requested_effort` even when `effort_defaulted: true`. When the outbound field is absent, it instead requires `effort_defaulted: true`; this does not claim that configured `extra_body` reached the wire. Offline fixtures cover the formerly accepted wire `medium` / ledger requested `xhigh` tampering and genuine absent-wire defaulting. This is a validation-only revision, not a new inference or a replacement live receipt. The original snapshot remains [`ac6-role-projected-20261118.json`](ac6-role-projected-20261118.json), whose `runner_sha256` identifies the runner that produced it. The original medium/non-defaulted observations above are unchanged; no new live execution or contemporary ledger verification is claimed.

## Reproduce

Prerequisites: initialized pinned `templates/hermes-agent` submodule; Flume's Node dependencies; installed Hermes Python with `httpx`, `openai`, and `PyYAML`; read access to the member's existing 1Password reference and the gateway ledger PAT. No gateway-administration skill payload is required. The gateway skill was quarantined during this task and was not read through another path.

```sh
PY=/home/delorenj/.hermes/hermes-agent/.venv/bin/python
PYTHONDONTWRITEBYTECODE=1 "$PY" tests/ac6-projected-fallback-regressions.py
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/ac6-live-projected-fallback.py \
  --live --profile flume-pm \
  --chain automaticai/personal/kimi-k3 automaticai/personal/sol-6.1
```

Those route arguments describe this dated proof only. Recheck both current catalogs before choosing routes for another run. The runner returns a secret-free JSON summary with `PASS` or `BLOCKED` and its fresh scratch receipt path. Without `--live` it refuses before creating state or sending inference. Each invocation permits one real fallback inference, bounded to 512 output tokens and a 110-second Hermes deadline by default; the read-only ledger stage has its own 60-second ceiling.

Read-only independent ledger verification, without a new inference request:

```sh
python3 /home/delorenj/docker/stacks/ai/newapi/ops/gateway-proof.py check \
  --marker AAI_ROUTE_PROOF_169213cb3886f924478b5c50b9f04db2 \
  --since 1795044410 \
  --route automaticai/personal/sol-6.1 \
  --account openai-personal \
  --token-name aai:hermes-flume-pm:1790777406434714921 \
  --request-id 202611182326544908510298268d9d6othtUQIR
```

## Verification and limits

- Offline runner regressions: **11 tests PASS**, including 19 receipt-tampering subcases and host/order/token/retry-bound refusal checks. Fixture HTTP responses in these unit tests are explicitly not live evidence.
- `node --check scripts/ac6-project-role.mjs`: PASS.
- `git diff --check`: PASS.
- Live run from the pushed source revision: **PASS**, as recorded above.
- Before/after hashes for the real fleet base, member config and delta, registry, org chart, and deployment catalog are identical. No live profile/default/catalog edits, service restart/reload, employee rerender, token mutation, board write or schedule was performed. Credentials are resolved into process memory; raw runtime output is suppressed and no secret is committed.
- The full unrelated Flume suite was not rerun by this AC6-only worker. This receipt does not re-certify AC1–AC5 or authorize integration. Independent review and integration remain with the parent PM.

Authoritative runtime documentation consulted: [configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration/) and [configuring models](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models).
