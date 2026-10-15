# FLUME-52 live proof (2026-10-14)

Status: **NOT RUN. Procedure only.** Supervisor-owned (plan-checkpoint ruling 2026-10-14): the dev and
review sessions do not restart `flume-access.service`, edit the live `role.yaml` / `agent.yaml` definitions,
or run `--apply` against live definitions. The supervising session runs this after the verified build lands
on Flume main, because the running facade serves main's `dist`. Until then `flume identity readiness`
keeps `plane_native_identity` `unproven`, and the story is not fully accepted (AC 5).

Everything here is read-only on Plane. This file holds IDs, `op://` references and px/HTTP codes only.

## Inputs

| employee | native user | credential reference | boards |
|---|---|---|---|
| grolf (post `33god-pm`) | `292ac356-3640-474e-ac01-8b0611ed6a91` | `op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/5td5eddyyhjnbbsgfoovfi5x2y` | TEST, 33GOD, FLUME |
| rererere | `ba82e3bd-9b21-4066-9737-bd6279cf00f7` | `op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/gwxsutraup26mm4h7vkqj64ivu` | TEST, WORKF |

Instance: `https://plane.delo.sh/33god`. Live definitions: grolf
`/home/delorenj/code/33GOD/agents/hermes/pm/role.yaml` (parent 33GOD repo), rererere
`~/.agents/workforce/rererere/agent.yaml` (`~/.agents` repo). Do NOT set `FLUME_PX_BIN` (that would record
`evidence: "fixture"`). Pilot at or after `225cf94`.

## Procedure

1. Merge the verified build to Flume main, `npm run build`, then restart the facade on it:
   `systemctl --user restart flume-access.service` (the widened `native_actor_id` pattern is unreadable to an
   older facade, which answers `unknown-client`). Confirm it is `active` and that `flume access` for grolf
   still works.
2. Preview, then apply, for each employee (a preview writes nothing):
   ```bash
   flume identity bind grolf plane --principal 292ac356-3640-474e-ac01-8b0611ed6a91 \
     --instance https://plane.delo.sh/33god \
     --credential-ref op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/5td5eddyyhjnbbsgfoovfi5x2y --apply
   flume identity adopt-actor grolf plane --board TEST --board 33GOD --board FLUME --apply
   flume identity bind rererere plane --principal ba82e3bd-9b21-4066-9737-bd6279cf00f7 \
     --instance https://plane.delo.sh/33god \
     --credential-ref op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/gwxsutraup26mm4h7vkqj64ivu --apply
   flume identity adopt-actor rererere plane --board TEST --board WORKF --apply
   ```
   Expect `evidence: "provider"`, `plane.version 1.3.1`, `plane.edition PLANE_COMMUNITY`,
   `credential.static true`, `credential.expiry.observable false`, `shared_key_fallback false`, and a
   `legacy-registry-principal` warning for grolf (registry `b29eaffc-...`; reported, not written).
3. Authorship readback (read-only on Plane; the receipt is a local file):
   ```bash
   flume comment verify-plane TEST-14 \
     --comment grolf:b405f5b4-3525-4980-b9b2-4ad40b145d73 \
     --comment rererere:2d4fe4fa-c167-4aac-a25b-7cb5c18c72e8 --apply --json
   ```
   Expect two `native-verified` rows with distinct actors `292ac356-...` and `ba82e3bd-...`,
   `board_id` `0711da94-284a-4db1-86e8-d7ca37c26d45`, verdict `native-distinct-verified`.
4. One refusal: grolf is not a member of WORKF.
   `flume identity adopt-actor grolf plane --board WORKF --json` (no `--apply`) expects
   `provider-refused` with `provider_code: not_project_member`.
5. `flume identity show grolf --json`: `bindings.plane.native_actor_id == principal`, and
   `credentials.plane` is the static PAT with `expiry.observable false`.
6. `flume access request --service plane ...` as grolf answers `denied static-provider-credential`.
7. Commit and push both definition repos (the parent 33GOD repo for grolf's `role.yaml`, `~/.agents` for
   rererere). Receipts live in `${FLUME_IDENTITY_STATE:-$XDG_STATE_HOME/flume/identity}/plane-verifications.jsonl`
   and are not committed.

## Result

Not yet run. Record each step's outcome here, or the exact blocker (px code or HTTP status), and leave
`plane_native_identity` unproven if any step is blocked.
