- Finding floor: 111,767 bytes / 1,000 = 111.767 kB; `N = min(floor(sqrt(111.767) + 1), 10) = min(11, 10) = 10`.

- [boardWip](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:111) ignores every worker associated with the journal’s ticket, including workers with different command IDs. A pending command can therefore be published while another execution owns that ticket. Exempt only workers belonging to the saved command.

- [Dependency checks](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:149) reject written prerequisites only when there are zero native predecessors. One completed native dependency allows an additional unresolved written prerequisite through. Verify each written prerequisite or require explicit reconciliation before selection.

- [Cycle eligibility](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:155) treats missing `cycle_view` as disabled. Unknown cycle configuration therefore bypasses eligibility checks. Require an explicit boolean and complete membership observations when enabled.

- [Downstream scoring](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:166) counts all unfinished tickets listed under `blocking`. A downstream ticket still blocked by another predecessor is incorrectly reported as unblocked by this work. Check its remaining prerequisites before awarding the score.

- [Journal loading](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:185) verifies the envelope digest without checking that journal identities match the envelope’s context. Changing only `journal.ticket_id` reproduced a successful PATCH to ticket 2 using ticket 1’s command and started receipts. Validate these bindings before any recovery action.

- [Configuration comparison](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:219) hashes ordinary `JSON.stringify()` output. Reordering otherwise identical configuration keys makes pending execution unrecoverable through normal reconciliation. Canonicalize configuration serialization before hashing.

- [Command revalidation](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:402) checks that the ticket remains eligible, but never compares its content with the saved prompt. Changing acceptance criteria between intent creation and publication reproduced dispatch of the old criteria followed by a successful claim. Persist and verify the ticket’s content revision.

- [Publication prerequisites](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank.mjs:402) are validated before potentially lengthy board hydration. A worker observation aged 55 seconds became 65 seconds old during hydration, yet publication still occurred; refusal came afterward. Recheck worker freshness and deployment expiry immediately before dispatch.

- [Bundle hashing](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank_ports.mjs:24) covers only three Markdown files. Changes to executable scripts and contract schemas leave the accepted digest unchanged. Include the executable bundle and schemas in the deployment fingerprint.

- [Board hydration](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank_ports.mjs:176) fetches every Todo ticket’s relations sequentially on repeated scans. At 100 tickets and 150 ms per request, three prepublication scans alone consume the entire 45-second watchdog budget. Use bounded concurrency and reserve time for publication and readback.

- [Receipt lookup](/tmp/momo-board-crank-20261005/skill/scripts/lib/board_crank_ports.mjs:197) caps the canonical search at 100 requests while that helper scans forward through an initial 4,096-sequence window. A retained matching receipt that was second newest returned no match in reproduction. Use smaller initial windows or resumable traversal so unrelated history cannot indefinitely prevent acknowledgement and reconciliation.
