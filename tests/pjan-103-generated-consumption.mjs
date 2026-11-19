// PJAN-103: real Copier -> shipped dispatcher -> Plane requests -> regeneration
// -> the actual hermes.pm-scaffold rule. No provisioning tasks or live services.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const template = join(root, "templates/hermes-agent");
const work = mkdtempSync(join(tmpdir(), "pjan103-generated-"));
const home = join(work, "home");
const repo = join(work, "fixture");
const role = join(repo, "agents/hermes/pm");
const bin = join(work, "bin");
const binding = { type: "plane", workspace: "fixture-ws", board_id: "fixture-board", identifier: "PJAN" };
const base = "https://plane.invalid/api/v1/workspaces/fixture-ws/projects/fixture-board";
const stock = [
  { id: "backlog", name: "Backlog", group: "backlog" },
  { id: "todo", name: "Todo", group: "unstarted" },
  { id: "started", name: "In Progress", group: "started" },
  { id: "done", name: "Done", group: "completed" },
  { id: "cancelled", name: "Cancelled", group: "cancelled" },
];
const twoUnstarted = [...stock, { id: "ready", name: "Ready for Implementation", group: "unstarted" }];
const cleanEnv = {
  PATH: process.env.PATH, HOME: home, TMPDIR: work, LANG: "C.UTF-8",
  PYTHONDONTWRITEBYTECODE: "1", HERMES_FLEET_HOME: join(home, ".hermes"),
  HERMES_AGENTS_REGISTRY: join(home, ".hermes/agents-registry.yaml"),
  HERMES_FLEET_ENV: join(work, "no-fleet.env"), FLUME_HOST_OVERLAY: "none",
};
let checks = 0;
function check(label, fn) { fn(); console.log(`ok ${++checks} - ${label}`); }
function command(program, args, env = cleanEnv, cwd = repo) {
  return spawnSync(program, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}
function render(overwrite = false) {
  const r = command("copier", ["copy", "-T", "--trust", "--defaults", ...(overwrite ? ["--overwrite"] : []),
    "-d", "target_repo=fixture", "-d", "role=pm", "-d", "ticket_provider=plane", template, role]);
  assert.equal(r.status, 0, `real Copier render failed: ${r.error ?? r.stderr}`);
}
function manifest(map) {
  writeFileSync(join(repo, ".project.json"), JSON.stringify({ ticket_provider: { ...binding, ...(map === undefined ? {} : { state_map: map }) } }));
}
function transition({ map, target = "unstarted", catalog = twoUnstarted, state = "started", labels = [], readbackId } = {}) {
  manifest(map);
  const log = join(work, "requests.jsonl");
  rmSync(log, { force: true });
  const statefile = join(work, "issue.json");
  writeFileSync(statefile, JSON.stringify({ id: "fixture-issue", sequence_id: 103, state, labels }));
  const states = join(work, "states.json");
  writeFileSync(states, JSON.stringify({ results: catalog }));
  const result = command("bash", ["-c", 'source "$1"; tp transition fixture-issue "$2"', "test", join(role, ".scripts/lib/ticket-provider.sh"), target], {
    ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, PLANE_BASE: "https://plane.invalid", PLANE_API_KEY: "fixture-only",
    FIXTURE_LOG: log, FIXTURE_STATES: states, FIXTURE_ISSUE: statefile, FIXTURE_READBACK_ID: readbackId ?? "fixture-issue",
  }, join(role, ".scripts"));
  const requests = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  assert.ok(requests.every(x => x.url.startsWith(`${base}/`)), JSON.stringify(requests));
  return { ...result, requests };
}
function success(result, body) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok 103\s*$/);
  const patches = result.requests.filter(x => x.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.equal(patches[0].url, `${base}/issues/fixture-issue/`);
  assert.deepEqual(JSON.parse(patches[0].body), body);
  assert.deepEqual(result.requests.at(-1), { method: "GET", url: `${base}/issues/fixture-issue/`, body: "" });
}
try {
  for (const dir of [home, repo, bin, join(home, ".hermes")]) mkdirSync(dir, { recursive: true });
  const version = command("copier", ["--version"]);
  assert.equal(version.status, 0, `Copier is REQUIRED by npm test; install tests/requirements.txt with uv tool install 'copier==9.14.0' (no skip): ${version.error ?? version.stderr}`);
  assert.match(version.stdout, /copier 9\./, "tests require Copier 9.x");
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env python3
import json, os, sys
args=sys.argv[1:]; method='GET'; url=''; body=''; output=''; headers=''; writeout=''
i=0
while i<len(args):
    arg=args[i]
    if arg in ('-X','-d','-o','-D','-w','-H','--connect-timeout','--max-time'):
        value=args[i+1]
        if arg=='-X': method=value
        elif arg=='-d': body=value
        elif arg=='-o': output=value
        elif arg=='-D': headers=value
        elif arg=='-w': writeout=value
        i+=2
    elif arg.startswith('-'): i+=1
    else: url=arg; i+=1
with open(os.environ['FIXTURE_LOG'],'a') as f: f.write(json.dumps({'method':method,'url':url,'body':body})+'\\n')
statefile=os.environ['FIXTURE_ISSUE']
with open(statefile) as f: issue=json.load(f)
if method=='GET' and url.endswith('/states/'):
    with open(os.environ['FIXTURE_STATES']) as f: payload=json.load(f)
elif method=='GET' and url.endswith('/labels/'):
    payload={'results':[{'id':'review','name':'lifecycle:review'},{'id':'hold','name':'lifecycle:needs-input'},{'id':'human','name':'lifecycle:human'},{'id':'other','name':'agent:working'}]}
elif method=='GET' and url.endswith('/issues/'):
    payload={'results':[issue]}
elif method=='GET' and url.endswith('/cycles/'):
    payload={'results':[]}
elif method=='GET' and url.endswith('/issues/fixture-issue/'):
    payload={**issue,'id':os.environ['FIXTURE_READBACK_ID']}
elif method=='PATCH' and url.endswith('/issues/fixture-issue/'):
    issue.update(json.loads(body))
    with open(statefile,'w') as f: json.dump(issue,f)
    payload=issue
else: sys.exit('unexpected request '+method+' '+url)
text=json.dumps(payload)
if output:
    with open(output,'w') as f: f.write(text)
else: sys.stdout.write(text)
if headers:
    with open(headers,'w') as f: f.write('HTTP/1.1 200 OK\\r\\n')
if writeout: sys.stdout.write(writeout.replace('%{http_code}','200'))
`, { mode: 0o755 });
  const init = command("git", ["-c", "init.defaultBranch=main", "init", "-q"]);
  assert.equal(init.status, 0, init.stderr);
  manifest();
  render();
  const originalRole = readFileSync(join(role, "role.yaml"), "utf8");
  check("fresh real Copier role ships Todo default and executable vendor, never Linear", () => {
    assert.match(originalRole, /  unstarted: "Todo"/);
    assert.equal(existsSync(join(role, ".scripts/providers/linear.sh")), false);
    assert.deepEqual(readFileSync(join(role, ".scripts/providers/plane.sh")), readFileSync(join(template, "template/.scripts/providers/plane.sh")));
    success(transition(), { state: "todo" });
  });
  check("actual generated dispatcher on a true five-state stock board", () => {
    assert.equal(stock.length, 5);
    success(transition({ catalog: stock }), { state: "todo" });
  });
  check("project Ready override beats conflicting generated Todo role", () => {
    success(transition({ map: { unstarted: "Ready for Implementation" } }), { state: "ready" });
    assert.equal(readFileSync(join(role, "role.yaml"), "utf8"), originalRole);
  });
  check("legacy role fallback beats adapter Todo default with no project map", () => {
    writeFileSync(join(role, "role.yaml"), originalRole.replace('  unstarted: "Todo"', '  unstarted: "Ready for Implementation" # role fallback'));
    success(transition(), { state: "ready" });
    writeFileSync(join(role, "role.yaml"), originalRole.replace('  unstarted: "Todo"', '  unstarted: ""'));
    success(transition(), { state: "todo" });
    writeFileSync(join(role, "role.yaml"), originalRole);
  });
  for (const [label, map, catalog, noRequests] of [
    ["unknown key", { unstartd: "Ready for Implementation" }, twoUnstarted, true],
    ["malformed map", { unstarted: 42 }, twoUnstarted, true],
    ["missing target", { unstarted: "Missing" }, twoUnstarted, false],
    ["wrong group", { unstarted: "Done" }, twoUnstarted, false],
    ["duplicate target", { unstarted: "Todo" }, [...twoUnstarted, { id: "todo2", name: "todo", group: "unstarted" }], false],
  ]) check(`generated dispatcher refuses ${label} without PATCH`, () => {
    const r = transition({ map, catalog });
    assert.notEqual(r.status, 0);
    assert.equal(r.requests.filter(x => x.method === "PATCH").length, 0);
    assert.deepEqual(r.requests.map(x => x.method), noRequests ? [] : ["GET", "GET", "GET", "GET", "GET"]);
    if (!noRequests) assert.equal(r.requests.at(-1).url, `${base}/states/`);
  });
  check("same-issue verification refuses wrong readback after exactly one PATCH", () => {
    const r = transition({ readbackId: "different-issue" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /did not identify the requested issue/);
    assert.deepEqual(r.requests.slice(-3).map(x => x.method), ["GET", "PATCH", "GET"]);
    assert.equal(r.requests.filter(x => x.method === "PATCH").length, 1);
  });
  check("review/hold retain lifecycle labels and hold never moves Todo", () => {
    success(transition({ target: "in_review", state: "todo", labels: ["other"] }), { state: "started", labels: ["other", "review"] });
    success(transition({ target: "awaiting_decision", state: "todo", labels: ["other"] }), { labels: ["other", "hold"] });
  });
  manifest({ unstarted: "Ready for Implementation" });
  const savedProject = readFileSync(join(repo, ".project.json"));
  const explicitRole = originalRole.replace('  unstarted: "Todo"', '  unstarted: "Legacy Waiting" # durable operator mapping');
  writeFileSync(join(role, "role.yaml"), explicitRole);
  check("forced real Copier regeneration retains supported project map and explicit role choices", () => {
    render(true);
    assert.deepEqual(readFileSync(join(repo, ".project.json")), savedProject);
    assert.equal(readFileSync(join(role, "role.yaml"), "utf8"), explicitRole);
    success(transition({ map: { unstarted: "Ready for Implementation" } }), { state: "ready" });
    assert.equal(existsSync(join(role, ".scripts/providers/linear.sh")), false);
  });

  // The rule is not exported by the CLI; bundle its REAL source, not a surrogate.
  const req = createRequire(join(root, "package.json"));
  const modules = req.resolve.paths("yaml").find(p => existsSync(join(p, "yaml")));
  assert.ok(modules, "npm install is required");
  symlinkSync(modules, join(work, "node_modules"), "dir");
  const entry = join(work, "rule-entry.ts");
  const bundle = join(work, "rule.mjs");
  writeFileSync(entry, `export { createHermesChecks } from ${JSON.stringify(join(root, "packages/flume-hr/src/parity/rules.ts"))};`);
  buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  const { createHermesChecks } = await import(pathToFileURL(bundle).href);
  const previous = Object.fromEntries(Object.keys(cleanEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, cleanEnv);
  try {
    writeFileSync(cleanEnv.HERMES_AGENTS_REGISTRY, "schema_version: 1\nagents:\n  fixture-pm:\n    role: pm\n");
    const ctx = { repoRoot: repo, homeDir: home, pjanglerRoot: root, dryRun: false, force: false };
    const rule = createHermesChecks().find(x => x.id === "hermes.pm-scaffold");
    assert.ok(rule);
    const before = await rule.audit(ctx);
    console.log(JSON.stringify({ phase: "before-parity", report: before }));
    // -T intentionally avoids provisioning tasks, so runtime metadata is absent.
    // Remediate only this scratch repo through the supported rule to converge it.
    const migrated = await rule.migrate(ctx, before);
    console.log(JSON.stringify({ phase: "parity-migrate", report: migrated }));
    assert.ok(["applied", "noop"].includes(migrated.status), JSON.stringify(migrated));
    const after = await rule.audit(ctx);
    console.log(JSON.stringify({ phase: "after-parity", report: after }));
    check("actual hermes.pm-scaffold passes on regenerated fixed consumer, map retained, no Linear", () => {
      assert.equal(after.status, "pass", JSON.stringify(after));
      assert.deepEqual(readFileSync(join(repo, ".project.json")), savedProject);
      assert.match(readFileSync(join(role, "role.yaml"), "utf8"), /  unstarted: "Legacy Waiting" # durable operator mapping/);
      assert.equal(existsSync(join(role, ".scripts/providers/linear.sh")), false);
      assert.deepEqual(readFileSync(join(role, ".scripts/providers/plane.sh")), readFileSync(join(template, "template/.scripts/providers/plane.sh")));
      success(transition({ map: { unstarted: "Ready for Implementation" } }), { state: "ready" });
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  console.log(`PJAN-103 generated consumption: ${checks} integration checks passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
