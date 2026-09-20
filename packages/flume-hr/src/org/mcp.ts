// The MCP half of the fleet observation surface.
//
// It lives here rather than in `src/mcp-server.ts` for one reason: the story's
// hard claim is that CLI and MCP are two THIN adapters over one core, adding
// envelope wrapping and `next_actions` guidance and nothing else -- no extra
// option, no different default, no alternate policy. That claim is only worth
// making if it is inspectable, and a reviewer can read this file end to end in a
// minute and see that every handler does exactly three things: shape arguments,
// call the shared core, wrap the result.
//
// `asText` is passed IN rather than imported. `src/mcp-server.ts` runs
// `await server.connect(new StdioServerTransport())` at module scope, so
// importing anything from it would start a server as a side effect of loading
// this module. Cloning the helper instead would give the tool surface two result
// shapes, which is the thing the shared helper exists to prevent.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectFleetInventory } from "./inventory";
import {
  fleetFailureEnvelope,
  fleetSuccessEnvelope,
  normalizeFleetError,
  type FleetEnvelopeV1,
} from "./output";
import { collectFleetProvenance } from "./provenance";
import { createRunContext, type FleetRunContext } from "./runtime";
import { collectFleetStatus } from "./status";
import { FLEET_STATUS_DOMAINS, FleetError, type FleetInventory, type FleetProvenance, type FleetStatus } from "./types";

const INVENTORY_COMMAND = "fleet.inventory";
const PROVENANCE_COMMAND = "fleet.provenance";
const STATUS_COMMAND = "fleet.status";

/**
 * The shared flag surface, one-for-one with the CLI's.
 *
 * `z.strictObject` matches the rest of the tool catalog: an unknown top-level
 * argument is rejected at the protocol boundary, before the handler can read any
 * state. A misspelled `deadline_ms` must fail loudly rather than be silently
 * dropped into an unbounded run.
 */
const FLEET_TOOL_INPUT = {
  agent: z.string().optional().describe("Report only this agent; totals and the verdict still describe the whole fleet."),
  projectRegistry: z.string().optional().describe("Inspect this project registry instead of the configured one. Never rewrites the configured path."),
  agentRegistry: z.string().optional().describe("Inspect this agent registry instead of the configured one."),
  contract: z.string().optional().describe("Validate and read this fleet contract instead of the tracked one."),
  deadlineMs: z.number().int().positive().optional().describe("Fail with TIMEOUT if the whole run has not finished within this budget."),
} as const;

interface FleetToolArgs {
  agent?: string;
  projectRegistry?: string;
  agentRegistry?: string;
  contract?: string;
  deadlineMs?: number;
  /** `fleet status` only. Rejected by the other two tools at the protocol boundary. */
  domain?: string;
  /** `fleet status` only. Authorizes bounded, read-only host and network observation. */
  live?: boolean;
  /** `fleet status` only. A prior status document to correlate this run against. */
  baseline?: string;
  /**
   * `fleet status` only, and deliberately INERT here.
   *
   * The CLI projects `data.health.exit_category` onto a process exit; a tool
   * call has no process to exit. It is accepted so the two adapters expose one
   * option surface -- an option the CLI has and the tool does not is how they
   * stop being one command -- and it changes nothing in `data`, which is what
   * keeps the deep-equality assertion meaningful.
   */
  exitCode?: boolean;
}

/**
 * What every fleet core accepts. One shape, so the adapter cannot become the
 * place a tool grows an option its CLI twin does not have.
 *
 * `domain` and `live` are optional here and ignored by the two cores that do not
 * declare them -- widened from the inventory/provenance shape this was hardcoded
 * to, which would otherwise have forced `fleet status` to be dispatched through
 * a second, near-identical wrapper.
 */
interface FleetToolCollectInput {
  agentId?: string;
  projectRegistry?: string;
  agentRegistry?: string;
  contract?: string;
  domain?: string;
  live?: boolean;
  baseline?: string;
  runContext: FleetRunContext;
}

/**
 * The CLI's `requireValue` guard, asked of an MCP argument.
 *
 * Zod already rejects a non-string, but not an empty or option-shaped one. The
 * CLI refuses both, and an adapter that accepted what its twin refuses would not
 * be the same command.
 */
function requireValue(value: string | undefined, flag: string): void {
  if (value === undefined) return;
  if (value.trim() === "") throw new FleetError("INVALID_INPUT", `${flag} was given an empty value`);
  if (value.startsWith("--")) throw new FleetError("INVALID_INPUT", `${flag} was given an option, not a value`);
}

/**
 * The server, by type only.
 *
 * A type import is erased at build time, so this module still never causes
 * `src/mcp-server.ts` -- which connects a stdio transport at module scope -- to
 * be loaded. The handler signature the SDK infers is `(args: unknown, extra)`,
 * so each handler narrows its own arguments; `z.strictObject` has already
 * rejected anything that is not this shape at the protocol boundary.
 */
type ToolHost = Pick<McpServer, "registerTool">;

