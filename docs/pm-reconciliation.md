# Owning-PM reconciliation (FLUME-111)

This is an interval PM decision pass, not a second dispatcher. The canonical
implementation is in the hermes-agent template's `template/.scripts/pm-reconcile.py`,
`pm-reconcile-liveness.mjs` and `pm-reconcile.prompt.md`. Flume owns `flume reconcile`;
Pilot owns board writes, Krebs owns Todo → In Progress, Candybar owns the clock.
Neither a manifest nor an installed job is evidence of a completed pass.

## Continuous replenishment after holds

The owning PM never waits for held tickets to resolve before looking for independent
work. Two In Progress tickets with real needs-input/blocked holds occupy zero
Krebs slots. The PM inspects Backlog in priority order (then sort order, ref),
accepts and triages authorized independent tickets, preserving each original
question/dependency. The same rule repeats after each new hold. A live worker,
file collision, open `blocked_by`, out-of-cut launch task, unclear criteria,
reserved decision, or unapproved scope is an exact exclusion reason, not an
invitation to clear a hold or bypass a cap. Existing triaged Todo stays queued;
Krebs alone starts its ordered candidates, only up to the real scope WIP cap.
When no Backlog candidate qualifies, the PM's pass note names the exact reason
for each candidate; `UNAVAILABLE` is never a claim of an empty queue.

The intake `--apply` performs one `px move REF Todo -m <evidence>` and, after
fresh owner/relations/lease/liveness checks, `px label add REF
lifecycle:triaged`. That second command is the PM's completed triage assertion,
not a dispatch. If it fails the ticket stays in Todo *untriaged*, with a refusal
receipt; Krebs may start a catch-up triage under its own supported contract.
This two-write sequence is not atomic against external Plane writers. The
isolated integration regression applies two intakes alongside two preserved
holds and then invokes the **real injected Krebs `runTick`**, verifying the
Krebs `ticket-delegation` publishes and `agent:working` transitions. It does
not simulate a live gateway invocation; parent owns that proof after review.

## Decide and apply

The monitor prints stable candidate lines with an owner/scopes header. `UNAVAILABLE`
is not an empty board. The brief shows at most 30 candidates and a full-ticket
expected digest. The PM must read the actual authority source, product restrictions,
original question or blocker relation, and failed invocation history before writing
a plan. For intake, it must record `authority:`, `restriction:`, `criteria:`,
`dependencies:`, `files:` and `launch-cut:` evidence; the last four are PM
assertions supported by independent readback, not automatic proofs. One plan
has at most six operations, each with the expected digest and
specific hold. For a hold, name
`recheck:`; for failed turns, name `diagnosis:` and `recovery:`. These are evidence
fields, not self-granted permissions. The applier does not prove the **truth** of
prose, so independent readback of the cited evidence remains essential.

`--apply` accepts only a JSON file in that PM desk's runtime directory, requires
the exact `HERMES_BOARD_LEASE_OWNER` and canonical `HERMES_BOARD_LEASE_PATH`, and
refuses another owner's fresh lease. It checks the registry and role opt-out,
exact ticket label routing, snapshot digest and current Krebs/Candystore liveness
under the lease. It stops on a refusal, writes a durable receipt, and refuses
replay of that filename. Hold recovery comments first; only after a new recheck
may it remove exactly one justified hold. Comment failure keeps the hold.
Because Pilot label removal is not transactional with the immediately preceding
read, a remote edit between that read and the write is still a concurrency seam;
reviewers should not treat the lease as locking outside writers. This path is
source-only until that race and the evidence contract are independently accepted.

Never touch `lifecycle:human`, `agent:working`, review handbacks, ambiguous scope,
live/queued/detached turns, or reserved publication/spend/legal/credential decisions.
On a shared board, an unlabeled ticket is shown as a coverage gap, not silently
adopted. If a source is unavailable, keep holds and report the unknown. No
heartbeat, Hermes internal clock, mass restart, new credentials, or permission
change is part of this feature.

## Supported rollout (parent PM after independent reviews only)

1. Land the reviewed canonical template commit and Flume gitlink. Run
   `flume remediate hermes.pm-scaffold <repo> --scripts-only --dry-run` on ONE
   owning PM, inspect the full proposed collateral, then use the same command
   without `--dry-run` only if its scope is approved. If it would refresh the
   five locally modified scripts or unrelated project files, stop and arrange
   a supported scoped projection rather than applying the whole plan. Recheck
   `flume reconcile status <repo> --json`; opt-outs and retired
   desks must remain inactive.
2. Run `flume reconcile install <repo> --json` (preview). For one approved desk,
   run `flume reconcile install <repo> --apply --json`. This writes a local policy,
   two real executable profile wrappers, a **paused** `scheduler=external` lean
   Hermes job, and a **disabled** Candybar project manifest. It does not register,
   resume or run anything. Re-run the preview to check no-op. A conflict refuses
   rather than adopting an existing job or manifest.
3. Review the exact manifest then `candybar register --dry-run -n
   <repo>-pm-reconcile` and, only with explicit installation authority,
   `candybar register -n <repo>-pm-reconcile`. Check the resulting runner and
   job pin. Only after a separate execution authorization enable the external
   job and `candybar resume <repo>-pm-reconcile`; never use an internal Hermes
   schedule. The job's monitor and brief wrappers are real files, not symlinks.
4. Dogfood one explicitly authorized Backlog disposition and one original-hold
   recheck (FLUME-106/107 only when a real hold or answer warrants it). Inspect
   the plan, receipt, Pilot readback and ensuing Krebs status/tick read-only
   evidence. Do not fabricate a synthetic held ticket or clear FLUME-107's
   unanswered Mobile Hub ownership question. Repeat only with a new plan file.
5. Per desk, inspect active scope coverage; unavailable DNET/MKTJNG reads are
   unknown, not coverage PASS. Keep disabled and retired rows disabled. Check
   `candybar doctor --repo . --live --json` for new bypasses; a repository PASS
   alone is not a machine PASS.

Rollback before a run: leave the job paused, manifest disabled and do not
register/resume. After a run: `candybar pause <repo>-pm-reconcile`; disable the
Hermes job, preserve receipts and board evidence, and make no blind reverse
writes. The registry, launcher and board are not rewritten by installation.

## Verification boundary

Isolated tests: template `pytest -q tests/test_pm_reconcile.py`; Flume
`node scripts/run-tests.mjs pm-reconcile`. Source and type/build checks cannot
establish live authority, Candystore availability or successful dispatch. An
independent spec review and independent safety/quality review must precede a
rollout decision. No live board/profile/registration mutation was performed by
the source candidate.
