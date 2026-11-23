// `flume identity voice`: read, assign, clone or clear the voice an employee SPEAKS.
//
// The agent is the voice's single source of truth. The fleet base (~/.hermes/config.yaml tts.vox.voice) is the
// default; a desk pins its own voice in config.delta.yaml, and Holocene, Telegram and every other surface only render
// what the desk says. This command is the one supported way to change that pin:
//
//   flume identity voice <employee>                                   what it speaks, pinned or inherited
//   flume identity voice <employee> --assign brule [--apply]          pin an existing Vox voice
//   flume identity voice <employee> --assign meg --clone "Meg from Family Guy" [--pick N] [--apply]
//                                                                     clone a new Vox voice (voxxy voice clone), then pin it
//   flume identity voice <employee> --clear [--apply]                 drop the pin: inherit the fleet default again
//
// Run from inside a desk (HERMES_HOME / HERMES_PROFILE), the employee may be omitted: the desk is the employee.
// The pin is written by the template's own voice transform (voice-config.py), never a private copy, so the PM deploy,
// fleet-sync and the specialist provisioner all agree with what this command writes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { resolveFlumeRoot } from "../kernel/paths";
import { callerRunsProfile, cycleProfileViaSocket, deskDirOf, fleetBaseConfigPath, fleetHome, readGateway } from "./channel";
import { deskProfileOf, identityCensus, resolveEmployee } from "./company";

const VOICE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PLUGIN = "vox";
const DEFAULT_VOX_URL = "https://vox.delo.sh";

export interface VoiceOptions {
  assign?: string;
  clone?: string;
  pick?: number;
  clear?: boolean;
  force?: boolean;
  apply?: boolean;
  noReload?: boolean;
}

interface Spoken { voice: string | null; provider: string | null }

export interface VoiceResult {
  ok: boolean;
  apply: boolean;
  employee: string;
  profile: string | null;
  action: "show" | "assign" | "clone+assign" | "clear";
  speaks: Spoken & { source: "pinned" | "fleet default" | "none" };
  fleet_default: string | null;
  to?: string | null;
  changed: boolean;
  clone?: { query: string; name: string; status: "planned" | "cloned" | "degraded" | "failed"; detail: string };
  definition_voice?: { path: string; from: string; to: string | null };
  gateway?: { action: string; confirmed: boolean; detail: string };
  writes: string[];
  blockers: Array<{ code: string; detail: string }>;
  detail: string;
}

function readYaml(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const doc = YAML.parse(readFileSync(path, "utf8"));
  return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
}

/** Vox speaks the top-level tts.voice before tts.<provider>.voice (plugins/vox _resolve_voice). */
function spokenOf(tts: unknown): Spoken {
  if (!tts || typeof tts !== "object") return { voice: null, provider: null };
  const t = tts as Record<string, any>;
  const provider = typeof t.provider === "string" ? t.provider : null;
  const own = provider && t[provider] && typeof t[provider].voice === "string" ? t[provider].voice : null;
  const top = typeof t.voice === "string" && t.voice.trim() ? t.voice.trim() : null;
  return { voice: provider === PLUGIN || provider === null ? (top ?? own) : (own ?? top), provider };
}

function pinnedOf(delta: Record<string, any>): string | null {
  const tts = delta.tts;
  if (!tts || typeof tts !== "object") return null;
  const top = typeof tts.voice === "string" && tts.voice.trim() ? tts.voice.trim() : null;
  const own = tts[PLUGIN] && typeof tts[PLUGIN].voice === "string" && tts[PLUGIN].voice.trim() ? tts[PLUGIN].voice.trim() : null;
  return top ?? own;
}

function voxBase(generated: Record<string, any>, base: Record<string, any>): string {
  const pick = (c: Record<string, any>) => c?.tts?.[PLUGIN]?.base_url;
  const url = pick(generated) ?? pick(base) ?? process.env.VOX_URL ?? DEFAULT_VOX_URL;
  return String(url).replace(/\/+$/u, "");
}

let voxKey: string | null | undefined;
/** Voxxy's key: $VOX_API_KEY, else the op:// ref in $VOX_API_KEY_REF (read once). The voxxy CLI's convention. */
export function voxAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (voxKey === undefined || env !== process.env) {
    let key: string | null = env.VOX_API_KEY?.trim() || null;
    const ref = env.VOX_API_KEY_REF?.trim();
    if (!key && ref) {
      const read = spawnSync("op", ["read", "--no-newline", ref], { encoding: "utf8", timeout: 20_000 });
      key = read.status === 0 ? read.stdout.trim() || null : null;
    }
    if (env !== process.env) return key ? { Authorization: `Bearer ${key}`, "X-API-Key": key } : {};
    voxKey = key;
  }
  return voxKey ? { Authorization: `Bearer ${voxKey}`, "X-API-Key": voxKey } : {};
}

