import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync, lstatSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { canonicalPolicy, policySection } from "../scripts/lib/scheduling-policy.mjs";

const root = resolve(import.meta.dirname, ".."), work = mkdtempSync(join(tmpdir(), "flume-policy-refresh-"));
const fleet = join(work, "fleet"), registry = join(fleet, "agents-registry.yaml"), policy = canonicalPolicy(root);
const rows = {}, files = [];
const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); files.push(path); };
const legacy = (role = "pm") => `# Persona\n\n<!-- Composed by flume from roles/${role}.md. Edit the ROLE, not this file:\n     Keep this whole comment. -->\n\n## Tone\nCranky and candid.\n\n## Role-specific behavior\nDo NOT erase my bespoke directives.\nUnicode: héllø 🦖\n`;
const save = () => put(registry, YAML.stringify({ agents: rows }));
const cli = apply => spawnSync(process.execPath, [join(root, "packages/flume-hr/dist/index.js"), "refresh-scheduling-policy", "--registry", registry, "--fleet-home", fleet, "--json", ...(apply ? ["--apply"] : [])], { encoding: "utf8", timeout: 15000, env: { ...process.env, HERMES_FLEET_ENV: join(work, "no-env") } });
function employee(id, text = legacy(), role = "pm") {
  const project = join(work, id), roleDir = join(project, "agents/hermes", role), profile = join(fleet, "profiles", id);
  rows[id] = { profile_name: id, repo: id, role, project_path: project, role_dir: roleDir };
  put(join(roleDir, "role.yaml"), YAML.stringify({ agent_id: id, profile: id, role, repo: id }));
  const identityText = bytes => {
    if (!bytes.includes("Composed by flume from roles/")) return bytes;
    return bytes.replace("## Tone", `| Agent ID | \`${id}\` |\n| Profile | \`${id}\` |\n| Repo | \`${id}\` |\n| Role | \`${role}\` |\n\n## Tone`);
  };
  for (const name of ["SOUL.md", "runtime/SOUL.md"]) put(join(roleDir, name), identityText(text));
  put(join(roleDir, "hermes"), "WRAPPER DO NOT TOUCH\n"); put(join(profile, "config.yaml"), "CONFIG DO NOT TOUCH\n");
  symlinkSync(join(roleDir, "runtime/SOUL.md"), join(profile, "SOUL.md"));
  return { roleDir, profile };
}
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
try {
  const ordinary = employee("ordinary"), local = employee("local"), stale = employee("stale", legacy().replace("## Role-specific behavior", policy.replace("Candybar owns when", "Old clock owns when") + "\n\n## Role-specific behavior"));
  employee("handwritten", "# My authored persona\nOnly my role owner may edit me.\n");
  employee("placeholder", "<!-- FLUME SOUL PLACEHOLDER -- not the agent's soul. -->\n");
  employee("duplicate", legacy().replace("## Role-specific behavior", policy + "\n" + policy + "\n## Role-specific behavior"));
  employee("halfmarker", legacy().replace("## Role-specific behavior", "<!-- flume:scheduling-policy:start -->\n## Role-specific behavior"));
  const conflict = employee("conflict"); put(join(conflict.roleDir, "role.yaml"), "agent_id: foreign\nprofile: conflict\nrole: pm\nrepo: conflict\n");
  const escaped = employee("escape"); rmSync(join(escaped.profile, "SOUL.md")); const outside = join(work, "outside"); put(outside, legacy()); symlinkSync(outside, join(escaped.profile, "SOUL.md"));
  const ancestor = employee("ancestor"); const runtime = join(ancestor.roleDir, "runtime"), target = join(work, "runtime-alias"); rmSync(runtime, { recursive: true }); mkdirSync(target); put(join(target, "SOUL.md"), legacy()); symlinkSync(target, runtime);
  employee("missing"); rmSync(join(fleet, "profiles/missing/SOUL.md")); rmSync(join(rows.missing.role_dir, "runtime/SOUL.md"));
  const dupA = employee("dupa"), dupB = employee("dupb"); rows.dupb.profile_name = "dupa";
  const partial = employee("partial"); put(join(partial.roleDir, "SOUL.md"), "# Foreign tracked persona\n");
  rmSync(join(local.profile, "SOUL.md")); put(join(local.profile, "SOUL.md"), readFileSync(join(local.roleDir, "SOUL.md"), "utf8")); chmodSync(join(local.roleDir, "SOUL.md"), 0o640);
  save();
  const snapshot = () => Object.fromEntries(files.filter(path => existsSync(path)).map(path => [path, { bytes: readFileSync(path, "utf8"), mtime: lstatSync(path).mtimeMs, mode: lstatSync(path).mode }]));
  const before = snapshot();
  let preview, applied;
  check("built command previews only owned instruction files without byte/mtime changes", () => {
    const run = cli(false); assert.equal(run.status, 1, run.stdout + run.stderr); preview = JSON.parse(run.stdout);
    assert.deepEqual(preview.counts, { changed: 0, "would-change": 3, current: 0, refused: 10, missing: 1 });
    assert.equal(preview.changed_file_count, 7); assert.deepEqual(snapshot(), before);
  });
  check("apply preserves exact persona bytes, unrelated files, modes and profile links", () => {
    const run = cli(true); assert.equal(run.status, 1, run.stdout + run.stderr); applied = JSON.parse(run.stdout);
    assert.equal(applied.counts.changed, 3); assert.equal(applied.changed_file_count, 7);
    for (const row of applied.rows.filter(r => r.status === "changed")) for (const f of row.files) {
      assert.equal(f.after_sha256, f.readback_sha256); assert.equal(f.nonpolicy_bytes_preserved, true);
      const seen = readFileSync(f.path, "utf8"); assert.equal(policySection(seen), policy);
      if (row.id !== "stale") assert.equal(seen.replace(policy, ""), before[f.path].bytes);
    }
    for (const [path, previous] of Object.entries(before)) if (!applied.rows.flatMap(r => r.changed_files).includes(path)) assert.deepEqual(snapshot()[path], previous, path);
    assert.equal(lstatSync(join(local.roleDir, "SOUL.md")).mode & 0o777, 0o640);
    assert.ok(lstatSync(join(ordinary.profile, "SOUL.md")).isSymbolicLink());
    assert.equal(readFileSync(join(partial.roleDir, "runtime/SOUL.md"), "utf8"), before[join(partial.roleDir, "runtime/SOUL.md")].bytes, "one foreign surface refuses the whole employee");
  });
  check("second apply and preview are no-ops with unchanged bytes/mtime", () => {
    const snapshotAfter = snapshot();
    for (const apply of [true, false]) {
      const run = cli(apply); assert.equal(run.status, 1); const result = JSON.parse(run.stdout);
      assert.equal(result.changed_file_count, 0); assert.equal(result.counts.current, 3); assert.deepEqual(snapshot(), snapshotAfter);
    }
  });
  check("hard links, non-UTF8, foreign SOUL identities and profile aliases refuse without publication", () => {
    const path = join(ordinary.roleDir, "SOUL.md"), original = readFileSync(path), alias = join(work, "hardlink-alias");
    const runRefused = () => { const run = cli(true); assert.equal(run.status, 1); const row = JSON.parse(run.stdout).rows.find(r => r.id === "ordinary"); assert.equal(row.status, "refused"); assert.deepEqual(row.changed_files, []); };
    linkSync(path, alias); runRefused(); rmSync(alias);
    writeFileSync(path, Buffer.concat([original, Buffer.from([0xff])])); runRefused(); assert.equal(readFileSync(path).at(-1), 0xff); writeFileSync(path, original);
    writeFileSync(path, original.toString().replace("| Agent ID | `ordinary` |", "| Agent ID | `foreign` |")); runRefused(); writeFileSync(path, original);
    const profile = join(ordinary.profile, "SOUL.md"); rmSync(profile); symlinkSync(join(ordinary.roleDir, "runtime/SOUL.md"), profile);
    const aliasDir = join(fleet, "profiles/alias"), actualProfile = ordinary.profile; symlinkSync(actualProfile, aliasDir); rows.alias = { ...rows.ordinary, profile_name: "alias" }; save();
    assert.equal(JSON.parse(cli(true).stdout).rows.find(r => r.id === "alias").status, "refused"); delete rows.alias; rmSync(aliasDir); save();
  });
  check("malformed registry and duplicate YAML keys fail without mutation", () => {
    for (const bytes of ["agents: {}\n", "agents: {a: {}, a: {}}\n"]) { put(registry, bytes); assert.equal(cli(true).status, 2); assert.equal(readFileSync(registry, "utf8"), bytes); }
  });
  check("narrow portable adapter updates only SOUL and its receipt, preserving charter/config", () => {
    const pf = join(work, "portable-fleet"), profile = join(pf, "profiles/alice"), definition = join(work, "agent.yaml");
    const raw = { id: "alice", display_name: "Alice", charter: { purpose: "Keep purpose", directives: ["Keep all directives"], tone: "candid" }, memory: { write_bank: "agent-alice" } };
    put(definition, YAML.stringify(raw)); put(join(pf, "config.yaml"), YAML.stringify({ model: { default: "automaticai/personal/sol" } }));
    const request = { ...raw, definition };
    const env = { ...process.env, HERMES_FLEET_HOME: pf, HERMES_TEMPLATE_CONFIG: join(work, "none"), PYTHONDONTWRITEBYTECODE: "1", VOX_PLUGIN_DIR: join(work, "no-plugin") };
    const run = (script, args, payload) => spawnSync("/usr/bin/python3", [join(root, script), ...args], { input: JSON.stringify(payload), encoding: "utf8", env, timeout: 15000 });
    const initial = run("templates/hermes-agent/scripts/hermes-specialist-profile.py", [], request); assert.equal(initial.status, 0, initial.stderr);
    const soulPath = join(profile, "SOUL.md"), receiptPath = join(profile, "specialist-projection.json");
    const soulBefore = readFileSync(soulPath, "utf8"), receiptBefore = JSON.parse(readFileSync(receiptPath, "utf8")), configBefore = readFileSync(join(profile, "config.yaml"), "utf8");
    const projected = { ...request, charter: { ...raw.charter, purpose: raw.charter.purpose + "\n\n" + policy } };
    const payload = { request: projected, purpose: raw.charter.purpose };
    const preview = run("scripts/specialist-policy-refresh.py", ["--check"], payload); assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).changed.length, 2); assert.equal(readFileSync(soulPath, "utf8"), soulBefore);
    const applied = run("scripts/specialist-policy-refresh.py", [], payload); assert.equal(applied.status, 0, applied.stderr);
    const soul = readFileSync(soulPath, "utf8"), receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(soul.replace(policy + "\n\n", ""), soulBefore); assert.equal(receipt.files["SOUL.md"], createHash("sha256").update(soul).digest("hex"));
    receiptBefore.files["SOUL.md"] = receipt.files["SOUL.md"]; assert.deepEqual(receipt, receiptBefore);
    assert.equal(readFileSync(join(profile, "config.yaml"), "utf8"), configBefore);
    assert.deepEqual(JSON.parse(run("scripts/specialist-policy-refresh.py", [], payload).stdout).changed, []);
    const full = run("templates/hermes-agent/scripts/hermes-specialist-profile.py", ["--check"], projected); assert.equal(full.status, 0, full.stderr); assert.deepEqual(JSON.parse(full.stdout).changed, []);
    put(soulPath, soul + "foreign handwriting\n"); const refused = run("scripts/specialist-policy-refresh.py", [], payload); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /handwritten/);
  });
  console.log(`policy-refresh: ${checks} check groups passed`);
} finally { rmSync(work, { recursive: true, force: true }); }
