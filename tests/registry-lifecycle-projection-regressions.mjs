// Registry projection for the ticket lifecycle: `agents.<id>.company_identity` and `agents.<id>.gateway_consumer`,
// written by `hermes.registry-parity` so the n8n Fleet node can attribute lane failures and dispatches without
// running flume (workforce/registry-lifecycle.ts).
//
// Pins:
//   1. an enrolled post with a VERIFIED native Plane binding projects subject/handle/email/status + plane
//      {attribution_mode: native, native_actor_id}, and its desk delta's FLUME-39 reference names its consumer;
//   2. an enrolled post whose Plane binding is only requested projects no plane block, and a desk that inherits the
//      fleet base runs the shared base consumer `hermes`;
//   3. an un-enrolled post loses a stale company_identity, and a row with no desk loses a stale gateway_consumer;
//   4. a portable specialist (no repository) is projected from its agent.yaml, whichever repository runs the rule,
//      and a desk reference that is not the FLUME-39 shape names no consumer;
//   5. the generated config.yaml (what the desk RUNS) wins over its delta, exactly as the gateway adapter resolves it;
//   6. an unreadable desk config holds the row's value as it is and says so; it is never guessed either way;
//   8. a row that NAMES a definition which is missing (moved checkout, dangling link) holds its company_identity and
//      says so; only a row that names none, or an existing definition that enrolls nobody, drops it. A finding made
//      only of held keys is not fixable, so audit and remediate converge;
//   9. the write is compare-and-swap: a registry that changed while the run waited for the lock is never overwritten
//      (status "blocked"), and a successful write keeps comments and quoted timestamps byte-for-byte.
//   7. --dry-run writes nothing; a second remediation is a no-op; only the two keys change; no credential reference
//      or secret is ever projected.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const work = mkdtempSync(join(tmpdir(), "flume-registry-lifecycle-"));

const ITEM = "yeurk5dpqkaarspvsn3cjtmkki";
const gatewayRef = (consumer) => `op://DeLoSecrets/${ITEM}/${consumer}`;
const NATIVE = "292ac356-3640-474e-ac01-8b0611ed6a91";
const SPECIALIST_NATIVE = "ba82e3bd-9b21-4066-9737-bd6279cf00f7";
const PLANE_KEY = "op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/5td5eddyyhjnbbsgfoovfi5x2y";
const GROLF = "1dcd3567-3b5e-46b0-a6c3-a2753d6c763b";
const BOB = "6ab06d6a-65c4-4295-8cc6-a322cc10f294";
const SPEC = "1dca27f5-06e8-47a3-86c9-49bc3ed5331c";

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HERMES_|FLUME_|PJ_)/u.test(key)));

