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
`FLUME_RUN_ASSERTION`, plus `GH_TOKEN`, `GITHUB_TOKEN`, `FLUME_GRANT_ID`,
`FLUME_GRANT_EXPIRES_AT` and (FLUME-51) `FLUME_EMPLOYEE_SUBJECT`,
`FLUME_GITHUB_REPOSITORY`, `FLUME_GITHUB_APP_ID` and `FLUME_GITHUB_INSTALLATION_ID`,
all taken from the granted body, never from the caller; the receipt (without the token) goes to stderr and the
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
receipt's `expires_at` with GitHub's. Do not infer a sandbox from a repo name or widen an
installation. Comments are FLUME-51, below.

## Review comments with verified authorship (FLUME-51)

An installation token lets an employee comment; nothing in it says who GitHub will
record as the author, and two employees can silently be one shared bot. FLUME-51 adds
three steps, each checked against what GitHub reports and nothing else.

**1. Adopt the actor (operator).** An installation token cannot read `GET /app`, and a
review comment does not reliably carry `performed_via_github_app`. The one stable,
provider-issued author identity is the bot user's numeric ID.

```sh
flume identity adopt-actor <employee> github            # preview: the slug and the ID GitHub reports
flume identity adopt-actor <employee> github --apply    # writes native_actor_id on that one binding
```

It signs an App JWT (through `@octokit/auth-app`) for `GET /app` to get the slug, then
makes the public, credential-free `GET /users/<slug>[bot]`. The user must be
`type: Bot` with exactly that login. `--apply` writes `native_actor_id` (a `^\d+$` string,
an optional field of the binding; the block stays `version: 1`) under the registry lock,
and nothing else. Re-adopting the same ID is a no-op; a different stored ID is
`native-actor-conflict`; an ID already adopted by another employee is
`native-actor-duplicate` unless both bindings are `shared_bot_attributed`. An unbound,
unenrolled or retired employee is refused. The login is checked only here, to find the
bot user; it is recorded in the report but never used for comment authorship, because it
is mutable. Comments are matched on the user ID alone.

**Deploy first.** The binding schema is closed, so a facade running a build without
`native_actor_id` reads an adopted definition as invalid and answers that employee
`unknown-client`. Deploy this build and restart `flume-access.service` on every host
that runs the facade *before* `adopt-actor --apply`.

**2. Post.** `flume comment post <owner/repo> <number> (--body | --body-file) [--marker k]`
is an `--exec` consumer, so the token it uses is the one just granted:

```sh
flume access run <employee> -- flume access request --service github \
  --resource owner/repo --permission issues:write --permission pull_requests:write \
  --exec -- flume comment post owner/repo 1 --body "..." --json
# inline: add  --review --commit <40-char head sha> --path <file> --line <n> [--side RIGHT|LEFT]
```

Before any network call it checks, in order: the review flags (`--start-line`,
`--position`, `--subject-type`, `--event` and an incomplete `--review` are
`unsupported-review-mode`); the environment `--exec` sets; the target repository equals
`FLUME_GITHUB_REPOSITORY` (case-insensitive, else `repository-not-granted`); the
subject's binding is found in the census and its `principal` equals
`FLUME_GITHUB_APP_ID` (else `binding-mismatch`); `native_actor_id` is adopted (else
`native-actor-not-adopted`).

GitHub comment creation has no idempotency key, so the invisible marker
`<!-- flume-comment:<marker> -->` (default a fresh UUID; `[A-Za-z0-9._-]{8,128}`) stands in
for one, and **each invocation POSTs at most once**:

1. *Reconcile first.* List the target's comments (`per_page=100`, at most 10 pages) and
   keep those that carry the marker **and** whose author is the adopted actor. One:
   returned with `reconciled: true`, nothing posted. More than one: `duplicate-comments`
   (with the IDs). More than 10 pages: `reconcile-incomplete`. None: continue.
2. *Review mode:* `GET` the PR; a head SHA other than `--commit` is `stale-commit`.
3. *One POST,* then a `GET` of the comment by ID. 403 `insufficient-permissions`, 404
   `target-not-found`, a 422 on a review comment `invalid-position`, any other 4xx
   `provider-refused`.
4. *A timeout, network error or 5xx* reconciles once more. Found: `reconciled: true`.
   Not found: `unverified` / `comment-ambiguous` with the marker; re-run with the same
   `--marker` (the re-run reconciles first). Never a second POST in one invocation.

