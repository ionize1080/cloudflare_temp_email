import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { reserveSubmission, finishSubmission, failSubmission } from '../shared/smtp-access.mjs';
import { prepareSubmission, submitPrepared } from '../worker/src/smtp_submission.mjs';

const identity = { address_id: 1, address: 'alice@example.com', app_id: 'client' };
function fixture(balance = 5) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO address(name) VALUES('alice@example.com'); INSERT INTO imap_access(address_id,enabled) VALUES(1,1);
    INSERT INTO imap_passwords(id,address_id,label,password_hash) VALUES('client',1,'test','hash');
    INSERT INTO address_sender(address,balance,enabled) VALUES('alice@example.com',${balance},1)`);
  const db = { async batch(statements) { sql.exec('BEGIN'); try { for (const s of statements) await s.run(); sql.exec('COMMIT'); } catch(e) { sql.exec('ROLLBACK'); throw e; } }, prepare(query) {
    const statement = sql.prepare(query); let values=[];
    return { bind(...args) { values=args; return this; }, async first() { return statement.get(...values)||null; }, async run() { return statement.run(...values); } };
  }};
  return { db, sql, balance: () => sql.prepare('SELECT balance FROM address_sender').get().balance };
}
const input = (extra = '') => ({ from: identity.address, recipients: ['bob@example.net','hidden@example.net'], raw: Buffer.from(`From: Alice <alice@example.com>\r\nTo: bob@example.net\r\nBcc: hidden@example.net\r\nSubject: test\r\nMessage-ID: <test@example.com>\r\n${extra}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="file.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--b--\r\n`).toString('base64') });

