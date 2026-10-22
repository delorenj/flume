// `flume org`: the inference contract and the honesty markers.
//
// 2026-10-22: the chart drew eleven unrelated employees under delonet-director
// with "[inferred: the fleet's only director (delonet-director)]". It was false
// four ways over -- rererere (workflows-director), context-director, marge-simpson
// (hr-director) and delonet-director are all directors -- because the inference
// counted only the literal role `director`. org.yaml's own header documents the
// contract the renderer contradicted: placed agents win; unplaced agents nest by
// project_path; anything still unplaced falls into "Unassigned".
//
// Every case runs the REAL built dist in a subprocess against a constructed
// HOME, so nothing here reads the operator's fleet.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "flume-hr", "dist", "index.js");
if (!existsSync(CLI)) {
  console.error("SKIP org-chart-regressions: dist/ is not built (npm run build)");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "flume-org-chart-"));
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
};

/** A fleet home with a registry, an org.yaml and one desk per name in `desks`. */
function fleet(name, { agents, org, desks }) {
  const home = join(work, name);
  const hermes = join(home, ".hermes");
  mkdirSync(join(hermes, "profiles"), { recursive: true });
  for (const desk of desks) mkdirSync(join(hermes, "profiles", desk), { recursive: true });
  const rows = Object.entries(agents)
    .map(([id, row]) => {
      const lines = [`  ${id}:`, `    role: ${row.role ?? "pm"}`, `    type: ${row.type ?? "hermes"}`, `    display_name: "${row.display_name ?? id}"`];
      if (row.project_path) lines.push(`    project_path: ${row.project_path}`);
      return lines.join("\n");
    })
    .join("\n");
  writeFileSync(join(hermes, "agents-registry.yaml"), `agents:\n${rows}\n`);
  writeFileSync(join(hermes, "org.yaml"), org);
  return { home, registry: join(hermes, "agents-registry.yaml"), orgFile: join(hermes, "org.yaml") };
}

function run(env, args = [], extraEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, "org", ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { PATH: process.env.PATH, HOME: env.home, NO_COLOR: "1", ...extraEnv },
  });
  assert.ok(result.stdout.trim(), `flume org printed nothing (status ${result.status}): ${result.stderr}`);
  return result;
}

const json = (env, extraEnv) => {
  const out = JSON.parse(run(env, ["--json"], extraEnv).stdout);
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
  return out.data;
};
const node = (chart, id) => chart.nodes.find((n) => n.id === id);

const ORG = `version: 1
company: {name: "Fixture Co.", handle: "Fix"}
ceo: {id: ceo, display_name: "Boss", title: "Operator / CEO"}
personas:
  ghost-pm: {title: "Nobody"}
  flows-director: {title: "Director of Workflows"}
departments:
  - id: infra
    name: "Infrastructure"
    order: 1
    manager: infra-director
    members: [infra-pm]
  - id: flows
    name: "Workflows"
    order: 2
    manager: flows-director
    members: []
  - id: hr
    name: "People"
    order: 3
    manager: hr-director
    members: []
defaults:
  unassigned_department: {id: unassigned, name: "Unassigned", order: 999}
hidden: []
`;

const AGENTS = {
  "infra-director": { role: "director", project_path: "/work/infra-co" },
  "flows-director": { role: "workflows-director" },
  "hr-director": { role: "hr-director" },
  "infra-pm": { role: "pm", project_path: "/work/infra-co/infra" },
  // unplaced, under a placed agent's directory -> nests into that department
  "monitor-pm": { role: "pm", project_path: "/work/infra-co/infra/monitoring" },
  // unplaced, same directory as a placed agent -> same department
  "infra-scrum": { role: "scrum-master", project_path: "/work/infra-co/infra" },
  // unplaced, no evidence at all -> Unassigned, never "the only director"
  "stray-specialist": { role: "specialist" },
  "elsewhere-pm": { role: "pm", project_path: "/work/other-repo" },
  // a prefix of a placed path but not an ancestor directory
  "infra-co-lookalike-pm": { role: "pm", project_path: "/work/infra-co-lookalike" },
  // registry row, Hermes runtime, no profile directory
  "deskless-reporter": { role: "reporter", project_path: "/work/infra-co/reporter" },
  // not a Hermes row: no desk is expected
  "external-bot": { role: "pm", type: "claude-code", project_path: "/work/external" },
};
const ALL_DESKS = Object.keys(AGENTS).filter((id) => id !== "deskless-reporter" && id !== "external-bot");

