# FLUME-52 live proof (2026-10-14/15)

Secret-free: IDs, `op://` references, board IDs, px refusal codes and HTTP statuses only. No token, key,
PEM or JWT is in this file. Everything here ran against the real Plane at https://plane.delo.sh (1.3.1,
PLANE_COMMUNITY, workspace `33god`) through the real `px` (Pilot `225cf94`+), with `FLUME_PX_BIN` unset, so
every result says `evidence: "provider"`. Flume opened no Plane connection: it ran `px identity verify`
and `px show` as subprocesses. Plane was read only; nothing was posted by Flume. The comments below are the
ones PX-13 posted (receipt: `pilot/docs/identity-receipt-2026-10-14.md`).

Flume build under test: main `0ff265d` (FLUME-52) on top of `ccbb657` (registry projection), rebuilt, and
`flume-access.service` restarted on it before any live definition was written (the widened
`native_actor_id` shape is unreadable to an older facade, which answers `unknown-client`).

## Verdict

AC1-AC4 are met live. AC3 (two verified bindings, returned native actors, comment IDs) is met against
PX-13's sandbox comments with `evidence: "provider"`. The one residual limit is stated, not hidden: a
Plane PAT's expiry is not observable (see AC4), so `flume identity readiness` keeps `plane_native_identity`
`unproven` by design; it is a static list and proves nothing by itself.

## Binding and adoption (two employees)

| employee | native user | credential reference (item UUID + field ID) | boards verified by Pilot |
|---|---|---|---|
| grolf (post `33god-pm`) | `292ac356-3640-474e-ac01-8b0611ed6a91` | `op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/5td5eddyyhjnbbsgfoovfi5x2y` | TEST, 33GOD, FLUME |
| rererere (portable specialist) | `ba82e3bd-9b21-4066-9737-bd6279cf00f7` | `op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/gwxsutraup26mm4h7vkqj64ivu` | TEST, WORKF |

Commands (preview first, then `--apply`; instance `https://plane.delo.sh/33god`):

```
flume identity bind grolf plane --principal 292ac356-... --instance https://plane.delo.sh/33god --credential-ref op://.../5td5... --attribution-mode native --apply
flume identity adopt-actor grolf plane --board TEST --board 33GOD --board FLUME --apply
flume identity bind rererere plane --principal ba82e3bd-... --instance https://plane.delo.sh/33god --credential-ref op://.../gwxs... --attribution-mode native --apply
flume identity adopt-actor rererere plane --board TEST --board WORKF --apply
```

Result of each adopt: `ok: true`, `evidence: "provider"`, `plane {version 1.3.1, edition PLANE_COMMUNITY}`,
`credential {type plane_personal_access_token, static true, expiry.observable false}`,
`shared_key_fallback false`; `native_actor_id` written equal to the principal. Definitions: grolf
`33GOD/agents/hermes/pm/role.yaml` (33GOD `1494070`), rererere `~/.agents/workforce/rererere/agent.yaml`
(`~/.agents` `e3a0ad2`; the file was previously untracked, so this commit also puts the desk's definition
under version control). Adoption receipts are local observation lines in
`$XDG_STATE_HOME/flume/identity/plane-verifications.jsonl` (3 lines, no key material).

## AC1: blocked, never a fallback

Run in an isolated throwaway employee (temporary HOME and registry, so no live definition was involved),
against the real Plane through real px:

