# Existing seams and delivery boundaries

Read-only discovery against Flume c360fae. Provider operations and end-to-end provisioning were not exercised. Audit recommendations are source-supported, not live completion evidence.

## Existing capability versus missing integration

| Surface | Existing authority | Missing work |
| --- | --- | --- |
| Hire and resume | `packages/flume-hr/src/index.ts:94-151`; `hire/HireRecipe.ts:149-160` | Compose identity/provider/media steps into one invocation for repository employees and portable specialists; preserve occupied-desk refusal and owned-definition resume. |
| Vault and mail | `workforce/provision.ts:105-132,183-218,301-317`; `docs/identity-provisioning.md` | Enrollment is a prerequisite and provision plans only vault-item, Access-token and mailbox. FLUME-57 owns policy admission; FLUME-80 owns fresh vault verification. A routing rule is not authenticated mail delivery. |
| AAI key | `scripts/gateway-member-tokens.py:34-56,97-112`; gateway `ops/gateway-tokens.py` | FLUME-39 owns hire integration. The Flume wrapper does not propagate the current group input and names a stale astra route. Validate current scopes through gateway authority rather than copying a route list. Separate consumer identity from a native AAI user. |
| Plane key | `workforce/plane.ts`; Pilot `src/commands/identity.js` | Existing workflow binds/verifies a previously created native user/PAT. Pilot should own version-aware invite/member operations and secure employee-session/PAT enrollment. Historical CE limitation is not evidence that every leg is impossible. No new Plane HTTP client in Flume. |
| Voice | `contracts/named-agent.schema.json`; template `scripts/hermes-specialist-profile.py:365-410`; Voxxy `app/main.py:752-809`, `cli/README.md:118-176` | Specialist voice slug projection exists. Validate selection against Voxxy, support supplied clone audio and retain verified identity; repository hire lacks unified voice selection. |
| Avatar | Holocene `apps/api/src/avatars.ts`; Flume `workforce/persona.ts:50-53` | Holocene owns canonical per-agent image and Telegram sync. Flume needs an owned source reference and publication/readback, not another image store. |
| Telegram | `workforce/channel.ts:446-522`; template `template/.scripts/30-telegram.sh`; `hire/WireTelegram.ts` | Later attachment already exists through `channel online --credential-ref`. Unified create-time input and persistent owned declaration are missing. BotFather creation remains external. |

Paths without a repository prefix above are relative to `packages/flume-hr/src/` when starting with `workforce/` or `hire/`; otherwise they are Flume-relative. Gateway source: `~/code/client-portal/gateway`. Pilot, Holocene and Voxxy remain their own owners.

## Reuse rather than duplicate

- FLUME-62: one-command hire/enroll/provision orchestration, clear recovery and truthful readiness. Existing ticket has additional original requirements; this plan does not delete them.
- FLUME-39: per-employee AAI token integration, current group/scope compatibility and reference projection.
- FLUME-59: shared definition/channel/avatar seams; reconcile its historical Bloodbank/Telegram claims against current code before implementation. Later attachment already exists.
- FLUME-57: targeted service-token admission in the configured Cloudflare Access policy; do not widen it to every valid token.
- FLUME-80: fresh vault write verification and safe retry. Existing stranded live credentials still require bounded owner-approved recovery.
- New isolated slices: Voxxy/Holocene media orchestration, Pilot-owned Plane enrollment and final one-command canary proof. Sequence shared definition/hire/provision edits with real blocks relations.

## Evidence contract

Use Adapter/Facade composition over existing provider entrypoints, not a shell chain with success inferred from exit zero. Store per-step secret-free outcomes and make reruns reconcile the same resources.

AAI proof names the actual consumer/key scope and runtime attribution. Plane proof matches `users/me`, company email, memberships and native actor; a renamed operator token fails. Mail proof includes real delivery and cross-employee denial. Voice proof includes actual output from the intended employee path. Avatar proof includes Holocene readback and visible `/agents` rendering, with mirroring state separate. Telegram proof includes validated bot identity and live connection, not only a token reference.

Inject stale vault reads, provider denial, invalid/duplicate bot, unknown voice and partial media failure in isolated tests. Keep fixtures separate from approved live canary evidence. Do not place canary credentials in prompts or test output.

## Delivery order

Repair vault verification and Access admission before depending on working mail. Integrate current AAI tokens; reconcile shared definitions/channels; add media adapters; compose the onboarding workflow after its file-scope prerequisites. Plane enrollment can proceed in Pilot independently but blocks the final full-identity proof. The final proof must not silently waive a missing personal Plane key.
