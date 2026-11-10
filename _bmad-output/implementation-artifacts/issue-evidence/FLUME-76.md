# Evidence: FLUME-76 — I-9 agent.message coordination

## Issue
- Ticket: FLUME-76, In Progress; reservation `i9-flume-contract-worker`.
- Worker: `i9-flume-contract-worker` / Claude subagent.
- Scope: Flume coordination handoff; Hermes Fleet retains contract and mutation ownership.

## Acceptance Criteria
1. Reconcile only original command `149134bb-3c88-4ebf-8ecf-98610e054933`, correlation `f9126f02-14cf-4fae-8a5c-00026336cefa`, exact thread; never resend.
2. Evidence actual Fleet source/owner selection or exact missing enrollment/implementation binding.
3. Record a supported-target predicate and G1–G3 finite cases, future manifest fields and truthful unavailable entrypoint/observer, without native input.
4. One bounded next true-owner brief conditional on verified source, with dependencies and allowed/forbidden files.

## Repo Changes
- Branch: `feat/FLUME-76-agent-message-coordination`; base `df252be3e2b854abe3449276fa3ac06461d0f8d9`. Head is recorded in the final worker report.
- `_bmad-output/implementation-artifacts/FLUME-76/agent-message-coordination.json`: machine-readable coordination receipt, reconciled current state, gate matrix and blocked owner brief.
- `scripts/check-flume-76-handoff.py`: default = structural check (no journal, no parent-doc reads); `--currency` = separate fail-closed check against pinned digests and the live journal (SQLite `mode=ro`): exactly one row for the original command, comparing only `profile`, `state`, `outcome`, `created_at`, `updated_at`, `rejection_reason`, `failure_code`, `detached_at` and the `terminal_events` id/type/time triples. `lane`, `rejected_at`, `started_events`, `envelope_digest` and event causation ids are not compared.
- `scripts/test-flume-76-handoff.py`: structural baseline plus mutation probes on temporary copies of the real manifest; never touches the live journal or parent docs.
- `scripts/test-flume-76-currency.py`: currency baseline plus fail-closed negatives on temporary copies.
- No Flume runtime/identity/registry/config, Hermes install, Fleet code, parent catalog, BB-32/33, PJAN-202 or Crank changes.

## Verification
- Structural baseline: `python3 -B -I scripts/check-flume-76-handoff.py _bmad-output/implementation-artifacts/FLUME-76/agent-message-coordination.json` → exit 0, `VALID (structure-only)`. Runs independent of live journal and parent-doc state.
- Currency baseline: same argv plus `--currency` → exit 0, `VALID (structure+currency)`: the live journal holds exactly one row for the original command, its compared columns (`profile`, `state`, `outcome`, `created_at`, `updated_at`, `rejection_reason`, `failure_code`, `detached_at`, `terminal_events` id/type/time) equal the recorded values, and all nine pinned source digests match. Uncompared columns are listed under Repo Changes.
- Structural regression at 456facc: `python3 -B -I scripts/test-flume-76-handoff.py` → baseline + **75** rejected real-artifact-copy mutations, actionable exit 1, no tracebacks; includes the stale "response remains pending" blocker claim and an adoption claim, both rejected by a narrow blocker guard. FLUME-77 counts are below.
- Currency regression at 456facc: `python3 -B -I scripts/test-flume-76-currency.py` → baseline + **7** negatives, each rejected inside `check_currency` with a currency-stage diagnostic. Drift is injected only through scratch copies under a temp dir via the explicit, default-off `FLUME76_EVIDENCE_OVERRIDES` path map: scratch SQLite copies of the real row changed/duplicated/removed, one-byte-drifted pinned source copies, drifted resume. Manifest untouched; live journal, real evidence and parent docs never written. Manifest-field mutations of the recorded state remain structural rejections (structure pins them first) and are covered by the structural suite.
- Original independent SPEC session `1f12659d` on prior head `bb9f560`: structural checks passed, currency-equivalent journal probe correctly failed closed ("new selected journal evidence"), and the regression aborted before mutations — the journal coupling that this revision removes.
- No Redis, no bus, no native/pane input, no resend/replay/cross-route at any point.