Every call refuses redirects and aborts after `FLUME_GITHUB_TIMEOUT_MS`. The readback
must match the PR (or issue), and for a review comment the path, line, side and
`commit_id`; otherwise `unverified` / `location-mismatch`.

**The authorship rule (one rule, everywhere).** A comment is by an employee when
GitHub's readback says `user.id` (as a string) equals the binding's `native_actor_id`
**and** `user.type` is `Bot`. Then `native-verified` (binding `attribution_mode: native`)
or `shared-bot-attributed` (binding `shared_bot_attributed`); anything else is
`not-native-verified` with a reason (`author-mismatch`, `author-not-bot`,
`attribution-mode-unset`, `native-actor-not-adopted`). Body text, the marker, display
names, logins, email and git commit author/committer/signature are never evidence; a
stranger who copies a marker neither stops a post nor makes a comment ours.

**3. Verify.** `flume comment verify <owner/repo> --comment <employee>:<issue|review>:<id> ...`
is a read-only `--exec` consumer (request the same granted permission strings; the
policy matches them as exact strings, so `*:read` needs its own grant). It reads each
comment by ID and applies the rule to the named employee's binding. `commit` or any
other kind is `unsupported-evidence`. The verdict is `native-distinct-verified` only if
there are at least two distinct subjects, every comment is `native-verified`, their
`native_actor_id`s are pairwise distinct and their App principals are pairwise
distinct. Otherwise `not-native-distinct` with reasons (`fewer-than-two-employees`,
`not-native-verified:...`, `shared-actor`, `shared-app`, `shared-bot-attributed`); a
shared bot is never reported as two native actors. The report lists the comment
classes (`issue`, `review`) covered per employee. Every `post`/`verify` result carries
`evidence`: `provider` only against `https://api.github.com`, otherwise `fixture`. The
token appears in no output, file or receipt; receipts hold IDs, the marker, URL, author
ID/login/type, `performed_via_github_app.id` when returned, the location and HTTP
status.

