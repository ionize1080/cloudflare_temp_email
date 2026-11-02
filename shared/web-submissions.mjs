import { passwordDigest } from './passwords.mjs';
export async function reserveWeb(db, identity, id, digest, cost, now = Math.floor(Date.now()/1000)) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效发送标识');
  const key = await passwordDigest(identity.address + ':' + id), claim = crypto.randomUUID();
  let row = await db.prepare('SELECT * FROM web_submissions WHERE id=? AND address_id=?').bind(key, identity.address_id).first();
  if (row && row.digest !== digest) throw new Error('邮件内容已变化，请重新发送');
  if (!row) {
    try { await db.prepare('INSERT OR IGNORE INTO web_submissions(id,address_id,digest,cost,claim,lease,created_at) VALUES(?,?,?,?,?,?,?)').bind(key, identity.address_id, digest, cost, claim, now+90, now).run(); }
    catch { throw new Error('发送权限或剩余额度不足'); }
    row = await db.prepare('SELECT * FROM web_submissions WHERE id=? AND address_id=?').bind(key, identity.address_id).first();
  }
  if (row.digest !== digest) throw new Error('发送标识已被使用');
  if (row.state === 'sent') return { row, duplicate: true };
  if (row.state === 'failed') throw new Error('此邮件曾被拒绝，请修改后重新发送');
  if (now-row.created_at >= 23*3600) throw new Error('先前投递结果需管理员核查');
  if (row.claim !== claim) {
    await db.prepare("UPDATE web_submissions SET claim=?,lease=?,state='pending' WHERE id=? AND state IN ('pending','uncertain') AND lease<=?").bind(claim, now+90, key, now).run();
    row = await db.prepare('SELECT * FROM web_submissions WHERE id=?').bind(key).first();
    if (row.claim !== claim) throw new Error('正在发送，请稍后重试');
  }
  return { row, duplicate: false };
}
export async function failWeb(db, row, definitive) {
  await db.prepare("UPDATE web_submissions SET state=?,lease=0 WHERE id=? AND claim=? AND state='pending'").bind(definitive?'failed':'uncertain', row.id, row.claim).run();
}
export async function finishWeb(db, row, address, provider, archive, attachments) {
  await db.batch([
    ...attachments.map(id => db.prepare('UPDATE mail_attachments SET expires_at=NULL WHERE id=? AND address_id=?').bind(id,row.address_id)),
    db.prepare("INSERT INTO sendbox(address,raw) SELECT ?,? FROM web_submissions WHERE id=? AND claim=? AND state='pending'").bind(address,JSON.stringify(archive),row.id,row.claim),
    db.prepare("UPDATE web_submissions SET state='sent',provider_id=? WHERE id=? AND claim=? AND state='pending'").bind(provider,row.id,row.claim),
  ]);
}
