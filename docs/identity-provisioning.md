# Identity provisioning

`flume identity provision <employee>` (FLUME-56) turns an **enrolled** employee
into live company accounts. Enrollment (`flume identity enroll`) stays a
prerequisite: provisioning never mints a subject and never touches a definition
except to add the provider binding it just created.

Preview is the default — it reads live provider state (GETs only) and reports
what it *would* do. `--apply` performs the mutations. Every capability is
idempotent: a second apply is a no-op, and a resource with a colliding name
that provisioning does not own is a **conflict blocker**, never a clobber.

## What one apply does

| capability | provider action | local effect |
| --- | --- | --- |
| `vault-item` | — | `op item create` (category identity) titled after the handle in the configured vault |
| `access-token` | `POST /accounts/…/access/service_tokens` named `employee-<handle>` (8760h) | secret lands in the vault item as `Client Secret`; the definition gains `company_identity.bindings.cloudflare_access` with the signed `principal` (client id), the pinned `instance` (issuer) and a `credential_ref` **by field id** |
| `access-policy` | GET the configured application + Service Auth policy; append only `{service_token: {token_id: <actual token ID>}}` if missing, PUT and GET the policy back | secret-free ID/subject/account attribution before the edit and outcome receipt; an already-bound employee gets the same reconciliation without minting |
| `mailbox` | literal Email Routing rule `<handle>@agents.delo.sh` → worker; KV `allowlist/<address>` in the facade's projection namespace | receipt only |

Order is deliberate: the vault item exists before any secret is minted. Item
lists and item reads use a **per-command `--cache=false`** flag, including
preflight and read-after-write verification; no operator-wide `OP_CACHE=off`
is needed. Reads and edits target the immutable item ID after title resolution.
The provisioner writes the `Identity Service Token.Client ID` and
`Identity Service Token.Client Secret` pair in one edit, then compares both
values from a fresh read and binds the secret's unique **field ID**, never a
same-named field in another section.

Failure handling is deliberately asymmetric:

| observation | outcome |
| --- | --- |
| Fresh read confirms the exact pair, even if `op item edit` returned nonzero | finish the binding; repeat apply is a no-op |
| Edit returned a normal nonzero status (not timeout/signal) **and** fresh read confirms neither Access field persisted | attempt orphan DELETE, then GET by token ID; only successful DELETE plus HTTP 404 is `deleted-orphan` / `deleted: true` |
| DELETE fails, absence cannot be verified, or provider still returns the token | blocked; `cleanup-unconfirmed`, `deleted: false`; owner reconciliation required |
| Read unavailable, values/field IDs ambiguous, partial pair, or edit reports success but pair is absent | blocked; token **retained, not deleted**, `reconciliation-required` |
| Pair persisted but binding or receipt write fails | blocked; retain the vaulted token for reconciliation, never roll it back |

A blocked Access step does not erase completed `vault-item` or `mailbox`
results. `ok: false` is not an all-or-nothing rollback. Access mutations also
set `changed: true` when their final action is blocked. Receipts record `minted`
before attempting the vault write, then `created`, `deleted-orphan`,
`cleanup-unconfirmed` or `reconciliation-required`. Provider free-form errors
are withheld because they can echo secrets. Do not treat a receipt alone as
current provider truth.

Receipts for new Access issuance include the employee subject, provider account ID,
token ID and non-secret client ID. A `minted` receipt remains pending while vault verification
or binding is uncertain. `flume identity credentials <employee>` inventories this
unbound token against the complete provider listing rather than claiming
`not-issued`. `flume identity retire <employee> --revoke cloudflare_access`
(preview first, `--apply` only with lifecycle authority) can delete a pending
issuance by its receipt ID only when the configured account and live provider
name and client ID still match this employee's issuance record; it verifies
absence with a fresh complete listing. Duplicate IDs anywhere in a listing,
including within one page, make the inventory incomplete: no mint or claim of
absence is allowed. Before any Access DELETE (including orphan cleanup), Flume
re-reads the whole census and permanent retirement reservations under the registry
lock. Another employee's binding or reservation blocks deletion, regardless of
that employee's status. Normal `identity bind` also refuses a principal reserved
by another subject's pending issuance; transferring it needs explicit reconciliation.

Contradictory scoped receipts keep the first client-ID attribution and quarantine
the employee's Access issuance journal. No pending or binding-scoped Access DELETE
is authorized while it is uncertain, even if a later receipt says `created` or
`deleted-orphan`. Inventory remains unverified and revocation incomplete; editing
receipts is not an automatic recovery path.
A failed DELETE remains incomplete and may be retried. Unscoped historical
receipts, unreadable receipts, unknown named tokens and ownership mismatches
stay unverified and never authorize a DELETE or complete-revocation claim.
Neither retirement nor preview clears vault fields; any such repair still needs
the separate owner-approved procedure below.

## Configuration

`~/.config/flume/identity-provisioning.yaml` (override:
`FLUME_PROVISION_CONFIG`), validated against
`contracts/identity-provisioning.schema.json`:

