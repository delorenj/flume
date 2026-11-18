# FLUME-14 Q1: bounded, nonblocking pointer reader

## Candidate and scope

Repair of independently confirmed QUALITY finding Q1 against frozen parent
`ea44f90bb14a2cde8dd5bbe7eb0c397a5b008d20`, on existing branch
`feat/FLUME-14-routing-readiness`. The commit containing this receipt is the
repaired candidate; parent coordinates fresh exact-head SPEC and QUALITY gates.
No main integration or deployment is asserted.

`socketPath()` now opens the pointer with `O_RDONLY | O_NONBLOCK | O_NOFOLLOW`,
checks regular-file, same-owner, private-mode and size constraints with `fstat`
on that descriptor, reads at most 257 bytes (including short reads), rejects
more than 256 before decoding, and closes in `finally`. A raced FIFO cannot
block opening; a pathname replacement cannot redirect reads from an already
opened descriptor. The direct socket path, categorized unavailable result,
identify protocol, deadline/cancellation and activation semantics are unchanged.

Positive session-profile addressability still **cannot** grant routing-ready:
`bloodbank-target-resolution-unsupported` and `capability_readiness: unproven`
remain. No resolver implementation, activation or dispatch was added.

## Persistent real-CLI regression

Coverage lives in `tests/flume-14-routing-regressions.mjs`, already in the test
runner, with `tests/fixtures/flume-14-pointer-interleaving.cjs` as preload.
The preload forces actual filesystem mutations at the scheduling boundary and
records actual descriptor operations. It does not replace the observer, fake
stats, fabricate read results, or mock the socket response. Short-read control
limits each actual kernel read to seven bytes. Every socket request still must
be exactly the existing argument-free `identify` request.

The preload supports the old path-stat boundary and the repaired open/fstat
boundary, so the regression also exercises the vulnerable implementation.

Executed controls and forced interleavings:

- A valid 0600 private pointer padded to **exactly 256 bytes** reaches the actual
  AF_UNIX peer and returns `gateway-serves-declared-profile`; repeated with
  seven-byte reads. Each opens/closes one descriptor and stays routing-unproven.
- A real 0600 FIFO atomically replaces a regular pointer immediately before
  opening, with no FIFO writer. It returns
  `gateway-control-socket-unavailable`, opens/closes one descriptor, reads zero
  bytes and never contacts the peer. Actual elapsed time: **202 ms**, CLI exit 0
  with a 250 ms command budget.
- A symlink to another valid 0600 pointer is rejected before a descriptor opens;
  a 0644 regular replacement opens but is rejected without reading and closes.
- The checked regular inode grows by **1 MiB after fstat**. The actual read is
  **257 bytes**, then rejection without contacting the peer; one open/close.
- A 1 MiB replacement before open is rejected by descriptor size without a read.
  The same replacement after fstat leaves the reader on the original inode;
  only its original 95 bytes are read and the real identify succeeds. No read
  follows the replacement pathname.
- A FIFO replaces the pathname **after descriptor validation**. With a silent
  actual socket peer, deadline returns `TIMEOUT`, exit **7**, `data: null` in
  **429 ms** including Node startup. Repeated with SIGINT sent on the actual
  identify request, returns `CANCELLED`, exit **8**, `data: null` in **208 ms**.
  Both close the original descriptor before the socket exchange; no watchdog
  fires. Every pointer case asserts actual bytes read never exceed 257 and
  every successfully opened pointer descriptor closes.

Ordinary CLI runs retain full fixture-tree content/mode/mtime snapshots. Forced
mutation cases exclude only the deliberately mutated pointer and parent
directory size/mtime; all registry, role/profile configuration, service sentinel
and other fixture paths remain compared. Existing armed child-process,
HTTP/fetch and non-fixture-network tripwires and planted-secret checks remain.

## Red/green and actual checks

On 2026-11-18, before editing production code, the new suite against the rebuilt
frozen parent returned **12 passed, 4 failures**, exit 1. Both forced FIFO cases
blocked past the 3-second outer watchdog despite a 250 ms command budget.
The other new assertions rejected the old uninstrumented/unbounded read path.
Receipt: `flume14-q1-red.log` under the active-profile scratch directory.

After repair, one intermediate test failure counted the harness's own append
open as a product open. The preload now excludes its mutation operation from
observer descriptor accounting; it still performs the real append. No product
assertion was weakened.

Final executed checks (all exit 0):

| Command | Actual result |
| --- | --- |
| `npm run typecheck` | Both workspaces pass |
| `npm run build` | CLI and MCP bundles built |
| `node tests/flume-14-routing-regressions.mjs` | **16 passed, 0 failures**, no skips |
| `node tests/fleet-contract-regressions.mjs` | **128 passed**, no failures/skips |
| `node tests/fleet-shared-bloodbank-regressions.mjs` | Reports `ok` |
| `node tests/fleet-health-regressions.mjs` | **32 passed**, no failures/skips |
| `node tests/fleet-status-regressions.mjs` | **54 passed**, **2 deliberately skipped** host-live cases |
| `git diff --check` | Pass |

Logs/command exits are in
`/home/delorenj/.hermes/profiles/flume-pm/cache/scratch/flume14-q1-verification/`:
`results.json`, `routing.log`, `typecheck.log`, `build.log`, `contract.log`,
`shared-bloodbank.log`, `corrected-env-results.json`,
`health-corrected-env.log`, `status-corrected-env.log`.

Checks used an allowlisted credential-free environment, disabled host overlay,
private absent registry selectors, and active-profile scratch fixtures. Initial
broader runs had an overlong AF_UNIX fixture pathname (health setup failure)
and a realpath-resolved Python symlink that lost the installed venv's PyYAML
(status 8 failures). A shorter scratch TMPDIR and a private executable wrapper
to the installed venv interpreter corrected these environmental failures;
health and status then passed without source/test changes. Initial failure logs
are retained, not relabeled as passes.

Only private fixtures were observed. No live host gateway read, employee
invocation, command publication/replay, work consumption/acknowledgement,
activation/registry/profile/service/clock/board change or other repository edit
was part of this repair. The full repository matrix and target resolver proof
were not run or claimed. Fresh independent gates and authorized integration
remain with the parent.