**Live-proof procedure and gate.** Only against the operator-designated sandbox
`delorenj/flume-identity-sandbox` (PR #1, `proof.txt` lines 1-3 on the RIGHT side), never
a production repository, and only after the fixture suite
(`node scripts/run-tests.mjs employee-access-github-comments`) passes: (1) per
employee, `identity adopt-actor --apply`, then through `flume access run` post one
conversation comment and one inline comment on `proof.txt` line 2 at the PR head;
(2) a second employee only once `github-inspect` shows its sandbox installation, then
an operator bind, a sandbox grant and adoption; (3) `comment verify` over every
comment ID. `github_native_authorship` stays `unproven` in readiness by design. Receipt:
`_bmad-output/implementation-artifacts/FLUME-51/`.

## Plane identities, verified by Pilot (FLUME-52)

An employee's Flume record can name its **own native Plane user**, and Flume can prove it.
Pilot (`px`) owns every Plane read and write: Flume runs `px` as a subprocess
(`FLUME_PX_BIN`, default `px`; `FLUME_PX_TIMEOUT_MS`, default 60000; no shell, parent
environment passed through) and records what it says. Flume has no Plane HTTP client, no SQL, no
bot/OAuth endpoint and does not mint tokens. Only `px identity verify` and `px show` are ever
invoked; posting stays with the operator or the employee through Pilot.

**Binding** (`bindings.plane`, mirroring the GitHub one):

```yaml
plane:
  principal: 292ac356-3640-474e-ac01-8b0611ed6a91        # lowercase native Plane user UUID
  instance: https://plane.delo.sh/33god                  # https://<host>/<workspace-slug>, exactly
  credential_ref: op://DeLoSecrets/<26-char item uuid>/<field-id>   # the employee's own PAT, by reference
  # attribution_mode: absent or native
  # native_actor_id: written ONLY by adopt-actor; equals principal
```

**Flow: bind, adopt, verify-plane.**

```bash
flume identity bind grolf plane --principal 292ac356-... --instance https://plane.delo.sh/33god --credential-ref op://... --apply
flume identity adopt-actor grolf plane --board TEST --board FLUME --apply     # px identity verify, once per board
flume comment verify-plane TEST-14 --comment grolf:<comment-id> --comment rererere:<comment-id> --apply
```

- `bind` validates the shape and refuses the four stale candidates in
  `contracts/company-identity-candidates.yaml` (`adoptable: false`, `stale-candidate`).
- `adopt-actor` runs only for an enrolled, **active** employee (any other status is refused before any px
  call). Every `--board` must verify or nothing is written. Board membership is not stored on the binding;
  the verified boards go in the receipt. Px refusals surface as `provider-refused` with px's code
  (`wrong_employee`, `not_employee_identity`, `shared_identity`, `shared_credential`, `not_project_member`,
  `credential_rejected`, `unknown_board`); a px answer that disagrees with the binding is
  `provider-result-mismatch`; a missing binary, a timeout or non-JSON is `provider-unavailable`. There is
  no fallback to a shared or operator key and no choosing among candidates.
- `comment verify-plane` reads the ticket once with `px show` (the operator-key, third-party read) and
  compares each comment's `actor_id` with the adopted `native_actor_id`. Text, markers and display names
  are never evidence. It also verifies the historical comments of a retired or suspended employee.
  Verdicts: `native-verified` per comment; `native-distinct-verified` overall, else `not-native-distinct`
  (`native-actor-not-adopted`, `author-mismatch`, `comment-not-found`, `shared-actor`, ...).
- Previews are the default. Receipts (`plane-verifications.jsonl` under
  `${FLUME_IDENTITY_STATE:-$XDG_STATE_HOME/flume/identity}`, mode 0600) are appended only with `--apply`
  and hold IDs, `op://` references, board IDs, px codes, the Plane version and `evidence` (`fixture`
  whenever `FLUME_PX_BIN` is set, else `provider`). They never change a definition.
- `adopt-actor` never writes the agent registry; a mismatch is reported as a `legacy-registry-principal`
  warning. The registry's `plane.member_id` / `key_ref` are a projection of the ADOPTED binding on an active
  employee, written by `flume remediate hermes.registry-parity` (declared in the handbook under
  `agent_operational_records`). An unbound or merely requested binding projects nothing. A portable specialist
  has no board binding in its registry row: `plane.workspace|project_id|identifier` belong to project-registry.

**Manual enrollment prerequisites** (Flume cannot create a Plane user or token; `bind` without a
`--credential-ref`, or `adopt-actor` without a binding, answers `manual-enrollment-required` /
`no-provider-binding` with this list): invite `<handle>@agents.delo.sh` (or let it self-sign-up); sign in
once; the employee creates **its own** PAT in the browser and records the expiry it chose; vault it and
reference it by item UUID and field ID; a workspace admin adds board membership; then bind and adopt.

**A Plane PAT is static.** Plane shows its expiry and revocation only to the owner's browser session, never to
the key. Every result reports `type: plane_personal_access_token`, `static: true`, px's `expiry`
(`observable: false`) and `revocation`, and never an `expires_at` or lifetime. `flume identity show` carries
this under `credentials.plane` (from the latest adoption receipt, else `verified: false`). The access facade
therefore **denies** `service: plane` with `static-provider-credential` even when a grant matches: a local
grant TTL must never be read as the token's expiry.

**Deploy first.** The `native_actor_id` schema pattern is widened to digits or a lowercase UUID. A facade
built before this change cannot read a definition holding a Plane actor and answers `unknown-client`
for that employee. Rebuild and restart `flume-access.service` before running `adopt-actor` on a live
employee. `plane_native_identity` stays `unproven` in `flume identity readiness`: only Pilot verification
receipts prove it, and a PAT's expiry is not observable. The live proof is run by the supervising
session after the build lands (`_bmad-output/implementation-artifacts/FLUME-52/`).

## Suspension, rotation and retirement (FLUME-53)

`flume identity status` records LOCAL employment state and revokes nothing. The lifecycle commands below are what
closes the mailbox, revokes or reports each provider credential, rotates a key while keeping who the person is, and proves
afterwards that history still points at the same person.

```
flume identity suspend  <e> [--revoke cloudflare_access|github|gateway ...] [--apply]
flume identity retire   <e> [--revoke cloudflare_access|github|gateway|all ...] [--apply]
flume identity restore  <e> [--apply]
flume identity credentials <e>                      # read-only inventory
flume identity rotate   <e> cloudflare_access|github|plane --credential-ref <op://...> [--apply]
flume identity continuity <e> [--record [--apply]] [--comment <e>:<uuid> | <e>:<issue|review>:<id> ...]
flume access receipts (--employee <e> | --run <id>) [--since <iso>] [--gateway-proof <file>]
flume mail list | read <id>                         # plain client; run as `flume access run <e> -- flume mail list`
```

**Every command is a preview unless `--apply`.** A preview reads (Cloudflare and GitHub GETs, `px identity verify`,
`gateway-tokens status`) and writes nothing: no definition, no state or ledger file, no provider mutation. A blocker
(`not-enrolled`, `invalid-request`, `shared-consumer`, `retired-terminal`, `not-suspended`, an unreadable or symlinked
definition) exits 1 with `blockers[]` before any provider call.

**Order.** Suspend writes local status FIRST (`setEmployeeStatus`), then deletes the mailbox allowlist key
(`allowlist/<address>`: the record is read, captured into the lifecycle state, deleted, and verified absent by a GET that
answers 404), then runs only the adapters named with `--revoke`, always in the order `cloudflare_access`, `github`, `gateway`.
Retire is the same plus the employee's own literal routing rule disabled (PUT `enabled:false`, verified by GET; a foreign rule
for the address is never touched), a tombstone, and `--revoke all`. Restore runs only from `suspended`: it re-PUTs the exact
captured record (verified by GET), un-suspends a GitHub installation only if THIS lifecycle suspended it, and writes status
`active` LAST. The facade reads status on every request, so a crash or outage in between fails closed.

