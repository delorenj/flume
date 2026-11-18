import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { remainingMs, throwIfCancelled, type FleetRunContext } from "./runtime";

export interface LiveProcess {
  pid: number;
  employee: string | null;
  kind: "gateway" | "worker" | "interactive";
  state: "attributed" | "ambiguous" | "unattributed" | "error";
  reason: string;
  evidence: string[];
}
export interface LiveProcessReport {
  processes: LiveProcess[];
  errors: string[];
  complete: boolean;
}
export interface LiveProcessSource {
  list(): string[];
  read(pid: string, file: "comm" | "cmdline" | "environ"): Buffer;
}

// Only read bounded bytes; never serialize arbitrary argv or environment values.
export const procSource: LiveProcessSource = {
  list: () => readdirSync("/proc"),
  read: (pid, file) => {
    const fd = openSync(`/proc/${pid}/${file}`, "r");
    try {
      const buffer = Buffer.alloc(16 * 1024 + 1);
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count > 16 * 1024) throw new Error("process metadata exceeds observation bound");
      return buffer.subarray(0, count);
    } finally { closeSync(fd); }
  },
};

const split = (value: Buffer): string[] => value.toString("utf8").split("\0").filter(Boolean);
const safeName = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(name);

// Only exact registered profile names are displayed; unknown identity values may be secrets.
const profileEvidence = (profile: string, names: ReadonlyMap<string, string[]>, source: string): string =>
  names.has(profile) ? `${source} ${profile}` : `${source} unregistered identity`;

export function observeLiveProcesses(
  ctx: FleetRunContext,
  registered: ReadonlyMap<string, string | null>,
  sharedHome: string,
  source: LiveProcessSource = procSource,
): LiveProcessReport {
  throwIfCancelled(ctx);
  const errors: string[] = [];
  const processes: LiveProcess[] = [];
  let entries: string[];
  try { entries = source.list(); }
  catch { return { processes, errors: ["process table unavailable or denied"], complete: false }; }
  if (entries.length > 100_000) return { processes, errors: ["process table exceeds observation bound"], complete: false };
  const numeric = entries.filter((entry) => /^[1-9][0-9]*$/u.test(entry));
  if (numeric.length === 0 && entries.length === 0) return { processes, errors, complete: true };
  if (numeric.length === 0) return { processes, errors: ["process table contains no readable process IDs"], complete: false };
  const names = new Map<string, string[]>();
  for (const [id, profile] of registered) {
    if (profile !== null) names.set(profile, [...(names.get(profile) ?? []), id]);
  }
  const root = resolve(sharedHome);
  for (const pid of numeric.sort((a, b) => Number(a) - Number(b))) {
    remainingMs(ctx);
    let comm: string;
    let args: string[];
    try {
      comm = source.read(pid, "comm").toString("utf8").trim();
    } catch {
      errors.push(`PID ${pid}: process identity unavailable, denied or exited during observation`);
      continue;
    }
    if (comm !== "hermes" && !comm.startsWith("python")) continue;
    try { args = split(source.read(pid, "cmdline")); }
    catch {
      if (comm === "hermes") errors.push(`PID ${pid}: metadata unavailable, denied or exited during observation`);
      continue;
    }
    const command = args[0] ?? "";
    const isHermes = comm === "hermes" || basename(command) === "hermes" ||
      (args[1] === "-m" && args[2] === "hermes");
    if (!isHermes) continue;
    const gateway = args.some((arg, i) => arg === "gateway" && args[i + 1] === "run");
    const kind = gateway ? "gateway" : args.includes("worker") ? "worker" : "interactive";
    let env: string[];
    try { env = split(source.read(pid, "environ")); }
    catch {
      processes.push({ pid: Number(pid), employee: null, kind, state: "error", reason: "identity metadata denied or process exited", evidence: ["Hermes executable/comm"] });
      errors.push(`PID ${pid}: identity metadata unavailable`);
      continue;
    }
    const evidence: string[] = ["Hermes executable/comm"];
    const claims = new Set<string>();
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] !== "--profile" && args[i] !== "--profile-name") continue;
      const value = args[i + 1]!;
      if (safeName(value)) { claims.add(value); evidence.push(profileEvidence(value, names, "--profile")); }
      else evidence.push("invalid profile flag");
    }
    for (const entry of env) {
      if (!entry.startsWith("HERMES_HOME=")) continue;
      const home = entry.slice("HERMES_HOME=".length);
      const normalized = resolve(home);
      if (normalized.startsWith(`${root}${sep}`) && normalized.slice(root.length + 1).startsWith(`profiles${sep}`)) {
        const profile = normalized.slice(root.length + 1 + `profiles${sep}`.length);
        if (safeName(profile)) { claims.add(profile); evidence.push(profileEvidence(profile, names, "HERMES_HOME profile")); }
      } else if (normalized !== root) evidence.push("HERMES_HOME outside declared profile root");
    }
    const owners = new Set([...claims].flatMap((claim) => names.get(claim) ?? []));
    let state: LiveProcess["state"] = "unattributed";
    let reason = gateway ? "shared gateway (host-scoped)" : "no registered profile identity";
    let employee: string | null = null;
    if (claims.size > 1 || owners.size > 1) { state = "ambiguous"; reason = "conflicting profile identities"; }
    else if (claims.size === 1 && owners.size === 1 && !gateway) {
      state = "attributed"; employee = [...owners][0]!; reason = "unique registered profile match";
    } else if (claims.size === 1 && owners.size === 0) reason = "profile identity is not registered";
    else if (gateway && claims.size > 0) { state = "ambiguous"; reason = "shared gateway carries an employee profile identity"; }
    processes.push({ pid: Number(pid), employee, kind, state, reason, evidence });
  }
  remainingMs(ctx);
  return { processes, errors, complete: errors.length === 0 };
}
