// The composed SOUL names the Hindsight PROJECT bank. It must be the bank the
// memory hooks write (~/.claude/hooks/lib/hindsight-bank.sh: override file,
// origin remote name, checkout basename). Banks are case-sensitive: telling the
// 33GOD PM `33god` (the registry slug) silently creates a new, empty bank.
//
// Bundles the composer from source with esbuild (no dist entry exports it).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";

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

  const git = (cwd, ...args) => {
    const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  };
  const checkout = (name) => {
    const dir = join(work, name);
    mkdirSync(join(dir, "agents/hermes/pm"), { recursive: true });
    git(dir, "init", "-q");
    return dir;
  };

  // 4. No remote: the checkout root's basename, case preserved.
  const bare = checkout("33GOD");
  assert.equal(projectBankFor(join(bare, "agents/hermes/pm"), "33god"), "33GOD");

  // 3. The origin remote's repo name wins over the directory name (~/docker -> DeLoContainers).
  const docker = checkout("docker");
  git(docker, "remote", "add", "origin", "git@github.com:delorenj/DeLoContainers.git");
  assert.equal(projectBankFor(join(docker, "agents/hermes/pm"), "delocontainers"), "DeLoContainers");
  const https = checkout("keepy");
  git(https, "remote", "add", "origin", "https://github.com/delorenj/keepy-money");
  assert.equal(projectBankFor(join(https, "agents/hermes/pm"), "x"), "keepy-money");

  // 1. An explicit .hindsight/bank override beats the remote; comments and blanks are skipped.
  mkdirSync(join(docker, ".hindsight"));
  writeFileSync(join(docker, ".hindsight/bank"), "# routed by hand\n docker \n");
  assert.equal(projectBankFor(join(docker, "agents/hermes/pm"), "x"), "docker");

  // Outside any checkout: the registry slug.
  const loose = join(work, "loose");
  mkdirSync(loose);
  assert.equal(projectBankFor(loose, "loose-slug"), "loose-slug");

  const identity = { agentId: "33god-pm", role: "pm", repo: "33god", displayName: "33GOD PM", profileName: "33god-pm", purpose: "", botHandle: "", soulTone: "", projectBank: "33GOD" };
  const { text } = composeSoul(root, identity);
  assert.match(text, /hindsight memory retain 33GOD "33god-pm: <fact>"/);
  assert.match(text, /hindsight memory recall 33GOD "<question>"/);
  assert.doesNotMatch(text, /hindsight memory (retain|recall) 33god /, "the slug must never name the bank");

  // Without a resolvable checkout the composer falls back to the slug rather than failing.
  const { text: fallback } = composeSoul(root, { ...identity, projectBank: undefined });
  assert.match(fallback, /hindsight memory retain 33god /);
  console.log("soul-project-bank: all assertions passed");
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(join(root, "node_modules/.cache/flume-soul-bank"), { recursive: true, force: true });
}