| case | outcome |
|---|---|
| bind principal `62b4fef6-...` (grolf@delo.sh, stale) | `stale-candidate`, nothing written |
| bind principal `b29eaffc-...` (33god-pm@delo.sh, the registry's old member) | `stale-candidate` |
| bind principal `fe4e8e5f-...` (rererere@delo.sh, stale) | `stale-candidate` |
| bind principal `db1ac9dc-...` (jaradd+grolf@gmail.com, operator-mailbox alias) | `stale-candidate` |
| hand-edited definition holding `db1ac9dc-...` (skips bind) | adopt: `stale-candidate`, 0 px calls |
| Jarad's operator key (`dlxun2xmwhkt54ns77l4gagrdq/nrepbe5r35hz5revdgagk2wec4`) claiming grolf's user | adopt: `provider-refused`, px `wrong_employee`, nothing written |
| the live `jaradd+grolf` alias key (`.../5g54znqmobyhd5z357eaxcka3y`) claiming grolf's user | `provider-refused`, `wrong_employee` |
| rererere's key claiming grolf's user | `provider-refused`, `wrong_employee` |
| real rererere, board 33GOD (preview) | `provider-refused`, px `not_project_member` (members/ answered 403) |
| real grolf, board WORKF (preview) | `provider-refused`, px `not_project_member` |

The alias key `5g54...` is still live in Jarad's main Plane item (section "API Keys - Agent Roster") and
resolves to the operator-mailbox alias, not to Grolf. Flume refuses it; retiring it is the operator's call.

## AC2: manual enrollment is reported, not worked around

`flume identity bind <e> plane` with no `--credential-ref` is refused `manual-enrollment-required` with
six `enrollment.prerequisites[]` (invite or self-signup, sign in once, the employee creates its own PAT in
the browser and records its expiry, vault it by item UUID and field ID, an admin adds board membership,
then bind and adopt). No SQL, no bot endpoint, no OAuth, no PAT minting is used.

## AC3: authorship readback (Pilot's comments, Flume's record)

```
flume comment verify-plane TEST-14 \
  --comment grolf:b405f5b4-3525-4980-b9b2-4ad40b145d73 \
  --comment rererere:2d4fe4fa-c167-4aac-a25b-7cb5c18c72e8 --apply
```

`verdict: native-distinct-verified`, `evidence: provider`, `board_id 0711da94-284a-4db1-86e8-d7ca37c26d45`
(TEST), grolf comment `b405f5b4-...` by actor `292ac356-...`, rererere comment `2d4fe4fa-...` by actor
`ba82e3bd-...`; each actor equals the adopted `native_actor_id`. The same two IDs swapped between employees
answer `not-native-distinct` with `author-mismatch` on both rows (exit 1). Mode: TEST is the legacy sandbox
board and the readback is read-only (`px show`), so no managed board was touched and nothing was cut over.

## AC4: static PAT semantics, honestly

- `flume identity show <e> --json` reports `credentials.plane`: `type plane_personal_access_token`,
  `static: true`, `expiry.observable: false` with Pilot's reason, and the revocation route (the owner
  deletes the token in the browser, or an admin removes the project membership; Pilot has no revoke verb).
  No `expires_at` or `lifetime_seconds` is ever emitted for a Plane credential.
- Neither 1Password identity item records the expiry chosen in the token modal. The enrolling operator must
  record it; no code can read it.
- `flume access request --service plane ...` as grolf, through Access, the Worker and the facade, is denied
  `static-provider-credential` with the same semantics. A local access-session TTL is never presented as the
  PAT's expiry.

## Registry correction (owned path, not hand edits)

`~/.hermes/agents-registry.yaml` row `33god-pm` carried the stale `plane.member_id b29eaffc-...` and a
`plane.key_ref` to the deleted item `Plane Agent 33god-pm`. Neither field was claimed by any handbook
authority. Both are now declared under `agent_operational_records` (handbook, no version bump: additive) and
`hermes.registry-parity` projects them from the owning definition, only when the binding is adopted on an
active employee. `flume remediate hermes.registry-parity` set `member_id 292ac356-...` and
`key_ref op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/5td5eddyyhjnbbsgfoovfi5x2y`; the audit now passes. The
remediation also re-serialised the registry's quoting (`''` to `""`, unquoted ISO timestamps); semantics are
unchanged. Landed as Flume `ccbb657`.

Rererere's desk: the contract does not support a board binding. `plane.workspace|project_id|identifier` are
project-registry's (projected from a pjangler project), and a portable specialist is never a project
(`specialist.ts` rejects those keys on a desk). So the WORKF board is verified for Rererere at adoption
(`--board WORKF`) and recorded in the receipt, not written to its row.

## Grolf's Hermes PM: what was and was not true

- The unit `hermes-33god-pm-gateway.service` does not exist on this host (nor do the other per-PM gateway
  units); `~/.hermes/profiles/33god-pm/gateway_state.json` has said `stopped` since 2026-10-11, and the live
  gateway is the single `hermes-gateway.service` (active). Nothing here required a restart, and none was done.
  No reader of the registry's `plane.member_id` or `plane.key_ref` exists in Flume, Pilot or the Hermes
  checkout, so the correction cannot change how any process resolves a credential.
- Read-only check through the PM profile's config path (`onepassword.env.PLANE_API_KEY =
  op://DeLoSecrets/Plane/Main/AutomaticAI API Token`): the reference resolves and `users/me` answers
  `a95d7646-e557-437e-b453-ae82d7f78df7` (jaradd@gmail.com), the operator, not Grolf. So the PM runtime still
  writes Plane as the operator. Switching its runtime credential to Grolf's native key is a board-level
  cutover (Krebs/Pilot managed-actor routing) and was not authorised here. It is the next step to make the
  PM comment as itself.

## State left behind

- Flume main `0ff265d`; parent 33GOD `1494070` (Grolf binding) plus the pin advance; `~/.agents` `e3a0ad2`.
- Receipts: `$XDG_STATE_HOME/flume/identity/plane-verifications.jsonl` (local, not committed).
- DW-1 (specialist-hire EISDIR) is pre-existing and unrelated; left open.
