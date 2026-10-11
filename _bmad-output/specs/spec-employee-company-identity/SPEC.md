---
id: SPEC-employee-company-identity
companions:
  - ../../planning-artifacts/employee-company-identity/requirements.md
  - ../../planning-artifacts/employee-company-identity/architecture.md
  - ../../planning-artifacts/employee-company-identity/epics.md
  - execution.md
sources: []
---

# Employee company identity

## Why

Employees need their own durable company identity, contact address and approved API access instead of acting under Jarad's shared credentials. FLUME-46 defines this capability; implementation must extend existing named employees without introducing another employee registry or assuming an email address is authentication.

## Capabilities

- **CAP-1**
  - **intent:** Enroll an existing employee once and retain who they are as names, posts and harnesses change.
  - **success:** One immutable subject survives migration, rename and retirement; duplicate/adoption conflicts fail without writes and existing memory/post identity is preserved. FLUME-47.
- **CAP-2**
  - **intent:** Request explicitly permitted service access as an authenticated employee from multiple harnesses.
  - **success:** Hermes and a plain client identify the same person with separate run IDs; forged/foreign/expired credentials and employee substitution are denied. FLUME-48.
- **CAP-3**
  - **intent:** Receive company invitations and notifications privately without purchasing a mailbox per employee.
  - **success:** Addressed mail is durably retrievable only by its employee, bounded in size/retention and replay-safe; account costs and real delivery are verified separately. FLUME-49.
- **CAP-4**
  - **intent:** Obtain approved code-host access and leave attributable code/ticket comments.
  - **success:** GitHub credentials carry actual repository/permission bounds and expiry; separate employee apps yield verified distinct native comment authors, including inline review comments. FLUME-50/51.
- **CAP-5**
  - **intent:** Bind the employee to the correct native Plane member without impersonating the operator.
  - **success:** Pilot-owned identity/membership/comment readback matches the employee and board; no shared-key fallback, speculative bot API or managed-execution bypass. FLUME-52 consumes PX-13.
- **CAP-6**
  - **intent:** Suspend/retire access while retaining historical authorship.
  - **success:** New grants/mail access stop; every provider is revoked or explicitly reports residual expiry/manual action. Cross-harness evidence and existing FLUME-39 gateway evidence remain distinct from config generation. FLUME-53.

## Constraints

- Adopted companions contain the complete original acceptance criteria; do not weaken or replace them. Company addresses default to `<handle>@agents.delo.sh`; personal and post aliases have different lifecycles.
- Flume owns employment; PJangler owns project bindings; Pilot/Krebs own provider/managed ticket execution; gateway owns inference credentials; Bloodbank/Candystore own immutable facts.
- Use versioned extensions to existing identity contracts. Preserve named people, portable specialists, desks, post IDs and memory banks. Reconcile old Grolf provider candidates before creating another account.
- Cloudflare is a replaceable authentication/contact adapter. Validate signed machine identity, not an empty JWT sub or arbitrary header. Shared UID does not imply hostile-process isolation.
- Durable secrets stay in 1Password. Resolve only into trusted consumers; never store raw credentials or include them in prompts, logs or facts.
- Account/plan quotas, external provisioning and provider proof require their declared gates. Never call fixture acceptance live deployment. Static provider keys do not expire just because an internal grant does.

## Non-goals

- New employee registry, agent runtime, ticket state machine or full enterprise SSO system.
- Paid mailbox subscriptions, arbitrary outbound email by default, automatic SaaS signup or workforce-wide rollout.
- Production DNS, account creation/rotation/revocation or service activation during the initial FLUME-47/48 loop stretch.
- Repairing unrelated FLUME-45 WIP, unrelated tests or broad shared-host configuration.

## Success signal

Two employees can demonstrably act under their own verified identities, one through two different harnesses, with private mail and attributable sandbox code/ticket comments. Suspending one prevents new access and discloses every outstanding credential. Completion requires all adopted ACs and provider evidence, not just successful builds.

## Assumptions

- The approved epic is the implementation intent; actual account capabilities are still readiness checks, not inferred facts.
- First unattended stretch covers FLUME-47 and FLUME-48. Later provider-facing stories are queued behind explicit spec checkpoints and external-owner prerequisites.
