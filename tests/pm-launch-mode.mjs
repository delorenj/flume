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
    // Wrapping is not content: every phrase below is matched against the whitespace-collapsed section.
    const flat = body.replace(/\s+/gu, " ");
    // Inert by default: the declaration file switches it, and absence means steady.
    assert.match(flat, /committed `\.launch\.yaml` says `mode: launch`/);
    assert.match(flat, /With no file, or `mode: steady`,\s+this section is inert/);
    // The rules absorbed from the retired Launch Director charters: the PM is the whole launch desk.
    assert.match(flat, /\*\*One finish line:\*\* the declaration's `finish_line`, `contract` and `epic`/);
    assert.match(flat, /Hold the cut line:\*\* rank open work launch-critical, after-launch or cut/);
    assert.doesNotMatch(flat, /Launch Director desk|leave\s+verdicts to it/, "no clause defers to a Launch Director desk");
    assert.match(flat, /Review verdicts are yours/);
    assert.match(flat, /keep receipts current for the current candidate\s+with an agent observer, refresh them on deploy events, never reuse an expired receipt/);
    assert.match(flat, /UNKNOWN is\s+not PASS/);
    assert.match(flat, /record go on Jarad's behalf when every gate passes on agent evidence and no\s+owner-filed High or Urgent bug is open\. No-go comes only from Jarad/);
    // The copy gate: both policy names, every numbered check, missing evidence is HOLD.
    assert.match(flat, /`docs\/marketing\/launch-copy-gate\.md` \(or the older\s+`docs\/marketing\/launch-director-copy-gate\.md`; prefer the new name\)/);
    assert.match(flat, /perform every numbered\s+check in it against the exact final artifact and targeting before approving or publishing any\s+ad, post, video, page, store graphic or targeting list/);
    assert.match(flat, /`asset-ledger\.md`[\s\S]*`claims\.md`[\s\S]*is HOLD/);
    // Monorepo and readout.
    assert.match(flat, /files child work from the child's directory and joins\s+it to the epic \(`px epic add <epic> <ref>`\); it never edits child code/);
    assert.match(flat, /Monday's edition rolls\s+up the week/);
    assert.match(flat, /\*\*Todo holds only launch-critical work\*\*,\s+owner-filed bugs on top/);
    assert.match(flat, /Only\s+owner-filed High or Urgent bugs block the finish line/);
    assert.match(flat, /\*\*His play is the gate; silence is approval\.\*\* Never ask Jarad to verify or\s+sign off/);
    assert.match(flat, /reviewed ticket shipped in a published\s+build is accepted: close it, citing that build/);
    assert.match(flat, /mobile-deploy-hub/);
    assert.match(flat, /money, legal, passkey,\s+product decisions\), each with a recommendation and a default/);
    assert.match(flat, /at most one short comment a day on the epic, only on change/);
    assert.match(flat, /file one ticket proposing\s+`mode: steady`\. Never edit the declaration yourself/);
    // One clock (Candybar) and one board writer (the driver's --apply).
    assert.ok(flat.includes(`Candybar fires the launch pass (\`${repo}-pm-launch-pass\`)`), "candybar manifest named per repo");
    assert.match(flat, /`\.scripts\/launch-pass\.py --brief`/);
    assert.match(flat, /`runtime\/launch-roadmap\.md`, under 40 lines/);
    assert.match(flat, /`--apply <plan\.json>`, the pass's only board\s+writer/);
    assert.doesNotMatch(body, /\{\{|\}\}/, "no unrendered placeholder");
    const lines = body.trim().split("\n").length;
    assert.ok(lines <= 40, `launch mode section stays short (${lines} lines)`);
  };

  const pm = composeSoul(root, identity("earshot", "pm")).text;
  assertLaunchMode(pm, "earshot");
  // It lands inside the role body, before the shared conventions section.
  assert.ok(pm.indexOf("## Launch mode") < pm.indexOf("## DeloNet conventions you respect"));
  // Repo-agnostic: another repo's PM gets the same section with its own manifest name.
  assertLaunchMode(composeSoul(root, identity("another-product", "pm")).text, "another-product");

  // Only the PM charter carries it; a mode is not smeared across every role.
  for (const role of ["dev", "review", "reporter", "director"]) {
    const text = composeSoul(root, identity("earshot", role)).text;
    assert.equal(section(text), null, `${role} soul has no Launch mode section`);
    assert.doesNotMatch(text, /\.launch\.yaml|launch-pass\.py|Launch mode is declared/, `${role} soul does not mention launch mode`);
  }

  // Retired roles keep their file but never compose: a deployed desk's SOUL is never replaced by the notice.
  for (const role of ["launch-director", "paired-launch-director", "em"]) {
    assert.throws(() => composeSoul(root, identity("earshot", role)), (error) => error.name === "RetiredRoleError" && /retired/.test(error.message), `${role} refuses to compose`);
    assert.doesNotMatch(readFileSync(join(root, "roles", `${role}.md`), "utf8"), /prime_directives|board_scope|## Your six responsibilities/, `${role}.md is a notice, not a charter`);
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
  const unsafe = original.replace(/file one ticket proposing `mode: steady`\.\n  Never edit the declaration yourself\./u,
    "set `mode: steady` in `.launch.yaml` yourself.");
  assert.notEqual(unsafe, original, "negative fixture must alter the role source");
  writeFileSync(fixtureRole, unsafe);
  assert.throws(() => assertLaunchMode(composeSoul(scratch, identity("earshot", "pm")).text, "earshot"), /mode: steady/);

  console.log("pm-launch-mode: pm section, prime directive, behavior key, per-repo manifest, non-pm exclusion and negative mutation passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
