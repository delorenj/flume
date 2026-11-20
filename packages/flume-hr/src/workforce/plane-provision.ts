// FLUME-62/93: the `plane` capability of `flume identity provision` -- one command from an enrolled employee to a
// native Plane user that comments as itself.
//
// Pilot owns every Plane write. Since Plane is self-hosted, `px identity enroll` (PX-26) enrolls the employee through
// Plane's own Django ORM -- user, profile, workspace and project memberships, a personal access token labelled
// `px-identity:<handle>` -- vaults the token in 1Password without argv exposure, and verifies it with users/me. Flume
// opens no Plane connection: it runs px (FLUME_PX_BIN is the fixture seam), then records what px proved through the paths
// that already exist for a hand-made identity:
//
//   1. `px identity enroll ... --json` (preview, read-only)  -> plan; a binding to a DIFFERENT principal is a conflict
//   2. `px identity enroll ... --apply --json`               -> user id + key_ref (op://<vault>/<item uuid>/<field id>)
//   3. bind      (bindEmployeeProvider)       principal = user id, instance, credential_ref = key_ref, native
//                 or rotate (rotateEmployeeCredential) when the same principal got a new key_ref
//   4. adopt     (adoptNativeActor plane)     `px identity verify` on its own boards, or the verification board
//   5. desk      (plane-desk projectPlaneKey) PLANE_API_KEY = key_ref in the desk delta, re-render, cycle the profile
//
// Every step converges: a rerun on an enrolled, adopted employee whose desk runs its own key is a pure no-op (one px
// preview, nothing written). The token value never reaches Flume: px prints references only.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { adoptNativeActor, bindEmployeeProvider, rotateEmployeeCredential, type IdentityBlocker, type IdentityCensus, type IdentityDefinition } from "./company";
import { githubCredentialRefProblem } from "./github";
import { isBoardArgument, isPlaneUuid, parsePlaneInstance, planeEvidence, runPx, PLANE_CREDENTIAL_SEMANTICS } from "./plane";
import { planeDeskRow, projectPlaneKey } from "./plane-desk";
import { parseNamedAgentYaml } from "./validator";
import type { CompanyIdentity } from "./types";
import type { CapabilityResult } from "./provision";

/** The workspace every employee is enrolled in unless the provisioning config names another. */
export const DEFAULT_PLANE_INSTANCE = "https://plane.delo.sh/33god";
/** Verified for an employee with no board of its own (a portable specialist): the director's board, where everyone is a member. */
export const DEFAULT_PLANE_VERIFICATION_BOARD = "33GOD";

export interface PlaneProvisionSetting { instance: string; workspace: string; verificationBoard: string; vault?: string; source: "config" | "default" }

/**
 * Whether, and against which workspace, the plane capability runs. It runs when the provisioning config carries a
 * `plane:` block, or when the operator asked for it by name (`--only plane`); otherwise it is reported `deferred`, never
 * silently skipped and never run against a default the operator did not choose.
 */
export function planeProvisionSetting(config: { plane?: { instance?: string; verification_board?: string }; onepassword?: { vault?: string } } | null, explicit: boolean, configPath: string): PlaneProvisionSetting | { deferred: string } {
  const block = config?.plane;
  if (!block && !explicit) return { deferred: `no plane: block in ${configPath}; add \`plane: { instance: ${DEFAULT_PLANE_INSTANCE} }\` there, or run with --only plane` };
  const instance = block?.instance ?? DEFAULT_PLANE_INSTANCE;
  const parsed = parsePlaneInstance(instance);
  if (!parsed) return { deferred: `plane.instance ${instance} is not https://<host>/<workspace-slug>` };
  return { instance, workspace: parsed.workspace, verificationBoard: block?.verification_board ?? DEFAULT_PLANE_VERIFICATION_BOARD, ...(config?.onepassword?.vault ? { vault: config.onepassword.vault } : {}), source: block ? "config" : "default" };
}

