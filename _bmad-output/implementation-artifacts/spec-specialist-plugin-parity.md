---
title: 'Specialist plugin provisioning parity with PM (voice contract + tts/vox plugin link)'
type: 'bugfix'
created: '2026-10-20'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 40379dca564c3a8f778f836bb3fbb082291720da
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `20-runtime-repo.sh` installs the Vox TTS plugin symlink, the `plugins.enabled` add-patch, and the canonical `tts.provider/voice` delta only for `ROLE == pm`. Portable named specialists (rererere, infra-specialist, marge-simpson, n8n-specialist, ...) provisioned through `hermes-specialist-profile.py` get no `plugins/tts/vox` link and no voice contract, so their configured `tts.provider: vox` silently falls through to a built-in (Edge 403) — a stranger's voice with no error.

**Approach:** Give the specialist projection the same voice/plugin capability the PM path provisions: `hermes-specialist-profile.py` reconciles the canonical voice contract (via the shared `lib/voice-config.py` semantics: `plugins.enabled` add `tts/vox`, remove `tts/voxxy`, `tts.provider/voice` pins) and installs the `plugins/tts/<plugin>` symlink from the fleet config. Definition-level `voice:` overrides the fleet default; absent voice uses the fleet base default (vox/carlin).

## Boundaries & Constraints

**Always:** Reuse `templates/hermes-agent/template/.scripts/lib/voice-config.py` reconciliation semantics (same delta transform, same sealed-history rules) — no second voice writer with diverging behavior. Plugin name/dir/voice defaults resolve from the same fleet config keys (`fleet.vox_plugin_name`, `fleet.vox_plugin_dir`, `fleet.vox_voice`, `fleet.vox_url`) as the PM path. Voice is recorded in the projection receipt (`specialist-projection.json`) so ownership-conflict rules cover it. `--check` reports voice/plugin drift in `changed`. The specialist delta must keep the strict invariants (no external skill discovery, no raw credentials — `tts.*` values are non-secret slugs). Atomic, lock-guarded writes through the existing projection transaction (pending-journal) mechanism.

**Never:** No raw secrets anywhere. Do not touch `20-runtime-repo.sh`'s PM branch, shared instructions/settings, other profiles, or the running gateways. Do not backfill existing desks from this change (repair of rererere's desk is a separate operator-authorized step, not part of the projection patch). Do not enable TTS where the fleet base has no plugin dir installed — missing plugin dir defers the symlink with an explicit note, matching the PM path's "optional Vox plugin not installed" behavior; the config contract still lands.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hire specialist, plugin dir present | definition with no `voice:` | delta gets `plugins.enabled add tts/vox` + `remove tts/voxxy`, `tts.provider: vox`, `tts.voice/vox.voice: <fleet default>`; symlink `plugins/tts/vox -> <vox_plugin_dir>`; generated config matches renderer output | N/A |
| Definition overrides voice | `voice: walken` in definition | delta pins `tts.voice`/`tts.vox.voice: walken`; receipt records it | invalid voice slug (regex per voice-config.py) refuses before effects |
| Plugin dir absent | `fleet.vox_plugin_dir` not on disk | config contract still lands; no symlink; result notes deferral | never dies on optional plugin |
| Second onboard, unchanged | idempotent re-run | `changed: []`, no managed byte or receipt diff | N/A |
| Foreign `plugins.enabled` snapshot in delta | legacy unmarked list | same classification as voice-config.py (sealed-history match → migrate; partial → manual) | UnresolvedLegacySnapshot-style refusal, never silent freeze |
| Symlink spoof | existing `plugins/tts/vox` is a real dir or points elsewhere not owned | refuse ownership conflict | refuse, never overwrite foreign bytes |
| `--check` on drifted desk | voice keys differ from expected | `changed` lists `config.delta.yaml`/`config.yaml` | exit semantics unchanged |

</frozen-after-approval>

## Code Map

