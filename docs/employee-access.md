# Employee access

`flume access` authenticates **who is asking**, independently of the harness that
launched the process. It is FLUME-48 of the company-identity capability: it builds
on the stable subject FLUME-47 gave each employee and issues **fixture grants
only**. No provider is called, no Cloudflare resource is provisioned, and nothing
here is live Access proof.

## Trust model

The evidence is **possession of a scoped credential**: a Cloudflare Access
service token held by the trusted launcher, plus a run assertion the launcher
signed. It is not hardware or process attestation. On a shared Unix UID, arbitrary
code that can read another process's environment or the vault CLI is not stopped
by any of this; a shared UID is not a hostile-process boundary. What the design
does guarantee is that nothing the caller *says* (prompt, env var, flag, header,
JSON field) can select a different employee, and that the vault credential and
other employees' bootstrap secrets never reach a child. SPIRE or Keycloak are the
later options if real workload attestation is required.

## How a request is authenticated

Order, and nothing writes a grant before step 8:

1. Verify `Cf-Access-Jwt-Assertion` with jose: pinned issuer, pinned audience,
   RS256 only, `exp` required, rotating JWKS at `<issuer>/cdn-cgi/access/certs`.
   A missing assertion (direct-origin request) is `401 missing-assertion`; a bad
   one is `401 invalid-assertion`.
2. Read the signed `common_name`. A service-token assertion has an **empty
   `sub`**; `sub`, email and display headers are never identity. No `common_name`
   (a human token) is `401 missing-machine-identity`.
3. Map `(iss, common_name)` to exactly one enrolled employee through their
   `company_identity.bindings.cloudflare_access` (`instance` = issuer,
   `principal` = client id). None is `403 unknown-client`; more than one is
   `403 ambiguous-client`.
4. Verify the run assertion in `X-Flume-Run-Assertion`: EdDSA, signed by the
   launcher (`iss: flume-launcher`, `aud: flume-access`, `sub` = subject,
   `jti` = run id, `harness`, 12h expiry). Missing is `401 missing-run`, a bad one
   `401 invalid-run`, and a run launched for someone else is
   `401 run-subject-mismatch`.
5. Validate the body against `contracts/employee-access.schema.json#/$defs/request`
   (closed: an unknown key such as `approved` is `400 invalid-request`).
6. `employee` in the body may only be absent or equal the authenticated employee's
   handle or subject, otherwise `403 denied employee-mismatch`. A suspended or
   retired employee is `403 denied employee-<status>`.
7. Idempotency, keyed by (subject, `request_id`): an identical body returns the
   original grant (`replayed: true`, same `grant_id` and `expires_at`, **no
   credential** — it was never stored); a changed body is `409 conflict`.
   Granted and `approval_required` results persist; denials are re-evaluated.
8. Policy, then fixture issue. Grants are pre-approved by the operator in the
   configuration, keyed by subject + service + resource. Permissions must be a
   subset and the lifetime within `max_lifetime_seconds`; anything else is
   `200 approval_required`. The facade never writes the configuration and has no
   approve endpoint: the operator approves by editing the file.

Every result carries `evidence: "fixture"` and `provider: "fixture"`.

## What is written, and what never is

`$FLUME_ACCESS_STATE` (default `~/.local/state/flume/access`, mode 0600) holds
`audit.jsonl`, `idempotency.json` and `fixture-ledger.jsonl`: IDs, scopes, lifetime,
run and outcome. They never hold the credential value, a client secret, an Access
JWT, a run assertion or a vault token. The fixture credential appears only in the
first `granted` response, to the consuming process.

## The trusted launcher

`flume launch <employee>` (Hermes) and `flume access run <employee> -- <command>`
(any plain command) derive the employee from enrolled configuration and refuse an
unenrolled, suspended/retired or unbound employee before a child starts. They:

- drop `OP_*`, `CF_ACCESS_*`, `FLUME_ACCESS_*`, `FLUME_RUN_*`,
  `AUTOMATICAI_GATEWAY_KEY` and the inference fallback keys from the child, and
  also inherited variables that look like a credential: a name ending in `TOKEN`,
  `SECRET(S)`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `_PASS`, `API_KEY`/`APIKEY`,
  `_KEY`, `CREDENTIAL(S)`, `_PAT` or `_DSN` (optionally followed by one
  `_<suffix>`), case-insensitive, a name starting with `VAULT_`, `SSH_AUTH_SOCK`,
  and any value that embeds a password in a URL (`postgres://user:pass@host`).
  The operator's own shell exports dozens of these
  (`GITHUB_PERSONAL_ACCESS_TOKEN`, `PGPASSWORD`, `NOTION_API_KEY_RR`,
  `POSTGRES_URL`, ...) and an employee must never act as the operator. The match
  is on the end of the name, so `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `XAUTHORITY`
  survive. This is a name/value heuristic, not an allowlist: a credential under a
  name that matches none of these still reaches the child. Re-adding this
  employee's own values happens after the scrub;
- resolve secrets with `op read` inside the launcher only;
- set only that employee's `FLUME_ACCESS_URL`, `CF_ACCESS_CLIENT_ID`,
  `CF_ACCESS_CLIENT_SECRET`, `FLUME_RUN_ID` and `FLUME_RUN_ASSERTION` (and, for
  Hermes, its own `AUTOMATICAI_GATEWAY_KEY`).

`flume access request` is the plain client: it reads that environment, never a
flag, to say who it is. `--employee` may only repeat the authenticated employee.

## Configuration

`~/.config/flume/employee-access.yaml` (override with `FLUME_ACCESS_CONFIG`).
Only `grants` is re-read on every request; every other field (`url`, `listen`,
`cloudflare_access`, `launcher`) needs a restart of `flume access serve`. If the file
cannot be read or fails validation at reload time the facade **fails closed**: it
drops every grant (so each request is `approval_required`) and writes one line to
stderr naming the file and the error, until the file is valid again.

Make the launcher key pair (store the private half in 1Password, never in a file you keep):

```sh
openssl genpkey -algorithm ed25519 | tee /dev/stderr | openssl pkey -pubout   # private key on stderr, public_key on stdout
```

```yaml
version: 1
url: https://access.example.com        # what employee processes call (Access application hostname)
listen: { host: 127.0.0.1, port: 8787 } # where `flume access serve` binds; put Access in front of it
cloudflare_access:
  issuer: https://<team>.cloudflareaccess.com
  audience: <access-application-aud-tag>
launcher:
  signing_key_ref: op://DeLoSecrets/<item-uuid>/<field>   # Ed25519 PKCS8 private key
  public_key: |
    -----BEGIN PUBLIC KEY-----
    ...
    -----END PUBLIC KEY-----
grants:
  - subject: <employee-subject-uuid>
    service: fixture
    resource: repo:alpha
    permissions: [read, write]
    max_lifetime_seconds: 3600
```

The employee's definition carries the binding (hand-authored for now, as in
FLUME-47; for a specialist run `flume onboard --employee <id>` afterwards to
refresh `contract.yaml`):

```yaml
company_identity:
  bindings:
    cloudflare_access:
      principal: <service-token client id>      # the signed common_name
      instance: https://<team>.cloudflareaccess.com
      credential_ref: op://DeLoSecrets/<item-uuid>/<field>   # the client secret
```

## Pending live proof

Not done here, and `flume identity readiness` reports `access_assertion_policy` as
`unproven`: the real Access application and policy, per-employee service tokens,
the launcher signing-key vault item, a Hermes tool that consumes the environment,
and a `bind` command. The test suite's fake edge mints assertions the way Cloudflare
does; only the issuer differs in production.
