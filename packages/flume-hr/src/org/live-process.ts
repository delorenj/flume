import { probeRaw, remainingMs, type FleetRunContext } from "./runtime";

export interface LiveProcess {
  pid: number;
  employee: string | null;
  kind: "gateway" | "worker" | "interactive";
  state: "attributed" | "ambiguous" | "unattributed" | "error";
  sharedGateway: boolean;
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

// Self-contained so the same typed parser runs inside the bounded read-only child.
// Only sanitized attribution facts cross its stdout; raw metadata stays in the child.
export function scanLiveProcesses(
  registered: [string, string | null][],
  sharedHome: string,
  source: LiveProcessSource,
  paths: Pick<typeof import("node:path"), "resolve" | "basename" | "sep">,
): LiveProcessReport {
  const errors: string[] = [];
  const processes: LiveProcess[] = [];
  let entries: string[];
  try { entries = source.list(); }
  catch { return { processes, errors: ["process table unavailable or denied"], complete: false }; }
  if (entries.length > 100_000) return { processes, errors: ["process table exceeds observation bound"], complete: false };
  const numeric = [...new Set(entries.filter((entry) => /^[1-9][0-9]*$/u.test(entry)))];
  if (numeric.length === 0 && entries.length !== 0) return { processes, errors: ["process table contains no readable process IDs"], complete: false };
  const names = new Map<string, string[]>();
  for (const [id, profile] of registered) {
    if (profile !== null) names.set(profile, [...(names.get(profile) ?? []), id]);
  }
  const split = (value: Buffer): string[] => {
    const parts = value.toString("utf8").split("\0");
    if (parts[parts.length - 1] === "") parts.pop(); // Only the final NUL is a delimiter, not argv data.
    return parts;
  };
  const safeName = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(name);
  const root = paths.resolve(sharedHome);
  const profileRoot = `${root}${paths.sep}profiles${paths.sep}`;
  for (const pid of numeric.sort((a, b) => Number(a) - Number(b))) {
    let comm: string;
    let args: string[];
    try { comm = source.read(pid, "comm").toString("utf8").trim(); }
    catch {
      errors.push(`PID ${pid}: process identity unavailable, denied or exited during observation`);
      continue;
    }
    if (comm !== "hermes" && !/^python(?:[0-9.]+)?$/u.test(comm)) continue;
    try { args = split(source.read(pid, "cmdline")); }
    catch {
      // An unreadable Python command might be a supported Hermes entrypoint.
      errors.push(`PID ${pid}: candidate command unavailable, denied or exited during observation`);
      continue;
    }
    let start = -1;
    if (paths.basename(args[0] ?? "") === "hermes") start = 1;
    else if (comm === "hermes") start = 1;
    else {
      // Python processes short options left to right. -m/-c end option parsing;
      // -W/-X consume the rest of their group or the following argv element.
      let uncertain = false;
      const modules = ["hermes", "hermes_cli", "hermes_cli.main"];
      const possibleEntrypoint = (index: number): boolean => {
        const value = args[index] ?? "";
        return paths.basename(value) === "hermes" ||
          (value === "-m" && modules.includes(args[index + 1] ?? "")) ||
          (/^-[bBdEhiIOPqsStuUvVxRt]*m$/u.test(value) && modules.includes(args[index + 1] ?? "")) ||
          /^-[bBdEhiIOPqsStuUvVxRt]*m(?:hermes|hermes_cli(?:\.main)?)$/u.test(value);
      };
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "-" || ["--help", "--help-all", "--help-env", "--help-xoptions", "--version"].includes(arg)) break;
        if (arg === "--") {
          if (paths.basename(args[i + 1] ?? "") === "hermes") start = i + 2;
          break;
        }
        if (arg === "--check-hash-based-pycs") {
          if (++i >= args.length) errors.push(`PID ${pid}: Python entrypoint options could not be resolved`);
          continue;
        }
        if (arg.startsWith("--check-hash-based-pycs=")) continue;
        if (arg.startsWith("-")) {
          if (!arg.startsWith("--")) {
            let terminal = false;
            let consumed = false;
            for (let j = 1; j < arg.length; j++) {
              const option = arg[j]!;
              if (option === "c") { terminal = true; break; }
              if (option === "m") {
                const module = arg.slice(j + 1) || args[++i] || "";
                if (!module) errors.push(`PID ${pid}: Python entrypoint options could not be resolved`);
                else if (modules.includes(module)) {
                  if (uncertain) errors.push(`PID ${pid}: Python entrypoint options could not be resolved`);
                  else start = i + 1;
                }
                terminal = true;
                break;
              }
              if (option === "W" || option === "X") {
                if (j + 1 === arg.length && ++i >= args.length) errors.push(`PID ${pid}: Python entrypoint options could not be resolved`);
                consumed = true;
                break;
              }
              if (!"bBdEhiIOPqsStuUvVxRt".includes(option)) { uncertain = true; break; }
            }
            if (terminal) break;
            if (consumed) continue;
          } else {
            uncertain = true;
          }
          continue;
        }
        if (paths.basename(arg) === "hermes") {
          if (uncertain) errors.push(`PID ${pid}: Python entrypoint options could not be resolved`);
          else start = i + 1;
        } else if (uncertain) {
          // An unknown switch may consume this argument; a later explicit
          // entrypoint is uncertain rather than proof of an empty process table.
          for (let j = i + 1; j < args.length; j++) {
            if (args[j] === "-c" || args[j]?.startsWith("-c")) break;
            if (possibleEntrypoint(j)) {
              errors.push(`PID ${pid}: Python entrypoint options could not be resolved`);
              break;
            }
          }
        }
        break; // The first positional argument is the script, not later text.
      }
    }
    if (start < 0) continue;

