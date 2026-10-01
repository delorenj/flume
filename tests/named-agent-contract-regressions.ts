import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  materializeDesk,
  NamedAgentValidationError,
  parseNamedAgentYaml,
  provisionDesk,
  resolveDeskPath,
  validateNamedAgent,
  validateNamedAgentSchema,
  type NamedAgentContract,
} from "../packages/flume-hr/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "flume-named-agent-contract-"));

try {
  console.log("running named-agent-contract regressions in:", work);

  // Setup hermetic Skillex registry fixture
  const skillexRoot = join(work, "skillex");
  mkdirSync(join(skillexRoot, "all-skills", "n8n-workflow-design"), { recursive: true });
  writeFileSync(
    join(skillexRoot, "all-skills", "n8n-workflow-design", "SKILL.md"),
    "---\nname: n8n-workflow-design\ndescription: Design n8n workflows\n---\n# Workflow Design\n",
  );
  mkdirSync(join(skillexRoot, "all-skills", "n8n-node-builder"), { recursive: true });
  writeFileSync(
    join(skillexRoot, "all-skills", "n8n-node-builder", "SKILL.md"),
    "---\nname: n8n-node-builder\ndescription: Build custom n8n nodes\n---\n# Node Builder\n",
  );
  mkdirSync(join(skillexRoot, "all-skills", "n8n-community-nodes"), { recursive: true });
  writeFileSync(
    join(skillexRoot, "all-skills", "n8n-community-nodes", "SKILL.md"),
    "---\nname: n8n-community-nodes\ndescription: Community node management\n---\n# Community Nodes\n",
  );

  // Pack 1: agent-n8n with 2 skills
  const packDir = join(skillexRoot, "packs", "agent-n8n");
  mkdirSync(packDir, { recursive: true });
  writeFileSync(
    join(packDir, "pack.toml"),
    `[pack]
name = "agent-n8n"
version = "0.1.0"
description = "N8N specialist skills pack"

[freeform]
skills = [
  "n8n-workflow-design",
  "n8n-node-builder"
]
`,
  );

  // Pack 2: broken pack referencing missing canonical skill
  const brokenPackDir = join(skillexRoot, "packs", "agent-broken");
  mkdirSync(brokenPackDir, { recursive: true });
  writeFileSync(
    join(brokenPackDir, "pack.toml"),
    `[pack]
name = "agent-broken"
version = "0.1.0"
description = "Broken skills pack"

[freeform]
skills = [
  "n8n-workflow-design",
  "non-existent-skill"
]
`,
  );

  // Pack 3: updated pack for re-provisioning test
  const updatedPackDir = join(skillexRoot, "packs", "agent-n8n-v2");
  mkdirSync(updatedPackDir, { recursive: true });
  writeFileSync(
    join(updatedPackDir, "pack.toml"),
    `[pack]
name = "agent-n8n-v2"
version = "0.2.0"
description = "Updated n8n pack"

[freeform]
skills = [
  "n8n-workflow-design",
  "n8n-community-nodes"
]
`,
  );

  const fixtureHome = join(work, "userhome");
  mkdirSync(fixtureHome, { recursive: true });

  // ==========================================================================
  // Test 1: Valid Named Agent Definition (No repo or project_path required)
  // ==========================================================================
  const validYaml = `schema_version: 1
id: n8n-specialist
display_name: "N8N Workflow Specialist"
role: workflow-specialist
charter:
  purpose: "Design and maintain high-reliability n8n workflows following homelab conventions."
  directives:
    - "Prefer built-in nodes over code nodes unless transformations require custom libraries."
    - "Expose minimal required fields in intermediate node outputs."
  tone: direct
skills:
  pack: agent-n8n
memory:
  write_bank: agent-n8n-specialist
  recall_banks:
    - agent-n8n-specialist
desk:
  path: "~/.agents/workforce/n8n-specialist"
`;

  const parsed = parseNamedAgentYaml(validYaml);
  const contract = validateNamedAgentSchema(parsed);
  assert.equal(contract.id, "n8n-specialist");
  assert.equal(contract.role, "workflow-specialist");
  assert.equal(contract.display_name, "N8N Workflow Specialist");
  assert.equal(contract.charter.purpose, "Design and maintain high-reliability n8n workflows following homelab conventions.");
  assert.equal(contract.charter.directives?.length, 2);
  assert.equal(contract.charter.tone, "direct");
  assert.equal(contract.skills.pack, "agent-n8n");
  assert.equal(contract.memory.write_bank, "agent-n8n-specialist");
  assert.deepEqual(contract.memory.recall_banks, ["agent-n8n-specialist"]);
  assert.equal(contract.desk?.path, "~/.agents/workforce/n8n-specialist");
  // Confirm repo and project_path are absent
  assert.equal((contract as any).repo, undefined);
  assert.equal((contract as any).project_path, undefined);
  console.log("  ok: valid named agent definition passes schema validation");

  // ==========================================================================
  // Test 2: Omission of desk resolves default path
  // ==========================================================================
  const noDeskYaml = `schema_version: 1
id: n8n-specialist
display_name: "N8N Workflow Specialist"
role: workflow-specialist
charter:
  purpose: "Design and maintain n8n workflows."
skills:
  pack: agent-n8n
memory:
  write_bank: agent-n8n-specialist
`;
  const noDeskContract = validateNamedAgentSchema(noDeskYaml);
  const resolvedDesk = resolveDeskPath(noDeskContract, { home: fixtureHome });
  assert.equal(resolvedDesk, join(fixtureHome, ".agents", "workforce", "n8n-specialist"));
  console.log("  ok: omitted desk resolves default path ~/.agents/workforce/<id>");

  // ==========================================================================
  // Test 3: Missing Required Fields Rejection
  // ==========================================================================
  // 3a. Missing id
  assert.throws(
    () => {
      validateNamedAgentSchema(`schema_version: 1
display_name: "Test"
role: test-role
charter:
  purpose: "Test"
skills:
  pack: agent-n8n
memory:
  write_bank: agent-test
`);
    },
    (err: unknown) => {
      assert.ok(err instanceof NamedAgentValidationError);
      assert.match(err.message, /Missing required field: id/);
      return true;
    },
    "Should reject definition missing id",
  );

  // 3b. Missing role
  assert.throws(
    () => {
      validateNamedAgentSchema(`schema_version: 1
id: test-agent
display_name: "Test"
charter:
  purpose: "Test"
skills:
  pack: agent-n8n
memory:
  write_bank: agent-test
`);
    },
    (err: unknown) => {
      assert.ok(err instanceof NamedAgentValidationError);
      assert.match(err.message, /Missing required field: role/);
      return true;
    },
    "Should reject definition missing role",
  );

  // 3c. Missing memory.write_bank
  assert.throws(
    () => {
      validateNamedAgentSchema(`schema_version: 1
id: test-agent
display_name: "Test"
role: test-role
charter:
  purpose: "Test"
skills:
  pack: agent-n8n
memory:
  recall_banks:
    - agent-test
`);
    },
    (err: unknown) => {
      assert.ok(err instanceof NamedAgentValidationError);
      assert.match(err.message, /Missing required field: memory\.write_bank/);
      return true;
    },
    "Should reject definition missing memory.write_bank",
  );

  // 3d. Invalid memory.write_bank pattern (must be agent-<name>)
  assert.throws(
    () => {
      validateNamedAgentSchema(`schema_version: 1
id: test-agent
display_name: "Test"
role: test-role
charter:
  purpose: "Test"
skills:
  pack: agent-n8n
memory:
  write_bank: custom-bank-name
`);
    },
    (err: unknown) => {
      assert.ok(err instanceof NamedAgentValidationError);
      assert.match(err.message, /pattern \^agent-\[a-z0-9-_\]\+\$/);
      return true;
    },
    "Should reject memory.write_bank not starting with agent-",
  );

  // 3e. Additional property (e.g. repo or project_path) rejected by additionalProperties: false
  assert.throws(
    () => {
      validateNamedAgentSchema(`schema_version: 1
id: test-agent
display_name: "Test"
role: test-role
repo: my-repo
charter:
  purpose: "Test"
skills:
  pack: agent-n8n
memory:
  write_bank: agent-test
`);
    },
    (err: unknown) => {
      assert.ok(err instanceof NamedAgentValidationError);
      assert.match(err.message, /Additional property not allowed: repo/);
      return true;
    },
    "Should reject additional property repo",
  );
  console.log("  ok: missing required fields and illegal properties rejected");

  // ==========================================================================
  // Test 4: Pack and Canonical Skill Resolution
  // ==========================================================================
  // 4a. Valid resolution
  const resolvedAgent = await validateNamedAgent(validYaml, {
    skillexRoot,
    home: fixtureHome,
  });
  assert.equal(resolvedAgent.resolvedSkills.length, 2);
  const skillNames = resolvedAgent.resolvedSkills.map((s) => s.name).sort();
  assert.deepEqual(skillNames, ["n8n-node-builder", "n8n-workflow-design"]);
  for (const s of resolvedAgent.resolvedSkills) {
    assert.equal(s.path, join(skillexRoot, "all-skills", s.name));
    assert.ok(existsSync(join(s.path, "SKILL.md")));
  }
  console.log("  ok: pack resolution maps declared skills to canonical all-skills/ targets");

  // 4b. Unresolved canonical skill detection
  const brokenAgentYaml = `schema_version: 1
id: broken-agent
display_name: "Broken Agent"
role: test-role
charter:
  purpose: "Test broken skill resolution"
skills:
  pack: agent-broken
memory:
  write_bank: agent-broken-agent
`;
  await assert.rejects(
    async () => {
      await validateNamedAgent(brokenAgentYaml, {
        skillexRoot,
        home: fixtureHome,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof NamedAgentValidationError);
      assert.match(err.message, /references canonical skill that does not exist in Skillex catalog/);
      assert.match(err.message, /non-existent-skill/);
      assert.match(err.message, new RegExp(join(skillexRoot, "all-skills")));
      return true;
    },
    "Should reject agent referencing non-existent canonical skill",
  );
  console.log("  ok: unresolved canonical skill fails validation with diagnostic error");

  // ==========================================================================
  // Test 5: Desk Materialization and .agents/skills Symlinks
  // ==========================================================================
  const deskResult = await provisionDesk(validYaml, {
    skillexRoot,
    home: fixtureHome,
  });

  const expectedDeskPath = join(fixtureHome, ".agents", "workforce", "n8n-specialist");
  assert.equal(deskResult.deskPath, expectedDeskPath);
  assert.equal(deskResult.created, 2);
  assert.equal(deskResult.preserved, 0);
  assert.equal(deskResult.updated, 0);
  assert.equal(deskResult.removed, 0);

  // Verify .agents/skills directory exists
  const skillsDir = join(expectedDeskPath, ".agents", "skills");
  assert.ok(existsSync(skillsDir), "Desk .agents/skills directory must exist");

  // Verify symlinks exist and are real symbolic links pointing to canonical targets
  for (const skillName of ["n8n-workflow-design", "n8n-node-builder"]) {
    const linkPath = join(skillsDir, skillName);
    assert.ok(existsSync(linkPath), `Symlink must exist: ${linkPath}`);
    const stat = lstatSync(linkPath);
    assert.ok(stat.isSymbolicLink(), `Entry ${skillName} must be a symbolic link`);
    const target = readlinkSync(linkPath);
    assert.equal(resolve(target), join(skillexRoot, "all-skills", skillName));
  }

  // Verify contract.yaml written to desk
  assert.ok(existsSync(join(expectedDeskPath, "contract.yaml")));
  console.log("  ok: desk materializes .agents/skills symlinks pointing to canonical targets");

  // ==========================================================================
  // Test 6: Idempotent Re-provisioning and User Notes Preservation
  // ==========================================================================
  // Create user notes inside the desk
  const userNotePath = join(expectedDeskPath, "specialist-notes.md");
  writeFileSync(userNotePath, "# Specialist Private Notes\nDo not delete me!\n");
  const subDirPath = join(expectedDeskPath, "scratch");
  mkdirSync(subDirPath, { recursive: true });
  writeFileSync(join(subDirPath, "scratch.txt"), "Important user scratchpad");

  // Re-run provisionDesk (idempotent)
  const rerunResult = await provisionDesk(validYaml, {
    skillexRoot,
    home: fixtureHome,
  });
  assert.equal(rerunResult.created, 0);
  assert.equal(rerunResult.preserved, 2);
  assert.equal(rerunResult.updated, 0);
  assert.equal(rerunResult.removed, 0);

  // User notes must remain untouched
  assert.ok(existsSync(userNotePath), "User notes must be preserved");
  assert.equal(readFileSync(userNotePath, "utf8"), "# Specialist Private Notes\nDo not delete me!\n");
  assert.ok(existsSync(join(subDirPath, "scratch.txt")));
  console.log("  ok: idempotent re-provisioning preserves symlinks and user notes");

  // ==========================================================================
  // Test 7: Pack Update Symlink Reconciliation
  // ==========================================================================
  // Switch agent to updated pack agent-n8n-v2 (has n8n-workflow-design and n8n-community-nodes)
  const updatedYaml = validYaml.replace("pack: agent-n8n", "pack: agent-n8n-v2");
  const updateResult = await provisionDesk(updatedYaml, {
    skillexRoot,
    home: fixtureHome,
  });

  assert.equal(updateResult.created, 1, "Should create 1 new symlink for n8n-community-nodes");
  assert.equal(updateResult.preserved, 1, "Should preserve 1 existing symlink for n8n-workflow-design");
  assert.equal(updateResult.removed, 1, "Should remove 1 stale symlink for n8n-node-builder");

  // Check filesystem state
  assert.ok(existsSync(join(skillsDir, "n8n-workflow-design")));
  assert.ok(existsSync(join(skillsDir, "n8n-community-nodes")));
  assert.ok(!existsSync(join(skillsDir, "n8n-node-builder")), "Removed skill symlink must not exist");

  // User notes still intact
  assert.ok(existsSync(userNotePath));
  console.log("  ok: pack updates reconcile symlinks: adds new, removes stale, preserves unchanged");

  // ==========================================================================
  // Test 8: Filesystem Permission Error Handling
  // ==========================================================================
  const readOnlyParent = join(work, "readonly-dir");
  mkdirSync(readOnlyParent, { recursive: true });
  chmodSync(readOnlyParent, 0o444);

  const blockedYaml = validYaml.replace(
    'path: "~/.agents/workforce/n8n-specialist"',
    `path: "${join(readOnlyParent, "nested", "desk")}"`,
  );

  await assert.rejects(
    async () => {
      await provisionDesk(blockedYaml, {
        skillexRoot,
        home: fixtureHome,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Filesystem creation error for desk directory/);
      return true;
    },
    "Should report filesystem creation error if permission denied",
  );

  // Restore permissions so cleanup works
  chmodSync(readOnlyParent, 0o777);
  // ==========================================================================
  // Test 9: Persisted contract.yaml Schema Validity
  // ==========================================================================
  const persistedRaw = readFileSync(join(expectedDeskPath, "contract.yaml"), "utf8");
  const persistedParsed = parseNamedAgentYaml(persistedRaw);
  assert.equal(
    (persistedParsed as any).resolvedSkills,
    undefined,
    "Persisted contract.yaml must omit resolvedSkills",
  );
  // Must pass validateNamedAgentSchema without error
  const validatedPersisted = validateNamedAgentSchema(persistedParsed);
  assert.equal(validatedPersisted.id, "n8n-specialist");
  console.log("  ok: persisted contract.yaml parses and passes schema validation");

  // ==========================================================================
  // Test 10: options.deskRoot Isolation Override
  // ==========================================================================
  const isolatedDeskRoot = join(work, "isolated-desks");
  const isolatedResult = await provisionDesk(noDeskYaml, {
    deskRoot: isolatedDeskRoot,
    skillexRoot,
    home: fixtureHome,
  });
  const expectedIsolatedDesk = join(isolatedDeskRoot, "n8n-specialist");
  assert.equal(isolatedResult.deskPath, expectedIsolatedDesk);
  assert.ok(existsSync(join(expectedIsolatedDesk, ".agents", "skills", "n8n-workflow-design")));
  console.log("  ok: options.deskRoot overrides desk location when desk is omitted");

  // ==========================================================================
  // Test 11: Accurate dryRun Diff Counting
  // ==========================================================================
  // 11a. dryRun on new desk
  const dryNewRoot = join(work, "dry-run-new");
  const dryNew = await provisionDesk(validYaml, {
    deskRoot: dryNewRoot,
    skillexRoot,
    home: fixtureHome,
    dryRun: true,
  });
  assert.equal(dryNew.created, 2);
  assert.equal(dryNew.preserved, 0);
  assert.equal(dryNew.updated, 0);
  assert.equal(dryNew.removed, 0);
  assert.ok(!existsSync(dryNewRoot), "dryRun must not create directories");

  // 11b. dryRun on existing unchanged desk
  const dryExisting = await provisionDesk(updatedYaml, {
    skillexRoot,
    home: fixtureHome,
    dryRun: true,
  });
  assert.equal(dryExisting.created, 0);
  assert.equal(dryExisting.preserved, 2);
  assert.equal(dryExisting.updated, 0);
  assert.equal(dryExisting.removed, 0);

  // 11c. dryRun on existing desk with diffs (switching back to pack 1)
  const dryDiff = await provisionDesk(validYaml, {
    skillexRoot,
    home: fixtureHome,
    dryRun: true,
  });
  assert.equal(dryDiff.created, 1, "dryRun reports 1 to create (n8n-node-builder)");
  assert.equal(dryDiff.preserved, 1, "dryRun reports 1 to preserve (n8n-workflow-design)");
  assert.equal(dryDiff.removed, 1, "dryRun reports 1 to remove (n8n-community-nodes)");
  // Ensure dryRun did not mutate the existing directory
  assert.ok(existsSync(join(skillsDir, "n8n-community-nodes")), "dryRun must not mutate filesystem");
  assert.ok(!existsSync(join(skillsDir, "n8n-node-builder")), "dryRun must not mutate filesystem");
  console.log("  ok: dryRun accurately reports created, preserved, and removed diff counts");

  // ==========================================================================
  // Test 12: options.resolvedSkills Bypasses Catalog Resolution
  // ==========================================================================
  const explicitSkills = [
    { name: "n8n-workflow-design", path: join(skillexRoot, "all-skills", "n8n-workflow-design") },
  ];
  const explicitResult = await provisionDesk(
    {
      schema_version: 1,
      id: "explicit-agent",
      display_name: "Explicit Agent",
      role: "test-role",
      charter: { purpose: "Test explicit skills" },
      skills: { pack: "non-existent-pack-in-catalog" },
      memory: { write_bank: "agent-explicit-agent" },
    },
    {
      deskRoot: join(work, "explicit-desk"),
      resolvedSkills: explicitSkills,
      home: fixtureHome,
    },
  );
  assert.equal(explicitResult.created, 1);
  assert.ok(existsSync(join(explicitResult.skillsDir, "n8n-workflow-design")));
  console.log("  ok: options.resolvedSkills bypasses catalog pack resolution");

  // ==========================================================================
  // Test 13: Fail-Fast Validation Before Filesystem Mutation
  // ==========================================================================
  const failFastRoot = join(work, "fail-fast-desk");
  const invalidSkills = [
    { name: "missing-skill", path: join(skillexRoot, "all-skills", "non-existent-path") },
  ];
  await assert.rejects(
    async () => {
      await provisionDesk(
        {
          schema_version: 1,
          id: "fail-fast-agent",
          display_name: "Fail Fast",
          role: "test-role",
          charter: { purpose: "Test fail fast" },
          skills: { pack: "dummy" },
          memory: { write_bank: "agent-fail-fast-agent" },
        },
        {
          deskRoot: failFastRoot,
          resolvedSkills: invalidSkills,
          home: fixtureHome,
        },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Canonical skill "missing-skill" is missing SKILL\.md/);
      return true;
    },
  );
  assert.ok(!existsSync(failFastRoot), "Must not create desk directory on validation failure");
  console.log("  ok: pre-validation fails fast before mutating filesystem");

  console.log("named-agent-contract regressions: all assertions passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
