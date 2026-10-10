---
title: Employee company identity — architecture decisions
status: planned-not-deployed
created: 2026-10-10
owner: flume
inputs:
  - requirements.md
  - ../research/employee-company-identity-2026-10-10/research.md
---

# Employee company identity

## Decision

Compose existing employment identity with Cloudflare-managed contact and authentication, a small Flume access facade, existing 1Password custody, and native provider principals. Do not buy employee mailboxes or deploy an identity platform merely to assign email addresses.

This is a brownfield extension of Flume, not a new agent framework. Cloudflare-first is a replaceable adapter, not the canonical employee registry. No live resources are provisioned by this plan.

## Ownership

| Truth | Authority | This capability adds |
| --- | --- | --- |
| Person, post, employment, contact and service bindings | Flume | Stable subject and lifecycle; one reconciled identity projection |
| Project/board enrollment | PJangler canonical manifest | Consume existing project identity; no parallel board map |
| Plane operations and native identity readback | Pilot | Owner dependency for per-employee keys and comments |
| Managed attempts/leases/authorization | Krebs | Existing authenticated actors; no new ticket state machine |
| API grant policy and issuance | Owning provider; Flume mediates approved requests | Bounded adapters; no arbitrary master-key distribution |
| Long-lived secret material | 1Password DeLoSecrets | References, never resolved values in manifests or receipts |
| Immutable facts | Bloodbank/Candystore | Secret-free identity/grant lifecycle evidence, schemas reviewed by Bloodbank owner |
| Process identity and credential injection | Trusted runtime launcher | Hermes adapter plus one plain client proves framework independence |

No boundary change is needed to request a provider token. Flume does not acquire authority to mutate tickets by brokering access. Managed Plane changes remain `px → Bloodbank → Krebs → Pilot provider adapter`.

## AD-1 — One employee, many bindings

Reuse `contracts/named-agent.schema.json`, `workforce/identity.ts` and existing named-person/post resolution. Add a versioned company-identity extension with an immutable UUID subject, non-recycled handle, employment status, email aliases and provider bindings. The subject is an attribute of the existing owning employee definition, not a second employee database. Existing post IDs, profiles, personal banks and routing names remain unchanged.

