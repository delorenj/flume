// The PM's Launch mode section carries the copy gate the retired paired Launch Director held:
// product copy review is delegated to the repo's own policy (the new or the old file name), every
// numbered check runs against the exact final artifact, missing evidence is HOLD, and no product's
// checks are imported into another. A negative mutation proves the assertion would catch a charter
// that approves with missing proof.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// External packages in the bundle (yaml, ajv, etc.) resolve from the emitted
// module's location. A bundle under TMPDIR cannot resolve workspace packages.
const cache = join(root, "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, "flume-launch-copy-"));
try {
  const entry = join(scratch, "entry.ts");
  writeFileSync(entry, `export { composeSoul } from ${JSON.stringify(join(root, "packages/flume-hr/src/parity/rules.ts"))};\n`);
  const out = join(scratch, "composer.mjs");
  buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile: out, logLevel: "silent" });
  const { composeSoul } = await import(pathToFileURL(out).href);
  const identity = (repo, role = "pm") => ({
    agentId: `${repo}-${role}`, role, repo, displayName: `${repo} PM`,
    profileName: `${repo}-${role}`, purpose: "", botHandle: "", soulTone: "direct", projectBank: repo,
  });
  const flatten = (text) => text.replace(/\s+/gu, " ");
  const actual = flatten(composeSoul(root, identity("gruvato")).text);
  const assertCopyGate = (text) => {
    // Both policy names, the new one preferred.
    assert.match(text, /`docs\/marketing\/launch-copy-gate\.md` \(or the older `docs\/marketing\/launch-director-copy-gate\.md`; prefer the new name\)/);
    assert.match(text, /perform every numbered check in it against the exact final artifact and targeting before approving or publishing any ad, post, video, page, store graphic or targeting list/);
    for (const name of ["asset-ledger.md", "claims.md"]) assert.ok(text.includes(`\`${name}\``), `${name} named`);
    assert.match(text, /missing evidence, an unknown or a failed check is HOLD/);
    assert.match(text, /Record artifact hash, each verdict with evidence, and the decision; re-review any change/);
    assert.match(text, /Copy review only: no spend or publication authority\. Without that policy, import no one's rules/);
  };
  assertCopyGate(actual);

  // Negative HOLD regression: a charter that permits approval with missing proof must fail this
  // source-contract assertion. It does not simulate an LLM's live decision.
  const fixtureRoles = join(scratch, "roles");
  mkdirSync(fixtureRoles);
  for (const name of ["_base.md", "_tones.yaml", "pm.md"]) copyFileSync(join(root, "roles", name), join(fixtureRoles, name));
  const fixtureRole = join(fixtureRoles, "pm.md");
  const original = readFileSync(fixtureRole, "utf8");
  const unsafeRole = original.replace(/missing evidence, an unknown or a failed check is HOLD/u, "missing evidence, an unknown or a failed check may be approved");
  assert.notEqual(unsafeRole, original, "negative fixture must alter the role source");
  writeFileSync(fixtureRole, unsafeRole);
  assert.throws(() => assertCopyGate(flatten(composeSoul(scratch, identity("gruvato")).text)), /is HOLD/);

  // The PM is still the PM: it delegates every code change and never merges, whatever the copy gate says.
  const role = readFileSync(join(root, "roles/pm.md"), "utf8");
  assert.match(role, /delegate_all_code_changes: true/);
  assert.match(role, /You do not approve merges/);

  // No product's checks leak into another repo's soul.
  const other = flatten(composeSoul(root, identity("another-product")).text);
  assert.doesNotMatch(other, /Gruvato|template B|sixteen/);
  assert.doesNotMatch(composeSoul(root, identity("another-product", "dev")).text, /launch-copy-gate\.md|launch-director-copy-gate\.md/, "non-PM roles do not gain the policy pointer");
  console.log("pm-launch-copy-gate: source contract, negative HOLD mutation, composition and role boundaries passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
