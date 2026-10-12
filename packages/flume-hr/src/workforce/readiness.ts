// Company identity readiness: what is NOT known about the accounts the later
// stories need, said plainly.
//
// Nothing here is assumed. Without a probe every external fact is `unproven`,
// never ready and never free. `--probe cloudflare` is the only measurement this
// command makes: GET requests only, with the token read from
// CLOUDFLARE_API_TOKEN and never echoed. A measured value is evidence for an
// operator to judge, not a readiness verdict, so `ready` stays false.
import { COMPANY_MAIL_DOMAIN } from "./validator";

const APEX_DOMAIN = COMPANY_MAIL_DOMAIN.split(".").slice(1).join(".");
const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeRecord { observed_at: string; method: "GET"; path: string; http_status: number | null; measured?: unknown; error?: string }
export interface ReadinessCheck { status: "unproven" | "measured"; ready: false; cost: null; detail: string; evidence: ProbeRecord[] }
export interface ReadinessOptions { probe?: string[] }

const UNPROVEN: Record<string, string> = {
  cloudflare_plan: `Cloudflare plan and entitlements for ${APEX_DOMAIN} (Email Routing, Workers, storage) are not measured`,
  mail_dns_conflicts: `MX records on ${COMPANY_MAIL_DOMAIN} and the apex ${APEX_DOMAIN}, and Email Routing state, are not measured`,
  service_token_capacity: "Access service-token count against the documented 50-per-account default is not measured",
  provider_account_rights: "GitHub App, Plane membership and AutomaticAI rights are provider facts this command does not measure",
};

async function get(base: string, token: string, path: string): Promise<ProbeRecord & { body?: any }> {
  const observed_at = new Date().toISOString();
  try {
    const response = await fetch(`${base}${path}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    let body: any;
    try { body = await response.json(); } catch { body = undefined; }
    // A 200 that is not a JSON answer measured nothing.
    const failed = !response.ok || body === undefined || body?.success === false;
    const errors = Array.isArray(body?.errors) ? body.errors.map((e: { code?: unknown; message?: unknown }) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ") : "";
    return { observed_at, method: "GET", path, http_status: response.status, body, ...(failed ? { error: errors || (body === undefined ? `HTTP ${response.status} without a JSON body` : `HTTP ${response.status}`) } : {}) };
  } catch (error) {
    return { observed_at, method: "GET", path, http_status: null, error: (error as Error).name === "TimeoutError" ? "timed out" : (error as Error).message };
  }
}

function record({ body: _body, ...probe }: ProbeRecord & { body?: any }, measured?: unknown): ProbeRecord {
  return probe.error ? probe : { ...probe, measured };
}

function mx(probe: ProbeRecord & { body?: any }): ProbeRecord {
  return record(probe, (probe.body?.result ?? []).map((r: any) => ({ name: r.name, content: r.content, priority: r.priority })));
}

async function probeCloudflare(token: string, checks: Record<string, ReadinessCheck>): Promise<void> {
  const base = (process.env.FLUME_CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4").replace(/\/$/u, "");
  const zones = await get(base, token, `/zones?name=${APEX_DOMAIN}`);
  const zone = zones.body?.result?.[0];
  const found = record(zones, zone
    ? { zone: zone.name, zone_id: zone.id, plan: zone.plan?.name ?? null, plan_price: zone.plan?.price ?? null, plan_currency: zone.plan?.currency ?? null, account_id: zone.account?.id ?? null }
    : { zones_found: 0 });
  // No visible zone means the plan was not observed, so the check stays unproven.
  checks.cloudflare_plan!.evidence.push(zone ? found : { ...found, error: found.error ?? `zone ${APEX_DOMAIN} is not visible to this token` });
  if (!zone?.id) return;
  for (const name of [COMPANY_MAIL_DOMAIN, APEX_DOMAIN]) checks.mail_dns_conflicts!.evidence.push(mx(await get(base, token, `/zones/${zone.id}/dns_records?type=MX&name=${name}`)));
  const routing = await get(base, token, `/zones/${zone.id}/email/routing`);
  checks.mail_dns_conflicts!.evidence.push(record(routing, { enabled: routing.body?.result?.enabled ?? null, status: routing.body?.result?.status ?? null }));
  if (!zone.account?.id) return;
  const tokens = await get(base, token, `/accounts/${zone.account.id}/access/service_tokens?per_page=50`);
  checks.service_token_capacity!.evidence.push(record(tokens, { service_tokens: tokens.body?.result_info?.total_count ?? tokens.body?.result?.length ?? null, documented_default_limit: 50 }));
}

/** A readiness report that never claims more than it measured. */
export async function identityReadiness(options: ReadinessOptions = {}) {
  const unknown = (options.probe ?? []).filter(p => p !== "cloudflare");
  if (unknown.length) throw new Error(`Unsupported probe: ${unknown.join(", ")} (only cloudflare is probed)`);
  const checks: Record<string, ReadinessCheck> = Object.fromEntries(Object.entries(UNPROVEN).map(([name, detail]) => [name, { status: "unproven", ready: false, cost: null, detail, evidence: [] }]));
  const probes: Record<string, string> = { cloudflare: "not_requested" };
  if (options.probe?.includes("cloudflare")) {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) probes.cloudflare = "not_run: CLOUDFLARE_API_TOKEN is not set";
    else { await probeCloudflare(token, checks); probes.cloudflare = "run"; }
  }
  for (const check of Object.values(checks)) {
    if (check.evidence.length && check.evidence.every(e => !e.error)) check.status = "measured";
  }
  return { ok: true, ready: false, domain: COMPANY_MAIL_DOMAIN, checks, probes,
    note: "Unproven is not zero cost and not ready. Measured values are evidence for the operator; this command never creates or changes a resource." };
}
