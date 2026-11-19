import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveFlumeRoot } from "../kernel/paths";

export interface MemberCredentialOutcome {
  profile: string;
  consumer: string;
  reference: string;
  token: string;
  delta: string;
  render: string;
  ok: boolean;
  error?: string;
}

/** The Python helper owns the canonical profile lock; never hand-edit a delta here. */
export function provisionMemberCredential(profile: string, options: { home?: string; apply?: boolean; group?: string } = {}): MemberCredentialOutcome {
  const helper = join(resolveFlumeRoot(), "scripts/gateway-member-tokens.py");
  const run = spawnSync("python3", [helper, "--members", profile, "--json", "--render",
    ...(options.apply === false ? [] : ["--apply"]), ...(options.group ? ["--group", options.group] : [])], {
    encoding: "utf8", timeout: 200_000, maxBuffer: 256 * 1024,
    env: { ...process.env, ...(options.home ? { HERMES_FLEET_HOME: options.home } : {}), OP_CACHE: "off", PYTHONDONTWRITEBYTECODE: "1" },
  });
  // Gateway and vault errors may contain credentials. Never quote raw output.
  let outcome: MemberCredentialOutcome | undefined;
  try {
    const response = JSON.parse(run.stdout) as { members?: MemberCredentialOutcome[] };
    outcome = response.members?.find(member => member.profile === profile);
  } catch { /* only authored failure codes cross this boundary */ }
  if (!outcome || run.error || run.status !== 0 || !outcome.ok) {
    const safe = outcome && { ...outcome, error: outcome.error ?? "provisioning-failed", ok: false };
    throw new Error(`Member gateway credential not verified: ${safe ? `token=${safe.token} delta=${safe.delta} render=${safe.render} ${safe.error}` : "authority-unavailable"}`);
  }
  return outcome;
}