## Ledger Update
- Reconciliation 2026-11-10T00:20:14Z (orchestrator, resume.md steps 1–3): journal now has exactly one `executions` row for the original command — profile `flume-pm`, state `completed`, outcome `success`, created `2026-11-08T13:48:40.160176Z`, updated `2026-11-08T13:56:46.047665Z`, rejection/failure/detached all null. Terminal events `3fe51b58-8ff9-5212-bdf9-e0988bd0d47c` (`bloodbank.agent.invocation.completed`) and `d16988b9-1a67-5656-a992-fba0aaa433bb` (`bloodbank.conversation.turn.completed`).
- Candystore: exactly 4 correlated lifecycle events, none carrying reply text. Owner reply: `flume-pm` session `20261108_084840_86474df2`, message 3949 (stop, 2026-11-08T13:56:45.783575Z), copy `/home/delorenj/.claude/tmp/i9-flume-pm-final-reply-2026-11-08.md` SHA256 `e779f054f306a7002e1cec6946eea49a10d762917ab63ac7745abcf7c25b5854` (committed byte-identical as `_bmad-output/implementation-artifacts/FLUME-76/evidence/i9-flume-pm-final-reply-2026-11-08.md`; see FLUME-77 below).
- Distinct facts: lifecycle completed/success is **execution evidence**; the reply is the **coordination disposition** (coordination receipt ACCEPTED, coordination-only; Fleet contract adoption BLOCKED). Neither is Fleet adoption, API readiness, input enablement or proof. No exactly-once claim.
- Historical evidence preserved and labelled historical: stored receipt (seq 160790, 09:59:07Z), 10:14:20Z PENDING snapshot, 10:13:53Z observer expiry. Policy unchanged: no resend, replay or cross-route.

## Known Gaps
- AC2 precise blocker stands, corroborated by the reply: no Fleet-authored contract, owner ticket, code home, enrolled board/PM or public API. `hermes-fleet.yaml` card and `~/.hermes/hermes-agent` install are evidence, not an implementation home.
- G1 external schema/version capability, G2 final asynchronous native-session fence, G3 independent receiver input-acceptance observable: **BLOCKED / NOT RUN**. Unsupported ⇒ zero native frames, no terminal fallback. Installed 2.1.319 (`dabafec82…`) is a capability-gated candidate only.
- AC4: `EXACT_ORIGINAL_OWNER_REPLY` satisfied by the coordination reply only; `FLEET_SOURCE_SELECTED`, `FLEET_BOARD_PM_ENROLLED`, `FLEET_AUTHORITY_EVIDENCED` remain MISSING, so the brief stays `BLOCKED_SOURCE_SELECTION` with no ticket/worker.
- Dependencies unchanged: BB-32 before BB-33; PJAN-202 provisional read-only; ASM identity, terminal-driver topology/actions, Crank admission/attempts/unknown fence and separate C3 cases. Hub/workflow, scoped FR-6, full I-8 stay independent.

## FLUME-77 hardening (stacked on 456facc)
Branch `feat/FLUME-77-handoff-checker-hardening`, base `456facc0647afaa8b79f466b970c7c0eec96b0e5` (FLUME-76, unmerged; landing FLUME-77 depends on it). Head is recorded in the final worker report. Recorded manifest values are unchanged (`agent-message-coordination.json` sha256 `57914f1be2c063010606e4c628df6d6c0b4e0886473322ca87c59c9b41e2390a`, as at 456facc).

- **AC1 override marker.** Whenever `FLUME76_EVIDENCE_OVERRIDES` is set (even to an empty map), `--currency` never prints VALID. A run whose redirected evidence passes every check exits 1 with `currency: FLUME76_EVIDENCE_OVERRIDES active, evidence redirected (<key> -> <value>, …); VALID refused`. A set-but-empty variable exits 1. Probes: `override-identical-journal`, `override-identical-receipt`, `override-empty-map`, `override-env-set-empty`.
- **AC2 journal URI escaping.** The journal path is percent-encoded (`urllib.parse.quote(…, safe="/")`) before `?mode=ro`. Probe `override-journal-query-injection` (`<tmp>/a2/journal.sqlite3?mode=rwc&`) exits 2 (`unable to open database file`) and `a2/` stays empty.
- **AC3 override confinement.** Keys must be pinned source paths or the journal; every replacement must resolve (symlinks followed) strictly under `tempfile.gettempdir()`. Probes: `override-outside-tempdir`, `override-dotdot-escape`, `override-symlink-escape`, `override-unknown-key-executable`. All exit 1.
- **AC4 executable pin.** `INSTALLED_EXECUTABLE` and `INSTALLED_EXECUTABLE_SHA256` are checker constants. Structure requires the manifest fields to equal them, `later_validation_manifest.executable_digest` must reference the constant, and `--currency` hashes the constant path. Probe `executable-consistent-retarget` points the path at another real file with its real digest in both digest fields; it exits 1 in the structural suite and in the currency suite.
- **AC5 stale-claim guard.** One guard covers `owner_binding.blocker`, `original_invocation.latest_scoped_journal_read`, `reconciliation.historical_snapshot` and `candidate.installed_inspection`. It rejects:
  - pending-reply wording: pending, outstanding, awaiting, "no reply yet", not received, unanswered, "still pending";
  - adoption claims: "adopted", "adopts", "adoption: accepted".
  "historical PENDING" wording does not match. Negatives: `journal-read-no-reply-yet`, `journal-read-still-pending`, `historical-snapshot-response-pending`, `installed-inspection-adopts`, `blocker-awaiting-answer`, `blocker-adoption-colon`. The `not adopted` false positive is fixed. The accepted variants `blocker-not-adopted` and `blocker-not-yet-been-adopted` must exit 0, and do.
