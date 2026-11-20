// Identity manifests (FLUME-93, AD-2..AD-6): the canonical, versioned set of identity points an employee is expected
// to hold, and a read-only evaluator that says which of them this employee satisfies.
//
// The manifest is declarative (AD-5): it names points, whether each is required, and what it means. How a point is
// judged lives here, in one reviewed evaluator per point id. A new integration is a new point plus a new manifest
// version, never an edit to a published one.
//
// Evaluation is LOCAL ONLY: the owning definition, the desk config files, the provisioning and identity receipts,
// Holocene's avatar index and the gateway state file. No provider is asked anything, so it is cheap enough for a shell
// prompt's background refresher and never needs a secret. That bound is stated on every point: "satisfied" means the
// company provisioned and recorded it, not that the provider still answers right now (`flume identity credentials`
// asks the providers).
//
// Adoption (AD-2/AD-3: an employee explicitly adopts a manifest version) has no record yet, so every employee is
// evaluated against the latest manifest and `adopted` is null until the adoption record exists.
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { provisionStateDir } from "./access-issuance";
import { channelList, fleetHome } from "./channel";
import { deskProfileOf, identityCensus, resolveEmployee, type IdentityCensus, type IdentityDefinition } from "./company";
import { deskGatewayConsumer } from "./gateway-desk";
import { planeDeskRow } from "./plane-desk";
import { COMPANY_MAIL_DOMAIN } from "./validator";

export interface ManifestPoint {
  id: string;
  title: string;
  required: boolean;
  /** What satisfying it means, in the operator's words. */
  means: string;
}

export interface IdentityManifest { version: number; points: ManifestPoint[] }

/** Published manifests, oldest first. Never edit a published version: add the next one. */
export const IDENTITY_MANIFESTS: readonly IdentityManifest[] = [
  {
    version: 1,
    // AD-4: Telegram optional; the remaining original core requirements are required. GitHub is not a v1 point.
    points: [
      { id: "vault", title: "1Password Identity", required: true, means: "the employee's own Identity item in the company vault" },
      { id: "gateway", title: "AAI gateway key", required: true, means: "the desk runs its own AutomaticAI gateway consumer, not the shared one" },
      { id: "plane", title: "Plane identity", required: true, means: "a native Plane user, verified by Pilot, whose key the desk runs" },
      { id: "inbox", title: "private inbox", required: true, means: `<handle>@${COMPANY_MAIL_DOMAIN} routed and allowlisted` },
      { id: "voice", title: "voice", required: true, means: "a personal voice slug, not the inherited fleet default" },
      { id: "avatar", title: "avatar", required: true, means: "an avatar held by Holocene (holocene.delo.sh/agents)" },
      { id: "telegram", title: "Telegram", required: false, means: "a linked bot the gateway runs" },
    ],
  },
];

export const LATEST_IDENTITY_MANIFEST = IDENTITY_MANIFESTS[IDENTITY_MANIFESTS.length - 1]!;

export interface PointResult { id: string; title: string; required: boolean; satisfied: boolean; detail: string; evidence?: Record<string, unknown> }

interface PointContext {
  census: IdentityCensus;
  target: IdentityDefinition;
  profile: string | null;
  receipts: Array<Record<string, unknown>>;
  registry: Record<string, Record<string, unknown>>;
}

type Evaluator = (ctx: PointContext) => Omit<PointResult, "id" | "title" | "required">;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYamlFile(path: string): Record<string, any> | undefined {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    const parsed = YAML.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

/** provision/receipts.jsonl rows; a torn line is not an observation. */
function provisionReceipts(): Array<Record<string, unknown>> {
  const path = join(provisionStateDir(), "receipts.jsonl");
  let text: string;
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) return [];
    text = readFileSync(path, "utf8");
  } catch { return []; }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (isRecord(row)) rows.push(row); } catch { /* torn */ }
  }
  return rows;
}

const OP_ITEM = /^op:\/\/[^/]+\/([a-z0-9]{26})\/.+$/u;
const VOICE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const AVATAR_FILE = /^[a-z0-9][a-z0-9-]*\.[0-9a-f]{16}\.jpg$/u;

