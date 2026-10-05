---
id: SPEC-flume-29-named-specialists
companions:
  - brownfield.md
  - specialist-charters.md
sources:
  - ../../named-agent-definition-reconciliation.md
---

# FLUME-29: named specialists with a traveling desk and memory

## Why

The operator needs specialists that can work across repositories without pretending a runtime directory is a project. Flume already validates portable employee definitions, but hiring and profile projection still depend on a repository. Complete that path so one definition supplies an employee's charter, skills, memory identity, and reproducible runtime; prove it with the n8n and infrastructure specialists.

## Capabilities

- **CAP-1**
  - **intent:** Hire an employee by its named definition without an owning repository.
  - **success:** A definition with no repo or project_path produces a workforce desk, Hermes profile, registry record, and truthful roster/audit result; occupied identity or invalid definition is refused without replacing existing state.
- **CAP-2**
  - **intent:** Give each specialist an owning desk from which its declared skills are available.
  - **success:** A repo-less hire resolves its pack(s) or set through Skillex and projects exactly that loadout into a strict Hermes profile, with empty external_dirs and no profile .agents discovery root.
- **CAP-3**
  - **intent:** Run a specialist in an arbitrary working directory with its own charter, curated skills, and traveling memory.
  - **success:** A Hermes CLI session launched from an unrelated directory demonstrably loads the specialist charter and exact loadout, writes to agent-<id>, and recalls only its declared banks plus that implicit own bank.
- **CAP-4**
  - **intent:** Refresh an employee after changing its definition without hand-editing projections.
  - **success:** Charter, loadout, and bank changes update desk/profile/harness projections deterministically while preserving unrelated state; a second refresh changes no managed bytes or receipts.
- **CAP-5**
  - **intent:** Hire the n8n workflow specialist with the operator's workflow standards.
  - **success:** n8n-specialist is hired through CAP-1, resolves the n8n Skillex set, passes applicable workforce audits, and demonstrates its charter and agent-n8n-specialist memory in CAP-3.
- **CAP-6**
  - **intent:** Hire Big Chungus to inspect and operate the operator's infrastructure using its established conventions.
  - **success:** infra-specialist is hired through CAP-1 with the charter and curated infrastructure skills in specialist-charters.md, passes applicable audits, and demonstrates agent-infra-specialist memory in CAP-3.

## Constraints

- Reuse contracts/named-agent.schema.json, workforce/identity.ts, and the FLUME-32 role declaration and selection APIs. Identity validation is already delivered; do not create a second identity contract.
- Definitions are the authored source of charter, loadout, and banks. Skill selections reference the canonical Skillex catalog; managed links may expose canonical skills, never copied or unmanaged duplicates.
- Preserve the distinction between the owning workforce desk and the generated strict Hermes profile. No fabricated repo/project_path, profile .agents discovery root, or nonempty skills.external_dirs.
- Inference uses api.automaticai.io with the employee's own hermes-<profile> member token. FLUME-39 owns token minting; an unavailable token is an explicit deployment dependency.
- Canonical template changes land in hermes-agent-template and enter Flume through its gitlink. Flume owns employee definition/record/policy, PJangler projects, Pilot/Krebs tickets, Hermes runtime, Bloodbank events.
- Definition or catalog failure, occupied identity, untrusted observation, and partial projection must have truthful outcomes. Refresh preserves unrelated registry/org comments, handwritten content, and other employees.

## Non-goals

- Bloodbank invocation of named specialists (parent I-1.4), member-token minting (FLUME-39), additional CLI adapters, org-chart redesign, or migration of existing repository PMs.

## Success signal

Both inaugural specialists can be hired without a project, run from unrelated working directories with verified charter/loadout/own-bank behavior, and refresh twice with a zero-change second pass. Evidence separates source tests, actual profile state, live invocation, and any unresolved token or runtime dependency.

## Confirmed projection choices

- Hermes CLI is the first harness.
- The owning definition root is ~/.agents/workforce/<id>; ~/.hermes/profiles/<id> is its generated runtime projection.
- Big Chungus uses identity infra-specialist and bank agent-infra-specialist.
