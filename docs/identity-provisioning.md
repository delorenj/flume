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
| `mailbox` | literal Email Routing rule `<handle>@agents.delo.sh` → worker; KV `allowlist/<address>` in the facade's projection namespace | receipt only |

Order is deliberate: the vault item exists before any secret is minted. If the
vault write after a token creation fails, the orphaned token is **deleted at
the provider** and the receipt says so (`deleted-orphan`) — no secret-less
credential is ever left live.

## Configuration

`~/.config/flume/identity-provisioning.yaml` (override:
`FLUME_PROVISION_CONFIG`), validated against
`contracts/identity-provisioning.schema.json`:

```yaml
version: 1
cloudflare:
  api_token_ref: op://DeLoSecrets/Cloudflare/globalAPIToken  # resolved via `op read`
  account_id: <32-hex>
  zone_id: <32-hex>              # the zone that owns the mail domain
  access_issuer: https://<team>.cloudflareaccess.com
mailbox:
  worker: agents-facade          # the agents-facade Worker
  kv_namespace_id: <32-hex>      # its MAILBOX_ALLOWLIST namespace
onepassword:
  vault: DeLoSecrets
```

State: `$FLUME_PROVISION_STATE` (default `~/.local/state/flume/provision`)
holds `receipts.jsonl` — one secret-free line per applied action: IDs,
references, outcomes. Secrets pass through process memory and `op` argv only;
they are never written to receipts, logs, stdout or definitions.

## Boundaries

- No GitHub App creation (the manifest flow needs an authenticated browser
  session — the ego-browser skill owns that leg), no Plane member provisioning
  (FLUME-49's successor story 1.6 found the installed edition cannot), no
  sending mail, no GPG (deferred: story 1.5 proves authorship via the provider
  API, not commit signing).
- Revocation belongs to FLUME-53. A rebinding attempt to a *different*
  principal is `binding-conflict`: rotation is deliberate, not a hire
  side-effect.
- The facade worker reads the allowlist from KV (`allowlist/<address>` keys),
  so hiring never redeploys it.
