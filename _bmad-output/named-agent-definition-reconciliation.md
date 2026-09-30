# Named-Agent Definition & Reconciliation

> **Purpose:** One canonical definition of the repo-independent named agent,
> reconciling the parent Epic 2 (stories 2.1–2.4) with flume's existing backlog
> (FLUME-16/FLUME-21) and the landed story-2.1 implementation code.
>
> Produced under FLUME-25 per the Phase 1 delegation from 33GOD parent.
> **Corrected 2026-09-30 per 33god director review** (four rejection points
> addressed inline: write-bank invariant honesty, story 2.1 disposition,
> story 2.2 gaps, stories 2.3/2.4 not dropped).

---

## Part A: Named-Agent Definition

The repo-independent named agent is defined by the `named-agent.schema.json`
contract (commits `6b1f429`, `7c10c85`) and the implementing validator
(`packages/flume-hr/src/workforce/`).

### Canonical shape

```yaml
# Minimal valid definition
schema_version: 1
id: <kebab-case-agent-id>
display_name: <Human-Readable Name>
role: <role-identifier>
charter:
  purpose: <one-line purpose statement>
  directives:          # optional
    - <operational guideline>
  tone: <communication tone>  # optional
skills:
  pack: <skillex-pack-name>
memory:
  write_bank: agent-<id>          # invariant: always agent-<name> (see Part A2)
  recall_banks:                   # optional; write_bank is implicitly first
    - agent-<another-agent>
desk:                             # optional; inferred from deskRoot + id
  path: ~/.agents/workforce/<id>
```

### Required fields

| Field | Type | Notes |
|---|---|---|
| `schema_version` | integer ≥ 1 | Currently always `1` |
| `id` | string | Pattern: `^[a-z0-9]+([-_][a-z0-9]+)*$` |
| `display_name` | string | minLength 1 |
| `role` | string | Pattern: `^[a-z0-9]+([-_][a-z0-9]+)*$` |
| `charter.purpose` | string | One-line statement |
| `skills.pack` | string | Skillex pack reference |
| `memory.write_bank` | string | Pattern: `^agent-[a-z0-9-_]+$` (see Part A2) |

### Key invariants

1. **No repo binding.** The contract requires no `repo`, `project_path`, or
   directory attribute. A named agent lives by its declared memory banks, not
   by where it was checked out.
2. **Binding is declared banks, not a directory.** `memory.write_bank` and
   `memory.recall_banks` are the agent's identity anchors — matching FLUME-21's
   "hire by name with a charter, binding by declared banks, not project_path."
   The `desk.path` is a local projection detail, never an identity attribute.
3. **Write bank invariant.** *Intent:* `memory.write_bank` must be exactly
   `agent-<id>`. *Enforcement status:* see Part A2 — the code today enforces a
   **weaker** constraint than the intent, and the gap is tracked as work.
4. **Desk is derived, not authored.** When the contract omits `desk.path`, the
   validator infers it from `deskRoot + id` (validator.ts line 202), falling
   back to `~/.agents/workforce/<id>`. The desk is a runtime projection.
5. **Skill resolution is canonical.** The validator resolves `skills.pack`
   against the Skillex catalog, verifying every canonical entry has a `SKILL.md`
   (validator.ts lines 253-274). No skills are stored inside the definition.

---

## Part A2: Write-Bank Invariant — What the Code Enforces TODAY vs What It MUST Enforce

Director correction #1 (2026-09-30): the previous version of this document
falsely claimed the schema pattern and semantic check enforce
"`memory.write_bank` must be exactly `agent-<id>`." They do not. The two
sections below state the truth and the required end-state.

### What the code enforces TODAY (as landed in 6b1f429/7c10c85)

- **JSON Schema** (`contracts/named-agent.schema.json` line 82):
  `memory.write_bank` matches pattern `^agent-[a-z0-9-_]+$`. Any string of
  lowercase alphanumerics, hyphens and underscores beginning with `agent-`
  passes — including `agent-anything`, `agent-foo`, or a bank that has nothing
  to do with the agent's `id`.
- **Semantic check** (`packages/flume-hr/src/workforce/validator.ts` line 182):
  `contract.memory.write_bank.startsWith("agent-")`. Same weakness: prefix
  only, no equality with `agent-<id>`.
- **`memory.recall_banks` entries are NOT validated.** The schema constrains
  the list only to `minLength: 1` (when present); there is no per-entry
  pattern check, no reserved-bank exclusion, no duplicate check, and no cap on
  count.

