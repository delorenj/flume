[
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-32-hire/packages/flume-hr/src/hire/PreserveRegistryComments.ts:59-62",
    "trigger_condition": "Another registry writer commits between restoration’s read and write.",
    "guard_snippet": "withRegistryLock(path, () => reconcileAndWrite(before, document(path)));",
    "potential_consequence": "Concurrent employee or channel updates disappear from the shared registry."
  },
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-32-hire/packages/flume-hr/src/hire/PreserveRegistryComments.ts:16-19",
    "trigger_condition": "Registry assignment uses quoted inline comments or supported HERMES_FLEET_HOME expansion.",
    "guard_snippet": "const assignments = parseFleetEnvironment(fleetEnv, env);",
    "potential_consequence": "Copier receives literal quotes or variable names and writes to the wrong registry."
  },
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-32-hire/packages/flume-hr/src/hire/ProjectRoleDeclaration.ts:35-38",
    "trigger_condition": "The fixed temporary filename already points to an unrelated file through a symlink.",
    "guard_snippet": "fd, temporary = tempfile.mkstemp(dir=pdir); os.write(fd, r.dump_yaml(delta).encode()); os.close(fd)",
    "potential_consequence": "Unrelated content is overwritten; config.delta.yaml becomes a symlink despite successful execution."
  },
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-32-hire/packages/flume-hr/src/hire/PreserveRegistryComments.ts:62",
    "trigger_condition": "Comment restoration is interrupted or encounters an I/O failure after truncating the registry.",
    "guard_snippet": "atomicWriteRegistry(path, rendered, { mode: 0o600 });",
    "potential_consequence": "The shared registry becomes empty or partial, replacing Copier’s previously committed complete registry."
  },
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-32-hire/packages/flume-hr/src/hire/PreserveRegistryComments.ts:39-40",
    "trigger_condition": "An inserted alias references a renamed anchor whose original node reconciliation retained.",
    "guard_snippet": "remapIncomingAliases(pair, current, before); previous.items.push(pair);",
    "potential_consequence": "Restoration throws an unresolved-alias error after Copier has already provisioned the employee."
  },
  {
    "location": "/home/delorenj/code/33GOD/flume/.worktrees/flume-32-hire/packages/flume-hr/src/hire/ProjectRoleDeclaration.ts:28-34",
    "trigger_condition": "Retry follows correcting a fleet base that initially omitted terminal or file.",
    "guard_snippet": "removed = [\"delegation\", \"terminal\", \"file\"]  # persist the complete restriction when creating the patch",
    "potential_consequence": "The existing incomplete removal patch survives; onboarding continues failing the Bloodbank permission audit."
  }
]
