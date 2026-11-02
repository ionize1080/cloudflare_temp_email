import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentEnvironment } from '../scripts/deploy-env.mjs';
const source={WRANGLER_CI_OVERRIDE_NAME:'ionacs-navigation',WRANGLER_CI_MATCH_TAG:'navigation-tag',CLOUDFLARE_API_TOKEN:'build-only-fixture',PATH:'/bin'};
test('mail deployment retains its configured target instead of the connected navigation Worker',()=>{
 const env=deploymentEnvironment(source,'account','deploy-fixture',true);
 assert.equal(env.WRANGLER_CI_OVERRIDE_NAME,undefined);assert.equal(env.WRANGLER_CI_MATCH_TAG,undefined);
 assert.equal(env.CLOUDFLARE_API_TOKEN,'deploy-fixture');assert.equal(env.CLOUDFLARE_ACCOUNT_ID,'account');assert.equal(env.PATH,'/bin');
 assert.equal(source.WRANGLER_CI_OVERRIDE_NAME,'ionacs-navigation');
});
test('navigation deployment keeps the connected Worker target checks',()=>{
 const env=deploymentEnvironment(source,'account','deploy-fixture');
 assert.equal(env.WRANGLER_CI_OVERRIDE_NAME,'ionacs-navigation');assert.equal(env.WRANGLER_CI_MATCH_TAG,'navigation-tag');
});
