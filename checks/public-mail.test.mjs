import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createInvitations,registerInvitedAddress,invitationHash } from '../shared/invitations.mjs';
import { validateCompose,validateAttachment,MAX_ATTACHMENTS } from '../shared/compose.mjs';
import { reserveWeb,failWeb,finishWeb } from '../shared/web-submissions.mjs';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8'));
 sql.exec(readFileSync(new URL('../db/2026-11-02-public-mail.sql',import.meta.url),'utf8'));
 const db={async batch(statements){sql.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}},prepare(query){const s=sql.prepare(query);let args=[];return{bind(...v){args=v;return this;},async run(){return s.run(...args)},async first(){return s.get(...args)||null}}}};
 return{db,sql};
}
test('invitations generate 1–100 strong one-use codes and store hashes only',async()=>{
 const f=fixture();for(const n of [0,-1,101,1.5,'10',null])await assert.rejects(()=>createInvitations(f.db,n,'admin'));
 const codes=await createInvitations(f.db,100,'admin');assert.equal(new Set(codes.map(x=>x.code)).size,100);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM invitations').get().n,100);
 assert.ok(codes.every(x=>/^[a-f0-9]{32}$/.test(x.code)));
 assert.ok(!JSON.stringify(f.sql.prepare('SELECT * FROM invitations').all()).includes(codes[0].code));
 await registerInvitedAddress(f.db,codes[0].code,'alice@example.com','test','hash');
 await assert.rejects(()=>registerInvitedAddress(f.db,codes[0].code,'bob@example.com','test','hash'));
 assert.equal(f.sql.prepare('SELECT count(*) n FROM address').get().n,1);
});
test('failed registration rolls back code consumption; expired, revoked and malformed codes fail',async()=>{
 const f=fixture(),codes=await createInvitations(f.db,3,'admin');
 f.sql.exec("INSERT INTO address(name) VALUES('taken@example.com')");
 await assert.rejects(()=>registerInvitedAddress(f.db,codes[0].code,'taken@example.com','test','hash'));
 assert.equal(f.sql.prepare('SELECT used_at FROM invitations WHERE id=?').get(codes[0].id).used_at,null);
 await registerInvitedAddress(f.db,codes[0].code,'free@example.com','test','hash');
 f.sql.prepare('UPDATE invitations SET expires_at=1 WHERE id=?').run(codes[1].id);
 f.sql.prepare('UPDATE invitations SET revoked_at=1 WHERE id=?').run(codes[2].id);
 for(const code of [codes[1].code,codes[2].code,'bad','f'.repeat(32)])await assert.rejects(()=>registerInvitedAddress(f.db,code,'bad@example.com','test','hash'));
 await assert.rejects(()=>invitationHash({code:'bad'}));
});
test('compose enforces recipient limits, header safety, attachment sizes and executable block',()=>{
 const base={to:'a@example.com',subject:'Hello',content:'Hello',attachments:[]};
 const r=validateCompose({...base,cc:'a@example.com,b@example.com',bcc:'b@example.com,c@example.com'});
 assert.deepEqual(r.cc,['b@example.com']);assert.deepEqual(r.bcc,['c@example.com']);assert.equal(r.all.length,3);
 for(const patch of [{to:'bad'},{to:Array.from({length:21},(_,i)=>`${i}@example.com`)},{subject:'bad\r\nBcc:x@y.com'},{attachments:['https://evil/']},{content:'x'.repeat(100001)}])assert.throws(()=>validateCompose({...base,...patch}));
 validateAttachment('report.pdf',MAX_ATTACHMENTS);
 for(const [name,size] of [['x.exe',1],['../a',1],['a\r\n.txt',1],['a',0],['a',MAX_ATTACHMENTS+1]])assert.throws(()=>validateAttachment(name,size));
});
test('web quota is atomic, concurrent retries cannot double charge, failed delivery refunds once',async()=>{
 const f=fixture();f.sql.exec("INSERT INTO address(name) VALUES('a@example.com');INSERT INTO address_sender(address,enabled,balance) VALUES('a@example.com',1,2)");
 const identity={address:'a@example.com',address_id:1},id=crypto.randomUUID();
 const reservation=await reserveWeb(f.db,identity,id,'digest',2,1000);
 assert.equal(f.sql.prepare('SELECT balance FROM address_sender').get().balance,0);
 await assert.rejects(()=>reserveWeb(f.db,identity,id,'digest',2,1001));
 await assert.rejects(()=>reserveWeb(f.db,identity,crypto.randomUUID(),'digest2',1,1001));
 await failWeb(f.db,reservation.row,true);await failWeb(f.db,reservation.row,true);
 assert.equal(f.sql.prepare('SELECT balance FROM address_sender').get().balance,2);
});
test('uncertain delivery reuses the same reservation and archives exactly once',async()=>{
 const f=fixture();f.sql.exec("INSERT INTO address(name) VALUES('a@example.com');INSERT INTO address_sender(address,enabled,balance) VALUES('a@example.com',1,2)");
 const identity={address:'a@example.com',address_id:1},id=crypto.randomUUID();
 const first=await reserveWeb(f.db,identity,id,'digest',1,1000);await failWeb(f.db,first.row,false);
 const retry=await reserveWeb(f.db,identity,id,'digest',1,1002);assert.equal(first.row.id,retry.row.id);
 await finishWeb(f.db,retry.row,identity.address,'provider',{content:'Hello'},[]);
 await finishWeb(f.db,retry.row,identity.address,'provider',{content:'Hello'},[]);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sendbox').get().n,1);
 assert.equal((await reserveWeb(f.db,identity,id,'digest',1,1003)).duplicate,true);
 assert.equal(f.sql.prepare('SELECT balance FROM address_sender').get().balance,1);
});