/** The board(s) this employee works on: its registry rows' `plane.identifier`. A portable specialist has none. */
export function ownPlaneBoards(census: IdentityCensus, target: IdentityDefinition): string[] {
  let agents: Record<string, any> = {};
  try { agents = (YAML.parse(readFileSync(census.registryPath, "utf8")) as { agents?: Record<string, any> } | null)?.agents ?? {}; } catch { return []; }
  const boards: string[] = [];
  for (const post of target.posts) {
    const identifier = agents[post]?.plane?.identifier;
    if (typeof identifier === "string" && isBoardArgument(identifier) && !boards.includes(identifier)) boards.push(identifier);
  }
  return boards;
}

/** The person's name as Plane should show it: a specialist's display_name; a post's role.yaml display_name only when it names the person. */
export function planeDisplayName(target: IdentityDefinition, block: CompanyIdentity): string {
  const capitalized = block.handle.charAt(0).toUpperCase() + block.handle.slice(1);
  if (target.kind === "specialist") return typeof target.fields.display_name === "string" && target.fields.display_name.trim() ? target.fields.display_name.trim() : capitalized;
  let display: unknown;
  try { display = (parseNamedAgentYaml(target.text) as Record<string, unknown> | null)?.display_name; } catch { display = undefined; }
  const person = (target.person ?? block.handle).toLowerCase();
  return typeof display === "string" && display.toLowerCase().includes(person) ? display.trim() : capitalized;
}

interface EnrollAnswer {
  userId: string | null;
  userCreated: boolean;
  workspaceMember: { role?: unknown; created?: boolean; reactivated?: boolean };
  boards: Array<{ identifier: string; action: string; role?: unknown }>;
  credential: { key_ref: string | null; action: string | null };
  verifiedUser: string | null;
  plane: Record<string, unknown>;
}

/** Read px's answer and refuse anything that disagrees with what was asked. The answer carries references only. */
function readEnrollAnswer(data: Record<string, any>, block: CompanyIdentity, setting: PlaneProvisionSetting, applied: boolean): { answer: EnrollAnswer } | { problem: string } {
  if (data.ok !== true) return { problem: "px answered exit 0 without ok:true" };
  if (applied && data.applied !== true) return { problem: "px did not report the enrollment as applied" };
  if (!applied && data.applied === true) return { problem: "px reported a preview as applied" };
  const user = data.user && typeof data.user === "object" ? data.user : {};
  if (user.email !== undefined && String(user.email).toLowerCase() !== block.email) return { problem: `px enrolled ${String(user.email)}, not the employee's company address ${block.email}` };
  const userId = isPlaneUuid(user.id) ? user.id : null;
  if (applied && !userId) return { problem: "px did not report the enrolled native user UUID" };
  const workspace = data.plane?.workspace;
  if (typeof workspace === "string" && workspace !== setting.workspace) return { problem: `px enrolled into workspace ${workspace}, not ${setting.workspace}` };
  if (data.shared_key_fallback === true || (applied && data.shared_key_fallback !== false)) return { problem: "px did not state that no shared key was used (shared_key_fallback must be false)" };
  const credential = data.credential && typeof data.credential === "object" ? data.credential : {};
  const keyRef = typeof credential.key_ref === "string" ? credential.key_ref : null;
  if (applied) {
    if (!keyRef) return { problem: "px did not report the vaulted key reference" };
    const refProblem = githubCredentialRefProblem(keyRef);
    if (refProblem) return { problem: `px reported an unusable key reference: ${refProblem}` };
    if (credential.type !== undefined && credential.type !== PLANE_CREDENTIAL_SEMANTICS.type) return { problem: "px did not report a Plane personal access token" };
    if (data.verified?.users_me !== userId) return { problem: "px did not verify users/me with the new key as the enrolled user" };
  }
  const boards = Array.isArray(data.boards) ? data.boards.filter((b: any) => b && typeof b.identifier === "string").map((b: any) => ({ identifier: String(b.identifier), action: String(b.action ?? "unknown"), ...(b.role !== undefined ? { role: b.role } : {}) })) : [];
  return {
    answer: {
      userId, userCreated: user.created === true || !userId,
      workspaceMember: data.workspace_member && typeof data.workspace_member === "object" ? data.workspace_member : {},
      boards, credential: { key_ref: keyRef, action: typeof credential.action === "string" ? credential.action : null },
      verifiedUser: typeof data.verified?.users_me === "string" ? data.verified.users_me : null,
      plane: data.plane && typeof data.plane === "object" ? data.plane : {},
    },
  };
}