    const evidence = ["Hermes entrypoint/comm"];
    const claims = new Set<string>();
    let invalid = false;
    const claim = (value: string, label: string): void => {
      if (!safeName(value)) { invalid = true; evidence.push(`invalid ${label}`); return; }
      claims.add(value);
      evidence.push(names.has(value) ? `${label} ${value}` : `${label} unregistered identity`);
    };
    // Hermes accepts selectors after an action too. Skip value-taking options
    // so prompt text is not parsed as flags, and stop at nested-command argv.
    const valueFlags = new Set(["-z", "--oneshot", "-m", "--model", "--provider", "--reasoning", "-t", "--toolsets", "-r", "--resume", "-s", "--skills", "--usage-file", "--in", "-q", "--query", "--prompt", "--token"]);
    let action = -1;
    let mcp = false;
    let mcpAdd = false;
    for (let i = start; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--" || (arg === "--args" && mcpAdd)) break;
      if (["--profile", "--profile-name", "-p"].includes(arg)) claim((args[++i] ?? "").trim().toLowerCase(), "profile flag");
      else if (arg.startsWith("--profile=") || arg.startsWith("--profile-name=")) claim(arg.slice(arg.indexOf("=") + 1).trim().toLowerCase(), "profile flag");
      else if (valueFlags.has(arg)) i++;
      else if (["-c", "--continue"].includes(arg)) { if (args[i + 1] && !args[i + 1]!.startsWith("-")) i++; }
      else if (!arg.startsWith("-")) {
        if (action < 0) { action = i; mcp = arg === "mcp"; }
        else if (mcp && arg === "add") mcpAdd = true;
      }
    }
    const kind: LiveProcess["kind"] = args[action] === "gateway" && args[action + 1] === "run" ? "gateway" : args[action] === "worker" ? "worker" : "interactive";
    let env: string[];
    try { env = split(source.read(pid, "environ")); }
    catch {
      processes.push({ pid: Number(pid), employee: null, kind, state: "error", sharedGateway: false, reason: "identity metadata denied or process exited", evidence });
      errors.push(`PID ${pid}: identity metadata unavailable`);
      continue;
    }
    let sharedRoot = false;
    let foreignHome = false;
    for (const entry of env) {
      if (!entry.startsWith("HERMES_HOME=")) continue;
      const home = entry.slice("HERMES_HOME=".length);
      // Empty/relative homes cannot prove a shared runtime identity.
      const normalized = paths.resolve(home);
      if (home.startsWith(paths.sep) && normalized === root) {
        sharedRoot = true; evidence.push("HERMES_HOME declared shared root");
      } else if (home.startsWith(paths.sep) && normalized.startsWith(profileRoot) && safeName(normalized.slice(profileRoot.length))) {
        claim(normalized.slice(profileRoot.length), "HERMES_HOME profile");
      } else {
        foreignHome = true; evidence.push("HERMES_HOME outside declared profile root or invalid");
      }
    }
    // --profile default is how the installed launcher selects the shared home.
    const gatewayDefault = kind === "gateway" && claims.size === 1 && claims.has("default") && sharedRoot && !names.has("default");
    const owners = new Set([...claims].flatMap((value) => names.get(value) ?? []));
    let state: LiveProcess["state"] = "unattributed";
    let reason = "no registered profile identity";
    let employee: string | null = null;
    const sharedGateway = kind === "gateway" && sharedRoot && !foreignHome && !invalid && (claims.size === 0 || gatewayDefault);
    if (foreignHome || invalid || claims.size > 1 || owners.size > 1 || (sharedRoot && claims.size > 0 && !gatewayDefault)) {
      state = "ambiguous"; reason = "conflicting or invalid runtime identity evidence";
    } else if (sharedGateway) reason = "shared gateway at declared root (host-scoped)";
    else if (kind === "gateway") reason = claims.size > 0 ? "gateway profile identity is not the declared shared runtime" : "gateway lacks declared shared-root identity";
    else if (claims.size === 1 && owners.size === 1) {
      state = "attributed"; employee = [...owners][0]!; reason = "unique registered profile match";
    } else if (claims.size === 1) reason = "profile identity is not registered";
    processes.push({ pid: Number(pid), employee, kind, state, sharedGateway, reason, evidence });
  }
  return { processes, errors, complete: errors.length === 0 };
}

