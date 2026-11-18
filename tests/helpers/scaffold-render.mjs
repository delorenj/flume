// Fixture rendering of the pinned hermes-agent template, the way the scaffold
// observer renders it: Flume's own renderTemplate (simple substitution plus the
// string-equality if/else the sentinel prompt uses), proven byte-identical to
// Copier in tests/scaffold-conditional-regressions.mjs. A template that
// renderer refuses falls back to substituting the inputs it knows, which is
// what the fixtures did before the template grew a conditional.
import fs from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..");
const dir = fs.mkdtempSync(join(os.tmpdir(), "flume-scaffold-render-"));
const bundle = join(dir, "compare.mjs");
await build({ entryPoints: [join(root, "packages/flume-hr/src/scaffold/compare.ts")], outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
const { renderTemplate } = await import(pathToFileURL(bundle).href);
fs.rmSync(dir, { recursive: true, force: true });

export function renderFixtureTemplate(text, inputs) {
  const result = renderTemplate(text, inputs);
  if (result.ok) return result.text;
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gu, (whole, name) => (name in inputs ? inputs[name] : whole));
}
