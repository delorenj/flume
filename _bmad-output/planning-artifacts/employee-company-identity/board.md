# Company identity — board and delivery index

Created/read back 2026-10-10. All new items are **Backlog**, unassigned; no implementation, account provisioning or live activation was started. References below are authoritative; story numbers are local to this capability.

## Owners

- [FLUME-46 — Employees act under their own company identity](https://plane.delo.sh/33god/browse/FLUME-46/): Flume epic, High.
- [33GOD-82 — I-5 company identities across mail/access/code/tickets](https://plane.delo.sh/33god/browse/33GOD-82/): cross-project outcome and integrated acceptance, High. Parent does not hold child implementation stories.
- [PX-13 — Verify employee-native Plane identity and comment authorship](https://plane.delo.sh/33god/browse/PX-13/): owner request to pilot-pm; preserve Krebs/PJangler authority and decompose in the owning project as needed, High.

## Flume stories

| Story | Ticket | Outcome | Dependencies | Priority |
| --- | --- | --- | --- | --- |
| 1.1 | [FLUME-47](https://plane.delo.sh/33god/browse/FLUME-47/) | Enroll existing employee, retain identity | None | High |
| 1.2 | [FLUME-48](https://plane.delo.sh/33god/browse/FLUME-48/) | Harness-independent authenticated requests | FLUME-47 | High |
| 1.3 | [FLUME-49](https://plane.delo.sh/33god/browse/FLUME-49/) | Company inbound mail without paid mailboxes | FLUME-47, FLUME-48 | Medium |
| 1.4 | [FLUME-50](https://plane.delo.sh/33god/browse/FLUME-50/) | Repository-scoped GitHub access | FLUME-47, FLUME-48 | Medium |
| 1.5 | [FLUME-51](https://plane.delo.sh/33god/browse/FLUME-51/) | Verified code-review comment authorship | FLUME-50 | Medium |
| 1.6 | [FLUME-52](https://plane.delo.sh/33god/browse/FLUME-52/) | Adopt verified native Plane binding | FLUME-47, FLUME-48, PX-13 | Medium |
| 1.7 | [FLUME-53](https://plane.delo.sh/33god/browse/FLUME-53/) | Revoke access, preserve history | FLUME-49, FLUME-51, FLUME-52; existing FLUME-39 gateway evidence | Medium |

Every story has Given/When/Then acceptance criteria and explicit evidence/non-goal boundaries in [epics.md](epics.md); the complete body was posted to the ticket. Child-parent references, titles, descriptions and Backlog state were read back. PX-13 is intentionally not a cross-board sub-issue: the owner board keeps its own work.

## Existing work reused, not rewritten

- FLUME-39: AutomaticAI member-token provisioning remains its own implementation.
- FLUME-16/17/21/29: person identity/memory and portable specialist work is an input, not a new identity registry.
- FLUME-6/7/10: inspect older corporate-mail scope before implementation; no automatic cancellation or stale-schema adoption.
- 33GOD-63: existing managed execution program; no enrollment or mode cutover triggered here.
- FLUME-45: unrelated uncommitted hire-path change remains excluded; this epic does not certify the earlier unsupported fix claim.

## Recommended first implementation unit

**FLUME-47**, then **FLUME-48**. Reconcile the people and provider candidates before creating more credentials. Mail, GitHub and owner-led Plane work can then proceed in parallel without making outbound email a blocker.

## Publication limitation

`pj notebook status /home/delorenj/code/33GOD/flume --json` returned a planned binding with no notebook_id and failed remote/Overview checks. No notebook repair or creation was attempted. Git-backed documents and Plane links are delivered; remote notebook publication requires that existing binding to be provisioned/repaired separately.
