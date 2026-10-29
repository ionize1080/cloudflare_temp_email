import { passwordDigest, randomAppPassword } from './passwords.mjs';
import { equalSecret } from './security.mjs';

export class ImapAccessError extends Error {}
export const imapState = row => row?.enabled ? 'approved' : row?.requested_at ? 'pending' : row ? 'disabled' : 'not_requested';
export async function mailboxIdentity(db, payload) {
  if (!payload || !Number.isSafeInteger(Number(payload.address_id))) throw new ImapAccessError('邮箱凭据已失效');
  const row = await db.prepare('SELECT id, name FROM address WHERE id = ? AND name = ?').bind(Number(payload.address_id), payload.address).first();
  if (!row) throw new ImapAccessError('邮箱凭据已失效');
  return row;
}
export async function requestImap(db, addressId) {
  await db.prepare(`INSERT INTO imap_access(address_id, requested_at) SELECT id, datetime('now') FROM address WHERE id = ?
    ON CONFLICT(address_id) DO UPDATE SET requested_at = COALESCE(imap_access.requested_at, excluded.requested_at) WHERE imap_access.enabled = 0`).bind(addressId).run();
  return db.prepare('SELECT * FROM imap_access WHERE address_id = ?').bind(addressId).first();
}
export async function reviewImap(db, input) {
  if (!input || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.address_id) || input.address_id <= 0) throw new ImapAccessError('无效的邮箱或权限值');
  const mailbox = await db.prepare('SELECT id, name FROM address WHERE id = ?').bind(input.address_id).first();
  if (!mailbox) throw new ImapAccessError('邮箱不存在');
  const statements = [db.prepare(`INSERT INTO imap_access(address_id, enabled, reviewed_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(address_id) DO UPDATE SET enabled = excluded.enabled, requested_at = NULL, reviewed_at = excluded.reviewed_at`).bind(mailbox.id, input.enabled ? 1 : 0)];
  if (!input.enabled) statements.push(db.prepare('DELETE FROM imap_passwords WHERE address_id = ?').bind(mailbox.id));
  await db.batch(statements);
  return mailbox;
}
export async function createImapPassword(db, addressId, label) {
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 50) throw new ImapAccessError('请输入 1–50 个字符的客户端名称');
  const id = crypto.randomUUID(), password = randomAppPassword();
  const hash = await passwordDigest(password);
  await db.prepare(`INSERT INTO imap_passwords(id, address_id, label, password_hash)
    SELECT ?, address_id, ?, ? FROM imap_access WHERE address_id = ? AND enabled = 1
    AND (SELECT COUNT(*) FROM imap_passwords WHERE address_id = ?) < 5`).bind(id, label.trim(), hash, addressId, addressId).run();
  const created = await db.prepare('SELECT id FROM imap_passwords WHERE id = ?').bind(id).first();
  if (!created) throw new ImapAccessError('需要管理员开通 IMAP，且每个邮箱最多保存 5 个客户端密码');
  return { id, password };
}
export async function authenticateImap(db, username, password) {
  if (typeof username !== 'string' || username.length > 254 || typeof password !== 'string' || !/^[a-f0-9]{48}$/.test(password)) return null;
  const hash = await passwordDigest(password);
  const rows = await db.prepare(`SELECT p.id AS app_id, a.id AS address_id, a.name AS address, p.password_hash
    FROM imap_passwords p JOIN address a ON a.id = p.address_id JOIN imap_access i ON i.address_id = a.id
    WHERE a.name = ? AND i.enabled = 1`).bind(username.trim().toLowerCase()).all();
  for (const row of rows.results || []) {
    if (await equalSecret(hash, row.password_hash)) {
      await db.prepare("UPDATE imap_passwords SET last_used_at = datetime('now') WHERE id = ?").bind(row.app_id).run();
      return { app_id: row.app_id, address_id: row.address_id, address: row.address };
    }
  }
  return null;
}
export async function validImapSession(db, session) {
  if (session?.scope !== 'imap' || typeof session.app_id !== 'string' || !Number.isSafeInteger(session.address_id)) return false;
  return Boolean(await db.prepare(`SELECT p.id FROM imap_passwords p JOIN imap_access i ON i.address_id = p.address_id
    JOIN address a ON a.id = p.address_id WHERE p.id = ? AND p.address_id = ? AND a.name = ? AND i.enabled = 1`)
    .bind(session.app_id, session.address_id, session.address).first());
}
