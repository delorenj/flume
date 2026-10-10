---
title: Flume — employee company identity and access
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - requirements.md
  - architecture.md
  - ../research/employee-company-identity-2026-10-10/research.md
status: planned
created: 2026-10-10
approval_basis: User delegated completion; architecture defaults are recommendations, live deployment is not authorized.
---

# Flume — Epic Breakdown

## Overview

Give employees a durable company identity, a `delo.sh` address and approved API access so work is attributable to them instead of Jarad. Reuse named employees, their posts/desks, provider authorities and the existing vault. This document is a focused capability plan, not a replacement for the rest of Flume's backlog. Story numbers are local to this epic; Plane refs in `board.md` are authoritative task identifiers.

## Requirements Inventory

### Functional Requirements

The full definitions are in [requirements.md](requirements.md).

- FR1: Stable employee subject across name/post/project/harness changes.
- FR2: Unique company email and separately managed role aliases.
- FR3: Isolated, bounded, replay-safe inbound mail access.
- FR4: Authenticated employee/run binding, not a caller-supplied identity string.
- FR5: Explicit service/resource/permission requests under pre-approved grants.
- FR6: Provider-issued scoped credentials with truthful lifetime and revocation.
- FR7: Distinct native Plane authors through Pilot/Krebs.
- FR8: Verified GitHub comment authorship, separate from commit metadata.
- FR9: Suspension, rotation and retirement with retained historical identity.
- FR10: Secret-free receipts, readback and honest partial/blocked outcomes.

### NonFunctional Requirements

- NFR1: No new per-mailbox subscription; preflight Cloudflare account costs/quotas.
- NFR2: Framework-independent contracts; Hermes plus a plain client proof.
- NFR3: 1Password references only in stored config/evidence; no master keys in employee prompts/environments.
- NFR4: One named canary and sandbox resources first; no automatic workforce rollout or optional outbound mail activation.
- NFR5: Preserve Flume/PJangler/Pilot/Krebs/gateway/Bloodbank authority boundaries.
- NFR6: State the launcher trust model; a shared Unix UID is not adversarial isolation.

### Additional Requirements

- Extend existing closed schemas through a versioned migration; preserve post/profile/memory identities.
- Current Cloudflare constraints: literal subdomain routing rules; 50 Access service tokens/account; machine JWT empty sub and signed common_name. Validate actual account capacity and origin enforcement before deployment.
- GitHub installation token expiry/scopes are provider facts; static Plane/gateway keys must not be relabeled short-lived.
- Reconcile existing Grolf Plane candidates before provisioning another account.
- FLUME-39 owns AutomaticAI member-key provisioning; this epic consumes it and adds lifecycle integration only where missing.
- Pilot dependency owns Plane-native action implementation. Parent initiative owns combined acceptance, not child implementation.
- Create storage/entities only as needed by the story using them. No framework starter or new identity database required.

### UX Design Requirements

No new GUI. CLI/API output must clearly distinguish planned, denied, approval-required, partial, provider-verified and revoked/manual-action-required states. Secrets are never presentation output.

### FR Coverage Map

| Requirement | Stories / external outcome |
| --- | --- |
| FR1 | 1.1; continuity regression in 1.7 |
| FR2 | 1.1, 1.3 |
| FR3 | 1.3, 1.7 |
| FR4 | 1.2; cross-harness evidence in 1.7 |
| FR5 | 1.2, 1.4, 1.6 |
| FR6 | 1.4, 1.6, existing FLUME-39, 1.7 |
| FR7 | 1.6 + Pilot owner dependency |
| FR8 | 1.4, 1.5 |
| FR9 | 1.1 basic local state, 1.7 provider lifecycle |
| FR10 | Every story; integrated root acceptance |

## Epic List

### Epic 1: Employees act under their own company identity

**Outcome:** The operator can enroll an existing named employee once, give it a company address, let it request permitted service access from more than one harness, verify who authored its code/ticket comments, and retire its access without destroying attribution.

**FRs:** FR1–FR10. One Flume epic with seven ordered stories; the Plane provider seam is delegated to its owner. No stories are automatically claimed or promoted to Todo by this planning pass. Cloudflare-first is the recommended implementation path; costs/account limitations are executable gates, not assumptions of unlimited free service.

