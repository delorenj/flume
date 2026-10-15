// FLUME-52: the agent registry's `plane.member_id` / `plane.key_ref` are a PROJECTION of the
// employee's provider-verified native Plane binding, written by `hermes.registry-parity` and
// nowhere else.
//
// Pins:
//   1. an adopted binding (native_actor_id == principal) on an ACTIVE employee is audited and
//      projected, leaving every other registry key (and the stale pre-company principal) accounted for;
//   2. a merely requested binding, a suspended employee, a malformed credential reference and a
//      native_actor_id that disagrees with the principal project NOTHING;
//   3. a legacy row with no plane binding at all is left exactly as it was;
//   4. a second remediation is a no-op, and the output carries op:// references, never values.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const work = mkdtempSync(join(tmpdir(), "flume-registry-plane-"));

const STALE = "b29eaffc-cc8d-4de1-a10b-7425c67177ab";
const NATIVE = "292ac356-3640-474e-ac01-8b0611ed6a91";
const REF = "op://DeLoSecrets/mrtiqvegawfdotoybfbgckehpm/5td5eddyyhjnbbsgfoovfi5x2y";
const STALE_REF = "op://DeLoSecrets/Plane Agent 33god-pm/apiKey";

try {
  const home = join(work, "home");
  const repo = join(work, "repo");
  const roleDir = join(repo, "agents", "hermes", "pm");
  mkdirSync(join(home, ".hermes"), { recursive: true });
  mkdirSync(join(roleDir, ".scripts"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "# fixture\n");
  const agentId = "named-pm";
  const roleBase = `repo: fixture\nrole: pm\nagent_id: ${agentId}\nprofile: ${agentId}\nidentity:\n  name: grolf\n  recall_banks:\n    - agent-${agentId}\n`;
  const identity = (plane, status = "active") => `company_identity:
  version: 1
  subject: "1dcd3567-3b5e-46b0-a6c3-a2753d6c763b"
  handle: "grolf"
  email: "grolf@agents.delo.sh"
  status: "${status}"
  enrolled_at: "2026-10-13T09:14:09.584Z"
  bindings:
    plane:
${Object.entries(plane).map(([key, value]) => `      ${key}: "${value}"`).join("\n")}
`;
  const role = (plane, status) => writeFileSync(join(roleDir, "role.yaml"), `${roleBase}${plane ? identity(plane, status) : ""}`);
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify({ project_name: "fixture", repo_path: repo,
    agents: { [agentId]: { role: "pm", role_dir: "agents/hermes/pm", provisioning_state: "provisioned" } } }, null, 2)}\n`);
  const registryPath = join(home, ".hermes", "agents-registry.yaml");
  const seed = () => writeFileSync(registryPath, `agents:
  ${agentId}:
    project_path: ${repo}
    role_dir: ${roleDir}
    profile_name: ${agentId}
    identity: grolf
    hindsight:
      write_bank: agent-grolf
      recall_banks:
        - agent-grolf
        - agent-${agentId}
    plane:
      workspace: 33god
      project_id: 15258893-0206-4e8f-aea6-340eb217988c
      identifier: 33GOD
      member_id: ${STALE}
      key_ref: ${STALE_REF}
    bloodbank:
      enabled: true
      gateway_scope: fleet
      target_agent_id: ${agentId}
`);

  const run = (args) => {
    const result = spawnSync("node", [cli, ...args], { cwd: repo, encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, ".cache") } });
    assert.ok(result.stdout.trim(), `expected JSON from ${args.join(" ")}\n${result.stderr}`);
    return { json: JSON.parse(result.stdout), raw: result.stdout + result.stderr };
  };
  const parity = () => run(["audit", repo, "--rules", "hermes.registry-parity", "--json"]).json.rules.find((rule) => rule.id === "hermes.registry-parity");
  const remediate = () => run(["remediate", "hermes.registry-parity", repo, "--json"]);
  const row = () => YAML.parse(readFileSync(registryPath, "utf8")).agents[agentId];
  const planeDrift = (audit) => audit.details.filter((line) => /plane\.(member_id|key_ref)/u.test(line));

  // 3. no plane binding: the legacy principal is not touched, and not reported as drift.
  seed(); role(null);
  assert.deepEqual(planeDrift(parity()), [], "an unbound employee claims nothing about the registry's plane identity");
  remediate();
  assert.equal(row().plane.member_id, STALE, "no verified binding, no rewrite");
  assert.equal(row().plane.key_ref, STALE_REF);

  // 2. everything short of an ADOPTED, ACTIVE, well-formed binding projects nothing.
  const refused = [
    ["requested but not adopted", { principal: NATIVE, instance: "https://plane.delo.sh/33god", credential_ref: REF, attribution_mode: "native" }, "active"],
    ["adopted actor differs from the principal", { principal: NATIVE, instance: "https://plane.delo.sh/33god", credential_ref: REF, native_actor_id: STALE }, "active"],
    ["title-based credential reference", { principal: NATIVE, instance: "https://plane.delo.sh/33god", credential_ref: STALE_REF, native_actor_id: NATIVE }, "active"],
    ["not a uuid", { principal: "grolf", instance: "https://plane.delo.sh/33god", credential_ref: REF, native_actor_id: "grolf" }, "active"],
    ["suspended employee", { principal: NATIVE, instance: "https://plane.delo.sh/33god", credential_ref: REF, native_actor_id: NATIVE }, "suspended"],
    ["retired employee", { principal: NATIVE, instance: "https://plane.delo.sh/33god", credential_ref: REF, native_actor_id: NATIVE }, "retired"],
  ];
  for (const [label, plane, status] of refused) {
    seed(); role(plane, status);
    assert.deepEqual(planeDrift(parity()), [], `${label}: must not be audited as a projection`);
    remediate();
    assert.equal(row().plane.member_id, STALE, `${label}: member_id must stay`);
    assert.equal(row().plane.key_ref, STALE_REF, `${label}: key_ref must stay`);
  }

  // 1. adopted + active: audited, projected, nothing else disturbed.
  seed(); role({ principal: NATIVE, instance: "https://plane.delo.sh/33god", credential_ref: REF, attribution_mode: "native", native_actor_id: NATIVE });
  const before = row();
  let audit = parity();
  assert.equal(audit.status, "fail");
  assert.equal(audit.fixable, true);
  const lines = planeDrift(audit);
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.match(lines.join("\n"), new RegExp(`plane\\.member_id for ${agentId} is "${STALE}" \\(role\\.yaml's verified native Plane user is "${NATIVE}"\\)`, "u"));
  assert.match(lines.join("\n"), /plane\.key_ref for named-pm is "op:\/\/DeLoSecrets\/Plane Agent 33god-pm\/apiKey"/u);
  const applied = remediate();
  assert.equal(applied.json.results.find((rule) => rule.id === "hermes.registry-parity").status, "applied");
  assert.equal(row().plane.member_id, NATIVE);
  assert.equal(row().plane.key_ref, REF);
  assert.equal(row().plane.workspace, before.plane.workspace, "board identity is project-registry's, never rewritten here");
  assert.equal(row().plane.project_id, before.plane.project_id);
  assert.equal(row().plane.identifier, before.plane.identifier);
  assert.deepEqual({ ...row(), plane: null }, { ...before, plane: null }, "only the plane identity changed");
  assert.deepEqual(planeDrift(parity()), []);

  // 4. idempotent, and the registry holds references only.
  const once = readFileSync(registryPath, "utf8");
  remediate();
  assert.equal(readFileSync(registryPath, "utf8"), once, "a second remediation changes nothing");
  assert.doesNotMatch(once + applied.raw, /X-API-Key|plane_api_[a-z0-9]{8,}/iu);

  console.log("company-identity registry-plane regressions: all assertions passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
