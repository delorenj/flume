# Owning-PM reconciliation (FLUME-111): SAFE CHECKPOINT, HOLD

**Automatic board writes are disabled unconditionally. Full source acceptance and
runtime acceptance remain HOLD; this is not delivered or install-ready.**
The canonical template's `pm-reconcile.py --apply` returns exit 2 before reading
configuration, plans, leases, authority or providers. It has no environment or
configuration bypass. The unconditional Pilot writer and receipt writer were
removed; a valid intake, resolve or failed-turn plan cannot execute mutations.

## External dependency: Pilot/Plane conditional mutation

Independent safety review inserted `lifecycle:human` AFTER the final ticket read
through the liveness collaborator. The rejected prototype still moved the intake
and removed a hold. Pilot/Plane currently supplies no provider-enforced conditional
expected-version AND human-absence predicate. A Flume lease serializes local
participants only; another read cannot close an outside writer's race. Pilot owns
this boundary. Do not invent a Flume adapter or pretend a local check is CAS.
Parent is filing the dependency; no dependency ticket ID is asserted here.

Retained reviewer evidence (historical, not acceptance of this checkpoint):
- `flume111-safety-131zhr66/results.log` and `followup.log` in the active PM scratch.
- `spec111-review-ol3ufqjm/default-real-result.txt`: 477 provider GETs for four
  tickets, plus real mutation fan-out. No global runtime/read-cost bound is proven.

## Read-only prototype retained

`--monitor` reports scoped candidates and explicit unavailable/exclusion facts;
`--brief` prints proposal instructions and at most 30 compact candidate entries.
Neither is a dispatcher. Scanning itself is NOT bounded by that display limit.
`--evaluate <absolute-runtime-plan.json>` evaluates a proposal without mutating a
provider, lease, receipt or roadmap. Success is explicitly `proposal_only`, not
an applied disposition. A local no-write plan may contain `writes: []` and a
bounded `note`; the note is printed locally, not durably receipted.

The canonical digest excludes Pilot's derived `pipeline` metadata, but keeps
persisted ticket facts and `updated_at` for proposal freshness. Monitor also
ignores `updated_at`-only churn. It keeps **all comments**, including
`[pm-reconcile]` prefixes: there is no trusted actor/receipt proof permitting an
own-echo exemption in this checkpoint. Spoofed prefixes cannot suppress changes.

Proposal cost accounting reflects actual Pilot fan-out: intake is three provider
mutations (move PATCH, evidence POST, triage PATCH); hold recovery is two. The
proposal rejects totals over six. This arithmetic does not implement mutations
or prove runtime cost bounds. Unknown operations, including `reject`, refuse.

Flume coverage/authority now rejects Krebs' inactive registry forms: trimmed,
case-insensitive `status` or `employment` retired/suspended/offboarded,
`retired: true`, populated `retired_at`, and disabled Bloodbank activation.
Board identifiers/refs allow digit-leading `33GOD`. Manifest slugs normalize to
lowercase without changing case-sensitive repository paths. POSIX wrappers quote
literal apostrophes, spaces, `$()` and backticks; real wrapper subprocesses test
that no substitution occurs.

## Installation and execution gate

The inert installer prototype remains reviewable and is exercised only against
scratch-local fake profiles/jobs. Its output creates a paused externally pinned
job and disabled manifest, not a registration or execution. Preview explicitly
states NOT install-ready. Existing conflicting jobs refuse instead of being
adopted. **Do not install, register, resume, project into desks or dogfood this
checkpoint.** No rollout command sequence is authorized here. Candybar remains
the only clock; Krebs remains the only implementation dispatcher.

## Deferred findings / acceptance gaps

- Provider-conditional version/human-absence mutation and race acceptance (Pilot).
- Supported reject/disposition operation and attributable durable decision evidence.
- Paging starvation/fairness beyond the compact first-30 brief.
- Overall deadline, provider-read budget and realistic large-board cost bounds.
- Exact launcher lease handoff and release/reentrancy semantics for future writes.
- Ancestor-confined receipt paths and atomic one-plan reservation/replay protection.
  The unsafe receipt writer is removed, not repaired or claimed complete.
- Actor/receipt-proven own-comment echo filtering (currently conservative).
- Independent re-review, full AC proof, live intake/resolved-hold readback and actual
  ensuing Krebs invocation. None is satisfied by a modeled collaborator fixture.

## Verification boundary

Template `tests/test_pm_reconcile.py` separates real subprocess fail-closed apply
regressions from read-only proposal checks. Its collaborator fixture explicitly
constructs modeled accepted Todo, then invokes real injected Krebs `runTick` with
FakePlane. That proves only an isolated collaborator contract, NOT PM apply,
production handoff or runtime acceptance. The old successful-apply/partial-write
fixture assertions have been removed, not counted as delivery proof.

Flume `tests/pm-reconcile-regressions.mjs` tests the built CLI against isolated
profiles, inactive lifecycle forms, lowercase manifests and malicious literal
paths. Provider credentials are not inherited by either suite. Run individual
suites with scratch TMPDIR rather than the root runner's unrelated temp behavior.
No live boards, profiles, jobs, registries, registrations or services were changed.
