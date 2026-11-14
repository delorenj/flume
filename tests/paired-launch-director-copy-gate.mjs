// The paired Launch Director's composed charter delegates product copy review to
// that repo's policy; it never imports Gruvato-specific checks into another product.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "flume-launch-copy-"));
try {
  const entry = join(scratch, "entry.ts");
  writeFileSync(entry, `export { composeSoul } from ${JSON.stringify(join(root, "packages/flume-hr/src/parity/rules.ts"))};\n`);
  const out = join(scratch, "composer.mjs");
  buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile: out, logLevel: "silent", nodePaths: [join(root, "node_modules")] });
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  const { composeSoul } = await import(pathToFileURL(out).href);
  const identity = (repo, role = "paired-launch-director") => ({
    agentId: `${repo}-launch-director`, role, repo, displayName: `${repo} Launch Director`,
    profileName: `${repo}-launch-director`, purpose: "", botHandle: "", soulTone: "direct", projectBank: repo,
  });
  const actual = composeSoul(root, identity("gruvato")).text;
  assert.match(actual, /perform \*every numbered check\* in that policy against the exact final/);
  for (const name of ["launch-director-copy-gate.md", "asset-ledger.md", "claims.md"]) assert.ok(actual.includes(`docs/marketing/${name}`));
  assert.match(actual, /missing\s+evidence, an unknown or a failed check mean HOLD/);
  assert.match(actual, /Record the final artifact path\/hash, ledger and claims references, each/);
  assert.match(actual, /This is copy review only: it grants no code-edit, dispatch,/);
  for (const boundary of ["may_merge: false", "may_edit_code: false", "may_dispatch_workers: false", "may_transition_tickets: false"]) {
    assert.ok(readFileSync(join(root, "roles/paired-launch-director.md"), "utf8").includes(boundary));
  }
  assert.match(actual, /Never edit code, merge, dispatch workers/);

  const other = composeSoul(root, identity("another-product")).text;
  assert.match(other, /If the repo does\s+not supply that policy, do not import another product's copy rules/);
  assert.doesNotMatch(other, /Gruvato|template B|sixteen/);
  assert.doesNotMatch(composeSoul(root, identity("another-product", "dev")).text,
    /launch-director-copy-gate\.md/, "non-LD roles do not gain the policy pointer");
  console.log("paired-launch-director-copy-gate: 16-source-checks, role composition and boundaries passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