export function holoceneAvatarDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOLOCENE_AVATAR_DIR || join(env.HOME || homedir(), ".local", "share", "holocene", "avatars");
}

/** The provider and voice a tts block actually speaks with (vox: tts.voice, then tts.vox.voice; others: tts.<provider>.voice, then tts.voice). */
function spokenVoice(tts: unknown): { provider: string; voice: string } | undefined {
  if (!isRecord(tts)) return undefined;
  const provider = typeof tts.provider === "string" && tts.provider ? tts.provider : "vox";
  const own = isRecord(tts[provider]) && typeof tts[provider].voice === "string" ? tts[provider].voice : undefined;
  const top = typeof tts.voice === "string" && tts.voice.trim() ? tts.voice.trim() : undefined;
  const voice = provider === "vox" ? (top ?? own) : (own ?? top);
  return voice && VOICE_SLUG.test(voice) ? { provider, voice } : undefined;
}

/** The tts block a render would produce: the base's, with the delta's keys (one level of provider blocks) on top. */
function mergeTts(base: unknown, delta: unknown): Record<string, any> | undefined {
  if (!isRecord(delta)) return isRecord(base) ? base : undefined;
  const merged: Record<string, any> = { ...(isRecord(base) ? base : {}) };
  for (const [key, value] of Object.entries(delta)) merged[key] = isRecord(value) && isRecord(merged[key]) ? { ...merged[key], ...value } : value;
  return merged;
}

function isRealFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function isRealDir(path: string): boolean {
  try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}

/** An account point on a definition that holds no identity block: say why (unreadable beats unenrolled). */
function notEnrolled(target: IdentityDefinition) {
  return { satisfied: false, detail: target.problem ? `definition unreadable: ${target.problem}` : target.missing ? "definition missing" : "not enrolled (no company identity)" };
}