- `templates/hermes-agent/scripts/hermes-specialist-profile.py` — the projection adapter; add voice contract + plugin symlink to `project()`. It already imports `hermes-profile-config.py` as module `r`; `lib/` helpers (voice-config.py, profile-config-lock.py) live under `templates/hermes-agent/template/.scripts/lib/` — import voice-config by path the same way it imports profile-config-lock (importlib from a fixed trusted relative path, refuse symlink).
- `templates/hermes-agent/template/.scripts/lib/voice-config.py` — the canonical delta transform (`reconcile_delta(delta, plugin, voice)`), atomic writer, and lock; reuse `reconcile_delta` semantics directly, do not fork. Note its `check`/`reconcile` CLI expects base/delta/generated paths and renders via the canonical renderer — for the adapter, call `reconcile_delta` in-process, then fold the result into the existing `expected_config` merge the adapter already does (single writer, single receipt).
- `templates/hermes-agent/template/.scripts/20-runtime-repo.sh` (lines ~174-202) — PM branch: reference behavior for plugin name/dir resolution (`config_get fleet.vox_plugin_*`), symlink install, and deferral when the plugin dir is absent. Specialist adapter must read the same keys from the fleet base config (`r.BASE` mapping: `fleet.vox_plugin_name` etc. are in `config.example.toml` → rendered fleet config; resolve with the same defaults as the shell script).
- `templates/hermes-agent/tests/test_specialist_profile.py` — add cases: voice contract lands, definition voice override, absent plugin dir defers, idempotent re-run, foreign `plugins.enabled` snapshot classification, symlink spoof refusal.
- `packages/flume-hr/src/workforce/specialist.ts` — passes the definition JSON to the adapter; extend request schema only if `voice:` is definition-level (preferred: adapter reads `request.get("voice")` — no TS change needed beyond passthrough, verify the definition validator tolerates/declares the key).
- `packages/flume-hr/src/workforce/validator.ts` (definition schema) — declare optional `voice` (slug regex) so a definition can pin its voice; unknown keys may be refused, so check.
- `~/.hermes/config.yaml` fleet base — already carries `plugins.enabled: [..., tts/vox, vox, ...]` and `tts.provider: vox` (verify: the base list already includes `tts/vox`; the specialist delta add-patch may then be redundant but harmless — keep it for parity with the PM contract since 52d9445 proved fleet lists regress).

## Tasks & Acceptance

**Execution:**
- [ ] `templates/hermes-agent/scripts/hermes-specialist-profile.py` — import `reconcile_delta` from `lib/voice-config.py` (trusted, non-symlink path); resolve plugin name/dir + voice (definition `voice:` > fleet `vox_voice` default `carlin`); apply `reconcile_delta` to the delta inside `project()` before `expected_config`; install/verify `plugins/tts/<plugin>` symlink (defer with note when dir absent; refuse foreign occupation); record voice in receipt + SOUL.md unchanged; `--check` parity.
- [ ] `packages/flume-hr/src/workforce/validator.ts` — allow optional `voice:` slug in the definition schema (if the validator is strict).
- [ ] `templates/hermes-agent/tests/test_specialist_profile.py` — the six I/O matrix scenarios.
- [ ] Run repo test suites: template pytest + flume-hr regression tests (`scripts/run-tests.mjs`).

**Acceptance Criteria:**
- Given a fresh portable-specialist hire with the vox plugin dir present, when `flume hire --definition` runs, then the desk's generated `config.yaml` has `tts.provider: vox`, the fleet-matching voice, `plugins.enabled` containing `tts/vox`, and `plugins/tts/vox` symlinked to the plugin dir.
- Given an unchanged definition, when `flume onboard --employee <id>` re-runs, then the projection reports no changes.
- Given a definition with `voice: walken`, when projected, then `tts.voice` and `tts.vox.voice` are `walken` and the receipt records the pin.
- Given no plugin dir on disk, when projected, then the config contract still lands and the result reports the deferred symlink instead of failing.

## Implementation Notes

## Spec Change Log

## Review Triage Log

