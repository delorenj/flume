---
title: 'FLUME-55: named-agent recall compass (deterministic last-5-projects list)'
type: feature
created: 2026-10-12
status: done
route: dispatch
baseline_commit: ece7068
review_loop_iteration: 0
context:
  - '{project-root}/contracts/recency.schema.json'
  - '{project-root}/packages/flume-hr/src/workforce/company.ts'
---

# FLUME-55 — named-agent recall compass

## Intent

A named agent with no bound directory has no anchor for project context. This
component is a machine-owned, most-recent-first list of the last 5 projects a
person interacted with (`$HERMES_FLEET_HOME/recency/<person>.json`), used to
order or narrow the person's **declared** personal recall banks. No LLM in the
write path; the list is data, never prompt text.

Memory taxonomy (operator decision 2026-10-12): personal bank = episodic
narrative; project banks = project facts. Recency never writes a project bank
and never invents bank membership — it re-orders or narrows the declared set
only. An empty list narrows nothing and is never an error.

## Acceptance (from the ticket) and evidence

1. **Deterministic write path, MRU, dedupe, cap 5, specified eviction** —
   `touchProject` in `packages/flume-hr/src/workforce/recency.ts`; regressions:
   ordering, dedupe-with-source, cap eviction. PASS.
2. **Observable, replayable interaction source** — every entry carries
   `last_seen` + `source` (manual / hook:session-start / candystore-replay);
   `--at` allows exact replay of an event stream. State is version-1 JSON per
   `contracts/recency.schema.json`. PASS.
3. **Recall integration** — `flume identity recall <employee> [--narrow]`:
   write bank, then declared banks most-recently-interacted first; `--narrow`
   intersects the declared set with recent projects. Undeclared projects never
   leak in; empty recency narrows nothing. Repo-bound post-holders and
   specialists share one resolution path. PASS.
4. **Tests** — `tests/named-agent-recency-regressions.mjs`, 7 fixtures:
   preview-vs-apply, MRU, dedupe, cap-5 eviction, recall ordering + narrowing,
   specialist parity, write coupling (registry/role bytes unchanged), refusals
   (unnamed post, unknown employee, invalid project id, corrupt state). PASS.
5. **Formal contract** — `contracts/recency.schema.json`; state validated on
   read (version, owner, entry shape); corrupt state refuses before any write.

Deferred honestly: hook/session-start wiring into the canonical
`~/.agents/hooks/lib/hindsight-bank.sh` resolver belongs to the hooks owner
(fan-out), and is sequenced with FLUME-54's Grolf deployment work. The flume
side (`recent --touch`, `recall`) is the consumable contract that wiring calls.

Open contract finding (recorded for FLUME-54): the named-agent validator
requires lowercase bank ids, but real project banks can be mixed-case
(`33GOD`, derived verbatim from repo basename). Resolve bank-name casing
before Grolf's recall list is rewritten.

## Verification commands

```
node scripts/run-tests.mjs named-agent-recency named-agent-regressions company-identity employee-access
# 4/4 suites PASS, incl. named-agent-recency-regressions (7 fixtures)
```
