import { NAV_SESSION_SECONDS, createMailTicket, consumeMailTicket, validateMailIdentity } from '../../shared/navigation-sso.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import app, { register, safeURL, challenge } from '../src/worker.mjs';
import { parseWallpapers } from '../src/wallpapers.mjs';
import { hashPassword, passwordDigest, verifyPassword } from '../../shared/passwords.mjs';
let mf,db,env,owner,other,admin;
const ctx={waitUntil(){}};
const origin='https://ionacs.com';
async function identity(email){const password=await hashPassword('Fixture-only-long-password!');await db.prepare('INSERT INTO address(name,password) VALUES(?,?)').bind(email,password).run();const row=await db.prepare('SELECT * FROM address WHERE name=?').bind(email).first();const token=crypto.randomUUID().replaceAll('-','')+'0123456789abcdef';await db.prepare('INSERT INTO nav_sessions VALUES(?,?,?,?)').bind(await passwordDigest(token),row.id,await passwordDigest(password),Math.floor(Date.now()/1000)+3600).run();return {...row,token};}
const req=(path,{method='GET',data,user,headers={}}={})=>new Request(origin+'/api'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(user?{Cookie:'__Host-ionacs_session='+user.token}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
const call=(path,options)=>app.fetch(req(path,options),env,ctx);
before(async()=>{mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});db=await mf.getD1Database('DB');await db.exec('CREATE TABLE address(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,password TEXT,source_meta TEXT);');const schema=await readFile(new URL('../migrations/0001_navigation.sql',import.meta.url),'utf8');await db.prepare(schema).run().catch(async()=>{ // D1 exec expects one statement per line; preserve trigger bodies.
 const statements=schema.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE|$)/).map(s=>s.trim()).filter(Boolean);for(const sql of statements)await db.prepare(sql).run();
});await db.prepare(await readFile(new URL('../migrations/0002_default_bookmarks.sql',import.meta.url),'utf8')).run();await db.prepare(await readFile(new URL('../migrations/0003_mail_sessions.sql',import.meta.url),'utf8')).run();env={DB:db,APP_ORIGIN:origin,ADMIN_EMAIL:'adrian@ionacs.com',AUTH_LIMITER:{limit:async()=>({success:true})},WRITE_LIMITER:{limit:async()=>({success:true})},WALLPAPERS:{getWithMetadata:async()=>({value:null})}};owner=await identity('first@ionacs.com');other=await identity('second@ionacs.com');admin=await identity('adrian@ionacs.com');});
after(async()=>{await mf?.dispose();});
test('guest cannot access private data or wallpaper metadata and image',async()=>{for(const path of ['/bookmarks','/preferences','/wallpapers','/wallpaper/20261102','/admin/invites'])assert.equal((await call(path)).status,401);});
test('rejects foreign origins and executable bookmark URLs',async()=>{assert.equal((await call('/bookmarks',{method:'POST',user:owner,data:{title:'bad',url:'javascript:alert(1)'},headers:{Origin:'https://evil.example'}})).status,403);assert.throws(()=>safeURL('javascript:alert(1)'));assert.throws(()=>safeURL('https://user:pass@example.com'));});
test('bookmark ownership enforced across read, update, delete',async()=>{let res=await call('/bookmarks',{method:'POST',user:owner,data:{title:'Example',url:'https://example.com'}});assert.equal(res.status,201);const{id}=await res.json();assert.ok((await(await call('/bookmarks',{user:other})).json()).bookmarks.every(b=>b.id!==id));assert.equal((await call('/bookmarks/'+id,{method:'PATCH',user:other,data:{title:'stolen',url:'https://example.net'}})).status,404);assert.equal((await call('/bookmarks/'+id,{method:'DELETE',user:other})).status,404);assert.equal((await call('/bookmarks/'+id,{method:'DELETE',user:owner})).status,200);});
test('admin invitation privilege cannot be supplied by request data',async()=>{assert.equal((await call('/admin/invites',{method:'POST',user:owner,data:{admin:true,label:'x',days:7,maxUses:1}})).status,403);assert.equal((await call('/admin/invites',{user:admin})).status,200);});
test('single-use invitation atomically creates one shared mailbox under concurrent registration',async()=>{const created=await call('/admin/invites',{method:'POST',user:admin,data:{label:'test',days:7,maxUses:1}});const{code}=await created.json();const results=await Promise.allSettled(['invited1','invited2'].map(name=>register(env,{email:name+'@ionacs.com',password:'Shared-mail-password-123!',invite:code})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rows=(await db.prepare("SELECT * FROM address WHERE name LIKE 'invited%@ionacs.com'").all()).results;assert.equal(rows.length,1);assert.ok(await verifyPassword('Shared-mail-password-123!',rows[0].password));const usage=await db.prepare('SELECT used FROM nav_invites WHERE code_hash=?').bind(await passwordDigest(code)).first();assert.equal(usage.used,1);});
test('invalid and reserved registrations cannot create mailbox or consume invite',async()=>{await assert.rejects(register(env,{email:'adrian@ionacs.com',password:'123456789012',invite:'invalid'}));await assert.rejects(register(env,{email:'noninvited@ionacs.com',password:'123456789012',invite:'invalid'}));assert.equal(await db.prepare("SELECT id FROM address WHERE name='noninvited@ionacs.com'").first(),null);});
test('password change in shared mailbox invalidates navigation session',async()=>{const account=await identity('changed@ionacs.com');assert.ok((await(await call('/me',{user:account})).json()).user);await db.prepare('UPDATE address SET password=? WHERE id=?').bind(await hashPassword('New-password-value-1234'),account.id).run();assert.equal((await(await call('/me',{user:account})).json()).user,null);});
test('logout revokes server-side session',async()=>{const account=await identity('logout@ionacs.com');const res=await call('/logout',{method:'POST',user:account});assert.match(res.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await(await call('/me',{user:account})).json()).user,null);});
test('Turnstile fails closed without configuration and rejects wrong hostname/action',async()=>{await assert.rejects(challenge(req('/login'),env,'token','login'),/尚未配置/);const original=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({success:true,hostname:'evil.example',action:'login'});await assert.rejects(challenge(req('/login'),{...env,TURNSTILE_SITE_KEY:'site',TURNSTILE_SECRET_KEY:'secret'},'token','login'),/未通过/);globalThis.fetch=async()=>Response.json({success:true,hostname:'ionacs.com',action:'register'});await assert.rejects(challenge(req('/login'),{...env,TURNSTILE_SITE_KEY:'site',TURNSTILE_SECRET_KEY:'secret'},'token','login'),/未通过/);}finally{globalThis.fetch=original;}});
test('upstream parser selects latest seven and rejects untrusted image hosts',()=>{const lines=Array.from({length:9},(_,i)=>`2026-10-${String(20+i).padStart(2,'0')} | [Landscape (© Author)](https://cn.bing.com/th?id=OHR.Land${i}_UHD.jpg&w=3840)`);lines.push('2026-11-01 | [Bad](https://evil.example/th?id=OHR.Bad.jpg)');const parsed=parseWallpapers(lines.join('\n'));assert.equal(parsed.length,7);assert.equal(parsed[0].day,'20261028');assert.ok(parsed.every(i=>i.copyright==='Landscape (© Author)'));});
test('preferences reject script links and persist user-scoped data',async()=>{assert.equal((await call('/preferences',{method:'PUT',user:owner,data:{...{wallpaper_mode:'image',wallpaper_url:'javascript:alert(1)',color:'#ffffff',search_engine:'google'}}})).status,400);assert.equal((await call('/preferences',{method:'PUT',user:owner,data:{wallpaper_mode:'color',wallpaper_url:'',color:'#ffffff',search_engine:'bing'}})).status,200);assert.equal((await(await call('/preferences',{user:other})).json()).preferences,null);});
test('login accepts the existing mailbox password and sets a host-only secure session',async()=>{const original=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({success:true,hostname:'ionacs.com',action:'login'});const authEnv={...env,TURNSTILE_SITE_KEY:'site',TURNSTILE_SECRET_KEY:'secret'};const bad=await app.fetch(req('/login',{method:'POST',data:{email:owner.name,password:'wrong',token:'test'}}),authEnv,ctx);assert.equal(bad.status,401);const res=await app.fetch(req('/login',{method:'POST',data:{email:owner.name,password:'Fixture-only-long-password!',token:'test'}}),authEnv,ctx);assert.equal(res.status,200);assert.match(res.headers.get('set-cookie'),/__Host-ionacs_session=.*; Path=\/; Secure; HttpOnly; SameSite=Lax/);assert.equal((await res.json()).user.email,owner.name);assert.match(res.headers.get('set-cookie'),/Max-Age=34560000/);const restored=await app.fetch(new Request(origin+'/api/me',{headers:{Cookie:res.headers.get('set-cookie').split(';')[0]}}),authEnv,ctx);assert.equal((await restored.json()).user.email,owner.name);}finally{globalThis.fetch=original;}});

