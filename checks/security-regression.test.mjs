import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {buildSync} from '../worker/node_modules/.pnpm/esbuild@0.27.0/node_modules/esbuild/lib/main.js';
import {sign} from '../worker/node_modules/hono/dist/utils/jwt/jwt.js';
import {hashPassword,passwordDigest} from '../shared/passwords.mjs';
import {sessionClaims,validSession,storeChallenge,consumeChallenge,validChallenge} from '../shared/sessions.mjs';
import {verifyTurnstile} from '../shared/turnstile.mjs';
import {publicHttpsUrl,webhookRequest} from '../shared/outbound-url.mjs';

const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8'));
const db={async batch(statements){sql.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}},prepare(query){const s=sql.prepare(query);let args=[];return {bind(...v){args=v;return this;},async run(){return {...s.run(...args),success:true};},async first(column){const row=s.get(...args);return column?row?.[column]??null:row||null;},async all(){return {results:s.all(...args)};}};}};
sql.prepare('INSERT INTO address(id,name,password) VALUES(1,?,?)').run('owner@ionacs.com',await hashPassword('original-secure-password'));
sql.prepare('INSERT INTO address(id,name,password) VALUES(2,?,?)').run('other@ionacs.com',await hashPassword('other-secure-password'));
sql.prepare('INSERT INTO users(id,user_email,password) VALUES(10,?,?)').run('user@example.com',await passwordDigest('user-secure-password'));
const output=buildSync({entryPoints:[new URL('../worker/src/worker.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],banner:{js:"import { createRequire } from 'node:module'; const nodeRequire=createRequire(import.meta.url); const require=name=>name==='cloudflare:sockets'?{connect(){throw new Error('No network sockets in security tests');}}:nodeRequire(name);"},bundle:true,platform:'node',format:'esm',write:false,external:['cloudflare:*']}).outputFiles[0].text;
mkdirSync(new URL('../.private',import.meta.url),{recursive:true});writeFileSync(new URL('../.private/security-worker.mjs',import.meta.url),output.replace('name: err.name, path:', 'name: err.name, diagnostic: err.message, path:'));
const {default:worker}=await import('../.private/security-worker.mjs');
const env={DB:db,JWT_SECRET:'isolated-security-secret',DOMAINS:['ionacs.com'],ENABLE_ADDRESS_PASSWORD:'true',ADMIN_PASSWORDS_SECRET:'["isolated-admin-password"]'};
const run=(path,init={},bindings=env)=>worker.fetch(new Request('https://mail.ionacs.com'+path,init),bindings,{waitUntil(p){p.catch(()=>{});}});
const post=(path,body,headers={},bindings=env)=>run(path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)},bindings);
const bearer=token=>({Authorization:'Bearer '+token});
let currentMailbox,userSession;

test('password changes require current password and revoke old sessions immediately',async()=>{
 const login=await post('/api/address_login',{email:'owner@ionacs.com',password:'original-secure-password',password_format:'plain'});assert.equal(login.status,200);const old=(await login.json()).jwt;
 assert.equal((await post('/api/address_change_password',{new_password:'replacement-secure-password'},bearer(old))).status,403);
 const changed=await post('/api/address_change_password',{current_password:'original-secure-password',new_password:'replacement-secure-password'},bearer(old));assert.equal(changed.status,200);currentMailbox=(await changed.json()).jwt;
 assert.equal((await run('/api/settings',{headers:bearer(old)})).status,401);
 assert.equal((await run('/api/settings',{headers:bearer(currentMailbox)})).status,200);
 const expired=await sign({address:'owner@ionacs.com',address_id:1},env.JWT_SECRET,'HS256');assert.equal((await run('/api/settings',{headers:bearer(expired)})).status,401);
});
test('user passwords are upgraded, binding does not expose hashes, stale mailbox tokens cannot bind',async()=>{
 const result=await post('/user_api/login',{email:'user@example.com',password:await passwordDigest('user-secure-password')});assert.equal(result.status,200);userSession=(await result.json()).jwt;
 assert.ok(sql.prepare('SELECT password FROM users WHERE id=10').get().password.startsWith('pbkdf2-'));
 const stale=await sign({address:'owner@ionacs.com',address_id:1,exp:Math.floor(Date.now()/1000)+300},env.JWT_SECRET,'HS256');
 assert.equal((await post('/user_api/bind_address',{}, {...bearer(stale),'x-user-token':userSession})).status,401);
 assert.equal((await post('/user_api/bind_address',{}, {...bearer(currentMailbox),'x-user-token':userSession})).status,200);
 const list=await run('/user_api/bind_address',{headers:{'x-user-token':userSession}});const rows=(await list.json()).results;assert.equal(rows.length,1);assert.equal(rows[0].password,undefined);
 const credential=await run('/user_api/bind_address_jwt/1',{headers:{'x-user-token':userSession}});const token=(await credential.json()).jwt;assert.equal((await run('/api/settings',{headers:bearer(token)})).status,200);
 await post('/user_api/unbind_address',{address_id:1},{'x-user-token':userSession});assert.equal((await run('/api/settings',{headers:bearer(token)})).status,401);
});
test('one-use challenges reject reuse, expiry and crossing purposes or users',async()=>{
 await storeChallenge(db,'random-nonce','passkey-register',10);
 assert.equal(await validChallenge(db,'random-nonce','passkey-auth',10),false);
 assert.equal(await validChallenge(db,'random-nonce','passkey-register',11),false);
 assert.equal(await consumeChallenge(db,'random-nonce','passkey-register',10),true);
 assert.equal(await consumeChallenge(db,'random-nonce','passkey-register',10),false);
 await storeChallenge(db,'expired','oauth','client');sql.prepare('UPDATE auth_challenges SET expires_at=0 WHERE nonce=?').run('expired');assert.equal(await consumeChallenge(db,'expired','oauth','client'),false);
});
test('Turnstile fails closed for missing/replayed tokens, wrong hostname/action, network and configuration errors',async()=>{
 const configured={CF_TURNSTILE_SITE_KEY:'configured',CF_TURNSTILE_SECRET_KEY:'test-secret',TURNSTILE_REQUIRED:'true'};
 for(const result of [{success:false,'error-codes':['timeout-or-duplicate']},{success:true,hostname:'evil.example',action:'mailbox_login'},{success:true,hostname:'mail.ionacs.com',action:'signup'}])assert.equal(await verifyTurnstile(configured,'token','mailbox_login','',async()=>Response.json(result)),false);
 assert.equal(await verifyTurnstile(configured,'','mailbox_login',''),false);
 assert.equal(await verifyTurnstile({TURNSTILE_REQUIRED:'true'},'token','mailbox_login',''),false);
 assert.equal(await verifyTurnstile(configured,'token','mailbox_login','',async()=>{throw new Error('network');}),false);
 assert.equal(await verifyTurnstile(configured,'token','mailbox_login','',async()=>Response.json({success:true,hostname:'mail.ionacs.com',action:'mailbox_login'})),true);
});
test('all login routes require server-side Turnstile; raw admin password cannot bypass it',async()=>{
 const protectedEnv={...env,CF_TURNSTILE_SITE_KEY:'configured',CF_TURNSTILE_SECRET_KEY:'test-secret',TURNSTILE_REQUIRED:'true'};
 for(const [path,body] of [['/api/address_login',{email:'owner@ionacs.com',password:'replacement-secure-password',password_format:'plain'}],['/user_api/login',{email:'user@example.com',password:await passwordDigest('user-secure-password')}],['/user_api/passkey/authenticate_request',{}],['/open_api/admin_login',{password:'isolated-admin-password'}],['/open_api/credential_login',{credential:currentMailbox}]])assert.equal((await post(path,body,{},protectedEnv)).status,403,path);
 assert.equal((await run('/admin/overview',{headers:{'x-admin-auth':'isolated-admin-password'}},protectedEnv)).status,401);
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({success:true,hostname:'mail.ionacs.com',action:'admin_login'});
 try {const res=await post('/open_api/admin_login',{password:'isolated-admin-password',cf_token:'fresh-token'}, {}, protectedEnv);assert.equal(res.status,200);const {token}=await res.json();assert.equal((await run('/admin/invitations',{headers:{'x-admin-auth':token}},protectedEnv)).status,200);assert.equal((await run('/api/settings',{headers:bearer(token)},protectedEnv)).status,401);}
 finally{globalThis.fetch=original;}
});
test('deleted user sessions cannot be reused when SQLite reuses a user ID',async()=>{
 const payload=await sessionClaims(db,'user',10,'user@example.com');assert.equal(await validSession(db,payload,'user'),true);
 sql.prepare('DELETE FROM users WHERE id=10').run();sql.prepare("INSERT INTO users(id,user_email,password) VALUES(10,'user@example.com','new')").run();assert.equal(await validSession(db,payload,'user'),false);
});
test('webhook validation blocks local addresses, alternate ports and unsafe headers',()=>{
 for(const url of ['http://example.com','https://127.0.0.1','https://2130706433','https://[::1]','https://metadata.google.internal','https://example.com:8091','https://u:p@example.com','https://host.local'])assert.throws(()=>publicHttpsUrl(url));
 assert.equal(publicHttpsUrl('https://hooks.example.com/path'),'https://hooks.example.com/path');
 assert.throws(()=>webhookRequest({url:'https://hooks.example.com',method:'POST',body:'{}',headers:'{"Host":"127.0.0.1"}'}));
});

test('real P-256 passkey registration and authentication reject replay and wrong origins',async()=>{
 const b64=b=>Buffer.from(b).toString('base64url');
 const head=(major,n)=>n<24?Buffer.from([major*32+n]):n<256?Buffer.from([major*32+24,n]):Buffer.from([major*32+25,n>>8,n&255]);
 const cbor=value=>{
  if(typeof value==='number')return value>=0?head(0,value):head(1,-1-value);
  if(typeof value==='string'){const b=Buffer.from(value);return Buffer.concat([head(3,b.length),b]);}
  if(value instanceof Uint8Array)return Buffer.concat([head(2,value.length),value]);
  const entries=[...value];return Buffer.concat([head(5,entries.length),...entries.flatMap(([k,v])=>[cbor(k),cbor(v)])]);
 };
 const sha=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',value));
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);
 const id=crypto.getRandomValues(new Uint8Array(32)),rp=await sha(Buffer.from('mail.ionacs.com'));
 const publicKey=cbor(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]]));
 const userJwt=await sign(await sessionClaims(db,'user',10,'user@example.com'),env.JWT_SECRET,'HS256');
 const options=await (await post('/user_api/passkey/register_request',{}, {'x-user-token':userJwt})).json();
 const registration={id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{},response:{transports:['internal'],clientDataJSON:b64(JSON.stringify({type:'webauthn.create',challenge:options.challenge,origin:'https://mail.ionacs.com'})),attestationObject:b64(cbor(new Map([['fmt','none'],['attStmt',new Map()],['authData',Buffer.concat([rp,Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,id.length]),id,publicKey])]])))}};
 const registered=await post('/user_api/passkey/register_response',{credential:registration,passkey_name:'Synthetic authenticator'},{'x-user-token':userJwt});assert.equal(registered.status,200,await registered.text());
 assert.notEqual((await post('/user_api/passkey/register_response',{credential:registration,passkey_name:'Replay'},{'x-user-token':userJwt})).status,200);
 const auth=await (await post('/user_api/passkey/authenticate_request',{})).json();
 async function assertion(origin){
  const data=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:auth.challenge,origin})),authData=Buffer.concat([rp,Buffer.from([5,0,0,0,0])]);
  const signature=Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,Buffer.concat([authData,await sha(data)])));
  const integer=b=>{while(b.length>1&&b[0]===0)b=b.subarray(1);if(b[0]&128)b=Buffer.concat([Buffer.from([0]),b]);return Buffer.concat([Buffer.from([2,b.length]),b]);};
  const der=Buffer.concat([integer(signature.subarray(0,32)),integer(signature.subarray(32))]);
  return {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:b64(data),authenticatorData:b64(authData),signature:b64(Buffer.concat([Buffer.from([0x30,der.length]),der])),userHandle:b64('10')}};
 }
 assert.notEqual((await post('/user_api/passkey/authenticate_response',{credential:await assertion('https://evil.example')})).status,200);
 const credential=await assertion('https://mail.ionacs.com');
 const accepted=await post('/user_api/passkey/authenticate_response',{credential});assert.equal(accepted.status,200,await accepted.clone().text());
 assert.ok((await accepted.json()).jwt);
 assert.notEqual((await post('/user_api/passkey/authenticate_response',{credential})).status,200);
});
