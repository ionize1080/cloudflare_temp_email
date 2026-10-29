import DOMPurify from 'dompurify';

export function mailDocument(html, allowImages = false) {
  const clean = DOMPurify.sanitize(String(html || ''), {
    WHOLE_DOCUMENT: false,
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'svg', 'math', 'style', 'link', 'meta', 'base'],
    FORBID_ATTR: ['srcset', 'background', 'ping', 'action', 'formaction', 'id', 'name'],
  });
  // A template stays inert while image URLs are filtered; parsing into an HTML
  // document can start image downloads before the final iframe CSP is applied.
  const template = document.createElement('template');
  template.content.append(clean);
  const doc = template.content;
  for (const el of doc.querySelectorAll('[style]')) {
    // Keep email typography, but remove CSS capable of fetching external resources.
    const style = el.getAttribute('style');
    if (/url\s*\(|@import|image-set|expression|behavior|\\/i.test(style)) el.removeAttribute('style');
  }
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const embedded = /^(data:image\/(png|jpe?g|gif|webp);base64,|blob:)/i.test(src);
    if (!embedded && !(allowImages && /^https:\/\//i.test(src))) img.removeAttribute('src');
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.setAttribute('loading', 'lazy');
  }
  for (const link of doc.querySelectorAll('a')) {
    if (!/^(https?:|mailto:)/i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  const csp = `default-src 'none'; img-src data: blob:${allowImages ? ' https:' : ''}; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body{margin:20px;color:#202124;background:white;font:15px/1.7 Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#0b57d0}</style></head><body>${template.innerHTML}</body></html>`;
}
