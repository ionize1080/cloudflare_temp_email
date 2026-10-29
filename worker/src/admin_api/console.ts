import { Hono } from 'hono';
import { getAdminPasswords, getBooleanValue, getDomains, getJsonObjectValue } from '../utils';
import { ACCESS_ISSUER, MAIL_ORIGIN } from '../../../shared/security.mjs';

const api = new Hono<HonoCustomType>();
api.get('/admin/overview', async c => {
    const counts = await c.env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM address) AS addresses,
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM raw_mails) AS received,
        (SELECT COUNT(*) FROM sendbox) AS sent,
        (SELECT COUNT(*) FROM address_sender WHERE requested_at IS NOT NULL) AS pending,
        (SELECT COUNT(*) FROM address_sender WHERE enabled = 1 AND balance > 0) AS senders`).first();
    const domains = getDomains(c);
    const smtp = getJsonObjectValue<Record<string, unknown>>(c.env.SMTP_CONFIG) || {};
    return c.json({ counts, identity: c.get('accessEmail'), canonicalOrigin: MAIL_ORIGIN,
        security: {
            accessVerified: true, accessIssuer: ACCESS_ISSUER,
            adminCheckEnabled: !getBooleanValue(c.env.DISABLE_ADMIN_PASSWORD_CHECK),
            encryptedAdminSecret: Boolean(c.env.ADMIN_PASSWORDS_SECRET),
            adminCredentialConfigured: getAdminPasswords(c).length > 0,
            rateLimitEnabled: Boolean(c.env.RATE_LIMITER),
            jwtConfigured: Boolean(c.env.JWT_SECRET), auditRetention: 1000,
        },
        domains: domains.map(domain => ({ domain,
            outboundConfigured: Boolean(c.env.RESEND_TOKEN || c.env[`RESEND_TOKEN_${domain.replace(/\./g, '_').toUpperCase()}`] || smtp[domain]),
        })),
    });
});
api.get('/admin/audit', async c => {
    const offset = Number(c.req.query('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return c.json({ error: '无效的页码' }, 400);
    const [rows, count] = await c.env.DB.batch([
        c.env.DB.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 50 OFFSET ?').bind(offset),
        c.env.DB.prepare('SELECT COUNT(*) AS count FROM admin_audit'),
    ]);
    return c.json({ results: rows.results, count: count.results[0]?.count || 0 });
});
export default api;
