# FLUME-87 — integrated charter and brief; canonical hire blocked

Snapshot: 2026-11-19. **Partial delivery, not ticket acceptance.** Reviewed Flume candidate `4170d253302e622ec68abfb4f3d5eb61cd8569b2` and parent 33GOD brief candidate `3b53e8e03cff261aa685a69cfaac5e4eb10b08fb` were fast-forwarded onto their canonical `main` branches and pushed. Both repositories were first updated with `git pull --no-rebase origin main`. No merge conflict, stash, reset, rebase, branch switch or force was used.

## Canonical preflight and blocker

The **single canonical preview** ran from `/home/delorenj/code/33GOD`:

```text
flume hire marketing-director --target-repo 33GOD --purpose 'Work home: 33god-platform/atlas; Atlas showcase messaging and outreach strategy for 33GOD' --skip-telegram --yes --dry-run
```

It correctly resolved `repo=33god`, profile `33god-marketing-director`, canonical template/charter/role paths, `board_scope=advisory` and `reconcile_enabled=false`. **Exit 1:** `hermes.pm-scaffold: 3 locally-modified script(s) preserved; reconcile them into the template before this rule can pass`. See [`live/canonical-preview.json`](live/canonical-preview.json), transcribed from the real terminal result without replaying the command.

The three preserved assets belong to the **existing `33god-pm`**, not the marketing candidate:

- `agents/hermes/pm/.scripts/01-config.sh`
- `agents/hermes/pm/.scripts/_lib.sh`
- `agents/hermes/pm/.scripts/config.example.toml`

Each is clean against parent `main`, last changed by `76862a25b5864afc67ee68198f3bcce05f2ae241` (`launcher defaults point at the ONE shared install`). Their bytes differ from pinned template `3b9b7e89b95dc505031c36245a93effa17dd2781`. The config assets retain the older explicit runtime SHA; `_lib.sh` also differs in portable host helpers and shared-install behavior. The rule labels them locally modified because their blobs are absent from the template object database, **not because this run found uncommitted PM edits**. Hashes, history and exact read-only template diffs are in [`live/scaffold-attribution.json`](live/scaffold-attribution.json).

**Owner:** 33GOD PM scaffold / Flume and hermes-agent-template maintainers must reconcile these committed customizations through the supported scaffold lifecycle. This run does not repair another employee's scripts or weaken the preservation guard. FLUME-78 owns advisory inventory classification, **not this scaffold refusal**. No exact existing ticket for scaffold reconciliation was established, and no board ticket was created.

No live hire was attempted: preview was not safe to advance. Read-only checks confirm zero marketing registry records, no marketing role directory, no named profile and no project-agent entry. The roster returns `NOT_FOUND` (exit 3). No employment definition was fabricated, no duplicate employee was created, and no containment was needed. The declared Atlas work home remains in the charter/brief and preview purpose, **not an employee record**.

## Acceptance evidence

| AC | Actual outcome | Evidence / gap |
| --- | --- | --- |
| 1 — dedicated marketing role | **Delivered.** Advisory director reporting to `33god-pm`; message/story, campaigns and Genesis-desk measurement charter. | `roles/marketing-director.md`; fresh charter tests 3/3, build and typecheck pass on integrated main. |
| 2 — one hired employee / Atlas work home / roster | **Blocked.** Intended identity and paths resolve correctly; no employee exists. | Canonical preview refusal; `live/employment-and-communication.json`. Work-home employment-record and roster acceptance remain open. |
| 3 — marketing / art / designers boundary | **Delivered declaratively.** Marketing owns message/story, FLUME-85 visual direction/sign-off, FLUME-86 pages/artwork. | Charter and parent `33god-platform/atlas/MARKETING-DIRECTOR-FIRST-BRIEF.md`. No production performed. |
| 4 — audit, real Bloodbank reply and returned worker handoff | **Open, not passed.** Scoped audit refuses absent employee; aggregate fails; no safe live message target. | Fresh scoped/aggregate/control receipts below. No Bloodbank publication, terminal event, reply or native worker result exists for marketing. |
| 5 — first assignment queued | **Brief delivered; employment association incomplete.** Retrievable brief names intended employee and explicitly says queued, not dispatched. | Parent brief passes 15 required-phrase checks. No campaign plan delivered or campaign executed; actual hire still required. |
| 6 — public/client/paid gates and privacy | **Delivered declaratively.** Explicit Jarad approval, public export/check/manual visual privacy review, no source/internal paths/hostnames/secrets in public material. | Charter and first brief. No bots, accounts, spend, client contact, publication or campaign activity. |

