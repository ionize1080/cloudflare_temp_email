export class SenderAccessError extends Error {}
export function senderState(row, unlimited = false) {
  if (unlimited) return 'unlimited';
  if (!row) return 'not_requested';
  if (row.requested_at) return 'pending';
  if (!row.enabled) return 'disabled';
  return row.balance > 0 ? 'approved' : 'exhausted';
}

export async function requestSenderAccess(db, address) {
  // The mailbox identity comes only from its verified token, never the body.
  const exists = await db.prepare('SELECT id FROM address WHERE name = ?').bind(address).first();
  if (!exists) throw new SenderAccessError('邮箱不存在');
  const result = await db.prepare(`INSERT INTO address_sender (address, balance, enabled, requested_at)
    VALUES (?, 0, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(address) DO UPDATE SET requested_at = COALESCE(address_sender.requested_at, CURRENT_TIMESTAMP)
    WHERE address_sender.enabled = 0 OR address_sender.balance <= 0`).bind(address).run();
  if (!result.success) throw new Error('申请提交失败');
  return db.prepare('SELECT * FROM address_sender WHERE address = ?').bind(address).first();
}

export async function updateSenderAccess(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SenderAccessError('无效的权限配置');
  const { balance, enabled } = input;
  if (!Number.isSafeInteger(balance) || balance < 0 || balance > 100000) throw new SenderAccessError('额度须为 0 到 100000 的整数');
  if (![0, 1, false, true].includes(enabled)) throw new SenderAccessError('无效的启用状态');
  const address = typeof input.address === 'string' ? input.address.trim().toLowerCase() : '';
  if (!address || address.length > 254) throw new SenderAccessError('请填写有效的邮箱地址');
  const existing = await db.prepare('SELECT id FROM address WHERE name = ?').bind(address).first();
  if (!existing) throw new SenderAccessError('邮箱不存在，请先创建邮箱');
  if (input.address_id !== undefined) {
    const row = await db.prepare('SELECT address FROM address_sender WHERE id = ?').bind(input.address_id).first();
    if (!row || row.address !== address) throw new SenderAccessError('发件权限记录与邮箱不匹配');
  }
  const result = await db.prepare(`INSERT INTO address_sender (address, balance, enabled, requested_at)
    VALUES (?, ?, ?, NULL) ON CONFLICT(address) DO UPDATE SET
    balance = excluded.balance, enabled = excluded.enabled, requested_at = NULL`)
    .bind(address, balance, enabled ? 1 : 0).run();
  if (!result.success) throw new Error('发件权限保存失败');
  return { address, balance, enabled: Boolean(enabled) };
}
