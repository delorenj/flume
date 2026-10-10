---
title: Employee company identity — requirements
status: planned
created: 2026-10-10
owner: flume
approval_basis: User instructed autonomous research and planning after the proposed defaults; no live provisioning authorized.
---

# Employee company identity

## Outcome

An employee can keep one company identity across projects and harnesses, receive service invitations at a `delo.sh` address, request approved API access, and leave ticket/code comments whose author is correctly attributable. Offboarding stops future access without erasing historical authorship.

This is a new access-and-contact capability on top of existing named employees, not a replacement for Flume's person/post distinction or personal memory.

## Functional requirements

- **FR1 — Stable employee:** Extend the existing named-employee contract with a durable, non-recycled subject and explicit links to current name, post/profile and employment state. Renaming a display name, moving a checkout or changing a harness must not create a new person. Unnamed posts require explicit enrollment rather than silently inventing people.
- **FR2 — Company address:** Assign `<employee-handle>@agents.delo.sh`; optional root-domain and role aliases are secondary. Personal addresses remain attached to the employee; role aliases may be reassigned with an explicit record. Reject collisions and retired-address reuse.
- **FR3 — Receive correspondence:** Route invitation and notification mail to the addressed employee through a bounded, authenticated interface. Unknown and retired recipients fail closed. Delivery retries do not create duplicate work. Mail content is untrusted data, never authority to grant access.
- **FR4 — Prove the caller:** Bind access requests to launcher-proven employee identity and the actual run; an arbitrary `employee_id`, email address, environment variable or CLI flag is not authentication. Demonstrate the same identity through Hermes and a plain non-Hermes client.
- **FR5 — Request access:** An employee requests a named service, resource and permission. Pre-approved grants can be fulfilled automatically; new permissions return an operator-approval requirement, not self-approval. Keep employee subject, provider principal and run identity separate.
- **FR6 — Provider credentials:** Mint short-lived, resource-limited credentials where supported. For static-key providers report that limitation and use vaulted references with provider-side revocation. Never describe broker expiry as expiry of an underlying permanent API key. Reuse FLUME-39 for AutomaticAI hire-time member credentials.
- **FR7 — Ticket authorship:** Use a distinct native Plane member for long-lived employees, verified against users/me, workspace/project membership and returned comment actor. Retain Pilot/Krebs authority and do not fall back to Jarad's/shared key. This is an integration dependency owned by Pilot/Krebs, not a new ticket writer in Flume.
- **FR8 — Code authorship:** Support GitHub issue/PR comments and review comments under a verified provider principal. Represent native-distinct and shared-bot-with-employee-attribution modes explicitly. Git commit author metadata is not authenticated API authorship. No fabricated human account identity.
- **FR9 — Employment lifecycle:** Suspension blocks new grants and mail access immediately at the broker; offboarding revokes existing provider access where supported and reports any residual expiry/revocation dependency. Historical employee and provider identifiers remain resolvable.
- **FR10 — Honest evidence:** Read back provider identity and side effects, retain secret-free receipts, and distinguish planned, locally tested, externally verified, partial, blocked and revoked outcomes. Reconcile ambiguous provider responses before repeating account/token/comment creation.

## Non-functional requirements

- **NFR1 — Cost:** No new per-mailbox subscription in the default plan. Cloudflare first; distinguish Email Routing, Worker execution, storage and outbound charges. Paid-plan activation or a new vendor subscription is not authorized by this planning task. A cost/account check gates deployment.
- **NFR2 — Framework neutrality:** Identity and grant contracts are versioned and independent of Hermes, OpenCode, model choice, and prompt format. Existing adapters consume them; no new agent runtime is required.
- **NFR3 — Secrets:** Existing 1Password DeLoSecrets remains the durable credential authority. Source, config and receipts contain references only. Credentials needed by a broker/launcher are resolved into its process, not exposed in prompts, event bodies or generated files.
- **NFR4 — Proportional scope:** Start with one named canary employee and one sandbox repository/board. No company-wide backfill, generic SaaS marketplace, full email client, enterprise SSO replacement, custom OAuth protocol, or SPIRE rollout in the first slice.
- **NFR5 — Existing authorities:** Flume owns employment and service bindings; PJangler owns projects; Pilot owns the Plane adapter; Krebs owns managed execution; the gateway owns inference token policy; Bloodbank/Candystore own durable facts. Do not introduce a second employee registry or bypass execution control.
- **NFR6 — Isolation:** A shared Unix user is not a security boundary between employees. The proof must prevent a client from selecting another identity; separately describe the deployment sandbox/process boundary needed to resist malicious same-user code.

## Inputs and observed constraints

- User request and subsequent instruction to proceed without another approval round (2026-10-10).
- `contracts/named-agent.schema.json` and `packages/flume-hr/src/workforce/identity.ts`: existing closed schemas; additions need an explicit version/migration, not arbitrary new YAML fields.
- Existing FLUME-16/17/21/29: person identity and memory work; reuse rather than duplicate. Board states do not alone prove implementation.
- FLUME-39: scoped AutomaticAI member credentials and existing vault/config helpers; remains the owner of that implementation.
- `../krebs/docs/execution-contract.md`: native Plane principals, authenticated actors, per-board ownership and provider readback already required. Contract is intent, not deployed proof.
- FLUME-6/7/10: legacy corporate mail/event backlog; examine for overlap before implementation; do not revive obsolete event names from their titles.
- No complete current local PRD/architecture for this capability existed when planning began. This bounded requirements file is the PRD input; `architecture.md` records this initiative's decisions. No UI is in scope.
- Main-checkout FLUME-45 source WIP and event log changes are unrelated and excluded from this planning branch.

## Planning disposition

The user delegated the proposed defaults and completion of the planning work. Decisions are recorded as recommended implementation defaults, not as evidence of live capability. Provider/account unknowns become explicit executable readiness checks rather than repeated questions to the user.
