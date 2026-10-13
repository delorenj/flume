// FLUME-55 named-agent recall compass, through the built `flume identity` CLI only.
//
// Isolated HOME per fixture: registry, role dirs, workforce desks and recency
// state live under mkdtemp; nothing reads the operator's employees or banks.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync("/tmp/flume55-");
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

function fixture(label) {
  const dir = join(work, label), home = join(dir, "home"), fleet = join(home, ".hermes"), registry = join(fleet, "agents-registry.yaml");
  for (const p of [fleet, join(home, ".agents/workforce"), join(dir, "repos")]) mkdirSync(p, { recursive: true });
  writeFileSync(registry, "# org comment\nschema_version: 1\nagents: {}\n");
  const env = { ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
    HERMES_TEMPLATE_CONFIG: join(dir, "no-config"), HERMES_FLEET_ENV: join(dir, "no-env"), PYTHONDONTWRITEBYTECODE: "1" };
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, cwd: dir, encoding: "utf8", timeout: 60000 });
  const json = (r, status = 0) => { assert.equal(r.status, status, r.stdout + r.stderr); return JSON.parse(r.stdout); };
  const named = (id, person, banks = []) => {
    const roleDir = join(dir, "repos", id, "agents/hermes/pm");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), `repo: ${id}\nrole: pm\nagent_id: ${id}\nprofile: ${id}\nidentity:\n  name: ${person}\n  recall_banks:\n${banks.map(b => `    - ${b}\n`).join("")}`);
    const doc = YAML.parseDocument(readFileSync(registry, "utf8"));
    doc.setIn(["agents", id], { project_path: join(dir, "repos", id), role_dir: roleDir, profile_name: id, identity: person });
    writeFileSync(registry, String(doc));
  };
  const unnamed = (id) => {
    const roleDir = join(dir, "repos", id, "agents/hermes/pm");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), `repo: ${id}\nrole: pm\nagent_id: ${id}\nprofile: ${id}\n`);
    const doc = YAML.parseDocument(readFileSync(registry, "utf8"));
    doc.setIn(["agents", id], { project_path: join(dir, "repos", id), role_dir: roleDir, profile_name: id });
    writeFileSync(registry, String(doc));
  };
  const specialist = (id, banks = []) => {
    const desk = join(home, ".agents/workforce", id);
    mkdirSync(desk, { recursive: true });
    writeFileSync(join(desk, "agent.yaml"), YAML.stringify({ schema_version: 1, id, display_name: id, role: "ops", charter: { purpose: "p" }, skills: { set: "x" }, memory: { write_bank: `agent-${id}`, recall_banks: banks } }));
  };
  const touch = (employee, project, at, extra = []) => json(run(["identity", "recent", employee, "--touch", project, ...(at ? ["--at", at] : []), ...extra, "--json"]));
  const recent = (employee, status = 0) => json(run(["identity", "recent", employee, "--json"]), status);
  const recall = (employee, extra = [], status = 0) => json(run(["identity", "recall", employee, ...extra, "--json"]), status);
  const statePath = (person) => join(fleet, "recency", `${person}.json`);
  return { dir, home, fleet, registry, env, run, json, named, unnamed, specialist, touch, recent, recall, statePath };
}

