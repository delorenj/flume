"""Offline safety/acceptance regressions; fixture responses are not live AC6 evidence.

Use the installed Hermes Python, which supplies httpx and PyYAML:
  .venv/bin/python tests/ac6-projected-fallback-regressions.py
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ac6', ROOT / 'scripts/ac6-live-projected-fallback.py')
assert spec is not None and spec.loader is not None
ac6 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ac6)
import httpx

CHAIN = ['automaticai/personal/fixture-primary', 'automaticai/personal/fixture-first', 'automaticai/personal/fixture-later']
CATALOG = {route:{'billing':'subscription','account':'fixture-personal','upstream':'fixture-native'} for route in CHAIN}


def fixture_receipt():
    return {'projection':{'config_sha256':'same-hash','role':{'chain':CHAIN}, 'effective_chain':CHAIN,
                          'base_chain':[CHAIN[-1]], 'result':{'overrides':[]}},
            'runtime':{'config_sha256':'same-hash','effective_chain':CHAIN,'primary_http503_count':3,
                       'activated_model':CHAIN[1],'fallback_index':1,'completed':True,'final_response_nonempty':True,
                       'real_inference_requests':1,'gateway_http_status':200,'request_ids':['fixture-id'],
                       'requests':[{'model':CHAIN[1],'url':ac6.GATEWAY + '/v1/chat/completions','reasoning_effort':'medium'}]},
            'receipts':[{'route':CHAIN[1],'account':'fixture-personal','native_model':'fixture-native',
                         'token_name':'aai:hermes-fixture:123','request_id':'fixture-id',
                         'requested_effort':'medium','effective_effort':'medium','effort_defaulted':False}]}


class ReceiptChecks(unittest.TestCase):
    def test_valid_fixture_shape(self):
        ac6.verdict_check(fixture_receipt(), CHAIN, 'hermes-fixture', CATALOG)

    def test_incomplete_or_misattributed_receipt_never_passes(self):
        cases = [
            ('no ledger', lambda r:r.update(receipts=[])),
            ('wrong consumer', lambda r:r['receipts'][0].update(token_name='aai:hermes-fleet-workers:123')),
            ('wrong account', lambda r:r['receipts'][0].update(account='other-account')),
            ('wrong native model', lambda r:r['receipts'][0].update(native_model='wrong-model')),
            ('different request', lambda r:r['receipts'][0].update(request_id='unrelated')),
            ('later fallback ledger', lambda r:r['receipts'][0].update(route=CHAIN[2])),
            ('later fallback activation', lambda r:r['runtime'].update(activated_model=CHAIN[2],fallback_index=2)),
            ('configuration only', lambda r:r['runtime'].update(primary_http503_count=0)),
            ('no completion', lambda r:r['runtime'].update(completed=False)),
            ('no answer', lambda r:r['runtime'].update(final_response_nonempty=False)),
            ('no request id', lambda r:r['runtime'].update(request_ids=[])),
            ('changed config', lambda r:r['runtime'].update(config_sha256='rewritten')),
            ('wrong chain', lambda r:r['runtime'].update(effective_chain=list(reversed(CHAIN)))),
            ('base only', lambda r:r['projection'].update(base_chain=CHAIN)),
            ('explicit override', lambda r:r['projection']['result'].update(overrides=['model.default'])),
            ('non-public endpoint', lambda r:r['runtime']['requests'][0].update(url='https://api-direct.automaticai.io/v1/chat/completions')),
            ('too many requests', lambda r:r['runtime'].update(real_inference_requests=2)),
            ('missing defaulting', lambda r:r['receipts'][0].pop('effort_defaulted')),
            ('effort mismatch', lambda r:r['receipts'][0].update(requested_effort='xhigh')),
        ]
        for label, mutate in cases:
            with self.subTest(label=label):
                receipt = fixture_receipt()
                mutate(receipt)
                with self.assertRaises((ac6.Blocker, KeyError)):
                    ac6.verdict_check(receipt, CHAIN, 'hermes-fixture', CATALOG)

    def test_actual_gateway_defaulting_is_allowed_and_reported(self):
        receipt = fixture_receipt()
        receipt['receipts'][0].update(effort_defaulted=True,requested_effort='xhigh',effective_effort='xhigh')
        receipt['runtime']['requests'][0]['reasoning_effort'] = None
        ac6.verdict_check(receipt, CHAIN, 'hermes-fixture', CATALOG)


class CatalogAndIsolationChecks(unittest.TestCase):
    def test_chain_requires_both_catalogs_and_nonmetered_intent(self):
        ac6.validate_chain(CHAIN, CATALOG, set(CHAIN))
        cases = [(CHAIN, CATALOG, set(CHAIN[:-1])),
                 (CHAIN, {}, set(CHAIN)), ([CHAIN[0]], CATALOG, set(CHAIN)),
                 ([CHAIN[0], CHAIN[0]], CATALOG, set(CHAIN)),
                 (['automaticai/auto',CHAIN[1]], CATALOG, set(CHAIN))]
        paid = copy.deepcopy(CATALOG)
        paid[CHAIN[1]]['billing'] = 'metered'
        cases.append((CHAIN, paid, set(CHAIN)))
        for args in cases:
            with self.subTest(args=args), self.assertRaises(ac6.Blocker):
                ac6.validate_chain(*args)

    def test_environment_drops_parent_keys_profile_and_hooks(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY':'fixture-not-a-key','HERMES_HOME':'/shared',
                                     'AUTOMATICAI_GATEWAY_KEY':'fixture-not-a-key', 'PYTHONPATH':'/foreign',
                                     'HTTP_PROXY':'http://foreign','CODEX_HOME':'/foreign'}, clear=False):
            env = ac6.safe_environment(Path('/scratch/proof'), Path('/scratch/proof/desk'))
        for key in ('OPENAI_API_KEY','AUTOMATICAI_GATEWAY_KEY','PYTHONPATH','HTTP_PROXY','CODEX_HOME'):
            self.assertNotIn(key, env)
        self.assertEqual(env['HERMES_HOME'], '/scratch/proof/desk')
        self.assertEqual(env['HERMES_DISABLE_PLUGINS'], '1')
        self.assertEqual(env['HERMES_DISABLE_LAZY_INSTALLS'], '1')
        self.assertEqual(env['TMPDIR'], '/scratch/proof')

    def test_no_live_flag_fails_before_any_side_effect(self):
        done = subprocess.run([sys.executable, str(ROOT / 'scripts/ac6-live-projected-fallback.py'), '--chain', *CHAIN],
                              capture_output=True, text=True, timeout=10)
        self.assertEqual(done.returncode, 2)
        self.assertEqual(json.loads(done.stdout)['verdict'], 'BLOCKED')
        self.assertIn('--live required', done.stdout)

    def test_real_projection_entrypoint_is_not_a_mock(self):
        source = (ROOT / 'scripts/ac6-project-role.mjs').read_text()
        self.assertIn('api.readRoleDeclaration(work', source)
        self.assertIn('await api.projectRoleDeclaration(role', source)
        self.assertNotIn('catalogModels:', source)
        self.assertIn('assert.deepEqual(chain, role.chain)', source)


class TransportChecks(unittest.TestCase):
    def setUp(self):
        self.evidence = {'requests':[],'primary_http503_count':0,'real_inference_requests':0,'request_ids':[]}
        self.forwarded = []
        def original(_client, request, *args, **kwargs):
            self.forwarded.append(str(request.url))
            return httpx.Response(200,request=request,headers={'x-oneapi-request-id':'fixture-id'},json={})
        self.send = ac6.make_bounded_send(CHAIN, self.evidence, original)

    def request(self, model, url=ac6.GATEWAY + '/v1/chat/completions', tokens=512):
        return httpx.Request('POST',url,json={'model':model,'max_tokens':tokens,'reasoning_effort':'medium'})

    def test_primary_503_is_client_local(self):
        response = self.send(None,self.request(CHAIN[0]))
        self.assertEqual(response.status_code,503)
        self.assertFalse(self.forwarded)
        self.assertEqual(self.evidence['primary_http503_count'],1)

    def test_first_fallback_is_forwarded_once(self):
        response = self.send(None,self.request(CHAIN[1]))
        self.assertEqual(response.status_code,200)
        self.assertEqual(len(self.forwarded),1)
        self.assertEqual(self.evidence['request_ids'],['fixture-id'])
        with self.assertRaises(ac6.Blocker):
            self.send(None,self.request(CHAIN[1]))
        self.assertEqual(len(self.forwarded),1)

    def test_non_gateway_later_fallback_and_unbounded_tokens_refused(self):
        for request in (self.request(CHAIN[2]), self.request(CHAIN[1],url='https://api.openai.com/v1/chat/completions'),
                        self.request(CHAIN[1],tokens=513), self.request(CHAIN[1],tokens=0)):
            with self.subTest(request=request), self.assertRaises(ac6.Blocker):
                self.send(None,request)
        self.assertFalse(self.forwarded)

    def test_retry_bound(self):
        self.evidence['primary_http503_count'] = 12
        with self.assertRaises(ac6.Blocker):
            self.send(None,self.request(CHAIN[0]))
        self.assertFalse(self.forwarded)


if __name__ == '__main__':
    unittest.main(verbosity=2)
