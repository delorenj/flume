#!/usr/bin/env python3
"""Bounded, read-only authenticated catalog check. Never emits credentials."""
import json, os, subprocess, sys, urllib.request
request=json.load(sys.stdin)
key=os.environ.get('AUTOMATICAI_GATEWAY_KEY')
if request.get('reference'):
    result=subprocess.run(['op','read',request['reference']],capture_output=True,text=True,timeout=20)
    if result.returncode: raise SystemExit('member credential resolution failed')
    key=result.stdout.strip()
if not key: raise SystemExit('member AUTOMATICAI_GATEWAY_KEY/reference unavailable')
try:
    req=urllib.request.Request('https://api.automaticai.io/v1/models',headers={'Authorization':'Bearer '+key})
    with urllib.request.urlopen(req,timeout=15) as response: models={x['id'] for x in json.load(response)['data']}
    missing=[route for route in request['chain'] if route not in models]
    if missing: raise SystemExit('routes absent from authenticated /v1/models: '+', '.join(missing))
    print(json.dumps({'verified':True,'routes':request['chain']}))
except Exception as error:
    raise SystemExit('authenticated catalog unavailable: '+type(error).__name__)
