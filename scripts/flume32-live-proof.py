#!/usr/bin/env python3
"""Bounded FLUME-32 seam probe; no deployed configuration/service mutations."""
import json, os, pathlib, secrets, sys, time, importlib.util, urllib.request
root=pathlib.Path(__file__).resolve().parents[1]
ops=pathlib.Path('/home/delorenj/docker/stacks/ai/newapi/ops')
sys.path.insert(0,str(ops))
from aai import read_secret, Gateway, http_json
spec=importlib.util.spec_from_file_location('proof',ops/'gateway-proof.py')
proof=importlib.util.module_from_spec(spec);spec.loader.exec_module(proof)
import yaml
source=yaml.safe_load(pathlib.Path('/home/delorenj/.hermes/profiles/flume-pm/config.yaml').read_text())
key=read_secret(source['secrets']['onepassword']['env']['AUTOMATICAI_GATEWAY_KEY'])
base=yaml.safe_load(pathlib.Path('/home/delorenj/.hermes/config.yaml').read_text())
fallbacks=base['fallback_providers']
marker='AAI_ROUTE_PROOF_'+secrets.token_hex(16)
start=int(time.time())
report={'verdict':'UNPROVEN','ingress':'isolated Hermes AIAgent fallback seam (not multiplexed Bloodbank)','consumer':'hermes-flume-pm','marker':marker,'effective_chain':[base['model']['default'],*[x['model'] for x in fallbacks]],'failure_injection':'primary client HTTP 503 simulated at isolated desk transport; no server mutation'}
try:
    discovered=http_json('https://api.automaticai.io/v1/models',headers={'Authorization':'Bearer '+key})
    ids={x['id'] for x in discovered['data']}
    assert all(x['model'] in ids for x in fallbacks)
    report['authenticated_models_verified']=True
    fixture=pathlib.Path(os.environ['HERMES_HOME'])/'config.yaml'
    fixture.write_text(yaml.safe_dump({'providers':base.get('providers',{}),'model':base['model'],'fallback_providers':fallbacks,'secrets':{'onepassword':{'enabled':False}}}))
    os.environ['AUTOMATICAI_GATEWAY_KEY']=key
    import logging
    logging.basicConfig(level=logging.WARNING)
    from run_agent import AIAgent
    from agent.chat_completion_helpers import build_api_kwargs
    import openai
    agent=AIAgent(model=base['model']['default'],provider='automaticai',base_url='https://api.automaticai.io/v1',api_key=key,
        fallback_model=fallbacks,max_iterations=1,enabled_toolsets=[],quiet_mode=True,skip_context_files=True,skip_memory=True,skip_background_review=True,save_trajectories=False)
    req=urllib.request.Request('https://api.automaticai.io/v1/chat/completions')
    try:
        raise openai.InternalServerError('FLUME-32 injected primary unavailable',response=__import__('httpx').Response(503,request=__import__('httpx').Request('POST',req.full_url)),body=None)
    except openai.InternalServerError:
        assert agent._try_activate_fallback(), 'No fallback activated'
    report['activated_model']=agent.model
    assert agent.model==fallbacks[0]['model']
    kwargs=build_api_kwargs(agent,[{'role':'user','content':marker+' Reply only OK.'}],[])
    kwargs['stream']=False
    # Keep proof bounded; outgoing effort is intentionally whatever Hermes built.
    kwargs.pop('stream_options',None)
    report['outgoing_effort']={k:kwargs.get(k) for k in ('reasoning_effort','extra_body')}
    reply=agent.client.chat.completions.create(**kwargs)
    report['response_completed']=bool(reply.choices)
    rows,_=proof.fetch_rows(Gateway(),since=start,route=agent.model,max_pages=2)
    receipts=proof.match_receipts(rows,marker=marker,since=start,route=agent.model)
    receipts=[x for x in receipts if str(x['token_name']).startswith('aai:hermes-flume-pm:') or x['token_name']=='hermes-flume-pm']
    for receipt in receipts:
        row=next(x for x in rows if x['id']==receipt['log_id']);other=json.loads(row.get('other') or '{}')
        receipt['effort_defaulted']=other.get('automaticai_effort_defaulted')
        receipt['outgoing_reasoning_effort']=other.get('reasoning_effort')
    report['receipts']=receipts
    report['verdict']='PASS_SEAM_ONLY' if receipts else 'UNPROVEN'
except Exception as error:
    report['blocker']=type(error).__name__+': '+str(error)[:300]
# Only safe fields emitted; never keys/config/reference payloads.
(root/'_bmad-output/implementation-artifacts/FLUME-32/live-fallback.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
