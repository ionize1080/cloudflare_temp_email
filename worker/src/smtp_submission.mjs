import PostalMime, { addressParser } from 'postal-mime';
import { SmtpError, reserveSubmission, finishSubmission, failSubmission } from '../../shared/smtp-access.mjs';
import { passwordDigest } from '../../shared/passwords.mjs';

const MAX_MESSAGE = 1024 * 1024;
const validAddress = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(value);
const flatten = items => (items || []).flatMap(item => item.group || [item]).map(item => item.address?.toLowerCase()).filter(Boolean);
const oneLine = value => String(value || '').replace(/[\r\n]/g, ' ').replaceAll(String.fromCharCode(0), ' ').slice(0, 998);

export async function prepareSubmission(identity, input, blocked = []) {
  if (!input || typeof input.raw !== 'string' || input.raw.length > Math.ceil(MAX_MESSAGE / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.raw) || !Array.isArray(input.recipients)
    || !input.recipients.length || input.recipients.length > 20 || !input.recipients.every(validAddress)
    || typeof input.from !== 'string' || input.from.toLowerCase() !== identity.address) throw new SmtpError('Invalid message, sender or recipients');
  let raw;
  try { raw = Uint8Array.from(atob(input.raw), c => c.charCodeAt(0)); } catch { throw new SmtpError('Invalid MIME encoding'); }
  if (raw.length > MAX_MESSAGE) throw new SmtpError('Message exceeds 1 MiB', 413);
  const mail = await PostalMime.parse(raw, { attachmentEncoding: 'base64', maxNestingDepth: 20, maxHeadersSize: 32768 });
  const fromHeaders = mail.headers.filter(h => h.key === 'from');
  if (fromHeaders.length !== 1 || addressParser(fromHeaders[0].value, { flatten: true }).length !== 1
    || mail.from?.address?.toLowerCase() !== identity.address
    || (mail.sender && mail.sender.address?.toLowerCase() !== identity.address)
    || mail.headers.some(h => h.key.startsWith('resent-'))) throw new SmtpError('From must match the authenticated mailbox', 403);
  const recipients = [...new Set(input.recipients.map(r => r.toLowerCase()))];
  if (recipients.some(r => blocked.some(b => typeof b === 'string' && r.includes(b.toLowerCase())))) throw new SmtpError('Recipient is blocked', 403);
  const to = [...new Set(flatten(mail.to))].filter(r => recipients.includes(r));
  const cc = [...new Set(flatten(mail.cc))].filter(r => recipients.includes(r) && !to.includes(r));
  const bcc = recipients.filter(r => !to.includes(r) && !cc.includes(r));
  if (!to.length) throw new SmtpError('Include at least one envelope recipient in the To header');
  const headers = {};
  for (const [key, value] of [['In-Reply-To', mail.inReplyTo], ['References', mail.references]]) if (value) headers[key] = oneLine(value);
  const subject = oneLine(mail.subject) || '(no subject)';
  const payload = {
    from: mail.from.name ? `"${oneLine(mail.from.name).replace(/["\\]/g, '')}" <${identity.address}>` : identity.address,
    to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject,
    text: mail.text || '', ...(mail.html ? { html: mail.html } : {}), headers,
    ...(mail.replyTo?.length ? { reply_to: flatten(mail.replyTo).filter(validAddress).slice(0, 5) } : {}),
    attachments: mail.attachments.map((a, index) => ({ filename: oneLine(a.filename) || `attachment-${index + 1}`,
      content: a.content, content_type: a.mimeType, ...(a.contentId ? { content_id: oneLine(a.contentId).replace(/^<|>$/g, '') } : {}) })),
  };
  const id = await passwordDigest(identity.address + '\n' + recipients.slice().sort().join('\n') + '\n' + input.raw);
  const archive = { version: 'smtp-v1', mime_base64: input.raw, to_mail: recipients.join(', '), subject };
  return { id, cost: recipients.length, payload, archive };
}

export async function submitPrepared(db, identity, prepared, token, send = fetch) {
  if (!token) throw new SmtpError('Outgoing provider is not configured', 503);
  const reservation = await reserveSubmission(db, identity, prepared.id, prepared.cost);
  if (reservation.duplicate) return { success: true, duplicate: true };
  const { row } = reservation;
  let response;
  try {
    response = await send('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `smtp/${prepared.id}` },
      body: JSON.stringify(prepared.payload) });
  } catch {
    await failSubmission(db, row, false);
    throw new SmtpError('Provider response unavailable; retry the same message', 503);
  }
  if (!response.ok) {
    const definitive = response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status);
    await failSubmission(db, row, definitive);
    throw new SmtpError(definitive ? 'Outgoing provider rejected this message' : 'Outgoing provider unavailable; retry later', definitive ? 400 : 503);
  }
  const result = await response.json();
  if (typeof result.id !== 'string') throw new SmtpError('Provider result requires retry', 503);
  await finishSubmission(db, row, identity.address, result.id, prepared.archive);
  return { success: true };
}
