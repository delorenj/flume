---
title: Company identity for employees — Cloudflare-first decision
type: technical
topic: employee-company-identity
decision: Compose existing employee identity with Cloudflare mail/authentication and provider-native accounts.
source: current public documentation and repository metadata; local contracts kept separate
status: complete-with-account-readiness-gates
claims_verified: 0
claims_unverified: 12
verification_note: Primary documented; the ledger reserves verified for independent corroboration.
preset: standard
validation: normal
created: 2026-10-10
updated: 2026-10-10
---

# Company identity for employees

## Decision summary

**Use Cloudflare Email Routing for `<handle>@agents.delo.sh`, Cloudflare Access service tokens for the initial machine-authentication adapter, and Flume's existing employee definition as the canonical identity.** Add a narrow access facade backed by existing 1Password custody and provider-specific enrollment. Do not buy a mailbox for every employee or install an agent framework to obtain identities.

Cloudflare now documents both receiving and sending under Email Service. Inbound routing is free. Arbitrary outbound requires Workers Paid (minimum $5/account/month); Email Sending includes 3,000 emails/month on that plan, then costs $0.35 per additional 1,000. Email Sending remains Beta. Already paying for some Cloudflare product does not prove Workers Paid entitlement. Worker/storage usage is a separate cost consideration. [1][2][3]

**There is no evidenced universal package that turns one employee identity into distinct authors across every external service.** Use native Plane users and GitHub Apps; a shared upstream bot remains one upstream author even when the internal audit says which employee requested the action. GitHub installation tokens can be limited to repositories/permissions and expire after one hour. [8][10]

Three credible OSS choices were checked: SPIFFE/SPIRE for workload attestation; Keycloak for OAuth service accounts; AGNTCY Identity for agent identifiers and signed identity badges. All inspected implementations are Apache-2.0. None removes service-specific enrollment. Keep Keycloak as the standard-protocol alternative and SPIRE for a demonstrated attestation need; do not make AGNTCY badges the credential broker or proof of live caller possession. [12][13][14]

**Biggest caveat:** public product capability is not this account's entitlement or a deployed proof. The first implementation story must reconcile existing identities, Cloudflare limits and the installed Plane edition. No DNS/account/token changes were made during research.

## 1. Cloudflare mail: receive-first is the inexpensive path

- Email Routing is available on Free and Paid plans, with unlimited inbound messages in the pricing table. Email Workers consume separately metered Worker resources. Free Workers allow 100,000 requests/day but only 10ms CPU/invocation; unmeasured parsing/storage cannot be promised free. [1][2]
- `agents.delo.sh` can use Email Routing within the existing `delo.sh` zone. **Subdomain catch-all is not available**; use literal rules per employee. Current docs list 200 rules/domain and 30 configured mail domains/zone. [4][5]
- Routing/Workers are transport and processing, not a traditional hosted inbox. Bounded storage and authenticated retrieval remain implementation work; don't expose a shared catch-all inbox to all employees. [3][5]
- Sending to verified account destination addresses is free; sending to arbitrary recipients needs Workers Paid and a separately onboarded sending domain. A free notification to the operator is not evidence of general outbound capability. [1][3][4]
- Current price baseline: inbound routing $0; Worker/storage depend on use; arbitrary outbound $0 additional subscription if Workers Paid already exists, otherwise at least $5/month, plus usage overages. **No new per-mailbox fee is needed for the proposed receive-first design.** [1][2]

Decision: receive service invitations and notifications first. Ticket/code comments go through service APIs, so outbound email is not a prerequisite. Keep arbitrary sending disabled until account access and incremental cost are explicitly checked.

## 2. Cloudflare authentication: viable, but not the employee directory

Access service tokens authenticate automated clients with a client ID/secret, with separate rotation, expiry and revocation. The default account limit is **50 service tokens**, distinct from the free plan's human-seat allowance. Existing uses and rotation headroom must be counted before promising one credential to every employee. [6][7]

The critical implementation detail: a service-token application JWT has an empty `sub`; `common_name` contains the Client ID. Validate signature, issuer, application audience and validity, then map signed `(issuer, common_name)` to the stable employee subject. Do not key all employees by the empty subject or accept an arbitrary identity header. Cloudflare documents JWKS validation and a jose example. [6]