## Epic 1: Employees act under their own company identity

### Story 1.1: Enroll an existing employee without changing who they are

As the operator,
I want a stable company identity and an adoption preview for an existing employee,
So that adding accounts does not create duplicate people or transfer someone else's history.

**Scope/owner:** Flume contracts, validator, identity resolution and record/read-only view. **Depends on:** none. **Requirements:** FR1, FR2, FR9 (local status), FR10; NFR1/3/4/5.

**Acceptance Criteria:**

1. **Given** a named post-holder and a portable specialist fixture, **When** company enrollment is previewed and applied through the public Flume surface, **Then** each receives one persistent subject and proposed `@agents.delo.sh` handle/address on the existing owning definition, **And** post ID, desk, personal memory and unrelated employee fields remain unchanged; a second apply is a no-op.
2. **Given** legacy schema data, a duplicate handle/subject/provider binding or an unnamed post, **When** migration/adoption is requested, **Then** valid legacy data remains readable and conflicts/unnamed-person decisions are explicit blockers, **And** invalid input writes nothing. Existing Grolf native-account candidates are listed for reconciliation rather than auto-created or silently chosen.
3. **Given** a renamed display name, changed project/post or rotated authentication binding, **When** the identity is read, **Then** the same immutable subject remains; retired subjects/personal addresses are not reusable, **And** suspend/retire local state can already be recorded without claiming provider revocation.
4. **Given** no account inventory has been measured, **When** readiness is requested, **Then** Cloudflare plan, mail/DNS conflicts, service-token capacity and provider account rights are reported as unproven, not zero cost/ready, **And** optional authorized read-only probes record time and exact measured results without creating resources.

**Evidence:** isolated public-interface regression commands/results, dry-run diff, duplicate/rename/migration fixtures and a secret-free adoption plan. No live-account creation in this story.

### Story 1.2: Authenticate employee access requests independently of the harness

As an employee,
I want to request a permitted capability using my own authenticated identity,
So that the service can distinguish me from another employee without trusting my prompt.

**Scope/owner:** Flume access contract, Access verification adapter and trusted-launcher interface; runtime implementation coordinated with its owner. **Depends on:** 1.1. **Requirements:** FR4, FR5, FR10; NFR2/3/6.

**Acceptance Criteria:**

1. **Given** two enrolled employees and a configured Access issuer/audience, **When** valid service JWT fixtures are verified, **Then** signed common_name maps to exactly one employee subject despite empty sub, **And** forged signatures, wrong issuer/audience, expired/not-yet-valid assertions, unknown clients and direct-origin requests are refused before grants.
2. **Given** employee A's authenticated request, **When** a body/header/CLI option names employee B or asks for an unapproved resource, **Then** no B credential is selected and no provider mutation occurs; permitted requests return a fixture grant, **And** additional access returns approval_required/denied without self-approval.
3. **Given** the same enrollment used by Hermes and a plain client, **When** each runs under the trusted launcher contract, **Then** receipts identify the same employee and distinct actual runs, **And** the launcher never places the global vault credential or another employee's bootstrap secret in the child environment. Shared-UID limitations are documented and tested to the extent claimed.
4. **Given** repeated identical request IDs and a changed body under an existing ID, **When** requests replay, **Then** identical requests return the original result and changed bodies conflict, **And** audit records contain scopes/IDs/lifetime but no token values.

**Evidence:** offline JWT validation and identity-substitution tests; two-client contract smoke; later authorized canary checks the real Access assertion/policy before live status. Use maintained JWT libraries, not custom cryptography. No provider account provisioning required for fixture completion.

### Story 1.3: Receive company mail without buying employee mailboxes

As an employee,
I want invitations and notifications delivered to my company address,
So that services can contact me without a separate paid mailbox.

**Scope/owner:** Flume mail adapter Worker, bounded mailbox storage/read interface and owned routing projection. **Depends on:** 1.1, 1.2. **Requirements:** FR2, FR3, FR10; NFR1/3/4.

**Acceptance Criteria:**