{
  const f = fixture("ordering");
  f.named("33god-pm", "grolf", ["agent-33god-pm", "flume", "pjangler"]);
  assert.equal(existsSync(f.statePath("grolf")), false);
  const preview = f.touch("grolf", "flume", "2026-10-12T00:00:00.000Z");
  assert.equal(preview.apply, false);
  assert.equal(existsSync(f.statePath("grolf")), false);
  const first = f.touch("grolf", "flume", "2026-10-12T00:00:00.000Z", ["--apply"]);
  assert.deepEqual(first.entries.map(e => e.project), ["flume"]);
  const second = f.touch("grolf", "pjangler", "2026-10-12T01:00:00.000Z", ["--apply"]);
  assert.deepEqual(second.entries.map(e => e.project), ["pjangler", "flume"]);
  const state = JSON.parse(readFileSync(f.statePath("grolf"), "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.employee, "grolf");
  pass("preview writes nothing; applied touches are most-recent-first in a valid version-1 document");
}
{
  const f = fixture("dedupe");
  f.named("33god-pm", "grolf", ["agent-33god-pm", "flume", "pjangler"]);
  f.touch("grolf", "flume", "2026-10-12T00:00:00.000Z", ["--apply"]);
  f.touch("grolf", "pjangler", "2026-10-12T01:00:00.000Z", ["--apply"]);
  const again = f.touch("grolf", "flume", "2026-10-12T02:00:00.000Z", ["--apply", "--source", "hook:session-start"]);
  assert.deepEqual(again.entries.map(e => e.project), ["flume", "pjangler"]);
  assert.equal(again.entries[0].last_seen, "2026-10-12T02:00:00.000Z");
  assert.equal(again.entries[0].source, "hook:session-start");
  const read = f.recent("grolf");
  assert.deepEqual(read.entries.map(e => e.project), ["flume", "pjangler"]);
  pass("a repeat interaction dedupes by project, moves it to the front and records the source");
}
{
  const f = fixture("cap-eviction");
  f.named("33god-pm", "grolf", ["agent-33god-pm"]);
  for (const [i, project] of ["p1", "p2", "p3", "p4", "p5", "p6"].entries()) {
    f.touch("grolf", project, `2026-10-12T0${i}:00:00.000Z`, ["--apply"]);
  }
  const read = f.recent("grolf");
  assert.deepEqual(read.entries.map(e => e.project), ["p6", "p5", "p4", "p3", "p2"]);
  assert.equal(read.entries.length, 5);
  pass("the sixth interaction evicts the oldest; the list never exceeds five");
}
{
  const f = fixture("recall-order");
  f.named("33god-pm", "grolf", ["agent-33god-pm", "flume", "pjangler"]);
  const before = f.recall("grolf");
  assert.deepEqual(before.recall_banks, ["agent-grolf", "agent-33god-pm", "flume", "pjangler"]);
  assert.deepEqual(before.recent_projects, []);
  const narrowEmpty = f.recall("grolf", ["--narrow"]);
  assert.deepEqual(narrowEmpty.recall_banks, ["agent-grolf", "agent-33god-pm", "flume", "pjangler"]);
  f.touch("grolf", "pjangler", "2026-10-12T01:00:00.000Z", ["--apply"]);
  f.touch("grolf", "flume", "2026-10-12T02:00:00.000Z", ["--apply"]);
  f.touch("grolf", "undeclared-bank", "2026-10-12T03:00:00.000Z", ["--apply"]);
  const ordered = f.recall("grolf");
  assert.deepEqual(ordered.recall_banks, ["agent-grolf", "flume", "pjangler", "agent-33god-pm"]);
  const narrow = f.recall("grolf", ["--narrow"]);
  assert.deepEqual(narrow.recall_banks, ["agent-grolf", "flume", "pjangler"]);
  pass("recall re-orders declared banks by recency, narrow intersects them, and undeclared projects never leak in");
}
{
  const f = fixture("specialist");
  f.specialist("grolf", ["flume", "platform"]);
  f.touch("grolf", "platform", "2026-10-12T01:00:00.000Z", ["--apply"]);
  const ordered = f.recall("grolf");
  assert.deepEqual(ordered.recall_banks, ["agent-grolf", "platform", "flume"]);
  const deskBytes = readFileSync(join(f.home, ".agents/workforce/grolf/agent.yaml"), "utf8");
  assert.match(deskBytes, /write_bank: agent-grolf/);
  assert.ok(!existsSync(join(f.home, ".agents/workforce/grolf/recency.json")));
  pass("a portable specialist gets the same compass; the authored definition and desk are untouched");
}
{
  const f = fixture("write-coupling");
  f.named("33god-pm", "grolf", ["agent-33god-pm", "flume"]);
  const registryBefore = readFileSync(f.registry, "utf8");
  const roleBefore = readFileSync(join(f.dir, "repos/33god-pm/agents/hermes/pm/role.yaml"), "utf8");
  f.touch("grolf", "flume", "2026-10-12T00:00:00.000Z", ["--apply"]);
  assert.equal(readFileSync(f.registry, "utf8"), registryBefore);
  assert.equal(readFileSync(join(f.dir, "repos/33god-pm/agents/hermes/pm/role.yaml"), "utf8"), roleBefore);
  pass("touching recency writes only fleet recency state; registry and role definition bytes are unchanged");
}
{
  const f = fixture("refusals");
  f.unnamed("plain-pm");
  const unnamedPost = f.recent("plain-pm", 1);
  assert.ok(unnamedPost.blockers.some(b => b.code === "unnamed"));
  assert.equal(f.recent("nobody", 1).blockers.some(b => b.code === "unknown-employee"), true);
  const bad = f.json(f.run(["identity", "recent", "grolf", "--touch", "bad/project", "--apply", "--json"]), 1);
  assert.ok(bad.blockers.some(b => b.code === "invalid-project"));
  f.named("33god-pm", "grolf", ["agent-33god-pm"]);
  mkdirSync(join(f.fleet, "recency"), { recursive: true });
  writeFileSync(f.statePath("grolf"), "not json");
  const unreadable = f.recent("grolf", 1);
  assert.ok(unreadable.blockers.some(b => b.code === "invalid-state"));
  pass("unnamed posts, unknown employees, bad project ids and corrupt state all refuse before any write");
}

console.log(`\n${count} checks passed`);
