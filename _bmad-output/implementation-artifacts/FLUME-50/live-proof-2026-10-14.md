# FLUME-50 live AC4 proof — 2026-10-14

Secret-free. No token, PEM, JWT, API key or client secret appears here, in the ledgers, or in a ticket.
Operator (Jarad) authorized the sandbox proof, the provider-principal binding and the grants.

## Verdict

AC4 met for Grolf against the designated sandbox installation `delorenj/flume-identity-sandbox`:
allowed repository access succeeded, disallowed repositories failed, and the provider's real
expiry and scopes were captured. Rererere is NOT proven: its GitHub App installation is pending the
operator's passkey (see "Rererere").

## Path used (real, end to end)

`flume access run grolf -- flume access request --service github ... --exec -- <consumer>`

1. Trusted launcher `flume access run` read Grolf's Cloudflare Access service token and signed a run
   assertion (Ed25519 key in 1Password item `dybnthxix7rea3sv7lueqld3ui`, field `launcherkey`).
2. Client POST to `https://identity.delo.sh/v1/access/requests` with the service-token headers.
3. Cloudflare Access app `identity` (aud `93bb2a33...f2cc`, policy "company employees (service tokens)",
   `non_identity`, include = the two employee service tokens) authenticated the token.
4. Worker `agents-facade` (route `identity.delo.sh/*`) proxied it to `ACCESS_FACADE_ORIGIN` =
   `https://identity-origin.delo.sh` (new var; Worker version `d30cdde5-0c3e-4e94-82fc-249d1626ed5a`).
   Before this the Worker answered `501 facade-not-provisioned` (FLUME-48's pending live-Access gap).
5. Traefik (`dynamic/flume-access.yml`) -> host `flume-access.service` (`flume access serve`, 0.0.0.0:18791).
   A direct, un-Accessed call to the origin is `401 missing-assertion`.
6. The facade verified the Access JWT (pinned issuer `https://delonet.cloudflareaccess.com`, pinned aud),
   mapped `common_name` -> Grolf, verified the run assertion, applied the operator grant, read the App key
   with `op read` inside its own process, and minted a real installation token through `@octokit/auth-app`.
7. The token reached only the `--exec` consumer's environment.

This also supplies FLUME-48's previously pending live Access path for the employee-access facade
(real Access app, real service token, real Worker hop). It does not change FLUME-48's status.

## Binding and grant

- `flume identity bind grolf github --principal 5296475 --instance 170872985 --credential-ref
  op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/2j7ayqlhuchnxh2vz4pyh4kzq4 --attribution-mode native --apply`
  (preview first). `flume identity show grolf --json` shows the `github` binding;
  `flume access github-inspect --employee grolf` -> App `gr0lfbot` (id 5296475), bot_login `gr0lfbot[bot]`,
  installation 170872985 on account `delorenj`, `repository_selection: selected`, not suspended.
- Grant in `~/.config/flume/employee-access.yaml` (operator-owned, mode 0600, not in any repo):
  subject `1dcd3567-3b5e-46b0-a6c3-a2753d6c763b`, service github, resource
  `delorenj/flume-identity-sandbox`, permissions `[issues:write, pull_requests:write, contents:read]`,
  `max_lifetime_seconds: 3600`.
- Installation `170872985` is selected-repository, 21 repos (all 33GOD repos + the sandbox); the issued token
  narrows it to exactly the sandbox repo.

## Results

| # | Request (Grolf) | Result |
|---|---|---|
| a | `delorenj/flume-identity-sandbox`, issues:write + pull_requests:write + contents:read | `granted`, `evidence: provider`, app 5296475, installation 170872985, `repository_selection: selected`, permissions returned `contents:read, issues:write, metadata:read, pull_requests:write`, `lifetime_seconds: 3600` |
| a-1 | first grant `30b63acc-5dfb-4819-b9eb-cbcdca518925` | issued 2026-10-14T23:28:23Z, provider `expires_at` 2026-10-15T00:28:23.000Z |
| a-2 | second grant `0b2ad6a3-3dbd-4537-8c37-fb003e422e60` | provider `expires_at` 2026-10-15T00:28:38.000Z |
| a-use | consumer-only token use | `GET /repos/delorenj/flume-identity-sandbox/issues` -> 200; `GET /installation/repositories` -> `total_count: 1`, only `delorenj/flume-identity-sandbox`; private repos `delorenj/monitoring`, `delorenj/infra`, `delorenj/zshyzsh` (not in the token) -> 404 |
| b1 | `delorenj/n8n-nodes-hermes` with a temporary grant (App not installed there) | `denied provider-refused` — GitHub 422 "repository does not exist or is not accessible to the parent installation"; no token |
| b2 | `octocat/Hello-World` with a temporary grant (foreign owner) | `denied repository-not-installed` — owner is not the installation's account; no provider POST |
| c | `delorenj/flume` without a grant | `approval_required` ("the employee cannot approve its own access") |
| d | `administration:write` / `issues:write + contents:write` on the sandbox, no matching grant | `approval_required` |
| shape | `issues:admin`; `delorenj/*` | `denied invalid-permission` / `denied invalid-resource` (0 provider calls) |

Note on the public-repo probe: `delorenj/flume` and `delorenj/n8n-nodes-hermes` are PUBLIC, so any token
reads their issues (HTTP 200). That is not a scope signal; the scope proof is `/installation/repositories`
(exactly one repository) plus the 404 on private repos. The first consumer run showed those 200s before
the consumer was changed to probe private repositories.

`excessive-permissions` was not reachable live: Grolf's installation holds `administration:write` and the
other write permissions, so a request beyond the installation could not be formed. It remains covered by the
fake-provider suite.

### One mistake, disclosed

While building the temporary grants for b1/b2 I also left a temporary grant for
`administration:write` on the sandbox repo, so one extra real token was minted (granted
2026-10-14T23:28:57Z, expires 2026-10-15T00:28:57Z, sandbox repo only, `administration:write` +
`metadata:read`). It was consumed by `true` and never used, the grant was removed within a minute, and the
token expires on its own (installation tokens cannot be listed or revoked by id). The `administration:write`
no-grant refusal (row d) was then re-run with the grant gone.

## Ledgers contain no secret material

`~/.local/state/flume/access/{audit.jsonl,idempotency.json,provider-ledger.jsonl}`: scanned for `ghs_`,
`ghp_`, `github_pat_`, `BEGIN ... PRIVATE`, JWT-shaped strings and 60+ char tokens. The only long strings are
seven 64-hex request-body hashes in `idempotency.json`; no record has a `credential`. `flume-access.service`
journal: no matches. `provider-ledger.jsonl` holds `attempt/issued/refused` lines with repository, expiry and
HTTP status only.

## Rererere

NOT proven; an operator blocker. App `colrerererebot` (id 5296560, bot login `colrerererebot[bot]`) has no
installation: `flume access github-inspect --app-id 5296560 --key-ref op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/sxskdgqeniqpfjftucu6rz7u2i`
returned `installations: []` on 15 polls, 60s apart (2026-10-14T23:29Z to 23:44Z). The earlier Install click for
`delorenj/flume-identity-sandbox` + `delorenj/n8n-nodes-hermes` is waiting on the operator's passkey (GitHub sudo prompt).
Nothing was bound or granted for Rererere, and no installation id exists.

Next step (operator): complete the passkey prompt on the pending install request at
`https://github.com/apps/colrerererebot/installations/new` (select only the sandbox repo and `n8n-nodes-hermes`), then run
`flume access github-inspect --app-id 5296560 --key-ref ...` to read the installation id and repeat:
`flume identity bind rererere github --principal 5296560 --instance <installation id> --credential-ref op://DeLoSecrets/hizgz76ree7zcwklorn5qtd4tu/sxskdgqeniqpfjftucu6rz7u2i --attribution-mode native --apply`,
add a sandbox grant for subject `1dca27f5-06e8-47a3-86c9-49bc3ed5331c`, and run proof (a).

Definition location: `~/.agents/workforce/rererere/{agent.yaml,contract.yaml}`. That directory is inside the git
repo `~/.agents` (delorenj/agents) but is **untracked** (`?? workforce/rererere/`), so there was nothing of mine to
commit there; the bind will need `flume onboard --employee rererere` afterwards to refresh `contract.yaml`.

## State left behind

- `~/.config/flume/employee-access.yaml` (grant + launcher public key; temporary b1/b2/admin grants removed).
- `flume-access.service` (user unit, enabled) on 18791; Traefik `dynamic/flume-access.yml`.
- `agents-facade/wrangler.jsonc` gains `ACCESS_FACADE_ORIGIN` (deployed).
- Launcher signing key 1Password item `dybnthxix7rea3sv7lueqld3ui` ("Flume Access Launcher Signing Key").
- Grolf binding in `agents/hermes/pm/role.yaml` (parent repo 33GOD).