async function voxVoiceExists(baseUrl: string, voice: string): Promise<{ exists: boolean | null; detail: string }> {
  try {
    const response = await fetch(`${baseUrl}/voices/${encodeURIComponent(voice)}`, { headers: voxAuthHeaders(), signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return { exists: false, detail: `Vox has no voice "${voice}" (${baseUrl}/voices)` };
    if (!response.ok) return { exists: null, detail: `Vox answered HTTP ${response.status} for voice "${voice}"` };
    return { exists: true, detail: `Vox voice "${voice}" exists` };
  } catch (error) {
    return { exists: null, detail: `Vox unreachable at ${baseUrl}: ${(error as Error).message}` };
  }
}

function voiceConfigTool(): string {
  return process.env.FLUME_VOICE_CONFIG ?? join(resolveFlumeRoot(), "templates/hermes-agent/template/.scripts/lib/voice-config.py");
}

/** The desk the caller runs inside (HERMES_PROFILE, or HERMES_HOME under the fleet's profiles/), if any. */
export function callerDesk(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HERMES_PROFILE && !env.HERMES_PROFILE.includes("$")) return env.HERMES_PROFILE;
  const home = env.HERMES_HOME;
  if (!home || home.includes("$")) return null;
  const real = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
  const dir = real(home);
  return dirname(dir) === real(join(fleetHome(), "profiles")) ? basename(dir) : null;
}

/** A specialist definition that declares `voice:` is the contract its projection enforces: keep it in step. */
function definitionVoice(path: string, text: string): { from: string; line: RegExp } | null {
  const line = /^voice:[ \t]*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?[ \t]*(#.*)?$/mu;
  const match = text.match(line);
  return match ? { from: match[1]!, line } : null;
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.flume-voice-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

function runClone(query: string, name: string, options: VoiceOptions): { status: "cloned" | "degraded" | "failed"; code: number | null; detail: string } {
  const interactive = Boolean(process.stdin.isTTY) && !options.pick;
  const args = ["voice", "clone", query, "--name", name];
  if (!interactive) args.push("--yes");
  if (options.pick) args.push("--pick", String(options.pick));
  if (options.force) args.push("--force");
  const heavy = spawnSync("sh", ["-c", "command -v heavy"], { encoding: "utf8" }).stdout.trim();
  const [cmd, argv] = heavy ? [heavy, ["voxxy", ...args]] : ["voxxy", args];
  // Progress goes to stderr so stdout stays this command's own report (and valid --json).
  const run = spawnSync(cmd, argv, { stdio: ["inherit", process.stderr, process.stderr] });
  if (run.error) return { status: "failed", code: null, detail: `could not run voxxy: ${run.error.message}` };
  switch (run.status) {
    case 0: return { status: "cloned", code: 0, detail: `voxxy cloned "${query}" as ${name}` };
    case 2: return { status: "degraded", code: 2, detail: `voxxy uploaded ${name}, but its persona or verification fell short (exit 2); listen before relying on it` };
    case 3: return { status: "failed", code: 3, detail: "voxxy could not reach the Vox server (exit 3)" };
    case 5: return { status: "failed", code: 5, detail: `voxxy refused (exit 5): unattended clones of a character need --pick N. Inspect ~/.cache/voxxy/clone/*/markers.json (or run \`voxxy voice candidates\`), then re-run with --pick N; a re-run reuses the download` };
    default: return { status: "failed", code: run.status, detail: `voxxy voice clone failed (exit ${run.status})` };
  }
}

async function pickUp(profile: string, noReload: boolean): Promise<{ action: string; confirmed: boolean; detail: string }> {
  if (!readGateway().running) return { action: "none", confirmed: false, detail: "no running gateway: the desk speaks the new voice when the gateway next starts" };
  if (noReload) return { action: "skipped", confirmed: false, detail: `--no-reload: written, NOT picked up; cycle ${profile} or run hermes-gateway-restart once after the last change` };
  const cycled = await cycleProfileViaSocket(profile);
  if (cycled.ok) return { action: "profile-cycle", confirmed: true, detail: cycled.detail };
  return { action: "unpicked", confirmed: false, detail: `${cycled.detail}; written, NOT picked up${cycled.self ? " (the desk picks it up on its next start)" : ""}` };
}

export async function employeeVoice(employeeArg: string | undefined, options: VoiceOptions = {}): Promise<VoiceResult> {
  const blockers: VoiceResult["blockers"] = [];
  const employee = employeeArg ?? callerDesk();
  const action: VoiceResult["action"] = options.clear ? "clear" : options.clone ? "clone+assign" : options.assign ? "assign" : "show";
  const empty = (detail: string, profile: string | null = null): VoiceResult => ({
    ok: false, apply: Boolean(options.apply), employee: employee ?? "", profile, action,
    speaks: { voice: null, provider: null, source: "none" }, fleet_default: null, changed: false, writes: [], blockers, detail,
  });
  if (!employee) { blockers.push({ code: "no-employee", detail: "name the employee, or run inside a desk (HERMES_HOME)" }); return empty("no employee"); }
  if (options.clear && (options.assign || options.clone)) blockers.push({ code: "invalid-flags", detail: "--clear takes no --assign or --clone" });
  if (options.clone && !options.assign) blockers.push({ code: "invalid-flags", detail: "--clone needs --assign <new-voice-slug>: the name the clone is saved under" });
  if (options.pick !== undefined && !options.clone) blockers.push({ code: "invalid-flags", detail: "--pick only applies to --clone" });
  if (options.assign && !VOICE_SLUG.test(options.assign)) blockers.push({ code: "invalid-voice", detail: `voice "${options.assign}" must match ${VOICE_SLUG.source}` });
  if (blockers.length) return empty("refused");

  const census = identityCensus();
  const target = resolveEmployee(census, employee);
  if (target.missing) { blockers.push({ code: "unknown-employee", detail: `no definition for ${employee}: ${target.path}` }); return empty("refused"); }
  const profile = deskProfileOf(census, target);
  const desk = profile ? deskDirOf(profile) : null;
  if (!profile || !desk || !existsSync(join(desk, "config.delta.yaml"))) {
    blockers.push({ code: "no-desk", detail: `${employee} has no desk under inheritance (${desk ?? "no profile"}/config.delta.yaml)` });
    return empty("refused", profile);
  }
  const deltaPath = join(desk, "config.delta.yaml");
  const generatedPath = join(desk, "config.yaml");
  const base = readYaml(fleetBaseConfigPath());
  const delta = readYaml(deltaPath);
  const generated = readYaml(generatedPath);
  const spoken = spokenOf(generated.tts);
  const pinned = pinnedOf(delta);
  const fleetDefault = spokenOf(base.tts).voice;
  const speaks = { ...spoken, source: (spoken.voice ? (pinned ? "pinned" : "fleet default") : "none") as VoiceResult["speaks"]["source"] };
  const result: VoiceResult = { ok: true, apply: Boolean(options.apply), employee, profile, action, speaks, fleet_default: fleetDefault, changed: false, writes: [], blockers, detail: "" };
  if (action === "show") { result.detail = `${employee} speaks ${spoken.voice ?? "nothing"} (${speaks.source})`; return result; }

  const to = options.clear ? null : options.assign!;
  result.to = to;
  const vox = voxBase(generated, base);
  if (to) {
    const known = await voxVoiceExists(vox, to);
    if (options.clone) {
      result.clone = { query: options.clone, name: to, status: "planned", detail: `voxxy voice clone "${options.clone}" --name ${to}${options.pick ? ` --pick ${options.pick}` : ""}` };
      if (known.exists === true && !options.force) blockers.push({ code: "voice-exists", detail: `Vox already has "${to}": drop --clone to assign it, or pass --force to re-clone over it` });
    } else if (known.exists === false) {
      blockers.push({ code: "unknown-voice", detail: `${known.detail}; pass --clone "<who>" to make it` });
    } else if (known.exists === null) {
      blockers.push({ code: "vox-unverified", detail: known.detail });
    }
  }
  // A specialist definition that names a voice is what its projection enforces; it moves with the pin.
  let definitionEdit: { from: string; line: RegExp } | null = null;
  if (target.kind === "specialist" && target.text) {
    definitionEdit = definitionVoice(target.path, target.text);
    if (definitionEdit && to === null) blockers.push({ code: "definition-pins-voice", detail: `${target.path} declares voice: ${definitionEdit.from}; --clear cannot unpin a definition voice. Remove it there, or --assign another voice` });
    if (definitionEdit) result.definition_voice = { path: target.path, from: definitionEdit.from, to };
  }
  if (blockers.length) return { ...result, ok: false, detail: "refused" };

  const already = to === null ? pinned === null : (pinned === to && spoken.voice === to);
  const definitionDrift = Boolean(definitionEdit && definitionEdit.from !== to);
  result.changed = !already || definitionDrift || Boolean(options.clone);
  if (!result.changed) { result.detail = `${employee} already speaks ${spoken.voice} (${speaks.source})`; return result; }
  if (!options.apply) {
    result.detail = to === null ? `would unpin ${pinned}; ${employee} would speak the fleet default ${fleetDefault ?? "(none)"}` : `would pin ${employee} to ${to}${options.clone ? " after cloning it" : ""}`;
    return result;
  }

  if (options.clone && result.clone) {
    const cloned = runClone(options.clone, to!, options);
    result.clone = { ...result.clone, status: cloned.status, detail: cloned.detail };
    if (cloned.status === "failed") { blockers.push({ code: "clone-failed", detail: cloned.detail }); return { ...result, ok: false, detail: "clone failed; nothing pinned" }; }
    const known = await voxVoiceExists(vox, to!);
    if (known.exists !== true) { blockers.push({ code: "clone-unverified", detail: `after the clone, ${known.detail}` }); return { ...result, ok: false, detail: "clone not found on Vox; nothing pinned" }; }
  }

  const args = ["-I", voiceConfigTool(), "reconcile", "--base", fleetBaseConfigPath(), "--delta", deltaPath, "--generated", generatedPath, "--plugin", PLUGIN];
  if (to === null) args.push("--clear"); else args.push("--voice", to);
  const run = spawnSync("python3", args, { encoding: "utf8" });
  if (run.status !== 0) {
    blockers.push({ code: "pin-failed", detail: `voice-config.py reconcile failed: ${(run.stderr || run.stdout || "").trim().split("\n").slice(-2).join(" ")}` });
    return { ...result, ok: false, detail: "pin failed" };
  }
  result.writes.push(deltaPath, generatedPath);
  if (definitionEdit && definitionDrift && to) {
    atomicWrite(target.path, target.text.replace(definitionEdit.line, `voice: ${to}`));
    result.writes.push(target.path);
  }
  const after = spokenOf(readYaml(generatedPath).tts).voice;
  const want = to ?? fleetDefault;
  if (after !== want) {
    blockers.push({ code: "pin-unverified", detail: `rendered config speaks ${after ?? "nothing"}, expected ${want ?? "nothing"}` });
    return { ...result, ok: false, detail: "pin did not read back" };
  }
  result.speaks = { voice: after, provider: PLUGIN, source: to ? "pinned" : "fleet default" };
  // Runs inside its own desk? Never cycle it (that would cut this very turn).
  result.gateway = callerRunsProfile(profile)
    ? { action: "unpicked", confirmed: false, detail: `written from inside ${profile}: picked up on its next start or cycle` }
    : await pickUp(profile, Boolean(options.noReload));
  result.detail = `${employee} now speaks ${after} (${result.speaks.source})`;
  return result;
}

export function formatVoiceResult(result: Record<string, any>): string {
  const lines: string[] = [];
  if (result.error) return `✗ ${result.error}\n`;
  const mode = result.action === "show" ? "" : result.apply ? " --apply" : " (preview)";
  lines.push(`${result.employee || "?"}: voice ${result.action}${mode}${result.profile ? ` — desk ${result.profile}` : ""}`);
  if (result.speaks?.voice !== undefined) lines.push(`  speaks       ${result.speaks.voice ?? "nothing"} (${result.speaks.source})${result.fleet_default ? `; fleet default ${result.fleet_default}` : ""}`);
  if (result.clone) lines.push(`  clone        ${result.clone.status}: ${result.clone.detail}`);
  if (result.definition_voice) lines.push(`  definition   ${result.definition_voice.path}: voice ${result.definition_voice.from} -> ${result.definition_voice.to ?? "(unchanged)"}`);
  for (const b of result.blockers ?? []) lines.push(`  ✗ ${b.code}: ${b.detail}`);
  for (const w of result.writes ?? []) lines.push(`  wrote ${w}`);
  if (result.gateway) lines.push(`  gateway      ${result.gateway.action}: ${result.gateway.detail}`);
  lines.push(result.detail);
  if (result.ok && result.changed && !result.apply && result.action !== "show") lines.push("Preview only: nothing was written and nothing was cloned. Pass --apply.");
  return `${lines.join("\n")}\n`;
}
