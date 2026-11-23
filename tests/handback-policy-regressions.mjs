import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import YAML from "yaml";
import { createSet, addSetSkills } from "@delorenj/skillex";
import { canonicalPolicy, policySection, START, END } from "../scripts/lib/handback-policy.mjs";
import { canonicalPolicy as schedulingPolicy, policySection as schedulingSection, START as SCHEDULE_START, END as SCHEDULE_END } from "../scripts/lib/scheduling-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "flume-handback-"));
const cache = join(root, "node_modules/.cache", `flume-handback-${process.pid}`);
const policy = canonicalPolicy(root), schedule = schedulingPolicy(root);
const digest = text => createHash("sha256").update(text).digest("hex");
const evidence = { policy_sha256: digest(policy), consumers: [], commands: [], scenarios: [], checks: [] };
const outputs = new Map();
const check = async (name, fn) => { await fn(); evidence.checks.push(name); console.log(`PASS ${name}`); };
const snapshot = path => {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { link: readlinkSync(path) };
  if (stat.isDirectory()) return Object.fromEntries(readdirSync(path).sort().filter(name => !name.endsWith(".lock")).map(name => [name, snapshot(join(path, name))]));
  return { bytes: readFileSync(path).toString("base64"), mtime: stat.mtimeMs };
};
const run = (label, command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: work, encoding: "utf8", timeout: 40000, ...options });
  evidence.commands.push({ label, command, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  assert.equal(result.status, 0, `${label}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result;
};
const assertPolicies = text => { assert.equal(policySection(text), policy); assert.equal(schedulingSection(text), schedule); };
try {
  mkdirSync(cache, { recursive: true });
  const entry = join(work, "entry.ts"), bundle = join(cache, "consumer.mjs");
  writeFileSync(entry, `export { composeSoul, RetiredRoleError } from ${JSON.stringify(join(root, "packages/flume-hr/src/parity/rules.ts"))};\nexport { specialistPolicyRequest } from ${JSON.stringify(join(root, "packages/flume-hr/src/workforce/scheduling.ts"))};\n`);
  buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "silent", nodePaths: [join(root, "node_modules")] });
  const { composeSoul, RetiredRoleError, specialistPolicyRequest } = await import(pathToFileURL(bundle).href);
  const declarations = readdirSync(join(root, "roles")).filter(name => name.endsWith(".md") && !name.startsWith("_") && name !== "README.md").sort().map(name => {
    const raw = readFileSync(join(root, "roles", name), "utf8");
    return { role: name.slice(0, -3), front: YAML.parse(raw.split(/^---$/mu)[1]) };
  });
  const active = declarations.filter(({ front }) => front.retired == null).map(({ role }) => role);
  const retired = declarations.filter(({ front }) => front.retired != null).map(({ role }) => role);
  const identity = (role, named) => ({ agentId: `fixture-${role}`, role, repo: "fixture-repo", displayName: "Fixture Employee", profileName: `fixture-${role}`, purpose: "Preserve declared purpose", botHandle: "", soulTone: "direct", ...(named ? { named: { name: "alice", writeBank: "agent-alice", recallBanks: ["agent-alice"] } } : {}) });
  await check("all active roles and fallback receive one canonical section for named and unnamed posts", () => {
    assert.ok(active.includes("pm") && active.includes("director") && active.includes("dev") && active.includes("review"));
    assert.ok(retired.length, "retired refusal must have real inputs");
    for (const role of [...active, "unconfigured-future-role"]) for (const named of [false, true]) {
      const composed = composeSoul(root, identity(role, named));
      const key = `${role}-${named ? "named" : "unnamed"}`;
      assertPolicies(composed.text);
      assert.equal(composeSoul(root, identity(role, named), composed.text).text, composed.text);
      assert.match(composed.text, /Preserve declared purpose/);
      assert.ok(composed.text.indexOf(START) < composed.text.indexOf("## Role-specific behavior"));
      assert.equal(composed.source, join(root, "roles", role === "unconfigured-future-role" ? "_default.md" : `${role}.md`));
      if (named) assert.match(composed.text, /agent-alice/);
      outputs.set(key, composed.text);
      evidence.consumers.push({ key, role, named, source: composed.source, soul_sha256: digest(composed.text) });
    }
    console.log(`roles: active=${active.join(",")} fallback=unconfigured-future-role retired=${retired.join(",")}`);
  });
  await check("retired role composition refuses for named and unnamed employees", () => {
    for (const role of retired) for (const named of [false, true]) assert.throws(() => composeSoul(root, identity(role, named)), RetiredRoleError);
  });
  await check("bounded extraction refuses absent, duplicate, reversed and empty canonical sections", () => {
    for (const text of ["", START, END, `${policy}\n${policy}`, `${END}\n${START}`]) assert.throws(() => policySection(text), /exactly one|reversed/);
    const fake = join(work, "bad-policy"); mkdirSync(join(fake, "roles"), { recursive: true });
    writeFileSync(join(fake, "roles/_base.md"), `${START}\n\n${END}`);
    assert.throws(() => canonicalPolicy(fake), /empty/);
    writeFileSync(join(fake, "roles/_base.md"), `${policy}\n${START}`);
    assert.throws(() => canonicalPolicy(fake), /exactly one/);
    writeFileSync(join(fake, "roles/_base.md"), schedule);
    assert.throws(() => specialistPolicyRequest({ charter: { purpose: "Original" } }, fake), /exactly one handback-policy/);
  });
  const definition = { schema_version: 1, id: "alice", display_name: "Alice", role: "infra-specialist", charter: { purpose: "Keep authored purpose", directives: ["Keep authored directive"], tone: "candid" }, memory: { write_bank: "agent-alice" }, skills: { set: "fixture-set" } };
  await check("portable request preserves its source and refuses authored markers anywhere in charter", () => {
    const before = structuredClone(definition);
    const request = specialistPolicyRequest(definition, root);
    assertPolicies(request.charter.purpose);
    assert.deepEqual(definition, before);
    assert.equal(request.charter.tone, definition.charter.tone);
    assert.deepEqual(request.charter.directives, definition.charter.directives);
    for (const marker of [START, END, SCHEDULE_START, SCHEDULE_END]) for (const field of ["purpose", "directives", "tone"]) {
      const charter = { ...definition.charter, [field]: field === "directives" ? [marker] : marker };
      assert.throws(() => specialistPolicyRequest({ ...definition, charter }, root), /must not author/);
    }
  });
  await check("real Python specialist preview, projection and repeat converge without changing authored persona", () => {
    const fleet = join(work, "adapter-fleet"); mkdirSync(fleet);
    writeFileSync(join(fleet, "config.yaml"), YAML.stringify({ model: { default: "automaticai/personal/sol" } }));
    const request = { ...specialistPolicyRequest(definition, root), definition: join(work, "desk/agent.yaml") };
    const env = { ...process.env, HERMES_FLEET_HOME: fleet, HERMES_TEMPLATE_CONFIG: join(work, "absent-config"), VOX_PLUGIN_DIR: join(work, "absent-vox"), PYTHONDONTWRITEBYTECODE: "1" };
    const adapter = join(root, "templates/hermes-agent/scripts/hermes-specialist-profile.py");
    const before = snapshot(fleet);
    const preview = run("adapter preview", "python3", [adapter, "--check"], { input: JSON.stringify(request), env });
    assert.ok(JSON.parse(preview.stdout).changed.includes("SOUL.md")); assert.deepEqual(snapshot(fleet), before);
    run("adapter apply", "python3", [adapter], { input: JSON.stringify(request), env });
    const text = readFileSync(join(fleet, "profiles/alice/SOUL.md"), "utf8");
    assertPolicies(text); assert.match(text, /Keep authored purpose[\s\S]*Keep authored directive[\s\S]*Tone: candid/);
    outputs.set("portable-adapter", text);
    const after = snapshot(fleet);
    const repeated = run("adapter repeat", "python3", [adapter], { input: JSON.stringify(request), env });
    assert.deepEqual(JSON.parse(repeated.stdout).changed, []); assert.deepEqual(snapshot(fleet), after);
  });
  await check("built public hire and onboard refresh an old owned projection, preserve source and converge", async () => {
    const home = join(work, "public-home"), fleet = join(home, ".hermes"), catalog = join(home, "code/skillex"), skill = join(catalog, "all-skills/handback-fixture");
    mkdirSync(skill, { recursive: true }); mkdirSync(fleet, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: handback-fixture\ndescription: Private handback regression fixture.\n---\n");
    const options = { home, registryRoot: catalog, stateHome: join(home, ".local/state") };
    assert.ok((await createSet("fixture-set", options)).ok); assert.ok((await addSetSkills("fixture-set", ["handback-fixture"], options)).ok);
    writeFileSync(join(fleet, "config.yaml"), YAML.stringify({ model: { default: "automaticai/personal/sol" } }));
    writeFileSync(join(fleet, "agents-registry.yaml"), "agents: {}\n");
    const source = join(work, "public-agent.yaml"), sourceBytes = YAML.stringify(definition); writeFileSync(source, sourceBytes);
    const bin = join(work, "public-bin"), calls = join(work, "fixture-credential-calls"); mkdirSync(bin);
    const gateway = join(bin, "gateway-tokens.py");
    writeFileSync(gateway, `import sys\nfrom pathlib import Path\nassert sys.argv[1:] == ["mint", "hermes-alice", "--preset", "owner-no-anthropic", "--group", "aai-personal", "--days", "-1"]\nwith Path(${JSON.stringify(calls)}).open("a") as log: log.write("mint\\n")\nprint("existing token; op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/hermes-alice")\n`);
    writeFileSync(join(bin, "op"), `#!${process.execPath}\nconst fs = require("node:fs");\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["read", "op://DeLoSecrets/yeurk5dpqkaarspvsn3cjtmkki/hermes-alice"])) process.exit(1);\nfs.appendFileSync(${JSON.stringify(calls)}, "read\\n"); console.log("fixture-member-value-long-enough-for-readback");\n`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLUME_GATEWAY_TOKENS_BIN: gateway, HOME: home, HERMES_FLEET_HOME: fleet, HERMES_AGENTS_REGISTRY: join(fleet, "agents-registry.yaml"), HERMES_FLEET_REGISTRY_FILE: join(fleet, "agents-registry.yaml"), HERMES_TEMPLATE_CONFIG: join(work, "no-template"), HERMES_FLEET_ENV: join(work, "no-env"), PJ_SKILLS_REGISTRY_ROOT: catalog, XDG_STATE_HOME: options.stateHome, PYTHONDONTWRITEBYTECODE: "1", VOX_PLUGIN_DIR: join(work, "no-vox") };
    const cli = (label, args) => JSON.parse(run(label, process.execPath, [join(root, "packages/flume-hr/dist/index.js"), ...args, "--json"], { env }).stdout);
    const before = snapshot(home); cli("public hire preview", ["hire", "--definition", source, "--dry-run"]); assert.deepEqual(snapshot(home), before); assert.equal(existsSync(calls), false);
    cli("public hire", ["hire", "--definition", source]);
    const profile = join(fleet, "profiles/alice"), soul = join(profile, "SOUL.md"), receipt = join(profile, "specialist-projection.json");
    const text = readFileSync(soul, "utf8"); assertPolicies(text); outputs.set("portable-public", text);
    assert.match(text, /Keep authored purpose[\s\S]*Keep authored directive[\s\S]*Tone: candid/);
    assert.equal(readFileSync(source, "utf8"), sourceBytes); assert.equal(readFileSync(join(home, ".agents/workforce/alice/agent.yaml"), "utf8"), sourceBytes);
    const configBefore = readFileSync(join(profile, "config.yaml"), "utf8");
    // Model an old generated projection using its existing ownership receipt, not a foreign edit.
    const historical = text.replace(`${policy}\n\n`, ""); assert.equal(historical.includes(START), false);
    const old = JSON.parse(readFileSync(receipt, "utf8")); old.files["SOUL.md"] = digest(historical);
    writeFileSync(soul, historical); writeFileSync(receipt, JSON.stringify(old, null, 2) + "\n");
    const legacy = snapshot(home);
    cli("public onboard preview", ["onboard", "--employee", "alice", "--dry-run"]); assert.deepEqual(snapshot(home), legacy);
    cli("public onboard refresh", ["onboard", "--employee", "alice"]); assert.equal(readFileSync(soul, "utf8"), text); assert.equal(readFileSync(join(profile, "config.yaml"), "utf8"), configBefore);
    const converged = snapshot(home);
    assert.equal(cli("public onboard repeat", ["onboard", "--employee", "alice"]).changed, false); assert.deepEqual(snapshot(home), converged);
    assert.equal(readFileSync(source, "utf8"), sourceBytes); assert.equal(readFileSync(join(home, ".agents/workforce/alice/agent.yaml"), "utf8"), sourceBytes);
    assert.equal(readFileSync(calls, "utf8"), "mint\nread\nmint\nread\nmint\nread\n", "only private credential stubs were used");
    writeFileSync(soul, `${text}\nEmployee-authored note: preserve me.\n`);
    const handwritten = snapshot(home);
    const refused = spawnSync(process.execPath, [join(root, "packages/flume-hr/dist/index.js"), "onboard", "--employee", "alice", "--json"], { env, cwd: work, encoding: "utf8", timeout: 40000 });
    assert.notEqual(refused.status, 0); assert.match(refused.stdout + refused.stderr, /ownership conflict: SOUL.md/); assert.deepEqual(snapshot(home), handwritten);
    evidence.commands.push({ label: "public handwritten refusal", status: refused.status, stdout: refused.stdout, stderr: refused.stderr });
  });
  await check("generated consumers cover clean, dirty, blocked, headless and restricted handback scenarios", () => {
    const scenarios = [
      ["clean", [/clean verified completion/i, /run the required checks/, /actual results/, /verify those owned paths are clean/]],
      ["dirty-owned", [/if owned work is dirty, unfinished, blocked or not fully\n  verified, do not claim completion/, /durable checkpoint/i]],
      ["dirty-unrelated", [/cleanliness means owned paths only/, /never claim\n  the whole checkout is clean/, /Unrelated dirty paths may remain/, /leave them untouched/]],
      ["blocked", [/what changed/, /what remains/, /blocker and responsible owner/, /executable next step/, /working\n  location and prerequisites/, /not only transient chat/]],
      ["headless", [/interactive, delegated and headless\n sessions|interactive, delegated and headless\nsessions/, /no terminal or person watching is required/]],
      ["local-only", [/Explicit local-only, no-publication and no-commit instructions remain binding/, /Local-only work\n  stays local/]],
      ["no-publication", [/a commit or checkpoint is not permission to publish/, /no-publication means no push, upload, PR or deployment/, /including over general role or artifact-sharing instructions/]],
      ["no-commit", [/With no-commit,\n  use a permitted durable local note or handback record instead of committing/, /If no\n  durable write is allowed/, /do not create an unauthorized file or commit/]],
      ["foreign-work", [/NEVER authorizes stashing, resetting, checking\n  out, committing or discarding another agent's changes/, /Do not use repository-wide\n  cleanup or broad staging/, /only explicitly owned paths/, /if ownership\n  overlaps or is uncertain, preserve the work and checkpoint for its owner/]],
      ["authority", [/Keep required review, role boundaries, live-change and restart restrictions/, /never widen authority or start a new clock/]],
    ];
    for (const [scenario, clauses] of scenarios) {
      for (const [consumer, text] of outputs) for (const clause of clauses) assert.match(policySection(text), clause, `${scenario}: ${consumer}: ${clause}`);
      evidence.scenarios.push({ scenario, consumers: outputs.size, kind: "generated instruction contract; not agent behavior enforcement" });
    }
    const base = readFileSync(join(root, "roles/_base.md"), "utf8");
    assert.match(base, /When publication is authorized/); assert.doesNotMatch(base, /Publish every file\s+you produce/);
  });
  await check("isolated Git states distinguish owned cleanliness; no-commit note preserves all work", () => {
    const repo = join(work, "checkout"); mkdirSync(repo);
    const git = (...args) => run(`fixture git ${args.join(" ")}`, "git", args, { cwd: repo }).stdout;
    git("init", "-q"); git("config", "user.name", "Handback Fixture"); git("config", "user.email", "fixture@example.test"); git("config", "core.hooksPath", join(work, "no-hooks"));
    writeFileSync(join(repo, "owned.txt"), "owned baseline\n"); writeFileSync(join(repo, "foreign.txt"), "foreign baseline\n");
    git("add", "--", "owned.txt", "foreign.txt"); git("commit", "--only", "-m", "fixture baseline", "--", "owned.txt", "foreign.txt");
    assert.equal(git("status", "--porcelain", "--", "owned.txt"), "");
    writeFileSync(join(repo, "foreign.txt"), "another employee's unfinished work\n");
    assert.equal(git("status", "--porcelain", "--", "owned.txt"), ""); assert.notEqual(git("status", "--porcelain"), "");
    writeFileSync(join(repo, "owned.txt"), "unfinished owned work\n"); assert.notEqual(git("status", "--porcelain", "--", "owned.txt"), "");
    const before = { owned: readFileSync(join(repo, "owned.txt"), "utf8"), foreign: readFileSync(join(repo, "foreign.txt"), "utf8"), head: git("rev-parse", "HEAD") };
    const checkpoint = join(work, "no-commit-handback.md");
    writeFileSync(checkpoint, `Changed: ${repo}/owned.txt; unfinished owned work.\nRemains: run verification and complete owned work.\nChecks: owned status dirty; no completion claim.\nBlocker: no-commit instruction; owner: task coordinator.\nNext: from ${repo}, run git diff -- owned.txt; request the coordinator's permitted completion path before any commit.\nRestrictions: local-only, no-publication, no-commit.\n`);
    assert.deepEqual({ owned: readFileSync(join(repo, "owned.txt"), "utf8"), foreign: readFileSync(join(repo, "foreign.txt"), "utf8"), head: git("rev-parse", "HEAD") }, before);
    assert.match(readFileSync(checkpoint, "utf8"), /Changed:[\s\S]*Remains:[\s\S]*Checks:[\s\S]*Blocker:[\s\S]*owner:[\s\S]*Next:/);
  });
  console.log(`handback-policy: ${evidence.checks.length} groups passed; ${active.length} active roles + fallback x named/unnamed; ${retired.length} retired refusals; ${outputs.size} generated consumers; ${evidence.scenarios.length} contract scenarios`);
  if (process.env.FLUME_HANDBACK_EVIDENCE_DIR) {
    const destination = resolve(process.env.FLUME_HANDBACK_EVIDENCE_DIR); mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    for (const [name, text] of outputs) writeFileSync(join(destination, `${name}.SOUL.md`), text);
  }
} finally {
  rmSync(work, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true });
}
