---
id: SPEC-one-command-employee-provisioning
companions:
  - brownfield.md
sources: []
---

# One-command employee provisioning

## Why

Jarad wants full unique employee provisioning in a one-liner instead of manually joining hiring, identity enrollment, credentials, mailbox, voice, avatar and Telegram. Existing provider steps should become one resumable onboarding workflow, preserving the same employee on retry.

## Capabilities

- **CAP-1**
  - **intent:** Provision or resume an employee through one non-interactive invocation.
  - **success:** New and existing supported employee classes converge without forced rehire or duplicate resources; every requested service reports ready, deferred, failed or unverified, with an executable recovery action.
- **CAP-2**
  - **intent:** Give the employee a 1Password Identity and private `[agentname]@agents.delo.sh` inbox.
  - **success:** The employee-owned vault item and company address are retained on retry; actual mail reaches the inbox and only that employee can retrieve it through authenticated access.
- **CAP-3**
  - **intent:** Give the employee personal AAI LLM Gateway access and key.
  - **success:** Distinct scoped consumer credentials are vaulted and used by the intended employee runtime without operator/shared-key fallback; provider identity, scope and attribution are verified separately from generated configuration.
- **CAP-4**
  - **intent:** Give the employee a native Plane identity and personal API key.
  - **success:** Provider-owned enrollment establishes the employee session, key and required memberships; Pilot verifies native user and company email on each required board. Binding a manually supplied key alone does not satisfy automated provisioning.
- **CAP-5**
  - **intent:** Assign a premade Voxxy voice or a clone from authorized supplied audio.
  - **success:** The selected voice exists, survives onboarding and produces a verified sample through the employee's intended voice path; failed cloning or missing voices never silently become the shared default.
- **CAP-6**
  - **intent:** Set the employee avatar on `holocene.delo.sh/agents`.
  - **success:** An employee-owned source reference is published through Holocene and the visible avatar is read back; Telegram mirroring is reported separately from Holocene publication.
- **CAP-7**
  - **intent:** Link a supplied Telegram bot token during provisioning or afterwards.
  - **success:** Both paths attach to the same employee, validate bot identity and exclusive ownership, and verify running connection. Omitted tokens remain explicitly deferred and can be supplied later without rehire.

## Constraints

- Extend existing hire/onboard and company identity contracts; do not create another employee registry. Reuse the owners and seams in brownfield.md.
- Durable secrets stay in 1Password. Accept references or protected input that is vaulted before projection; no raw token literals in chat, shell history, logs, command arguments, generated config, receipts or planning artifacts.
- Preserve subjects, native actors, personal memory and unrelated configuration. Conflicts block rather than overwrite; partial success must survive safe retry. Preview creates no local/provider resources.
- Read-only planning does not authorize account creation, credential recovery/rotation, gateway restarts, publishing, deployment or workforce-wide changes. Krebs alone dispatches implementation; independent spec and quality review remain required.
- Provider readback, actual service behavior, configuration and fixtures are different evidence classes. No full-ready result with a failed or unverified requested service; show any deliberately deferred optional service.
- Pilot owns Plane provider operations, Voxxy owns voice creation, Holocene owns avatars, gateway tooling owns inference credentials, and Hermes owns runtime activation. Flume coordinates these boundaries.

## Non-goals

- A new identity service, generic SaaS signup framework, provider client duplication or independent recurring scheduler.
- Automatically creating Telegram bots, paid human 1Password accounts, outbound mail, portraits or clone subjects.
- Changing model-route policy, broadening Cloudflare admission, repairing unrelated employees, or replacing independent review with the implementer's declaration.

## Success signal

A canary employee is provisioned through one invocation with distinct AAI and Plane credentials, private delivered mail, a working selected voice and a visible Holocene avatar. A second run creates nothing duplicate; Telegram works when supplied initially or later; an injected partial failure resumes without changing identity or leaking secrets. Demonstrate both premade and clone voice branches and preserve existing-employee continuity before declaring delivery.

## Assumptions

- “1pass Identity” means the existing Identity-category vault item, not a separate paid human account.
- “Personal AAI key” uses the existing distinct consumer credential under an approved owner group; this is not a separate native AAI user.
- Mail access initially means private inbound delivery and retrieval. Voice/audio and avatar assets are supplied by an authorized operator.
