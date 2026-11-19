// Secret-free Access issuance history shared by provisioning, binding and retirement.
// Keep the first attribution; contradictory history is diagnostic evidence, never deletion authority.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstatIfPresent } from "./lifecycle-state";

export function provisionStateDir(): string {
  const home = process.env.HOME || homedir();
  return process.env.FLUME_PROVISION_STATE || join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "flume", "provision");
}

type Receipt = Record<string, unknown>;
function readReceipts(): Receipt[] {
  const path = join(provisionStateDir(), "receipts.jsonl");
  const info = lstatIfPresent(path);
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("issuance receipts are not a regular file");
  return readFileSync(path, "utf8").split("\n").filter(text => text.trim()).map(text => {
    const row = JSON.parse(text);
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid issuance receipt");
    return row as Receipt;
  });
}

export interface PendingAccessIssuance { token_ids: string[]; client_ids: Record<string, string>; uncertain: boolean }
function pendingFrom(rows: Receipt[], handle: string, subject: string, accountId?: string): PendingAccessIssuance {
  const pending = new Set<string>(), accounted = new Set<string>();
  const clientIds = new Map<string, string>();
  let uncertain = false;
  for (const row of rows) {
    if (row.employee !== handle || row.capability !== "access-token") continue;
    if (row.subject !== subject || !accountId || row.account_id !== accountId || typeof row.token_id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/u.test(row.token_id)) {
      if (row.action === "minted" || row.action === "reconciliation-required" || row.action === "cleanup-unconfirmed" || (row.subject === subject && row.account_id)) uncertain = true;
      continue;
    }
    const id = row.token_id, original = clientIds.get(id);
    if (row.client_id !== undefined && (typeof row.client_id !== "string" || !row.client_id || original && original !== row.client_id)) uncertain = true;
    if (row.action === "minted") {
      if (accounted.has(id) || typeof row.client_id !== "string" || !row.client_id || (original && original !== row.client_id)) uncertain = true;
      if (!original && typeof row.client_id === "string" && row.client_id) clientIds.set(id, row.client_id);
      pending.add(id);
    } else if (row.action === "created") {
      if (!pending.has(id) || !original || original !== row.client_id) uncertain = true;
      else { pending.delete(id); accounted.add(id); }
    } else if (row.action === "deleted-orphan" && row.deleted === true) {
      if (!pending.has(id)) uncertain = true;
      pending.delete(id);
      accounted.add(id);
    } else if (row.action === "reconciliation-required" || row.action === "cleanup-unconfirmed") {
      if (!pending.has(id) || !original || (row.client_id !== undefined && row.client_id !== original)) uncertain = true;
      pending.add(id);
    } else uncertain = true;
  }
  // Whole scoped journal quarantine: even a later "created"/"deleted" row cannot launder a contradiction.
  return { token_ids: uncertain ? [] : [...pending], client_ids: Object.fromEntries(clientIds), uncertain };
}

export function pendingAccessIssuance(handle: string, subject: string, accountId?: string): PendingAccessIssuance {
  try { return pendingFrom(readReceipts(), handle, subject, accountId); }
  catch { return { token_ids: [], client_ids: {}, uncertain: true }; }
}

export interface AccessPolicyHistory { ids: string[]; clients: Record<string, string>; scopes: Array<{ account_id: string; application_id: string; policy_id: string; domain?: string }>; uncertain: boolean }
/** Scope is part of the grant: a later configuration must not silently replace the policy that admitted a token. */
export function accessPolicyTokenHistory(handle: string, subject: string, accountId: string, principal?: string): AccessPolicyHistory {
  const uncertain = (): AccessPolicyHistory => ({ ids: [], clients: {}, scopes: [], uncertain: true });
  try {
    const ids = new Set<string>(), clients = new Map<string, string>(), scopes = new Map<string, AccessPolicyHistory["scopes"][number]>(), rows = readReceipts();
    for (const row of rows) {
      if (row.capability !== "access-policy" || row.employee !== handle) continue;
      if (row.subject !== subject || row.account_id !== accountId || typeof row.client_id !== "string" || !row.client_id ||
          typeof row.token_id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/u.test(row.token_id) ||
          typeof row.application_id !== "string" || !row.application_id || typeof row.policy_id !== "string" || !row.policy_id ||
          (row.domain !== undefined && (typeof row.domain !== "string" || !row.domain)) ||
          (clients.has(row.token_id) && clients.get(row.token_id) !== row.client_id)) return uncertain();
      clients.set(row.token_id, row.client_id);
      if (!principal || row.client_id === principal) {
        ids.add(row.token_id);
        scopes.set(`${row.application_id}:${row.policy_id}:${row.domain ?? ""}`, { account_id: accountId, application_id: row.application_id, policy_id: row.policy_id, ...(row.domain ? { domain: row.domain as string } : {}) });
      }
    }
    for (const [id, client] of clients) {
      if (rows.some(row => row.capability === "access-policy" && row.employee !== handle && (row.token_id === id || row.client_id === client))) return uncertain();
    }
    return { ids: [...ids], clients: Object.fromEntries(clients), scopes: [...scopes.values()], uncertain: false };
  } catch { return uncertain(); }
}

export function accessPolicyExpectedDigest(handle: string, subject: string, accountId: string, tokenId: string, applicationId: string, policyId: string): { digest?: string; baseline?: string; uncertain: boolean } {
  try {
    let digest: string | undefined, baseline: string | undefined;
    for (const row of readReceipts()) {
      if (row.capability !== "access-policy" || row.employee !== handle || row.subject !== subject || row.account_id !== accountId ||
          row.token_id !== tokenId || row.application_id !== applicationId || row.policy_id !== policyId) continue;
      if (row.action === "write-intent") {
        if (typeof row.expected_digest !== "string" || !/^[0-9a-f]{64}$/u.test(row.expected_digest) ||
            typeof row.baseline_digest !== "string" || !/^[0-9a-f]{64}$/u.test(row.baseline_digest)) return { uncertain: true };
        digest = row.expected_digest; baseline = row.baseline_digest;
      } else if (row.action === "verified" && digest === row.expected_digest) { digest = undefined; baseline = undefined; }
    }
    return { digest, baseline, uncertain: false };
  } catch { return { uncertain: true }; }
}

/** A pending issuance cannot silently become a second employee's binding, even after its definition disappears. */
export function accessIssuanceReservation(principal: string, subject: string): "pending-issuance-reserved" | "issuance-receipt-uncertain" | undefined {
  try {
    const rows = readReceipts();
    const claims = rows.filter(row => row.capability === "access-token" && row.client_id === principal && row.subject !== subject);
    for (const claim of claims) {
      if (typeof claim.employee !== "string" || typeof claim.subject !== "string" || typeof claim.account_id !== "string") return "issuance-receipt-uncertain";
      const pending = pendingFrom(rows, claim.employee, claim.subject, claim.account_id);
      if (pending.uncertain) return "issuance-receipt-uncertain";
      if (pending.token_ids.some(id => pending.client_ids[id] === principal)) return "pending-issuance-reserved";
    }
    return undefined;
  } catch { return "issuance-receipt-uncertain"; }
}
