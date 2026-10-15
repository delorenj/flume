# FLUME-53 live canary procedure (supervisor-owned)

Nothing in this file has been executed. The build session wrote it and ran no live command. It holds IDs, `op://` references and commands only;
no secret value belongs in it or in anything it produces.

Subject: **Rererere** (registry post id as listed by `flume roster`; the commands below use `rere-pm`, native Plane user `ba82e3bd-9b21-4066-9737-bd6279cf00f7`, Plane PAT
`op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/gwxsutraup26mm4h7vkqj64ivu`). Rererere is the sandbox employee. **Grolf is not canaried.**
Retire is terminal and `grolf` is the 33GOD PM, so the retire step below uses a disposable enrolled employee or is recorded as not run.

Every command below is a preview without `--apply`. Run the preview first, read it, then apply.

## Gates (all must hold, or record the exact blocker and do not report the story fully accepted)

| gate | proves | evidence required |
|---|---|---|
| G0 | the rebuilt Flume origin is running and the Worker's mail route reaches it | the Worker no longer passes through a 404 for `/v1/mail/authorize` |
| G1 | a suspended employee is denied at the facade, in access AND mail, with the same run assertion | `employee-suspended` on both, `evidence` is not `fixture` for the provider rows |
| G2 | the mailbox allowlist key is removed and restored byte-identical | KV `allowlist/rererere@agents.delo.sh` absent after suspend, present and equal after restore |
| G3 | every credential row carries provider evidence | every row `evidence: "provider"` in `flume identity credentials rererere --json` |
| G4 | restore returns the employee to service with provider evidence | access request granted, `flume mail list` returns only Rererere's messages |
| G5 | receipts join the real runs | `flume access receipts --employee rererere --json` shows one subject and the live `run_id`s |
| G6 | gateway attribution is linked to FLUME-39 evidence | `gateway.evidence_status` is `present`; otherwise record the blocker below |

## 0. Preconditions (supervisor)

1. The build is on Flume `main`. Rebuild and restart `flume-access.service` (the origin that answers `/v1/mail/authorize`). Deploy the origin BEFORE exercising mail:
   the agents-facade Worker (`agents-facade/src/index.ts`) already calls the route and passes the origin's answer through.
2. `flume identity readiness --json | jq -r .checks.employee_lifecycle_canary.status` is `unproven` before this procedure, and stays `unproven` until you decide G0 to G6 hold.
3. `FLUME_PROVISION_CONFIG` points at the live `identity-provisioning.yaml`; `op` is signed in as the DeLoSecrets service token; none of `FLUME_CLOUDFLARE_API_BASE`, `FLUME_GITHUB_API_BASE`,
   `FLUME_PX_BIN`, `FLUME_GATEWAY_TOKENS_BIN` is set (any of them makes the evidence `fixture`).
4. FLUME-39 status: at the time of writing FLUME-39 is Backlog and no evidence directory exists at `_bmad-output/implementation-artifacts/FLUME-39`. G6 cannot hold until it does.

## 1. Baseline

```
flume identity show rere-pm
flume identity credentials rere-pm --json > /tmp/rererere-credentials-before.json
flume identity continuity rere-pm --record --apply
flume access run rere-pm -- flume access request --service fixture --resource repo:alpha --permission read
flume access run rere-pm -- flume mail list
```

Record the `run_id` the facade logged (`flume access receipts --employee rere-pm --json | jq .run_ids`).

Snapshot the allowlist record, for the G2 comparison (GET only; token `op://DeLoSecrets/Cloudflare/globalAPIToken`, account and KV namespace from `FLUME_PROVISION_CONFIG`):

```
curl -s -H "Authorization: Bearer $(op read op://DeLoSecrets/Cloudflare/globalAPIToken)" \
  "https://api.cloudflare.com/client/v4/accounts/<account_id>/storage/kv/namespaces/<kv_namespace_id>/values/allowlist%2Frererere%40agents.delo.sh" | jq -S . > /tmp/rererere-allowlist-before.json
```

Start ONE launched child that keeps its environment across the suspension (this is what G1 needs: the SAME run assertion, since a new `flume access run` is refused by the launcher before it reaches the facade):

```
mkfifo /tmp/rererere-canary.fifo
flume access run rere-pm -- sh -c '
  flume access request --service fixture --resource repo:alpha --permission read > /tmp/rererere-before-access.json
  flume mail list > /tmp/rererere-before-mail.json
  read go < /tmp/rererere-canary.fifo
  flume access request --service fixture --resource repo:alpha --permission read --request-id after-suspend > /tmp/rererere-after-access.json
  flume mail list > /tmp/rererere-after-mail.json
' &
```

