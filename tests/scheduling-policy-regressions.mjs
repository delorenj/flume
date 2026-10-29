import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import YAML from "yaml";
import { createSet, addSetSkills } from "@delorenj/skillex";
import { auditSchedulingPolicy, canonicalPolicy, policySection, START, END } from "../scripts/audit-scheduling-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "flume-scheduling-policy-"));
const cache = join(root, "node_modules/.cache", `flume-scheduling-policy-${process.pid}`);
const policy = canonicalPolicy(root);
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
try {
  mkdirSync(cache, { recursive: true });
  const entry = join(work, "entry.ts"), bundle = join(cache, "composer.mjs");
  writeFileSync(entry, `export { composeSoul } from ${JSON.stringify(join(root, "packages/flume-hr/src/parity/rules.ts"))};\nexport { specialistSchedulingRequest } from ${JSON.stringify(join(root, "packages/flume-hr/src/workforce/scheduling.ts"))};\n`);
  buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "silent",
    nodePaths: [join(root, "node_modules"), join(root, "packages/flume-hr/node_modules")] });
  const { composeSoul, specialistSchedulingRequest } = await import(pathToFileURL(bundle).href);
  const declared = readdirSync(join(root, "roles")).filter(name => name.endsWith(".md") && !name.startsWith("_") && name !== "README.md").map(name => name.slice(0, -3));
  const roles = [...declared, "director", "infra-specialist", "unconfigured-future-role"];
  for (const role of roles) {
    check(`composer propagates byte-identical policy to ${role} (named and unnamed)`, () => {
      for (const named of [undefined, { name: "alice", writeBank: "agent-alice", recallBanks: ["agent-alice"] }]) {
        const identity = { agentId: `demo-${role}`, role, repo: "demo", displayName: "Demo", profileName: `demo-${role}`, purpose: "Keep my purpose", botHandle: "", soulTone: "direct", ...(named ? { named } : {}) };
        const a = composeSoul(root, identity).text, b = composeSoul(root, identity, a).text;
        assert.equal(policySection(a), policy);
        assert.equal(a, b, "composition must be idempotent");
        assert.match(a, /Keep my purpose/);
        assert.ok(a.indexOf(START) < a.indexOf("## Role-specific behavior"), "policy cannot be PM-role owned");
      }
    });
  }
  check("portable specialist adapter projects shared policy without changing the owning definition", () => {
    const fleet = join(work, "specialist-fleet"); mkdirSync(fleet);
    writeFileSync(join(fleet, "config.yaml"), YAML.stringify({ model: { default: "automaticai/personal/sol" } }));
    const definition = { schema_version: 1, id: "alice", display_name: "Alice", role: "infra-specialist", charter: { purpose: "Keep original purpose", directives: ["Keep my directive"], tone: "candid" }, memory: { write_bank: "agent-alice" }, skills: { set: "unused-adapter-fixture" } };
    const before = structuredClone(definition);
    const request = { ...specialistSchedulingRequest(definition, root), definition: join(work, "desk/agent.yaml") };
    const profile = join(fleet, "profiles/alice/SOUL.md");
    const run = checkOnly => spawnSync("python3", [join(root, "templates/hermes-agent/scripts/hermes-specialist-profile.py"), ...(checkOnly ? ["--check"] : [])], { input: JSON.stringify(request), encoding: "utf8", timeout: 10000, env: { ...process.env, HERMES_FLEET_HOME: fleet, HERMES_TEMPLATE_CONFIG: join(work, "absent-config"), VOX_PLUGIN_DIR: join(work, "absent-plugin"), PYTHONDONTWRITEBYTECODE: "1" } });
    const preview = run(true); assert.equal(preview.status, 0, preview.stderr);
    assert.ok(JSON.parse(preview.stdout).changed.includes("SOUL.md"));
    const applied = run(false); assert.equal(applied.status, 0, applied.stderr);
    assert.equal(policySection(readFileSync(profile, "utf8")), policy);
    assert.match(readFileSync(profile, "utf8"), /Keep original purpose[\s\S]*Keep my directive[\s\S]*Tone: candid/);
    assert.deepEqual(definition, before);
    const repeated = run(false); assert.equal(repeated.status, 0, repeated.stderr); assert.deepEqual(JSON.parse(repeated.stdout).changed, []);
    assert.throws(() => specialistSchedulingRequest({ ...definition, charter: { purpose: START } }, root), /must not author/);
  });
  check("policy includes ownership, every bypass class, proof and bounded exceptions", () => {
    for (const term of ["Candybar owns when", "Hermes and services own execution", "systemd timers", "cron entries", "Hermes recurring", "n8n Schedule Triggers", "sleep/poll loops", "API", "terminal invocation", "native clock is disabled", "not a Candybar", "AD-22", "not crank-watchdog", "exact schedule, responsible owner, scope, and explicit rationale"]) {
      assert.ok(policy.includes(term), `missing ${term}`);
    }
    assert.match(policy, /never register it as a\nCandybar|never register it as a\n  Candybar/);
  });
  const fleetHome = join(work, "fleet"), registry = join(work, "agents-registry.yaml");
  const rows = {};
  function employee(id, soul, extra = {}) {
    rows[id] = { role: "dev", profile_name: id, ...extra };
    if (soul !== null) { const path = join(fleetHome, "profiles", id, "SOUL.md"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, soul); }
  }
  employee("current", `# Preserve authored persona\n\n${policy}\n\n## Local notes\nDo not overwrite me.\n`);
  employee("missing", null);
  employee("legacy", "# Legacy persona\n");
  employee("stale", policy.replace("Candybar owns when", "Other scheduler owns when"));
  employee("duplicate", `${policy}\n${policy}`);
  employee("portable", "# Named specialist\n", { employment: "portable-specialist", role: "infra-specialist" });
  employee("invalid", null); rows.invalid.profile_name = "../escape";
  employee("linked", null);
  const linked = join(fleetHome, "profiles/linked/SOUL.md"), actual = join(work, "runtime-SOUL.md");
  mkdirSync(dirname(linked), { recursive: true }); writeFileSync(actual, policy); symlinkSync(actual, linked);
  const save = () => writeFileSync(registry, YAML.stringify({ agents: rows })); save();
  const snapshot = () => Object.fromEntries([registry, actual, ...Object.entries(rows).filter(([id]) => !["missing", "invalid", "linked"].includes(id)).map(([id]) => join(fleetHome, "profiles", id, "SOUL.md"))].map(path => [path, { bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs }]));
  const before = snapshot();
  check("registry guard counts real profile policy, stale, absent, duplicate, missing, portable and symlink cases", () => {
    const report = auditSchedulingPolicy({ registry, fleetHome });
    assert.equal(report.ok, false); assert.equal(report.audited, 8);
    assert.deepEqual(report.counts, { pass: 2, drift: 4, unproven: 2 });
    assert.match(report.rows.find(row => row.id === "portable").detail, /owning Flume onboarding refresh/);
    assert.equal(report.runtime_schedules_assessed, false);
    assert.deepEqual(snapshot(), before, "read-only guard must preserve bytes and mtimes");
  });
  const cli = args => spawnSync(process.execPath, [join(root, "scripts/audit-scheduling-policy.mjs"), "--registry", registry, "--fleet-home", fleetHome, ...args], { encoding: "utf8", timeout: 5000 });
  check("CLI exits 1 on drift and zero only on a complete current registry", () => {
    const failed = cli([]); assert.equal(failed.status, 1, failed.stderr); assert.equal(JSON.parse(failed.stdout).ok, false); assert.deepEqual(snapshot(), before);
    writeFileSync(registry, YAML.stringify({ agents: { current: rows.current, linked: rows.linked } }));
    const passed = cli([]); assert.equal(passed.status, 0, passed.stderr); assert.equal(JSON.parse(passed.stdout).audited, 2);
  });
  check("malformed/empty registry, duplicate YAML keys and invented flags fail closed", () => {
    for (const text of ["agents: {}\n", "agents: []\n", "agents: {x: {profile_name: x}, x: {profile_name: y}}\n", "[unterminated"]) {
      writeFileSync(registry, text); const run = cli([]); assert.equal(run.status, 2); assert.equal(JSON.parse(run.stdout).ok, false);
    }
    save(); const restored = snapshot(); assert.equal(cli(["--apply"]).status, 2); assert.deepEqual(snapshot(), restored);
    assert.throws(() => policySection(`${END}\n${START}`), /reversed/);
    assert.throws(() => policySection(""), /exactly one/);
  });
  {
    const home = join(work, "public-home"), fleet = join(home, ".hermes"), catalog = join(home, "code/skillex"), skill = join(catalog, "all-skills/policy-fixture");
    mkdirSync(skill, { recursive: true }); mkdirSync(fleet, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: policy-fixture\ndescription: Disposable fixture for scheduling propagation.\n---\n");
    const options = { home, registryRoot: catalog, stateHome: join(home, ".local/state") };
    assert.ok((await createSet("fixture-set", options)).ok);
    assert.ok((await addSetSkills("fixture-set", ["policy-fixture"], options)).ok);
    writeFileSync(join(fleet, "config.yaml"), YAML.stringify({ model: { default: "automaticai/personal/sol" } }));
    writeFileSync(join(fleet, "agents-registry.yaml"), "agents: {}\n");
    const definition = { schema_version: 1, id: "public-specialist", display_name: "Public Specialist", role: "token-ops-engineer", charter: { purpose: "Preserve public charter", directives: ["Preserve persona"] }, skills: { set: "fixture-set" }, memory: { write_bank: "agent-public-specialist" } };
    const source = join(work, "public-agent.yaml"); writeFileSync(source, YAML.stringify(definition));
    const env = { ...process.env, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: join(fleet, "agents-registry.yaml"), HERMES_FLEET_REGISTRY_FILE: join(fleet, "agents-registry.yaml"), HERMES_TEMPLATE_CONFIG: join(work, "no-template"), HERMES_FLEET_ENV: join(work, "no-env"), PJ_SKILLS_REGISTRY_ROOT: catalog, XDG_STATE_HOME: options.stateHome, PYTHONDONTWRITEBYTECODE: "1", VOX_PLUGIN_DIR: join(work, "no-vox") };
    const cli = args => spawnSync(process.execPath, [join(root, "packages/flume-hr/dist/index.js"), ...args, "--json"], { env, cwd: work, encoding: "utf8", timeout: 40000 });
    check("built public hire/onboard path propagates to a portable specialist and converges", () => {
      const hired = cli(["hire", "--definition", source]); assert.equal(hired.status, 0, hired.stdout + hired.stderr);
      const text = readFileSync(join(fleet, "profiles/public-specialist/SOUL.md"), "utf8");
      assert.equal(policySection(text), policy);
      assert.match(text, /Preserve public charter[\s\S]*Preserve persona/);
      assert.deepEqual(YAML.parse(readFileSync(join(home, ".agents/workforce/public-specialist/agent.yaml"), "utf8")), definition);
      const portableProfile = join(fleet, "profiles/public-specialist");
      const soulPath = join(portableProfile, "SOUL.md"), receiptPath = join(portableProfile, "specialist-projection.json");
      const stalePolicy = policy.replace("Candybar owns when", "Historical policy owns when");
      const historical = text.replace(policy, stalePolicy);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.files["SOUL.md"] = createHash("sha256").update(historical).digest("hex");
      writeFileSync(soulPath, historical); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
      const configBefore = readFileSync(join(portableProfile, "config.yaml"), "utf8");
      const narrowPreview = cli(["refresh-scheduling-policy"]); assert.equal(narrowPreview.status, 0, narrowPreview.stdout + narrowPreview.stderr);
      assert.equal(JSON.parse(narrowPreview.stdout).counts["would-change"], 1); assert.equal(readFileSync(soulPath, "utf8"), historical);
      const narrow = cli(["refresh-scheduling-policy", "--apply"]); assert.equal(narrow.status, 0, narrow.stdout + narrow.stderr);
      assert.equal(JSON.parse(narrow.stdout).counts.changed, 1); assert.equal(readFileSync(soulPath, "utf8"), text);
      assert.equal(readFileSync(join(portableProfile, "config.yaml"), "utf8"), configBefore);
      const repeatedNarrow = cli(["refresh-scheduling-policy", "--apply"]); assert.equal(repeatedNarrow.status, 0); assert.equal(JSON.parse(repeatedNarrow.stdout).changed_file_count, 0);
      const again = cli(["onboard", "--employee", "public-specialist"]); assert.equal(again.status, 0, again.stdout + again.stderr); assert.equal(JSON.parse(again.stdout).changed, false);
    });
  }
  console.log(`scheduling-policy: ${checks} check groups passed; ${roles.length} roles x named/unnamed rendered`);
} finally { rmSync(work, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); }
