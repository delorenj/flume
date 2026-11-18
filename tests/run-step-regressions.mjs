// Every child a hire runs goes through runStep: an unattended child gets a
// heartbeat and a bound, so a wedged Copier task or provider call fails the
// step instead of freezing the operator's terminal with no output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'..');
const bundle=join(root,'tests',`.run-step-${process.pid}.mjs`);
let count=0;
const pass=label=>{count++;console.log(`PASS ${label}`);};
try {
  await build({entryPoints:[join(root,'packages/flume-hr/src/utils/run-step.ts')],outfile:bundle,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
  const {runStep,describeStepFailure,defaultStepTimeoutMs}=await import(pathToFileURL(bundle).href);

  let result=await runStep('sh',['-c','echo out; echo err >&2; exit 3'],{label:'t',capture:true,heartbeat:null});
  assert.equal(result.status,3);
  assert.equal(result.stdout,'out\n');
  assert.equal(result.stderr,'err\n');
  assert.equal(describeStepFailure(result),'exited with status 3');
  pass('captured output and exit status come back');

  const beats=[];
  const started=Date.now();
  result=await runStep('sh',['-c','sleep 30'],{label:'wedged task',capture:true,timeoutMs:400,heartbeatMs:100,heartbeat:line=>beats.push(line)});
  assert.equal(result.timedOut,true);
  assert.ok(Date.now()-started<5000,'a timed-out child is killed, not waited on');
  assert.match(describeStepFailure(result),/^timed out after /);
  assert.ok(beats.length>=2,`heartbeats while silent: ${beats.length}`);
  assert.match(beats[0],/wedged task: still running/);
  pass('an unattended child is bounded and reports it is still running');

  const quiet=[];
  result=await runStep('sh',['-c','sleep 0.3'],{label:'human',capture:true,interactive:true,timeoutMs:50,heartbeatMs:50,heartbeat:line=>quiet.push(line)});
  assert.equal(result.timedOut,false);
  assert.equal(result.status,0);
  assert.deepEqual(quiet,[]);
  pass('an interactive child is neither bounded nor interrupted');

  result=await runStep('/nonexistent/flume-step',[],{label:'missing',capture:true,heartbeat:null});
  assert.equal(result.status,null);
  assert.ok(result.error);
  pass('a missing executable is an error result, not a throw');

  assert.equal(defaultStepTimeoutMs({FLUME_STEP_TIMEOUT_MS:'1234'}),1234);
  assert.equal(defaultStepTimeoutMs({FLUME_STEP_TIMEOUT_MS:'junk'}),15*60*1000);
  pass('FLUME_STEP_TIMEOUT_MS overrides the default bound');

  console.log(`\n${count} run-step regressions passed`);
} finally {
  fs.rmSync(bundle,{force:true});
}
