import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, createFetchMock } from 'miniflare';

test('icon discovery runs with actual Workers fetch semantics and manual DNS redirects',async()=>{
  const mock=createFetchMock();mock.disableNetConnect();
  for(const type of ['A','AAAA'])mock.get('https://cloudflare-dns.com').intercept({path:'/dns-query?name=www.python.org&type='+type}).reply(200,JSON.stringify({Status:0,Answer:type==='A'?[{type:1,data:'151.101.0.223'}]:[]}),{headers:{'Content-Type':'application/dns-json'}});
  mock.get('https://www.python.org').intercept({path:'/'}).reply(200,'<link rel="icon" href="/favicon.png">',{headers:{'Content-Type':'text/html'}});
  mock.get('https://www.python.org').intercept({path:'/favicon.png'}).reply(200,Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13]),{headers:{'Content-Type':'image/png'}});
  const bundle=await build({stdin:{contents:`import {discoverIcon} from './src/site-icons.mjs';export default {async fetch(){const icon=await discoverIcon('https://www.python.org');return new Response(icon.bytes,{headers:{'Content-Type':icon.type}})}};`,resolveDir:process.cwd()},bundle:true,format:'esm',write:false});
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',fetchMock:mock});
  try{const response=await mf.dispatchFetch('https://fixture.invalid');assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');assert.equal((await response.arrayBuffer()).byteLength,12);mock.assertNoPendingInterceptors();}
  finally{await mf.dispose();}
});
