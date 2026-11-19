#!/usr/bin/env node
/** Read-only instruction coverage guard, not Candybar's runtime schedule linter. */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import YAML, { isMap, isScalar } from "yaml";
import roleSchema from "../contracts/role.schema.json" with { type: "json" };
import { canonicalPolicy, policySection } from "./lib/scheduling-policy.mjs";
import { readAuditText } from "./lib/read-audit-text.mjs";
export { canonicalPolicy, policySection, START, END } from "./lib/scheduling-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapping = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const rolePattern = new RegExp(roleSchema.properties.role.pattern, "u");

export function auditSchedulingPolicy({ registry, fleetHome }) {
  const policy = canonicalPolicy(root);
  const document = YAML.parseDocument(readAuditText(registry, 4 * 1024 * 1024), { uniqueKeys: true });
  if (document.errors.length) throw new Error("Invalid registry YAML");
  const rawAgents = document.get("agents", true);
  if (!isMap(rawAgents) || rawAgents.items.some(({ key }) => !isScalar(key) || typeof key.value !== "string")) {
    throw new Error("Registry agents must be a mapping with string employee keys");
  }
  const agents = document.toJS({ maxAliasCount: 100 })?.agents;
  if (!mapping(agents) || Object.keys(agents).length === 0 || Object.keys(agents).length !== rawAgents.items.length) {
    throw new Error("Registry must contain a non-empty agents mapping without lost employee keys");
  }
  const profiles = new Map();
  for (const row of Object.values(agents)) if (mapping(row) && typeof row.profile_name === "string") {
    profiles.set(row.profile_name, (profiles.get(row.profile_name) ?? 0) + 1);
  }
  const rows = Object.entries(agents).map(([id, row]) => {
    const result = { id, role: mapping(row) && typeof row.role === "string" ? row.role : null,
      employment: mapping(row) && (row.employment === undefined || typeof row.employment === "string") ? row.employment ?? "post" : null,
      status: "unproven", profile: null, detail: "" };
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id) || !mapping(row) || typeof row.profile_name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(row.profile_name)) {
      result.detail = "Invalid employee id or profile_name; no profile inferred";
      return result;
    }
    if (typeof row.role !== "string" || !rolePattern.test(row.role) ||
        (row.employment !== undefined && !["post", "portable-specialist"].includes(row.employment))) {
      result.detail = "Invalid or missing role/employment; coverage unproven";
      return result;
    }
    if (profiles.get(row.profile_name) !== 1) {
      result.detail = "Duplicate profile_name; employee instruction coverage is ambiguous";
      return result;
    }
    result.profile = join(resolve(fleetHome), "profiles", row.profile_name, "SOUL.md");
    try {
      const bytes = readAuditText(result.profile);
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
    running_sessions_assessed: false, coverage_scope: "registered-profile-soul-policy-bytes",
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
