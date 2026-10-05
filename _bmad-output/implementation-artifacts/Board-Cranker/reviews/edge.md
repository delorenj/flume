[
  {
    "location": "skill/scripts/lib/board_crank.mjs:76-77",
    "trigger_condition": "An untriaged Todo ticket has null description_html alongside otherwise ready work.",
    "guard_snippet": "if (typeof html !== 'string') return '';",
    "potential_consequence": "The null description aborts selection for the entire board."
  },
  {
    "location": "skill/scripts/lib/board_crank.mjs:85-92",
    "trigger_condition": "Acceptance criteria are empty or contain prose between numbered requirements.",
    "guard_snippet": "const criteria = parseCompleteAcceptanceSection(html); return validateEveryCriterion(criteria);",
    "potential_consequence": "Unrelated or partial criteria qualify tickets and omit required work."
  },
  {
    "location": "skill/scripts/lib/board_crank.mjs:149-153",
    "trigger_condition": "A ticket names an unresolved prerequisite alongside one completed native dependency.",
    "guard_snippet": "if (!allWrittenPrerequisitesResolved(text, predecessors, byId)) { refuse(i, 'unresolved written prerequisite'); continue; }",
    "potential_consequence": "Work starts while an additional written prerequisite remains unresolved."
  },
  {
    "location": "skill/scripts/lib/board_crank.mjs:114-115",
    "trigger_condition": "An uncertain ticket has an active worker with a different command_id during replay.",
    "guard_snippet": "workers.active.some(w => w.ticket_id !== ownId || w.command_id !== ownCommandId)",
    "potential_consequence": "Replay can dispatch alongside a different execution on the same ticket."
  },
  {
    "location": "skill/scripts/lib/board_crank.mjs:402-412",
    "trigger_condition": "Worker absence expires during board hydration after the last runtime validation.",
    "guard_snippet": "current = await fresh(); require(!boardWip(latest, current.workers, j.ticket_id));",
    "potential_consequence": "A command is published using worker evidence older than sixty seconds."
  },
  {
    "location": "skill/scripts/lib/board_crank.mjs:405-406",
    "trigger_condition": "Acceptance criteria change after intent persistence while the ticket remains eligible.",
    "guard_snippet": "require(ticketFingerprint(currentTicket) === j.ticket_fingerprint, 'requirements changed since intent');",
    "potential_consequence": "The worker receives stale requirements while the updated ticket becomes claimed."
  },
  {
    "location": "skill/scripts/lib/board_crank.mjs:338-341",
    "trigger_condition": "Journal directory changes with a renewed receipt while an old execution remains uncertain.",
    "guard_snippet": "require(c.runtime.state_dir === facts.manifest.board_crank_state_dir, 'journal binding changed');",
    "potential_consequence": "A new command bypasses the original durable execution fence."
  },
  {
    "location": "skill/scripts/momo-board-crank.mjs:38-42",
    "trigger_condition": "Pilot synchronously resolves an op:// credential through a stalled 1Password process.",
    "guard_snippet": "await runPassInSubprocess({ timeoutMs: 45000, killProcessGroup: true });",
    "potential_consequence": "The watchdog cannot interrupt the lookup; the pass can hang indefinitely."
  },
  {
    "location": "skill/scripts/momo-board-crank.mjs:38-42",
    "trigger_condition": "The control pass is bounded.",
    "guard_snippet": "Pilot's Plane constructor uses execFileSync for op read without a timeout; setTimeout cannot interrupt it.",
    "potential_consequence": "Hourly invocations can accumulate beyond the promised pass budget.",
    "kind": "claim",
    "confidence": "high"
  },
  {
    "location": "skill/scripts/lib/board_crank.mjs:114-115",
    "trigger_condition": "Busy or uncertain reruns never start a second worker.",
    "guard_snippet": "boardWip excludes every worker on j.ticket_id, including workers with different command_id values.",
    "potential_consequence": "A saved invocation can start alongside another worker on that ticket.",
    "kind": "claim",
    "confidence": "high"
  }
]