try {
  const home = join(work, "home");
  const fleet = join(home, ".hermes");
  const repo = join(work, "repo");
  mkdirSync(fleet, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "# fixture\n");

  const desk = (profile, files) => {
    const dir = join(fleet, "profiles", profile);
    mkdirSync(dir, { recursive: true });
    for (const [name, consumerOrRef] of Object.entries(files)) {
      const ref = consumerOrRef.startsWith("op://") ? consumerOrRef : gatewayRef(consumerOrRef);
      writeFileSync(join(dir, name), `model:\n  default: auto\nsecrets:\n  onepassword:\n    env:\n      AUTOMATICAI_GATEWAY_KEY: ${ref}\n`);
    }
  };
  // The fleet base maps the shared consumer every desk inherits.
  writeFileSync(join(fleet, "config.yaml"), `secrets:\n  onepassword:\n    env:\n      AUTOMATICAI_GATEWAY_KEY: ${gatewayRef("hermes")}\n`);

  const companyBlock = (subject, handle, status, plane) => `company_identity:
  version: 1
  subject: "${subject}"
  handle: "${handle}"
  email: "${handle}@agents.delo.sh"
  status: "${status}"
  enrolled_at: "2026-10-13T09:14:09.584Z"
  bindings:
    cloudflare_access:
      principal: "abc123.access"
      instance: "https://delo.cloudflareaccess.com"
      credential_ref: "op://DeLoSecrets/zzzzzzzzzzzzzzzzzzzzzzzzzz/clientsecret"
${plane ? `    plane:\n${Object.entries(plane).map(([key, value]) => `      ${key}: "${value}"`).join("\n")}\n` : ""}`;

  const roles = {
    // 1. grolf-like: named, enrolled, ADOPTED native Plane binding.
    "named-pm": { dir: "pm", name: "grolf", block: companyBlock(GROLF, "grolf", "active",
      { principal: NATIVE, instance: "https://plane.delo.sh/33god", credential_ref: PLANE_KEY, attribution_mode: "native", native_actor_id: NATIVE }),
      // FLUME-52's own projection of the same binding, already in place.
      plane: `      member_id: ${NATIVE}\n      key_ref: ${PLANE_KEY}\n` },
    // 2. enrolled, but the Plane binding is only requested (no native_actor_id): no plane block.
    "plain-director": { dir: "director", name: "bob", block: companyBlock(BOB, "bob", "suspended",
      { principal: NATIVE.replace(/^2/u, "3"), instance: "https://plane.delo.sh/33god", credential_ref: PLANE_KEY, attribution_mode: "native" }) },
    // 3. an unnamed, un-enrolled post.
    "ops-pm": { dir: "ops", name: null, block: "" },
  };
  const roleDir = (dir) => join(repo, "agents", "hermes", dir);
  for (const [agentId, role] of Object.entries(roles)) {
    mkdirSync(join(roleDir(role.dir), ".scripts"), { recursive: true });
    const identity = role.name ? `identity:\n  name: ${role.name}\n` : "";
    writeFileSync(join(roleDir(role.dir), "role.yaml"), `repo: fixture\nrole: ${role.dir}\nagent_id: ${agentId}\nprofile: ${agentId}\n${identity}${role.block}`);
  }
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify({ project_name: "fixture", repo_path: repo,
    agents: Object.fromEntries(Object.entries(roles).map(([id, role]) => [id, { role: role.dir, role_dir: `agents/hermes/${role.dir}`, provisioning_state: "provisioned" }])) }, null, 2)}\n`);

  // 4. a portable specialist: no repository, its own agent.yaml is the SSOT.
  const specDesk = join(home, ".agents", "workforce", "spec");
  mkdirSync(specDesk, { recursive: true });
  writeFileSync(join(specDesk, "agent.yaml"), `schema_version: 2\nid: spec\ndisplay_name: Spec\nrole: workflows-director\n${companyBlock(SPEC, "spec", "active",
    { principal: SPECIALIST_NATIVE, instance: "https://plane.delo.sh/33god", credential_ref: PLANE_KEY, native_actor_id: SPECIALIST_NATIVE })}`);

  // Desks. named-pm: delta only (render predicts its own consumer). plain-director: generated from the base.
  // spec: a launcher-style reference that is not the FLUME-39 shape. ops-pm: no desk at all.
  desk("named-pm", { "config.delta.yaml": "hermes-named-pm" });
  desk("plain-director", { "config.yaml": "hermes" });
  desk("spec", { "config.delta.yaml": "op://DeLoSecrets/hermes-spec/credential", "config.yaml": "op://DeLoSecrets/hermes-spec/credential" });

  const registryPath = join(fleet, "agents-registry.yaml");
  const postRow = (agentId, role, extra = "") => `  ${agentId}:
    repo: fixture
    role: ${role.dir}
    type: hermes
    project_path: ${repo}
    role_dir: ${roleDir(role.dir)}
    profile_name: ${agentId}
