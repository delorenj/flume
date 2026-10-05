# Existing code and delivery boundaries

The named-agent contract already supports a charter, pack(s) or set, explicit memory banks, and optional desk path. Current workforce/validator.ts delegates identity semantics to workforce/identity.ts: the write bank equals agent-<id>, reserved fallback banks are rejected, and recall banks are validated and capped. The weak prefix-only validator described by the September 30 FLUME-25 reconciliation has been replaced. Do not reopen that gap.

The current hire CLI takes a title and repository target and renders agents/hermes/<role>. It does not call the standalone workforce desk provisioner. The template's profile step requires a project skill selection, so a repo-independent specialist still needs a desk-aware projection seam. Existing workforce/desk.ts and role/selection functions should supply that seam; the command must validate and resolve the definition before creating employee projections.

The proposed owning root is ~/.agents/workforce/<id>. Its authored definition and managed launch/selection artifacts are distinct from ~/.hermes/profiles/<id>, the generated runtime desk. The owning root can expose canonical Skillex links through a managed selection. The Hermes profile stays strict: no .agents discovery root, skills.external_dirs remains empty, and only the declared loadout is projected. Changing a working directory must not change identity, write bank, or loadout.

Hermes CLI is the proposed first harness. A launcher should select the named profile, charter and memory identity while retaining the requested working directory. The definition must drive both onboarding and launch; another authored prompt or skill manifest would create drift. Later Claude/Codex adapters can consume the same definition, but are outside this delivery.

FLUME-21 remains the hire-by-name umbrella; FLUME-29 supplies projection and inaugural-hire receipts. Story 2.1 is shipped schema/validation work. Parent stories 2.2-2.4 remain represented by CAP-1 through CAP-6. Parent I-1.4 owns specialist Bloodbank invocation. FLUME-39 owns the member token needed for live AutomaticAI inference. No umbrella or child closes merely because this spec exists.

Verification must cover absent repo binding, occupied identity refusal, invalid catalog selection, deterministic refresh, preserved unrelated registry/org/profile state, arbitrary-CWD launch, exact skill discovery, and attributable own-bank writes. Fixture evidence cannot establish installed/runtime acceptance; provide distinct source, profile, and live invocation receipts. Never restart gateways just to recreate already-accepted proof.

The proposed desk separation and infra identity remain pending owner confirmation. A response supersedes the corresponding append-only memlog assumption and re-derives this spec before those capabilities are implemented.
