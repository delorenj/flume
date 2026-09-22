/**
 * The engagement model: who may open one, and what survives closing it.
 *
 * Two decisions are pinned here because they are policy, not implementation,
 * and a refactor that quietly reverses either one would still typecheck:
 *   1. only a PM opens an engagement -- contractor spend is governed by the PM
 *      who owns the project, so the delegation edge and the budget edge match;
 *   2. closing archives the LEDGER and keeps the SUBSTRATE -- the ledger is
 *      about contractors who are gone, the substrate is about a client who is not.
 */
import assert from "node:assert/strict";
import {
  capabilitiesOf, mayOpenEngagement, mayEngage, closeEngagement, reopenEngagement,
} from "../packages/flume-core/src/index.ts";

let ok = 0; let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); ok += 1; }
  catch (error) { console.log(`  FAIL ${name}: ${error.message}`); failed += 1; }
};

const contract = () => ({
  id: "sow-1",
  scope: ["packages/flume-hr/src/org"],
  acceptance: ["npm run typecheck passes", "flume roster renders 24 rows"],
});

const substrate = () => ({
  artifacts: ["packages/flume-hr/src/org/tree.ts"],
  notebook: "notebooklm://flume",
  banks: { client: "delonet", project: "flume" },
  skills: { client: ["delonet-conventions"], project: ["flume-org-chart"] },
});

const engagement = (over = {}) => ({
  id: "eng-1",
  client: "delonet",
  project: "flume",
  manager: "33god-pm",
  contract: contract(),
  substrate: substrate(),
  openedAt: "2026-09-22T10:00:00Z",
  ledger: [
    { runId: "r1", task: "build the org tree", startedAt: "2026-09-22T10:05:00Z", endedAt: "2026-09-22T10:40:00Z", outcome: "delivered", contributed: ["tree.ts"] },
    { runId: "r2", task: "live columns", startedAt: "2026-09-22T11:00:00Z", endedAt: "2026-09-22T11:30:00Z", outcome: "rejected" },
  ],
  ...over,
});

console.log("engagement regressions");

check("the capability matrix says a contractor is stateless but bound", () => {
  const c = capabilitiesOf("contractor");
  assert.equal(c.hasMemory, false, "a contractor has no memory of its own");
  assert.equal(c.bindsTo, "engagement", "but it IS bound -- to the engagement");
  assert.equal(c.durable, false);
  assert.equal(c.writesCode, true);
  assert.equal(c.delegates, "none");
});

check("orchestrators cannot write code and workers cannot delegate", () => {
  for (const id of ["director", "pm"]) assert.equal(capabilitiesOf(id).writesCode, false, `${id} must not write code`);
  for (const id of ["ic", "contractor"]) assert.equal(capabilitiesOf(id).delegates, "none", `${id} must not delegate`);
});

check("only a PM may open an engagement", () => {
  assert.equal(mayOpenEngagement("pm", contract()), true);
  for (const id of ["director", "ic", "contractor"]) {
    const verdict = mayOpenEngagement(id, contract());
    assert.notEqual(verdict, true, `${id} must not open an engagement`);
    assert.match(verdict, /governed by the project's PM/);
  }
});

check("a contract with no acceptance or no scope is refused at open", () => {
  assert.match(mayOpenEngagement("pm", { ...contract(), acceptance: [] }), /self-reported/);
  assert.match(mayOpenEngagement("pm", { ...contract(), scope: [] }), /unbounded/);
});

check("closing archives the ledger", () => {
  const { engagement: closed, archive } = closeEngagement(engagement(), "2026-09-22T18:00:00Z");
  assert.deepEqual(closed.ledger, [], "the live ledger is emptied");
  assert.equal(closed.closedAt, "2026-09-22T18:00:00Z");
  assert.equal(archive.runs.length, 2, "both runs are preserved in the archive");
  assert.equal(archive.delivered, 1);
  assert.equal(archive.rejected, 1);
  assert.equal(archive.abandoned, 0);
});

check("closing KEEPS the substrate, byte-identical", () => {
  const before = engagement();
  const { engagement: closed } = closeEngagement(before, "2026-09-22T18:00:00Z");
  assert.deepEqual(closed.substrate, before.substrate, "the client file survives the engagement");
  assert.equal(JSON.stringify(closed.substrate), JSON.stringify(substrate()), "and is unmodified");
  // The point of keeping it: both skill scopes and both banks are still there.
  assert.deepEqual(closed.substrate.skills.client, ["delonet-conventions"]);
  assert.equal(closed.substrate.banks.client, "delonet");
});

check("re-engaging carries the substrate but not the ledger", () => {
  const { engagement: closed } = closeEngagement(engagement(), "2026-09-22T18:00:00Z");
  const next = reopenEngagement(closed, { ...contract(), id: "sow-2" }, "2026-10-01T09:00:00Z", "pm");
  assert.notEqual(typeof next, "string", `re-engage must succeed: ${next}`);
  assert.deepEqual(next.substrate, substrate(), "this is where the compounding lands");
  assert.deepEqual(next.ledger, [], "a new engagement starts with nobody on it");
  assert.equal(next.closedAt, undefined);
  assert.equal(next.contract.id, "sow-2", "prior work does not license future work");
});

check("re-engaging needs a PM and a closed prior engagement", () => {
  const { engagement: closed } = closeEngagement(engagement(), "2026-09-22T18:00:00Z");
  assert.match(reopenEngagement(closed, contract(), "2026-10-01T09:00:00Z", "director"), /governed by the project's PM/);
  assert.match(reopenEngagement(engagement(), contract(), "2026-10-01T09:00:00Z", "pm"), /still open/);
});

check("a contractor cannot be spawned into a closed or lapsed engagement", () => {
  const now = "2026-09-23T09:00:00Z";
  assert.equal(mayEngage(engagement(), now), true);
  const { engagement: closed } = closeEngagement(engagement(), "2026-09-22T18:00:00Z");
  assert.match(mayEngage(closed, now), /closed/);
  assert.match(mayEngage(engagement({ contract: { ...contract(), expiresAt: "2026-09-01T00:00:00Z" } }), now), /expired/);
  assert.match(mayEngage(engagement({ contract: { ...contract(), acceptance: [] } }), now), /self-reported/);
});

console.log(failed ? `\n${failed} engagement check(s) failed` : "\nengagement regressions passed");
process.exit(failed ? 1 : 0);
