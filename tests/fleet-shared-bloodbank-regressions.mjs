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

console.log("fleet-shared Bloodbank provisioning regressions: ok");
