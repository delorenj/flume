import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages", "flume-hr", "dist", "index.js");
const cleanup = [];

function makeHome(name) {
  const home = mkdtempSync(join(tmpdir(), `pjan-48-${name}-home-`));
  cleanup.push(home);
  mkdirSync(join(home, ".hermes"), { recursive: true });
  return home;
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjan-48-${name}-repo-`));
  cleanup.push(repo);
  writeFileSync(join(repo, "AGENTS.md"), "# Fixture agent rules\n");
  return repo;
}

function makeRole(repo, agentId, roleName = "pm") {
  const roleDir = join(repo, "agents", "hermes", roleName);
  mkdirSync(join(roleDir, ".scripts"), { recursive: true });
  writeFileSync(
    join(roleDir, "role.yaml"),
    `repo: fixture\nrole: ${roleName}\nagent_id: ${agentId}\nprofile: ${agentId}\n`,
  );
  writeFileSync(
    join(repo, ".project.json"),
    `${JSON.stringify({
      project_name: "fixture",
      repo_path: repo,
      agents: {
        [agentId]: {
          role: roleName,
          role_dir: `agents/hermes/${roleName}`,
          provisioning_state: "provisioned",
        },
      },
    }, null, 2)}\n`,
  );
  return roleDir;
}

function jsonCommand(args, { cwd, home, extraEnv = {} }) {
  const result = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      ...extraEnv,
    },
  });
  assert.ok(result.stdout.trim(), `expected JSON output\nstderr:\n${result.stderr}`);
  return { result, json: JSON.parse(result.stdout) };
}

function finding(report, id) {
  const value = report.rules.find((entry) => entry.id === id);
  assert.ok(value, `missing audit finding ${id}`);
  return value;
}

function migrationResult(report, id) {
  const value = report.results.find((entry) => entry.id === id);
  assert.ok(value, `missing migration result ${id}`);
  return value;
}

try {
  {
    for (const roleName of ["pm", "director"]) {
      const repo = makeRepo(`bloodbank-gate-${roleName}`);
      const home = makeHome(`bloodbank-gate-${roleName}`);
      const agentId = `pjan48-gate-${roleName}`;
      const roleDir = makeRole(repo, agentId, roleName);
      const registryPath = join(home, ".hermes", "agents-registry.yaml");
      writeFileSync(
        registryPath,
        `agents:\n  ${agentId}:\n    project_path: ${repo}\n    role_dir: ${roleDir}\n    bloodbank:\n      enabled: false\n      gateway_scope: fleet\n      target_agent_id: ${agentId}\n`,
      );

      // No key means enabled: the role declares no bloodbank.enabled, so the
      // registry's `false` is drift and remediation projects `true`.
      const plannedAudit = jsonCommand(["audit", repo, "--json"], { cwd: repo, home }).json;
      const plannedFinding = finding(plannedAudit, "hermes.registry-parity");
      assert.equal(plannedFinding.status, "fail");
      assert.match(plannedFinding.details.join("\n"), /must match role value true \(an absent key means true\)/);
      const plannedMigration = jsonCommand(["remediate", "hermes.registry-parity", repo, "--json"], { cwd: repo, home }).json;
      assert.equal(migrationResult(plannedMigration, "hermes.registry-parity").status, "applied");
      assert.match(readFileSync(registryPath, "utf8"), /enabled: true/);

      // An explicit false still quarantines.
      writeFileSync(
        join(roleDir, "role.yaml"),
        `${readFileSync(join(roleDir, "role.yaml"), "utf8")}bloodbank:\n  enabled: false\n`,
      );
      const quarantineMigration = jsonCommand(["remediate", "hermes.registry-parity", repo, "--json"], { cwd: repo, home }).json;
      assert.equal(migrationResult(quarantineMigration, "hermes.registry-parity").status, "applied");
      assert.match(readFileSync(registryPath, "utf8"), /enabled: false/);

      const beforeMalformed = readFileSync(registryPath, "utf8");
      writeFileSync(
        join(roleDir, "role.yaml"),
        readFileSync(join(roleDir, "role.yaml"), "utf8").replace("enabled: false", "enabled: yes"),
      );
      const malformedAudit = jsonCommand(["audit", repo, "--json"], { cwd: repo, home }).json;
      const malformedFinding = finding(malformedAudit, "hermes.registry-parity");
      assert.equal(malformedFinding.status, "fail");
      assert.equal(malformedFinding.fixable, false);
      assert.match(malformedFinding.details.join("\n"), /strict YAML boolean/);
      const blocked = jsonCommand(["remediate", "hermes.registry-parity", repo, "--json"], { cwd: repo, home }).json;
      assert.equal(migrationResult(blocked, "hermes.registry-parity").status, "blocked");
      assert.equal(readFileSync(registryPath, "utf8"), beforeMalformed);
    }
  }

  {
    const repo = makeRepo("moved-registry");
    const home = makeHome("moved-registry");
    const agentId = "pjan48-moved-pm";
    const roleDir = makeRole(repo, agentId);
    const registryPath = join(home, ".hermes", "agents-registry.yaml");
    writeFileSync(
      registryPath,
      `agents:\n  ${agentId}:\n    project_path: /old/location/pjangler\n    role_dir: /old/location/pjangler/agents/hermes/pm\n    hermes: {}\n`,
    );

    const audit = jsonCommand(["audit", repo, "--json"], { cwd: repo, home }).json;
    assert.equal(finding(audit, "hermes.registry-parity").status, "fail");

    const migrated = jsonCommand(["remediate", "hermes.registry-parity", repo, "--json"], { cwd: repo, home }).json;
    assert.equal(migrationResult(migrated, "hermes.registry-parity").status, "applied");
    const repaired = readFileSync(registryPath, "utf8");
    assert.match(repaired, new RegExp(`role_dir: ${roleDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(repaired, new RegExp(`project_path: ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const postAudit = jsonCommand(["audit", repo, "--json"], { cwd: repo, home }).json;
    assert.equal(
      finding(postAudit, "hermes.registry-parity").status,
      "pass",
      JSON.stringify(finding(postAudit, "hermes.registry-parity")),
    );
  }

  {
    const repo = makeRepo("stale-systemd");
    const home = makeHome("stale-systemd");
    const agentId = "pjan48-systemd-pm";
    const roleDir = makeRole(repo, agentId);
    const sysDir = join(home, ".config", "systemd", "user");
    const fakeBin = join(home, "bin");
    const forceRecord = join(home, "force-systemd.txt");
    mkdirSync(sysDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    const units = [
      `hermes-${agentId}-gateway.service`,
      `hermes-${agentId}-heartbeat.timer`,
    ];
    for (const unit of units) {
      writeFileSync(join(sysDir, unit), "ExecStart=/old/location/pjangler/agents/hermes/pm/runtime/bin/hermes\n");
    }

    const fakeSystemctl = join(fakeBin, "systemctl");
    writeFileSync(fakeSystemctl, "#!/usr/bin/env bash\nprintf 'running\\n'\nexit 0\n");
    chmodSync(fakeSystemctl, 0o755);
    const provision = join(roleDir, ".scripts", "70-systemd.sh");
    writeFileSync(
      provision,
      "#!/usr/bin/env bash\nprintf '%s' \"${FORCE_SYSTEMD:-}\" > \"${PJAN48_FORCE_RECORD:?}\"\n",
    );
    chmodSync(provision, 0o755);

    const migrated = jsonCommand(["remediate", "systemd.sentinel", repo, "--json"], {
      cwd: repo,
      home,
      extraEnv: {
        PATH: `${fakeBin}:${process.env.PATH}`,
        PJAN48_FORCE_RECORD: forceRecord,
      },
    }).json;
    assert.equal(migrationResult(migrated, "systemd.sentinel").status, "applied");
    assert.equal(existsSync(forceRecord), true, "stale unit paths must force regeneration");
    assert.equal(readFileSync(forceRecord, "utf8"), "1", "systemd provisioning must receive FORCE_SYSTEMD=1");
  }

  console.log("PJAN-48 regressions: passed");
} finally {
  for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
}
