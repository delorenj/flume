#!/usr/bin/env bash
# Sign in AS THE AGENT and mint its own Plane API token, straight into 1Password.
# Reads: EMAIL, OP_ITEM, TASK, PLANE_BASE, AGENT.  The token is never printed.
set -euo pipefail
: "${EMAIL:?}" "${OP_ITEM:?}" "${TASK:?}" "${PLANE_BASE:?}" "${AGENT:?}"

if op item get "$OP_ITEM" --fields apiKey >/dev/null 2>&1; then
  echo "  token already stored — reusing (delete the field to rotate)" >&2; exit 0
fi

PW="$(op read "op://DeLoSecrets/${OP_ITEM}/password")"

# Mask the password in the audit log (see ego-signup.sh). The TOKEN is never in the
# script — it comes back on stdout into a shell variable and goes straight to 1Password.
export EGO_BROWSER_REDACT="$PW"
OUT="$(ego-browser nodejs <<EOF 2>&1
const EMAIL = $(python3 -c 'import json,os;print(json.dumps(os.environ["EMAIL"]))');
const PW    = $(python3 -c 'import json,os;print(json.dumps(os.environ["PW"]))');
const LABEL = 'hermes:${AGENT}';
const task = await useOrCreateTaskSpace('${TASK}');

const setVal = (sel, v) => js(\`(()=>{const i=document.querySelector(\${JSON.stringify(sel)});
  if(!i) return 'no-input'; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(i, \${JSON.stringify(v)}); i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()\`);
const click = (re) => js(\`(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>\${re}.test(x.innerText)); if(b){b.click();return 'ok'} return 'no';})()\`);

await gotoAndWait('${PLANE_BASE}/');
await new Promise(r => setTimeout(r, 4000));
await setVal('input[name=email]', EMAIL);
await new Promise(r => setTimeout(r, 600));
await click('/continue/i');
await new Promise(r => setTimeout(r, 4500));
await setVal('input[name=password]', PW);
await new Promise(r => setTimeout(r, 500));
await click('/continue|sign in|log in/i');
await new Promise(r => setTimeout(r, 9000));

await gotoAndWait('${PLANE_BASE}/settings/profile/api-tokens/');
await new Promise(r => setTimeout(r, 6000));
const here = await js('location.href');
if (!/api-tokens/.test(here)) { cliLog('RESULT:not-signed-in url=' + here); } else {
  await click('/add api token|create token|add token|new token/i');
  await new Promise(r => setTimeout(r, 3000));
  await setVal('input[name=label],input[placeholder*="itle" i],input[type=text]', LABEL);
  await new Promise(r => setTimeout(r, 500));
  await click('/generate|create|add token/i');
  await new Promise(r => setTimeout(r, 6000));
  // Plane reveals the token exactly once, in the success modal.
  const tok = await js(\`(()=>{const m=document.body.innerText.match(/\\\\bplane_api_[A-Za-z0-9_-]{16,}\\\\b/)
    || document.body.innerText.match(/\\\\b[a-f0-9]{40}\\\\b/); return m?m[0]:'';})()\`);
  cliLog(tok ? 'RESULT:token ' + tok : 'RESULT:no-token text=' + (await js('document.body.innerText.slice(0,300)')).replace(/\s+/g,' '));
}
EOF
)"
unset PW EGO_BROWSER_REDACT

TOKEN="$(printf '%s' "$OUT" | sed -n 's/.*RESULT:token \([A-Za-z0-9_-]*\).*/\1/p' | head -1)"
if [[ -z "$TOKEN" ]]; then
  echo "  token mint failed:" >&2; printf '%s\n' "$OUT" | grep RESULT: | cut -c1-200 >&2; exit 1
fi
op item edit "$OP_ITEM" --vault=DeLoSecrets "apiKey[password]=${TOKEN}" >/dev/null
unset TOKEN
echo "  token minted and stored at op://DeLoSecrets/${OP_ITEM}/apiKey" >&2
