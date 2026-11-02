import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { buildSync } from '../worker/node_modules/.pnpm/esbuild@0.27.0/node_modules/esbuild/lib/main.js';
import { sign } from '../worker/node_modules/hono/dist/utils/jwt/jwt.js';
import { Hono } from '../worker/node_modules/hono/dist/index.js';
const output=buildSync({entryPoints:[new URL('../worker/src/web_mail.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],banner:{js:"import { createRequire } from 'node:module'; const nodeRequire = createRequire(import.meta.url); const require = name => name === 'cloudflare:sockets' ? { connect(){ throw new Error('Socket delivery is disabled in isolated tests'); } } : nodeRequire(name);"},bundle:true,platform:'node',format:'esm',write:false,external:['cloudflare:*']}).outputFiles[0].text;
mkdirSync(new URL('../.private',import.meta.url),{recursive:true});writeFileSync(new URL('../.private/web-mail-runtime.mjs',import.meta.url),output);
const {webMailApi}=await import('../.private/web-mail-runtime.mjs');
const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8'));sql.exec(readFileSync(new URL('../db/2026-11-02-public-mail.sql',import.meta.url),'utf8'));
sql.exec("INSERT INTO address(name) VALUES('test@ionacs.com');INSERT INTO address(name) VALUES('other@ionacs.com');INSERT INTO address_sender(address,balance,enabled) VALUES('test@ionacs.com',10,1)");
const db={async batch(statements){sql.exec('BEGIN');try{let results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}},prepare(query){const s=sql.prepare(query);let args=[];return{bind(...v){args=v;return this;},async run(){return{...s.run(...args),success:true}},async first(column){const r=s.get(...args);return column?r?.[column]??null:r||null},async all(){return{results:s.all(...args)}}}}};
const app=new Hono();app.use('*',async(c,next)=>{c.set('jwtPayload',{address:'test@ionacs.com',address_id:1});await next();});app.route('/',webMailApi);
const env={DB:db,JWT_SECRET:'isolated-test-key-only',RESEND_TOKEN:'mock',ATTACHMENT_ORIGIN:'https://storage.invalid',ATTACHMENT_SECRET:'mock'};
const request=(path,options={})=>app.request('https://mail.ionacs.com'+path,options,env);
test('real compose route preserves HTML, Cc/Bcc, uses private attachment capability, and archives only once',async()=>{
 const attachment=crypto.randomUUID();sql.prepare('INSERT INTO mail_attachments(id,address_id,filename,content_type,size,created_at,expires_at,ready) VALUES(?,1,?,?,?,unixepoch(),unixepoch()+86400,1)').run(attachment,'report.txt','text/plain',10);
 const body={send_id:crypto.randomUUID(),to:'one@example.com',cc:'two@example.com',bcc:'hidden@example.com',subject:'Test',content:'<b>Hello</b>',is_html:true,attachments:[attachment]};
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://api.resend.com/emails');const payload=JSON.parse(init.body);assert.deepEqual(payload.bcc,['hidden@example.com']);assert.equal(payload.html,'<b>Hello</b>');assert.ok(payload.attachments[0].path.startsWith('https://mail.ionacs.com/open_api/outgoing_attachment/'));assert.ok(!payload.attachments[0].path.includes('mock'));return Response.json({id:'mock-provider-id'});};
 try{for(let i=0;i<2;i++){const r=await request('/api/send_mail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,await r.text());}assert.equal(calls,1);assert.equal(sql.prepare('SELECT balance FROM address_sender').get().balance,7);assert.equal(sql.prepare('SELECT count(*) n FROM sendbox').get().n,1);}
 finally{globalThis.fetch=original;}
});
test('real routes reject oversized uploads, other mailbox attachments, forged capabilities and total over 25 MB',async()=>{
 const other=crypto.randomUUID();sql.prepare('INSERT INTO mail_attachments(id,address_id,filename,content_type,size,created_at,ready) VALUES(?,2,?,?,?,unixepoch(),1)').run(other,'private.txt','text/plain',1);
 assert.equal((await request('/api/compose/attachments/'+other)).status,404);
 assert.equal((await request('/open_api/outgoing_attachment/'+other+'?token=forged')).status,403);
 assert.equal((await request('/api/compose/attachments',{method:'POST',headers:{'Content-Length':String(26*1024*1024),'x-filename':'large.txt'},body:'x'})).status,400);
 const ids=[crypto.randomUUID(),crypto.randomUUID()];for(const id of ids)sql.prepare('INSERT INTO mail_attachments(id,address_id,filename,content_type,size,created_at,ready) VALUES(?,1,?,?,?,unixepoch(),1)').run(id,'large.txt','text/plain',14*1024*1024);
 const result=await request('/api/send_mail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({send_id:crypto.randomUUID(),to:'one@example.com',subject:'Test',content:'Test',attachments:ids})});assert.equal(result.status,413);
});

const full=buildSync({entryPoints:[new URL('../worker/src/worker.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],banner:{js:"import { createRequire } from 'node:module'; const nodeRequire = createRequire(import.meta.url); const require = name => name === 'cloudflare:sockets' ? { connect(){ throw new Error('Socket delivery is disabled in isolated tests'); } } : nodeRequire(name);"},bundle:true,platform:'node',format:'esm',write:false,external:['cloudflare:*']}).outputFiles[0].text;
writeFileSync(new URL('../.private/full-worker-runtime.mjs',import.meta.url),full);
const {default:worker}=await import('../.private/full-worker-runtime.mjs');
const runtimeEnv={...env,DOMAINS:['ionacs.com'],ENABLE_USER_CREATE_EMAIL:'true',ENABLE_ADDRESS_PASSWORD:'true',ADMIN_PASSWORDS_SECRET:'["isolated-admin"]'};
const runtimeRequest=(path,init={})=>worker.fetch(new Request('https://mail.ionacs.com'+path,init),runtimeEnv,{waitUntil(p){p.catch(()=>{});}});
test('public Worker requires admin/mailbox credentials and keeps service Access isolated',async()=>{
 assert.equal((await runtimeRequest('/open_api/settings')).status,200);
 for(const path of ['/admin/invitations','/admin/overview','/api/mails','/imap_api/authenticate'])assert.equal((await runtimeRequest(path)).status,401,path);
 assert.equal((await runtimeRequest('/admin/invitations',{headers:{'Cf-Access-Authenticated-User-Email':'admin@example.com'}})).status,401);
 assert.equal((await runtimeRequest('/admin/invitations',{headers:{'x-admin-auth':'isolated-admin',Origin:'https://evil.example'}})).status,403);
 const mailbox=await sign({address:'test@ionacs.com',address_id:1,exp:Math.floor(Date.now()/1000)+300},runtimeEnv.JWT_SECRET,'HS256');
 assert.equal((await runtimeRequest('/admin/invitations',{headers:{Authorization:'Bearer '+mailbox}})).status,401);
 const make=await runtimeRequest('/admin/invitations',{method:'POST',headers:{'Content-Type':'application/json','x-admin-auth':'isolated-admin'},body:JSON.stringify({count:1})});assert.equal(make.status,200,await make.text());
 const bad=await runtimeRequest('/api/new_address',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'test2',domain:'ionacs.com',password:'isolated-test-password'})});assert.equal(bad.status,400);
 for(const path of ['/user_api/register','/external/api/send_mail','/telegram/test'])assert.equal((await runtimeRequest(path,{method:'POST',body:'{}'})).status,403);
});
