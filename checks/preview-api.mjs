// Local UI fixture, never deployed and never connected to real email delivery.
import http from 'node:http';
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
  if (req.headers.authorization !== 'Bearer preview-only') return json({ error: '请输入测试凭据 preview-only' }, 401);
  if (url.pathname === '/api/settings') return json({ address: 'alex@ionacs.com', send_balance: 10 });
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