While the allowlist key is absent the agents-facade Worker bounces new inbound mail to the address: inbound mail is refused while the employee is suspended or retired, stored mail is kept, and restore re-opens delivery.

**Convergence.** Every `--apply` of suspend, restore or retire has an `operation_id`. State is
`<identity state dir>/lifecycle-state.json` and `lifecycle-ledger.jsonl` (directory 0700, files 0600, secret-free), held under
its own lock for the whole apply; the registry lock is never nested. Each provider-mutating step has a resource-scoped key such as
`cloudflare_access:token-delete:<client_id>`. A key recorded `done` or `converged` is never executed again, even by a later
operation in the same suspension episode: it reports `already-done` with the original `operation_id`. Restore clears only the keys
of the steps it reversed. An `unresolved` step is re-attempted by the next run. A 404 on a DELETE, an installation that was
already suspended, and `revoked 0 tokens` are `converged`. After an outage, re-run the same command.

**What each provider can and cannot revoke.**

| provider | what `--revoke` does | what stays usable | row status |
|---|---|---|---|
| mail | suspend deletes the allowlist key (reversible, record captured); retire also disables the employee's own routing rule | stored mail is kept under `mail/<handle>/` (Flume has no R2 client and deletes no mail) | `suspended-reversible`; after retire `revoked` by read-back |
| cloudflare_access | `--revoke` DELETEs the service token and verifies by listing again | without `--revoke`: the token authenticates at Access until its `expires_at` (the facade still denies by status) | `static-usable` + `expires_at`; `revoked` only when the listing no longer has it |
| github | `--revoke` suspends the installation (PUT `/app/installations/{id}/suspended`, verified by `suspended_at`) | the App private key (probed by app-JWT `GET /app`); unexpired installation tokens until `expires_at` (at most 1 hour). Anyone holding the key can un-suspend | installation and tokens `suspended-reversible`; key `static-usable`, `revoked` only when GitHub answers 401 |
| plane | nothing: Flume has no Plane client or revoke verb | the employee's PAT; its expiry is not observable. The employee deletes it (Profile > Personal Access Tokens) or an admin removes the board membership | `static-usable`; `revoked` only on Pilot's `credential_rejected` |
| gateway | `--revoke` runs `gateway-tokens.py revoke <consumer>` and verifies `status` lists no tokens | an `expired_time` of `-1` means the token never expires | `static-usable` or `residual-expiry`; `revoked` only when `tokens: []` |

Row statuses: `revoked`, `suspended-reversible`, `residual-expiry`, `static-usable`, `manual-action-required`, `unverified`,
`unresolved`, `not-issued`. A static credential becomes `revoked` ONLY when the provider has read back its rejection or absence
(`read_back` names which); a local status, a grant TTL or a step that merely ran never does. On retire, a row that would be
`static-usable` is reported `manual-action-required`. `complete_revocation` is true only when every row is `revoked` or
`not-issued`; otherwise `incomplete[]` lists the rest and the text output says `revocation INCOMPLETE`. Run assertions live 12 hours
but are status-gated, so a suspended employee's run is denied immediately. Installation tokens already minted live at most an hour.

**Gateway and FLUME-39.** The consumer is the last segment of the desk's `AUTOMATICAI_GATEWAY_KEY`, and only for the FLUME-39 shape
`op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/<consumer>`; any other shape is `unverified` (`gateway-ref-shape`). A consumer shared with
the fleet base or another desk fails `--revoke gateway` as `shared-consumer`. Flume never mints or rotates gateway tokens (FLUME-39,
`gateway-tokens.py`). Every gateway row and result carries `owner_ticket: FLUME-39`, `evidence_path`
(`FLUME_GATEWAY_EVIDENCE`, default `_bmad-output/implementation-artifacts/FLUME-39`) and `evidence_status`, which is `unverified`
until that evidence exists. Residual risk: `launchSpecialist` reads the gateway key from a hard-coded
`op://DeLoSecrets/hermes-<employee>/credential`, which is not the FLUME-39 shape; the lifecycle reports the mismatch and does not change it.

