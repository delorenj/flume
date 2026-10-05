[
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1489-1490",
    "trigger_condition": "A registry gateway_unit incorrectly names an installed heartbeat unit.",
    "guard_snippet": "if (stored !== null && isRetiredHeartbeat(stored)) continue;",
    "potential_consequence": "The heartbeat is excluded from the retired sweep and reported as a duplicate gateway."
  },
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1376-1384",
    "trigger_condition": "An unregistered alias returns its canonical unit name in Id.",
    "guard_snippet": "const sample = lookupByIdOrNames(shown, unit); // request Names alongside Id",
    "potential_consequence": "Valid alias responses become show-malformed, discarding activity evidence and blocking fleet health proof."
  },
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1375-1384",
    "trigger_condition": "Classification stdout exceeds max_show_bytes but remains below the probe's global byte cap.",
    "guard_snippet": "if (Buffer.byteLength(text) > ctx.manifest.limits.max_show_bytes) return failedSweep(kept, 'show-too-large');",
    "potential_consequence": "Oversized responses are parsed and reported successfully despite the declared read limit."
  },
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1422-1424",
    "trigger_condition": "A retired candidate repeats {agent_id}, but the unit substitutes different employee IDs.",
    "guard_snippet": "if (item.split('{agent_id}').length !== 2) fail(where, 'require exactly one employee placeholder');",
    "potential_consequence": "Units matching no consistent employee substitution receive retirement guidance."
  },
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-15/packages/flume-hr/src/org/systemd.ts:1489-1490",
    "trigger_condition": "Leftover heartbeat units remain visible as retired machinery during the unregistered sweep.",
    "guard_snippet": "owned.add(stored); // the sweep excludes owned names before retired detection",
    "potential_consequence": "A heartbeat referenced as gateway disappears from retired cleanup results.",
    "kind": "claim",
    "confidence": "high"
  }
]
