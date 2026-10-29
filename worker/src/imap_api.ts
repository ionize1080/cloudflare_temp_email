import { Hono } from 'hono';
import { Jwt } from 'hono/utils/jwt';
import { equalSecret } from '../../shared/security.mjs';
import { ImapAccessError, imapState, mailboxIdentity, requestImap, reviewImap, createImapPassword, authenticateImap, validImapSession } from '../../shared/imap-access.mjs';
import { getBooleanValue, sendAdminInternalMail } from './utils';

export const mailboxImapApi = new Hono<HonoCustomType>();
mailboxImapApi.use('/api/imap/*', async (c, next) => {
    try { await mailboxIdentity(c.env.DB, c.get('jwtPayload')); }
    catch { return c.text('邮箱凭据已失效', 401); }
    await next();
});
mailboxImapApi.get('/api/imap/settings', async c => {
    const { address_id } = c.get('jwtPayload');
    const row = await c.env.DB.prepare('SELECT * FROM imap_access WHERE address_id = ?').bind(address_id).first();
    const passwords = await c.env.DB.prepare('SELECT id, label, created_at, last_used_at FROM imap_passwords WHERE address_id = ? ORDER BY created_at DESC').bind(address_id).all();
    return c.json({ state: imapState(row), requested_at: row?.requested_at, passwords: passwords.results,
        host: row?.enabled ? c.env.IMAP_HOST || '' : '', port: Number(c.env.IMAP_PORT || 993), tls: true,
        available: Boolean(c.env.IMAP_HOST && c.env.IMAP_GATEWAY_SECRET) });
});
mailboxImapApi.post('/api/imap/request', async c => c.json({ state: imapState(await requestImap(c.env.DB, c.get('jwtPayload').address_id)) }));
mailboxImapApi.post('/api/imap/passwords', async c => {
    try { const { label } = await c.req.json(); return c.json(await createImapPassword(c.env.DB, c.get('jwtPayload').address_id, label)); }
    catch (error) { if (error instanceof ImapAccessError) return c.text(error.message, 400); throw error; }
});
mailboxImapApi.delete('/api/imap/passwords/:id', async c => {
    await c.env.DB.prepare('DELETE FROM imap_passwords WHERE id = ? AND address_id = ?').bind(c.req.param('id'), c.get('jwtPayload').address_id).run();
    return c.json({ success: true });
});

export const adminImapApi = new Hono<HonoCustomType>();
adminImapApi.get('/admin/imap', async c => {
    const offset = Number(c.req.query('offset') || 0), query = (c.req.query('q') || '').trim().slice(0, 254);
    if (!Number.isSafeInteger(offset) || offset < 0) return c.text('无效页码', 400);
    const pending = c.req.query('pending') === '1' ? ' AND i.requested_at IS NOT NULL' : '';
    const where = ` FROM address a LEFT JOIN imap_access i ON i.address_id = a.id WHERE instr(lower(a.name), lower(?)) > 0${pending}`;
    const rows = await c.env.DB.prepare(`SELECT a.id AS address_id, a.name AS address, i.enabled, i.requested_at, i.reviewed_at,
        (SELECT COUNT(*) FROM imap_passwords p WHERE p.address_id = a.id) AS clients${where}
        ORDER BY i.requested_at IS NOT NULL DESC, a.id DESC LIMIT 20 OFFSET ?`).bind(query, offset).all();
    const count = await c.env.DB.prepare('SELECT COUNT(*) AS count' + where).bind(query).first();
    return c.json({ results: rows.results, count: count?.count || 0 });
});
adminImapApi.post('/admin/imap', async c => {
    try {
        const input = await c.req.json();
        const mailbox = await reviewImap(c.env.DB, input);
        const sent = await sendAdminInternalMail(c, mailbox.name, 'IMAP 权限更新', input.enabled
            ? '管理员已开通 IMAP。请在网页邮箱的“邮箱与账号 → 第三方客户端”生成专用密码。'
            : '管理员已停用 IMAP，之前生成的所有客户端密码已撤销。');
        return c.json({ success: true, notification_sent: Boolean(sent) });
    } catch (error) { if (error instanceof ImapAccessError) return c.text(error.message, 400); throw error; }
});