Illustrative fields only (NOT accepted by today's closed schema):

```yaml
company_identity:
  subject: <immutable-employee-uuid>
  handle: grolf
  email: grolf@agents.delo.sh
  status: active
  bindings:
    cloudflare_access:
      issuer: https://<team>.cloudflareaccess.com
      client_id: <public-client-id>
      credential_ref: op://DeLoSecrets/<item-uuid>/<field>
    plane:
      native_user_id: <verified-native-id>
      credential_ref: op://DeLoSecrets/<item-uuid>/<field>
      attribution_mode: native
    github:
      app_id: <app-id>
      installation_id: <installation-id>
      native_actor_id: <read-back-bot-id>
      signing_key_ref: op://DeLoSecrets/<item-uuid>/<field>
      attribution_mode: native
```

The schema migration must reconcile named people holding posts and portable specialists through the existing validator; unnamed legacy posts are not automatically people. Changing email/display name must not rotate the subject. Retired subjects and personal addresses are tombstoned, never reassigned. Provider IDs are namespaced by service/account/instance.

Existing Grolf Plane candidates are a concrete collision risk: `krebs/docs/activation.md` (2026-10-06) records multiple users, one stale, and mismatched memberships. Adoption must use actual users/me plus membership readback. Do not auto-create a fourth Grolf or rename a post to select a person.

## AD-2 — Mail addresses, not purchased mailboxes

Default `<handle>@agents.delo.sh`; `grolf@delo.sh` is an optional later alias, not a v1 requirement. `flume-pm@agents.delo.sh` is a job alias and may move; a personal address may not.

Use literal Cloudflare Email Routing rules to one Flume-owned mail adapter Worker. Subdomain catch-all is unsupported by current docs. Preserve apex MX records. Provisioning requires a reviewed before/after DNS/routing plan scoped only to owned subdomain records.

The Worker is a lightweight transport boundary: validate recipient against an active projection, enforce size/retention limits, durably accept or report failure, and expose mail through the employee-authenticated interface. Recommended bounded storage: D1 metadata/recipient mapping and private R2 raw-message objects, subject to account entitlement and measured costs. Those are mailbox content, not the audit system of record; retain opaque message references in Bloodbank, not verification codes or raw mail. Choose a bounded retention policy before activation; default proposal 7 days for raw mail, 30 days for delivery metadata, attachments on explicit retrieval only. Dedupe by ingress identity/content+recipient, not sender-controlled Message-ID alone. Replay must not re-run an invitation or create duplicate work.

Registration mail is data. Do not automatically follow arbitrary links or treat a message as permission to request new privileges. Employee B cannot retrieve employee A's invitations. Quarantined/unknown recipients must not fall through to an all-employee inbox.

**V1 is receive-first.** GitHub/Plane comments use their APIs, not outbound SMTP. Cloudflare Email Sending is Beta; arbitrary recipients require Workers Paid. Sending is optional, disabled until an account/cost check confirms it fits the approved budget. No fallback signup with another paid mail vendor.

## AD-3 — Cloudflare Access first; replaceable authentication

For the canary, use a dedicated service token per employee, held by a trusted launcher and individually revocable. Access authenticates the request to an application fronting Flume's small access/mail surface. Flume verifies the Access JWT using a maintained library (e.g. jose), pinned expected issuer, application audience, allowed algorithm, expiry/not-before and rotating JWKS. Map signed `(iss, common_name)` to the declared employee subject. **Service-token JWT `sub` is empty; email and display headers are not the machine identity.** Refuse missing/unknown machine claims and direct-origin bypass.

Do not flip organization-wide strict-service-token settings during this feature. Inspect current policy and prove the chosen application path. The documented default is 50 service tokens/account: preflight counts all existing tokens and reserves rotation/provisioning headroom. Free human seats are a separate quota, not proof of service-token capacity or billing.

Caller evidence is possession of a scoped credential, not hardware/process attestation. A launcher must derive the employee from its enrolled configuration, bind it to a run and hand only the intended access to the child process. A caller cannot select another employee by changing `--employee` or a JSON property. Cross-harness proof is Hermes plus a plain HTTP/CLI client using the same canonical subject.

On a shared Unix UID with arbitrary code and access to the global vault environment, perfect employee isolation is not proven. Keep the vault service token out of employee environments; validate launcher isolation before claiming stronger protection. SPIRE is the later option when genuine workload attestation is required; it still needs distinguishable process/container selectors. Keycloak service accounts are the OSS alternative if Access capacity or cloud dependence becomes unacceptable. Do not deploy either alongside Access by default.

## AD-4 — Narrow access facade, not a universal vault

Expose versioned request/result contracts for `service`, `resource`, `permissions`, requested lifetime and idempotency key. Caller-supplied subject is either absent or checked against authenticated identity; it never selects credentials. Attach run identity from the launcher, not the prompt.

The initial facade supports named pre-approved grants. Requests outside an operator-authored allow-list return `approval_required`/`denied`; the employee cannot grant itself access. Resolve master/signing keys only in the trusted adapter process. Return credentials only to the consuming trusted process over an authenticated channel; never through LLM responses, Bloodbank bodies, logs or files. Operation receipts carry IDs/scopes/expiry/actor, never secrets.

Use provider libraries/APIs rather than building OAuth or JWT signing protocols. Persist idempotency metadata and reconcile uncertain issuance by provider identifiers before retrying. Unsupported revocation or scope must be explicit rather than imitated by an internal timer.

## AD-5 — Provider-native attribution

### GitHub

Prefer one GitHub App per long-lived named employee needing native authorship. Start with two test principals on one sandbox repository to prove distinct author IDs. Enrollment/install is an operator-controlled setup; an employee may request installation, not register arbitrary accounts or grant repositories to itself. Private keys stay vaulted; mint installation tokens restricted to the intended repository and required issue/PR permissions (GitHub documents a one-hour lifetime). Do not enable code push or merge permissions merely to comment.

Store app/installation/native actor IDs. Verify returned author for an issue comment, PR conversation comment and inline review comment independently; reconcile ambiguous POSTs before retry. If a service path only supports a shared app, label it `shared_bot_attributed` and require explicit operator opt-in; it does not satisfy native-distinct acceptance. Per-app operational/cost limits and actual installation access are checked before expansion. No promise of unlimited free app registrations or seat behavior.

Do not create dozens of free GitHub machine accounts: the current terms permit one free machine account in addition to a personal account. Git commit name/email is separate mutable metadata; email matching or push authentication alone does not prove API author identity. Commit signing is outside v1.

### Plane

Adopt or enroll one native user per long-lived employee. Store a reference to its PAT (or supported OAuth binding); verify users/me, workspace and specific board membership, plus read-back comment actor. Use Pilot's existing provider adapter and Krebs binding when managed; never supply Jarad's key as fallback. Manual initial key enrollment is acceptable and must be reported as such; unsupported native account provisioning is a clear blocker, not direct SQL mutation.

The Pilot dependency owns proof on the installed Plane version/edition, pagination and current membership semantics. PJangler owns writing canonical project enrollment; Flume only supplies verified employment/provider binding. No board is enrolled or cut over merely to demonstrate company identity.

### AutomaticAI

FLUME-39 remains the implementation owner. Reuse its consumer naming, helper and vaulted references; link employee subject to existing gateway consumer/profile instead of renaming consumers or minting duplicates. Model inference attribution is not Plane or GitHub identity. Live attribution readback is distinct from successful config rendering.

## AD-6 — Suspension and retirement are part of identity

Before every new grant/mail retrieval, check current employment and binding status. Suspension locally blocks new use; offboarding invokes provider revocation/disable via its maintained adapter. Report `revoked`, `expires_at`, `manual_action_required` or `unverified` per binding. An already-issued bearer token may survive local suspension until provider revocation/expiry; list the maximum residual window. Static Plane/gateway keys require actual provider revocation, not an invented broker TTL.

Retain secret-free historical IDs and audit references; preserve unrelated employees and handwritten config. Rotation changes credentials, not identity. A provider outage cannot be reported as successful retirement.

## Rollout and gates

1. Read-only reconciliation/cost inventory plus identity dry-run for one named person and one portable specialist. No new accounts yet.
2. Isolated launcher/access proof: subject stability, employee impersonation denial, unknown/expired credential rejection, no secrets in logs.
3. One subdomain address receive/retrieve proof with real mail after scoped deployment authorization; preserve apex mail.
4. Two sandbox GitHub principals and native comment readback; Plane owner supplies two verified users/comment receipts. No production-comment smoke.
5. Reuse FLUME-39 gateway evidence; suspend one canary and prove grant/mail denial, rotation continuity and provider revocation/residual expiry.
6. Root integrated acceptance before expanding the cohort. Source tests, sandbox proof and deployed canary are separate statuses.

## Delivery scope of this planning slice

Repos changed now: Flume planning documents and the 33GOD initiative/pin only. Acceptance: cited current vendor evidence; ten FRs mapped; ordered stories with executable criteria; duplicate check; board descriptions read back; reviewed docs on component main then root main. No runtime, DNS, secrets, app registrations or account changes. The Flume notebook currently lacks a bound remote notebook_id; report that publication blocker without provisioning a replacement.
