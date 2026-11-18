// Exercise the interactive ingredient with a controlled prompt and an op executable
// that cannot reach a real vault. The rendered-script boundary is asserted separately.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(process.env.TMPDIR, "flume-40-"));
const calls = [];
const prompts = [];
const warnings = [];
let response;
let opResult;
let bundle;

try {
  const promptStub = join(work, "prompts.mjs");
  writeFileSync(promptStub, `export const text = globalThis.__flume40.text;
export const password = globalThis.__flume40.password;
export const confirm = globalThis.__flume40.confirm;
export const isCancel = globalThis.__flume40.isCancel;
export const log = globalThis.__flume40.log;
export const spinner = globalThis.__flume40.spinner;
`);
  const childStub = join(work, "child.mjs");
  writeFileSync(childStub, `export const spawnSync = globalThis.__flume40.spawnSync;\n`);
  bundle = join(root, "node_modules/.cache", `flume40-wire-${process.pid}.mjs`);
  mkdirSync(join(root, "node_modules/.cache"), { recursive: true });
  buildSync({ entryPoints: [join(root, "packages/flume-hr/src/hire/WireTelegram.ts")],
    bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle,
    alias: { "@clack/prompts": promptStub, "node:child_process": childStub }, logLevel: "silent" });
  globalThis.__flume40 = {
    text: async (options) => { prompts.push(options); return response; },
    password: () => { throw new Error("bot token flow unexpectedly prompted"); },
    confirm: () => { throw new Error("bot token persistence unexpectedly prompted"); },
    isCancel: (answer) => answer === Symbol.for("cancel"),
    log: { warn: (message) => warnings.push(message), info: () => {}, step: () => {} },
    spinner: () => ({ start: () => {}, stop: () => {} }),
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "op") return opResult;
      assert.equal(command, "bash");
      return { status: 0 };
    },
  };
  const { WireTelegram } = await import(pathToFileURL(bundle).href);
  const roleDir = join(work, "role");
  mkdirSync(join(roleDir, ".scripts"), { recursive: true });
  writeFileSync(join(roleDir, ".scripts/30-telegram.sh"), "#!/usr/bin/env bash\n");
  const context = { targetDir: work, targetRepo: "demo", role: "pm", roleDir };
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalAllowed = process.env.TELEGRAM_ALLOWED_USERS;
  process.env.TELEGRAM_BOT_TOKEN = "123456:synthetic-token";
  let count = 0;
  async function exercise(label, { override, read = { status: 0, stdout: "  987654321  \n" }, answer, skip = false, quiet = false, dryRun = false }) {
    calls.length = prompts.length = warnings.length = 0;
    opResult = read;
    response = answer;
    if (override === undefined) delete process.env.TELEGRAM_ALLOWED_USERS;
    else process.env.TELEGRAM_ALLOWED_USERS = override;
    const result = await new WireTelegram({ ...context, skipTelegram: skip, quiet, dryRun }).invoke();
    const idReads = calls.filter(({ command }) => command === "op");
    const scriptCalls = calls.filter(({ command }) => command === "bash");
    assert.ok(idReads.every(({ args }) => JSON.stringify(args) === JSON.stringify(["read", "op://DeLoSecrets/Telegram/id"])), label);
    count++;
    return { result, idReads, scriptCalls };
  }
  try {
    let run = await exercise("vault ID", {});
    assert.equal(run.result.success, true);
    assert.equal(run.idReads.length, 1);
    assert.equal(prompts.length, 0, "resolved ID suppresses user-ID question");
    assert.equal(run.scriptCalls[0].options.env.TELEGRAM_ALLOWED_USERS, "987654321");
    assert.equal(run.scriptCalls[0].options.env.TELEGRAM_BOT_TOKEN, "123456:synthetic-token");
    assert.equal(run.scriptCalls[0].options.cwd, roleDir);

    for (const [override, expected] of [["12345", "12345"], [" 111,222,333 ", "111,222,333"]]) {
      run = await exercise("explicit allow-list", { override });
      assert.equal(run.result.success, true);
      assert.equal(run.idReads.length, 0, "explicit allow-list must not read vault");
      assert.equal(prompts.length, 0);
      assert.equal(run.scriptCalls[0].options.env.TELEGRAM_ALLOWED_USERS, expected);
    }

    for (const [label, read] of [
      ["missing op", { status: null, error: new Error("ENOENT"), stdout: "" }],
      ["failed read", { status: 1, stdout: "" }],
      ["empty read", { status: 0, stdout: " \n" }],
      ["non-numeric read", { status: 0, stdout: "bot-name\n" }],
      ["comma-list read", { status: 0, stdout: "111,222\n" }],
    ]) {
      run = await exercise(label, { read, answer: " 333,444 " });
      assert.equal(run.result.success, true, label);
      assert.equal(run.idReads.length, 1, label);
      assert.equal(prompts.length, 1, label);
      assert.match(warnings.join(" "), /Could not resolve a numeric Telegram user id/, label);
      assert.equal(run.scriptCalls[0].options.env.TELEGRAM_ALLOWED_USERS, "333,444", label);
    }
    run = await exercise("invalid override", { override: "111,,222", answer: "555" });
    assert.equal(run.result.success, true);
    assert.equal(run.idReads.length, 1);
    assert.equal(run.scriptCalls[0].options.env.TELEGRAM_ALLOWED_USERS, "987654321");
    assert.equal(prompts.length, 0);
    assert.match(warnings.join(" "), /TELEGRAM_ALLOWED_USERS must be/);
    run = await exercise("invalid override and failed vault", { override: "111,,222", read: { status: 1, stdout: "" }, answer: "555" });
    assert.equal(run.result.success, true);
    assert.equal(prompts.length, 1);
    assert.equal(run.scriptCalls[0].options.env.TELEGRAM_ALLOWED_USERS, "555");

    run = await exercise("cancel", { read: { status: 1, stdout: "" }, answer: Symbol.for("cancel") });
    assert.equal(run.result.success, false);
    assert.match(run.result.message, /Aborted; Telegram step deferred/);
    assert.equal(run.scriptCalls.length, 0);

    run = await exercise("invalid manual answer", { read: { status: 1, stdout: "" }, answer: "bad" });
    assert.equal(run.result.success, false);
    assert.equal(run.scriptCalls.length, 0);
    assert.equal(prompts[0].validate("123,,456"), "comma-separated numeric ids");
    assert.equal(prompts[0].validate("123,456"), undefined);

    for (const mode of [{ skip: true }, { quiet: true }, { dryRun: true }]) {
      run = await exercise("no interactive vault read", mode);
      assert.equal(run.idReads.length, 0);
      assert.equal(run.scriptCalls.length, 0);
      assert.equal(prompts.length, 0);
    }
    console.log(`FLUME-40 controlled interactive hire: ${count} cases passed (exact ref, handoff, override, fallbacks, cancellation, skip/quiet/dry-run)`);
  } finally {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalAllowed === undefined) delete process.env.TELEGRAM_ALLOWED_USERS;
    else process.env.TELEGRAM_ALLOWED_USERS = originalAllowed;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  if (bundle) rmSync(bundle, { force: true });
}
