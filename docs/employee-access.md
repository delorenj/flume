# Employee access

`flume access` authenticates **who is asking**, independently of the harness that
launched the process. It is FLUME-48 of the company-identity capability: it builds
on the stable subject FLUME-47 gave each employee. Every service issues a **fixture
grant**, except `github` (FLUME-50, below), which asks GitHub for a real installation
token. No Cloudflare resource is provisioned here, and nothing here is live Access
proof.

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
8. Policy, then fixture issue (for `github`: request shape, policy, binding, then the
   provider; see "GitHub credentials"). Grants are pre-approved by the operator in the
   configuration, keyed by subject + service + resource. Permissions must be a
   subset and the lifetime within `max_lifetime_seconds`; anything else is
   `200 approval_required`. The facade never writes the configuration and has no
   approve endpoint: the operator approves by editing the file.

Every fixture result carries `evidence: "fixture"` and `provider: "fixture"`.

## What is written, and what never is

`$FLUME_ACCESS_STATE` (default `~/.local/state/flume/access`, mode 0600) holds
`audit.jsonl`, `idempotency.json`, `fixture-ledger.jsonl` and `provider-ledger.jsonl`:
IDs, scopes, lifetime, run and outcome. They never hold the credential value, a
client secret, an Access JWT, a run assertion, a vault token, a GitHub App private
key, an app JWT or an installation token (nor a prefix or hash of any of them). The
credential appears only in the first `granted` response, to the consuming process.

## GitHub credentials (FLUME-50)

`service: "github"` issues a **real installation token**, restricted to one
repository and the requested permissions, using the authenticated employee's own
GitHub App. There is no PAT, `GH_TOKEN`/`GITHUB_TOKEN`, other-employee or shared-App
fallback anywhere. JWT signing and the installation-token protocol are
`@octokit/auth-app`'s; this repo does not implement them.

**Binding** (one per employee; the key lives in the identity item's `Github App`
section, referenced by item UUID and **field ID**, never by title or section label):

```yaml
company_identity:
  bindings:
    github:
      principal: "123456"        # the numeric GitHub App ID
      instance: "7890123"        # the numeric installation ID
      credential_ref: op://DeLoSecrets/<26-char item uuid>/<field id>   # the App private key
      attribution_mode: native
```

Write it with `flume identity bind <employee> github --principal 123456 --instance
7890123 --credential-ref op://DeLoSecrets/<uuid>/<field-id> [--apply]` (a preview
unless `--apply`). It refuses non-digit IDs, a title instead of an item UUID, and a
section-qualified path. Find the field ID without printing values:
`op item get <uuid> --format json | jq '[.fields[]|{id,label,section:.section.label,type}]'`.
A Client ID field alone proves neither the App ID nor an installation; run
`flume access github-inspect --employee <e>` (or `--app-id <id> --key-ref op://...`),
which makes app-JWT GETs to `/app` and `/app/installations` only and prints the App,
`bot_login` (`<slug>[bot]`) and each installation's account, selection, permissions
and suspended state. It never mints, writes or adopts.

**Grant** (the operator edits the file; permissions are matched as exact
`<name>:<read|write>` strings, so `issues:write` does not cover `issues:read`):

```yaml
grants:
  - subject: <employee-subject-uuid>
    service: github
    resource: owner/repo                 # exactly owner/repo: no wildcard, no bare owner
    permissions: [issues:write, pull_requests:read]
    max_lifetime_seconds: 3600           # GitHub fixes tokens at ~1h; use at least 3600
```

**Permission vocabulary:** each permission is `<name>:<read|write>`, one level per
name (`issues:write`, `pull_requests:read`, `checks:write`, ...). `issues:admin`, a
bare name, a wildcard or a repeated name is `invalid-permission`; `owner/*` or `owner`
is `invalid-resource`; a `lifetime_seconds` is `lifetime-not-supported` (GitHub does
not let a caller shorten a token). These are denials: they make no provider call and
are not persisted. A request outside the operator grant is `approval_required` before
the binding is read. No binding is `no-provider-binding`; a non-digit `principal` or
`instance`, or a missing `credential_ref`, is `provider-binding-invalid`. Both are
refused before any vault read.