1. **Given** an enrolled employee and existing `delo.sh` DNS/routing state, **When** onboarding is previewed, **Then** it proposes only a literal rule for the chosen `@agents.delo.sh` address and necessary owned subdomain records, **And** apex mail and foreign records remain unchanged; quotas, Worker/storage entitlement and estimated/measured budget are prerequisites to live apply.
2. **Given** a message addressed to A, **When** it is accepted and A retrieves it, **Then** it is durably retrievable only by A; B, unknown recipients and retired addresses are denied, **And** interrupted storage/delivery does not produce a false accepted/delivered receipt.
3. **Given** duplicate delivery, oversize mail, spoofed sender/Message-ID or hostile instructions in message content, **When** ingestion runs, **Then** the bounded size/retention policy and dedupe are enforced, **And** no access grant, link execution or duplicate task is triggered by the mail itself.
4. **Given** receive-only deployment, **When** a client requests arbitrary-recipient sending, **Then** it is explicitly unavailable, **And** no paid-plan enablement occurs. A scoped later live proof receives a unique external message, reads it back as A, denies B, and records the provider receipt without storing verification codes in audit facts.

**Evidence:** Worker/storage tests including fault/replay paths; DNS before/after comparison; no-op second sync; one authorized external-delivery canary. Raw-mail content is mailbox storage, not a second event ledger.

### Story 1.4: Obtain a GitHub credential for only the approved repository

As an employee,
I want a short-lived GitHub credential for an approved repository and permission set,
So that I can work without carrying Jarad's personal token.

**Scope/owner:** Flume service binding and GitHub App credential adapter. **Depends on:** 1.1, 1.2. **Requirements:** FR5, FR6, FR10; NFR1/3/4/5.

**Acceptance Criteria:**

1. **Given** an operator-enrolled GitHub App/install binding and vaulted signing key for A, **When** A requests an approved token, **Then** the provider request limits repositories and permissions and returns its real expiry, **And** credentials go only to the consuming trusted process, not prompts/logs/files/receipts.
2. **Given** a mismatched app/install, uninstalled repository, foreign employee request or excessive permissions, **When** issuance is attempted, **Then** it is refused without using another employee's app or a shared PAT fallback, **And** provider errors/ambiguous issuance remain partial/unverified until reconciled.
3. **Given** token expiry/rotation and request retries, **When** the adapter obtains replacement access, **Then** subject and native provider binding remain stable and the retry policy is bounded, **And** no fixed token-length assumption rejects valid current provider tokens.
4. **Given** a designated sandbox installation after cost/rights checks, **When** the live proof is authorized, **Then** allowed repository access succeeds, a disallowed repository fails, and actual expiry/scopes are captured; app enrollment and native actor adoption are explicit steps, **And** no automated human account signup or workspace-wide grant occurs.

**Evidence:** fake-provider tests, secret leakage assertions and a bounded sandbox token acceptance receipt. This story does not require mail delivery or comment posting.

### Story 1.5: Leave code-review comments with verified employee authorship

As the operator,
I want code comments to identify the actual employee,
So that I can distinguish employees' feedback from a shared automation account.

**Scope/owner:** Flume GitHub action adapter/canary consuming 1.4. **Depends on:** 1.4. **Requirements:** FR8, FR10; NFR3/4/5.

**Acceptance Criteria:**

1. **Given** two employee-bound apps installed on one sandbox repo, **When** each posts a marked issue/PR conversation comment, **Then** provider readback returns two different native author IDs matching their bindings, **And** changing displayed text or email cannot satisfy native-author proof.
2. **Given** a test PR with a known commit/path/line, **When** A posts an inline review comment, **Then** readback confirms author, PR and code location, **And** insufficient permissions, stale diff positions and unsupported review modes fail explicitly.
3. **Given** a timed-out comment POST, **When** reconciliation runs, **Then** it finds the existing marked comment before retry or reports ambiguity, **And** no blind replay creates duplicates.
4. **Given** only a shared-bot binding or mutable git author/email metadata, **When** native-distinct proof is requested, **Then** the result is not native-verified; shared_bot_attributed is available only as an explicitly configured alternative, **And** commit metadata/signing is not used as a substitute for API authorship.

**Evidence:** isolated adapter tests and sandbox author/comment readbacks for both employees and both comment classes. No production review/comments or merge permissions are needed.