const env = fleet("main", { agents: AGENTS, org: ORG, desks: ALL_DESKS });
const chart = json(env);

check("no node ever claims 'the only director', and no label is built from one", () => {
  const text = run(env).stdout;
  assert.doesNotMatch(text, /only director/i);
  for (const n of chart.nodes) assert.doesNotMatch(n.note ?? "", /only director/i, n.id);
});

check("a director role other than the literal `director` is never counted as the fleet's boss", () => {
  // Four directors exist; the stray has no path and must land in Unassigned,
  // under none of them.
  const stray = node(chart, "stray-specialist");
  assert.equal(stray.inferred, true);
  assert.match(stray.reports_to, /unassigned/);
  assert.equal(node(chart, stray.reports_to).kind, "department");
  assert.equal(node(chart, stray.reports_to).display_name, "Unassigned");
});

check("an unplaced agent nests under the department of the placed agent that owns its directory", () => {
  const monitor = node(chart, "monitor-pm");
  assert.equal(monitor.inferred, true);
  assert.equal(monitor.reports_to, "infra-director", "joins the infra department, under its manager");
  assert.match(monitor.note, /nested by project path under infra-pm/);
});

check("an unplaced agent at exactly a placed agent's path joins that department", () => {
  const scrum = node(chart, "infra-scrum");
  assert.equal(scrum.reports_to, "infra-director");
  assert.match(scrum.note, /^inferred: (nested by project path under infra-director|same project path as infra-pm)/);
});

check("a path that merely shares a string prefix is not nesting", () => {
  const lookalike = node(chart, "infra-co-lookalike-pm");
  assert.match(lookalike.reports_to, /unassigned/);
});

check("an inferred agent does not vouch for another: no chains of guesses", () => {
  // deskless-reporter is under /work/infra-co/reporter: nests via infra-director's path,
  // a RECORDED placement. If inferred monitor-pm could vouch, nothing here would change,
  // so pin the evidence source in the note instead.
  const reporter = node(chart, "deskless-reporter");
  assert.match(reporter.note, /under infra-director|under infra-pm/);
  assert.doesNotMatch(reporter.note, /under (monitor-pm|infra-scrum|deskless-reporter)/);
});

check("a persona title is shown beside the registry role, so the operator's word for the job is visible", () => {
  const line = run(env).stdout.split("\n").find((l) => l.includes("(flows-director)"));
  assert.match(line, /Director of Workflows · workflows-director/);
  assert.equal(node(chart, "flows-director").title, "Director of Workflows");
});

check("recorded placements are untouched and unmarked", () => {
  for (const id of ["infra-director", "flows-director", "hr-director", "infra-pm"]) {
    assert.equal(node(chart, id).inferred, false, id);
  }
  assert.equal(node(chart, "flows-director").reports_to, "flows");
  assert.equal(node(chart, "infra-pm").reports_to, "infra-director");
});

check("a Hermes employee with no profile directory is marked [no desk] and counted", () => {
  assert.equal(node(chart, "deskless-reporter").desk, "missing");
  assert.deepEqual(chart.no_desk, ["deskless-reporter"]);
  assert.equal(chart.totals.no_desk, 1);
  const text = run(env).stdout;
  const line = text.split("\n").find((l) => l.includes("(deskless-reporter)"));
  assert.match(line, /\[no desk\]/);
  assert.match(text, /1 no desk/);
  assert.match(text, /no desk — registry row, but no profile directory/);
  for (const l of text.split("\n")) {
    if (l.includes("[no desk]")) assert.ok(l.includes("(deskless-reporter)"), `only the deskless row carries the marker: ${l}`);
  }
});

