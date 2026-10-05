// FLUME-32: exercise the registry adapter with the canonical parser and real flock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import YAML from 'yaml';

const root=resolve(import.meta.dirname,'..');
const work=fs.mkdtempSync('/tmp/flume32-registry-');
const bundle=join(root,'tests',`.registry-comments-${process.pid}.mjs`);
let count=0;
const pass=label=>{count++;console.log(`PASS ${label}`);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async path=>{
  const deadline=Date.now()+5000;
  while(!fs.existsSync(path)) {assert.ok(Date.now()<deadline,`barrier not reached: ${path}`);await delay(10);}
};
try {
  await build({entryPoints:[join(root,'packages/flume-hr/src/hire/PreserveRegistryComments.ts')],outfile:bundle,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
  const {copierRegistryPath,preserveCopierRegistryComments}=await import(pathToFileURL(bundle).href);
  const home=join(work,'home'),config=join(work,'config.toml'),fleetEnv=join(work,'fleet.env');
  fs.mkdirSync(home);
  fs.writeFileSync(config,`[fleet]\nfleet_env = ${JSON.stringify(fleetEnv)}\nregistry_file = "~/toml-registry.yaml"\n`);
  const env={HOME:home,PATH:'/usr/bin:/bin',HERMES_TEMPLATE_CONFIG:config,PYTHONDONTWRITEBYTECODE:'1'};

  for(const [label,text,extra,wanted] of [
    ['unquoted expansion',`HERMES_FLEET_HOME='${home}/fleet space' # home\nHERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/registry.yaml # registry\n`,{},join(home,'fleet space/registry.yaml')],
    ['braced expansion',`HERMES_FLEET_HOME='${home}/from-file'\nHERMES_FLEET_REGISTRY_FILE=\${HERMES_FLEET_HOME}/registry.yaml\n`,{HERMES_FLEET_HOME:join(home,'from-caller')},join(home,'from-caller/registry.yaml')],
    ['quoted inline comment',`HERMES_FLEET_REGISTRY_FILE="${home}/registry with spaces.yaml" # preserve\n`,{},join(home,'registry with spaces.yaml')],
    ['single quotes stay literal',`HERMES_FLEET_REGISTRY_FILE='${home}/$HERMES_FLEET_HOME.yaml' # literal\n`,{},join(home,'$HERMES_FLEET_HOME.yaml')],
    ['ANSI-C escapes',`HERMES_FLEET_REGISTRY_FILE=$'${home}/registry\\x20space.yaml' # ANSI\n`,{},join(home,'registry space.yaml')],
    ['caller fleet registry wins',`HERMES_FLEET_REGISTRY_FILE='${home}/from-file.yaml'\n`,{HERMES_FLEET_REGISTRY_FILE:join(home,'from-env.yaml')},join(home,'from-env.yaml')],
    ['Flume registry override',`HERMES_FLEET_REGISTRY_FILE='${home}/from-file.yaml'\n`,{HERMES_AGENTS_REGISTRY:join(home,'from-flume.yaml')},join(home,'from-flume.yaml')],
    ['REGISTRY_FILE wins',`REGISTRY_FILE='${home}/file-registry.yaml'\nHERMES_FLEET_REGISTRY_FILE='${home}/file-fleet.yaml'\n`,{REGISTRY_FILE:join(home,'explicit.yaml'),HERMES_AGENTS_REGISTRY:join(home,'flume.yaml')},join(home,'explicit.yaml')],
    ['template REGISTRY_FILE assignment',`REGISTRY_FILE='${home}/file-registry.yaml'\n`,{HERMES_FLEET_REGISTRY_FILE:join(home,'caller-fleet.yaml')},join(home,'file-registry.yaml')],
    ['empty file falls back to TOML','',{},join(home,'toml-registry.yaml')],
  ]) {
    fs.writeFileSync(fleetEnv,text);
    assert.equal(copierRegistryPath({...env,...extra}),wanted,label);
    assert.equal(fs.readFileSync(fleetEnv,'utf8'),text,'the parser does not rewrite fleet.env');
    pass(`canonical parser: ${label}`);
  }
  fs.rmSync(fleetEnv);
  assert.equal(copierRegistryPath(env),join(home,'toml-registry.yaml'));
  pass('optional missing fleet.env');

  for(const [label,text] of [
    ['duplicate variable','HERMES_FLEET_REGISTRY_FILE=/one\nHERMES_FLEET_REGISTRY_FILE=/two\n'],
    ['unresolved supported expansion','HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/registry.yaml\n'],
    ['unsupported expansion','HERMES_FLEET_REGISTRY_FILE=$OTHER/registry.yaml\n'],
    ['quoted dynamic expansion','HERMES_FLEET_REGISTRY_FILE="$HERMES_FLEET_HOME/registry.yaml"\n'],
    ['bad quoted suffix','HERMES_FLEET_REGISTRY_FILE="/tmp/registry" trailing\n'],
    ['interpreter injection','NODE_OPTIONS=--inspect\n'],
  ]) {
    fs.writeFileSync(fleetEnv,text);
    assert.throws(()=>copierRegistryPath({...env,REGISTRY_FILE:join(home,'explicit.yaml')}),/Fleet environment:/,label);
    assert.equal(fs.readFileSync(fleetEnv,'utf8'),text);
    pass(`invalid fleet data refused: ${label}`);
  }
  fs.rmSync(fleetEnv);
  const operatorEnv=join(work,'operator.env');fs.writeFileSync(operatorEnv,'# operator\n');fs.symlinkSync(operatorEnv,fleetEnv);
  assert.throws(()=>copierRegistryPath(env),/Fleet environment:/);
  assert.equal(fs.readFileSync(operatorEnv,'utf8'),'# operator\n');fs.rmSync(fleetEnv);
  pass('fleet.env symlink refused without changing its target');

  const registry=join(work,'registry.yaml');
  const restoreFrom=async(before,after)=>{
    fs.writeFileSync(registry,before,{mode:0o640});
    const restore=await preserveCopierRegistryComments(registry);
    fs.writeFileSync(registry,after);
    await restore();
    assert.deepEqual(YAML.parse(fs.readFileSync(registry,'utf8')),YAML.parse(after),'latest values and aliases stay authoritative');
    return {restore,text:fs.readFileSync(registry,'utf8')};
  };
  const changed=await restoreFrom('# top\nlist: &old [one, two] # list\nmirror: *old # mirror\nagents: {}\n',
    'list: &old [one, three]\nmirror: *old\nagents: {hire: {role: dev}}\n');
  assert.match(changed.text,/# list/);assert.match(changed.text,/# mirror/);
  pass('changed anchored sequence retains after alias identities and old comments');

  const renamed=await restoreFrom('# top\nlist: &old [one] # original list\nmirror: *old\nagents: {}\n',
    '# concurrent top\nlist: &new [one] # concurrent list\nmirror: *new\ninserted: *new\nagents: {}\n');
  for(const comment of ['top','original list','concurrent top','concurrent list']) assert.ok(renamed.text.includes(`# ${comment}`));
  assert.match(renamed.text,/&new/);assert.doesNotMatch(renamed.text,/&old|\*old/);
  fs.writeFileSync(registry,'list: &third [changed]\nmirror: *third\ninserted: *third\nagents: {}\n');
  await renamed.restore();
  assert.deepEqual(YAML.parse(fs.readFileSync(registry,'utf8')).inserted,['changed']);
  pass('renamed and inserted aliases survive repeated restoration from an immutable snapshot');

  const list=await restoreFrom('agents: {}\nobservations:\n  - obsolete # removed item\n  - keep # surviving scalar\n  - {id: unchanged, value: one} # surviving map\n',
    'agents: {}\nobservations:\n  - {id: unchanged, value: one}\n  - new\n  - keep # current scalar\n');
  for(const comment of ['surviving scalar','surviving map','current scalar']) assert.ok(list.text.includes(comment));
  assert.doesNotMatch(list.text,/removed item/);
  pass('surviving reordered scalar/map list comments remain attached; deleted-item comments stay deleted');

  const repeated=await restoreFrom('# original top\nagents: {}\n','# concurrent top\n# concurrent top\nagents: {}\n');
  assert.equal(repeated.text.match(/# concurrent top/g).length,2);
  assert.match(repeated.text,/# original top/);
  pass('concurrent repeated comment lines are preserved verbatim');

  // A writer holds the template's exact .lock before restoration starts.
  fs.writeFileSync(registry,'# original top\nagents: {boss: {role: director}} # original agents\n');
  const restore=await preserveCopierRegistryComments(registry);
  fs.writeFileSync(registry,'agents: {boss: {role: director}, hire: {role: dev}}\n');
  const ready=join(work,'ready'),release=join(work,'release');
  const writer=spawn('flock',[`${registry}.lock`,'python3','-I','-c',String.raw`
import pathlib, sys, time
registry, ready, release = map(pathlib.Path, sys.argv[1:])
ready.write_text('locked')
deadline = time.monotonic() + 5
while not release.exists():
    if time.monotonic() > deadline: raise SystemExit('release timed out')
    time.sleep(.01)
registry.write_text('# concurrent top\nagents:\n  boss: {role: director}\n  hire: {role: dev}\n  peer: {role: reviewer} # concurrent employee\n')
`,registry,ready,release],{stdio:['ignore','pipe','pipe']});
  const writerDone=new Promise((resolve,reject)=>{writer.once('error',reject);writer.once('exit',code=>code===0?resolve():reject(new Error(`peer writer exit ${code}`)));});
  await waitFor(ready);
  let restored=false;const restoring=restore().then(()=>{restored=true;});
  await delay(40);assert.equal(restored,false,'restoration must wait for the existing writer lock');
  fs.writeFileSync(release,'release');await writerDone;await restoring;
  const concurrent=fs.readFileSync(registry,'utf8');
  assert.deepEqual(Object.keys(YAML.parse(concurrent).agents),['boss','hire','peer']);
  for(const comment of ['original top','original agents','concurrent top','concurrent employee']) assert.ok(concurrent.includes(comment));
  pass('locked restoration preserves the latest concurrent employee, values and comments');

  // Observe publication via an already-open reader. Replacement keeps that
  // reader's complete old document intact; an in-place truncate would change it.
  fs.writeFileSync(registry,'# original\nagents: {}\n');
  const atomicRestore=await preserveCopierRegistryComments(registry);
  const latest='agents: {hire: {role: dev}}\n';fs.writeFileSync(registry,latest);
  const oldFd=fs.openSync(registry,'r'),oldInode=fs.fstatSync(oldFd).ino;
  const realFsync=fs.fsyncSync;let lockChecks=0;
  const oldUmask=process.umask(0o077);
  try {
    fs.fsyncSync=fd=>{
      const contender=spawnSync('flock',['-n',`${registry}.lock`,'true']);
      assert.equal(contender.status,1,'the registry lock covers both file and directory flush');lockChecks++;
      realFsync(fd);
    };syncBuiltinESMExports();
    await atomicRestore();
    assert.ok(lockChecks>=2);assert.notEqual(fs.statSync(registry).ino,oldInode);
    assert.equal(fs.readFileSync(oldFd,'utf8'),latest,'an existing reader sees its complete old inode');
    assert.deepEqual(YAML.parse(fs.readFileSync(registry,'utf8')).agents,{hire:{role:'dev'}});
    assert.equal(fs.statSync(registry).mode&0o777,0o640);
  } finally {fs.fsyncSync=realFsync;syncBuiltinESMExports();fs.closeSync(oldFd);process.umask(oldUmask);}
  pass('atomic flush/rename publication preserves old readers, permissions and serialization');

  fs.writeFileSync(registry,'# restore me\nagents: {}\n');
  const failedRestore=await preserveCopierRegistryComments(registry);
  fs.writeFileSync(registry,latest);const beforeFiles=fs.readdirSync(work).sort();
  try {
    fs.fsyncSync=()=>{throw new Error('injected flush failure');};syncBuiltinESMExports();
    await assert.rejects(failedRestore(),/injected flush failure/);
  } finally {fs.fsyncSync=realFsync;syncBuiltinESMExports();}
  assert.equal(fs.readFileSync(registry,'utf8'),latest);
  assert.deepEqual(fs.readdirSync(work).sort(),beforeFiles,'failed publication leaves no temporary artifact');
  assert.equal(spawnSync('flock',['-n',`${registry}.lock`,'true']).status,0,'failure releases the lock');
  pass('flush failure leaves the complete latest registry unchanged and releases the lock');
  console.log(`\n${count} registry comment check groups passed`);
} finally {fs.rmSync(bundle,{force:true});fs.rmSync(work,{recursive:true,force:true});}
