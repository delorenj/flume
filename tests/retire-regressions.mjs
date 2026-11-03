// `flume retire`: take an employee out of service, keep the record, and prove who gets the tickets.
//
// The incident (2026-11-02): pile-of-dumb-things-pm was "retired" by hand -- its telegram status set to
// `retired`, nothing else. Its row kept `bloodbank.enabled: true` and a `plane:` block claiming the shared
// TOLT board as scope_default, so the n8n Bloodbank node (fleet.ts resolveFleetAgentForBoard) kept picking
// it for every game, forge and unlabeled ticket while the real PM (tolt-pm) got none.
//
// Everything here runs the REAL built dist in a subprocess against a constructed fleet in /tmp (never the
// live ~/.hermes). The registry is the real TOLT shape plus an unrelated row full of YAML comments.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "flume-hr", "dist", "index.js");
if (!existsSync(CLI)) {
  console.error("SKIP retire-regressions: dist/ is not built (npm run build)");
  process.exit(0);
}

const work = mkdtempSync("/tmp/flume-retire-");
let failures = 0;
let count = 0;
const check = async (name, fn) => {
  count += 1;
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
};

const BOARD = "eb302959-0eac-48da-8fd5-ae1666bd500f";

// ---- the registry -------------------------------------------------------------------------------
// `pileBlocks` lets a case change just the retiring row; everything else is the fixed TOLT shape.
const PILE_BLOODBANK = `    bloodbank:
      enabled: true # keep routing on until retired
      gateway_scope: fleet
      target_agent_id: pile-of-dumb-things-pm
`;
const PILE_PLANE = `    plane:
      project_id: ${BOARD}
      workspace: tolt
      identifier: TOLT
      scope_label: [repo:game, repo:forge]
      scope_default: true
`;
function registryText({ pileBloodbank = PILE_BLOODBANK, pilePlane = PILE_PLANE, pileTelegram = "retired" } = {}) {
  const pm = (id, label, extra = "") => `  ${id}:
    profile_name: ${id}
    role: pm
    type: hermes
    bloodbank:
      enabled: true
      gateway_scope: fleet
      target_agent_id: ${id}
    plane:
      project_id: ${BOARD}
      workspace: tolt
      identifier: TOLT
      scope_label: ${label}
${extra}`;
  return `# Fleet registry fixture: this header comment must survive every retire.
schema_version: 1
agents:
  # --- the TOLT board: four rows share one project id ---
${pm("lost-things-forge-pm", "repo:forge")}
  pile-of-dumb-things-pm:
    profile_name: pile-of-dumb-things-pm
    role: pm
    type: hermes
    telegram:
      provisioning_status: ${pileTelegram}
      bot_username: pile_pm_bot
${pileBloodbank}${pilePlane}${pm("tolt-director", "repo:tolt")}${pm("tolt-pm", "repo:game", "      scope_default: true\n")}  # An unrelated employee. Its comments and quoting are none of retire's business.
  unrelated-pm:
    profile_name: unrelated-pm # keep this trailing comment
    role: pm
    type: hermes
    display_name: "Unrelated — the PM"
    bloodbank:
      enabled: true
      gateway_scope: fleet
      target_agent_id: unrelated-pm
    plane:
      project_id: 11111111-2222-3333-4444-555555555555
      identifier: UNR
      scope_default: true
`;
}

