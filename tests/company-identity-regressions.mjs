// FLUME-47 company identity, through the built `flume identity` CLI only.
//
// Every fixture is an isolated HOME with its own registry, role directories,
// workforce desks and Skillex catalog; nothing reads the operator's real
// employees. Cloudflare is a local fake server that records every request, so
// "zero network" and "GET only" are measured, not assumed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import YAML from "yaml";
import { addSetSkills, createSet } from "@delorenj/skillex";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const work = mkdtempSync("/tmp/flume47-");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };

/** Bytes and mtimes of everything under `path`: equal trees mean nothing was written. */
function tree(path) {
  let s;
  try { s = lstatSync(path); } catch { return null; }
  if (s.isSymbolicLink()) return { link: readlinkSync(path) };
  if (s.isDirectory()) return Object.fromEntries(readdirSync(path).sort().filter((n) => !n.endsWith(".lock")).map((n) => [n, tree(join(path, n))]));
  return { bytes: readFileSync(path).toString("base64"), mtime: s.mtimeMs };
}

function fixture(label) {
  const dir = join(work, label), home = join(dir, "home"), fleet = join(home, ".hermes"), registry = join(fleet, "agents-registry.yaml");
  for (const p of [fleet, join(home, ".agents/workforce"), join(dir, "repos")]) mkdirSync(p, { recursive: true });
  writeFileSync(registry, "# org comment\nschema_version: 1\nagents: {}\n");
  const env = { ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: registry, HERMES_FLEET_REGISTRY_FILE: registry,
    HERMES_TEMPLATE_CONFIG: join(dir, "no-config"), HERMES_FLEET_ENV: join(dir, "no-env"), XDG_STATE_HOME: join(home, ".local/state"),
    PYTHONDONTWRITEBYTECODE: "1", CLOUDFLARE_API_TOKEN: "", FLUME_CLOUDFLARE_API_BASE: "http://127.0.0.1:9/never" };
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, cwd: dir, encoding: "utf8", timeout: 60000 });
  const runAsync = (args, extra = {}) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extra }, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => stdout += b);
    child.stderr.on("data", (b) => stderr += b);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  const json = (r, status = 0) => { assert.equal(r.status, status, r.stdout + r.stderr); return JSON.parse(r.stdout); };
  /** A post in the registry whose role.yaml optionally names a person. */
  const post = (id, roleYaml) => {
    const roleDir = join(dir, "repos", id, "agents/hermes/pm");
    mkdirSync(roleDir, { recursive: true });
    if (roleYaml !== undefined) writeFileSync(join(roleDir, "role.yaml"), roleYaml);
    const doc = YAML.parseDocument(readFileSync(registry, "utf8"));
    doc.setIn(["agents", id], { project_path: join(dir, "repos", id), role_dir: roleDir, profile_name: id, identity: id });
    writeFileSync(registry, String(doc));
    return join(roleDir, "role.yaml");
  };
  const named = (id, person, extra = "") => post(id, `# operator note: keep me\nrepo: ${id}\nrole: pm\nagent_id: ${id}\nprofile: ${id}\nidentity:\n  name: ${person}\n  recall_banks:\n    - agent-${id}\n${extra}`);
  const block = (fields) => ({ version: 1, subject: fields.subject, handle: fields.handle, email: `${fields.handle}@agents.delo.sh`, status: fields.status ?? "active", enrolled_at: "2026-10-01T00:00:00.000Z", ...(fields.bindings ? { bindings: fields.bindings } : {}) });
  const yamlBlock = (fields) => YAML.stringify({ company_identity: block(fields) });
  return { dir, home, fleet, registry, env, run, runAsync, json, post, named, block, yamlBlock };
}