Access proves possession of a credential, not which Unix process or LLM is using it. A trusted launcher must enforce employee/run selection, and a shared Unix UID with global vault access is not a meaningful adversarial isolation boundary. That limitation is a design constraint, not a Cloudflare defect.

Decision: use Access first to avoid running a new IdP. Keep the binding replaceable. Do not change organization-wide strict-auth settings as a side effect; prove the application's actual policy and prevent origin bypass. [6]

## 3. Native authorship and provider credentials

### GitHub

Installation access tokens authenticate an app installation, expire in one hour and can be narrowed to a repository subset and granted permission subset. A distinct app per employee is the proposed native-author mapping; verify returned author IDs on actual comments rather than inferring them from names. A shared app cannot produce distinct native employee authors merely by changing comment text. [8]

Do not automate dozens of free pseudo-human accounts: current GitHub terms require human account creation and permit no more than one free machine account in addition to a free personal account. App enrollment is the better-supported automation route for this design. This pass did not establish app-registration caps or all account-plan billing terms, so those remain an enrollment gate, not an unlimited-free claim. [9]

Issue comments, PR conversation comments and inline review comments need separate permission/endpoint proofs. Git commit attribution is separate: GitHub matches commit-header email to an account. A push token does not rewrite author metadata or prove who authored the code. [11]

### Plane

Plane documents user-generated personal API keys and optional expiry, with OAuth as an alternative. Per-employee native users plus their own credentials are the proposed native attribution path; no arbitrary per-call actor substitution is established. The installed edition/version, user enrollment route and returned comment author must be verified through Pilot. A dedicated bot API was not established in the inspected sources; do not plan against one. [10]

Local integration constraint: Krebs already requires distinct native long-lived actors, authenticated ingress and users/me plus membership checks. Its October 6 activation notes contain conflicting/stale Grolf candidate accounts. Reconcile and adopt a verified principal before creating new ones. These are local contract/dated observations, not a fresh service audit.

## 4. Open-source comparison

| Option | What is actually evidenced | Why choose / defer |
| --- | --- | --- |
| **SPIFFE/SPIRE** | SPIFFE identity standard; SPIRE Apache-2.0 server/node-agent implementation, process/node attestation, short-lived X.509/JWT identities. No LLM framework required. [12] | Best for real workload-origin proof. Defer until distinct workloads and attestation justify extra infrastructure; a shared selector cannot distinguish employees. |
| **Keycloak** | Apache-2.0; confidential clients have service accounts, client credentials or signed assertions, OIDC tokens and roles/scopes. [13] | Credible OSS alternative to Access. Requires operating an IdP and does not itself mint arbitrary third-party API tokens. |
| **AGNTCY Identity** | Apache-2.0 standalone CLI/backend for agent/MCP identities and signed badges; inspected release is v0.0.26 and API v1alpha1. [14] | Closest narrowly agent-focused OSS answer. Useful for identity metadata/interoperability; inspected evidence does not establish a complete live caller-authentication, SaaS broker or retirement solution. |
| **Small Flume adapter + Access** | Existing employee authority plus documented service-auth front door. [6][7] | Recommended here: fewest new infrastructure services; cloud dependency and 50-token account limit are explicit tradeoffs. This is proposed integration work, not an off-the-shelf universal broker. |

No benchmark or independent operational-cost measurement was performed. Authentik and other agent-auth products were not evaluated deeply enough to rank. Product advertising is not evidence of provider-native authorship.

## Cross-dimension conclusions

1. An employee needs a stable **person identifier**, an authentication binding and a **provider principal**; email alone supplies none of the latter two.
2. The user's zero-extra-mailbox-cost goal is compatible with the receive-first plan. It is not a guarantee of zero compute/storage/outbound costs.
3. Email can help accept an invitation, but existing provider APIs/apps often establish identity without inbox-driven login. Avoid making mailbox automation a prerequisite for every token request.
4. Keep credentials in the adapter/launcher and grant only named resources. An internal expiry label cannot shorten a static upstream PAT; actual revocation or provider expiry is required.
5. Native Plane identities are already an integration requirement. A shared bot fallback would regress the existing contract, even if easier to build.

## Evidence limits and contrary material

This was a bounded primary-source pass, not an exhaustive independent security/product review. The Cloudflare digest records third-party claims of GA and $0.09/1,000 that conflict with current official Beta and $0.35/1,000 documentation; they do not govern the recommendation. [1][3]