let seq = 0;
/** A fresh fleet under /tmp with the given registry text. Returns the env seams and a runner. */
function fleet(text, { desks = [] } = {}) {
  seq += 1;
  const home = join(work, `home${seq}`);
  const fleetHome = join(home, ".hermes");
  const registry = join(fleetHome, "agents-registry.yaml");
  mkdirSync(join(fleetHome, "profiles"), { recursive: true });
  writeFileSync(registry, text, { mode: 0o600 });
  writeFileSync(join(fleetHome, "org.yaml"), "version: 1\ncompany: {name: Fixture Co., handle: Fix}\nceo: {id: ceo, display_name: Boss, title: CEO}\n");
  writeFileSync(join(fleetHome, "config.yaml"), YAML.stringify({ model: { default: "fleet-model" }, platforms: { telegram: { enabled: true } } }));
  for (const id of desks) {
    const dir = join(fleetHome, "profiles", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.delta.yaml"), `# keep me\n${YAML.stringify({ skills: { project_discovery: true }, secrets: { onepassword: { enabled: true, env: { TELEGRAM_BOT_TOKEN: `op://DeLoSecrets/${"botitem".padEnd(26, "0")}/credential` } } } })}`, { mode: 0o600 });
    writeFileSync(join(dir, "config.yaml"), "# GENERATED FILE\nmodel:\n  default: stale\n", { mode: 0o600 });
  }
  const env = { HOME: home, NO_COLOR: "1", TMPDIR: "/tmp", PATH: process.env.PATH, HERMES_FLEET_HOME: fleetHome, HERMES_AGENTS_REGISTRY: registry };
  const run = (args, cwd = ROOT) => new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  const json = async (args) => { const r = await run([...args, "--json"]); return { ...r, body: JSON.parse(r.stdout) }; };
  return { home, fleetHome, registry, env, run, json, read: () => readFileSync(registry, "utf8"), agents: () => YAML.parse(readFileSync(registry, "utf8")).agents };
}

const ownerOf = (board, label) => board.routes.find((route) => route.label === label)?.owner;
const PILE = "pile-of-dumb-things-pm";

// ---- the bug, reproduced -------------------------------------------------------------------------

await check("BEFORE retire the report reproduces the incident: pile wins game, forge and unlabeled", async () => {
  const f = fleet(registryText());
  const { body, status } = await f.json(["retire", PILE]);
  assert.equal(status, 0);
  const board = body.routing.find((entry) => entry.board === BOARD);
  assert.ok(board, "the board the row claimed is reported");
  assert.equal(ownerOf(board.before, "repo:game"), PILE, "the retired row won repo:game");
  assert.equal(ownerOf(board.before, "repo:forge"), PILE, "...and repo:forge, ahead of the forge PM");
  assert.equal(ownerOf(board.before, null), PILE, "...and every unlabeled ticket");
  assert.equal(ownerOf(board.before, "repo:tolt"), "tolt-director", "only the label nobody else's row shadows still reached its owner");
  assert.ok(board.before.flags.some((flag) => flag.code === "multiple-defaults"), "two scope_default rows on one board");
  assert.ok(body.routing[0].before.claimants.find((c) => c.id === PILE).eligible, "the retired row was a fully eligible owner");
});

// ---- preview ------------------------------------------------------------------------------------

await check("preview writes nothing: registry bytes, mode and directory are untouched", async () => {
  const f = fleet(registryText());
  const before = f.read();
  const mode = statSync(f.registry).mode;
  const { body, status, stdout } = await f.json(["retire", PILE]);
  assert.equal(status, 0);
  assert.equal(body.applied, false);
  assert.equal(body.alreadyRetired, false);
  assert.equal(f.read(), before);
  assert.equal(statSync(f.registry).mode, mode);
  assert.ok(!existsSync(`${f.registry}.retire.${process.pid}`));
  assert.equal(body.bloodbank.changed, true);
  assert.equal(body.removedPlane.scope_default, true, "the claim it WOULD remove is shown");
  const text = (await f.run(["retire", PILE])).stdout;
  assert.match(text, /dry run; pass --apply/u);
  assert.match(text, /repo:game\s+tolt-pm/u, "the preview already says who gets game tickets afterwards");
  assert.ok(stdout.length > 0);
});

// ---- apply --------------------------------------------------------------------------------------

await check("apply disables routing and removes the claim; every other byte of the registry is untouched", async () => {
  const text = registryText();
  const f = fleet(text);
  chmodSync(f.registry, 0o640);
  const { body, status } = await f.json(["retire", PILE, "--apply"]);
  assert.equal(status, 0, JSON.stringify(body));
  assert.equal(body.applied, true);
  const expected = text
    .replace("      enabled: true # keep routing on until retired\n", "      enabled: false # keep routing on until retired\n")
    .replace(PILE_PLANE, "");
  assert.notEqual(expected, text);
  assert.equal(f.read(), expected, "exactly the intended lines changed: header, comments, quoting and every other row byte-identical");
  const row = f.agents()[PILE];
  assert.equal(row.bloodbank.enabled, false);
  assert.equal(row.bloodbank.gateway_scope, "fleet", "kept so the row can be restored");
  assert.equal(row.bloodbank.target_agent_id, PILE);
  assert.equal("plane" in row, false);
  assert.equal(row.telegram.provisioning_status, "retired", "the record is kept, not deleted");
  assert.equal(body.removedPlane.project_id, BOARD, "the old claim survives in the result");
  assert.deepEqual(body.removedPlane.scope_label, ["repo:game", "repo:forge"]);
  assert.equal(statSync(f.registry).mode & 0o777, 0o640, "mode preserved");
});

await check("AFTER apply the routing report sends game and unlabeled to tolt-pm, forge to the forge PM, tolt to the director", async () => {
  const f = fleet(registryText());
  const { body } = await f.json(["retire", PILE, "--apply"]);
  const after = body.routing.find((entry) => entry.board === BOARD).after;
  assert.equal(ownerOf(after, "repo:game"), "tolt-pm");
  assert.equal(ownerOf(after, null), "tolt-pm");
  assert.equal(ownerOf(after, "repo:forge"), "lost-things-forge-pm");
  assert.equal(ownerOf(after, "repo:tolt"), "tolt-director");
  assert.deepEqual(after.flags, [], "the board is clean once the claim is gone");
  assert.ok(after.routes.every((route) => route.eligible));
  assert.deepEqual(body.flags, []);
  // The disk agrees with the report: a later preview from the written registry sees the same board.
  const again = await f.json(["retire", "tolt-pm"]);
  assert.equal(ownerOf(again.body.routing[0].before, "repo:game"), "tolt-pm", "what was written resolves the way the report said");
});

await check("disabling only bloodbank is NOT a retirement: the claim still wins and the ticket is dropped (owner-ineligible)", async () => {
  const disabledOnly = PILE_BLOODBANK.replace("enabled: true", "enabled: false");
  const f = fleet(registryText({ pileBloodbank: disabledOnly }));
  const { body } = await f.json(["retire", PILE]);
  const before = body.routing.find((entry) => entry.board === BOARD).before;
  assert.equal(ownerOf(before, "repo:game"), PILE, "the resolver still picks the disabled row");
  assert.equal(before.routes.find((route) => route.label === "repo:game").eligible, false);
  const ineligible = before.flags.filter((flag) => flag.code === "owner-ineligible");
  assert.ok(ineligible.length >= 3, "game, forge and unlabeled all go to an ineligible owner");
  assert.ok(ineligible.some((flag) => flag.detail.includes("bloodbank.enabled is false")));
  // Retiring such a row still has the claim to remove, so it is not "already retired".
  assert.equal(body.alreadyRetired, false);
  assert.equal(body.bloodbank.changed, false);
  assert.equal(body.removedPlane.scope_default, true);
  const applied = await f.json(["retire", PILE, "--apply"]);
  assert.equal(ownerOf(applied.body.routing[0].after, "repo:game"), "tolt-pm");
  assert.deepEqual(applied.body.routing[0].after.flags, []);
});

await check("a second apply converges and says already retired", async () => {
  const f = fleet(registryText());
  assert.equal((await f.json(["retire", PILE, "--apply"])).status, 0);
  const settled = f.read();
  const { body, status } = await f.json(["retire", PILE, "--apply"]);
  assert.equal(status, 0);
  assert.equal(body.alreadyRetired, true);
  assert.equal(body.applied, false);
  assert.equal(f.read(), settled);
  const text = (await f.run(["retire", PILE, "--apply"])).stdout;
  assert.match(text, /already retired/u);
});

await check("an unknown employee is an error with exit 1 and no write", async () => {
  const f = fleet(registryText());
  const before = f.read();
  const run = await f.json(["retire", "no-such-pm", "--apply"]);
  assert.equal(run.status, 1);
  assert.equal(run.body.ok, false);
  assert.equal(run.body.found, false);
  assert.match(run.body.errors[0], /no employee "no-such-pm"/u);
  assert.equal(f.read(), before);
  const text = await f.run(["retire", "no-such-pm"]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /retire no-such-pm failed/u);
});

await check("an invalid registry is refused without a write", async () => {
  const f = fleet("agents:\n  a: [unclosed\n");
  const before = f.read();
  const run = await f.json(["retire", "a", "--apply"]);
  assert.equal(run.status, 1);
  assert.match(run.body.errors[0], /invalid/u);
  assert.equal(f.read(), before);
});

// ---- the board report's flags -------------------------------------------------------------------

await check("multiple-defaults survives a retire that does not remove one of the defaults", async () => {
  const f = fleet(registryText());
  // tolt-director is not a default; retiring it leaves pile AND tolt-pm both scope_default on the board.
  const { body } = await f.json(["retire", "tolt-director"]);
  const after = body.routing.find((entry) => entry.board === BOARD).after;
  assert.ok(after.flags.some((flag) => flag.code === "multiple-defaults" && flag.detail.includes(PILE) && flag.detail.includes("tolt-pm")));
  assert.ok(body.flags.some((flag) => flag.startsWith("multiple-defaults:")));
  assert.match((await f.run(["retire", "tolt-director"])).stdout, /! multiple-defaults:/u);
});

await check("board-unowned: retiring the only claimant leaves the board with nobody to take tickets", async () => {
  const f = fleet(registryText());
  const { body } = await f.json(["retire", "unrelated-pm"]);
  const board = body.routing[0];
  assert.equal(board.board, "11111111-2222-3333-4444-555555555555");
  assert.ok(board.after.flags.some((flag) => flag.code === "board-unowned"));
  assert.equal(ownerOf(board.after, null), null);
  assert.ok(board.before.flags.every((flag) => flag.code !== "board-unowned"), "it was owned before");
});

await check("label-unclaimed: a label only the retiring row declared is still reported, with its fallback owner", async () => {
  // The live shape after the hand fix: pile holds no claim, so tolt-pm is the only row declaring repo:game.
  const f = fleet(registryText({ pilePlane: "" }));
  const { body } = await f.json(["retire", "tolt-pm"]);
  const board = body.routing.find((entry) => entry.board === BOARD);
  const game = board.after.routes.find((route) => route.label === "repo:game");
  assert.ok(game, `repo:game must stay in the report after its only declarer leaves: ${JSON.stringify(board.after.routes)}`);
  assert.equal(game.owner, "lost-things-forge-pm", "first in order (no default left, then id)");
  assert.equal(game.declared, false);
  assert.equal(board.after.routes.find((route) => route.label === "repo:forge").declared, true);
  assert.equal(board.after.routes.find((route) => route.label === null).declared, true);
  assert.ok(board.after.flags.some((flag) => flag.code === "label-unclaimed" && flag.detail.includes("repo:game") && flag.detail.includes("lost-things-forge-pm")), JSON.stringify(board.after.flags));
  assert.ok(board.before.flags.every((flag) => flag.code !== "label-unclaimed"), "every label was declared before");
  assert.ok(body.flags.some((flag) => flag.startsWith("label-unclaimed:")));
  const text = (await f.run(["retire", "tolt-pm"])).stdout;
  assert.match(text, /repo:game\s+lost-things-forge-pm {2}\(fallback: nobody declares it\)/u);
  assert.match(text, /! label-unclaimed:/u);
});

await check("a bus-ineligible claimant that is the last eligible one: the remaining owner is flagged, not hidden", async () => {
  // forge-pm and a second claimant whose bloodbank block is missing: after retiring forge-pm, repo:forge's
  // only remaining claimant is unroutable.
  const text = registryText().replace(
    /  tolt-director:\n    profile_name: tolt-director\n    role: pm\n    type: hermes\n    bloodbank:\n      enabled: true\n      gateway_scope: fleet\n      target_agent_id: tolt-director\n/u,
    "  tolt-director:\n    profile_name: tolt-director\n    role: pm\n    type: hermes\n",
  );
  assert.ok(!text.includes("target_agent_id: tolt-director"), "the fixture edit applied");
  const f = fleet(text);
  const { body } = await f.json(["retire", "lost-things-forge-pm"]);
  const after = body.routing[0].after;
  assert.equal(ownerOf(after, "repo:tolt"), "tolt-director");
  assert.ok(after.flags.some((flag) => flag.code === "owner-ineligible" && flag.detail.includes("repo:tolt") && flag.detail.includes("no bloodbank block")));
});

await check("a row with no bloodbank block is reported as already unroutable, and its claim is still removed", async () => {
  const noBloodbank = registryText({ pileBloodbank: "" });
  const f = fleet(noBloodbank);
  const { body } = await f.json(["retire", PILE, "--apply"]);
  assert.equal(body.bloodbank.present, false);
  assert.equal(body.bloodbank.changed, false);
  assert.ok(body.nextActions.some((a) => a.includes("no bloodbank block")));
  assert.equal("bloodbank" in f.agents()[PILE], false, "no block is invented");
  assert.equal("plane" in f.agents()[PILE], false);
});

await check("a bloodbank-enabled row with NO plane block is still disabled: not 'already retired', applied, then converges", async () => {
  const f = fleet(registryText({ pilePlane: "" }));
  const before = f.read();
  const preview = await f.json(["retire", PILE]);
  assert.equal(preview.status, 0);
  assert.equal(preview.body.alreadyRetired, false, "enabled routing is work to do even without a board claim");
  assert.equal(preview.body.bloodbank.changed, true);
  assert.equal(preview.body.removedPlane, null);
  assert.equal(f.read(), before, "preview writes nothing");
  const applied = await f.json(["retire", PILE, "--apply"]);
  assert.equal(applied.status, 0, JSON.stringify(applied.body));
  assert.equal(applied.body.applied, true);
  assert.equal(f.agents()[PILE].bloodbank.enabled, false);
  assert.equal(f.read(), before.replace("      enabled: true # keep routing on until retired\n", "      enabled: false # keep routing on until retired\n"));
  const again = await f.json(["retire", PILE, "--apply"]);
  assert.equal(again.body.alreadyRetired, true);
  assert.equal(again.body.applied, false);
});

// ---- owner eligibility: each of the resolver's four checks -----------------------------------------

/** Edit one row's block of the registry text (from the `  <id>:` line to the next two-space key or comment). */
function editRow(text, id, from, to) {
  const start = text.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `row ${id} exists`);
  const end = text.slice(start + 1).search(/\n {2}[#\w]/u);
  const block = text.slice(start, end < 0 ? undefined : start + 1 + end);
  assert.ok(block.includes(from), `${id} contains ${JSON.stringify(from)}`);
  return text.slice(0, start) + block.replace(from, to) + (end < 0 ? "" : text.slice(start + 1 + end));
}

for (const [name, from, to, why] of [
  ["no profile_name", "    profile_name: tolt-pm\n", "", /tolt-pm has no profile_name/u],
  ["gateway_scope is not fleet", "gateway_scope: fleet", "gateway_scope: agent", /tolt-pm gateway_scope is not 'fleet'/u],
  ["target_agent_id is someone else", "target_agent_id: tolt-pm", "target_agent_id: tolt-director", /tolt-pm target_agent_id mismatch \(tolt-director\)/u],
]) {
  await check(`an owner with ${name} is ineligible: its tickets are flagged owner-ineligible`, async () => {
    const f = fleet(editRow(registryText(), "tolt-pm", from, to));
    const { body } = await f.json(["retire", PILE]);
    const after = body.routing.find((entry) => entry.board === BOARD).after;
    const game = after.routes.find((route) => route.label === "repo:game");
    assert.equal(game.owner, "tolt-pm", "still chosen as owner: the resolver does not skip ineligible rows");
    assert.equal(game.eligible, false);
    assert.match(game.why, why);
    assert.equal(after.claimants.find((c) => c.id === "tolt-pm").eligible, false);
    assert.ok(after.flags.some((flag) => flag.code === "owner-ineligible" && flag.detail.includes("repo:game") && flag.detail.includes("tolt-pm")), JSON.stringify(after.flags));
    assert.ok(body.flags.some((flag) => flag.startsWith("owner-ineligible:")));
    // The healthy rows beside it are unaffected.
    assert.equal(after.routes.find((route) => route.label === "repo:forge").eligible, true);
  });
}

// ---- the surgery proof ----------------------------------------------------------------------------

await check("the proof refuses to write when the edit would change another row (shared YAML anchor)", async () => {
  // tolt-pm's bloodbank block is an alias of pile's. Setting pile's enabled:false through the anchor would
  // silently turn tolt-pm's routing off too; the proof must catch that and leave the file alone.
  const text = registryText({ pileBloodbank: `    bloodbank: &shared_bb
      enabled: true
      gateway_scope: fleet
      target_agent_id: ${PILE}
` }).replace(/(  tolt-pm:\n(?:.*\n)*?)    bloodbank:\n      enabled: true\n      gateway_scope: fleet\n      target_agent_id: tolt-pm\n/u, "$1    bloodbank: *shared_bb\n");
  assert.ok(text.includes("bloodbank: *shared_bb"), "the fixture edit applied");
  const f = fleet(text);
  const before = f.read();
  const mode = statSync(f.registry).mode;
  const run = await f.json(["retire", PILE, "--apply"]);
  assert.equal(run.status, 1);
  assert.equal(run.body.ok, false);
  assert.equal(run.body.applied, false);
  assert.match(run.body.errors[0], /refusing to write/u);
  assert.equal(f.read(), before, "registry byte-identical");
  assert.equal(statSync(f.registry).mode, mode);
  assert.ok(!readdirSync(f.fleetHome).some((name) => name.includes(".tmp") || name.includes("retire")), "no temp file left behind");
  const text2 = await f.run(["retire", PILE, "--apply"]);
  assert.equal(text2.status, 1);
  assert.match(text2.stdout, /refusing to write/u);
});

// ---- channels: reuse channelOffline -------------------------------------------------------------

function liveChannelRegistry() {
  return registryText().replace(
    "    telegram:\n      provisioning_status: retired\n      bot_username: pile_pm_bot\n",
    "    telegram:\n      provisioning_status: verified\n      bot_username: pile_pm_bot\n      bot_id: '111'\n",
  );
}

await check("a live channel is parked by calling channelOffline (registry row, delta pin, no gateway touched)", async () => {
  const f = fleet(liveChannelRegistry(), { desks: [PILE] });
  const preview = await f.json(["retire", PILE, "--reason", "replaced by tolt-pm"]);
  assert.equal(preview.status, 0, preview.stdout);
  assert.equal(preview.body.channels[0].platform, "telegram");
  assert.equal(preview.body.channels[0].action, "would-park");
  assert.equal(YAML.parse(readFileSync(join(f.fleetHome, "profiles", PILE, "config.delta.yaml"), "utf8")).platforms, undefined, "a preview leaves the delta alone");

  const { body, status } = await f.json(["retire", PILE, "--reason", "replaced by tolt-pm", "--apply"]);
  assert.equal(status, 0, JSON.stringify(body));
  assert.equal(body.channels[0].action, "parked");
  const row = f.agents()[PILE];
  assert.equal(row.telegram.provisioning_status, "offline");
  assert.equal(row.telegram.offline_reason, "replaced by tolt-pm");
  assert.equal(row.bloodbank.enabled, false);
  assert.equal("plane" in row, false);
  const delta = YAML.parse(readFileSync(join(f.fleetHome, "profiles", PILE, "config.delta.yaml"), "utf8"));
  assert.equal(delta.platforms.telegram.enabled, false);
  assert.ok(delta.secrets.onepassword.env.TELEGRAM_BOT_TOKEN.startsWith("op://"), "the credential reference is kept so it can come back");
  assert.ok(body.nextActions.some((a) => a.startsWith("hermes-gateway-restart --reason")), "one restart, named, never raw systemctl");
  assert.ok(body.leftBehind.some((item) => item.includes("hermes-gateway-restart")));
  assert.ok(body.leftBehind.some((item) => item.includes(join(f.fleetHome, "profiles", PILE))), "the desk outlives the record");
  // The board is fixed as well, and every other row is byte-identical to what it was.
  assert.equal(ownerOf(body.routing[0].after, "repo:game"), "tolt-pm");
  const others = (agents) => Object.fromEntries(Object.entries(agents).filter(([id]) => id !== PILE));
  assert.deepEqual(others(f.agents()), others(YAML.parse(liveChannelRegistry()).agents));
  // And it converges.
  const again = await f.json(["retire", PILE, "--apply"]);
  assert.equal(again.body.alreadyRetired, true);
  assert.deepEqual(again.body.channels, []);
});

await check("when channelOffline cannot run (no desk) retire does not fake it: routing is fixed, the exact command is reported, exit 1", async () => {
  const f = fleet(liveChannelRegistry(), { desks: [] });
  const { body, status } = await f.json(["retire", PILE, "--apply"]);
  assert.equal(status, 1);
  assert.equal(body.ok, false);
  assert.equal(body.applied, true, "the routing half still landed");
  assert.equal(f.agents()[PILE].telegram.provisioning_status, "verified", "the channel was not touched");
  assert.equal("plane" in f.agents()[PILE], false);
  assert.equal(f.agents()[PILE].bloodbank.enabled, false);
  assert.equal(body.channels[0].action, "next-action");
  assert.equal(body.channels[0].command, `flume channel offline ${PILE} --platform telegram --reason "employee retired" --apply`);
  assert.match(body.channels[0].detail, /not a real profile directory/u);
  assert.ok(body.nextActions.includes(body.channels[0].command));
  // A preview is not an error for the same reason: it just says what is left to do.
  const preview = await f.json(["retire", PILE]);
  assert.equal(preview.status, 0);
});

// ---- the audit invariant ------------------------------------------------------------------------

const auditRule = async (f) => {
  const run = await f.run(["audit", "--rules", "hermes.retired-routing", "--json"]);
  const report = JSON.parse(run.stdout);
  return report.rules.find((rule) => rule.id === "hermes.retired-routing");
};

await check("flume audit flags the pile shape (retired channel, live claim and bloodbank) and two defaults, and is clean after retire", async () => {
  const f = fleet(registryText());
  const found = await auditRule(f);
  assert.equal(found.status, "fail");
  assert.equal(found.scope, "host");
  assert.ok(found.details.some((line) => line.startsWith(`${PILE}: telegram marked retired but the row still claims board ${BOARD} and has bloodbank enabled`) && line.includes(`flume retire ${PILE} --apply`)), found.details.join("\n"));
  assert.ok(found.details.some((line) => line.startsWith(`board ${BOARD}: 2 rows declare plane.scope_default: true (${PILE}, tolt-pm)`)));
  assert.equal((await f.json(["retire", PILE, "--apply"])).status, 0);
  const clean = await auditRule(f);
  assert.equal(clean.status, "pass", JSON.stringify(clean));
  assert.deepEqual(clean.details, []);
});

await check("a bloodbank-disabled retired row that kept its claim is still caught by the audit", async () => {
  const f = fleet(registryText({ pileBloodbank: PILE_BLOODBANK.replace("enabled: true", "enabled: false") }));
  const found = await auditRule(f);
  assert.equal(found.status, "fail");
  assert.ok(found.details.some((line) => line.includes(`${PILE}: telegram marked retired but the row still claims board`) && !line.includes("bloodbank enabled")));
});

rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? `retire regressions passed (${count})` : `\n${failures} of ${count} retire check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