Independent review was **PASS-for-partial**, not closure acceptance. Earlier generic real-Copier role-hire fixtures passed 24 groups, but were not rerun here and are not this employee's live proof. Fresh closeout checks: `python3 -m unittest scripts/test-marketing-director-charter.py -v` (3/3); `npm run build` (0); `npm run typecheck` (0); parent brief contract (15/15); retained JSON parse and secret-pattern checks. Static phrase checks prove only declarative scope.

## Fresh audit scope and attribution

- [`live/scoped-audit.json`](live/scoped-audit.json): exact supported rules `hermes.pm-scaffold,hermes.runtime-singleton,hermes.registry-parity,hermes.bloodbank-toolsets` with `--agent 33god-marketing-director`; **exit 1**, `No provisioned employee ...`. The command emits an exception rather than structured audit JSON. This is fail-closed absence, **not an employee-scoped pass or a host verdict**.
- [`live/aggregate-audit.json`](live/aggregate-audit.json): unscoped canonical 33GOD audit **exit 1**, `ok=false`, `hostOk=false`. Failures: PM scaffold (20 details), runtime singleton (13), Bloodbank toolsets (11), gateway routing (3), delta-list override (12), registry parity (3), identity conflicts (**16 groups**, not the 19 detail lines including advice). Profile-path and project-record warnings remain visible.
- [`live/identity-without-target.json`](live/identity-without-target.json): private read-only registry copy, candidate removal is a **no-op because candidate is absent**; same 16 unpermitted groups. Live registry bytes unchanged. No candidate-caused conflict can be inferred because no candidate was hired; this is not post-hire acceptance. Existing art-director/PM conflicts remain for repo, project path, identifier and slug. Classification belongs to **FLUME-78**; no handbook exception or registry repair was applied.
- `33god-pm` is the sole current registry claimant of the 33GOD board UUID. The marketing preview's advisory declaration is not proof of a seated employee's routing; real post-hire consumer proof remains open.

## Communication and safety disposition

Because no employee was provisioned, no safe marketing target exists for an attributable Bloodbank request or delegated worker exercise. **Fresh blocker: canonical hiring refusal above.** Historical FLUME-85 `final_answer_capture_unavailable_before_dispatch` is not a fresh FLUME-87 failure and is not reused as communication evidence. Once provisioning can succeed, an authorized bounded request must retain the marketing publication/terminal/reply and native worker-return evidence; a queued receipt alone cannot pass AC4. No unchanged failing command was retried.

`agent-fleet-operations` and `bloodbank-integration` skill loads were quarantined. No security bypass or alternative skill-file read was used. No shared gateway restart or service/config mutation was performed.

Board access was read-only (`px show` for FLUME-87 and FLUME-78). FLUME-87 remained **In Progress**, with identical labels, empty assignees and `updated_at=2026-11-19T03:20:04.764490-05:00` across reads; see [`live/board-read-only.json`](live/board-read-only.json). Parent PM owns hold/closure decisions.

## Integration and cleanup

Both reviewed candidate commits were verified on remote main immediately after integration. Follow-up evidence and the parent Flume pin are committed on main separately; their exact final remote refs are in the operator return, not asserted in advance here.

`git unpushed` ran before cleanup. Both FLUME-87 candidate branches had zero commits ahead of upstream. The Flume worktree's initialized template submodule produced a detached-HEAD warning; its SHA matches the canonical pinned template. Ignored dependency/build/Python caches were inspected. Normal parent brief worktree removal succeeded. Normal Flume worktree removal **refused**: `working trees containing submodules cannot be moved or removed`. It is retained at `/home/delorenj/code/33GOD/flume/.worktrees/feat-FLUME-87-marketing`; no force deletion or submodule deinit was attempted. Inspect ignored-runtime inventory in `live/worktree-cleanup.json`; unrelated FLUME-85 worktrees and all other workers remain untouched.

Unrelated modified `bloodbank-events.jsonl` files, Flume `spec-one-command-employee-provisioning/`, parent research, and other component changes remain outside these commits. No employment repository was written because no live hire ran.
