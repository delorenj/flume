// The paired Launch Director's composed charter delegates product copy review to
// that repo's policy; it never imports Gruvato-specific checks into another product.
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
  const identity = (repo, role = "paired-launch-director") => ({
    agentId: `${repo}-launch-director`, role, repo, displayName: `${repo} Launch Director`,
    profileName: `${repo}-launch-director`, purpose: "", botHandle: "", soulTone: "direct", projectBank: repo,
  });
  const actual = composeSoul(root, identity("gruvato")).text;
  const assertCopyGate = (text) => {
    assert.match(text, /before approving or\s+publishing any ad, post, video, page, store graphic or targeting list,\s+perform \*every numbered check\* in that policy against the exact final\s+artifact and associated targeting/);
    for (const name of ["launch-director-copy-gate.md", "asset-ledger.md", "claims.md"]) assert.ok(text.includes(`docs/marketing/${name}`));
    assert.match(text, /missing registers, missing\s+evidence, an unknown or a failed check mean HOLD, never silent approval/);
    assert.match(text, /Record the final artifact path\/hash, ledger and claims references, each\s+numbered verdict with evidence, reviewer, decision and later changes/);
    assert.match(text, /Re-review changed artifacts, builds, offers or\s+targeting/);
    assert.match(text, /This is copy review only: it grants no code-edit, dispatch,\s+merge, board-transition, spend or publication authority/);
  };
  assertCopyGate(actual);
  // Negative HOLD regression: a charter that permits approval with missing
  // proof must fail this source-contract assertion. This does not simulate an
  // LLM's live decision or claim to prove the project policy's 16 verdicts.
  const fixtureRoles = join(scratch, "roles");
  mkdirSync(fixtureRoles);
  for (const name of ["_base.md", "_tones.yaml", "paired-launch-director.md"]) {
    copyFileSync(join(root, "roles", name), join(fixtureRoles, name));
  }
  const fixtureRole = join(fixtureRoles, "paired-launch-director.md");
  const unsafeRole = readFileSync(fixtureRole, "utf8").replace(
    /missing registers, missing\s+evidence, an unknown or a failed check mean HOLD, never silent approval/,
    "missing registers, missing evidence, an unknown or a failed check may be approved");
  assert.notEqual(unsafeRole, readFileSync(fixtureRole, "utf8"), "negative fixture must alter the role source");
  writeFileSync(fixtureRole, unsafeRole);
  const unsafe = composeSoul(scratch, identity("gruvato")).text;
  assert.throws(() => assertCopyGate(unsafe), /missing registers, missing/);
  const role = readFileSync(join(root, "roles/paired-launch-director.md"), "utf8");
  for (const boundary of ["may_merge: false", "may_edit_code: false", "may_dispatch_workers: false", "may_transition_tickets: false"]) {
    assert.ok(role.includes(boundary));
  }
  assert.match(actual, /Never edit code, merge, dispatch workers/);

  const other = composeSoul(root, identity("another-product")).text;
  assert.match(other, /If the repo does\s+not supply that policy, do not import another product's copy rules/);
  assert.doesNotMatch(other, /Gruvato|template B|sixteen/);
  assert.doesNotMatch(composeSoul(root, identity("another-product", "dev")).text,
    /launch-director-copy-gate\.md/, "non-LD roles do not gain the policy pointer");
  console.log("paired-launch-director-copy-gate: source contract, negative HOLD mutation, composition and role-file boundaries passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
