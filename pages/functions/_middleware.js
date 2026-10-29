import { requireAccess, rejectCrossOrigin, securityHeaders, MAIL_ORIGIN } from '../../shared/security.mjs';

const API_PATHS = [
    "/api/",
    "/open_api/",
    "/user_api/",
    "/admin/",
    "/telegram/",
    "/external/",
];

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const reqPath = url.pathname;
    // Never serve a second, unprotected copy on a Pages preview hostname.
    if (url.hostname !== 'mail.ionacs.com') {
        return securityHeaders(Response.redirect(`${MAIL_ORIGIN}${url.pathname}${url.search}`, 308));
    }
    if (!await requireAccess(context.request)) {
        return securityHeaders(new Response('请通过 Cloudflare Access 登录后重试。', { status: 401 }));
    }
    if (rejectCrossOrigin(context.request)) return securityHeaders(new Response('Forbidden origin', { status: 403 }));
    if (API_PATHS.map(path => reqPath.startsWith(path)).some(Boolean)) {
        return securityHeaders(await context.env.BACKEND.fetch(context.request));
    }
    if (reqPath === '/health_check') return securityHeaders(await context.env.BACKEND.fetch(context.request));
    const response = await context.next();
    return securityHeaders(response, { html: response.headers.get('content-type')?.includes('text/html') });
}
