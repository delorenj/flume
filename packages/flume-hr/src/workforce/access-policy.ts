// Target one configured application policy; never infer policy ownership from a name.
import { isDeepStrictEqual } from "node:util";
import { cfOk, cfRequest, opRead, type ProvisioningConfig } from "./provision";

type Policy = Record<string, unknown> & { id: string; decision: string; include: Record<string, unknown>[] };
export type PolicyResult = { ok: true; policy: Policy; token: string; path: string } | { ok: false; code: string; detail: string };
const failure = (code: string, detail: string): Extract<PolicyResult, { ok: false }> => ({ ok: false, code, detail });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const codeOf = (status: number) => status === 401 || status === 403 ? "access-policy-permission-denied" : status === 404 ? "access-policy-unresolved" : `access-policy-http-${status || "unavailable"}`;
const detailOf = (status: number) => status === 401 || status === 403
  ? "Access policy credential denied; grant Access: Apps and Policies Edit on the configured account (provider output withheld)"
  : "configured Access application/policy could not be read or edited (provider output withheld)";

/** Both GETs use ONLY the explicit policy credential. Missing configuration never borrows a global credential. */
export async function readAccessPolicy(config: ProvisioningConfig): Promise<PolicyResult> {
  const selected = config.cloudflare.access_policy;
  if (!selected) return failure("access-policy-not-configured", "configure cloudflare.access_policy with application_id, policy_id, domain and scoped api_token_ref (docs/identity-provisioning.md)");
  let token: string;
  try { token = opRead(selected.api_token_ref); }
  catch { return failure("access-policy-credential-unavailable", "explicit Access policy credential unavailable; no fallback attempted"); }
  const appPath = `/accounts/${config.cloudflare.account_id}/access/apps/${selected.application_id}`;
  const app = await cfRequest(token, "GET", appPath);
  if (!cfOk(app)) return failure(codeOf(app.http_status), detailOf(app.http_status));
  if (app.body?.success !== true || app.body?.result?.id !== selected.application_id || app.body?.result?.domain !== selected.domain) return failure("access-policy-application-mismatch", "configured Access application ID/domain did not read back exactly; no policy mutation authorized");
  const path = `${appPath}/policies/${selected.policy_id}`;
  const got = await cfRequest(token, "GET", path);
  if (!cfOk(got)) return failure(codeOf(got.http_status), detailOf(got.http_status));
  const policy = got.body?.result;
  if (got.body?.success !== true || !object(policy) || policy.id !== selected.policy_id || policy.decision !== "non_identity" ||
      typeof policy.name !== "string" || !Array.isArray(policy.include) || !policy.include.every(object) ||
      (policy.exclude !== undefined && (!Array.isArray(policy.exclude) || !policy.exclude.every(object))) ||
      (policy.require !== undefined && (!Array.isArray(policy.require) || !policy.require.every(object)))) {
    return failure("access-policy-invalid", "configured policy must be a readable Service Auth (non_identity) policy with explicit include rules");
  }
  if (policy.reusable === true || (typeof policy.app_count === "number" && policy.app_count > 1)) return failure("access-policy-shared", "configured policy is reusable/shared; targeted application membership requires an application-specific policy");
  if (JSON.stringify(policy.include).includes('"any_valid_service_token"')) return failure("access-policy-too-broad", "policy admits any valid service token; reconcile to explicit employee token IDs before provisioning");
  if (policy.include.some(rule => JSON.stringify(rule).includes('"service_token"') && !policyTokenId(rule))) return failure("access-policy-invalid", "service-token include selectors must be direct token_id rules; nested or ambiguous membership requires operator reconciliation");
  return { ok: true, policy: policy as Policy, token, path };
}

export const policyTokenId = (rule: Record<string, unknown>): string | undefined =>
  Object.keys(rule).length === 1 && object(rule.service_token) && Object.keys(rule.service_token).length === 1 && typeof rule.service_token.token_id === "string" && /^[a-zA-Z0-9-]{1,80}$/u.test(rule.service_token.token_id) ? rule.service_token.token_id : undefined;
export const policyHasToken = (policy: Policy, id: string): boolean => policy.include.some(rule => policyTokenId(rule) === id);
const writable = (policy: Policy): Record<string, unknown> => {
  const { id: _id, account_id: _account, policy_resolution_account_id: _resolution, created_at: _created, updated_at: _updated, reusable: _reusable, app_count: _count, ...body } = policy;
  return body;
};

/** Re-read immediately before editing and verify the entire writable policy, not merely a successful PUT. */
export async function reconcileAccessPolicy(config: ProvisioningConfig, ids: string[], present: boolean, apply: boolean) {
  const before = await readAccessPolicy(config);
  if (!before.ok) return { ...before, changed: false };
  const wanted = new Set(ids);
  if (!ids.length || ids.some(id => !/^[a-zA-Z0-9-]{1,80}$/u.test(id))) return { ...failure("access-policy-token-unresolved", "actual employee token ID is unavailable; no policy mutation authorized"), changed: false };
  const include = present
    ? [...before.policy.include, ...ids.filter(id => !policyHasToken(before.policy, id)).map(id => ({ service_token: { token_id: id } }))]
    : before.policy.include.filter(rule => !wanted.has(policyTokenId(rule) ?? ""));
  if (isDeepStrictEqual(include, before.policy.include)) return { ok: true as const, changed: false, code: present ? "membership-present" : "membership-absent" };
  if (!apply) return { ok: true as const, changed: true, code: present ? "membership-add-planned" : "membership-remove-planned" };
  const expected = { ...writable(before.policy), include };
  const put = await cfRequest(before.token, "PUT", before.path, expected);
  // Even an error may have committed. Report partial/uncertain, and let the next invocation observe convergence.
  if (!cfOk(put) || put.body?.success !== true) return { ...failure(codeOf(put.http_status), detailOf(put.http_status)), changed: true };
  const after = await readAccessPolicy(config);
  if (!after.ok) return { ...after, changed: true };
  if (!isDeepStrictEqual(writable(after.policy), expected)) return { ...failure("access-policy-readback-mismatch", "policy update not read back identical; membership/settings uncertain, retry after inspection"), changed: true };
  return { ok: true as const, changed: true, code: present ? "membership-added" : "membership-removed" };
}
