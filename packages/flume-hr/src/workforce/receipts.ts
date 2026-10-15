// FLUME-53: `flume access receipts` -- one read-only view that joins what the facade, the mailbox, the lifecycle and Pilot
// each recorded about the same employee, by the fields they share: `subject`, `run_id`, `operation_id`, `grant_id`.
//
// It reads secret-free logs (the facade's audit and ledgers, the lifecycle ledger, Pilot's comment receipts) and emits a
// FIELD WHITELIST per record. It never echoes a raw line, so a field some future writer adds is not leaked by accident.
// Gateway attribution is linked to the FLUME-39 evidence, which is `unverified` until that evidence exists; a generated
// desk config is never offered as proof. A `--gateway-proof` file (the output of `gateway-proof.py check`) is `verified`
// only if it says `verified: true` and every receipt's token_name belongs to the employee's own consumer.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accessStateDir } from "./access";
import { identityCensus, resolveEmployee } from "./company";
import { gatewayConsumerOf, gatewayLink } from "./lifecycle-adapters";
import { readLifecycleLedger } from "./lifecycle-state";
import { readPlaneReceipts } from "./plane";

export interface ReceiptsOptions { run?: string; employee?: string; since?: string; gatewayProof?: string; env?: NodeJS.ProcessEnv }

type Line = Record<string, any>;
const pick = (line: Line, fields: readonly string[]): Line => Object.fromEntries(fields.filter(field => line[field] !== undefined).map(field => [field, line[field]]));

const AUDIT_FIELDS = ["at", "event", "outcome", "http_status", "subject", "handle", "run_id", "harness", "request_id", "grant_id", "service", "resource", "permissions", "lifetime_seconds", "expires_at", "replayed", "operation", "message_id"] as const;
const LEDGER_FIELDS = ["at", "provider", "grant_id", "subject", "run_id", "request_id", "service", "resource", "permissions", "expires_at"] as const;
const PROVIDER_FIELDS = ["at", "provider", "event", "grant_id", "subject", "run_id", "request_id", "app_id", "installation_id", "repository", "permissions", "expires_at", "http_status", "github_request_id", "reason"] as const;
const LIFECYCLE_FIELDS = ["at", "event", "operation_id", "command", "employee", "handle", "subject", "phase", "step", "adapter", "outcome", "provider_code", "ok", "complete_revocation", "from", "to", "revoke", "original_operation_id", "provider", "previous_ref", "credential_ref"] as const;
const COMMENT_FIELDS = ["employee", "subject", "comment_id", "actor_id", "native_actor_id", "authorship", "reason"] as const;

function readJsonl(path: string): Line[] {
  if (!existsSync(path)) return [];
  const lines: Line[] = [];
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try { lines.push(JSON.parse(text)); } catch { /* a torn line is not a record */ }
  }
  return lines;
}

