import { Hono } from 'hono';
import { createInvitations } from '../../shared/invitations.mjs';
export const invitationApi = new Hono<HonoCustomType>();
invitationApi.post('/admin/invitations', async c => {
    const { count, days = 30 } = await c.req.json();
    try { return c.json({ codes: await createInvitations(c.env.DB, count, c.get('accessEmail') || 'admin', days) }); }
    catch { return c.text('生成失败，请使用 1–100 的整数数量和 1–365 天有效期', 400); }
});
invitationApi.get('/admin/invitations', async c => {
    const offset = Number(c.req.query('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return c.text('无效页码', 400);
    const results = await c.env.DB.prepare('SELECT id,hint,created_at,expires_at,used_at,used_by,revoked_at FROM invitations ORDER BY created_at DESC,id LIMIT 100 OFFSET ?').bind(offset).all();
    return c.json(results);
});
invitationApi.delete('/admin/invitations/:id', async c => {
    await c.env.DB.prepare('UPDATE invitations SET revoked_at=unixepoch() WHERE id=? AND used_at IS NULL').bind(c.req.param('id')).run();
    return c.json({ success: true });
});
