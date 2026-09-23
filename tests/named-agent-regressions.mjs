// Named agents: a role directory is a POST (`agent_id`/`profile`); a NAMED
// agent declares who it is in role.yaml `identity:` and keeps its name,
// personal bank and chat identity if it changes posts. The first one is Grolf,
// holding the 33god-pm post.
//
// Pins four things:
//   1. readRoleIdentity() agrees with the template's .scripts/lib/role-identity.py
//      (the provisioner pins and projects from THAT answer);
//   2. composeSoul() addresses a named agent by name and names its personal and
//      history banks, while an unnamed post composes exactly the legacy prose;
//   3. hermes.registry-parity audits and converges the registry projection;
//   4. a malformed identity is a non-fixable blocker that writes nothing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const work = mkdtempSync(join(tmpdir(), "flume-named-agent-"));
const cache = join(root, "node_modules/.cache/flume-named-agent");

try {
  const entry = join(work, "entry.ts");
  writeFileSync(entry, `export { composeSoul, readRoleIdentity } from ${JSON.stringify(join(root, "packages/flume-hr/src/parity/rules.ts"))};\n`);
  mkdirSync(cache, { recursive: true });
  const out = join(cache, `bundle-${process.pid}.mjs`);
  buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile: out, logLevel: "silent",
    nodePaths: [join(root, "node_modules"), join(root, "packages/flume-hr/node_modules")] });
  const { composeSoul, readRoleIdentity } = await import(pathToFileURL(out).href);

  // -- 1. identity validation, and parity with the template's reader ----------
  const base = "repo: demo\nrole: pm\nagent_id: demo-pm\nprofile: demo-pm\n";
  const cases = [
    ["unnamed post", "", { state: "none" }],
    ["named, defaults", "identity:\n  name: grolf\n", { state: "named", name: "grolf", writeBank: "agent-grolf", recallBanks: ["agent-grolf"] }],
    ["named, history first-deduped", "identity:\n  name: grolf\n  recall_banks: [agent-demo-pm, agent-grolf, workspace-grolf]\n",
      { state: "named", name: "grolf", writeBank: "agent-grolf", recallBanks: ["agent-grolf", "agent-demo-pm", "workspace-grolf"] }],
    ["name is the post", "identity:\n  name: demo-pm\n", "invalid"],
    ["bank named for the post", "identity:\n  name: grolf\n  write_bank: agent-demo-pm\n", "invalid"],
    ["upper-case name", "identity:\n  name: Grolf\n", "invalid"],
    ["shared fallback recall", "identity:\n  name: grolf\n  recall_banks: [hermes]\n", "invalid"],
    ["unknown key", "identity:\n  name: grolf\n  nickname: g\n", "invalid"],
    ["scalar block", "identity: grolf\n", "invalid"],
  ];
  const reader = join(root, "templates/hermes-agent/template/.scripts/lib/role-identity.py");
  for (const [label, block, expected] of cases) {
    const text = `${base}${block}`;
    const got = readRoleIdentity(text, "demo-pm", "demo-pm");
    if (expected === "invalid") assert.equal(got.state, "invalid", `${label}: ${JSON.stringify(got)}`);
    else assert.deepEqual(got, expected, label);
    if (existsSync(reader)) {
      const file = join(work, "role.yaml");
      writeFileSync(file, text);
      const py = spawnSync("python3", ["-I", reader, file, "demo-pm", "demo-pm"], { encoding: "utf8" });
      if (expected === "invalid") {
        assert.notEqual(py.status, 0, `template reader accepted ${label}`);
      } else {
        assert.equal(py.status, 0, `${label}: ${py.stderr}`);
        const parsed = JSON.parse(py.stdout);
        const mapped = expected.state === "none" ? {} : { name: expected.name, write_bank: expected.writeBank, recall_banks: expected.recallBanks };
        assert.deepEqual(parsed, mapped, `template reader disagrees on ${label}`);
      }
    }
  }

  // -- 2. the composed soul ------------------------------------------------------
  const post = { agentId: "33god-pm", role: "pm", repo: "33god", displayName: "33GOD PM", profileName: "33god-pm", purpose: "", botHandle: "", soulTone: "direct", projectBank: "33GOD" };
  const unnamed = composeSoul(root, post).text;
  assert.match(unnamed, /\| Bank \| `agent-33god-pm` \| `33GOD` \|/);
  assert.match(unnamed, /\(`memory\.bank_id_template: agent-\{profile\}`\), so it accrues on its own from\nyour turns\. It is keyed to your profile name, \*\*never\*\*/);
  assert.match(unnamed, /repository\.\n\n## Identity\n\n\| \| \|\n\| --- \| --- \|\n\| Agent ID \|/);
  assert.doesNotMatch(unnamed, /named agent|\| Name \|/);

  const grolf = composeSoul(root, {
    ...post,
    displayName: "Grolf",
    botHandle: "Gr0lfBot",
    named: { name: "grolf", writeBank: "agent-grolf", recallBanks: ["agent-grolf", "agent-33god-pm", "workspace-grolf"] },
  }).text;
  assert.match(grolf, /^# Grolf\n/);
  assert.match(grolf, /You are \*\*Grolf\*\* — a Hermes agent/);
  assert.match(grolf, /You are a \*\*named agent\*\*\. \*Grolf\* \(`grolf`\) is who you are;\n`33god-pm` is only the post you currently hold\./);
  assert.match(grolf, /\| --- \| --- \|\n\| Name \| \*\*Grolf\*\* \(`grolf`\) — a named agent holding the `33god-pm` post \|\n\| Agent ID \| `33god-pm` \|/);
  assert.match(grolf, /\| Telegram \| `@Gr0lfBot` \|/);
  assert.match(grolf, /\| Bank \| `agent-grolf` \| `33GOD` \|/);
  assert.match(grolf, /pinned to your personal bank `agent-grolf`/);
  assert.match(grolf, /It is keyed to your name \(`grolf`\), not to the post you hold, \*\*never\*\*/);
  assert.match(grolf, /hindsight memory recall agent-33god-pm "<question>"\nhindsight memory recall workspace-grolf "<question>"/);
  assert.doesNotMatch(grolf, /hindsight memory recall agent-grolf /, "the write bank is recalled automatically, never listed as history");
  assert.doesNotMatch(grolf, /\n{3,}/);

  // -- 3 + 4. registry parity -------------------------------------------------------
  const home = join(work, "home");
  const repo = join(work, "repo");
  const roleDir = join(repo, "agents", "hermes", "pm");
  mkdirSync(join(home, ".hermes"), { recursive: true });
  mkdirSync(join(roleDir, ".scripts"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "# fixture\n");
  const agentId = "named-pm";
  const roleBase = `repo: fixture\nrole: pm\nagent_id: ${agentId}\nprofile: ${agentId}\n`;
  const named = `${roleBase}identity:\n  name: grolf\n  recall_banks:\n    - agent-${agentId}\n`;
  writeFileSync(join(roleDir, "role.yaml"), named);
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify({ project_name: "fixture", repo_path: repo,
    agents: { [agentId]: { role: "pm", role_dir: "agents/hermes/pm", provisioning_state: "provisioned" } } }, null, 2)}\n`);
  const registryPath = join(home, ".hermes", "agents-registry.yaml");
  writeFileSync(registryPath, `agents:\n  ${agentId}:\n    project_path: ${repo}\n    role_dir: ${roleDir}\n    profile_name: ${agentId}\n    bloodbank:\n      enabled: true\n      gateway_scope: fleet\n      target_agent_id: ${agentId}\n`);

  const run = (args) => {
    const result = spawnSync("node", [cli, ...args], { cwd: repo, encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, ".cache") } });
    assert.ok(result.stdout.trim(), `expected JSON from ${args.join(" ")}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const parity = () => run(["audit", repo, "--rules", "hermes.registry-parity", "--json"]).rules.find((rule) => rule.id === "hermes.registry-parity");
  const remediate = () => run(["remediate", "hermes.registry-parity", repo, "--json"]).results.find((rule) => rule.id === "hermes.registry-parity");
  const row = () => YAML.parse(readFileSync(registryPath, "utf8")).agents[agentId];

  let audit = parity();
  assert.equal(audit.status, "fail");
  assert.match(audit.details.join("\n"), /registry identity for named-pm is absent \(role\.yaml names "grolf"\)/);
  assert.match(audit.details.join("\n"), /hindsight\.write_bank for named-pm is absent \(role\.yaml declares "agent-grolf"\)/);
  assert.equal(audit.fixable, true);
  assert.equal(remediate().status, "applied");
  assert.equal(row().identity, "grolf");
  assert.deepEqual(row().hindsight, { write_bank: "agent-grolf", recall_banks: ["agent-grolf", `agent-${agentId}`] });
  assert.equal(row().profile_name, agentId, "naming an agent never renames its post");
  audit = parity();
  assert.doesNotMatch(audit.details.join("\n"), /identity|write_bank|recall_banks/, JSON.stringify(audit));

  // The role forgets the name: the projection is stale and is dropped.
  writeFileSync(join(roleDir, "role.yaml"), roleBase);
  audit = parity();
  assert.match(audit.details.join("\n"), /registry names named-pm "grolf" but pm\/role\.yaml declares no identity/);
  assert.equal(remediate().status, "applied");
  assert.equal(row().identity, undefined);
  assert.equal(row().hindsight, undefined);

  // A malformed identity blocks, and writes nothing.
  writeFileSync(join(roleDir, "role.yaml"), `${roleBase}identity:\n  name: ${agentId}\n`);
  const before = readFileSync(registryPath, "utf8");
  audit = parity();
  assert.equal(audit.status, "fail");
  assert.equal(audit.fixable, false);
  assert.match(audit.details.join("\n"), /is a post id/);
  assert.equal(remediate().status, "blocked");
  assert.equal(readFileSync(registryPath, "utf8"), before);

  console.log("named-agent regressions: all assertions passed");
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
}