function enrollArgs(block: CompanyIdentity, displayName: string, ownBoards: string[], keyRef: string | undefined, setting: PlaneProvisionSetting, apply: boolean): string[] {
  const [first, ...rest] = displayName.split(/\s+/u).filter(Boolean);
  return [
    "identity", "enroll", "--email", block.email, "--display-name", displayName,
    ...(first ? ["--first-name", first] : []), ...(rest.length ? ["--last-name", rest.join(" ")] : []),
    ...ownBoards.flatMap(board => ["--admin-board", board]), "--all-boards",
    ...(keyRef ? ["--key-ref", keyRef] : []), ...(setting.vault ? ["--vault", setting.vault] : []),
    ...(apply ? ["--apply"] : []), "--json",
  ];
}

/** What px calls a membership or key it would leave exactly as it is. Anything else in a preview is a pending write. */
const SETTLED = new Set(["unchanged", "reused", "existing", "exists", "present", "kept", "noop", "no-op"]);

const blockerText = (blockers: IdentityBlocker[]): string => blockers.map(b => `${b.code}: ${b.detail}${b.provider_code ? ` [px ${b.provider_code}${b.board ? ` on ${b.board}` : ""}]` : ""}`).join("; ");
const boardSummary = (boards: EnrollAnswer["boards"]): string => boards.map(b => `${b.identifier}:${b.action}`).join(",") || "none";

export interface PlaneCapabilityStep {
  plan: { plane: CapabilityResult; desk: CapabilityResult };
  apply: () => Promise<{ plane: CapabilityResult; desk: CapabilityResult }>;
}

const fixed = (plane: CapabilityResult, desk: CapabilityResult): PlaneCapabilityStep => ({ plan: { plane, desk }, apply: async () => ({ plane, desk }) });

function deskCapability(result: Awaited<ReturnType<typeof projectPlaneKey>>): CapabilityResult {
  const refs: Record<string, string> = { ...(result.profile ? { profile: result.profile } : {}), standing: result.standing, ...(result.to ? { credential_ref: result.to } : {}), ...(result.gateway ? { gateway: result.gateway.action } : {}) };
  if (!result.ok) return { action: "blocked", detail: result.blockers.map(b => `${b.code}: ${b.detail}`).join("; ") || result.detail, refs };
  if (!result.changed) return { action: result.standing === "own-key" ? "no-op" : "deferred", detail: result.detail, refs };
  if (!result.apply) return { action: "create", detail: result.detail, refs };
  return { action: "created", changed: true, detail: `${result.detail}${result.gateway ? `; gateway ${result.gateway.action}: ${result.gateway.detail}` : ""}`, refs };
}

/**
 * Plan (read-only: one px preview) and, on apply, run the plane capability for one enrolled, ACTIVE employee. The caller
 * has already refused a non-active or unenrolled employee.
 */
