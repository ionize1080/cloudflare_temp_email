export async function invitationHash(code) {
  if (typeof code !== 'string' || !/^[A-Fa-f0-9]{32}$/.test(code.trim())) throw new Error('请输入有效的邀请码');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.trim().toLowerCase()));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export async function createInvitations(db, count, actor, days = 30) {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('生成数量必须为 1–100 的整数');
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('有效期必须为 1–365 天');
  const now = Math.floor(Date.now() / 1000), results = [], statements = [];
  for (let i = 0; i < count; i++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    const id = crypto.randomUUID(), expires_at = now + days * 86400;
    results.push({ id, code, expires_at });
    statements.push(db.prepare('INSERT INTO invitations(id,code_hash,hint,created_at,expires_at,created_by) VALUES(?,?,?,?,?,?)')
      .bind(id, await invitationHash(code), code.slice(-6), now, expires_at, actor));
  }
  await db.batch(statements);
  return results;
}
export async function registerInvitedAddress(db, code, name, source, hash) {
  const digest = await invitationHash(code);
  // Both statements roll back on duplicate address or consumed/expired/revoked invitation.
  await db.batch([
    db.prepare('INSERT INTO invitation_redemptions(code_hash,address) VALUES(?,?)').bind(digest, name),
    db.prepare('INSERT INTO address(name,source_meta,password) VALUES(?,?,?)').bind(name, source, hash),
  ]);
}
