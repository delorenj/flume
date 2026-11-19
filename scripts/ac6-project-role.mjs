#!/usr/bin/env node
// AC6's only projection entrypoint: real role reader, validator and renderer API.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, symlinkSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import YAML from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [work, profile, catalog] = process.argv.slice(2);
assert.ok(work && profile && catalog, 'work, profile and deployment catalog required');
// External packages resolve through the existing checkout, not a fresh install.
const dependencies = fileURLToPath(import.meta.resolve('yaml')).split('/node_modules/')[0] + '/node_modules';
symlinkSync(dependencies, join(work, 'node_modules'));
const bundle = join(work, 'role-api.mjs');
await build({entryPoints:[join(root, 'packages/flume-hr/src/workforce/role.ts')],
  outfile:bundle, bundle:true, packages:'external', platform:'node', format:'esm', logLevel:'silent'});
const api = await import(pathToFileURL(bundle).href);
const fleet = join(work, 'fleet');
const role = api.readRoleDeclaration(work, 'ac6', profile, profile);
const result = await api.projectRoleDeclaration(role, profile, profile, {
  home:join(work, 'home'), fleetRoot:fleet,
  registryPath:join(fleet, 'agents-registry.yaml'), orgPath:join(fleet, 'org.yaml'),
  deskPath:join(fleet, 'profiles', profile), catalogPath:catalog,
  renderer:join(root, 'templates/hermes-agent/scripts/hermes-profile-config.py'),
});
const config = YAML.parse(readFileSync(join(fleet, 'profiles', profile, 'config.yaml'), 'utf8'));
const chain = [config.model.default, ...config.fallback_providers.map(entry => entry.model)];
assert.deepEqual(chain, role.chain);
assert.deepEqual(result.overrides, []);
assert.equal(result.fallback_surface, 'desk-gateway');
writeFileSync(join(work, 'projection.json'), JSON.stringify({
  role, result, effective_chain:chain,
  authenticated_catalog_check:'projectRoleDeclaration invoked scripts/role-catalog-check.py (no catalogModels bypass)',
}, null, 2) + '\n');
console.log(JSON.stringify({projected:true, chain, overrides:result.overrides}));