check("a non-Hermes row is not accused of lacking a desk", () => {
  assert.equal(node(chart, "external-bot").desk, "n/a");
});

check("phantoms are still reported and never drawn", () => {
  assert.deepEqual(chart.phantom, ["ghost-pm"]);
  assert.equal(node(chart, "ghost-pm"), undefined);
  assert.match(run(env).stdout, /phantom\b.*absent from the registry/);
});

check("a fully placed fleet reads 0 inferred / 0 phantom / 0 no desk, with no Unassigned heading", () => {
  const placedOrg = `version: 1
company: {name: "Fixture Co.", handle: "Fix"}
ceo: {id: ceo, display_name: "Boss", title: "CEO"}
departments:
  - id: only
    name: "Only"
    order: 1
    manager: infra-director
    members: [infra-pm, flows-director]
`;
  const tidy = fleet("tidy", {
    agents: {
      "infra-director": { role: "director" },
      "infra-pm": { role: "pm" },
      "flows-director": { role: "workflows-director" },
    },
    org: placedOrg,
    desks: ["infra-director", "infra-pm", "flows-director"],
  });
  const out = run(tidy).stdout;
  assert.match(out, /3 in the registry · 3 placed · 0 inferred · 0 no desk · 0 phantom/);
  assert.doesNotMatch(out, /Unassigned/);
  assert.doesNotMatch(out, /[├└]── ~ /);
});

check("the header names the file that was read, and says how the path was chosen", () => {
  // Default resolution: no `via`.
  const plain = run(env).stdout;
  assert.match(plain, /^registry {2}~\/\.hermes\/agents-registry\.yaml {2}\d+ employees$/m);
  assert.match(plain, /^hierarchy ~\/\.hermes\/org\.yaml {2}v1$/m);

  // An env override is quoted, and the path shown is the override, never the default.
  const elsewhere = fleet("elsewhere", { agents: { "solo-pm": { role: "pm" } }, org: "version: 1\ndepartments: []\n", desks: ["solo-pm"] });
  const viaEnv = run(env, [], { HERMES_AGENTS_REGISTRY: elsewhere.registry, HERMES_ORG_PATH: elsewhere.orgFile }).stdout;
  assert.match(viaEnv, /registry .*elsewhere\/\.hermes\/agents-registry\.yaml \(via env HERMES_AGENTS_REGISTRY\) {2}1 employees/);
  assert.match(viaEnv, /hierarchy .*elsewhere\/\.hermes\/org\.yaml \(via env HERMES_ORG_PATH\)/);
  assert.doesNotMatch(viaEnv, /(?<!elsewhere)\/\.hermes\/agents-registry\.yaml \(via/);

  // A flag is quoted too.
  const viaFlag = run(env, ["--agent-registry", elsewhere.registry, "--org", elsewhere.orgFile]).stdout;
  assert.match(viaFlag, /\(via flag\)/);
});

check("a symlinked source is shown with where it lands", () => {
  const linked = join(work, "linked");
  mkdirSync(linked, { recursive: true });
  symlinkSync(env.registry, join(linked, "registry-link.yaml"));
  const out = run(env, ["--agent-registry", join(linked, "registry-link.yaml")]).stdout;
  assert.match(out, /registry-link\.yaml -> ~\/\.hermes\/agents-registry\.yaml \(via flag\)/);
});

check("a header can never name a file that does not exist: an unreadable registry fails instead", () => {
  const missing = spawnSync(process.execPath, [CLI, "org", "--json"], {
    encoding: "utf8",
    timeout: 20000,
    env: { PATH: process.env.PATH, HOME: env.home, NO_COLOR: "1", HERMES_AGENTS_REGISTRY: join(work, "nope", "agents-registry.yaml") },
  });
  const out = JSON.parse(missing.stdout);
  assert.equal(out.ok, false);
});

rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} org-chart check(s) failed`);
  process.exit(1);
}
console.log("org-chart-regressions: all checks passed");
