import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/flume-hr/dist/index.js");
const retired = ["canonical_skills_dir", "symlinked_runtime_skills", "pm_external_skill_dirs"];

function withConfig(run) {
  const scratch = mkdtempSync(join(tmpdir(), "flume-skill-config-"));
  const config = join(scratch, "config.toml");
  const env = { ...process.env, HOME: scratch, HERMES_TEMPLATE_CONFIG: config, HERMES_FLEET_ENV: join(scratch, "no-fleet.env"), NO_COLOR: "1" };
  const bootstrap = (...args) => spawnSync(process.execPath, [cli, "handbook", "bootstrap", ...args], { cwd: scratch, env, encoding: "utf8", timeout: 15000 });
  const parse = () => {
    const result = spawnSync("python3", ["-I", "-c", "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"], { input: readFileSync(config), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try { run({ scratch, config, bootstrap, parse }); } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("fresh bootstrap does not emit retired skill-writer keys", () => withConfig(({ bootstrap, parse }) => {
  const result = bootstrap();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const fleet = parse().fleet;
  for (const key of retired) assert.equal(Object.hasOwn(fleet, key), false, `retired fleet.${key} must not be emitted`);
}));

test("forced bootstrap retires only fleet skill keys, preserves operator bytes and is idempotent", () => withConfig(({ config, bootstrap, parse }) => {
  const operator = `# precious notes\n[operator]\ncanonical_skills_dir = "/keep"\nsymlinked_runtime_skills = ["keep"]\nnotes = '''\n[fleet]\npm_external_skill_dirs = ["payload, not config"]\n'''\n\n[fleet.custom]\ncanonical_skills_dir = "keep child table"\n`;
  assert.equal(bootstrap().status, 0);
  const current = readFileSync(config, "utf8");
  const expected = current.replace("[fleet]\n", `[fleet] # pinned binary is unrelated\ncustom_key = "keep"\n`).replace(/^hermes_bin = .*$/m, `hermes_bin = "/operator/hermes"`) + `\n${operator}`;
  writeFileSync(config, expected.replace("custom_key = \"keep\"\n", `custom_key = "keep"\n"canonical_skills_dir" = "/retired"\nsymlinked_runtime_skills = [\n  "retired", # closing ] inside comment\n  "other",\n]\n'pm_external_skill_dirs' = ["/retired"]\n`), { mode: 0o640 });
  chmodSync(config, 0o640);
  const before = readFileSync(config);
  const preview = bootstrap("--force", "--dry-run");
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.deepEqual(readFileSync(config), before);
  const result = bootstrap("--force");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const fleet = parse().fleet;
  for (const key of retired) assert.equal(Object.hasOwn(fleet, key), false, `retired fleet.${key} must be removed`);
  const text = readFileSync(config, "utf8");
  assert.equal(text, expected, "only retired assignments may change");
  assert.equal(statSync(config).mode & 0o777, 0o640);
  const stable = statSync(config);
  assert.equal(bootstrap("--force").status, 0);
  assert.equal(readFileSync(config, "utf8"), text);
  assert.equal(statSync(config).ino, stable.ino);
  assert.equal(statSync(config).mtimeMs, stable.mtimeMs);
}));
