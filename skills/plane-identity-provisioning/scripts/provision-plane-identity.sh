#!/usr/bin/env bash
# Provision a full Plane identity for a Hermes agent: email -> account -> membership -> token.
# Idempotent: every step checks for its own prior result and resumes rather than duplicating.
#
#   provision-plane-identity.sh <agent-id> [--dry-run]
#
# Secrets NEVER touch disk or the audit log. Password and token go straight into 1Password;
# the agent registry receives only the op:// reference.
set -euo pipefail

AGENT="${1:?usage: provision-plane-identity.sh <agent-id> [--dry-run]}"
DRY=0; [[ "${2:-}" == "--dry-run" ]] && DRY=1

PLANE_BASE="${PLANE_BASE:-https://plane.delo.sh}"
WORKSPACE="${PLANE_WORKSPACE:-33god}"
EMAIL="${AGENT}@delo.sh"
FORWARD_TO="${AGENT_EMAIL_FORWARD_TO:-jaradd@gmail.com}"
CF_API="${CF_API:-https://api.cloudflare.com/client/v4}"
CF_ZONE="${CF_ZONE_DELO_SH:-eabc163cde3e31680f10fc313aecdda3}"
OP_ITEM="Plane Agent ${AGENT}"
TASK="plane-iam-${AGENT}"

log()  { printf '  %s\n' "$*" >&2; }
step() { printf '\n[%s] %s\n' "$1" "$2" >&2; }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 1; }
run()  { if (( DRY )); then log "DRY-RUN: would $*"; else "$@"; fi; }

command -v ego-browser >/dev/null || die "ego-browser not on PATH (the Mac bridge)"
command -v op          >/dev/null || die "1Password CLI not on PATH"

# A rate-limited vault makes every later step fail as if the credential were wrong.
op read "op://DeLoSecrets/Plane/Main/apiKey" >/dev/null 2>&1 \
  || die "1Password is unreachable or rate-limited — stop and wait it out (see SKILL.md)"
ego-browser doctor >/dev/null 2>&1 || die "ego-browser bridge is down — run 'ego-browser doctor'"

PLANE_KEY="$(op read 'op://DeLoSecrets/Plane/Main/apiKey')"

# ── 1. email ────────────────────────────────────────────────────────────────────
step 1 "Cloudflare email routing: ${EMAIL} -> ${FORWARD_TO}"
CF_TOKEN="$(op read 'op://DeLoSecrets/Cloudflare-EmailRouting/token' 2>/dev/null || true)"
[[ -n "$CF_TOKEN" ]] || die "no Cloudflare Email Routing token at op://DeLoSecrets/Cloudflare-EmailRouting/token"
EXISTING_RULE="$(curl -sS "${CF_API}/zones/${CF_ZONE}/email/routing/rules?per_page=200" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  | python3 -c "
import sys,json
addr=sys.argv[1]; d=json.load(sys.stdin)
for r in d.get('result') or []:
    for m in r.get('matchers') or []:
        if m.get('field')=='to' and m.get('value')==addr:
            print(r.get('tag') or r.get('id')); break
" "$EMAIL")"
if [[ -n "$EXISTING_RULE" ]]; then
  log "rule exists (${EXISTING_RULE}) — reusing"
else
  BODY="$(python3 -c "
import json,sys
print(json.dumps({'name':f'hermes:{sys.argv[1]}','enabled':True,'priority':100,
 'matchers':[{'field':'to','type':'literal','value':sys.argv[2]}],
 'actions':[{'type':'forward','value':[sys.argv[3]]}]}))" "$AGENT" "$EMAIL" "$FORWARD_TO")"
  if (( DRY )); then log "DRY-RUN: would POST email routing rule"; else
    RESP="$(curl -sS -X POST "${CF_API}/zones/${CF_ZONE}/email/routing/rules" \
      -H "Authorization: Bearer ${CF_TOKEN}" -H 'Content-Type: application/json' -d "$BODY")"
    echo "$RESP" | grep -q '"success":true' || die "email rule create failed: $RESP"
    log "rule created"
  fi
fi

# ── 2. password ─────────────────────────────────────────────────────────────────
step 2 "password into 1Password (never to disk)"
if op item get "$OP_ITEM" --fields password >/dev/null 2>&1; then
  log "password already stored — reusing"
else
  if (( DRY )); then log "DRY-RUN: would generate + store password"; else
    PW="$(openssl rand -base64 24 | tr -d '\n/+=' | head -c 28)Aa1!"
    op item create --category=login --title="$OP_ITEM" --vault=DeLoSecrets \
      "username=${EMAIL}" "password=${PW}" "url=${PLANE_BASE}" >/dev/null \
      || op item edit "$OP_ITEM" --vault=DeLoSecrets "password=${PW}" >/dev/null
    unset PW
    log "password generated and stored"
  fi
fi

# ── 3. account (ego-browser) ────────────────────────────────────────────────────
step 3 "create the Plane account as ${EMAIL} (ego-browser)"
if (( DRY )); then log "DRY-RUN: would sign up via ego-browser"; else
  EMAIL="$EMAIL" OP_ITEM="$OP_ITEM" TASK="$TASK" PLANE_BASE="$PLANE_BASE" \
  "$(dirname "$0")/ego-signup.sh" || die "signup step failed"
fi

# ── 4. workspace membership ─────────────────────────────────────────────────────
step 4 "add ${EMAIL} to workspace '${WORKSPACE}'"
IS_MEMBER="$(curl -sS -H "X-API-Key: ${PLANE_KEY}" \
  "${PLANE_BASE}/api/v1/workspaces/${WORKSPACE}/members/" \
  | python3 -c "
import sys,json
addr=sys.argv[1]; d=json.load(sys.stdin)
rows = d if isinstance(d,list) else d.get('results',[])
for m in rows:
    mm = m.get('member') or m
    if (mm.get('email') or '').lower()==addr.lower():
        print(mm.get('id') or ''); break
" "$EMAIL")"
if [[ -n "$IS_MEMBER" ]]; then
  log "already a member (${IS_MEMBER})"
else
  run curl -sS -X POST "${PLANE_BASE}/api/v1/workspaces/${WORKSPACE}/invitations/" \
    -H "X-API-Key: ${PLANE_KEY}" -H 'Content-Type: application/json' \
    -d "{\"emails\":[{\"email\":\"${EMAIL}\",\"role\":15}]}" >/dev/null
  log "invitation sent"
fi

# ── 5+6. mint the token (ego-browser) and store it ──────────────────────────────
step 5 "mint the agent's own API token (ego-browser) and store it"
if (( DRY )); then log "DRY-RUN: would mint + store token"; else
  EMAIL="$EMAIL" OP_ITEM="$OP_ITEM" TASK="$TASK" PLANE_BASE="$PLANE_BASE" AGENT="$AGENT" \
  "$(dirname "$0")/ego-mint-token.sh" || die "token mint failed"
fi

# ── 7. registry ─────────────────────────────────────────────────────────────────
step 7 "record the identity in the agent registry"
run flume iam record "$AGENT" \
  --email "$EMAIL" \
  --key-ref "op://DeLoSecrets/${OP_ITEM}/apiKey" \
  --member-id "${IS_MEMBER:-pending}"

printf '\n✔ %s provisioned: %s\n' "$AGENT" "$EMAIL" >&2
printf '  verify: curl -s -H "X-API-Key: $(op read %s)" %s/api/v1/users/me/ | jq -r .email\n' \
  "\"op://DeLoSecrets/${OP_ITEM}/apiKey\"" "$PLANE_BASE" >&2