${role.name ? `    identity: ${role.name}\n    hindsight:\n      write_bank: agent-${role.name}\n      recall_banks:\n        - agent-${role.name}\n` : ""}    plane:
      workspace: 33god
      project_id: 15258893-0206-4e8f-aea6-340eb217988c
      identifier: 33GOD
${role.plane ?? ""}    bloodbank:
      enabled: true
      gateway_scope: fleet
      target_agent_id: ${agentId}
${extra}`;
  const seed = () => writeFileSync(registryPath, `schema_version: 1
gateways:
  bloodbank:
    scope: fleet
agents:
${postRow("named-pm", roles["named-pm"])}${postRow("plain-director", roles["plain-director"])}${postRow("ops-pm", roles["ops-pm"], `    company_identity:
      subject: ${GROLF}
      handle: ghost
      email: ghost@agents.delo.sh
      status: active
    gateway_consumer: hermes-ops-pm
`)}  spec:
    employment: portable-specialist
    definition_path: ${join(specDesk, "agent.yaml")}
    desk_path: ${specDesk}
    identity: spec
    profile_name: spec
    display_name: Spec
    role: workflows-director
    type: hermes
    hindsight:
      write_bank: agent-spec
      recall_banks:
        - agent-spec
    bloodbank:
      enabled: true
      gateway_scope: fleet
      target_agent_id: spec
    gateway_consumer: hermes-spec
