// The composed SOUL names the Hindsight PROJECT bank. Banks are case-sensitive
// and every agent resolves its active bank as the basename of the repo's git
// toplevel, so the 33GOD PM must be told `33GOD` -- not the registry slug
// `33god`, which silently creates a new, empty bank.
//
// Bundles the composer from source with esbuild (no dist entry exports it).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "flume-soul-bank-"));
try {
  const entry = join(work, "entry.ts");
  writeFileSync(entry, `export { composeSoul, projectBankFor } from ${JSON.stringify(join(root, "packages/flume-hr/src/parity/rules.ts"))};\n`);
  // Emit inside node_modules so the external packages (yaml, skillex) resolve.
  const cache = join(root, "node_modules/.cache/flume-soul-bank");
  mkdirSync(cache, { recursive: true });
  const out = join(cache, `bundle-${process.pid}.mjs`);
  buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile: out, logLevel: "silent",
    nodePaths: [join(root, "node_modules"), join(root, "packages/flume-hr/node_modules")] });
  const { composeSoul, projectBankFor } = await import(pathToFileURL(out).href);

  // A checkout named with capitals, a role dir three levels down.
  const repo = join(work, "33GOD");
  const roleDir = join(repo, "agents/hermes/pm");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(roleDir, { recursive: true });
  assert.equal(projectBankFor(roleDir, "33god"), "33GOD", "bank is the git toplevel basename, case preserved");

  // A submodule carries a .git FILE; its own basename wins over the superproject's.
  const sub = join(repo, "bloodbank");
  mkdirSync(join(sub, "agents/hermes/pm"), { recursive: true });
  writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/bloodbank\n");
  assert.equal(projectBankFor(join(sub, "agents/hermes/pm"), "bb"), "bloodbank");

  // No checkout anywhere above: fall back to the registry slug.
  assert.equal(projectBankFor("/", "loose-slug"), "loose-slug");

  const identity = { agentId: "33god-pm", role: "pm", repo: "33god", displayName: "33GOD PM", profileName: "33god-pm", purpose: "", botHandle: "", soulTone: "", projectBank: "33GOD" };
  const { text } = composeSoul(root, identity);
  assert.match(text, /hindsight memory retain 33GOD "33god-pm: <fact>"/);
  assert.match(text, /hindsight memory recall 33GOD "<question>"/);
  assert.doesNotMatch(text, /hindsight memory (retain|recall) 33god /, "the slug must never name the bank");

  // Without a resolvable checkout the composer falls back to the slug rather than failing.
  const { text: fallback } = composeSoul(root, { ...identity, projectBank: undefined });
  assert.match(fallback, /hindsight memory retain 33god /);
  console.log("soul-project-bank: 7 assertions passed");
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(join(root, "node_modules/.cache/flume-soul-bank"), { recursive: true, force: true });
}
