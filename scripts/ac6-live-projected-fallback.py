#!/usr/bin/env python3
"""Bounded FLUME-32 AC6 role -> generated desk -> installed Hermes -> gateway proof.

Run with the installed Hermes Python (PyYAML/httpx/openai available). No service,
profile, catalog, token, or board administration. --live is mandatory for requests.
Only an allowlisted receipt is exported; credentials and raw runtime logs stay out
of files, argv and output. All ephemeral state lives beneath --scratch-root.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from typing import Any

import yaml

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT_HOME = Path('/home/delorenj')
SCRATCH = ACCOUNT_HOME / '.hermes/profiles/flume-pm/cache/scratch'
GATEWAY = 'https://api.automaticai.io'
INGRESS = 'isolated installed Hermes AIAgent.run_conversation; exact Flume role-projected desk config; not multiplexed Bloodbank'


class Blocker(RuntimeError):
    """Only explicitly authored, secret-free diagnostics belong in this exception."""


def require(condition, message):
    if not condition:
        raise Blocker(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, 'module unavailable: ' + path.name)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def run_checked(argv, *, env=None, timeout=45, stage):
    try:
        done = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=timeout, cwd=ROOT)
    except subprocess.TimeoutExpired:
        raise Blocker(stage + ': deadline exceeded') from None
    require(done.returncode == 0, stage + f': exit {done.returncode} (raw output suppressed)')
    return done.stdout


def member_reference(profile, helper, member_config):
    require(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,60}', profile), 'unsafe member profile')
    consumer = helper.consumer_name(profile)
    expected = helper.TOKENS_ITEM + '/' + consumer
    actual = yaml.safe_load(member_config.read_text())['secrets']['onepassword']['env'].get(helper.ENV_NAME)
    require(actual == expected, 'member credential mapping differs from gateway-member-tokens.py; refusing other consumer')
    return consumer, actual


def safe_environment(work, desk=None):
    # Never inherit parent provider keys, hooks, routing, profile or auth overrides.
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR') if k in os.environ}
    env.update(HOME=str(work / 'home'), TMPDIR=str(work), PYTHONDONTWRITEBYTECODE='1',
               HERMES_FLEET_HOME=str(work / 'fleet'),
               HERMES_AGENTS_REGISTRY=str(work / 'fleet/agents-registry.yaml'),
               HERMES_ORG_PATH=str(work / 'fleet/org.yaml'),
               HERMES_HOME=str(desk or work / 'fleet'), HERMES_DISABLE_PLUGINS='1',
               HERMES_DISABLE_TELEMETRY='1', HERMES_DISABLE_LAZY_INSTALLS='1',
               XDG_CONFIG_HOME=str(work / 'xdg/config'), XDG_CACHE_HOME=str(work / 'xdg/cache'),
               XDG_DATA_HOME=str(work / 'xdg/data'), XDG_STATE_HOME=str(work / 'xdg/state'))
    # op is used read-only by Flume's authenticated catalog checker. No secret in argv/files.
    if 'OP_SERVICE_ACCOUNT_TOKEN' in os.environ:
        env['OP_SERVICE_ACCOUNT_TOKEN'] = os.environ['OP_SERVICE_ACCOUNT_TOKEN']
    env.update(OP_BIOMETRIC_UNLOCK_ENABLED='false', OP_LOAD_DESKTOP_APP_SETTINGS='false', OP_SESSION_DELEGATION_ENABLED='false')
    return env


def models(key):
    req = urllib.request.Request(GATEWAY + '/v1/models', headers={
        'Authorization':'Bearer ' + key, 'User-Agent':'flume-ac6-proof/1'})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return {entry['id'] for entry in json.load(response)['data']}
    except urllib.error.HTTPError as error:
        raise Blocker(f'authenticated /v1/models HTTP {error.code}') from None
    except Exception as error:
        raise Blocker('authenticated /v1/models ' + type(error).__name__) from None


def validate_chain(chain, catalog, authenticated):
    require(2 <= len(chain) <= 3 and len(set(chain)) == len(chain), 'declare 2-3 distinct routes')
    for route in chain:
        require(re.fullmatch(r'automaticai/[^/]+/[^/]+', route), 'chain needs explicit canonical account/model routes')
        require(route in catalog and route in authenticated, 'route absent from catalog or authenticated /v1/models: ' + route)
        require(catalog[route].get('billing') == 'subscription', 'proof refuses metered or unspecified-billing route: ' + route)


def verdict_check(receipt, chain, consumer, catalog):
    runtime = receipt['runtime']
    require(runtime.get('config_sha256') == receipt['projection']['config_sha256'], 'runtime did not consume exact generated config')
    require(runtime.get('effective_chain') == chain, 'runtime chain differs from role declaration')
    require(runtime.get('primary_http503_count', 0) >= 1, 'primary failure not exercised')
    require(runtime.get('activated_model') == chain[1] and runtime.get('fallback_index') == 1, 'first fallback was not activated')
    require(runtime.get('completed') is True and runtime.get('final_response_nonempty') is True, 'Hermes did not complete')
    require(runtime.get('real_inference_requests') == 1, 'proof requires exactly one real fallback inference')
    require(runtime.get('gateway_http_status') == 200, 'fallback did not return HTTP200')
    require(runtime.get('request_ids'), 'no response request ID from actual transport')
    require(receipt['projection']['role']['chain'] == chain and receipt['projection']['effective_chain'] == chain,
            'role source or projection differs from declared chain')
    require(receipt['projection']['base_chain'] != chain and not receipt['projection']['result']['overrides'],
            'projection only inherited the base or preserved an override')
    fallback_requests = [r for r in runtime.get('requests', []) if r.get('model') == chain[1]]
    require(len(fallback_requests) == 1 and fallback_requests[0]['url'] == GATEWAY + '/v1/chat/completions',
            'fallback transport does not prove public gateway ingress')
    rows = receipt['receipts']
    require(bool(rows), 'no matching completed gateway ledger receipt')
    for row in rows:
        require(row['route'] == chain[1], 'ledger route differs from first fallback')
        require(row['account'] == catalog[chain[1]]['account'], 'ledger account differs from deployment catalog')
        require(row['native_model'] == catalog[chain[1]]['upstream'], 'ledger native model differs from deployment catalog')
        require(row['token_name'].startswith('aai:' + consumer + ':'), 'ledger did not use member own consumer')
        require(row['request_id'] in runtime['request_ids'], 'ledger request ID differs from actual response')
        require(row['requested_effort'] and row['effective_effort'] and isinstance(row['effort_defaulted'], bool), 'ledger effort/defaulting incomplete')
        if not row['effort_defaulted']:
            require(row['requested_effort'] == fallback_requests[0].get('reasoning_effort'), 'ledger effort differs from actual outbound request')


def make_bounded_send(chain, evidence, original_send):
    """Intercept only this child process; forward exactly one real first-fallback call."""
    import httpx

    def bounded_send(client, request, *args, **kwargs):
        host = request.url.host
        require(host == 'api.automaticai.io' and request.url.scheme == 'https', 'Hermes attempted non-gateway HTTP transport')
        if request.method == 'GET':
            require(request.url.path == '/v1/models', 'Hermes attempted unexpected gateway GET')
            return original_send(client, request, *args, **kwargs)
        require(request.method == 'POST' and request.url.path == '/v1/chat/completions', 'unexpected inference API')
        body = json.loads(request.content)
        model = body.get('model')
        evidence['requests'].append({'model':model, 'url':str(request.url),
            'reasoning_effort':body.get('reasoning_effort'), 'max_tokens':body.get('max_tokens'),
            'max_completion_tokens':body.get('max_completion_tokens'), 'stream':body.get('stream', False)})
        if model == chain[0]:
            evidence['primary_http503_count'] += 1
            require(evidence['primary_http503_count'] <= 12, 'primary retry bound exceeded')
            return httpx.Response(503, request=request, json={'error':{'message':'AC6 client-local primary injection', 'type':'server_error'}})
        require(model == chain[1], 'Hermes attempted a later or undeclared fallback')
        require(body.get('max_tokens', body.get('max_completion_tokens', 0)) in range(1, 513), 'outbound token bound missing/exceeded')
        require(evidence['real_inference_requests'] == 0, 'real inference request bound exceeded')
        evidence['real_inference_requests'] += 1
        response = original_send(client, request, *args, **kwargs)
        evidence['gateway_http_status'] = response.status_code
        request_id = response.headers.get('x-oneapi-request-id')
        if request_id:
            evidence['request_ids'].append(request_id)
        return response

    return bounded_send


def child(work, hermes_root, deadline):
    """Fresh process: load projected config before constructing the unmodified Hermes agent."""
    sys.path.insert(0, str(hermes_root))
    import httpx
    from unittest.mock import patch
    from hermes_cli.config import load_config
    from hermes_cli.fallback_config import get_fallback_chain
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from run_agent import AIAgent

    desk = Path(os.environ['HERMES_HOME'])
    config = load_config()
    spec = json.loads((work / 'challenge.json').read_text())
    chain = [config['model']['default'], *[entry['model'] for entry in get_fallback_chain(config)]]
    require(chain == spec['chain'], 'Hermes config loader differs from projected role chain')
    require(config['providers']['automaticai']['api'].rstrip('/') == GATEWAY + '/v1', 'Hermes endpoint differs from public gateway')
    evidence = {'config_sha256':digest(desk / 'config.yaml'), 'effective_chain':chain,
                'primary_http503_count':0, 'real_inference_requests':0, 'request_ids':[], 'requests':[],
                'fallback_notice_count':0, 'completed':False}
    bounded_send = make_bounded_send(chain, evidence, httpx.Client.send)

    def alarm(_signum, _frame):
        raise Blocker('isolated Hermes wall deadline exceeded')

    signal.signal(signal.SIGALRM, alarm)
    signal.alarm(deadline)
    agent: Any = None
    transport_guard = patch.object(httpx.Client, 'send', bounded_send)
    transport_guard.start()
    try:
        runtime = resolve_runtime_provider(requested=config['model']['provider'], target_model=chain[0])
        require(runtime['base_url'].rstrip('/') == GATEWAY + '/v1', 'resolved primary bypasses public gateway')
        def status(text, *unused, **options):
            if 'fallback' in str(text).lower():
                evidence['fallback_notice_count'] += 1
        agent_factory: Any = AIAgent
        agent = agent_factory(model=chain[0], provider=config['model']['provider'], requested_provider=config['model']['provider'],
            api_key=runtime['api_key'], base_url=runtime['base_url'], api_mode=runtime['api_mode'],
            fallback_model=get_fallback_chain(config), enabled_toolsets=[], max_tokens=512, max_iterations=2,
            run_budget_seconds=deadline - 5, quiet_mode=True, skip_context_files=True,
            skip_memory=True, skip_background_review=True, save_trajectories=False,
            session_id='flume32-ac6-' + spec['marker'].removeprefix('AAI_ROUTE_PROOF_'),
            status_callback=status)
        require(not agent.tools, 'proof unexpectedly enabled tools')
        result = agent.run_conversation(spec['marker'] + '\nReply only OK. Do not use tools.', system_message='Reply only OK. No tools.')
        evidence.update(activated_model=agent.model, fallback_index=agent._fallback_index,
            completed=not bool(result.get('error')),
            final_response_nonempty=bool(result.get('final_response')),
            final_response_sha256=hashlib.sha256(str(result.get('final_response', '')).encode()).hexdigest(),
            result_error_present=bool(result.get('error')))
    except Exception as error:
        evidence.update(blocker=error.args[0] if isinstance(error, Blocker) else type(error).__name__,
                        error_type=type(error).__name__)
    finally:
        signal.alarm(0)
        if agent is not None:
            with contextlib.suppress(Exception):
                agent.close()
        (work / 'runtime.json').write_text(json.dumps(evidence, indent=2) + '\n')
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='authorize exactly one real fallback inference')
    parser.add_argument('--profile', default='flume-pm', help='existing member credential mapping (read-only)')
    parser.add_argument('--chain', nargs='+', required=True, help='explicit primary then fallback routes; no embedded route defaults')
    parser.add_argument('--scratch-root', type=Path, default=SCRATCH)
    parser.add_argument('--hermes-root', type=Path, default=ACCOUNT_HOME / '.hermes/hermes-agent')
    parser.add_argument('--gateway-ops', type=Path, default=ACCOUNT_HOME / 'docker/stacks/ai/newapi/ops')
    parser.add_argument('--deadline', type=int, default=110, choices=range(30, 121))
    args = parser.parse_args()
    require(args.live, '--live required; no inference was sent')
    require(args.scratch_root.resolve().is_relative_to(SCRATCH.resolve()), 'scratch root outside assigned profile scratch')
    args.scratch_root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='flume32-ac6-', dir=args.scratch_root))
    os.chmod(work, 0o700)
    key = ''
    receipt = {'verdict':'BLOCKED', 'ticket':'FLUME-32', 'recorded_at':time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'ingress':INGRESS, 'effective_chain':args.chain, 'scratch_path':str(work),
               'failure_injection':'HTTP503 at client-local httpx send for declared primary only; no primary sent to gateway',
               'bounds':{'real_inference_requests':1, 'max_tokens':512, 'hermes_wall_seconds':args.deadline},
               'receipts':[]}
    try:
        helper = load_module('flume_member_token_mapping', ROOT / 'scripts/gateway-member-tokens.py')
        member = ACCOUNT_HOME / '.hermes/profiles' / args.profile / 'config.yaml'
        consumer, reference = member_reference(args.profile, helper, member)
        receipt.update(consumer=consumer, credential_reference=reference,
            runner_sha256=digest(Path(__file__)), projector_sha256=digest(ROOT / 'scripts/ac6-project-role.mjs'),
            hermes_commit=run_checked(['git','-C',str(args.hermes_root),'rev-parse','HEAD'], stage='Hermes revision').strip(),
            template_commit=run_checked(['git','-C',str(ROOT / 'templates/hermes-agent'),'rev-parse','HEAD'], stage='template revision').strip())
        protected = [ACCOUNT_HOME / '.hermes/config.yaml', member, member.with_name('config.delta.yaml'),
                     ACCOUNT_HOME / '.hermes/agents-registry.yaml', ACCOUNT_HOME / '.hermes/org.yaml',
                     args.gateway_ops / 'routes.json']
        receipt['protected_before_sha256'] = {str(p):digest(p) for p in protected}
        # Secret resolution is read-only; never invoke the helper's provisioning main/mint.
        key = run_checked(['op', 'read', reference], timeout=20, stage='member credential read').strip()
        require(len(key) > 20, 'member credential missing')
        catalog_path = args.gateway_ops / 'routes.json'
        catalog = {route['id']:route for route in json.loads(catalog_path.read_text())['routes']}
        authenticated = models(key)
        validate_chain(args.chain, catalog, authenticated)
        receipt['catalog'] = {'sha256':digest(catalog_path), 'authenticated_models_verified':True,
            'selected_routes':[{k:catalog[route].get(k) for k in ('id','account','upstream','default_effort','billing')} for route in args.chain]}
        profile = args.profile
        fleet = work / 'fleet'
        desk = fleet / 'profiles' / profile
        desk.mkdir(parents=True)
        (work / 'home').mkdir()
        (work / 'roles').mkdir()
        # Minimal scratch base; chain deliberately differs from the role to rule out inheritance-only proof.
        provider = {'name':'AutomaticAI', 'api':GATEWAY + '/v1', 'key_env':helper.ENV_NAME,
                    'api_mode':'chat_completions', 'extra_body':{'reasoning_effort':'xhigh'},
                    'request_timeout_seconds':40}
        base = {'model':{'provider':'automaticai','default':args.chain[-1],'api_mode':'chat_completions'},
                'fallback_providers':[], 'providers':{'automaticai':provider},
                'secrets':{'onepassword':{'env':{helper.ENV_NAME:reference}}},
                'agent':{'api_max_retries':3,'auto_recover_max_attempts':0},
                'compression':{'enabled':False}, 'memory':{'memory_enabled':False,'user_profile_enabled':False},
                'skills':{'external_dirs':[]}, 'plugins':{'enabled':False}}
        (fleet / 'config.yaml').write_text(yaml.safe_dump(base, sort_keys=False))
        (desk / 'config.yaml').write_text(yaml.safe_dump(base, sort_keys=False))
        (desk / 'config.delta.yaml').write_text('{}\n')
        (fleet / 'agents-registry.yaml').write_text(yaml.safe_dump({'agents':{'proof-manager':{'role':'director'}, profile:{'role':'ac6'}}}))
        (fleet / 'org.yaml').write_text(yaml.safe_dump({'departments':[{'id':'proof','manager':'proof-manager','members':[]}]}))
        role = {'role':'ac6','department':'proof','reports_to':'proof-manager','chain':args.chain}
        role_path = work / 'roles/ac6.md'
        role_path.write_text('---\n' + yaml.safe_dump(role, sort_keys=False) + '---\nBounded AC6 test desk.\n')
        environment = safe_environment(work)
        environment[helper.ENV_NAME] = key
        run_checked(['node', str(ROOT / 'scripts/ac6-project-role.mjs'), str(work), profile, str(catalog_path)],
                    env=environment, timeout=75, stage='real Flume role projection')
        projection = json.loads((work / 'projection.json').read_text())
        receipt['projection'] = {**projection, 'role_sha256':digest(role_path), 'config_sha256':digest(desk / 'config.yaml'),
            'role_source':role_path.read_text(), 'generated_config':(desk / 'config.yaml').read_text(),
            'delta':(desk / 'config.delta.yaml').read_text(), 'managed_state':json.loads((desk / 'role-projection.json').read_text()),
            'base_chain':[base['model']['default']], 'source_commit':run_checked(['git','rev-parse','HEAD'], stage='source revision').strip()}
        marker = 'AAI_ROUTE_PROOF_' + secrets.token_hex(16)
        receipt.update(marker=marker, since=int(time.time()))
        (work / 'challenge.json').write_text(json.dumps({'chain':args.chain,'marker':marker}))
        environment = safe_environment(work, desk)
        environment[helper.ENV_NAME] = key
        # Private child mode intentionally absent from public argparse; no auth in arguments.
        run_checked([sys.executable, str(Path(__file__).resolve()), '_child', str(work), str(args.hermes_root), str(args.deadline)],
                    env=environment, timeout=args.deadline + 15, stage='isolated installed Hermes')
        receipt['runtime'] = json.loads((work / 'runtime.json').read_text())
        sys.path.insert(0, str(args.gateway_ops))
        proof = load_module('flume_gateway_usage_proof', args.gateway_ops / 'gateway-proof.py')
        def ledger_deadline(_signum, _frame):
            raise Blocker('read-only ledger deadline exceeded')
        signal.signal(signal.SIGALRM, ledger_deadline)
        signal.alarm(60)
        # Ignore ambient NEWAPI_URL: this proof names the public endpoint exactly.
        setattr(sys.modules['aai'], 'BASE', GATEWAY)
        gateway = proof.Gateway()
        # The ops reader only executes authenticated GET /api/log queries. No login/provision/rekey.
        until = time.monotonic() + 10
        while True:
            rows, exhausted = proof.fetch_rows(gateway, since=receipt['since'], route=args.chain[1], max_pages=2)
            matches = proof.match_receipts(rows, marker=marker, since=receipt['since'], route=args.chain[1], account=catalog[args.chain[1]]['account'])
            by_id = {row['id']:row for row in rows}
            for match in matches:
                other = json.loads(by_id[match['log_id']].get('other') or '{}')
                match['effort_defaulted'] = other.get('automaticai_effort_defaulted')
                match['ledger_reasoning_effort'] = other.get('reasoning_effort')
            receipt['receipts'] = matches
            if matches or time.monotonic() >= until:
                break
            time.sleep(0.5)
        verdict_check(receipt, args.chain, consumer, catalog)
        receipt['protected_after_sha256'] = {str(p):digest(p) for p in protected}
        require(receipt['protected_before_sha256'] == receipt['protected_after_sha256'], 'protected live source changed during proof')
        require(digest(desk / 'config.yaml') == receipt['projection']['config_sha256'], 'runtime rewrote generated config')
        require(key not in json.dumps(receipt), 'credential unexpectedly present in receipt; refusing export')
        receipt['verdict'] = 'PASS'
    except Exception as error:
        receipt['blocker'] = str(error) if isinstance(error, Blocker) else type(error).__name__
    signal.alarm(0)
    # Fail closed even on a failed assertion: never persist an accidentally echoed key.
    if 'key' in locals() and key and key in json.dumps(receipt):
        receipt = {'verdict':'BLOCKED', 'ticket':'FLUME-32', 'blocker':'credential detected; receipt export suppressed'}
    receipt_path = work / 'receipt.json'
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'verdict':receipt['verdict'], 'receipt_path':str(receipt_path), 'blocker':receipt.get('blocker')}))
    return 0 if receipt['verdict'] == 'PASS' else 2


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '_child':
        logging.disable(logging.CRITICAL)
        # Hermes/library output can contain provider bodies: do not export it, even on failure.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            child(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]))
    else:
        try:
            raise SystemExit(main())
        except Blocker as error:
            print(json.dumps({'verdict':'BLOCKED', 'blocker':str(error)}))
            raise SystemExit(2)