`);

  const run = (args) => {
    const result = spawnSync("node", [cli, ...args], { cwd: repo, encoding: "utf8", env: { ...env, HOME: home, XDG_CACHE_HOME: join(home, ".cache") } });
    assert.ok(result.stdout.trim(), `expected JSON from ${args.join(" ")}\n${result.stderr}`);
    return { json: JSON.parse(result.stdout), raw: result.stdout + result.stderr };
  };
  const parity = () => run(["audit", repo, "--rules", "hermes.registry-parity", "--json"]).json.rules.find((rule) => rule.id === "hermes.registry-parity");
  const remediate = (...flags) => run(["remediate", "hermes.registry-parity", repo, "--json", ...flags]);
  const registry = () => YAML.parse(readFileSync(registryPath, "utf8"));
  const lifecycleLines = (audit) => audit.details.filter((line) => /company_identity|gateway_consumer/u.test(line));

  seed();
  const seeded = readFileSync(registryPath, "utf8");
  const before = registry();

  // The audit reports every row's drift -- including the specialist's, which belongs to no repository.
  let audit = parity();
  assert.equal(audit.status, "fail", JSON.stringify(audit));
  assert.equal(audit.fixable, true);
  const drift = lifecycleLines(audit);
  assert.deepEqual(audit.details.filter((line) => !lifecycleLines({ details: [line] }).length), [], "the fixture is otherwise in parity");
  for (const pattern of [
    /registry company_identity for named-pm is absent/u,
    /registry gateway_consumer for named-pm is absent \(its desk runs consumer "hermes-named-pm"\)/u,
    /registry company_identity for plain-director is absent/u,
    /registry gateway_consumer for plain-director is absent \(its desk runs consumer "hermes"\)/u,
    /registry company_identity for ops-pm is .* but .*ops\/role\.yaml is not enrolled; a stale projection is removed/u,
    /registry gateway_consumer for ops-pm is "hermes-ops-pm" \(its desk runs no FLUME-39 gateway consumer\)/u,
    /registry company_identity for spec is absent/u,
    /registry gateway_consumer for spec is "hermes-spec" \(its desk runs no FLUME-39 gateway consumer\)/u,
  ]) assert.ok(drift.some((line) => pattern.test(line)), `missing ${pattern}\n${drift.join("\n")}`);
  assert.equal(drift.length, 8, drift.join("\n"));

  // 7. a preview writes nothing.
  const preview = remediate("--dry-run");
  assert.equal(preview.json.results.find((rule) => rule.id === "hermes.registry-parity").status, "skipped");
  assert.equal(readFileSync(registryPath, "utf8"), seeded, "--dry-run must not touch the registry");

  const applied = remediate();
  assert.equal(applied.json.results.find((rule) => rule.id === "hermes.registry-parity").status, "applied", applied.raw);
  const after = registry();

  // 1. enrolled + verified native Plane binding; desk delta names the consumer.
  assert.deepEqual(after.agents["named-pm"].company_identity, {
    subject: GROLF, handle: "grolf", email: "grolf@agents.delo.sh", status: "active",
    plane: { attribution_mode: "native", native_actor_id: NATIVE },
  });
  assert.equal(after.agents["named-pm"].gateway_consumer, "hermes-named-pm");
  // 2. enrolled without a verified Plane actor; desk inherits the fleet base consumer.
  assert.deepEqual(after.agents["plain-director"].company_identity, { subject: BOB, handle: "bob", email: "bob@agents.delo.sh", status: "suspended" });
  assert.equal(after.agents["plain-director"].gateway_consumer, "hermes");
  // 3. un-enrolled post, no desk: both stale projections removed.
  assert.equal("company_identity" in after.agents["ops-pm"], false);
  assert.equal("gateway_consumer" in after.agents["ops-pm"], false);
  // 4. specialist projected from agent.yaml; a launcher-shaped reference names no consumer.
  assert.deepEqual(after.agents.spec.company_identity, {
    subject: SPEC, handle: "spec", email: "spec@agents.delo.sh", status: "active",
    plane: { attribution_mode: "native", native_actor_id: SPECIALIST_NATIVE },
  });
  assert.equal("gateway_consumer" in after.agents.spec, false);

  // 7. only the two keys moved; nothing secret-shaped or credential-shaped was projected.
  const strip = (doc) => ({ ...doc, agents: Object.fromEntries(Object.entries(doc.agents).map(([id, row]) => {
    const { company_identity: _c, gateway_consumer: _g, ...rest } = row;
    return [id, rest];
  })) });
  assert.deepEqual(strip(after), strip(before), "only company_identity / gateway_consumer may change");
  for (const row of Object.values(after.agents)) {
    if (row.company_identity) assert.deepEqual(Object.keys(row.company_identity).filter((key) => !["subject", "handle", "email", "status", "plane"].includes(key)), []);
    assert.doesNotMatch(JSON.stringify(row.company_identity ?? {}), /op:\/\/|credential|principal|key_ref/u);
  }
  assert.doesNotMatch(applied.raw, /clientsecret|5td5eddyyhjnbbsgfoovfi5x2y/u, "the remediation output never echoes a credential reference from the definition");

  audit = parity();
  assert.equal(audit.status, "pass", JSON.stringify(audit.details));
  const once = readFileSync(registryPath, "utf8");
  assert.equal(remediate().json.results.find((rule) => rule.id === "hermes.registry-parity").status, "noop");
  assert.equal(readFileSync(registryPath, "utf8"), once, "a second remediation changes nothing");

  // 5. the generated config is what the desk RUNS: a stale render beats its newer delta.
  desk("named-pm", { "config.yaml": "hermes" });
  audit = parity();
  assert.ok(lifecycleLines(audit).some((line) => /gateway_consumer for named-pm is "hermes-named-pm" \(its desk runs consumer "hermes"\)/u.test(line)), JSON.stringify(audit.details));
  remediate();
  assert.equal(registry().agents["named-pm"].gateway_consumer, "hermes");
  desk("named-pm", { "config.yaml": "hermes-named-pm" });
  remediate();
  assert.equal(registry().agents["named-pm"].gateway_consumer, "hermes-named-pm");

  // 6. an unreadable desk config holds the row as it is, and the audit says why.
  const generated = join(fleet, "profiles", "plain-director", "config.yaml");
  rmSync(generated);
  symlinkSync(join(fleet, "config.yaml"), generated);
  audit = parity();
  assert.ok(lifecycleLines(audit).some((line) => /gateway_consumer for plain-director cannot be projected \(left as is\)/u.test(line)), JSON.stringify(audit.details));
  remediate();
  assert.equal(registry().agents["plain-director"].gateway_consumer, "hermes", "a held key is never rewritten");

  // An un-enrolled definition whose company_identity is malformed is held too, never read as "not enrolled".
  rmSync(generated);
  desk("plain-director", { "config.yaml": "hermes" });
  const directorYaml = join(roleDir("director"), "role.yaml");
  const directorText = readFileSync(directorYaml, "utf8");
  writeFileSync(directorYaml, directorText.replace('status: "suspended"', 'status: "on-leave"'));
  audit = parity();
  assert.ok(lifecycleLines(audit).some((line) => /company_identity for plain-director cannot be projected \(left as is\): .*malformed/u.test(line)), JSON.stringify(audit.details));
  remediate();
  assert.equal(registry().agents["plain-director"].company_identity.status, "suspended", "a malformed definition never strips or rewrites the projection");
  writeFileSync(directorYaml, directorText);
  assert.equal(parity().status, "pass");

  // 8. a definition that is MISSING is unreadable, not "not enrolled": the identity is held, never dropped.
  const specAgent = join(specDesk, "agent.yaml");
  const specIdentity = () => registry().agents.spec.company_identity;
  assert.equal(specIdentity().handle, "spec");
  const heldLine = /company_identity for spec cannot be projected \(left as is\): .*does not exist/u;
  const checkHeld = (why) => {
    audit = parity();
    assert.equal(audit.status, "fail", `${why}: ${JSON.stringify(audit.details)}`);
    assert.ok(lifecycleLines(audit).some((line) => heldLine.test(line)), `${why}: ${JSON.stringify(audit.details)}`);
    // Nothing left to remediate: a held key cannot be fixed, so the finding must not claim it can.
    assert.equal(audit.fixable, false, `${why}: a held-only finding is not fixable`);
    const before = readFileSync(registryPath, "utf8");
    // The migration changes nothing; the engine's postcondition audit then says the held key is still unresolved.
    const held = remediate().json.results.find((rule) => rule.id === "hermes.registry-parity");
    assert.equal(held.status, "partial", why);
    assert.deepEqual(held.changedFiles, [], why);
    assert.equal(readFileSync(registryPath, "utf8"), before, `${why}: a held identity is never rewritten`);
    assert.equal(specIdentity().handle, "spec", `${why}: the identity survives`);
  };
  renameSync(specAgent, `${specAgent}.moved`);
  checkHeld("definition moved away");
  symlinkSync(join(work, "nowhere", "agent.yaml"), specAgent);
  checkHeld("dangling definition link");
  // Real drift beside a held key stays fixable, and fixing it still leaves the held key alone.
  writeFileSync(registryPath, `${readFileSync(registryPath, "utf8")}    gateway_consumer: hermes-spec\n`);
  audit = parity();
  assert.equal(audit.fixable, true, "a fixable drift next to a held key keeps the finding fixable");
  remediate();
  assert.equal("gateway_consumer" in registry().agents.spec, false);
  assert.equal(specIdentity().handle, "spec");
  checkHeld("after the beside-drift was fixed");
  rmSync(specAgent);
  renameSync(`${specAgent}.moved`, specAgent);
  assert.equal(parity().status, "pass");
  // A row that names NO definition, and a definition that exists and enrolls nobody, still drop a stale identity.
  writeFileSync(registryPath, `${readFileSync(registryPath, "utf8")}  orphan:
    employment: portable-specialist
    profile_name: orphan
    type: hermes
    company_identity:
      subject: ${GROLF}
      handle: ghost
      email: ghost@agents.delo.sh
      status: active