```yaml
version: 1
cloudflare:
  api_token_ref: op://DeLoSecrets/Flume Identity Provisioning/credential  # scoped provisioning credential, resolved via `op read`
  account_id: <32-hex>
  zone_id: <32-hex>              # the zone that owns the mail domain
  access_issuer: https://<team>.cloudflareaccess.com
  access_policy:
    api_token_ref: op://DeLoSecrets/Flume Access Policy/credential
    application_id: <application-uuid>
    policy_id: <service-auth-policy-uuid>
    domain: identity.delo.sh    # exact domain returned by the configured application GET
mailbox:
  worker: agents-facade          # the agents-facade Worker
  kv_namespace_id: <32-hex>      # its MAILBOX_ALLOWLIST namespace
onepassword:
  vault: DeLoSecrets
```

## Access policy membership (FLUME-57)

`cloudflare.access_policy` is optional in the schema so existing lifecycle/mail
configuration still loads, but provisioning is **blocked**, not ready, without it.
It must identify one existing Service Auth (`decision: non_identity`) policy under
one existing application in the configured account. The application ID and exact
`domain` must read back before any policy edit; Flume does not discover by display
name, create policies, embed production IDs, edit another policy, or enable
`any_valid_service_token`. Nested/ambiguous service-token include selectors are
refused, not rewritten. Reusable/shared policies are refused because their edits
could affect other applications. Other include rules, employees, exclusions, requirements,
precedence, session duration and other writable settings are preserved.

**Credential permissions:** the explicit `access_policy.api_token_ref` needs
Cloudflare account **Access: Apps and Policies — Edit** (API permission group
`Access: Apps and Policies Write`) for the selected account; it covers both the
application/policy GETs and the policy PUT. The general provisioning credential
needs **Access: Service Tokens — Edit**, **Workers KV Storage — Edit** for its
account and **Email Routing Rules — Edit** for its mail zone. They can reference
the same appropriately scoped credential only if the operator explicitly configures
both references. Policy requests never use `cloudflare.api_token_ref`,
`CLOUDFLARE_API_TOKEN`, or an operator-global fallback. A token that only mints
service tokens is not sufficient. Keep account/zone resources narrowly scoped.

`access-policy-permission-denied` (401/403) names the missing permission without
copying provider errors. `access-policy-unresolved` (404), an application/domain
mismatch, missing reference, invalid policy, provider outage or failed full-policy
readback is blocked. A read failure before a new token is created prevents its
mint. A PUT denial or uncertain readback after token issuance preserves the
vaulted, bound token and completed mailbox results; `ok: false` reports partial
provisioning. Retry the same employee after fixing the scoped credential or
configuration: it reads the existing binding/fresh vault/provider inventory and
repairs membership without minting or duplicating includes. A PUT that committed
but returned an error is blocked on that invocation and converges on retry.
Receipts distinguish `fixture` from official-endpoint `provider` observations;
they contain IDs/outcome codes only and do not prove edge access works.

`suspend|retire --revoke cloudflare_access` first durably captures the actual
token IDs, then removes only their direct include rules and reads the policy
back before the existing token-delete step. A failed policy edit does **not**
prevent token deletion: local status is already closed, and authentication should
be revoked even if membership cleanup is denied. The extra
`access-policy-membership` inventory row keeps `complete_revocation: false`
while membership is present, unknown or unreadable. Retry uses the durable
capture, earlier token-delete ID or subject/account/client-scoped receipts even
when the provider token has already disappeared. A historical bound token with
no recoverable ID remains `access-policy-token-unresolved`; an operator must
reconcile its ID rather than Flume guessing from a name or claiming cleanup.
A membership reintroduced after a completed step is detected as new work.
Restore never silently re-adds revoked membership or recreates a deleted token.

Provisioning receipts bind the subject, account, application, policy and domain to
its actual token ID. If configuration later selects another policy or a binding
is removed, retirement cannot substitute the new policy and call the old grant
revoked: restore the original scoped configuration and retry. A completed issuance
receipt remains a cleanup obligation even after an external token deletion and
manual unbind. Before DELETE, the token step durably captures its verified ID
itself, including when the preceding policy inventory failed; a killed process
can therefore retry membership removal after the token is gone.

A policy PUT records secret-free SHA-256 digests of the full writable baseline
and intended state before sending the request. An unresolved readback mismatch
blocks a plain retry (including preview) if the provider matches neither digest;
Flume never overwrites externally changed settings automatically. Inspect the
provider policy and receipt, repair it under operator authority to the intended
full state (or the prior baseline), then retry for a fresh verification. This
is not a claim of live authorization or a compare-and-swap guarantee.

Preview all operations first (`--json` exposes each capability/credential row).
These are targeted policy edits, not transactional policy ownership: local Flume
writers serialize through the registry lock and each edit reads the latest policy,
but Cloudflare's full-policy PUT offers no compare-and-swap here. Coordinate
external policy writers during an apply; full writable-policy readback detects
observable drift but cannot eliminate an external write racing the PUT. Empty
include lists are never replaced with a broad selector; if Cloudflare refuses
removing the final include, cleanup stays unresolved for operator handling.

