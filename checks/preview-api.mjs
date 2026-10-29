// Local UI fixture, never deployed and never connected to real email delivery.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { requestSenderAccess, updateSenderAccess, senderState } from '../shared/sender-access.mjs';
const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
sql.exec("INSERT INTO address(name) VALUES ('alex@ionacs.com')");
const db = { prepare(query) { const s = sql.prepare(query); let values = []; return { bind(...args) { values = args; return this; }, async first() { return s.get(...values) || null; }, async run() { s.run(...values); return { success: true }; } }; } };
let audit = [];
const day = new Date().toISOString().slice(0, 10);
const samples = [
  ['设计协作', '下一个好想法，从一封邮件开始', '你好，欢迎使用 IONACS Mail。\n\n这里是全新的邮件空间：收件箱、搜索和写邮件，都在熟悉的位置。愿每一次沟通都更从容。\n\n祝今天顺利！'],
  ['林晓', '周五见，聊聊新的设计方案', '我把这周的设计方向整理了一下，想听听你的建议。'],
  ['产品周刊', '本周值得关注的 5 个产品灵感', '关于更好的工具、更轻松的工作，以及一些有趣的发现。'],
  ['Alex Chen', 'Re: 我们的下一步计划', '感谢你的反馈，我已经更新了文档中的时间安排。'],
  ['阅读清单', '给忙碌生活留一点空白', '今天分享三篇适合周末阅读的文章。'],
  ['项目协作', '十月项目进展 · 已准备好评审', '最新版本已准备好，附件和变更说明请查收。'],
  ['IONACS', '欢迎来到你的私人邮箱', '消息有序，沟通从容。'],
  ['安全测试', 'HTML 邮件安全测试', '<h2>HTML 安全测试</h2><p>这段文字可以正常显示。</p><img src="https://tracker.invalid/pixel" onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">不安全链接</a><a href="https://example.com">安全链接</a>'],
];
let messages = samples.map(([name, subject, body], i) => ({ id: 100 - i, source: `${name} <sender${i}@example.com>`, address: 'alex@ionacs.com', created_at: `${day} ${String(9 + Math.floor(i / 2)).padStart(2, '0')}:30:00`, raw: `From: ${name} <sender${i}@example.com>\r\nTo: alex@ionacs.com\r\nSubject: ${subject}\r\nContent-Type: ${i === 7 ? 'text/html' : 'text/plain'}; charset=utf-8\r\n\r\n${body}` }));
let sent = [];
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const url = new URL(req.url, 'http://localhost:8788');
  const json = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/open_api/settings') return json({ title: 'IONACS Mail', domains: ['ionacs.com'], defaultDomains: ['ionacs.com'], enableUserDeleteEmail: true, enableUserCreateEmail: false });
  if (url.pathname === '/user_api/open_settings') return json({ enable: false });
  if (url.pathname.startsWith('/admin/')) {
    if (req.headers['x-admin-auth'] !== 'preview-admin') return json({ error: '本地管理员密码为 preview-admin' }, 401);
    if (url.pathname === '/admin/overview') return json({ counts: { addresses: 1, users: 0, received: messages.length, sent: sent.length, pending: sql.prepare('SELECT COUNT(*) AS n FROM address_sender WHERE requested_at IS NOT NULL').get().n, senders: sql.prepare('SELECT COUNT(*) AS n FROM address_sender WHERE enabled = 1 AND balance > 0').get().n }, identity: 'admin@example.com', canonicalOrigin: 'https://mail.ionacs.com', domains: [{ domain: 'ionacs.com', outboundConfigured: true }], security: { accessVerified: true, adminCheckEnabled: true, encryptedAdminSecret: true, adminCredentialConfigured: true, rateLimitEnabled: true, jwtConfigured: true, auditRetention: 1000 } });
    if (url.pathname === '/admin/audit') return json({ results: audit, count: audit.length });
    if (url.pathname === '/admin/address_sender' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      try { await updateSenderAccess(db, JSON.parse(body)); audit.unshift({ id: Date.now(), actor: 'admin@example.com', method: 'POST', path: url.pathname, status: 200, created_at: new Date().toISOString() }); return json({ success: true }); }
      catch (error) { return json({ error: error.message }, 400); }
    }
    if (url.pathname === '/admin/address_sender') {
      const rows = sql.prepare('SELECT * FROM address_sender').all().filter(row => (!url.searchParams.get('address') || row.address.includes(url.searchParams.get('address'))) && (url.searchParams.get('pending') !== '1' || row.requested_at));
      return json({ results: rows, count: rows.length });
    }
    if (url.pathname === '/admin/address') return json({ results: [{ id: 1, name: 'alex@ionacs.com', mail_count: messages.length, send_count: sent.length, created_at: day, updated_at: day }], count: 1 });
    return json({});
  }
  if (req.headers.authorization !== 'Bearer preview-only') return json({ error: '请输入测试凭据 preview-only' }, 401);
  if (url.pathname === '/api/settings') { const row = sql.prepare('SELECT * FROM address_sender WHERE address = ?').get('alex@ionacs.com'); return json({ address: 'alex@ionacs.com', send_balance: row?.enabled ? row.balance : 0, send_access_status: senderState(row), send_requested_at: row?.requested_at }); }
  if (url.pathname === '/api/request_send_mail_access') { const row = await requestSenderAccess(db, 'alex@ionacs.com'); return json({ status: 'ok', send_access_status: senderState(row) }); }
  if (url.pathname === '/api/mails' || url.pathname === '/api/sendbox') {
    const all = (url.pathname.endsWith('sendbox') ? sent : messages).filter(r => !url.searchParams.get('q') || r.raw.includes(url.searchParams.get('q')));
    const offset = Number(url.searchParams.get('offset') || 0); return json({ results: all.slice(offset, offset + 25), count: all.length });
  }
  if (url.pathname === '/api/send_mail') {
    let body = ''; for await (const chunk of req) body += chunk; const data = JSON.parse(body);
    if (data.subject.includes('[fail]')) return json({ error: '模拟发送失败' }, 503);
    sent.unshift({ id: Date.now(), address: 'alex@ionacs.com', created_at: new Date().toISOString(), raw: JSON.stringify({ ...data, version: 'v2' }) });
    return json({ success: true });
  }
  if (req.method === 'DELETE') { messages = messages.filter(r => r.id !== Number(url.pathname.split('/').pop())); return json({ success: true }); }
  json({});
}).listen(8788, '127.0.0.1', () => console.log('Local UI fixture on 127.0.0.1:8788'));
