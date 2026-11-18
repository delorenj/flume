import { readFileSync, lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { FleetError } from "./types";
import { remainingMs, type FleetRunContext } from "./runtime";

/** Hermes gateway/control_socket.py: identify is a live, argument-free read of its served authorities. */
export const BLOODBANK_ROUTE_SOURCE = "gateway-control-identify";
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface BloodbankRouteResult {
  state: "pass" | "fail" | "unobserved" | "error";
  reason: string;
  /** A stable, non-secret category; never a raw gateway response. */
  observed: string;
  evidence: "direct" | "absent";
  probe: "ok" | "failed" | "timeout";
}

function result(state: BloodbankRouteResult["state"], reason: string, probe: BloodbankRouteResult["probe"] = "ok"): BloodbankRouteResult {
  return { state, reason, observed: reason, evidence: state === "pass" || state === "fail" ? "direct" : "absent", probe };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function socketPath(home: string): string | null {
  const direct = join(home, "gateway.sock");
  try {
    const stat = lstatSync(direct);
    if (stat.isSocket() && stat.uid === process.getuid?.()) return direct;
    return null;
  } catch { /* Hermes can publish a private pointer for a long home path. */ }
  try {
    const pointer = join(home, "gateway.sock.path");
    const stat = lstatSync(pointer);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 256) return null;
    const target = readFileSync(pointer, "utf8").trim();
    if (!isAbsolute(target)) return null;
    const endpoint = lstatSync(target);
    if (!endpoint.isSocket() || endpoint.uid !== process.getuid?.()) return null;
    return target;
  } catch { return null; }
}

/** Only the identify verb is sent; neither route lookup nor dispatch has a read-safe command verb. */
export async function observeBloodbankRoute(run: FleetRunContext, home: string, profileRoot: string | null, agentId: string, profile: string | null, scope: string | null, target: string | null): Promise<BloodbankRouteResult> {
  remainingMs(run);
  if (scope === null) return result("fail", "routing-scope-missing");
  if (scope !== "fleet") return result("fail", "routing-scope-not-fleet");
  if (target === null) return result("fail", "routing-target-missing");
  if (target !== agentId) return result("fail", "routing-target-mismatch");
  if (profile === null || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(profile)) return result("fail", "routing-profile-missing-or-invalid");
  if (profileRoot === null) return result("unobserved", "profile-layout-unresolved", "failed");
  const wanted = resolve(profileRoot, profile);
  if (wanted !== join(profileRoot, profile)) return result("fail", "routing-profile-unresolved");
  try {
    const dir = lstatSync(wanted);
    if (!dir.isDirectory()) return result("fail", "routing-profile-unresolved");
  } catch { return result("fail", "routing-profile-unresolved"); }
  const path = socketPath(home);
  if (path === null) return result("unobserved", "gateway-control-socket-unavailable", "failed");
  const budget = Math.min(remainingMs(run), run.probeTimeoutMs);
  const answer = await new Promise<BloodbankRouteResult>((settle) => {
    const socket = createConnection(path);
    let finished = false;
    let bytes = 0;
    let response = "";
    const finish = (value: BloodbankRouteResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      run.signal.removeEventListener("abort", abort);
      socket.destroy();
      settle(value);
    };
    const abort = () => finish(result("error", "gateway-inspection-cancelled", "failed"));
    const timer = setTimeout(() => finish(result("unobserved", "gateway-inspection-timeout", "timeout")), budget);
    socket.on("connect", () => socket.write('{"verb":"identify","id":1,"protocol":1}\n'));
    socket.on("error", (error: NodeJS.ErrnoException) => finish(result("unobserved", error.code === "EACCES" || error.code === "EPERM" ? "gateway-inspection-denied" : "gateway-inspection-failed", "failed")));
    socket.on("end", () => finish(result("unobserved", "gateway-inspection-incomplete", "failed")));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return finish(result("error", "gateway-inspection-oversized", "failed"));
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      let parsed: unknown;
      try { parsed = JSON.parse(response.slice(0, newline)); }
      catch { return finish(result("error", "gateway-inspection-malformed", "failed")); }
      if (!record(parsed) || parsed.protocol !== 1 || parsed.id !== 1 || parsed.ok !== true || !record(parsed.result)) {
        return finish(result("error", "gateway-inspection-invalid-envelope", "failed"));
      }
      const identity = parsed.result;
      if (identity.runtime_protocol !== 1 || typeof identity.hermes_home !== "string" || resolve(identity.hermes_home) !== resolve(home)) {
        return finish(result("error", "gateway-identity-mismatch", "failed"));
      }
      if (identity.state !== "ready" || !Array.isArray(identity.capabilities) || !identity.capabilities.includes("session-authority-v1")) {
        return finish(result("unobserved", "gateway-not-ready", "ok"));
      }
      if (!Array.isArray(identity.served_profiles) || !identity.served_profiles.every((entry) =>
        record(entry) && typeof entry.profile_id === "string" && typeof entry.home === "string" && isAbsolute(entry.profile_id) && isAbsolute(entry.home))) {
        return finish(result("unobserved", "gateway-route-evidence-missing", "ok"));
      }
      const served = identity.served_profiles as Array<{ profile_id: string; home: string }>;
      if (served.some((entry) => resolve(entry.profile_id) !== entry.profile_id || resolve(entry.home) !== entry.home)) {
        return finish(result("error", "gateway-route-evidence-invalid", "failed"));
      }
      const matches = served.filter((entry) => entry.profile_id === wanted && entry.home === wanted);
      const conflicts = served.some((entry) => entry.profile_id === wanted && entry.home !== wanted || entry.home === wanted && entry.profile_id !== wanted);
      if (conflicts || matches.length > 1) return finish(result("fail", "gateway-route-conflict"));
      if (matches.length === 0) return finish(result("fail", "gateway-profile-not-served"));
      return finish(result("pass", "gateway-serves-declared-profile"));
    });
    run.signal.addEventListener("abort", abort, { once: true });
    if (run.signal.aborted) abort();
  });
  if (run.signal.aborted) throw new FleetError("CANCELLED", "Fleet command was cancelled before it completed");
  remainingMs(run);
  return answer;
}