const EVALUATORS: Record<string, Evaluator> = {
  vault({ target, receipts }) {
    const block = target.block;
    if (!block) return notEnrolled(target);
    const mine = receipts.filter(r => r.employee === block.handle);
    const created = mine.find(r => r.capability === "vault-item" && typeof r.item_id === "string" && (r.action === "created" || r.action === "no-op"));
    if (created) return { satisfied: true, detail: `vault item ${created.item_id} (vault-item receipt)`, evidence: { item: created.item_id } };
    // An item that pre-dates the vault-item receipt is proven by the Access binding that lives in it AND the receipt
    // that recorded the token written there: both must name the same item.
    const item = OP_ITEM.exec(block.bindings?.cloudflare_access?.credential_ref ?? "")?.[1];
    if (item && mine.some(r => r.item === item)) return { satisfied: true, detail: `vault item ${item} (Access binding + issuance receipt)`, evidence: { item } };
    if (item) return { satisfied: false, detail: `Access binding names item ${item} but no receipt for ${block.handle} records it` };
    return { satisfied: false, detail: `no identity item recorded for ${block.handle}: flume identity provision ${target.posts[0] ?? block.handle} --apply` };
  },

  gateway({ target, profile, registry }) {
    if (!profile || !isRealDir(join(fleetHome(), "profiles", profile))) return { satisfied: false, detail: `no desk${profile ? ` (${profile})` : ""}` };
    const desk = deskGatewayConsumer(fleetHome(), profile);
    if (desk.unreadable) return { satisfied: false, detail: `${profile}: generated config.yaml unreadable` };
    if (!desk.consumer) return { satisfied: false, detail: `${profile}: runs no FLUME-39 gateway consumer` };
    if (desk.consumer === "hermes") return { satisfied: false, detail: `${profile}: runs the shared fleet consumer \`hermes\`` };
    if (desk.drift) return { satisfied: false, detail: `${profile}: running config drifts from its delta (re-render the desk)`, evidence: { consumer: desk.consumer } };
    const sharedWith = Object.entries(registry).filter(([post, row]) => !target.posts.includes(post) && isRecord(row) && row.gateway_consumer === desk.consumer).map(([post]) => post);
    if (sharedWith.length) return { satisfied: false, detail: `consumer ${desk.consumer} is shared with ${sharedWith.join(", ")}`, evidence: { consumer: desk.consumer } };
    return { satisfied: true, detail: `own consumer ${desk.consumer}`, evidence: { consumer: desk.consumer, source: desk.source } };
  },

  plane({ census, target }) {
    if (!target.block) return notEnrolled(target);
    const row = planeDeskRow(census, target);
    return { satisfied: row.standing === "own-key", detail: `${row.standing}: ${row.detail}`, ...(row.want ? { evidence: { credential_ref: row.want } } : {}) };
  },

  inbox({ target, receipts }) {
    const block = target.block;
    if (!block) return notEnrolled(target);
    // Suspension deletes the allowlist key; the append-only receipts would otherwise keep reading satisfied.
    if (block.status !== "active") return { satisfied: false, detail: `${block.email}: ${block.status} (allowlist closed)` };
    const key = `allowlist/${block.email.toLowerCase()}`;
    const allowed = receipts.some(r => r.employee === block.handle && r.capability === "mailbox-allowlist" && r.key === key && (r.action === "created" || r.action === "no-op"));
    if (!allowed) return { satisfied: false, detail: `${block.email}: no mailbox allowlist receipt` };
    return { satisfied: true, detail: `${block.email} allowlisted`, evidence: { address: block.email } };
  },

  voice({ profile }) {
    // Judge the voice the desk SPEAKS, not the keys its delta sets: Hermes runs the generated config.yaml (the fleet
    // base merged with the delta), and for vox the top-level tts.voice wins over tts.vox.voice (plugins/vox
    // _resolve_voice). A delta that sets only tts.vox.voice still speaks the base's tts.voice.
    const fleet = fleetHome();
    const base = readYamlFile(join(fleet, "config.yaml"));
    const fleetDefault = spokenVoice(base?.tts);
    if (!profile) return { satisfied: false, detail: "no desk" };
    const desk = join(fleet, "profiles", profile);
    const generated = readYamlFile(join(desk, "config.yaml"));
    const tts = generated ? generated.tts : mergeTts(base?.tts, readYamlFile(join(desk, "config.delta.yaml"))?.tts);
    const spoken = spokenVoice(tts);
    if (!spoken) return { satisfied: false, detail: "no voice configured" };
    if (fleetDefault && spoken.provider === fleetDefault.provider && spoken.voice === fleetDefault.voice) {
      return { satisfied: false, detail: `speaks the fleet default ${spoken.voice} (${spoken.provider})` };
    }
    return { satisfied: true, detail: `${spoken.voice} (${spoken.provider})`, evidence: { voice: spoken.voice, provider: spoken.provider, source: generated ? "generated" : "delta" } };
  },

  avatar({ target, profile }) {
    const store = holoceneAvatarDir();
    let index: Record<string, any> | undefined;
    try { const parsed = JSON.parse(readFileSync(join(store, "index.json"), "utf8")); index = isRecord(parsed?.agents) ? parsed.agents : undefined; } catch { /* below */ }
    if (!index) return { satisfied: false, detail: `no Holocene avatar store at ${store}` };
    for (const key of [...target.posts, ...(profile && !target.posts.includes(profile) ? [profile] : [])]) {
      const rec = index[key];
      if (!isRecord(rec) || typeof rec.file !== "string" || !AVATAR_FILE.test(rec.file)) continue;
      try {
        const info = lstatSync(join(store, "files", rec.file));
        if (info.isFile() && info.size > 0) return { satisfied: true, detail: `${rec.file} (${rec.source ?? "holocene"})`, evidence: { file: rec.file, source: rec.source, updated_at: rec.updatedAt } };
      } catch { /* missing file: try the next post */ }
    }
    return { satisfied: false, detail: "Holocene holds no avatar file for this employee" };
  },

  telegram({ target }) {
    const post = target.posts[0];
    if (!post) return { satisfied: false, detail: "no registry post" };
    let list;
    try { list = channelList(post); }
    catch (error) { return { satisfied: false, detail: (error as Error).message }; }
    const row = list.rows.find(r => r.platform === "telegram");
    if (!row || row.standing === "deferred" || row.standing === "unwired") return { satisfied: false, detail: "not linked" };
    const bot = row.bot_username ? `@${row.bot_username}` : "bot";
    // channelList calls a wired channel `online` unless the gateway says fatal; the point wants it actually running.
    if (row.standing === "online") {
      if (!list.gateway_running) return { satisfied: false, detail: `${bot} linked, but the gateway is not running` };
      if (row.gateway?.state !== "connected") return { satisfied: false, detail: `${bot} linked, gateway state ${row.gateway?.state ?? "unknown"}` };
      return { satisfied: true, detail: `${bot} connected`, evidence: { bot_username: row.bot_username, gateway: row.gateway.state } };
    }
    return { satisfied: false, detail: `${bot} ${row.standing}${row.notes.length ? `: ${row.notes.join("; ")}` : ""}` };
  },
};

