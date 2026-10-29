import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { hashPassword, hashPasswordDigest, passwordDigest, validatePassword, verifyPassword } from '../shared/passwords.mjs';
import { requestImap, reviewImap, createImapPassword, authenticateImap, validImapSession, mailboxIdentity, imapState, updateImapFlags } from '../shared/imap-access.mjs';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO address(name) VALUES ('alice@example.com'), ('bob@example.com')");
  const db = { async batch(statements) { sql.exec('BEGIN'); try { const result = []; for (const s of statements) result.push(await s.run()); sql.exec('COMMIT'); return result; } catch (e) { sql.exec('ROLLBACK'); throw e; } }, prepare(query) {
    const statement = sql.prepare(query); let values = [];
    return { bind(...args) { values = args; return this; }, async first() { return statement.get(...values) || null; }, async all() { return { results: statement.all(...values) }; }, async run() { const result = statement.run(...values); return { success: true, meta: { changes: result.changes } }; } };
  } };
  return { sql, db };
}

test('bulk flag changes stay within two SQL queries and preserve mailbox isolation', async () => {
  const { db, sql } = fixture();
  for (let i = 1; i <= 100; i++) sql.prepare("INSERT INTO imap_messages(address_id, folder, mail_id, flags) VALUES(1, 'INBOX', ?, ?)").run(i, '["\\\\Answered"]');
  sql.exec("INSERT INTO imap_messages(address_id, folder, mail_id) VALUES(2, 'INBOX', 101)");
  const uids = Array.from({ length: 101 }, (_, i) => i + 1);
  let queries = 0;
  const bounded = { prepare(query) { queries++; return db.prepare(query); } };
  const added = await updateImapFlags(bounded, 1, uids, ['\\Seen'], 1);
  assert.equal(queries, 2); assert.equal(added.results.length, 100);
  for (const row of added.results) assert.deepEqual(new Set(JSON.parse(row.flags)), new Set(['\\Seen', '\\Answered']));
  const removed = await updateImapFlags(db, 1, uids, ['\\Seen'], -1);
  assert.deepEqual(JSON.parse(removed.results[0].flags), ['\\Answered']);
  const replaced = await updateImapFlags(db, 1, uids, ['\\Flagged'], 0);
  assert.deepEqual(JSON.parse(replaced.results[0].flags), ['\\Flagged']);
  assert.equal(sql.prepare('SELECT flags FROM imap_messages WHERE address_id=2').get().flags, '[]');
});
test('passwords use independent salts, enforce length, and support legacy upgrades', async () => {
  const raw = 'long-test-password-2026';
  const a = await hashPassword(raw), b = await hashPassword(raw);
  assert.notEqual(a, b); assert.equal(await verifyPassword(raw, a), true);
  assert.equal(await verifyPassword('wrong-password', a), false);
  assert.equal(await verifyPassword(raw, null), false);
  const legacy = await passwordDigest(raw);
  assert.equal(await verifyPassword(raw, legacy), true);
  assert.equal(await verifyPassword(legacy, a, 'sha256'), true);
  assert.equal(await verifyPassword(raw, await hashPasswordDigest(legacy)), true);
  for (const invalid of ['', 'short', 'x'.repeat(129), null]) assert.throws(() => validatePassword(invalid));
});
test('IMAP request is idempotent and never grants itself access or a client password', async () => {
  const { db } = fixture();
  assert.equal(imapState(await requestImap(db, 1)), 'pending');
  const first = await requestImap(db, 1), second = await requestImap(db, 1);
  assert.equal(first.requested_at, second.requested_at); assert.equal(second.enabled, 0);
  await assert.rejects(() => createImapPassword(db, 1, 'client'));
  assert.equal(await requestImap(db, 999), null);
  await assert.rejects(() => mailboxIdentity(db, { address_id: 1, address: 'bob@example.com' }));
});
test('only approved, correctly scoped client credentials authenticate', async () => {
  const { db, sql } = fixture();
  await reviewImap(db, { address_id: 1, enabled: true });
  assert.equal(imapState(await requestImap(db, 1)), 'approved');
  const credential = await createImapPassword(db, 1, 'Outlook');
  const stored = sql.prepare('SELECT password_hash FROM imap_passwords WHERE id = ?').get(credential.id);
  assert.notEqual(stored.password_hash, credential.password);
  const identity = await authenticateImap(db, 'ALICE@example.com', credential.password);
  assert.equal(identity.address_id, 1);
  assert.equal(await authenticateImap(db, 'bob@example.com', credential.password), null);
  assert.equal(await authenticateImap(db, 'alice@example.com', 'f'.repeat(48)), null);
  assert.equal(await validImapSession(db, { ...identity, scope: 'imap' }), true);
  assert.equal(await validImapSession(db, { ...identity, scope: 'web' }), false);
  assert.equal(await validImapSession(db, { ...identity, scope: 'imap', address_id: 2 }), false);
});
test('revocation invalidates open IMAP sessions and reapproval cannot restore old passwords', async () => {
  const { db } = fixture();
  await reviewImap(db, { address_id: 1, enabled: true });
  const key = await createImapPassword(db, 1, 'Phone');
  const session = { ...await authenticateImap(db, 'alice@example.com', key.password), scope: 'imap' };
  await reviewImap(db, { address_id: 1, enabled: false });
  assert.equal(await validImapSession(db, session), false);
  await requestImap(db, 1);
  assert.equal(await authenticateImap(db, 'alice@example.com', key.password), null);
  await reviewImap(db, { address_id: 1, enabled: true });
  assert.equal(await validImapSession(db, session), false);
});
test('client password count is capped and admin input cannot coerce permission values', async () => {
  const { db } = fixture();
  for (const input of [{ address_id: 1, enabled: 'false' }, { address_id: 0, enabled: true }, { address_id: 999, enabled: true }]) await assert.rejects(() => reviewImap(db, input));
  await reviewImap(db, { address_id: 1, enabled: true });
  for (let n = 0; n < 5; n++) await createImapPassword(db, 1, 'client-' + n);
  await assert.rejects(() => createImapPassword(db, 1, 'sixth'));
});
test('UIDs stay stable across deletes and are never reused when SQLite mail IDs are reused', () => {
  const { sql } = fixture();
  sql.exec("INSERT INTO raw_mails(id,address,raw) VALUES (5,'alice@example.com','first'),(6,'alice@example.com','second')");
  const rows = sql.prepare('SELECT uid,mail_id FROM imap_messages ORDER BY uid').all();
  sql.exec('DELETE FROM raw_mails WHERE id = 6');
  sql.exec("INSERT INTO raw_mails(id,address,raw) VALUES (6,'alice@example.com','new message')");
  const next = sql.prepare('SELECT uid,mail_id FROM imap_messages ORDER BY uid').all();
  assert.equal(next[0].uid, rows[0].uid); assert.ok(next[1].uid > rows[1].uid);
  sql.exec("DELETE FROM address WHERE id = 1");
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM imap_messages').get().n, 0);
});
test('IMAP migration is repeatable and preserves content, permissions and UID assignments', async () => {
  const { sql, db } = fixture();
  await reviewImap(db, { address_id: 1, enabled: true });
  const key = await createImapPassword(db, 1, 'Saved');
  sql.exec("INSERT INTO raw_mails(address,raw) VALUES('alice@example.com','preserved MIME')");
  const before = sql.prepare('SELECT * FROM imap_messages').all();
  sql.exec(readFileSync(new URL('../db/2026-10-29-imap.sql', import.meta.url), 'utf8'));
  assert.deepEqual(sql.prepare('SELECT * FROM imap_messages').all(), before);
  assert.ok(await authenticateImap(db, 'alice@example.com', key.password));
});
