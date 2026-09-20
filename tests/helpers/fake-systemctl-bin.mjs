// The scripted user manager the fleet suites observe instead of this host's.
//
// Spawned by the `systemctl` shim `installFakeSystemctl` writes onto a case's
// PATH. Everything it needs -- where its state, its invocation log, its
// recorded child environment and its sample counter live -- arrives as argv,
// NOT as environment: the observer hands its children an ALLOWLIST
// (`service_manifest.probe.env_allowlist` plus four pins), so a fake that
// needed an env key of its own could never be reached, and the recorded
// environment below is what proves the allowlist is the whole environment.
//
// Usage: node fake-systemctl-bin.mjs <shim-dir> --user <verb> [...]

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_SAMPLED_PROPERTY_FLOOR } from "./fake-systemctl.mjs";

const [shimDir, ...argv] = process.argv.slice(2);
const statePath = join(shimDir, "systemctl-state.json");
const logPath = join(shimDir, "systemctl-invocations.log");
const envPath = join(shimDir, "systemctl-child-env.log");
const counterPath = join(shimDir, "systemctl-sample.counter");

appendFileSync(logPath, `${JSON.stringify(argv)}\n`, "utf8");
appendFileSync(envPath, `${JSON.stringify({ argv, env: { ...process.env } })}\n`, "utf8");

/** A whole-millisecond sleep with no timers: the child must not exit before it has waited. */
function sleepMs(ms) {
  if (!(ms > 0)) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

let state;
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  process.stderr.write("fake systemctl: no state\n");
  process.exit(1);
}

function readCounter() {
  try { return Number.parseInt(readFileSync(counterPath, "utf8").trim(), 10) || 0; } catch { return 0; }
}

function bumpCounter() {
  writeFileSync(counterPath, String(readCounter() + 1), "utf8");
}

const NOT_FOUND = (unit) => ({
  Id: unit,
  Names: unit,
  LoadState: "not-found",
  LoadError: `org.freedesktop.systemd1.NoSuchUnit "Unit ${unit} not found."`,
  UnitFileState: "",
  ActiveState: "inactive",
  SubState: "dead",
  Result: "success",
  ExecMainStatus: "0",
  ExecMainCode: "0",
  ExecMainStartTimestampMonotonic: "0",
  ExecMainExitTimestampMonotonic: "0",
  TimeoutStartUSec: "1min 30s",
});

/** One unit's property map for THIS sample. An array is a per-sample script; an object is the same reading every time. */
function sampleOf(unit, index) {
  const entry = state.units?.[unit];
  if (entry === undefined) return null;
  if (!Array.isArray(entry)) return entry;
  if (entry.length === 0) return null;
  return entry[Math.min(index, entry.length - 1)];
}

/** A `*` / `?` glob over a unit name, the way `systemctl list-units 'hermes-*'` matches. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^\\0]*").replaceAll("?", "[^\\0]");
  return new RegExp(`^${escaped}$`, "u");
}

const positional = argv.filter((token) => !token.startsWith("-"));
const verb = positional[0] ?? "";
sleepMs(state.delay_ms ?? 0);

if (verb === "is-system-running") {
  sleepMs(state.manager?.delay_ms ?? 0);
  process.stdout.write(`${state.manager?.stdout ?? "running"}\n`);
  process.exit(state.manager?.exit ?? 0);
}

if (verb === "list-units" || verb === "list-unit-files") {
  // A scripted LISTING failure: the manager answers `is-system-running` and
  // then cannot list its units. `state.malformed` is the third shape (valid
  // exit, unparseable body); together they are the three codes `listFleet`
  // can produce with an available manager.
  const listing = state.listing ?? null;
  if (listing !== null) {
    sleepMs(listing.delay_ms ?? 0);
    if (typeof listing.exit === "number" && listing.exit !== 0) {
      process.stderr.write(`fake systemctl: scripted ${verb} failure\n`);
      process.exit(listing.exit);
    }
  }
  if (state.malformed === true) {
    process.stdout.write("{not json\n");
    process.exit(0);
  }
  const pattern = positional[1] ?? "*";
  const match = globToRegExp(pattern);
  const rows = verb === "list-units"
    ? (state.list_units ?? []).filter((row) => match.test(row.unit))
    : (state.unit_files ?? []).filter((row) => match.test(row.unit_file));
  process.stdout.write(`${JSON.stringify(rows)}\n`);
  process.exit(0);
}

if (verb === "show") {
  const at = argv.indexOf("-p");
  const properties = at === -1 ? [] : (argv[at + 1] ?? "").split(",").filter((name) => name !== "");
  const units = positional.slice(1);
  // The SAMPLED show is the one that advances the window; the classification
  // show over unregistered units asks for a narrower property set and must not
  // move a scripted unit on to its next reading. Told apart by the SIZE of the
  // requested set, never by one production property name: keying it on
  // `includes("NRestarts")` meant dropping that property from the observer
  // would have frozen every window at sample 0 with the suite still green.
  const sampled = properties.length > FAKE_SAMPLED_PROPERTY_FLOOR;
  const index = sampled ? readCounter() : Math.max(0, readCounter() - 1);
  const blocks = units.map((unit) => {
    const found = sampleOf(unit, index) ?? NOT_FOUND(unit);
    const map = { ...found, Id: found.Id ?? unit };
    const lines = [];
    for (const property of properties) {
      const value = map[property];
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) lines.push(`${property}=${item}`);
      else lines.push(`${property}=${value}`);
    }
    if (!properties.includes("Id")) lines.push(`Id=${map.Id}`);
    return lines.join("\n");
  });
  if (sampled) bumpCounter();
  process.stdout.write(`${blocks.join("\n\n")}\n`);
  process.exit(0);
}

// Any other verb is a MUTATION the observer must never reach for. It is logged
// above and refused here, so a suite asserting "no mutation verb was invoked"
// is asserting over a fake that would have obeyed one.
process.stderr.write(`fake systemctl: refusing unexpected verb ${verb}\n`);
process.exit(2);