type AsText = (payload: unknown) => { content: Array<{ type: "text"; text: string }> };

/**
 * Run one fleet command and wrap whatever it produced.
 *
 * The ONLY thing this adds over the core: the envelope, and the `next_actions`
 * guidance the CLI writes for the same case. `extra.signal` becomes the run
 * context's cancellation source, so an aborted MCP request kills the same live
 * `git` children a CLI ctrl-C does, and reports `CANCELLED` in the same shape.
 */
async function runFleetTool<T>(
  command: string,
  args: FleetToolArgs,
  signal: AbortSignal,
  collect: (input: FleetToolCollectInput) => Promise<T>,
  succeed: (value: T) => FleetEnvelopeV1,
  failureActions: (error: FleetError) => string[],
): Promise<FleetEnvelopeV1> {
  try {
    requireValue(args.agent, "agent");
    requireValue(args.projectRegistry, "projectRegistry");
    requireValue(args.agentRegistry, "agentRegistry");
    requireValue(args.contract, "contract");
    requireValue(args.domain, "domain");
    requireValue(args.baseline, "baseline");
    const runContext = createRunContext({ signal, deadlineMs: args.deadlineMs });
    const value = await collect({
      agentId: args.agent,
      projectRegistry: args.projectRegistry,
      agentRegistry: args.agentRegistry,
      contract: args.contract,
      domain: args.domain,
      live: args.live,
      baseline: args.baseline,
      runContext,
    });
    return succeed(value);
  } catch (error) {
    const normalized = normalizeFleetError(error);
    return fleetFailureEnvelope(command, normalized, failureActions(normalized));
  }
}

/**
 * The CLI's own `next_actions`, reproduced exactly.
 *
 * Duplicated deliberately rather than imported: `src/fleet/cli.ts` builds them
 * inside its Commander actions, and exporting those would export the action
 * bodies. The parity assertion in `tests/mcp-server-regressions.mjs` compares
 * `command`, `data` and `error` -- the machine contract -- and these strings are
 * the human guidance beside it.
 */
function inventoryEnvelope(inventory: FleetInventory): FleetEnvelopeV1 {
  return fleetSuccessEnvelope(INVENTORY_COMMAND, inventory, inventory.health.healthy
    ? ["Consume data.rows as the fleet's declared state; every value names the authority that owns it"]
    : [inventory.health.conflicts
      ? "Rule on each unpermitted conflict group: repair the drift, or record it under classifications.intentionally_unmanaged"
      : "Review data.findings; each names the owning registry and the field path to repair"]);
}

function provenanceEnvelope(provenance: FleetProvenance): FleetEnvelopeV1 {
  return fleetSuccessEnvelope(PROVENANCE_COMMAND, provenance, provenance.health.healthy && provenance.health.complete
    ? ["Consume data.facts as the fleet's proven provenance; every fact names the source of both sides"]
    : [provenance.health.mismatched
      ? "Repoint each mismatched agent at the configured pin, or move the pin -- data.facts names both sides and the authority that owns the field"
      : provenance.health.missing
        ? "Record the missing values on the owning side; an absent pin is never a match"
        : "Review data.probes: a fact reported unobserved was not read, and nothing may be claimed about it"]);
}

/**
 * The CLI's status guidance, reproduced exactly. Same rule as the two above.
 *
 * The CLI's extra human-path line ("Re-run with --json ...") is deliberately
 * absent: a caller reaching this over a protocol already has the JSON.
 */
function statusEnvelope(status: FleetStatus): FleetEnvelopeV1 {
  return fleetSuccessEnvelope(STATUS_COMMAND, status, status.health.proven
    ? ["Consume data.agents as the fleet's proven state; every observation names its domain, its evidence, its severity, and the one action that changes it"]
    : [status.health.errors || status.health.collection_errors
      ? "Review data.findings: a collection error is never a pass, so the domains it covers are reported error or unobserved until the source can be read"
      : status.health.failed
        ? "Repair the failing observations in data.agents, worst first -- data.findings is sorted by gating impact and severity, and data.host is separate on purpose"
        : status.health.unjustified
          ? "Every non-pass without a justification blocks proof: authorize it under health_policy in the fleet contract, or repair it"
          : status.health.stale
            ? "Refresh the evidence behind each stale observation, or widen the owning health_policy.freshness entry"
            : status.scope.live
              ? "Review data.health.unobserved: live-process and Bloodbank-liveness observers do not exist in this release (stories 1.9/1.10)"
              : "Re-run with --live to authorize the bounded, read-only recipe audit; without it every audit-fed domain is unobserved"]);
}

function budgetAwareActions(what: string): (error: FleetError) => string[] {
  return (error) => [
    error.code === "TIMEOUT" || error.code === "CANCELLED"
      ? `Re-run with a larger deadlineMs; no partial ${what} is reported, because a partial one must never be mistaken for a complete one`
      : `Fix the reported source path, or run \`flume handbook validate\` if the fault is in the contract`,
  ];
}

