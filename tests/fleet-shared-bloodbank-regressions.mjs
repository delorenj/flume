import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = join(root, "packages", "flume-hr");
const read = (path) => readFileSync(join(pkg, path), "utf8");

const copier = read("src/hire/RunCopierTemplate.ts");
const summary = read("src/hire/PrintHermesSummary.ts");
const parity = read("src/parity/rules.ts");

assert.match(copier, /SKIP_BLOODBANK:\s*"1"/);
assert.doesNotMatch(summary, /consumer\.service/);
// The retired per-agent key names may appear ONLY in the LEGACY_SYSTEMD_KEYS
// constant that scopes detection/cleanup. Anywhere else means the legacy
// contract is being provisioned or recorded again.
assert.match(parity, /const LEGACY_SYSTEMD_KEYS = \["consumer_unit", "checkpoint_timer"\] as const;/);
assert.equal((parity.match(/consumer_unit/g) ?? []).length, 1, "consumer_unit may appear only inside LEGACY_SYSTEMD_KEYS");
assert.equal((parity.match(/checkpoint_timer/g) ?? []).length, 1, "checkpoint_timer may appear only inside LEGACY_SYSTEMD_KEYS");
assert.doesNotMatch(parity, /bloodbank-consumer\.py/);
assert.match(parity, /gateway_scope:\s*fleet/);
assert.match(parity, /target_agent_id:/);
assert.match(parity, /enabled:/);
// The registry-parity rule enforces the fleet-bloodbank standard on existing
// agents: audit flags drift, migrate converges it.
assert.match(parity, /must advertise bloodbank \{ gateway_scope: fleet/);
assert.match(parity, /normalize fleet bloodbank routing for/);
assert.match(parity, /retired per-agent consumer unit still on disk/);

// The portable-specialist writer must never force a quarantine again: a row
// it touches converges to {enabled, gateway_scope: fleet, target_agent_id:
// self} with an explicit false preserved. These static pins keep the old
// force-disabled projection from coming back unnoticed.
assert.doesNotMatch(read("src/workforce/specialist.ts"), /must have Bloodbank disabled/);
assert.match(read("src/workforce/specialist.ts"), /target_agent_id: p\.definition\.id/);
assert.match(read("src/workforce/specialist.ts"), /gateway_scope: "fleet"/);
// The bloodbank block must be written as a real YAML node (a plain object
// stored with setIn breaks every later per-leaf setIn: "Expected YAML
// collection"), and a present non-boolean enabled must refuse instead of
// coercing -- explicit quarantine survives, strict typing holds.
assert.match(read("src/workforce/specialist.ts"), /doc\.setIn\(\["agents", p\.definition\.id, "bloodbank"\], doc\.createNode\(wantedBloodbank\)\)/);
assert.match(read("src/workforce/specialist.ts"), /refusing to coerce/);
assert.match(read("src/workforce/specialist.ts"), /bloodbankContinuity\(p\)/);

console.log("fleet-shared Bloodbank provisioning regressions: ok");
