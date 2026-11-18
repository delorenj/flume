---
title: 'FLUME-29: preflight desk-authored inputs before profile mutation'
type: bugfix
created: '2026-11-18'
status: in-review
route: oneshot
review_loop_iteration: 0
---

<frozen-after-approval reason="Delegated repair of independent review R1 with explicit commit/push authorization">

## Intent

Reject missing or unsafe desk-authored charter and effective selection inputs before step 10 mutates any named profile. Apply this to new, partially provisioned and strict desks; preserve persisted selection precedence and legitimate canonical skill symlinks. Validate the existing role identity before profile creation rather than after it. Correct documentation that claims every unselected local skill is refused, without changing Skillex. Push only the existing review branches and updated template gitlink; no merge, board or live-profile mutation.

</frozen-after-approval>

## Implementation Notes

- Intent gaps: none. No runtime deployment, migration or destructive operation. Explicitly authorized effects are commits/pushes to the existing repair branches.
- Template `_lib.sh` owns desk-root/charter checks; step 10 owns effective selection precedence and invokes the existing identity reader. Actual step-10 fixture regressions cover refusals without profile mutation and canonical links on success.
- `docs/named-specialists.md` distinguishes managed selection from runtime-discovered noncolliding local skills. Existing Skillex advertised-name ambiguity is a separate dependency, not an implementation change here.
- Independent regression recheck is owned by the parent after this branch is pushed. No merge readiness or live acceptance is asserted by this worker.
- Implemented in template `96e7e288026782358584b9b85c764659d240ee0d`: require regular charter; preflight effective selection ancestors/leaf; invoke existing identity validation before profile effects. Added actual-step new/partial/strict and persisted/receipt selection cases, including canonical-link success and FIFO charter refusal.
- Final changed-path verification against the installed unchanged Skillex 0.4.8 package passes 54 tests (51 desk plus 3 project entrypoints). Existing identity/credential-clone/host-state guards pass 13 tests with 41 deselected. All five targeted baseline negative controls fail as expected. Evidence: `FLUME-29/r1-desk-input-repair.md`.
- Full independent post-push review remains pending, so status is `in-review`, not `done`. The parent owns routing the pre-existing Skillex advertised-name collision dependency and live acceptance.