/**
 * Expose `fleet inventory` and `fleet provenance` as MCP tools.
 *
 * `isError` is `!envelope.ok`, matching the rest of the catalog, and the payload
 * is the COMPLETE fleet envelope as JSON text -- the same document `--json`
 * writes to stdout, so an automation client and an operator are reading one
 * contract. `structuredContent`/`outputSchema` are deliberately not used;
 * nothing else in this server does, and introducing them on two tools would
 * split the surface.
 */
export function registerFleetMcpTools(server: ToolHost, asText: AsText): void {
  server.registerTool(
    "pjangler_fleet_inventory",
    {
      title: "Inventory the Hermes fleet",
      description:
        "Reads the two canonical registries and reports every registered agent with per-field authoritative-source provenance, "
        + "identity conflicts under stable group ids, and independently counted totals. Strictly read-only. "
        + "Returns the fleet JSON v1 envelope; an unhealthy fleet is still ok:true with data.health.healthy false.",
      inputSchema: z.strictObject({ ...FLEET_TOOL_INPUT }),
    },
    async (args: unknown, extra: { signal: AbortSignal }) => {
      const envelope = await runFleetTool(
        INVENTORY_COMMAND, args as FleetToolArgs, extra.signal,
        async (input) => collectFleetInventory(input),
        inventoryEnvelope,
        budgetAwareActions("inventory"),
      );
      return { isError: !envelope.ok, ...asText(envelope) };
    },
  );

  server.registerTool(
    "pjangler_fleet_provenance",
    {
      title: "Report Hermes fleet provenance",
      description:
        "Pairs every recorded or pinned fleet value with its live counterpart -- template gitlink, host pin, per-agent hermes "
        + "executable, checkout identity, HEAD and cleanliness -- each side naming its own source and categorized "
        + "match/mismatch/dirty/missing/unsupported/unobserved. Never executes the observed binary and never touches the network. "
        + "Returns the fleet JSON v1 envelope; a drifted fleet is still ok:true with data.health.healthy false.",
      inputSchema: z.strictObject({ ...FLEET_TOOL_INPUT }),
    },
    async (args: unknown, extra: { signal: AbortSignal }) => {
      const envelope = await runFleetTool(
        PROVENANCE_COMMAND, args as FleetToolArgs, extra.signal,
        async (input) => collectFleetProvenance(input),
        provenanceEnvelope,
        budgetAwareActions("provenance"),
      );
      return { isError: !envelope.ok, ...asText(envelope) };
    },
  );

  server.registerTool(
    "pjangler_fleet_status",
    {
      title: "Report registry-wide Hermes fleet status",
      description:
        "Traverses the registry once and reports every registered agent across all nine observation domains -- registry, "
        + `project_binding, template_scaffold, profile, runtime, systemd, live_process, bloodbank, release_provenance -- each `
        + "either observed or carrying an explicit unobserved/unsupported reason. Host-scoped findings are reported once in "
        + "data.host and never folded into an agent. Strictly read-only; `live` authorizes bounded read-only host and network "
        + "observation (the recipe-owned audit rules) and nothing else -- it does not gate the systemd observer, which samples "
        + "this machine's user manager with read-only `systemctl --user` queries in every scope. Returns the fleet JSON v1 "
        + "envelope; an unhealthy or incomplete fleet is still ok:true with data.health.healthy / data.health.complete false.",
      inputSchema: z.strictObject({
        ...FLEET_TOOL_INPUT,
        // A plain string, matching the CLI, so an unknown value produces the
        // SAME `INVALID_INPUT` envelope on both adapters rather than a zod
        // -32602 transport error with no envelope at all on one of them. DW-60
        // records that divergence for `deadlineMs`; there is no reason to add a
        // second instance of it here.
        domain: z.string().optional().describe(`Report only this domain: ${FLEET_STATUS_DOMAINS.join(", ")}.`),
        live: z.boolean().optional().describe("Authorize bounded, read-only host and network observation: run the recipe-owned audit rules per repository. Never mutation, process control, service changes, board changes, or Bloodbank activation."),
        baseline: z.string().optional().describe("Correlate against a prior status document and report every transition. Opened for reading only; an unreadable or unparseable file is INVALID_INPUT naming the path."),
        // Accepted for surface parity with the CLI's `--exit-code` and inert
        // over a protocol that has no process exit. `data.health.exit_category`
        // is the discriminant on both adapters, which is what finally gives an
        // MCP client one at all.
        exitCode: z.boolean().optional().describe("No effect over MCP; read data.health.exit_category instead. Accepted so this tool exposes the CLI's option surface one-for-one."),
      }),
    },
    async (args: unknown, extra: { signal: AbortSignal }) => {
      const envelope = await runFleetTool(
        STATUS_COMMAND, args as FleetToolArgs, extra.signal,
        async (input) => collectFleetStatus({ ...input, runContext: input.runContext }),
        statusEnvelope,
        budgetAwareActions("status"),
      );
      return { isError: !envelope.ok, ...asText(envelope) };
    },
  );
}
