export async function deleteMailbox(db, rawId) {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid mailbox ID');
  const mailbox = await db.prepare('SELECT name FROM address WHERE id = ?').bind(id).first();
  if (!mailbox) return false;
  // Keep the address until all dependent records have been removed. D1 batch
  // rolls the entire transaction back if any statement fails.
  const statements = ['raw_mails', 'address_sender', 'sendbox', 'auto_reply_mails'].map(table =>
    db.prepare(`DELETE FROM ${table} WHERE address IN (SELECT name FROM address WHERE id = ?)`).bind(id));
  statements.push(db.prepare('DELETE FROM users_address WHERE address_id = ?').bind(id));
  statements.push(db.prepare('DELETE FROM address WHERE id = ?').bind(id));
  const results = await db.batch(statements);
  if (results.some(result => !result.success)) throw new Error('Mailbox deletion failed');
  return true;
}
