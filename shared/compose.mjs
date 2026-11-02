export const MAX_ATTACHMENTS = 25 * 1024 * 1024;
export const BLOCKED_FILE = /\.(exe|com|bat|cmd|msi|scr|ps1|vbs|js|jar|hta|lnk|reg|dll|iso|img)$/i;
export const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(value);
export function recipients(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,\n]/).map(v => v.trim()).filter(Boolean) : [];
  if (list.length > 20 || !list.every(validEmail)) throw new Error('请填写有效的邮箱地址，多个地址用逗号分隔');
  return [...new Set(list.map(v => v.toLowerCase()))];
}
export function validateCompose(input) {
  const to = recipients(input.to || input.to_mail), cc = recipients(input.cc), bcc = recipients(input.bcc);
  const all = [...new Set([...to, ...cc, ...bcc])];
  if (!to.length || all.length > 20) throw new Error('每封邮件需要收件人，收件人总数最多 20 人');
  if (typeof input.subject !== 'string' || input.subject.length > 250 || /[\r\n\x00]/.test(input.subject)) throw new Error('主题无效');
  if (typeof input.content !== 'string' || input.content.length > 100000) throw new Error('正文不能超过 100000 字符');
  if (!Array.isArray(input.attachments || []) || (input.attachments || []).length > 20 || !(input.attachments || []).every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))) throw new Error('附件无效');
  return { to, cc: cc.filter(v => !to.includes(v)), bcc: bcc.filter(v => !to.includes(v) && !cc.includes(v)), all, attachments: [...new Set(input.attachments || [])] };
}
export function validateAttachment(filename, size) {
  if (typeof filename !== 'string' || !filename.length || filename.length > 180 || /[\x00-\x1f\x7f/\\]/.test(filename) || BLOCKED_FILE.test(filename)) throw new Error('不支持此附件名称或可执行文件类型');
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENTS) throw new Error('附件大小需在 1 字节至 25 MB 之间');
}
