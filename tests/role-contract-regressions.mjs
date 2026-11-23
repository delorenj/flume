import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const bundle = new URL(`./.role-contract-${process.pid}.mjs`, import.meta.url);
await (await import('esbuild')).build({entryPoints:['packages/flume-hr/src/index.ts'],outfile:bundle.pathname,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent'});
const api = await import(bundle.href);
(await import('node:fs')).rmSync(bundle);

assert.equal(typeof api.validateRoleDeclaration, 'function', 'role frontmatter must consume the named-agent definitions');
const named = {schema_version:1,id:'alice',display_name:'Alice',role:'dev',charter:{purpose:'Build'},skills:{pack:'dev'},memory:{write_bank:'agent-alice',recall_banks:['custom']}};
const role = {role:'dev',department:'engineering',skills:{pack:'dev'},identity:{name:'alice',write_bank:'agent-alice',recall_banks:['custom']}};
assert.throws(() => api.validateNamedAgentSchema(named), /shared fallback bank/, 'Story 2.1 must reuse established identity validation');
assert.throws(() => api.validateRoleDeclaration(role, 'demo-dev', 'demo-dev'), /shared fallback bank/);
for (const bank of ['agent-bob', 'agent-alice']) {
  named.memory = {write_bank:bank}; role.identity = {name:'alice',write_bank:bank};
  if (bank === 'agent-bob') {
    assert.throws(() => api.validateNamedAgentSchema(named), /agent-alice/);
    assert.throws(() => api.validateRoleDeclaration(role, 'demo-dev','demo-dev'), /agent-alice/);
  } else {
    assert.equal(api.validateNamedAgentSchema(named).id, 'alice');
    assert.equal(api.validateRoleDeclaration(role,'demo-dev','demo-dev').identity.name, 'alice');
  }
}
const schema = JSON.parse(readFileSync(new URL('../contracts/named-agent.schema.json', import.meta.url)));
const roleSchema = JSON.parse(readFileSync(new URL('../contracts/role.schema.json', import.meta.url)));
const baseRole = {role:'dev',department:'engineering'};
for (const route of ['automaticai/auto','automaticai/auto/orchestrator','automaticai/auto/subagent','automaticai/auto/fast','automaticai/personal/sol-5.5']) {
  assert.deepEqual(api.validateRoleDeclaration({...baseRole,chain:[route]},'demo-dev','demo-dev').chain,[route],`${route} must validate`);
}
assert.deepEqual(api.validateRoleDeclaration({...baseRole,chain:['automaticai/auto','automaticai/auto/subagent','automaticai/personal/sol-5.5']},'demo-dev','demo-dev').chain,['automaticai/auto','automaticai/auto/subagent','automaticai/personal/sol-5.5']);
for (const chain of [[],['automaticai/auto','automaticai/auto'],['automaticai/'],['automaticai/auto/'],['automaticai/auto/slow'],['automaticai/auto/subagent/extra'],['automaticai//model'],['automaticai/personal/'],['other/auto'],['automaticai/auto ']]) {
  assert.throws(() => api.validateRoleDeclaration({...baseRole,chain},'demo-dev','demo-dev'),error => error.diagnostics?.some(d => d.field.startsWith('chain')),`invalid role chain ${JSON.stringify(chain)} must fail schema validation`);
}
console.log('PASS FLUME-64 role-chain shapes, nonempty unique chains and malformed routes');
assert.ok(schema.$defs.identity && schema.$defs.skills && schema.$defs.memory);
assert.equal(schema.properties.skills.$ref, '#/$defs/skills');
assert.equal(schema.properties.memory.$ref, '#/$defs/memory');
assert.equal(roleSchema.properties.skills.$ref, schema.$id+'#/$defs/skills');
assert.equal(roleSchema.properties.identity.$ref, schema.$id+'#/$defs/identity');
assert.equal(roleSchema.properties.memory.$ref, schema.$id+'#/$defs/memory');
console.log('PASS shared role/named definitions and established identity semantics');
