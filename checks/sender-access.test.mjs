import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { requestSenderAccess, updateSenderAccess, senderState } from '../shared/sender-access.mjs';
import { deleteMailbox } from '../shared/admin-data.mjs';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO address(name) VALUES ('alice@example.com'), ('bob@example.com')");
  const db = { async batch(statements) { sql.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec('COMMIT'); return result; } catch (error) { sql.exec('ROLLBACK'); throw error; } }, prepare(query) {
    const statement = sql.prepare(query); let values = [];
    return { bind(...args) { values = args; return this; }, async first() { return statement.get(...values) || null; }, async run() { statement.run(...values); return { success: true }; } };
  } };
  return { sql, db };
}
test('request is pending and idempotent, with no self-granted quota', async () => {
  const { db, sql } = fixture();
  const first = await requestSenderAccess(db, 'alice@example.com');
  const second = await requestSenderAccess(db, 'alice@example.com');
  assert.equal(senderState(first), 'pending');
  assert.equal(first.balance, 0); assert.equal(first.enabled, 0);
  assert.equal(first.id, second.id); assert.equal(first.requested_at, second.requested_at);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM address_sender').get().n, 1);
  sql.close();
});
test('approval enables sending; repeated requests cannot reset approved quota', async () => {
  const { db, sql } = fixture();
  const request = await requestSenderAccess(db, 'alice@example.com');
  await updateSenderAccess(db, { address: 'alice@example.com', address_id: request.id, balance: 25, enabled: true });
  const row = await requestSenderAccess(db, 'alice@example.com');
  assert.equal(senderState(row), 'approved'); assert.equal(row.balance, 25); assert.equal(row.requested_at, null);
  sql.close();
});
test('exhausted and disabled mailboxes can reapply without gaining send permission', async () => {
  const { db, sql } = fixture();
  for (const enabled of [true, false]) {
    await updateSenderAccess(db, { address: 'alice@example.com', balance: enabled ? 0 : 9, enabled });
    const row = await requestSenderAccess(db, 'alice@example.com');
    assert.equal(senderState(row), 'pending');
    assert.equal(Boolean(row.enabled), enabled); assert.equal(row.balance, enabled ? 0 : 9);
  }
  sql.close();
});
test('admin input rejects negative, fractional, oversized and string balances', async () => {
  const { db, sql } = fixture();
  for (const balance of [-1, 0.5, 100001, '100', null, NaN]) {
    await assert.rejects(() => updateSenderAccess(db, { address: 'alice@example.com', balance, enabled: true }));
  }
  await assert.rejects(() => updateSenderAccess(db, { address: 'alice@example.com', balance: 1, enabled: 'false' }));
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM address_sender').get().n, 0);
  sql.close();
});
test('unknown mailboxes and mismatched record IDs cannot be granted permission', async () => {
  const { db, sql } = fixture();
  const request = await requestSenderAccess(db, 'alice@example.com');
  await assert.rejects(() => requestSenderAccess(db, 'missing@example.com'));
  await assert.rejects(() => updateSenderAccess(db, { address: 'missing@example.com', balance: 10, enabled: true }));
  await assert.rejects(() => updateSenderAccess(db, { address: 'bob@example.com', address_id: request.id, balance: 10, enabled: true }));
  assert.equal(sql.prepare('SELECT enabled FROM address_sender WHERE id = ?').get(request.id).enabled, 0);
  sql.close();
});
test('migration preserves prior quota and adds an empty audit log', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec("CREATE TABLE address_sender(id INTEGER PRIMARY KEY, address TEXT UNIQUE, balance INTEGER, enabled INTEGER, created_at TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT); INSERT INTO address_sender VALUES(1, 'existing@example.com', 42, 1, '2025-01-01'); INSERT INTO settings VALUES('db_version','v0.0.5',null)");
  sql.exec(readFileSync(new URL('../db/2026-10-29-admin-console.sql', import.meta.url), 'utf8'));
  const row = sql.prepare('SELECT * FROM address_sender').get();
  assert.equal(row.balance, 42); assert.equal(row.enabled, 1); assert.equal(row.requested_at, null);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM admin_audit').get().n, 0);
  assert.equal(sql.prepare('SELECT value FROM settings').get().value, 'v0.0.6');
  sql.close();
});
test('mailbox deletion removes dependent records without touching another mailbox', async () => {
  const { sql, db } = fixture();
  for (const address of ['alice@example.com', 'bob@example.com']) {
    for (const table of ['raw_mails', 'sendbox', 'auto_reply_mails', 'address_sender']) sql.prepare('INSERT INTO ' + table + ' (address) VALUES (?)').run(address);
  }
  sql.exec('INSERT INTO users_address(user_id, address_id) VALUES(1,1),(2,2)');
  assert.equal(await deleteMailbox(db, 1), true);
  for (const table of ['raw_mails', 'sendbox', 'auto_reply_mails', 'address_sender']) {
    const rows = sql.prepare('SELECT address FROM ' + table).all();
    assert.equal(rows.length, 1); assert.equal(rows[0].address, 'bob@example.com');
  }
  assert.equal(sql.prepare('SELECT name FROM address').get().name, 'bob@example.com');
  assert.equal(sql.prepare('SELECT address_id FROM users_address').get().address_id, 2);
  assert.equal(await deleteMailbox(db, 1), false);
  await assert.rejects(() => deleteMailbox(db, '-1'));
  sql.close();
});
test('failed mailbox cleanup rolls back the address and already-deleted dependents', async () => {
  const { sql, db } = fixture();
  sql.exec("INSERT INTO raw_mails(address) VALUES('alice@example.com'); INSERT INTO sendbox(address) VALUES('alice@example.com'); CREATE TRIGGER prevent_test_delete BEFORE DELETE ON sendbox BEGIN SELECT RAISE(ABORT, 'Simulated failure'); END;");
  await assert.rejects(() => deleteMailbox(db, 1));
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM address WHERE id=1').get().n, 1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM raw_mails').get().n, 1);
  sql.close();
});
