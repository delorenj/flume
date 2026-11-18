// The scaffold renderer handles the template's `{% if name == "x" %}` branches
// byte-for-byte as Copier does. 2026-11-18: the sentinel prompt gained a
// ticket_provider branch (PJAN-17) and every pm-scaffold refresh went blocked
// with render-unsupported. The proof here is Copier itself: each provider's
// rendered sentinel prompt must equal Flume's render of the vendored template.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'..');
const template=join(root,'templates','hermes-agent');
const bundle=join(root,'tests',`.scaffold-conditional-${process.pid}.mjs`);
const work=fs.mkdtempSync(join(os.tmpdir(),'flume-scaffold-cond-'));
let count=0;
const pass=label=>{count++;console.log(`PASS ${label}`);};
try {
  await build({entryPoints:[join(root,'packages/flume-hr/src/scaffold/compare.ts')],outfile:bundle,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
  const {renderTemplate}=await import(pathToFileURL(bundle).href);

  // Unit: the branch semantics, and what stays unsupported.
  const src='a\n{% if p == "x" %}\nX\n{% else %}\nY\n{% endif %}\nb {{ p }}\n';
  assert.deepEqual(renderTemplate(src,{p:'x'}),{ok:true,text:'a\n\nX\n\nb x\n'});
  assert.deepEqual(renderTemplate(src,{p:'z'}),{ok:true,text:'a\n\nY\n\nb z\n'});
  assert.equal(renderTemplate('{% if p != "x" %}N{% endif %}',{p:'y'}).text,'N');
  assert.equal(renderTemplate('{% if p == "x" %}{% if q == "y" %}B{% endif %}A{% endif %}',{p:'x',q:'n'}).text,'A');
  pass('if/else/endif keep every byte around the tags, nested too');

  assert.equal(renderTemplate('{% if p == "x" %}X{% endif %}',{}).reason,'render-unsupported');
  assert.equal(renderTemplate('{% if p == "x" %}X{% endif %}',{p:null}).reason,'input-missing');
  for (const bad of ['{% if p == "x" %}X','X{% endif %}','{% else %}','{% if p == "x" %}A{% elif p == "y" %}B{% endif %}','{%- if p == "x" %}X{% endif %}','{% if p|lower == "x" %}X{% endif %}']) {
    assert.equal(renderTemplate(bad,{p:'x'}).reason,'render-unsupported',bad);
  }
  pass('unbalanced tags, elif, whitespace control and filters stay render-unsupported');

  // Integration: Copier's own render of the vendored template, per provider.
  const copier=spawnSync('copier',['--version'],{encoding:'utf8'});
  if (copier.status!==0) throw new Error('copier is required for this suite');
  const source=fs.readFileSync(join(template,'template','.scripts','sentinel.prompt.md.jinja'),'utf8');
  for (const provider of ['plane','trello']) {
    const inputs={target_repo:'demo',role:'pm',ticket_provider:provider,agent_id:'demo-pm',display_name:'Demo PM'};
    const dest=join(work,provider);
    const data=Object.entries(inputs).flatMap(([k,v])=>['--data',`${k}=${v}`]);
    const run=spawnSync('copier',['copy','--skip-tasks','--defaults','--trust','--vcs-ref=HEAD',...data,template,dest],{encoding:'utf8',timeout:120_000});
    assert.equal(run.status,0,run.stdout+run.stderr);
    const copierText=fs.readFileSync(join(dest,'.scripts','sentinel.prompt.md'),'utf8');
    const ours=renderTemplate(source,inputs);
    assert.equal(ours.ok,true,ours.detail);
    assert.equal(ours.text,copierText,`${provider}: Flume's render differs from Copier's`);
  }
  pass('the sentinel prompt renders byte-identical to Copier for plane and trello');

  console.log(`\n${count} scaffold conditional regressions passed`);
} finally {
  fs.rmSync(bundle,{force:true});
  fs.rmSync(work,{recursive:true,force:true});
}
