// Launch mode is a capability of every PM, switched per repo by a committed
// `.launch.yaml`; it is not a role branch. The composed PM soul carries one
// `## Launch mode` section (inert without the declaration), and no other role
// gains it.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// External packages in the bundle resolve from the emitted module's location,
// so the bundle lives under the workspace, never TMPDIR.
const cache = join(root, "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, "flume-pm-launch-mode-"));
try {
  const entry = join(scratch, "entry.ts");
  writeFileSync(entry, `export { composeSoul } from ${JSON.stringify(join(root, "packages/flume-hr/src/parity/rules.ts"))};\n`);
  const out = join(scratch, "composer.mjs");
  buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile: out, logLevel: "silent" });
  const { composeSoul } = await import(pathToFileURL(out).href);
  const identity = (repo, role) => ({
    agentId: `${repo}-${role}`, role, repo, displayName: `${repo}-${role}`,
    profileName: `${repo}-${role}`, purpose: "", botHandle: "", soulTone: "direct", projectBank: repo,
  });

  /** The `## Launch mode` section of a composed soul, up to the next `## ` heading. */
  const section = (text) => {
    const match = /^## Launch mode\n([\s\S]*?)(?=^## )/mu.exec(text);
    return match ? match[1] : null;
  };

  const assertLaunchMode = (text, repo) => {
    assert.match(text, /\*\*Launch mode is declared, never guessed\*\*/, "prime directive rendered");
    const body = section(text);
    assert.ok(body, "pm soul has a ## Launch mode section");
    // Inert by default: the declaration file switches it, and absence means steady.
    assert.match(body, /committed `\.launch\.yaml` says `mode: launch`/);
    assert.match(body, /With no file, or `mode: steady`,\s+this section is inert/);
    // The rules absorbed from the Launch Director charter.
    assert.match(body, /\*\*One finish line:\*\* the declaration's `finish_line`, `contract` and `epic`/);
    assert.match(body, /If the repo has a Launch Director desk, apply its cut line and\s+leave\s+verdicts to it/);
    assert.match(body, /\*\*Todo holds only launch-critical work\*\*, owner-filed bugs on top/);
    assert.match(body, /Only\s+owner-filed High or Urgent bugs block the finish line/);
    assert.match(body, /\*\*His play is the gate; silence is approval\.\*\* Never ask Jarad to verify or\s+sign off/);
    assert.match(body, /reviewed ticket shipped in a published\s+build is accepted: close it, citing that build/);
    assert.match(body, /mobile-deploy-hub/);
    assert.match(body, /money, legal, passkey, product decisions\), each\s+with a recommendation and a default/);
    assert.match(body, /at most one short comment a day on the epic, only on change/);
    assert.match(body, /file one ticket proposing\s+`mode: steady`\. Never edit the declaration yourself/);
    // One clock (Candybar) and one board writer (the driver's --apply).
    assert.ok(body.includes(`Candybar fires the launch pass (\`${repo}-pm-launch-pass\`)`), "candybar manifest named per repo");
    assert.match(body, /`\.scripts\/launch-pass\.py --brief`/);
    assert.match(body, /`runtime\/launch-roadmap\.md`, under 40 lines/);
    assert.match(body, /`--apply <plan\.json>`, the pass's only board\s+writer/);
    assert.doesNotMatch(body, /\{\{|\}\}/, "no unrendered placeholder");
    const lines = body.trim().split("\n").length;
    assert.ok(lines <= 35, `launch mode section stays short (${lines} lines)`);
  };

  const pm = composeSoul(root, identity("earshot", "pm")).text;
  assertLaunchMode(pm, "earshot");
  // It lands inside the role body, before the shared conventions section.
  assert.ok(pm.indexOf("## Launch mode") < pm.indexOf("## DeloNet conventions you respect"));
  // Repo-agnostic: another repo's PM gets the same section with its own manifest name.
  assertLaunchMode(composeSoul(root, identity("another-product", "pm")).text, "another-product");

  // Only the PM charter carries it; a mode is not smeared across every role.
  for (const role of ["dev", "review", "em"]) {
    const text = composeSoul(root, identity("earshot", role)).text;
    assert.equal(section(text), null, `${role} soul has no Launch mode section`);
    assert.doesNotMatch(text, /\.launch\.yaml|launch-pass\.py|Launch mode is declared/, `${role} soul does not mention launch mode`);
  }

  // The structured half: behavior.launch_mode names the declaration and driver.
  const front = YAML.parse(readFileSync(join(root, "roles/pm.md"), "utf8").split(/^---$/mu)[1]);
  assert.deepEqual(front.behavior.launch_mode, { declaration: ".launch.yaml", driver: ".scripts/launch-pass.py" });

  // Negative mutation: a charter that lets the PM flip its own declaration fails.
  const fixtureRoles = join(scratch, "roles");
  mkdirSync(fixtureRoles);
  for (const name of ["_base.md", "_tones.yaml", "pm.md"]) copyFileSync(join(root, "roles", name), join(fixtureRoles, name));
  const fixtureRole = join(fixtureRoles, "pm.md");
  const original = readFileSync(fixtureRole, "utf8");
  const unsafe = original.replace(/file one ticket proposing\n  `mode: steady`\. Never edit the declaration yourself\./u,
    "set `mode: steady` in `.launch.yaml` yourself.");
  assert.notEqual(unsafe, original, "negative fixture must alter the role source");
  writeFileSync(fixtureRole, unsafe);
  assert.throws(() => assertLaunchMode(composeSoul(scratch, identity("earshot", "pm")).text, "earshot"), /mode: steady/);

  console.log("pm-launch-mode: pm section, prime directive, behavior key, per-repo manifest, non-pm exclusion and negative mutation passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
