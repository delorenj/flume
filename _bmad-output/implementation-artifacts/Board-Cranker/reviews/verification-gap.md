### Sequencing dependencies can be ignored without failing verification

- **Changed surface:** `start_after` and `finish_after` join the required predecessors at [board_crank.mjs:142](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:142).
- **Impacted consumer or site:** The readiness check before publication at [board_crank.mjs:404](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:404).
- **Existing test evidence:** `Regression gap`: dependency scenarios populate only `blocked_by` at [test_board_crank.mjs:219](/tmp/momo-board-crank-20261005/skill/scripts/tests/test_board_crank.mjs:219). Repository-wide searches found `start_after` and `finish_after` only initialized as empty arrays in tests.
- **Missing verification:** An incomplete predecessor supplied solely through either sequencing relation prevents dispatch and ticket mutation.
- **Demonstration:** Removing both sequencing arrays from the predecessor union left all 41 tests passing in an isolated copy.
- **Consequence:** A ticket can start before its sequencing prerequisites finish.
- **Disposition:** `patch` — add parameterized readiness tests for both relation types, asserting incomplete predecessors prevent dispatch and completed predecessors permit selection.

### Pilot dependency payloads are not verified at the readiness boundary

- **Changed surface:** Production board loading retrieves native relations at [board_crank_ports.mjs:177](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank_ports.mjs:177).
- **Impacted consumer or site:** Dependency eligibility in [rankCandidates:137](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:137).
- **Existing test evidence:** `Regression gap`: the production HTTP fixture always returns empty relations at [test_board_crank.mjs:623](/tmp/momo-board-crank-20261005/skill/scripts/tests/test_board_crank.mjs:623). Its assertions check issue count and the requested relations URL, without checking dependency-based selection.
- **Missing verification:** Ranking the board returned by the production adapter excludes a ticket whose HTTP relation payload identifies an incomplete predecessor.
- **Demonstration:** Keeping the HTTP request but replacing its returned relations with empty arrays left all 41 tests passing. Other dependency tests supply their relation maps directly.
- **Consequence:** Native dependencies can disappear during board loading, allowing blocked work to dispatch.
- **Disposition:** `patch` — extend the production-boundary test with nonempty relation responses and assert eligibility through `rankCandidates(await ports.board(c), clock)`.

### Production cycle membership mapping is bypassed by cycle tests

- **Changed surface:** Plane cycle rows become ticket memberships at [board_crank_ports.mjs:183](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank_ports.mjs:183).
- **Impacted consumer or site:** Assigned-cycle eligibility at [board_crank.mjs:159](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:159).
- **Existing test evidence:** `Regression gap`: cycle tests directly construct `cycle_members` at [test_board_crank.mjs:197](/tmp/momo-board-crank-20261005/skill/scripts/tests/test_board_crank.mjs:197) and [test_board_crank.mjs:234](/tmp/momo-board-crank-20261005/skill/scripts/tests/test_board_crank.mjs:234). The production fixture disables cycles at line 625.
- **Missing verification:** Production HTTP cycle membership responses cause tickets assigned to future or finished cycles to be excluded.
- **Demonstration:** Changing the production mapping to `row.nonexistent_issue_id` left all 41 tests passing. Actual assigned tickets would then appear unassigned to the ranker.
- **Consequence:** Work reserved for an ineligible cycle can dispatch.
- **Disposition:** `patch` — add cycle-enabled Pilot-boundary fixtures and assert the resulting eligibility, including supported string and object issue references.

### Production lifecycle receipt retrieval has no exercising test

- **Changed surface:** Retained completion and started receipt retrieval at [board_crank_ports.mjs:193](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank_ports.mjs:193) and [board_crank_ports.mjs:202](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank_ports.mjs:202).
- **Impacted consumer or site:** Dispatch acknowledgement at [board_crank.mjs:396](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:396) and fence retirement at [board_crank.mjs:293](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:293).
- **Existing test evidence:** `Regression gap`: fixture ports manufacture lifecycle envelopes directly at [test_board_crank.mjs:103](/tmp/momo-board-crank-20261005/skill/scripts/tests/test_board_crank.mjs:103) and line 109. The production-boundary test exercises runtime, board and PATCH operations only. Repository-wide symbol/import searches found no additional tests exercising these production receipt ports.
- **Missing verification:** The production adapter retrieves matching retained events through the canonical direct-get helpers and supplies them to dispatch and reconciliation.
- **Demonstration:** Returning `[]` from production `started` and `null` from production `completed` left all 41 tests passing.
- **Consequence:** Published commands remain uncertain, and completed executions retain their fences indefinitely.
- **Disposition:** `patch` — add fixture-backed production receipt tests that execute canonical direct-get traversal and assert matching events enable PATCH and completion reconciliation.

### CLI read-only guards are not covered by the inspect test

- **Changed surface:** CLI operation and `--dry-run` flags control mutation permission at [momo-board-crank.mjs:45](/tmp/momo-board-crank-20261005/skill/scripts/momo-board-crank.mjs:45).
- **Impacted consumer or site:** Public `inspect`, `execute --dry-run` and `reconcile --dry-run` invocations, whose read-only contract is documented at [board.crank.v1.md:29](/tmp/momo-board-crank-20261005/skill/contracts/board.crank.v1.md:29).
- **Existing test evidence:** `Regression gap`: the inspect test directly passes `{ execute: false }` to the library at [test_board_crank.mjs:143](/tmp/momo-board-crank-20261005/skill/scripts/tests/test_board_crank.mjs:143). Repository-wide filename/import searches found no test invoking the CLI.
- **Missing verification:** Actual CLI arguments produce no lease, journal, publication, ticket or reconciliation writes.
- **Demonstration:** Replacing both CLI mutation guards with `execute: true` left all 41 tests passing.
- **Consequence:** Inspection or dry-run commands can mutate execution state.
- **Disposition:** `patch` — add child-process CLI tests with fixture runtime and HTTP responses, asserting read-only storage and provider behavior.

## Other findings

- At [board_crank.mjs:150](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:150), both written-prerequisite checks apply only when `predecessors.length === 0`. I reproduced a ticket with completed native predecessor TEST-9 and an explicitly unresolved written prerequisite TEST-10; `rankCandidates` admitted it with dependencies containing only TEST-9. Any completed native predecessor therefore bypasses detection of additional unmatched written prerequisites, contrary to the readiness contract.