test('SMTP MIME conversion preserves attachments and keeps Bcc out of visible recipients', async () => {
  const p = await prepareSubmission(identity,input());
  assert.deepEqual(p.payload.to,['bob@example.net']); assert.deepEqual(p.payload.bcc,['hidden@example.net']);
  assert.equal(p.payload.attachments[0].content,'AAECAw=='); assert.match(p.payload.text,/Hello/);
  assert.equal(p.archive.mime_base64,input().raw); assert.equal(p.cost,2);
  assert.equal((await prepareSubmission(identity,input())).id,p.id);
});
test('SMTP rejects spoofed headers/envelopes, blocked recipients and oversized mail', async () => {
  await assert.rejects(()=>prepareSubmission(identity,{...input(),from:'other@example.com'}));
  await assert.rejects(()=>prepareSubmission(identity,input('From: other@example.com\r\n')));
  await assert.rejects(()=>prepareSubmission(identity,input(),['example.net']));
  await assert.rejects(()=>prepareSubmission(identity,{...input(),raw:Buffer.alloc(1048577).toString('base64')}));
});
test('SMTP accepts encoded and folded display names while diagnosing sender headers separately', async () => {
  const message = headers => ({ from: identity.address, recipients: ['bob@example.net'],
    raw: Buffer.from(headers + '\r\nTo: bob@example.net\r\nSubject: test\r\n\r\nTest').toString('base64') });
  const from = 'From: =?UTF-8?B?5rWL6K+V?=\r\n <ALICE@example.com>';
  const p = await prepareSubmission(identity, message(from + '\r\nSender: Alice <alice@example.com>'));
  assert.match(p.payload.from, /alice@example.com/);
  for (const [headers, reason] of [
    ['Subject: missing sender', /Exactly one From/],
    [from + '\r\nFrom: alice@example.com', /Exactly one From/],
    ['From: alice@example.com, other@example.net', /contain one mailbox/],
    ['From: other@example.net', /From address/],
    [from + '\r\nResent-From: alice@example.com', /Resent headers/],
  ]) await assert.rejects(() => prepareSubmission(identity, message(headers)), reason);
});
test('SMTP replaces client Sender metadata without allowing it to authorize a different From', async () => {
  const source=input('Sender: client-agent@example.org\r\nSender: second-agent@example.org\r\nReturn-Path: <client-agent@example.org>\r\n');
  const prepared=await prepareSubmission(identity,source);
  assert.equal(prepared.payload.from,'"Alice" <alice@example.com>');
  assert.deepEqual(prepared.payload.headers,{});
  assert.equal(prepared.payload.sender,undefined);
  assert.ok(!JSON.stringify(prepared.payload).includes('client-agent@example.org'));
  const f=fixture(); let calls=0;
  await submitPrepared(f.db,identity,prepared,'test-key',async (_url,opts)=>{
    calls++; const payload=JSON.parse(opts.body);
    assert.equal(payload.from,'"Alice" <alice@example.com>');
    assert.ok(!JSON.stringify(payload).includes('agent@example.org'));
    return Response.json({id:'normalized-sender'});
  });
  assert.equal(calls,1); assert.equal(f.balance(),3);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM sendbox').get().n,1);
  const spoof={...source,raw:Buffer.from(Buffer.from(source.raw,'base64').toString().replace('From: Alice <alice@example.com>','From: Other <other@example.org>')).toString('base64')};
  await assert.rejects(()=>prepareSubmission(identity,spoof),/From address/);
});
test('SMTP reserves quota once, retries uncertainty without recharging and archives only once', async () => {
  const f=fixture(); const first=await reserveSubmission(f.db,identity,'key',2,1000);
  assert.equal(f.balance(),3); await assert.rejects(()=>reserveSubmission(f.db,identity,'key',2,1001));
  await failSubmission(f.db,first.row,false); assert.equal(f.balance(),3);
  const retry=await reserveSubmission(f.db,identity,'key',2,1002); assert.equal(f.balance(),3);
  await finishSubmission(f.db,retry.row,identity.address,'provider-id',{version:'smtp-v1'});
  await finishSubmission(f.db,retry.row,identity.address,'provider-id',{version:'smtp-v1'});
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM sendbox').get().n,1);
  assert.equal((await reserveSubmission(f.db,identity,'key',2,1003)).duplicate,true);
  assert.equal(f.balance(),3);
});
test('SMTP denies insufficient quota and revoked privileges, and refunds definitive failure once', async () => {
  const f=fixture(1); await assert.rejects(()=>reserveSubmission(f.db,identity,'key',2)); assert.equal(f.balance(),1);
  const first=await reserveSubmission(f.db,identity,'key',1); assert.equal(f.balance(),0);
  await failSubmission(f.db,first.row,true); await failSubmission(f.db,first.row,true); assert.equal(f.balance(),1);
  f.sql.exec('UPDATE address_sender SET enabled=0'); await assert.rejects(()=>reserveSubmission(f.db,identity,'new',1));
  f.sql.exec('UPDATE address_sender SET enabled=1; DELETE FROM imap_passwords'); await assert.rejects(()=>reserveSubmission(f.db,identity,'new',1));
});
test('SMTP uncertain submissions never replay beyond the provider idempotency window', async () => {
  const f=fixture(); const r=await reserveSubmission(f.db,identity,'key',1,1000); await failSubmission(f.db,r.row,false);
  await assert.rejects(()=>reserveSubmission(f.db,identity,'key',1,1000+23*3600)); assert.equal(f.balance(),4);
});
test('SMTP provider calls are idempotent, permission-gated, and known failures refund quota', async () => {
  const f=fixture(); const prepared=await prepareSubmission(identity,input()); let count=0;
  const provider=async (url,opts)=>{ count++; assert.equal(url,'https://api.resend.com/emails'); assert.match(opts.headers['Idempotency-Key'],/^smtp\//); return Response.json({id:'provider-id'}); };
  await submitPrepared(f.db,identity,prepared,'test-key',provider); await submitPrepared(f.db,identity,prepared,'test-key',provider);
  assert.equal(count,1); assert.equal(f.balance(),3);
  const g=fixture(); await assert.rejects(()=>submitPrepared(g.db,identity,prepared,'test-key',async()=>new Response('',{status:422}))); assert.equal(g.balance(),5);
  const h=fixture(0); await assert.rejects(()=>submitPrepared(h.db,identity,prepared,'test-key',provider)); assert.equal(count,1);
});
