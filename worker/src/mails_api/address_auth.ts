import { Context } from 'hono';
import { getBooleanValue } from '../utils';
import { Jwt } from 'hono/utils/jwt';
import { hashPassword, hashPasswordDigest, passwordDigest, verifyPassword } from '../../../shared/passwords.mjs';

export default {
    changePassword: async (c: Context<HonoCustomType>) => {
        if (!getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD)) return c.text('密码登录未启用', 403);
        const { new_password } = await c.req.json();
        const { address, address_id } = c.get('jwtPayload');
        let encoded;
        try { encoded = await hashPassword(new_password); } catch (error) { return c.text((error as Error).message, 400); }
        const row = await c.env.DB.prepare('SELECT id FROM address WHERE id = ? AND name = ?').bind(address_id, address).first();
        if (!row) return c.text('邮箱凭据已失效', 401);
        await c.env.DB.batch([
            c.env.DB.prepare("UPDATE address SET password = ?, updated_at = datetime('now') WHERE id = ? AND name = ?").bind(encoded, address_id, address),
            c.env.DB.prepare('DELETE FROM imap_passwords WHERE address_id = ?').bind(address_id),
        ]);
        return c.json({ success: true });
    },
    login: async (c: Context<HonoCustomType>) => {
        if (!getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD)) return c.text('密码登录未启用', 403);
        const { email, password, password_format } = await c.req.json();
        if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string') return c.text('账号或密码错误', 401);
        const normalized = email.trim().toLowerCase();
        if (c.env.AUTH_RATE_LIMITER && !(await c.env.AUTH_RATE_LIMITER.limit({ key: 'mailbox:' + normalized })).success) return c.text('登录尝试过多，请一分钟后再试。', 429);
        const row = await c.env.DB.prepare('SELECT id, name, password FROM address WHERE name = ?').bind(normalized).first<{ id: number, name: string, password: string }>();
        const format = password_format === 'plain' ? 'plain' : 'sha256';
        if (!await verifyPassword(password, row?.password, format)) return c.text('账号或密码错误', 401);
        if (!row!.password.startsWith('pbkdf2-')) {
            const upgraded = await hashPasswordDigest(format === 'sha256' ? password : await passwordDigest(password));
            await c.env.DB.prepare('UPDATE address SET password = ? WHERE id = ? AND password = ?').bind(upgraded, row!.id, row!.password).run();
        }
        const jwt = await Jwt.sign({ address: row!.name, address_id: row!.id, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 30 * 86400 }, c.env.JWT_SECRET, 'HS256');
        return c.json({ jwt, address: row!.name });
    },
};