export async function planPlaneCapability(employee: string, census: IdentityCensus, target: IdentityDefinition, setting: PlaneProvisionSetting, options: { noReload?: boolean; receipt: (line: Record<string, unknown>) => void }): Promise<PlaneCapabilityStep> {
  const block = target.block!;
  const evidence = planeEvidence();
  const existing = block.bindings?.plane;
  const ownBoards = ownPlaneBoards(census, target);
  const verification = ownBoards.length ? ownBoards : [setting.verificationBoard];
  const basis = ownBoards.length ? "own-board" : "default-board";
  const displayName = planeDisplayName(target, block);
  const deferredDesk: CapabilityResult = { action: "deferred", detail: "the desk is projected once the plane identity is adopted" };

  if (existing?.instance && existing.instance !== setting.instance) {
    return fixed({ action: "conflict", detail: `binding-conflict: plane is bound to ${existing.instance}, not ${setting.instance}; a different instance is a different identity (never silently rebound)` }, deferredDesk);
  }
  const preview = runPx(enrollArgs(block, displayName, ownBoards, existing?.credential_ref, setting, false));
  if (!preview.ok) {
    const detail = preview.kind === "unavailable" ? `provider-unavailable: ${preview.detail}` : `provider-refused [px ${preview.code}]: ${preview.detail}`;
    return fixed({ action: "blocked", detail, refs: { evidence, ...(preview.kind === "refused" ? { provider_code: preview.code } : {}) } }, deferredDesk);
  }
  const read = readEnrollAnswer(preview.data, block, setting, false);
  if ("problem" in read) return fixed({ action: "blocked", detail: `provider-result-mismatch: ${read.problem}`, refs: { evidence } }, deferredDesk);
  const plan = read.answer;
  if (existing && plan.userId !== existing.principal) {
    return fixed({ action: "conflict", detail: `binding-conflict: plane is bound to principal ${existing.principal}, but ${block.email} ${plan.userId ? `is native user ${plan.userId}` : "has no Plane user yet"}; rotation is deliberate (unbind by hand first), never a side effect of provisioning`, refs: { evidence, principal: existing.principal } }, deferredDesk);
  }
  const adopted = Boolean(existing && existing.native_actor_id === existing.principal);
  const pending = plan.userCreated || !existing || !adopted
    || plan.boards.some(b => !SETTLED.has(b.action))
    || Boolean(plan.workspaceMember.created || plan.workspaceMember.reactivated)
    || !SETTLED.has(plan.credential.action ?? "")
    || Boolean(plan.credential.key_ref && existing?.credential_ref && plan.credential.key_ref !== existing.credential_ref);
  const refs = { evidence, email: block.email, display_name: displayName, boards: boardSummary(plan.boards), admin_boards: ownBoards.join(",") || "none", verification_boards: verification.join(","), verification_basis: basis, ...(plan.userId ? { user_id: plan.userId } : {}) };

  // The desk, judged as it stands today; after an enrollment it is re-judged on apply.
  const row = planeDeskRow(census, target);
  const deskPlan: CapabilityResult = !pending && row.standing === "own-key" ? { action: "no-op", detail: row.detail, refs: { profile: row.profile ?? "-" } }
    : row.standing === "no-desk" || (!row.profile) ? { action: "deferred", detail: `no desk to project into (${row.detail})` }
      : !pending && row.standing === "projectable" ? { action: "create", detail: `${row.detail}; project it, re-render, cycle ${row.profile}`, refs: { profile: row.profile } }
        : !pending ? { action: "blocked", detail: row.detail, refs: { profile: row.profile } }
          : { action: "create", detail: `after adoption: set ${row.profile} PLANE_API_KEY to the employee's own key, re-render, cycle the profile`, refs: { profile: row.profile } };

  if (!pending) {
    const planePlan: CapabilityResult = { action: "no-op", detail: `native user ${existing!.principal} enrolled, bound and adopted; memberships and key unchanged`, refs };
    return {
      plan: { plane: planePlan, desk: deskPlan },
      apply: async () => ({ plane: planePlan, desk: deskPlan.action === "create" ? deskCapability(await projectPlaneKey(employee, { apply: true, noReload: options.noReload })) : deskPlan }),
    };
  }
  const steps = [plan.userCreated ? `create native user ${block.email} ("${displayName}")` : `adopt existing native user ${plan.userId}`,
    `memberships ${boardSummary(plan.boards)} (admin on ${ownBoards.join(", ") || "none"}; member everywhere else)`,
    `key ${plan.credential.action ?? "?"}`,
    existing ? (adopted ? "binding kept" : "adopt the existing binding") : "bind plane (native)",
    `verify on ${verification.join(", ")} (${basis})`];
  const planePlan: CapabilityResult = { action: plan.userCreated ? "create" : "adopt", detail: steps.join("; "), refs };

  const apply = async (): Promise<{ plane: CapabilityResult; desk: CapabilityResult }> => {
    const blocked = (detail: string, extra: Record<string, string> = {}, changed = false): { plane: CapabilityResult; desk: CapabilityResult } => ({ plane: { action: "blocked", detail, refs: { ...refs, ...extra }, ...(changed ? { changed } : {}) }, desk: deferredDesk });
    const ran = runPx(enrollArgs(block, displayName, ownBoards, existing?.credential_ref, setting, true));
    if (!ran.ok) {
      // A refusal after some ORM steps is safe to retry: px converges on the same user, memberships and labelled token.
      return ran.kind === "unavailable" ? blocked(`provider-unavailable: ${ran.detail}; rerun to converge`) : blocked(`provider-refused [px ${ran.code}]: ${ran.detail}; rerun to converge`, { provider_code: ran.code });
    }
    const got = readEnrollAnswer(ran.data, block, setting, true);
    if ("problem" in got) return blocked(`provider-result-mismatch: ${got.problem}; nothing bound`, {}, true);
    const answer = got.answer;
    const userId = answer.userId!, keyRef = answer.credential.key_ref!;
    if (existing && userId !== existing.principal) return blocked(`binding-conflict: px enrolled native user ${userId}, but plane is bound to ${existing.principal}; nothing rebound`, { user_id: userId }, true);
    const done = { ...refs, user_id: userId, credential_ref: keyRef, credential_action: answer.credential.action ?? "unknown", boards: boardSummary(answer.boards) };
    try {
      options.receipt({ capability: "plane", employee, handle: block.handle, subject: block.subject, action: answer.userCreated ? "created" : "enrolled", user_id: userId, instance: setting.instance, credential_ref: keyRef, credential_action: answer.credential.action, boards: answer.boards, evidence });
    } catch { /* the Plane write already happened; the binding below is the durable record */ }

    let bindNote: string;
    if (!existing) {
      const bound = await bindEmployeeProvider(employee, "plane", { principal: userId, instance: setting.instance, credential_ref: keyRef, attribution_mode: "native" }, { apply: true });
      if (!bound.ok) return blocked(`enrolled at Plane, but the binding was refused: ${blockerText(bound.blockers)}`, done, true);
      bindNote = "bound";
    } else if (existing.credential_ref !== keyRef) {
      const rotated = await rotateEmployeeCredential(employee, "plane", { credentialRef: keyRef, principal: existing.principal }, { apply: true });
      if (!rotated.ok) return blocked(`enrolled at Plane, but the key rotation was refused: ${blockerText(rotated.blockers)}`, done, true);
      bindNote = `key rotated from ${existing.credential_ref ?? "(none)"} (revoke the old token at Plane by hand)`;
    } else bindNote = "binding unchanged";

    const adoption = await adoptNativeActor(employee, "plane", { apply: true, boards: verification });
    if (!adoption.ok) return blocked(`enrolled and ${bindNote}, but adoption failed on ${verification.join(", ")}: ${blockerText(adoption.blockers as IdentityBlocker[])}; rerun to converge`, done, true);
    const plane: CapabilityResult = { action: answer.userCreated ? "created" : "adopted", changed: true, detail: `native user ${userId} (${block.email}); memberships ${boardSummary(answer.boards)}; key ${answer.credential.action ?? "?"}; ${bindNote}; verified by Pilot on ${verification.join(", ")} (${basis})`, refs: done };
    const desk = deskCapability(await projectPlaneKey(employee, { apply: true, noReload: options.noReload }));
    return { plane, desk };
  };
  return { plan: { plane: planePlan, desk: deskPlan }, apply };
}