/** A real, audited portable specialist hired through the public CLI. */
async function specialistFixture(label) {
  const f = fixture(label), catalog = join(f.dir, "skillex");
  mkdirSync(join(catalog, "all-skills/alpha"), { recursive: true });
  writeFileSync(join(catalog, "all-skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: fixture alpha\n---\n");
  const options = { registryRoot: catalog, home: f.home, stateHome: f.env.XDG_STATE_HOME };
  assert.ok((await createSet("first", options)).ok);
  assert.ok((await addSetSkills("first", ["alpha"], options)).ok);
  writeFileSync(join(f.fleet, "config.yaml"), YAML.stringify({ model: { provider: "automaticai", default: "automaticai/personal/sol" }, memory: { provider: "hindsight" } }));
  f.env.PJ_SKILLS_REGISTRY_ROOT = catalog;
  const source = join(f.dir, "agent.yaml");
  writeFileSync(source, "# specialist source\n" + YAML.stringify({ schema_version: 1, id: "specialist", display_name: "The Specialist", role: "infra", charter: { purpose: "Keep infra boring" }, skills: { set: "first" }, memory: { write_bank: "agent-specialist", recall_banks: ["infra"] } }));
  f.json(f.run(["hire", "--definition", source, "--json"]));
  assert.ok(f.json(f.run(["audit", "--employee", "specialist", "--json"])).ok);
  return { ...f, source, desk: join(f.home, ".agents/workforce/specialist"), profile: join(f.fleet, "profiles/specialist") };
}

/** A fake Cloudflare API that records every request it sees. */
async function fakeCloudflare(routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const route = routes[new URL(req.url, "http://x").pathname + new URL(req.url, "http://x").search] ?? routes[new URL(req.url, "http://x").pathname];
    const [status, body] = route ?? [404, { success: false, errors: [{ code: 7003, message: "not found" }] }];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${server.address().port}/client/v4`, close: () => new Promise((r) => server.close(r)) };
}

try {
  // -- Enroll post-holder: preview, apply, re-apply -------------------------------------
  {
    const f = fixture("post-holder");
    const rolePath = f.named("33god-pm", "grolf");
    f.post("other-pm", "role: pm\nagent_id: other-pm\n");
    const original = readFileSync(rolePath, "utf8"), registryBefore = readFileSync(f.registry, "utf8");
    const before = tree(f.dir);
    const preview = f.json(f.run(["identity", "enroll", "33god-pm", "--json"]));
    assert.equal(preview.ok, true);
    assert.equal(preview.apply, false);
    assert.equal(preview.changed, true);
    assert.equal(preview.identity.handle, "grolf");
    assert.equal(preview.identity.email, "grolf@agents.delo.sh");
    assert.match(preview.identity.subject, UUID);
    assert.match(preview.preview.appended, /^company_identity:\n/u);
    assert.deepEqual(preview.writes, []);
    assert.deepEqual(tree(f.dir), before);
    pass("post-holder preview proposes subject and grolf@agents.delo.sh without writing");

    const applied = f.json(f.run(["identity", "enroll", "33god-pm", "--apply", "--json"]));
    assert.equal(applied.changed, true);
    assert.deepEqual(applied.writes, [rolePath]);
    const after = readFileSync(rolePath, "utf8");
    assert.ok(after.startsWith(original), "role.yaml prefix is byte-for-byte unchanged");
    const parsed = YAML.parse(after);
    assert.deepEqual(parsed.identity, { name: "grolf", recall_banks: ["agent-33god-pm"] });
    assert.equal(parsed.agent_id, "33god-pm");
    assert.deepEqual(parsed.company_identity, applied.identity);
    assert.equal(parsed.company_identity.status, "active");
    assert.equal(readFileSync(f.registry, "utf8"), registryBefore, "registry row, post id and bank are untouched");
    // The template's own reader still sees the same person and bank.
    const reader = spawnSync("python3", [join(root, "templates/hermes-agent/template/.scripts/lib/role-identity.py"), rolePath, "33god-pm", "33god-pm"], { encoding: "utf8" });
    assert.equal(reader.status, 0, reader.stderr);
    assert.deepEqual(JSON.parse(reader.stdout), { name: "grolf", write_bank: "agent-grolf", recall_banks: ["agent-grolf", "agent-33god-pm"] });
    const scalar = spawnSync("python3", [join(root, "templates/hermes-agent/template/.scripts/lib/role-yaml.py"), rolePath, "agent_id"], { encoding: "utf8" });
    assert.equal(scalar.stdout.trim(), "33god-pm");
    pass("apply appends one block to role.yaml; post id, registry row, memory bank and template readers unchanged");

    const settled = tree(f.dir);
    const again = f.json(f.run(["identity", "enroll", "33god-pm", "--apply", "--json"]));
    assert.equal(again.changed, false);
    assert.equal(again.identity.subject, applied.identity.subject);
    assert.deepEqual(again.writes, []);
    assert.deepEqual(tree(f.dir), settled);
    assert.equal(f.json(f.run(["identity", "enroll", "33god-pm", "--json"])).changed, false);
    pass("second apply is a no-op that keeps bytes, mtimes and the subject");

    const shown = f.json(f.run(["identity", "show", "grolf", "--json"]));
    assert.equal(shown.identity.subject, applied.identity.subject);
    const immutable = f.json(f.run(["identity", "enroll", "33god-pm", "--handle", "grolf2", "--apply", "--json"]), 1);
    assert.deepEqual(immutable.blockers.map((b) => b.code), ["handle-immutable"]);
    assert.deepEqual(tree(f.dir), settled);
    pass("handle is immutable once enrolled");

    // Grolf candidates: listed for reconciliation, never chosen.
    assert.deepEqual(applied.reconcile.map((c) => [c.principal, c.state]), [
      ["db1ac9dc-6180-47d0-aa87-e1bf46d10707", "unadopted"],
      ["b29eaffc-cc8d-4de1-a10b-7425c67177ab", "unadopted"],
      ["62b4fef6-b0fe-4cd2-bcd7-53737a61feb4", "unadopted"],
    ]);
    assert.equal(parsed.company_identity.bindings, undefined, "no candidate is bound");
    assert.equal(JSON.stringify(applied).includes("op://"), false, "the adoption plan is secret-free");
    pass("existing Grolf Plane candidates are listed under reconcile[] as unadopted and none is bound");
  }

  // -- Enroll portable specialist ---------------------------------------------------------
  {
    const s = await specialistFixture("specialist");
    const agentPath = join(s.desk, "agent.yaml"), contractPath = join(s.desk, "contract.yaml");
    const definitionBefore = readFileSync(agentPath, "utf8"), registryBefore = readFileSync(s.registry, "utf8"), profileBefore = tree(s.profile);
    const preview = s.json(s.run(["identity", "enroll", "specialist", "--json"]));
    assert.equal(preview.kind, "specialist");
    assert.equal(preview.identity.email, "specialist@agents.delo.sh");
    assert.equal(preview.preview.schema_version, "1 -> 2");
    assert.equal(readFileSync(agentPath, "utf8"), definitionBefore);
    const applied = s.json(s.run(["identity", "enroll", "specialist", "--apply", "--json"]));
    assert.deepEqual(applied.writes, [agentPath, contractPath]);
    const definition = YAML.parse(readFileSync(agentPath, "utf8"));
    assert.equal(definition.schema_version, 2);
    assert.deepEqual(definition.company_identity, applied.identity);
    const { schema_version: _a, company_identity: _b, ...rest } = definition;
    const { schema_version: _c, ...original } = YAML.parse(definitionBefore);
    assert.deepEqual(rest, original, "every other definition key is unchanged");
    assert.ok(readFileSync(agentPath, "utf8").startsWith("# specialist source\n"), "comments survive");
    assert.deepEqual(YAML.parse(readFileSync(contractPath, "utf8")).company_identity, applied.identity);
    assert.equal(readFileSync(s.registry, "utf8"), registryBefore);
    assert.deepEqual(tree(s.profile), profileBefore, "profile, SOUL and memory config untouched");
    const audit = s.json(s.run(["audit", "--employee", "specialist", "--json"]));
    assert.equal(audit.standing, "in good standing");
    assert.equal(audit.write_bank, "agent-specialist");
    pass("specialist enrollment raises agent.yaml to schema_version 2, re-renders contract.yaml and stays in good standing");

    const settled = tree(s.home);
    assert.equal(s.json(s.run(["identity", "enroll", "specialist", "--apply", "--json"])).changed, false);
    assert.equal(s.json(s.run(["onboard", "--employee", "specialist", "--json"])).changed, false);
    assert.deepEqual(tree(s.home), settled);
    pass("specialist re-apply and onboard --employee are no-ops after enrollment");

    // Onboard drift: a source that lacks or differs from the enrolled block is refused before any write.
    const lacking = s.run(["onboard", "--definition", s.source, "--json"]);
    assert.notEqual(lacking.status, 0);
    assert.match(lacking.stdout, /Company identity continuity/);
    const differing = join(s.dir, "differing.yaml");
    writeFileSync(differing, YAML.stringify({ ...definition, company_identity: { ...definition.company_identity, subject: "00000000-0000-4000-8000-000000000000" } }));
    const refused = s.run(["onboard", "--definition", differing, "--json"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout, /Company identity continuity/);
    assert.deepEqual(tree(s.home), settled);
    pass("onboard --definition that drops or changes the enrolled block is refused with nothing written");

    // Rename: the display name changes through the owning definition; the subject does not.
    const renamed = { ...definition, display_name: "Renamed Specialist" };
    writeFileSync(s.source, YAML.stringify(renamed));
    assert.equal(s.json(s.run(["onboard", "--definition", s.source, "--json"])).changed, true);
    const shown = s.json(s.run(["identity", "show", "specialist", "--json"]));
    assert.equal(shown.fields.display_name, "Renamed Specialist");
    assert.equal(shown.identity.subject, applied.identity.subject);
    assert.ok(s.json(s.run(["audit", "--employee", "specialist", "--json"])).ok);
    pass("renamed display name keeps the same subject");

    // Status on a specialist: the block is replaced in place, schema_version stays 2, the desk contract follows.
    const suspended = s.json(s.run(["identity", "status", "specialist", "suspended", "--apply", "--json"]));
    assert.deepEqual(suspended.writes, [agentPath, contractPath]);
    const stored = YAML.parse(readFileSync(agentPath, "utf8"));
    assert.equal(stored.schema_version, 2);
    assert.equal(stored.company_identity.status, "suspended");
    assert.equal(stored.company_identity.subject, applied.identity.subject);
    assert.equal(YAML.parse(readFileSync(contractPath, "utf8")).company_identity.status, "suspended");
    assert.equal(s.json(s.run(["audit", "--employee", "specialist", "--json"])).standing, "in good standing");
    pass("specialist status change keeps schema_version 2, refreshes contract.yaml and stays in good standing");

    // Hire never introduces a block: only `identity enroll` censuses every other definition first.
    const forged = join(s.dir, "forged.yaml");
    writeFileSync(forged, YAML.stringify({ ...renamed, id: "forger", display_name: "Forger", memory: { write_bank: "agent-forger" }, company_identity: { ...stored.company_identity, status: "active" } }));
    const homeBefore = tree(s.home);
    const forgedHire = s.run(["hire", "--definition", forged, "--json"]);
    assert.notEqual(forgedHire.status, 0);
    assert.match(forgedHire.stdout + forgedHire.stderr, /never introduce a company_identity/);
    assert.deepEqual(tree(s.home), homeBefore);
    pass("hire --definition carrying a company_identity block is refused before any write");
  }

  // -- Legacy read ------------------------------------------------------------------------
  {
    const f = fixture("legacy");
    f.named("legacy-pm", "ada");
    const desk = join(f.home, ".agents/workforce/legacy");
    mkdirSync(desk, { recursive: true });
    writeFileSync(join(desk, "agent.yaml"), YAML.stringify({ schema_version: 1, id: "legacy", display_name: "Legacy", role: "ops", charter: { purpose: "p" }, skills: { set: "x" }, memory: { write_bank: "agent-legacy" } }));
    const before = tree(f.dir);
    const post = f.json(f.run(["identity", "show", "legacy-pm", "--json"]));
    assert.equal(post.enrolled, false);
    assert.equal(post.identity, null);
    assert.equal(post.fields.identity, "ada");
    assert.equal(post.fields.agent_id, "legacy-pm");
    const specialist = f.json(f.run(["identity", "show", "legacy", "--json"]));
    assert.equal(specialist.enrolled, false);
    assert.deepEqual(specialist.fields, { schema_version: 1, id: "legacy", display_name: "Legacy", role: "ops" });
    assert.deepEqual(tree(f.dir), before);
    pass("legacy role.yaml and v1 agent.yaml read as enrolled:false with their fields");
  }

  // -- Blockers: every one exits 1 and writes nothing ------------------------------------
  const blocked = (f, args, code) => {
    const before = tree(f.dir);
    const result = f.json(f.run(["identity", ...args, "--apply", "--json"]), 1);
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.code === code), `${code} expected in ${JSON.stringify(result.blockers)}`);
    assert.deepEqual(tree(f.dir), before, `${code} wrote nothing`);
    return result;
  };
  {
    const f = fixture("unnamed");
    f.post("plain-pm", "role: pm\nagent_id: plain-pm\n");
    blocked(f, ["enroll", "plain-pm"], "unnamed-post");
    pass("unnamed post is an explicit unnamed-post blocker; no person is invented");
  }
  {
    const f = fixture("handle-taken");
    f.named("ada-pm", "ada", f.yamlBlock({ subject: "11111111-1111-4111-8111-111111111111", handle: "ada", status: "retired" }));
    f.named("bob-pm", "bob");
    blocked(f, ["enroll", "bob-pm", "--handle", "ada"], "handle-taken");
    pass("a retired tombstone keeps its handle: handle-taken");
  }
  {
    const f = fixture("subject-duplicate");
    f.named("ada-pm", "ada", f.yamlBlock({ subject: "22222222-2222-4222-8222-222222222222", handle: "ada" }));
    f.named("bob-pm", "bob", f.yamlBlock({ subject: "22222222-2222-4222-8222-222222222222", handle: "bob" }));
    blocked(f, ["enroll", "bob-pm"], "subject-duplicate");
    pass("a subject recorded twice is subject-duplicate");
  }
  {
    const f = fixture("binding-duplicate");
    const bindings = { plane: { principal: "db1ac9dc-6180-47d0-aa87-e1bf46d10707", credential_ref: "op://DeLoSecrets/x/credential" } };
    f.named("ada-pm", "ada", f.yamlBlock({ subject: "33333333-3333-4333-8333-333333333333", handle: "ada", bindings }));
    f.named("bob-pm", "bob", f.yamlBlock({ subject: "44444444-4444-4444-8444-444444444444", handle: "bob", bindings }));
    blocked(f, ["enroll", "bob-pm"], "binding-duplicate");
    pass("one provider principal bound to two people is binding-duplicate");
  }
  {
    const f = fixture("person-elsewhere");
    f.named("first-pm", "dup");
    f.named("second-pm", "dup");
    blocked(f, ["enroll", "first-pm"], "person-elsewhere");
    const g = fixture("person-enrolled-elsewhere");
    g.named("old-pm", "cy", g.yamlBlock({ subject: "55555555-5555-4555-8555-555555555555", handle: "cy" }));
    g.named("new-pm", "cy");
    const result = blocked(g, ["enroll", "new-pm"], "person-elsewhere");
    assert.ok(result.blockers.some((b) => b.code === "handle-taken"));
    pass("a person declared or enrolled at another definition is person-elsewhere");
  }
  {
    const f = fixture("handle-reserved");
    f.named("mail-pm", "postmaster");
    blocked(f, ["enroll", "mail-pm"], "handle-reserved");
    f.named("ops-pm", "dee");
    blocked(f, ["enroll", "ops-pm", "--handle", "mail-pm"], "handle-reserved");
    blocked(f, ["enroll", "ops-pm", "--handle", "webmaster"], "handle-reserved");
    pass("RFC 2142 role names and other registry post ids are handle-reserved");
  }
  {
    const f = fixture("handle-reserved-unhired");
    // A definition-less registry row still reserves its post id, and an unhired
    // desk with the same id must not claim it as a handle (review fix: identity
    // is not ownership — only an enrolled specialist's posts[] count).
    const doc = YAML.parseDocument(readFileSync(f.registry, "utf8"));
    doc.setIn(["agents", "ada"], { profile_name: "ada" });
    writeFileSync(f.registry, String(doc));
    const desk = join(f.home, ".agents/workforce/ada");
    mkdirSync(desk, { recursive: true });
    writeFileSync(join(desk, "agent.yaml"), YAML.stringify({ schema_version: 1, id: "ada", display_name: "Ada", role: "ops", charter: { purpose: "p" }, skills: { set: "x" }, memory: { write_bank: "agent-ada" } }));
    blocked(f, ["enroll", "ada"], "handle-reserved");
    pass("an unhired desk cannot claim a handle reserved by a definition-less registry post id");
  }
  {
    const f = fixture("status-missing-definition");
    f.post("gone-pm"); // registry row and role dir, but role.yaml was never written
    blocked(f, ["status", "gone-pm", "suspended"], "invalid-definition");
    pass("status on a deleted/missing definition reports invalid-definition, never not-enrolled");
  }
  {
    const f = fixture("invalid");
    const desk = join(f.home, ".agents/workforce/early");
    mkdirSync(desk, { recursive: true });
    writeFileSync(join(desk, "agent.yaml"), YAML.stringify({ schema_version: 1, id: "early", display_name: "Early", role: "ops", charter: { purpose: "p" }, skills: { set: "x" }, memory: { write_bank: "agent-early" }, company_identity: f.block({ subject: "66666666-6666-4666-8666-666666666666", handle: "early" }) }));
    blocked(f, ["enroll", "early"], "invalid-definition");
    f.named("bad-pm", "eve", "company_identity:\n  version: 1\n  subject: 77777777-7777-4777-8777-777777777777\n  handle: eve\n  email: someone-else@agents.delo.sh\n  status: active\n  enrolled_at: \"2026-10-01T00:00:00.000Z\"\n");
    blocked(f, ["enroll", "bad-pm"], "invalid-definition");
    f.named("extra-pm", "fay", f.yamlBlock({ subject: "88888888-8888-4888-8888-888888888888", handle: "fay" }).replace("  status:", "  bindings:\n    plane:\n      principal: p\n      token: raw\n  status:"));
    blocked(f, ["enroll", "extra-pm"], "invalid-definition");
    f.named("good-pm", "gus");
    const census = blocked(f, ["enroll", "good-pm"], "invalid-definition");
    assert.ok(census.blockers.some((b) => /census cannot read/.test(b.detail)));
    assert.equal(f.json(f.run(["identity", "show", "bad-pm", "--json"]), 1).ok, false);
    pass("v1 agent.yaml carrying a block, a mismatched address, an unknown binding key and an unreadable census are invalid-definition");
  }
  {
    const f = fixture("symlink");
    const real = join(f.dir, "real-role.yaml");
    writeFileSync(real, "role: pm\nagent_id: link-pm\nidentity:\n  name: hal\n");
    const rolePath = f.post("link-pm");
    symlinkSync(real, rolePath);
    blocked(f, ["enroll", "link-pm"], "invalid-definition");
    writeFileSync(real, `role: pm\nagent_id: link-pm\nidentity:\n  name: hal\n${f.yamlBlock({ subject: "99999999-9999-4999-8999-999999999999", handle: "hal" })}`);
    const preview = f.json(f.run(["identity", "status", "link-pm", "suspended", "--json"]), 1);
    assert.deepEqual(preview.blockers.map((b) => b.code), ["invalid-definition"]);
    blocked(f, ["status", "link-pm", "suspended"], "invalid-definition");
    pass("a symlinked definition is refused before any write, for enroll and status alike");
  }
  {
    const f = fixture("unresolvable");
    f.named("una-pm", "una");
    const before = tree(f.dir);
    blocked(f, ["enroll", "una-pm", "--handle", "Una_Upper"], "invalid-handle");
    const missing = f.json(f.run(["identity", "show", "nobody", "--json"]), 1);
    assert.match(missing.error, /Employee not found: nobody/);
    const probe = f.json(f.run(["identity", "readiness", "--probe", "github", "--json"]), 1);
    assert.match(probe.error, /Unsupported probe: github/);
    assert.deepEqual(tree(f.dir), before);
    pass("a malformed handle is invalid-handle; an unknown employee or probe exits 1 with nothing written");
  }

  // -- Reconciliation inventory: bound candidates and the override path -------------------
  {
    const f = fixture("reconcile");
    const inventory = join(f.dir, "candidates.yaml");
    writeFileSync(inventory, YAML.stringify({ schema_version: 1, candidates: [
      { provider: "plane", principal: "p-1", person: "zed", description: "already adopted elsewhere" },
      { provider: "plane", principal: "p-2", post: "zed-pm", description: "free" },
      { provider: "plane", principal: "p-3", person: "nobody-here" },
    ] }));
    const holder = f.named("yan-pm", "yan", f.yamlBlock({ subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", handle: "yan", bindings: { plane: { principal: "p-1" } } }));
    f.named("zed-pm", "zed");
    const result = f.json(f.run(["identity", "enroll", "zed-pm", "--json"], { FLUME_IDENTITY_CANDIDATES: inventory }));
    assert.deepEqual(result.reconcile.map((c) => [c.principal, c.state, c.bound_at]), [["p-1", "bound", holder], ["p-2", "unadopted", undefined]]);
    assert.deepEqual(result.warnings, []);
    const absent = f.json(f.run(["identity", "enroll", "zed-pm", "--json"], { FLUME_IDENTITY_CANDIDATES: join(f.dir, "absent.yaml") }));
    assert.deepEqual(absent.reconcile, []);
    assert.match(absent.warnings[0], /candidate inventory not found/);
    pass("a candidate already bound elsewhere is reported bound with its holder; a missing inventory is a warning");
  }

  // -- Move and rotate keep the subject ---------------------------------------------------
  {
    const f = fixture("move");
    const from = f.named("first-pm", "ida");
    const enrolled = f.json(f.run(["identity", "enroll", "first-pm", "--apply", "--json"]));
    // Move the person: `identity:` and `company_identity:` travel together to the new post.
    const moved = YAML.parse(readFileSync(from, "utf8"));
    writeFileSync(from, "role: pm\nagent_id: first-pm\n");
    const to = f.post("second-pm", `role: pm\nagent_id: second-pm\n${YAML.stringify({ identity: moved.identity, company_identity: moved.company_identity })}`);
    assert.equal(f.json(f.run(["identity", "show", "second-pm", "--json"])).identity.subject, enrolled.identity.subject);
    assert.equal(f.json(f.run(["identity", "show", "ida", "--json"])).identity.subject, enrolled.identity.subject);
    assert.equal(f.json(f.run(["identity", "enroll", "ida", "--apply", "--json"])).changed, false);
    // Rotate: a binding's credential reference changes; the person does not.
    const doc = YAML.parseDocument(readFileSync(to, "utf8"));
    doc.setIn(["company_identity", "bindings"], { github: { principal: "app-1", credential_ref: "op://DeLoSecrets/a/one" } });
    writeFileSync(to, String(doc));
    const once = f.json(f.run(["identity", "show", "ida", "--json"]));
    const rotate = YAML.parseDocument(readFileSync(to, "utf8"));
    rotate.setIn(["company_identity", "bindings", "github", "credential_ref"], "op://DeLoSecrets/a/two");
    writeFileSync(to, String(rotate));
    const rotated = f.json(f.run(["identity", "show", "ida", "--json"]));
    assert.equal(once.identity.subject, enrolled.identity.subject);
    assert.equal(rotated.identity.subject, enrolled.identity.subject);
    assert.equal(rotated.identity.bindings.github.credential_ref, "op://DeLoSecrets/a/two");
    pass("moving posts and rotating a binding credential keep the same subject");
  }

  // -- Status: local only, retired is terminal -------------------------------------------
  {
    const f = fixture("status");
    const rolePath = f.named("jo-pm", "jo");
    f.named("kim-pm", "kim");
    const enrolled = f.json(f.run(["identity", "enroll", "jo-pm", "--apply", "--json"]));
    const before = tree(f.dir);
    const preview = f.json(f.run(["identity", "status", "jo-pm", "suspended", "--json"]));
    assert.equal(preview.changed, true);
    assert.equal(preview.provider_revocation, "not_performed");
    assert.deepEqual(tree(f.dir), before);
    const suspended = f.json(f.run(["identity", "status", "jo-pm", "suspended", "--apply", "--json"]));
    assert.equal(suspended.provider_revocation, "not_performed");
    assert.match(suspended.note, /provider access was not revoked/);
    const stored = YAML.parse(readFileSync(rolePath, "utf8")).company_identity;
    assert.equal(stored.status, "suspended");
    assert.match(stored.status_changed_at, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(stored.subject, enrolled.identity.subject);
    assert.ok(readFileSync(rolePath, "utf8").startsWith("# operator note: keep me\n"));
    const human = f.run(["identity", "status", "jo-pm", "retired", "--apply"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /provider access was not revoked/);
    assert.equal(YAML.parse(readFileSync(rolePath, "utf8")).company_identity.status, "retired");
    const retired = blocked(f, ["status", "jo-pm", "active"], "retired-terminal");
    assert.equal(retired.provider_revocation, "not_performed");
    blocked(f, ["status", "kim-pm", "suspended"], "not-enrolled");
    blocked(f, ["status", "jo-pm", "fired"], "invalid-status");
    blocked(f, ["enroll", "kim-pm", "--handle", "jo"], "handle-taken");
    pass("suspend/retire are recorded locally with provider_revocation not_performed; retired is terminal and keeps its handle");

    // A block in the middle of the file is replaced in place; what follows it keeps every byte.
    const head = "role: pm\nagent_id: mid-pm\nidentity:\n  name: mo\n";
    const tail = "\n# trailing operator note\ndeployment:\n  local_only: true\n";
    const midPath = f.post("mid-pm", `${head}${f.yamlBlock({ subject: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", handle: "mo" })}${tail}`);
    f.json(f.run(["identity", "status", "mid-pm", "suspended", "--apply", "--json"]));
    const mid = readFileSync(midPath, "utf8");
    assert.ok(mid.startsWith(head) && mid.endsWith(tail), mid);
    assert.equal(YAML.parse(mid).company_identity.status, "suspended");
    assert.equal(YAML.parse(mid).deployment.local_only, true);
    pass("status on a mid-file block keeps every byte before and after it");
  }

  // -- Readiness ---------------------------------------------------------------------------
  {
    const f = fixture("readiness");
    const cf = await fakeCloudflare({});
    const quiet = await f.runAsync(["identity", "readiness", "--json"], { FLUME_CLOUDFLARE_API_BASE: cf.base, CLOUDFLARE_API_TOKEN: "fixture-secret-token" });
    assert.equal(quiet.status, 0, quiet.stderr);
    const report = JSON.parse(quiet.stdout);
    assert.equal(report.ready, false);
    assert.deepEqual(Object.keys(report.checks), ["cloudflare_plan", "mail_dns_conflicts", "service_token_capacity", "access_assertion_policy", "github_sandbox_installation", "github_native_authorship", "plane_native_identity", "provider_account_rights"]);
    for (const check of Object.values(report.checks)) { assert.equal(check.status, "unproven"); assert.equal(check.ready, false); assert.equal(check.cost, null); }
    assert.equal(report.probes.cloudflare, "not_requested");
    assert.equal(cf.seen.length, 0, "no probe flag means zero network");
    const missing = JSON.parse((await f.runAsync(["identity", "readiness", "--probe", "cloudflare", "--json"], { FLUME_CLOUDFLARE_API_BASE: cf.base })).stdout);
    assert.match(missing.probes.cloudflare, /^not_run/u);
    const human = await f.runAsync(["identity", "readiness", "--probe", "cloudflare"], { FLUME_CLOUDFLARE_API_BASE: cf.base });
    assert.match(human.stdout, /probe cloudflare: not_run: CLOUDFLARE_API_TOKEN is not set/);
    assert.equal(cf.seen.length, 0);
    await cf.close();
    pass("without measurement every check is unproven, not ready and not free; no flag or no token means no request");

    const zone = { id: "zone-1", name: "delo.sh", plan: { name: "Free Website", price: 0, currency: "USD" }, account: { id: "acct-1" } };
    const live = await fakeCloudflare({
      "/client/v4/zones?name=delo.sh": [200, { success: true, result: [zone] }],
      "/client/v4/zones/zone-1/dns_records?type=MX&name=agents.delo.sh": [200, { success: true, result: [] }],
      "/client/v4/zones/zone-1/dns_records?type=MX&name=delo.sh": [200, { success: true, result: [{ name: "delo.sh", content: "route1.mx.cloudflare.net", priority: 10 }] }],
      "/client/v4/zones/zone-1/email/routing": [200, { success: true, result: { enabled: true, status: "ready" } }],
      "/client/v4/accounts/acct-1/access/service_tokens": [403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }],
    });
    const probed = await f.runAsync(["identity", "readiness", "--probe", "cloudflare", "--json"], { FLUME_CLOUDFLARE_API_BASE: live.base, CLOUDFLARE_API_TOKEN: "fixture-secret-token" });
    assert.equal(probed.status, 0, probed.stderr);
    assert.equal(probed.stdout.includes("fixture-secret-token") || probed.stderr.includes("fixture-secret-token"), false, "the token is never echoed");
    const measured = JSON.parse(probed.stdout);
    assert.equal(measured.ready, false);
    assert.equal(measured.probes.cloudflare, "run");
    assert.ok(live.seen.length === 5 && live.seen.every((r) => r.method === "GET" && r.auth === "Bearer fixture-secret-token"), JSON.stringify(live.seen));
    const plan = measured.checks.cloudflare_plan;
    assert.equal(plan.status, "measured");
    assert.equal(plan.ready, false);
    assert.equal(plan.cost, null);
    assert.deepEqual(plan.evidence[0].measured, { zone: "delo.sh", zone_id: "zone-1", plan: "Free Website", plan_price: 0, plan_currency: "USD", account_id: "acct-1" });
    assert.equal(plan.evidence[0].http_status, 200);
    assert.equal(plan.evidence[0].path, "/zones?name=delo.sh");
    assert.ok(!Number.isNaN(Date.parse(plan.evidence[0].observed_at)));
    const mail = measured.checks.mail_dns_conflicts;
    assert.deepEqual(mail.evidence.map((e) => e.measured), [[], [{ name: "delo.sh", content: "route1.mx.cloudflare.net", priority: 10 }], { enabled: true, status: "ready" }]);
    const tokens = measured.checks.service_token_capacity;
    assert.equal(tokens.status, "unproven");
    assert.equal(tokens.evidence[0].http_status, 403);
    assert.match(tokens.evidence[0].error, /Authentication error/);
    assert.equal(measured.checks.provider_account_rights.status, "unproven");
    await live.close();
    pass("authorized --probe cloudflare records GET-only time, path, HTTP status and exact values; an HTTP error stays unproven");

    // A 200 that names no zone, or is not JSON at all, measured nothing.
    for (const body of [{ success: true, result: [] }, "<html>proxy login</html>"]) {
      const blind = await fakeCloudflare({ "/client/v4/zones?name=delo.sh": [200, body] });
      const report = JSON.parse((await f.runAsync(["identity", "readiness", "--probe", "cloudflare", "--json"], { FLUME_CLOUDFLARE_API_BASE: blind.base, CLOUDFLARE_API_TOKEN: "fixture-secret-token" })).stdout);
      assert.equal(report.checks.cloudflare_plan.status, "unproven", JSON.stringify(report.checks.cloudflare_plan));
      assert.ok(report.checks.cloudflare_plan.evidence[0].error);
      assert.equal(blind.seen.length, 1);
      await blind.close();
    }
    pass("a 200 with no visible zone or no JSON body stays unproven");
  }

  console.log(`\n${count} company identity check groups passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