export function accessReceipts(options: ReceiptsOptions) {
  const env = options.env ?? process.env;
  const blockers: Array<{ code: string; detail: string }> = [];
  const refuse = (code: string, detail: string) => ({ ok: false, blockers: [{ code, detail }], rows: [] as Line[], runs: [] as Line[], operations: [] as Line[], writes: [] as string[] });
  if (!options.run && !options.employee) return refuse("invalid-request", "pass --employee <employee> or --run <run id>");
  if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) return refuse("invalid-request", "--since must be an ISO-8601 time");

  const dir = accessStateDir();
  const audit = readJsonl(join(dir, "audit.jsonl")).filter(line => line.event === "access.request" || line.event === "mail.authorize");
  const ledger = readJsonl(join(dir, "fixture-ledger.jsonl"));
  const provider = readJsonl(join(dir, "provider-ledger.jsonl"));
  const lifecycle = readLifecycleLedger(env);

  // -- who: one subject, from the enrolled employee or from the run the facade recorded -------------------------------
  let subject: string | undefined, handle: string | undefined, employee = options.employee;
  let target: ReturnType<typeof resolveEmployee> | undefined;
  const census = identityCensus();
  if (options.employee) {
    try { target = resolveEmployee(census, options.employee); } catch (error) { return refuse("employee-not-found", (error as Error).message.split("\n")[0]!); }
    if (!target.block) return refuse("not-enrolled", `${options.employee} has no company identity`);
    subject = target.block.subject; handle = target.block.handle;
  }
  if (options.run) {
    const subjects = new Set(audit.filter(line => line.run_id === options.run && line.subject).map(line => String(line.subject)));
    if (subjects.size === 0) return refuse("run-not-found", `no audit line carries run ${options.run}`);
    if (subjects.size > 1) return refuse("run-ambiguous", `run ${options.run} appears under more than one subject`);
    const found = [...subjects][0]!;
    if (subject && subject !== found) return refuse("run-subject-mismatch", `run ${options.run} belongs to another employee`);
    subject = found;
    handle = handle ?? audit.find(line => line.run_id === options.run)?.handle;
    if (!target) {
      target = census.definitions.find(definition => definition.block?.subject === subject);
      employee = target?.person ?? handle;
    }
  }

  const since = options.since ? Date.parse(options.since) : undefined;
  const after = (line: Line) => since === undefined || Date.parse(String(line.at)) >= since;
  const mine = (line: Line) => line.subject === subject && after(line);

  // -- the run window: from the run's first record to its last, across every log that names the run -------------------
  let window: { from: number; to: number } | undefined;
  if (options.run) {
    const stamps = [...audit, ...ledger, ...provider].filter(line => line.run_id === options.run).map(line => Date.parse(String(line.at))).filter(Number.isFinite);
    if (stamps.length) window = { from: Math.min(...stamps), to: Math.max(...stamps) };
  }
  const inRun = (line: Line) => (!options.run || line.run_id === options.run);

  const rows: Line[] = [];
  for (const line of audit.filter(mine).filter(inRun)) {
    const denied = Number(line.http_status) >= 400;
    const kind = line.event === "mail.authorize" ? (denied ? "denial" : "mail") : denied ? "denial" : "request";
    rows.push({ kind, ...pick(line, AUDIT_FIELDS) });
  }
  for (const line of ledger.filter(mine).filter(inRun)) rows.push({ kind: "grant", ...pick(line, LEDGER_FIELDS) });
  for (const line of provider.filter(mine).filter(inRun)) rows.push({ kind: "provider", ...pick(line, PROVIDER_FIELDS) });
  const lifecycleMine = lifecycle.filter(mine).filter(line => !window || (Date.parse(String(line.at)) >= window.from && Date.parse(String(line.at)) <= window.to));
  for (const line of lifecycleMine) rows.push({ kind: "lifecycle", ...pick(line, LIFECYCLE_FIELDS) });
  if (!options.run) {
    for (const receipt of readPlaneReceipts(env).filter(line => line.kind === "plane.verify-comments" && after(line))) {
      for (const comment of (receipt.comments ?? []) as Line[]) if (comment.subject === subject) rows.push({ kind: "plane-comment", at: receipt.at, ref: receipt.ref, evidence: receipt.evidence, ...pick(comment, COMMENT_FIELDS) });
    }
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  // -- joins ------------------------------------------------------------------------------------------------------
  const runIds = [...new Set(rows.map(row => row.run_id).filter(Boolean))] as string[];
  const runs = runIds.map(id => {
    const own = rows.filter(row => row.run_id === id);
    return {
      run_id: id, harness: own.find(row => row.harness)?.harness ?? null,
      first_at: own[0]?.at, last_at: own[own.length - 1]?.at,
      requests: own.filter(row => row.kind === "request").length, grants: own.filter(row => row.kind === "grant").length,
      mail_authorizations: own.filter(row => row.kind === "mail").length, denials: own.filter(row => row.kind === "denial").length,
    };
  });
  const operations = [...new Set(lifecycleMine.map(line => line.operation_id).filter(Boolean))].map(id => {
    const own = lifecycleMine.filter(line => line.operation_id === id);
    const started = own.find(line => line.event === "lifecycle.operation" && line.phase === "started"), finished = own.find(line => line.event === "lifecycle.operation" && line.phase === "finished");
    return {
      operation_id: id, command: own[0]?.command, started_at: started?.at ?? own[0]?.at, finished_at: finished?.at ?? null, ok: finished?.ok ?? null,
      steps: own.filter(line => line.event === "lifecycle.step").map(line => pick(line, ["step", "adapter", "outcome", "provider_code", "original_operation_id"] as const)),
    };
  });

  // -- gateway attribution: the FLUME-39 evidence, never a generated config ---------------------------------------
  const link = gatewayLink(env);
  const consumer = target ? gatewayConsumerOf(census, target, env) : undefined;
  const gateway: Line = { ...link, consumer: consumer?.consumer ?? null, attribution: link.evidence_status === "present" ? "linked" : "unverified" };
  if (options.gatewayProof) gateway.proof = gatewayProof(options.gatewayProof, consumer?.consumer);

  return {
    ok: true, blockers, employee: employee ?? null, subject: subject ?? null, handle: handle ?? null,
    ...(options.run ? { run: options.run, ...(window ? { window: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() } } : {}) } : {}),
    subjects: subject ? [subject] : [], run_ids: runIds, runs, operations, rows, gateway, writes: [] as string[],
  };
}

/** `verified` only for `verified: true` AND every receipt's token_name starting `aai:<consumer>:`; anything else is named. */
function gatewayProof(path: string, consumer: string | undefined): Line {
  const base = { path };
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return { ...base, status: "unverified", reason: "not-a-regular-file" };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { status?: unknown; verified?: unknown; receipts?: unknown };
    const receipts = Array.isArray(parsed.receipts) ? parsed.receipts as Line[] : [];
    const shown = receipts.map(receipt => pick(receipt, ["token_name", "request_id", "session_id", "created_at"] as const));
    if (!consumer) return { ...base, status: "unverified", reason: "no-consumer", receipts: shown };
    if (parsed.verified !== true) return { ...base, status: "unverified", reason: "proof-not-verified", proof_status: typeof parsed.status === "string" ? parsed.status : null, consumer, receipts: shown };
    if (!receipts.length) return { ...base, status: "unverified", reason: "no-receipts", consumer, receipts: shown };
    const prefix = `aai:${consumer}:`;
    const foreign = receipts.filter(receipt => typeof receipt.token_name !== "string" || !receipt.token_name.startsWith(prefix));
    if (foreign.length) return { ...base, status: "mismatch", reason: "foreign-token-name", consumer, foreign: foreign.length, receipts: shown };
    return { ...base, status: "verified", consumer, receipts: shown };
  } catch {
    return { ...base, status: "unverified", reason: "unreadable" };
  }
}