Net: today, `agent-anything` is accepted as a write bank, and arbitrary recall
banks pass. The validator enforces a **weaker** constraint than the intent and
than the parity identity rules.

### What it MUST enforce (the `readRoleIdentity()` standard)

`readRoleIdentity()` (`packages/flume-hr/src/parity/rules.ts`, commit `93059a8`)
is the established identity standard elsewhere in flume. The named-agent
validator must delegate identity validation to it (or apply its rules
equivalently):

- **Write bank equality:** `write_bank` must equal `agent-<name>` **exactly** —
  not merely start with `agent-`.
- **Name pattern:** `^[a-z0-9][a-z0-9_-]{0,57}$`.
- **Bank pattern:** `^[a-z0-9][a-z0-9_-]{0,63}$`.
- **Reserved banks rejected:** `custom` and `hermes` (shared fallbacks) may not
  be named.
- **Post-id collision rejected:** the identity `name` must not equal the post's
  own id / profile name.
- **Every recall_banks entry validated:** each entry must match the bank
  pattern — not just `minLength: 1` on the list.
- **Recall banks capped:** at most 16 total (including the implicit
  `agent-<name>` first entry).
- **Duplicate recall banks rejected** (dedup by inclusion check).
- **Unsupported identity keys detected** and rejected.

**Tracking:** this identity-rule fix is gap (a) of story 2.2 and is scoped
under **FLUME-29** — it is NOT covered by FLUME-21 as written. See Part C.

---

## Part B: Reconciliation

### Against FLUME-21 ("flume hire <name>")

FLUME-21 defines the hire-by-name workflow: "a named officer bound by banks,
not a directory." The landed named-agent contract (story 2.1) aligns fully:

- **`memory.write_bank`** is the identity anchor, matching FLUME-21's "binding
  is declared banks" — no `project_path` or repo attribute required.
- **`desk.path`** is optional, matching FLUME-21's "no faked repo." A named
  agent's desk follows it; the desk is not the agent's identity.
- **The role+charter pattern** implements FLUME-21's concept of a "named officer
  with a charter" — the agent is defined by what it IS (role) and what it DOES
  (charter), not by where it was created.
- **Precedent `fleet-bloodbank-gateway` under `gateways:` with `scope: fleet`**
  maps to the `skills.pack` mechanism — curated skill packs determine what the
  agent can do, not a repo checkout.

The delta: FLUME-21's hire command (`flume hire <name>`) needs the projection
engine to materialize a definition into Hermes profiles, systemd units, and
the registry. The named-agent schema + validator provide the *what*; the
projection engine provides the *how*. Note that FLUME-21's ticket text covers
hire-by-name and binding-by-banks only; the projection-engine gaps are scoped
under FLUME-29 (Part C, story 2.2).

### Against landed story-2.1 code (commits 6b1f429, 7c10c85)

**Schema** (`contracts/named-agent.schema.json`):

| Schematic | Landed state |
|---|---|
| FR-17: named agents bound by Role/JD rather than repo | Implemented: `role` is required, `repo` is absent |
| FR-18: portable Skillex packs | Implemented: `skills.pack` + `showPack()` resolution |
| FR-19: traveling Hindsight banks | Implemented: `memory.write_bank` + `memory.recall_banks` (but with weak validation — see Part A2) |
| FR-20: framework-agnostic harness projections | **NOT yet implemented** — see Part C, story 2.2 → FLUME-29 |
| FR-21: Bloodbank dispatch without repo binding | **NOT yet implemented** — integration story I-1.4 |

**Validator** (`packages/flume-hr/src/workforce/validator.ts`):

| Aspect | Landed state | Tension |
|---|---|---|
| Schema validation | Complete — JSON Schema + semantic checks | — |
| Skill resolution | Complete — `showPack()` + SKILL.md verification | — |
| Desk inference | Complete — derives from `deskRoot + id` or fallback | — |
| Identity rules | **Re-invents identity validation loosely** (Part A2) | Must reuse `readRoleIdentity()` (commit `93059a8`, `parity/rules.ts`) for consistent name/bank validation — tracked as FLUME-29 gap (a) |

---

## Part C: Story Dispositions (AC-2)

Per director-rule-plan Phase 1, each parent story 2.1–2.4 receives exactly one
disposition below. Story 2.5 stays with the parent as integration I-1.4.

### Story 2.1 — Portable Named-Agent Contract