## 2. Suspend (reversible adapters only)

```
flume identity suspend rere-pm                                 # preview
flume identity suspend rere-pm --revoke github --apply --json  # sandbox installation only; do NOT revoke cloudflare_access or gateway on Rererere
```

Do not pass `--revoke cloudflare_access` or `--revoke gateway`: those deletions cannot be undone by restore.

Gate checks. Release the launched child from step 1 so it retries with its SAME environment (same Access client and run assertion), then confirm both calls were denied:

```
echo go > /tmp/rererere-canary.fifo
wait
jq -r .code /tmp/rererere-after-access.json /tmp/rererere-after-mail.json   # employee-suspended, employee-suspended
```

A NEW launch must now be refused by the launcher itself (this is not G1, it is the second half of AC1):

```
flume access run rere-pm -- flume mail list    # Launch refused: rere-pm is suspended
```

G1 and G2 are read from the facade audit (`outcome: employee-suspended`, events `access.request` and `mail.authorize`) and from the lifecycle ledger.
Confirm with the same GET as in step 1 that the allowlist key now answers 404.

## 3. Credentials read-back

```
flume identity credentials rere-pm --json
```

Expect: mail `suspended-reversible`; installation `suspended-reversible`; Access, App key, Plane PAT and gateway `static-usable` or `residual-expiry`; `complete_revocation: false`.
If any row says `evidence: "fixture"`, G3 fails: record which override leaked in.

## 4. Restore

```
flume identity restore rere-pm                    # preview
flume identity restore rere-pm --apply --json
flume access run rere-pm -- flume access request --service fixture --resource repo:alpha --permission read
flume access run rere-pm -- flume mail list
```

G4: both succeed, the installation is un-suspended (`suspended_at` null). G2: repeat the step 1 GET into `/tmp/rererere-allowlist-after.json` and compare: `diff <(jq -S . /tmp/rererere-allowlist-before.json) <(jq -S . /tmp/rererere-allowlist-after.json)` is empty.

## 5. Rotation (only if a spare credential exists)

```
flume identity rotate rere-pm github --credential-ref op://DeLoSecrets/<new-item-uuid>/<new-field-id>           # preview: writes nothing
flume identity rotate rere-pm github --credential-ref op://DeLoSecrets/<new-item-uuid>/<new-field-id> --apply   # continuity reports `rotated` only after this
flume access github-inspect --employee rere-pm
flume identity continuity rere-pm --json                                                                           # github.credential_ref rotated, everything else stable
```

Delete the old key in the GitHub App settings by hand (the old ref is reported `manual-action-required`), then `flume identity credentials rere-pm` must show the old probe unaffected and the new key `static-usable`.
No spare credential: record "rotation not canaried: no spare credential" and do not claim it.

## 6. Retire (disposable employee only)

Retire is terminal. The disposable employee must first be provisioned and bound to THROWAWAY credentials, otherwise only `not-issued` paths run and nothing is proven:

```
flume identity enroll <disposable> --apply
flume identity provision <disposable> --apply                 # Access service token, routing rule, allowlist key, vault item
flume identity bind <disposable> github --principal <throwaway-app-id> --instance <throwaway-installation-id> --credential-ref op://DeLoSecrets/<throwaway-item-uuid>/<field-id> --apply
flume identity bind <disposable> plane --principal <throwaway-plane-user-uuid> --instance https://<host>/<workspace> --credential-ref op://DeLoSecrets/<throwaway-item-uuid>/<field-id> --apply
flume identity credentials <disposable> --json                # every row except gateway must be a real provider row, not not-issued
flume identity retire <disposable> --revoke all --apply --json
flume offboard <disposable> --apply
flume identity enroll <another-post> --handle <disposable-handle>          # must answer handle-tombstoned
```

Skip, and record "retire not canaried: no disposable employee", if none exists.

## 7. Receipts

```
flume access receipts --employee rere-pm --json
flume access receipts --run <run id from step 1> --json
```

G5: one subject, the live `run_id`s, grants, `mail` authorizations, the `employee-suspended` denials and the suspend/restore `operation_id`s.

## 8. Close-out

Write `_bmad-output/implementation-artifacts/FLUME-53/live-canary-<date>.md` with the commands run, each gate G0 to G6 as held or failed, and for any failed gate the exact blocker.
Only if G0 to G6 all hold: the receipts carry `evidence: "provider"` and AC5 is met. Otherwise the story is not reported fully accepted.
`employee_lifecycle_canary` in `flume identity readiness` is a static list and stays `unproven` by design; the receipt is the proof.