Vendor docs substantiate advertised mechanisms and pricing, not this account's availability or successful runtime behavior. Independent corroboration of every feature was not obtained. Only receive pricing had a secondary comparison in the research digest; conclusions otherwise retain primary-documented/not-deployed status. No blanket “verified in production” label is used.

## Open readiness checks, not unanswered product questions

- Cloudflare: current Workers Paid/Email Sending availability; active service-token count and machine-identity billing; subdomain DNS conflicts; measured Worker/storage budget and failure behavior.
- Plane: installed version/edition, supported user enrollment and PAT/OAuth capabilities; reconcile Grolf candidates and exact board membership without assuming an existing email proves active identity.
- GitHub: organization/app enrollment rights, limits/cost and two distinct native actors; exact comment permissions and revoke behavior.
- Runtime: can the launcher keep vault/master credentials out of the child environment and prevent identity substitution? Strong same-host isolation remains unproven until tested.
- Offboarding: actual provider revocation and maximum residual lifetime for existing tokens, not just broker denial.

These checks are assigned to the epic's first/adapter stories. They do not block publishing the plan.

## Source appendix

All accessed **2026-10-10**. Confidence here means confidence in the cited documented statement; runtime/account verification has not occurred.

| Ref | Supports | Publisher / source | Publication/update | Confidence |
| --- | --- | --- | --- | --- |
| [1] | Routing/sending price | [Cloudflare Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) | 2026-06-09 | Primary documented |
| [2] | Workers subscription, free/paid usage | [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) | 2026-10-02 | Primary documented |
| [3] | Beta status, mail interfaces | [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) | 2026-10-08 | Primary documented |
| [4] | Subdomain onboarding, no catch-all | [Cloudflare subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/) | 2026-09-25 | Primary documented |
| [5] | Mail/platform limits | [Cloudflare Email limits](https://developers.cloudflare.com/email-service/platform/limits/) | 2026-09-25 | Primary documented |
| [6] | Service auth lifecycle and signed machine claim | [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [application JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) | 2026-10-02 / 06-25 / 05-06 | Primary documented |
| [7] | 50 service-token default limit | [Cloudflare One account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) | 2026-09-04 | Primary documented |
| [8] | GitHub installation token auth/scope/expiry | [GitHub installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) | Living documentation, date unspecified | Primary documented; distinct-author mapping needs canary |
| [9] | Machine account constraints | [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) | Effective 2026-04-27 | Primary documented |
| [10] | Plane user keys/OAuth | [Plane API introduction](https://developers.plane.so/api-reference/introduction) | Living documentation, date unspecified | Primary documented; installed edition untested |
| [11] | Commit email attribution | [GitHub troubleshooting commits](https://docs.github.com/en/pull-requests/how-tos/commit-changes/troubleshooting-commits) | Living documentation, date unspecified | Primary documented |
| [12] | SPIRE implementation/license, SPIFFE and attestation | [SPIRE repository](https://github.com/spiffe/spire), [SPIFFE overview](https://spiffe.io/docs/latest/spiffe-about/overview/), [SPIRE concepts](https://spiffe.io/docs/latest/spire-about/spire-concepts/) | Living docs; observed release v1.15.3 2026-08-21 | Primary documented; deployment fit judgment |
| [13] | Keycloak service accounts/license | [Keycloak repository](https://github.com/keycloak/keycloak), [26.8.0 service-account docs](https://github.com/keycloak/keycloak/blob/26.8.0/docs/documentation/server_admin/topics/clients/oidc/proc-using-a-service-account.adoc) | Release 2026-10-01 | Primary documented; no deployment benchmark |
| [14] | Agent-focused OSS badges/license | [AGNTCY Identity](https://github.com/agntcy/identity) | Observed release v0.0.26 2026-09-29 | Primary documented; alpha maturity/lifecycle caveats |

## Staleness policy

Re-check all pricing/account limits and Beta/availability **before live deployment**, regardless of this report's age. Version/compatibility claims use a one-month freshness window; agent-specific landscape uses three months; general patterns use two years. Publication dates are unknown for some rolling documents; their publication-based freshness cannot be calculated. The access date proves retrieval, not recent authorship. The generated staleness check is captured in `validation.md`; the older SPIRE release observation already warrants a fresh version check before installation. No specific version is pinned for implementation by this report.
