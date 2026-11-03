import { NAV_SESSION_SECONDS, MAIL_SESSION_HOURS, createMailTicket } from '../../shared/navigation-sso.mjs';
import { initializeBookmarks } from './bookmarks.mjs';
import { hashPassword, verifyPassword, passwordDigest, randomAppPassword } from '../../shared/passwords.mjs';

import { refreshWallpapers, serveWallpaper } from './wallpapers.mjs';

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const now = () => Math.floor(Date.now() / 1000);
const COOKIE = '__Host-ionacs_session';
const cookie = (token, age = NAV_SESSION_SECONDS) => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const tokenOf = req => (req.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
const boundedString = (value, max) => typeof value === 'string' && value.length <= max;
export function safeURL(value, httpsOnly = false) {
  if (!boundedString(value, 2048)) fail('网址过长或格式不正确');
  let url; try { url = new URL(value); } catch { fail('请输入完整网址，例如 https://example.com'); }
  if (!(httpsOnly ? ['https:'] : ['http:', 'https:']).includes(url.protocol) || url.username || url.password) fail('网址只支持 HTTP/HTTPS，不能包含账户密码');
  return url.href;
}
async function body(req) {
  if (!req.headers.get('content-type')?.startsWith('application/json')) fail('请求格式错误', 415);
  if (Number(req.headers.get('content-length')) > 16384) fail('请求过大', 413);
  const reader = req.body?.getReader(); if (!reader) fail('请求为空');
  let size = 0, parts = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); fail('请求过大', 413); } parts.push(value); }
  const data = new Uint8Array(size); let offset = 0; for (const p of parts) { data.set(p, offset); offset += p.length; }
  try { const parsed = JSON.parse(new TextDecoder().decode(data)); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('请求格式错误'); return parsed; } catch { fail('请求格式错误'); }
}
async function rate(env, binding, key) {
  if (!env[binding]) fail('安全服务尚未配置', 503);
  if (!(await env[binding].limit({ key })).success) fail('操作太频繁，请一分钟后再试', 429);
}
export async function challenge(req, env, token, action) {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) fail('验证服务尚未配置，请稍后再试', 503);
  if (!boundedString(token, 2048) || !token) fail('请先完成人机验证');
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: req.headers.get('CF-Connecting-IP') || undefined })
  });
  if (!response.ok) fail('验证服务暂不可用', 503);
  const result = await response.json();
  if (!result.success || result.hostname !== new URL(env.APP_ORIGIN).hostname || result.action !== action) fail('验证已过期或未通过，请重新验证', 403);
}
async function session(req, env, required = true, state = {}) {
  const token = tokenOf(req);
  if (!/^[a-f0-9]{48}$/.test(token)) { if (required) fail('请先登录', 401); return null; }
  const row = await env.DB.prepare(`SELECT a.id, a.name, a.password, s.password_version, s.expires_at FROM nav_sessions s JOIN address a ON a.id = s.address_id WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await passwordDigest(token), now()).first();
  if (!row || row.password_version !== await passwordDigest(row.password || '')) { if (required) fail('登录已过期，请重新登录', 401); return null; }
  if(row.expires_at < now()+NAV_SESSION_SECONDS-86400){await env.DB.prepare('UPDATE nav_sessions SET expires_at=? WHERE token_hash=?').bind(now()+NAV_SESSION_SECONDS,await passwordDigest(token)).run();state.cookie=cookie(token);}
  return { id: row.id, email: row.name, admin: row.name === env.ADMIN_EMAIL };
}
async function issueSession(env, row) {
  const token = randomAppPassword();
  await env.DB.prepare('INSERT INTO nav_sessions(token_hash,address_id,password_version,expires_at) VALUES(?,?,?,?)').bind(await passwordDigest(token), row.id, await passwordDigest(row.password), now() + NAV_SESSION_SECONDS).run();
  return json({ user: { id: row.id, email: row.name, admin: row.name === env.ADMIN_EMAIL } }, 200, { 'Set-Cookie': cookie(token) });
}
export async function register(env, data) {
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._-]{2,39}@ionacs\.com$/.test(email) || email.includes('..')) fail('请输入 3–40 位邮箱名称，只能使用字母、数字、点、下划线和短横线');
  if (email === env.ADMIN_EMAIL || /^(admin|postmaster|abuse|security|support|noreply|no-reply)@/.test(email)) fail('该邮箱名称不可注册');
  if (!boundedString(data.invite, 128) || !data.invite.trim()) fail('请输入邀请码');
  const inviteHash = await passwordDigest(data.invite.trim());
  const invite = await env.DB.prepare('SELECT 1 FROM nav_invites WHERE code_hash = ? AND revoked = 0 AND used < max_uses AND expires_at > ?').bind(inviteHash, now()).first();
  if (!invite) fail('邀请码无效、已用完或已过期');
  let password; try { password = await hashPassword(data.password); } catch (error) { fail(error.message); }
  // D1 batch is atomic: invite exhaustion or duplicate mailbox rolls back BOTH inserts.
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO address(name,password,source_meta) VALUES(?, ?, ?)").bind(email, password, JSON.stringify({ source: 'ionacs-navigation' })),
      env.DB.prepare('INSERT INTO nav_registrations(address_id,invite_hash) SELECT id, ? FROM address WHERE name = ?').bind(inviteHash, email)
    ]);
  } catch (error) {
    if (/invite_unavailable|UNIQUE constraint/.test(error.message)) fail('邮箱已存在，或邀请码已失效');
    throw error;
  }
  return env.DB.prepare('SELECT id,name,password FROM address WHERE name = ?').bind(email).first();
}
async function wallpapers(env, ctx) {
  let rows = (await env.DB.prepare('SELECT payload,fetched_at FROM nav_wallpapers ORDER BY day DESC LIMIT 8').all()).results;
  if (!rows.length) { ctx.waitUntil(refreshWallpapers(env).catch(() => console.warn('Wallpaper refresh unavailable'))); return json({images:[],unavailable:true}); }
  else if (rows[0].fetched_at < now() - 3600) ctx.waitUntil(refreshWallpapers(env).catch(() => console.warn('Wallpaper refresh unavailable')));
  return json({ images: rows.map(r => { const item = JSON.parse(r.payload); return { ...item, originalURL: item.url, url: '/api/wallpaper/' + item.day, thumbnail: '/api/wallpaper/' + item.day + '?size=thumb' }; }) });
}
async function handle(req, env, ctx, state) {
  const url = new URL(req.url), path = url.pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers.get('Origin') !== env.APP_ORIGIN || req.headers.get('Sec-Fetch-Site') === 'cross-site') fail('请求来源不被允许', 403);
    await rate(env, 'WRITE_LIMITER', req.headers.get('CF-Connecting-IP') || 'unknown');
  }
  if (path === '/api/config' && req.method === 'GET') return json({ siteKey: env.TURNSTILE_SITE_KEY || '', mailURL: 'https://mail.ionacs.com', registration: 'invite' });

  if (path === '/api/me' && req.method === 'GET') return json({ user: await session(req, env, false, state) });
  if (['/api/login', '/api/register'].includes(path) && req.method === 'POST') {
    const data = await body(req);
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    await rate(env, 'AUTH_LIMITER', 'ip:' + (req.headers.get('CF-Connecting-IP') || 'unknown'));
    await rate(env, 'AUTH_LIMITER', 'email:' + await passwordDigest(email));
    await challenge(req, env, data.token, path.slice(5));
    if (path === '/api/register') return issueSession(env, await register(env, data));
    if (email.length > 254) fail('账号或密码错误', 401);
    const row = await env.DB.prepare('SELECT id,name,password FROM address WHERE name=?').bind(email).first();
    if (!await verifyPassword(data.password, row?.password, 'plain')) fail('账号或密码错误', 401);
    return issueSession(env, row);
  }
  if (path === '/api/logout' && req.method === 'POST') {
    await env.DB.prepare('DELETE FROM nav_sessions WHERE token_hash=?').bind(await passwordDigest(tokenOf(req))).run();
    return json({ success: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  const user = await session(req, env, true, state);
  if(path==='/api/mail-link'&&req.method==='POST'){
    const prefs=await env.DB.prepare('SELECT mail_session_hours FROM nav_preferences WHERE address_id=?').bind(user.id).first();
    const ticket=await createMailTicket(env.DB,tokenOf(req),prefs?.mail_session_hours||24);
    return json({url:'https://mail.ionacs.com/#ionacs-ticket='+ticket});
  }
  if (path === '/api/wallpapers' && req.method === 'GET') return wallpapers(env,ctx);
  const wallpaper = /^\/api\/wallpaper\/(\d{8})$/.exec(path);
  if (wallpaper && req.method === 'GET') return serveWallpaper(req,env,ctx,wallpaper[1],url.searchParams.get('size') === 'thumb' ? 'thumb' : 'large');
  if (path === '/api/bookmarks') {
    if (req.method === 'GET') { await initializeBookmarks(env.DB,user.id); return json({ bookmarks: (await env.DB.prepare('SELECT id,title,url,position FROM nav_bookmarks WHERE address_id=? ORDER BY position,created_at,id').bind(user.id).all()).results }); }
    if (req.method === 'POST') {
      const data = await body(req);
      if (!boundedString(data.title, 80) || !data.title.trim()) fail('名称需要 1–80 个字符');
      const link = safeURL(data.url), id = crypto.randomUUID();
      const result = await env.DB.prepare('INSERT INTO nav_bookmarks(id,address_id,title,url,position) SELECT ?,?,?,?,COALESCE(MAX(position),-1)+1 FROM nav_bookmarks WHERE address_id=? HAVING COUNT(*) < 100').bind(id,user.id,data.title.trim(),link,user.id).run();
      if (!result.meta.changes) fail('最多保存 100 个收藏');
      return json({ id }, 201);
    }
  }
  const bookmark = /^\/api\/bookmarks\/([a-f0-9-]{36})$/.exec(path);
  if (bookmark) {
    if (req.method === 'DELETE') { const result = await env.DB.prepare('DELETE FROM nav_bookmarks WHERE id=? AND address_id=?').bind(bookmark[1],user.id).run(); if (!result.meta.changes) fail('收藏不存在',404); return json({ success: true }); }
    if (req.method === 'PATCH') { const data = await body(req); if (!boundedString(data.title,80) || !data.title.trim()) fail('名称需要 1–80 个字符'); const result = await env.DB.prepare('UPDATE nav_bookmarks SET title=?,url=? WHERE id=? AND address_id=?').bind(data.title.trim(),safeURL(data.url),bookmark[1],user.id).run(); if (!result.meta.changes) fail('收藏不存在',404); return json({ success: true }); }
  }
  if (path === '/api/preferences') {
    if (req.method === 'GET') return json({ preferences: await env.DB.prepare('SELECT wallpaper_mode,wallpaper_url,color,search_engine,mail_session_hours FROM nav_preferences WHERE address_id=?').bind(user.id).first() });
    if (req.method === 'PUT') {
      const d = await body(req);
      if(d.mail_session_hours!==undefined&&!MAIL_SESSION_HOURS.includes(d.mail_session_hours))fail('邮箱登录有效期不正确');
      if (!['bing','image','color'].includes(d.wallpaper_mode) || !['google','bing','baidu'].includes(d.search_engine) || !/^#[a-fA-F0-9]{6}$/.test(d.color)) fail('设置格式不正确');
      const image = d.wallpaper_mode === 'image' ? (/^\/api\/wallpaper\/\d{8}$/.test(d.wallpaper_url) ? d.wallpaper_url : safeURL(d.wallpaper_url,true)) : '';
      await env.DB.prepare('INSERT INTO nav_preferences(address_id,wallpaper_mode,wallpaper_url,color,search_engine,mail_session_hours) VALUES(?,?,?,?,?,?) ON CONFLICT(address_id) DO UPDATE SET wallpaper_mode=excluded.wallpaper_mode,wallpaper_url=excluded.wallpaper_url,color=excluded.color,search_engine=excluded.search_engine,mail_session_hours=excluded.mail_session_hours').bind(user.id,d.wallpaper_mode,image,d.color,d.search_engine,d.mail_session_hours||24).run();
      return json({ success: true });
    }
  }
  if (path.startsWith('/api/admin/')) {
    if (!user.admin) fail('需要管理员权限',403);
    if (path === '/api/admin/invites' && req.method === 'GET') return json({ invites: (await env.DB.prepare('SELECT code_hash AS id,label,max_uses,used,expires_at,revoked,created_at FROM nav_invites ORDER BY created_at DESC LIMIT 100').all()).results });
    if (path === '/api/admin/invites' && req.method === 'POST') {
      const d = await body(req); if (!Number.isInteger(d.maxUses) || d.maxUses < 1 || d.maxUses > 100 || !Number.isInteger(d.days) || d.days < 1 || d.days > 90 || !boundedString(d.label,80)) fail('邀请码设置不正确');
      const code = randomAppPassword(), hash = await passwordDigest(code);
      await env.DB.prepare('INSERT INTO nav_invites(code_hash,label,max_uses,expires_at,created_by) VALUES(?,?,?,?,?)').bind(hash,d.label || '新邀请码',d.maxUses,now()+d.days*86400,user.id).run();
      return json({ code },201);
    }
    const invite = /^\/api\/admin\/invites\/([a-f0-9]{64})$/.exec(path);
    if (invite && req.method === 'DELETE') { await env.DB.prepare('UPDATE nav_invites SET revoked=1 WHERE code_hash=?').bind(invite[1]).run(); return json({ success:true }); }
  }
  fail('未找到此接口',404);
}
export default {
  async fetch(req,env,ctx) {
    let res;const state={};
    try { res = await handle(req,env,ctx,state); }
    catch (err) { if (!err.status) console.error('Navigation request failed'); res = json({ error: err.status ? err.message : '服务暂时不可用，请稍后重试' }, err.status || 503); }
    res = new Response(res.body,res);
    if(state.cookie&&!res.headers.has('Set-Cookie'))res.headers.set('Set-Cookie',state.cookie);
    res.headers.set('X-Content-Type-Options','nosniff'); res.headers.set('X-Frame-Options','DENY'); res.headers.set('Referrer-Policy','no-referrer');
    res.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()'); res.headers.set('Strict-Transport-Security','max-age=31536000');
    res.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (new URL(req.url).pathname.startsWith('/api/') && !res.headers.has('Cache-Control')) res.headers.set('Cache-Control','private, no-store');
    return res;
  },
  async scheduled(event,env,ctx) { ctx.waitUntil(Promise.all([refreshWallpapers(env),env.DB.prepare('DELETE FROM nav_mail_tickets WHERE expires_at < ?').bind(now()).run(),env.DB.prepare('DELETE FROM nav_sessions WHERE expires_at < ?').bind(now()).run()])); }
};