// A dedicated Access service token and gateway secret protect this namespace.
// IMAP sessions use a separate signing key and can never authenticate web APIs.
export const bridgeImapApi = new Hono<HonoCustomType>();
bridgeImapApi.use('/imap_api/*', async (c, next) => {
    if (!c.env.IMAP_GATEWAY_SECRET || !await equalSecret(c.req.header('x-imap-gateway-key') || '', c.env.IMAP_GATEWAY_SECRET)) return c.text('Gateway authentication required', 401);
    if (c.req.path === '/imap_api/authenticate') { await next(); return; }
    try {
        const payload = await Jwt.verify((c.req.header('Authorization') || '').replace(/^Bearer /, ''), c.env.JWT_SECRET + ':imap:v1', 'HS256');
        if (!payload.exp || !await validImapSession(c.env.DB, payload)) return c.text('IMAP permission revoked or session expired', 401);
        c.set('imapPayload', payload as ImapPayload);
    } catch { return c.text('IMAP authentication required', 401); }
    await next();
});
bridgeImapApi.post('/imap_api/authenticate', async c => {
    const { username, password } = await c.req.json();
    if (typeof username !== 'string' || username.length > 254) return c.text('Authentication failed', 401);
    if (c.env.AUTH_RATE_LIMITER && !(await c.env.AUTH_RATE_LIMITER.limit({ key: 'imap:' + username.trim().toLowerCase() })).success) return c.text('Too many attempts', 429);
    const identity = await authenticateImap(c.env.DB, username, password);
    if (!identity) return c.text('Authentication failed', 401);
    const token = await Jwt.sign({ ...identity, scope: 'imap', exp: Math.floor(Date.now() / 1000) + 12 * 3600 }, c.env.JWT_SECRET + ':imap:v1', 'HS256');
    return c.json({ token, address: identity.address, uidvalidity: identity.address_id });
});
bridgeImapApi.get('/imap_api/session', c => c.json({ address: c.get('imapPayload').address }));
bridgeImapApi.get('/imap_api/messages', async c => {
    const { address_id } = c.get('imapPayload');
    const folder = c.req.query('folder'), after = Number(c.req.query('after') || 0);
    if (!['INBOX', 'SENT'].includes(folder || '') || !Number.isSafeInteger(after) || after < 0) return c.text('Invalid mailbox', 400);
    const rows = await c.env.DB.prepare('SELECT uid, flags FROM imap_messages WHERE address_id = ? AND folder = ? AND uid > ? ORDER BY uid LIMIT 1000').bind(address_id, folder, after).all();
    const sequence = await c.env.DB.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'imap_messages'").first();
    return c.json({ results: rows.results, uidnext: Number(sequence?.seq || 0) + 1, uidvalidity: address_id });
});
bridgeImapApi.get('/imap_api/message/:uid', async c => {
    const uid = Number(c.req.param('uid'));
    if (!Number.isSafeInteger(uid) || uid < 1) return c.text('Invalid UID', 400);
    const meta = await c.env.DB.prepare('SELECT * FROM imap_messages WHERE uid = ? AND address_id = ?').bind(uid, c.get('imapPayload').address_id).first<{ folder: string, mail_id: number, flags: string }>();
    if (!meta) return c.text('Message not found', 404);
    const row = await c.env.DB.prepare(`SELECT raw, created_at, address FROM ${meta.folder === 'INBOX' ? 'raw_mails' : 'sendbox'} WHERE id = ? AND address = ?`).bind(meta.mail_id, c.get('imapPayload').address).first();
    if (!row) return c.text('Message not found', 404);
    return c.json({ ...row, uid, folder: meta.folder, flags: JSON.parse(meta.flags) });
});
const allowedFlags = ['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft'];
bridgeImapApi.post('/imap_api/flags', async c => {
    const { uids, flags, mode } = await c.req.json();
    if (!Array.isArray(uids) || !uids.length || uids.length > 100 || !uids.every(id => Number.isSafeInteger(id) && id > 0)
        || !Array.isArray(flags) || flags.length > 5 || !flags.every(f => allowedFlags.includes(f)) || ![-1, 0, 1].includes(mode)) return c.text('Invalid flags', 400);
    // Use json_each for atomic union/subtraction so concurrent clients do not lose flags.
    const value = mode === 0 ? '?' : mode === 1
        ? `(SELECT json_group_array(value) FROM (SELECT value FROM json_each(imap_messages.flags) UNION SELECT value FROM json_each(?)))`
        : `(SELECT json_group_array(value) FROM json_each(imap_messages.flags) WHERE value NOT IN (SELECT value FROM json_each(?)))`;
    await c.env.DB.batch(uids.map(uid => c.env.DB.prepare(`UPDATE imap_messages SET flags = ${value} WHERE uid = ? AND address_id = ?`).bind(JSON.stringify([...new Set(flags)]), uid, c.get('imapPayload').address_id)));
    const rows = await c.env.DB.prepare('SELECT uid, flags FROM imap_messages WHERE address_id = ? AND uid IN (SELECT value FROM json_each(?))').bind(c.get('imapPayload').address_id, JSON.stringify(uids)).all();
    return c.json({ results: rows.results });
});
bridgeImapApi.post('/imap_api/expunge', async c => {
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) return c.text('Deletion is disabled', 403);
    const { folder } = await c.req.json();
    if (!['INBOX', 'SENT'].includes(folder)) return c.text('Invalid mailbox', 400);
    const { address_id, address } = c.get('imapPayload');
    await c.env.DB.prepare(`DELETE FROM ${folder === 'INBOX' ? 'raw_mails' : 'sendbox'} WHERE address = ? AND id IN
        (SELECT mail_id FROM imap_messages WHERE address_id = ? AND folder = ?
         AND EXISTS (SELECT 1 FROM json_each(flags) WHERE value = '\\Deleted'))`).bind(address, address_id, folder).run();
    return c.json({ success: true });
});