**Tombstones.** Retire records the subject, handle, email and binding keys in the lifecycle state. `flume offboard` removes only the
registry row, but enroll, bind, status and restore consult the tombstone: `handle-tombstoned`, `subject-tombstoned`,
`binding-tombstoned` and `retired-terminal`.

**Rotation.** `rotate` changes `credential_ref` only; the principal, instance, `native_actor_id` and attribution are unchanged. A
differing `--principal` or `--instance` is `rotation-changes-principal`; a ref held elsewhere is `credential-ref-duplicate`; gateway is
`rotation-owned-elsewhere`. It appends an `identity.rotate` ledger line and reports the previous ref `manual-action-required`: revoke the
old key at the provider. Verify the new key with `flume access github-inspect` (github) or `flume identity adopt-actor ... plane --board` (plane).
`continuity` compares the identity now with a baseline recorded by `--record --apply`: the same subject, handle, email, principal,
`native_actor_id` and mailbox prefix are `stable`; a new `credential_ref` is `rotated` and a new post `moved`; drift is `broken` (exit 1).

**Mail authorize (deploy the Flume origin FIRST).** `POST /v1/mail/authorize` runs the same assertion, client mapping, run, body and
fresh-status pipeline as `/v1/access/requests` and reads the census on every request. Its body is closed:
`{operation: "list"|"read", message_id?: <64 hex>}` (`read` requires the id, `list` forbids it). A 200 is
`{ok: true, status: "authorized", handle, subject, run_id, harness, mailbox_prefix: "mail/<handle>/", operation}`; a non-active employee is 403
`employee-<status>`. The handle comes only from the verified machine identity. Each request writes one `mail.authorize` audit line (outcome, IDs,
operation, message_id; never mail content or codes). The agents-facade Worker already calls this route; until the rebuilt origin is running
(`flume-access.service` restarted) it answers 404 and the Worker passes that through. Only after authorize does the Worker check that the KV allowlist
key still exists (suspension removes it, so the mailbox is closed even if the origin were stale) and read `mail/<handle>/`.

**Receipts.** `flume access receipts` joins the facade's audit and ledgers, the lifecycle ledger and Pilot's comment receipts by `subject`,
`run_id` and `operation_id`, emitting a field whitelist and never a raw line. `--run` adds that subject's lifecycle operations inside the run window.
Gateway attribution links the FLUME-39 evidence (`unverified` while absent), never a generated config; a `--gateway-proof` file is `verified` only
if it says `verified: true` and every `token_name` starts with `aai:<consumer>:`. The live canary procedure is
`_bmad-output/implementation-artifacts/FLUME-53/live-canary-procedure.md`; `employee_lifecycle_canary` stays `unproven` in `flume identity readiness`
until the supervisor runs it.

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

## Live deployment (2026-10-14) and what is still unproven

A real Access-fronted path exists and carried the FLUME-50 GitHub proof
(`_bmad-output/implementation-artifacts/FLUME-50/live-proof-2026-10-14.md`):

```
flume access run <e> -> https://identity.delo.sh   (Cloudflare Access app "identity", service-token policy)
  -> Worker agents-facade (route identity.delo.sh/*, var ACCESS_FACADE_ORIGIN=https://identity-origin.delo.sh)
  -> Traefik dynamic/flume-access.yml -> user unit flume-access.service (`flume access serve`, port 18791)
```

The origin hostname grants nothing alone: the facade refuses any request without a verifiable
`Cf-Access-Jwt-Assertion` (pinned issuer and audience). The launcher signing key is the 1Password item
"Flume Access Launcher Signing Key". Operator grants live in `~/.config/flume/employee-access.yaml`.

Still unproven, and `flume identity readiness` keeps `access_assertion_policy` `unproven`: a Hermes tool
that consumes the launcher environment, and a negative live matrix for the Access layer itself
(unknown/revoked token, wrong audience). `github_sandbox_installation` stays `unproven` in readiness by
design (it is a static list); the GitHub sandbox proof for Grolf is recorded in the FLUME-50 receipt.
The test suite's fake edge mints assertions the way Cloudflare does; only the issuer differs in production.