export async function observeLiveProcesses(
  ctx: FleetRunContext,
  registered: ReadonlyMap<string, string | null>,
  sharedHome: string,
): Promise<LiveProcessReport> {
  remainingMs(ctx);
  // A synchronous /proc read can block. Isolate enumeration so the runtime can
  // enforce wall-clock limits/cancellation by terminating only this probe child,
  // never any observed process. Each read is capped independently at 16 KiB.
  const script = `
const fs = require('node:fs');
const scan = ${scanLiveProcesses.toString()};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const { registered, sharedHome } = JSON.parse(input);
  const source = {
    list: () => fs.readdirSync('/proc'),
    read: (pid, file) => {
      const fd = fs.openSync('/proc/' + pid + '/' + file, 'r');
      try {
        const buffer = Buffer.alloc(16 * 1024 + 1);
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (count > 16 * 1024) throw Error('metadata bound');
        return buffer.subarray(0, count);
      } finally { fs.closeSync(fd); }
    }
  };
  process.stdout.write(JSON.stringify(scan(registered, sharedHome, source, require('node:path'))));
});`;
  const result = await probeRaw(ctx, [process.execPath, "--eval", script], undefined, JSON.stringify({ registered: [...registered], sharedHome }));
  // Deadline/cancellation must not be downgraded to a partial observation.
  remainingMs(ctx);
  if (result.outcome !== "ok" || result.value === null) return {
    processes: [], errors: [`process observation probe ${result.outcome}`], complete: false,
  };
  try { return JSON.parse(result.value.toString("utf8")) as LiveProcessReport; }
  catch { return { processes: [], errors: ["process observation probe returned invalid metadata"], complete: false }; }
}