- **AC6 durable evidence.** The five scratch evidence files are committed byte-identical under `_bmad-output/implementation-artifacts/FLUME-76/evidence/`. The checker reads only these copies, in both modes. The manifest still records the original scratch paths as evidence identity, and the digest pins are unchanged. `sha256sum` of the `~/.claude/tmp` originals and of the copies (plus `cmp`), 2026-11-09:

  | File | Bytes | sha256 (original = copy) |
  |---|---|---|
  | `i9-flume-stored-command-receipt.json` | 359 | `e5b1ce26762831bb005fd8584d5fcc60a3e792a8c89f0a0565279b74beeaffae` |
  | `i9-flume-observer-expiry-evidence.json` | 898 | `906478a2d18e5bfb0ecee46653370bd7db6d9f67a41e51865309c3752cfc4035` |
  | `i9-flume-original-request-reconciliation-2026-11-09.json` | 5539 | `d0990398727cadf03ca9657c1652e8b73497f2aef718929dce1cbf55ef53b585` |
  | `i9-flume-pm-final-reply-2026-11-08.md` | 14017 | `e779f054f306a7002e1cec6946eea49a10d762917ab63ac7745abcf7c25b5854` |
  | `i9-flume-correlated-events-2026-11-09.json` | 22143 | `e00620c988e1b1fd77e480e7b981f4f94181e207a5778291fba55ff63522f6a8` |

  Pre-commit scan, by manual read plus a regex scan of each copy: no secrets and no platform chat IDs. The regex scan covered key prefixes, credential words, JWT/PEM, Telegram/Slack/Discord/WhatsApp, 9+ digit bare numbers, emails and phone numbers, and found no NUL bytes. Reviewed non-findings:
  - "authorization" appears twice as prose ("future explicit input authorization").
  - `(~291227080)`, `(~315830654)`, `(~317741355)` and `(~317742655)` are byte offsets into the 340226576-byte 2.1.319 executable.
  - One localhost Candystore query URL.
  - Internal UUIDs, Hermes session and message ids, and the full `prompt_text` of the original request.
- **AC7 documentation accuracy.**
  - This file no longer claims "exactly the recorded reconciled row"; it names the compared and uncompared columns.
  - The checker docstring and `--currency` help say the same.
  - The timestamp comment in `test-flume-76-handoff.py` now states that the three timestamps are exact-value pins and that the format and ordering checks are not reached by those probes.

Verification at the FLUME-77 head (`python3 -B -I`, Python 3.14.4):
- `scripts/check-flume-76-handoff.py <manifest>` → exit 0, `VALID (structure-only)`.
- same plus `--currency`, with `FLUME76_EVIDENCE_OVERRIDES` unset → exit 0, `VALID (structure+currency)`.
- `scripts/test-flume-76-handoff.py` → exit 0: baseline, then **82** rejected mutations (75 + 6 AC5 + 1 AC4), then **2** accepted variants. No tracebacks.
- `scripts/test-flume-76-currency.py` → exit 0: baseline, then **7** drift negatives (unchanged; drifted copies now made from the durable copies), then **10** FLUME-77 probes (AC1 4, AC2 1, AC3 4, AC4 1). No tracebacks, no VALID with overrides set.
- A side-by-side run of each probe against the frozen 456facc checker shows that every new regression discriminates:
  - AC1, AC3 and both AC4 modes printed VALID there.
  - AC2 created `journal.sqlite3` through `mode=rwc`, in a scratch dir.
  - AC5 accepted "no reply yet" and falsely rejected "not adopted".
  - An audit hook on `open` and `sqlite3.connect` shows that 456facc read `~/.claude/tmp`, while the FLUME-77 checker reads only the durable copies plus the `mode=ro` journal.
- No Redis, bus, gateway or native input. No resend, replay or replace of `149134bb…` / `f9126f02…`. The live journal was only opened `mode=ro`. Scratch writes stayed under `TMPDIR`.
- Not done (deferred by the ticket): the additional invariant mutations and the style/info cleanups (walrus, double parsing, loose types, `-O`, unclosed connections, duplicated constants), and `dispatch_policy.replace`.

## Close Recommendation
- FLUME-76 head 456facc passed independent SPEC then QUALITY; it stays frozen and unmerged, and merge waits on the operator. FLUME-77 hardening awaits its own fresh SPEC then QUALITY. Next bounded owner result belongs to Hermes Fleet through its own intake (not FLUME). Do not mark FLUME-76 Done or promote G1–G3.