Recovery review confirmed and fixed: plugin publication preceded the pending journal; wrong-target symlinks were replaced; plugin ancestors were unchecked; absent definition voice overwrote profile overrides; malformed template config silently selected defaults. Link targets now join the existing locked, recover-forward publication journal, foreign occupation refuses, and profile voice overrides survive. Missing template TOML alone is optional. Endpoint uses the plugin's documented `tts.<plugin>.base_url` key.

Voice precedence: explicit definition (updates prior owned pins, refuses a contradictory handwritten override) > existing profile override > `VOX_VOICE` > template TOML `fleet.vox_voice` > fleet base TTS voice > `carlin`. Plugin name/dir use environment > template TOML > existing PM defaults. Existing endpoint overrides survive; otherwise environment > TOML > base > service default. Unsafe template config refuses instead of silently falling back.

## Verification

Recovery evidence root: `/home/delorenj/.hermes/profiles/rererere/cache/scratch/`.

- `PYTHONDONTWRITEBYTECODE=1 timeout 120s mise x -- uv run --no-cache --with pytest --with pyyaml python -m pytest tests/test_specialist_profile.py tests/test_expected_config_contract.py tests/test_profile_config_locking.py -q` (vendored template): **97 passed in 22.60s**, exit 0. `flume-parity-focused-final.log`. Includes 75 specialist cases: both leaf/ancestor link refusals, journal/link/file interruption and recovery, legacy receipt voice preservation, explicit voice updates, ambiguous plugin snapshots, malformed TOML, and endpoint credentials refusal.
- `timeout 90s npm run typecheck` and `timeout 90s npm run build`: exit 0. `flume-parity-typecheck.log`, `flume-parity-build.log`.
- `timeout 60s node tests/named-agent-contract-regressions.ts`: all assertions passed, exit 0; optional voice survives schema + resolved-definition passthrough, invalid slugs refuse. `flume-parity-contract.log`.
- Bounded actual built Flume/Skillex public hire/dry-run/onboard/audit proof: `timeout 120s mise x -- uv run --no-cache --with pyyaml node .../flume-parity-cli-proof.mjs`, exit 0. Voice `walken`, provider `vox`, real plugin link, first hire changed, second onboard unchanged, scoped audit OK. `flume-parity-cli.log`.
- **Actual installed Hermes discovery + TTS tool**, not a fixture/direct-HTTP substitute: disposable scratch profile provisioned through the patched adapter; installed `hermes --print-runtime-command` bootstrap retained, entrypoint changed only to the probe script. Hermes registered `VoxTTSProvider` from the provisioned `plugins/tts/vox` link and `text_to_speech_tool` POSTed `https://vox.delo.sh/synthesize`, HTTP 200, returned `provider: vox`, `success: true`. `ffprobe`: Opus, mono 48 kHz, 2.246500 s, 13,631 bytes. `flume-parity-proof.log`, `flume-parity-proof/evidence.json`, `flume-parity-proof/proof.ogg`.
- Root and vendored `git diff --check`: exit 0.

## Remaining Integration Limits

No live desk/gateway changes, no commits/pushes, no canonical-template overwrite. Canonical checkout remains clean at `81cd6fa`; vendored `1c20c5f` includes `bdc15bf` and `1c20c5f` beyond it (verified ancestor). Parent must choose the intended canonical integration before publishing and updating the gitlink. The spec remains in-progress for that reason. Monolithic full test runners were deliberately not rerun; the prior worker's unrelated failures were not fully baselined and are not claimed green. Public CLI proof required uv's PyYAML environment because default PATH `python3` lacks yaml; this is an existing host dependency, not a package installation performed here. Initial audio validation expected WAV but Hermes inherited Telegram delivery and correctly returned Opus; the probe was corrected to validate the real output with ffprobe. The proof establishes Hermes-to-Vox routing/audio, not a listening assessment or server engine identity. Ownership regression gates cover static foreign topology and cooperating locked writers, not hostile concurrent filesystem replacement.

