/**
 * Probing the project contracts a hire depends on.
 *
 * pjangler owns the project rules; Flume owns the employee rules. Before this
 * split, `HermesAgentRecipe` imported `createMiseChecks()` and
 * `createProjectChecks()` directly and failed an agent deployment on a project
 * finding -- one recipe reaching across the boundary to audit the other side's
 * contract.
 *
 * Flume asks instead. `pj audit --rules <ids> --json` reports exactly those
 * rules, and an unknown id is an error there rather than an empty pass, so a
 * probe can never read "clean" when the real answer is "never checked".
 *
 * Critically, this is NOT a hard dependency. If `pj` is absent the probe
 * reports `unableToAssess` and the hire continues. Flume must never require
 * pjangler to be installed -- that is the cycle this whole split exists to
 * break, and rebuilding it in the opposite direction would be no better.
 */

import { spawnSync } from "node:child_process";
import type { Standing } from "@delorenj/flume-core";

/** The project contracts a hire changes or depends on. */
export const HIRE_PROJECT_CONTRACTS = ["mise.config-root", "sot.project-json"] as const;

export interface ProjectContractProbe {
  standing: Standing;
  /** One line per rule that did not pass, or per reason the probe could not run. */
  details: string[];
}

interface AuditJson {
  ok?: unknown;
  rules?: unknown;
}

export function probeProjectContracts(
  repoRoot: string,
  ruleIds: readonly string[] = HIRE_PROJECT_CONTRACTS,
  env: NodeJS.ProcessEnv = process.env,
): ProjectContractProbe {
  const bin = env.PJANGLER_BIN?.trim() || "pj";
  const result = spawnSync(bin, ["audit", repoRoot, "--rules", ruleIds.join(","), "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });

  if (result.error || result.status === null) {
    return {
      standing: "unableToAssess",
      details: [`project contract probe could not run \`${bin} audit\`: ${result.error?.message ?? "no exit status"}`],
    };
  }

  let parsed: AuditJson;
  try {
    parsed = JSON.parse(result.stdout) as AuditJson;
  } catch {
    return {
      standing: "unableToAssess",
      details: [`project contract probe could not parse \`${bin} audit --json\` output`],
    };
  }

  const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
  const reported = new Set(
    rules.map((r) => (r && typeof r === "object" ? String((r as { id?: unknown }).id ?? "") : "")),
  );
  const unreported = ruleIds.filter((id) => !reported.has(id));
  if (unreported.length) {
    return {
      standing: "unableToAssess",
      details: [`project contract probe got no answer for: ${unreported.join(", ")}`],
    };
  }

  const failed = rules.filter((r) => {
    if (!r || typeof r !== "object") return false;
    const status = String((r as { status?: unknown }).status ?? "");
    return status !== "pass" && status !== "skip";
  });
  if (failed.length === 0) return { standing: "inGoodStanding", details: [] };

  return {
    standing: "onNotice",
    details: failed.map((r) => {
      const o = r as { id?: unknown; summary?: unknown };
      return `${String(o.id ?? "?")}: ${String(o.summary ?? "failed")}`;
    }),
  };
}