`);
  audit = parity();
  assert.ok(lifecycleLines(audit).some((line) => /company_identity for orphan is .* but the row's definition is not enrolled/u.test(line)), JSON.stringify(audit.details));
  remediate();
  assert.equal("company_identity" in registry().agents.orphan, false, "a row with no definition reference drops it");
  assert.equal(parity().status, "pass");

  // 9. format preservation: a comment and a quoted ISO timestamp elsewhere in the file survive a real write.
  const marked = readFileSync(registryPath, "utf8")
    .replace("schema_version: 1\n", "# keep this comment\nschema_version: 1\n")
    .replace("    profile_name: plain-director\n", '    profile_name: plain-director\n    seen_at: "2026-10-13T09:14:09.584Z" # keep this too\n')
    + "    gateway_consumer: hermes-orphan\n";
  writeFileSync(registryPath, marked);
  assert.ok(lifecycleLines(parity()).some((line) => /gateway_consumer for orphan/u.test(line)));
  assert.equal(remediate().json.results.find((rule) => rule.id === "hermes.registry-parity").status, "applied");
  const kept = readFileSync(registryPath, "utf8");
  assert.ok(kept.startsWith("# keep this comment\nschema_version: 1\n"), "the leading comment survives");
  assert.ok(kept.includes('    seen_at: "2026-10-13T09:14:09.584Z" # keep this too\n'), "the quoted timestamp and its comment survive");
  assert.equal(kept, marked.replace("    gateway_consumer: hermes-orphan\n", ""), "only the drifted key changed, byte-for-byte");

  // 9. compare-and-swap: the registry changes while the run waits for the fleet lock, so nothing is written.
  const lockPath = `${registryPath}.lock`;
  const racedBase = readFileSync(registryPath, "utf8");
  writeFileSync(registryPath, `${racedBase}    gateway_consumer: hermes-orphan\n`);
  const holder = spawn("python3", ["-c", `import fcntl,sys\nf=open(${JSON.stringify(lockPath)},"a")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\nsys.stdin.read()`], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((done, fail) => { holder.stdout.once("data", done); holder.once("error", fail); });
  const racing = spawn("node", [cli, "remediate", "hermes.registry-parity", repo, "--json"], { cwd: repo, env: { ...env, HOME: home, XDG_CACHE_HOME: join(home, ".cache") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  racing.stdout.on("data", (chunk) => { out += chunk; });
  racing.stderr.on("data", (chunk) => { out += chunk; });
  const exited = new Promise((done) => racing.once("close", done));
  // Release only once the run is queued on the lock (a waiter shows up in /proc/locks), i.e. after it read the file.
  const inode = statSync(lockPath).ino;
  for (let waited = 0; waited < 200; waited += 1) {
    let locks = "";
    try { locks = readFileSync("/proc/locks", "utf8"); } catch { await new Promise((done) => setTimeout(done, 3000)); break; }
    if (locks.split("\n").some((line) => line.includes("->") && line.endsWith(`:${inode} 0 EOF`) || (line.includes("->") && line.includes(`:${inode} `)))) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const intruder = `${readFileSync(registryPath, "utf8")}# another writer was here\n`;
  writeFileSync(registryPath, intruder);
  holder.stdin.end();
  await exited;
  const raced = JSON.parse(out.slice(out.indexOf("{"))).results.find((rule) => rule.id === "hermes.registry-parity");
  assert.equal(raced.status, "blocked", out);
  assert.match(raced.summary, /changed while it was being repaired/u);
  assert.equal(readFileSync(registryPath, "utf8"), intruder, "the stale copy never overwrites what the other writer wrote");
  assert.equal(remediate().json.results.find((rule) => rule.id === "hermes.registry-parity").status, "applied", "re-running after the race converges");
  assert.equal("gateway_consumer" in registry().agents.orphan, false);
  assert.ok(readFileSync(registryPath, "utf8").includes("# another writer was here"));

  console.log("registry lifecycle projection regressions: all assertions passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