test('first login bookmarks match guest defaults exactly once, including concurrent requests and deliberate deletion',async()=>{
 const fresh=await identity('fresh-defaults@ionacs.com');
 const responses=await Promise.all([call('/bookmarks',{user:fresh}),call('/bookmarks',{user:fresh})]);
 const lists=await Promise.all(responses.map(r=>r.json()));
 for(const list of lists)assert.deepEqual(list.bookmarks.map(b=>b.title),['IONACS 邮箱','Google','GitHub','YouTube','Bing']);
 const first=lists[0].bookmarks[0];
 assert.equal((await call('/bookmarks/'+first.id,{method:'PATCH',user:fresh,data:{title:'我的邮箱',url:'https://mail.ionacs.com'}})).status,200);
 assert.equal((await(await call('/bookmarks',{user:fresh})).json()).bookmarks[0].title,'我的邮箱');
 for(const b of lists[0].bookmarks)await call('/bookmarks/'+b.id,{method:'DELETE',user:fresh});
 assert.equal((await(await call('/bookmarks',{user:fresh})).json()).bookmarks.length,0);
});
test('existing personalized bookmarks are preserved during initialization',async()=>{
 const existing=await identity('existing-bookmarks@ionacs.com');
 await call('/bookmarks',{method:'POST',user:existing,data:{title:'个人网站',url:'https://example.com'}});
 const list=(await(await call('/bookmarks',{user:existing})).json()).bookmarks;
 assert.equal(list.length,1);assert.equal(list[0].title,'个人网站');
});

