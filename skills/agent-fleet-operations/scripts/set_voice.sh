#!/usr/bin/env bash
# Set the active Hermes profile's Voxxy TTS voice.
# Usage: set_voice.sh <voice-slug>
set -euo pipefail

VOICE="${1:-carlin}"
BASE_URL="${VOX_BASE_URL:-https://vox.delo.sh}"
# vox.delo.sh requires its key (2026-11-23): $VOX_API_KEY, else the op:// ref in $VOX_API_KEY_REF.
VOX_KEY="${VOX_API_KEY:-}"
if [[ -z "$VOX_KEY" && -n "${VOX_API_KEY_REF:-}" ]]; then
    VOX_KEY="$(op read --no-newline "$VOX_API_KEY_REF" 2>/dev/null || true)"
fi

# Verify the voice exists on the Voxxy service.
if ! curl -sf -H "X-API-Key: ${VOX_KEY}" "${BASE_URL}/voices/${VOICE}" >/dev/null 2>&1; then
    echo "Voice '${VOICE}' not found at ${BASE_URL}. Available voices:" >&2
    curl -sf -H "X-API-Key: ${VOX_KEY}" "${BASE_URL}/voices" 2>/dev/null | \
        python3 -c 'import json,sys; data=json.load(sys.stdin); print("\n".join(v["name"] for v in data))' >&2 || true
    exit 1
fi

# Resolve the active Hermes TTS provider.
PROVIDER=$(hermes config get tts.provider 2>/dev/null || echo "vox")

case "${PROVIDER}" in
    voxxy|vox)
        hermes config set --force tts.vox.voice "${VOICE}"
        hermes config set --force tts.voice "${VOICE}"
        ;;
    *)
        echo "Unsupported TTS provider: ${PROVIDER}. This script only configures Voxxy." >&2
        exit 1
        ;;
esac

echo "Hermes TTS voice set to '${VOICE}' for provider '${PROVIDER}'."
echo "Run /reset for the change to take effect in a session; for the host gateway batch it into one: hermes-gateway-restart --reason \"tts voice change\" (never a raw systemctl restart)."
