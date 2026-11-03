import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconURL, publicAddress, iconCandidates, boundedBytes, discoverIcon, cachedIcon } from '../src/site-icons.mjs';

const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13]);
const dns = url => Response.json({Status:0,Answer:new URL(url).searchParams.get('type')==='A'?[{type:1,data:'93.184.215.14'}]:[]});
function network(handler) { return (url,options) => url.startsWith('https://cloudflare-dns.com/') ? dns(url) : handler(url,options); }
function storage() {
  const entries = new Map();
  return { entries, async getWithMetadata(key) { return entries.get(key) || {value:null,metadata:null}; }, async put(key,value,options) { entries.set(key,{value,metadata:options.metadata}); } };
}
test('icon fetching rejects local, literal, credentialed and non-web addresses',()=>{
  for (const url of ['http://127.1','http://2130706433','http://0x7f000001','http://[::1]','http://localhost','http://router.local','https://user:pass@bbc.com','https://bbc.com:8443','file:///etc/passwd','https://foo.internal/']) assert.throws(()=>iconURL(url));
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.0.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']) assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('1.1.1.1'),true);
});
test('real HTML parsing handles base URLs and entities without executing script lookalikes',()=>{
  assert.deepEqual(iconCandidates('<base href="/assets/"><!-- <link rel="icon" href="bad"> --><script>"<link rel=icon href=bad>"</script><link REL="shortcut icon" href="icon.png?v=2&amp;x=3"><link rel="apple-touch-icon" href="/apple.png">','https://bbc.com/news'),['https://bbc.com/assets/icon.png?v=2&x=3','https://bbc.com/apple.png','https://bbc.com/favicon.ico']);
});
test('discovers a target-site icon with no credentials or private bookmark path sent upstream',async()=>{
  const calls=[];
  const found=await discoverIcon('https://bbc.com/private?token=secret#fragment',network((url,options)=>{
    calls.push(url);assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');assert.equal(options.headers.Cookie,undefined);
    return url.endsWith('/')?new Response('<link rel="icon" href="/latest.png">',{headers:{'Content-Type':'text/html'}}):new Response(png);
  }));
  assert.equal(found.type,'image/png');assert.deepEqual(calls,['https://bbc.com/','https://bbc.com/latest.png']);
});
test('redirect and DNS private targets are rejected before contacting them',async()=>{
  const calls=[];
  await assert.rejects(discoverIcon('https://bbc.com',network(url=>{calls.push(url);return new Response(null,{status:302,headers:{Location:'http://169.254.169.254/latest/meta-data'}});})));assert.equal(calls.length,2);
  let contacted=false;
  await assert.rejects(discoverIcon('https://private.bbc.com',url=>{
    if(url.startsWith('https://cloudflare-dns.com/'))return Response.json({Status:0,Answer:[{type:1,data:'10.0.0.1'}]});
    contacted=true;return new Response(png);
  }));assert.equal(contacted,false);
});
test('untrusted SVG/HTML is rejected and bounded streams cancel oversized images',async()=>{
  await assert.rejects(discoverIcon('https://bbc.com',network(()=>new Response('<svg onload="alert(1)"></svg>',{headers:{'Content-Type':'image/png'}}))));
  let cancelled=false;
  const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(20));},cancel(){cancelled=true;}});
  await assert.rejects(boundedBytes(new Response(stream),16),/too_large/);assert.equal(cancelled,true);
});
test('cache reuses icons; manual refresh replaces stale bytes, isolates accounts and preserves last good icon on failure',async()=>{
  const WALLPAPERS=storage(),env={WALLPAPERS},bookmark={address_id:1,url:'https://bbc.com/news'};let requests=0;
  const request=network(url=>{requests++;return url.endsWith('/')?new Response('',{headers:{'Content-Type':'text/html'}}):new Response(png);});
  assert.equal((await cachedIcon(env,bookmark,false,request)).refreshed,true);
  const count=requests;assert.equal((await cachedIcon(env,bookmark,false,request)).refreshed,false);assert.equal(requests,count);
  const entry=[...WALLPAPERS.entries.values()][0];entry.metadata.attemptedAt-=61;
  assert.equal((await cachedIcon(env,bookmark,true,request)).refreshed,true);assert.ok(requests>count);
  assert.equal((await cachedIcon(env,{...bookmark,address_id:2},false,request)).refreshed,true);assert.equal(WALLPAPERS.entries.size,2);
  [...WALLPAPERS.entries.values()][0].metadata.attemptedAt-=61;
  const failure=await cachedIcon(env,bookmark,true,network(()=>new Response('down',{status:503})));
  assert.equal(failure.unavailable,true);assert.deepEqual(new Uint8Array(failure.value),png);
  const suppressed=await cachedIcon(env,bookmark,true,()=>{throw new Error('must back off');});assert.equal(suppressed.refreshed,false);
});