**Provider sequence.** The facade reads the App key with `op read` (inside its own
process), then: (1) `GET /app/installations/{instance}` with an app JWT (at most two
attempts on a network error or 5xx): 404 is `installation-mismatch`, a suspended
installation is denied, an account other than the repo owner is
`repository-not-installed`, permissions beyond the installation's are
`excessive-permissions`; (2) exactly one `POST /app/installations/{instance}/access_tokens`
with `repositories: [repo]` and the requested permissions, through a fresh auth
instance; (3) it verifies the answer. A response that is not `selected`, not exactly
that one repository, or wider than requested is `provider-scope-mismatch`; an expiry
beyond the grant's `max_lifetime_seconds` + 60s is `provider-lifetime-exceeds-grant`.
Either is **revoked** (`DELETE /installation/token`, at most two attempts) and denied.
If the revoke fails, the result is `502 unverified`, code `revoke-failed`, with a
`residual_expires_at`, and it is persisted. A definitive provider 4xx on the POST is
denied `provider-refused` (first line of GitHub's message) and is not persisted. A POST
timeout, network error or 5xx is ambiguous: `502 unverified`, code `issuance-ambiguous`,
persisted under the `request_id` so a replay never re-mints. Installation tokens cannot
be listed, so an ambiguous POST cannot be reconciled; its residual window is unknown
and bounded only by GitHub's own expiry. A fresh `request_id` mints once. Each call is
aborted after `FLUME_GITHUB_TIMEOUT_MS` (default 15000). `FLUME_GITHUB_API_BASE`
(default `https://api.github.com`) points the facade at a double; `evidence` is
`"provider"` only against the real base, otherwise `"fixture"`. Token length and
prefix are never validated.

**Delivery.** A granted result reports `provider: "github"`, `app_id`,
`installation_id`, `repository`, the provider-returned `permissions` (GitHub adds
`metadata:read`) and `repository_selection`, the provider `expires_at` and a
`lifetime_seconds` derived from it. The credential is
`{ kind: "github-installation-token", value }` in the first response only. The plain
client prints a credential only for `fixture-bearer`; `--service github` without
`--exec` is refused before any request. Use:

```sh
flume access run <employee> -- flume access request --service github \
  --resource owner/repo --permission issues:write --exec -- gh issue list -R owner/repo
```

The consumer gets the parent environment minus `CF_ACCESS_CLIENT_SECRET` and
`FLUME_RUN_ASSERTION`, plus `GH_TOKEN`, `GITHUB_TOKEN`, `FLUME_GRANT_ID` and
`FLUME_GRANT_EXPIRES_AT`; the receipt (without the token) goes to stderr and the
command exits with the consumer's code. `provider-ledger.jsonl` records
attempt/issued/refused/ambiguous/revoked/revoke-failed lines (IDs, scopes, expiry,
HTTP status, `x-github-request-id`).

**Live proof procedure and its gate.** Nothing here has minted a real token.
`flume identity readiness` keeps `github_sandbox_installation` `unproven` until an
operator designates a sandbox repository and installation. To prove it live: confirm
with `github-inspect` that the installation belongs to the employee's App (its
account, `repository_selection: selected` and permissions), and confirm out of band,
in the App's installation settings in GitHub, that the selected repositories are only
the sandbox repository (`github-inspect` cannot list repositories), then
`flume identity bind ... --apply`, add the
one grant, run the `--exec` command above with a read-only consumer, and compare the
receipt's `expires_at` with GitHub's. Do not infer a sandbox from a repo name, widen an
installation, or post comments (FLUME-51).

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
the launcher signing-key vault item, and a Hermes tool that consumes the environment.
The GitHub sandbox gate above is separate. The test suite's fake edge mints assertions the way Cloudflare
does; only the issuer differs in production.
