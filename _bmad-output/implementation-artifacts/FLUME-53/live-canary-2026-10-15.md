# FLUME-53 live canary receipt, 2026-10-15

Secret-free: IDs, `op://` references, timestamps and outcomes only. Raw machine output is in `evidence/`
(scanned for PEMs, JWTs, `sk-`/`ghs_`/`ghp_` shapes, and for the literal values of Rererere's Access secret, Plane PAT and
gateway token, Grolf's Plane key and the provisioning token: none present, here or in `~/.local/state/flume`).

Operator authorization for this run: sandbox canary on Rererere, a disposable throwaway employee for the retirement proof, a test
mail to Rererere's own address, and read-only inventory of Grolf. Grolf's credentials were **not** suspended, revoked or rotated.

## Verdict

**Not fully accepted.** AC1, AC3 and AC4 hold live for Rererere's mail, Access, Plane and gateway bindings and for both harnesses. Three
gaps remain, each with an owner and an exact next action (see "Gaps"). The story is left in QA with this receipt, not closed.

## Build under test

| item | value |
|---|---|
| Flume main | `cc93a25` (first review fixes) then `4121abb` (second review fixes) then `078a429` (real-op dialect), all pushed |
| `flume-access.service` | restarted 2026-10-15T05:18:55Z on `cc93a25`, again after `4121abb` and `078a429` |
| agents-facade Worker | version `1e8cf557-d0f7-4d09-8ada-cb7bfdb18a6f`, route `identity.delo.sh/*`, mail route `POST /v1/mail/messages` (parent `261d458`) |
| Every provider row | `evidence: provider` (none of `FLUME_CLOUDFLARE_API_BASE`, `FLUME_GITHUB_API_BASE`, `FLUME_PX_BIN`, `FLUME_GATEWAY_TOKENS_BIN` set) |

Path exercised: client -> Cloudflare Access (service token) -> `agents-facade` Worker -> Traefik -> `flume access serve`, and for mail
the Worker then reads R2 only after the origin's `/v1/mail/authorize` answers `authorized` for the verified handle.

## Gate results (G0 to G6 from the procedure)

| gate | result | evidence |
|---|---|---|
| G0 origin and Worker reach `/v1/mail/authorize` | held | direct origin call without an Access assertion answers 401 (was 404 before the build); mail list through the Worker returns 200 |
| G1 suspended employee denied in access AND mail with the SAME run assertion | held, 3 episodes | plain runs `be4e1517-b84a-4e96-b5f6-dffb4e8d1ce5`, `6a48d61e-3120-4566-acb8-076325845fc0`, `7ecce456-6c57-40de-be70-4fa29db3d320`; Hermes run `41b173ea-460b-4ebc-bd57-cec5a6f60281`: `employee-suspended` on both `access.request` and `mail.authorize`; a new `flume access run` is refused: `Launch refused: rererere is suspended` |
| G2 allowlist removed then restored byte-identical | held, 3 cycles | KV `allowlist/rererere@agents.delo.sh`: 200 -> 404 after suspend -> 200 after restore; `jq -S` diff against the baseline is empty each time (`evidence/rererere-allowlist-before.json` vs `-after3.json`) |
| G3 every row carries provider evidence | held | `evidence/rererere-credentials-*.json`: every row `provider` |
| G4 restore returns the employee to service | held | fresh grant `20ee1d7e-7e7e-4350-b400-a36366c06d2b` and `flume mail list` count 1 after the last restore; status `active`, `status_changed_at` 2026-10-15T06:27:06Z |
| G5 receipts join the real runs | held | `evidence/rererere-receipts-final.json`: one subject, 12 run IDs, harness `plain` and `hermes`, six lifecycle `operation_id`s |
| G6 gateway attribution linked to FLUME-39 evidence | **not held** | attribution is proven by the gateway's own usage log (below), but FLUME-39 is Backlog and `_bmad-output/implementation-artifacts/FLUME-39` does not exist, so `gateway.evidence_status` is `unverified` |

## AC1: suspension, immediate denial, every credential listed

Canary: Rererere (subject `1dca27f5-06e8-47a3-86c9-49bc3ed5331c`, handle `rererere`, address `rererere@agents.delo.sh`).
A sandbox `fixture` grant for `repo:alpha` read was added to `employee-access.yaml` for the run and **removed afterwards** (a request now
answers `approval_required`).

Operations (suspend applied with no `--revoke`, because those deletions cannot be undone by restore):

| operation | id | at |
|---|---|---|
| suspend | `48ebf50a-a748-4635-b0ec-582182cd0336` | 05:24:52Z to 05:24:54Z |
| restore | `c98a3e65-ec55-4422-a781-f6638ea43b01` | 05:26:17Z to 05:26:20Z |
| suspend | `57562e66-a545-4e8d-a0bd-0bd47024b3aa` | 05:27:01Z to 05:27:04Z |
| restore | `1d02e71b-88ab-4580-b300-a844a99b394b` | 05:27:46Z to 05:27:49Z |
| suspend (final build) | `cb653709-ee26-44ab-b282-fe0f1eaa0400` | 06:26:53Z to 06:26:56Z |
| restore (final build) | `4bdf0032-12a3-4631-a52a-1347a382c3a5` | 06:27:05Z to 06:27:08Z |

Measured denial window (episode 2, facade audit): the suspend operation closed at 05:27:04.530Z and the first request made afterwards, by the held plain run, was
denied at 05:27:04.997Z (access) and 05:27:05.360Z (mail), 0.47 s later. The held Hermes run's requests were denied at 05:27:16.098Z and 05:27:16.805Z. The facade
reads status per request, so there is no propagation window; the only delay in each case is when the child chose to ask. Residual windows that remain after suspend
are in the inventory below (Access token to 2027-10-13, gateway token none, Plane PAT static, installation tokens at most 1 h).

Mail while suspended: a test mail sent through Resend to the address (id `01a13e06-0f03-727e-bf5f-d3077ea2706f`) read back
`last_event: bounced` within 25 s (the allowlist key was gone, so the Worker rejected it at SMTP time). It was never stored.

Credential inventory read back from the providers while suspended (`rererere-credentials-suspended.json`) and on the final build
(`rererere-credentials-final-build.json`):

| provider | kind | status | residual or manual action |
|---|---|---|---|
| mail | mailbox-allowlist | `suspended-reversible` while suspended, `static-usable` when active | KV key deleted and read back 404; restore re-puts it |
| cloudflare_access | access-service-token `bfb08e3f094e26eba7f2dcf9cd42812a.access` | `static-usable` | valid at Access until 2027-10-13T09:39:48Z unless `retire --revoke cloudflare_access`; the facade still denies by status. Not deleted: the canary must be restored |
| github | app-private-key | `not-issued` | Rererere's App 5296560 has no installation (see Gaps) |
| plane | plane-personal-access-token | `static-usable` | the PAT is static, its expiry is not observable; revocation is the owner deleting it or an admin removing board membership (`px` has no revoke verb) |
| gateway | gateway-token `75` (`hermes-rererere`, ref from the generated config) | `static-usable` | no expiry (`expired_time -1`); `retire --revoke gateway` would run `gateway-tokens.py revoke hermes-rererere`; not run because it destroys the canary's token |
| gateway | launcher reference `op://DeLoSecrets/hermes-rererere/credential` | `not-issued` | the vault item does not exist, so the specialist launcher injects no key (see Gaps) |

`complete_revocation` was `false` throughout, as it must be while a static key is usable. The command printed `revocation INCOMPLETE`.

Grolf, read-only (`rererere-credentials-grolf-final.json`, no mutation): real GitHub rows from the live App 5296475 (App key probed with an app JWT,
installation 170872985), Access `static-usable` until 2027-10-13T09:39:43Z, Plane `static-usable`, gateway `residual-expiry` until
2026-12-29T14:11:19Z. No issued-token rows because every FLUME-50 installation token has expired (1 h maximum).

## AC2: real provider revocation, convergence, honesty

Rererere's Access token, GitHub installation and gateway token were deliberately not revoked live. Real provider revocation was proven on a
disposable employee `f53canary` (subject `53d67284-3651-4cf1-8317-3d24e7e94555`) provisioned through `flume identity provision`:

- Created: Access service token `499112fa-ff3d-4509-a126-4d6d6a8bb545` (client `05a89b5d7637c42b6e056f8d3816ba1e.access`), routing rule
  `9b89e1bb1ebe49929f7140f9cb0f8ba6`, KV allowlist key, vault item.
- `identity retire f53canary --revoke all --apply` (operation `14fe6344-1ee2-4688-bdff-dd455bb88463`) succeeded for local status, tombstone, mail allowlist
  delete, routing-rule disable and Access token delete.
- Independent readbacks with the provisioning token (not Flume): the service-token listing no longer holds the client; the routing rule reads
  `enabled:false`; the KV key answers 404.
- A repeat of the same retire changed nothing. `restore` and `identity status active` on the retired employee answer `retired-terminal`.
- `complete_revocation` stayed `false` because the gateway row was `unverified` (`gateway-ref-shape`: the specialist's reference is not the FLUME-39 shape).
  The tool did not claim completion.
- Tombstone: after deleting the definition (the offboard-equivalent) and re-creating one with the same id, enrolling it answered `handle-tombstoned`.
- Cleanup: the throwaway definition, routing rule and vault item (archived) were removed. The tombstone in the lifecycle state remains by design.

Provider outage and retry convergence (one provider failing, successes recorded apart from unresolved, no duplicate DELETE) is proven by the fault-injecting
fixtures only (`company-identity-lifecycle`, 51 scenarios). I did not induce a live outage, which would need a stand-in endpoint and make the evidence `fixture`.
One real fault did appear live: `gateway-tokens.py status` answered `HTTP 429` at login during repeated lookups, and the inventory reported that row
`unresolved` / `provider-unavailable` instead of guessing.

## AC3: continuity

`identity continuity rererere --record` at 05:21:56Z, then three suspend/restore cycles. Final check (`rererere-continuity-final.json`): `status: stable` for subject,
handle, email, `mailbox_prefix` (`mail/rererere/`), Access principal and instance, Plane principal and `native_actor_id`. Historical provenance:
`--comment rererere:2d4fe4fa-c167-4aac-a25b-7cb5c18c72e8` (the PX-13 Plane comment) is `stable`, actor `ba82e3bd-9b21-4066-9737-bd6279cf00f7`
unchanged. The stored test mail (id `3771768ed5302ef93fef97bf0cfe8fe696ab58785b909ee818d9e16443f7b5a5`) is listed with the same id before suspension and after
every restore. No retired address or subject was reassigned; the tombstone test above is the negative case. Credential rotation is covered by the fixtures only (no spare credential
exists; I did not duplicate a secret to fake one).

## AC4: two harnesses, correlated, secret-free

- Plain client: `flume access run rererere -- ...` (harness `plain`).
- Hermes harness: the real Hermes binary under the `rererere` profile, started with `harness: hermes` access minted by the launcher primitive
  (`canary/hermes-harness.ts`). `flume launch rererere` itself refuses (see Gaps), so the driver does what `launchSpecialist` does minus its stale projection audit and
  stale gateway reference. Runs `ae0399e3-e5be-445a-ba5c-c382a7a8baaa` (episode 1) and `41b173ea-460b-4ebc-bd57-cec5a6f60281` (episode 2) were granted and listed mail before
  the suspension; the second run's later requests were denied `employee-suspended` (audit rows above). In episode 1 the model declined the second prompt, so the denial for the
  Hermes harness is proven in episode 2 from the facade audit, not from model text.
- Correlation: `flume access receipts --employee rererere --json` joins `access.request`, `mail.authorize`, denials and `lifecycle.operation` rows by subject, `run_id` and `operation_id`.
- Gateway attribution (actual, not from a config): a unique marker in each Hermes prompt was matched by `gateway-proof.py check` to the gateway's authenticated usage log.
  Episode 1: 3 requests, episode 2: 4 requests (ids such as `202610150526389264856008268d9d6dZqIoRX1`), every `token_name` `aai:hermes-rererere:1791900401673888883`
  (`evidence/gateway-proof-episode*-hermes.json`). `receipts --gateway-proof` marked the proof `verified` for consumer `hermes-rererere`, and left
  `attribution: unverified` because the FLUME-39 evidence directory does not exist.

## Findings from the live run

1. `flume identity provision` crashed on a **new** vault item: `op item create` printed a table, `JSON.parse` threw after the item existed, and an orphan item was left. Fixed (`79311eb`, test now proves it).
2. The lifecycle read the service account's missing-item refusal ("Found 0 item(s) in vault ...") as `vault-unavailable`. Fixed (`078a429`), the fixture op now speaks that dialect.
3. A first `flume mail list` immediately after the Worker deploy answered `fetch failed`; the next calls were fine. Transient edge propagation, not reproduced.
4. `hermes chat` with the profile default model `automaticai/auto` is refused by the member token (`HTTP 403: This token has no access to model auto`); an explicit `-m automaticai/auto/fast` works.
5. Starting Hermes printed a self-update (`Update complete! (v0.21.6+530...dirty)`); not caused by Flume, noted because the Hermes runtime is shared.

## Gaps (why the story is not closed)

1. **Rererere has no GitHub binding.** App 5296560 (`colrerererebot`) still has `installations: []` (polled again at 2026-10-15T06:28Z); the passkey confirmation is the operator's. Until then the
   GitHub leg of AC1 (installation suspend and restore, issued-token residual rows) is proven by fixtures and by Grolf's read-only rows, not by a live canary.
   Next: operator completes the install, then `flume identity bind rererere github ...`, a sandbox grant, one token mint, `suspend --revoke github`, restore.
2. **FLUME-39 has no evidence** (ticket Backlog, no evidence directory), so G6 cannot hold. Two concrete FLUME-39 defects surfaced: the specialist projector owns
   `AUTOMATICAI_GATEWAY_KEY` as `op://DeLoSecrets/hermes-<id>/credential` (an item that does not exist) while FLUME-39's script writes the real reference into the desk delta, so
   `flume launch rererere` fails with `specialist projection refused: ownership conflict: config secrets.onepassword.env.AUTOMATICAI_GATEWAY_KEY`; and a member token has no access to the profile's default model name.
3. **Not done live by design:** deleting Rererere's Access token, revoking its gateway token, a live provider outage, a live GitHub installation suspend, credential rotation. Each is covered by fixtures or, for the
   Access delete, by the disposable employee. The Plane PAT can only be revoked by hand and is reported `manual-action-required` on retire.
