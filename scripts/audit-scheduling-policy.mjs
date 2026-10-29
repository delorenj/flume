#!/usr/bin/env node
/** Read-only instruction coverage guard, not Candybar's runtime schedule linter. */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { canonicalPolicy, policySection } from "./lib/scheduling-policy.mjs";
export { canonicalPolicy, policySection, START, END } from "./lib/scheduling-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapping = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function auditSchedulingPolicy({ registry, fleetHome, policy = canonicalPolicy(root) }) {
  const document = YAML.parseDocument(readFileSync(registry, "utf8"), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid registry: ${document.errors[0].message}`);
  const agents = document.toJS()?.agents;
  if (!mapping(agents) || Object.keys(agents).length === 0) throw new Error("Registry must contain a non-empty agents mapping");
  const rows = Object.entries(agents).map(([id, row]) => {
    const result = { id, role: mapping(row) ? row.role ?? null : null,
      employment: mapping(row) ? row.employment ?? "post" : null,
      status: "unproven", profile: null, detail: "" };
    if (!mapping(row) || typeof row.profile_name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(row.profile_name)) {
      result.detail = "Invalid or missing profile_name; no profile inferred";
      return result;
    }
    result.profile = join(resolve(fleetHome), "profiles", row.profile_name, "SOUL.md");
    try {
      if (!statSync(result.profile).isFile()) throw new Error("SOUL.md is not a regular file");
      const bytes = readFileSync(result.profile, "utf8");
      result.soul_sha256 = digest(bytes);
      try {
        const seen = policySection(bytes);
        result.status = seen === policy ? "pass" : "drift";
        result.detail = seen === policy ? "Canonical instruction policy present; runtime scheduling not assessed" : "Scheduling-policy bytes differ from roles/_base.md";
      } catch (error) {
        result.status = "drift";
        result.detail = error.message;
      }
      if (result.employment === "portable-specialist" && result.status !== "pass") {
        result.detail += "; portable specialist needs an owning Flume onboarding refresh, not direct SOUL edits";
      }
    } catch (error) {
      result.detail = error.code === "ENOENT" ? "Profile SOUL.md missing" : error.message;
    }
    return result;
  });
  const counts = Object.fromEntries(["pass", "drift", "unproven"].map(status => [status, rows.filter(row => row.status === status).length]));
  return { ok: rows.every(row => row.status === "pass"), read_only: true, runtime_schedules_assessed: false,
    policy_source: "roles/_base.md", policy_sha256: digest(policy), registry: resolve(registry),
    audited: rows.length, counts, rows };
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--registry", "--fleet-home"].includes(key) || !args[i + 1] || args[i + 1].startsWith("--") || options[key]) {
      throw new Error("Usage: node scripts/audit-scheduling-policy.mjs [--registry FILE] [--fleet-home DIR]");
    }
    options[key] = args[++i];
  }
  const fleetHome = options["--fleet-home"] || process.env.HERMES_FLEET_HOME || join(process.env.HOME || homedir(), ".hermes");
  const registry = options["--registry"] || process.env.HERMES_AGENTS_REGISTRY || process.env.HERMES_FLEET_REGISTRY_FILE || join(fleetHome, "agents-registry.yaml");
  const report = auditSchedulingPolicy({ registry, fleetHome });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.log(JSON.stringify({ ok: false, read_only: true, error: error.message })); process.exitCode = 2; }
}