function registryOf(census: IdentityCensus): Record<string, Record<string, unknown>> {
  const doc = readYamlFile(census.registryPath);
  return isRecord(doc?.agents) ? doc!.agents : {};
}

export function evaluateManifest(census: IdentityCensus, target: IdentityDefinition, manifest: IdentityManifest = LATEST_IDENTITY_MANIFEST) {
  let profile: string | null = null;
  try { profile = deskProfileOf(census, target); } catch { /* the points that need a desk say "no desk" */ }
  const ctx: PointContext = { census, target, profile, receipts: provisionReceipts(), registry: registryOf(census) };
  const points: PointResult[] = manifest.points.map(point => {
    const evaluate = EVALUATORS[point.id];
    let judged: Omit<PointResult, "id" | "title" | "required">;
    try { judged = evaluate ? evaluate(ctx) : { satisfied: false, detail: `no evaluator registered for point ${point.id}` }; }
    catch (error) { judged = { satisfied: false, detail: `unreadable: ${(error as Error).message}` }; }
    return { id: point.id, title: point.title, required: point.required, ...judged };
  });
  const required = points.filter(p => p.required), optional = points.filter(p => !p.required);
  return {
    manifest: { version: manifest.version, latest: LATEST_IDENTITY_MANIFEST.version, adopted: null as number | null },
    points,
    satisfied: required.filter(p => p.satisfied).length,
    total: required.length,
    optional: { satisfied: optional.filter(p => p.satisfied).length, total: optional.length },
  };
}

/** `flume identity manifest <employee>`: which identity points this employee holds, from local evidence only. */
export function employeeManifest(employee: string) {
  const census = identityCensus();
  // Without a registry every employee is "not found"; say what is actually wrong so a caller never reads it as unhired.
  if (!isRealFile(census.registryPath)) throw new Error(`Agent registry not readable: ${census.registryPath}`);
  const target = resolveEmployee(census, employee);
  const block = target.block;
  return {
    ok: true,
    employee,
    posts: target.posts,
    person: target.person,
    definition: target.path,
    enrolled: Boolean(block),
    ...(block ? { handle: block.handle, status: block.status } : {}),
    ...evaluateManifest(census, target),
    note: "Local evidence only: satisfied means provisioned and recorded, not that the provider answers now (flume identity credentials asks the providers). No adoption record exists yet; evaluated against the latest manifest.",
  };
}

export function formatManifestResult(result: Record<string, any>): string {
  if (!result.ok) return `✗ ${result.error ?? "manifest evaluation failed"}\n`;
  const who = result.enrolled ? `${result.handle} (${result.status})` : "not enrolled";
  const lines = [`${result.employee}: ${who} · identity manifest v${result.manifest.version} · ${result.satisfied}/${result.total} required${result.optional.total ? ` · ${result.optional.satisfied}/${result.optional.total} optional` : ""}`];
  for (const point of result.points) lines.push(`  ${point.satisfied ? "✓" : "✗"} ${point.title}${point.required ? "" : " (optional)"}: ${point.detail}`);
  return `${lines.join("\n")}\n`;
}