### Story 1.6: Bind employees to verified native Plane identities

As the operator,
I want an employee's Flume record linked to its actual Plane member,
So that Pilot/Krebs can comment under that member rather than Jarad.

**Scope/owner:** Flume provider-binding adoption and consumer contract only. Pilot owns users/me, membership and comment operations; PJangler owns project enrollment; Krebs retains managed execution. **Depends on:** 1.1, 1.2 and Pilot owner request PX-13 (listed in board.md). **Requirements:** FR6, FR7, FR10; NFR3/5.

**Acceptance Criteria:**

1. **Given** existing candidate principals and vaulted credential references, **When** adoption consumes the provider-owner verification result, **Then** native user/instance/workspace/board match the employee's requested binding, **And** stale Grolf candidates, foreign memberships or a credential resolving to Jarad block adoption rather than falling back.
2. **Given** unsupported automatic member/PAT provisioning on the installed Plane edition, **When** enrollment is requested, **Then** it reports the exact manual enrollment prerequisite, **And** no direct DB write, unverified bot endpoint or imaginary OAuth capability is used.
3. **Given** two verified employee bindings, **When** the owning Pilot path posts sandbox comments, **Then** Flume's verification record references returned native actors and comment IDs matching those employees, **And** legacy vs managed mode is obeyed with no board cutover in this story.
4. **Given** a static PAT or missing provider expiry, **When** access is reported, **Then** its actual static/expiry and revocation semantics are explicit, **And** a local access-session TTL is never described as expiration of that PAT.

**Evidence:** fixture consumer tests plus provider-owner receipts from the installed-compatible sandbox path. This story may finish local implementation with external proof blocked, but cannot be marked fully accepted until the dependency's readbacks exist.

### Story 1.7: Retire access without losing the employee's history

As the operator,
I want suspension, rotation and retirement to cover an employee's bindings,
So that access stops while previous work stays attributable.

**Scope/owner:** Flume employment lifecycle coordinator and adapter results; each provider remains its revocation authority. **Depends on:** 1.3, 1.5, 1.6; FLUME-39 for AutomaticAI enrollment verification (do not duplicate it). **Requirements:** FR1, FR3, FR4, FR6, FR9, FR10; all NFRs.

**Acceptance Criteria:**

1. **Given** an active canary with mail/auth/GitHub/Plane bindings and the existing gateway binding, **When** suspended, **Then** new grants and mail reads are immediately denied at the facade, **And** every already-issued credential is listed with actual provider revocation status or residual expiry/manual requirement.
2. **Given** offboarding during one provider outage, **When** revocation is attempted, **Then** successful providers are recorded separately from unresolved providers and safe retries converge without duplicate deletion, **And** the command never reports complete revocation while a static key remains usable/unverified.
3. **Given** key rotation or a person moving posts/harnesses, **When** continuity is checked, **Then** the subject and historical comment/mail provenance remain stable, **And** no retired address/subject is handed to a replacement employee or unrelated record changed.
4. **Given** authorized sandbox canaries using Hermes and a plain client, **When** an end-to-end run requests access, retrieves mail and verifies code/ticket authorship, then suspends one employee, **Then** correlated secret-free receipts prove the identities and denials, **And** actual gateway attribution is linked to FLUME-39 evidence rather than inferred from a generated config.

**Evidence:** deterministic lifecycle/fault tests; provider readbacks; measured revocation/residual windows; two-harness receipts. Root initiative accepts the combined result. No general rollout until that acceptance, and no silent claims of same-UID isolation.

## Sequencing and boundaries

- Start **1.1**, then **1.2**. Mail (1.3), GitHub access (1.4) and owner-led Plane work can proceed independently after their prerequisites.
- 1.5 follows 1.4; 1.6 consumes the Pilot result; 1.7 integrates accepted adapters. Dependencies reference only earlier Flume stories or explicit existing/external owners.
- All seven are Backlog planning items, not implementation receipts. No paid feature or broad account/DNS change is authorized by filing them.
- Outbound email, corporate SSO, cross-organization agent badge exchange, full SPIRE attestation and commit signing are deferred—not hidden acceptance requirements.
