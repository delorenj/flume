#!/usr/bin/env node
// The flume test runner.
//
// It exists because `npm test` used to be one `a && b && c && ...` chain. A
// single red suite short-circuits the shell, so every suite listed after it
// never runs at all -- and a run that stops at the first failure cannot tell
// you whether you broke one thing or twelve. Every suite here is attempted on
// every run; the exit code and the closing summary are decided afterwards from
// the collected results.
//
// Typecheck is the one exception and runs first as a hard gate. `npm run build`
// bundles with esbuild --packages=external, which never typechecks, so a file
// that cannot compile still produces a clean dist. Suites exercise that dist,
// so running them against un-typechecked source reports fiction.
//
// Usage:
//   node scripts/run-tests.mjs                     # everything
//   node scripts/run-tests.mjs fleet-status pjan-48  # only suites matching a filter
//   node scripts/run-tests.mjs --list              # print the suite list and exit
//   node scripts/run-tests.mjs --no-typecheck      # skip the typecheck gate (debugging only)
//   node scripts/run-tests.mjs --no-build          # skip the rebuild (debugging only)

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Wall-clock ceiling for one suite. A hang must not wedge the whole run. */
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Suites whose failure is reported loudly but does not fail the run.
 *
 * Keyed by suite name, valued by the reason plus what a real fix requires.
 * This is for a failure that is genuinely environmental -- something this host
 * cannot satisfy -- never for a suite that is merely inconvenient. A quarantined
 * suite still executes on every run and still prints its full output on failure.
 * Empty is the correct steady state; anything in here is a debt with an owner.
 */
const QUARANTINED = new Map([
  // ["some-suite", "why it cannot pass here + what a fix requires"],
]);

/**
 * Every regression suite, in execution order.
 *
 * This list is the single source of truth. package.json's `test` script is a
 * one-line delegation to this file precisely so a new suite is added in one
 * place and can never be silently dropped from the chain.
 */
const SUITES = [
  "tests/engagement-regressions.mjs",
  "tests/fleet-shared-bloodbank-regressions.mjs",
  "tests/hermes-profile-inheritance-regressions.mjs",
  "tests/pjan-48-regressions.mjs",
  "tests/fleet-contract-regressions.mjs",
  "tests/fleet-inventory-regressions.mjs",
  "tests/fleet-provenance-regressions.mjs",
  "tests/fleet-status-regressions.mjs",
  "tests/fleet-health-regressions.mjs",
  "tests/fleet-scaffold-regressions.mjs",
  "tests/soul-project-bank-regressions.mjs",
  "tests/fleet-profile-regressions.mjs",
  "tests/fleet-systemd-regressions.mjs",
  "tests/pjan-86-hermes-deploy-regressions.mjs",
];

const args = process.argv.slice(2);
const filters = args.filter((arg) => !arg.startsWith("-"));
const listOnly = args.includes("--list");
const skipTypecheck = args.includes("--no-typecheck");
const skipBuild = args.includes("--no-build");

/** A step is selected when it has no filters to satisfy or matches one. */
const selects = (name) => filters.length === 0 || filters.some((f) => name.includes(f));

const steps = SUITES.filter((script) => selects(script)).map((script) => ({
  name: script.replace(/^tests\//, "").replace(/\.mjs$/, ""),
  script,
  kind: "suite",
}));

if (listOnly) {
  for (const step of steps) console.log(`suite  ${step.name}`);
  console.log(`\n${steps.length} step(s)`);
  process.exit(0);
}

const duration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

if (!skipTypecheck) {
  process.stdout.write("gate  typecheck ... ");
  const started = Date.now();
  const typecheck = spawnSync("npm", ["run", "typecheck"], { cwd: root, encoding: "utf8" });
  if (typecheck.status !== 0) {
    console.log(`FAIL (${duration(Date.now() - started)})`);
    process.stdout.write(typecheck.stdout ?? "");
    process.stderr.write(typecheck.stderr ?? "");
    console.error(
      "\ntypecheck failed. It is a hard gate: esbuild bundles without typechecking, so\n" +
        "every suite below would run against a dist that does not match this source.\n" +
        "No suite was attempted.",
    );
    process.exit(1);
  }
  console.log(`ok (${duration(Date.now() - started)})`);
}

// Typecheck proves the SOURCE compiles. It does not put that source into
// packages/*/dist, and every suite below runs that dist. Without this, a stale
// bundle lets every suite pass while certifying code that is no longer in the
// tree -- the run reports fiction just as loudly as an un-typechecked one does,
// and says so just as confidently.
if (!skipBuild) {
  process.stdout.write("gate  build ... ");
  const started = Date.now();
  const build = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) {
    console.log(`FAIL (${duration(Date.now() - started)})`);
    process.stdout.write(build.stdout ?? "");
    process.stderr.write(build.stderr ?? "");
    console.error("\nbuild failed. Every suite below runs dist/, so none was attempted.");
    process.exit(1);
  }
  console.log(`ok (${duration(Date.now() - started)})`);
}