test('navigation sessions renew on use and survive browser restoration',async()=>{
 const account=await identity('persistent@ionacs.com');
 const result=await call('/me',{user:account});assert.equal((await result.json()).user.email,account.name);
 assert.match(result.headers.get('set-cookie'),/Max-Age=34560000/);
 const stored=await db.prepare('SELECT expires_at FROM nav_sessions WHERE token_hash=?').bind(await passwordDigest(account.token)).first();
 assert.ok(stored.expires_at>=Math.floor(Date.now()/1000)+NAV_SESSION_SECONDS-2);
 const again=await call('/me',{user:account});assert.equal((await again.json()).user.email,account.name);assert.equal(again.headers.get('set-cookie'),null);
});
test('mail handoffs are single-use under concurrency, time-limited, and bound to the navigation identity',async()=>{
 const account=await identity('handoff@ionacs.com');const token=await createMailTicket(db,account.token,8);
 const results=await Promise.allSettled([consumeMailTicket(db,token),consumeMailTicket(db,token)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const claims=results.find(r=>r.status==='fulfilled').value;
 assert.equal(claims.address,account.name);assert.equal(claims.exp-claims.iat,8*3600);
 assert.equal((await validateMailIdentity(db,claims)).name,account.name);
 assert.equal(await validateMailIdentity(db,{...claims,exp:1}),null);
 await db.prepare('UPDATE address SET password=? WHERE id=?').bind(await hashPassword('A-new-mail-password-2026'),account.id).run();
 assert.equal(await validateMailIdentity(db,claims),null);
});
test('expired tickets and signed-out navigation sessions cannot grant mailbox access',async()=>{
 const account=await identity('expired-handoff@ionacs.com');const ticket=await createMailTicket(db,account.token,1);
 await db.prepare('UPDATE nav_mail_tickets SET expires_at=1 WHERE token_hash=?').bind(await passwordDigest(ticket)).run();
 await assert.rejects(consumeMailTicket(db,ticket));
 const fresh=await createMailTicket(db,account.token,24);await call('/logout',{method:'POST',user:account});await assert.rejects(consumeMailTicket(db,fresh));
 await assert.rejects(createMailTicket(db,account.token,10000));
});

test('bookmark icon endpoints require ownership and same-origin refresh; cached images stay private',async()=>{
 const created=await(await call('/bookmarks',{method:'POST',user:owner,data:{title:'Icon test',url:'https://bbc.com'}})).json();
 const path='/bookmarks/'+created.id+'/icon';
 assert.equal((await call(path)).status,401);
 assert.equal((await call(path,{user:other})).status,404);
 assert.equal((await call(path,{method:'POST',user:owner,headers:{Origin:'https://evil.example'}})).status,403);
 const old=env.WALLPAPERS;env.ICON_LIMITER={limit:async()=>({success:true})};
 env.WALLPAPERS={getWithMetadata:async()=>({value:new Uint8Array([137,80,78,71]),metadata:{type:'image/png',checkedAt:Math.floor(Date.now()/1000),attemptedAt:Math.floor(Date.now()/1000)}})};
 try{const res=await call(path,{user:owner});assert.equal(res.status,200);assert.equal(res.headers.get('Content-Type'),'image/png');assert.match(res.headers.get('Cache-Control'),/private, no-store/);
 assert.equal((await call(path,{method:'POST',user:owner})).status,200);
 env.ICON_LIMITER={limit:async()=>({success:false})};assert.equal((await call(path,{user:owner})).status,429);
 }finally{env.WALLPAPERS=old;}
});