| Field | Value |
|---|---|
| **Disposition** | `done: shipped flume 6b1f429, 7c10c85` |
| **Form** | Done — landed code (NOT "covered by FLUME-21"; FLUME-21 *consumes* this contract, it does not cover the story) |
| **Rationale** | The portable named-agent contract, JSON Schema, and workforce validator shipped as commits 6b1f429 and 7c10c85 on the flume repo. The parent epics.md marks this story "done (tombstone)." FLUME-21's hire-by-name workflow builds ON this shipped contract — it is downstream of 2.1, not a substitute for it. |

### Story 2.2 — Framework-Agnostic Projection Engine

| Field | Value |
|---|---|
| **Disposition** | `FLUME-21 + FLUME-29` |
| **Form** | Partially covered by existing FLUME ticket; remainder covered by new FLUME ticket |
| **Rationale** | FLUME-21's hire-by-name workflow and the existing template steps 10/70/80 (Hermes profile, systemd, registry projection) cover the projection *concept*. But FLUME-21's text does NOT mention three required work items, and they are **gaps as written**: (a) making the 2.1 validator reuse `readRoleIdentity()` (the identity-rule fix, Part A2); (b) letting template step 10 accept a DESK as the owning root instead of requiring a repo; (c) a harness runner for a CLI agent (or any working directory). These three are now scoped under **FLUME-29** ("Projection-engine gaps from story 2.2 + inaugural specialist hires"), opened 2026-09-30. |
| **AC mapping** | Parent AC-1 (Hermes profile generation from agent spec) → FLUME-21 + FLUME-29 item (b). Parent AC-2 (CLI terminal harness) → FLUME-29 item (c). Parent AC-3 (deterministic refresh) → FLUME-21 (`flume remediate` projection refresh). |

### Story 2.3 — Provision the n8n Workflow Specialist

| Field | Value |
|---|---|
| **Disposition** | `FLUME-29` |
| **Form** | Covered by new FLUME ticket (first acceptance hire) — **NOT dropped** |
| **Rationale** | This is one of the owner's two inaugural named specialists; it must not be lost. Provisioning it is the first acceptance hire for the hire-by-name pipeline: `flume hire n8n-specialist` once the projection engine is stable. Scoped under FLUME-29 as an acceptance example, exercising the named-agent contract end to end (role charter, skill manifest, Hindsight bank). |

### Story 2.4 — Provision the Big Chungus Infrastructure Specialist

| Field | Value |
|---|---|
| **Disposition** | `FLUME-29` |
| **Form** | Covered by new FLUME ticket (first acceptance hire) — **NOT dropped** |
| **Rationale** | The owner's second inaugural specialist. Same disposition as 2.3: `flume hire big-chungus-infra` once the hire-by-name pipeline is stable, exercised as an acceptance example under FLUME-29. |

### Story 2.5 (for reference — NOT dispositioned per FLUME-25 scope)

| Field | Value |
|---|---|
| **Disposition** | (out of scope) |
| **Owner** | Parent 33GOD as integration story I-1.4 |
| **Note** | Stays with parent per director-rule-plan; not managed under FLUME-25 |

---

## Part D: Qualified-Ref Summary (AC-3)

The following qualified refs are posted as a comment on FLUME-25:

| Story | Qualified Ref |
|---|---|
| 2.1 | `done: shipped flume 6b1f429, 7c10c85` |
| 2.2 | `FLUME-21 + FLUME-29` (FLUME-21 covers hire-by-name + bank binding; the three projection-engine gaps — validator identity-rule fix, desk-accepting template step 10, CLI harness runner — are scoped under FLUME-29) |
| 2.3 | `FLUME-29` (inaugural n8n workflow specialist — first acceptance hire, not dropped) |
| 2.4 | `FLUME-29` (inaugural big-chungus infrastructure specialist — first acceptance hire, not dropped) |

---

## Part E: Non-Goal Compliance (AC-4)

This document:
- **Does NOT modify** any file under `/home/delorenj/code/33GOD/_bmad-output/` (parent).
- **Does NOT change** any implementation code in `packages/`, `contracts/`, or any other source directory.
- **IS confined** to `flume/_bmad-output/` (this file) plus Plane comments/tickets on the FLUME board.
- **Does NOT touch** the Hermes runtime, registry, systemd, profiles, or any live service configuration.
- **Does NOT add or remove** labels on FLUME-25 or change its state (PM's job).