/**
 * A regression suite must never carry the operator's production credentials.
 *
 * Blanking the ticket-provider credentials here makes the whole suite hermetic
 * by construction -- the adapter is unreachable, so anything that would reach
 * for a board takes its no-credential path instead of creating a real one.
 *
 * `TMPDIR=/tmp` is NOT a convenience. Several suites build a fixture package
 * root under TMPDIR and resolve it against the running CLI; on this host the
 * inherited TMPDIR sits under the real home, which puts the fixture inside a
 * checkout and makes the host answer for it.
 */
const HERMETIC_ENV = {
  PYTHONDONTWRITEBYTECODE: "1",
  TMPDIR: "/tmp",
  PLANE_API_KEY: "",
  PLANE_DEFAULT_API_KEY: "",
  PLANE_33GOD_API_KEY: "",
  PLANE_AUTOMATICAI_API_KEY: "",
  PLANE_INTELLIFORIA_API_KEY: "",
  PLANE_LASERTOAST_API_KEY: "",
  TRELLO_KEY: "",
  TRELLO_API_KEY: "",
  TRELLO_TOKEN: "",
  HERMES_FLEET_ENV: join(root, "scripts", "no-such-fleet.env"),
};

const results = [];
for (const [index, step] of steps.entries()) {
  const label = `[${String(index + 1).padStart(2)}/${steps.length}] ${step.name}`;
  process.stdout.write(`${label} ... `);
  const started = Date.now();
  const run = spawnSync(process.execPath, [step.script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...HERMETIC_ENV },
    timeout: SUITE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsed = Date.now() - started;
  const timedOut = run.error && run.error.code === "ETIMEDOUT";
  const ok = !run.error && run.status === 0;
  const quarantined = QUARANTINED.has(step.name);
  const status = ok ? "PASS" : timedOut ? "TIMEOUT" : "FAIL";
  console.log(`${status}${!ok && quarantined ? " (quarantined)" : ""} (${duration(elapsed)})`);
  if (!ok) {
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    if (run.error && !timedOut) console.error(String(run.error.message));
  }
  results.push({ ...step, status, ok, quarantined, elapsed });
}

const failed = results.filter((r) => !r.ok && !r.quarantined);
const quarantineFailures = results.filter((r) => !r.ok && r.quarantined);
const passed = results.filter((r) => r.ok);
const total = results.reduce((sum, r) => sum + r.elapsed, 0);

console.log(`\n${"=".repeat(72)}`);
console.log(
  `SUMMARY  attempted ${results.length}  passed ${passed.length}  failed ${failed.length}` +
    `  quarantined-failing ${quarantineFailures.length}  (${duration(total)})`,
);
console.log("=".repeat(72));

for (const result of quarantineFailures) {
  console.log(`QUARANTINED FAIL  ${result.name}`);
  console.log(`                  ${QUARANTINED.get(result.name)}`);
}
for (const result of failed) console.log(`${result.status.padEnd(8)}  ${result.name}`);

if (failed.length === 0) {
  console.log(
    quarantineFailures.length === 0
      ? "All suites passed."
      : "All non-quarantined suites passed. The quarantined failures above are still real debt.",
  );
}
process.exit(failed.length === 0 ? 0 : 1);
