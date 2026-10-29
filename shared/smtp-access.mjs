export class SmtpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function smtpPermission(db, identity) {
  const row = await db.prepare(`SELECT s.balance FROM address_sender s JOIN address a ON a.name = s.address
    JOIN imap_access i ON i.address_id = a.id JOIN imap_passwords p ON p.address_id = a.id
    WHERE a.id = ? AND a.name = ? AND p.id = ? AND i.enabled = 1 AND s.enabled = 1`).bind(identity.address_id, identity.address, identity.app_id).first();
  return row;
}

export async function reserveSubmission(db, identity, id, cost, now = Math.floor(Date.now() / 1000)) {
  if (!await smtpPermission(db, identity)) throw new SmtpError('Sending permission revoked', 403);
  const claim = crypto.randomUUID();
  // The trigger charges the quota only when this insert creates a new row.
  await db.prepare(`INSERT OR IGNORE INTO smtp_submissions(id,address_id,cost,claim,lease,created_at)
    SELECT ?,a.id,?,?,?,? FROM address a JOIN imap_access i ON i.address_id=a.id JOIN imap_passwords p ON p.address_id=a.id
    JOIN address_sender s ON s.address=a.name WHERE a.id=? AND a.name=? AND p.id=? AND i.enabled=1 AND s.enabled=1 AND s.balance>=?`)
    .bind(id, cost, claim, now + 90, now, identity.address_id, identity.address, identity.app_id, cost).run();
  let row = await db.prepare('SELECT * FROM smtp_submissions WHERE id=? AND address_id=?').bind(id, identity.address_id).first();
  if (!row) throw new SmtpError('Sending permission or remaining quota unavailable', 403);
  if (row.state === 'sent') return { row, duplicate: true };
  if (row.state === 'failed') throw new SmtpError('This submission was rejected; correct the message before retrying');
  if (now - row.created_at >= 23 * 3600) throw new SmtpError('Previous delivery outcome requires administrator review', 409);
  if (row.claim !== claim) {
    await db.prepare(`UPDATE smtp_submissions SET claim=?,lease=?,state='pending' WHERE id=? AND address_id=?
      AND state IN ('pending','uncertain') AND lease<=?`).bind(claim, now + 90, id, identity.address_id, now).run();
    row = await db.prepare('SELECT * FROM smtp_submissions WHERE id=? AND address_id=?').bind(id, identity.address_id).first();
    if (row.claim !== claim) throw new SmtpError('Submission is processing; retry later', 409);
  }
  return { row, duplicate: false };
}

export async function finishSubmission(db, row, address, providerId, archive) {
  await db.batch([
    db.prepare(`INSERT INTO sendbox(address,raw) SELECT ?,? FROM smtp_submissions WHERE id=? AND claim=? AND state='pending'`)
      .bind(address, JSON.stringify(archive), row.id, row.claim),
    db.prepare("UPDATE smtp_submissions SET state='sent',provider_id=? WHERE id=? AND claim=? AND state='pending'")
      .bind(providerId, row.id, row.claim),
  ]);
}

export async function failSubmission(db, row, definitive) {
  await db.prepare("UPDATE smtp_submissions SET state=?,lease=0 WHERE id=? AND claim=? AND state='pending'")
    .bind(definitive ? 'failed' : 'uncertain', row.id, row.claim).run();
}