State: `$FLUME_PROVISION_STATE` (default `~/.local/state/flume/provision`)
holds `receipts.jsonl` — one secret-free line per applied action: IDs,
references, outcomes. Secrets pass through process memory and `op` argv only;
they are never written to receipts, logs, stdout or definitions.

## Stranded credentials: diagnose first, recover only with approval

A fresh preflight refuses **any existing Access field without a binding**, even
an empty field or a secret-only partial pair. It does not repeatedly mint and
delete replacements. A bound employee is a no-op only when the fresh sectioned
fields, field-ID reference, issuer and complete provider inventory agree.
Conflicts report only item/token/field IDs, field presence, `provider_match` (token
ID or `absent`) and the last five receipt token IDs/deletion outcomes.
`receipt_comparison: unavailable` is not proof of absence. Preview performs
these comparisons with reads only; it never repairs credentials or writes a
receipt.

For FLUME-80's reported employee, the surviving Client ID plus historical
`deleted-orphan` receipts suggests a dangling vault credential, **not** a
credential to silently replace. The historical report has not been independently
validated against live providers by this patch. Live recovery remains pending
explicit owner approval; isolated fixture recovery is not live approval.

Bounded operator procedure (one employee, one item, one account):

1. Run `flume identity provision <employee> --json` (preview, **without** `--apply`). Record the subject/handle, immutable item and
   field IDs, section labels/presence, `provider_match` and `receipt_comparison`
   from `capabilities.access-token.refs`, and the conflict outcome. The default
   human rendering omits these diagnostic refs; use the documented JSON preview.
   Keep raw item JSON,
   resolved credentials and secret values out of terminals, tickets and logs.
   The provisioner compares the Client ID internally; output needs no secret.
2. Compare fresh vault data with provider GETs in the configured account
   (all pages, then GET the receipt token IDs) and the employee's existing
   provisioning receipts. Confirm which token exists, which vault pair it
   matches, and whether a local binding exists. A non-404 outage or denied GET
   is uncertainty, not evidence that a token is gone. Old `deleted: true`
   receipts are historical claims, not authorization for another deletion.
3. If a live token and complete vaulted pair match, preserve them. Request
   approval to finish **only** the missing binding using the existing
   `identity bind` path and the vaulted secret field-ID reference. Do not rotate
   merely because binding previously failed. Re-run preview after approval.
4. If the referenced token is authoritatively absent, request explicit approval
   naming the employee, account, item, exact Access field IDs and proposed
   removal of those **stale fields only**. Preserve other sections, item content,
   mailbox and every other employee. No automatic clear/delete/rotation command
   is introduced here. Have the owner perform or separately authorize the
   scoped vault repair, retaining a secret-free approval/audit record.
5. Only after approved reconciliation, preview again; if Access now plans
   `create` and other capabilities agree, obtain approval for a single apply.
   Verify the binding/reference and repeat apply is a no-op. Stop on any new
   mismatch rather than looping. Cleanup failures or secret-less live tokens
   require a separately approved provider action and absence verification.

This recovery procedure complements Access-policy membership (FLUME-57); it does not authorize
live vault-field recovery or redesign the general suspension/rotation/retirement
contract (FLUME-53). The narrow pending-issuance lifecycle handoff above makes
retirement inventory and explicitly requested Access revocation honest. It does
not authorize workforce-wide repair. Source/fixture verification is documented under
`_bmad-output/implementation-artifacts/FLUME-80/`; no installed/deployed or live
recovery claim follows from it.

## Boundaries

- No GitHub App creation (the manifest flow needs an authenticated browser
  session — the ego-browser skill owns that leg), no Plane member provisioning
  (FLUME-49's successor story 1.6 found the installed edition cannot), no
  sending mail, no GPG (deferred: story 1.5 proves authorship via the provider
  API, not commit signing).
- Revocation, suspension, rotation and retirement generally belong to FLUME-53
  (`flume identity suspend|restore|retire|credentials|rotate|continuity`; see
  "Suspension, rotation and retirement (FLUME-53)" in `docs/employee-access.md`).
  FLUME-80 adds only subject-scoped pending Access issuance inventory and
  permissioned, verified revocation for retained tokens.
  A rebinding attempt to a *different* principal is `binding-conflict`:
  rotation is deliberate (`flume identity rotate`), not a hire side-effect.
- The facade worker reads the allowlist from KV (`allowlist/<address>` keys),
  so hiring never redeploys it.
- Enrollment, suspension and retirement change what the fleet registry should
  project for the employee. `flume remediate hermes.registry-parity` re-projects
  `company_identity` (and each desk's `gateway_consumer`) onto every registry
  row; see "Registry projection for the lifecycle" in `docs/employee-access.md`.
